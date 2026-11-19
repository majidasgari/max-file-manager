/**
 * Pure comparison/planning for a sync run. No fs, no Electron: everything here is a function of
 * the two trees, the optional baseline and the user's choices, so the matrix can be tested without
 * a network or a disk.
 *
 * Two modes share this code:
 * - one-way (`ltr`/`rtl`) uses a two-way comparison: newest wins, a size difference with an equal
 *   timestamp is ambiguous and is never copied silently.
 * - two-way (`both`) uses a three-way comparison against the baseline of the last successful run,
 *   which is the only way to tell «deleted on the left» from «new on the right».
 */
import type {
  BaselineRow,
  ConflictKind,
  SyncAction,
  SyncCompareBy,
  SyncIgnoreRule,
  SyncMode,
  SyncPlan,
  SyncRow,
  SyncSide,
  SyncState
} from '../shared/sync.ts'

export type { BaselineRow }
export type Baseline = Record<string, BaselineRow>

/** One row of the local tree as the drift check sees it: no hash, no network. */
export type LocalFile = { size: number; mtime: number; dir: boolean }

/** Files that belong to the app, not to the synced content. */
export const SYNC_SKIP_NAMES = new Set(['.mfm.json', '.mfm-versions', '.mfm-trash', '.mfm-restic'])

/** `mtime` differences below this are «the same moment» (FAT/SMB round to 2s). */
export const SAME_MTIME_MS = 2000

/** `*.log` / `node_modules` style patterns, matched against the base name and the relative path. */
export function ignored(rel: string, patterns: string[]): boolean {
  if (!patterns.length) return false
  const parts = rel.split(/[\\/]/)
  const base = parts[parts.length - 1] ?? rel
  return patterns.some((raw) => globHits(rel, parts, base, raw.trim()))
}

function globHits(rel: string, parts: string[], base: string, pattern: string): boolean {
  if (!pattern) return false
  const rx = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  )
  if (rx.test(base) || rx.test(rel)) return true
  // a bare folder name (`node_modules`) hides it at any depth, not only at the root
  return !pattern.includes('/') && parts.some((part) => rx.test(part))
}

/**
 * One rule of the Ignore tab. `size` rules only see files (a folder's recursive size is not known
 * during the walk), and a `path` rule hides the whole subtree below that exact relative path.
 */
export function matchesIgnore(
  rel: string,
  rule: SyncIgnoreRule,
  size?: number,
  dir?: boolean
): boolean {
  if (rule.kind === 'size') {
    if (dir === true || size === undefined) return false
    return rule.op === 'gt' ? size > rule.bytes : size < rule.bytes
  }
  const parts = rel.split(/[\\/]/)
  const base = parts[parts.length - 1] ?? rel
  if (rule.kind === 'path') return rel === rule.value || rel.startsWith(rule.value + '/')
  if (rule.kind === 'regex') {
    try {
      const rx = new RegExp(rule.value)
      return rx.test(base) || rx.test(rel)
    } catch {
      return false
    }
  }
  return globHits(rel, parts, base, rule.value)
}

export function ignoredBy(
  rel: string,
  rules: SyncIgnoreRule[] | undefined,
  size?: number,
  dir?: boolean
): boolean {
  if (!rules?.length) return false
  return rules.some((rule) => matchesIgnore(rel, rule, size, dir))
}

const sameMoment = (a: number, b: number): boolean => Math.abs(a - b) <= SAME_MTIME_MS

/**
 * Paths whose local state no longer matches the baseline. Pure and network-free: the caller walks
 * the disk once and this only reads the map. A baseline key that is missing from `files` is a local
 * deletion and is reported too, because the comparison must see it to decide what happened.
 */
export function localDrift(files: Map<string, LocalFile>, baseline: Baseline): string[] {
  const out: string[] = []
  for (const [rel, file] of files) {
    const base = baseline[rel]
    if (!base) {
      out.push(rel)
      continue
    }
    if (base.dir !== file.dir) {
      out.push(rel)
      continue
    }
    // a folder has no content of its own; only its type/identity matters here
    if (file.dir) continue
    if (base.size !== file.size || !sameMoment(base.mtime, file.mtime)) out.push(rel)
  }
  for (const rel of Object.keys(baseline)) if (!files.has(rel)) out.push(rel)
  return out.sort()
}

/** Size+type equality, the only test an adopted baseline is allowed to use (no timestamps). */
const sameBySize = (a: SyncSide, b: SyncSide): boolean => a.dir === b.dir && (a.dir || a.size === b.size)

export function sameSide(a: SyncSide, b: SyncSide, by: SyncCompareBy): boolean {
  if (a.dir !== b.dir) return false
  if (a.dir) return true
  if (by === 'hash' && a.hash && b.hash) return a.hash === b.hash
  return a.size === b.size && sameMoment(a.mtime, b.mtime)
}

/**
 * Newest wins, which is what makes a one-way sync safe: a file that differs in size but is older
 * must not overwrite the newer one. Only a size difference with the same timestamp is ambiguous.
 */
export function stateOf(l: SyncSide, r: SyncSide, by: SyncCompareBy): SyncState {
  if (l.dir !== r.dir) return 'typeDiff'
  if (l.dir) return 'same'
  if (by === 'hash' && l.hash && r.hash) return l.hash === r.hash ? 'same' : l.size === r.size ? 'contentDiff' : 'sizeDiff'
  const d = l.mtime - r.mtime
  if (Math.abs(d) > SAME_MTIME_MS) return d > 0 ? 'leftNewer' : 'rightNewer'
  return l.size === r.size ? 'same' : 'sizeDiff'
}

/** Compare one row that exists on both sides; used by the one-way path. */
export function rowOf(rel: string, left: SyncSide | undefined, right: SyncSide | undefined, by: SyncCompareBy): SyncRow {
  if (left && !right) return { rel, state: 'leftOnly', left }
  if (!left && right) return { rel, state: 'rightOnly', right }
  if (!left || !right) return { rel, state: 'same' }
  return { rel, state: stateOf(left, right, by), left, right }
}

const conflictOf = (l: SyncSide | undefined, r: SyncSide | undefined, kind: ConflictKind): SyncRow => ({
  rel: '',
  state: 'conflict',
  left: l,
  right: r,
  conflict: kind
})

/**
 * Three-way comparison. A row is a conflict when both sides moved away from the baseline (or the
 * same relative path appeared on both sides with different content), because no rule can decide
 * it without the user.
 */
export function threeWay(rows: SyncRow[], baseline: Baseline, by: SyncCompareBy): SyncRow[] {
  const out: SyncRow[] = []
  for (const row of rows) {
    const base = baseline[row.rel]
    if (!base) {
      if (row.left && row.right) {
        if (sameSide(row.left, row.right, by)) out.push({ ...row, state: 'same' })
        else if (row.left.dir !== row.right.dir)
          out.push({ ...row, state: 'conflict', conflict: 'typeDiff' })
        else out.push({ ...row, state: 'conflict', conflict: 'bothNew' })
      } else out.push(row)
      continue
    }
    const b: SyncSide = {
      size: base.size,
      mtime: base.mtime,
      dir: base.dir,
      hash: base.hash,
      ...(base.adopted === true ? { adopted: true } : {})
    }
    // An adopted anchor was written when the two sides were known to be the same file but their
    // timestamps were not comparable (Drive's `modifiedTime` is the upload time). Equality with
    // that anchor is size+type only; otherwise every later run would see a phantom edit.
    const eq = base.adopted === true ? sameBySize : (x: SyncSide, y: SyncSide) => sameSide(x, y, by)
    const left = row.left
    const right = row.right
    if (left && right) {
      const lEqB = eq(left, b)
      const rEqB = eq(right, b)
      const lEqR = eq(left, right)
      if (left.dir !== right.dir) out.push({ ...row, state: 'conflict', conflict: 'typeDiff', baseline: b })
      else if (lEqR) out.push({ ...row, state: 'same', baseline: b })
      else if (lEqB) out.push({ ...row, state: 'rightNewer', baseline: b })
      else if (rEqB) out.push({ ...row, state: 'leftNewer', baseline: b })
      else out.push({ ...row, state: 'conflict', conflict: 'bothChanged', baseline: b })
      continue
    }
    if (left && !right) {
      if (eq(left, b)) out.push({ ...row, state: 'leftOnly', baseline: b })
      else out.push({ ...row, state: 'conflict', conflict: 'editDelete', baseline: b })
      continue
    }
    if (!left && right) {
      if (eq(right, b)) out.push({ ...row, state: 'rightOnly', baseline: b })
      else out.push({ ...row, state: 'conflict', conflict: 'editDelete', baseline: b })
      continue
    }
    out.push(row)
  }
  return out
}

export type PlanOptions = {
  /** delete files that only exist on the destination side */
  deleteExtra?: boolean
  /** relative paths the user ticked; missing/undefined means every row */
  selected?: Set<string>
  /** per-row decisions for `both`; a conflict without one is reported, never applied */
  resolutions?: Record<string, 'left' | 'right' | 'skip'>
}

/**
 * Turn rows into the exact actions a run performs. Conflicts are never guessed: in `both` mode a
 * conflict without a resolution lands in `plan.conflicts` and the run refuses to start.
 */
export function planRows(rows: SyncRow[], mode: SyncMode, opts: PlanOptions = {}): SyncPlan {
  const copy: SyncAction[] = []
  const remove: SyncAction[] = []
  const conflicts: SyncRow[] = []
  const selected = opts.selected
  let skipped = 0

  for (const row of rows) {
    if (selected && !selected.has(row.rel)) {
      skipped++
      continue
    }
    if (row.state === 'same') {
      skipped++
      continue
    }
    if (mode === 'both') {
      if (row.state === 'conflict' || row.state === 'typeDiff') {
        // a folder on one side and a file on the other cannot be resolved by copying a file:
        // the user has to rename/remove one side in the file manager, then compare again
        if (row.conflict === 'typeDiff') {
          conflicts.push(row)
          continue
        }
        const decision = opts.resolutions?.[row.rel] ?? row.resolution
        if (!decision || decision === 'skip') {
          conflicts.push(row)
          continue
        }
        // the chosen side is the truth: copy it over, or delete the other side when it is gone
        if (decision === 'left') {
          if (row.left) copy.push({ rel: row.rel, kind: 'copy', from: 'left', to: 'right', state: row.state })
          else remove.push({ rel: row.rel, kind: 'delete', from: 'right', to: 'right', state: row.state })
        } else {
          if (row.right) copy.push({ rel: row.rel, kind: 'copy', from: 'right', to: 'left', state: row.state })
          else remove.push({ rel: row.rel, kind: 'delete', from: 'left', to: 'left', state: row.state })
        }
        continue
      }
      if (row.state === 'leftOnly') {
        // with a baseline this is «deleted on the right»; without one it is a new file on the left
        if (row.baseline) {
          if (opts.deleteExtra) remove.push({ rel: row.rel, kind: 'delete', from: 'left', to: 'left', state: row.state })
          else skipped++
        } else {
          copy.push({ rel: row.rel, kind: 'copy', from: 'left', to: 'right', state: row.state })
        }
        continue
      }
      if (row.state === 'rightOnly') {
        if (row.baseline) {
          if (opts.deleteExtra) remove.push({ rel: row.rel, kind: 'delete', from: 'right', to: 'right', state: row.state })
          else skipped++
        } else {
          copy.push({ rel: row.rel, kind: 'copy', from: 'right', to: 'left', state: row.state })
        }
        continue
      }
      if (row.state === 'leftNewer') {
        copy.push({ rel: row.rel, kind: 'copy', from: 'left', to: 'right', state: row.state })
        continue
      }
      if (row.state === 'rightNewer') {
        copy.push({ rel: row.rel, kind: 'copy', from: 'right', to: 'left', state: row.state })
        continue
      }
      if (row.state === 'sizeDiff' || row.state === 'contentDiff') {
        // with a baseline exactly one side moved, so the other is the older copy
        const leftMoved = row.baseline ? !sameSide(row.left!, row.baseline, row.left!.hash ? 'hash' : 'mtime') : false
        if (leftMoved) copy.push({ rel: row.rel, kind: 'copy', from: 'left', to: 'right', state: row.state })
        else copy.push({ rel: row.rel, kind: 'copy', from: 'right', to: 'left', state: row.state })
        continue
      }
      skipped++
      continue
    }

    // one-way: only the source is trusted; a type clash is skipped, not a blocker
    const ltr = mode === 'ltr'
    if (row.state === 'typeDiff' || row.state === 'conflict') {
      skipped++
      continue
    }
    if (ltr) {
      if (row.state === 'leftOnly' || row.state === 'leftNewer' || row.state === 'sizeDiff' || row.state === 'contentDiff') {
        copy.push({ rel: row.rel, kind: 'copy', from: 'left', to: 'right', state: row.state })
      } else if (row.state === 'rightOnly') {
        if (opts.deleteExtra) remove.push({ rel: row.rel, kind: 'delete', from: 'right', to: 'right', state: row.state })
        else skipped++
      } else skipped++
      continue
    }
    if (row.state === 'rightOnly' || row.state === 'rightNewer' || row.state === 'sizeDiff' || row.state === 'contentDiff') {
      copy.push({ rel: row.rel, kind: 'copy', from: 'right', to: 'left', state: row.state })
    } else if (row.state === 'leftOnly') {
      if (opts.deleteExtra) remove.push({ rel: row.rel, kind: 'delete', from: 'left', to: 'left', state: row.state })
      else skipped++
    } else skipped++
  }
  return { mode, copy, remove, conflicts, skipped }
}

/**
 * A plan that can be undone without a version store: copies can be reversed while the source still
 * exists; deletions cannot, and are reported instead of pretending.
 */
export function invertPlan(plan: SyncPlan): { copy: SyncAction[]; unrestorable: string[] } {
  const copy: SyncAction[] = []
  const unrestorable: string[] = []
  for (const action of plan.copy) {
    copy.push({ ...action, from: action.to, to: action.from })
  }
  for (const action of plan.remove) unrestorable.push(action.rel)
  return { copy, unrestorable }
}

/**
 * The baseline after a successful two-way run. Only rows this run actually reconciled get a new
 * anchor; an unresolved conflict or a row the user left untouched keeps the old one, so the next
 * run sees the same difference instead of silently forgetting it. Deletions leave the baseline.
 */
export function nextBaseline(rows: SyncRow[], previous: Baseline, plan: SyncPlan): Baseline {
  const out: Baseline = { ...previous }
  const copyFrom = new Map(plan.copy.map((a) => [a.rel, a.from]))
  const removed = new Set(plan.remove.map((a) => a.rel))
  for (const row of rows) {
    if (removed.has(row.rel)) {
      delete out[row.rel]
      continue
    }
    const from = copyFrom.get(row.rel)
    if (from) {
      const side = from === 'left' ? row.left : row.right
      if (side) out[row.rel] = { size: side.size, mtime: side.mtime, dir: side.dir, hash: side.hash }
      continue
    }
    if (row.state === 'same' && row.left) {
      const prev = previous[row.rel]
      const keepAdopted = prev?.adopted === true && prev.size === row.left.size
      out[row.rel] = {
        size: row.left.size,
        mtime: row.left.mtime,
        dir: row.left.dir,
        hash: row.left.hash,
        ...(keepAdopted ? { adopted: true } : {})
      }
    }
  }
  // a path that disappeared from both sides leaves the baseline too
  const present = new Set(rows.map((r) => r.rel))
  for (const rel of Object.keys(out)) if (!present.has(rel)) delete out[rel]
  return out
}

/**
 * The baseline after an incremental (subset) run. `rows` is only the dirty subset, so the «delete
 * every path that is not in rows» step of `nextBaseline` must not run here: it would destroy the
 * anchor of every path this run did not even look at. Only keys present in `rows` are updated or
 * removed; everything else stays exactly as it was.
 */
export function nextBaselineSubset(rows: SyncRow[], previous: Baseline, plan: SyncPlan): Baseline {
  const out: Baseline = { ...previous }
  const copyFrom = new Map(plan.copy.map((a) => [a.rel, a.from]))
  const removed = new Set(plan.remove.map((a) => a.rel))
  for (const row of rows) {
    if (removed.has(row.rel)) {
      delete out[row.rel]
      continue
    }
    const from = copyFrom.get(row.rel)
    if (from) {
      const side = from === 'left' ? row.left : row.right
      if (side) out[row.rel] = { size: side.size, mtime: side.mtime, dir: side.dir, hash: side.hash }
      continue
    }
    if (row.state === 'same' && row.left) {
      const prev = previous[row.rel]
      const keepAdopted = prev?.adopted === true && prev.size === row.left.size
      out[row.rel] = {
        size: row.left.size,
        mtime: row.left.mtime,
        dir: row.left.dir,
        hash: row.left.hash,
        ...(keepAdopted ? { adopted: true } : {})
      }
    }
  }
  return out
}

export type SyncSummary = {
  same: number
  left: number
  right: number
  suspicious: number
  conflicts: number
  changed: number
}

export function summarize(rows: SyncRow[]): SyncSummary {
  const s: SyncSummary = { same: 0, left: 0, right: 0, suspicious: 0, conflicts: 0, changed: 0 }
  for (const row of rows) {
    if (row.state === 'same') s.same++
    else if (row.state === 'leftOnly' || row.state === 'leftNewer') s.left++
    else if (row.state === 'rightOnly' || row.state === 'rightNewer') s.right++
    else if (row.state === 'conflict') s.conflicts++
    else s.suspicious++
    if (row.state !== 'same') s.changed++
  }
  return s
}

/** Sort for display: differences first, then the path. */
export function sortRows(rows: SyncRow[]): SyncRow[] {
  return [...rows].sort((a, b) => {
    const rank = (r: SyncRow): number => (r.state === 'conflict' ? 0 : r.state === 'same' ? 2 : 1)
    return rank(a) - rank(b) || a.rel.localeCompare(b.rel)
  })
}

/**
 * Build a row from a baseline entry that no longer exists on either side. Used by the two-way
 * comparison so a deletion on both sides is not a phantom.
 */
export function baselineOf(row: SyncRow): SyncSide | undefined {
  return row.baseline
}

/** Exported for the tests that lock the conflict matrix. */
export const conflictRow = (rel: string, left: SyncSide | undefined, right: SyncSide | undefined, kind: ConflictKind): SyncRow => {
  const base = conflictOf(left, right, kind)
  return { ...base, rel }
}
