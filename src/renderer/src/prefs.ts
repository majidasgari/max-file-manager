import { t } from './i18n.ts'
import { COMMANDS, COMMAND_BY_ID, DEFAULT_SHORTCUTS } from './commands.ts'
import { DEFAULT_COLOR_THEME, isColorTheme } from './themes.ts'

/** The toolbar the app ships with; the user can change it in preferences. */
export const DEFAULT_TOOLBAR = [
  'newItem',
  'copy',
  'move',
  'edit',
  'rename',
  'trash',
  'size',
  'look',
  'previewPane',
  'undo',
  'newTab',
  'flat',
  'dupes',
  'terminal'
]

export type Lang = 'en' | 'fa'
export type View = 'list' | 'grid'
export type Layout = 'dual' | 'single'
export type DoubleClick = 'open' | 'gallery' | 'preview'
export type ColId = 'type' | 'size' | 'date' | 'mode' | 'owner' | 'links' | 'dims' | 'rating'

/** Optional columns, in the order the user arranged them (name is always first). */
export const colLabel = (id: string): string => {
  const c = COLUMNS.find((x) => x.id === id)
  return c ? t(c.label) : id
}

/** Persian stays the key; `colLabel` translates it at render time so a language switch applies. */
export const COLUMNS: { id: ColId; label: string }[] = [
  { id: 'type', label: 'نوع' },
  { id: 'size', label: 'اندازه' },
  { id: 'date', label: 'تاریخ' },
  { id: 'mode', label: 'مجوز' },
  { id: 'owner', label: 'مالک' },
  { id: 'links', label: 'لینک' },
  { id: 'dims', label: 'ابعاد' },
  { id: 'rating', label: 'امتیاز' }
]

/**
 * Every user-facing option in one place, mirroring the categories Directory Opus, Krusader and
 * FreeCommander use (see docs/PREFERENCES.md). Anything not listed here is not configurable yet.
 */
export type Prefs = {
  /** schema version, so a changed default binding can migrate exactly once */
  prefsVersion: number
  /** UI language; English is the default */
  lang: Lang
  // appearance
  /** 'system' follows the OS light/dark preference live */
  theme: 'dark' | 'light' | 'system'
  /** palette family id from themes.ts, applied on top of light/dark */
  colorTheme: string
  /** CSS family list for the whole UI; '' keeps the bundled Vazirmatn stack */
  fontFamily: string
  view: View
  foldersFirst: boolean
  showHidden: boolean
  /** show link indicator badge next to symbolic links (default false) */
  showSymlink: boolean
  /** share of the side preview/editor in single layout (0.25–0.8) */
  sideWidth: number
  /** share of the first pane in dual layout (0.2–0.8, default 0.5) */
  dualSplit: number
  columns: ColId[]
  /** pixel width per optional column; a missing entry uses the built-in width */
  colWidths: Record<string, number>
  /** fields shown small under a grid tile's name (same ids as the columns) */
  gridMeta: ColId[]
  sizeFormat: 'human' | 'bytes'
  dateFormat: 'iso' | 'jalali' | 'short'
  showSeconds: boolean
  /** lines a grid tile may use for its name (1..4); the tile grows with it */
  gridNameLines: number
  /** grid tile width in px (80..240); thumbnail and name box scale with it */
  tileSize: number
  /** file/folder icons: the bundled Pure set, the desktop icon theme, or our own line glyphs */
  fileIcons: 'pure' | 'system' | 'line'
  // window
  titlebar: 'app' | 'system'
  /** caption-button look; only used with the app's own title bar */
  titlebarButtons: 'default' | 'mcmojave' | 'windows' | 'minimal'
  /** physical side of the caption buttons */
  titlebarSide: 'left' | 'right'
  rounded: boolean
  layout: Layout
  sidebar: 'docked' | 'float'
  sidebarOpen: boolean
  sidebarWidth: number
  /** 1 = ultra mild (default), 2 = soft, 3 = gentle, 4 = medium, 5 = pronounced, 6 = vivid */
  sidebarTone: 1 | 2 | 3 | 4 | 5 | 6
  /** ids of sidebar sections currently collapsed ('places' | 'bookmarks' | 'labels') */
  sidebarCollapsed: string[]
  /** command id → accelerator text; '' means the command has no key */
  shortcuts: Record<string, string>
  /** command ids shown as buttons in the toolbar, in order */
  toolbar: string[]
  /** toolbar button look: icon only, icon with its label, or the label alone */
  toolbarMode: 'icon' | 'icon-text' | 'text'
  // tabs
  newTabPos: 'end' | 'next'
  middleClickClosesTab: boolean
  /** a pane with a single tab needs no tab strip */
  hideSingleTab: boolean
  /** show each tab folder's own icon next to its name */
  tabIcons: boolean
  /** folder path → tab colour (hex) chosen from the tab menu */
  tabColors: Record<string, string>
  // archives, gallery and preview
  zipLevel: number
  imageFormat: 'png' | 'jpeg' | 'webp'
  /** 50..100, only used for jpeg/webp */
  imageQuality: number
  slideshowSec: number
  galleryLoop: boolean
  previewMaxKB: number
  /** named window layouts (Opus «Layouts/Styles») */
  layouts: Record<string, NamedLayout>
  /** named name filters shown in the presets dialog */
  filters: Record<string, string>
  /** extension → colour for the small type dot */
  fileTypes: Record<string, string>
  /** folders the indexer walks (empty = the OS defaults at runtime) */
  searchRoots: string[]
  /** glob-ish names/paths the indexer skips */
  searchExclude: string[]
  /** double-tapping Shift opens the global search overlay */
  doubleShiftSearch: boolean
  /** show a folder tree inside every pane (Opus «Dual Tree») */
  paneTree: boolean
  /** the separate folder-tree pane: off, docked left or docked right */
  treePane: 'off' | 'left' | 'right'
  /** tree pane width in px (160..520) */
  treeWidth: number
  /** the tree follows the active pane's folder */
  treeAutoFocus: boolean
  /** the gallery's information/edit sidebar is visible when the viewer opens */
  galleryInfo: boolean
  /** user commands: name → shell line, `{path}` and `{dir}` are substituted */
  scripts: Record<string, string>
  // transfer filters
  transferSkipExisting: boolean
  transferNewerOnly: boolean
  /** KB/s ceiling for transfers, 0 = unlimited */
  speedLimitKB: number
  // file operations
  doubleClick: DoubleClick
  confirmDelete: boolean
  trashByDefault: boolean
  // launching
  /** provide the XDG file chooser used by Firefox and other portal-aware apps */
  portalPicker: boolean
  /** last folder accepted in the portal picker */
  pickerLastDir: string
  singleInstance: boolean
  /** hide the window in the tray when minimized / closed (needs single instance) */
  minimizeToTray: boolean
  closeToTray: boolean
  /** restore the last tabs or always open one folder */
  startup: 'session' | 'folder'
  hotkey: string
  hotkeyEnabled: boolean
  /** '' means: reopen the last session */
  startFolder: string
  /** extension → app that opens it, overriding the OS default */
  defaultApps: Record<string, { id: string; name: string }>
  /** custom background commands with %f substitution for file extensions or folders */
  customCommands: CustomCommand[]
  // icon packs (folder look)
  iconDirs: string[]
  iconTheme: string
}

export type CustomCommand = {
  id: string
  label: string
  pattern: string
  command: string
}

export const DEFAULT_FONT_FAMILY = "Vazirmatn, system-ui, 'Noto Sans', sans-serif"

/** A single family gets Vazirmatn as a Persian-capable fallback; a full stack is left alone. */
export const fontStack = (family: string): string => {
  const v = cleanFontFamily(family)
  if (!v) return DEFAULT_FONT_FAMILY
  return v.includes(',') ? v : `${v}, ${DEFAULT_FONT_FAMILY}`
}

/** Whatever the user typed must stay a family list, never break out of the CSS declaration. */
export const cleanFontFamily = (raw: unknown): string => {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[;{}()<>\\/\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 120)
}

export const DEFAULTS: Prefs = {
  prefsVersion: 2,
  lang: 'en',
  theme: 'dark',
  colorTheme: DEFAULT_COLOR_THEME,
  fontFamily: '',
  view: 'list',
  foldersFirst: true,
  showHidden: false,
  showSymlink: false,
  sideWidth: 0.5,
  dualSplit: 0.5,
  columns: ['type', 'size', 'date'],
  colWidths: {},
  gridMeta: ['size'],
  sizeFormat: 'human',
  dateFormat: 'iso',
  showSeconds: false,
  gridNameLines: 2,
  tileSize: 108,
  fileIcons: 'pure',
  titlebar: 'app',
  titlebarButtons: 'default',
  titlebarSide: 'right',
  rounded: true,
  layout: 'dual',
  sidebar: 'docked',
  sidebarOpen: true,
  sidebarWidth: 208,
  sidebarTone: 1,
  sidebarCollapsed: [],
  shortcuts: DEFAULT_SHORTCUTS,
  toolbar: DEFAULT_TOOLBAR,
  toolbarMode: 'icon-text',
  newTabPos: 'next',
  middleClickClosesTab: true,
  hideSingleTab: true,
  tabIcons: true,
  tabColors: {},
  doubleClick: 'gallery',
  zipLevel: 6,
  imageFormat: 'png',
  imageQuality: 90,
  slideshowSec: 3,
  galleryLoop: true,
  previewMaxKB: 200,
  layouts: {},
  filters: {},
  fileTypes: {},
  searchRoots: [],
  searchExclude: ['node_modules', '.git', '.cache', '.venv', 'dist', 'build', '*.tmp', '.Trash', 'snap'],
  doubleShiftSearch: true,
  paneTree: false,
  treePane: 'off',
  treeWidth: 232,
  treeAutoFocus: true,
  galleryInfo: true,
  scripts: {},
  transferSkipExisting: false,
  transferNewerOnly: false,
  speedLimitKB: 0,
  confirmDelete: true,
  trashByDefault: true,
  portalPicker: false,
  pickerLastDir: '',
  singleInstance: true,
  minimizeToTray: false,
  closeToTray: false,
  startup: 'session',
  hotkey: 'Super+E',
  hotkeyEnabled: false,
  startFolder: '',
  defaultApps: {},
  customCommands: [],
  iconDirs: [],
  iconTheme: ''
}

export type NamedLayout = {
  layout?: 'dual' | 'single'
  sidebar?: 'docked' | 'float'
  sidebarOpen?: boolean
  sidebarWidth?: number
  view?: 'list' | 'grid'
  columns?: string[]
  toolbar?: string[]
}

const COLS = new Set(['type', 'size', 'date', 'mode', 'owner', 'links', 'dims', 'rating'])

function normalLayouts(raw: unknown): Record<string, NamedLayout> {
  const out: Record<string, NamedLayout> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!name.trim() || !v || typeof v !== 'object') continue
    const l = v as NamedLayout
    const keep: NamedLayout = {}
    if (l.layout === 'dual' || l.layout === 'single') keep.layout = l.layout
    if (l.sidebar === 'docked' || l.sidebar === 'float') keep.sidebar = l.sidebar
    if (typeof l.sidebarOpen === 'boolean') keep.sidebarOpen = l.sidebarOpen
    if (typeof l.sidebarWidth === 'number' && Number.isFinite(l.sidebarWidth))
      keep.sidebarWidth = Math.min(600, Math.max(160, Math.round(l.sidebarWidth)))
    if (l.view === 'list' || l.view === 'grid') keep.view = l.view
    if (Array.isArray(l.columns)) keep.columns = l.columns.filter((c) => COLS.has(c))
    if (Array.isArray(l.toolbar)) keep.toolbar = l.toolbar.filter((c) => typeof c === 'string')
    out[name.slice(0, 60)] = keep
  }
  return out
}

function normalFilters(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (name.trim() && typeof v === 'string' && v.trim()) out[name.slice(0, 60)] = v.slice(0, 200)
  }
  return out
}

function normalScripts(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [name, cmd] of Object.entries(raw as Record<string, unknown>)) {
    if (name.trim() && typeof cmd === 'string' && cmd.trim()) out[name.slice(0, 40)] = cmd.slice(0, 500)
  }
  return out
}

function normalFileTypes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [ext, color] of Object.entries(raw as Record<string, unknown>)) {
    const e = ext.trim().toLowerCase().replace(/^\./, '')
    if (!/^[a-z0-9_+-]{1,16}$/.test(e)) continue
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) out[e] = color
  }
  return out
}

/** Only known commands survive; a missing or garbage value falls back to the default toolbar. */
function normalToolbar(raw: unknown): string[] {
  if (!Array.isArray(raw)) return DEFAULT_TOOLBAR
  let ids = raw.filter((id): id is string => typeof id === 'string' && !!COMMAND_BY_ID[id])
  if (ids.length === 0) return DEFAULT_TOOLBAR

  // Replace legacy 'mkdir' with 'newItem' (since 'newItem' already includes new folder)
  if (ids.includes('mkdir')) {
    ids = ids.filter((id) => id !== 'mkdir')
  }
  if (!ids.includes('newItem')) {
    ids = ['newItem', ...ids]
  }
  return ids
}

/** Only known commands survive; a missing or garbage value falls back to the default key. */
function normalShortcuts(raw: unknown): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULT_SHORTCUTS }
  if (raw && typeof raw === 'object') {
    for (const c of COMMANDS) {
      const v = (raw as Record<string, unknown>)[c.id]
      if (typeof v === 'string') out[c.id] = v.trim()
    }
  }
  return out
}

/** Tab colours are keyed by an absolute folder path and must stay real hex colours. */
function cleanTabColors(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) && (k.startsWith('/') || /^[A-Za-z]:[\\/]/.test(k))) {
      out[k] = v
    }
  }
  return out
}

/** Extension → app, restricted to a plain extension and an absolute .desktop path. */
function cleanDefaultApps(raw: unknown): Record<string, { id: string; name: string }> {
  const out: Record<string, { id: string; name: string }> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [rawExt, v] of Object.entries(raw as Record<string, unknown>)) {
    const ext = rawExt.toLowerCase().replace(/^\./, '').trim()
    if (!/^[a-z0-9._+-]{1,24}$/.test(ext)) continue
    if (!v || typeof v !== 'object') continue
    const app = v as { id?: unknown; name?: unknown }
    if (typeof app.id !== 'string' || !(app.id.startsWith('/') || /^[A-Za-z]:[\\/]/.test(app.id))) continue
    if (typeof app.name !== 'string' || !app.name.trim()) continue
    out[ext] = { id: app.id, name: app.name.trim().slice(0, 120) }
  }
  return out
}

function cleanCustomCommands(raw: unknown): CustomCommand[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((x): x is CustomCommand =>
      Boolean(
        x &&
        typeof x === 'object' &&
        typeof (x as CustomCommand).label === 'string' &&
        typeof (x as CustomCommand).pattern === 'string' &&
        typeof (x as CustomCommand).command === 'string'
      )
    )
    .map((x, i) => ({
      id: typeof x.id === 'string' && x.id.trim() ? x.id.trim() : `cmd_${Date.now()}_${i}`,
      label: x.label.trim().slice(0, 100),
      pattern: x.pattern.trim().slice(0, 100),
      command: x.command.trim().slice(0, 1000)
    }))
    .filter((x) => x.label && x.pattern && x.command)
}

/** Coerces whatever is on disk into a valid Prefs object — a bad value must never crash a boot. */
export function mergePrefs(raw: (Partial<Prefs> & { showTypeColumn?: boolean }) | null | undefined): Prefs {
  const p = { ...DEFAULTS, ...(raw ?? {}) }
  const rawVersion = Number((raw as { prefsVersion?: unknown } | null | undefined)?.prefsVersion)
  const version = Number.isFinite(rawVersion) && rawVersion > 0 ? rawVersion : 1
  const shortcuts = normalShortcuts(p.shortcuts)
  // v2 moved global search from Ctrl+Shift+K to Ctrl+K; only an unmodified old default is touched
  if (version < 2 && shortcuts.searchIndex === 'Ctrl+Shift+K') shortcuts.searchIndex = 'Ctrl+K'
  return {
    prefsVersion: Math.max(2, version),
    lang: p.lang === 'fa' ? 'fa' : 'en',
    theme: p.theme === 'light' || p.theme === 'system' ? p.theme : 'dark',
    colorTheme: isColorTheme(p.colorTheme) ? p.colorTheme : DEFAULT_COLOR_THEME,
    fontFamily: cleanFontFamily(p.fontFamily),
    view: p.view === 'grid' ? 'grid' : 'list',
    foldersFirst: p.foldersFirst !== false,
    showHidden: p.showHidden === true,
    showSymlink: p.showSymlink === true,
    sideWidth:
      typeof p.sideWidth === 'number' && Number.isFinite(p.sideWidth)
        ? Math.min(0.8, Math.max(0.25, p.sideWidth))
        : 0.5,
    dualSplit:
      typeof p.dualSplit === 'number' && Number.isFinite(p.dualSplit)
        ? Math.min(0.8, Math.max(0.2, p.dualSplit))
        : 0.5,
    columns: normalColumns(p.columns, p.showTypeColumn),
    colWidths: normalWidths(p.colWidths),
    gridMeta: normalGridMeta(p.gridMeta),
    sizeFormat: p.sizeFormat === 'bytes' ? 'bytes' : 'human',
    dateFormat: p.dateFormat === 'jalali' || p.dateFormat === 'short' ? p.dateFormat : 'iso',
    showSeconds: p.showSeconds === true,
    gridNameLines:
      typeof p.gridNameLines === 'number' && p.gridNameLines >= 1 && p.gridNameLines <= 4
        ? Math.round(p.gridNameLines)
        : 2,
    tileSize:
      typeof p.tileSize === 'number' && p.tileSize >= 80 && p.tileSize <= 240
        ? Math.round(p.tileSize)
        : 108,
    // old `theme` meant "the desktop icon theme"; keep that intent, everything else defaults to Pure
    fileIcons:
      p.fileIcons === 'line'
        ? 'line'
        : p.fileIcons === 'system' || (p.fileIcons as string) === 'theme'
          ? 'system'
          : 'pure',
    titlebar: p.titlebar === 'system' ? 'system' : 'app',
    titlebarButtons:
      p.titlebarButtons === 'mcmojave' || p.titlebarButtons === 'windows' || p.titlebarButtons === 'minimal'
        ? p.titlebarButtons
        : 'default',
    titlebarSide: p.titlebarSide === 'left' ? 'left' : 'right',
    rounded: p.rounded !== false,
    layout: p.layout === 'single' ? 'single' : 'dual',
    sidebar: p.sidebar === 'float' ? 'float' : 'docked',
    sidebarOpen: p.sidebarOpen !== false,
    sidebarWidth:
      typeof p.sidebarWidth === 'number' && Number.isFinite(p.sidebarWidth)
        ? Math.min(600, Math.max(160, Math.round(p.sidebarWidth)))
        : 208,
    sidebarTone:
      typeof p.sidebarTone === 'number' && [1, 2, 3, 4, 5, 6].includes(p.sidebarTone)
        ? (p.sidebarTone as 1 | 2 | 3 | 4 | 5 | 6)
        : 1,
    sidebarCollapsed:
      Array.isArray(p.sidebarCollapsed)
        ? p.sidebarCollapsed.filter((x): x is string => typeof x === 'string')
        : [],
    shortcuts,
    toolbar: normalToolbar(p.toolbar),
    toolbarMode:
      p.toolbarMode === 'icon' || p.toolbarMode === 'text' ? p.toolbarMode : 'icon-text',
    newTabPos: p.newTabPos === 'end' ? 'end' : 'next',
    middleClickClosesTab: p.middleClickClosesTab !== false,
    hideSingleTab: p.hideSingleTab !== false,
    tabIcons: p.tabIcons !== false,
    tabColors: cleanTabColors(p.tabColors),
    doubleClick: p.doubleClick === 'gallery' || p.doubleClick === 'preview' ? p.doubleClick : 'open',
    zipLevel:
      typeof p.zipLevel === 'number' && p.zipLevel >= 0 && p.zipLevel <= 9 ? Math.floor(p.zipLevel) : 6,
    imageFormat:
      p.imageFormat === 'jpeg' || p.imageFormat === 'webp' ? p.imageFormat : 'png',
    imageQuality:
      typeof p.imageQuality === 'number' && p.imageQuality >= 50 && p.imageQuality <= 100
        ? Math.round(p.imageQuality)
        : 90,
    slideshowSec:
      typeof p.slideshowSec === 'number' && p.slideshowSec >= 1 && p.slideshowSec <= 60
        ? Math.round(p.slideshowSec)
        : 3,
    galleryLoop: p.galleryLoop !== false,
    previewMaxKB:
      typeof p.previewMaxKB === 'number' && p.previewMaxKB >= 16 && p.previewMaxKB <= 8192
        ? Math.round(p.previewMaxKB)
        : 200,
    layouts: normalLayouts(p.layouts),
    filters: normalFilters(p.filters),
    fileTypes: normalFileTypes(p.fileTypes),
    searchRoots: Array.isArray(p.searchRoots)
      ? p.searchRoots.filter((r) => typeof r === 'string' && r.startsWith('/'))
      : [],
    searchExclude: Array.isArray(p.searchExclude)
      ? p.searchExclude.filter((r) => typeof r === 'string' && r.trim())
      : DEFAULTS.searchExclude,
    doubleShiftSearch: p.doubleShiftSearch !== false,
    paneTree: p.paneTree === true,
    treePane: p.treePane === 'left' || p.treePane === 'right' ? p.treePane : 'off',
    treeWidth:
      typeof p.treeWidth === 'number' && Number.isFinite(p.treeWidth)
        ? Math.min(520, Math.max(160, Math.round(p.treeWidth)))
        : 232,
    treeAutoFocus: p.treeAutoFocus !== false,
    galleryInfo: p.galleryInfo !== false,
    scripts: normalScripts(p.scripts),
    transferSkipExisting: p.transferSkipExisting === true,
    transferNewerOnly: p.transferNewerOnly === true,
    speedLimitKB:
      typeof p.speedLimitKB === 'number' && p.speedLimitKB > 0 && p.speedLimitKB < 10_000_000
        ? Math.floor(p.speedLimitKB)
        : 0,
    confirmDelete: p.confirmDelete !== false,
    trashByDefault: p.trashByDefault !== false,
    portalPicker: p.portalPicker === true,
    pickerLastDir:
      typeof p.pickerLastDir === 'string' && p.pickerLastDir.startsWith('/') ? p.pickerLastDir : '',
    singleInstance: p.singleInstance !== false,
    minimizeToTray: p.minimizeToTray === true,
    closeToTray: p.closeToTray === true,
    startup: p.startup === 'folder' ? 'folder' : 'session',
    hotkey: typeof p.hotkey === 'string' && p.hotkey.trim() ? p.hotkey.trim() : 'Super+E',
    hotkeyEnabled: p.hotkeyEnabled === true,
    startFolder: typeof p.startFolder === 'string' ? p.startFolder : '',
    defaultApps: cleanDefaultApps(p.defaultApps),
    customCommands: cleanCustomCommands(p.customCommands),
    iconDirs: Array.isArray(p.iconDirs) ? p.iconDirs.filter((d) => typeof d === 'string' && d) : [],
    iconTheme: typeof p.iconTheme === 'string' ? p.iconTheme : ''
  }
}

/** Old state files kept theme/view/hidden/chrome/ui at the top level; fold them into prefs. */
export function migrateLegacy(s: any): Partial<Prefs> {
  const p: Partial<Prefs> = {}
  if (s?.theme === 'light' || s?.theme === 'dark' || s?.theme === 'system') p.theme = s.theme
  if (s?.view === 'grid' || s?.view === 'list') p.view = s.view
  if (typeof s?.hidden === 'boolean') p.showHidden = s.hidden
  if (s?.chrome) {
    p.titlebar = s.chrome.customTitlebar === false ? 'system' : 'app'
    p.rounded = s.chrome.rounded !== false
  }
  if (s?.ui) {
    if (s.ui.sidebar === 'float') p.sidebar = 'float'
    if (s.ui.sidebarOpen === false) p.sidebarOpen = false
    if (typeof s.ui.sidebarWidth === 'number') p.sidebarWidth = s.ui.sidebarWidth
    if (typeof s.ui.sidebarTone === 'number' && [1, 2, 3, 4, 5, 6].includes(s.ui.sidebarTone)) {
      p.sidebarTone = s.ui.sidebarTone as 1 | 2 | 3 | 4 | 5 | 6
    } else if (s.ui.sidebarDarker === true) {
      p.sidebarTone = 4
    }
    if (Array.isArray(s.ui.iconDirs)) p.iconDirs = s.ui.iconDirs.filter((d: unknown) => typeof d === 'string')
    if (typeof s.ui.iconTheme === 'string') p.iconTheme = s.ui.iconTheme
  }
  return p
}

/** Unknown ids are dropped and widths are clamped, so a junk state file cannot break the grid. */
const knownColumn = (id: unknown): id is ColId =>
  typeof id === 'string' && COLUMNS.some((c) => c.id === id)

function normalWidths(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (knownColumn(id) && typeof value === 'number' && Number.isFinite(value)) {
      out[id] = Math.round(Math.min(420, Math.max(48, value)))
    }
  }
  return out
}

function normalGridMeta(raw: unknown): ColId[] {
  if (!Array.isArray(raw)) return ['size']
  return [...new Set(raw.filter(knownColumn))].slice(0, 4)
}

function normalColumns(raw: unknown, legacyShowType: unknown): ColId[] {
  const known = new Set(COLUMNS.map((c) => c.id))
  const list = Array.isArray(raw) ? raw.filter((c): c is ColId => known.has(c as ColId)) : []
  const unique = [...new Set(list)]
  if (unique.length) return unique
  // old state files only had showTypeColumn
  return legacyShowType === false ? ['size', 'date'] : ['type', 'size', 'date']
}
