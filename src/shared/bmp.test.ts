import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeBmp } from './bmp.ts'

test('encodeBmp writes a valid 24-bit file header', () => {
  const bmp = encodeBmp(new Uint8ClampedArray(2 * 2 * 4).fill(255), 2, 2)
  assert.equal(String.fromCharCode(bmp[0], bmp[1]), 'BM')
  const view = new DataView(bmp.buffer)
  const rowSize = 8 // 2 px × 3 bytes = 6 → padded to 8
  assert.equal(view.getUint32(2, true), 54 + rowSize * 2)
  assert.equal(view.getUint32(10, true), 54)
  assert.equal(view.getUint32(14, true), 40)
  assert.equal(view.getInt32(18, true), 2)
  assert.equal(view.getInt32(22, true), 2)
  assert.equal(view.getUint16(28, true), 24)
  assert.equal(view.getUint32(34, true), rowSize * 2)
})

test('rows are bottom-up and pixels are BGR with padding', () => {
  // top-left red, top-right green, bottom-left blue, bottom-right white
  const px = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255
  ])
  const bmp = encodeBmp(px, 2, 2)
  // first stored row is the bottom one: blue then white
  assert.deepEqual([...bmp.slice(54, 57)], [255, 0, 0])
  assert.deepEqual([...bmp.slice(57, 60)], [255, 255, 255])
  assert.deepEqual([...bmp.slice(60, 62)], [0, 0]) // padding
  // second row: red then green
  assert.deepEqual([...bmp.slice(62, 65)], [0, 0, 255])
  assert.deepEqual([...bmp.slice(65, 68)], [0, 255, 0])
})

test('alpha is composited over white', () => {
  const bmp = encodeBmp(new Uint8ClampedArray([0, 0, 0, 128]), 1, 1)
  // 50% black over white ≈ 127 in every channel (255 × (1 − 128/255))
  assert.deepEqual([...bmp.slice(54, 57)], [127, 127, 127])
})

test('a zero size never produces a broken file', () => {
  const bmp = encodeBmp(new Uint8ClampedArray(0), 0, 0)
  const view = new DataView(bmp.buffer)
  assert.equal(view.getInt32(18, true), 1)
  assert.equal(view.getInt32(22, true), 1)
})
