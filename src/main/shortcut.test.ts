import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createShortcuts, freeLinkName, shortcutName } from './shortcut.ts'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'mfm-shortcut-'))
const exists = (p: string) => fs.access(p).then(() => true, () => false)

test('shortcutName: Explorer style on Windows, «Link to …» elsewhere', () => {
  assert.equal(shortcutName('/home/max/report.pdf', 'linux'), 'Link to report.pdf')
  assert.equal(shortcutName('/home/max/report.pdf', 'darwin'), 'Link to report.pdf')
  assert.equal(shortcutName('/home/max/report.pdf', 'win32'), 'report.pdf - Shortcut.lnk')
})

test('freeLinkName: never reuses a name, and a broken link still counts as taken', async () => {
  const root = await tmp()
  assert.equal(await freeLinkName(root, 'Link to a.txt'), path.join(root, 'Link to a.txt'))
  await fs.writeFile(path.join(root, 'Link to a.txt'), 'x')
  assert.equal(await freeLinkName(root, 'Link to a.txt'), path.join(root, 'Link to a (2).txt'))
  await fs.symlink(path.join(root, 'gone'), path.join(root, 'Link to a (2).txt'))
  assert.equal(await freeLinkName(root, 'Link to a.txt'), path.join(root, 'Link to a (3).txt'))
})

test('createShortcuts: a real link next to the file, again inside the folder never overwrites', async () => {
  const root = await tmp()
  const file = path.join(root, 'notes.txt')
  await fs.writeFile(file, 'hello')

  const first = await createShortcuts([file], 'here', { platform: 'linux', desktopDir: '' })
  assert.equal(first.done, 1)
  assert.deepEqual(first.errors, [])
  assert.equal(await fs.readlink(first.created[0]), file)
  assert.equal(await fs.readFile(first.created[0], 'utf8'), 'hello')

  const second = await createShortcuts([file], 'here', { platform: 'linux', desktopDir: '' })
  assert.equal(second.done, 1)
  assert.notEqual(second.created[0], first.created[0])
  assert.match(second.created[0], /\(2\)/)
})

test('createShortcuts: the desktop target lands in the given desktop folder', async () => {
  const root = await tmp()
  const desk = path.join(root, 'Desktop')
  await fs.mkdir(desk)
  const dir = path.join(root, 'work')
  await fs.mkdir(dir)
  const file = path.join(dir, 'a.txt')
  await fs.writeFile(file, 'x')

  const r = await createShortcuts([file], 'desktop', { platform: 'linux', desktopDir: desk })
  assert.equal(r.done, 1)
  assert.equal(path.dirname(r.created[0]), desk)
  assert.equal(await fs.readlink(r.created[0]), file)
})

test('createShortcuts: a missing desktop folder is reported, nothing is written', async () => {
  const root = await tmp()
  const file = path.join(root, 'a.txt')
  await fs.writeFile(file, 'x')
  const r = await createShortcuts([file], 'desktop', {
    platform: 'linux',
    desktopDir: path.join(root, 'nope')
  })
  assert.equal(r.done, 0)
  assert.match(r.errors[0], /desktop folder not found/)
})

test('createShortcuts: Windows writes a .lnk through the injected writer', async () => {
  const root = await tmp()
  const file = path.join(root, 'tool.exe')
  await fs.writeFile(file, 'MZ')
  const calls: { link: string; target: string }[] = []
  const r = await createShortcuts([file], 'here', {
    platform: 'win32',
    desktopDir: '',
    writeLink: async (link, target) => {
      calls.push({ link, target })
      await fs.writeFile(link, 'lnk')
      return true
    }
  })
  assert.equal(r.done, 1)
  assert.equal(path.basename(r.created[0]), 'tool.exe - Shortcut.lnk')
  assert.deepEqual(calls, [{ link: r.created[0], target: file }])
})

test('createShortcuts: a refused writer or a missing target is an error, not a crash', async () => {
  const root = await tmp()
  const file = path.join(root, 'a.txt')
  await fs.writeFile(file, 'x')
  const refused = await createShortcuts([file], 'here', {
    platform: 'win32',
    desktopDir: '',
    writeLink: async () => false
  })
  assert.equal(refused.done, 0)
  assert.match(refused.errors[0], /refused/)

  const missing = await createShortcuts([path.join(root, 'nope')], 'here', {
    platform: 'linux',
    desktopDir: ''
  })
  assert.equal(missing.done, 0)
  assert.match(missing.errors[0], /does not exist/)

  const relative = await createShortcuts(['a.txt'], 'here', { platform: 'linux', desktopDir: '' })
  assert.equal(relative.done, 0)
  assert.match(relative.errors[0], /absolute/)
  assert.equal(await exists(path.join(root, 'Link to a.txt')), false, 'the successful case left no link')
})
