/**
 * Accelerators are stored as text ("F5", "Ctrl+Shift+F", "Space") so they can live in prefs
 * and be edited by the user. Everything here is pure and unit tested.
 */
export type Accel = { ctrl: boolean; shift: boolean; alt: boolean; key: string }

const NAMED: Record<string, string> = {
  space: 'Space',
  escape: 'Escape',
  esc: 'Escape',
  delete: 'Delete',
  del: 'Delete',
  backspace: 'Backspace',
  enter: 'Enter',
  tab: 'Tab',
  home: 'Home',
  end: 'End',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight'
}

export function parseAccel(accel: string): Accel {
  const parts = accel.split('+').map((p) => p.trim())
  const acc: Accel = { ctrl: false, shift: false, alt: false, key: '' }
  for (const raw of parts) {
    const p = raw.toLowerCase()
    if (p === 'ctrl' || p === 'cmd' || p === 'meta') acc.ctrl = true
    else if (p === 'shift') acc.shift = true
    else if (p === 'alt') acc.alt = true
    else if (p) acc.key = raw.length === 1 ? raw.toUpperCase() : (NAMED[p] ?? raw)
  }
  return acc
}

/**
 * The letter or digit the *key position* carries, whatever the active layout prints on it.
 *
 * A Persian, Arabic or Greek layout reports «ز» for the physical C key; desktop shortcuts are about
 * the position (that is how Explorer keeps Ctrl+C working with a Persian layout), so accelerators
 * read the code and fall back to the printed character only for keys the code does not name.
 */
export function physicalKey(code: string | undefined): string {
  if (!code) return ''
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]
  return ''
}

const keyOf = (ev: KeyboardEvent): string => {
  if (ev.key === ' ') return 'Space'
  if (ev.key.length === 1) {
    // non-Latin (Persian «ز» for C, Persian digit «۱» for 1): the accelerator is the position
    if (ev.key.charCodeAt(0) > 0x7f) {
      const physical = physicalKey(ev.code)
      if (physical) return physical
    }
    return ev.key.toUpperCase()
  }
  return NAMED[ev.key.toLowerCase()] ?? ev.key
}

/**
 * One app modifier: Ctrl on Linux/Windows, Cmd on macOS — but never *both* at once.
 *
 * macOS system shortcuts are chorded with both (⌃⌘F is full screen, ⌃⌘Space is the emoji
 * panel). Treating Ctrl and Cmd as the same modifier made `Ctrl+F` (name filter) match ⌃⌘F and
 * swallow the system shortcut before AppKit saw it.
 */
export const appModifier = (ev: KeyboardEvent): boolean =>
  Boolean(ev.ctrlKey) !== Boolean(ev.metaKey)

export function matchAccel(accel: string, ev: KeyboardEvent): boolean {
  if (!accel) return false
  const a = parseAccel(accel)
  if (!a.key) return false
  if (a.ctrl !== appModifier(ev)) return false
  if (a.shift !== Boolean(ev.shiftKey)) return false
  if (a.alt !== Boolean(ev.altKey)) return false
  return keyOf(ev) === a.key
}

/** The capture UI uses this: a keydown becomes the accelerator string to store. */
export function accelFromEvent(ev: KeyboardEvent): string | null {
  const k = keyOf(ev)
  if (!k || ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'Dead'].includes(k)) return null
  const bits: string[] = []
  if (ev.ctrlKey || ev.metaKey) bits.push('Ctrl')
  if (ev.altKey) bits.push('Alt')
  if (ev.shiftKey) bits.push('Shift')
  bits.push(k)
  return bits.join('+')
}

/** Display form for the UI: Persian-friendly separators, Latin keys. */
export function formatAccel(accel: string): string {
  const a = parseAccel(accel)
  const bits: string[] = []
  if (a.ctrl) bits.push('Ctrl')
  if (a.alt) bits.push('Alt')
  if (a.shift) bits.push('Shift')
  if (a.key) bits.push(a.key === 'Space' ? 'Space' : a.key)
  return bits.join(' + ')
}

/** Ids whose accelerator is used more than once. */
export function findConflicts(map: Record<string, string>): string[] {
  const seen = new Map<string, string[]>()
  for (const [id, accel] of Object.entries(map)) {
    if (!accel) continue
    const norm = parseAccel(accel)
    const k = `${norm.ctrl}|${norm.alt}|${norm.shift}|${norm.key}`
    seen.set(k, [...(seen.get(k) ?? []), id])
  }
  const out: string[] = []
  for (const ids of seen.values()) if (ids.length > 1) out.push(...ids)
  return out
}

/**
 * Shortcuts every desktop expects, which are not user commands: ⌘Q quits on macOS, ⌘↑ goes to the
 * enclosing folder, Explorer/Dolphin use Alt+↑ for the same and Delete for the trash. Kept pure so
 * one table decides for all three platforms (and the test can walk it).
 */
export type SystemAction =
  | 'close-window'
  | 'quit'
  | 'fullscreen'
  | 'up'
  | 'trash'
  | 'back'
  | 'forward'
  | 'properties'
  | 'open'
  | 'new-folder'
  | 'rename'
  | 'address'
  | 'prev-tab'

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

/** Ctrl on Linux/Windows, Cmd on macOS — never both, and never with Alt in the same chord. */
export function systemShortcut(ev: KeyLike, platform: string): SystemAction | null {
  const mac = platform === 'darwin'
  const key = ev.key
  // a Persian/Greek layout prints a local letter on the physical key: the chord is positional
  const shown =
    key.length === 1 && key.charCodeAt(0) > 0x7f
      ? physicalKey((ev as { code?: string }).code) || key
      : key
  const k = shown.length === 1 ? shown.toLowerCase() : shown
  const mod = mac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey
  const plain = !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey

  if (key === 'F11' && plain) return 'fullscreen'
  // Delete is the trash key on every desktop; Shift+Delete stays a user command (permanent)
  if (key === 'Delete' && plain) return 'trash'
  // parent folder: Alt+Up on Windows/Linux, Cmd+Up on macOS
  if (!mac && ev.altKey && !ev.ctrlKey && !ev.metaKey && key === 'ArrowUp') return 'up'
  // previous tab: Ctrl+Shift+Tab (Cmd+Shift+Tab on macOS)
  if (ev.shiftKey && ev.altKey === false && key === 'Tab' && (mac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey)) {
    return 'prev-tab'
  }

  if (mod && !ev.altKey) {
    if (k === 'w') return 'close-window'
    if (k === 'q' && (mac || platform === 'linux')) return 'quit'
    if (ev.shiftKey && k === 'n') return 'new-folder'
    if (mac) {
      if (key === 'ArrowUp' && !ev.shiftKey) return 'up'
      if (key === 'ArrowDown' && !ev.shiftKey) return 'open'
      if (k === '[' ) return 'back'
      if (k === ']') return 'forward'
      if (k === 'i' && !ev.shiftKey) return 'properties'
      if (k === 'o' && !ev.shiftKey) return 'open'
      if ((key === 'Backspace' || key === 'Delete') && !ev.shiftKey) return 'trash'
      if (ev.shiftKey && k === 'g') return 'address'
      // macOS often takes F2 for a system action; this is the same command without a function key
      if (ev.shiftKey && k === 'r') return 'rename'
    }
  }
  return null
}
