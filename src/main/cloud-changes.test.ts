import test from 'node:test'
import assert from 'node:assert/strict'
import { applyChanges, chooseRunMode, type CloudNode } from './cloud-changes.ts'
import type { CloudChange, CloudChangePage } from './cloud-client.ts'

const ROOT = 'root'

const node = (id: string, rel: string, extra: Partial<CloudNode> = {}): CloudNode => ({
  id,
  rel,
  parentId: ROOT,
  name: rel.slice(rel.lastIndexOf('/') + 1),
  dir: false,
  size: 1,
  mtime: 1,
  ...extra
})

const tree = (...nodes: CloudNode[]): Map<string, CloudNode> =>
  new Map(nodes.map((n) => [n.id, n]))

const page = (...changes: CloudChange[]): CloudChangePage => ({
  changes,
  nextToken: 'next'
})

const change = (id: string, name: string, extra: Partial<CloudChange> = {}): CloudChange => ({
  id,
  removed: false,
  parentId: ROOT,
  name,
  dir: false,
  size: 1,
  mtime: 1,
  ...extra
})

test('applyChanges: a new file under the root is dirty and enters the tree', () => {
  const out = applyChanges(tree(), ROOT, page(change('f1', 'a.txt')))
  assert.equal(out.rescan, false)
  assert.deepEqual(out.dirty, ['a.txt'])
  assert.equal(out.nodes.get('f1')?.rel, 'a.txt')
})

test('applyChanges: a content change is dirty under the same path', () => {
  const out = applyChanges(tree(node('f1', 'a.txt')), ROOT, page(change('f1', 'a.txt', { size: 9 })))
  assert.deepEqual(out.dirty, ['a.txt'])
  assert.equal(out.nodes.get('f1')?.size, 9)
})

test('applyChanges: a rename reports the old and the new path', () => {
  const out = applyChanges(tree(node('f1', 'a.txt')), ROOT, page(change('f1', 'b.txt')))
  assert.deepEqual(out.dirty, ['a.txt', 'b.txt'])
  assert.equal(out.nodes.get('f1')?.rel, 'b.txt')
  assert.equal([...out.nodes.values()].some((n) => n.rel === 'a.txt'), false)
})

test('applyChanges: a move between two folders dirties both paths', () => {
  const nodes = tree(
    node('d1', 'one', { dir: true }),
    node('d2', 'two', { dir: true }),
    node('f1', 'one/x.txt', { parentId: 'd1' })
  )
  const out = applyChanges(nodes, ROOT, page(change('f1', 'x.txt', { parentId: 'd2' })))
  assert.deepEqual(out.dirty, ['one/x.txt', 'two/x.txt'])
  assert.equal(out.nodes.get('f1')?.rel, 'two/x.txt')
  assert.equal(out.nodes.get('f1')?.parentId, 'd2')
})

test('applyChanges: removing a known id drops it and dirties its old path', () => {
  const out = applyChanges(
    tree(node('f1', 'a.txt')),
    ROOT,
    page({ ...change('f1', ''), removed: true })
  )
  assert.deepEqual(out.dirty, ['a.txt'])
  assert.equal(out.nodes.has('f1'), false)
})

test('applyChanges: removing an unknown id is ignored', () => {
  const out = applyChanges(tree(node('keep', 'keep.txt')), ROOT, page({ ...change('ghost', ''), removed: true }))
  assert.deepEqual(out.dirty, [])
  assert.deepEqual([...out.nodes.keys()], ['keep'])
})

test('applyChanges: an unknown parent asks for a full rescan instead of inventing a path', () => {
  const nodes = tree(node('d1', 'one', { dir: true }))
  const out = applyChanges(nodes, ROOT, page(change('f9', 'x.txt', { parentId: 'not-here' })))
  assert.equal(out.rescan, true)
  assert.equal(out.nodes.has('f9'), false)
  assert.deepEqual(out.dirty, [])
})

test('applyChanges: a renamed folder rewrites its whole subtree', () => {
  const nodes = tree(
    node('d1', 'old', { dir: true }),
    node('d2', 'old/deep', { dir: true, parentId: 'd1' }),
    node('f1', 'old/deep/file.txt', { parentId: 'd2' })
  )
  const out = applyChanges(nodes, ROOT, page(change('d1', 'new', { dir: true })))
  assert.deepEqual(out.dirty, ['old', 'new'])
  assert.equal(out.nodes.get('d1')?.rel, 'new')
  assert.equal(out.nodes.get('d2')?.rel, 'new/deep')
  assert.equal(out.nodes.get('f1')?.rel, 'new/deep/file.txt')
})

// ---------------------------------------------------------------- run-mode choice

const NOW = 1_800_000_000_000
const HOUR = 60 * 60_000

const modeInput = (extra: Partial<Parameters<typeof chooseRunMode>[0]> = {}) => ({
  hasFlatten: true,
  hasFeed: true,
  seed: 'fast',
  nodeCount: 3,
  pageToken: 'cursor-1',
  fullScanAt: NOW - HOUR,
  now: NOW,
  ...extra
})

test('chooseRunMode: an empty node map adopts once, on any provider with flatten', () => {
  assert.equal(chooseRunMode(modeInput({ nodeCount: 0, pageToken: null, fullScanAt: null })), 'adopt')
  // a cursor that survived while the node map did not must not block the one-time adoption
  assert.equal(chooseRunMode(modeInput({ nodeCount: 0 })), 'adopt')
})

test('chooseRunMode: full seed, missing flatten or an existing tree never adopt', () => {
  assert.equal(
    chooseRunMode(modeInput({ nodeCount: 0, seed: 'full', pageToken: null, fullScanAt: null })),
    'full'
  )
  assert.equal(
    chooseRunMode(modeInput({ nodeCount: 0, hasFlatten: false, pageToken: null, fullScanAt: null })),
    'full'
  )
  assert.equal(chooseRunMode(modeInput()), 'feed')
})

test('chooseRunMode: a change feed needs a fresh cursor and a fresh full scan', () => {
  assert.equal(chooseRunMode(modeInput({ pageToken: null })), 'full')
  assert.equal(chooseRunMode(modeInput({ fullScanAt: null })), 'full')
  assert.equal(chooseRunMode(modeInput({ fullScanAt: NOW - 25 * HOUR })), 'full')
  assert.equal(chooseRunMode(modeInput({ nodeCount: 0, pageToken: 'c', seed: 'full' })), 'full')
})

test('chooseRunMode: without a feed the local drift is enough, but only after a full scan', () => {
  assert.equal(chooseRunMode(modeInput({ hasFeed: false })), 'local')
  assert.equal(chooseRunMode(modeInput({ hasFeed: false, pageToken: null })), 'local')
  assert.equal(chooseRunMode(modeInput({ hasFeed: false, fullScanAt: null })), 'full')
  assert.equal(chooseRunMode(modeInput({ hasFeed: false, nodeCount: 0, seed: 'full' })), 'full')
})
