import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  familyFromFileName,
  familyFromFontData,
  importUserFont,
  isFontFile,
  listUserFonts,
  readUserFont,
  removeUserFont,
  safeFontId
} from './fonts.ts'

/** A minimal `name` table with one Windows/English legacy-family record. */
const nameTable = (family: string): Buffer => {
  const text = Buffer.from(family, 'utf16le')
  text.swap16()
  const header = Buffer.alloc(6)
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(1, 2)
  header.writeUInt16BE(6 + 12, 4)
  const rec = Buffer.alloc(12)
  rec.writeUInt16BE(3, 0)
  rec.writeUInt16BE(1, 2)
  rec.writeUInt16BE(0x409, 4)
  rec.writeUInt16BE(1, 6)
  rec.writeUInt16BE(text.length, 8)
  rec.writeUInt16BE(0, 10)
  return Buffer.concat([header, rec, text])
}

/** One-table sfnt (ttf/otf container). */
const sfnt = (table: Buffer): Buffer => {
  const head = Buffer.alloc(12)
  head.writeUInt32BE(0x00010000, 0)
  head.writeUInt16BE(1, 4)
  head.writeUInt16BE(16, 6)
  const rec = Buffer.alloc(16)
  rec.write('name', 0, 'latin1')
  rec.writeUInt32BE(12 + 16, 8)
  rec.writeUInt32BE(table.length, 12)
  return Buffer.concat([head, rec, table])
}

const woff1 = (table: Buffer): Buffer => {
  const header = Buffer.alloc(44)
  header.write('wOFF', 0, 'latin1')
  header.writeUInt32BE(0x00010000, 4)
  header.writeUInt32BE(44 + 20 + table.length, 8)
  header.writeUInt16BE(1, 12)
  const rec = Buffer.alloc(20)
  rec.write('name', 0, 'latin1')
  rec.writeUInt32BE(44 + 20, 4)
  rec.writeUInt32BE(table.length, 8)
  rec.writeUInt32BE(table.length, 12)
  return Buffer.concat([header, rec, table])
}

const base128 = (value: number): number[] => {
  const out = [value & 0x7f]
  let v = Math.floor(value / 128)
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  return out
}

const woff2 = (table: Buffer): Buffer => {
  const dir = Buffer.from([63, ...'name'.split('').map((c) => c.charCodeAt(0)), ...base128(table.length)])
  const body = zlib.brotliCompressSync(table)
  const header = Buffer.alloc(48)
  header.write('wOF2', 0, 'latin1')
  header.writeUInt32BE(0x00010000, 4)
  header.writeUInt32BE(48 + dir.length + body.length, 8)
  header.writeUInt16BE(1, 12)
  header.writeUInt32BE(table.length, 16)
  header.writeUInt32BE(body.length, 20)
  return Buffer.concat([header, dir, body])
}

test('font family is read from sfnt, woff and woff2 containers', () => {
  const table = nameTable('Test Family')
  assert.equal(familyFromFontData(sfnt(table)), 'Test Family')
  assert.equal(familyFromFontData(woff1(table)), 'Test Family')
  assert.equal(familyFromFontData(woff2(table)), 'Test Family')
  assert.equal(familyFromFontData(Buffer.from('not a font at all')), '')
  assert.equal(familyFromFontData(Buffer.alloc(0)), '')
})

test('a typographic family (nameID 16) wins over the legacy one', () => {
  const text = Buffer.from('Real Family', 'utf16le')
  text.swap16()
  const header = Buffer.alloc(6)
  header.writeUInt16BE(0, 0)
  header.writeUInt16BE(2, 2)
  header.writeUInt16BE(6 + 24, 4)
  const legacy = Buffer.alloc(12)
  legacy.writeUInt16BE(3, 0)
  legacy.writeUInt16BE(1, 2)
  legacy.writeUInt16BE(0x409, 4)
  legacy.writeUInt16BE(1, 6)
  legacy.writeUInt16BE(text.length, 8)
  legacy.writeUInt16BE(0, 10)
  const typo = Buffer.alloc(12)
  typo.writeUInt16BE(3, 0)
  typo.writeUInt16BE(1, 2)
  typo.writeUInt16BE(0x409, 4)
  typo.writeUInt16BE(16, 6)
  typo.writeUInt16BE(text.length, 8)
  typo.writeUInt16BE(0, 10)
  const table = Buffer.concat([header, legacy, typo, text])
  assert.equal(familyFromFontData(sfnt(table)), 'Real Family')
})

test('file names are a readable fallback, and never a path', () => {
  assert.equal(familyFromFileName('Inter-Regular.ttf'), 'Inter')
  assert.equal(familyFromFileName('IBM_Plex_Sans-Bold.otf'), 'IBM Plex Sans')
  assert.equal(familyFromFileName('inter-latin-wght-normal.woff2'), 'inter')
  assert.equal(isFontFile('a.ttf'), true)
  assert.equal(isFontFile('a.TTF'), true)
  assert.equal(isFontFile('a.png'), false)
  assert.equal(safeFontId('one.ttf'), 'one.ttf')
  assert.equal(safeFontId('../evil.ttf'), '')
  assert.equal(safeFontId('/etc/evil.ttf'), '')
  assert.equal(safeFontId('.hidden.ttf'), '')
  assert.equal(safeFontId('evil.sh'), '')
})

test('import, list, read and remove keep fonts inside the app folder', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mfm-fonts-'))
  const dir = path.join(root, 'fonts')
  const src = path.join(root, 'MyFace-Bold.ttf')
  await fs.writeFile(src, sfnt(nameTable('My Face')))

  const first = await importUserFont(dir, src)
  assert.ok('family' in first)
  assert.equal(first.family, 'My Face')
  assert.equal(first.id, 'MyFace-Bold.ttf')

  // a second import of the same file must not overwrite the first copy
  const second = await importUserFont(dir, src)
  assert.ok('family' in second)
  assert.equal(second.id, 'MyFace-Bold (2).ttf')

  const listed = await listUserFonts(dir)
  assert.deepEqual(
    listed.map((f) => f.id),
    ['MyFace-Bold (2).ttf', 'MyFace-Bold.ttf']
  )
  assert.ok(listed.every((f) => f.family === 'My Face'))

  const bytes = await readUserFont(dir, 'MyFace-Bold.ttf')
  assert.ok(bytes && bytes.length > 0)
  assert.equal(await readUserFont(dir, '../MyFace-Bold.ttf'), null)

  assert.equal(await removeUserFont(dir, 'MyFace-Bold.ttf'), true)
  assert.equal(await removeUserFont(dir, 'MyFace-Bold.ttf'), false)
  assert.equal(await removeUserFont(dir, '../x.ttf'), false)
  assert.deepEqual(
    (await listUserFonts(dir)).map((f) => f.id),
    ['MyFace-Bold (2).ttf']
  )
  assert.deepEqual(await listUserFonts(path.join(root, 'missing')), [])
  await fs.rm(root, { recursive: true, force: true })
})

test('import refuses something that is not a font file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mfm-fonts-'))
  const txt = path.join(root, 'notes.txt')
  await fs.writeFile(txt, 'hello')
  const r = await importUserFont(path.join(root, 'fonts'), txt)
  assert.ok('error' in r)
  assert.equal(r.error, 'unsupported_font')
  await fs.rm(root, { recursive: true, force: true })
})
