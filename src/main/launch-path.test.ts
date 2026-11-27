import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { openTarget, shellNamespaceTarget, targetPath } from './launch-path.ts'

// every path below is absolute on the running system, so the same file is green on Linux and Windows
const APP = path.resolve('max-file-manager-app')
const abs = (p: string): string => path.resolve(p)

test('the app directory passed by the launcher is not the target', () => {
  const downloads = abs('/home/max/Downloads')
  assert.equal(targetPath(['electron', APP], APP), null)
  assert.equal(targetPath(['electron', APP, downloads], APP), downloads)
})

test('a packaged launch takes the first real argument', () => {
  assert.equal(targetPath(['mfm', abs('/home/max/Documents')], APP), abs('/home/max/Documents'))
  assert.equal(targetPath(['mfm'], APP), null)
})

test('file:// URIs from %U are decoded', () => {
  const folder = abs('/home/max/My Folder')
  assert.equal(targetPath(['electron', APP, pathToFileURL(folder).href], APP), folder)
})

test('flags are ignored and the app’s own folder can still be opened explicitly', () => {
  assert.equal(targetPath(['electron', '--inspect', APP, APP], APP), APP)
})

// ── shell-namespace targets (Windows) ────────────────────────────────────────────────────────
// Opening the Control Panel while this app owns the folder verb launched the app with
// «::{26EE0668-…}» as its only argument; that target belongs to Explorer, not to a pane.

const CONTROL_PANEL = '::{26EE0668-A00A-44D7-9371-BEB064C98683}'

test('a shell-namespace target is recognised as itself, not as a path', () => {
  assert.equal(shellNamespaceTarget(CONTROL_PANEL), CONTROL_PANEL)
  // a child of a shell folder, and the «shell:» spelling Windows writes for a link
  assert.equal(
    shellNamespaceTarget('::{20D04FE0-3AEA-1069-A2D8-08002B30309D}\\0'),
    '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}\\0'
  )
  assert.equal(
    shellNamespaceTarget('shell:::{20D04FE0-3AEA-1069-A2D8-08002B30309D}'),
    'shell:::{20D04FE0-3AEA-1069-A2D8-08002B30309D}'
  )
  // a packaged app's folder is the other shape the shell hands over
  const apps = 'shell:AppsFolder\\Microsoft.Windows.ControlPanel_cw5n1h2txyewy!App'
  assert.equal(shellNamespaceTarget(apps), apps)
  // a quoted %1 still matches
  assert.equal(shellNamespaceTarget(`"${CONTROL_PANEL}"`), CONTROL_PANEL)
})

test('a real path is never mistaken for a shell target', () => {
  assert.equal(shellNamespaceTarget('C:\\Windows\\System32'), null)
  assert.equal(shellNamespaceTarget(abs('/home/max/shell:notes')), null)
  assert.equal(shellNamespaceTarget(pathToFileURL(abs('/home/max/Documents')).href), null)
  assert.equal(shellNamespaceTarget(''), null)
})

test('openTarget keeps the two kinds apart', () => {
  assert.deepEqual(openTarget(['mfm', CONTROL_PANEL], APP), { kind: 'shell', value: CONTROL_PANEL })
  const folder = abs('/home/max/Documents')
  assert.deepEqual(openTarget(['mfm', folder], APP), { kind: 'path', value: folder })
  // the shell target wins even when a folder argument follows it
  assert.deepEqual(openTarget(['mfm', CONTROL_PANEL, folder], APP), {
    kind: 'shell',
    value: CONTROL_PANEL
  })
  // the launcher's own directory is still skipped before the real target
  assert.deepEqual(openTarget(['electron', APP, CONTROL_PANEL], APP), {
    kind: 'shell',
    value: CONTROL_PANEL
  })
  assert.equal(openTarget(['mfm'], APP), null)
})
