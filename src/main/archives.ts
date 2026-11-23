/**
 * Archive surface for the whole app: listing, creation and extraction.
 *
 * The heavy lifting lives in `zip-archive.ts` (ZIP + ZIP64 + AES/ZipCrypto) and `tar-archive.ts`
 * (ustar/pax + gzip/zstd). This file only decides what a path is, collects sources, applies the
 * conflict policy and keeps extraction inside the destination folder.
 *
 * No system tool is spawned: `zip`, `7z`, `rar` and `tar` may not exist on the user's machine, and
 * passwords must never show up in a process list.
 */
import { createWriteStream, promises as fs } from 'node:fs'
import { Transform } from 'node:stream'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { freeName } from './ops.ts'
import type { Entry } from './types.ts'
import type { ConflictPolicy } from '../shared/conflict.ts'
import { isConflictPolicy } from '../shared/conflict.ts'
import {
  ArchivePasswordError,
  archiveStem,
  openZip,
  openZipEntry,
  safeArchiveName,
  writeZip,
  type ZipEntry,
  type ZipWriteEntry
} from './zip-archive.ts'
import { readTarFile, writeTar, type TarItem, type TarWriteEntry } from './tar-archive.ts'

export { ArchivePasswordError } from './zip-archive.ts'

export type ZipLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz' | 'tar.zst'
export type ArchiveEncryption = 'aes256' | 'aes192' | 'aes128' | 'zipcrypto'

const ZIP_LEVEL = (n: unknown): ZipLevel => Math.max(0, Math.min(9, Math.trunc(Number(n) || 0))) as ZipLevel

export const ARCHIVE_FORMATS: ArchiveFormat[] = ['zip', 'tar', 'tar.gz', 'tar.zst']

export const isArchiveFormat = (v: unknown): v is ArchiveFormat =>
  typeof v === 'string' && (ARCHIVE_FORMATS as string[]).includes(v)

export const isArchiveEncryption = (v: unknown): v is ArchiveEncryption =>
  v === 'aes256' || v === 'aes192' || v === 'aes128' || v === 'zipcrypto'

/** `null` means "not an archive we open"; the compressed-tar family is explicit about bz2/xz. */
export type ArchiveKind = 'zip' | 'tar' | 'tar.gz' | 'tar.zst' | 'tar.bz2' | 'tar.xz'

export function archiveKind(file: string): ArchiveKind | null {
  const p = file.toLowerCase()
  if (p.endsWith('.zip') || p.endsWith('.cbz')) return 'zip'
  if (p.endsWith('.tar')) return 'tar'
  if (p.endsWith('.tar.gz') || p.endsWith('.tgz')) return 'tar.gz'
  if (p.endsWith('.tar.zst') || p.endsWith('.tzst')) return 'tar.zst'
  if (p.endsWith('.tar.bz2') || p.endsWith('.tbz2') || p.endsWith('.tbz')) return 'tar.bz2'
  if (p.endsWith('.tar.xz') || p.endsWith('.txz')) return 'tar.xz'
  return null
}

export const isArchive = (p: string): boolean => archiveKind(p) !== null

export const formatExt = (format: ArchiveFormat): string =>
  format === 'tar.gz' ? '.tar.gz' : format === 'tar.zst' ? '.tar.zst' : `.${format}`

export const formatForName = (name: string): ArchiveFormat | null => {
  const k = archiveKind(name)
  return k === 'zip' || k === 'tar' || k === 'tar.gz' || k === 'tar.zst' ? k : null
}

/** Recursive source collection shared by every format. Symlinks are stored as links, never followed. */
type CollectEntry = {
  name: string
  abs?: string
  dir: boolean
  symlink?: string
  mtime: number
  mode: number
  size: number
}

const modeOf = (m: number): number => m & 0xffff

async function collect(sources: string[]): Promise<CollectEntry[]> {
  const out: CollectEntry[] = []
  const used = new Set<string>()
  const unique = (name: string): string => {
    let n = name
    for (let i = 2; used.has(n); i++) {
      const ext = path.posix.extname(n)
      n = `${name.slice(0, name.length - ext.length)} (${i})${ext}`
    }
    used.add(n)
    return n
  }

  const walk = async (abs: string, rel: string): Promise<void> => {
    const st = await fs.lstat(abs)
    if (st.isSymbolicLink()) {
      out.push({
        name: unique(rel),
        dir: false,
        symlink: await fs.readlink(abs),
        mtime: st.mtimeMs,
        mode: modeOf(st.mode) || 0o120777,
        size: 0
      })
      return
    }
    if (st.isDirectory()) {
      const dirName = unique(rel)
      out.push({ name: dirName, dir: true, mtime: st.mtimeMs, mode: modeOf(st.mode), size: 0 })
      const kids = (await fs.readdir(abs)).sort((a, b) => a.localeCompare(b))
      for (const k of kids) await walk(path.join(abs, k), `${dirName}/${k}`)
      return
    }
    out.push({
      name: unique(rel),
      abs,
      dir: false,
      mtime: st.mtimeMs,
      mode: modeOf(st.mode),
      size: st.size
    })
  }

  for (const source of sources) {
    const base = path.basename(source.replace(/[\\/]+$/, '')) || path.basename(source)
    await walk(source, base)
  }
  return out
}

async function collectSafe(sources: string[]): Promise<{ entries: CollectEntry[]; bytes: number }> {
  const entries = await collect(sources)
  const bytes = entries.reduce((a, e) => a + (e.dir || e.symlink ? 0 : e.size), 0)
  return { entries, bytes }
}

/** ── listing ─────────────────────────────────────────────────────────────── */

export type ArchiveListing = {
  entries: Entry[]
  capped: boolean
  /** format actually detected (useful for the dialog) */
  format?: ArchiveKind
  /** the archive has at least one encrypted entry */
  encrypted?: boolean
  /** user-facing reason when the archive could not be opened */
  error?: string
}

const extOf = (n: string): string => {
  const b = n.split('/').pop() ?? n
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i + 1).toLowerCase() : ''
}

const zipToList = (archive: string, zips: ZipEntry[]): Entry[] =>
  zips
    .filter((z) => z.name && !z.name.startsWith('__MACOSX'))
    .map<Entry>((z) => ({
      name: z.name,
      path: `${archive}!${z.name}`,
      dir: z.dir,
      size: z.size,
      mtime: z.mtime,
      ext: z.dir ? '' : extOf(z.name),
      encrypted: z.encrypted,
      csize: z.csize,
      method: z.method,
      link: z.symlink
    }))

const tarToList = (archive: string, items: TarItem[]): Entry[] =>
  items
    .filter((i) => i.name && !i.name.startsWith('__MACOSX'))
    .map<Entry>((i) => ({
      name: i.name,
      path: `${archive}!${i.name}`,
      dir: i.dir,
      size: i.size,
      mtime: i.mtime,
      ext: i.dir ? '' : extOf(i.name),
      link: !!i.symlink || !!i.hardlink
    }))

/** Lists an archive. Names are readable even when the payloads are encrypted. */
export async function listArchive(archive: string): Promise<ArchiveListing> {
  const kind = archiveKind(archive)
  if (!kind) return { entries: [], capped: false, error: 'این فایل، آرشیو شناخته‌شده‌ای نیست' }
  if (kind === 'tar.bz2' || kind === 'tar.xz') {
    return {
      entries: [],
      capped: false,
      format: kind,
      error: 'فشرده‌سازی bz2/xz در برنامه پیاده نشده؛ اول با ابزار سیستم به tar تبدیلش کن'
    }
  }
  try {
    if (kind === 'zip') {
      const z = await openZip(archive)
      return {
        entries: zipToList(archive, z.entries),
        capped: false,
        format: 'zip',
        encrypted: z.entries.some((e) => e.encrypted)
      }
    }
    const items = await readTarFile(archive, kind)
    return { entries: tarToList(archive, items), capped: false, format: kind }
  } catch (e: any) {
    return { entries: [], capped: false, format: kind, error: String(e?.message ?? e) }
  }
}

/** ── creating ────────────────────────────────────────────────────────────── */

export type ArchiveProgress = {
  phase: 'compress' | 'extract'
  done: number
  total: number
  bytes: number
  totalBytes: number
  name?: string
}

export type CreateArchiveOpts = {
  dir: string
  name: string
  sources: string[]
  format?: ArchiveFormat
  level?: number
  /** zip only: store or deflate (auto picks store for level 0 / tiny files) */
  method?: 'auto' | 'store' | 'deflate'
  /** zip only */
  password?: string
  encryption?: ArchiveEncryption
  comment?: string
  onProgress?: (p: ArchiveProgress) => void
  signal?: AbortSignal
}

const cleanName = (name: string): string =>
  path.basename(String(name ?? '').replace(/[\\/]+$/, '')).replace(/[\0/\\]/g, '_').trim()

export async function createArchive(
  opts: CreateArchiveOpts
): Promise<{ path: string; files: number; bytes: number } | { error: string }> {
  try {
    if (!path.isAbsolute(opts.dir)) return { error: 'مقصد نامعتبر است' }
    const format = isArchiveFormat(opts.format) ? opts.format : 'zip'
    const password = format === 'zip' ? (opts.password ?? '') : ''
    const sources = (opts.sources ?? []).filter((s) => typeof s === 'string' && path.isAbsolute(s))
    if (!sources.length) return { error: 'چیزی برای آرشیو کردن نیست' }
    if (opts.sources.length !== sources.length) return { error: 'مسیر نامعتبر' }
    if (format !== 'zip' && opts.password) return { error: 'رمزنگاری فقط برای zip است' }

    const baseName = cleanName(opts.name) || 'archive'
    const ext = formatExt(format)
    const lower = baseName.toLowerCase()
    const fileName = lower.endsWith(ext) ? baseName : `${baseName}${ext}`
    const out = await freeName(path.join(opts.dir, fileName))

    const { entries, bytes } = await collectSafe(sources)
    if (!entries.length) return { error: 'چیزی برای آرشیو کردن نیست' }
    const unsafe = entries.find((e) => !safeArchiveName(e.name))
    if (unsafe) return { error: `نام نامعتبر داخل آرشیو: ${unsafe.name}` }

    const level = ZIP_LEVEL(opts.level ?? 6)
    const onProgress = opts.onProgress
    if (format === 'zip') {
      const zipEntries: ZipWriteEntry[] = entries.map((e) => ({
        name: e.name,
        abs: e.abs,
        dir: e.dir,
        symlink: e.symlink,
        mtime: e.mtime,
        mode: e.mode,
        size: e.size
      }))
      const made = await writeZip(out, zipEntries, {
        level,
        method: opts.method === 'store' || opts.method === 'deflate' ? opts.method : 'auto',
        password: password || undefined,
        encryption: isArchiveEncryption(opts.encryption) ? opts.encryption : 'aes256',
        comment: opts.comment,
        onProgress: (p) =>
          onProgress?.({
            phase: 'compress',
            done: p.done,
            total: p.total,
            bytes: p.bytes,
            totalBytes: p.totalBytes
          }),
        signal: opts.signal
      })
      return { path: out, files: made.files, bytes: made.bytes }
    }

    const tarEntries: TarWriteEntry[] = entries.map((e) => ({
      name: e.name,
      abs: e.abs,
      dir: e.dir,
      symlink: e.symlink,
      mtime: e.mtime,
      mode: e.mode,
      size: e.size
    }))
    const made = await writeTar(out, tarEntries, {
      gzip: format === 'tar.gz',
      zstd: format === 'tar.zst',
      onProgress: (p) =>
        onProgress?.({
          phase: 'compress',
          done: p.done,
          total: p.total,
          bytes: p.bytes,
          totalBytes: p.totalBytes
        }),
      signal: opts.signal
    })
    return { path: out, files: made.files, bytes }
  } catch (e: any) {
    if (e?.name === 'AbortError' || e?.message === 'لغو شد') return { error: 'لغو شد' }
    return { error: String(e?.message ?? e) }
  }
}

/** ── extracting ──────────────────────────────────────────────────────────── */

export type ExtractArchiveOpts = {
  archive: string
  /** inner names; empty means everything */
  names?: string[]
  dest: string
  password?: string
  conflict?: ConflictPolicy
  /** put everything inside one folder named after the archive */
  subfolder?: boolean
  preserveTimes?: boolean
  preserveMode?: boolean
  /** recreate symlinks (off by default: a link escaped from the destination is a real hazard) */
  symlinks?: boolean
  onProgress?: (p: ArchiveProgress) => void
  signal?: AbortSignal
}

export type ExtractResult = { done: number; skipped: number; bytes: number; errors: string[] }

type Plan =
  | { kind: 'dir'; name: string; mtime: number; mode: number }
  | { kind: 'file'; name: string; mtime: number; mode: number; size: number; zip?: ZipEntry; data?: Buffer }
  | { kind: 'link'; name: string; mtime: number; target: string; hard?: boolean; zip?: ZipEntry }

const inside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const parentNoSymlink = async (root: string, rel: string, cache: Set<string>): Promise<void> => {
  const parts = rel.split('/').slice(0, -1)
  let cur = root
  for (const part of parts) {
    cur = path.join(cur, part)
    if (cache.has(cur)) continue
    const st = await fs.lstat(cur).catch(() => null)
    if (!st) continue
    if (st.isSymbolicLink()) throw new Error('مسیر از یک پیوند نمادین بیرون می‌زند')
    cache.add(cur)
  }
}

const writeBuffer = async (target: string, data: Buffer, overwrite: boolean): Promise<void> => {
  if (overwrite) {
    const tmp = path.join(path.dirname(target), `.mfm-part-${randomBytes(6).toString('hex')}`)
    try {
      await fs.writeFile(tmp, data)
      await fs.rename(tmp, target)
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw e
    }
  } else {
    await fs.writeFile(target, data, { flag: 'wx' })
  }
}

/** Applies mtime/mode; failures here are cosmetic and never fail the extraction. */
const restoreMeta = async (target: string, mtime: number, mode: number, opts: ExtractArchiveOpts): Promise<void> => {
  if (opts.preserveMode !== false && mode && process.platform !== 'win32') {
    await fs.chmod(target, mode & 0o777).catch(() => undefined)
  }
  if (opts.preserveTimes !== false && mtime > 0) {
    const sec = mtime / 1000
    await fs.utimes(target, sec, sec).catch(() => undefined)
  }
}

export async function extract(opts: ExtractArchiveOpts): Promise<ExtractResult> {
  const errors: string[] = []
  let done = 0
  let skipped = 0
  let bytes = 0
  const result = (): ExtractResult => ({ done, skipped, bytes, errors })
  try {
    if (!path.isAbsolute(opts.archive) || !path.isAbsolute(opts.dest)) {
      errors.push('مسیر نامعتبر است')
      return result()
    }
    const kind = archiveKind(opts.archive)
    if (!kind) {
      errors.push('این فایل آرشیو شناخته‌شده‌ای نیست')
      return result()
    }
    if (kind === 'tar.bz2' || kind === 'tar.xz') {
      errors.push('فشرده‌سازی bz2/xz پشتیبانی نمی‌شود')
      return result()
    }

    const conflict: ConflictPolicy = isConflictPolicy(opts.conflict) ? opts.conflict : 'keep'
    const selected = (opts.names ?? []).map((n) => safeArchiveName(n)).filter((n): n is string => !!n)
    const selectedSet = new Set(selected)

    let plan: Plan[] = []
    let encrypted = false

    if (kind === 'zip') {
      const z = await openZip(opts.archive)
      encrypted = z.entries.some((e) => e.encrypted)
      for (const e of z.entries) {
        const name = safeArchiveName(e.name)
        if (!name) {
          errors.push(`${e.name}: نام ناامن (خارج از مقصد)`)
          continue
        }
        if (!chosen(name, selectedSet)) continue
        if (e.dir) plan.push({ kind: 'dir', name, mtime: e.mtime, mode: e.mode })
        else if (e.symlink) {
          // The target lives in the entry data, so only read it when symlinks are wanted.
          if (!opts.symlinks) {
            skipped++
            continue
          }
          plan.push({ kind: 'link', name, mtime: e.mtime, target: '', hard: false, zip: e })
        } else {
          plan.push({ kind: 'file', name, mtime: e.mtime, mode: e.mode, size: e.size, zip: e })
        }
      }
    } else {
      const items = await readTarFile(opts.archive, kind)
      for (const it of items) {
        const name = safeArchiveName(it.name)
        if (!name) {
          errors.push(`${it.name}: نام ناامن (خارج از مقصد)`)
          continue
        }
        if (!chosen(name, selectedSet)) continue
        if (it.dir) plan.push({ kind: 'dir', name, mtime: it.mtime, mode: it.mode })
        else if (it.symlink || it.hardlink) {
          if (!opts.symlinks) {
            skipped++
            continue
          }
          plan.push({
            kind: 'link',
            name,
            mtime: it.mtime,
            target: it.symlink ?? it.hardlink ?? '',
            hard: !!it.hardlink
          })
        } else plan.push({ kind: 'file', name, mtime: it.mtime, mode: it.mode, size: it.size, data: it.data })
      }
    }

    const needsPassword = plan.some(
      (p) => p.kind === 'file' && p.zip?.encrypted
    )
    if (!plan.length) {
      errors.push(encrypted && !opts.password ? 'این آرشیو رمز دارد' : 'چیزی برای استخراج پیدا نشد')
      return result()
    }
    if (needsPassword && !opts.password) {
      errors.push('این آرشیو رمز دارد؛ رمز را وارد کن')
      return result()
    }

    const root = path.resolve(opts.dest)
    const outRoot = opts.subfolder ? path.join(root, archiveStem(opts.archive)) : root
    await fs.mkdir(outRoot, { recursive: true })
    if (opts.subfolder) {
      const own = await fs.lstat(outRoot)
      if (own.isSymbolicLink()) throw new Error('پوشهٔ مقصد یک پیوند نمادین است')
    }
    const checked = new Set<string>()
    const total = plan.filter((p) => p.kind !== 'dir').length
    const totalBytes = plan.reduce((a, p) => a + (p.kind === 'file' ? p.size : 0), 0)
    opts.onProgress?.({ phase: 'extract', done: 0, total, bytes: 0, totalBytes })

    const files = plan.filter((p) => p.kind === 'file')
    const links = plan.filter((p) => p.kind === 'link')
    const dirs = plan.filter((p) => p.kind === 'dir')

    const place = async (p: Plan): Promise<string | null> => {
      const rel = p.name
      const candidate = path.resolve(outRoot, rel)
      if (!inside(outRoot, candidate)) throw new Error('مسیر بیرون از مقصد')
      await parentNoSymlink(outRoot, rel, checked)
      const exists = await fs.lstat(candidate).catch(() => null)
      if (exists) {
        if (conflict === 'skip') {
          skipped++
          return null
        }
        if (conflict === 'newer' && exists.mtimeMs >= p.mtime) {
          skipped++
          return null
        }
        if (conflict === 'keep') return freeName(candidate)
      }
      return candidate
    }

    for (const p of dirs) {
      try {
        const target = path.resolve(outRoot, p.name)
        if (!inside(outRoot, target)) throw new Error('مسیر بیرون از مقصد')
        await parentNoSymlink(outRoot, p.name, checked)
        const existing = await fs.lstat(target).catch(() => null)
        if (existing?.isSymbolicLink()) {
          // mkdir/chmod on a symlink would follow it outside the destination.
          errors.push(`${p.name}: یک پیوند نمادین با همین نام وجود دارد`)
          continue
        }
        if (existing && !existing.isDirectory()) {
          errors.push(`${p.name}: یک فایل با همین نام وجود دارد`)
          continue
        }
        await fs.mkdir(target, { recursive: true })
        await restoreMeta(target, p.mtime, p.mode, opts)
      } catch (e: any) {
        errors.push(`${p.name}: ${e?.message ?? e}`)
      }
    }

    for (const p of files) {
      if (opts.signal?.aborted) throw new Error('لغو شد')
      if (p.kind !== 'file') continue
      let target: string | null = null
      let current = 0
      let lastReport = 0
      let lastReportBytes = 0
      const report = (force = false): void => {
        const now = Date.now()
        const sent = bytes + current
        if (!force && now - lastReport < 120 && sent - lastReportBytes < 4 * 1024 * 1024) return
        lastReport = now
        lastReportBytes = sent
        opts.onProgress?.({
          phase: 'extract',
          done,
          total,
          bytes: bytes + current,
          totalBytes,
          name: p.name
        })
      }
      try {
        target = await place(p)
        if (!target) continue
        await fs.mkdir(path.dirname(target), { recursive: true })
        const overwrite = conflict === 'overwrite' || conflict === 'newer'
        if (p.zip) {
          const opened = await openZipEntry(opts.archive, p.zip, opts.password)
          const counter = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              current += chunk.length
              report()
              cb(null, chunk)
            }
          })
          if (overwrite) {
            const tmp = path.join(path.dirname(target), `.mfm-part-${randomBytes(6).toString('hex')}`)
            try {
              await pipeline(opened.stream, counter, createWriteStream(tmp), { signal: opts.signal })
              await opened.finish()
              await fs.rename(tmp, target)
            } catch (e) {
              await fs.rm(tmp, { force: true }).catch(() => undefined)
              throw e
            }
          } else {
            try {
              await pipeline(opened.stream, counter, createWriteStream(target, { flags: 'wx' }), {
                signal: opts.signal
              })
            } catch (e) {
              throw e
            }
            await opened.finish()
          }
        } else {
          const data = p.data ?? Buffer.alloc(0)
          await writeBuffer(target, data, overwrite)
          current = data.length
        }
        await restoreMeta(target, p.mtime, p.mode, opts)
        bytes += current
        current = 0
        done++
        report(true)
      } catch (e: any) {
        if (e instanceof ArchivePasswordError || e?.name === 'AbortError') {
          errors.push(String(e.message))
          if (e instanceof ArchivePasswordError) return result()
        } else {
          errors.push(`${p.name}: ${e?.message ?? e}`)
        }
      }
    }

    if (opts.symlinks) {
      for (const p of links) {
        if (p.kind !== 'link' || opts.signal?.aborted) continue
        try {
          let value = p.target
          if (p.zip) {
            const opened = await openZipEntry(opts.archive, p.zip, opts.password)
            const chunks: Buffer[] = []
            for await (const c of opened.stream) chunks.push(Buffer.from(c))
            await opened.finish()
            value = Buffer.concat(chunks).toString('utf8')
          }
          if (!value) throw new Error('مقصد پیوند خالی است')
          const targetPath = path.resolve(outRoot, p.name)
          if (!inside(outRoot, targetPath)) throw new Error('مقصد پیوند بیرون از پوشه است')
          // links are created last and may replace a directory; verify the chain afresh
          await parentNoSymlink(outRoot, p.name, new Set())
          if (path.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) throw new Error('پیوند مطلق مجاز نیست')
          const resolved = path.resolve(path.dirname(targetPath), value)
          if (!inside(outRoot, resolved)) throw new Error('پیوند به بیرون از مقصد اشاره می‌کند')
          await fs.mkdir(path.dirname(targetPath), { recursive: true })
          const existing = await fs.lstat(targetPath).catch(() => null)
          if (existing) {
            if (conflict === 'skip' || conflict === 'newer') {
              skipped++
              continue
            }
            if (conflict === 'keep') {
              // a differently named link is better than replacing the existing one
              continue
            }
            await fs.rm(targetPath, { recursive: true, force: true })
          }
          if (p.hard) await fs.link(resolved, targetPath)
          else await fs.symlink(value, targetPath)
          done++
        } catch (e: any) {
          errors.push(`${p.name}: ${e?.message ?? e}`)
        }
      }
    }

    return result()
  } catch (e: any) {
    errors.push(String(e?.message ?? e))
    return result()
  }
}

/** A selected name picks itself and, for a folder, everything below it. */
function chosen(name: string, selected: Set<string>): boolean {
  if (!selected.size) return true
  if (selected.has(name)) return true
  for (const s of selected) if (name.startsWith(`${s}/`)) return true
  return false
}

/** ── integrity ───────────────────────────────────────────────────────────── */

/** Reads every entry to the end, checking CRC/HMAC without writing anything to disk. */
export async function verifyArchive(
  archive: string,
  opts: { password?: string; names?: string[]; onProgress?: (p: ArchiveProgress) => void } = {}
): Promise<{ ok: boolean; checked: number; errors: string[] }> {
  const errors: string[] = []
  let checked = 0
  try {
    const kind = archiveKind(archive)
    if (!kind) throw new Error('آرشیو شناخته‌شده نیست')
    if (kind === 'zip') {
      const z = await openZip(archive)
      const wanted = new Set((opts.names ?? []).map((n) => safeArchiveName(n)).filter((n): n is string => !!n))
      const files = z.entries.filter((e) => !e.dir && chosen(e.name, wanted))
      for (let i = 0; i < files.length; i++) {
        const e = files[i]
        const opened = await openZipEntry(archive, e, opts.password)
        try {
          for await (const _ of opened.stream) void _
          await opened.finish()
          checked++
        } catch (err: any) {
          errors.push(`${e.name}: ${err?.message ?? err}`)
        }
        opts.onProgress?.({
          phase: 'extract',
          done: i + 1,
          total: files.length,
          bytes: 0,
          totalBytes: 0,
          name: e.name
        })
      }
      return { ok: errors.length === 0, checked, errors }
    }
    if (kind === 'tar.bz2' || kind === 'tar.xz') throw new Error('فشرده‌سازی bz2/xz پشتیبانی نمی‌شود')
    const items = await readTarFile(archive, kind)
    checked = items.filter((i) => !i.dir).length
    return { ok: true, checked, errors }
  } catch (e: any) {
    errors.push(String(e?.message ?? e))
    return { ok: false, checked, errors }
  }
}
