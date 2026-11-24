import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createShortcuts, freeLinkName, linkDetails, shortcutName, type LinkDetails } from './shortcut.ts'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'mfm-shortcut-'))
const exists = (p: string) => fs.access(p).then(() => true, () => false)
/** Windows only makes symlinks with Developer Mode on; the Unix branch is tested where it exists. */
const noSymlinks = process.platform === 'win32' ? 'symlinks need Developer Mode on Windows' : false

test('shortcutName: Explorer style on Windows, «Link to …» elsewhere', () => {
  assert.equal(shortcutName('/home/max/report.pdf', 'linux'), 'Link to report.pdf')
  assert.equal(shortcutName('/home/max/report.pdf', 'darwin'), 'Link to report.pdf')
  assert.equal(shortcutName('/home/max/report.pdf', 'win32'), 'report.pdf - Shortcut.lnk')
})

test('shortcutName: a program loses the extension Windows shows anyway', () => {
  assert.equal(shortcutName('C:\\Tools\\notepad.exe', 'win32'), 'notepad - Shortcut.lnk')
  assert.equal(shortcutName('C:\\Tools\\regedit.COM', 'win32'), 'regedit - Shortcut.lnk')
  // a script or installer keeps its name: the .lnk itself says nothing about what it starts
  assert.equal(shortcutName('C:\\Tools\\setup.msi', 'win32'), 'setup.msi - Shortcut.lnk')
  assert.equal(shortcutName('C:\\Tools\\run.cmd', 'win32'), 'run.cmd - Shortcut.lnk')
  // the Unix branch keeps the whole name, program or not
  assert.equal(shortcutName('/opt/Game.AppImage', 'linux'), 'Link to Game.AppImage')
})

test('linkDetails: a program starts in its own folder and carries its own icon', () => {
  const exe = path.join('apps', 'tool.exe')
  assert.deepEqual(linkDetails(exe), { target: exe, cwd: 'apps', args: '', icon: exe, iconIndex: 0 })
  // a document keeps the empty icon: Windows shows its own file-type icon, exactly like Explorer
  const doc = path.join('docs', 'report.pdf')
  assert.deepEqual(linkDetails(doc), { target: doc, cwd: 'docs', args: '' })
})

test('freeLinkName: never reuses a name, and a broken link still counts as taken', async () => {
  const root = await tmp()
  assert.equal(await freeLinkName(root, 'Link to a.txt'), path.join(root, 'Link to a.txt'))
  await fs.writeFile(path.join(root, 'Link to a.txt'), 'x')
  assert.equal(await freeLinkName(root, 'Link to a.txt'), path.join(root, 'Link to a (2).txt'))
  // a dangling symlink counts exactly like a file; Windows has no symlink without Developer Mode
  if (noSymlinks) await fs.writeFile(path.join(root, 'Link to a (2).txt'), 'x')
  else await fs.symlink(path.join(root, 'gone'), path.join(root, 'Link to a (2).txt'))
  assert.equal(await freeLinkName(root, 'Link to a.txt'), path.join(root, 'Link to a (3).txt'))
})

test('createShortcuts: a real link next to the file, again inside the folder never overwrites', { skip: noSymlinks }, async () => {
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

test('createShortcuts: the desktop target lands in the given desktop folder', { skip: noSymlinks }, async () => {
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

test('createShortcuts: Windows writes a program .lnk with the details Explorer fills in', async () => {
  const root = await tmp()
  const file = path.join(root, 'tool.exe')
  await fs.writeFile(file, 'MZ')
  const calls: { link: string; details: LinkDetails }[] = []
  const r = await createShortcuts([file], 'here', {
    platform: 'win32',
    desktopDir: '',
    writeLink: async (link, details) => {
      calls.push({ link, details })
      await fs.writeFile(link, 'lnk')
      return true
    }
  })
  assert.equal(r.done, 1)
  assert.deepEqual(r.errors, [])
  assert.equal(path.basename(r.created[0]), 'tool - Shortcut.lnk')
  assert.deepEqual(calls, [{ link: r.created[0], details: linkDetails(file) }])
  // the program is the target, its own folder is «Start in», its own exe is the icon
  assert.equal(calls[0].details.target, file)
  assert.equal(calls[0].details.cwd, root)
  assert.equal(calls[0].details.icon, file)
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
  // a program usually lives in Program Files, so the refusal has to point at the desktop
  assert.match(refused.errors[0], /desktop/)

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
