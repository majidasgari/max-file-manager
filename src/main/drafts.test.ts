import assert from 'node:assert/strict'
import test from 'node:test'
import { createDrafts } from './drafts.ts'

const backing = () => {
  const map = new Map<string, string>()
  return { map, kv: { get: (k: string) => map.get(k) ?? null, set: (k: string, v: string) => void map.set(k, v) } }
}

test('a draft round-trips per path and is cleared independently', () => {
  const { kv } = backing()
  const drafts = createDrafts(kv)
  drafts.set('/a/one.md', 'hello', 1000)
  drafts.set('/a/two.md', 'other', 2000)
  assert.deepEqual(drafts.get('/a/one.md'), { text: 'hello', at: 1000 })
  drafts.clear('/a/one.md')
  assert.equal(drafts.get('/a/one.md'), null)
  assert.deepEqual(drafts.get('/a/two.md'), { text: 'other', at: 2000 })
})

test('setting the same path twice replaces the text instead of stacking', () => {
  const { kv } = backing()
  const drafts = createDrafts(kv)
  drafts.set('/a/one.md', 'v1', 1)
  drafts.set('/a/one.md', 'v2', 2)
  assert.equal(drafts.get('/a/one.md')?.text, 'v2')
  const index = JSON.parse(backingIndex(kv))
  assert.equal(index.length, 1)
})

test('prune keeps the newest drafts and forgets expired ones', () => {
  const { kv } = backing()
  const drafts = createDrafts(kv)
  const day = 86_400_000
  const now = 100 * day
  drafts.set('/old.md', 'old', now - 90 * day)
  for (let i = 0; i < 5; i++) drafts.set(`/new-${i}.md`, `t${i}`, now - i * 1000)
  const removed = drafts.prune(3, now, 60)
  assert.equal(removed, 3) // the old one plus the two oldest of the five
  assert.equal(drafts.get('/old.md'), null)
  assert.ok(drafts.get('/new-0.md'))
  assert.ok(drafts.get('/new-1.md'))
  assert.ok(drafts.get('/new-2.md'))
  assert.equal(drafts.get('/new-3.md'), null)
})

test('junk in the store is ignored instead of crashing the editor', () => {
  const { map, kv } = backing()
  map.set('draft:/x.md', '{not json')
  const drafts = createDrafts(kv)
  assert.equal(drafts.get('/x.md'), null)
  assert.equal(drafts.get('/never.md'), null)
})

function backingIndex(kv: { get(k: string): string | null }): string {
  return kv.get('draftIndex') ?? '[]'
}
