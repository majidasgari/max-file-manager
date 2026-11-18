import test from 'node:test'
import assert from 'node:assert/strict'
import { RAW_IMAGE_MAX_BYTES, rawImageType } from './image-mime.ts'

test('formats nativeImage cannot decode get the MIME Chromium needs', () => {
  assert.equal(rawImageType('/home/me/logo.svg'), 'image/svg+xml')
  assert.equal(rawImageType('/home/me/photo.webp'), 'image/webp')
  assert.equal(rawImageType('/home/me/photo.WEBP'), 'image/webp')
  assert.equal(rawImageType('/home/me/anim.gif'), 'image/gif')
  assert.equal(rawImageType('/home/me/legacy.bmp'), 'image/bmp')
  assert.equal(rawImageType('/home/me/app.ico'), 'image/x-icon')
  assert.equal(rawImageType('/home/me/new.avif'), 'image/avif')
})

test('a real thumbnail and an unknown format stay with the PNG pipeline', () => {
  assert.equal(rawImageType('/home/me/photo.png'), null)
  assert.equal(rawImageType('/home/me/photo.JPG'), null)
  assert.equal(rawImageType('/home/me/scan.tiff'), null)
  assert.equal(rawImageType('/home/me/README'), null)
  assert.equal(rawImageType('/home/me/folder.svg/'), null)
  assert.ok(RAW_IMAGE_MAX_BYTES > 8 * 1024 * 1024)
})
