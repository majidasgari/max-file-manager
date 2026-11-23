import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createEngine, type Job } from './jobs.ts'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'mfm-'))
const exists = (p: string) => fs.access(p).then(() => true, () => false)

const engine = () => {
  const seen: Job[] = []
  return { e: createEngine((j) => seen.push(j)), seen }
}

/** Jobs run on a chain; wait until the last one stops being queued/running. */
async function settle(seen: Job[]): Promise<Job> {
  for (let i = 0; i < 400; i++) {
    const last = seen[seen.length - 1]
    if (last && ['done', 'error', 'cancelled'].includes(last.state)) return last
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('job did not settle')
}

test('copy reports bytes and keeps the source', async () => {
  const root = await tmp()
  const src = path.join(root, 'big.bin')
  const dest = path.join(root, 'dest')
  await fs.writeFile(src, Buffer.alloc(3 * 1024 * 1024, 7))
  await fs.mkdir(dest)

  const { e, seen } = engine()
  e.start('copy', [src], dest)
  const job = await settle(seen)

  assert.equal(job.state, 'done')
  assert.equal(job.bytes, 3 * 1024 * 1024)
  assert.equal(job.done, job.bytes, 'every byte is accounted for')
  assert.ok(await exists(src))
  assert.equal((await fs.stat(path.join(dest, 'big.bin'))).size, job.bytes)
})

test('move deletes the source and can be undone', async () => {
  const root = await tmp()
  const src = path.join(root, 'dir')
  const dest = path.join(root, 'dest')
  await fs.mkdir(src)
  await fs.writeFile(path.join(src, 'inner.txt'), 'content')
  await fs.mkdir(dest)

  const { e, seen } = engine()
  e.start('move', [src], dest)
  assert.equal((await settle(seen)).state, 'done')
  assert.equal(await exists(src), false)
  assert.equal(await fs.readFile(path.join(dest, 'dir', 'inner.txt'), 'utf8'), 'content')

  assert.equal(e.undoDepth(), 1)
  const u = await e.undo()
  assert.equal(u.done, 1)
  assert.equal(await fs.readFile(path.join(src, 'inner.txt'), 'utf8'), 'content', 'undo moves it back')
  assert.equal(await exists(path.join(dest, 'dir')), false)
})

test('cancel stops the transfer and leaves no partial file', async () => {
  const root = await tmp()
  const src = path.join(root, 'huge.bin')
  const dest = path.join(root, 'dest')
  await fs.writeFile(src, Buffer.alloc(24 * 1024 * 1024, 3))
  await fs.mkdir(dest)

  const { e, seen } = engine()
  const job = e.start('copy', [src], dest)
  for (let i = 0; i < 200 && !seen.some((j) => j.state === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  e.cancel(job.id)
  const end = await settle(seen)

  assert.equal(end.state, 'cancelled')
  assert.equal(await exists(path.join(dest, 'huge.bin')), false, 'partial copy is removed')
})

test('renameMany renames and undo reverses it', async () => {
  const root = await tmp()
  const names = ['a.txt', 'b.txt']
  for (const n of names) await fs.writeFile(path.join(root, n), n)

  const { e } = engine()
  const r = await e.renameMany([
    { from: path.join(root, 'a.txt'), to: path.join(root, 'x-a.txt') },
    { from: path.join(root, 'b.txt'), to: path.join(root, 'x-b.txt') }
  ])
  assert.deepEqual(r, { done: 2, errors: [] })
  assert.ok(await exists(path.join(root, 'x-a.txt')))

  await e.undo()
  assert.ok(await exists(path.join(root, 'a.txt')))
  assert.equal(await exists(path.join(root, 'x-a.txt')), false)
})

test('makeDir creates and undo removes it', async () => {
  const root = await tmp()
  const { e } = engine()
  assert.deepEqual(await e.makeDir(root, 'new folder'), { done: 1, errors: [] })
  assert.ok(await exists(path.join(root, 'new folder')))
  await e.undo()
  assert.equal(await exists(path.join(root, 'new folder')), false)
})

test('createFile creates file with content and undo removes it', async () => {
  const root = await tmp()
  const { e } = engine()
  const res = await e.createFile(root, 'note.txt', 'hello world')
  assert.deepEqual(res, { done: 1, errors: [] })
  assert.ok(await exists(path.join(root, 'note.txt')))
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'hello world')

  // existing file cannot be overwritten
  const failRes = await e.createFile(root, 'note.txt', 'over')
  assert.equal(failRes.done, 0)
  assert.equal(failRes.errors.length, 1)

  await e.undo()
  assert.equal(await exists(path.join(root, 'note.txt')), false)

  // base64 payload creates raw binary file
  const binRes = await e.createFile(root, 'raw.bin', 'base64:AQIDBA==')
  assert.deepEqual(binRes, { done: 1, errors: [] })
  const binBuf = await fs.readFile(path.join(root, 'raw.bin'))
  assert.deepEqual([...binBuf], [1, 2, 3, 4])
  await e.undo()
  assert.equal(await exists(path.join(root, 'raw.bin')), false)

  // base64 creates valid zip/docx header (PK\x03\x04)
  const docxRes = await e.createFile(root, 'doc.docx', 'base64:UEsDBBQAAAAIA===')
  assert.deepEqual(docxRes, { done: 1, errors: [] })
  const docBuf = await fs.readFile(path.join(root, 'doc.docx'))
  assert.equal(docBuf[0], 0x50) // 'P'
  assert.equal(docBuf[1], 0x4b) // 'K'
  await e.undo()
  assert.equal(await exists(path.join(root, 'doc.docx')), false)
})

test('a bad destination fails the job instead of guessing', async () => {
  const root = await tmp()
  const src = path.join(root, 'a.txt')
  await fs.writeFile(src, 'x')
  const { e, seen } = engine()
  e.start('copy', [src], 'relative/dest')
  const job = await settle(seen)
  assert.equal(job.state, 'error')
  assert.match(job.errors[0], /destination/)
})

test('skipExisting leaves an existing destination file alone and counts it', async () => {
  const root = await tmp()
  const src = path.join(root, 'src')
  const dest = path.join(root, 'dest')
  await fs.mkdir(src)
  await fs.mkdir(dest)
  await fs.writeFile(path.join(src, 'same.txt'), 'new content')
  await fs.writeFile(path.join(src, 'fresh.txt'), 'only here')
  await fs.writeFile(path.join(dest, 'same.txt'), 'old')

  const { e, seen } = engine()
  e.start('copy', [path.join(src, 'same.txt'), path.join(src, 'fresh.txt')], dest, {
    skipExisting: true
  })
  const job = await settle(seen)

  assert.equal(job.state, 'done')
  assert.equal(job.skipped, 1)
  assert.equal(await fs.readFile(path.join(dest, 'same.txt'), 'utf8'), 'old', 'existing file untouched')
  assert.equal(await fs.readFile(path.join(dest, 'fresh.txt'), 'utf8'), 'only here')
  assert.equal(await exists(path.join(dest, 'same (2).txt')), false, 'skipExisting must not rename')
})

test('newerOnly copies an older destination file but skips a newer one', async () => {
  const root = await tmp()
  const src = path.join(root, 'src')
  const dest = path.join(root, 'dest')
  await fs.mkdir(src)
  await fs.mkdir(dest)
  await fs.writeFile(path.join(src, 'older.txt'), 'from source')
  await fs.writeFile(path.join(dest, 'older.txt'), 'from dest')
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(path.join(dest, 'older.txt'), old, old)

  await fs.writeFile(path.join(src, 'newer.txt'), 'from source')
  await fs.writeFile(path.join(dest, 'newer.txt'), 'from dest')

  const { e, seen } = engine()
  e.start('copy', [path.join(src, 'older.txt'), path.join(src, 'newer.txt')], dest, { newerOnly: true })
  const job = await settle(seen)

  assert.equal(job.state, 'done')
  assert.equal(job.skipped, 1, 'the destination copy is newer, so it stays')
  assert.equal(await fs.readFile(path.join(dest, 'older.txt'), 'utf8'), 'from source', 'older dest is replaced')
  assert.equal(await fs.readFile(path.join(dest, 'newer.txt'), 'utf8'), 'from dest')
})

test('the per-file log lists what was copied inside a folder, what a filter skipped and why', async () => {
  const root = await tmp()
  const src = path.join(root, 'src')
  const dest = path.join(root, 'dest')
  await fs.mkdir(path.join(src, 'dir'), { recursive: true })
  await fs.mkdir(dest)
  await fs.writeFile(path.join(src, 'dir', 'inner.txt'), 'inner')
  await fs.writeFile(path.join(src, 'dir', 'deep.txt'), 'deep')
  await fs.writeFile(path.join(src, 'fresh.txt'), 'only here')
  await fs.writeFile(path.join(dest, 'fresh.txt'), 'already there')

  const { e, seen } = engine()
  const job = e.start('copy', [path.join(src, 'dir'), path.join(src, 'fresh.txt')], dest, {
    skipExisting: true
  })
  const done = await settle(seen)
  assert.equal(done.state, 'done')

  const log = e.files(job.id)
  assert.ok(log, 'a finished job keeps its log')
  assert.deepEqual(
    log!.copied.entries.map((f) => path.basename(f.path)).sort(),
    ['deep.txt', 'inner.txt'],
    'files inside the folder are logged one by one'
  )
  assert.equal(log!.copied.total, 2)
  assert.equal(log!.copied.entries.find((f) => f.path.endsWith('inner.txt'))?.size, 5)
  assert.deepEqual(log!.skipped.entries, [
    { path: path.join(src, 'fresh.txt'), state: 'skipped', note: 'exists' }
  ])
  assert.equal(log!.failed.total, 0)
})

test('clearing finished jobs drops their logs too', async () => {
  const root = await tmp()
  const dest = path.join(root, 'dest')
  const src = path.join(root, 'one.txt')
  await fs.mkdir(dest)
  await fs.writeFile(src, 'x')

  const { e, seen } = engine()
  const job = e.start('copy', [src], dest)
  await settle(seen)
  assert.ok(e.files(job.id))
  e.clear()
  assert.equal(e.files(job.id), null)
  assert.equal(e.files('nope'), null)
})

test('conflict: overwrite replaces the destination and logs it as overwritten', async () => {
  const root = await tmp()
  const src = path.join(root, 'src')
  const dest = path.join(root, 'dest')
  await fs.mkdir(src)
  await fs.mkdir(dest)
  await fs.writeFile(path.join(src, 'same.txt'), 'new')
  await fs.writeFile(path.join(src, 'fresh.txt'), 'fresh')
  await fs.writeFile(path.join(dest, 'same.txt'), 'old')

  const { e, seen } = engine()
  const job = e.start('copy', [path.join(src, 'same.txt'), path.join(src, 'fresh.txt')], dest, {
    conflict: 'overwrite'
  })
  const done = await settle(seen)

  assert.equal(done.state, 'done')
  assert.equal(done.conflict, 'overwrite')
  assert.equal(done.skipped, 0)
  assert.equal(done.overwrites, 1, 'one destination file was replaced')
  assert.equal(await fs.readFile(path.join(dest, 'same.txt'), 'utf8'), 'new')
  assert.equal(await exists(path.join(dest, 'same (2).txt')), false, 'overwrite never renames')
  const log = e.files(job.id)!
  assert.equal(log.copied.total, 2)
  assert.equal(log.copied.entries.find((f) => f.path.endsWith('fresh.txt'))?.overwrote, false)
  assert.equal(log.copied.entries.find((f) => f.path.endsWith('same.txt'))?.overwrote, true)
})

test('conflict: skip leaves every existing name alone, keep makes a free name', async () => {
  const root = await tmp()
  const src = path.join(root, 'src')
  const dest = path.join(root, 'dest')
  await fs.mkdir(src)
  await fs.mkdir(dest)
  await fs.writeFile(path.join(src, 'a.txt'), 'new')
  await fs.writeFile(path.join(dest, 'a.txt'), 'old')

  const skip = engine()
  skip.e.start('copy', [path.join(src, 'a.txt')], dest, { conflict: 'skip' })
  const skipJob = await settle(skip.seen)
  assert.equal(skipJob.skipped, 1)
  assert.equal(skipJob.conflict, 'skip')
  assert.equal(await fs.readFile(path.join(dest, 'a.txt'), 'utf8'), 'old')
  assert.deepEqual(skip.e.files(skipJob.id)!.skipped.entries[0].note, 'exists')

  const keep = engine()
  keep.e.start('copy', [path.join(src, 'a.txt')], dest, { conflict: 'keep' })
  await settle(keep.seen)
  assert.equal(await fs.readFile(path.join(dest, 'a.txt'), 'utf8'), 'old')
  assert.equal(await fs.readFile(path.join(dest, 'a (2).txt'), 'utf8'), 'new', 'keep both adds a suffix')
})

test('conflict: newer replaces an older destination but leaves a newer one', async () => {
  const root = await tmp()
  const src = path.join(root, 'src')
  const dest = path.join(root, 'dest')
  await fs.mkdir(src)
  await fs.mkdir(dest)
  await fs.writeFile(path.join(src, 'older.txt'), 'from source')
  await fs.writeFile(path.join(dest, 'older.txt'), 'from dest')
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(path.join(dest, 'older.txt'), old, old)
  await fs.writeFile(path.join(src, 'newer.txt'), 'from source')
  await fs.writeFile(path.join(dest, 'newer.txt'), 'from dest')

  const { e, seen } = engine()
  const job = e.start('copy', [path.join(src, 'older.txt'), path.join(src, 'newer.txt')], dest, {
    conflict: 'newer'
  })
  const done = await settle(seen)

  assert.equal(done.conflict, 'newer')
  assert.equal(done.skipped, 1)
  assert.equal(done.overwrites, 1)
  assert.equal(await fs.readFile(path.join(dest, 'older.txt'), 'utf8'), 'from source')
  assert.equal(await fs.readFile(path.join(dest, 'newer.txt'), 'utf8'), 'from dest')
  assert.equal(e.files(job.id)!.skipped.entries[0].note, 'newer')
})

test('the legacy skipExisting/newerOnly flags still pick a policy', async () => {
  const root = await tmp()
  const src = path.join(root, 'src')
  const dest = path.join(root, 'dest')
  await fs.mkdir(src)
  await fs.mkdir(dest)
  await fs.writeFile(path.join(src, 'x.txt'), 'new')
  await fs.writeFile(path.join(dest, 'x.txt'), 'old')

  const { e, seen } = engine()
  const job = e.start('copy', [path.join(src, 'x.txt')], dest, { skipExisting: true })
  const done = await settle(seen)
  assert.equal(done.conflict, 'skip')
  assert.equal(job.conflict, 'skip')
  assert.equal(await fs.readFile(path.join(dest, 'x.txt'), 'utf8'), 'old')
  assert.equal(done.skipped, 1)
})
