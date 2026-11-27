import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  net,
  protocol,
  screen,
  shell,
  type Rectangle
} from 'electron'
import {
  createReadStream,
  constants as fsConstants,
  existsSync,
  readFileSync,
  writeFileSync,
  watch as fsWatch,
  promises as fs
} from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  createArchive,
  extract,
  isArchiveEncryption,
  isArchiveFormat,
  listArchive,
  verifyArchive
} from './archives.ts'
import { openTarget } from './launch-path.ts'
import { saveImage, saveImageAs } from './image.ts'
import { hashMany } from './hash.ts'
import { iconSetPaths, iconsIn, themeDirs } from './icons.ts'
import { readNativeFolderLook } from './folderlook.ts'
import { preview } from './preview.ts'
import { probeMedia } from './ffmpeg.ts'
import { parseByteRange } from './player-core.ts'
import {
  cancelPlayerJob,
  ffmpegCapabilities,
  initPlayer,
  openPlayerFile,
  saveVideoFrame,
  stopPlayerJobs
} from './player.ts'
import {
  LABELS,
  readMeta,
  setEntryColor,
  setFormat,
  setLabel,
  setMeta,
  setNote,
  setRating,
  togglePin,
  toggleShown,
  type FolderFormat,
  type FolderMeta
} from './meta.ts'
import { htmlToPdf, readTextFile, writeTextFile } from './editor.ts'
import { importUserFont, listUserFonts, readUserFont, removeUserFont } from './fonts.ts'
import { stopWinETakeover, winETakeover } from './wine-hook.ts'
import { fitWindow } from './window-bounds.ts'
import {
  clearDefaultFileManagerWindows,
  defaultApp,
  isDefaultFileManager,
  isRunnableFile,
  launchApp,
  listApps,
  mimeForPath,
  openWithDefault,
  openWithInfo,
  runFile,
  runFileAsAdmin,
  setDefaultApp,
  setDefaultFileManager,
  shortcutTarget,
  type DesktopApp
} from './apps.ts'
import { appIconFile } from './appicons.ts'
import { revealFile, runCustomCommand, openShellNamespace, startFileDrag } from './desktop.ts'
import { autoTerminal, listTerminals, openTerminal } from './terminals.ts'
import { setDesktopWallpaper } from './wallpaper.ts'
import { readTags, writeId3 } from './metadata.ts'
import {
  cleanAudioFields,
  readAudioCover,
  readAudioTags,
  writeAudioTags,
  type AudioWriteRequest
} from './audioTags.ts'
import { execFile } from 'node:child_process'
import { clearThumbs, thumbFor } from './thumbs.ts'
import { RAW_IMAGE_MAX_BYTES, rawImageType } from './image-mime.ts'
import {
  clearIndex,
  indexRoots,
  indexSizes,
  indexStats,
  searchIndex,
  type IndexConfig
} from './searchdb.ts'
import { checkUpdate, openRelease } from './updates.ts'
import { migrateLegacyStore, readStore, writeStore } from './store.ts'
import { createDrafts } from './drafts.ts'
import {
  mcpFile,
  logMcpError,
  mcpLogTail,
  mcpTools,
  readMcpConfig,
  startMcp,
  stopMcp,
  writeMcpConfig,
  type McpMode
} from './mcp.ts'
import { randomBytes } from 'node:crypto'
import { copyFilesToClipboard, readClipboardFiles, releaseFileClipboard } from './fileclip.ts'
import { diffFiles } from './sync.ts'
import {
  cleanEncryption,
  cleanIgnoreRules,
  cleanRsyncOptions,
  cleanVersions,
  type SyncEncryption,
  type SyncIgnoreRule
} from '../shared/sync.ts'
import { createSyncService } from './sync-service.ts'
import {
  createCloudService,
  type CloudAccountDraft,
  type CloudBindingDraft,
  type CloudBindingPatch
} from './cloud-service.ts'
import { generateKeypair, looksLikeIdentity, recipientOf } from './sync-crypt.ts'
import { getSyncSecret, hasSyncSecret, removeSyncSecret, setSyncSecret } from './sync-secrets.ts'
import { resticAvailable } from './sync-versions.ts'
import { convertImages, type ConvertOpts } from './convert.ts'
import { exportListing, type ExportRow } from './export.ts'
import { createEngine, type JobKind, type JobOpts } from './jobs.ts'
import { createSymlink, freeName, remove } from './ops.ts'
import { createShortcuts } from './shortcut.ts'
import { findDupes, walk, type WalkOpts } from './search.ts'
import { breakdown, type BreakdownMode } from './breakdown.ts'
import { listDrives, listVolumes, mountDrive, unmountDrive } from './drives.ts'
import { memoryInfo } from './system.ts'
import { dirs } from './dirs.ts'
import { mediaPathFromUrl } from './media-path.ts'
import {
  isRemotePath,
  parseRemote,
  remoteDir,
  remoteJoin,
  remoteName,
  remoteProtocolLabel
} from '../shared/remote-path.ts'
import {
  forgetRemoteHostKey,
  listRemoteProfiles,
  readSshConfigHosts,
  remoteFs,
  remoteFsCompressed,
  remoteProfileUri,
  removeRemoteProfile,
  saveRemoteProfile,
  testRemoteDraft,
  testSavedProfile
} from './remotes.ts'
import { createRemoteCache, type RemoteCache } from './remote-cache.ts'
import { closeFtpClients } from './remote-ftp.ts'
import type { DirRef, Entry } from './types.ts'
import type { ProfileDraft } from '../shared/remote-profile.ts'
import { conflictOf, type ConflictPolicy } from '../shared/conflict.ts'
import { BUNDLED_FONTS } from '../shared/fonts.ts'
import { PortalServer, type PortalRequestData } from './portal.ts'
import { installPortal, portalInstalled, uninstallPortal } from './portal-install.ts'

// mfm:// serves local files to <img> so the renderer never gets a filesystem API.
protocol.registerSchemesAsPrivileged([
  { scheme: 'mfm', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

type Chrome = { customTitlebar: boolean; rounded: boolean }

/** Created after `app.ready` (it lives under userData); every remote viewer goes through it. */
let remoteCache: RemoteCache | null = null
const cacheFor = (): RemoteCache => {
  if (!remoteCache) throw new Error('the remote cache is not ready yet')
  return remoteCache
}

const idCache = new Map<string, string>()
/** one drag-debug session per process: the header line is written once */
let debugLogStarted = false

/** Resolve a uid/gid to a name with `getent`; a missing entry keeps the number. */
function ownerName(kind: 'passwd' | 'group', id: number): Promise<string> {
  const key = `${kind}:${id}`
  const cached = idCache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)
  return new Promise((resolve) => {
    const done = (name: string) => {
      idCache.set(key, name)
      resolve(name)
    }
    try {
      const child = execFile('getent', [kind, String(id)], { timeout: 1000 }, (err, out) => {
        const name = err ? '' : String(out).split(':')[0].trim()
        done(name || String(id))
      })
      child.on('error', () => done(String(id)))
    } catch {
      done(String(id))
    }
  })
}

/** Read synchronously, before `ready`: frame/transparent and the instance lock need it that early. */
function bootState(): any {
  try {
    migrateLegacyStore()
    return readStore('state') ?? {}
  } catch {
    return {}
  }
}

/**
 * Editor drafts live in the same app table as the settings: one key per file plus an index, so a
 * crash or a closed window never loses typing. Expired/over-quota drafts are pruned on boot.
 */
const drafts = createDrafts({
  get: (key) => readStore<string>(key),
  set: (key, value) => writeStore(key, value)
})
try {
  drafts.prune()
} catch {
  // a broken index must never stop the app from starting
}

const boot = bootState()
const bootPrefs = boot.prefs ?? {}

// Plasma 6 runs kwalletd6 only; Chromium's auto-detected "kwallet" backend looks for the unversioned
// bus name, comes up unusable, and then every stored secret reads as «not available» — the cloud token
// (`cloud-store.ts`) and remote passwords (`remotes.ts`). Name the backend the session actually runs
// before OSCrypt initializes; it is read once, so this has to happen before app ready.
const kdeVersion = process.env['KDE_SESSION_VERSION']
if (
  process.platform === 'linux' &&
  (kdeVersion === '5' || kdeVersion === '6') &&
  !process.argv.some((a) => a.startsWith('--password-store'))
) {
  app.commandLine.appendSwitch('password-store', `kwallet${kdeVersion}`)
}

// frame/transparent are window-construction options, so the chrome choice is read before the window exists
/**
 * One sync service for the app: saved jobs, the queue and the scheduler. It reads the jobs from the
 * same prefs blob the renderer writes, so a job is never duplicated in a second store.
 */
const syncService = createSyncService({
  remote: remoteFs,
  remoteCompressed: remoteFsCompressed,
  trash: (p) => shell.trashItem(p),
  emit: (channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  }
})

/**
 * Cloud folders: accounts and bindings in the same SQLite store, the existing sync engine for the
 * actual work. Started with the window; the scheduler is a single 30 s tick, never a timer per
 * folder.
 */
const cloudService = createCloudService({
  remote: remoteFs,
  trash: (p) => shell.trashItem(p),
  emit: (channel, payload) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload)
    }
  }
})

// frame/transparent are window-construction options, so the chrome choice is read before the window exists
let chrome: Chrome = {
  customTitlebar: bootPrefs.titlebar !== 'system' && boot.chrome?.customTitlebar !== false,
  rounded: bootPrefs.rounded !== false && boot.chrome?.rounded !== false
}
let win: BrowserWindow | null = null

const incoming = openTarget(process.argv, app.getAppPath() || process.cwd())
const firstPath = incoming?.kind === 'path' ? incoming.value : null
const portalOnly = process.argv.includes('--portal-backend')

// macOS hands "open this folder" over as an Apple event, not argv; queue it until the window exists
const pendingOpens: string[] = []
app.on('open-file', (e, p) => {
  e.preventDefault()
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('app:open-path', p)
  } else {
    pendingOpens.push(p)
  }
})

// single instance: a second launch focuses the window and opens the path it was given.
// The portal backend has no window and holds its D-Bus name for the whole session, so the lock must
// skip it: while it owned the lock every normal launch exited silently and no window ever appeared.
if (bootPrefs.singleInstance !== false && !process.env['SMOKE_SHOT'] && !portalOnly) {
  if (!app.requestSingleInstanceLock()) {
    // Exit synchronously: app.quit() still let `whenReady` run and bind the MCP port that the
    // first instance owns, which surfaced as EADDRINUSE + a main-process error dialog.
    process.exit(0)
  }
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--portal-backend')) void portalServer.start().catch(() => undefined)
    const target = openTarget(argv, app.getAppPath() || process.cwd())
    // a special folder (Control Panel, This PC…) belongs to Explorer: hand it back, leave this window alone
    if (target?.kind === 'shell') {
      openShellNamespace(target.value)
      return
    }
    if (!win || portalOnly) return
    forceForeground(win)
    if (target) win.webContents.send('app:open-path', target.value)
  })
}

/**
 * A shell-namespace target is not a folder this app can list, so it is never accepted: it goes back
 * to Explorer and this launch leaves no window behind. Only reached by the process that owns the
 * single-instance lock — a later launch forwards its argv to the running window instead, and the
 * `second-instance` handler above delegates the same way.
 */
if (incoming?.kind === 'shell') {
  openShellNamespace(incoming.value)
  process.exit(0)
}

/** Sizes/mtimes need one stat per file; chunked so a 10k-file folder can't exhaust fds. */
async function fillStats(entries: Entry[]): Promise<void> {
  for (let i = 0; i < entries.length; i += 128) {
    await Promise.all(
      entries.slice(i, i + 128).map(async (e) => {
        const st = await fs.stat(e.path).catch(() => null) // follows symlinks; broken link keeps dirent type
        if (!st) return
        e.dir = st.isDirectory()
        e.size = st.size
        e.mtime = st.mtimeMs
        e.mode = st.mode
        e.uid = st.uid
        e.gid = st.gid
        e.nlink = st.nlink
      })
    )
  }
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'])

async function list(dir: string, showHidden: boolean, dims = false) {
  const meta = await readMeta(dir).catch(() => null)
  const forced = new Set(meta?.shown ?? [])
  const dirents = await fs.readdir(dir, { withFileTypes: true })
  let entries: Entry[] = dirents
    .filter((d) => showHidden || !d.name.startsWith('.') || forced.has(d.name))
    .map((d) => ({
      name: d.name,
      path: path.join(dir, d.name),
      dir: d.isDirectory(),
      size: 0,
      mtime: 0,
      ext: path.extname(d.name).slice(1).toLowerCase(),
      link: d.isSymbolicLink() || undefined,
      forceShow: forced.has(d.name) || undefined
    }))
  await fillStats(entries)
  // folder look comes from the folder's own marker file; capped so a 5k-folder directory stays quick
  const folders = entries.filter((e) => e.dir).slice(0, 1000)
  for (let i = 0; i < folders.length; i += 64) {
    await Promise.all(
      folders.slice(i, i + 64).map(async (e) => {
        const m = await readMeta(e.path)
        if (m?.hidden) e.hidden = true
        if (m?.color) e.color = m.color
        if (m?.icon) {
          e.icon = m.icon
          return
        }
        // a colour picked in this app is an explicit choice: keep our tinted glyph, not the theme's
        if (m?.color) return
        // Dolphin's `.directory` and Windows' desktop.ini already carry an icon: honour it
        const native = await readNativeFolderLook(e.path)
        if (native.icon) e.icon = native.icon
      })
    )
  }
  // «don't list me» follows the hidden-files switch, exactly like Dolphin's hidden attribute
  if (!showHidden) entries = entries.filter((e) => !e.hidden || e.forceShow)
  // pixel size needs a decoder, so it is opt-in and capped
  if (dims) {
    const images = entries.filter((e) => !e.dir && IMAGE_EXT.has(e.ext) && e.size < 20_000_000).slice(0, 400)
    for (const e of images) {
      const size = nativeImage.createFromPath(e.path).getSize()
      if (size.width) {
        e.w = size.width
        e.h = size.height
      }
    }
  }
  const parent = path.dirname(dir)
  return { path: dir, parent: parent === dir ? null : parent, entries }
}

/** One listing path for the two stores; callers never care which protocol answers. */
async function listAny(dir: string, showHidden: boolean, dims = false) {
  if (!isRemotePath(dir)) return list(dir, showHidden, dims)
  const remote = await remoteFs.list(dir, showHidden)
  return {
    ...remote,
    pins: [],
    labels: {},
    ratings: {},
    notes: {},
    format: null
  }
}

async function dirsAny(dir: string, showHidden = false, followLinks = false): Promise<DirRef[]> {
  if (isRemotePath(dir)) return remoteFs.dirs(dir, showHidden)
  return dirs(dir, { showHidden, followLinks })
}

const remoteVersionOf = async (p: string): Promise<string> => {
  if (!isRemotePath(p)) {
    const st = await fs.stat(p).catch(() => null)
    return st ? `${st.mtimeMs}-${st.size}` : ''
  }
  const st = await remoteFs.stat(p).catch(() => null)
  return st ? `${st.mtime}-${st.size}` : ''
}

/** A real local path for any entry: local paths pass through, remote ones are cached first. */
async function localCopyOf(p: string, version = '', maxBytes?: number): Promise<string> {
  if (!isRemotePath(p)) return p
  return cacheFor().ensure(p, version, maxBytes ? { maxBytes } : {})
}

async function propertiesAny(p: string): Promise<Record<string, unknown>> {
  return isRemotePath(p) ? remoteFs.properties(p) : propertiesOf(p)
}

async function sizeAny(p: string): Promise<{ bytes: number; files: number; capped: boolean }> {
  if (isRemotePath(p)) return remoteFs.measure(p)
  return dirSize(p)
}

async function previewAny(p: string, maxKB?: number) {
  if (!isRemotePath(p)) return preview(p, maxKB)
  const st = await remoteFs.stat(p)
  if (!st) return null
  if (st.dir) return { kind: 'dir' as const, size: 0, mtime: st.mtime }
  const local = await localCopyOf(p, `${st.mtime}-${st.size}`, 256 * 1024 * 1024)
  const pv = await preview(local, maxKB)
  return { ...pv, size: st.size, mtime: st.mtime }
}

async function hashAny(paths: string[], algo: string) {
  const local: string[] = []
  for (const p of (paths ?? []).slice(0, 500)) {
    if (isRemotePath(p)) {
      try {
        local.push(await localCopyOf(p, await remoteVersionOf(p)))
      } catch {
        // hashMany reports a missing file instead of failing the whole batch
      }
    } else if (path.isAbsolute(p)) local.push(p)
  }
  return hashMany(local, algo || 'sha256')
}

async function readTextAny(p: string) {
  if (!isRemotePath(p)) return readTextFile(p)
  return remoteFs.readText(p)
}

async function writeTextAny(p: string, text: string) {
  if (!isRemotePath(p)) return writeTextFile(p, text)
  return remoteFs.writeText(p, text)
}

/** Editing a remote image: edit the cached copy, then push it back to its real home. */
async function saveImageAny(src: string, dataUrl: string, mode: 'overwrite' | 'copy') {
  if (!isRemotePath(src)) return saveImage(src, dataUrl, mode)
  const st = await remoteFs.stat(src)
  if (!st || st.dir) return { error: 'not_found' }
  const local = await localCopyOf(src, `${st.mtime}-${st.size}`)
  const saved = await saveImage(local, dataUrl, mode)
  if ('error' in saved) return saved
  try {
    if (mode === 'overwrite') {
      await remoteFs.uploadFile(local, src)
      return { path: src }
    }
    const target = await remoteFs.freeName(remoteJoin(remoteDir(src), path.basename(saved.path)))
    await remoteFs.uploadFile(saved.path, target)
    return { path: target }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

async function saveImageAsAny(src: string, dataUrl: string, dest?: string) {
  const remoteSource = isRemotePath(src)
  const remoteDest = !!dest && isRemotePath(dest)
  if (!remoteSource && !remoteDest) return saveImageAs(src, dataUrl, dest)
  const localSource = remoteSource ? await localCopyOf(src, await remoteVersionOf(src)) : src
  if (!remoteDest) return saveImageAs(localSource, dataUrl, dest)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mfm-save-'))
  try {
    const saved = await saveImageAs(localSource, dataUrl, tmp)
    if ('error' in saved) return saved
    const target = await remoteFs.freeName(remoteJoin(dest!, path.basename(saved.path)))
    await remoteFs.uploadFile(saved.path, target)
    return { path: target }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function clipboardImageAny(dir: string, name: string, data: Uint8Array) {
  if (!isRemotePath(dir)) return saveClipboardImage(dir, name, data)
  const buf = Buffer.from(data ?? [])
  if (!buf.length || buf.length > 50 * 1024 * 1024) return { error: 'bad_image' }
  try {
    const safe = /^[\w.-]{1,80}$/.test(name ?? '') ? name : 'clipboard.png'
    const target = await remoteFs.freeName(remoteJoin(dir, safe))
    await remoteFs.writeBuffer(target, buf)
    return { path: target }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

async function removeAnyPaths(paths: string[], permanent: boolean): Promise<{ done: number; errors: string[] }> {
  const errors: string[] = []
  let done = 0
  const local: string[] = []
  for (const p of paths) {
    if (!isRemotePath(p)) {
      local.push(p)
      continue
    }
    try {
      await remoteFs.remove(p)
      done++
    } catch (e) {
      errors.push(`${remoteName(p)}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (local.length) {
    const r = await remove(local, permanent ? {} : { trash: (p) => shell.trashItem(p) })
    done += r.done
    errors.push(...r.errors)
  }
  return { done, errors }
}

/** Serve an existing local file with the byte-range headers Chromium needs for media. */
async function serveLocalFile(req: Request, p: string): Promise<Response> {
  const st = await fs.stat(p).catch(() => null)
  if (!st?.isFile()) return new Response('not found', { status: 404 })
  const headers = new Headers({
    'Content-Type': mimeForPath(p),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    // without CORS the renderer can display the image but a canvas stays tainted and cannot be saved
    'Access-Control-Allow-Origin': '*'
  })
  const range = parseByteRange(req.headers.get('range'), st.size)
  const head = req.method === 'HEAD'
  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${st.size}`)
    headers.set('Content-Length', String(range.end - range.start + 1))
    if (head) return new Response(null, { status: 206, headers })
    const stream = createReadStream(p, { start: range.start, end: range.end })
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
      status: 206,
      headers
    })
  }
  headers.set('Content-Length', String(st.size))
  if (head) return new Response(null, { status: 200, headers })
  return new Response(Readable.toWeb(createReadStream(p)) as unknown as ReadableStream<Uint8Array>, {
    status: 200,
    headers
  })
}

/** `mfm://remote/<encoded remote URI>?v=…` → the remote location and its listing version. */
function remoteFromMediaUrl(raw: string): { uri: string; version: string } | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.hostname !== 'remote') return null
  try {
    const uri = decodeURIComponent(u.pathname.replace(/^\//, ''))
    return isRemotePath(uri) ? { uri, version: u.searchParams.get('v') ?? '' } : null
  } catch {
    return null
  }
}

/** Subfolders only, no stat: what the sidebar tree needs. */

const isDir = (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false)

/** Mount points + home, so removable media show up without a volume manager. */
async function roots(): Promise<DirRef[]> {
  const out: DirRef[] = []
  if (process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const p = `${letter}:\\`
      if (await isDir(p)) out.push({ name: p, path: p })
    }
    return out
  }
  out.push({ name: '/', path: '/' }, { name: '~', path: os.homedir() })
  const user = os.userInfo().username
  for (const base of ['/mnt', `/media/${user}`, `/run/media/${user}`]) {
    const kids = await fs.readdir(base, { withFileTypes: true }).catch(() => [])
    for (const k of kids) if (k.isDirectory()) out.push({ name: k.name, path: path.join(base, k.name) })
  }
  return out
}

// shortcut: folder size stops at 200k entries / 4s and admits it; upgrade to a worker + cache table.
async function dirSize(root: string): Promise<{ bytes: number; files: number; capped: boolean }> {
  let bytes = 0
  let files = 0
  let capped = false
  const deadline = Date.now() + 4000
  const stack = [root]
  while (stack.length) {
    if (files > 200_000 || Date.now() > deadline) {
      capped = true
      break
    }
    const dir = stack.pop()!
    const kids = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const k of kids) {
      const p = path.join(dir, k.name)
      if (k.isDirectory()) stack.push(p)
      else {
        const st = await fs.stat(p).catch(() => null)
        if (st) {
          bytes += st.size
          files++
        }
      }
    }
  }
  return { bytes, files, capped }
}

async function readState(): Promise<any> {
  return readStore('state')
}

/** Writes only the chrome key, so the renderer's session state is never clobbered. */
async function saveChrome(next: Chrome): Promise<void> {
  const st = (await readState()) ?? {}
  writeStore('state', { ...st, chrome: next })
}


/** Settings export/import: one JSON file with the preference object, validated by the renderer. */
async function writeSettingsFile(file: string, prefs: unknown) {
  const payload = {
    app: 'max-file-manager',
    format: 1,
    exportedAt: new Date().toISOString(),
    prefs
  }
  const partial = file + '.part'
  await fs.writeFile(partial, JSON.stringify(payload, null, 2))
  await fs.rename(partial, file)
  return { path: file }
}

function parseSettings(raw: string): { prefs?: Record<string, unknown>; error?: string } {
  try {
    const j = JSON.parse(raw)
    const prefs = j && typeof j === 'object' && 'prefs' in j ? j.prefs : j
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return { error: 'not a settings file' }
    return { prefs: prefs as Record<string, unknown> }
  } catch {
    return { error: 'invalid JSON' }
  }
}

async function readSettingsFile(file: string) {
  const raw = await fs.readFile(file, 'utf8').catch(() => '')
  if (!raw) return { error: 'file is not readable' }
  return parseSettings(raw)
}

/** Native file pickers; the MCP path variant never shows a dialog. */
async function saveSettingsDialog(prefs: unknown) {
  const opts = {
    title: 'Export settings',
    defaultPath: path.join(os.homedir(), 'max-file-manager-settings.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (r.canceled || !r.filePath) return { canceled: true }
  return writeSettingsFile(r.filePath, prefs)
}

async function openSettingsDialog() {
  const opts = {
    title: 'Import settings',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile' as const]
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (r.canceled || !r.filePaths[0]) return { canceled: true }
  return readSettingsFile(r.filePaths[0])
}

/** Run the user's own script text with {path}/{dir} shell-quoted; shared with the MCP tool. */
async function runScriptCommand(a: { command?: string; path?: string; dir?: string }) {
  const cmd = String(a?.command ?? '').trim()
  if (!cmd) return { error: 'دستوری تعریف نشده' }
  const dir = path.isAbsolute(a?.dir ?? '') ? a!.dir! : os.homedir()
  const target = a?.path && path.isAbsolute(a.path) ? a.path : ''
  const line = cmd
    .replace(/\{path\}|%f/g, target ? `'${target.replace(/'/g, `'\\''`)}'` : '')
    .replace(/\{dir\}|%d/g, `'${dir.replace(/'/g, `'\\''`)}'`)
  return new Promise<Record<string, unknown>>((resolve) => {
    execFile('sh', ['-c', line], { cwd: dir, timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim().slice(0, 2000)
      resolve(err ? { error: out || err.message } : { ok: true, output: out })
    })
  })
}

/** Save pasted/clipboard image bytes as a normal file; the free name never overwrites. */
async function saveClipboardImage(dir: string, name: string, data: Uint8Array) {
  if (!path.isAbsolute(dir)) return { error: 'bad_dir' }
  const stat = await fs.stat(dir).catch(() => null)
  if (!stat?.isDirectory()) return { error: 'bad_dir' }
  const buf = Buffer.from(data ?? [])
  if (!buf.length || buf.length > 50 * 1024 * 1024) return { error: 'bad_image' }
  const safe = /^[\w.-]{1,80}$/.test(name ?? '') ? name : 'clipboard.png'
  const target = await freeName(path.join(dir, safe))
  const partial = target + '.part'
  await fs.writeFile(partial, buf)
  await fs.rename(partial, target)
  return { path: target }
}

/** Everything the properties dialog shows, in one stat round-trip; also the MCP `properties` tool. */
async function propertiesOf(p: string): Promise<Record<string, unknown>> {
  if (!path.isAbsolute(p)) return { error: 'bad_path' }
  const link = await fs.lstat(p).catch(() => null)
  if (!link) return { error: 'not_found' }
  const symbolic = link.isSymbolicLink()
  const target = symbolic ? await fs.readlink(p).catch(() => '') : ''
  const st = symbolic ? await fs.stat(p).catch(() => null) : link
  if (!st) return { error: 'not_found' }
  const [readable, writable, executable, user, group] = await Promise.all([
    fs.access(p, fsConstants.R_OK).then(() => true, () => false),
    fs.access(p, fsConstants.W_OK).then(() => true, () => false),
    fs.access(p, fsConstants.X_OK).then(() => true, () => false),
    ownerName('passwd', st.uid),
    ownerName('group', st.gid)
  ])
  const ext = path.extname(p).slice(1).toLowerCase()
  const dir = st.isDirectory()
  let items: number | null = null
  if (dir) items = (await fs.readdir(p).catch(() => [])).length
  let dims: { w: number; h: number } | null = null
  if (!dir && IMAGE_EXT.has(ext)) {
    const size = nativeImage.createFromPath(p).getSize()
    if (size.width) dims = { w: size.width, h: size.height }
  }
  return {
    name: path.basename(p) || p,
    path: p,
    dir,
    size: st.size,
    ext,
    mode: st.mode & 0o777,
    readable,
    writable,
    executable,
    uid: st.uid,
    gid: st.gid,
    user,
    group,
    nlink: st.nlink,
    inode: Number(st.ino),
    device: Number(st.dev),
    birthtime: st.birthtimeMs,
    mtime: st.mtimeMs,
    atime: st.atimeMs,
    ctime: st.ctimeMs,
    link: symbolic,
    target,
    mime: mimeForPath(p),
    items,
    dims
  }
}

/** Image bytes as a data URL; shared by the gallery editor and the MCP `image_get` tool. */
async function readImageData(p: string): Promise<{ dataUrl?: string; error?: string }> {
  if (!path.isAbsolute(p)) return { error: 'مسیر نامعتبر' }
  const st = await fs.stat(p).catch(() => null)
  if (!st || st.size > 40_000_000) return { error: 'فایل بیش از ۴۰ مگابایت است' }
  const ext = path.extname(p).slice(1).toLowerCase()
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'webp' ? 'webp' : 'png'
  const buf = await fs.readFile(p).catch(() => null)
  if (!buf) return { error: 'خواندن فایل ممکن نشد' }
  return { dataUrl: `data:image/${mime};base64,${buf.toString('base64')}` }
}

/** Register the single global shortcut; a failure (Wayland) is reported, never hidden. */
function registerHotkey(accel: string): { ok: boolean; accel: string } {
  globalShortcut.unregisterAll()
  const a = String(accel ?? '').trim()
  if (!a) return { ok: false, accel: '' }
  // Win+E is owned by Explorer on Windows and needs a portal on Wayland; the caller shows the result
  const ok = globalShortcut.register(a, () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  return { ok, accel: a }
}

type SavedBounds = { x: number; y: number; width: number; height: number; maximized?: boolean }

function readBounds(): SavedBounds | null {
  const b = readStore<SavedBounds>('window')
  const ok =
    !!b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite((b as Record<string, unknown>)[k]))
  return ok ? b : null
}

/** Persist the *normal* bounds, so un-maximizing later still restores the last free size. */
function saveBounds(w: BrowserWindow | null): void {
  if (!w || w.isDestroyed()) return
  try {
    const b = w.getNormalBounds()
    writeStore('window', { ...b, maximized: w.isMaximized() })
  } catch {
    // a read-only config dir must not take the window down
  }
}

/**
 * The saved rectangle when it is still on a connected display, otherwise a centred
 * default on the primary screen. The decision itself is pure and unit-tested.
 */
function windowBounds(): { x: number; y: number; width: number; height: number } {
  const areas = screen.getAllDisplays().map((d) => d.workArea)
  return fitWindow(readBounds(), areas, screen.getPrimaryDisplay().workArea, {
    width: 1320,
    height: 860,
    minWidth: 780,
    minHeight: 480
  })
}

function windowIcon(): string | undefined {
  const dev = path.join(app.getAppPath(), 'build/icon.png')
  if (existsSync(dev)) return dev
  const packed = path.join(process.resourcesPath ?? '', 'icon.png')
  return existsSync(packed) ? packed : undefined
}

const portalServer = new PortalServer({
  preload: path.join(__dirname, '../preload/index.js'),
  rendererUrl: process.env['ELECTRON_RENDERER_URL'],
  rendererFile: path.join(__dirname, '../renderer/index.html'),
  icon: windowIcon()
})
let portalError = ''

let tray: Tray | null = null
let trayPrefs = { minimize: false, close: false }
let quitting = false
const singleInstanceEnabled = bootPrefs.singleInstance !== false

function showWindow(): void {
  forceForeground(win)
}

/**
 * Windows refuses the foreground to a process that was started by another process (the Win+E
 * helper), so `show()+focus()` leaves the window behind. The accepted workaround is to flip
 * always-on-top on for a moment: that makes the shell raise the window, and focus sticks.
 */
function forceForeground(w: BrowserWindow | null): void {
  if (!w || w.isDestroyed()) return
  if (w.isMinimized()) w.restore()
  w.show()
  if (process.platform === 'win32') {
    const top = w.isAlwaysOnTop()
    w.setAlwaysOnTop(true)
    w.moveTop()
    w.focus()
    w.setAlwaysOnTop(top)
  } else {
    w.focus()
  }
}

/**
 * macOS refuses native full screen for a transparent window: `setFullScreen(true)` returns
 * without resizing anything, so ⌃⌘F looked dead. Simple full screen emulates it (the app manages
 * its own window) and works with our frameless, transparent chrome.
 *
 * Other window managers (KWin under some settings, Xvfb without a WM) accept `setFullScreen` but
 * keep the frame/bounds. A frameless window placed on the display rect looks identical, so the
 * fallback below enforces that geometry and remembers the old bounds to restore on exit.
 */
const saved = new Map<number, Rectangle>()

function applyFullscreen(w: BrowserWindow, on: boolean): void {
  if (process.platform === 'darwin') {
    w.setSimpleFullScreen(on)
    return
  }
  w.setFullScreen(on)
  setTimeout(() => {
    if (w.isDestroyed()) return
    let forced = false
    if (on) {
      const b = w.getBounds()
      const d = screen.getDisplayMatching(b).bounds
      const covered =
        b.x === d.x && b.y === d.y && b.width === d.width && b.height === d.height
      if (!w.isFullScreen() || !covered) {
        if (!saved.has(w.id)) saved.set(w.id, b)
        w.setBounds(d)
        w.setAlwaysOnTop(true)
        w.setMenuBarVisibility(false)
        w.focus()
        forced = true
      }
    } else {
      const b = saved.get(w.id)
      if (b) {
        saved.delete(w.id)
        w.setAlwaysOnTop(false)
        w.setBounds(b)
        w.focus()
        forced = true
      }
    }
    console.log(
      'FULLSCREEN ' +
        JSON.stringify({
          on,
          forced,
          bounds: w.getBounds(),
          fullscreen: w.isFullScreen(),
          displays: screen.getAllDisplays().map((d) => d.bounds)
        })
    )
  }, 260)
}

/**
 * The macOS menu bar. Electron's default menu also installs an Edit menu whose ⌘C/⌘X/⌘V/⌘A/⌘Z
 * accelerators are matched *before* the page — so they did nothing in the file list while the
 * app's own file commands never saw the key. This menu keeps only what macOS needs (app menu and
 * window menu) and owns ⌃⌘F itself, because the default "Toggle Full Screen" item called the
 * native full screen that a transparent window cannot enter.
 */
function installMacMenu(): void {
  if (process.platform !== 'darwin') return
  const toggle = (): void => {
    const w = BrowserWindow.getFocusedWindow() ?? win
    if (!w || w.isDestroyed()) return
    const on = !w.isSimpleFullScreen()
    applyFullscreen(w, on)
    w.webContents.send('window:fullscreen-state', on)
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'View',
        submenu: [
          { label: 'Toggle Full Screen', accelerator: 'Control+Command+F', click: toggle }
        ]
      },
      { role: 'windowMenu' }
    ])
  )
}

function ensureTray(labels: { show: string; quit: string }): void {
  const wanted = singleInstanceEnabled && (trayPrefs.minimize || trayPrefs.close)
  if (!wanted) {
    tray?.destroy()
    tray = null
    return
  }
  if (!tray) {
    try {
      const src = windowIcon()
      const image = src ? nativeImage.createFromPath(src) : nativeImage.createEmpty()
      tray = new Tray(image.resize({ width: 22, height: 22 }))
      tray.setToolTip('Max File Manager')
      tray.on('click', showWindow)
      tray.on('double-click', showWindow)
    } catch {
      // no usable tray host: never hide the window with no way back
      tray = null
      trayPrefs = { minimize: false, close: false }
      return
    }
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.show, click: showWindow },
      { type: 'separator' },
      {
        label: labels.quit,
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

function createWindow(): BrowserWindow {
  const frameless = chrome.customTitlebar
  const transparent = frameless && chrome.rounded
  const saved = readBounds()
  const w = new BrowserWindow({
    title: 'Max File Manager',
    ...windowBounds(),
    minWidth: 780,
    minHeight: 480,
    frame: !frameless,
    transparent,
    backgroundColor: transparent ? '#00000000' : '#16181d',
    hasShadow: false,
    // macOS: a click in a background window should reach the list, not be swallowed by
    // activation. Without this the first press only raises the window and the drag never starts;
    // with it one gesture can select and drag out — the platform's drag-through then keeps the
    // window from covering the drop target.
    acceptFirstMouse: true,
    icon: windowIcon(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  const icon = windowIcon()
  if (icon) w.setIcon(icon)
  if (singleInstanceEnabled) {
    w.on('minimize', () => {
      if (trayPrefs.minimize) w.hide()
    })
    w.on('close', (e) => {
      if (!trayPrefs.close || quitting) return
      e.preventDefault()
      w.hide()
    })
  }
  w.on('ready-to-show', () => {
    forceForeground(w)
    if (saved?.maximized) w.maximize()
  })
  let boundsTimer: NodeJS.Timeout | null = null
  const remember = () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => saveBounds(w), 400)
  }
  w.on('resize', remember)
  w.on('move', remember)
  w.on('maximize', remember)
  w.on('unmaximize', remember)
  w.on('close', () => saveBounds(w))
  w.on('maximize', () => w.webContents.send('window:maximized', true))
  w.on('unmaximize', () => w.webContents.send('window:maximized', false))
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) w.loadURL(devUrl)
  else w.loadFile(path.join(__dirname, '../renderer/index.html'))
  return w
}

app.on('will-quit', () => {
  syncService.cancel()
  syncService.stopScheduler()
  cloudService.stop()
  stopPlayerJobs()
  globalShortcut.unregisterAll()
  stopWinETakeover()
  for (const w of childWindows) if (!w.isDestroyed()) w.destroy()
  portalServer.stop()
  void stopMcp()
})

/**
 * Fill in the icons a platform did not resolve itself. macOS hands back `.app` paths and no icon,
 * so Electron reads the bundle icon once per app and caches the PNG (see `appicons.ts`). Windows
 * handlers hand back an `.exe` (classic) or a PNG inside `WindowsApps` (packaged app).
 */
async function withAppIcons(apps: DesktopApp[]): Promise<DesktopApp[]> {
  if (process.platform === 'darwin') {
    const dir = path.join(app.getPath('userData'), 'appicons')
    return Promise.all(
      apps.map(async (a) => (a.iconPath ? a : { ...a, iconPath: await appIconFile(a.id, dir) }))
    )
  }
  if (process.platform !== 'win32') return apps
  const dir = path.join(app.getPath('userData'), 'appicons')
  return Promise.all(
    apps.map(async (a) => (a.iconPath ? { ...a, iconPath: await winIconFile(a.iconPath, dir) } : a))
  )
}

const winIconCache = new Map<string, string>()

/** Packaged apps ship a PNG; a classic app's icon is extracted from its `.exe`, once per mtime. */
async function winIconFile(source: string, dir: string): Promise<string> {
  const src = String(source ?? '').trim()
  if (!src || !path.isAbsolute(src)) return ''
  if (/\.(png|jpe?g|webp)$/i.test(src)) return src
  const hit = winIconCache.get(src)
  if (hit) return hit
  const st = await fs.stat(src).catch(() => null)
  if (!st) return ''
  const key = createHash('sha1').update(`win1:${src}:${st.mtimeMs}`).digest('hex')
  const file = path.join(dir, `${key}.png`)
  if (await fs.access(file).then(() => true, () => false)) {
    winIconCache.set(src, file)
    return file
  }
  const icon = await app.getFileIcon(src, { size: 'large' }).catch(() => null)
  if (!icon || icon.isEmpty()) return ''
  await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
  const tmp = `${file}.${process.pid}.png`
  const wrote = await fs.writeFile(tmp, icon.toPNG()).then(() => true, () => false)
  if (!wrote) return ''
  await fs.rename(tmp, file).catch(() => undefined)
  const ok = await fs.access(file).then(() => true, () => false)
  if (ok) winIconCache.set(src, file)
  return ok ? file : ''
}

/** Window IPC must act on the window that asked: viewer/editor windows are separate. */
const senderWindow = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
  BrowserWindow.fromWebContents(e.sender) ?? win

/** Track the standalone viewer/editor/music windows so quitting closes them too. */
const childWindows = new Set<BrowserWindow>()
/** One music window; a second open request brings the existing one forward. */
let musicWindow: BrowserWindow | null = null
/** One video window, single-instance like the music window. */
let videoWindow: BrowserWindow | null = null
/** Last state the player pushed, replayed to a music window that opens later. */
let lastMusicState: unknown = null
/** ffprobe durations by absolute path, invalidated by mtime. */
const durationCache = new Map<string, { mtime: number; dur: number }>()

const STANDALONE_SIZE: Record<
  'gallery' | 'editor' | 'music' | 'video',
  { w: number; h: number; minW: number; minH: number }
> = {
  gallery: { w: 1100, h: 760, minW: 520, minH: 380 },
  editor: { w: 980, h: 720, minW: 520, minH: 380 },
  music: { w: 1080, h: 660, minW: 760, minH: 460 },
  video: { w: 1200, h: 780, minW: 720, minH: 420 }
}

function openStandalone(
  kind: 'gallery' | 'editor' | 'music' | 'video',
  file: string
): { ok: true } | { error: string } {
  try {
    // The player itself lives in the main window: a second music window would have no sound.
    if (kind === 'music' && musicWindow && !musicWindow.isDestroyed()) {
      if (musicWindow.isMinimized()) musicWindow.restore()
      musicWindow.show()
      musicWindow.focus()
      return { ok: true }
    }
    // The video window owns its own player, so a second one would only be a duplicate window.
    if (kind === 'video' && videoWindow && !videoWindow.isDestroyed()) {
      if (videoWindow.isMinimized()) videoWindow.restore()
      videoWindow.show()
      videoWindow.focus()
      return { ok: true }
    }
    const frameless = chrome.customTitlebar
    const size = STANDALONE_SIZE[kind]
    const w = new BrowserWindow({
      width: size.w,
      height: size.h,
      minWidth: size.minW,
      minHeight: size.minH,
      title: remoteName(file),
      frame: !frameless,
      hasShadow: false,
      backgroundColor: '#16181d',
      icon: windowIcon(),
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    childWindows.add(w)
    w.on('closed', () => {
      childWindows.delete(w)
      if (musicWindow === w) musicWindow = null
      if (videoWindow === w) videoWindow = null
      // Closing a player window must stop playback that lives in the main window (the music
      // element, or a preview video of the same file), rather than leaving it running there.
      if (kind === 'music' || kind === 'video') {
        if (win && !win.isDestroyed()) win.webContents.send('player:window-closed', kind)
      }
    })
    if (kind === 'video') videoWindow = w
    if (kind === 'music') {
      musicWindow = w
      // the renderer subscribes after this event, so preload keeps the last state as well
      w.webContents.once('did-finish-load', () => {
        if (lastMusicState !== null && !w.isDestroyed()) {
          w.webContents.send('music:state', lastMusicState)
        }
      })
    }
    w.on('maximize', () => w.webContents.send('window:maximized', true))
    w.on('unmaximize', () => w.webContents.send('window:maximized', false))
    w.on('enter-full-screen', () => w.webContents.send('window:fullscreen-state', true))
    w.on('leave-full-screen', () => w.webContents.send('window:fullscreen-state', false))
    w.once('ready-to-show', () => w.show())
    const query: Record<string, string> =
      kind === 'music'
        ? { music: '1', path: file }
        : kind === 'video'
          ? { video: '1', path: file }
          : { [kind === 'gallery' ? 'gallery' : 'editor']: '1', path: file }
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) {
      const url = new URL(devUrl)
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
      void w.loadURL(url.toString())
    } else {
      void w.loadFile(path.join(__dirname, '../renderer/index.html'), { query })
    }
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * One response for both `thumb://` registrations (the initial window and the one a chrome change
 * rebuilds). A real thumbnail is a cached PNG; the formats `nativeImage` cannot decode (SVG, WebP,
 * GIF, BMP, ICO, AVIF) are handed over as the original file with their own MIME type, because
 * Chromium draws all of them and a blank tile was the alternative.
 */
async function serveThumb(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const side = Number(url.searchParams.get('s') ?? 256) || 256
  const remote = remoteFromMediaUrl(req.url)
  let p = ''
  if (remote) {
    try {
      p = await cacheFor().ensure(remote.uri, remote.version)
    } catch {
      return new Response('remote file unavailable', { status: 404 })
    }
  } else {
    p = mediaPathFromUrl(req.url)
    if (!path.isAbsolute(p)) return new Response('bad path', { status: 400 })
  }
  // a versioned URL (?v=mtime-size) is immutable: a changed file gets a new URL. Without one the
  // renderer cannot tell us the file changed, so it must revalidate instead of trusting a day-old hit
  const cacheControl = url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache'

  const file = await thumbFor(p, side)
  if (file) {
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    headers.set('Cache-Control', cacheControl)
    return new Response(res.body, { status: res.status, headers })
  }

  const mime = rawImageType(p)
  const st = mime ? await fs.stat(p).catch(() => null) : null
  if (!mime || !st || !st.isFile() || st.size === 0 || st.size > RAW_IMAGE_MAX_BYTES) {
    return new Response('no thumb', { status: 404 })
  }
  const res = await net.fetch(pathToFileURL(p).toString())
  const headers = new Headers(res.headers)
  headers.set('Content-Type', mime)
  headers.set('Content-Length', String(st.size))
  headers.set('Cache-Control', cacheControl)
  return new Response(res.body, { status: res.status, headers })
}

app.whenReady().then(async () => {
  void initPlayer()
  // Remote files are materialized here before the renderer sees a path; the version in the URL
  // keeps a changed remote file from being served from an old cache entry.
  remoteCache = createRemoteCache({
    dir: path.join(app.getPath('userData'), 'remote-cache'),
    fs: remoteFs
  })
  protocol.handle('mfm', async (req) => {
    const remote = remoteFromMediaUrl(req.url)
    if (remote) {
      try {
        const local = await cacheFor().ensure(remote.uri, remote.version)
        return await serveLocalFile(req, local)
      } catch {
        return new Response('remote file unavailable', { status: 404 })
      }
    }
    const p = mediaPathFromUrl(req.url)
    if (!path.isAbsolute(p)) return new Response('bad path', { status: 400 })
    // Seeking in <video> is HTTP byte-range based. `net.fetch(file://)` reads the whole file,
    // so serve it here with the headers Chromium needs and a real bounded stream.
    return serveLocalFile(req, p)
  })

  protocol.handle('thumb', serveThumb)

  ipcMain.handle('thumbs:clear', () => clearThumbs())

  // ── remote connection profiles (metadata only; secrets never cross this boundary) ──────────
  ipcMain.handle('remote:profiles', () => listRemoteProfiles())
  ipcMain.handle('remote:save', (_e, draft: ProfileDraft) => saveRemoteProfile(draft ?? {}))
  ipcMain.handle('remote:remove', (_e, id: string) => ({ ok: removeRemoteProfile(String(id ?? '')) }))
  ipcMain.handle('remote:test', (_e, draft: ProfileDraft) => testRemoteDraft(draft ?? {}))
  ipcMain.handle('remote:testSaved', (_e, id: string) => testSavedProfile(String(id ?? '')))
  ipcMain.handle('remote:uri', (_e, id: string) => remoteProfileUri(String(id ?? '')))
  ipcMain.handle('remote:sshConfig', () => readSshConfigHosts())
  ipcMain.handle('remote:forgetHostKey', (_e, id: string) => forgetRemoteHostKey(String(id ?? '')))
  ipcMain.handle('remote:clearCache', async () => {
    await cacheFor().clear()
    return true
  })

  // ── cloud folders: metadata + run control; the password never crosses this boundary ────────
  ipcMain.handle('cloud:list', () => cloudService.view())
  ipcMain.handle('cloud:accountSave', (_e, draft: CloudAccountDraft) => cloudService.saveAccount(draft ?? {}))
  ipcMain.handle('cloud:accountRemove', (_e, id: string) => {
    cloudService.removeAccount(String(id ?? ''))
    return true
  })
  ipcMain.handle('cloud:browse', (_e, a: { accountId?: string; path?: string }) =>
    cloudService.browse(String(a?.accountId ?? ''), String(a?.path ?? '/'))
  )
  ipcMain.handle('cloud:folderCreate', (_e, a: { accountId?: string; parent?: string; name?: string }) =>
    cloudService.createFolder(String(a?.accountId ?? ''), String(a?.parent ?? '/'), String(a?.name ?? ''))
  )
  ipcMain.handle('cloud:preview', (_e, a: { accountId?: string; localPath?: string; remoteId?: string }) =>
    cloudService.preview({
      accountId: String(a?.accountId ?? ''),
      localPath: String(a?.localPath ?? ''),
      remoteId: String(a?.remoteId ?? '/')
    })
  )
  ipcMain.handle('cloud:bindingSave', (_e, draft: CloudBindingDraft) => cloudService.saveBinding(draft ?? {}))
  ipcMain.handle('cloud:bindingUpdate', (_e, a: { id?: string; patch?: CloudBindingPatch }) =>
    cloudService.updateBinding(String(a?.id ?? ''), a?.patch ?? {})
  )
  ipcMain.handle('cloud:bindingRemove', (_e, id: string) => {
    cloudService.removeBinding(String(id ?? ''))
    return true
  })
  ipcMain.handle('cloud:syncNow', (_e, a: { id?: string; confirm?: boolean }) =>
    cloudService.run(String(a?.id ?? ''), { confirmDelete: a?.confirm === true })
  )
  ipcMain.handle('cloud:docs', (_e, provider: string) => {
    const url = cloudService.docs(String(provider ?? ''))
    if (!/^https:\/\//.test(url)) return false
    void shell.openExternal(url)
    return true
  })

  /**
   * One fs.watch per folder that is on screen, event-driven (no polling). A save or rename fires
   * several events, so each folder is debounced before the renderer is told to reload it. Folders
   * whose filesystem does not support watching (some network mounts) are skipped silently.
   */
  const watched = new Map<string, { w: import('node:fs').FSWatcher; timer: ReturnType<typeof setTimeout> | null }>()
  const closeWatched = (dir?: string): void => {
    const entries = dir ? [...watched].filter(([p]) => p === dir) : [...watched]
    for (const [p, e] of entries) {
      if (e.timer) clearTimeout(e.timer)
      try {
        e.w.close()
      } catch {
        // already closed
      }
      watched.delete(p)
    }
  }
  const changed = (dir: string): void => {
    const entry = watched.get(dir)
    if (!entry || entry.timer) return
    entry.timer = setTimeout(() => {
      const current = watched.get(dir)
      if (!current) return
      current.timer = null
      if (win && !win.isDestroyed()) win.webContents.send('fs:changed', dir)
    }, 300)
  }
  ipcMain.handle('fs:watch', (_e, dirs: unknown) => {
    const want = new Set(
      (Array.isArray(dirs) ? dirs : []).filter(
        (d): d is string => typeof d === 'string' && path.isAbsolute(d)
      )
    )
    for (const p of [...watched.keys()]) if (!want.has(p)) closeWatched(p)
    for (const p of want) {
      if (watched.has(p)) continue
      try {
        const w = fsWatch(p, { persistent: false }, () => changed(p))
        w.on('error', () => closeWatched(p))
        watched.set(p, { w, timer: null })
      } catch {
        // watching unsupported here; the manual refresh still works
      }
    }
    return true
  })
  app.on('will-quit', () => {
    closeWatched()
    closeFtpClients()
  })

  if (!portalOnly) win = createWindow()
  if (!portalOnly) installMacMenu()
  if (!portalOnly) syncService.startScheduler()
  if (!portalOnly) cloudService.start()
  const engine = createEngine((job) => {
    if (win && !win.isDestroyed()) win.webContents.send('job:update', job)
  }, remoteFs)

  ipcMain.handle('fs:list', async (_e, dir: string, showHidden: boolean, dims = false) => {
    const l = await listAny(dir, !!showHidden, dims)
    const meta = path.isAbsolute(dir) ? await readMeta(dir) : null
    // file colours live in the parent folder's marker; folders carry their own colour already
    if (meta?.colors) {
      for (const e of l.entries) if (!e.dir && meta.colors[e.name]) e.color = meta.colors[e.name]
    }
    // a cloud binding is a path prefix, so the badge is one lookup per row (no fs, no network)
    for (const e of l.entries) {
      const c = cloudService.forPath(e.path)
      if (c) e.cloud = c
    }
    return {
      ...l,
      pins: meta?.pins ?? [],
      labels: meta?.labels ?? {},
      ratings: meta?.ratings ?? {},
      notes: meta?.notes ?? {},
      format: meta?.format ?? null
    }
  })
  /** Everything the properties dialog shows, in one stat round-trip. */
  /**
   * Drag/shortcut debugging: `MFM_DRAG_DEBUG=1` for a console session, or an empty
   * `drag-debug.on` marker in userData — the marker survives a Start-menu launch, where no
   * environment can be injected.
   */
  ipcMain.handle('debug:log', (_e, msg: string) => {
    if (process.env.MFM_DRAG_DEBUG !== '1') {
      try {
        if (!existsSync(path.join(app.getPath('userData'), 'drag-debug.on'))) return false
      } catch {
        return false
      }
    }
    const file = path.join(app.getPath('userData'), 'drag-debug.log')
    try {
      if (!debugLogStarted) {
        debugLogStarted = true
        writeFileSync(
          file,
          `${new Date().toISOString()} session start · electron ${process.versions.electron} · app ${app.getVersion()} · WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? ''} · DISPLAY=${process.env.DISPLAY ?? ''}\n`
        )
      }
      void fs.appendFile(file, `${new Date().toISOString()} ${String(msg)}\n`)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('fs:properties', (_e, p: string) => propertiesAny(p))

  ipcMain.handle('fs:breakdown', (_e, a: { path?: string; mode?: BreakdownMode }) =>
    path.isAbsolute(a?.path ?? '')
      ? breakdown(a.path!, { mode: a.mode === 'level1' ? 'level1' : 'all' })
      : { root: '', mode: 'all', bytes: 0, files: 0, folders: 0, scanned: 0, capped: false, byExt: [], largest: [], children: [] }
  )
  /** chmod from the permissions tab; only the permission bits are accepted. */
  ipcMain.handle('fs:chmod', async (_e, a: { path?: string; mode?: number }) => {
    if (!path.isAbsolute(a?.path ?? '')) return { error: 'bad_path' }
    const mode = Number(a?.mode)
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) return { error: 'bad_mode' }
    try {
      await fs.chmod(a.path!, mode)
      return { ok: true }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('fs:statfs', async (_e, p: string) => {
    if (!path.isAbsolute(p)) return null
    const s = await fs.statfs(p).catch(() => null)
    return s ? { free: Number(s.bavail) * Number(s.bsize), size: Number(s.blocks) * Number(s.bsize) } : null
  })
  /** Raw bytes for the drag-out cache: a web drop zone needs a real File, not just a path. */
  ipcMain.handle('fs:readBytes', async (_e, a: { path?: string; max?: number }) => {
    const p = a?.path ?? ''
    if (!isRemotePath(p) && !path.isAbsolute(p)) return { error: 'bad_path' }
    const max = Math.min(32 * 1024 * 1024, Math.max(1, Number(a?.max ?? 32 * 1024 * 1024)))
    try {
      const local = isRemotePath(p) ? await localCopyOf(p, await remoteVersionOf(p), max) : p
      const st = await fs.stat(local).catch(() => null)
      if (!st?.isFile()) return { error: 'not_a_file' }
      if (st.size > max) return { error: 'too_large' }
      const data = await fs.readFile(local).catch(() => null)
      return data ? { data } : { error: 'read_failed' }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('fs:imageData', async (_e, p: string) => {
    if (!isRemotePath(p)) return readImageData(p)
    try {
      const local = await localCopyOf(p, await remoteVersionOf(p), 40_000_000)
      return await readImageData(local)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('image:save', (_e, a: { src: string; dataUrl: string; mode: 'overwrite' | 'copy' }) =>
    saveImageAny(a.src, a.dataUrl, a.mode)
  )
  ipcMain.handle('fs:dirs', (_e, dir: string, showHidden = false, followLinks = false) =>
    dirsAny(dir, !!showHidden, !!followLinks)
  )
  ipcMain.handle('fs:roots', () => roots())
  ipcMain.handle('fs:home', () => os.homedir())
  ipcMain.handle('drives:list', () => listDrives())
  ipcMain.handle('drives:volumes', () => listVolumes())
  ipcMain.handle('drives:mount', async (_e, dev: string) => {
    const res = await mountDrive(dev)
    if (res.ok) void syncService.notifyMount()
    return res
  })
  ipcMain.handle('drives:unmount', (_e, dev: string) => unmountDrive(dev))
  ipcMain.handle('system:memory', () => memoryInfo())
  ipcMain.handle('fs:size', (_e, p: string) =>
    isRemotePath(p) || path.isAbsolute(p) ? sizeAny(p) : { bytes: 0, files: 0, capped: true }
  )
  ipcMain.handle('fs:remove', (_e, a: { paths: string[]; permanent: boolean }) =>
    removeAnyPaths(
      (Array.isArray(a?.paths) ? a.paths : []).filter(
        (p) => typeof p === 'string' && (isRemotePath(p) || path.isAbsolute(p))
      ),
      a?.permanent !== false
    )
  )
  ipcMain.handle('fs:walk', (_e, dir: string, opts: WalkOpts) =>
    path.isAbsolute(dir) ? walk(dir, opts ?? {}) : { entries: [], scanned: 0, capped: false }
  )
  ipcMain.handle('fs:dupes', (_e, dir: string) =>
    path.isAbsolute(dir) ? findDupes(dir) : { entries: [], capped: false }
  )
  /** The archive engine is opt-in; the UI gate and these guards read the same preference. */
  const archiveFeatureOn = (): boolean => {
    const state = readStore<{ prefs?: { archiveEnabled?: boolean } }>('state')
    return state?.prefs?.archiveEnabled === true
  }
  const ARCHIVE_OFF = 'موتور آرشیو خاموش است؛ از تنظیمات فعالش کن'
  const archiveOps = new Map<string, AbortController>()
  const archiveOp = (id: string): { opId: string; controller: AbortController } => {
    const opId = typeof id === 'string' ? id.slice(0, 80) : ''
    const controller = new AbortController()
    if (opId) archiveOps.set(opId, controller)
    return { opId, controller }
  }
  const archiveProgress =
    (sender: Electron.WebContents, opId: string) =>
    (p: { phase: 'compress' | 'extract'; done: number; total: number; bytes: number; totalBytes: number; name?: string }) => {
      if (sender.isDestroyed()) return
      try {
        sender.send('archive:progress', { opId, ...p })
      } catch {
        // the window went away mid-operation; the archive itself is still finished
      }
    }

  ipcMain.handle('fs:archive', (_e, p: string) =>
    !archiveFeatureOn()
      ? { entries: [], capped: false, error: ARCHIVE_OFF }
      : path.isAbsolute(p)
        ? listArchive(p)
        : { entries: [], capped: false, error: 'مسیر نامعتبر است' }
  )
  ipcMain.handle(
    'fs:archiveCreate',
    async (
      e,
      a: {
        dir?: string
        name?: string
        sources?: string[]
        format?: string
        level?: number
        method?: string
        password?: string
        encryption?: string
        comment?: string
        opId?: string
      }
    ) => {
      if (!archiveFeatureOn()) return { error: ARCHIVE_OFF }
      if (!path.isAbsolute(a?.dir ?? '')) return { error: 'مقصد نامعتبر است' }
      const sources = Array.isArray(a?.sources)
        ? a.sources.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p))
        : []
      if (!sources.length) return { error: 'مسیر نامعتبر' }
      const { opId, controller } = archiveOp(String(a?.opId ?? ''))
      try {
        return await createArchive({
          dir: a!.dir!,
          name: String(a?.name ?? 'archive'),
          sources,
          format: isArchiveFormat(a?.format) ? a!.format! : 'zip',
          level: Math.min(9, Math.max(0, Number(a?.level ?? 6))),
          method:
            a?.method === 'store' || a?.method === 'deflate' || a?.method === 'auto'
              ? a.method
              : 'auto',
          password: typeof a?.password === 'string' ? a.password.slice(0, 1024) : undefined,
          encryption: isArchiveEncryption(a?.encryption) ? a!.encryption! : 'aes256',
          comment: typeof a?.comment === 'string' ? a.comment.slice(0, 65535) : undefined,
          signal: controller.signal,
          onProgress: archiveProgress(e.sender, opId)
        })
      } finally {
        if (opId) archiveOps.delete(opId)
      }
    }
  )
  ipcMain.handle(
    'fs:extract',
    async (
      e,
      a: {
        archive?: string
        names?: string[]
        dest?: string
        password?: string
        conflict?: string
        subfolder?: boolean
        symlinks?: boolean
        opId?: string
      }
    ) => {
      if (!archiveFeatureOn()) return { done: 0, skipped: 0, bytes: 0, errors: [ARCHIVE_OFF] }
      if (!path.isAbsolute(a?.archive ?? '') || !path.isAbsolute(a?.dest ?? '')) {
        return { done: 0, skipped: 0, bytes: 0, errors: ['مسیر نامعتبر است'] }
      }
      const { opId, controller } = archiveOp(String(a?.opId ?? ''))
      try {
        return await extract({
          archive: a!.archive!,
          dest: a!.dest!,
          names: Array.isArray(a?.names) ? a.names.filter((n): n is string => typeof n === 'string') : [],
          password: typeof a?.password === 'string' ? a.password.slice(0, 1024) : undefined,
          conflict: conflictOf({ conflict: a?.conflict as ConflictPolicy | undefined }),
          subfolder: a?.subfolder === true,
          symlinks: a?.symlinks === true,
          signal: controller.signal,
          onProgress: archiveProgress(e.sender, opId)
        })
      } finally {
        if (opId) archiveOps.delete(opId)
      }
    }
  )
  ipcMain.handle('fs:archiveVerify', (_e, a: { archive?: string; password?: string; names?: string[] }) =>
    !archiveFeatureOn()
      ? { ok: false, checked: 0, errors: [ARCHIVE_OFF] }
      : path.isAbsolute(a?.archive ?? '')
      ? verifyArchive(a!.archive!, {
          password: typeof a?.password === 'string' ? a.password.slice(0, 1024) : undefined,
          names: Array.isArray(a?.names) ? a.names.filter((n): n is string => typeof n === 'string') : []
        })
      : { ok: false, checked: 0, errors: ['مسیر نامعتبر است'] }
  )
  ipcMain.handle('fs:archiveCancel', (_e, opId: string) => {
    const c = archiveOps.get(String(opId ?? ''))
    if (!c) return false
    c.abort()
    archiveOps.delete(String(opId))
    return true
  })
  ipcMain.handle('meta:set', (_e, a: { dir: string; meta: FolderMeta }) =>
    path.isAbsolute(a.dir) ? setMeta(a.dir, a.meta ?? {}) : null
  )
  ipcMain.handle('hotkey:register', (_e, accel: string) => registerHotkey(accel))
  ipcMain.handle('wine:takeover', (_e, on: boolean, autostart: boolean) =>
    winETakeover(on === true, autostart === true)
  )
  ipcMain.handle('app:runScript', (_e, a: { command?: string; path?: string; dir?: string }) => {
    if (isRemotePath(a?.path ?? '') || isRemotePath(a?.dir ?? '')) {
      return { error: 'a remote folder cannot run a local script; copy the files down first' }
    }
    return runScriptCommand(a)
  })
  ipcMain.handle('app:runCustomCommand', (_e, a: { command?: string; path?: string }) => {
    if (isRemotePath(a?.path ?? '')) return { error: 'a remote file cannot be opened by a local command' }
    return runCustomCommand(String(a?.command ?? ''), String(a?.path ?? ''))
  })
  ipcMain.handle('app:terminal', (_e, dir: string, shell?: string) => {
    if (isRemotePath(dir ?? '')) return { error: 'a remote folder has no local terminal' }
    return openTerminal(dir ?? '', String(shell ?? '') || 'auto')
  })
  // the settings row offers only what this machine actually has (PowerShell vs cmd, installed emulators)
  ipcMain.handle('app:terminalOptions', () => ({
    auto: autoTerminal(),
    options: listTerminals()
  }))
  // ── user fonts: copies live in userData, never in the folder being browsed ─────────────────
  const fontsDir = () => path.join(app.getPath('userData'), 'fonts')
  ipcMain.handle('fonts:list', () => listUserFonts(fontsDir()))
  ipcMain.handle('fonts:read', (_e, id: string) => readUserFont(fontsDir(), id))
  ipcMain.handle('fonts:remove', (_e, id: string) => removeUserFont(fontsDir(), id))
  ipcMain.handle('fonts:import', async () => {
    const opts = {
      title: 'Import fonts',
      filters: [{ name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
      properties: ['openFile' as const, 'multiSelections' as const]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled) return []
    const added = []
    for (const file of r.filePaths) {
      const f = await importUserFont(fontsDir(), file)
      if (!('error' in f)) added.push(f)
    }
    return added
  })
  ipcMain.handle('app:reveal', async (_e, p: string) => {
    if (!isRemotePath(p)) return revealFile(p ?? '')
    try {
      const local = await localCopyOf(p, await remoteVersionOf(p))
      return await revealFile(local)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('app:setWallpaper', async (_e, p: string, fillMode?: string) => {
    try {
      const local = isRemotePath(p) ? await localCopyOf(p, await remoteVersionOf(p)) : String(p ?? '')
      return await setDesktopWallpaper(local, fillMode === undefined ? undefined : String(fillMode))
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
  // The music window mirrors state and sends commands; playback keeps living in the main window.
  ipcMain.on('music:state', (e, state) => {
    lastMusicState = state
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && w.webContents.id !== e.sender.id) {
        w.webContents.send('music:state', state)
      }
    }
  })
  ipcMain.on('music:cmd', (_e, cmd) => {
    if (win && !win.isDestroyed()) win.webContents.send('music:cmd', cmd)
  })
  ipcMain.on('app:dragOut', (e, files: string[]) => {
    const list = files ?? []
    if (!list.some((p) => isRemotePath(p))) {
      const r = startFileDrag(e.sender, list)
      if ('error' in r) console.error('drag out:', r.error)
      return
    }
    void (async () => {
      // a native drag needs real local files: remote rows are materialized first
      const local: string[] = []
      for (const p of list) {
        if (!isRemotePath(p)) {
          local.push(p)
          continue
        }
        try {
          local.push(await localCopyOf(p, await remoteVersionOf(p)))
        } catch (err) {
          console.error('drag out:', err instanceof Error ? err.message : String(err))
        }
      }
      const r = startFileDrag(e.sender, local)
      // a drag that cannot start must not fail silently: the user sees the row do nothing
      if ('error' in r) console.error('drag out:', r.error)
    })()
  })
  /**
   * Search indexing is one run at a time and its state is global: the pending state, the settings
   * page and MCP clients all read the same object, so «is it indexing?» has a truthful answer.
   */
  type SearchIndexStatus = {
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
  let indexStatus: SearchIndexStatus = {
    running: false,
    scanned: 0,
    added: 0,
    done: 0,
    total: 0,
    root: '',
    startedAt: 0,
    finishedAt: 0,
    files: 0,
    dirs: 0,
    lastIndex: 0,
    error: ''
  }
  let indexRun: Promise<unknown> | null = null

  function clearSearchIndex() {
    clearIndex(searchDbFile())
    const stats = indexStats(searchDbFile())
    if (!indexStatus.running) indexStatus = { ...indexStatus, ...stats }
    return stats
  }

  function runSearchIndex(
    cfg: IndexConfig,
    emit?: (st: SearchIndexStatus) => void
  ): Promise<Record<string, unknown>> {
    if (indexRun) return Promise.resolve({ alreadyRunning: true, status: indexStatus })
    indexStatus = {
      running: true,
      scanned: 0,
      added: 0,
      done: 0,
      total: cfg.roots.length,
      root: '',
      startedAt: Date.now(),
      finishedAt: 0,
      files: 0,
      dirs: 0,
      lastIndex: 0,
      error: ''
    }
    const push = () => {
      emit?.(indexStatus)
      // broadcast to the window too: an index started by MCP must be visible in the status bar
      if (win && !win.isDestroyed()) win.webContents.send('search:progress', indexStatus)
    }
    push()
    const chain = indexRoots(searchDbFile(), cfg, (p) => {
      Object.assign(indexStatus, p)
      push()
    })
      .then((r) => {
        const stats = indexStats(searchDbFile())
        indexStatus = { ...indexStatus, running: false, finishedAt: Date.now(), ...stats }
        push()
        return { ...r, stats, status: indexStatus }
      })
      .catch((e) => {
        indexStatus = {
          ...indexStatus,
          running: false,
          finishedAt: Date.now(),
          error: e instanceof Error ? e.message : String(e)
        }
        push()
        throw e
      })
      .finally(() => {
        indexRun = null
      })
    indexRun = chain
    return chain as Promise<Record<string, unknown>>
  }

  /**
   * Every MCP tool goes through here: the same functions the IPC handlers use, so an agent can
   * reach every capability of the app without a second implementation drifting away.
   */
  const mcpHandler = async (tool: string, args: Record<string, any>): Promise<unknown> => {
    const abs = (v: unknown) => (typeof v === 'string' && path.isAbsolute(v) ? v : null)
    const absList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => abs(x) !== null) : [])
    const needAbs = (v: unknown): string => {
      const p = abs(v)
      if (!p) throw new Error('absolute path required')
      return p
    }
    /** local absolute or remote URI: the same accepted set the renderer uses */
    const anyPath = (v: unknown): string | null =>
      typeof v === 'string' && (path.isAbsolute(v) || isRemotePath(v)) ? v : null
    const anyList = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => anyPath(x) !== null) : []
    const needPath = (v: unknown): string => {
      const p = anyPath(v)
      if (!p) throw new Error('an absolute path or a remote URI is required')
      return p
    }
    const localForMcp = async (p: string): Promise<string> =>
      isRemotePath(p) ? localCopyOf(p, await remoteVersionOf(p)) : p
    /** Anything the window itself must do is sent to the renderer, which owns that state. */
    const ui = (extra: Record<string, unknown> = {}) => {
      win?.webContents.send('mcp:ui', { tool, args, ...extra })
      return { ok: true }
    }
    switch (tool) {
      case 'roots':
        return { home: os.homedir(), roots: await roots() }
      case 'drives_list':
        return listDrives()
      case 'drive_mount':
        return mountDrive(String(args.device ?? ''))
      case 'drive_unmount':
        return unmountDrive(String(args.device ?? ''))
      case 'list': {
        const dir = needPath(args.path)
        const l = await listAny(dir, !!args.hidden, !!args.dims)
        const meta = path.isAbsolute(dir) ? await readMeta(dir) : null
        if (meta?.colors) for (const e of l.entries) if (!e.dir && meta.colors[e.name]) e.color = meta.colors[e.name]
        return {
          ...l,
          pins: meta?.pins ?? [],
          labels: meta?.labels ?? {},
          ratings: meta?.ratings ?? {},
          notes: meta?.notes ?? {},
          format: meta?.format ?? null
        }
      }
      case 'dirs':
        return dirsAny(needPath(args.path), !!args.hidden, !!args.links)
      case 'walk':
        return walk(needAbs(args.dir), {
          query: args.pattern ? String(args.pattern) : undefined,
          regex: !!args.regex,
          content: args.content ? String(args.content) : undefined,
          includeDirs: true,
          exclude: Array.isArray(args.exclude) ? args.exclude.map(String) : undefined,
          limit: Number.isFinite(Number(args.cap)) ? Number(args.cap) : 2000
        })
      case 'properties':
        return propertiesAny(needPath(args.path))
      case 'statfs': {
        const st = await fs.statfs(needAbs(args.path)).catch(() => null)
        return st ? { free: Number(st.bavail) * Number(st.bsize), size: Number(st.blocks) * Number(st.bsize) } : null
      }
      case 'size':
        return sizeAny(needPath(args.path))
      case 'breakdown':
        return breakdown(needAbs(args.path), { mode: args.mode === 'level1' ? 'level1' : 'all' })
      case 'hash':
        return hashAny(anyList(args.paths), String(args.algo ?? 'sha256'))
      case 'dupes':
        return findDupes(needAbs(args.dir), { limit: Number(args.limit ?? 4000) })
      case 'search':
        return searchIndex(searchDbFile(), String(args.query ?? ''), Number(args.limit ?? 100))
      case 'search_stats':
        return indexStats(searchDbFile())
      case 'search_sizes':
        return indexSizes(searchDbFile(), absList(args.dirs).slice(0, 500))
      case 'preview':
        return previewAny(needPath(args.path), Number(args.maxKB ?? 200))
      case 'read_text':
        return readTextAny(needPath(args.path))
      case 'archive_list':
        return archiveFeatureOn()
          ? listArchive(needAbs(args.path))
          : { entries: [], capped: false, error: ARCHIVE_OFF }
      case 'diff':
        return diffFiles(needAbs(args.a), needAbs(args.b))
      case 'tags': {
        const out: Record<string, unknown> = {}
        for (const pp of absList(args.paths).slice(0, 200)) out[pp] = await readTags(pp)
        return out
      }
      case 'tags_cover': {
        const cover = await readAudioCover(needAbs(args.path))
        if (!cover) return { error: 'کاور جاسازی‌شده‌ای ندارد' }
        const wantsOut = args.out !== undefined && args.out !== null && args.out !== ''
        if (!wantsOut) {
          if (cover.data.length > 4 * 1024 * 1024) {
            throw new Error('cover is larger than 4 MB; pass out to write it to a file')
          }
          return {
            mime: cover.mime,
            size: cover.data.length,
            dataUrl: `data:${cover.mime};base64,${cover.data.toString('base64')}`
          }
        }
        const target = await freeName(needAbs(args.out))
        await fs.writeFile(target, cover.data)
        return { path: target, size: cover.data.length }
      }
      case 'meta_get':
        return (await readMeta(needAbs(args.dir))) ?? {}
      case 'labels':
        return LABELS
      case 'folder_look': {
        const p = needAbs(args.path)
        const meta = await readMeta(p)
        if (meta?.icon || meta?.color) return { color: meta.color, icon: meta.icon }
        const native = await readNativeFolderLook(p)
        return native.icon ? { icon: native.icon, color: '' } : {}
      }
      case 'icons': {
        const extra = Array.isArray(args.extra) ? args.extra.map(String) : []
        const themes = await themeDirs(extra)
        if (typeof args.theme !== 'string' || !args.theme) return { themes, set: iconSetPaths() }
        const theme = themes.find((d) => d.dir === args.theme || d.name === args.theme)
        return theme ? iconsIn(theme.dir) : []
      }
      case 'remote_connections':
        return listRemoteProfiles()
      case 'ssh_config':
        return readSshConfigHosts()
      case 'remote_add':
        return saveRemoteProfile({
          id: typeof args.id === 'string' ? args.id : undefined,
          protocol: String(args.protocol ?? 'ftp'),
          name: typeof args.name === 'string' ? args.name : undefined,
          host: typeof args.host === 'string' ? args.host : undefined,
          port: args.port === undefined ? undefined : Number(args.port),
          user: typeof args.user === 'string' ? args.user : undefined,
          root: typeof args.root === 'string' ? args.root : undefined,
          bucket: typeof args.bucket === 'string' ? args.bucket : undefined,
          region: typeof args.region === 'string' ? args.region : undefined,
          endpoint: typeof args.endpoint === 'string' ? args.endpoint : undefined,
          pathStyle: args.pathStyle === undefined ? undefined : args.pathStyle === true,
          implicitTLS: args.implicitTLS === undefined ? undefined : args.implicitTLS === true,
          verifyTls: args.verifyTls === undefined ? undefined : args.verifyTls !== false,
          accessKey: typeof args.accessKey === 'string' ? args.accessKey : undefined,
          anonymous: args.anonymous === true,
          auth: typeof args.auth === 'string' ? args.auth : undefined,
          keyPath: typeof args.keyPath === 'string' ? args.keyPath : undefined,
          keyPassphrase: typeof args.keyPassphrase === 'string' ? args.keyPassphrase : undefined,
          acceptNewHostKey: args.acceptNewHostKey === undefined ? undefined : args.acceptNewHostKey === true,
          password: typeof args.password === 'string' ? args.password : undefined,
          secretKey: typeof args.secretKey === 'string' ? args.secretKey : undefined,
          sessionToken: typeof args.sessionToken === 'string' ? args.sessionToken : undefined
        })
      case 'remote_remove':
        return { removed: removeRemoteProfile(String(args.id ?? '')) }
      case 'remote_test': {
        if (typeof args.id === 'string' && args.id) return testSavedProfile(args.id)
        return testRemoteDraft((args.profile ?? args) as ProfileDraft)
      }
      case 'remote_connect': {
        const uri = typeof args.id === 'string' ? remoteProfileUri(args.id) : anyPath(args.path)
        if (!uri) throw new Error('a connection id or remote path is required')
        if (win && !win.isDestroyed()) win.webContents.send('mcp:ui', { tool: 'goto', args: { path: uri, pane: args.pane } })
        return { ok: true, path: uri }
      }
      case 'jobs_list':
        return engine.list()
      case 'job_files':
        return engine.files(String(args.id ?? ''))
      case 'undo_depth':
        return engine.undoDepth()
      case 'state':
        return readStore('state') ?? {}
      case 'mcp_status': {
        const cfg = await readMcpConfig()
        return { mode: cfg.mode, port: cfg.port, log: await mcpLogTail(50) }
      }
      case 'apps':
        return listApps(await localForMcp(needPath(args.path)), !!args.all)
      case 'app_default': {
        const d = await defaultApp(await localForMcp(needPath(args.path)))
        return d ?? {}
      }
      case 'desktop_default_manager':
        return { default: await isDefaultFileManager() }
      case 'portal_status':
        return {
          supported: process.platform === 'linux',
          installed: portalInstalled(),
          running: portalServer.running,
          error: portalError || null
        }
      case 'update_check':
        return checkUpdate(!!args.force)
      case 'write_text':
        return writeTextAny(needPath(args.path), String(args.text ?? ''))
      case 'mkdir':
        return engine.makeDir(needPath(args.dir), String(args.name ?? ''))
      case 'create_file':
        return engine.createFile(needPath(args.dir), String(args.name ?? ''), typeof args.content === 'string' ? args.content : '')
      case 'rename': {
        const from = needPath(args.path)
        const name = String(args.name ?? '')
        const to = isRemotePath(from) ? remoteJoin(remoteDir(from), name) : path.join(path.dirname(from), name)
        return engine.renameMany([{ from, to }])
      }
      case 'rename_many': {
        const pairs: { from: string; to: string }[] = []
        for (const x of Array.isArray(args.pairs) ? args.pairs : []) {
          const from = anyPath(x?.from)
          const to = anyPath(x?.to)
          if (from && to) pairs.push({ from, to })
        }
        if (!pairs.length) throw new Error('pairs with absolute from/to are required')
        return engine.renameMany(pairs)
      }
      case 'copy':
      case 'move': {
        const dest = needPath(args.dest)
        const files = anyList(args.sources ?? args.paths)
        if (!files.length) throw new Error('paths are required')
        const opts: JobOpts = {
          conflict: conflictOf({
            conflict: args.conflict as ConflictPolicy | undefined,
            skipExisting: !!args.skipExisting,
            newerOnly: !!args.newerOnly
          }),
          limitBps: Number(args.limitBps ?? 0) || 0
        }
        return engine.start(tool === 'copy' ? 'copy' : 'move', files, dest, opts)
      }
      case 'trash':
        return removeAnyPaths(anyList(args.paths), false)
      case 'delete': {
        if (args.confirm !== true) throw new Error('permanent delete needs confirm:true')
        return removeAnyPaths(anyList(args.paths), true)
      }
      case 'symlink':
        return createSymlink(needAbs(args.target), needAbs(args.link))
      case 'shortcut': {
        const targets = anyList(args.paths ?? args.targets)
        if (!targets.length) throw new Error('paths are required')
        if (targets.some(isRemotePath)) throw new Error('shortcuts are local only')
        return createShortcuts(targets, args.where === 'desktop' ? 'desktop' : 'here', {
          desktopDir: app.getPath('desktop'),
          writeLink: (link, details) => Promise.resolve(shell.writeShortcutLink(link, 'create', details))
        })
      }
      case 'chmod': {
        const mode = Number(args.mode)
        if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('mode must be 0..0o7777')
        await fs.chmod(needAbs(args.path), mode)
        return { ok: true }
      }
      case 'extract':
        if (!archiveFeatureOn()) return { done: 0, skipped: 0, bytes: 0, errors: [ARCHIVE_OFF] }
        return extract({
          archive: needAbs(args.archive),
          dest: needAbs(args.dest),
          names: Array.isArray(args.names) ? args.names.filter((n): n is string => typeof n === 'string') : [],
          password: typeof args.password === 'string' ? args.password : undefined,
          conflict: conflictOf({ conflict: args.conflict as ConflictPolicy | undefined }),
          subfolder: args.subfolder === true,
          symlinks: args.symlinks === true
        })
      case 'archive_verify':
        if (!archiveFeatureOn()) return { ok: false, checked: 0, errors: [ARCHIVE_OFF] }
        return verifyArchive(needAbs(args.archive), {
          password: typeof args.password === 'string' ? args.password : undefined,
          names: Array.isArray(args.names) ? args.names.filter((n): n is string => typeof n === 'string') : []
        })
      case 'create_zip':
        if (!archiveFeatureOn()) return { error: ARCHIVE_OFF }
        return createArchive({
          dir: needAbs(args.dir),
          name: String(args.name ?? 'archive'),
          sources: absList(args.sources),
          format: isArchiveFormat(args.format) ? args.format : 'zip',
          level: Math.min(9, Math.max(0, Number(args.level ?? 6))),
          method: args.method === 'store' || args.method === 'deflate' ? args.method : 'auto',
          password: typeof args.password === 'string' ? args.password : undefined,
          encryption: isArchiveEncryption(args.encryption) ? args.encryption : 'aes256',
          comment: typeof args.comment === 'string' ? args.comment : undefined
        })
      case 'tags_write': {
        const list = Array.isArray(args.paths)
          ? absList(args.paths)
          : typeof args.path === 'string' && abs(args.path)
            ? [needAbs(args.path)]
            : []
        if (!list.length) throw new Error('path or paths is required')
        let cover: AudioWriteRequest['cover'] = 'keep'
        if (args.coverFromFolder === true) cover = 'folder'
        else if (args.cover === undefined) cover = 'keep'
        else if (args.cover === null || args.cover === '') cover = 'clear'
        else cover = { path: needAbs(args.cover) }
        const fields = cleanAudioFields(args.fields)
        return writeAudioTags({ items: list.map((p) => ({ path: p, fields })), cover })
      }
      case 'tags_number': {
        const list = absList(args.paths).slice(0, 500)
        if (!list.length) throw new Error('paths are required')
        const start = Number.isFinite(Number(args.start)) ? Math.trunc(Number(args.start)) : 1
        return writeAudioTags({
          items: list.map((p, i) => ({ path: p, fields: { track: String(start + i) } })),
          cover: 'keep'
        })
      }
      case 'export_listing':
        return exportListing(
          needAbs(args.dir),
          String(args.name ?? 'listing'),
          (Array.isArray(args.rows) ? args.rows : []) as ExportRow[],
          args.format === 'pdf' ? 'pdf' : 'csv',
          String(args.theme ?? 'dark')
        )
      case 'pdf':
        return htmlToPdf(String(args.html ?? ''), needAbs(args.out), String(args.theme ?? 'light'))
      case 'image_get':
        return readImageData(await localForMcp(needPath(args.path)))
      case 'image_save':
        return saveImageAny(needPath(args.src), String(args.dataUrl ?? ''), args.mode === 'overwrite' ? 'overwrite' : 'copy')
      case 'image_save_as':
        return saveImageAsAny(needPath(args.src), String(args.dataUrl ?? ''), anyPath(args.dest) ?? undefined)
      case 'image_convert':
        return convertImages(absList(args.files).slice(0, 500), {
          format: args.format === 'png' ? 'png' : args.format === 'webp' ? 'webp' : 'jpeg',
          maxSide: Number(args.maxSide ?? 0) || 0,
          quality: Math.min(100, Math.max(1, Number(args.quality ?? 90))),
          dest: abs(args.dest) ?? undefined
        })
      case 'thumbs_clear':
        clearThumbs()
        return { ok: true }
      case 'label_set':
        return setLabel(needAbs(args.dir), String(args.name ?? ''), args.label ? String(args.label) : null)
      case 'file_color_set':
        return setEntryColor(needAbs(args.dir), String(args.name ?? ''), String(args.color ?? ''))
      case 'rating_set':
        return setRating(needAbs(args.dir), String(args.name ?? ''), Number(args.stars ?? 0))
      case 'note_set':
        return setNote(needAbs(args.dir), String(args.name ?? ''), String(args.text ?? ''))
      case 'meta_set':
        return setMeta(needAbs(args.dir), (args.patch ?? {}) as FolderMeta)
      case 'sort_set': {
        const dir = needAbs(args.dir)
        const cur = (await readMeta(dir))?.format ?? {}
        return setFormat(dir, { ...cur, sortKey: String(args.key ?? 'name'), sortAsc: args.asc !== false })
      }
      case 'pin_set':
        return togglePin(needAbs(args.dir), String(args.name ?? ''), Boolean(args.on))
      case 'shown_set':
        return toggleShown(needAbs(args.dir), String(args.name ?? ''), Boolean(args.on))
      case 'job_start':
        return engine.start(
          (args.kind === 'move' ? 'move' : args.kind === 'copy' ? 'copy' : 'copy') as JobKind,
          anyList(args.sources),
          needPath(args.dest),
          (args.opts ?? {}) as JobOpts
        )
      case 'job_pause':
        return engine.pause(String(args.id ?? ''))
      case 'job_resume':
        return engine.resume(String(args.id ?? ''))
      case 'job_cancel':
        return engine.cancel(String(args.id ?? ''))
      case 'job_clear':
        return engine.clear()
      case 'undo':
        return engine.undo()
      case 'search_index': {
        const cfg = {
          roots: absList(args.roots),
          exclude: Array.isArray(args.exclude) ? args.exclude.map(String) : []
        }
        if (args.wait === false) {
          void runSearchIndex(cfg).catch(() => undefined)
          return { started: true, status: indexStatus }
        }
        return runSearchIndex(cfg)
      }
      case 'search_status': {
        const stats = indexStats(searchDbFile())
        return { ...indexStatus, ...stats, stats }
      }
      case 'search_clear':
        return clearSearchIndex()
      case 'prefs_set': {
        const patch = (args.patch ?? {}) as Record<string, unknown>
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch object required')
        const st = (await readState()) ?? {}
        const prefs = { ...(st.prefs ?? {}), ...patch }
        writeStore('state', { ...st, prefs })
        return ui({ prefs })
      }
      case 'fonts_list': {
        const st = (await readState()) ?? {}
        const prefs = (st.prefs ?? {}) as Record<string, unknown>
        return {
          // bundled families are renderer assets; the metadata is shared with the settings page
          bundled: BUNDLED_FONTS,
          imported: await listUserFonts(path.join(app.getPath('userData'), 'fonts')),
          current: typeof prefs.fontFamily === 'string' ? prefs.fontFamily : ''
        }
      }
      case 'open':
        return openWithDefault(await localForMcp(needPath(args.path)))
      case 'reveal':
        return revealFile(await localForMcp(needPath(args.path)))
      case 'wallpaper_set':
        return setDesktopWallpaper(
          await localForMcp(needPath(args.path)),
          args.fillMode === undefined ? undefined : String(args.fillMode)
        )
      case 'terminal':
        if (isRemotePath(args.dir ?? '')) throw new Error('a remote folder has no local terminal')
        return openTerminal(needAbs(args.dir), args.shell === undefined ? 'auto' : String(args.shell))
      case 'apps_launch':
        return launchApp(needAbs(args.id), await localForMcp(needPath(args.path)))
      case 'app_set_default': {
        const file = await localForMcp(needPath(args.path))
        const wanted = String(args.app ?? '')
        const known = await listApps(file, true)
        const hit =
          known.find((a) => a.id === wanted) ??
          known.find((a) => a.name.toLowerCase() === wanted.toLowerCase())
        if (!hit) throw new Error('unknown_app')
        return setDefaultApp(file, hit.id)
      }
      case 'set_default_manager':
        return setDefaultFileManager()
      case 'update_open':
        return openRelease(String(args.url ?? ''))
      case 'hotkey':
        return registerHotkey(String(args.accel ?? ''))
      case 'sync_compare':
        return syncService.compare({
          left: needPath(args.left),
          right: needPath(args.right),
          mode: args.mode === 'rtl' || args.mode === 'both' ? args.mode : 'ltr',
          compareBy: args.compareBy === 'hash' ? 'hash' : 'mtime',
          ignore: Array.isArray(args.ignore) ? args.ignore.map(String).slice(0, 50) : [],
          ignoreRules: cleanIgnoreRules(args.ignoreRules)
        })
      case 'sync_plan':
        return syncService.plan({
          left: needPath(args.left),
          right: needPath(args.right),
          mode: args.mode === 'rtl' || args.mode === 'both' ? args.mode : 'ltr',
          compareBy: args.compareBy === 'hash' ? 'hash' : 'mtime',
          ignore: Array.isArray(args.ignore) ? args.ignore.map(String).slice(0, 50) : [],
          ignoreRules: cleanIgnoreRules(args.ignoreRules),
          compress: args.compress === true,
          deleteExtra: !!args.deleteExtra,
          useRsync: !!args.useRsync,
          rsync: cleanRsyncOptions(args.rsync),
          enc: { left: syncEnc(args.encLeft), right: syncEnc(args.encRight) }
        })
      case 'sync_run': {
        const r = await syncService.run({
          left: needPath(args.left),
          right: needPath(args.right),
          mode: args.mode === 'rtl' || args.mode === 'both' ? args.mode : 'ltr',
          compareBy: args.compareBy === 'hash' ? 'hash' : 'mtime',
          ignore: Array.isArray(args.ignore) ? args.ignore.map(String).slice(0, 50) : [],
          ignoreRules: cleanIgnoreRules(args.ignoreRules),
          compress: args.compress === true,
          deleteExtra: !!args.deleteExtra,
          useRsync: !!args.useRsync,
          rsync: cleanRsyncOptions(args.rsync),
          enc: { left: syncEnc(args.encLeft), right: syncEnc(args.encRight) },
          versions: syncVersions(args.versions),
          dryRun: args.dryRun === true,
          confirmRemoteDelete: args.confirm === true
        })
        // an agent needs the outcome, not 20 000 rows; sync_plan is the row-shaped tool
        return {
          id: r.id,
          blocked: r.blocked,
          summary: r.summary,
          plan: {
            copy: r.plan.copy.length,
            remove: r.plan.remove.length,
            skipped: r.plan.skipped,
            conflicts: r.plan.conflicts.map((c) => ({ rel: c.rel, conflict: c.conflict }))
          }
        }
      }
      case 'sync_apply': {
        // legacy shape: re-compare instead of trusting rows supplied by the caller
        const r = await syncService.run({
          left: needPath(args.left),
          right: needPath(args.right),
          mode: args.mode === 'rtl' ? 'rtl' : 'ltr',
          compareBy: args.compareBy === 'hash' ? 'hash' : 'mtime',
          deleteExtra: !!args.deleteExtra,
          confirmRemoteDelete: false
        })
        return {
          copied: r.applied?.copied ?? 0,
          deleted: r.applied?.removed ?? 0,
          skipped: r.applied?.skipped ?? r.plan.skipped,
          errors: r.applied?.errors ?? (r.blocked ? ['conflicts need a decision'] : [])
        }
      }
      case 'sync_jobs':
        return syncService.listJobs()
      case 'sync_job_save':
        return syncService.upsertJob(args.job)
      case 'sync_job_remove':
        return syncService.removeJob(String(args.id ?? ''))
      case 'sync_history':
        return syncService.history(Number(args.limit) || 100)
      case 'sync_restore': {
        const r = await syncService.restore(String(args.id ?? ''), args.confirm === true)
        return { id: r.id, summary: r.summary, copied: r.applied?.copied ?? 0 }
      }
      case 'sync_cancel':
        return syncService.cancel(typeof args.id === 'string' ? args.id : undefined)
      case 'sync_status':
        return syncService.status()
      case 'cloud_status':
        return cloudService.view()
      case 'cloud_browse':
        return cloudService.browse(String(args.account ?? ''), String(args.path ?? '/'))
      case 'cloud_sync':
        return cloudService.run(String(args.id ?? ''), { confirmDelete: args.confirm === true })
      case 'cloud_pause':
        return cloudService.updateBinding(String(args.id ?? ''), { paused: args.paused !== false })
      case 'sync_versions':
        return syncService.versionsQuery({
          left: needPath(args.left),
          right: needPath(args.right),
          mode: args.mode === 'rtl' ? 'rtl' : 'ltr',
          repo: typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : undefined,
          secretId: String(args.secretId ?? '')
        })
      case 'sync_versions_restore':
        return {
          path: await syncService.versionsRestore(
            String(args.repo ?? ''),
            String(args.secretId ?? ''),
            String(args.id ?? '')
          )
        }
      case 'run_script':
        return runScriptCommand({
          command: String(args.command ?? ''),
          path: abs(args.path) ?? undefined,
          dir: abs(args.dir) ?? undefined
        })
      case 'run_custom_command':
        return runCustomCommand(String(args.command ?? ''), needAbs(args.path))
      case 'clipboard_image':
        return clipboardImageAny(needPath(args.dir), String(args.name ?? 'clipboard.png'), Buffer.from(String(args.base64 ?? ''), 'base64'))
      case 'window': {
        if (!win) throw new Error('no window')
        const action = String(args.action ?? '')
        if (action === 'minimize') win.minimize()
        else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
        else if (action === 'close') win.close()
        else if (action === 'show') {
          win.show()
          win.focus()
        } else if (action === 'fullscreen') applyFullscreen(win, args.on !== false)
        else if (action === 'chrome') return chrome
        else throw new Error('action must be minimize, maximize, close, show, fullscreen or chrome')
        return { ok: true, maximized: win.isMaximized(), fullscreen: win.isFullScreen() }
      }
      case 'settings_export': {
        const st = (await readState()) ?? {}
        const file = abs(args.path)
        return file ? writeSettingsFile(file, st.prefs ?? {}) : saveSettingsDialog(st.prefs ?? {})
      }
      case 'settings_import': {
        const file = abs(args.path)
        const got = file ? await readSettingsFile(file) : await openSettingsDialog()
        if ('error' in got && got.error) throw new Error(got.error)
        if ('canceled' in got) return got
        const prefs = (got as { prefs?: Record<string, unknown> }).prefs ?? {}
        if (args.apply !== false) {
          const st = (await readState()) ?? {}
          writeStore('state', { ...st, prefs })
          win?.webContents.send('mcp:ui', { tool: 'prefs_set', args: {}, prefs })
        }
        return { prefs, applied: args.apply !== false }
      }
      case 'bookmark': {
        if (args.action !== 'list') return ui()
        const st = (await readState()) ?? {}
        return { marks: Array.isArray(st.marks) ? st.marks : [] }
      }
      case 'command':
      case 'goto':
      case 'select':
      case 'filter':
      case 'tab':
      case 'open_editor':
      case 'open_gallery':
      case 'open_preview':
      case 'properties_dialog':
      case 'note':
        return ui()
      default:
        throw new Error(`unknown tool ${tool}`)
    }
  }

  void readMcpConfig()
    .then(async (cfg) => {
      if (cfg.mode === 'off') return
      try {
        await startMcp(mcpHandler)
      } catch (e) {
        // a busy loopback port must not become an uncaught main-process error dialog
        await logMcpError(`listen failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    })
    .catch(() => undefined)

  ipcMain.handle('mcp:status', async () => {
    const cfg = await readMcpConfig()
    return { mode: cfg.mode, port: cfg.port, hasToken: !!cfg.token, log: await mcpLogTail(50) }
  })
  ipcMain.handle('mcp:configure', async (_e, patch: { mode?: McpMode; port?: number }) => {
    const cur = await readMcpConfig()
    const cfg = await writeMcpConfig({
      mode: patch?.mode ?? cur.mode,
      port: Number(patch?.port) > 1024 && Number(patch?.port) < 65535 ? Number(patch.port) : cur.port,
      token: cur.token
    })
    let st: { running: boolean; port: number; mode: McpMode }
    let error = ''
    try {
      st = await startMcp(mcpHandler)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
      st = { running: false, port: cfg.port, mode: cfg.mode }
      await logMcpError(`listen failed: ${error}`)
    }
    return { ...st, token: cfg.token, error, log: await mcpLogTail(20) }
  })
  ipcMain.handle('mcp:token', async () => {
    const cur = await readMcpConfig()
    const cfg = await writeMcpConfig({ ...cur, token: randomBytes(24).toString('hex') })
    if (cfg.mode !== 'off') {
      try {
        await startMcp(mcpHandler)
      } catch (e) {
        await logMcpError(`listen failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return cfg.token
  })
  ipcMain.handle('update:check', (_e, force?: boolean) => checkUpdate(!!force))
  ipcMain.handle('update:open', (_e, url: string) => openRelease(String(url ?? '')))
  const searchDbFile = () => path.join(app.getPath('userData'), 'search.db')
  ipcMain.handle('search:index', (e, cfg: IndexConfig) =>
    runSearchIndex(cfg ?? { roots: [], exclude: [] }, (st) => e.sender.send('search:progress', st))
  )
  ipcMain.handle('search:status', () => {
    const stats = indexStats(searchDbFile())
    return { ...indexStatus, ...stats, stats }
  })
  ipcMain.handle('search:query', (_e, a: { query: string; limit?: number }) =>
    searchIndex(searchDbFile(), String(a?.query ?? ''), a?.limit ?? 200)
  )
  ipcMain.handle('search:stats', () => indexStats(searchDbFile()))
  ipcMain.handle('search:sizes', (_e, dirs: string[]) =>
    indexSizes(searchDbFile(), (dirs ?? []).filter((d) => path.isAbsolute(d)).slice(0, 500))
  )
  ipcMain.handle('search:clear', () => clearSearchIndex())
  ipcMain.handle('fs:tags', async (_e, ps: string[]) => {
    const out: Record<string, unknown> = {}
    for (const p of (ps ?? []).slice(0, 200)) {
      if (path.isAbsolute(p)) out[p] = await readTags(p)
    }
    return out
  })
  ipcMain.handle('image:saveAs', (_e, a: { src: string; dataUrl: string; dest?: string }) =>
    saveImageAsAny(a?.src ?? '', String(a?.dataUrl ?? ''), a?.dest)
  )
  ipcMain.handle('meta:writeTags', (_e, a: { path: string; fields: Record<string, string> }) =>
    writeId3(a?.path ?? '', a?.fields ?? {})
  )
  ipcMain.handle('meta:audioRead', (_e, paths: string[]) => readAudioTags(Array.isArray(paths) ? paths : []))
  // Track lengths for the standalone playlist: ffprobe once per path+mtime, errors simply omitted.
  ipcMain.handle('audio:durations', async (_e, paths: string[]) => {
    const out: Record<string, number> = {}
    const list = Array.isArray(paths) ? paths.slice(0, 200) : []
    for (const p of list) {
      if (typeof p !== 'string' || !path.isAbsolute(p) || isRemotePath(p)) continue
      const st = await fs.stat(p).catch(() => null)
      if (!st || !st.isFile()) continue
      const hit = durationCache.get(p)
      if (hit && hit.mtime === st.mtimeMs) {
        out[p] = hit.dur
        continue
      }
      const probe = await probeMedia(p).catch(() => null)
      const dur = Number(probe?.duration ?? 0)
      if (!Number.isFinite(dur) || dur <= 0) continue
      durationCache.set(p, { mtime: st.mtimeMs, dur })
      out[p] = dur
    }
    return out
  })
  ipcMain.handle('meta:audioWrite', (_e, a: AudioWriteRequest) =>
    writeAudioTags(a && Array.isArray(a.items) ? a : { items: [], cover: 'keep' })
  )
  ipcMain.handle('image:batchConvert', (_e, a: { files: string[]; opts: ConvertOpts }) =>
    convertImages((a?.files ?? []).slice(0, 500), a?.opts ?? { format: 'jpeg', maxSide: 0, quality: 90 })
  )
  ipcMain.handle(
    'export:listing',
    (
      _e,
      a: { dir: string; name: string; rows: ExportRow[]; format: 'csv' | 'pdf'; theme?: string }
    ) =>
      exportListing(
        a?.dir ?? '',
        String(a?.name ?? 'listing'),
        a?.rows ?? [],
        a?.format ?? 'csv',
        a?.theme ?? 'dark'
      )
  )
  /**
   * Sync IPC. Every path is validated here (absolute local or a remote URI), every mode is clamped,
   * and the actual work is delegated to the one service — the renderer never runs a comparison.
   */
  const syncPath = (v: unknown): string => {
    const p = typeof v === 'string' ? v.trim() : ''
    if (!p || (!isRemotePath(p) && !path.isAbsolute(p))) {
      throw new Error('sync needs an absolute local folder or a remote URI')
    }
    return p
  }
  const syncOpts = (a: Record<string, unknown> | undefined): {
    left: string
    right: string
    mode: 'ltr' | 'rtl' | 'both'
    compareBy: 'mtime' | 'hash'
    ignore: string[]
    ignoreRules: SyncIgnoreRule[]
    compress: boolean
  } => {
    const left = syncPath(a?.left)
    const right = syncPath(a?.right)
    if (left === right) throw new Error('the two folders are the same')
    const mode = a?.mode === 'rtl' || a?.mode === 'both' ? a.mode : 'ltr'
    return {
      left,
      right,
      mode,
      compareBy: a?.compareBy === 'hash' ? 'hash' : 'mtime',
      ignore: Array.isArray(a?.ignore)
        ? (a.ignore as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 50)
        : [],
      ignoreRules: cleanIgnoreRules(a?.ignoreRules),
      compress: a?.compress === true
    }
  }
  const syncSelections = (a: Record<string, unknown> | undefined): string[] | undefined =>
    Array.isArray(a?.selected)
      ? (a.selected as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20_000)
      : undefined
  const syncResolutions = (
    a: Record<string, unknown> | undefined
  ): Record<string, 'left' | 'right' | 'skip'> | undefined => {
    if (!a?.resolutions || typeof a.resolutions !== 'object') return undefined
    const out: Record<string, 'left' | 'right' | 'skip'> = {}
    for (const [rel, decision] of Object.entries(a.resolutions as Record<string, unknown>)) {
      if (decision === 'left' || decision === 'right' || decision === 'skip') out[rel] = decision
    }
    return out
  }
  const syncEnc = (v: unknown): SyncEncryption | undefined => {
    const e = cleanEncryption(v)
    if (e === null) throw new Error('invalid encryption configuration')
    return e
  }
  const syncVersions = (v: unknown) => {
    const x = cleanVersions(v)
    if (x === null) throw new Error('invalid version configuration')
    return x
  }

  const syncBroadcastJobs = (): void => {
    const jobs = syncService.listJobs()
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('state:prefs-patch', { syncJobs: jobs })
    }
  }

  ipcMain.handle('sync:compare', async (_e, a: Record<string, unknown>) => syncService.compare(syncOpts(a)))
  ipcMain.handle('sync:plan', async (_e, a: Record<string, unknown>) =>
    syncService.plan({
      ...syncOpts(a),
      deleteExtra: a?.deleteExtra === true,
      useRsync: a?.useRsync === true,
      rsync: cleanRsyncOptions(a?.rsync),
      enc: { left: syncEnc(a?.encLeft), right: syncEnc(a?.encRight) },
      selected: syncSelections(a),
      resolutions: syncResolutions(a)
    })
  )
  ipcMain.handle('sync:run', async (_e, a: Record<string, unknown>) =>
    syncService.run({
      ...syncOpts(a),
      jobId: typeof a?.jobId === 'string' ? a.jobId : undefined,
      deleteExtra: a?.deleteExtra === true,
      useRsync: a?.useRsync === true,
      rsync: cleanRsyncOptions(a?.rsync),
      enc: { left: syncEnc(a?.encLeft), right: syncEnc(a?.encRight) },
      versions: syncVersions(a?.versions),
      selected: syncSelections(a),
      resolutions: syncResolutions(a),
      dryRun: a?.dryRun === true,
      confirmRemoteDelete: a?.confirmRemoteDelete === true
    })
  )
  ipcMain.handle('sync:jobs', () => syncService.listJobs())
  ipcMain.handle('sync:jobSave', async (_e, draft: unknown) => {
    const job = syncService.upsertJob(draft)
    if (job) syncBroadcastJobs()
    return job
  })
  ipcMain.handle('sync:jobRemove', async (_e, id: string) => {
    const removed = syncService.removeJob(String(id ?? ''))
    if (removed) syncBroadcastJobs()
    return removed
  })
  ipcMain.handle('sync:history', (_e, limit?: number) => syncService.history(Number(limit) || 100))
  ipcMain.handle('sync:restore', async (_e, a: { id?: string; confirmRemote?: boolean }) =>
    syncService.restore(String(a?.id ?? ''), a?.confirmRemote === true)
  )
  ipcMain.handle('sync:status', () => syncService.status())
  ipcMain.handle('sync:cancel', (_e, id?: string) => syncService.cancel(id ? String(id) : undefined))
  ipcMain.handle('sync:pause', (_e, id?: string) => syncService.pause(id ? String(id) : undefined))
  ipcMain.handle('sync:resume', (_e, id?: string) => syncService.resume(id ? String(id) : undefined))
  ipcMain.handle('sync:clearBaseline', (_e, a: { left?: string; right?: string }) => {
    syncService.clearBaseline(syncPath(a?.left), syncPath(a?.right))
    return true
  })
  // Secrets are write-only on purpose: the reveal path exists only for backing up a generated
  // keypair identity, and the MCP surface never gets any of these.
  ipcMain.handle('sync:secretSet', (_e, a: { id?: string; value?: string }) =>
    setSyncSecret(String(a?.id ?? ''), String(a?.value ?? ''))
  )
  ipcMain.handle('sync:secretHas', (_e, id: string) => hasSyncSecret(String(id ?? '')))
  ipcMain.handle('sync:secretRemove', (_e, id: string) => removeSyncSecret(String(id ?? '')))
  ipcMain.handle('sync:secretReveal', (_e, id: string) => getSyncSecret(String(id ?? '')))
  ipcMain.handle('sync:keypair', () => generateKeypair())
  ipcMain.handle('sync:recipientOf', async (_e, identity: string) => {
    if (!looksLikeIdentity(String(identity ?? ''))) throw new Error('invalid age identity')
    return recipientOf(String(identity))
  })
  ipcMain.handle('sync:versionsAvailable', () => resticAvailable())
  ipcMain.handle(
    'sync:versions',
    (_e, a: { left?: string; right?: string; mode?: string; repo?: string; secretId?: string }) =>
      syncService.versionsQuery({
        left: syncPath(a?.left),
        right: syncPath(a?.right),
        mode: a?.mode === 'rtl' || a?.mode === 'both' ? a.mode : 'ltr',
        repo: typeof a?.repo === 'string' && a.repo.trim() ? a.repo.trim() : undefined,
        secretId: String(a?.secretId ?? '')
      })
  )
  ipcMain.handle('sync:versionsRestore', (_e, a: { repo?: string; secretId?: string; id?: string }) =>
    syncService.versionsRestore(syncPath(a?.repo), String(a?.secretId ?? ''), String(a?.id ?? ''))
  )
  ipcMain.handle('fs:diff', (_e, a: { a: string; b: string }) => diffFiles(a?.a ?? '', a?.b ?? ''))
  ipcMain.handle('fs:readText', (_e, p: string) => readTextAny(p ?? ''))
  const editablePath = (p: string): boolean => isRemotePath(p) || path.isAbsolute(p)
  ipcMain.handle('drafts:get', (_e, p: string) =>
    editablePath(p ?? '') ? drafts.get(p) : null
  )
  ipcMain.handle('drafts:set', (_e, a: { path?: string; text?: string }) => {
    const p = a?.path ?? ''
    if (!editablePath(p) || typeof a?.text !== 'string') return null
    if (a.text.length > 8 * 1024 * 1024) return null // the same ceiling as writeText
    return drafts.set(p, a.text)
  })
  ipcMain.handle('drafts:clear', (_e, p: string) => {
    if (editablePath(p ?? '')) drafts.clear(p)
    return true
  })
  ipcMain.handle('fs:writeText', (_e, a: { path: string; text: string }) =>
    writeTextAny(a?.path ?? '', String(a?.text ?? ''))
  )
  ipcMain.handle('pdf:html', (_e, a: { html: string; out: string; theme?: string }) =>
    htmlToPdf(String(a?.html ?? ''), a?.out ?? '', a?.theme ?? 'dark')
  )
  ipcMain.handle('fs:preview', (_e, p: string, maxKB?: number) =>
    isRemotePath(p) || path.isAbsolute(p) ? previewAny(p, maxKB) : null
  )
  ipcMain.handle('player:open', async (e, p: string) => {
    if (!isRemotePath(p) && !path.isAbsolute(p)) return { kind: 'unsupported', error: 'invalid path' }
    try {
      const local = isRemotePath(p) ? await localCopyOf(p, await remoteVersionOf(p), 2 * 1024 * 1024 * 1024) : p
      return await openPlayerFile(local, e.sender)
    } catch (e2) {
      return { kind: 'unsupported', error: e2 instanceof Error ? e2.message : String(e2) }
    }
  })
  ipcMain.handle('player:cancel', (_e, id: string) => cancelPlayerJob(String(id ?? '')))
  ipcMain.handle('player:saveFrame', (_e, p: string, at: number) =>
    isRemotePath(p) ? { error: 'saving a frame of a remote video is not supported' } : path.isAbsolute(p) ? saveVideoFrame(p, Number(at)) : { error: 'invalid path' }
  )
  ipcMain.handle('player:capabilities', () => ffmpegCapabilities())
  ipcMain.handle('fs:hash', (_e, paths: string[], algo: string) => hashAny(paths, algo))
  ipcMain.handle('meta:get', (_e, dir: string) => (path.isAbsolute(dir) ? readMeta(dir) : null))
  ipcMain.handle('meta:setFormat', (_e, a: { dir: string; format: FolderFormat }) =>
    path.isAbsolute(a?.dir ?? '') ? setFormat(a.dir, a.format ?? {}) : null
  )
  ipcMain.handle('meta:setRating', (_e, a: { dir: string; name: string; stars: number }) =>
    path.isAbsolute(a?.dir ?? '') ? setRating(a.dir, String(a.name ?? ''), Number(a.stars ?? 0)) : {}
  )
  ipcMain.handle('meta:setNote', (_e, a: { dir: string; name: string; text: string }) =>
    path.isAbsolute(a?.dir ?? '') ? setNote(a.dir, String(a.name ?? ''), String(a.text ?? '')) : {}
  )
  ipcMain.handle('meta:setEntryColor', (_e, a: { dir: string; name: string; color: string }) =>
    path.isAbsolute(a?.dir ?? '') ? setEntryColor(a.dir, String(a.name ?? ''), String(a.color ?? '')) : null
  )
  ipcMain.handle('meta:setLabel', (_e, a: { dir: string; name: string; label: string | null }) =>
    path.isAbsolute(a?.dir ?? '') ? setLabel(a.dir, String(a.name ?? ''), a.label ?? null) : {}
  )
  ipcMain.handle('meta:togglePin', (_e, a: { dir: string; name: string; on?: boolean }) =>
    path.isAbsolute(a?.dir ?? '') ? togglePin(a.dir, String(a.name ?? ''), a.on) : []
  )
  ipcMain.handle('meta:toggleShown', (_e, a: { dir: string; name: string; on?: boolean }) =>
    path.isAbsolute(a?.dir ?? '') ? toggleShown(a.dir, String(a.name ?? ''), a.on) : []
  )
  ipcMain.handle('meta:labels', () => LABELS)
  ipcMain.handle('icons:themes', (_e, extra: string[]) => themeDirs(extra ?? []))
  ipcMain.handle('icons:in', (_e, dir: string) => (path.isAbsolute(dir) ? iconsIn(dir) : []))
  ipcMain.handle('icons:set', () => iconSetPaths())
  ipcMain.handle('icons:folderLook', async (_e, p: string) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return {}
    const meta = await readMeta(p)
    if (meta?.icon || meta?.color) return { color: meta.color, icon: meta.icon }
    const native = await readNativeFolderLook(p)
    return native.icon ? { icon: native.icon } : {}
  })
  ipcMain.handle('fs:mkdir', (_e, dir: string, name: string) => engine.makeDir(dir, name))
  ipcMain.handle('fs:createFile', (_e, dir: string, name: string, content?: string) =>
    engine.createFile(dir, name, content)
  )
  ipcMain.handle('app:launchPath', () => firstPath)
  ipcMain.handle('app:openViewer', (_e, a: { kind?: string; path?: string }) => {
    const p = a?.path ?? ''
    const kind =
      a?.kind === 'editor'
        ? 'editor'
        : a?.kind === 'music'
          ? 'music'
          : a?.kind === 'video'
            ? 'video'
            : 'gallery'
    // the music window is also a view of the playlist, so an empty path is legitimate there
    if (!isRemotePath(p) && !path.isAbsolute(p) && !(kind === 'music' && p === '')) {
      return { error: 'bad_path' }
    }
    return openStandalone(kind, p)
  })
  ipcMain.handle('fs:symlink', (_e, target: string, linkPath: string) => {
    if (isRemotePath(target) || isRemotePath(linkPath)) {
      return { ok: false, error: 'symbolic links are not supported on a remote server' }
    }
    return typeof target === 'string' && typeof linkPath === 'string'
      ? createSymlink(target, linkPath)
      : { ok: false, error: 'invalid paths' }
  })
  /**
   * One shortcut for the whole app (menu, MCP): a `.lnk` on Windows, a symlink everywhere else.
   * The desktop path comes from Electron so a redirected/OneDrive desktop is honoured.
   */
  ipcMain.handle('fs:shortcut', (_e, a: { targets?: string[]; where?: string }) => {
    const targets = (Array.isArray(a?.targets) ? a.targets : []).filter(
      (p): p is string => typeof p === 'string' && p !== ''
    )
    if (targets.some(isRemotePath)) {
      return { done: 0, created: [], errors: ['shortcuts are local only'] }
    }
    return createShortcuts(targets, a?.where === 'desktop' ? 'desktop' : 'here', {
      desktopDir: app.getPath('desktop'),
      writeLink: (link, details) => Promise.resolve(shell.writeShortcutLink(link, 'create', details))
    })
  })
  ipcMain.handle('fs:renameMany', (_e, pairs: { from: string; to: string }[]) =>
    engine.renameMany(pairs ?? [])
  )
  ipcMain.handle(
    'job:start',
    (_e, a: { kind: JobKind; sources: string[]; dest: string; opts?: JobOpts }) =>
      engine.start(a.kind, a.sources ?? [], a.dest, a.opts ?? {})
  )
  ipcMain.handle('job:pause', (_e, id: string) => engine.pause(id))
  ipcMain.handle('job:resume', (_e, id: string) => engine.resume(id))
  ipcMain.handle('job:cancel', (_e, id: string) => engine.cancel(id))
  ipcMain.handle('job:list', () => engine.list())
  ipcMain.handle('job:files', (_e, id: string) => (typeof id === 'string' ? engine.files(id) : null))
  ipcMain.handle('job:clear', () => engine.clear())
  ipcMain.handle('undo:run', () => engine.undo())
  ipcMain.handle('undo:depth', () => engine.undoDepth())
  /**
   * `shell.openPath` resolves to '' even when the hand-off failed, so the default app is
   * looked up and spawned directly — the same path «Open with» proves works.
   * An executable script/AppImage with the exec bit is run instead; a remote file never is.
   */
  ipcMain.handle('shell:open', async (_e, p: string) => {
    if (!isRemotePath(p) && !path.isAbsolute(p)) return { error: 'bad_path' }
    try {
      if (!isRemotePath(p) && (await isRunnableFile(p))) return await runFile(p)
      const local = isRemotePath(p) ? await localCopyOf(p, await remoteVersionOf(p)) : p
      return await openWithDefault(local)
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  /** A file the user marked executable: run it as itself, even when it is neither a script nor an AppImage. */
  ipcMain.handle('shell:run', async (_e, p: string) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return { error: 'bad_path' }
    const st = await fs.stat(p).catch(() => null)
    if (!st?.isFile() || (st.mode & 0o111) === 0) return { error: 'not_executable' }
    return runFile(p)
  })

  /** Windows: the folder a `.lnk` points into, so the pane can navigate there instead of the desktop. */
  ipcMain.handle('apps:shortcutTarget', (_e, p: string) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return ''
    return shortcutTarget(p)
  })

  /** Windows: an elevated start — UAC decides, and a refusal comes back as an error. */
  ipcMain.handle('apps:runAdmin', (_e, p: string) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return { error: 'bad_path' }
    return runFileAsAdmin(p)
  })

  /** Save an image from the renderer's clipboard as a normal file in the target folder. */
  /** Main-process clipboard write works even when the renderer is not focused. */
  /** A real file list (text/uri-list) so Telegram/Dolphin paste the file, not its path. */
  ipcMain.handle('clipboard:copyFiles', async (_e, a: { paths?: string[]; cut?: boolean }) => {
    const paths = (a?.paths ?? []).filter((p) => typeof p === 'string' && (isRemotePath(p) || path.isAbsolute(p)))
    const local: string[] = []
    for (const p of paths) {
      if (!isRemotePath(p)) {
        local.push(p)
        continue
      }
      try {
        local.push(await localCopyOf(p, await remoteVersionOf(p)))
      } catch {
        // a remote file that cannot be cached must not clear the rest of the clipboard selection
      }
    }
    return copyFilesToClipboard(local, !!a?.cut)
  })
  ipcMain.handle('clipboard:releaseFiles', () => {
    releaseFileClipboard()
    return true
  })
  /**
   * Files another application put on the clipboard, so Ctrl+V works after a copy in Explorer,
   * Finder or Dolphin. The per-platform flavours are read in `fileclip.ts`.
   */
  ipcMain.handle('clipboard:readFiles', async () => {
    const clip = await readClipboardFiles()
    // the queue can only act on absolute local paths and URIs the app understands
    return { paths: clip.paths.filter((p) => isRemotePath(p) || path.isAbsolute(p)), cut: clip.cut }
  })
  ipcMain.handle('clipboard:writeText', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })
  ipcMain.handle('clipboard:saveImage', (_e, a: { dir: string; name: string; data: Uint8Array }) =>
    clipboardImageAny(a?.dir ?? '', a?.name ?? '', a?.data ?? new Uint8Array())
  )

  /** Opening a remote file with a local app first materializes it in the cache. */
  const localForApp = async (p: string): Promise<string | null> => {
    if (path.isAbsolute(p)) return p
    if (!isRemotePath(p)) return null
    try {
      return await localCopyOf(p, await remoteVersionOf(p))
    } catch {
      return null
    }
  }
  ipcMain.handle('apps:list', async (_e, p: string) => {
    const local = await localForApp(p)
    return local ? listApps(local) : []
  })
  ipcMain.handle('apps:openWith', async (_e, a: { path?: string; all?: boolean }) => {
    const local = await localForApp(a?.path ?? '')
    if (!local) return { mime: '', canSetDefault: false, apps: [] }
    const info = await openWithInfo(local, !!a.all)
    return { ...info, apps: await withAppIcons(info.apps) }
  })
  ipcMain.handle('apps:setDefault', async (_e, a: { path?: string; id?: string }) => {
    const local = await localForApp(a?.path ?? '')
    return local && typeof a?.id === 'string' ? setDefaultApp(local, a.id) : { error: 'bad_path' }
  })
  ipcMain.handle('apps:default', async (_e, p: string) => {
    const local = await localForApp(p)
    return local ? defaultApp(local) : null
  })
  ipcMain.handle('apps:launch', async (_e, id: string, p: string) => {
    // Windows ids are `assoc:Photos` / `progid:…` / `exe:…`; an absolute path is only the
    // Linux `.desktop` and macOS `.app` shape.
    const known =
      process.platform === 'win32'
        ? typeof id === 'string' && /^(assoc|progid|exe|appid):.+/.test(id)
        : typeof id === 'string' && path.isAbsolute(id)
    const local = await localForApp(p)
    if (!known || !local) return { error: 'bad_path' }
    return launchApp(id, local)
  })
  ipcMain.handle('desktop:isDefaultFileManager', () => isDefaultFileManager())
  ipcMain.handle('desktop:setDefaultFileManager', async () => {
    const res = await setDefaultFileManager(process.execPath, app.getAppPath(), app.isPackaged)
    // remember what the classes' default verbs were so «undo» restores them exactly
    if (res.ok && res.previous) writeStore('windows-shell', res.previous)
    return { ok: res.ok, error: res.error }
  })
  ipcMain.handle('desktop:clearDefaultFileManager', async () => {
    if (process.platform !== 'win32') return { ok: false }
    const previous = readStore<Record<string, string>>('windows-shell')
    const res = await clearDefaultFileManagerWindows(previous)
    writeStore('windows-shell', null)
    return res
  })
  ipcMain.handle('window:control', (e, action: 'minimize' | 'maximize' | 'close') => {
    const w = senderWindow(e)
    if (!w) return
    if (action === 'minimize') w.minimize()
    else if (action === 'maximize') (w.isMaximized() ? w.unmaximize() : w.maximize())
    else w.close()
  })
  ipcMain.handle('app:quit', () => {
    // the tray keeps the window alive on close; a quit must not be turned into a hide
    quitting = true
    app.quit()
    return true
  })
  ipcMain.handle('window:isMax', (e) => !!senderWindow(e)?.isMaximized())
  ipcMain.handle('window:fullscreen', (e, on: boolean) => {
    const w = senderWindow(e)
    if (w) {
      applyFullscreen(w, !!on)
      w.webContents.send('window:fullscreen-state', !!on)
    }
    return !!on
  })
  ipcMain.handle('window:getChrome', () => chrome)
  app.on('before-quit', () => {
    quitting = true
  })
  ipcMain.handle(
    'window:setTray',
    (
      _e,
      a: { minimize?: boolean; close?: boolean; show?: string; quit?: string }
    ) => {
      trayPrefs = singleInstanceEnabled
        ? { minimize: a?.minimize === true, close: a?.close === true }
        : { minimize: false, close: false }
      ensureTray({
        show: String(a?.show ?? 'Show window'),
        quit: String(a?.quit ?? 'Quit')
      })
      return trayPrefs
    }
  )
  ipcMain.handle('window:setChrome', async (_e, next: Chrome) => {
    chrome = { customTitlebar: !!next.customTitlebar, rounded: !!next.rounded }
    await saveChrome(chrome)
    // frame/transparent cannot change on a live window: rebuild it, the UI comes back from the store
    const old = win
    protocol.handle('thumb', serveThumb)

  ipcMain.handle('thumbs:clear', () => clearThumbs())

  win = createWindow()
    if (old && !old.isDestroyed()) old.destroy()
    return chrome
  })
  ipcMain.handle('settings:export', async (_e, a: { prefs?: unknown }) => {
    const st = (await readState()) ?? {}
    return saveSettingsDialog(a?.prefs ?? st.prefs ?? {})
  })
  ipcMain.handle('settings:import', () => openSettingsDialog())
  ipcMain.handle('state:get', () => readState())
  ipcMain.handle('state:set', async (_e, s: unknown) => {
    writeStore('state', s)
    return true
  })
  /** Preferences are written at once: closing right after a change must not lose it. */
  ipcMain.handle('state:setPrefs', async (_e, prefs: unknown) => {
    const st = (await readState()) ?? {}
    writeStore('state', { ...st, prefs })
    return true
  })
  /**
   * A viewer/editor window changes one preference without owning the whole object: merge it into
   * the stored prefs and tell every window, so the main window does not overwrite it later.
   */
  ipcMain.handle('state:patchPrefs', async (_e, patch: Record<string, unknown>) => {
    const st = (await readState()) ?? {}
    const prefs = { ...(st.prefs ?? {}), ...(patch ?? {}) }
    writeStore('state', { ...st, prefs })
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('state:prefs-patch', patch)
    }
    return prefs
  })

  ipcMain.handle('state:marks', async (_e, change?: { path?: string; on?: boolean }) => {
    const st = (await readState()) ?? {}
    let marks: string[] = Array.isArray(st.marks)
      ? st.marks.filter((m: unknown): m is string => typeof m === 'string' && path.isAbsolute(m))
      : []
    if (change && typeof change.path === 'string' && path.isAbsolute(change.path)) {
      const has = marks.includes(change.path)
      if (change.on === true && !has) marks = [...marks, change.path]
      if (change.on === false && has) marks = marks.filter((m) => m !== change.path)
      writeStore('state', { ...st, marks })
      // the dialog and the main window share one bookmark list; tell every open window
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('state:marks', marks)
      }
    }
    return marks
  })

  ipcMain.handle('portal:request', (e): PortalRequestData | null => portalServer.requestFor(e.sender.id))
  ipcMain.handle('portal:respond', (e, result: { paths: string[] } | null) => portalServer.respond(e.sender.id, result))
  ipcMain.handle('portal:rememberDir', async (_e, dir: string) => {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false
    const st = (await readState()) ?? {}
    const prefs = { ...(st.prefs ?? {}), pickerLastDir: dir }
    writeStore('state', { ...st, prefs })
    return true
  })
  ipcMain.handle('portal:status', () => ({
    supported: process.platform === 'linux',
    installed: portalInstalled(),
    running: portalServer.running,
    error: portalError
  }))
  ipcMain.handle('portal:configure', async (_e, enabled: boolean) => {
    portalError = ''
    try {
      if (enabled) {
        // Own the bus name before the frontend reloads its configuration; otherwise a pending
        // chooser request can activate a second process while systemctl is still waiting.
        await portalServer.start()
        await installPortal()
      } else {
        portalServer.stop()
        await uninstallPortal()
      }
    } catch (e) {
      portalError = e instanceof Error ? e.message : String(e)
    }
    return {
      supported: process.platform === 'linux',
      installed: portalInstalled(),
      running: portalServer.running,
      error: portalError || undefined
    }
  })

  if (portalOnly || bootPrefs.portalPicker === true) {
    await portalServer.start().catch((e) => {
      portalError = e instanceof Error ? e.message : String(e)
      console.error('MFM portal backend:', portalError)
    })
  }

  // Windows: Win+E goes to a keyboard-hook helper (see wine-hook.ts); the pref owns its lifetime
  if (process.platform === 'win32' && bootPrefs.winE !== false) {
    const takeover = winETakeover(true, bootPrefs.winEAutostart !== false)
    if (!takeover.ok && takeover.error) console.error('MFM Win+E takeover:', takeover.error)
  }

  const opens = pendingOpens.length ? [...pendingOpens] : firstPath ? [firstPath] : []
  pendingOpens.length = 0
  if (opens.length && win) {
    win.webContents.once('did-finish-load', () => {
      for (const p of opens) win?.webContents.send('app:open-path', p)
    })
  }

  // SMOKE_SHOT=<file.png> renders the window once, saves a screenshot and quits; SMOKE_JS drives the UI first.
  const shot = process.env['SMOKE_SHOT']
  const js = process.env['SMOKE_JS']
  if (shot && win) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (js && win) {
          const out = await win.webContents.executeJavaScript(js).catch((e) => 'ERR ' + e)
          if (out !== undefined) console.log('SMOKE_JS_OUT ' + JSON.stringify(out))
        }
        await new Promise((r) => setTimeout(r, 900))
        const img = await win!.webContents.capturePage()
        await fs.writeFile(shot, img.toPNG())
        console.log('SMOKE_OK ' + shot)
        app.quit()
      }, 900)
    })
  }

  app.on('activate', () => {
    if (!portalOnly && BrowserWindow.getAllWindows().length === 0) win = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
