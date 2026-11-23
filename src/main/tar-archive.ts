/**
 * TAR engine (ustar + GNU long names + pax), plus gzip and zstd wrapping.
 *
 * TAR has no compression or encryption of its own, so the caller pairs it with gzip/zstd. Reading
 * is in-memory behind `TAR_CAP`; writing streams, so a huge folder does not have to fit in RAM.
 */
import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip, createZstdCompress, createZstdDecompress } from 'node:zlib'

/** Decompressed tar data is held in memory (headers must be walked), so it has a ceiling. */
export const TAR_CAP = 512 * 1024 * 1024

export type TarItem = {
  name: string
  dir: boolean
  symlink: string | null
  hardlink: string | null
  size: number
  mtime: number
  mode: number
  data: Buffer
}

export type TarWriteEntry = {
  name: string
  abs?: string
  dir?: boolean
  symlink?: string
  mtime?: number
  mode?: number
  size?: number
}

export type TarWriteOpts = {
  gzip?: boolean
  zstd?: boolean
  onProgress?: (p: { done: number; total: number; bytes: number; totalBytes: number }) => void
  signal?: AbortSignal
}

const str = (buf: Buffer, from: number, len: number): string =>
  buf.subarray(from, from + len).toString('utf8').replace(/\0.*$/s, '').trimEnd()

const octal = (buf: Buffer, from: number, len: number): number => {
  const raw = buf.subarray(from, from + len)
  // GNU base-256 encoding for values that do not fit the octal field (large files, big ids).
  if (raw[0] & 0x80) {
    let n = raw[0] & 0x7f
    for (let i = 1; i < raw.length; i++) n = n * 256 + raw[i]
    return n
  }
  const s = raw.toString('latin1').replace(/\0.*$/s, '').trim()
  return s ? parseInt(s, 8) || 0 : 0
}

type Pax = Record<string, string>

const parsePax = (data: Buffer): Pax => {
  const out: Pax = {}
  let o = 0
  while (o < data.length) {
    const sp = data.indexOf(0x20, o)
    if (sp < 0) break
    const len = parseInt(data.toString('latin1', o, sp), 10)
    if (!Number.isFinite(len) || len <= 0 || o + len > data.length) break
    const rec = data.toString('utf8', sp + 1, o + len - 1)
    const eq = rec.indexOf('=')
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1)
    o += len
  }
  return out
}

/** Parses a tar image. Truncated or non-tar input yields an empty list. */
export function readTar(buf: Buffer): TarItem[] {
  const items: TarItem[] = []
  let o = 0
  let pax: Pax = {}
  let globalPax: Pax = {}
  let longName: string | null = null
  let longLink: string | null = null
  const body = (size: number, at: number): Buffer => buf.subarray(at, Math.min(buf.length, at + size))

  while (o + 512 <= buf.length) {
    const h = buf.subarray(o, o + 512)
    if (h.every((b) => b === 0)) break
    const stored = parseInt(str(h, 148, 8), 8)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]
    if (Number.isFinite(stored) && stored !== sum) {
      throw new Error(`چکیدهٔ سرصفحهٔ tar در بایت ${o} نامعتبر است`)
    }
    const name = str(h, 0, 100)
    const mode = octal(h, 100, 8)
    let size = octal(h, 124, 12)
    let mtime = octal(h, 136, 12) * 1000
    const type = String.fromCharCode(h[156] || 0x30)
    const linkname = str(h, 157, 100)
    const prefix = str(h, 345, 155)
    const dataAt = o + 512
    const raw = body(size, dataAt)

    if (type === 'x' || type === 'X' || type === 'g') {
      const records = parsePax(raw)
      if (type === 'g') globalPax = { ...globalPax, ...records }
      else pax = { ...pax, ...records }
      o = dataAt + Math.ceil(size / 512) * 512
      continue
    }
    if (type === 'L' || type === 'K') {
      const value = str(raw, 0, raw.length)
      if (type === 'L') longName = value
      else longLink = value
      o = dataAt + Math.ceil(size / 512) * 512
      continue
    }

    const meta = { ...globalPax, ...pax }
    if (meta.size && Number(meta.size) >= 0) size = Number(meta.size)
    if (meta.mtime && Number.isFinite(Number(meta.mtime))) mtime = Math.round(Number(meta.mtime) * 1000)
    let full = meta.path ?? (prefix ? `${prefix}/${name}` : name)
    if (longName) full = longName
    const link = meta.linkpath ?? longLink ?? linkname
    const itemName = full.replace(/\/+$/, '')
    if (itemName) {
      const isDir = type === '5' || full.endsWith('/')
      items.push({
        name: itemName,
        dir: isDir,
        symlink: type === '2' ? link : null,
        hardlink: type === '1' ? link : null,
        size: isDir ? 0 : size,
        mtime,
        mode: mode || (isDir ? 0o755 : 0o644),
        data: isDir ? Buffer.alloc(0) : body(size, dataAt)
      })
    }
    pax = {}
    longName = null
    longLink = null
    o = dataAt + Math.ceil(size / 512) * 512
  }
  return items
}

/** Reads a plain/gzip/zstd tar, refusing decompressed output above `TAR_CAP`. */
export const readTarFile = async (file: string, format: 'tar' | 'tar.gz' | 'tar.zst'): Promise<TarItem[]> => {
  const st = await fs.stat(file)
  if (st.size > TAR_CAP) throw new Error('آرشیو برای مرور بزرگ‌تر از سقف ۵۱۲ مگابایت است')
  const raw = await fs.readFile(file)
  if (format === 'tar') return readTar(raw)
  const out = await new Promise<Buffer>((res, rej) => {
    const z = format === 'tar.gz' ? createGunzip() : createZstdDecompress()
    const chunks: Buffer[] = []
    let total = 0
    z.on('data', (c: Buffer) => {
      total += c.length
      if (total > TAR_CAP) z.destroy(new Error('محتوای آرشیو از سقف ۵۱۲ مگابایت بیشتر است'))
      else chunks.push(c)
    })
    z.on('end', () => res(Buffer.concat(chunks)))
    z.on('error', rej)
    z.end(raw)
  })
  return readTar(out)
}

const put = (h: Buffer, value: string, at: number, len: number): void => {
  const b = Buffer.from(value, 'utf8')
  b.copy(h, at, 0, Math.min(len, b.length))
}

const putOctal = (h: Buffer, value: number, at: number, len: number): void => {
  const s = Math.max(0, Math.trunc(value)).toString(8).padStart(len - 1, '0').slice(-(len - 1))
  h.write(s, at, 'latin1')
  h[at + len - 1] = 0
}

const checksum = (h: Buffer): void => {
  h.fill(0x20, 148, 156)
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0').slice(-6), 148, 'latin1')
  h[154] = 0
  h[155] = 0x20
}

const splitName = (name: string): { name: string; prefix: string } | null => {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' }
  for (let i = name.lastIndexOf('/'); i > 0; i = name.lastIndexOf('/', i - 1)) {
    const prefix = name.slice(0, i)
    const rest = name.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) {
      return { name: rest, prefix }
    }
  }
  return null
}

const header = (e: TarWriteEntry, size: number): Buffer => {
  const h = Buffer.alloc(512)
  const name = e.dir ? `${e.name.replace(/\/+$/, '')}/` : e.name
  const split = splitName(name) ?? { name: name.slice(0, 100), prefix: '' }
  put(h, split.name, 0, 100)
  putOctal(h, e.mode ?? (e.dir ? 0o755 : 0o644), 100, 8)
  putOctal(h, 0, 108, 8)
  putOctal(h, 0, 116, 8)
  putOctal(h, size, 124, 12)
  putOctal(h, Math.floor((e.mtime ?? Date.now()) / 1000), 136, 12)
  h[156] = e.dir ? 0x35 : e.symlink != null ? 0x32 : 0x30
  if (e.symlink != null) put(h, e.symlink, 157, 100)
  // GNU magic (`ustar  \0`) is what GNU tar itself writes for long-name records and is read by
  // every tar in practice; POSIX ustar magic is equally accepted for the regular records.
  put(h, 'ustar ', 257, 6)
  h[263] = 0x20
  h[264] = 0
  put(h, 'root', 265, 32)
  put(h, 'root', 297, 32)
  put(h, split.prefix, 345, 155)
  checksum(h)
  return h
}

const paxRecord = (key: string, value: string): Buffer => {
  const payload = ` ${key}=${value}\n`
  const raw = Buffer.byteLength(payload)
  for (let digits = 1; ; digits++) {
    const total = raw + digits
    if (String(total).length === digits) return Buffer.from(`${total}${payload}`, 'utf8')
  }
}

/** A POSIX pax extended header (type x), used for names or link targets ustar cannot hold. */
const paxHeader = (records: string[], entryName: string, mtime: number): Buffer[] => {
  const data = Buffer.concat(records.map((r) => {
    const eq = r.indexOf('=')
    return paxRecord(r.slice(0, eq), r.slice(eq + 1))
  }))
  const h = Buffer.alloc(512)
  put(h, `PaxHeaders.0/${entryName}`.slice(0, 100), 0, 100)
  putOctal(h, 0o644, 100, 8)
  putOctal(h, 0, 108, 8)
  putOctal(h, 0, 116, 8)
  putOctal(h, data.length, 124, 12)
  putOctal(h, Math.floor(mtime / 1000), 136, 12)
  h[156] = 0x78
  put(h, 'ustar', 257, 6)
  h[263] = 0x30
  h[264] = 0x30
  put(h, 'root', 265, 32)
  put(h, 'root', 297, 32)
  checksum(h)
  return [h, data, pad512(data.length)]
}

const pad512 = (size: number): Buffer => Buffer.alloc((512 - (size % 512)) % 512)

/**
 * Streams a tar (optionally gzip/zstd wrapped) to `out`.
 * Long names that do not fit ustar use GNU LongLink records, which GNU tar, bsdtar and 7-Zip read.
 */
export async function writeTar(
  out: string,
  entries: TarWriteEntry[],
  opts: TarWriteOpts = {}
): Promise<{ files: number; bytes: number }> {
  const totals = await Promise.all(
    entries.map(async (e) => {
      if (e.dir) return 0
      if (e.symlink != null) return 0
      if (e.size != null) return e.size
      return e.abs ? (await fs.stat(e.abs)).size : 0
    })
  )
  const totalBytes = totals.reduce((a, b) => a + b, 0)

  async function* source(): AsyncGenerator<Buffer> {
    let done = 0
    let bytes = 0
    let lastReport = 0
    let lastReportBytes = 0
    const report = (force = false): void => {
      const now = Date.now()
      if (!force && now - lastReport < 120 && bytes - lastReportBytes < 4 * 1024 * 1024) return
      lastReport = now
      lastReportBytes = bytes
      opts.onProgress?.({ done, total: entries.length, bytes, totalBytes })
    }
    report(true)
    for (let i = 0; i < entries.length; i++) {
      if (opts.signal?.aborted) throw new Error('لغو شد')
      const e = entries[i]
      const size = totals[i]
      const chunks: Buffer[] = []
      const records: string[] = []
      if (Buffer.byteLength(e.name) > 100 && !splitName(e.name)) records.push(`path=${e.name}`)
      if (e.symlink && Buffer.byteLength(e.symlink) > 100) records.push(`linkpath=${e.symlink}`)
      if (records.length) chunks.push(...paxHeader(records, e.name.split('/').pop() || e.name, e.mtime ?? Date.now()))
      chunks.push(header(e, size))
      for (const c of chunks) yield c
      if (e.dir) {
        done++
        report(true)
        continue
      }
      if (e.symlink != null) {
        // A type-2 record carries the target in the header and has no body.
      } else if (e.abs) {
        for await (const chunk of createReadStream(e.abs)) {
          if (opts.signal?.aborted) throw new Error('لغو شد')
          const b = chunk as Buffer
          bytes += b.length
          report()
          yield b
        }
        yield pad512(size)
      }
      done++
      report(true)
    }
    yield Buffer.alloc(1024)
  }

  const stream = Readable.from(source())
  const sink = createWriteStream(out)
  try {
    if (opts.gzip) await pipeline(stream, createGzip({ level: 6 }), sink, { signal: opts.signal })
    else if (opts.zstd) await pipeline(stream, createZstdCompress(), sink, { signal: opts.signal })
    else await pipeline(stream, sink, { signal: opts.signal })
  } catch (e) {
    await fs.rm(out, { force: true }).catch(() => undefined)
    throw e
  }
  return { files: entries.filter((e) => !e.dir).length, bytes: totalBytes }
}
