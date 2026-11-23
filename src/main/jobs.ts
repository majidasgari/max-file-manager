import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freeName } from './ops.ts'
import { conflictOf, type ConflictPolicy } from '../shared/conflict.ts'
import { isRemotePath, remoteJoin, remoteName, remoteOriginKey } from '../shared/remote-path.ts'
import type { RemoteControl, RemoteFs } from './remote-core.ts'
import type { Result } from './types.ts'

export type JobKind = 'copy' | 'move'
export type JobState = 'queued' | 'running' | 'paused' | 'done' | 'cancelled' | 'error'

/** One line of a job's file log: what happened to a single path. */
export type JobFile = {
  path: string
  state: 'copied' | 'skipped' | 'failed'
  size?: number
  /** this copy replaced a file that was already there */
  overwrote?: boolean
  /** a stable token ('exists' | 'newer') for a skip, or the error text of a failure */
  note?: string
}

/**
 * The per-file log of a transfer. Copied entries are a rolling window (a 40k-file folder must not
 * grow the strip's memory or IPC payload), while skips and failures are kept in full: they are the
 * lines the user actually goes looking for.
 */
export type JobLog = {
  copied: { entries: JobFile[]; total: number; dropped: number }
  skipped: { entries: JobFile[]; total: number }
  failed: { entries: JobFile[]; total: number }
}

export type Job = {
  id: string
  kind: JobKind
  label: string
  /** where the files are going, so the strip can name the target instead of guessing */
  dest: string
  state: JobState
  bytes: number
  done: number
  files: number
  filesDone: number
  speed: number
  current: string
  errors: string[]
  /** sources left alone by the conflict policy */
  skipped: number
  /** files that replaced an existing destination file */
  overwrites: number
  /** what this job does when the destination name is taken */
  conflict: ConflictPolicy
}

/** Transfer options the user can set in preferences. */
export type JobOpts = {
  /** keep both (default), replace, skip, or replace only when the source is newer */
  conflict?: ConflictPolicy
  /** legacy aliases of conflict: 'skip' */
  skipExisting?: boolean
  /** legacy aliases of conflict: 'newer' */
  newerOnly?: boolean
  /** bytes per second ceiling, 0 or missing = unlimited */
  limitBps?: number
}

type Ctl = { paused: boolean; cancelled: boolean; limitBps?: number }
type UndoRec = { label: string; pairs: [string, string][]; inverse: 'rename' | 'rmdir' | 'unlink' }

export type Engine = {
  start(kind: JobKind, sources: string[], dest: string, opts?: JobOpts): Job
  pause(id: string): void
  resume(id: string): void
  cancel(id: string): void
  list(): Job[]
  /** the per-file log of one job, or null when it is unknown or already cleared */
  files(id: string): JobLog | null
  clear(): void
  renameMany(pairs: { from: string; to: string }[]): Promise<Result>
  makeDir(dir: string, name: string): Promise<Result>
  createFile(dir: string, name: string, content?: string): Promise<Result>
  undo(): Promise<{ done: number; label: string }>
  undoDepth(): number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function measure(p: string): Promise<{ bytes: number; files: number }> {
  const st = await fs.lstat(p).catch(() => null)
  if (!st) return { bytes: 0, files: 1 }
  if (!st.isDirectory()) return { bytes: st.size, files: 1 }
  let bytes = 0
  let files = 0
  const stack = [p]
  while (stack.length) {
    const d = stack.pop()!
    const kids = await fs.readdir(d, { withFileTypes: true }).catch(() => [])
    for (const k of kids) {
      const q = path.join(d, k.name)
      if (k.isDirectory()) stack.push(q)
      else {
        const s = await fs.lstat(q).catch(() => null)
        if (s) {
          bytes += s.size
          files++
        }
      }
    }
  }
  return { bytes, files }
}

/** Called once per file that made it to the destination, with enough to log it. */
type OnFile = (file?: { path: string; size: number; overwrote?: boolean }) => void

async function copyFile(
  src: string,
  dest: string,
  ctl: Ctl,
  onBytes: (n: number) => void,
  onFile: OnFile,
  checkExists = false
): Promise<void> {
  const replaced = checkExists ? !!(await fs.lstat(dest).catch(() => null)) : false
  const rs = createReadStream(src, { highWaterMark: 1 << 20 })
  const ws = createWriteStream(dest)
  let aborted = false
  let sent = 0
  const startedAt = Date.now()
  try {
    for await (const chunk of rs) {
      if (ctl.cancelled) {
        aborted = true
        break
      }
      while (ctl.paused && !ctl.cancelled) await sleep(100)
      if (ctl.cancelled) {
        aborted = true
        break
      }
      const buf = chunk as Buffer
      if (!ws.write(buf)) await new Promise<void>((r) => ws.once('drain', () => r()))
      onBytes(buf.length)
      // shortcut: pacing is a sleep after each chunk, so the rate is a rough average, fine for a UI limit
      if (ctl.limitBps && ctl.limitBps > 0) {
        sent += buf.length
        const due = (sent / ctl.limitBps) * 1000
        const spent = Date.now() - startedAt
        if (due > spent) await sleep(Math.min(500, due - spent))
      }
    }
  } finally {
    if (aborted) {
      rs.destroy()
      ws.destroy()
      await fs.unlink(dest).catch(() => {})
      throw new Error('cancelled')
    }
  }
  await new Promise<void>((resolve, reject) => {
    ws.end(() => resolve())
    ws.on('error', reject)
  })
  const st = await fs.stat(src).catch(() => null)
  if (st) await fs.utimes(dest, st.atime, st.mtime).catch(() => {})
  onFile({ path: src, size: st?.size ?? 0, overwrote: replaced })
}

async function copyTree(
  src: string,
  dest: string,
  ctl: Ctl,
  onBytes: (n: number) => void,
  onFile: OnFile,
  checkExists = false
): Promise<void> {
  if (ctl.cancelled) throw new Error('cancelled')
  const st = await fs.lstat(src)
  if (st.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(src), dest)
    onFile({ path: src, size: 0 })
    return
  }
  if (st.isDirectory()) {
    await fs.mkdir(dest, { recursive: true })
    for (const k of await fs.readdir(src)) {
      await copyTree(path.join(src, k), path.join(dest, k), ctl, onBytes, onFile, checkExists)
    }
    return
  }
  await copyFile(src, dest, ctl, onBytes, onFile, checkExists)
}

// shortcut: cancelled transfers leave a partially filled directory (files are removed, dirs are not) and undo only covers move/rename/mkdir; upgrade when transfers get a journal.
export function createEngine(emit: (job: Job) => void, remote?: RemoteFs): Engine {
  const jobs = new Map<string, Job>()
  const ctls = new Map<string, Ctl>()
  const undoStack: UndoRec[] = []
  let chained: Promise<void> = Promise.resolve()
  let seq = 0

  const clone = (j: Job): Job => ({ ...j, errors: [...j.errors] })

  /** Local or remote: one naming rule for label/current/free-name/recursion. */
  const baseOf = (p: string): string => (isRemotePath(p) ? remoteName(p) : path.basename(p))
  const joinAny = (dir: string, name: string): string =>
    isRemotePath(dir) ? remoteJoin(dir, name) : path.join(dir, name)
  const requireRemote = (): RemoteFs => {
    if (!remote) throw new Error('remote support is not available in this window')
    return remote
  }
  const statAny = async (
    p: string
  ): Promise<{ size: number; mtime: number; dir: boolean } | null> => {
    if (isRemotePath(p)) {
      const st = await requireRemote().stat(p)
      return st ? { size: st.size, mtime: st.mtime, dir: st.dir } : null
    }
    const st = await fs.stat(p).catch(() => null)
    return st ? { size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() } : null
  }
  const measureAny = async (p: string): Promise<{ bytes: number; files: number }> => {
    if (!isRemotePath(p)) return measure(p)
    const m = await requireRemote().measure(p)
    return { bytes: m.bytes, files: m.files }
  }
  const removeAny = async (p: string): Promise<void> => {
    if (isRemotePath(p)) {
      await requireRemote().remove(p)
      return
    }
    await fs.rm(p, { recursive: true, force: true })
  }
  const freeNameAny = async (natural: string): Promise<string> =>
    isRemotePath(natural) ? requireRemote().freeName(natural) : freeName(natural)

  function controlOf(ctl: Ctl, onBytes: (n: number) => void, onFile: () => void): RemoteControl {
    return {
      onBytes,
      cancelled: () => ctl.cancelled,
      paused: () => ctl.paused,
      waitIfPaused: async () => {
        while (ctl.paused && !ctl.cancelled) await sleep(100)
      }
    }
  }

  /**
   * Move a local file/folder between any two stores. Same-store renames stay a rename; everything
   * else goes through the transfer path, which is also what undo uses to put a moved item back.
   */
  async function moveAny(from: string, to: string): Promise<void> {
    const aRemote = isRemotePath(from)
    const bRemote = isRemotePath(to)
    if (aRemote && bRemote && remoteOriginKey(from) === remoteOriginKey(to)) {
      await requireRemote().rename(from, to)
      return
    }
    if (!aRemote && !bRemote) {
      try {
        await fs.rename(from, to)
        return
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'EXDEV') throw e
      }
    }
    const ctl: Ctl = { paused: false, cancelled: false }
    await transferTree(from, to, ctl, () => undefined, () => undefined)
    await removeAny(from)
  }

  /**
   * Copy one tree in any direction: local↔local (the original fast path), remote→local,
   * local→remote and remote→remote (through a temp file). Symlinks are preserved locally and
   * refused for a remote destination; a remote symlink is transferred as the file it points at.
   */
  async function transferTree(
    src: string,
    dest: string,
    ctl: Ctl,
    onBytes: (n: number) => void,
    onFile: OnFile,
    checkExists = false
  ): Promise<void> {
    if (ctl.cancelled) throw new Error('cancelled')
    const srcRemote = isRemotePath(src)
    const destRemote = isRemotePath(dest)
    if (!srcRemote && !destRemote) {
      await copyTree(src, dest, ctl, onBytes, onFile, checkExists)
      return
    }
    const rfs = requireRemote()
    const control = controlOf(ctl, onBytes, onFile)
    if (srcRemote) {
      const st = await rfs.stat(src)
      if (!st) throw new Error('the remote source does not exist')
      if (st.dir) {
        if (destRemote) await rfs.mkdir(dest).catch(() => undefined)
        else await fs.mkdir(dest, { recursive: true })
        const listing = await rfs.list(src, true)
        for (const entry of listing.entries) {
          if (ctl.cancelled) throw new Error('cancelled')
          await transferTree(entry.path, joinAny(dest, entry.name), ctl, onBytes, onFile, checkExists)
        }
        return
      }
      if (destRemote) {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mfm-remote-'))
        const local = path.join(tmp, 'item')
        try {
          await rfs.downloadFile(src, local, control)
          // progress was already counted on the download leg; do not count the same bytes twice
          await rfs.uploadFile(local, dest, controlOf(ctl, () => undefined, onFile))
        } finally {
          await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
        }
      } else {
        await rfs.downloadFile(src, dest, control)
      }
      onFile({ path: src, size: st.size })
      return
    }
    const st = await fs.lstat(src)
    if (st.isSymbolicLink()) {
      if (destRemote) throw new Error('symbolic links cannot be copied to a remote folder')
      await fs.symlink(await fs.readlink(src), dest)
      onFile({ path: src, size: 0 })
      return
    }
    if (st.isDirectory()) {
      if (destRemote) await rfs.mkdir(dest)
      else await fs.mkdir(dest, { recursive: true })
      for (const name of await fs.readdir(src)) {
        if (ctl.cancelled) throw new Error('cancelled')
        await transferTree(path.join(src, name), joinAny(dest, name), ctl, onBytes, onFile, checkExists)
      }
      return
    }
    if (destRemote) {
      const replaced = checkExists && !!(await rfs.stat(dest))
      await rfs.uploadFile(src, dest, control)
      onFile({ path: src, size: st.size, overwrote: replaced })
    } else await copyFile(src, dest, ctl, onBytes, onFile, checkExists)
  }

  const lastEmit = new Map<string, number>()
  const push = (job: Job, force = false) => {
    const now = Date.now()
    if (!force && now - (lastEmit.get(job.id) ?? 0) < 120) return
    lastEmit.set(job.id, now)
    emit(clone(job))
  }
  /** copied lines are capped (rolling); skips and failures are kept whole */
  const LOG_CAP = 2000
  const logs = new Map<string, JobLog>()
  const logFor = (id: string): JobLog => {
    let l = logs.get(id)
    if (!l) {
      l = {
        copied: { entries: [], total: 0, dropped: 0 },
        skipped: { entries: [], total: 0 },
        failed: { entries: [], total: 0 }
      }
      logs.set(id, l)
    }
    return l
  }
  const record = (job: Job, entry: JobFile): void => {
    const l = logFor(job.id)
    if (entry.state === 'copied') {
      l.copied.total++
      l.copied.entries.push(entry)
      // prune in one go instead of shifting on every file
      if (l.copied.entries.length > LOG_CAP + 512) {
        const drop = l.copied.entries.length - LOG_CAP
        l.copied.entries.splice(0, drop)
        l.copied.dropped += drop
      }
      return
    }
    const bucket = entry.state === 'skipped' ? l.skipped : l.failed
    bucket.total++
    if (bucket.entries.length < LOG_CAP) bucket.entries.push(entry)
  }
  const undoPush = (label: string, pairs: [string, string][], inverse: UndoRec['inverse'] = 'rename') => {
    undoStack.push({ label, pairs, inverse })
    if (undoStack.length > 20) undoStack.shift()
  }

  function start(kind: JobKind, sources: string[], dest: string, opts: JobOpts = {}): Job {
    const job: Job = {
      id: 'j' + ++seq,
      kind,
      // named from the start, so a queued row in the strip is not a bare “…”
      label: sources.length === 1 ? baseOf(sources[0]) : `${sources.length} مورد`,
      dest,
      state: 'queued',
      bytes: 0,
      done: 0,
      files: 0,
      filesDone: 0,
      speed: 0,
      current: '',
      errors: [],
      skipped: 0,
      overwrites: 0,
      conflict: 'keep'
    }
    const ctl: Ctl = { paused: false, cancelled: false, limitBps: opts.limitBps ?? 0 }
    jobs.set(job.id, job)
    ctls.set(job.id, ctl)
    push(job, true)

    const policy = conflictOf(opts)
    job.conflict = policy

    chained = chained.then(async () => {
      if (ctl.cancelled) {
        job.state = 'cancelled'
        push(job, true)
        return
      }
      job.state = 'running'
      push(job, true)

      const pairs: [string, string][] = []
      try {
        const remoteDest = isRemotePath(dest)
        if (remoteDest) {
          const target = await requireRemote().stat(dest)
          if (!target?.dir) throw new Error('the destination is not a remote folder')
        } else if (!path.isAbsolute(dest)) {
          throw new Error('no destination')
        }
        for (const s of sources) {
          const natural = joinAny(dest, baseOf(s))
          // keep both is the one policy that never needs to look: freeName answers for a free name too
          let target = policy === 'keep' ? await freeNameAny(natural) : natural
          if (policy !== 'keep') {
            const there = await statAny(natural)
            if (there) {
              if (policy === 'skip') {
                job.skipped++
                record(job, { path: s, state: 'skipped', note: 'exists' })
                continue
              }
              if (policy === 'newer') {
                const here = await statAny(s)
                if (here && there.mtime >= here.mtime) {
                  job.skipped++
                  record(job, { path: s, state: 'skipped', note: 'newer' })
                  continue
                }
              }
              // overwrite (or newer with an older destination): this run replaces it on purpose
            }
          }
          pairs.push([s, target])
          const m = await measureAny(s)
          job.bytes += m.bytes
          job.files += m.files
        }
      } catch (e: any) {
        job.state = 'error'
        job.errors.push(String(e?.message ?? e))
        push(job, true)
        return
      }
      push(job, true)

      let lastBytes = 0
      let lastAt = Date.now()
      const timer = setInterval(() => {
        const now = Date.now()
        job.speed = Math.round((job.done - lastBytes) / Math.max(0.2, (now - lastAt) / 1000))
        lastBytes = job.done
        lastAt = now
        push(job)
      }, 500)

      const movedPairs: [string, string][] = []
      try {
        for (const [src, target] of pairs) {
          if (ctl.cancelled) break
          job.current = baseOf(src)
          push(job, true)
          try {
            await transferTree(
              src,
              target,
              ctl,
              (n) => {
                job.done += n
                push(job)
              },
              (file) => {
                job.filesDone++
                if (file) {
                  if (file.overwrote) job.overwrites++
                  record(job, {
                    path: file.path,
                    state: 'copied',
                    size: file.size,
                    overwrote: file.overwrote
                  })
                }
                push(job)
              },
              // overwrite and newer may replace an existing file, so the copy reports it
              policy === 'overwrite' || policy === 'newer'
            )
            if (kind === 'move') {
              await removeAny(src)
              movedPairs.push([src, target])
            }
          } catch (e: any) {
            if (ctl.cancelled) break
            const note = String(e?.message ?? e)
            job.errors.push(`${baseOf(src)}: ${note}`)
            record(job, { path: src, state: 'failed', note })
          }
        }
        if (movedPairs.length) undoPush(`انتقال ${movedPairs.length} مورد`, movedPairs)
        job.state = ctl.cancelled ? 'cancelled' : job.errors.length ? 'error' : 'done'
      } catch (e: any) {
        job.state = 'error'
        job.errors.push(String(e?.message ?? e))
      } finally {
        clearInterval(timer)
        job.speed = 0
        push(job, true)
      }
    })
    return clone(job)
  }

  function setPause(id: string, paused: boolean) {
    const ctl = ctls.get(id)
    const job = jobs.get(id)
    if (!ctl || !job || (job.state !== 'running' && job.state !== 'paused')) return
    ctl.paused = paused
    job.state = paused ? 'paused' : 'running'
    push(job, true)
  }

  return {
    start,
    pause: (id) => setPause(id, true),
    resume: (id) => setPause(id, false),
    cancel: (id) => {
      const ctl = ctls.get(id)
      if (ctl) ctl.cancelled = true
    },
    list: () => [...jobs.values()].map(clone),
    files: (id) => {
      const l = logs.get(id)
      if (!l) return null
      return {
        copied: { entries: [...l.copied.entries], total: l.copied.total, dropped: l.copied.dropped },
        skipped: { entries: [...l.skipped.entries], total: l.skipped.total },
        failed: { entries: [...l.failed.entries], total: l.failed.total }
      }
    },
    clear: () => {
      for (const [id, j] of jobs)
        if (j.state !== 'running' && j.state !== 'paused') {
          jobs.delete(id)
          logs.delete(id)
        }
    },
    renameMany: async (pairs) => {
      const errors: string[] = []
      const donePairs: [string, string][] = []
      for (const { from, to } of pairs) {
        try {
          const aRemote = isRemotePath(from)
          const bRemote = isRemotePath(to)
          if (aRemote !== bRemote) throw new Error('a rename cannot cross local and remote')
          if (aRemote) {
            await requireRemote().rename(from, to)
          } else {
            if (!path.isAbsolute(from) || !path.isAbsolute(to)) throw new Error('not an absolute path')
            await fs.rename(from, to)
          }
          donePairs.push([from, to])
        } catch (e: any) {
          errors.push(`${baseOf(from)}: ${e?.message ?? String(e)}`)
        }
      }
      if (donePairs.length) undoPush(`${donePairs.length} تغییر نام`, donePairs)
      return { done: donePairs.length, errors }
    },
    makeDir: async (dir, name) => {
      try {
        const remoteDir = isRemotePath(dir)
        if (!remoteDir && !path.isAbsolute(dir)) throw new Error('not an absolute path')
        const target = joinAny(dir, name)
        if (remoteDir) await requireRemote().mkdir(target)
        else await fs.mkdir(target)
        undoPush(`پوشهٔ ${name}`, [[target, target]], 'rmdir')
        return { done: 1, errors: [] }
      } catch (e: any) {
        return { done: 0, errors: [`${name}: ${e?.message ?? String(e)}`] }
      }
    },
    createFile: async (dir, name, content = '') => {
      try {
        const remoteDirPath = isRemotePath(dir)
        if (!remoteDirPath && !path.isAbsolute(dir)) throw new Error('not an absolute path')
        const target = joinAny(dir, name)
        const data =
          typeof content === 'string' && content.startsWith('base64:')
            ? Buffer.from(content.slice(7), 'base64')
            : content
        if (remoteDirPath) {
          const rfs = requireRemote()
          if (await rfs.exists(target)) throw new Error('این نام از قبل وجود دارد')
          await rfs.writeBuffer(target, Buffer.isBuffer(data) ? data : Buffer.from(data))
        } else {
          await fs.writeFile(target, data, { flag: 'wx' })
        }
        undoPush(`فایل ${name}`, [[target, target]], 'unlink')
        return { done: 1, errors: [] }
      } catch (e: any) {
        const msg =
          e?.code === 'EEXIST' || /وجود دارد/.test(String(e?.message))
            ? 'این نام از قبل وجود دارد'
            : (e?.message ?? String(e))
        return { done: 0, errors: [`${name}: ${msg}`] }
      }
    },
    undo: async () => {
      const rec = undoStack.pop()
      if (!rec) return { done: 0, label: '' }
      let done = 0
      for (const [from, to] of [...rec.pairs].reverse()) {
        try {
          if (rec.inverse === 'rmdir') {
            if (isRemotePath(from)) await requireRemote().remove(from)
            else await fs.rmdir(from)
          } else if (rec.inverse === 'unlink') {
            if (isRemotePath(from)) await requireRemote().remove(from)
            else await fs.unlink(from)
          } else {
            await moveAny(to, from)
          }
          done++
        } catch {
          // keep going: one unrestorable item must not block the rest
        }
      }
      return { done, label: rec.label }
    },
    undoDepth: () => undoStack.length
  }
}
