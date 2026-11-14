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
  shell
} from 'electron'
import { constants as fsConstants, existsSync, readFileSync, writeFileSync, watch as fsWatch, promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { extract, listArchive, createZip, type ZipLevel } from './archives.ts'
import { targetPath } from './launch-path.ts'
import { saveImage, saveImageAs } from './image.ts'
import { hashMany } from './hash.ts'
import { iconSetPaths, iconsIn, themeDirs } from './icons.ts'
import { readNativeFolderLook } from './folderlook.ts'
import { preview } from './preview.ts'
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
  type FolderFormat,
  type FolderMeta
} from './meta.ts'
import { htmlToPdf, readTextFile, writeTextFile } from './editor.ts'
import { fitWindow } from './window-bounds.ts'
import {
  defaultApp,
  isDefaultFileManager,
  launchApp,
  listApps,
  mimeForPath,
  openWithDefault,
  openWithInfo,
  setDefaultApp,
  setDefaultFileManager,
  type DesktopApp
} from './apps.ts'
import { appIconFile } from './appicons.ts'
import { openTerminal, revealFile, runCustomCommand, startFileDrag } from './desktop.ts'
import { readTags, writeId3 } from './metadata.ts'
import { execFile } from 'node:child_process'
import { clearThumbs, thumbFor } from './thumbs.ts'
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
import { copyFilesToClipboard, releaseFileClipboard } from './fileclip.ts'
import { applySync, compareTrees, diffFiles, type SyncRow } from './sync.ts'
import { convertImages, type ConvertOpts } from './convert.ts'
import { exportListing, type ExportRow } from './export.ts'
import { createEngine, type JobKind, type JobOpts } from './jobs.ts'
import { createSymlink, freeName, remove } from './ops.ts'
import { findDupes, walk, type WalkOpts } from './search.ts'
import { breakdown, type BreakdownMode } from './breakdown.ts'
import { listDrives, mountDrive, unmountDrive } from './drives.ts'
import { dirs } from './dirs.ts'
import type { DirRef, Entry } from './types.ts'
import { PortalServer, type PortalRequestData } from './portal.ts'
import { installPortal, portalInstalled, uninstallPortal } from './portal-install.ts'

// mfm:// serves local files to <img> so the renderer never gets a filesystem API.
protocol.registerSchemesAsPrivileged([
  { scheme: 'mfm', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

type Chrome = { customTitlebar: boolean; rounded: boolean }

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

// frame/transparent are window-construction options, so the chrome choice is read before the window exists
let chrome: Chrome = {
  customTitlebar: bootPrefs.titlebar !== 'system' && boot.chrome?.customTitlebar !== false,
  rounded: bootPrefs.rounded !== false && boot.chrome?.rounded !== false
}
let win: BrowserWindow | null = null

const firstPath = targetPath(process.argv, app.getAppPath() || process.cwd())
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

// single instance: a second launch focuses the window and opens the path it was given
if (bootPrefs.singleInstance !== false && !process.env['SMOKE_SHOT']) {
  if (!app.requestSingleInstanceLock()) {
    // Exit synchronously: app.quit() still let `whenReady` run and bind the MCP port that the
    // first instance owns, which surfaced as EADDRINUSE + a main-process error dialog.
    process.exit(0)
  }
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--portal-backend')) void portalServer.start().catch(() => undefined)
    if (!win || portalOnly) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    const target = targetPath(argv, app.getAppPath() || process.cwd())
    if (target) win.webContents.send('app:open-path', target)
  })
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
  const dirents = await fs.readdir(dir, { withFileTypes: true })
  let entries: Entry[] = dirents
    .filter((d) => showHidden || !d.name.startsWith('.'))
    .map((d) => ({
      name: d.name,
      path: path.join(dir, d.name),
      dir: d.isDirectory(),
      size: 0,
      mtime: 0,
      ext: path.extname(d.name).slice(1).toLowerCase(),
      link: d.isSymbolicLink() || undefined
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
  if (!showHidden) entries = entries.filter((e) => !e.hidden)
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
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
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
    w.show()
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
  globalShortcut.unregisterAll()
  for (const w of childWindows) if (!w.isDestroyed()) w.destroy()
  portalServer.stop()
  void stopMcp()
})

/**
 * Fill in the icons a platform did not resolve itself. macOS hands back `.app` paths and no icon,
 * so Electron reads the bundle icon once per app and caches the PNG (see `appicons.ts`).
 */
async function withAppIcons(apps: DesktopApp[]): Promise<DesktopApp[]> {
  if (process.platform !== 'darwin') return apps
  const dir = path.join(app.getPath('userData'), 'appicons')
  return Promise.all(
    apps.map(async (a) => (a.iconPath ? a : { ...a, iconPath: await appIconFile(a.id, dir) }))
  )
}

/** Window IPC must act on the window that asked: viewer/editor windows are separate. */
const senderWindow = (e: Electron.IpcMainInvokeEvent): BrowserWindow | null =>
  BrowserWindow.fromWebContents(e.sender) ?? win

/** Track the standalone viewer/editor windows so quitting closes them too. */
const childWindows = new Set<BrowserWindow>()

function openStandalone(kind: 'gallery' | 'editor', file: string): { ok: true } | { error: string } {
  try {
    const frameless = chrome.customTitlebar
    const w = new BrowserWindow({
      width: kind === 'gallery' ? 1100 : 980,
      height: kind === 'gallery' ? 760 : 720,
      minWidth: 520,
      minHeight: 380,
      title: path.basename(file),
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
    w.on('closed', () => childWindows.delete(w))
    w.on('maximize', () => w.webContents.send('window:maximized', true))
    w.on('unmaximize', () => w.webContents.send('window:maximized', false))
    w.once('ready-to-show', () => w.show())
    const query = { [kind === 'gallery' ? 'gallery' : 'editor']: '1', path: file }
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

app.whenReady().then(async () => {
  protocol.handle('mfm', async (req) => {
    const p = decodeURIComponent(new URL(req.url).pathname)
    if (!path.isAbsolute(p)) return new Response('bad path', { status: 400 })
    const res = await net.fetch(pathToFileURL(p).toString())
    // without CORS the renderer can display the image but a canvas stays tainted and cannot be saved
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(res.body, { status: res.status, headers })
  })

  protocol.handle('thumb', async (req) => {
    const url = new URL(req.url)
    const p = decodeURIComponent(url.pathname)
    const side = Number(url.searchParams.get('s') ?? 256) || 256
    if (!path.isAbsolute(p)) return new Response('bad path', { status: 400 })
    const file = await thumbFor(p, side)
    if (!file) return new Response('no thumb', { status: 404 })
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    // a versioned URL (?v=mtime-size) is immutable: a changed file gets a new URL. Without one the
    // renderer cannot tell us the file changed, so it must revalidate instead of trusting a day-old hit
    headers.set('Cache-Control', url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache')
    return new Response(res.body, { status: res.status, headers })
  })

  ipcMain.handle('thumbs:clear', () => clearThumbs())

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
  app.on('will-quit', () => closeWatched())

  if (!portalOnly) win = createWindow()
  const engine = createEngine((job) => {
    if (win && !win.isDestroyed()) win.webContents.send('job:update', job)
  })

  ipcMain.handle('fs:list', async (_e, dir: string, showHidden: boolean, dims = false) => {
    const l = await list(dir, showHidden, dims)
    const meta = path.isAbsolute(dir) ? await readMeta(dir) : null
    // file colours live in the parent folder's marker; folders carry their own colour already
    if (meta?.colors) {
      for (const e of l.entries) if (!e.dir && meta.colors[e.name]) e.color = meta.colors[e.name]
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
  /** Drag debugging: MFM_DRAG_DEBUG=1 keeps one session's drag lifecycle in userData. */
  ipcMain.handle('debug:log', (_e, msg: string) => {
    if (process.env.MFM_DRAG_DEBUG !== '1') return false
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

  ipcMain.handle('fs:properties', (_e, p: string) => propertiesOf(p))

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
    if (!path.isAbsolute(p)) return { error: 'bad_path' }
    const max = Math.min(32 * 1024 * 1024, Math.max(1, Number(a?.max ?? 32 * 1024 * 1024)))
    const st = await fs.stat(p).catch(() => null)
    if (!st?.isFile()) return { error: 'not_a_file' }
    if (st.size > max) return { error: 'too_large' }
    const data = await fs.readFile(p).catch(() => null)
    return data ? { data } : { error: 'read_failed' }
  })
  ipcMain.handle('fs:imageData', (_e, p: string) => readImageData(p))
  ipcMain.handle('image:save', (_e, a: { src: string; dataUrl: string; mode: 'overwrite' | 'copy' }) =>
    saveImage(a.src, a.dataUrl, a.mode)
  )
  ipcMain.handle('fs:dirs', (_e, dir: string, showHidden = false, followLinks = false) =>
    dirs(dir, { showHidden: !!showHidden, followLinks: !!followLinks })
  )
  ipcMain.handle('fs:roots', () => roots())
  ipcMain.handle('fs:home', () => os.homedir())
  ipcMain.handle('drives:list', () => listDrives())
  ipcMain.handle('drives:mount', (_e, dev: string) => mountDrive(dev))
  ipcMain.handle('drives:unmount', (_e, dev: string) => unmountDrive(dev))
  ipcMain.handle('fs:size', (_e, p: string) =>
    path.isAbsolute(p) ? dirSize(p) : { bytes: 0, files: 0, capped: true }
  )
  ipcMain.handle('fs:remove', (_e, a: { paths: string[]; permanent: boolean }) =>
    remove(a.paths ?? [], a.permanent ? {} : { trash: (p) => shell.trashItem(p) })
  )
  ipcMain.handle('fs:walk', (_e, dir: string, opts: WalkOpts) =>
    path.isAbsolute(dir) ? walk(dir, opts ?? {}) : { entries: [], scanned: 0, capped: false }
  )
  ipcMain.handle('fs:dupes', (_e, dir: string) =>
    path.isAbsolute(dir) ? findDupes(dir) : { entries: [], capped: false }
  )
  ipcMain.handle('fs:archive', (_e, p: string) =>
    path.isAbsolute(p) ? listArchive(p) : { entries: [], capped: false }
  )
  ipcMain.handle(
    'fs:archiveCreate',
    (_e, a: { dir: string; name: string; sources: string[]; level?: number }) =>
      createZip(
        a?.dir ?? '',
        String(a?.name ?? 'archive'),
        a?.sources ?? [],
        Math.min(9, Math.max(0, Number(a?.level ?? 6))) as ZipLevel
      )
  )
  ipcMain.handle('fs:extract', (_e, a: { archive: string; names: string[]; dest: string }) =>
    path.isAbsolute(a.archive) && path.isAbsolute(a.dest)
      ? extract(a.archive, a.names ?? [], a.dest)
      : { done: 0, errors: ['مسیر نامعتبر'] }
  )
  ipcMain.handle('meta:set', (_e, a: { dir: string; meta: FolderMeta }) =>
    path.isAbsolute(a.dir) ? setMeta(a.dir, a.meta ?? {}) : null
  )
  ipcMain.handle('hotkey:register', (_e, accel: string) => registerHotkey(accel))
  ipcMain.handle('app:runScript', (_e, a: { command?: string; path?: string; dir?: string }) => runScriptCommand(a))
  ipcMain.handle('app:runCustomCommand', (_e, a: { command?: string; path?: string }) =>
    runCustomCommand(String(a?.command ?? ''), String(a?.path ?? ''))
  )
  ipcMain.handle('app:terminal', (_e, dir: string) => openTerminal(dir ?? ''))
  ipcMain.handle('app:reveal', (_e, p: string) => revealFile(p ?? ''))
  ipcMain.on('app:dragOut', (e, files: string[]) => {
    void startFileDrag(e.sender, files ?? [])
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
        const dir = needAbs(args.path)
        const l = await list(dir, !!args.hidden, !!args.dims)
        const meta = await readMeta(dir)
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
        return dirs(needAbs(args.path), { showHidden: !!args.hidden, followLinks: !!args.links })
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
        return propertiesOf(needAbs(args.path))
      case 'statfs': {
        const st = await fs.statfs(needAbs(args.path)).catch(() => null)
        return st ? { free: Number(st.bavail) * Number(st.bsize), size: Number(st.blocks) * Number(st.bsize) } : null
      }
      case 'size':
        return dirSize(needAbs(args.path))
      case 'breakdown':
        return breakdown(needAbs(args.path), { mode: args.mode === 'level1' ? 'level1' : 'all' })
      case 'hash':
        return hashMany(absList(args.paths), String(args.algo ?? 'sha256'))
      case 'dupes':
        return findDupes(needAbs(args.dir), { limit: Number(args.limit ?? 4000) })
      case 'search':
        return searchIndex(searchDbFile(), String(args.query ?? ''), Number(args.limit ?? 100))
      case 'search_stats':
        return indexStats(searchDbFile())
      case 'search_sizes':
        return indexSizes(searchDbFile(), absList(args.dirs).slice(0, 500))
      case 'preview':
        return preview(needAbs(args.path), Number(args.maxKB ?? 200))
      case 'read_text':
        return readTextFile(needAbs(args.path))
      case 'archive_list':
        return listArchive(needAbs(args.path))
      case 'diff':
        return diffFiles(needAbs(args.a), needAbs(args.b))
      case 'tags': {
        const out: Record<string, unknown> = {}
        for (const pp of absList(args.paths).slice(0, 200)) out[pp] = await readTags(pp)
        return out
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
      case 'jobs_list':
        return engine.list()
      case 'undo_depth':
        return engine.undoDepth()
      case 'state':
        return readStore('state') ?? {}
      case 'mcp_status': {
        const cfg = await readMcpConfig()
        return { mode: cfg.mode, port: cfg.port, log: await mcpLogTail(50) }
      }
      case 'apps':
        return listApps(needAbs(args.path), !!args.all)
      case 'app_default': {
        const d = await defaultApp(needAbs(args.path))
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
        return writeTextFile(needAbs(args.path), String(args.text ?? ''))
      case 'mkdir':
        return engine.makeDir(needAbs(args.dir), String(args.name ?? ''))
      case 'create_file':
        return engine.createFile(needAbs(args.dir), String(args.name ?? ''), typeof args.content === 'string' ? args.content : '')
      case 'rename': {
        const from = needAbs(args.path)
        return engine.renameMany([{ from, to: path.join(path.dirname(from), String(args.name ?? '')) }])
      }
      case 'rename_many': {
        const pairs: { from: string; to: string }[] = []
        for (const x of Array.isArray(args.pairs) ? args.pairs : []) {
          const from = abs(x?.from)
          const to = abs(x?.to)
          if (from && to) pairs.push({ from, to })
        }
        if (!pairs.length) throw new Error('pairs with absolute from/to are required')
        return engine.renameMany(pairs)
      }
      case 'copy':
      case 'move': {
        const dest = needAbs(args.dest)
        const files = absList(args.sources ?? args.paths)
        if (!files.length) throw new Error('paths are required')
        const opts: JobOpts = {
          skipExisting: !!args.skipExisting,
          newerOnly: !!args.newerOnly,
          limitBps: Number(args.limitBps ?? 0) || 0
        }
        return engine.start(tool === 'copy' ? 'copy' : 'move', files, dest, opts)
      }
      case 'trash':
        return remove(absList(args.paths), { trash: (p) => shell.trashItem(p) })
      case 'delete': {
        if (args.confirm !== true) throw new Error('permanent delete needs confirm:true')
        return remove(absList(args.paths), {})
      }
      case 'symlink':
        return createSymlink(needAbs(args.target), needAbs(args.link))
      case 'chmod': {
        const mode = Number(args.mode)
        if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('mode must be 0..0o7777')
        await fs.chmod(needAbs(args.path), mode)
        return { ok: true }
      }
      case 'extract':
        return extract(needAbs(args.archive), Array.isArray(args.names) ? args.names : [], needAbs(args.dest))
      case 'create_zip': {
        const level = Math.min(9, Math.max(0, Number(args.level ?? 6))) as ZipLevel
        return createZip(needAbs(args.dir), String(args.name ?? 'archive'), absList(args.sources), level)
      }
      case 'tags_write':
        return writeId3(needAbs(args.path), (args.fields ?? {}) as Record<string, string>)
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
        return readImageData(needAbs(args.path))
      case 'image_save':
        return saveImage(needAbs(args.src), String(args.dataUrl ?? ''), args.mode === 'overwrite' ? 'overwrite' : 'copy')
      case 'image_save_as':
        return saveImageAs(needAbs(args.src), String(args.dataUrl ?? ''))
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
      case 'job_start':
        return engine.start(
          (args.kind === 'move' ? 'move' : args.kind === 'copy' ? 'copy' : 'copy') as JobKind,
          absList(args.sources),
          needAbs(args.dest),
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
      case 'open':
        return openWithDefault(needAbs(args.path))
      case 'reveal':
        return revealFile(needAbs(args.path))
      case 'terminal':
        return openTerminal(needAbs(args.dir))
      case 'apps_launch':
        return launchApp(needAbs(args.id), needAbs(args.path))
      case 'app_set_default': {
        const file = needAbs(args.path)
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
        return compareTrees(needAbs(args.left), needAbs(args.right), !!args.deep, {
          compareBy: args.compareBy === 'ctime' || args.compareBy === 'hash' ? args.compareBy : 'mtime',
          ignore: Array.isArray(args.ignore) ? args.ignore.map(String).slice(0, 50) : []
        })
      case 'sync_apply':
        return applySync(
          needAbs(args.left),
          needAbs(args.right),
          (Array.isArray(args.rows) ? args.rows : []) as SyncRow[],
          args.mode === 'rtl' ? 'rtl' : 'ltr',
          !!args.deleteExtra,
          (p) => shell.trashItem(p)
        )
      case 'run_script':
        return runScriptCommand({
          command: String(args.command ?? ''),
          path: abs(args.path) ?? undefined,
          dir: abs(args.dir) ?? undefined
        })
      case 'run_custom_command':
        return runCustomCommand(String(args.command ?? ''), needAbs(args.path))
      case 'clipboard_image':
        return saveClipboardImage(needAbs(args.dir), String(args.name ?? 'clipboard.png'), Buffer.from(String(args.base64 ?? ''), 'base64'))
      case 'window': {
        if (!win) throw new Error('no window')
        const action = String(args.action ?? '')
        if (action === 'minimize') win.minimize()
        else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize()
        else if (action === 'close') win.close()
        else if (action === 'show') {
          win.show()
          win.focus()
        } else if (action === 'fullscreen') win.setFullScreen(args.on !== false)
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
    saveImageAs(a?.src ?? '', String(a?.dataUrl ?? ''), a?.dest)
  )
  ipcMain.handle('meta:writeTags', (_e, a: { path: string; fields: Record<string, string> }) =>
    writeId3(a?.path ?? '', a?.fields ?? {})
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
  ipcMain.handle(
    'sync:compare',
    (_e, a: { left: string; right: string; deep?: boolean; compareBy?: 'mtime' | 'ctime' | 'hash'; ignore?: string[] }) =>
      compareTrees(a?.left ?? '', a?.right ?? '', !!a?.deep, {
        compareBy: a?.compareBy,
        ignore: Array.isArray(a?.ignore) ? a.ignore.slice(0, 50) : []
      })
  )
  ipcMain.handle(
    'sync:apply',
    (_e, a: { left: string; right: string; rows: SyncRow[]; mode: 'ltr' | 'rtl'; deleteExtra?: boolean }) =>
      applySync(a.left, a.right, a.rows ?? [], a.mode, !!a.deleteExtra, (p) => shell.trashItem(p))
  )
  ipcMain.handle('fs:diff', (_e, a: { a: string; b: string }) => diffFiles(a?.a ?? '', a?.b ?? ''))
  ipcMain.handle('fs:readText', (_e, p: string) => readTextFile(p ?? ''))
  ipcMain.handle('drafts:get', (_e, p: string) =>
    path.isAbsolute(p ?? '') ? drafts.get(p) : null
  )
  ipcMain.handle('drafts:set', (_e, a: { path?: string; text?: string }) => {
    const p = a?.path ?? ''
    if (!path.isAbsolute(p) || typeof a?.text !== 'string') return null
    if (a.text.length > 8 * 1024 * 1024) return null // the same ceiling as writeText
    return drafts.set(p, a.text)
  })
  ipcMain.handle('drafts:clear', (_e, p: string) => {
    if (path.isAbsolute(p ?? '')) drafts.clear(p)
    return true
  })
  ipcMain.handle('fs:writeText', (_e, a: { path: string; text: string }) =>
    writeTextFile(a?.path ?? '', String(a?.text ?? ''))
  )
  ipcMain.handle('pdf:html', (_e, a: { html: string; out: string; theme?: string }) =>
    htmlToPdf(String(a?.html ?? ''), a?.out ?? '', a?.theme ?? 'dark')
  )
  ipcMain.handle('fs:preview', (_e, p: string, maxKB?: number) =>
    path.isAbsolute(p) ? preview(p, maxKB) : null
  )
  ipcMain.handle('fs:hash', (_e, paths: string[], algo: string) =>
    hashMany((paths ?? []).filter((p) => path.isAbsolute(p)), algo || 'sha256')
  )
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
    if (!path.isAbsolute(a?.path ?? '')) return { error: 'bad_path' }
    return openStandalone(a?.kind === 'editor' ? 'editor' : 'gallery', a.path!)
  })
  ipcMain.handle('fs:symlink', (_e, target: string, linkPath: string) =>
    typeof target === 'string' && typeof linkPath === 'string'
      ? createSymlink(target, linkPath)
      : { ok: false, error: 'invalid paths' }
  )
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
  ipcMain.handle('job:clear', () => engine.clear())
  ipcMain.handle('undo:run', () => engine.undo())
  ipcMain.handle('undo:depth', () => engine.undoDepth())
  /**
   * `shell.openPath` resolves to '' even when the hand-off failed, so the default app is
   * looked up and spawned directly — the same path «Open with» proves works.
   */
  ipcMain.handle('shell:open', async (_e, p: string) => {
    if (!path.isAbsolute(p)) return { error: 'bad_path' }
    return openWithDefault(p)
  })

  /** Save an image from the renderer's clipboard as a normal file in the target folder. */
  /** Main-process clipboard write works even when the renderer is not focused. */
  /** A real file list (text/uri-list) so Telegram/Dolphin paste the file, not its path. */
  ipcMain.handle('clipboard:copyFiles', (_e, a: { paths?: string[]; cut?: boolean }) =>
    copyFilesToClipboard((a?.paths ?? []).filter((p) => path.isAbsolute(p)), !!a?.cut)
  )
  ipcMain.handle('clipboard:releaseFiles', () => {
    releaseFileClipboard()
    return true
  })
  ipcMain.handle('clipboard:writeText', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })
  ipcMain.handle('clipboard:saveImage', (_e, a: { dir: string; name: string; data: Uint8Array }) =>
    saveClipboardImage(a?.dir ?? '', a?.name ?? '', a?.data ?? new Uint8Array())
  )

  ipcMain.handle('apps:list', (_e, p: string) => (path.isAbsolute(p) ? listApps(p) : []))
  ipcMain.handle('apps:openWith', async (_e, a: { path?: string; all?: boolean }) => {
    if (!path.isAbsolute(a?.path ?? '')) return { mime: '', canSetDefault: false, apps: [] }
    const info = await openWithInfo(a.path!, !!a.all)
    return { ...info, apps: await withAppIcons(info.apps) }
  })
  ipcMain.handle('apps:setDefault', (_e, a: { path?: string; id?: string }) =>
    path.isAbsolute(a?.path ?? '') && typeof a?.id === 'string'
      ? setDefaultApp(a.path!, a.id)
      : { error: 'bad_path' }
  )
  ipcMain.handle('apps:default', (_e, p: string) => (path.isAbsolute(p) ? defaultApp(p) : null))
  ipcMain.handle('apps:launch', (_e, id: string, p: string) => {
    if (!path.isAbsolute(id) || !path.isAbsolute(p)) return { error: 'bad_path' }
    return launchApp(id, p)
  })
  ipcMain.handle('desktop:isDefaultFileManager', () => isDefaultFileManager())
  ipcMain.handle('desktop:setDefaultFileManager', () =>
    setDefaultFileManager(process.execPath, app.getAppPath())
  )
  ipcMain.handle('window:control', (e, action: 'minimize' | 'maximize' | 'close') => {
    const w = senderWindow(e)
    if (!w) return
    if (action === 'minimize') w.minimize()
    else if (action === 'maximize') (w.isMaximized() ? w.unmaximize() : w.maximize())
    else w.close()
  })
  ipcMain.handle('window:isMax', (e) => !!senderWindow(e)?.isMaximized())
  ipcMain.handle('window:fullscreen', (e, on: boolean) => {
    senderWindow(e)?.setFullScreen(!!on)
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
    protocol.handle('thumb', async (req) => {
    const url = new URL(req.url)
    const p = decodeURIComponent(url.pathname)
    const side = Number(url.searchParams.get('s') ?? 256) || 256
    if (!path.isAbsolute(p)) return new Response('bad path', { status: 400 })
    const file = await thumbFor(p, side)
    if (!file) return new Response('no thumb', { status: 404 })
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    // a versioned URL (?v=mtime-size) is immutable: a changed file gets a new URL. Without one the
    // renderer cannot tell us the file changed, so it must revalidate instead of trusting a day-old hit
    headers.set('Cache-Control', url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache')
    return new Response(res.body, { status: res.status, headers })
  })

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
