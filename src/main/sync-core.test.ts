import test from 'node:test'
import assert from 'node:assert/strict'
import {
  invertPlan,
  ignored,
  ignoredBy,
  localDrift,
  matchesIgnore,
  nextBaseline,
  nextBaselineSubset,
  planRows,
  sameSide,
  sortRows,
  stateOf,
  summarize,
  threeWay,
  type Baseline,
  type BaselineRow,
  type LocalFile
} from './sync-core.ts'
import type { SyncRow, SyncSide } from '../shared/sync.ts'

const file = (size: number, mtime: number, hash?: string): SyncSide => ({ size, mtime, dir: false, hash })
const dir: SyncSide = { size: 0, mtime: 0, dir: true }

test('ignored: base name and relative path globs', () => {
  assert.equal(ignored('a/b/notes.log', ['*.log']), true)
  assert.equal(ignored('node_modules', ['node_modules']), true)
  assert.equal(ignored('src/node_modules/x.js', ['node_modules']), true)
  assert.equal(ignored('src/app.ts', ['*.log']), false)
  assert.equal(ignored('a.b', ['a?b']), true)
})

test('matchesIgnore: exact path hides its subtree, regex covers base and path', () => {
  assert.equal(matchesIgnore('docs/secret.txt', { kind: 'path', value: 'docs/secret.txt' }), true)
  assert.equal(matchesIgnore('docs/private', { kind: 'path', value: 'docs/private' }), true)
  assert.equal(matchesIgnore('docs/private/a/b.txt', { kind: 'path', value: 'docs/private' }), true)
  assert.equal(matchesIgnore('docs/private2/a', { kind: 'path', value: 'docs/private' }), false)
  assert.equal(matchesIgnore('a/b/notes.log', { kind: 'regex', value: '\\.log$' }), true)
  assert.equal(matchesIgnore('notes.log', { kind: 'regex', value: '^notes' }), true)
  assert.equal(matchesIgnore('a/notes.txt', { kind: 'regex', value: '\\.log$' }), false)
  // an invalid regex is inert instead of breaking a run
  assert.equal(matchesIgnore('x', { kind: 'regex', value: '[' }), false)
})

test('matchesIgnore: size rules only see files; gt/lt are strict', () => {
  assert.equal(matchesIgnore('big.bin', { kind: 'size', op: 'gt', bytes: 10 }, 11, false), true)
  assert.equal(matchesIgnore('big.bin', { kind: 'size', op: 'gt', bytes: 10 }, 10, false), false)
  assert.equal(matchesIgnore('small.txt', { kind: 'size', op: 'lt', bytes: 10 }, 9, false), true)
  assert.equal(matchesIgnore('small.txt', { kind: 'size', op: 'lt', bytes: 10 }, 10, false), false)
  // a folder's recursive size is unknown at walk time, so a size rule never hides a folder
  assert.equal(matchesIgnore('dir', { kind: 'size', op: 'gt', bytes: 0 }, 999, true), false)
})

test('ignoredBy: an empty list is a no-op and globs keep the old behaviour', () => {
  assert.equal(ignoredBy('a.log', []), false)
  assert.equal(ignoredBy('a.log', undefined), false)
  assert.equal(ignoredBy('a/b/notes.log', [{ kind: 'glob', value: '*.log' }]), true)
  assert.equal(ignoredBy('src/node_modules/x.js', [{ kind: 'glob', value: 'node_modules' }]), true)
  assert.equal(ignoredBy('src/app.ts', [{ kind: 'glob', value: '*.log' }]), false)
})

test('stateOf: newest wins, equal timestamps with a size change are ambiguous', () => {
  assert.equal(stateOf(file(10, 5000), file(10, 1000), 'mtime'), 'leftNewer')
  assert.equal(stateOf(file(10, 1000), file(10, 5000), 'mtime'), 'rightNewer')
  assert.equal(stateOf(file(10, 1000), file(11, 1000), 'mtime'), 'sizeDiff')
  assert.equal(stateOf(file(10, 1000), file(10, 1500), 'mtime'), 'same')
  assert.equal(stateOf(file(10, 1000), file(10, 999999), 'mtime'), 'rightNewer')
  assert.equal(stateOf(dir, file(0, 0), 'mtime'), 'typeDiff')
})

test('sameSide: hash mode ignores timestamps', () => {
  assert.equal(sameSide(file(10, 1, 'aa'), file(10, 9_999_999, 'aa'), 'hash'), true)
  assert.equal(sameSide(file(10, 1, 'aa'), file(10, 1, 'bb'), 'hash'), false)
})

test('localDrift: new, size, mtime, deletion and type change; unchanged stays out', () => {
  const base: Baseline = {
    same: { size: 10, mtime: 1_000, dir: false },
    near: { size: 10, mtime: 1_000, dir: false },
    size: { size: 10, mtime: 1_000, dir: false },
    time: { size: 10, mtime: 1_000, dir: false },
    deleted: { size: 10, mtime: 1_000, dir: false },
    folder: { size: 0, mtime: 1_000, dir: true },
    turned: { size: 10, mtime: 1_000, dir: false }
  }
  const files = new Map<string, LocalFile>([
    ['same', { size: 10, mtime: 2_500, dir: false }],
    // exactly SAME_MTIME_MS apart is still «the same moment»
    ['near', { size: 10, mtime: 3_000, dir: false }],
    ['size', { size: 11, mtime: 1_000, dir: false }],
    ['time', { size: 10, mtime: 3_001, dir: false }],
    ['folder', { size: 0, mtime: 9_999, dir: true }],
    ['turned', { size: 10, mtime: 1_000, dir: true }],
    ['new', { size: 1, mtime: 5_000, dir: false }]
  ])
  assert.deepEqual(localDrift(files, base), ['deleted', 'new', 'size', 'time', 'turned'])
})

test('threeWay with an adopted baseline compares by size+dir, not mtime', () => {
  const base: Baseline = { file: { size: 100, mtime: 111, dir: false, adopted: true } }
  const same = threeWay(
    [{ rel: 'file', state: 'rightNewer', left: file(100, 999), right: file(100, 123) }],
    base,
    'mtime'
  )
  assert.equal(same[0].state, 'same')
  assert.equal(same[0].conflict, undefined)

  const left = threeWay(
    [{ rel: 'file', state: 'sizeDiff', left: file(101, 999), right: file(100, 123) }],
    base,
    'mtime'
  )
  assert.equal(left[0].state, 'leftNewer')

  const right = threeWay(
    [{ rel: 'file', state: 'sizeDiff', left: file(100, 999), right: file(101, 123) }],
    base,
    'mtime'
  )
  assert.equal(right[0].state, 'rightNewer')
})

test('nextBaseline keeps adopted only while the path is same and its size did not change', () => {
  const previous: Baseline = { keep: { size: 5, mtime: 1, dir: false, adopted: true } }
  const rows: SyncRow[] = [
    { rel: 'keep', state: 'same', left: file(5, 999), right: file(5, 12) },
    { rel: 'grown', state: 'same', left: file(6, 999), right: file(6, 12) }
  ]
  previous.grown = { size: 5, mtime: 1, dir: false, adopted: true }
  const next = nextBaseline(rows, previous, planRows(rows, 'both'))
  assert.equal(next.keep.adopted, true)
  assert.equal(next.grown.adopted, undefined)
  assert.equal(next.grown.size, 6)

  // the incremental subset path must not have a second, different rule
  const subset = nextBaselineSubset(
    [{ rel: 'keep', state: 'same', left: file(5, 999), right: file(5, 12) }],
    previous,
    planRows([], 'both')
  )
  assert.equal(subset.keep.adopted, true)
})

test('threeWay without a baseline: same, one-sided rows, and both-new is a conflict', () => {
  const rows: SyncRow[] = [
    { rel: 'same.txt', state: 'same', left: file(1, 100), right: file(1, 100) },
    { rel: 'left.txt', state: 'leftOnly', left: file(1, 100) },
    { rel: 'right.txt', state: 'rightOnly', right: file(1, 100) },
    { rel: 'both.txt', state: 'sizeDiff', left: file(1, 100), right: file(2, 100) },
    { rel: 'type', state: 'typeDiff', left: dir, right: file(1, 100) }
  ]
  const got = threeWay(rows, {}, 'mtime')
  assert.equal(got.find((r) => r.rel === 'same.txt')?.state, 'same')
  assert.equal(got.find((r) => r.rel === 'left.txt')?.state, 'leftOnly')
  assert.equal(got.find((r) => r.rel === 'right.txt')?.state, 'rightOnly')
  assert.equal(got.find((r) => r.rel === 'both.txt')?.state, 'conflict')
  assert.equal(got.find((r) => r.rel === 'both.txt')?.conflict, 'bothNew')
  assert.equal(got.find((r) => r.rel === 'type')?.conflict, 'typeDiff')
})

test('threeWay with a baseline: one moved side copies, both moved is a conflict', () => {
  const base: Baseline = { 'a.txt': { size: 10, mtime: 100, dir: false } }
  const rows: SyncRow[] = [
    { rel: 'a.txt', state: 'rightNewer', left: file(10, 100), right: file(10, 5000) },
    { rel: 'b.txt', state: 'same', left: file(10, 50), right: file(10, 50) },
    { rel: 'c.txt', state: 'leftOnly', left: file(10, 100) }
  ]
  const b: Baseline = {
    ...base,
    'b.txt': { size: 10, mtime: 50, dir: false },
    'c.txt': { size: 10, mtime: 100, dir: false }
  }
  const got = threeWay(rows, b, 'mtime')
  assert.equal(got.find((r) => r.rel === 'a.txt')?.state, 'rightNewer')
  assert.equal(got.find((r) => r.rel === 'b.txt')?.state, 'same')
  // unchanged on the left and gone on the right = a deletion, not an edit
  assert.equal(got.find((r) => r.rel === 'c.txt')?.state, 'leftOnly')
  assert.ok(got.find((r) => r.rel === 'c.txt')?.baseline)
})

test('threeWay: a changed file deleted on the other side is an edit/delete conflict', () => {
  const b: Baseline = { 'x.txt': { size: 10, mtime: 100, dir: false } }
  const got = threeWay([{ rel: 'x.txt', state: 'leftOnly', left: file(99, 9000) }], b, 'mtime')
  assert.equal(got[0].state, 'conflict')
  assert.equal(got[0].conflict, 'editDelete')
})

test('threeWay: both sides changed away from the baseline is a conflict', () => {
  const b: Baseline = { 'x.txt': { size: 10, mtime: 100, dir: false } }
  const got = threeWay([{ rel: 'x.txt', state: 'leftNewer', left: file(11, 500), right: file(12, 900) }], b, 'mtime')
  assert.equal(got[0].state, 'conflict')
  assert.equal(got[0].conflict, 'bothChanged')
})

test('planRows ltr: copies only what the left side is allowed to win', () => {
  const rows: SyncRow[] = [
    { rel: 'new.txt', state: 'leftOnly', left: file(1, 1) },
    { rel: 'newer.txt', state: 'leftNewer', left: file(1, 9), right: file(1, 1) },
    { rel: 'older.txt', state: 'rightNewer', left: file(1, 1), right: file(1, 9) },
    { rel: 'same.txt', state: 'same', left: file(1, 1), right: file(1, 1) },
    { rel: 'extra.txt', state: 'rightOnly', right: file(1, 1) },
    { rel: 'odd', state: 'typeDiff', left: dir, right: file(1, 1) }
  ]
  const plan = planRows(rows, 'ltr')
  assert.deepEqual(plan.copy.map((a) => a.rel), ['new.txt', 'newer.txt'])
  assert.deepEqual(plan.remove, [])
  assert.equal(plan.skipped, 4, 'the type clash is skipped, not copied')
  assert.deepEqual(plan.conflicts, [])

  const withDelete = planRows(rows, 'ltr', { deleteExtra: true })
  assert.deepEqual(withDelete.remove.map((a) => a.rel), ['extra.txt'])
})

test('planRows rtl is the mirror image', () => {
  const rows: SyncRow[] = [
    { rel: 'new.txt', state: 'rightOnly', right: file(1, 1) },
    { rel: 'left-newer.txt', state: 'leftNewer', left: file(1, 9), right: file(1, 1) },
    { rel: 'left-only.txt', state: 'leftOnly', left: file(1, 1) }
  ]
  const plan = planRows(rows, 'rtl')
  assert.deepEqual(plan.copy.map((a) => a.rel), ['new.txt'])
  const del = planRows(rows, 'rtl', { deleteExtra: true })
  assert.deepEqual(del.remove.map((a) => a.rel), ['left-only.txt'])
})

test('planRows both: conflicts are reported and never applied without a decision', () => {
  const rows: SyncRow[] = [
    { rel: 'c.txt', state: 'conflict', conflict: 'bothChanged', left: file(2, 2), right: file(3, 3) },
    { rel: 'new.txt', state: 'leftOnly', left: file(1, 1) },
    { rel: 'moved.txt', state: 'rightNewer', left: file(1, 1), right: file(1, 9) }
  ]
  const plan = planRows(rows, 'both')
  assert.deepEqual(plan.conflicts.map((r) => r.rel), ['c.txt'])
  assert.deepEqual(plan.copy.map((a) => `${a.rel}:${a.from}`), ['new.txt:left', 'moved.txt:right'])
})

test('planRows both: a decision makes the conflict runnable in either direction', () => {
  const row: SyncRow = { rel: 'c.txt', state: 'conflict', conflict: 'bothChanged', left: file(2, 2), right: file(3, 3) }
  assert.equal(planRows([row], 'both', { resolutions: { 'c.txt': 'left' } }).copy[0].from, 'left')
  assert.equal(planRows([row], 'both', { resolutions: { 'c.txt': 'right' } }).copy[0].from, 'right')
  const skip = planRows([row], 'both', { resolutions: { 'c.txt': 'skip' } })
  assert.equal(skip.copy.length, 0)
  assert.equal(skip.conflicts.length, 1)
})

test('planRows both: a folder/file clash is never resolved by a copy, even with a decision', () => {
  const row: SyncRow = {
    rel: 'thing',
    state: 'conflict',
    conflict: 'typeDiff',
    left: { size: 0, mtime: 0, dir: true },
    right: file(10, 100)
  }
  for (const decision of ['left', 'right', 'skip'] as const) {
    const plan = planRows([row], 'both', { resolutions: { thing: decision } })
    assert.equal(plan.copy.length, 0)
    assert.equal(plan.remove.length, 0)
    assert.equal(plan.conflicts.length, 1)
  }
})

test('planRows both: a deletion is only propagated with deleteExtra', () => {
  const deleted: SyncRow = { rel: 'gone.txt', state: 'leftOnly', left: file(1, 1), baseline: file(1, 1) }
  assert.equal(planRows([deleted], 'both').remove.length, 0)
  assert.equal(planRows([deleted], 'both', { deleteExtra: true }).remove[0].from, 'left')
  // no baseline = a new file, which is copied, never deleted
  const fresh: SyncRow = { rel: 'fresh.txt', state: 'leftOnly', left: file(1, 1) }
  assert.equal(planRows([fresh], 'both', { deleteExtra: true }).copy[0].from, 'left')
})

test('planRows both: a moved side wins a size difference that has a baseline', () => {
  const leftMoved: SyncRow = {
    rel: 'a',
    state: 'sizeDiff',
    left: file(20, 9000),
    right: file(10, 100),
    baseline: file(10, 100)
  }
  assert.equal(planRows([leftMoved], 'both').copy[0].from, 'left')
  const rightMoved: SyncRow = {
    rel: 'a',
    state: 'sizeDiff',
    left: file(10, 100),
    right: file(20, 9000),
    baseline: file(10, 100)
  }
  assert.equal(planRows([rightMoved], 'both').copy[0].from, 'right')
})

test('planRows: the selection drops rows without touching the plan shape', () => {
  const rows: SyncRow[] = [
    { rel: 'a', state: 'leftOnly', left: file(1, 1) },
    { rel: 'b', state: 'leftOnly', left: file(1, 1) }
  ]
  const plan = planRows(rows, 'ltr', { selected: new Set(['b']) })
  assert.deepEqual(plan.copy.map((a) => a.rel), ['b'])
  assert.equal(plan.skipped, 1)
})

test('invertPlan: copies reverse, deletions are reported as unrestorable', () => {
  const plan = planRows(
    [
      { rel: 'a', state: 'leftOnly', left: file(1, 1) },
      { rel: 'b', state: 'rightOnly', right: file(1, 1) }
    ],
    'ltr',
    { deleteExtra: true }
  )
  const inv = invertPlan(plan)
  assert.deepEqual(inv.copy.map((a) => `${a.rel}:${a.from}->${a.to}`), ['a:right->left'])
  assert.deepEqual(inv.unrestorable, ['b'])
})

test('nextBaseline follows the plan: copies get an anchor, unresolved rows keep the old one', () => {
  const previous: Baseline = { 'c': { size: 1, mtime: 1, dir: false } }
  const rows: SyncRow[] = [
    { rel: 'same', state: 'same', left: file(1, 10), right: file(1, 10) },
    { rel: 'left', state: 'leftNewer', left: file(2, 20), right: file(1, 10) },
    { rel: 'c', state: 'conflict', conflict: 'bothChanged', left: file(5, 5), right: file(6, 6) }
  ]
  const plan = planRows(rows, 'both')
  const next = nextBaseline(rows, previous, plan)
  assert.deepEqual(next.same, { size: 1, mtime: 10, dir: false, hash: undefined })
  assert.deepEqual(next.left, { size: 2, mtime: 20, dir: false, hash: undefined })
  assert.deepEqual(next.c, previous.c)
})

test('summarize and sortRows: conflicts first, identical rows last', () => {
  const rows: SyncRow[] = [
    { rel: 'z', state: 'same', left: file(1, 1), right: file(1, 1) },
    { rel: 'a', state: 'conflict', conflict: 'bothChanged', left: file(1, 1), right: file(2, 2) },
    { rel: 'm', state: 'leftNewer', left: file(2, 2), right: file(1, 1) }
  ]
  assert.deepEqual(summarize(rows), { same: 1, left: 1, right: 0, suspicious: 0, conflicts: 1, changed: 2 })
  assert.deepEqual(sortRows(rows).map((r) => r.rel), ['a', 'm', 'z'])
})

test('BaselineRow is structurally a SyncSide so a stored baseline can be compared directly', () => {
  const b: BaselineRow = { size: 1, mtime: 1, dir: false }
  const s: SyncSide = b
  assert.equal(s.dir, false)
})
