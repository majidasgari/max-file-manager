import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLOUD_MAX_INTERVAL,
  cleanCloudAccount,
  cleanCloudBinding,
  cleanCloudBindings,
  cleanCloudInterval,
  cloudOf,
  cloudPath,
  isCloudPath,
  isCloudProviderId,
  overlaps
} from './cloud.ts'

const id = 'cloud-abc123'
const accountId = 'cloud-acct01'
const account = {
  id: accountId,
  provider: 'nextcloud' as const,
  label: 'alice@cloud.example',
  url: 'https://cloud.example/remote.php/dav/files/alice',
  user: 'alice',
  sessionOnly: false,
  createdAt: 1
}

test('cloud paths round-trip and reject other schemes', () => {
  assert.equal(cloudPath(id), 'cloud://cloud-abc123')
  assert.equal(cloudPath(id, 'a/b.txt'), 'cloud://cloud-abc123/a/b.txt')
  assert.equal(cloudPath(id, '/a/b.txt'), 'cloud://cloud-abc123/a/b.txt')
  assert.equal(isCloudPath('/home/x'), false)
  assert.equal(isCloudPath('cloud://cloud-abc123'), true)
  assert.deepEqual(cloudOf('cloud://cloud-abc123/a b.txt'), { bindingId: 'cloud-abc123', rel: 'a b.txt' })
  assert.deepEqual(cloudOf('cloud://cloud-abc123'), { bindingId: 'cloud-abc123', rel: '' })
  // an id that could never have been generated is not a cloud path at all
  assert.equal(cloudOf('cloud://../../etc/passwd'), null)
  assert.equal(cloudOf('http://cloud-abc123'), null)
})

test('provider ids are checked against the catalog', () => {
  assert.equal(isCloudProviderId('nextcloud'), true)
  assert.equal(isCloudProviderId('nope'), false)
  assert.equal(isCloudProviderId(undefined), false)
})

test('interval is clamped to the provider floor and a day', () => {
  assert.equal(cleanCloudInterval('nextcloud', 1000), 5 * 60_000)
  assert.equal(cleanCloudInterval('nextcloud', 15 * 60_000), 15 * 60_000)
  assert.equal(cleanCloudInterval('nextcloud', 10 * 24 * 60 * 60_000), CLOUD_MAX_INTERVAL)
  assert.equal(cleanCloudInterval('nextcloud', 'nope'), 15 * 60_000)
})

test('accounts need a usable WebDAV url and a user', () => {
  assert.deepEqual(cleanCloudAccount(account)?.url, 'https://cloud.example/remote.php/dav/files/alice')
  assert.equal(cleanCloudAccount({ ...account, url: 'ftp://x' }), null)
  assert.equal(cleanCloudAccount({ ...account, url: 'https://a:b@cloud.example' }), null)
  assert.equal(cleanCloudAccount({ ...account, user: '' }), null)
  // a provider that is not shipped yet may not be stored
  assert.equal(cleanCloudAccount({ ...account, provider: 'protondrive', url: undefined }), null)
  assert.equal(cleanCloudAccount({ ...account, id: 'x' }), null)
})

test('bindings reject a relative local path and keep their remote shape', () => {
  const binding = {
    id,
    accountId,
    name: 'Docs',
    localPath: '/home/alice/Docs',
    remoteId: '/Docs',
    remoteLabel: '/Docs',
    direction: 'both',
    compareBy: 'hash',
    deleteExtra: false,
    intervalMs: 15 * 60_000,
    enabled: true,
    paused: false,
    createdAt: 1
  }
  const ok = cleanCloudBinding(binding)
  assert.ok(ok)
  assert.equal(ok.localPath, '/home/alice/Docs')
  assert.equal(ok.remoteId, '/Docs')
  // the fast seed is the default; only an explicit `full` switches it off and garbage falls back
  assert.equal(ok.seed, 'fast')
  assert.equal(cleanCloudBinding({ ...binding, seed: 'full' })?.seed, 'full')
  assert.equal(cleanCloudBinding({ ...binding, seed: 'weird' })?.seed, 'fast')
  assert.equal(cleanCloudBinding({ ...binding, localPath: 'Docs' }), null)
  assert.equal(cleanCloudBinding({ ...binding, remoteId: 'Docs' }), null)
  assert.equal(cleanCloudBinding({ ...binding, remoteId: '/..' })?.remoteId, '/..')
  // a Windows absolute folder is accepted too
  assert.ok(cleanCloudBinding({ ...binding, localPath: 'D:\\Cloud\\Docs' }))
})

test('two bindings may not overlap on the local disk', () => {
  const base = {
    accountId,
    remoteId: '/x',
    remoteLabel: '/x',
    direction: 'both',
    compareBy: 'hash',
    deleteExtra: false,
    intervalMs: 900000,
    enabled: true,
    paused: false,
    createdAt: 1
  }
  const list = cleanCloudBindings(
    [
      { ...base, id: 'cloud-one111', name: 'a', localPath: '/home/alice/Docs' },
      { ...base, id: 'cloud-two222', name: 'b', localPath: '/home/alice/Docs/Sub' },
      { ...base, id: 'cloud-thr333', name: 'c', localPath: '/home/alice/Other' }
    ],
    [account]
  )
  assert.deepEqual(
    list.map((b) => b.name),
    ['a', 'c']
  )
  assert.equal(overlaps('/a/b', '/a/b'), true)
  assert.equal(overlaps('/a/b', '/a/bc'), false)
})
