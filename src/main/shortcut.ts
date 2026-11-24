import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createSymlink } from './ops.ts'

/**
 * «Create shortcut», two platforms, two native answers:
 * Windows gets a real `.lnk` (a symlink there needs Developer Mode), every other system gets the
 * symbolic link its own file managers make. Neither ever overwrites.
 */
export type ShortcutWhere = 'here' | 'desktop'

export type ShortcutResult = { done: number; created: string[]; errors: string[] }

export type ShortcutDeps = {
  platform?: NodeJS.Platform
  /** `app.getPath('desktop')` — Electron already resolves the XDG/OneDrive redirection */
  desktopDir: string
  /** Windows only: `shell.writeShortcutLink(link, 'create', { target, cwd })` */
  writeLink?: (link: string, target: string) => Promise<boolean>
}

/**
 * Explorer appends « - Shortcut» and keeps the `.lnk` extension, so the visible name stays exact.
 * A Unix link keeps the original name at the end («Link to report.pdf»): the listing derives the
 * file type from the extension, and a trailing « - Shortcut» would make every link a mystery icon.
 */
export function shortcutName(target: string, platform: NodeJS.Platform = process.platform): string {
  const name = path.basename(target)
  return platform === 'win32' ? `${name} - Shortcut.lnk` : `Link to ${name}`
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
    try {
      if (typeof t !== 'string' || !path.isAbsolute(t)) throw new Error('absolute path required')
      const target = path.resolve(t)
      if (!(await fs.lstat(target).catch(() => null))) throw new Error('target does not exist')
      const dir = fixedDir ?? path.dirname(target)
      const link = await freeLinkName(dir, shortcutName(target, platform))
      if (platform === 'win32') {
        if (!deps.writeLink) throw new Error('no shortcut writer on this platform')
        if (!(await deps.writeLink(link, target))) throw new Error('Windows refused to write the shortcut')
      } else {
        const r = await createSymlink(target, link, platform)
        if (!r.ok) throw new Error(r.error)
      }
      out.created.push(link)
      out.done++
    } catch (e: any) {
      out.errors.push(`${path.basename(t)}: ${e?.message ?? String(e)}`)
    }
  }
  return out
}
