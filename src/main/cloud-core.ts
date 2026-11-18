/**
 * Pure cloud logic: scheduling, remote path arithmetic and the rows a run may not touch.
 * No fs, no electron — `node --test` imports this file directly.
 */
import type { SyncPlan, SyncRow } from '../shared/sync.ts'
import type { CloudBindingStatus, CloudCounts, CloudEntryState, CloudState } from '../shared/cloud.ts'

/** 30 s, 1 min, 2 min … capped. A failing server is never hammered. */
export function nextBackoff(failures: number, baseMs: number, maxMs = 30 * 60_000): number {
  const f = Math.max(0, Math.min(10, Math.floor(failures)))
  return Math.min(maxMs, baseMs * 2 ** f)
}

/**
 * When the next check is due. `dirty` means a change was seen by the local watcher, so the run is
 * pulled forward by a short debounce instead of waiting for the interval.
 */
export function nextRunAt(
  binding: { intervalMs: number; enabled: boolean },
  status: Pick<CloudBindingStatus, 'lastRunAt' | 'dirty'>,
  now: number,
  failures = 0,
  runNow = false
): number | null {
  if (!binding.enabled) return null
  if (runNow) return now
  if (status.dirty) return Math.min(now + 2_000, (status.lastRunAt ?? 0) + binding.intervalMs)
  const interval = failures > 0 ? nextBackoff(failures, binding.intervalMs) : binding.intervalMs
  return (status.lastRunAt ?? now) + interval
}

/** The entry state a row shows, given the binding's live state. */
export function entryState(state: CloudState, dirty: boolean): CloudEntryState {
  if (state === 'conflict') return 'conflict'
  if (state === 'syncing' || state === 'checking') return 'syncing'
  if (state === 'paused') return 'paused'
  if (state === 'offline') return 'offline'
  if (state === 'error') return 'error'
  return dirty ? 'pending' : 'synced'
}

/**
 * Rows a background run must leave alone: a conflict, or a folder on one side and a file on the
 * other. The plan already excludes them, but the service also needs the list to badge the files.
 */
export function conflictPaths(rows: SyncRow[]): string[] {
  return rows.filter((r) => r.state === 'conflict' || r.state === 'typeDiff').map((r) => r.rel).sort()
}

export const ZERO_COUNTS: CloudCounts = {
  synced: 0,
  pending: 0,
  localOnly: 0,
  cloudOnly: 0,
  conflict: 0
}

/** The badge a comparison row earns, before the run is applied. */
export function rowEntryState(row: SyncRow): CloudEntryState {
  switch (row.state) {
    case 'same':
      return 'synced'
    case 'leftOnly':
      return 'localOnly'
    case 'rightOnly':
      return 'cloudOnly'
    case 'leftNewer':
    case 'rightNewer':
    case 'sizeDiff':
    case 'contentDiff':
      return 'pending'
    default:
      // `typeDiff` and `conflict` are the rows a human has to look at
      return 'conflict'
  }
}

/** conflict is the loudest, then «missing on one side», then «changed», then «fine». */
const RANK: Record<string, number> = {
  synced: 0,
  pending: 1,
  localOnly: 2,
  cloudOnly: 3,
  conflict: 4
}

const worse = (a: CloudEntryState | undefined, b: CloudEntryState): CloudEntryState =>
  a === undefined || RANK[b] > RANK[a] ? b : a

export type EntryStates = {
  /** relative path → state, for the rows that have a local file */
  files: Map<string, CloudEntryState>
  /** relative path → the worst state below that folder */
  dirs: Map<string, CloudEntryState>
  counts: CloudCounts
}

/**
 * The per-path state after a run: the comparison's own verdict, corrected by what the plan actually
 * did. A copied path is synced even though its row said `leftNewer`; a path whose copy failed keeps
 * its pending state so the badge does not lie; a locally deleted path disappears from the map.
 */
export function entryStates(rows: SyncRow[], applied?: SyncPlan, errors: string[] = []): EntryStates {
  const verdict = new Map<string, 'synced' | 'gone'>()
  if (applied) {
    for (const a of applied.copy) verdict.set(a.rel, 'synced')
    // a delete on the local side removes the row; one on the cloud side leaves the local copy
    for (const a of applied.remove) verdict.set(a.rel, a.from === 'left' ? 'gone' : 'synced')
  }
  const files = new Map<string, CloudEntryState>()
  const dirs = new Map<string, CloudEntryState>()
  const counts: CloudCounts = { ...ZERO_COUNTS }
  for (const row of rows) {
    // a failed action must not claim success, so the row keeps the comparison's own verdict
    const failed = errors.some((e) => e.startsWith(`${row.rel}: `))
    const fixed = failed ? undefined : verdict.get(row.rel)
    if (fixed === 'gone') continue
    const state: CloudEntryState = fixed === 'synced' ? 'synced' : rowEntryState(row)
    files.set(row.rel, state)
    counts[state as keyof CloudCounts]++
    // every ancestor folder carries the worst state below it, so a folder can say
    // «there is something in here that only exists on the other side»
    let rel = row.rel
    for (;;) {
      const cut = rel.lastIndexOf('/')
      if (cut < 0) {
        // '' is the binding root itself: its badge summarises the whole tree
        dirs.set('', worse(dirs.get(''), state))
        break
      }
      rel = rel.slice(0, cut)
      dirs.set(rel, worse(dirs.get(rel), state))
    }
  }
  return { files, dirs, counts }
}

const REMOTE_SEGMENT_BAD = /[\\\u0000]/

/** Join a DAV path (`/a/b`) with a child name. */
export function remoteJoin(parent: string, name: string): string {
  const base = parent === '/' || parent === '' ? '' : parent.replace(/\/+$/, '')
  const child = name.replace(/^\/+/, '')
  return `${base}/${child}`
}

export function remoteParent(p: string): string {
  const clean = p.replace(/\/+$/, '')
  if (!clean || clean === '/') return '/'
  const i = clean.lastIndexOf('/')
  return i <= 0 ? '/' : clean.slice(0, i)
}

export function remoteName(p: string): string {
  const clean = p.replace(/\/+$/, '')
  if (!clean || clean === '/') return '/'
  return clean.slice(clean.lastIndexOf('/') + 1)
}

/** A folder name the user typed in the create-folder box. */
export function cleanRemoteName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/\u0000/g, '').trim()
  if (!s || s.length > 120) return null
  if (s === '.' || s === '..' || REMOTE_SEGMENT_BAD.test(s)) return null
  // a slash would silently create a sub-tree instead of one folder
  if (s.includes('/')) return null
  return s
}

/** The remote path a binding lives at, as an absolute DAV path. */
export function remotePathOf(remoteId: string): string {
  return remoteId.startsWith('/') ? remoteId : `/${remoteId}`
}
