import type { PortalFilter } from '../../shared/portal-filters.ts'

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

export type Tags = {
  title?: string
  artist?: string
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
export type SyncRow = {
  rel: string
  state: string
  left?: { size: number; mtime: number; ctime: number; dir: boolean }
  right?: { size: number; mtime: number; ctime: number; dir: boolean }
}
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
  format?: { view?: string; columns?: string[]; sortKey?: string; sortAsc?: boolean } | null
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
  state: JobState
  bytes: number
  done: number
  files: number
  filesDone: number
  speed: number
  skipped?: number
  current: string
  errors: string[]
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
  view?: 'list' | 'grid'
  marks?: string[]
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
  format?: { view?: string; columns?: string[]; sortKey?: string; sortAsc?: boolean } | null
}
export type PreviewKind = 'dir' | 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'office' | 'binary'
export type Preview = {
  kind: PreviewKind
  size: number
  mtime: number
  text?: string
  capped?: boolean
}
export type HashResult = { path: string; hash: string | null }
export type IconRef = { name: string; path: string }
export type IconTheme = { name: string; dir: string }

export type FileProperties = {
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
  archive(p: string): Promise<{ entries: Entry[]; capped: boolean }>
  registerHotkey(accel: string): Promise<{ ok: boolean; accel: string }>
  runScript(
    command: string,
    path?: string,
    dir?: string
  ): Promise<{ ok: true; output: string } | { error: string }>
  runCustomCommand(command: string, path: string): Promise<{ ok: true } | { error: string }>
  openTerminal(dir: string): Promise<{ ok: true } | { error: string }>
  reveal(path: string): Promise<{ ok: true } | { error: string }>
  isDefaultFileManager(): Promise<boolean>
  setDefaultFileManager(): Promise<{ ok: boolean; error?: string }>
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
    mount(device: string): Promise<{ ok: boolean; mountpoint?: string; error?: string }>
    unmount(deviceOrMount: string): Promise<{ ok: boolean; error?: string }>
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
  saveImageAs(src: string, dataUrl: string): Promise<{ path: string } | { error: string }>
  convertImages(
    files: string[],
    opts: { format: 'jpeg' | 'png' | 'webp'; maxSide: number; quality: number; dest?: string }
  ): Promise<{ done: number; errors: string[]; outDir: string }>
  exportListing(
    dir: string,
    name: string,
    rows: unknown,
    format: 'csv' | 'pdf',
    theme?: string
  ): Promise<{ path: string; rows: number } | { error: string }>
  syncCompare(
    left: string,
    right: string,
    opts?: { compareBy?: 'mtime' | 'ctime' | 'hash'; ignore?: string[]; deep?: boolean }
  ): Promise<{ rows: SyncRow[]; leftCount: number; rightCount: number; capped: boolean }>
  syncApply(
    left: string,
    right: string,
    rows: SyncRow[],
    mode: 'ltr' | 'rtl',
    deleteExtra?: boolean
  ): Promise<{ copied: number; deleted: number; skipped: number; errors: string[] }>
  diffFiles(a: string, b: string): Promise<DiffResult>
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
    dir: string,
    name: string,
    sources: string[],
    level?: number
  ): Promise<{ path: string; files: number; bytes: number } | { error: string }>
  extract(archive: string, names: string[], dest: string): Promise<Result>
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
  renameMany(pairs: { from: string; to: string }[]): Promise<Result>
  open(p: string): Promise<{ ok: true } | { error: string }>
  clipboard: {
    releaseFiles(): Promise<boolean>
    copyFiles(paths: string[], cut?: boolean): Promise<'files' | 'text'>
    writeText(text: string): Promise<boolean>
    saveImage(dir: string, name: string, data: Uint8Array): Promise<{ path: string } | { error: string }>
  }
  apps: {
    list(p: string): Promise<DesktopApp[]>
    openWith(p: string, all?: boolean): Promise<OpenWithInfo>
    setDefault(p: string, id: string): Promise<{ ok: true } | { error: string }>
    default(p: string): Promise<{ id: string; name: string } | null>
    launch(id: string, p: string): Promise<{ ok: true } | { error: string }>
  }
  preview(p: string, maxKB?: number): Promise<Preview | null>
  hash(paths: string[], algo: string): Promise<HashResult[]>
  pathForFile(file: File): string
  jobs: {
    start(
      kind: JobKind,
      sources: string[],
      dest: string,
      opts?: { skipExisting?: boolean; newerOnly?: boolean; limitBps?: number }
    ): Promise<Job>
    pause(id: string): Promise<void>
    resume(id: string): Promise<void>
    cancel(id: string): Promise<void>
    list(): Promise<Job[]>
    clear(): Promise<void>
    onUpdate(cb: (job: Job) => void): () => void
  }
  app: {
    onOpenPath(cb: (p: string) => void): () => void
    /** the path the process was launched with (null when started normally) */
    launchPath(): Promise<string | null>
    /** open the image viewer or the text editor in its own window */
    openViewer(kind: 'gallery' | 'editor', path: string): Promise<{ ok: true } | { error: string }>
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

declare global {
  interface Window {
    api: Api
  }
}

export const api = window.api
