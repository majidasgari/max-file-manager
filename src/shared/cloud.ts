/**
 * Cloud folders: one local folder mirrored with one folder on a cloud account.
 *
 * This module is shared by main and the renderer, so it contains only shapes and pure helpers —
 * no `fs`, no `electron`, no secrets. The renderer needs the provider catalog to draw the picker;
 * main needs the same catalog to validate what arrives over IPC.
 *
 * A binding is *not* a second sync engine: the service turns the cloud folder into a `PathOps`
 * and the existing `sync-core`/`sync-engine` do the comparison, the baseline and the conflicts.
 */

export const CLOUD_SCHEME = 'cloud://'

export type CloudProviderId =
  | 'gdrive'
  | 'dropbox'
  | 'onedrive'
  | 'protondrive'
  | 'nextcloud'
  | 'owncloud'
  | 'webdav'
  | 'qsync'

/** `oauth` providers authorise in a browser; `dav` ones take a URL and an app password. */
export type CloudFamily = 'oauth' | 'dav'

export type CloudProvider = {
  id: CloudProviderId
  label: string
  family: CloudFamily
  /** false while the adapter is not shipped yet: the row is drawn greyed out as «soon» */
  ready: boolean
  defaultIntervalMs: number
  /** the floor the UI may not go below, so a provider is never hammered */
  minIntervalMs: number
  /** the remote has a recycle bin, so a delete can be undone there */
  trash: boolean
  /**
   * The server keeps the source timestamp when it is sent (`X-OC-Mtime`, `client_modified`, …).
   * Without it an mtime comparison bounces every upload, so such a provider compares by hash.
   */
  preservesMtime: boolean
  /** the row that carries the badge; brand names stay in Latin, as on the desktop */
  note?: string
  /** the hint inside an empty server-address field; a wrong port is the usual WebDAV mistake */
  urlPlaceholder?: string
  /** the sentence under that field, so the port trap is explained before it happens */
  urlHint?: string
  /** why a not-ready provider is not available; shown instead of the protocol line */
  soonReason?: string
}

export const MINUTE = 60_000

/**
 * OAuth returns to this loopback port. A fixed port is deliberate: Dropbox matches the redirect
 * URI exactly, so the connect form can tell the user the one string to register in its console.
 */
export const OAUTH_REDIRECT_PORT = 53682
export const OAUTH_REDIRECT_URI = `http://127.0.0.1:${OAUTH_REDIRECT_PORT}/callback`
const HOUR = 60 * MINUTE

/**
 * The order is the one the picker shows. Only the WebDAV family is wired today; the OAuth
 * adapters and Proton Drive are declared here already so the list never has to change shape
 * (and so an invalid id from disk is rejected the same way).
 */
export const CLOUD_PROVIDERS: readonly CloudProvider[] = [
  {
    id: 'gdrive',
    label: 'Google Drive',
    family: 'oauth',
    ready: true,
    defaultIntervalMs: 5 * MINUTE,
    minIntervalMs: MINUTE,
    trash: true,
    preservesMtime: true,
    // The folder picker must list the whole drive, so this needs the full `drive` scope and Google's
    // restricted-scope verification — `drive.file` would only ever see folders this app created.
    note: 'scope: drive (verification required)'
  },
  {
    id: 'dropbox',
    label: 'Dropbox',
    family: 'oauth',
    ready: true,
    defaultIntervalMs: 5 * MINUTE,
    minIntervalMs: MINUTE,
    trash: true,
    preservesMtime: true
  },
  {
    id: 'onedrive',
    label: 'OneDrive',
    family: 'oauth',
    ready: true,
    defaultIntervalMs: 5 * MINUTE,
    minIntervalMs: MINUTE,
    trash: true,
    // Graph stamps its own timestamp on upload, so the binding compares by hash
    preservesMtime: false
  },
  {
    id: 'protondrive',
    label: 'Proton Drive',
    family: 'oauth',
    ready: false,
    soonReason: 'بدون API عمومی؛ منتظر API رسمی',
    defaultIntervalMs: 10 * MINUTE,
    minIntervalMs: 5 * MINUTE,
    trash: true,
    preservesMtime: true
  },
  {
    id: 'nextcloud',
    label: 'Nextcloud',
    family: 'dav',
    ready: true,
    defaultIntervalMs: 15 * MINUTE,
    minIntervalMs: 5 * MINUTE,
    trash: true,
    preservesMtime: true,
    note: '/remote.php/dav/files/<user>',
    urlPlaceholder: 'https://cloud.example.com',
    urlHint: 'برای Nextcloud همان آدرس اصلی کافی است؛ مسیر DAV خودکار اضافه می‌شود.'
  },
  {
    id: 'owncloud',
    label: 'ownCloud',
    family: 'dav',
    ready: true,
    defaultIntervalMs: 15 * MINUTE,
    minIntervalMs: 5 * MINUTE,
    trash: true,
    preservesMtime: true,
    note: '/remote.php/dav/files/<user>',
    urlPlaceholder: 'https://cloud.example.com',
    urlHint: 'برای ownCloud همان آدرس اصلی کافی است؛ مسیر DAV خودکار اضافه می‌شود.'
  },
  {
    id: 'webdav',
    label: 'WebDAV',
    family: 'dav',
    ready: true,
    defaultIntervalMs: 15 * MINUTE,
    minIntervalMs: 5 * MINUTE,
    trash: false,
    preservesMtime: false,
    urlPlaceholder: 'https://dav.example.com',
    urlHint: 'مسیر کامل WebDAV، بدون اسلش آخر.'
  },
  {
    id: 'qsync',
    label: 'Qsync',
    family: 'dav',
    ready: true,
    defaultIntervalMs: 15 * MINUTE,
    minIntervalMs: 5 * MINUTE,
    trash: false,
    preservesMtime: false,
    // the QTS web console also answers on 8080 (with HTML), so the port is the usual trap here
    note: 'QNAP · WebDAV · port 5000',
    urlPlaceholder: 'http://192.168.1.10:5000',
    urlHint:
      'روی QNAP سرویس WebDAV پورت ۵۰۰۰ (http) یا ۵۰۰۱ (https) است؛ ۸۰۸۰ کنسول وب QTS است و WebDAV نیست.'
  }
]

const PROVIDER_MAP = new Map(CLOUD_PROVIDERS.map((p) => [p.id, p]))

export function cloudProvider(id: string): CloudProvider | null {
  return PROVIDER_MAP.get(id as CloudProviderId) ?? null
}

export function isCloudProviderId(id: unknown): id is CloudProviderId {
  return typeof id === 'string' && PROVIDER_MAP.has(id as CloudProviderId)
}

export const CLOUD_MAX_INTERVAL = 24 * HOUR

/** Clamp a user-chosen interval to the provider's floor and a day. */
export function cleanCloudInterval(provider: CloudProviderId, raw: unknown): number {
  const p = cloudProvider(provider)
  const min = p?.minIntervalMs ?? 5 * MINUTE
  const fallback = p?.defaultIntervalMs ?? 15 * MINUTE
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(CLOUD_MAX_INTERVAL, Math.max(min, Math.round(n)))
}

export type CloudAccount = {
  id: string
  provider: CloudProviderId
  /** what the row shows: `alice@cloud.example.com`, or the account's display name */
  label: string
  /** WebDAV base URL, already ending at the DAV root (no trailing slash) */
  url?: string
  user?: string
  /** the OS keyring was unavailable, so the password only lives in this session */
  sessionOnly: boolean
  createdAt: number
}

export type CloudDirection = 'both' | 'ltr' | 'rtl'
export type CloudCompareBy = 'hash' | 'mtime'
/** The first pass: `fast` adopts equal-size pairs, `full` compares every file for real. */
export type CloudSeed = 'fast' | 'full'

export type CloudBinding = {
  id: string
  accountId: string
  name: string
  /** absolute local folder */
  localPath: string
  /** folder path below the account's DAV root; `/` is the root itself */
  remoteId: string
  /** what the user picked, for display only */
  remoteLabel: string
  direction: CloudDirection
  compareBy: CloudCompareBy
  /**
   * `fast` treats an equal size on both sides as the same file during the one-time adoption pass;
   * `full` never adopts and lets the normal comparison decide every path.
   */
  seed: CloudSeed
  /** propagate deletions to the other side; both sides must be recoverable for this to be safe */
  deleteExtra: boolean
  intervalMs: number
  enabled: boolean
  paused: boolean
  createdAt: number
}

export type CloudState = 'idle' | 'checking' | 'syncing' | 'paused' | 'offline' | 'error' | 'conflict'

/**
 * What a row in the pane shows next to its icon.
 *
 * `localOnly` and `cloudOnly` come from the last comparison: a path that exists on one side only.
 * A local row can only be `localOnly` itself (a cloud-only path has no row to draw), but a folder
 * carries the aggregate of its children, so «this folder has content that is only in the cloud»
 * still shows up where it is useful.
 */
export type CloudEntryState =
  | 'synced'
  | 'pending'
  | 'localOnly'
  | 'cloudOnly'
  | 'syncing'
  | 'paused'
  | 'offline'
  | 'conflict'
  | 'error'

/** Per-state file counts of the last comparison, so the page can say what is left to do. */
export type CloudCounts = {
  synced: number
  pending: number
  localOnly: number
  cloudOnly: number
  conflict: number
}

/**
 * The live progress of one run, pushed with every state broadcast (throttled in the service).
 * `scan` has no total yet (the walk does not know how many rows it will find), so the UI draws an
 * indeterminate bar until `phase` becomes `copy`.
 */
export type CloudProgress = {
  phase: 'scan' | 'copy'
  files: number
  filesDone: number
  bytesTotal: number
  bytesDone: number
  current: string
  /** unix ms; the renderer derives an average speed and an ETA from it */
  startedAt: number
}

export type CloudBindingStatus = {
  bindingId: string
  state: CloudState
  /** unix ms of the last finished run */
  lastRunAt: number | null
  /** unix ms of the next scheduled check */
  nextRunAt: number | null
  lastError: string | null
  /** relative paths the last comparison could not resolve */
  conflicts: string[]
  /** a local or remote change arrived after the last run */
  dirty: boolean
  /** what the last comparison found, per file state */
  counts: CloudCounts
  /** the run in flight; `null` when nothing is running */
  progress: CloudProgress | null
}

export type CloudView = {
  accounts: CloudAccount[]
  bindings: CloudBinding[]
  status: CloudBindingStatus[]
  /** `true` while a run is in flight, so the UI can hide «Sync now» */
  busy: boolean
}

/** A folder (or file) while browsing the remote side of an account. */
export type CloudTarget = {
  /** path below the DAV root, `/` at the top */
  path: string
  name: string
  dir: boolean
  size: number
  mtime: number
}

/** A read-only estimate shown before a binding is created; it never downloads content. */
export type CloudPreview = {
  /** files that exist only on the local side (uploaded on the first run) */
  up: number
  /** files that exist only on the cloud side (downloaded on the first run) */
  down: number
  same: number
  conflicts: number
  bytesUp: number
  bytesDown: number
  /** the walk hit its row/time cap: the numbers are a lower bound */
  capped: boolean
  /** the binding will compare by content hash, so this quick estimate used mtime */
  hashMode: boolean
}

export const CLOUD_ID_RE = /^cloud-[a-z0-9]{4,40}$/

export function newCloudId(existing: Iterable<string>): string {
  const taken = new Set(existing)
  for (let i = 0; i < 10_000; i++) {
    const id = `cloud-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(id)) return id
  }
  return `cloud-${Math.random().toString(36).slice(2, 12)}`
}

/** `cloud://<bindingId>` or `cloud://<bindingId>/<rel>`. Always forward slashes. */
export function cloudPath(bindingId: string, rel = ''): string {
  const clean = rel.replace(/^\/+/, '')
  return clean ? `${CLOUD_SCHEME}${bindingId}/${clean}` : `${CLOUD_SCHEME}${bindingId}`
}

export function isCloudPath(p: unknown): p is string {
  return typeof p === 'string' && p.startsWith(CLOUD_SCHEME)
}

export function cloudOf(p: string): { bindingId: string; rel: string } | null {
  if (!isCloudPath(p)) return null
  const rest = p.slice(CLOUD_SCHEME.length)
  const slash = rest.indexOf('/')
  const bindingId = slash === -1 ? rest : rest.slice(0, slash)
  if (!CLOUD_ID_RE.test(bindingId)) return null
  return { bindingId, rel: slash === -1 ? '' : rest.slice(slash + 1) }
}

/** Absolute on POSIX or Windows; shared code cannot import `node:path`. */
export function isAbsoluteFolder(p: unknown): p is string {
  if (typeof p !== 'string') return false
  const s = p.trim()
  if (!s || s.length > 4096 || s.includes('\u0000')) return false
  return s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')
}

const text = (raw: unknown, max: number): string =>
  typeof raw === 'string' ? raw.replace(/\u0000/g, '').trim().slice(0, max) : ''

/** http(s) only, no credentials in the URL, no trailing slash. */
export function cleanCloudUrl(raw: unknown): string | null {
  const s = text(raw, 2048)
  if (!s) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null
  const pathName = u.pathname.replace(/\/+$/, '')
  return `${u.origin}${pathName}`
}

export function cleanCloudAccount(raw: unknown): CloudAccount | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  const id = text(a.id, 64)
  if (!CLOUD_ID_RE.test(id)) return null
  if (!isCloudProviderId(a.provider)) return null
  const provider = cloudProvider(a.provider)
  if (!provider || !provider.ready) return null
  const url = provider.family === 'dav' ? cleanCloudUrl(a.url) : undefined
  if (provider.family === 'dav' && !url) return null
  const user = text(a.user, 120)
  if (provider.family === 'dav' && !user) return null
  const createdAt = typeof a.createdAt === 'number' && Number.isFinite(a.createdAt) ? a.createdAt : Date.now()
  return {
    id,
    provider: a.provider,
    label: text(a.label, 120) || user || provider.label,
    ...(url ? { url } : {}),
    ...(user ? { user } : {}),
    sessionOnly: a.sessionOnly === true,
    createdAt
  }
}

export function cleanCloudBinding(raw: unknown): CloudBinding | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const id = text(b.id, 64)
  if (!CLOUD_ID_RE.test(id)) return null
  const accountId = text(b.accountId, 64)
  if (!CLOUD_ID_RE.test(accountId)) return null
  const localPath = text(b.localPath, 4096)
  if (!isAbsoluteFolder(localPath)) return null
  const remoteId = text(b.remoteId, 2048)
  if (!remoteId.startsWith('/') || remoteId.includes('\\')) return null
  const direction: CloudDirection =
    b.direction === 'ltr' || b.direction === 'rtl' ? b.direction : 'both'
  const compareBy: CloudCompareBy = b.compareBy === 'mtime' ? 'mtime' : 'hash'
  const seed: CloudSeed = b.seed === 'full' ? 'full' : 'fast'
  const createdAt = typeof b.createdAt === 'number' && Number.isFinite(b.createdAt) ? b.createdAt : Date.now()
  return {
    id,
    accountId,
    name: text(b.name, 120) || localPath,
    localPath,
    remoteId: remoteId === '/' ? '/' : remoteId.replace(/\/+$/, ''),
    remoteLabel: text(b.remoteLabel, 2048) || remoteId,
    direction,
    compareBy,
    seed,
    deleteExtra: b.deleteExtra === true,
    intervalMs: cleanCloudInterval('webdav', b.intervalMs),
    enabled: b.enabled !== false,
    paused: b.paused === true,
    createdAt
  }
}

export function cleanCloudAccounts(raw: unknown): CloudAccount[] {
  if (!Array.isArray(raw)) return []
  const out: CloudAccount[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const a = cleanCloudAccount(item)
    if (!a || seen.has(a.id)) continue
    seen.add(a.id)
    out.push(a)
  }
  return out
}

export function cleanCloudBindings(raw: unknown, accounts: CloudAccount[]): CloudBinding[] {
  if (!Array.isArray(raw)) return []
  const known = new Set(accounts.map((a) => a.id))
  const out: CloudBinding[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const b = cleanCloudBinding(item)
    if (!b || seen.has(b.id) || !known.has(b.accountId)) continue
    // two bindings over the same local folder (or nested ones) would fight over the same files
    if (out.some((o) => overlaps(o.localPath, b.localPath))) continue
    seen.add(b.id)
    out.push(b)
  }
  return out
}

/** `a` and `b` are the same folder or one is below the other. */
export function overlaps(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const x = norm(a)
  const y = norm(b)
  if (x === y) return true
  return x.startsWith(y + '/') || y.startsWith(x + '/')
}
