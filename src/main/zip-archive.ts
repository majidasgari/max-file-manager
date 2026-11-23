/**
 * ZIP engine — read, write and stream, with no external dependency.
 *
 * The file manager used to hand whole archives to `fflate`, which meant no encryption, no ZIP64
 * and a 256 MB ceiling. This module implements the parts of APPNOTE 6.3.8 a desktop file manager
 * needs:
 *
 *  - central-directory listing (ZIP64 aware), store/deflate entries, UTF-8 and CP437 names
 *  - WinZip AES (AE-1/AE-2, 128/192/256 bit) and the legacy PKZIP stream cipher, both directions
 *  - streaming extraction with CRC/HMAC checks and a paragraph of memory
 *  - streaming creation with levels 0–9, data-free local headers patched in place, Unix modes,
 *    symlinks, directory entries, extended timestamps and an archive comment
 *
 * Reading is deliberately range-based: listing never reads entry data, extraction reads only the
 * bytes of the entry being written, so a 20 GB archive costs no RAM.
 */
import { createCipheriv, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs, createReadStream } from 'node:fs'
import { PassThrough, Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDeflateRaw, createInflateRaw, createZstdDecompress } from 'node:zlib'
import path from 'node:path'

export class ArchivePasswordError extends Error {
  readonly code = 'EPASSPHRASE'
  constructor(message = 'رمز آرشیو اشتباه است یا فایل خراب است') {
    super(message)
    this.name = 'ArchivePasswordError'
  }
}

/** ── small binary helpers ────────────────────────────────────────────────── */

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_ZIP64_LOCATOR = 0x07064b50

const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

const crcRaw = (crc: number, byte: number): number =>
  (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0

/** Running CRC-32; pass the previous value to continue. */
export const crc32 = (buf: Uint8Array, previous = 0): number => {
  let c = (previous ^ U32_MAX) >>> 0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ U32_MAX) >>> 0
}

const dosDateTime = (ms: number): { time: number; date: number } => {
  const d = new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now())
  const year = Math.min(2107, Math.max(1980, d.getFullYear()))
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

const msFromDos = (time: number, date: number): number => {
  const year = 1980 + ((date >> 9) & 0x7f)
  const month = ((date >> 5) & 0x0f) - 1
  const day = date & 0x1f
  const h = (time >> 11) & 0x1f
  const m = (time >> 5) & 0x3f
  const s = (time & 0x1f) * 2
  if (!date && !time) return 0
  const out = new Date(year, Math.max(0, month), Math.max(1, day), h, m, s).getTime()
  return Number.isFinite(out) ? out : 0
}

/** CP437 high half (0x80–0xFF), the fallback for names without the UTF-8 flag. */
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0'

const decodeName = (buf: Buffer, utf8: boolean): string => {
  if (utf8) return buf.toString('utf8')
  let out = ''
  for (const b of buf) out += b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80] ?? '?'
  return out
}

const u64 = (b: Buffer, o: number): number => Number(b.readBigUInt64LE(o))

const writeU64 = (b: Buffer, value: number, o: number): void => {
  b.writeBigUInt64LE(BigInt(Math.max(0, Math.trunc(value))), o)
}

const normName = (name: string): string =>
  name.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/')

/** Rejects absolute paths and `..` segments; the caller still resolves against the real dest. */
export const safeArchiveName = (name: string): string | null => {
  const n = normName(name)
  if (!n || n.includes('\0')) return null
  if (/^[a-zA-Z]:/.test(n)) return null
  // Windows alternate data streams hide data in a file's ":stream" suffix.
  if (process.platform === 'win32' && /[:*?"<>|]/.test(n)) return null
  const parts = n.split('/')
  if (parts.some((p) => p === '..')) return null
  return n.replace(/\/+$/, '')
}

/** Extra fields we understand. */
type Extra = {
  zip64?: { usize?: number; csize?: number; offset?: number; disk?: number }
  aes?: { version: number; vendor: string; strength: number; method: number }
  mtime?: number
  /** Info-ZIP Unicode Path (0x7075): the real name when the header bytes were not UTF-8 */
  unicodeName?: string
  mode?: number
}

type Zip64Wanted = { usize?: boolean; csize?: boolean; offset?: boolean; disk?: boolean }

const parseExtra = (buf: Buffer, wanted: Zip64Wanted = {}): Extra => {
  const out: Extra = {}
  let o = 0
  while (o + 4 <= buf.length) {
    const tag = buf.readUInt16LE(o)
    const size = buf.readUInt16LE(o + 2)
    const d = o + 4
    if (d + size > buf.length) break
    if (tag === 0x0001) {
      // Fields appear only for values saturated in the fixed header, in this fixed order.
      const z: NonNullable<Extra['zip64']> = {}
      let p = d
      if (wanted.usize && p + 8 <= d + size) {
        z.usize = u64(buf, p)
        p += 8
      }
      if (wanted.csize && p + 8 <= d + size) {
        z.csize = u64(buf, p)
        p += 8
      }
      if (wanted.offset && p + 8 <= d + size) {
        z.offset = u64(buf, p)
        p += 8
      }
      if (wanted.disk && p + 4 <= d + size) z.disk = buf.readUInt32LE(p)
      out.zip64 = z
    } else if (tag === 0x9901 && size >= 7) {
      out.aes = {
        version: buf.readUInt16LE(d),
        vendor: buf.toString('latin1', d + 2, d + 4),
        strength: buf[d + 4],
        method: buf.readUInt16LE(d + 5)
      }
    } else if (tag === 0x5455 && size >= 5) {
      const flags = buf[d]
      if (flags & 1 && size >= 5) out.mtime = buf.readUInt32LE(d + 1) * 1000
    } else if (tag === 0x7075 && size >= 5 && buf[d] === 1) {
      // version byte, 4-byte CRC of the legacy name, then UTF-8. The CRC is advisory.
      out.unicodeName = buf.toString('utf8', d + 5, d + size)
    } else if (tag === 0x7875 && size >= 4) {
      // Unix uid/gid; only the mode matters to us, which lives in the external attributes.
    }
    o = d + size
  }
  return out
}

/** ── central directory ───────────────────────────────────────────────────── */

export type ZipEntry = {
  /** name inside the archive, forward slashes, no trailing slash for directories */
  name: string
  dir: boolean
  symlink: boolean
  size: number
  csize: number
  mtime: number
  crc: number
  method: number
  flags: number
  encrypted: boolean
  /** 0 = not AES, otherwise 1/2/3 = 128/192/256 bit */
  aes: number
  /** Unix mode when the archive was made on Unix, else 0 */
  mode: number
  /** filled when the entry is opened; listing does not read local headers */
  dataOffset: number
  localOffset: number
  comment: string
}

export type ZipArchive = {
  entries: ZipEntry[]
  comment: string
  zip64: boolean
  /** bytes to add to every recorded offset when the file has a prepended stub (SFX) */
  offsetDelta: number
}

async function readRange(fh: fs.FileHandle, start: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, start + got)
    if (!bytesRead) break
    got += bytesRead
  }
  return got === length ? buf : buf.subarray(0, got)
}

/** Reads and parses the central directory. Throws when the file is not a ZIP. */
export async function openZip(file: string): Promise<ZipArchive> {
  const fh = await fs.open(file, 'r')
  try {
    const st = await fh.stat()
    if (st.size < 22) throw new Error('فایل zip معتبر نیست (کوچک‌تر از سرصفحه)')
    const tailLen = Math.min(st.size, 0xffff + 22 + 64)
    const tail = await readRange(fh, st.size - tailLen, tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== SIG_EOCD) continue
      const commentLen = tail.readUInt16LE(i + 20)
      if (i + 22 + commentLen <= tail.length) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('پایان دایرکتوری zip پیدا نشد')

    let total = tail.readUInt16LE(eocd + 10)
    let cdSize = tail.readUInt32LE(eocd + 12)
    let cdOffset = tail.readUInt32LE(eocd + 16)
    const commentBytes = tail.subarray(eocd + 22, eocd + 22 + tail.readUInt16LE(eocd + 20))
    let comment = commentBytes.toString('utf8')
    let zip64 = false

    const wantZip64 =
      total === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX ||
      tail.readUInt16LE(eocd + 8) === U16_MAX
    if (wantZip64 && eocd >= 20 && tail.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) {
      const z64Offset = u64(tail, eocd - 12)
      const z64 = await readRange(fh, z64Offset, 56)
      if (z64.length >= 56 && z64.readUInt32LE(0) === SIG_ZIP64_EOCD) {
        total = u64(z64, 32)
        cdSize = u64(z64, 40)
        cdOffset = u64(z64, 48)
        zip64 = true
      }
    }

    const diskNo = tail.readUInt16LE(eocd + 4)
    const diskCd = tail.readUInt16LE(eocd + 6)
    if (diskNo !== 0 || diskCd !== 0) throw new Error('آرشیو چندبخشی پشتیبانی نمی‌شود')
    if (total > 5_000_000) throw new Error('آرشیو بیش از ۵ میلیون عضو دارد')
    if (cdSize > 512 * 1024 * 1024) throw new Error('دایرکتوری مرکزی zip بیش از ۵۱۲ مگابایت است')

    let delta = 0
    let buf = await readRange(fh, cdOffset, cdSize)
    if (buf.length < 4 || buf.readUInt32LE(0) !== SIG_CENTRAL) {
      // Self-extracting archives have a stub before the data; the spec says to trust the EOCD,
      // but every desktop archiver compensates when the recorded offset misses.
      const actual = Math.max(0, st.size - cdSize - commentBytes.length - 22 - (zip64 ? 76 : 0))
      if (actual !== cdOffset) {
        delta = actual - cdOffset
        buf = await readRange(fh, actual, cdSize)
      }
      if (buf.length < 4 || buf.readUInt32LE(0) !== SIG_CENTRAL) {
        throw new Error('دایرکتوری مرکزی zip قابل خواندن نیست')
      }
    }

    const entries: ZipEntry[] = []
    let o = 0
    for (let n = 0; n < total && o + 46 <= buf.length; n++) {
      if (buf.readUInt32LE(o) !== SIG_CENTRAL) break
      const madeBy = buf.readUInt16LE(o + 4)
      const flags = buf.readUInt16LE(o + 8)
      const method = buf.readUInt16LE(o + 10)
      const time = buf.readUInt16LE(o + 12)
      const date = buf.readUInt16LE(o + 14)
      const crc = buf.readUInt32LE(o + 16)
      let csize = buf.readUInt32LE(o + 20)
      let usize = buf.readUInt32LE(o + 24)
      const nameLen = buf.readUInt16LE(o + 28)
      const extraLen = buf.readUInt16LE(o + 30)
      const cmtLen = buf.readUInt16LE(o + 32)
      const diskStart = buf.readUInt16LE(o + 34)
      const external = buf.readUInt32LE(o + 38)
      let localOffset = buf.readUInt32LE(o + 42)
      const nameBytes = buf.subarray(o + 46, o + 46 + nameLen)
      const extra = parseExtra(buf.subarray(o + 46 + nameLen, o + 46 + nameLen + extraLen), {
        usize: usize === U32_MAX,
        csize: csize === U32_MAX,
        offset: localOffset === U32_MAX,
        disk: diskStart === U16_MAX
      })
      const cmt = buf.toString('utf8', o + 46 + nameLen + extraLen, o + 46 + nameLen + extraLen + cmtLen)

      if (usize === U32_MAX && extra.zip64?.usize != null) usize = extra.zip64.usize
      if (csize === U32_MAX && extra.zip64?.csize != null) csize = extra.zip64.csize
      if (localOffset === U32_MAX && extra.zip64?.offset != null) localOffset = extra.zip64.offset
      if (diskStart === U16_MAX && extra.zip64?.disk != null) {
        // multi-disk archives are not supported; the entry simply fails to extract
      }

      const unixMode = madeBy >> 8 === 3 ? (external >>> 16) & 0xffff : 0
      const name = normName(
        extra.unicodeName && extra.unicodeName.trim()
          ? extra.unicodeName
          : decodeName(nameBytes, (flags & 0x800) !== 0)
      )
      if (!name) {
        o += 46 + nameLen + extraLen + cmtLen
        continue
      }
      const type = unixMode & 0o170000
      const symlink = type === 0o120000
      const dir = name.endsWith('/') || type === 0o040000
      const aes = method === 99 && extra.aes ? extra.aes.strength : 0
      const actualMethod = method === 99 && extra.aes ? extra.aes.method : method

      entries.push({
        name: dir ? name.replace(/\/+$/, '') : name,
        dir,
        symlink,
        size: usize,
        csize,
        mtime: extra.mtime || msFromDos(time, date),
        crc,
        method: actualMethod,
        flags,
        encrypted: (flags & 1) !== 0 || method === 99,
        aes,
        mode: unixMode,
        dataOffset: 0,
        localOffset: localOffset + delta,
        comment: cmt
      })
      o += 46 + nameLen + extraLen + cmtLen
    }

    // The local header's data offset is resolved when an entry is actually read: listing a
    // 100 000-entry archive must not issue 100 000 tiny reads.
    return { entries, comment, zip64, offsetDelta: delta }
  } finally {
    await fh.close()
  }
}

/** Listing only — no entry data is read. */
export const listZip = async (file: string): Promise<ZipEntry[]> => (await openZip(file)).entries

/** ── crypto primitives ───────────────────────────────────────────────────── */

const AES_SALT = [0, 8, 12, 16] // index = strength
const AES_KEY = [0, 16, 24, 32]
const AES_AUTH = 10

/** WinZip AES uses AES-CTR with a 128-bit little-endian counter starting at 1. */
class CtrStream extends Transform {
  private cipher: ReturnType<typeof createCipheriv>
  private counter = Buffer.alloc(16)
  private pending = Buffer.alloc(0)
  private hmac?: ReturnType<typeof createHmac>
  private readonly encrypting: boolean

  constructor(key: Buffer, encrypting: boolean, macKey?: Buffer) {
    super()
    this.cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null)
    this.cipher.setAutoPadding(false)
    this.counter[0] = 1
    this.encrypting = encrypting
    if (macKey) this.hmac = createHmac('sha1', macKey)
  }

  private nextKeystream(blocks: number): Buffer {
    const ctr = Buffer.alloc(blocks * 16)
    for (let i = 0; i < blocks; i++) {
      this.counter.copy(ctr, i * 16)
      for (let k = 0; k < 16; k++) {
        this.counter[k] = (this.counter[k] + 1) & 0xff
        if (this.counter[k] !== 0) break
      }
    }
    return this.cipher.update(ctr)
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, done: (e?: Error | null) => void): void {
    try {
      const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
      const blocks = Math.floor(data.length / 16)
      const tail = data.subarray(blocks * 16)
      let out: Buffer | null = null
      if (blocks) {
        const ks = this.nextKeystream(blocks)
        out = Buffer.allocUnsafe(blocks * 16)
        for (let i = 0; i < out.length; i++) out[i] = data[i] ^ ks[i]
        this.push(out)
      }
      // The authentication code covers the ciphertext: the output when encrypting, the input
      // when decrypting. A pending tail is not ciphertext yet on the encrypting side.
      if (this.hmac) this.hmac.update(this.encrypting ? (out ?? Buffer.alloc(0)) : chunk)
      this.pending = Buffer.from(tail)
      done()
    } catch (e) {
      done(e as Error)
    }
  }

  _flush(done: (e?: Error | null) => void): void {
    if (this.pending.length) {
      const ks = this.nextKeystream(1)
      const out = Buffer.allocUnsafe(this.pending.length)
      for (let i = 0; i < out.length; i++) out[i] = this.pending[i] ^ ks[i]
      if (this.hmac && this.encrypting) this.hmac.update(out)
      this.push(out)
      this.pending = Buffer.alloc(0)
    }
    done()
  }

  /** The 10-byte truncated HMAC-SHA1 that authenticates the ciphertext. */
  auth(): Buffer {
    if (!this.hmac) throw new Error('no mac key')
    return this.hmac.digest().subarray(0, AES_AUTH)
  }
}

class ZipCrypto {
  private k0 = 0x12345678
  private k1 = 0x23456789
  private k2 = 0x34567890

  /** The key state starts with the password bytes mixed in, not at the bare constants. */
  constructor(password: Buffer) {
    for (const b of password) this.update(b)
  }

  update(byte: number): void {
    this.k0 = crcRaw(this.k0, byte)
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0
    this.k2 = crcRaw(this.k2, this.k1 >>> 24)
  }

  byte(): number {
    const t = (this.k2 | 2) & 0xffff
    return (Math.imul(t, t ^ 1) >>> 8) & 0xff
  }

  /** Encrypts or decrypts one byte; `plain` updates the key stream for both directions. */
  one(value: number, encrypt: boolean): number {
    const out = value ^ this.byte()
    this.update(encrypt ? value : out)
    return out
  }
}

/** ── reading one entry ───────────────────────────────────────────────────── */

export type EntryStream = {
  stream: Readable
  /** call after the stream ends; verifies the HMAC/CRC and throws when the archive is broken */
  finish(): Promise<void>
}

const aesParams = (entry: ZipEntry) => {
  if (!entry.aes) throw new Error('entry is not AES encrypted')
  const saltLen = AES_SALT[entry.aes]
  const keyLen = AES_KEY[entry.aes]
  if (!saltLen || !keyLen) throw new Error('قدرت رمز AES ناشناخته است')
  return { saltLen, keyLen }
}

/**
 * Opens the payload of one entry. Password verification happens before the stream is handed back,
 * so a wrong password never writes a partial file.
 */
export async function openZipEntry(
  file: string,
  entry: ZipEntry,
  password?: string
): Promise<EntryStream> {
  if (entry.method !== 0 && entry.method !== 8 && entry.method !== 93) {
    throw new Error(`روش فشرده‌سازی ${entry.method} پشتیبانی نمی‌شود`)
  }
  if (entry.encrypted && !password) throw new ArchivePasswordError('این فایل رمز دارد؛ رمز را وارد کن')
  const fh0 = await fs.open(file, 'r')
  const local = Buffer.alloc(30)
  try {
    await fh0.read(local, 0, 30, entry.localOffset)
  } finally {
    await fh0.close()
  }
  if (local.length < 30 || local.readUInt32LE(0) !== SIG_LOCAL) throw new Error('سرصفحهٔ محلی این عضو خراب است')
  const dataOffset = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
  entry.dataOffset = dataOffset

  let start = dataOffset
  let end = dataOffset + entry.csize - 1
  let verifyAuth: (() => void) | null = null
  const stages: Transform[] = []

  if (entry.aes) {
    const { saltLen, keyLen } = aesParams(entry)
    const prefixLen = saltLen + 2
    if (entry.csize < prefixLen + AES_AUTH) throw new Error('بدنهٔ رمزشدهٔ این عضو ناقص است')
    const fh = await fs.open(file, 'r')
    const prefix = Buffer.alloc(prefixLen)
    const auth = Buffer.alloc(AES_AUTH)
    try {
      await fh.read(prefix, 0, prefixLen, dataOffset)
      await fh.read(auth, 0, AES_AUTH, dataOffset + entry.csize - AES_AUTH)
    } finally {
      await fh.close()
    }
    const salt = prefix.subarray(0, saltLen)
    const verifier = prefix.subarray(saltLen)
    const derived = pbkdf2Sync(Buffer.from(password!, 'utf8'), salt, 1000, keyLen * 2 + 2, 'sha1')
    const want = derived.subarray(keyLen * 2, keyLen * 2 + 2)
    if (verifier.length !== 2 || !timingSafeEqual(verifier, want)) throw new ArchivePasswordError()
    const ctr = new CtrStream(derived.subarray(0, keyLen), false, derived.subarray(keyLen, keyLen * 2))
    start = dataOffset + prefixLen
    end = dataOffset + entry.csize - AES_AUTH - 1
    stages.push(ctr)
    verifyAuth = () => {
      const got = ctr.auth()
      if (!timingSafeEqual(got, auth)) throw new ArchivePasswordError()
    }
  } else if (entry.encrypted) {
    if (entry.csize < 12) throw new Error('بدنهٔ رمزشدهٔ این عضو ناقص است')
    const fh = await fs.open(file, 'r')
    const hdr = Buffer.alloc(12)
    try {
      await fh.read(hdr, 0, 12, dataOffset)
    } finally {
      await fh.close()
    }
    const cipher = new ZipCrypto(Buffer.from(password!, 'utf8'))
    for (let i = 0; i < 12; i++) hdr[i] = cipher.one(hdr[i], false)
    // With a data descriptor the check byte is the high byte of the DOS time, not the CRC.
    const expected =
      (entry.flags & 8) !== 0 ? (dosDateTime(entry.mtime).time >>> 8) & 0xff : (entry.crc >>> 24) & 0xff
    if (hdr[11] !== expected) throw new ArchivePasswordError()
    start = dataOffset + 12
    stages.push(
      new Transform({
        transform(chunk: Buffer, _e, cb) {
          const out = Buffer.allocUnsafe(chunk.length)
          for (let i = 0; i < chunk.length; i++) out[i] = cipher.one(chunk[i], false)
          this.push(out)
          cb()
        }
      })
    )
  }

  if (entry.method === 8) stages.push(createInflateRaw())
  else if (entry.method === 93) stages.push(createZstdDecompress())

  let crc = 0
  let outBytes = 0
  const crcCheck = new Transform({
    transform(chunk: Buffer, _e, cb) {
      crc = crc32(chunk, crc)
      outBytes += chunk.length
      cb(null, chunk)
    }
  })

  const source = end >= start ? createReadStream(file, { start, end }) : Readable.from([])
  const out = new PassThrough({ highWaterMark: 1 << 16 })
  const finished = (pipeline as unknown as (...a: unknown[]) => Promise<void>)(
    source,
    ...stages,
    crcCheck,
    out
  )
  // The consumer sees the failure through `out`; keep the promise from becoming an unhandled
  // rejection and re-throw it from finish().
  finished.catch((e: Error) => out.destroy(e))

  return {
    stream: out,
    async finish() {
      await finished
      verifyAuth?.()
      if (entry.aes && entry.crc && crc !== entry.crc) throw new Error('CRC فایل مطابقت ندارد')
      if (!entry.aes && entry.crc && crc !== entry.crc) {
        throw new Error('CRC فایل مطابقت ندارد (آرشیو خراب است)')
      }
      if (outBytes !== entry.size) throw new Error('اندازهٔ استخراج‌شده مطابق سرصفحه نیست')
    }
  }
}

/** ── writing ─────────────────────────────────────────────────────────────── */

export type ZipWriteEntry = {
  /** name inside the archive (`/` separated) */
  name: string
  /** absolute source path; omitted for an empty directory or a symlink */
  abs?: string
  dir?: boolean
  /** symlink target; when set the entry stores the link itself */
  symlink?: string
  mtime?: number
  mode?: number
  /** uncompressed size, when known; the writer falls back to stat */
  size?: number
}

export type ZipWriteOpts = {
  level?: number
  /** `auto` uses deflate for files above 64 bytes, store otherwise */
  method?: 'auto' | 'store' | 'deflate'
  password?: string
  /** aes256 (default), aes192, aes128 or the legacy PKZIP stream cipher */
  encryption?: 'aes256' | 'aes192' | 'aes128' | 'zipcrypto'
  comment?: string
  /** force ZIP64 records even when the sizes would fit (used by the tests) */
  zip64?: boolean
  onProgress?: (p: { done: number; total: number; bytes: number; totalBytes: number }) => void
  signal?: AbortSignal
}

const writeFully = async (fh: fs.FileHandle, buf: Buffer, at: number): Promise<void> => {
  let done = 0
  while (done < buf.length) {
    const { bytesWritten } = await fh.write(buf, done, buf.length - done, at + done)
    if (!bytesWritten) throw new Error('نوشتن در فایل آرشیو متوقف شد')
    done += bytesWritten
  }
}

const UT_EXTRA = (mtime: number): Buffer => {
  const b = Buffer.alloc(9)
  b.writeUInt16LE(0x5455, 0)
  b.writeUInt16LE(5, 2)
  b[4] = 1
  b.writeUInt32LE(Math.max(0, Math.min(0xffffffff, Math.floor(mtime / 1000))), 5)
  return b
}

const AES_EXTRA = (strength: number, method: number): Buffer => {
  const b = Buffer.alloc(11)
  b.writeUInt16LE(0x9901, 0)
  b.writeUInt16LE(7, 2)
  b.writeUInt16LE(2, 4) // AE-2: no CRC in the header
  b.write('AE', 6, 'latin1')
  b[8] = strength
  b.writeUInt16LE(method, 9)
  return b
}

const ZIP64_EXTRA_LOCAL = (usize: number, csize: number): Buffer => {
  const b = Buffer.alloc(20)
  b.writeUInt16LE(0x0001, 0)
  b.writeUInt16LE(16, 2)
  writeU64(b, usize, 4)
  writeU64(b, csize, 12)
  return b
}

/**
 * Streams a ZIP onto disk. Local headers are written with placeholder sizes and patched in place
 * once the entry is on disk, so no data descriptor is needed and every reader (including Windows
 * Explorer) sees a plain, seekable ZIP.
 */
export async function writeZip(
  out: string,
  entries: ZipWriteEntry[],
  opts: ZipWriteOpts = {}
): Promise<{ files: number; bytes: number }> {
  const level = Math.max(0, Math.min(9, Math.trunc(opts.level ?? 6)))
  const methodOpt = opts.method ?? 'auto'
  const password = opts.password ? Buffer.from(opts.password, 'utf8') : null
  const encryption = opts.encryption ?? 'aes256'
  const strength =
    encryption === 'aes128' ? 1 : encryption === 'aes192' ? 2 : encryption === 'aes256' ? 3 : 0
  const comment = Buffer.from(opts.comment ?? '', 'utf8').subarray(0, 0xffff)

  const totals = await Promise.all(
    entries.map(async (e) => {
      if (e.dir) return 0
      if (e.symlink != null) return Buffer.byteLength(e.symlink)
      if (e.size != null) return e.size
      const st = e.abs ? await fs.stat(e.abs) : null
      return st?.size ?? 0
    })
  )
  const totalBytes = totals.reduce((a, b) => a + b, 0)
  const zip64 =
    opts.zip64 === true ||
    entries.length > U16_MAX ||
    totalBytes >= 0xf0000000 ||
    totals.some((n) => n >= 0xf0000000)
  const total = entries.length
  opts.onProgress?.({ done: 0, total, bytes: 0, totalBytes })

  const fh = await fs.open(out, 'w')
  let pos = 0
  let done = 0
  let bytes = 0
  const central: Buffer[] = []

  const write = async (buf: Buffer): Promise<void> => {
    await writeFully(fh, buf, pos)
    pos += buf.length
  }

  try {
    for (let index = 0; index < entries.length; index++) {
      if (opts.signal?.aborted) throw new Error('لغو شد')
      const e = entries[index]
      const isDir = e.dir === true
      const isLink = e.symlink != null
      const clean = isDir ? normName(e.name).replace(/\/+$/, '') : normName(e.name)
      if (!safeArchiveName(clean)) throw new Error(`نام نامعتبر داخل آرشیو: ${e.name}`)
      const name = isDir ? `${clean}/` : clean
      const nameBytes = Buffer.from(name, 'utf8')
      const mtime = e.mtime ?? Date.now()
      const { time, date } = dosDateTime(mtime)
      const sourceSize = totals[index]
      const storeOnly =
        isDir || methodOpt === 'store' || (methodOpt === 'auto' && (level === 0 || sourceSize < 64))
      const actualMethod = storeOnly ? 0 : 8
      const encrypted = !!password && !isDir
      const aes = encrypted && strength ? strength : 0
      const zipCrypto = encrypted && !aes
      const headerMethod = aes ? 99 : actualMethod
      const flags = 0x800 | (encrypted ? 1 : 0)
      const version = aes ? 51 : zip64 ? 45 : 20

      const aesExtra = aes ? AES_EXTRA(aes, actualMethod) : null
      const z64Local = zip64 ? ZIP64_EXTRA_LOCAL(sourceSize, 0) : null
      const ut = UT_EXTRA(mtime)
      // APPNOTE asks for the ZIP64 extra field to come first; 7-Zip rejects a ZIP64+AES
      // local header that puts the AES field in front of it.
      const extra = Buffer.concat([
        ...(z64Local ? [z64Local] : []),
        ...(aesExtra ? [aesExtra] : []),
        ut
      ])

      const header = Buffer.alloc(30)
      header.writeUInt32LE(SIG_LOCAL, 0)
      header.writeUInt16LE(version, 4)
      header.writeUInt16LE(flags, 6)
      header.writeUInt16LE(headerMethod, 8)
      header.writeUInt16LE(time, 10)
      header.writeUInt16LE(date, 12)
      header.writeUInt32LE(0, 14)
      header.writeUInt32LE(zip64 ? U32_MAX : 0, 18)
      header.writeUInt32LE(zip64 ? U32_MAX : 0, 22)
      header.writeUInt16LE(nameBytes.length, 26)
      header.writeUInt16LE(extra.length, 28)

      const headerPos = pos
      await write(header)
      await write(nameBytes)
      await write(extra)

      let crc = 0
      let usize = 0
      let csize = 0
      let lastReport = 0
      let lastReportBytes = 0
      // Per-chunk reporting keeps the bar alive inside one huge file; 120 ms or 4 MB keeps the
      // IPC channel quiet without ever freezing the bar on a fast disk.
      const report = (force = false): void => {
        const now = Date.now()
        const sent = bytes + usize
        if (!force && now - lastReport < 120 && sent - lastReportBytes < 4 * 1024 * 1024) return
        lastReport = now
        lastReportBytes = sent
        opts.onProgress?.({ done, total, bytes: sent, totalBytes })
      }

      const feed = async (source: Buffer | string): Promise<void> => {
        let enc: Transform | null = null
        let auth: (() => Buffer) | null = null

        if (aes) {
          const saltLen = AES_SALT[aes]
          const keyLen = AES_KEY[aes]
          const salt = randomBytes(saltLen)
          const derived = pbkdf2Sync(password!, salt, 1000, keyLen * 2 + 2, 'sha1')
          const ctr = new CtrStream(
            derived.subarray(0, keyLen),
            true,
            derived.subarray(keyLen, keyLen * 2)
          )
          const prefix = Buffer.concat([salt, derived.subarray(keyLen * 2, keyLen * 2 + 2)])
          await write(prefix)
          csize += prefix.length
          enc = ctr
          auth = () => ctr.auth()
        } else if (zipCrypto) {
          // The check byte needs the CRC, so ZipCrypto is two-pass; only this legacy mode pays it.
          let passCrc = 0
          if (Buffer.isBuffer(source)) passCrc = crc32(source)
          else for await (const chunk of createReadStream(source)) passCrc = crc32(chunk as Buffer, passCrc)
          const keys = new ZipCrypto(password!)
          const plain = randomBytes(12)
          plain[11] = (passCrc >>> 24) & 0xff
          const encHead = Buffer.alloc(12)
          for (let i = 0; i < 12; i++) encHead[i] = keys.one(plain[i], true)
          await write(encHead)
          csize += 12
          // The streaming CRC transform starts from zero; `passCrc` only feeds the check byte.
          crc = 0
          const c = keys
          enc = new Transform({
            transform(chunk: Buffer, _e, cb) {
              const outBuf = Buffer.allocUnsafe(chunk.length)
              for (let i = 0; i < chunk.length; i++) outBuf[i] = c.one(chunk[i], true)
              this.push(outBuf)
              cb()
            }
          })
        }

        const crcT = new Transform({
          transform(chunk: Buffer, _e, cb) {
            crc = crc32(chunk, crc)
            usize += chunk.length
            report()
            cb(null, chunk)
          }
        })
        const def = actualMethod === 8 ? createDeflateRaw({ level }) : null
        const sink = new Writable({
          write(chunk: Buffer, _e, cb) {
            csize += chunk.length
            writeFully(fh, chunk, pos).then(() => {
              pos += chunk.length
              cb()
            }, cb)
          }
        })

        const stages: (Transform | Writable)[] = [crcT]
        if (def) stages.push(def)
        if (enc) stages.push(enc)
        stages.push(sink)
        const input = Buffer.isBuffer(source) ? Readable.from([source]) : createReadStream(source)
        await (pipeline as unknown as (...a: unknown[]) => Promise<void>)(input, ...stages, {
          signal: opts.signal
        })
        if (auth) {
          const tag = auth()
          await write(tag)
          csize += tag.length
        }
      }

      if (isDir) {
        // directory: header only
      } else if (isLink) {
        await feed(Buffer.from(e.symlink!, 'utf8'))
      } else {
        if (!e.abs) throw new Error(`مسیر منبع برای ${e.name} نیست`)
        await feed(e.abs)
      }

      if (!isDir) {
        if (zip64) {
          const crcBuf = Buffer.alloc(4)
          crcBuf.writeUInt32LE(aes ? 0 : crc, 0)
          const sizes = Buffer.alloc(16)
          // The local ZIP64 extra is (uncompressed size, compressed size) in that order.
          writeU64(sizes, usize, 0)
          writeU64(sizes, csize, 8)
          await writeFully(fh, crcBuf, headerPos + 14)
          const z64At = headerPos + 30 + nameBytes.length
          await writeFully(fh, sizes, z64At + 4)
        } else {
          const patch = Buffer.alloc(12)
          patch.writeUInt32LE(aes ? 0 : crc, 0)
          patch.writeUInt32LE(csize, 4)
          patch.writeUInt32LE(usize, 8)
          await writeFully(fh, patch, headerPos + 14)
        }
      }

      const unixMode = e.mode
        ? e.mode & 0xffff
        : isDir
          ? 0o40755
          : isLink
            ? 0o120777
            : 0o100644
      const external = (((unixMode << 16) >>> 0) | (isDir ? 0x10 : 0)) >>> 0

      const cExtra: Buffer[] = []
      if (zip64) {
        const z = Buffer.alloc(28)
        z.writeUInt16LE(0x0001, 0)
        z.writeUInt16LE(24, 2)
        writeU64(z, usize, 4)
        writeU64(z, csize, 12)
        writeU64(z, headerPos, 20)
        cExtra.push(z)
      }
      if (aes) cExtra.push(AES_EXTRA(aes, actualMethod))
      cExtra.push(UT_EXTRA(mtime))
      const cExtraBuf = Buffer.concat(cExtra)

      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(SIG_CENTRAL, 0)
      cd.writeUInt16LE(0x033f, 4)
      cd.writeUInt16LE(version, 6)
      cd.writeUInt16LE(flags, 8)
      cd.writeUInt16LE(headerMethod, 10)
      cd.writeUInt16LE(time, 12)
      cd.writeUInt16LE(date, 14)
      cd.writeUInt32LE(aes ? 0 : crc, 16)
      cd.writeUInt32LE(zip64 ? U32_MAX : csize, 20)
      cd.writeUInt32LE(zip64 ? U32_MAX : usize, 24)
      cd.writeUInt16LE(nameBytes.length, 28)
      cd.writeUInt16LE(cExtraBuf.length, 30)
      cd.writeUInt16LE(0, 32)
      cd.writeUInt16LE(0, 34)
      cd.writeUInt32LE(external, 38)
      cd.writeUInt32LE(zip64 ? U32_MAX : headerPos, 42)
      central.push(Buffer.concat([cd, nameBytes, cExtraBuf]))

      bytes += usize
      usize = 0
      done++
      report(true)
    }

    if (opts.signal?.aborted) throw new Error('لغو شد')
    const cdStart = pos
    const cdBuf = Buffer.concat(central)
    await write(cdBuf)

    if (zip64) {
      const z = Buffer.alloc(56)
      z.writeUInt32LE(SIG_ZIP64_EOCD, 0)
      writeU64(z, 44, 4)
      z.writeUInt16LE(0x033f, 12)
      z.writeUInt16LE(45, 14)
      z.writeUInt32LE(0, 16)
      z.writeUInt32LE(0, 20)
      writeU64(z, entries.length, 24)
      writeU64(z, entries.length, 32)
      writeU64(z, cdBuf.length, 40)
      writeU64(z, cdStart, 48)
      const loc = Buffer.alloc(20)
      loc.writeUInt32LE(SIG_ZIP64_LOCATOR, 0)
      loc.writeUInt32LE(0, 4)
      writeU64(loc, pos, 8)
      loc.writeUInt32LE(1, 16)
      await write(z)
      await write(loc)
    }

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(SIG_EOCD, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(zip64 ? U16_MAX : entries.length, 8)
    eocd.writeUInt16LE(zip64 ? U16_MAX : entries.length, 10)
    eocd.writeUInt32LE(zip64 ? U32_MAX : cdBuf.length, 12)
    eocd.writeUInt32LE(zip64 ? U32_MAX : cdStart, 16)
    eocd.writeUInt16LE(comment.length, 20)
    await write(Buffer.concat([eocd, comment]))
    await fh.sync()
  } catch (e) {
    await fh.close().catch(() => undefined)
    await fs.rm(out, { force: true }).catch(() => undefined)
    throw e
  } finally {
    await fh.close().catch(() => undefined)
  }
  return { files: entries.filter((e) => !e.dir).length, bytes }
}

/** Root-relative path of every member, handy for a destination folder name. */
export const archiveStem = (file: string): string => {
  const stem = path
    .basename(file)
    .replace(/\.(zip|cbz|tar|tgz|tar\.gz|tar\.bz2|tbz2|tbz|tar\.xz|txz|tar\.zst|tzst)$/i, '')
  // A name like `...zip` would otherwise produce ".." and point the "extract to a folder"
  // option at the destination's parent.
  return stem && stem !== '.' && stem !== '..' && safeArchiveName(stem) ? stem : 'archive'
}
