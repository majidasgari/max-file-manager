import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isProgramName } from '../shared/program.ts'
import { createSymlink } from './ops.ts'

/**
 * «Create shortcut», two platforms, two native answers:
 * Windows gets a real `.lnk` (a symlink there needs Developer Mode), every other system gets the
 * symbolic link its own file managers make. Neither ever overwrites.
 */
export type ShortcutWhere = 'here' | 'desktop'

export type ShortcutResult = { done: number; created: string[]; errors: string[] }

/** Exactly what `shell.writeShortcutLink` takes, declared here so this module stays electron-free. */
export type LinkDetails = {
  target: string
  cwd: string
  args: string
  icon?: string
  iconIndex?: number
}

export type ShortcutDeps = {
  platform?: NodeJS.Platform
  /** `app.getPath('desktop')` — Electron already resolves the XDG/OneDrive redirection */
  desktopDir: string
  /** Windows only: `shell.writeShortcutLink(link, 'create', details)` */
  writeLink?: (link: string, details: LinkDetails) => Promise<boolean>
}

/**
 * Explorer appends « - Shortcut» and keeps a document's extension, but drops a program's: Windows
 * shows `.exe` anyway, so a shortcut to notepad is «notepad - Shortcut», not «notepad.exe -…».
 * A Unix link keeps the original name at the end («Link to report.pdf»): the listing derives the
 * file type from the extension, and a trailing « - Shortcut» would make every link a mystery icon.
 */
export function shortcutName(target: string, platform: NodeJS.Platform = process.platform): string {
  // the platform names the target's syntax, not the host's: a `C:\…` path must split on `\` even
  // when this runs (or is tested) on Linux
  const p = platform === 'win32' ? path.win32 : path
  const name = p.basename(target)
  if (platform !== 'win32') return `Link to ${name}`
  const ext = p.extname(name)
  return `${isProgramName(name) ? name.slice(0, name.length - ext.length) : name} - Shortcut.lnk`
}

/** `name (2)`, `name (3)` … — `lstat`, so a broken link still counts as taken. */
export async function freeLinkName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    const cand = path.join(dir, i === 1 ? name : `${base} (${i})${ext}`)
    if (!(await fs.lstat(cand).then(() => true, () => false))) return cand
  }
}

/**
 * What Explorer fills in by hand: the program is the target, its own folder is «Start in» — a program
 * that loads a DLL or a data file beside itself only runs from there — and the icon comes from the
 * program itself instead of the shortcut's generic `.lnk` document icon. A document keeps the empty
 * icon so Windows shows its own file-type icon, exactly like Explorer does.
 */
export function linkDetails(target: string): LinkDetails {
  const details: LinkDetails = { target, cwd: path.dirname(target), args: '' }
  if (isProgramName(path.basename(target))) {
    details.icon = target
    details.iconIndex = 0
  }
  return details
}

export async function createShortcuts(
  targets: string[],
  where: ShortcutWhere,
  deps: ShortcutDeps
): Promise<ShortcutResult> {
  const platform = deps.platform ?? process.platform
  const out: ShortcutResult = { done: 0, created: [], errors: [] }
  if (!targets.length) return { ...out, errors: ['no target given'] }

  const fixedDir = where === 'desktop' ? deps.desktopDir : null
  if (fixedDir) {
    const st = await fs.stat(fixedDir).catch(() => null)
    if (!st?.isDirectory()) return { ...out, errors: [`desktop folder not found: ${fixedDir}`] }
  }

  for (const t of targets) {
    const label = typeof t === 'string' ? path.basename(t) : String(t)
    try {
      if (typeof t !== 'string' || !path.isAbsolute(t)) throw new Error('absolute path required')
      const target = path.resolve(t)
      if (!(await fs.lstat(target).catch(() => null))) throw new Error('target does not exist')
      const dir = fixedDir ?? path.dirname(target)
      const link = await freeLinkName(dir, shortcutName(target, platform))
      if (platform === 'win32') {
        if (!deps.writeLink) throw new Error('no shortcut writer on this platform')
        if (!(await deps.writeLink(link, linkDetails(target)))) {
          // Program Files is exactly where programs live, and it stays read-only for them too
          throw new Error(
            'Windows refused the shortcut — a read-only folder cannot hold one, send it to the desktop'
          )
        }
      } else {
        const r = await createSymlink(target, link, platform)
        if (!r.ok) throw new Error(r.error)
      }
      out.created.push(link)
      out.done++
    } catch (e: any) {
      out.errors.push(`${label}: ${e?.message ?? String(e)}`)
    }
  }
  return out
}
