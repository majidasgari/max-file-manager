import type { ConflictPolicy } from '../../shared/conflict.ts'
import type { PortalFilter } from '../../shared/portal-filters.ts'
import type { ProfileDraft, RemoteProfile } from '../../shared/remote-profile.ts'
import type {
  CloudAccount,
  CloudBinding,
  CloudBindingStatus,
  CloudCompareBy,
  CloudDirection,
  CloudEntryState,
  CloudPreview,
  CloudProvider,
  CloudState,
  CloudTarget,
  CloudView
} from '../../shared/cloud.ts'
import type {
  RsyncOptions,
  SyncCompareBy,
  SyncEncryption,
  SyncIgnoreRule,
  SyncJob,
  SyncMode,
  SyncPlan,
  SyncProgress,
  SyncRow,
  SyncRunSummary,
  SyncSnapshot,
  SyncVersions
} from '../../shared/sync.ts'

export type { ProfileDraft, RemoteProfile } from '../../shared/remote-profile.ts'
export type {
  CloudAccount,
  CloudBinding,
  CloudBindingStatus,
  CloudCompareBy,
  CloudDirection,
  CloudEntryState,
  CloudPreview,
  CloudProvider,
  CloudState,
  CloudTarget,
  CloudView
} from '../../shared/cloud.ts'
export type {
  ConflictKind,
  RsyncOptions,
  SyncAction,
  SyncEncryption,
  SyncCompareBy,
  SyncIgnoreRule,
  SyncJob,
  SyncMode,
  SyncPlan,
  SyncProgress,
  SyncRow,
  SyncRunSummary,
  SyncSchedule,
  SyncSide,
  SyncSnapshot,
  SyncState,
  SyncVersions
} from '../../shared/sync.ts'

export type SyncCompareResult = {
  rows: SyncRow[]
  leftCount: number
  rightCount: number
  capped: boolean
  hashed: number
}
export type SyncApplyResult = { copied: number; removed: number; skipped: number; bytes: number; errors: string[]; cancel: boolean }
export type SyncPlanResult = { cmp: SyncCompareResult; plan: SyncPlan; rows: SyncRow[]; blocked: boolean }
export type SyncRunResult = {
  id: string
  rows: SyncRow[]
  plan: SyncPlan
  cmp: SyncCompareResult
  applied: SyncApplyResult | null
  summary: SyncRunSummary
  blocked: boolean
}
export type SyncOptions = {
  left: string
  right: string
  mode?: SyncMode
  compareBy?: SyncCompareBy
  ignore?: string[]
  ignoreRules?: SyncIgnoreRule[]
  compress?: boolean
  deleteExtra?: boolean
  selected?: string[]
  resolutions?: Record<string, 'left' | 'right' | 'skip'>
  jobId?: string
  dryRun?: boolean
  confirmRemoteDelete?: boolean
  useRsync?: boolean
  rsync?: RsyncOptions
  encLeft?: SyncEncryption
  encRight?: SyncEncryption
  versions?: SyncVersions
}
export type RemoteTestResult =
  | { ok: true; detail: string; hostKey?: string }
  | { ok: false; error: string }
export type SshConfigHost = {
  alias: string
  host: string
  user: string
  port: number
  identityFile: string
}

export type PortalOperation = 'open' | 'save' | 'saveFiles'
export type PortalRequestData = {
  id: string
  operation: PortalOperation
  title: string
  multiple: boolean
  directory: boolean
  currentFolder: string | null
  currentName: string
  acceptLabel: string
  filters: PortalFilter[]
  fileNames: string[]
}
export type PortalStatus = { supported: boolean; installed: boolean; running: boolean }

export type DesktopApp = {
  id: string
  name: string
  icon: string
  /** absolute icon file, '' when the theme has none */
  iconPath: string
  /** the desktop's current handler for this file type */
  isDefault: boolean
}
export type OpenWithInfo = { mime: string; canSetDefault: boolean; apps: DesktopApp[] }

export type BreakdownMode = 'level1' | 'all'
export type BreakdownSlice = { key: string; count: number; bytes: number }
export type BreakdownFile = { path: string; rel: string; name: string; ext: string; size: number }
export type BreakdownChild = { path: string; name: string; dir: boolean; bytes: number; files: number }
export type Breakdown = {
  root: string
  mode: BreakdownMode
  bytes: number
  files: number
  folders: number
  scanned: number
  capped: boolean
  byExt: BreakdownSlice[]
  largest: BreakdownFile[]
  children: BreakdownChild[]
}

export type Id3Fields = {
  title?: string
  artist?: string
  albumArtist?: string
  album?: string
  year?: string
  track?: string
  trackTotal?: string
  disc?: string
  discTotal?: string
  genre?: string
  composer?: string
  comment?: string
}

export type AudioRead = {
  files: Record<string, Id3Fields>
  hasCover: Record<string, boolean>
  sharedCover: string | null
  folderCover: string | null
  skipped: number
}

export type AudioWriteRequest = {
  items: { path: string; fields: Id3Fields }[]
  cover: 'keep' | 'clear' | 'folder' | { path: string }
}

export type AudioWriteResult = { done: number; errors: string[]; warnings?: string[] }

/** What the standalone music window mirrors: the main window owns the `<audio>`, this is its state. */
export type MusicWindowState = {
  items: string[]
  index: number
  playing: boolean
  pos: number
  dur: number
  volume: number
}

/** Commands the music window sends back to the one player in the main window. */
export type MusicCommand =
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'play'; index: number }
  | { type: 'seek'; pos: number }
  | { type: 'volume'; volume: number }
  | { type: 'remove'; index: number }

export type Tags = {
  title?: string
  artist?: string
  /** main's ID3 reader sends these too, the panel only shows some of them */
  albumArtist?: string
  genre?: string
  composer?: string
  album?: string
  year?: string
  track?: string
  date?: string
  camera?: string
  iso?: string
  fnumber?: string
  exposure?: string
  focal?: string
  size?: string
  kind: 'id3' | 'exif' | 'both' | 'none'
}

export type Entry = {
  name: string
  path: string
  dir: boolean
  size: number
  mtime: number
  ext: string
  /** duplicate group number, only set by api.dupes */
  group?: number
  /** per-folder look, from the folder's own .mfm.json */
  color?: string
  icon?: string
  mode?: number
  uid?: number
  gid?: number
  nlink?: number
  w?: number
  h?: number
  /** a folder marked «don't list me» in its own .mfm.json */
  hidden?: boolean
  /** the entry is a symbolic link (the path itself, not its target) */
  link?: boolean
  /** forced visible by the parent folder's `.mfm.json` */
  forceShow?: boolean
  /** inside a cloud binding; `root` draws the provider badge, a child only a state dot */
  cloud?: { provider: string; state: CloudEntryState; root: boolean }
  /** inside an archive: the payload needs a password */
  encrypted?: boolean
  /** inside an archive: compressed size and raw ZIP method (0 store, 8 deflate, 93 zstd) */
  csize?: number
  method?: number
}

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz' | 'tar.zst'
export type ArchiveEncryption = 'aes256' | 'aes192' | 'aes128' | 'zipcrypto'
export type ArchiveProgress = {
  opId?: string
  phase: 'compress' | 'extract'
  done: number
  total: number
  bytes: number
  totalBytes: number
  name?: string
}
export type ArchiveListing = {
  entries: Entry[]
  capped: boolean
  format?: string
  encrypted?: boolean
  error?: string
}
export type ArchiveCreateInput = {
  dir: string
  name: string
  sources: string[]
  format?: ArchiveFormat
  level?: number
  method?: 'auto' | 'store' | 'deflate'
  password?: string
  encryption?: ArchiveEncryption
  comment?: string
  opId?: string
}
export type ArchiveExtractInput = {
  archive: string
  dest: string
  names?: string[]
  password?: string
  conflict?: ConflictPolicy
  subfolder?: boolean
  symlinks?: boolean
  opId?: string
}
export type SearchHit = {
  path: string
  name: string
  dir: boolean
  size: number
  mtime: number
  ext: string
}

export type SearchProgress = {
  running: boolean
  scanned: number
  added: number
  done: number
  total: number
  root: string
  startedAt: number
  finishedAt: number
  files: number
  dirs: number
  lastIndex: number
  error: string
}
export type SearchStatus = SearchProgress & { stats: { files: number; dirs: number; lastIndex: number } }
export type DiffResult = {
  lines: { kind: 'same' | 'add' | 'del' | 'change'; a?: number; b?: number; text: string }[]
  added: number
  removed: number
  binary: boolean
  coarse: boolean
}
export type Listing = {
  path: string
  parent: string | null
  entries: Entry[]
  pins?: string[]
  labels?: Record<string, string>
  ratings?: Record<string, number>
  notes?: Record<string, string>
  format?: {
    view?: 'list' | 'grid' | 'compact'
    columns?: string[]
    sortKey?: string
    sortAsc?: boolean
    group?: 'none' | 'name' | 'type' | 'size' | 'date' | 'ext'
  } | null
}
export type DirRef = { name: string; path: string; /** the entry itself is a symbolic link */ link?: boolean }
export type Drive = {
  id: string
  name: string
  device: string
  mountpoint: string | null
  size: string
  fsType: string
  removable: boolean
  mounted: boolean
}
export type DiskVolume = {
  id: string
  name: string
  device: string
  mountpoint: string | null
  fsType: string
  total: number
  free: number | null
  used: number | null
  removable: boolean
  mounted: boolean
  system: boolean
}
export type MemoryInfo = {
  total: number
  available: number
  used: number
  swapTotal: number
  swapFree: number
  swapUsed: number
}
export type Result = { done: number; errors: string[] }
export type SizeResult = { bytes: number; files: number; capped: boolean }

export type WalkOpts = {
  query?: string
  regex?: boolean
  content?: string
  minSize?: number
  maxSize?: number
  newerThan?: number
  limit?: number
  /** names/paths to stay out of (node_modules, .git, …) */
  exclude?: string[]
  /** wall-clock budget in ms; the walk stops and reports `capped` */
  budgetMs?: number
}
export type WalkResult = { entries: Entry[]; scanned: number; capped: boolean }

export type JobKind = 'copy' | 'move'
export type JobState = 'queued' | 'running' | 'paused' | 'done' | 'cancelled' | 'error'
export type Job = {
  id: string
  kind: JobKind
  label: string
  /** destination folder of this transfer */
  dest?: string
  state: JobState
  bytes: number
  done: number
  files: number
  filesDone: number
  speed: number
  skipped?: number
  /** files that replaced an existing destination file */
  overwrites?: number
  /** what this job did when a destination name was taken */
  conflict?: ConflictPolicy
  current: string
  errors: string[]
}

/** One line of a job's per-file log. */
export type JobFile = {
  path: string
  state: 'copied' | 'skipped' | 'failed'
  size?: number
  /** this copy replaced a file that was already there */
  overwrote?: boolean
  /** 'exists' | 'newer' for a filtered skip, or the error text of a failure */
  note?: string
}

export type JobLog = {
  copied: { entries: JobFile[]; total: number; dropped: number }
  skipped: { entries: JobFile[]; total: number }
  failed: { entries: JobFile[]; total: number }
}

export type StoredState = {
  panes?: {
    tabs: string[]
    ti: number
    pinCount?: number
    names?: Record<string, string>
    locks?: Record<string, boolean>
  }[]
  active?: number
  hidden?: boolean
  theme?: 'dark' | 'light'
  sort?: { key: string; asc: boolean }
  view?: 'list' | 'grid' | 'compact'
  marks?: string[]
  /** custom bookmark titles, keyed by folder path */
  markNames?: Record<string, string>
  chrome?: { customTitlebar: boolean; rounded: boolean }
  prefs?: Record<string, unknown>
  ui?: {
    sidebar: 'docked' | 'float'
    sidebarOpen: boolean
    iconDirs?: string[]
    iconTheme?: string
  }
}

export type Chrome = { customTitlebar: boolean; rounded: boolean }
export type FolderMeta = {
  color?: string
  icon?: string
  /** hide this folder from its parent's listing (shown with hidden files) */
  hidden?: boolean
  pins?: string[]
  labels?: Record<string, string>
  ratings?: Record<string, number>
  notes?: Record<string, string>
  format?: {
    view?: 'list' | 'grid' | 'compact'
    columns?: string[]
    sortKey?: string
    sortAsc?: boolean
    group?: 'none' | 'name' | 'type' | 'size' | 'date' | 'ext'
  } | null
}
export type PreviewKind = 'dir' | 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'binary'
export type Preview = {
  kind: PreviewKind
  size: number
  mtime: number
  text?: string
  capped?: boolean
}
export type PlayerChapter = { start: number; end: number; title: string }
export type PlayerSubtitle = { label: string; lang: string; vtt: string }
export type PlayerSource = {
  /** absolute file on disk; the renderer turns it into an mfm:// URL */
  path: string
  mode: 'direct' | 'remux' | 'transcode'
  duration: number
  width: number
  height: number
  chapters: PlayerChapter[]
  subtitles: PlayerSubtitle[]
}
export type PlayerJobInfo = {
  id: string
  mode: 'remux' | 'transcode'
  progress: number
  duration: number
  width: number
  height: number
  chapters: PlayerChapter[]
}
export type PlayerOpen =
  | { kind: 'ready'; source: PlayerSource }
  | { kind: 'preparing'; job: PlayerJobInfo }
  | { kind: 'unsupported'; error: string }
export type PlayerEvent =
  | { id: string; path: string; type: 'progress'; progress: number }
  | { id: string; path: string; type: 'done'; source: PlayerSource }
  | { id: string; path: string; type: 'error'; error: string }
export type PlayerCapabilities = {
  ffmpeg: boolean
  ffprobe: boolean
  encoders: {
    h264: boolean
    aac: boolean
    vp9: boolean
    opus: boolean
    /** the hardware H.264 encoder FFmpeg proved it can use, absent when it has none */
    hw?: { name: string; device?: string }
  }
  version: string
}
export type HashResult = { path: string; hash: string | null }
export type IconRef = { name: string; path: string }
export type IconTheme = { name: string; dir: string }

export type FileProperties = {
  /** remote profiles show general/checksums/details only */
  remote?: boolean
  protocol?: string
  location?: string
  name: string
  path: string
  dir: boolean
  size: number
  ext: string
  mode: number
  readable: boolean
  writable: boolean
  executable: boolean
  uid: number
  gid: number
  user: string
  group: string
  nlink: number
  inode: number
  device: number
  birthtime: number
  mtime: number
  atime: number
  ctime: number
  /** the entry itself is a symbolic link */
  link: boolean
  target: string
  mime: string
  /** direct children (folders only) */
  items: number | null
  dims: { w: number; h: number } | null
}

export type Api = {

  portal: {
    request(): Promise<PortalRequestData | null>
    respond(result: { paths: string[]; filter?: PortalFilter | null } | null): Promise<{ ok: true } | { error: string }>
    rememberDir(dir: string): Promise<boolean>
    status(): Promise<PortalStatus>
    configure(enabled: boolean): Promise<PortalStatus & { error?: string }>
  }
  list(dir: string, showHidden: boolean, dims?: boolean): Promise<Listing>
  /** watch the folders on screen; the callback fires when one changes on disk (no polling) */
  watchDirs(dirs: string[]): Promise<boolean>
  onFsChange(cb: (dir: string) => void): () => void
  /** bytes/counts per extension, the largest files and each direct child's total */
  breakdown(path: string, mode?: BreakdownMode): Promise<Breakdown>
  statfs(p: string): Promise<{ free: number; size: number } | null>
  debugLog(msg: string): Promise<boolean>
  chmod(p: string, mode: number): Promise<{ ok: true } | { error: string }>
  properties(p: string): Promise<FileProperties | { error: string }>
  imageData(p: string): Promise<{ dataUrl?: string; error?: string }>
  readBytes(p: string, max?: number): Promise<{ data?: Uint8Array; error?: string }>
  saveImage(src: string, dataUrl: string, mode: 'overwrite' | 'copy'): Promise<{ path: string } | { error: string }>
  dirs(dir: string, showHidden?: boolean, followLinks?: boolean): Promise<DirRef[]>
  roots(): Promise<DirRef[]>
  home(): Promise<string>
  size(p: string): Promise<SizeResult>
  remove(paths: string[], permanent: boolean): Promise<Result>
  walk(dir: string, opts: WalkOpts): Promise<WalkResult>
  dupes(dir: string): Promise<{ entries: Entry[]; capped: boolean }>
  archive(p: string): Promise<ArchiveListing>
  registerHotkey(accel: string): Promise<{ ok: boolean; accel: string }>
  /** Windows only: hand Win+E to the keyboard-hook helper (or retire it) */
  wineTakeover(on: boolean, autostart?: boolean): Promise<{ ok: boolean; active: boolean; app: string; error?: string }>
  /** 'win32' | 'linux' | 'darwin' — a few settings only exist on one platform */
  platform: string
  /** Desktop environment on Linux (e.g. 'KDE', 'GNOME') */
  desktop?: string
  runScript(
    command: string,
    path?: string,
    dir?: string
  ): Promise<{ ok: true; output: string } | { error: string }>
  runCustomCommand(command: string, path: string): Promise<{ ok: true } | { error: string }>
  openTerminal(dir: string, shell?: string): Promise<{ ok: true } | { error: string }>
  /** terminal programs this machine can start (Windows shells, installed emulators) */
  terminalOptions(): Promise<{ auto: string; options: { id: string; label: string; detail: string }[] }>
  /** fonts the person imported; bundled families are renderer assets and need no IPC */
  fonts: {
    list(): Promise<{ id: string; family: string; size: number }[]>
    /** raw font bytes, registered with `FontFace` in the renderer (never a URL) */
    read(id: string): Promise<Uint8Array<ArrayBuffer> | null>
    /** native picker; returns what was actually copied into the app folder */
    import(): Promise<{ id: string; family: string; size: number }[]>
    remove(id: string): Promise<boolean>
  }
  reveal(path: string): Promise<{ ok: true } | { error: string }>
  isDefaultFileManager(): Promise<boolean>
  setDefaultFileManager(): Promise<{ ok: boolean; error?: string }>
  /** Windows only: give the folder classes their old default verb back */
  clearDefaultFileManager(): Promise<{ ok: boolean }>
  /** hands the files to the OS so they can be dropped into another app */
  dragOut(files: string[]): void
  clearThumbs(): Promise<{ removed: number }>
  mcp: {
    status(): Promise<{ mode: 'off' | 'read' | 'write'; port: number; hasToken: boolean; log: string[] }>
    configure(patch: { mode?: 'off' | 'read' | 'write'; port?: number }): Promise<{
      running: boolean
      port: number
      mode: string
      token: string
      error: string
      log: string[]
    }>
    token(): Promise<string>
    onUi(cb: (msg: unknown) => void): () => void
  }
  drives: {
    list(): Promise<Drive[]>
    volumes(): Promise<DiskVolume[]>
    mount(device: string): Promise<{ ok: boolean; mountpoint?: string; error?: string }>
    unmount(deviceOrMount: string): Promise<{ ok: boolean; error?: string }>
  }
  system: {
    memory(): Promise<MemoryInfo>
  }
  update: {
    check(force?: boolean): Promise<{
      current: string
      latest: string | null
      url: string | null
      notes: string | null
      newer: boolean
      checkedAt: number
      error?: string
    }>
    open(url: string): Promise<{ ok: true } | { error: string }>
  }
  search: {
    index(config: { roots: string[]; exclude: string[] }): Promise<{
      files: number
      dirs: number
      durationMs: number
      stats: { files: number; dirs: number; lastIndex: number }
      alreadyRunning?: boolean
      status?: SearchStatus
    }>
    query(query: string, limit?: number): Promise<SearchHit[]>
    stats(): Promise<{ files: number; dirs: number; lastIndex: number }>
    status(): Promise<SearchStatus>
    sizes(dirs: string[]): Promise<Record<string, { bytes: number; files: number }>>
    clear(): Promise<{ files: number; dirs: number; lastIndex: number }>
    onProgress(cb: (p: SearchProgress) => void): () => void
  }
  settings: {
    export(prefs: unknown): Promise<{ path: string } | { canceled: true } | { error: string }>
    import(): Promise<{ prefs: Record<string, unknown> } | { canceled: true } | { error: string }>
  }
  tags(paths: string[]): Promise<Record<string, Tags>>
  writeTags(path: string, fields: Record<string, string>): Promise<{ ok: true } | { error: string }>
  audioRead(paths: string[]): Promise<AudioRead>
  audioWrite(req: AudioWriteRequest): Promise<AudioWriteResult>
  audioDurations(paths: string[]): Promise<Record<string, number>>
  saveImageAs(src: string, dataUrl: string, dest?: string): Promise<{ path: string } | { error: string }>
  convertImages(
    files: string[],
    opts: { format: 'jpeg' | 'png' | 'webp' | 'bmp'; maxSide: number; quality: number; dest?: string }
  ): Promise<{ done: number; errors: string[]; outDir: string }>
  exportListing(
    dir: string,
    name: string,
    rows: unknown,
    format: 'csv' | 'pdf',
    theme?: string
  ): Promise<{ path: string; rows: number } | { error: string }>
  sync: {
    compare(opts: SyncOptions): Promise<SyncCompareResult>
    plan(opts: SyncOptions): Promise<SyncPlanResult>
    run(opts: SyncOptions): Promise<SyncRunResult>
    jobs(): Promise<SyncJob[]>
    saveJob(job: Partial<SyncJob>): Promise<SyncJob | null>
    removeJob(id: string): Promise<boolean>
    history(limit?: number): Promise<SyncRunSummary[]>
    restore(id: string, confirmRemote?: boolean): Promise<SyncRunResult>
    status(): Promise<{ id: string; state: string; paused: boolean } | null>
    cancel(id?: string): Promise<boolean>
    pause(id?: string): Promise<boolean>
    resume(id?: string): Promise<boolean>
    clearBaseline(left: string, right: string): Promise<boolean>
    secretSet(id: string, value: string): Promise<{ ok: true; sessionOnly: boolean } | { error: string }>
    secretHas(id: string): Promise<boolean>
    secretRemove(id: string): Promise<boolean>
    /** only for backing up a generated keypair identity; never call it for a passphrase */
    secretReveal(id: string): Promise<string | null>
    keypair(): Promise<{ identity: string; recipient: string }>
    recipientOf(identity: string): Promise<string>
    versionsAvailable(): Promise<boolean>
    versions(opts: {
      left: string
      right: string
      mode: SyncMode
      repo?: string
      secretId: string
    }): Promise<{ available: boolean; repo: string; snapshots: SyncSnapshot[]; error: string }>
    versionsRestore(repo: string, secretId: string, id: string): Promise<string>
    onProgress(cb: (p: SyncProgress) => void): () => void
    onDone(cb: (r: SyncRunSummary) => void): () => void
    onJobs(cb: (jobs: SyncJob[]) => void): () => void
  }
  diffFiles(a: string, b: string): Promise<DiffResult>
  /** cloud folders: one local folder mirrored with one folder on a WebDAV account */
  cloud: {
    list(): Promise<CloudView>
    accountSave(draft: {
      provider: string
      url?: string
      user?: string
      password?: string
      label?: string
      clientId?: string
      clientSecret?: string
    }): Promise<CloudAccount>
    accountRemove(id: string): Promise<boolean>
    browse(accountId: string, path: string): Promise<CloudTarget[]>
    folderCreate(accountId: string, parent: string, name: string): Promise<string>
    preview(accountId: string, localPath: string, remoteId: string): Promise<CloudPreview>
    /** open the provider's «create an OAuth app» page in the system browser */
    docs(provider: string): Promise<boolean>
    bindingSave(draft: {
      id?: string
      accountId: string
      localPath: string
      remoteId: string
      remoteLabel?: string
      name?: string
      compareBy?: CloudCompareBy
      seed?: 'fast' | 'full'
      deleteExtra?: boolean
      intervalMs?: number
      direction?: CloudDirection
    }): Promise<CloudBinding>
    bindingUpdate(
      id: string,
      patch: {
        name?: string
        intervalMs?: number
        deleteExtra?: boolean
        compareBy?: CloudCompareBy
        direction?: CloudDirection
        enabled?: boolean
        paused?: boolean
      }
    ): Promise<CloudBinding>
    bindingRemove(id: string): Promise<boolean>
    syncNow(
      id: string,
      confirm?: boolean
    ): Promise<{
      ok: boolean
      copied: number
      removed: number
      conflicts: number
      blockedDeletes: number
      error?: string
    }>
    onState(cb: (v: CloudView) => void): () => void
  }
  readText(p: string): Promise<{ text: string; size: number } | { error: string }>
  /** unsaved editor buffers, restored after a crash or a closed window */
  drafts: {
    get(path: string): Promise<{ text: string; at: number } | null>
    set(path: string, text: string): Promise<{ text: string; at: number } | null>
    clear(path: string): Promise<boolean>
  }
  writeText(path: string, text: string): Promise<{ ok: true } | { error: string }>
  htmlToPdf(html: string, out: string, theme?: string): Promise<{ path: string } | { error: string }>
  createArchive(
    a: ArchiveCreateInput
  ): Promise<{ path: string; files: number; bytes: number } | { error: string }>
  extract(a: ArchiveExtractInput): Promise<{ done: number; skipped: number; bytes: number; errors: string[] }>
  verifyArchive(a: {
    archive: string
    password?: string
    names?: string[]
  }): Promise<{ ok: boolean; checked: number; errors: string[] }>
  cancelArchive(opId: string): Promise<boolean>
  onArchiveProgress(cb: (v: ArchiveProgress) => void): () => void
  getMeta(dir: string): Promise<FolderMeta | null>
  labelPalette(): Promise<{ id: string; name: string; color: string }[]>
  setLabel(dir: string, name: string, label: string | null): Promise<Record<string, string>>
  setEntryColor(dir: string, name: string, color: string): Promise<FolderMeta | null>
  setRating(dir: string, name: string, stars: number): Promise<Record<string, number>>
  setFormat(
    dir: string,
    format: { view?: string; columns?: string[]; sortKey?: string; sortAsc?: boolean }
  ): Promise<unknown>
  setNote(dir: string, name: string, text: string): Promise<Record<string, string>>
  togglePin(dir: string, name: string, on?: boolean): Promise<string[]>
  /** keep a name visible even while hidden files are off (stored in the folder's `.mfm.json`) */
  toggleShown(dir: string, name: string, on?: boolean): Promise<string[]>
  setMeta(dir: string, meta: FolderMeta): Promise<FolderMeta | null>
  iconThemes(extra: string[]): Promise<IconTheme[]>
  iconsIn(themeDir: string): Promise<IconRef[]>
  /** kind → icon file from the preferred theme (Pure); empty when no theme is installed */
  iconSet(): Promise<Record<string, string>>
  folderLook(p: string): Promise<{ color?: string; icon?: string }>
  mkdir(dir: string, name: string): Promise<Result>
  createFile(dir: string, name: string, content?: string): Promise<Result>
  symlink(
    target: string,
    linkPath: string
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }>
  /** .lnk on Windows, a symlink elsewhere; `where` picks the item's own folder or the desktop */
  shortcut(
    targets: string[],
    where: 'here' | 'desktop'
  ): Promise<{ done: number; created: string[]; errors: string[] }>
  renameMany(pairs: { from: string; to: string }[]): Promise<Result>
  open(p: string): Promise<{ ok: true } | { error: string }>
  /** run an executable file as itself (the exec bit is the permission), whatever its type */
  run(p: string): Promise<{ ok: true } | { error: string }>
  clipboard: {
    releaseFiles(): Promise<boolean>
    copyFiles(paths: string[], cut?: boolean): Promise<'files' | 'text'>
    /** Files copied in another app (Explorer/Finder/Dolphin), empty when the clipboard holds none. */
    readFiles(): Promise<{ paths: string[]; cut: boolean }>
    writeText(text: string): Promise<boolean>
    saveImage(dir: string, name: string, data: Uint8Array): Promise<{ path: string } | { error: string }>
  }
  apps: {
    list(p: string): Promise<DesktopApp[]>
    openWith(p: string, all?: boolean): Promise<OpenWithInfo>
    setDefault(p: string, id: string): Promise<{ ok: true } | { error: string }>
    default(p: string): Promise<{ id: string; name: string } | null>
    launch(id: string, p: string): Promise<{ ok: true } | { error: string }>
    /** Windows: where a `.lnk` points, '' when it has no readable target */
    shortcutTarget(p: string): Promise<string>
    /** Windows: start an `.exe`/`.msi` elevated; a declined UAC prompt is an error */
    runAdmin(p: string): Promise<{ ok: true } | { error: string }>
  }
  remote: {
    /** saved connections; secrets never cross this boundary */
    profiles(): Promise<RemoteProfile[]>
    save(draft: ProfileDraft): Promise<{ ok: true; profile: RemoteProfile } | { ok: false; error: string }>
    remove(id: string): Promise<{ ok: boolean }>
    test(draft: ProfileDraft): Promise<RemoteTestResult>
    testSaved(id: string): Promise<RemoteTestResult>
    uri(id: string): Promise<string | null>
    /** concrete hosts from ~/.ssh/config, for the SFTP import list */
    sshConfig(): Promise<SshConfigHost[]>
    forgetHostKey(id: string): Promise<boolean>
    clearCache(): Promise<boolean>
  }
  preview(p: string, maxKB?: number): Promise<Preview | null>
  /**
   * The embedded HTML5 player. Unsupported containers/codecs are prepared by system FFmpeg in
   * main; the renderer only ever receives an absolute file path or a progress job.
   */
  player: {
    open(path: string): Promise<PlayerOpen>
    cancel(id: string): Promise<boolean>
    saveFrame(path: string, at: number): Promise<{ path: string } | { error: string }>
    capabilities(): Promise<PlayerCapabilities>
    onEvent(cb: (e: PlayerEvent) => void): () => void
    onWindowClosed(cb: (kind: 'music' | 'video') => void): () => void
  }
  hash(paths: string[], algo: string): Promise<HashResult[]>
  pathForFile(file: File): string
  jobs: {
    start(
      kind: JobKind,
      sources: string[],
      dest: string,
      opts?: {
        conflict?: ConflictPolicy
        skipExisting?: boolean
        newerOnly?: boolean
        limitBps?: number
      }
    ): Promise<Job>
    pause(id: string): Promise<void>
    resume(id: string): Promise<void>
    cancel(id: string): Promise<void>
    list(): Promise<Job[]>
    files(id: string): Promise<JobLog | null>
    clear(): Promise<void>
    onUpdate(cb: (job: Job) => void): () => void
  }
  app: {
    onOpenPath(cb: (p: string) => void): () => void
    /** the path the process was launched with (null when started normally) */
    launchPath(): Promise<string | null>
    /** open the image viewer, text editor, music player or video window */
    openViewer(
      kind: 'gallery' | 'editor' | 'music' | 'video',
      path: string
    ): Promise<{ ok: true } | { error: string }>
    /** KDE/Plasma only: make an image the desktop background, optionally with a `-f` fill mode */
    setWallpaper(path: string, fillMode?: string): Promise<{ ok: true } | { error: string }>
    /** Ctrl+Q / ⌘Q: quit for real, even when the window is set to hide in the tray */
    quit(): Promise<boolean>
  }
  undo: { run(): Promise<{ done: number; label: string }>; depth(): Promise<number> }
  window: {
    minimize(): Promise<void>
    maximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    setFullscreen(on: boolean): Promise<boolean>
    getChrome(): Promise<Chrome>
    setChrome(c: Chrome): Promise<Chrome>
    setTray(a: { minimize: boolean; close: boolean; show: string; quit: string }): Promise<{
      minimize: boolean
      close: boolean
    }>
    onMaximized(cb: (max: boolean) => void): () => void
    onFullscreen(cb: (on: boolean) => void): () => void
  }
  state: {
    get(): Promise<StoredState | null>
    set(s: StoredState): Promise<boolean>
    setPrefs(prefs: Record<string, unknown>): Promise<boolean>
    /** merge a single preference (used by the standalone viewer/editor windows) */
    patchPrefs(patch: Record<string, unknown>): Promise<Record<string, unknown>>
    onPrefsPatch(cb: (patch: Record<string, unknown>) => void): () => void
    /** bookmarks live in the shared window state; the dialog and the sidebar read the same list */
    marks(change?: { path: string; on: boolean }): Promise<string[]>
    onMarks(cb: (marks: string[]) => void): () => void
  }
}

/** The cross-window music bridge; the player itself never leaves the main window. */
export type MusicBridge = {
  push(state: MusicWindowState): void
  onCmd(cb: (cmd: MusicCommand) => void): () => void
  send(cmd: MusicCommand): void
  onState(cb: (state: MusicWindowState) => void): () => void
}

declare global {
  interface Window {
    api: Api
    musicBridge: MusicBridge
  }
}

export const api = window.api
export const musicBridge = window.musicBridge
