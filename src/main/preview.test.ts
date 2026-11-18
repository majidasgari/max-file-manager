import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hashFile, hashMany } from './hash.ts'
import { preview } from './preview.ts'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'mfm-prev-'))

test('preview: text, binary, image, directory', async () => {
  const root = await tmp()
  const txt = path.join(root, 'a.txt')
  await fs.writeFile(txt, 'line one\nline two\n')
  const t = await preview(txt)
  assert.equal(t.kind, 'text')
  assert.match(t.text!, /line two/)
  assert.equal(t.size, 18)

  const bin = path.join(root, 'b.bin')
  await fs.writeFile(bin, Buffer.from([1, 0, 2, 3]))
  assert.equal((await preview(bin)).kind, 'binary', 'a NUL byte means binary, not text')

  const img = path.join(root, 'c.png')
  await fs.writeFile(img, Buffer.alloc(10))
  assert.equal((await preview(img)).kind, 'image')

  // .ts is TypeScript in a source tree, not an MPEG transport stream
  const code = path.join(root, 'd.ts')
  await fs.writeFile(code, 'export const x = 1\n')
  assert.equal((await preview(code)).kind, 'text')

  assert.equal((await preview(root)).kind, 'dir')
})

test('preview: long text is capped and says so', async () => {
  const root = await tmp()
  const big = path.join(root, 'big.log')
  await fs.writeFile(big, 'x'.repeat(300 * 1024))
  const p = await preview(big)
  assert.equal(p.kind, 'text')
  assert.equal(p.capped, true)
  assert.equal(p.text!.length, 200 * 1024)
})

test('preview: office documents get no preview at all', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mfm-office-'))
  const file = path.join(dir, 'a.docx')
  await fs.writeFile(file, 'not really a zip')
  const p = await preview(file)
  assert.equal(p.kind, 'binary')
  assert.equal('text' in p ? p.text : '', '')
})

test('hash: sha256 is stable and a missing file returns null', async () => {
  const root = await tmp()
  const f = path.join(root, 'x.txt')
  await fs.writeFile(f, 'hello')
  assert.equal(
    await hashFile(f),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  )
  assert.equal(await hashFile(path.join(root, 'nope')), null)
  const many = await hashMany([f, path.join(root, 'nope')])
  assert.equal(many.length, 2)
  assert.equal(many[1].hash, null)
})
