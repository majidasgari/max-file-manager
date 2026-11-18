import assert from 'node:assert/strict'
import test from 'node:test'
import { addTracks, stepIndex } from './music.ts'

test('addTracks appends in order and never keeps a track twice', () => {
  assert.deepEqual(addTracks([], []), [])
  assert.deepEqual(addTracks([], ['/a.mp3', '/b.flac']), ['/a.mp3', '/b.flac'])
  assert.deepEqual(addTracks(['/a.mp3'], ['/a.mp3', '/c.ogg', '/b.flac']), [
    '/a.mp3',
    '/c.ogg',
    '/b.flac'
  ])
})

test('stepIndex stops at both ends instead of wrapping', () => {
  const list = ['/a.mp3', '/b.mp3']
  assert.equal(stepIndex(list, -1, 1), 0)
  assert.equal(stepIndex(list, 0, 1), 1)
  assert.equal(stepIndex(list, 1, 1), -1)
  assert.equal(stepIndex(list, 0, -1), -1)
  assert.equal(stepIndex([], -1, 1), -1)
})
