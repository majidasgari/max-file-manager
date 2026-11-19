import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseRemote } from '../shared/remote-path.ts'
import type { RemoteFs } from './remote-core.ts'
import { applyPlan, compareSubset, compareTrees, createOps, localOps, walkTree } from './sync-engine.ts'
import { decryptFile, encryptFile, generateKeypair } from './sync-crypt.ts'
import {
  invertPlan,
  nextBaseline,
  nextBaselineSubset,
  planRows,
  threeWay,
  type Baseline
} from './sync-core.ts'
import type { SyncRow } from '../shared/sync.ts'

async function temp(prefix = 'mfm-sync-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function write(root: string, rel: string, text: string, mtime?: number): Promise<void> {
  const file = path.join(root, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
  if (mtime !== undefined) {
    const d = new Date(mtime)
    await fs.utimes(file, d, d)
  }
}

const exists = async (p: string): Promise<boolean> =>
  fs.stat(p).then(
    () => true,
    () => false
  )

test('walkTree: nested files, .mfm.json and ignore patterns, folders kept for type checks', async () => {
  const root = await temp()
  try {
    await write(root, 'a.txt', 'a')
    await write(root, 'sub/b.txt', 'b')
    await write(root, 'sub/.mfm.json', '{}')
    await write(root, 'logs/x.log', 'x')
    await write(root, 'node_modules/pkg/index.js', 'no')
    const got = await walkTree(root, localOps(), { ignore: ['*.log', 'node_modules'] })
    assert.deepEqual([...got.tree.keys()].sort(), ['a.txt', 'logs', 'sub', 'sub/b.txt'])
    assert.equal(got.tree.get('sub')?.dir, true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('walkTree: a missing folder is an empty tree, not an error', async () => {
  const root = await temp()
  const got = await walkTree(path.join(root, 'nope'), localOps())
  assert.equal(got.tree.size, 0)
  assert.equal(got.capped, false)
  await fs.rm(root, { recursive: true, force: true })
})

test('walkTree: ignore rules hide exact path subtrees and files over a size', async () => {
  const root = await temp()
  try {
    await write(root, 'keep.txt', 'hello')
    await write(root, 'big.bin', 'x'.repeat(2048))
    await write(root, 'docs/private/secret.txt', 's')
    await write(root, 'docs/public/readme.txt', 'r')
    const got = await walkTree(root, localOps(), {
      rules: [
        { kind: 'path', value: 'docs/private' },
        { kind: 'size', op: 'gt', bytes: 1024 }
      ]
    })
    assert.deepEqual([...got.tree.keys()].sort(), [
      'docs',
      'docs/public',
      'docs/public/readme.txt',
      'keep.txt'
    ])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('compareTrees: an ignored file is invisible, so delete-extra never removes it', async () => {
  const left = await temp()
  const right = await temp()
  try {
    await write(left, 'a.txt', 'a')
    await write(right, 'delete.txt', 'd')
    await write(right, 'keep.log', 'k')
    const cmp = await compareTrees(left, right, localOps(), {
      rules: [{ kind: 'glob', value: '*.log' }]
    })
    assert.deepEqual(cmp.rows.map((r) => r.rel).sort(), ['a.txt', 'delete.txt'])
    const plan = planRows(cmp.rows, 'ltr', { deleteExtra: true })
    assert.deepEqual(plan.remove.map((a) => a.rel), ['delete.txt'])
  } finally {
    await fs.rm(left, { recursive: true, force: true })
    await fs.rm(right, { recursive: true, force: true })
  }
})

test('compareTrees mtime: left-only, right-only, newer and identical', async () => {
  const left = await temp()
  const right = await temp()
  try {
    const t = Date.now() - 60_000
    await write(left, 'only-left.txt', 'L', t)
    await write(right, 'only-right.txt', 'R', t)
    await write(left, 'newer-left.txt', 'LL', t + 10_000)
    await write(right, 'newer-left.txt', 'L', t)
    await write(left, 'same.txt', 'S', t)
    await write(right, 'same.txt', 'S', t)
    const got = await compareTrees(left, right, localOps(), {})
    const by = new Map(got.rows.map((r) => [r.rel, r.state]))
    assert.equal(by.get('only-left.txt'), 'leftOnly')
    assert.equal(by.get('only-right.txt'), 'rightOnly')
    assert.equal(by.get('newer-left.txt'), 'leftNewer')
    assert.equal(by.get('same.txt'), 'same')
    assert.equal(got.leftCount, 3)
    assert.equal(got.rightCount, 3)
  } finally {
    await fs.rm(left, { recursive: true, force: true })
    await fs.rm(right, { recursive: true, force: true })
  }
})

test('compareTrees hash: same size and timestamp, different bytes is contentDiff', async () => {
  const left = await temp()
  const right = await temp()
  try {
    const t = Date.now()
    await write(left, 'a.bin', 'aaaa', t)
    await write(right, 'a.bin', 'bbbb', t)
    const got = await compareTrees(left, right, localOps(), { compareBy: 'hash' })
    assert.equal(got.rows[0].state, 'contentDiff')
    assert.equal(got.hashed, 2)
    assert.ok(got.rows[0].left?.hash)
  } finally {
    await fs.rm(left, { recursive: true, force: true })
    await fs.rm(right, { recursive: true, force: true })
  }
})

test('compareTrees: a folder on one side and a file on the other is typeDiff', async () => {
  const left = await temp()
  const right = await temp()
  try {
    await fs.mkdir(path.join(left, 'thing'))
    await write(right, 'thing', 'not a folder')
    const got = await compareTrees(left, right, localOps(), {})
    assert.equal(got.rows.find((r) => r.rel === 'thing')?.state, 'typeDiff')
  } finally {
    await fs.rm(left, { recursive: true, force: true })
    await fs.rm(right, { recursive: true, force: true })
  }
})

test('applyPlan: copies with the source mtime, creates parents, and trashes deletions', async () => {
  const left = await temp()
  const right = await temp()
  const trashed: string[] = []
  try {
    const t = Date.now() - 120_000
    await write(left, 'deep/new/file.txt', 'hello', t)
    await write(right, 'extra.txt', 'bye', t)
    const cmp = await compareTrees(left, right, localOps(), {})
    const plan = planRows(cmp.rows, 'ltr', { deleteExtra: true })
    const res = await applyPlan(left, right, plan, localOps(), {
      trash: async (p) => {
        trashed.push(p)
        await fs.rm(p, { recursive: true, force: true })
      }
    })
    assert.equal(res.copied, 1)
    assert.equal(res.removed, 1)
    assert.deepEqual(res.errors, [])
    assert.equal(await fs.readFile(path.join(right, 'deep/new/file.txt'), 'utf8'), 'hello')
    const st = await fs.stat(path.join(right, 'deep/new/file.txt'))
    assert.ok(Math.abs(st.mtimeMs - t) < 2500)
    assert.deepEqual(trashed.map((p) => path.basename(p)), ['extra.txt'])
  } finally {
    await fs.rm(left, { recursive: true, force: true })
    await fs.rm(right, { recursive: true, force: true })
  }
})

test('applyPlan: two-way copies each changed side and refuses an unresolved conflict', async () => {
  const left = await temp()
  const right = await temp()
  try {
    const t = Date.now() - 120_000
    const base: Baseline = {
      'both-changed.txt': { size: 3, mtime: t, dir: false },
      'left.txt': { size: 3, mtime: t, dir: false },
      'right.txt': { size: 3, mtime: t, dir: false }
    }
    await write(left, 'both-changed.txt', 'left-version', t + 10_000)
    await write(right, 'both-changed.txt', 'right-version', t + 20_000)
    await write(left, 'left.txt', 'new-left', t + 10_000)
    await write(right, 'left.txt', 'old', t)
    await write(left, 'right.txt', 'old', t)
    await write(right, 'right.txt', 'new-right', t + 10_000)
    const cmp = await compareTrees(left, right, localOps(), { twoWay: true, baseline: base })
    const conflict = cmp.rows.find((r) => r.rel === 'both-changed.txt')
    assert.equal(conflict?.state, 'conflict')

    const blocked = planRows(cmp.rows, 'both')
    assert.equal(blocked.conflicts.length, 1)
    const res = await applyPlan(left, right, blocked, localOps())
    assert.equal(res.copied, 2)
    assert.equal(await fs.readFile(path.join(right, 'both-changed.txt'), 'utf8'), 'right-version')

    const resolved = planRows(cmp.rows, 'both', { resolutions: { 'both-changed.txt': 'left' } })
    await applyPlan(left, right, resolved, localOps())
    assert.equal(await fs.readFile(path.join(right, 'both-changed.txt'), 'utf8'), 'left-version')
    assert.equal(await fs.readFile(path.join(left, 'right.txt'), 'utf8'), 'new-right')

    const next = nextBaseline(cmp.rows, base, resolved)
    assert.ok(next['both-changed.txt'])
  } finally {
    await fs.rm(left, { recursive: true, force: true })
    await fs.rm(right, { recursive: true, force: true })
  }
})

test('applyPlan: a cancelled run reports cancel and writes nothing', async () => {
  const left = await temp()
  const right = await temp()
  try {
    await write(left, 'a.txt', 'A'.repeat(64_000))
    const cmp = await compareTrees(left, right, localOps(), {})
    const plan = planRows(cmp.rows, 'ltr')
    const res = await applyPlan(left, right, plan, localOps(), { ctl: { cancelled: true, paused: false } })
    assert.equal(res.cancel, true)
    assert.equal(res.copied, 0)
    assert.equal(await exists(path.join(right, 'a.txt')), false)
  } finally {
    await fs.rm(left, { recursive: true, force: true })
    await fs.rm(right, { recursive: true, force: true })
  }
})

test('applyPlan: byte and file progress callbacks fire for a real copy', async () => {
  const left = await temp()
  const right = await temp()
  const files: string[] = []
  let bytes = 0
  try {
    await write(left, 'big.bin', 'x'.repeat(200_000))
    const cmp = await compareTrees(left, right, localOps(), {})
    const plan = planRows(cmp.rows, 'ltr')
    const res = await applyPlan(left, right, plan, localOps(), {
      ctl: {
        cancelled: false,
        paused: false,
        onBytes: (n) => {
          bytes += n
        },
        onFile: (rel) => files.push(rel)
      }
    })
    assert.equal(res.copied, 1)
    assert.deepEqual(files, ['big.bin'])
    assert.equal(bytes, 200_000)
  } finally {
    await fs.rm(left, { recursive: true, force: true })
    await fs.rm(right, { recursive: true, force: true })
  }
})

test('invertPlan + applyPlan: a copy can be undone while the source still exists', async () => {
  const left = await temp()
  const right = await temp()
  try {
    await write(left, 'a.txt', 'A', Date.now() - 5000)
    const cmp = await compareTrees(left, right, localOps(), {})
    const plan = planRows(cmp.rows, 'ltr')
    await applyPlan(left, right, plan, localOps())
    const inv = invertPlan(plan)
    assert.deepEqual(inv.unrestorable, [])
    await applyPlan(left, right, { ...plan, copy: inv.copy, remove: [] }, localOps())
    assert.equal(await fs.readFile(path.join(right, 'a.txt'), 'utf8'), 'A')
  } finally {
    await fs.rm(left, { recursive: true, force: true })
    await fs.rm(right, { recursive: true, force: true })
  }
})

/**
 * A stand-in RemoteFs: the URI's path is a path under a temp root. This exercises the remote branch
 * of createOps (stat/list/download/upload/remove) without a server.
 */
function fakeRemote(root: string): RemoteFs {
  const localOf = (uri: string): string => {
    const loc = parseRemote(uri)
    if (!loc) throw new Error(`not remote: ${uri}`)
    return path.join(root, loc.path.replace(/^\/+/, ''))
  }
  return {
    stat: async (uri: string) => {
      const st = await fs.stat(localOf(uri)).catch(() => null)
      if (!st) return null
      return { name: path.basename(localOf(uri)), dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs }
    },
    list: async (uri: string, showHidden = false) => {
      const dir = localOf(uri)
      const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      const out = []
      for (const item of items) {
        if (!showHidden && item.name.startsWith('.')) continue
        const st = await fs.stat(path.join(dir, item.name))
        out.push({
          name: item.name,
          path: `${uri.replace(/\/$/, '')}/${item.name}`,
          dir: st.isDirectory(),
          size: st.isDirectory() ? 0 : st.size,
          mtime: st.mtimeMs,
          ext: ''
        })
      }
      return { path: uri, parent: null, entries: out }
    },
    downloadFile: async (uri: string, localPath: string) => {
      const from = localOf(uri)
      await fs.mkdir(path.dirname(localPath), { recursive: true })
      await fs.copyFile(from, localPath)
      const st = await fs.stat(from)
      return { size: st.size }
    },
    uploadFile: async (localPath: string, uri: string) => {
      const to = localOf(uri)
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.copyFile(localPath, to)
      const st = await fs.stat(localPath)
      return { size: st.size }
    },
    remove: async (uri: string) => {
      await fs.rm(localOf(uri), { recursive: true, force: true })
    },
    utimes: async () => undefined
  } as unknown as RemoteFs
}

test('createOps: local → sftp and sftp → local both work through the remote adapter', async () => {
  const left = await temp()
  const remoteRoot = await temp('mfm-fake-remote-')
  try {
    const ops = createOps(fakeRemote(remoteRoot))
    const uri = (p: string): string => `sftp://user@host/${p}`
    await write(left, 'from-local.txt', 'L', Date.now() - 9000)
    await write(remoteRoot, 'remote/dir/from-remote.txt', 'R', Date.now() - 9000)
    const cmp = await compareTrees(left, uri('remote'), ops, {})
    const plan = planRows(cmp.rows, 'ltr')
    const res = await applyPlan(left, uri('remote'), plan, ops)
    assert.deepEqual(res.errors, [])
    assert.equal(
      await fs.readFile(path.join(remoteRoot, 'remote/from-local.txt'), 'utf8'),
      'L'
    )
    // the remote file comes back on the reverse run
    const back = await compareTrees(left, uri('remote'), ops, {})
    const rtl = planRows(back.rows, 'rtl')
    await applyPlan(left, uri('remote'), rtl, ops)
    assert.equal(await fs.readFile(path.join(left, 'dir/from-remote.txt'), 'utf8'), 'R')
  } finally {
    await fs.rm(left, { recursive: true, force: true })
    await fs.rm(remoteRoot, { recursive: true, force: true })
  }
})

test('encryption: a plaintext source is written as age ciphertext and hashes as plaintext', async () => {
  const left = await temp()
  const right = await temp()
  const { identity, recipient } = await generateKeypair()
  try {
    await write(left, 'secret.txt', 'hello age', Date.now() - 20_000)
    const enc = { right: { mode: 'keypair' as const, identity, recipient } }
    const cmp = await compareTrees(left, right, localOps(), { compareBy: 'hash', enc })
    assert.equal(cmp.rows[0].state, 'leftOnly')
    const plan = planRows(cmp.rows, 'ltr')
    const res = await applyPlan(left, right, plan, localOps(), { enc })
    assert.deepEqual(res.errors, [])
    const raw = await fs.readFile(path.join(right, 'secret.txt'))
    assert.match(raw.subarray(0, 24).toString(), /^age-encryption\.org\/v1/)
    const back = path.join(right, 'back.txt')
    await decryptFile(path.join(right, 'secret.txt'), back, { mode: 'keypair', identity, recipient })
    assert.equal(await fs.readFile(back, 'utf8'), 'hello age')
    // the next compare decrypts the ciphertext and sees the same plaintext hash
    const again = await compareTrees(left, right, localOps(), { compareBy: 'hash', enc })
    assert.equal(again.rows.find((r) => r.rel === 'secret.txt')?.state, 'same')
  } finally {
    await fs.rm(left, { recursive: true, force: true })
    await fs.rm(right, { recursive: true, force: true })
  }
})

test('encryption: an encrypted source is decrypted into a plaintext destination', async () => {
  const left = await temp()
  const right = await temp()
  const { identity, recipient } = await generateKeypair()
  try {
    const plain = path.join(left, 'secret.txt')
    await fs.writeFile(plain, 'from an encrypted side')
    const cipher = path.join(left, 'cipher.tmp')
    await encryptFile(plain, cipher, { mode: 'keypair', recipient })
    await fs.rename(cipher, plain)
    const enc = { left: { mode: 'keypair' as const, identity, recipient } }
    const cmp = await compareTrees(left, right, localOps(), { compareBy: 'hash', enc })
    assert.equal(cmp.rows[0].state, 'leftOnly')
    const plan = planRows(cmp.rows, 'ltr')
    const res = await applyPlan(left, right, plan, localOps(), { enc })
    assert.deepEqual(res.errors, [])
    assert.equal(await fs.readFile(path.join(right, 'secret.txt'), 'utf8'), 'from an encrypted side')
  } finally {
    await fs.rm(left, { recursive: true, force: true })
    await fs.rm(right, { recursive: true, force: true })
  }
})

test('createOps: a remote path without a remote adapter is refused instead of treated as local', async () => {
  const ops = createOps(undefined)
  await assert.rejects(() => ops.stat('sftp://host/x'), /remote support is not available/)
})

test('compareSubset: changed, unchanged and cloud-deleted paths only', async () => {
  const left = await temp()
  const right = await temp()
  try {
    const t = Date.now() - 120_000
    await write(left, 'changed.txt', 'new', t + 10_000)
    await write(right, 'changed.txt', 'old', t)
    await write(left, 'same.txt', 'S', t)
    await write(right, 'same.txt', 'S', t)
    await write(left, 'gone.txt', 'G', t)
    const cmp = await compareSubset(left, right, localOps(), ['changed.txt', 'same.txt', 'gone.txt'])
    const by = new Map(cmp.rows.map((r) => [r.rel, r.state]))
    assert.equal(by.get('changed.txt'), 'leftNewer')
    assert.equal(by.get('same.txt'), 'same')
    assert.equal(by.get('gone.txt'), 'leftOnly')
    assert.equal(cmp.leftCount, 3)
    assert.equal(cmp.rightCount, 2)
    assert.equal(cmp.hashed, 0)
    assert.equal(cmp.capped, false)

    // only the two differing paths become actions; the unchanged row is skipped
    const plan = planRows(cmp.rows, 'ltr')
    assert.deepEqual(plan.copy.map((a) => a.rel).sort(), ['changed.txt', 'gone.txt'])
    assert.deepEqual(plan.remove, [])
  } finally {
    await fs.rm(left, { recursive: true, force: true })
    await fs.rm(right, { recursive: true, force: true })
  }
})

test('compareSubset: known right-side metadata means no ops.stat on the right', async () => {
  const left = await temp()
  const right = path.join(left, 'right')
  try {
    const t = Date.now() - 120_000
    await write(left, 'same.txt', 'S', t)
    await write(left, 'changed.txt', 'new', t + 10_000)
    let rightStats = 0
    const base = localOps()
    const ops = {
      ...base,
      stat: async (p: string) => {
        if (p.startsWith(right)) {
          rightStats++
          return null
        }
        return base.stat(p)
      }
    }
    const rightByRel = new Map<string, { size: number; mtime: number; dir: boolean }>([
      ['same.txt', { size: 1, mtime: t, dir: false }],
      ['changed.txt', { size: 3, mtime: t, dir: false }],
      ['cloudonly.txt', { size: 2, mtime: t, dir: false }]
    ])
    const cmp = await compareSubset(left, right, ops, [...rightByRel.keys()], { rightByRel })
    assert.equal(rightStats, 0)
    const by = new Map(cmp.rows.map((r) => [r.rel, r.state]))
    assert.equal(by.get('same.txt'), 'same')
    assert.equal(by.get('changed.txt'), 'leftNewer')
    assert.equal(by.get('cloudonly.txt'), 'rightOnly')
    assert.equal(cmp.leftCount, 2)
    assert.equal(cmp.rightCount, 3)
  } finally {
    await fs.rm(left, { recursive: true, force: true })
  }
})

test('nextBaselineSubset: untouched baseline keys survive a one-row incremental run', () => {
  const t = Date.now()
  const baseline: Baseline = {
    'a.txt': { size: 1, mtime: t, dir: false },
    'b.txt': { size: 2, mtime: t, dir: false },
    'c/d.txt': { size: 3, mtime: t, dir: false }
  }
  const rows: SyncRow[] = [
    {
      rel: 'a.txt',
      state: 'same',
      left: { size: 1, mtime: t, dir: false },
      right: { size: 1, mtime: t, dir: false }
    }
  ]
  const plan = planRows(rows, 'both')
  const next = nextBaselineSubset(rows, baseline, plan)
  assert.deepEqual(Object.keys(next).sort(), ['a.txt', 'b.txt', 'c/d.txt'])
  assert.deepEqual(next['b.txt'], baseline['b.txt'])
  assert.deepEqual(next['c/d.txt'], baseline['c/d.txt'])
})
