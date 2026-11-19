/**
 * The disk/network half of a sync run: walk two trees, hash what the comparison asks for, and
 * apply a plan. Every operation goes through `PathOps`, which has a local and a remote backend, so
 * the planner never needs to know which side is an SFTP server. No Electron import here: the tests
 * build a fake remote on two temp folders.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isRemotePath, remoteJoinRel, remoteName } from '../shared/remote-path.ts'
import { isCloudPath } from '../shared/cloud.ts'
import type { SyncAction, SyncCompareBy, SyncIgnoreRule, SyncPlan, SyncRow, SyncSide } from '../shared/sync.ts'
import type { RemoteFs } from './remote-core.ts'
import { ignored, ignoredBy, planRows, rowOf, sortRows, SYNC_SKIP_NAMES, threeWay, type Baseline } from './sync-core.ts'
import { decryptFile, encryptFile, hashPlaintext, type ResolvedEncryption } from './sync-crypt.ts'

export type SyncControl = {
  cancelled: boolean
  paused: boolean
  onBytes?(n: number): void
  onFile?(rel: string): void
}

export type WalkOptions = {
  ignore?: string[]
  /** Ignore-tab rules (glob/regex/path/size); applied before a row can reach the plan */
  rules?: SyncIgnoreRule[]
  /** rows cap; 20 000 is what the dialog can show without lying about completeness */
  maxRows?: number
  /** wall-clock budget for one tree */
  budgetMs?: number
  onProgress?(scanned: number, current: string): void
}

type Entry = { name: string; dir: boolean; size: number; mtime: number; link?: boolean }

export type PathOps = {
  isRemote(p: string): boolean
  join(dir: string, name: string): string
  stat(p: string): Promise<SyncSide | null>
  list(p: string): Promise<Entry[]>
  joinRel(root: string, rel: string): string
  hash(p: string, ctl?: SyncControl): Promise<string>
  copy(from: string, to: string, ctl?: SyncControl): Promise<void>
  remove(p: string): Promise<void>
  setMtime(p: string, mtime: number): Promise<void>
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitIfPaused(ctl?: SyncControl): Promise<void> {
  if (!ctl) return
  while (ctl.paused && !ctl.cancelled) await sleep(100)
  if (ctl.cancelled) throw new Error('cancelled')
}

async function hashLocal(file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer)
  return h.digest('hex')
}

/** Local backend: plain fs with the mtime preserved on every copy. */
export function localOps(): PathOps {
  return {
    isRemote: () => false,
    join: (dir, name) => path.join(dir, name),
    joinRel: (root, rel) => {
      const parts = rel.split('/').filter(Boolean)
      if (parts.some((p) => p === '..' || p === '.' || /[\0\r\n]/.test(p))) throw new Error('invalid relative path')
      return path.join(root, ...parts)
    },
    stat: async (p) => {
      const st = await fs.lstat(p).catch(() => null)
      if (!st || st.isSymbolicLink()) return null
      return { size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs, dir: st.isDirectory() }
    },
    list: async (p) => {
      const items = await fs.readdir(p, { withFileTypes: true }).catch(() => [])
      const out: Entry[] = []
      for (const item of items) {
        const full = path.join(p, item.name)
        const st = await fs.lstat(full).catch(() => null)
        if (!st || st.isSymbolicLink()) continue
        out.push({
          name: item.name,
          dir: st.isDirectory(),
          size: st.isDirectory() ? 0 : st.size,
          mtime: st.mtimeMs
        })
      }
      return out
    },
    hash: hashLocal,
    copy: async (from, to, ctl) => {
      const st = await fs.lstat(from)
      if (!st.isFile()) throw new Error('only files are copied')
      await fs.mkdir(path.dirname(to), { recursive: true })
      // stream, not fs.copyFile: a sync run must be pausable/cancellable and report bytes
      const rs = createReadStream(from, { highWaterMark: 1 << 20 })
      const ws = createWriteStream(to)
      let aborted = false
      try {
        for await (const chunk of rs) {
          if (ctl?.cancelled) {
            aborted = true
            break
          }
          while (ctl?.paused && !ctl.cancelled) await sleep(100)
          if (ctl?.cancelled) {
            aborted = true
            break
          }
          const buf = chunk as Buffer
          if (!ws.write(buf)) await new Promise<void>((resolve) => ws.once('drain', () => resolve()))
          ctl?.onBytes?.(buf.length)
        }
        if (aborted) throw new Error('cancelled')
        await new Promise<void>((resolve, reject) => {
          ws.end(() => resolve())
          ws.on('error', reject)
        })
        await fs.utimes(to, st.atime, st.mtime)
        await waitIfPaused(ctl)
      } catch (e) {
        rs.destroy()
        ws.destroy()
        await fs.unlink(to).catch(() => undefined)
        throw e
      }
    },
    remove: async (p) => {
      await fs.rm(p, { recursive: true, force: true })
    },
    setMtime: async (p, mtime) => {
      const d = new Date(mtime)
      await fs.utimes(p, d, d).catch(() => undefined)
    }
  }
}

/** Remote backend: everything goes through the app's own RemoteFs (SFTP/FTP/S3). */
export function remoteOps(remote: RemoteFs, tempRoot = os.tmpdir()): PathOps {
  const work = async (): Promise<string> => fs.mkdtemp(path.join(tempRoot, 'mfm-sync-'))
  return {
    isRemote: () => true,
    join: (dir, name) => remoteJoinRel(dir, name),
    joinRel: (root, rel) => remoteJoinRel(root, rel),
    stat: async (p) => {
      const st = await remote.stat(p).catch(() => null)
      if (!st) return null
      return { size: st.dir ? 0 : st.size, mtime: st.mtime, dir: st.dir }
    },
    list: async (p) => {
      const listing = await remote.list(p, true)
      return listing.entries
        .filter((e) => !e.link)
        .map((e) => ({ name: e.name, dir: e.dir, size: e.dir ? 0 : e.size, mtime: e.mtime }))
    },
    hash: async (p, ctl) => {
      const dir = await work()
      const tmp = path.join(dir, remoteName(p) || 'file')
      try {
        await remote.downloadFile(p, tmp, {
          onBytes: (n) => ctl?.onBytes?.(n),
          cancelled: () => ctl?.cancelled === true,
          paused: () => ctl?.paused === true,
          waitIfPaused: async () => waitIfPaused(ctl)
        })
        return hashLocal(tmp)
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    },
    copy: async (from, to, ctl) => {
      const fromRemote = isRemotePath(from)
      const toRemote = isRemotePath(to)
      const control = {
        onBytes: (n: number) => ctl?.onBytes?.(n),
        cancelled: () => ctl?.cancelled === true,
        paused: () => ctl?.paused === true,
        waitIfPaused: async () => waitIfPaused(ctl)
      }
      if (fromRemote && !toRemote) {
        await remote.downloadFile(from, to, control)
        await waitIfPaused(ctl)
        return
      }
      if (!fromRemote && toRemote) {
        await remote.uploadFile(from, to, control)
        await waitIfPaused(ctl)
        return
      }
      // remote → remote: a temp file is the only path both ends understand. Report bytes on the
      // upload only, otherwise progress counts the whole file twice and the rate/ETA lie.
      const dir = await work()
      const tmp = path.join(dir, remoteName(from) || 'file')
      const quiet = { ...control, onBytes: undefined }
      try {
        await remote.downloadFile(from, tmp, quiet)
        await remote.uploadFile(tmp, to, control)
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
      await waitIfPaused(ctl)
    },
    remove: async (p) => {
      await remote.remove(p)
    },
    setMtime: async (p, mtime) => {
      await remote.utimes(p, mtime).catch(() => undefined)
    }
  }
}

/** Dispatch by path scheme. One object, so `walk`/`copy` never branch on remote vs local. */
export function createOps(remote?: RemoteFs, cloud?: PathOps): PathOps {
  const local = localOps()
  const remoteSide = remote ? remoteOps(remote) : null
  const pick = (p: string): PathOps => {
    if (isCloudPath(p)) {
      if (!cloud) throw new Error('cloud support is not available for this folder')
      return cloud
    }
    if (isRemotePath(p)) {
      if (!remoteSide) throw new Error('remote support is not available in this window')
      return remoteSide
    }
    return local
  }
  return {
    isRemote: (p) => isRemotePath(p) || isCloudPath(p),
    join: (dir, name) => pick(dir).joinRel(dir, name),
    joinRel: (root, rel) => pick(root).joinRel(root, rel),
    stat: async (p) => pick(p).stat(p),
    list: async (p) => pick(p).list(p),
    hash: async (p, ctl) => pick(p).hash(p, ctl),
    copy: async (from, to, ctl) => {
      // either side being remote needs the adapter (it owns download/upload/temp), not local fs
      if (isCloudPath(from) || isCloudPath(to)) {
        if (!cloud) throw new Error('cloud support is not available for this folder')
        return cloud.copy(from, to, ctl)
      }
      if (isRemotePath(from) || isRemotePath(to)) {
        if (!remoteSide) throw new Error('remote support is not available in this window')
        return remoteSide.copy(from, to, ctl)
      }
      return local.copy(from, to, ctl)
    },
    remove: async (p) => pick(p).remove(p),
    setMtime: async (p, mtime) => pick(p).setMtime(p, mtime)
  }
}

export type Tree = Map<string, SyncSide>

/** Recursive walk with a row cap and a wall-clock budget. Folder names are kept for type checks. */
export async function walkTree(
  root: string,
  ops: PathOps,
  opts: WalkOptions = {}
): Promise<{ tree: Tree; capped: boolean; count: number }> {
  const tree: Tree = new Map()
  const maxRows = opts.maxRows ?? 20_000
  const deadline = Date.now() + (opts.budgetMs ?? 60_000)
  const rootStat = await ops.stat(root)
  if (!rootStat || !rootStat.dir) return { tree, capped: false, count: 0 }
  const queue: string[] = ['']
  let count = 0
  let capped = false
  while (queue.length) {
    if (Date.now() > deadline || tree.size >= maxRows) {
      capped = true
      break
    }
    const rel = queue.shift()!
    const entries = await ops.list(rel ? ops.joinRel(root, rel) : root)
    for (const entry of entries) {
      if (SYNC_SKIP_NAMES.has(entry.name)) continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (ignored(childRel, opts.ignore ?? [])) continue
      if (ignoredBy(childRel, opts.rules, entry.size, entry.dir)) continue
      tree.set(childRel, { size: entry.size, mtime: entry.mtime, dir: entry.dir })
      count++
      opts.onProgress?.(count, childRel)
      if (entry.dir) queue.push(childRel)
      if (tree.size >= maxRows) {
        capped = true
        break
      }
    }
  }
  return { tree, capped, count }
}

export type CompareResult = {
  rows: SyncRow[]
  leftCount: number
  rightCount: number
  capped: boolean
  hashed: number
}

/** Hash cache for one run: a remote file is downloaded once, not once per comparison. */
export class HashCache {
  private cache = new Map<string, string>()
  private limit = 5000

  key(side: string, rel: string, meta: SyncSide): string {
    return `${side}\u0000${rel}\u0000${meta.size}\u0000${Math.round(meta.mtime)}`
  }

  get(k: string): string | undefined {
    return this.cache.get(k)
  }

  set(k: string, v: string): void {
    if (this.cache.size >= this.limit) this.cache.clear()
    this.cache.set(k, v)
  }
}

const hashOf = async (
  root: string,
  side: 'left' | 'right',
  rel: string,
  ops: PathOps,
  cache: HashCache,
  ctl?: SyncControl,
  enc?: ResolvedEncryption
): Promise<string> => {
  const p = ops.joinRel(root, rel)
  const st = await ops.stat(p)
  if (!st) throw new Error(`vanished: ${rel}`)
  const key = cache.key(side, rel, st)
  const hit = cache.get(key)
  if (hit) return hit
  let hash: string
  if (!enc) hash = await ops.hash(p, ctl)
  else {
    // the plaintext is what both sides are compared on; download/copy the ciphertext first
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfm-sync-hash-'))
    const cipher = path.join(dir, 'cipher')
    try {
      await ops.copy(p, cipher, ctl)
      hash = await hashPlaintext(cipher, enc)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  cache.set(key, hash)
  return hash
}

/**
 * Compare two trees. `both` needs a baseline to be meaningful; without one every row that exists on
 * both sides with different content becomes a conflict instead of a silent overwrite.
 */
export async function compareTrees(
  left: string,
  right: string,
  ops: PathOps,
  opts: {
    compareBy?: SyncCompareBy
    ignore?: string[]
    rules?: SyncIgnoreRule[]
    twoWay?: boolean
    baseline?: Baseline
    /** per-side decryption for hashing and copies */
    enc?: { left?: ResolvedEncryption; right?: ResolvedEncryption }
    maxRows?: number
    budgetMs?: number
    ctl?: SyncControl
    onProgress?(phase: 'left' | 'right' | 'compare', done: number, current: string): void
  } = {}
): Promise<CompareResult> {
  const by = opts.compareBy ?? 'mtime'
  const maxRows = opts.maxRows ?? 20_000
  const leftWalk = await walkTree(left, ops, {
    ignore: opts.ignore,
    rules: opts.rules,
    maxRows,
    budgetMs: opts.budgetMs,
    onProgress: (n, cur) => opts.onProgress?.('left', n, cur)
  })
  if (opts.ctl?.cancelled) throw new Error('cancelled')
  const rightWalk = await walkTree(right, ops, {
    ignore: opts.ignore,
    rules: opts.rules,
    maxRows,
    budgetMs: opts.budgetMs,
    onProgress: (n, cur) => opts.onProgress?.('right', n, cur)
  })
  if (opts.ctl?.cancelled) throw new Error('cancelled')
  const rels = [...new Set([...leftWalk.tree.keys(), ...rightWalk.tree.keys()])].filter(
    (rel) => !ignored(rel, opts.ignore ?? []) && !ignoredBy(rel, opts.rules)
  )
  rels.sort()
  const cache = new HashCache()
  const rows: SyncRow[] = []
  let hashed = 0
  for (const rel of rels.slice(0, maxRows)) {
    const l = leftWalk.tree.get(rel)
    const r = rightWalk.tree.get(rel)
    // folder-only rows are implicit: files below them create the parents; a dir↔file clash is real
    if (l?.dir || r?.dir) {
      if (l && r && l.dir !== r.dir) rows.push({ rel, state: 'typeDiff', left: l, right: r })
      continue
    }
    const row = rowOf(rel, l, r, by)
    if (by === 'hash' && l && r && !l.dir && !r.dir) {
      const [hl, hr] = await Promise.all([
        hashOf(left, 'left', rel, ops, cache, opts.ctl, opts.enc?.left),
        hashOf(right, 'right', rel, ops, cache, opts.ctl, opts.enc?.right)
      ])
      hashed += 2
      row.left = { ...l, hash: hl }
      row.right = { ...r, hash: hr }
      row.state = hl === hr ? 'same' : l.size === r.size ? 'contentDiff' : 'sizeDiff'
    }
    rows.push(row)
    opts.onProgress?.('compare', rows.length, rel)
    if (opts.ctl?.cancelled) throw new Error('cancelled')
  }
  const finalRows = opts.twoWay ? threeWay(rows, opts.baseline ?? {}, by) : rows
  return {
    rows: sortRows(finalRows),
    leftCount: leftWalk.tree.size,
    rightCount: rightWalk.tree.size,
    capped: leftWalk.capped || rightWalk.capped || rels.length > maxRows,
    hashed
  }
}

/**
 * Compare only the paths an incremental change feed marked dirty. The rows are exactly what
 * `compareTrees` would produce for those paths (including the three-way rule), so `planRows` and
 * `applyPlan` stay untouched. A path that vanished from both sides simply produces no row.
 */
export async function compareSubset(
  left: string,
  right: string,
  ops: PathOps,
  rels: string[],
  opts: {
    compareBy?: SyncCompareBy
    twoWay?: boolean
    baseline?: Baseline
    /**
     * Metadata of already known cloud paths, keyed by relative path. When a key is present the
     * right side is taken from it instead of `ops.stat`, which on Drive would resolve every path
     * segment with a name query. The left side always comes from disk.
     */
    rightByRel?: Map<string, SyncSide>
    ctl?: SyncControl
    onProgress?(phase: 'left' | 'right' | 'compare', done: number, current: string): void
  } = {}
): Promise<CompareResult> {
  const by = opts.compareBy ?? 'mtime'
  const rows: SyncRow[] = []
  const unique = [...new Set(rels)]
  let leftCount = 0
  let rightCount = 0
  for (let i = 0; i < unique.length; i++) {
    const rel = unique[i]
    // a failed stat is «not there», exactly like a walk of a tree that does not contain it
    const l = await ops.stat(ops.joinRel(left, rel)).catch(() => null)
    opts.onProgress?.('left', i + 1, rel)
    const known = opts.rightByRel?.get(rel)
    const r = known ?? (await ops.stat(ops.joinRel(right, rel)).catch(() => null))
    opts.onProgress?.('right', i + 1, rel)
    if (opts.ctl?.cancelled) throw new Error('cancelled')
    if (l) leftCount++
    if (r) rightCount++
    if (!l && !r) continue
    rows.push(rowOf(rel, l ?? undefined, r ?? undefined, by))
    opts.onProgress?.('compare', rows.length, rel)
  }
  const finalRows = opts.twoWay ? threeWay(rows, opts.baseline ?? {}, by) : rows
  return {
    rows: sortRows(finalRows),
    leftCount,
    rightCount,
    capped: false,
    hashed: 0
  }
}

export type ApplyResult = {
  copied: number
  removed: number
  skipped: number
  bytes: number
  errors: string[]
  cancel: boolean
}

/**
 * Apply a plan. Deletions on a local side go through the injected `trash` (never hard-delete); a
 * remote deletion is permanent and the caller must have confirmed it.
 */
export async function applyPlan(
  left: string,
  right: string,
  plan: SyncPlan,
  ops: PathOps,
  opts: {
    trash?: (p: string) => Promise<void>
    ctl?: SyncControl
    enc?: { left?: ResolvedEncryption; right?: ResolvedEncryption }
  } = {}
): Promise<ApplyResult> {
  const res: ApplyResult = { copied: 0, removed: 0, skipped: plan.skipped, bytes: 0, errors: [], cancel: false }
  const ctl = opts.ctl
  const act = async (action: SyncAction): Promise<void> => {
    const fromRoot = action.from === 'left' ? left : right
    const toRoot = action.to === 'left' ? left : right
    const from = ops.joinRel(fromRoot, action.rel)
    const to = ops.joinRel(toRoot, action.rel)
    if (action.kind === 'delete') {
      if (opts.ctl?.cancelled) throw new Error('cancelled')
      if (isRemotePath(from) || isCloudPath(from)) {
        await ops.remove(from)
      } else if (opts.trash) {
        await opts.trash(from)
      } else {
        await ops.remove(from)
      }
      res.removed++
      return
    }
    const st = await ops.stat(from)
    if (!st) throw new Error('the source disappeared')
    if (st.dir) {
      res.skipped++
      return
    }
    const fromEnc = opts.enc?.[action.from]
    const toEnc = opts.enc?.[action.to]
    if (!fromEnc && !toEnc) {
      await ops.copy(from, to, ctl)
    } else {
      // one materialised plaintext (or ciphertext) at a time; remote sources/destinations still
      // go through PathOps, so the four direction combinations keep working
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfm-sync-crypt-'))
      const plain = path.join(dir, 'plain')
      const cipher = path.join(dir, 'cipher')
      // only the last hop is the payload the user is waiting for; intermediates would double-count
      const quiet = ctl ? { ...ctl, onBytes: undefined } : undefined
      try {
        if (fromEnc) {
          const sourceCipher = path.join(dir, 'source-cipher')
          await ops.copy(from, sourceCipher, quiet)
          await decryptFile(sourceCipher, plain, fromEnc)
        } else {
          await ops.copy(from, plain, quiet)
        }
        const payload = toEnc ? (await encryptFile(plain, cipher, toEnc), cipher) : plain
        await ops.copy(payload, to, ctl)
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    await ops.setMtime(to, st.mtime)
    res.copied++
    res.bytes += st.size
    await waitIfPaused(ctl)
  }
  const runOneCopy = async (action: SyncAction): Promise<boolean> => {
    try {
      ctl?.onFile?.(action.rel)
      await act(action)
      return true
    } catch (e) {
      if (ctl?.cancelled) {
        res.cancel = true
        return false
      }
      res.errors.push(`${action.rel}: ${e instanceof Error ? e.message : String(e)}`)
      return true
    }
  }
  // a remote run pays several round trips per file; a few files in flight hide that latency
  // (one SFTP session multiplexes the requests). Local-to-local stays sequential: the disk is
  // already the bottleneck and parallel copies only add seek noise.
  const lanes = isRemotePath(left) || isRemotePath(right) || isCloudPath(left) || isCloudPath(right) ? 4 : 1
  if (lanes === 1) {
    for (const action of plan.copy) {
      if (ctl?.cancelled) {
        res.cancel = true
        break
      }
      if (!(await runOneCopy(action))) break
    }
  } else {
    let next = 0
    let stop = false
    const worker = async (): Promise<void> => {
      while (!stop) {
        const i = next++
        if (i >= plan.copy.length) return
        if (ctl?.cancelled) {
          stop = true
          res.cancel = true
          return
        }
        if (!(await runOneCopy(plan.copy[i]))) {
          stop = true
          return
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(lanes, plan.copy.length) }, worker))
  }
  if (!res.cancel) {
    for (const action of plan.remove) {
      if (ctl?.cancelled) {
        res.cancel = true
        break
      }
      try {
        ctl?.onFile?.(action.rel)
        await act(action)
      } catch (e) {
        if (ctl?.cancelled) {
          res.cancel = true
          break
        }
        res.errors.push(`${action.rel}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  return res
}

/** Build a plan from already-compared rows; kept here so IPC has one call to make. */
export function makePlan(rows: SyncRow[], mode: SyncPlan['mode'], opts: Parameters<typeof planRows>[2] = {}): SyncPlan {
  return planRows(rows, mode, opts)
}
