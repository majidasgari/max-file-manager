/**
 * Run history and the two-way baseline, in the same SQLite file as the settings but in their own
 * tables: `clearIndex` deletes only files/fts/dirs/meta, so «clear the search index» never wipes a
 * sync history or the anchor that makes a two-way merge safe.
 *
 * The plan of every run is stored as JSON. That is what makes a manual reverse run possible without
 * a second copy of the tree: the exact actions are recorded, and a deletion is reported as
 * unrestorable instead of being guessed.
 */
import path from 'node:path'
import { app } from 'electron'
import type { SyncCompareBy, SyncMode, SyncPlan, SyncRunState, SyncRunSummary } from '../shared/sync.ts'
import type { Baseline } from './sync-core.ts'
import { openDb } from './searchdb.ts'

const dbFile = (): string => path.join(app.getPath('userData'), 'search.db')

type Db = ReturnType<typeof openDb>

function db(): Db {
  const d = openDb(dbFile())
  d.exec(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      left TEXT NOT NULL,
      right TEXT NOT NULL,
      mode TEXT NOT NULL,
      compare_by TEXT NOT NULL,
      state TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      copied INTEGER NOT NULL DEFAULT 0,
      removed INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      conflicts INTEGER NOT NULL DEFAULT 0,
      errors TEXT NOT NULL DEFAULT '[]',
      plan TEXT NOT NULL DEFAULT '{"copy":[],"remove":[]}'
    );
    CREATE INDEX IF NOT EXISTS sync_runs_started ON sync_runs(started_at DESC);
    CREATE TABLE IF NOT EXISTS sync_baseline (
      pair TEXT NOT NULL,
      rel TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime REAL NOT NULL,
      dir INTEGER NOT NULL,
      hash TEXT,
      PRIMARY KEY (pair, rel)
    );
    -- a cloud server without a content hash has to be read to be hashed; this table remembers the
    -- answer keyed by the server's own ETag, so a run only downloads what actually changed
    CREATE TABLE IF NOT EXISTS cloud_hash (
      pair TEXT NOT NULL,
      rel TEXT NOT NULL,
      size INTEGER NOT NULL,
      etag TEXT NOT NULL,
      hash TEXT NOT NULL,
      PRIMARY KEY (pair, rel)
    );
  `)
  return d
}

type RunRow = {
  id: string
  job_id: string | null
  left: string
  right: string
  mode: string
  compare_by: string
  state: string
  started_at: number
  finished_at: number | null
  copied: number
  removed: number
  skipped: number
  bytes: number
  conflicts: number
  errors: string
  plan: string
}

const summaryOf = (row: RunRow): SyncRunSummary => ({
  id: row.id,
  jobId: row.job_id ?? undefined,
  left: row.left,
  right: row.right,
  mode: row.mode as SyncMode,
  compareBy: row.compare_by as SyncCompareBy,
  state: row.state as SyncRunState,
  startedAt: row.started_at,
  finishedAt: row.finished_at ?? undefined,
  copied: row.copied,
  removed: row.removed,
  skipped: row.skipped,
  bytes: row.bytes,
  conflicts: row.conflicts,
  errors: JSON.parse(row.errors || '[]') as string[]
})

export function saveRun(summary: SyncRunSummary, plan: SyncPlan): void {
  db()
    .prepare(
      `INSERT INTO sync_runs
       (id, job_id, left, right, mode, compare_by, state, started_at, finished_at,
        copied, removed, skipped, bytes, conflicts, errors, plan)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state, finished_at = excluded.finished_at,
         copied = excluded.copied, removed = excluded.removed, skipped = excluded.skipped,
         bytes = excluded.bytes, conflicts = excluded.conflicts,
         errors = excluded.errors, plan = excluded.plan`
    )
    .run(
      summary.id,
      summary.jobId ?? null,
      summary.left,
      summary.right,
      summary.mode,
      summary.compareBy,
      summary.state,
      summary.startedAt,
      summary.finishedAt ?? null,
      summary.copied,
      summary.removed,
      summary.skipped,
      summary.bytes,
      summary.conflicts,
      JSON.stringify(summary.errors),
      JSON.stringify({ mode: plan.mode, copy: plan.copy, remove: plan.remove, conflicts: [], skipped: plan.skipped })
    )
}

export function listRuns(limit = 100): SyncRunSummary[] {
  const rows = db()
    .prepare('SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(500, Math.round(limit)))) as RunRow[]
  return rows.map(summaryOf)
}

export function getRun(id: string): { summary: SyncRunSummary; plan: SyncPlan | null } | null {
  const row = db().prepare('SELECT * FROM sync_runs WHERE id = ?').get(id) as RunRow | undefined
  if (!row) return null
  let plan: SyncPlan | null = null
  try {
    plan = JSON.parse(row.plan) as SyncPlan
  } catch {
    plan = null
  }
  return { summary: summaryOf(row), plan }
}

/** Keep the newest N runs; a long history is not worth an unbounded database. */
export function pruneRuns(keep = 200): void {
  db()
    .prepare(
      'DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY started_at DESC LIMIT ?)'
    )
    .run(Math.max(1, Math.round(keep)))
}

export function loadBaseline(pair: string): Baseline {
  const rows = db().prepare('SELECT rel, size, mtime, dir, hash FROM sync_baseline WHERE pair = ?').all(pair) as {
    rel: string
    size: number
    mtime: number
    dir: number
    hash: string | null
  }[]
  const out: Baseline = {}
  for (const row of rows) {
    out[row.rel] = {
      size: Number(row.size) || 0,
      mtime: Number(row.mtime) || 0,
      dir: Number(row.dir) === 1,
      ...(row.hash ? { hash: row.hash } : {})
    }
  }
  return out
}

export function saveBaseline(pair: string, baseline: Baseline): void {
  const d = db()
  d.exec('BEGIN')
  try {
    d.prepare('DELETE FROM sync_baseline WHERE pair = ?').run(pair)
    const insert = d.prepare(
      'INSERT INTO sync_baseline (pair, rel, size, mtime, dir, hash) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const [rel, row] of Object.entries(baseline)) {
      insert.run(pair, rel, Math.round(row.size), row.mtime, row.dir ? 1 : 0, row.hash ?? null)
    }
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
}

export function clearBaseline(pair: string): void {
  db().prepare('DELETE FROM sync_baseline WHERE pair = ?').run(pair)
}

/** One remembered remote hash: valid only while the server's ETag and size are unchanged. */
export type CloudHashRow = { size: number; etag: string; hash: string }

export function loadCloudHashes(pair: string): Map<string, CloudHashRow> {
  const rows = db()
    .prepare('SELECT rel, size, etag, hash FROM cloud_hash WHERE pair = ?')
    .all(pair) as { rel: string; size: number; etag: string; hash: string }[]
  return new Map(
    rows.map((r) => [r.rel, { size: Number(r.size) || 0, etag: r.etag, hash: r.hash }])
  )
}

export function saveCloudHashes(pair: string, cache: Map<string, CloudHashRow>): void {
  const d = db()
  d.exec('BEGIN')
  try {
    d.prepare('DELETE FROM cloud_hash WHERE pair = ?').run(pair)
    const insert = d.prepare('INSERT INTO cloud_hash (pair, rel, size, etag, hash) VALUES (?, ?, ?, ?, ?)')
    for (const [rel, row] of cache) insert.run(pair, rel, Math.round(row.size), row.etag, row.hash)
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
}

export function clearCloudHashes(pair: string): void {
  db().prepare('DELETE FROM cloud_hash WHERE pair = ?').run(pair)
}
