/**
 * User fonts: any ttf/otf/woff/woff2 the person drops in is copied into `userData/fonts` and the
 * renderer registers it with the FontFace API. Electron stays out of this file on purpose (the
 * folder is a parameter) so the parser and the store can be tested with `node --test`.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export const FONT_EXTS = ['.ttf', '.otf', '.woff', '.woff2']
export const MAX_FONT_BYTES = 64 * 1024 * 1024

export type UserFont = { id: string; family: string; size: number }

const u16 = (b: Buffer, off: number): number =>
  off >= 0 && off + 2 <= b.length ? b.readUInt16BE(off) : -1
const u32 = (b: Buffer, off: number): number =>
  off >= 0 && off + 4 <= b.length ? b.readUInt32BE(off) : -1

/** name strings are UTF-16BE; Node decodes LE, so swap (an odd trailing byte is dropped). */
const utf16be = (raw: Buffer): string => {
  const even = raw.length % 2 === 0 ? raw : raw.subarray(0, raw.length - 1)
  const swapped = Buffer.from(even)
  swapped.swap16()
  return swapped.toString('utf16le')
}

/** Family name out of a `name` table: typographic family (16) first, then the legacy one (1). */
const nameFamily = (table: Buffer): string => {
  const format = u16(table, 0)
  const count = u16(table, 2)
  const storage = u16(table, 4)
  if (format < 0 || count <= 0 || count > 4096 || storage < 0) return ''
  let best = ''
  let bestScore = -1
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12
    if (rec + 12 > table.length) break
    const platform = u16(table, rec)
    const encoding = u16(table, rec + 2)
    const language = u16(table, rec + 4)
    const nameID = u16(table, rec + 6)
    const length = u16(table, rec + 8)
    const offset = u16(table, rec + 10)
    if (nameID !== 1 && nameID !== 16) continue
    const start = storage + offset
    if (length <= 0 || start < 0 || start + length > table.length) continue
    const raw = table.subarray(start, start + length)
    let text = ''
    if (platform === 3 || platform === 0) text = utf16be(raw)
    else if (platform === 1 && encoding === 0) text = raw.toString('latin1')
    else continue
    text = text.replace(/\u0000/g, '').trim()
    if (!text) continue
    // typographic family beats the legacy one; a Windows/English record beats the rest
    const score =
      (nameID === 16 ? 4 : 0) + (platform === 3 ? 2 : 0) + (language === 0x409 || language === 0 ? 1 : 0)
    if (score > bestScore) {
      bestScore = score
      best = text
    }
  }
  return best
}

const SFNT_TAGS = ['\x00\x01\x00\x00', 'OTTO', 'true', 'typ1']

/** Offset of the first font inside a file: 0 for a plain sfnt, the first face for a collection. */
const sfntBase = (b: Buffer): number => {
  const tag = b.toString('latin1', 0, 4)
  if (tag === 'ttcf') {
    const n = u32(b, 8)
    return n > 0 ? u32(b, 12) : -1
  }
  return SFNT_TAGS.includes(tag) ? 0 : -1
}

const sfntName = (b: Buffer, base: number): Buffer | null => {
  const num = u16(b, base + 4)
  if (num <= 0 || num > 4096) return null
  for (let i = 0; i < num; i++) {
    const rec = base + 12 + i * 16
    if (rec + 16 > b.length) return null
    if (b.toString('latin1', rec, rec + 4) !== 'name') continue
    const off = u32(b, rec + 8)
    const len = u32(b, rec + 12)
    if (off < 0 || len <= 0 || off + len > b.length) return null
    return b.subarray(off, off + len)
  }
  return null
}

/** WOFF 1: the same table directory, but each table may be zlib-compressed. */
const woff1Name = (b: Buffer): Buffer | null => {
  const num = u16(b, 12)
  if (num <= 0 || num > 4096) return null
  for (let i = 0; i < num; i++) {
    const rec = 44 + i * 20
    if (rec + 20 > b.length) return null
    if (b.toString('latin1', rec, rec + 4) !== 'name') continue
    const off = u32(b, rec + 4)
    const comp = u32(b, rec + 8)
    const orig = u32(b, rec + 12)
    if (off < 0 || comp <= 0 || off + comp > b.length) return null
    const raw = b.subarray(off, off + comp)
    if (comp === orig) return raw
    return orig > MAX_FONT_BYTES ? null : zlib.inflateSync(raw)
  }
  return null
}

/** The 63 tags WOFF2 numbers instead of spelling out; `name` is 5. */
const WOFF2_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill'
]

/** WOFF2 variable-length integer (UIntBase128). */
const base128 = (b: Buffer, at: number): { value: number; next: number } | null => {
  let value = 0
  for (let i = 0; i < 5; i++) {
    const pos = at + i
    if (pos >= b.length) return null
    const byte = b[pos]
    if (i === 0 && byte === 0x80) return null
    value = value * 128 + (byte & 0x7f)
    if (value > 0xffffffff) return null
    if ((byte & 0x80) === 0) return { value, next: pos + 1 }
  }
  return null
}

/**
 * WOFF2 packs all tables into one Brotli stream; the directory only has lengths, so decompress the
 * stream and walk it to the `name` table (never transformed, unlike glyf/loca).
 */
const woff2Name = (b: Buffer): Buffer | null => {
  const num = u16(b, 12)
  const compressedSize = u32(b, 20)
  if (num <= 0 || num > 4096 || compressedSize <= 0) return null
  let at = 48
  const tables: { tag: string; length: number; transformed: boolean }[] = []
  for (let i = 0; i < num; i++) {
    if (at >= b.length) return null
    const flags = b[at++]
    const index = flags & 0x3f
    const version = flags >> 6
    let tag: string
    if (index === 63) {
      if (at + 4 > b.length) return null
      tag = b.toString('latin1', at, at + 4)
      at += 4
    } else tag = WOFF2_TAGS[index] ?? ''
    const orig = base128(b, at)
    if (!orig) return null
    at = orig.next
    const transformed = (tag === 'glyf' || tag === 'loca') && version === 0
    let length = orig.value
    if (transformed) {
      const t = base128(b, at)
      if (!t) return null
      at = t.next
      length = t.value
    }
    tables.push({ tag, length, transformed })
  }
  if (at + compressedSize > b.length) return null
  const data = zlib.brotliDecompressSync(b.subarray(at, at + compressedSize), {
    maxOutputLength: MAX_FONT_BYTES
  })
  let cursor = 0
  for (const t of tables) {
    if (t.tag === 'name' && !t.transformed) {
      if (cursor + t.length > data.length) return null
      return data.subarray(cursor, cursor + t.length)
    }
    cursor += t.length
  }
  return null
}

/** The family a font file calls itself; '' when the format cannot be read (woff2 is handled too). */
export function familyFromFontData(input: Uint8Array | Buffer): string {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (b.length < 12) return ''
  try {
    const tag = b.toString('latin1', 0, 4)
    let table: Buffer | null
    if (tag === 'wOFF') table = woff1Name(b)
    else if (tag === 'wOF2') table = woff2Name(b)
    else {
      const base = sfntBase(b)
      table = base >= 0 ? sfntName(b, base) : null
    }
    const family = table ? nameFamily(table) : ''
    return family
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/[,;{}()<>\\/"]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
  } catch {
    return ''
  }
}

export const isFontFile = (name: string): boolean =>
  FONT_EXTS.includes(path.extname(String(name ?? '')).toLowerCase())

/** A file name from the renderer must stay a bare name inside our own folder. */
export const safeFontId = (raw: unknown): string => {
  const name = String(raw ?? '')
  if (!name || name !== path.basename(name) || name.startsWith('.')) return ''
  return isFontFile(name) ? name : ''
}

/**
 * Fallback when the file carries no readable name table: `inter-latin-wght-normal.woff2` becomes
 * "inter", "IBM-Plex-Sans-Bold.otf" becomes "IBM Plex Sans".
 */
export const familyFromFileName = (name: string): string => {
  const stem = path.basename(String(name ?? ''), path.extname(String(name ?? '')))
  const style = /[-_ ]+(regular|normal|bold|italic|oblique|light|medium|semibold|black|thin|extralight|extrabold|variable|wght|webfont|display|text)+$/i
  let base = stem
  for (let i = 0; i < 8 && style.test(base); i++) base = base.replace(style, '')
  // webfont downloads end in one subset token (`inter-latin-wght-normal`); keep the family readable
  base = base.replace(
    /[-_ ](latin-ext|latin|cyrillic-ext|cyrillic|greek-ext|greek|vietnamese|arabic|hebrew|thai|devanagari|math|symbols)$/i,
    ''
  )
  const spaced = base.replace(/[-_]+/g, ' ').trim()
  return spaced || stem
}

const familyOf = async (file: string): Promise<string> => {
  const buf = await fs.readFile(file).catch(() => null)
  if (!buf) return ''
  return familyFromFontData(buf) || familyFromFileName(file)
}

/** `dir/name.ext`, then `dir/name (2).ext`, … — an import never overwrites an earlier font. */
const freePath = async (dir: string, stem: string, ext: string): Promise<string> => {
  for (let n = 1; n < 1000; n++) {
    const target = path.join(dir, n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`)
    if (!(await fs.stat(target).catch(() => null))) return target
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`)
}

export async function listUserFonts(dir: string): Promise<UserFont[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const out: UserFont[] = []
  for (const name of names) {
    if (!isFontFile(name) || name.startsWith('.')) continue
    const file = path.join(dir, name)
    const st = await fs.stat(file).catch(() => null)
    if (!st?.isFile()) continue
    out.push({ id: name, family: (await familyOf(file)) || name, size: st.size })
  }
  return out.sort((a, b) => a.family.localeCompare(b.family))
}

export async function importUserFont(
  dir: string,
  src: string
): Promise<UserFont | { error: string }> {
  if (!path.isAbsolute(src)) return { error: 'bad_path' }
  if (!isFontFile(src)) return { error: 'unsupported_font' }
  const st = await fs.stat(src).catch(() => null)
  if (!st?.isFile()) return { error: 'not_a_file' }
  if (st.size <= 0 || st.size > MAX_FONT_BYTES) return { error: 'bad_size' }
  const buf = await fs.readFile(src).catch(() => null)
  if (!buf) return { error: 'unreadable' }
  const family = familyFromFontData(buf) || familyFromFileName(src)
  if (!family) return { error: 'unnamed' }
  await fs.mkdir(dir, { recursive: true })
  const ext = path.extname(src).toLowerCase()
  const target = await freePath(dir, path.basename(src, path.extname(src)), ext)
  await fs.writeFile(target, buf)
  return { id: path.basename(target), family, size: buf.length }
}

export async function removeUserFont(dir: string, id: unknown): Promise<boolean> {
  const name = safeFontId(id)
  if (!name) return false
  const st = await fs.stat(path.join(dir, name)).catch(() => null)
  if (!st?.isFile()) return false
  await fs.rm(path.join(dir, name), { force: true })
  return true
}

/** Bytes for the renderer, which turns them into an `FontFace` (no URL and no CSP change). */
export async function readUserFont(dir: string, id: unknown): Promise<Buffer | null> {
  const name = safeFontId(id)
  if (!name) return null
  const file = path.join(dir, name)
  const st = await fs.stat(file).catch(() => null)
  if (!st?.isFile() || st.size > MAX_FONT_BYTES) return null
  return fs.readFile(file).catch(() => null)
}
