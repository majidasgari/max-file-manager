import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanRemoteName,
  conflictPaths,
  entryState,
  entryStates,
  nextBackoff,
  nextRunAt,
  remoteJoin,
  remoteName,
  remoteParent,
  rowEntryState
} from './cloud-core.ts'
import type { SyncPlan, SyncRow } from '../shared/sync.ts'

test('backoff doubles and stops at the ceiling', () => {
  assert.equal(nextBackoff(0, 60_000), 60_000)
  assert.equal(nextBackoff(1, 60_000), 120_000)
  assert.equal(nextBackoff(3, 60_000), 480_000)
  assert.equal(nextBackoff(50, 60_000), 30 * 60_000)
})

test('a dirty folder runs after a short debounce, a paused one never', () => {
  const now = 1_000_000
  assert.equal(nextRunAt({ intervalMs: 900_000, enabled: false }, { lastRunAt: null, dirty: true }, now), null)
  assert.equal(nextRunAt({ intervalMs: 900_000, enabled: true }, { lastRunAt: now - 1, dirty: true }, now), now + 2_000)
  assert.equal(nextRunAt({ intervalMs: 900_000, enabled: true }, { lastRunAt: now, dirty: false }, now), now + 900_000)
  assert.equal(nextRunAt({ intervalMs: 60_000, enabled: true }, { lastRunAt: now, dirty: false }, now, 2), now + 240_000)
})

test('entry state follows the binding state', () => {
  assert.equal(entryState('idle', false), 'synced')
  assert.equal(entryState('idle', true), 'pending')
  assert.equal(entryState('syncing', false), 'syncing')
  assert.equal(entryState('checking', true), 'syncing')
  assert.equal(entryState('conflict', false), 'conflict')
  assert.equal(entryState('paused', false), 'paused')
  assert.equal(entryState('offline', false), 'offline')
  assert.equal(entryState('error', false), 'error')
})

test('remote paths join, parent and name', () => {
  assert.equal(remoteJoin('/', 'Docs'), '/Docs')
  assert.equal(remoteJoin('/a/b', 'c'), '/a/b/c')
  assert.equal(remoteJoin('/a/b/', '/c'), '/a/b/c')
  assert.equal(remoteParent('/a/b'), '/a')
  assert.equal(remoteParent('/a'), '/')
  assert.equal(remoteParent('/'), '/')
  assert.equal(remoteName('/a/b'), 'b')
  assert.equal(remoteName('/'), '/')
})

test('a new folder name cannot escape its parent', () => {
  assert.equal(cleanRemoteName('Docs'), 'Docs')
  assert.equal(cleanRemoteName('  Docs  '), 'Docs')
  assert.equal(cleanRemoteName(''), null)
  assert.equal(cleanRemoteName('..'), null)
  assert.equal(cleanRemoteName('a/b'), null)
  assert.equal(cleanRemoteName('a\\b'), null)
  assert.equal(cleanRemoteName('x'.repeat(200)), null)
})

test('conflict rows are the ones a run may not touch', () => {
  const rows: SyncRow[] = [
    { rel: 'a.txt', state: 'conflict' },
    { rel: 'b', state: 'typeDiff' },
    { rel: 'c.txt', state: 'leftOnly' },
    { rel: 'd.txt', state: 'same' }
  ]
  assert.deepEqual(conflictPaths(rows), ['a.txt', 'b'])
})

test('every comparison row earns a badge a person can act on', () => {
  assert.equal(rowEntryState({ rel: 'a', state: 'same' }), 'synced')
  assert.equal(rowEntryState({ rel: 'a', state: 'leftOnly' }), 'localOnly')
  assert.equal(rowEntryState({ rel: 'a', state: 'rightOnly' }), 'cloudOnly')
  assert.equal(rowEntryState({ rel: 'a', state: 'leftNewer' }), 'pending')
  assert.equal(rowEntryState({ rel: 'a', state: 'rightNewer' }), 'pending')
  assert.equal(rowEntryState({ rel: 'a', state: 'sizeDiff' }), 'pending')
  assert.equal(rowEntryState({ rel: 'a', state: 'contentDiff' }), 'pending')
  assert.equal(rowEntryState({ rel: 'a', state: 'conflict' }), 'conflict')
  assert.equal(rowEntryState({ rel: 'a', state: 'typeDiff' }), 'conflict')
})

test('a folder carries the worst state below it, so nothing hides in a subfolder', () => {
  const side = { size: 4, mtime: 1, dir: false }
  const rows: SyncRow[] = [
    { rel: 'Docs/a.txt', state: 'same' },
    { rel: 'Docs/b.txt', state: 'rightOnly', right: side },
    { rel: 'Docs/Sub/c.txt', state: 'conflict', left: side, right: side },
    { rel: 'empty.txt', state: 'leftOnly', left: side }
  ]
  const map = entryStates(rows)
  assert.equal(map.files.get('Docs/a.txt'), 'synced')
  assert.equal(map.files.get('Docs/b.txt'), 'cloudOnly')
  // conflict outranks «only in the cloud» and «pending»
  assert.equal(map.dirs.get('Docs'), 'conflict')
  assert.equal(map.dirs.get('Docs/Sub'), 'conflict')
  assert.equal(map.counts.synced, 1)
  assert.equal(map.counts.cloudOnly, 1)
  assert.equal(map.counts.localOnly, 1)
  assert.equal(map.counts.conflict, 1)
})

test('a run marks what it copied as synced, keeps a failure and forgets a local delete', () => {
  const side = { size: 4, mtime: 1, dir: false }
  const rows: SyncRow[] = [
    { rel: 'up.txt', state: 'leftOnly', left: side },
    { rel: 'down.txt', state: 'rightOnly', right: side },
    { rel: 'bad.txt', state: 'leftNewer', left: side, right: side },
    { rel: 'gone.txt', state: 'leftOnly', left: side, baseline: side },
    { rel: 'kept.txt', state: 'rightOnly', right: side, baseline: side }
  ]
  const plan: SyncPlan = {
    mode: 'both',
    copy: [
      { rel: 'up.txt', kind: 'copy', from: 'left', to: 'right', state: 'leftOnly' },
      { rel: 'down.txt', kind: 'copy', from: 'right', to: 'left', state: 'rightOnly' },
      { rel: 'bad.txt', kind: 'copy', from: 'left', to: 'right', state: 'leftNewer' }
    ],
    remove: [{ rel: 'gone.txt', kind: 'delete', from: 'left', to: 'left', state: 'leftOnly' }],
    conflicts: [],
    skipped: 1
  }
  const map = entryStates(rows, plan, ['bad.txt: the network went away'])
  assert.equal(map.files.get('up.txt'), 'synced')
  assert.equal(map.files.get('down.txt'), 'synced')
  // a failed copy must not claim success
  assert.equal(map.files.get('bad.txt'), 'pending')
  assert.equal(map.files.has('gone.txt'), false)
  // «deleted on the cloud» with deleteExtra off was skipped, so it still says «only in the cloud»
  assert.equal(map.files.get('kept.txt'), 'cloudOnly')
  assert.equal(map.counts.pending, 1)
  assert.equal(map.counts.synced, 2)
})
