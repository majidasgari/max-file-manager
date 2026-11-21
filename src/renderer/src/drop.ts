/**
 * Where a drag lands and whether that landing is legal.
 *
 * Every drop target (a folder row in the listing, a node in the tree pane, a whole pane) answers
 * the same two questions, and both are pure: the destination folder, and whether dropping there
 * would put a folder inside itself. Keeping them here means the gesture can be reasoned about —
 * and tested — without a drag session.
 */
import { normalizePath } from './format.ts'

/** Local Windows/macOS paths fold case; POSIX paths and remote URIs do not. */
const fold = (p: string): string => {
  const s = normalizePath(String(p ?? '')).replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s
}

export const isSamePath = (a: string, b: string): boolean => fold(a) === fold(b)

/**
 * `child` is `parent` or somewhere below it. The separator check matters: `/a/bc` is not inside
 * `/a/b`, and a prefix test alone would refuse that drop.
 */
export const isInsidePath = (child: string, parent: string): boolean => {
  const c = fold(child)
  const p = fold(parent)
  if (!p) return false
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/')
}

/**
 * True when the drop must be ignored: the destination is one of the dragged paths, or a folder
 * dragged along with the rest contains it. Moving then would make the job fail after the queue
 * had already drawn progress for it.
 */
export const dropIsRefused = (paths: string[], dest: string): boolean =>
  paths.some((p) => isSamePath(p, dest) || isInsidePath(dest, p))

/** Dropping onto a folder row targets that folder; onto a file row it targets the open folder. */
export const dropDestFor = (entry: { path: string; dir: boolean }, cur: string): string =>
  entry.dir ? entry.path : cur
