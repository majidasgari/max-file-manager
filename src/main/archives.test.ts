import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { zipSync } from 'fflate'
import { createArchive, extract, isArchive, listArchive, verifyArchive } from './archives.ts'
import { archiveStem, openZip, writeZip } from './zip-archive.ts'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'mfm-arc-'))
const enc = (s: string) => new TextEncoder().encode(s)
const has = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0

async function makeZip(root: string, name = 'sample.zip'): Promise<string> {
  const zip = zipSync({
    'a.txt': enc('alpha'),
    'sub/b.txt': enc('beta'),
    'empty.txt': enc('')
  })
  const p = path.join(root, name)
  await fs.writeFile(p, zip)
  return p
}

async function fixture(root: string): Promise<string> {
  const src = path.join(root, 'pack')
  await fs.mkdir(path.join(src, 'deep'), { recursive: true })
  await fs.writeFile(path.join(src, 'one.txt'), 'first file')
  await fs.writeFile(path.join(src, 'deep', 'two.txt'), 'second file')
  await fs.mkdir(path.join(src, 'empty-dir'))
  return src
}

test('the subfolder name from an archive can never escape the destination', () => {
  assert.equal(archiveStem('/x/...zip'), 'archive')
  assert.equal(archiveStem('/x/.zip'), 'archive')
  assert.equal(archiveStem('/x/backup.tar.gz'), 'backup')
  assert.equal(archiveStem('/x/../../../etc/passwd.zip'), 'passwd')
})

test('isArchive recognises zip and the tar family, and rejects ordinary files', () => {
  for (const p of ['x.zip', 'x.cbz', 'x.tar', 'x.tar.gz', 'x.tgz', 'x.tar.bz2', 'x.tar.zst', 'x.tzst'])
    assert.equal(isArchive(p), true, p)
  assert.equal(isArchive('x.txt'), false)
})

test('listArchive reads zip entries with sizes, methods and archive-qualified paths', async () => {
  const root = await tmp()
  const zip = await makeZip(root)
  const { entries, error } = await listArchive(zip)
  assert.equal(error, undefined)
  assert.deepEqual(entries.map((e) => e.name).sort(), ['a.txt', 'empty.txt', 'sub/b.txt'])
  const a = entries.find((e) => e.name === 'a.txt')!
  assert.equal(a.size, 5)
  assert.equal(a.path, `${zip}!a.txt`)
  assert.equal(a.ext, 'txt')
  assert.equal(a.method, 8)
  assert.equal(a.encrypted, false)
})

test('extract writes only the chosen entries, into the destination', async () => {
  const root = await tmp()
  const zip = await makeZip(root)
  const dest = path.join(root, 'out')
  await fs.mkdir(dest)

  const r = await extract({ archive: zip, names: ['sub/b.txt'], dest })
  assert.deepEqual(r.errors, [])
  assert.equal(r.done, 1)
  assert.equal(await fs.readFile(path.join(dest, 'sub', 'b.txt'), 'utf8'), 'beta')
  assert.equal(
    await fs.access(path.join(dest, 'a.txt')).then(() => true, () => false),
    false,
    'unselected entries stay inside the archive'
  )
})

test('a directory selection extracts everything below it', async () => {
  const root = await tmp()
  const zip = await makeZip(root)
  const dest = path.join(root, 'out')
  await fs.mkdir(dest)
  const r = await extract({ archive: zip, names: ['sub'], dest })
  assert.equal(r.done, 1)
  assert.equal(await fs.readFile(path.join(dest, 'sub', 'b.txt'), 'utf8'), 'beta')
  assert.equal(await fs.access(path.join(dest, 'a.txt')).then(() => true, () => false), false)
})

test('extract with no names writes everything', async () => {
  const root = await tmp()
  const zip = await makeZip(root)
  const dest = path.join(root, 'all')
  await fs.mkdir(dest)
  const r = await extract({ archive: zip, dest })
  assert.equal(r.done, 3)
  assert.deepEqual(r.errors, [])
  assert.equal(await fs.readFile(path.join(dest, 'a.txt'), 'utf8'), 'alpha')
})

test('a tar archive is read and extracted by the built-in parser', async () => {
  const root = await tmp()
  const src = await fixture(root)
  const made = await createArchive({ dir: root, name: 'x', sources: [src], format: 'tar' })
  assert.ok('path' in made, JSON.stringify(made))
  if (!('path' in made)) return

  const { entries } = await listArchive(made.path)
  assert.deepEqual(
    entries.map((e) => e.name).sort(),
    ['pack', 'pack/deep', 'pack/deep/two.txt', 'pack/empty-dir', 'pack/one.txt'].sort()
  )

  const dest = path.join(root, 'out')
  const r = await extract({ archive: made.path, dest })
  assert.deepEqual(r.errors, [])
  assert.equal(await fs.readFile(path.join(dest, 'pack', 'one.txt'), 'utf8'), 'first file')
  assert.equal(await fs.readFile(path.join(dest, 'pack', 'deep', 'two.txt'), 'utf8'), 'second file')
  assert.equal(await fs.stat(path.join(dest, 'pack', 'empty-dir')).then((s) => s.isDirectory()), true)
})

test('createArchive writes a zip that lists and extracts back to the same bytes', async () => {
  const root = await tmp()
  const src = await fixture(root)
  const outDir = path.join(root, 'out')
  await fs.mkdir(outDir)

  const made = await createArchive({
    dir: outDir,
    name: 'بکاپ',
    sources: [src],
    format: 'zip',
    level: 9,
    comment: 'nightly'
  })
  assert.ok('path' in made, JSON.stringify(made))
  if (!('path' in made)) return
  assert.equal(path.basename(made.path), 'بکاپ.zip')
  assert.equal(made.files, 2)
  assert.equal((await openZip(made.path)).comment, 'nightly')

  const listed = await listArchive(made.path)
  const names = listed.entries.map((e) => e.name.replace(/\\/g, '/')).sort()
  assert.deepEqual(names, ['pack', 'pack/deep', 'pack/deep/two.txt', 'pack/empty-dir', 'pack/one.txt'])

  const back = path.join(root, 'back')
  await fs.mkdir(back)
  const res = await extract({ archive: made.path, dest: back })
  assert.deepEqual(res.errors, [])
  assert.equal(await fs.readFile(path.join(back, 'pack', 'one.txt'), 'utf8'), 'first file')
  assert.equal(await fs.readFile(path.join(back, 'pack', 'deep', 'two.txt'), 'utf8'), 'second file')
})

test('createArchive honours tar.gz and tar.zst', async () => {
  const root = await tmp()
  const src = await fixture(root)
  for (const format of ['tar.gz', 'tar.zst'] as const) {
    const made = await createArchive({ dir: root, name: format.replace('.', '-'), sources: [src], format })
    assert.ok('path' in made, JSON.stringify(made))
    if (!('path' in made)) continue
    const listed = await listArchive(made.path)
    assert.equal(listed.error, undefined, `${format}: ${listed.error}`)
    assert.ok(listed.entries.some((e) => e.name === 'pack/deep/two.txt'))
    const dest = path.join(root, `out-${format.replace(/\W/g, '')}`)
    const r = await extract({ archive: made.path, dest })
    assert.deepEqual(r.errors, [], format)
    assert.equal(await fs.readFile(path.join(dest, 'pack', 'deep', 'two.txt'), 'utf8'), 'second file')
  }
})

test('two sources with the same folder name get separate roots', async () => {
  const root = await tmp()
  for (const [sub, body] of [
    ['a', 'first'],
    ['b', 'second']
  ] as const) {
    await fs.mkdir(path.join(root, sub, 'pack'), { recursive: true })
    await fs.writeFile(path.join(root, sub, 'pack', 'f.txt'), body)
  }
  const made = await createArchive({
    dir: root,
    name: 'dupe-roots',
    sources: [path.join(root, 'a', 'pack'), path.join(root, 'b', 'pack')]
  })
  assert.ok('path' in made)
  if (!('path' in made)) return
  const names = (await listArchive(made.path)).entries.map((e) => e.name).sort()
  assert.deepEqual(names, ['pack', 'pack (2)', 'pack (2)/f.txt', 'pack/f.txt'])
  const dest = path.join(root, 'out')
  await extract({ archive: made.path, dest })
  assert.equal(await fs.readFile(path.join(dest, 'pack', 'f.txt'), 'utf8'), 'first')
  assert.equal(await fs.readFile(path.join(dest, 'pack (2)', 'f.txt'), 'utf8'), 'second')
})

test('a tar built by the system tar tool (long name + symlink) reads back', async (t) => {
  if (!has('tar')) return t.skip('tar is not installed')
  const root = await tmp()
  const src = path.join(root, 'pack')
  await fs.mkdir(src, { recursive: true })
  const long = 'x'.repeat(150) + '.txt'
  await fs.writeFile(path.join(src, long), 'long name body')
  await fs.writeFile(path.join(src, 'short.txt'), 'short')
  if (process.platform !== 'win32') await fs.symlink('short.txt', path.join(src, 'link.txt'))
  const archive = path.join(root, 'gnu.tar.gz')
  const made = spawnSync('tar', ['-czf', archive, '-C', root, 'pack'], { encoding: 'utf8' })
  assert.equal(made.status, 0, made.stderr)
  const listed = await listArchive(archive)
  assert.equal(listed.error, undefined)
  assert.ok(listed.entries.some((e) => e.name === `pack/${long}`))
  assert.ok(listed.entries.some((e) => e.name === 'pack/short.txt'))
  const dest = path.join(root, 'out')
  const r = await extract({ archive, dest })
  assert.deepEqual(r.errors, [])
  assert.equal(await fs.readFile(path.join(dest, 'pack', 'short.txt'), 'utf8'), 'short')
  assert.equal(await fs.readFile(path.join(dest, 'pack', long), 'utf8'), 'long name body')
})

test('createArchive never overwrites an existing archive and is empty-safe', async () => {
  const root = await tmp()
  const src = path.join(root, 'f.txt')
  await fs.writeFile(src, 'x')
  const dir = path.join(root, 'out')
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, 'a.zip'), 'old')

  const first = await createArchive({ dir, name: 'a', sources: [src] })
  assert.ok('path' in first)
  if ('path' in first) assert.equal(path.basename(first.path), 'a (2).zip', 'freeName guards the name')

  const empty = await createArchive({ dir, name: 'empty', sources: [] })
  assert.deepEqual(empty, { error: 'چیزی برای آرشیو کردن نیست' })
})

test('extract never overwrites by default: an existing file becomes "name (2)"', async () => {
  const root = await tmp()
  const zip = await makeZip(root)
  const dest = path.join(root, 'out')
  await fs.mkdir(dest)
  await fs.writeFile(path.join(dest, 'a.txt'), 'mine')

  const r = await extract({ archive: zip, names: ['a.txt'], dest })
  assert.deepEqual(r.errors, [])
  assert.equal(await fs.readFile(path.join(dest, 'a.txt'), 'utf8'), 'mine', 'the original is untouched')
  assert.equal(await fs.readFile(path.join(dest, 'a (2).txt'), 'utf8'), 'alpha')
})

test('the conflict policy chooses overwrite, skip or newer', async () => {
  const root = await tmp()
  const zip = await makeZip(root)
  const dest = path.join(root, 'out')
  await fs.mkdir(dest)
  await fs.writeFile(path.join(dest, 'a.txt'), 'mine')

  const over = await extract({ archive: zip, names: ['a.txt'], dest, conflict: 'overwrite' })
  assert.equal(over.done, 1)
  assert.equal(await fs.readFile(path.join(dest, 'a.txt'), 'utf8'), 'alpha')

  const skip = await extract({ archive: zip, names: ['a.txt'], dest, conflict: 'skip' })
  assert.equal(skip.done, 0)
  assert.equal(skip.skipped, 1)
  assert.equal(await fs.readFile(path.join(dest, 'a.txt'), 'utf8'), 'alpha')

  // `newer` needs a real timestamp on both sides: the fflate fixture carries none.
  const src = await fixture(root)
  const made = await createArchive({ dir: root, name: 'stamped', sources: [src] })
  assert.ok('path' in made)
  if (!('path' in made)) return
  const target = path.join(dest, 'pack', 'one.txt')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, 'mine')
  const future = Date.now() + 60_000
  await fs.utimes(target, future / 1000, future / 1000)
  const skipped = await extract({ archive: made.path, names: ['pack/one.txt'], dest, conflict: 'newer' })
  assert.equal(skipped.done, 0)
  assert.equal(skipped.skipped, 1)
  assert.equal(await fs.readFile(target, 'utf8'), 'mine')

  const past = 1_000_000
  await fs.utimes(target, past, past)
  const replaced = await extract({ archive: made.path, names: ['pack/one.txt'], dest, conflict: 'newer' })
  assert.equal(replaced.done, 1)
  assert.equal(await fs.readFile(target, 'utf8'), 'first file')
})

test('subfolder puts everything under one folder named after the archive', async () => {
  const root = await tmp()
  const zip = await makeZip(root)
  const dest = path.join(root, 'out')
  await fs.mkdir(dest)
  const r = await extract({ archive: zip, dest, subfolder: true })
  assert.deepEqual(r.errors, [])
  assert.equal(await fs.readFile(path.join(dest, 'sample', 'a.txt'), 'utf8'), 'alpha')
})

test('a zip-slip name is refused and nothing is written outside', async () => {
  const root = await tmp()
  const evil = path.join(root, 'evil.zip')
  await fs.writeFile(evil, zipSync({ '../escaped.txt': enc('bad'), 'ok.txt': enc('good') }))
  const dest = path.join(root, 'sandbox')
  await fs.mkdir(dest)
  const r = await extract({ archive: evil, dest })
  assert.ok(r.errors.some((e) => e.includes('..')), r.errors.join('\n'))
  assert.equal(await fs.access(path.join(root, 'escaped.txt')).then(() => true, () => false), false)
  assert.equal(await fs.readFile(path.join(dest, 'ok.txt'), 'utf8'), 'good')
})

test('AES-256 and ZipCrypto round-trip, reject a wrong password and keep names visible', async () => {
  const root = await tmp()
  const src = await fixture(root)
  for (const [encryption, password] of [
    ['aes256', 's3cret-ü'],
    ['aes128', 's3cret-ü'],
    ['zipcrypto', 's3cret-ü']
  ] as const) {
    const made = await createArchive({
      dir: root,
      name: `enc-${encryption}`,
      sources: [src],
      format: 'zip',
      password,
      encryption
    })
    assert.ok('path' in made, JSON.stringify(made))
    if (!('path' in made)) continue

    const listed = await listArchive(made.path)
    assert.equal(listed.encrypted, true, encryption)
    assert.ok(listed.entries.some((e) => e.name === 'pack/deep/two.txt'), encryption)

    const snap = path.join(root, `bad-${encryption}`)
    const bad = await extract({ archive: made.path, dest: snap, password: 'wrong' })
    assert.ok(bad.errors.length > 0, `${encryption} accepted a wrong password`)
    assert.equal(await fs.access(path.join(snap, 'pack', 'one.txt')).then(() => true, () => false), false)

    const dest = path.join(root, `ok-${encryption}`)
    const good = await extract({ archive: made.path, dest, password })
    assert.deepEqual(good.errors, [], encryption)
    assert.equal(await fs.readFile(path.join(dest, 'pack', 'deep', 'two.txt'), 'utf8'), 'second file', encryption)

    const check = await verifyArchive(made.path, { password })
    assert.equal(check.ok, true, `${encryption}: ${check.errors.join(', ')}`)
    assert.ok(check.checked >= 2)
  }
})

test('an encrypted zip without a password fails before writing anything', async () => {
  const root = await tmp()
  const src = await fixture(root)
  const made = await createArchive({ dir: root, name: 'secret', sources: [src], password: 'pw' })
  assert.ok('path' in made)
  if (!('path' in made)) return
  const dest = path.join(root, 'out')
  const r = await extract({ archive: made.path, dest })
  assert.ok(r.errors.some((e) => e.includes('رمز')), r.errors.join('\n'))
  assert.equal(await fs.access(path.join(dest, 'pack', 'one.txt')).then(() => true, () => false), false)
})

test('symlinks are stored and only recreated when asked', async (t) => {
  if (process.platform === 'win32') return t.skip('creating symlinks needs privileges on Windows')
  const root = await tmp()
  const src = path.join(root, 'pack')
  await fs.mkdir(src)
  await fs.writeFile(path.join(src, 'real.txt'), 'real')
  await fs.symlink('real.txt', path.join(src, 'link.txt'))

  const made = await createArchive({ dir: root, name: 'links', sources: [src] })
  assert.ok('path' in made)
  if (!('path' in made)) return
  const listed = await listArchive(made.path)
  assert.equal(listed.entries.find((e) => e.name === 'pack/link.txt')?.link, true)

  const plain = path.join(root, 'plain')
  const r1 = await extract({ archive: made.path, dest: plain })
  assert.deepEqual(r1.errors, [])
  assert.equal(await fs.access(path.join(plain, 'pack', 'link.txt')).then(() => true, () => false), false)

  const kept = path.join(root, 'kept')
  const r2 = await extract({ archive: made.path, dest: kept, symlinks: true })
  assert.deepEqual(r2.errors, [])
  const st = await fs.lstat(path.join(kept, 'pack', 'link.txt'))
  assert.equal(st.isSymbolicLink(), true)
  assert.equal(await fs.readlink(path.join(kept, 'pack', 'link.txt')), 'real.txt')
})

test('a symlink pointing outside the destination is refused', async (t) => {
  if (process.platform === 'win32') return t.skip('creating symlinks needs privileges on Windows')
  const root = await tmp()
  const src = path.join(root, 'pack')
  await fs.mkdir(src)
  await fs.symlink('/etc', path.join(src, 'escape'))
  const made = await createArchive({ dir: root, name: 'escape', sources: [src] })
  assert.ok('path' in made)
  if (!('path' in made)) return
  const dest = path.join(root, 'out')
  const r = await extract({ archive: made.path, dest, symlinks: true })
  assert.ok(r.errors.some((e) => e.includes('پیوند')), r.errors.join('\n'))
})

test('an existing symlinked folder in the destination is never followed', async (t) => {
  if (process.platform === 'win32') return t.skip('symlinks need privileges on Windows')
  const root = await tmp()
  const src = await fixture(root)
  const made = await createArchive({ dir: root, name: 'safe', sources: [src] })
  assert.ok('path' in made)
  if (!('path' in made)) return
  const dest = path.join(root, 'sandbox')
  const outside = path.join(root, 'outside')
  await fs.mkdir(dest)
  await fs.mkdir(outside)
  await fs.symlink(outside, path.join(dest, 'pack'))
  const r = await extract({ archive: made.path, dest })
  assert.ok(r.errors.length > 0)
  assert.equal(await fs.access(path.join(outside, 'one.txt')).then(() => true, () => false), false)
  assert.equal(await fs.readdir(outside).then((x) => x.length), 0)
})

test('ZIP64 records are readable by us and by 7z', async (t) => {
  if (!has('7z')) return t.skip('7z is not installed')
  const root = await tmp()
  const src = path.join(root, 'a.txt')
  await fs.writeFile(src, 'zip64 payload')
  const out = path.join(root, 'z64.zip')
  await writeZip(
    out,
    [
      { name: 'a.txt', abs: src, size: 13, mtime: Date.now() },
      { name: 'empty', dir: true }
    ],
    { zip64: true, level: 6, comment: 'forced zip64' }
  )
  const listed = await listArchive(out)
  assert.deepEqual(listed.entries.map((e) => e.name).sort(), ['a.txt', 'empty'])
  assert.equal(listed.entries.find((e) => e.name === 'a.txt')?.size, 13)

  const dest = path.join(root, 'out')
  const r = await extract({ archive: out, dest })
  assert.deepEqual(r.errors, [])
  assert.equal(await fs.readFile(path.join(dest, 'a.txt'), 'utf8'), 'zip64 payload')

  const z = spawnSync('7z', ['t', out], { encoding: 'utf8' })
  assert.equal(z.status, 0, z.stderr || z.stdout)

  const secure = path.join(root, 'z64-aes.zip')
  await writeZip(
    secure,
    [{ name: 'secret.txt', abs: src, size: 13, mtime: Date.now() }],
    { zip64: true, level: 9, password: 'pw', encryption: 'aes256' }
  )
  const secured = spawnSync('7z', ['t', '-ppw', secure], { encoding: 'utf8' })
  assert.equal(secured.status, 0, secured.stderr || secured.stdout)
  const back = path.join(root, 'z64-aes')
  const r2 = await extract({ archive: secure, dest: back, password: 'pw' })
  assert.deepEqual(r2.errors, [])
  assert.equal(await fs.readFile(path.join(back, 'secret.txt'), 'utf8'), 'zip64 payload')
})

test('our AES zip opens with 7-Zip and a 7-Zip AES zip opens with us', async (t) => {
  if (!has('7z')) return t.skip('7z is not installed')
  const root = await tmp()
  const src = path.join(root, 'pack')
  await fs.mkdir(src)
  await fs.writeFile(path.join(src, 'secret.txt'), 'aes interop\n'.repeat(50))

  const ours = await createArchive({
    dir: root,
    name: 'ours',
    sources: [src],
    password: 'interop',
    encryption: 'aes256'
  })
  assert.ok('path' in ours)
  if (!('path' in ours)) return
  const testOurs = spawnSync('7z', ['t', '-pinterop', ours.path], { encoding: 'utf8' })
  assert.equal(testOurs.status, 0, testOurs.stderr || testOurs.stdout)

  const theirs = path.join(root, 'theirs.zip')
  const made = spawnSync('7z', ['a', '-tzip', '-mem=AES256', '-pinterop', theirs, path.join(src, 'secret.txt')], {
    encoding: 'utf8'
  })
  assert.equal(made.status, 0, made.stderr || made.stdout)
  const dest = path.join(root, 'from7z')
  const r = await extract({ archive: theirs, dest, password: 'interop' })
  assert.deepEqual(r.errors, [])
  assert.equal(
    await fs.readFile(path.join(dest, 'secret.txt'), 'utf8'),
    'aes interop\n'.repeat(50)
  )
})

test('our ZipCrypto zip opens with unzip, and zip -e output opens with us', async (t) => {
  if (!has('unzip') || !has('zip')) return t.skip('zip/unzip are not installed')
  const root = await tmp()
  const src = path.join(root, 'pack')
  await fs.mkdir(src)
  await fs.writeFile(path.join(src, 'legacy.txt'), 'legacy interop\n'.repeat(30))

  const ours = await createArchive({
    dir: root,
    name: 'legacy',
    sources: [src],
    password: 'pw',
    encryption: 'zipcrypto'
  })
  assert.ok('path' in ours)
  if (!('path' in ours)) return
  const testOurs = spawnSync('unzip', ['-t', '-P', 'pw', ours.path], { encoding: 'utf8' })
  assert.equal(testOurs.status, 0, testOurs.stderr || testOurs.stdout)

  const theirs = path.join(root, 'theirs.zip')
  const made = spawnSync('zip', ['-e', '-P', 'pw', '-j', theirs, path.join(src, 'legacy.txt')], {
    encoding: 'utf8'
  })
  assert.equal(made.status, 0, made.stderr || made.stdout)
  const dest = path.join(root, 'fromzip')
  const r = await extract({ archive: theirs, dest, password: 'pw' })
  assert.deepEqual(r.errors, [])
  assert.equal(await fs.readFile(path.join(dest, 'legacy.txt'), 'utf8'), 'legacy interop\n'.repeat(30))
})

test('compression reports byte progress inside one large file', async () => {
  const root = await tmp()
  const big = path.join(root, 'big.bin')
  await fs.writeFile(big, Buffer.alloc(9 * 1024 * 1024, 0x41))
  const seen: { done: number; total: number; bytes: number; totalBytes: number }[] = []
  const made = await createArchive({
    dir: root,
    name: 'big',
    sources: [big],
    level: 1,
    onProgress: (p) => seen.push({ done: p.done, total: p.total, bytes: p.bytes, totalBytes: p.totalBytes })
  })
  assert.ok('path' in made, JSON.stringify(made))
  assert.equal(seen[0].bytes, 0)
  const last = seen[seen.length - 1]
  assert.equal(last.totalBytes, 9 * 1024 * 1024)
  assert.equal(last.bytes, last.totalBytes)
  assert.ok(
    seen.some((p) => p.bytes > 0 && p.bytes < p.totalBytes),
    'at least one intermediate byte progress event'
  )
  assert.equal(last.done, last.total)

  const dest = path.join(root, 'out')
  const extracted: number[] = []
  await extract({
    archive: (made as { path: string }).path,
    dest,
    onProgress: (p) => extracted.push(p.bytes)
  })
  assert.ok(extracted.some((n) => n > 0 && n < last.totalBytes), 'extraction also sees bytes')
  assert.equal(extracted[extracted.length - 1], last.totalBytes)
})

test('progress reports every file and totals', async () => {
  const root = await tmp()
  const src = await fixture(root)
  const seen: { done: number; total: number; bytes: number; totalBytes: number }[] = []
  const made = await createArchive({
    dir: root,
    name: 'progress',
    sources: [src],
    onProgress: (p) => seen.push(p)
  })
  assert.ok('path' in made)
  assert.ok(seen.length >= 3)
  const last = seen[seen.length - 1]
  assert.equal(last.done, last.total)
  assert.ok(last.totalBytes > 0)
  assert.ok(last.bytes > 0)

  const dest = path.join(root, 'out')
  const extracted: number[] = []
  await extract({
    archive: (made as { path: string }).path,
    dest,
    onProgress: (p) => extracted.push(p.done)
  })
  assert.ok(extracted.length >= 3, 'initial + per-file progress')
  assert.ok(extracted.every((n, i) => i === 0 || n >= extracted[i - 1]), 'done is monotonic')
  assert.equal(extracted[extracted.length - 1], Math.max(...extracted), 'ends at the total')
})
