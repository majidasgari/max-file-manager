/**
 * The shape of a synchronisation job, shared by the renderer (prefs), the main process (scheduler)
 * and the MCP tool table. Keeping it in `shared` is what stops the three from drifting apart.
 *
 * A path is either an absolute local path or a remote URI (`sftp://…`, `s3://…`); `isRemotePath`
 * and `path.isAbsolute` in main decide which store owns it.
 */
import { isRemotePath } from './remote-path.ts'

export type SyncCompareBy = 'mtime' | 'hash'
export type SyncMode = 'ltr' | 'rtl' | 'both'

export type SyncState =
  | 'same'
  | 'leftOnly'
  | 'rightOnly'
  | 'leftNewer'
  | 'rightNewer'
  | 'sizeDiff'
  | 'contentDiff'
  | 'typeDiff'
  | 'conflict'

export type ConflictKind = 'bothChanged' | 'editDelete' | 'bothNew' | 'typeDiff'

/** One side of one row. `hash` is filled only when the comparison asked for it. */
export type SyncSide = { size: number; mtime: number; dir: boolean; hash?: string; adopted?: boolean }

/**
 * A row of the two-way baseline. `adopted` marks a one-time size-only match (Drive adoption), so a
 * later comparison ignores the timestamp for that path until its size changes.
 */
export type BaselineRow = SyncSide

export type SyncRow = {
  rel: string
  state: SyncState
  left?: SyncSide
  right?: SyncSide
  /** the last reconciled state of this path; only present in a two-way comparison */
  baseline?: SyncSide
  conflict?: ConflictKind
  /** a per-row decision the user made; only used for `both` (and for manual overrides) */
  resolution?: 'left' | 'right' | 'skip'
}

export type SyncAction = {
  rel: string
  kind: 'copy' | 'delete'
  from: 'left' | 'right'
  to: 'left' | 'right'
  state: SyncState
}

export type SyncPlan = {
  mode: SyncMode
  copy: SyncAction[]
  remove: SyncAction[]
  conflicts: SyncRow[]
  skipped: number
}

/** The rsync switches the UI exposes; every one is a separate argv entry, never a shell string. */
export type RsyncOptions = {
  /** compare by checksum instead of size+mtime */
  checksum?: boolean
  compress?: boolean
  /** KB/s ceiling */
  bwlimitKB?: number
  partial?: boolean
  inplace?: boolean
  sparse?: boolean
  hardLinks?: boolean
  /** preserve POSIX ACLs (`-A`) */
  acls?: boolean
  /** preserve extended attributes (`-X`) */
  xattrs?: boolean
}

/**
 * Per-side content encryption. The secret material is never here: `secretId` points at the OS
 * keyring store. `recipient` is the public age key (safe in prefs); the identity is the secret.
 */
export type SyncEncryption = {
  mode: 'passphrase' | 'keypair'
  secretId: string
  /** age1…; required for keypair mode when writing to this side */
  recipient?: string
}

/**
 * A sync ignore rule. Name rules hide a path from both walks (so «delete extra» can never remove an
 * ignored file); size rules only apply to files. `glob` is the legacy `*.log` / `node_modules`
 * form, `path` is an exact relative path including its subtree, `regex` is a JS regular expression
 * tested against the relative path and the base name.
 */
export type SyncIgnoreRule =
  | { kind: 'glob'; value: string }
  | { kind: 'regex'; value: string }
  | { kind: 'path'; value: string }
  | { kind: 'size'; op: 'gt' | 'lt'; bytes: number }

/** A restic snapshot as the Versions tab shows it. */
export type SyncSnapshot = {
  id: string
  shortId: string
  time: string
  tags: string[]
  paths: string[]
  bytes: number
  files: number
}

/** restic snapshot history for a local destination. The password is a secret id, not data. */
export type SyncVersions = {
  keep: number
  /** absolute local repository; empty means <destination>/.mfm-restic */
  repo?: string
  secretId: string
}

export type SyncSchedule = {
  /** run once, shortly after the app starts */
  onStart?: boolean
  /** minutes between runs; 0/undefined = no interval */
  everyMinutes?: number
  /** a five-field cron expression */
  cron?: string
  /** run when a removable drive is mounted */
  onMount?: boolean
  /** run when a watched folder changes (local endpoints only) */
  onChange?: boolean
}

export type SyncJob = {
  id: string
  name: string
  left: string
  right: string
  /** the direction a manual «Run» uses unless the user picks another one */
  direction: SyncMode
  compareBy: SyncCompareBy
  /** wildcard names or relative paths, e.g. `*.log`, `node_modules` */
  ignore: string[]
  /** richer user-authored rules; `ignore` stays for rsync and older jobs */
  ignoreRules?: SyncIgnoreRule[]
  /** delete files that exist only on the destination (one-way) or on one side (two-way) */
  deleteExtra: boolean
  enabled: boolean
  schedule: SyncSchedule
  /** local ↔ local only; remote endpoints stay on the native engine */
  useRsync?: boolean
  rsync?: RsyncOptions
  /** compress the transfer: rsync `-z`, or SSH zlib on an SFTP session */
  compress?: boolean
  encLeft?: SyncEncryption
  encRight?: SyncEncryption
  versions?: SyncVersions
}

export type SyncRunState = 'running' | 'done' | 'cancelled' | 'error'

export type SyncRunSummary = {
  id: string
  jobId?: string
  left: string
  right: string
  mode: SyncMode
  compareBy: SyncCompareBy
  state: SyncRunState
  startedAt: number
  finishedAt?: number
  copied: number
  removed: number
  skipped: number
  bytes: number
  conflicts: number
  errors: string[]
}

export type SyncProgress = {
  id: string
  jobId?: string
  state: SyncRunState
  done: number
  total: number
  files: number
  filesDone: number
  bytes: number
  bytesDone: number
  /** total bytes this run intends to copy; 0 while the plan is not known yet */
  bytesTotal?: number
  /** recent transfer rate in bytes per second (0 while paused/idle) */
  speed?: number
  /** estimated time to finish; null when there is no usable rate */
  etaMs?: number | null
  current: string
  errors: string[]
  /** pause/resume is a state of the run, not a lost event */
  paused?: boolean
}

export const SYNC_JOB_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_JOBS = 50
const MAX_IGNORE = 50
const MAX_PATH = 4096

export const isSyncPath = (p: unknown): p is string =>
  typeof p === 'string' &&
  p.length > 0 &&
  p.length <= MAX_PATH &&
  (isRemotePath(p) || p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\/.test(p))

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** Five fields, digits/stars/ranges/lists — enough for the app, and never a shell string. */
export function cleanCron(raw: unknown): string {
  const v = text(raw, 80)
  if (!v) return ''
  const fields = v.split(/\s+/)
  if (fields.length !== 5) return ''
  return fields.every((f) => /^[0-9*/,\-]+$/.test(f)) ? v : ''
}

function cleanIgnore(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const value of raw) {
    const v = text(value, 120)
    if (!v || v === '.' || v === '..' || /[\0\r\n]/.test(v)) continue
    if (!out.includes(v)) out.push(v)
    if (out.length >= MAX_IGNORE) break
  }
  return out
}

/**
 * Keep only well-formed rules. A bad regex or a path that tries to escape the root is dropped
 * instead of breaking the whole job; the rest of the list still applies.
 */
export function cleanIgnoreRules(raw: unknown): SyncIgnoreRule[] {
  if (!Array.isArray(raw)) return []
  const out: SyncIgnoreRule[] = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const r = value as Record<string, unknown>
    let rule: SyncIgnoreRule | null = null
    if (r.kind === 'size') {
      const bytes = Number(r.bytes)
      if ((r.op === 'gt' || r.op === 'lt') && Number.isFinite(bytes) && bytes >= 0) {
        rule = { kind: 'size', op: r.op, bytes: Math.min(Number.MAX_SAFE_INTEGER, Math.round(bytes)) }
      }
    } else if (r.kind === 'glob' || r.kind === 'regex' || r.kind === 'path') {
      const v = text(r.value, 300)
      if (!v || v === '.' || v === '..' || /[\0\r\n]/.test(v)) continue
      if (r.kind === 'regex') {
        try {
          new RegExp(v)
          rule = { kind: 'regex', value: v }
        } catch {
          // an invalid expression is user error, not a reason to reject the job
        }
      } else if (r.kind === 'path') {
        const p = v.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
        if (p && !p.startsWith('/') && !p.split('/').includes('..')) rule = { kind: 'path', value: p }
      } else {
        rule = { kind: 'glob', value: v }
      }
    }
    if (!rule) continue
    const key = JSON.stringify(rule)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(rule)
    if (out.length >= 100) break
  }
  return out
}

export function cleanSchedule(raw: unknown): SyncSchedule {
  const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const every = Number(s.everyMinutes)
  return {
    onStart: s.onStart === true,
    everyMinutes: Number.isFinite(every) && every >= 1 ? Math.min(10080, Math.round(every)) : undefined,
    cron: cleanCron(s.cron) || undefined,
    onMount: s.onMount === true,
    onChange: s.onChange === true
  }
}

export function cleanSyncJob(raw: unknown): SyncJob | null {
  if (!raw || typeof raw !== 'object') return null
  const j = raw as Record<string, unknown>
  const id = text(j.id, 64)
  if (!SYNC_JOB_ID.test(id)) return null
  const left = text(j.left, MAX_PATH)
  const right = text(j.right, MAX_PATH)
  if (!isSyncPath(left) || !isSyncPath(right) || left === right) return null
  const direction = j.direction === 'rtl' || j.direction === 'both' ? j.direction : 'ltr'
  const compareBy = j.compareBy === 'hash' ? 'hash' : 'mtime'
  const name = text(j.name, 80) || id
  const encLeft = cleanEncryption(j.encLeft)
  const encRight = cleanEncryption(j.encRight)
  const versions = cleanVersions(j.versions)
  if (encLeft === null || encRight === null || versions === null) return null
  // restic history is one-way and local; a job that could never take a snapshot is rejected
  if (versions) {
    const dest = direction === 'rtl' ? left : right
    if (direction === 'both' || isRemotePath(dest)) return null
  }
  const localOnly = !isRemotePath(left) && !isRemotePath(right)
  // rsync cannot encrypt/decrypt; a job with an encrypted side always uses the native engine
  const useRsync = localOnly && j.useRsync === true && !encLeft && !encRight
  const rsync = useRsync ? cleanRsyncOptions(j.rsync) : {}
  const compress = j.compress === true || rsync.compress === true
  const ignore = cleanIgnore(j.ignore)
  // migrate the old glob-only list so an existing job behaves exactly as before
  const ignoreRules = cleanIgnoreRules(j.ignoreRules)
  for (const value of ignore) {
    if (!ignoreRules.some((r) => r.kind === 'glob' && r.value === value)) {
      ignoreRules.push({ kind: 'glob', value })
      if (ignoreRules.length >= 100) break
    }
  }
  return {
    id,
    name,
    left,
    right,
    direction,
    compareBy,
    ignore,
    ignoreRules,
    deleteExtra: j.deleteExtra === true,
    enabled: j.enabled !== false,
    schedule: cleanSchedule(j.schedule),
    useRsync,
    compress,
    ...(useRsync ? { rsync: { ...rsync, ...(compress ? { compress: true } : {}) } } : {}),
    ...(encLeft ? { encLeft } : {}),
    ...(encRight ? { encRight } : {}),
    ...(versions ? { versions } : {})
  }
}

const SECRET_ID = /^[a-z0-9][a-z0-9-]{7,63}$/
const RECIPIENT = /^age1[0-9a-z]{20,}$/i

/** Invalid encryption config must reject the job, not silently run it in plaintext. */
/** Invalid version config must reject the job; silently running without the promised history is worse. */
export function cleanVersions(raw: unknown): SyncVersions | undefined | null {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const secretId = typeof v.secretId === 'string' ? v.secretId.trim() : ''
  if (!SECRET_ID.test(secretId)) return null
  const keep = Number(v.keep)
  const repo = typeof v.repo === 'string' ? v.repo.trim() : ''
  if (repo && (!isSyncPath(repo) || isRemotePath(repo))) return null
  return {
    keep: Number.isFinite(keep) && keep >= 1 ? Math.min(100, Math.round(keep)) : 5,
    ...(repo ? { repo } : {}),
    secretId
  }
}

export function cleanEncryption(raw: unknown): SyncEncryption | undefined | null {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const mode = e.mode === 'passphrase' || e.mode === 'keypair' ? e.mode : null
  const secretId = typeof e.secretId === 'string' ? e.secretId.trim() : ''
  if (!mode || !SECRET_ID.test(secretId)) return null
  const recipient = typeof e.recipient === 'string' ? e.recipient.trim() : ''
  if (recipient && !RECIPIENT.test(recipient)) return null
  return { mode, secretId, ...(recipient ? { recipient } : {}) }
}

const RSYNC_FLAGS = [
  'checksum',
  'compress',
  'partial',
  'inplace',
  'sparse',
  'hardLinks',
  'acls',
  'xattrs'
] as const

/** Only known booleans and a sane bandwidth number survive; anything else is dropped. */
export function cleanRsyncOptions(raw: unknown): RsyncOptions {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out: RsyncOptions = {}
  for (const key of RSYNC_FLAGS) if (src[key] === true) out[key] = true
  const bw = Number(src.bwlimitKB)
  if (Number.isFinite(bw) && bw > 0) out.bwlimitKB = Math.min(1_000_000, Math.round(bw))
  return out
}

/** Invalid jobs are dropped one by one; one bad entry must never stop the app from booting. */
export function cleanSyncJobs(raw: unknown): SyncJob[] {
  if (!Array.isArray(raw)) return []
  const out: SyncJob[] = []
  const ids = new Set<string>()
  for (const value of raw) {
    const job = cleanSyncJob(value)
    if (!job || ids.has(job.id)) continue
    ids.add(job.id)
    out.push(job)
    if (out.length >= MAX_JOBS) break
  }
  return out
}

export function cleanPairDirs(raw: unknown): Record<string, SyncMode> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, SyncMode> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.length > 9000) continue
    if (v !== 'ltr' && v !== 'rtl' && v !== 'both') continue
    out[k] = v
    if (Object.keys(out).length >= 100) break
  }
  return out
}

/** A stable key for «the direction of this pair of panes», independent of which side is active. */
export const pairKey = (left: string, right: string): string => `${left}\u0000${right}`

export function jobKey(job: Pick<SyncJob, 'left' | 'right'>): string {
  return pairKey(job.left, job.right)
}

export function newSyncJobId(existing: Iterable<string>): string {
  const taken = new Set(existing)
  for (let i = 1; i < 10_000; i++) {
    const id = `sync-${i}`
    if (!taken.has(id)) return id
  }
  return `sync-${Date.now().toString(36)}`
}
