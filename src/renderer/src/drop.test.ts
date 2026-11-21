import assert from 'node:assert/strict'
import test from 'node:test'
import { dropDestFor, dropIsRefused, isInsidePath, isSamePath } from './drop.ts'

test('isSamePath folds case only for local drive paths', () => {
  assert.equal(isSamePath('D:\\Codes\\src\\', 'd:/codes/src'), true)
  assert.equal(isSamePath('/home/max/Docs', '/home/max/docs'), false)
  assert.equal(isSamePath('sftp://host/a/B', 'sftp://host/a/b'), false)
  assert.equal(isSamePath('D:/Codes/./src', 'D:/Codes/src'), true)
})

test('isInsidePath needs a real separator', () => {
  assert.equal(isInsidePath('/a/b/c', '/a/b'), true)
  assert.equal(isInsidePath('/a/bc', '/a/b'), false)
  assert.equal(isInsidePath('/a/b', '/a/b'), true)
  assert.equal(isInsidePath('D:/Codes/x/y', 'd:/codes/X'), true)
  assert.equal(isInsidePath('/a/b', ''), false)
})

test('dropIsRefused refuses a folder onto itself or into its own subtree', () => {
  assert.equal(dropIsRefused(['/a/b'], '/a/b'), true)
  assert.equal(dropIsRefused(['/a/b'], '/a/b/inner'), true)
  assert.equal(dropIsRefused(['/a/b/c.txt'], '/a/b'), false)
  assert.equal(dropIsRefused(['/a/b/c.txt'], '/a/d'), false)
  assert.equal(dropIsRefused(['/a/bc'], '/a/b'), false)
})

test('dropIsRefused covers a multi-selection where one folder holds the target', () => {
  const paths = ['/x/one.txt', '/x/folder']
  assert.equal(dropIsRefused(paths, '/x/folder/deep'), true)
  assert.equal(dropIsRefused(paths, '/x/other'), false)
})

test('dropDestFor sends a file row to the open folder', () => {
  assert.equal(dropDestFor({ path: '/a/dir', dir: true }, '/a'), '/a/dir')
  assert.equal(dropDestFor({ path: '/a/file.txt', dir: false }, '/a'), '/a')
})
