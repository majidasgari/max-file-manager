import assert from 'node:assert/strict'
import test from 'node:test'
import { accelFromEvent, findConflicts, formatAccel, matchAccel, parseAccel, systemShortcut } from './keys.ts'

const ev = (o: Partial<KeyboardEvent>) => o as KeyboardEvent

test('parseAccel reads modifiers and named keys', () => {
  assert.deepEqual(parseAccel('F5'), { ctrl: false, shift: false, alt: false, key: 'F5' })
  assert.deepEqual(parseAccel('Ctrl+Shift+F'), { ctrl: true, shift: true, alt: false, key: 'F' })
  assert.deepEqual(parseAccel('Shift+Delete'), { ctrl: false, shift: true, alt: false, key: 'Delete' })
  assert.equal(parseAccel('Space').key, 'Space')
})

test('matchAccel respects every modifier', () => {
  assert.equal(matchAccel('F5', ev({ key: 'F5' })), true)
  assert.equal(matchAccel('F5', ev({ key: 'F5', ctrlKey: true })), false)
  assert.equal(matchAccel('Ctrl+F5', ev({ key: 'F5', ctrlKey: true })), true)
  assert.equal(matchAccel('Ctrl+Shift+F', ev({ key: 'f', ctrlKey: true, shiftKey: true })), true)
  assert.equal(matchAccel('Ctrl+Shift+F', ev({ key: 'f', ctrlKey: true })), false)
  assert.equal(matchAccel('Space', ev({ key: ' ' })), true)
  assert.equal(matchAccel('', ev({ key: 'a' })), false)
})

test('Cmd is the app modifier on macOS, but a Ctrl+Cmd system chord is never ours', () => {
  // ⌘F must reach Ctrl+F (the app is written for Ctrl and aliases Cmd)
  assert.equal(matchAccel('Ctrl+F', ev({ key: 'f', metaKey: true })), true)
  assert.equal(matchAccel('Ctrl+F', ev({ key: 'f', ctrlKey: true, metaKey: true })), false)
  // ⌃⌘F is macOS full screen: the filter must not swallow it
  assert.equal(matchAccel('Ctrl+F', ev({ key: 'f', ctrlKey: true, metaKey: true, shiftKey: false })), false)
  // and a Cmd chord still never matches a plain accelerator
  assert.equal(matchAccel('Space', ev({ key: ' ', metaKey: true })), false)
})

test('accelFromEvent builds a storable string', () => {
  assert.equal(accelFromEvent(ev({ key: 'F7' })), 'F7')
  assert.equal(accelFromEvent(ev({ key: 'z', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Z')
  assert.equal(accelFromEvent(ev({ key: ' ' })), 'Space')
  assert.equal(accelFromEvent(ev({ key: 'Control', ctrlKey: true })), null, 'a bare modifier is not a shortcut')
})

test('formatAccel is stable and round-trips', () => {
  assert.equal(formatAccel('Ctrl+Shift+F'), 'Ctrl + Shift + F')
  assert.equal(formatAccel(accelFromEvent(ev({ key: 'F9' }))!), 'F9')
})

test('findConflicts reports every id sharing a key', () => {
  const bad = findConflicts({ copy: 'F5', move: 'F5', trash: 'F8' })
  assert.deepEqual(bad.sort(), ['copy', 'move'])
  assert.deepEqual(findConflicts({ copy: 'F5', move: 'F6' }), [])
  assert.deepEqual(findConflicts({ a: '', b: '' }), [])
})

test('each desktop gets its own window and quit chords', () => {
  const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods
  })
  assert.equal(systemShortcut(ev('w', { ctrlKey: true }), 'linux'), 'close-window')
  assert.equal(systemShortcut(ev('W', { ctrlKey: true }), 'win32'), 'close-window')
  assert.equal(systemShortcut(ev('w', { metaKey: true }), 'darwin'), 'close-window')
  assert.equal(systemShortcut(ev('q', { ctrlKey: true }), 'linux'), 'quit')
  assert.equal(systemShortcut(ev('q', { metaKey: true }), 'darwin'), 'quit')
  // Windows quits with Alt+F4 (the OS), not Ctrl+Q
  assert.equal(systemShortcut(ev('q', { ctrlKey: true }), 'win32'), null)
  // Ctrl+Q is not a quit on macOS
  assert.equal(systemShortcut(ev('q', { ctrlKey: true }), 'darwin'), null)
})

test('the navigation and trash keys follow the platform', () => {
  const ev = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods
  })
  assert.equal(systemShortcut(ev('ArrowUp', { altKey: true }), 'linux'), 'up')
  assert.equal(systemShortcut(ev('ArrowUp', { altKey: true }), 'win32'), 'up')
  assert.equal(systemShortcut(ev('ArrowUp', { metaKey: true }), 'darwin'), 'up')
  assert.equal(systemShortcut(ev('Delete'), 'linux'), 'trash')
  assert.equal(systemShortcut(ev('Backspace', { metaKey: true }), 'darwin'), 'trash')
  assert.equal(systemShortcut(ev('Delete', { shiftKey: true }), 'win32'), null, 'Shift+Delete is the command table')
  assert.equal(systemShortcut(ev('[', { metaKey: true }), 'darwin'), 'back')
  assert.equal(systemShortcut(ev(']', { metaKey: true }), 'darwin'), 'forward')
  assert.equal(systemShortcut(ev('i', { metaKey: true }), 'darwin'), 'properties')
  assert.equal(systemShortcut(ev('o', { metaKey: true }), 'darwin'), 'open')
  assert.equal(systemShortcut(ev('n', { ctrlKey: true, shiftKey: true }), 'win32'), 'new-folder')
  assert.equal(systemShortcut(ev('n', { metaKey: true, shiftKey: true }), 'darwin'), 'new-folder')
  assert.equal(systemShortcut(ev('Tab', { ctrlKey: true, shiftKey: true }), 'linux'), 'prev-tab')
  assert.equal(systemShortcut(ev('F11'), 'linux'), 'fullscreen')
  // a chord with both modifiers belongs to the system (⌃⌘F is macOS full screen)
  assert.equal(systemShortcut(ev('w', { ctrlKey: true, metaKey: true }), 'darwin'), null)
  assert.equal(systemShortcut(ev('g', { metaKey: true, shiftKey: true }), 'darwin'), 'address')
  assert.equal(systemShortcut(ev('r', { metaKey: true, shiftKey: true }), 'darwin'), 'rename')
  assert.equal(systemShortcut(ev('Enter'), 'darwin'), null, 'plain Enter belongs to the command handler')
})
