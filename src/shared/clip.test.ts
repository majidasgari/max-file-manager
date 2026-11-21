import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeClipTexts, parseClipText } from './clip.ts'

test('uri-list becomes paths, file URLs lose their scheme', () => {
  const c = parseClipText('file:///D:/Codes/a.txt\r\nfile:///D:/Codes/b%20c.txt\r\n')
  assert.deepEqual(c.paths, ['D:/Codes/a.txt', 'D:/Codes/b c.txt'])
  assert.equal(c.cut, false)
})

test('POSIX file URLs stay absolute', () => {
  assert.deepEqual(parseClipText('file:///home/max/a.txt').paths, ['/home/max/a.txt'])
})

test('the gnome header decides copy or cut, and comments are ignored', () => {
  assert.equal(parseClipText('cut\r\nfile:///home/max/a').cut, true)
  assert.equal(parseClipText('copy\r\nfile:///home/max/a').cut, false)
  assert.deepEqual(parseClipText('# a comment\r\n/home/max/a').paths, ['/home/max/a'])
})

test('duplicates and blank lines never reach the queue', () => {
  const c = parseClipText('D:/x/a.txt\n\nD:/x/a.txt\n  \n')
  assert.deepEqual(c.paths, ['D:/x/a.txt'])
})

test('mergeClipTexts unions the flavours and keeps a cut', () => {
  const merged = mergeClipTexts(['file:///D:/a.txt', 'cut\nD:/a.txt\nD:/b.txt'])
  assert.deepEqual(merged.paths, ['D:/a.txt', 'D:/b.txt'])
  assert.equal(merged.cut, true)
})

test('a non-file URI is not a path the queue can use', () => {
  assert.deepEqual(parseClipText('file:///D:/a.txt').paths, ['D:/a.txt'])
  assert.deepEqual(parseClipText('ftp://host/x').paths, ['ftp://host/x'])
})
