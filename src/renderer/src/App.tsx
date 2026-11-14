import { getLang, setLang, subscribeLang, t } from './i18n.ts'
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, type Chrome, type DesktopApp, type DirRef, type Drive, type Entry, type FolderMeta, type Job, type SearchProgress } from './api'
import { ContextMenu, type MenuAction, type MenuItem } from './ContextMenu'
import { ArchiveDialog, type ArchiveJob } from './ArchiveDialog'
import { FolderDialog } from './FolderDialog'
import { DiffDialog } from './DiffDialog'
import { Editor } from './Editor'
import { Gallery } from './Gallery'
import { OpenWithDialog } from './OpenWithDialog'
import { PropertiesDialog } from './PropertiesDialog'
import { clearDragPaths, lastDragPaths } from './drag'
import { dragLog } from './draglog'
import { JobsBar } from './JobsBar'
import { Pane, type FolderView, type PaneState, type SearchQuery, type View } from './Pane'
import { PreviewPanel } from './PreviewPanel'
import { RenameDialog } from './RenameDialog'
import { BreakdownDialog } from './BreakdownDialog'
import { ConvertDialog, RatingDialog, TagDialog, convertToWebp } from './RatingDialog'
import { rowsOf } from '../../shared/export.ts'
import { PresetsDialog } from './PresetsDialog'
import { Preferences } from './Preferences'
import {
  COLUMNS,
  DEFAULTS,
  colLabel,
  fontStack,
  mergePrefs,
  migrateLegacy,
  type ColId,
  type Prefs
} from './prefs'
import { PURE_ICON_SET } from './pure-icons'
import { PURE_URL_BY_NAME } from './pure-set'
import { FOLDER_COLORS } from './folder-colors'
import { PaneTree } from './PaneTree'
import { TreePane } from './TreePane'
import { SearchOverlay } from './SearchOverlay'
import { Sidebar } from './Sidebar'
import { SyncDialog } from './SyncDialog'
import { SymlinkDialog } from './SymlinkDialog'
import { WindowButtons } from './WindowButtons'
import { CommandBar } from './CommandBar'
import { COMMANDS, type CommandId } from './commands'
import { matchAccel } from './keys'
import { BLANK_TEMPLATE, NEW_CATEGORIES, NEW_FILE_TEMPLATES, type NewIconName } from './newTemplates.ts'
import {
  baseName,
  defaultSearchRoots,
  dirOf,
  fa,
  fmtDate,
  fmtSize,
  modeString,
  isArchiveName,
  isImage,
  joinPath,
  matchCustomCommand,
  mediaUrl,
  menuTargets,
  navIndex,
  openAction,
  opensInEditor,
  orderEntries,
  reorderItem,
  terminalDir,
  typeLabel,
  type NavMove,
  type SortKey
} from './format'
import { copyImageContent } from './clipboard'
import {
  ArchiveOpenIcon,
  AudioIcon,
  CodeIcon,
  DocIcon,
  FileIcon,
  ImageIcon,
  InfoIcon,
  PieIcon,
  PdfIcon,
  PlayIcon,
  SheetIcon,
  SlidesIcon,
  StarIcon,
  TerminalIcon,
  DriveIcon,
  DupeIcon,
  CopyIcon,
  CutIcon,
  PasteIcon,
  EyeIcon,
  EyeOffIcon,
  EntryIcon,
  FolderIcon,
  FolderPlusIcon,
  GaugeIcon,
  GridIcon,
  LayersIcon,
  LinkIcon,
  LockIcon,
  UnlockIcon,
  ListIcon,
  MenuIcon,
  MoonIcon,
  MoveIcon,
  PaletteIcon,
  PinIcon,
  PlusIcon,
  PreviewIcon,
  RefreshIcon,
  RenameIcon,
  SettingsIcon,
  SplitIcon,
  SunIcon,
  TrashIcon,
  TrashXIcon,
  XIcon,
  UndoIcon,
  ConfirmIcon
} from './Icons'

let tabCounter = 1
export const newTabId = () => 'tab_' + Date.now().toString(36) + '_' + (tabCounter++)

export const ensureTabIds = (tabs: string[], ids?: string[]): string[] => {
  const res = ids ? [...ids] : []
  while (res.length < tabs.length) {
    res.push(newTabId())
  }
  return res.slice(0, tabs.length)
}

const renderNewTemplateIcon = (icon: NewIconName) => {
  switch (icon) {
    case 'folder':
      return <FolderPlusIcon />
    case 'doc':
      return <DocIcon />
    case 'sheet':
      return <SheetIcon />
    case 'slides':
      return <SlidesIcon />
    case 'pdf':
      return <PdfIcon />
    case 'palette':
      return <PaletteIcon />
    case 'layers':
      return <LayersIcon />
    case 'image':
      return <ImageIcon />
    case 'code':
      return <CodeIcon />
    case 'terminal':
      return <TerminalIcon />
    case 'file':
    default:
      return <FileIcon />
  }
}

function buildNewMenuItems(includeFolder = true): MenuItem[] {
  const items: MenuItem[] = []
  if (includeFolder) {
    items.push({
      id: 'new:folder',
      label: t('پوشهٔ نو'),
      key: 'F7',
      icon: <FolderPlusIcon />
    })
    items.push({ sep: true })
  }
  for (const cat of NEW_CATEGORIES) {
    items.push({
      id: `cat:${cat.id}`,
      label: t(cat.label),
      icon: renderNewTemplateIcon(cat.icon),
      children: cat.templates.map((tmpl) => ({
        id: `new:${tmpl.id}`,
        label: t(tmpl.label),
        icon: renderNewTemplateIcon(tmpl.icon)
      }))
    })
  }
  items.push({ sep: true })
  items.push({
    id: `new:${BLANK_TEMPLATE.id}`,
    label: t(BLANK_TEMPLATE.label),
    icon: renderNewTemplateIcon(BLANK_TEMPLATE.icon)
  })
  return items
}

const newPane = (dir: string): PaneState => {
  const id = newTabId()
  return {
    tabs: [dir],
    tabIds: [id],
    ti: 0,
    tabNames: {},
    tabLocks: {},
    pinCount: 0,
    hist: [dir],
    hi: 0,
    sel: [],
    filter: '',
    listing: null,
    virtual: null,
    results: null,
    archive: null,
    preview: null,
    error: '',
    loading: true,
    fmt: null
  }
}

const patch = (panes: PaneState[], i: number, p: Partial<PaneState>): PaneState[] =>
  panes.map((x, j) => (j === i ? { ...x, ...p } : x))

const tabOf = (s: PaneState) => s.tabs[s.ti]

const OP_LABEL: Record<string, string> = {
  copy: 'کپی',
  move: 'انتقال',
  trash: 'سطل بازیافت',
  delete: 'حذف'
}

const SORT_KEYS: SortKey[] = ['name', 'size', 'mtime', 'ext', 'mode', 'owner', 'links', 'dims', 'rating']

/**
 * The OS preference, live. `theme: 'system'` follows it without a restart; an
 * explicit dark/light choice never reads this value.
 */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
  )
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const on = (ev: MediaQueryListEvent) => setDark(ev.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

export default function App() {
  const [panes, setPanes] = useState<PaneState[] | null>(null)
  const [roots, setRoots] = useState<DirRef[]>([])
  const [drives, setDrives] = useState<Drive[]>([])
  const [active, setActive] = useState(0)
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS)
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'name', asc: true })
  const [marks, setMarks] = useState<string[]>([])
  /** bookmark path → folder colour/icon, so the sidebar shows the folder's own glyph */
  const [markIcons, setMarkIcons] = useState<Record<string, { color?: string; icon?: string }>>({})
  /** folder path → own colour/icon for the tab strip */
  const [tabIcons, setTabIcons] = useState<Record<string, { color?: string; icon?: string }>>({})
  const [tabIconTick, setTabIconTick] = useState(0)
  const [sizes, setSizes] = useState<Record<string, string>>({})
  const [jobs, setJobs] = useState<Job[]>([])
  const [indexStatus, setIndexStatus] = useState<SearchProgress | null>(null)
  const [prompt, setPrompt] = useState<{
    kind: 'mkdir' | 'rename' | 'createFile'
    value: string
    content?: string
    ext?: string
  } | null>(null)
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null)
  const promptInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!prompt || !promptInputRef.current) return
    const input = promptInputRef.current
    input.focus()
    const dot = prompt.value.lastIndexOf('.')
    if (dot > 0 && prompt.kind === 'createFile') {
      input.setSelectionRange(0, dot)
    } else {
      input.select()
    }
  }, [prompt?.kind])
  const [tabPrompt, setTabPrompt] = useState<{ pane: number; path: string; value: string } | null>(null)
  const [renameTargets, setRenameTargets] = useState<string[] | null>(null)
  const [symlinkFor, setSymlinkFor] = useState<string | null>(null)
  const [note, setNote] = useState('')
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(''), 3500)
    return () => clearTimeout(t)
  }, [note])
  /** in-app file clipboard for the quick cut/copy/paste row */
  const [clip, setClip] = useState<{ paths: string[]; cut: boolean } | null>(null)
  const [home, setHome] = useState('')
  const [free, setFree] = useState<number | null>(null)
  const [confirmAsk, setConfirmAsk] = useState<{ kind: 'trash' | 'delete'; paths: string[] } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [prefsOpenPage, setPrefsOpenPage] = useState<'appearance' | 'columns' | null>(null)
  const [menu, setMenu] = useState<{
    path: string | null
    tab?: number
    x: number
    y: number
  } | null>(null)
  const [previewOn, setPreviewOn] = useState(false)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [editor, setEditor] = useState<string | null>(null)
  const [editorMax, setEditorMax] = useState(false)
  const [palette, setPalette] = useState<{ id: string; name: string; color: string }[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [update, setUpdate] = useState<{ current: string; latest: string | null; url: string | null; newer: boolean } | null>(null)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const [tagFor, setTagFor] = useState<{
    path: string
    name: string
    tags: Record<string, string>
  } | null>(null)
  const [rateFor, setRateFor] = useState<{ dir: string; name: string } | null>(null)
  const [convertAsk, setConvertAsk] = useState<{
    files: string[]
    busy: boolean
    result: string
  } | null>(null)
  const [labelFor, setLabelFor] = useState<{ dir: string; name: string } | null>(null)
  const [archiveJob, setArchiveJob] = useState<ArchiveJob | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveResult, setArchiveResult] = useState('')
  const [sync, setSync] = useState<{
    left: string
    right: string
    rows: any[]
    capped: boolean
    result: string
    busy: boolean
    compareBy: 'mtime' | 'ctime' | 'hash'
    ignore: string
  } | null>(null)
  const [diff, setDiff] = useState<{ a: string; b: string; result: any } | null>(null)
  const [gallery, setGallery] = useState<{ images: Entry[]; start: string } | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number } | null>(null)
  const [marksMenu, setMarksMenu] = useState<{ x: number; y: number; pane: number } | null>(null)
  const [openWith, setOpenWith] = useState<string | null>(null)
  const [menuApps, setMenuApps] = useState<{ path: string; apps: DesktopApp[] } | null>(null)
  const [propsFor, setPropsFor] = useState<string | null>(null)
  const [breakdownFor, setBreakdownFor] = useState<string | null>(null)
  const [folderLook, setFolderLook] = useState<{ dirs: string[]; name: string; meta: FolderMeta | null } | null>(
    null
  )
  const [booted, setBooted] = useState(false)
  /** a path from the shell or a second launch, kept until the restored session is ready */
  const [openTarget, setOpenTarget] = useState<string | null>(null)
  /** kind → icon file of the desktop icon theme (Pure first); empty means line glyphs */
  const [iconSet, setIconSet] = useState<Record<string, string>>({})
  const filterEls = useRef<(HTMLInputElement | null)[]>([])
  /** per-pane counter: the «filter» command opens that pane's floating input */
  const [filterTicks, setFilterTicks] = useState([0, 0])
  /** per-pane counter: Ctrl+L turns that pane's breadcrumbs into an address field */
  const [addrTicks, setAddrTicks] = useState([0, 0])
  /** what each pane currently shows, reported by Pane; drives page/grid steps */
  const metrics = useRef([
    { cols: 1, rows: 20 },
    { cols: 1, rows: 20 }
  ])
  /** the row a shift-range starts from; keyboard navigation owns it */
  const navAnchor = useRef('')
  /** type-ahead: the letters typed since the last pause, and when they were typed */
  const typedBuf = useRef('')
  const typedAt = useRef(0)
  const [reveal, setReveal] = useState<{ pane: number; path: string; tick: number }>({
    pane: -1,
    path: '',
    tick: 0
  })

  const updatePrefs = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    // write prefs immediately; the debounced session save may be lost if the window closes
    void api.state.setPrefs(next)
    if (patch.titlebar !== undefined || patch.rounded !== undefined) {
      // frame/transparent are window-creation options: main rebuilds the window and we reload
      void api.window.setChrome({
        customTitlebar: (patch.titlebar ?? prefs.titlebar) === 'app',
        rounded: patch.rounded ?? prefs.rounded
      })
    }
  }

  const systemDark = useSystemDark()
  const theme: 'dark' | 'light' =
    prefs.theme === 'system' ? (systemDark ? 'dark' : 'light') : prefs.theme
  const setTheme = (t: Prefs['theme'] | ((cur: Prefs['theme']) => Prefs['theme'])) =>
    updatePrefs({ theme: typeof t === 'function' ? t(prefs.theme) : t })
  const view = prefs.view
  const setView = (v: View | ((cur: View) => View)) => {
    const next = typeof v === 'function' ? v(prefs.view) : v
    updatePrefs({ view: next })
    const pane = panes?.[active]
    if (!pane) return
    // a folder with its own format must follow the click instead of snapping back on the next load
    setPanes((p) => (p && p[active]?.fmt ? patch(p, active, { fmt: { ...p[active].fmt!, view: next } }) : p))
    // …and it is written at once, so leaving and coming back keeps the thumbnails/details choice.
    // Virtual listings (search, flat view, archive) have no folder of their own to remember.
    if (pane.virtual || pane.archive) return
    const dir = tabOf(pane)
    if (!dir) return
    void api.setFormat(dir, { ...(pane.fmt ?? {}), view: next })
  }
  const hidden = prefs.showHidden
  const setHidden = (f: boolean | ((h: boolean) => boolean)) =>
    updatePrefs({ showHidden: typeof f === 'function' ? f(prefs.showHidden) : f })
  const setSortFor = (i: number, next: { key: SortKey; asc: boolean }) => {
    setSort(next)
    const pane = panes?.[i]
    if (!pane) return
    const fmt: FolderView = { ...(pane.fmt ?? {}), sortKey: next.key, sortAsc: next.asc }
    setPanes((p) => p && patch(p, i, { fmt }))
    // remember this folder's sort in its own .mfm.json, not just for this session
    if (!pane.virtual) void api.setFormat(tabOf(pane), fmt).catch(() => undefined)
  }
  const chrome = { customTitlebar: prefs.titlebar === 'app', rounded: prefs.rounded }
  const ui = {
    sidebar: prefs.sidebar,
    sidebarOpen: prefs.sidebarOpen,
    iconDirs: prefs.iconDirs,
    iconTheme: prefs.iconTheme
  }
  const setUi = (patch: Partial<typeof ui> | ((cur: typeof ui) => Partial<typeof ui>)) =>
    updatePrefs((typeof patch === 'function' ? patch(ui) : patch) as Partial<Prefs>)
  const refreshRef = useRef<() => void>(() => {})
  /** per-pane request id: a slow listing from an old folder must not overwrite a newer one */
  const loadSeq = useRef([0, 0])
  /** timestamp of the last lone Shift press, for double-tap global search */
  const lastShift = useRef(0)

  useEffect(() => {
    // Bookmarks are shared with the XDG file dialog; a change made there must show up here too.
    return api.state.onMarks((list) => setMarks(list))
  }, [])

  useEffect(() => {
    // a standalone viewer/editor window changed a preference: adopt it instead of overwriting it
    return api.state.onPrefsPatch((patch) => updatePrefs(patch as Partial<Prefs>))
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.colorTheme = prefs.colorTheme
  }, [prefs.colorTheme])

  useEffect(() => {
    document.documentElement.dataset.sidebarTone = String(prefs.sidebarTone || 1)
  }, [prefs.sidebarTone])

  useEffect(() => {
    if (!marks.length) {
      setMarkIcons({})
      return
    }
    let live = true
    void Promise.all(marks.map(async (m) => [m, await api.folderLook(m)] as const))
      .then((rows) => {
        if (live) setMarkIcons(Object.fromEntries(rows))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [marks])

  const tabPathsKey = (panes ?? []).map((p) => p.tabs.join('\u0000')).join('\u0001')
  useEffect(() => {
    if (!panes) return
    const paths = [...new Set(panes.flatMap((p) => p.tabs))]
    let live = true
    void Promise.all(paths.map(async (p) => [p, await api.folderLook(p)] as const))
      .then((rows) => {
        if (live) setTabIcons(Object.fromEntries(rows))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [tabPathsKey, tabIconTick])

  // rounded corners are CSS on a transparent frameless window; nothing else can round it
  useEffect(() => {
    const on = chrome.customTitlebar && chrome.rounded
    document.documentElement.dataset.rounded = on ? '1' : '0'
    document.documentElement.style.setProperty('--chrome-h', chrome.customTitlebar ? '36px' : '0px')
  }, [chrome])

  // boot: restore the last session, fall back to home
  useEffect(() => {
    Promise.all([api.roots(), api.home(), api.state.get()]).then(([r, home, st]) => {
      setRoots(r)
      setHome(home)
      void api.labelPalette().then(setPalette)
      const s: any = st ?? {}
      const p = mergePrefs(s.prefs ?? migrateLegacy(s))
      setPrefs(p)
      if (s.sort && SORT_KEYS.includes(s.sort.key as SortKey)) {
        setSort({ key: s.sort.key as SortKey, asc: !!s.sort.asc })
      }
      if (Array.isArray(s.marks)) setMarks(s.marks.filter((m: unknown) => typeof m === 'string' && m))
      if (s.active === 1) setActive(1)
      const mk = (p?: {
        tabs?: string[]
        tabIds?: string[]
        ti?: number
        pinCount?: number
        names?: Record<string, string>
        locks?: Record<string, boolean>
      }): PaneState => {
        const tabs = (p?.tabs ?? []).filter((t) => typeof t === 'string' && t)
        const list = tabs.length ? tabs : [s.prefs?.startFolder || home]
        const ti = Math.min(Math.max(p?.ti ?? 0, 0), list.length - 1)
        const pinCount = Math.min(Math.max(p?.pinCount ?? 0, 0), list.length)
        const tabIds = list.map((_, idx) => (typeof p?.tabIds?.[idx] === 'string' ? p.tabIds[idx] : newTabId()))
        const names: Record<string, string> = {}
        for (const [k, v] of Object.entries(p?.names ?? {})) {
          if (typeof v === 'string' && v.trim()) names[k] = v
        }
        const locks: Record<string, boolean> = {}
        for (const [k, v] of Object.entries(p?.locks ?? {})) {
          if (v === true) {
            if (tabIds.includes(k)) {
              locks[k] = true
            } else {
              const matchIdx = list.indexOf(k)
              if (matchIdx !== -1 && tabIds[matchIdx]) {
                locks[tabIds[matchIdx]] = true
              }
            }
          }
        }
        return { ...newPane(list[ti]), tabs: list, tabIds, ti, pinCount, tabNames: names, tabLocks: locks }
      }
      const start = p.startFolder.trim() || home
      setPanes(
        p.startup === 'folder'
          ? [mk({ tabs: [start] }), mk({ tabs: [start] })]
          : [mk(s.panes?.[0]), mk(s.panes?.[1])]
      )
      // the launcher's path must win over the restored session; apply it only after boot settles
      void api.app.launchPath().then((p) => {
        if (p) setOpenTarget(p)
      })
      setBooted(true)
    })
  }, [])

  // a path handed over by the shell ("open with…") or by a second launch
  useEffect(() => {
    return api.app.onOpenPath((p) => setOpenTarget(p))
  }, [])

  // apply the launch path after the session has loaded, so restoring the old tabs cannot win
  useEffect(() => {
    if (!openTarget || !booted || !panes) return
    const p = openTarget
    setOpenTarget(null)
    void api
      .list(p, prefs.showHidden, prefs.columns.includes('dims'))
      .then((l) => go(active, l.path))
      .catch(() => {
        // it was a file: show its folder and select it, the way a file manager should
        const parent = dirOf(p)
        if (!parent) return
        go(active, parent)
        setTimeout(() => {
          setPanes((cur) => (cur ? patch(cur, active, { sel: [p] }) : cur))
          if (prefs.doubleClick === 'preview') setPreviewPath(p)
        }, 350)
      })
  }, [openTarget, booted, panes, active, prefs.showHidden, prefs.columns, prefs.doubleClick])

  // an image in the clipboard becomes a real file in the active folder
  useEffect(() => {
    if (!panes) return
    const onPaste = async (ev: ClipboardEvent) => {
      const el = ev.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (menu || columnMenu || settingsOpen || openWith) return
      const items = ev.clipboardData?.items
      if (!items) return
      const file = [...items]
        .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
        ?.getAsFile()
      if (!file) return
      ev.preventDefault()
      const dir = tabOf(panes[active])
      const ext = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png'
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
      const bytes = new Uint8Array(await file.arrayBuffer())
      const saved = await api.clipboard.saveImage(dir, `clipboard-${stamp}.${ext}`, bytes)
      if ('error' in saved) {
        setNote(t('تصویر کلیپ‌بورد ذخیره نشد'))
        return
      }
      await load(active, dir)
      setPanes((p) => p && patch(p, active, { sel: [saved.path] }))
      setNote(`${t('ذخیره شد')}: ${baseName(saved.path)}`)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  })

  // a stray file dropped outside a pane must not navigate the window away
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  useEffect(() => {
    void api.jobs.list().then(setJobs)
    const off = api.jobs.onUpdate((job) => {
      setJobs((prev) => {
        const old = prev.find((j) => j.id === job.id)
        const finished =
          old && old.state !== job.state && ['done', 'error', 'cancelled'].includes(job.state)
        if (finished) setTimeout(() => refreshRef.current(), 150)
        const next = prev.filter((j) => j.id !== job.id)
        return [...next, job].slice(-8)
      })
    })
    return off
  }, [])

  // remember the session, debounced so a directory load doesn't hammer the disk
  useEffect(() => {
    if (!booted || !panes) return
    const t = setTimeout(() => {
      void api.state.set({
        panes: panes.map((p) => ({
          tabs: p.tabs,
          tabIds: p.tabIds,
          ti: p.ti,
          pinCount: p.pinCount,
          names: p.tabNames,
          locks: p.tabLocks
        })),
        active,
        sort,
        marks,
        prefs,
        chrome: { customTitlebar: prefs.titlebar === 'app', rounded: prefs.rounded }
      })
    }, 500)
    return () => clearTimeout(t)
  }, [booted, panes, active, sort, marks, prefs])

  const path0 = panes ? tabOf(panes[0]) : ''
  const path1 = panes ? tabOf(panes[1]) : ''
  const curPath = panes ? tabOf(panes[active]) : ''

  useEffect(() => {
    const appName = t('مدیر فایل مکس')
    const cur = curPath ? baseName(curPath) || curPath : ''
    document.title = cur ? `${cur} — ${appName}` : appName
  }, [curPath, prefs.lang])

  const handleReorderMarks = (from: number, to: number, place: 'before' | 'after') => {
    setMarks((m) => reorderItem(m, from, to, place))
  }

  /** A folder format overrides the app default only while that folder is loaded. */
  const viewOf = (i: number): View => (panes?.[i]?.fmt?.view ?? view) as View
  const sortOf = (i: number) => {
    const f = panes?.[i]?.fmt
    return { key: (f?.sortKey ?? sort.key) as SortKey, asc: f?.sortAsc ?? sort.asc }
  }
  const columnsOf = (i: number): ColId[] =>
    (panes?.[i]?.fmt?.columns as ColId[] | undefined) ?? prefs.columns

  /** Drag the divider: the preview keeps the share the user last chose. */
  const startSideResize = (ev: React.PointerEvent) => {
    ev.preventDefault()
    const body = ev.currentTarget.parentElement
    if (!body) return
    const rect = body.getBoundingClientRect()
    const rtl = document.documentElement.dir === 'rtl'
    const move = (e: PointerEvent) => {
      const share = rtl ? (e.clientX - rect.left) / rect.width : (rect.right - e.clientX) / rect.width
      updatePrefs({ sideWidth: Math.min(0.8, Math.max(0.25, share)) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Drag the divider between the two panes in dual layout: pane 0 gets the share chosen. */
  const startDualResize = (ev: React.PointerEvent) => {
    ev.preventDefault()
    const divider = ev.currentTarget as HTMLElement
    const prevEl = divider.previousElementSibling as HTMLElement | null
    const nextEl = divider.nextElementSibling as HTMLElement | null
    if (!prevEl || !nextEl) return
    const prevRect = prevEl.getBoundingClientRect()
    const nextRect = nextEl.getBoundingClientRect()
    const rtl = document.documentElement.dir === 'rtl'
    const start = rtl ? nextRect.left : prevRect.left
    const totalW = (rtl ? prevRect.right : nextRect.right) - start
    if (totalW <= 0) return

    const move = (e: PointerEvent) => {
      const p0Width = rtl ? prevRect.right - e.clientX : e.clientX - prevRect.left
      const share = p0Width / totalW
      updatePrefs({ dualSplit: Math.min(0.8, Math.max(0.2, share)) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Drag the splitter between docked sidebar and the pane to resize sidebar. */
  const startDockedSidebarResize = (ev: React.PointerEvent) => {
    ev.preventDefault()
    const splitter = ev.currentTarget as HTMLElement
    try {
      splitter.setPointerCapture(ev.pointerId)
    } catch {}
    const sideEl = splitter.previousElementSibling as HTMLElement | null
    if (!sideEl) return
    const rect = sideEl.getBoundingClientRect()
    const rtl = document.documentElement.dir === 'rtl'

    let curWidth = prefs.sidebarWidth
    const move = (e: PointerEvent) => {
      const raw = rtl ? rect.right - e.clientX : e.clientX - rect.left
      const clamped = Math.min(600, Math.max(160, Math.round(raw)))
      if (clamped !== curWidth) {
        curWidth = clamped
        setPrefs((p) => ({ ...p, sidebarWidth: clamped }))
      }
    }
    const up = (e: PointerEvent) => {
      try {
        splitter.releasePointerCapture(e.pointerId)
      } catch {}
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      updatePrefs({ sidebarWidth: curWidth })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Drag the tree pane's edge; on the right side the handle reads the opposite direction. */
  const startTreeResize = (ev: React.PointerEvent) => {
    ev.preventDefault()
    ev.stopPropagation()
    const handle = ev.currentTarget as HTMLElement
    try {
      handle.setPointerCapture(ev.pointerId)
    } catch {}
    const panel = handle.previousElementSibling as HTMLElement | null
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    const right = prefs.treePane === 'right'

    let cur = prefs.treeWidth
    const move = (e: PointerEvent) => {
      const raw = right ? rect.right - e.clientX : e.clientX - rect.left
      const clamped = Math.min(520, Math.max(160, Math.round(raw)))
      if (clamped !== cur) {
        cur = clamped
        setPrefs((p) => ({ ...p, treeWidth: clamped }))
      }
    }
    const up = (e: PointerEvent) => {
      try {
        handle.releasePointerCapture(e.pointerId)
      } catch {}
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      updatePrefs({ treeWidth: cur })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Drag the edge of the floating sidebar to resize it. */
  const startFloatSidebarResize = (ev: React.PointerEvent) => {
    ev.preventDefault()
    ev.stopPropagation()
    const handle = ev.currentTarget as HTMLElement
    try {
      handle.setPointerCapture(ev.pointerId)
    } catch {}
    const panel = handle.parentElement as HTMLElement | null
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    const rtl = document.documentElement.dir === 'rtl'

    let curWidth = prefs.sidebarWidth
    const move = (e: PointerEvent) => {
      const raw = rtl ? rect.right - e.clientX : e.clientX - rect.left
      const clamped = Math.min(600, Math.max(160, Math.round(raw)))
      if (clamped !== curWidth) {
        curWidth = clamped
        setPrefs((p) => ({ ...p, sidebarWidth: clamped }))
      }
    }
    const up = (e: PointerEvent) => {
      try {
        handle.releasePointerCapture(e.pointerId)
      } catch {}
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      updatePrefs({ sidebarWidth: curWidth })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const [floatPos, setFloatPos] = useState({ x: 0, y: 0 })
  const [floatDragging, setFloatDragging] = useState(false)

  const startFloatDrag = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return
    ev.preventDefault()
    const target = ev.currentTarget as HTMLElement
    try {
      target.setPointerCapture(ev.pointerId)
    } catch {}
    setFloatDragging(true)
    const startX = ev.clientX
    const startY = ev.clientY
    const origX = floatPos.x
    const origY = floatPos.y

    const move = (e: PointerEvent) => {
      setFloatPos({
        x: origX + (e.clientX - startX),
        y: origY + (e.clientY - startY)
      })
    }
    const up = (e: PointerEvent) => {
      try {
        target.releasePointerCapture(e.pointerId)
      } catch {}
      setFloatDragging(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const handleToggleSidebarSection = (id: string) => {
    const list = prefs.sidebarCollapsed || []
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
    updatePrefs({ sidebarCollapsed: next })
  }

  useEffect(() => {
    const refresh = () => {
      api.drives.list().then(setDrives).catch(() => setDrives([]))
    }
    refresh()
    const iv = setInterval(refresh, 3500)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(iv)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const handleMountDrive = async (device: string) => {
    const res = await api.drives.mount(device)
    if (res.ok && res.mountpoint) {
      go(active, res.mountpoint)
      void api.drives.list().then(setDrives)
    } else if (res.error) {
      setPanes((p) => p && patch(p, active, { error: res.error }))
    }
  }

  const handleUnmountDrive = async (device: string) => {
    const d = drives.find((x) => x.device === device)
    const res = await api.drives.unmount(device)
    if (res.ok) {
      void api.drives.list().then(setDrives)
      if (d?.mountpoint) {
        const mp = d.mountpoint
        panes?.forEach((p, idx) => {
          const cur = p.tabs[p.ti]
          if (cur === mp || cur.startsWith(mp + '/')) {
            go(idx, home)
          }
        })
      }
    } else if (res.error) {
      setPanes((p) => p && patch(p, active, { error: res.error }))
    }
  }

  const load = async (i: number, dir: string, quiet = false) => {
    const seq = ++loadSeq.current[i]
    if (!quiet) setPanes((p) => p && patch(p, i, { loading: true }))
    try {
      const listing = await api.list(dir, hidden, prefs.columns.includes('dims'))
      if (loadSeq.current[i] !== seq) return
      const fmt = (listing.format as FolderView | null) ?? null
      setPanes((p) => p && patch(p, i, { listing, fmt, error: '', loading: false }))
    } catch (e: any) {
      if (loadSeq.current[i] !== seq) return
      setPanes((p) => p && patch(p, i, { listing: null, error: String(e?.message ?? e), loading: false }))
    }
  }

  useEffect(() => {
    if (path0) void load(0, path0)
  }, [path0, hidden])
  useEffect(() => {
    if (path1) void load(1, path1)
  }, [path1, hidden])

  useEffect(() => {
    const p = panes?.[active] ? tabOf(panes[active]) : ''
    if (!p) return
    void api.statfs(p).then((r) => setFree(r?.free ?? null))
  }, [path0, path1, active])

  // one update check per session; a failure stays silent because it is not the user's problem
  useEffect(() => {
    if (!booted) return
    void api.update.check().then((u) => {
      if (!u.error) setUpdate(u)
    })
  }, [booted])

  // keep the index warm: refresh it in the background when it is older than an hour
  useEffect(() => {
    if (!booted) return
    const roots = prefs.searchRoots.length ? prefs.searchRoots : defaultSearchRoots(home)
    if (!roots.length) return
    void api.search.stats().then((st) => {
      if (Date.now() - st.lastIndex < 3_600_000) return
      void api.search.index({ roots, exclude: prefs.searchExclude })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted])

  // the index run is global: show its progress in the status bar wherever the user is
  useEffect(() => {
    let live = true
    void api.search
      .status()
      .then((s) => {
        if (live) setIndexStatus(s)
      })
      .catch(() => undefined)
    const off = api.search.onProgress((p) => {
      if (live) setIndexStatus((cur) => ({ ...cur, ...p }) as SearchProgress)
    })
    return () => {
      live = false
      off()
    }
  }, [])

  // the OS-level hotkey follows the preference; the result is reported because it can fail
  useEffect(() => {
    void api
      .registerHotkey(prefs.hotkeyEnabled ? prefs.hotkey : '')
      .then((r) => {
        if (prefs.hotkeyEnabled && !r.ok) {
          setNote(`کلید ${prefs.hotkey} ثبت نشد — در تنظیمات KDE به «Add Command» بده`)
        }
      })
  }, [prefs.hotkey, prefs.hotkeyEnabled])

  // a folder's format is applied at load time by `load()` above; it never rewrites the
  // global defaults, otherwise leaving the folder would drag its view onto every other one

  // the catalogue lives outside React; subscribing here repaints the whole UI the moment it changes
  useSyncExternalStore(subscribeLang, getLang)
  useEffect(() => {
    setLang(prefs.lang)
  }, [prefs.lang])

  // tray behaviour follows the prefs; main ignores it when single instance is off
  useEffect(() => {
    void api.window.setTray({
      minimize: prefs.minimizeToTray && prefs.singleInstance,
      close: prefs.closeToTray && prefs.singleInstance,
      show: t('نمایش پنجره'),
      quit: t('خروج از برنامه')
    })
  }, [prefs.minimizeToTray, prefs.closeToTray, prefs.singleInstance, prefs.lang])

  // the body font comes from one CSS variable, so a new family applies everywhere at once
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-font', fontStack(prefs.fontFamily))
  }, [prefs.fontFamily])

  // the OS icon theme is only read when asked for; Pure is bundled and needs no IPC at all
  useEffect(() => {
    if (prefs.fileIcons !== 'system') return
    void api.iconSet().then(setIconSet)
  }, [prefs.fileIcons])

  const iconSetFor = (): Record<string, string> => {
    if (prefs.fileIcons === 'line') return {}
    if (prefs.fileIcons === 'pure') return PURE_ICON_SET
    // a desktop without a resolvable theme must not fall back to bare glyphs
    return Object.keys(iconSet).length ? iconSet : PURE_ICON_SET
  }

  const transferOpts = () => ({
    skipExisting: prefs.transferSkipExisting,
    newerOnly: prefs.transferNewerOnly,
    limitBps: prefs.speedLimitKB > 0 ? prefs.speedLimitKB * 1024 : 0
  })

  const reloadAll = () => {
    if (!panes) return
    void load(0, tabOf(panes[0]))
    void load(1, tabOf(panes[1]))
  }
  refreshRef.current = reloadAll

  const go = (i: number, dir: string) => {
    // type-ahead belongs to the folder it was typed in: leaving must not carry filter or buffer along
    typedBuf.current = ''
    setPanes((p) => {
      if (!p) return p
      const s = p[i]
      const curTabId = s.tabIds?.[s.ti] ?? ('t_' + s.ti)
      // a locked tab keeps its folder; the destination opens in a fresh tab
      if (s.tabLocks[curTabId] && dir !== s.tabs[s.ti]) {
        const at =
          prefs.newTabPos === 'next' ? Math.min(s.tabs.length, Math.max(s.pinCount, s.ti + 1)) : s.tabs.length
        const tabs = [...s.tabs]
        const tabIds = ensureTabIds(s.tabs, s.tabIds)
        const newId = newTabId()
        tabs.splice(at, 0, dir)
        tabIds.splice(at, 0, newId)
        return patch(p, i, {
          tabs,
          tabIds,
          ti: at,
          sel: [],
          hist: [dir],
          hi: 0,
          virtual: null,
          results: null
        })
      }
      const hist = [...s.hist.slice(0, s.hi + 1), dir]
      return patch(p, i, {
        tabs: s.tabs.map((t, j) => (j === s.ti ? dir : t)),
        sel: [],
        filter: '',
        hist,
        hi: hist.length - 1,
        virtual: null,
        results: null
      })
    })
  }

  const jump = (i: number, delta: number) => {
    typedBuf.current = ''
    setPanes((p) => {
      if (!p) return p
      const s = p[i]
      const hi = s.hi + delta
      if (hi < 0 || hi >= s.hist.length) return p
      const curTabId = s.tabIds?.[s.ti] ?? ('t_' + s.ti)
      if (s.tabLocks[curTabId] && s.hist[hi] !== s.tabs[s.ti]) {
        const at =
          prefs.newTabPos === 'next' ? Math.min(s.tabs.length, Math.max(s.pinCount, s.ti + 1)) : s.tabs.length
        const tabs = [...s.tabs]
        const tabIds = ensureTabIds(s.tabs, s.tabIds)
        const newId = newTabId()
        tabs.splice(at, 0, s.hist[hi])
        tabIds.splice(at, 0, newId)
        return patch(p, i, {
          tabs,
          tabIds,
          ti: at,
          sel: [],
          hist: [s.hist[hi]],
          hi: 0,
          virtual: null,
          results: null
        })
      }
      return patch(p, i, {
        hi,
        tabs: s.tabs.map((t, j) => (j === s.ti ? s.hist[hi] : t)),
        sel: [],
        filter: '',
        virtual: null,
        results: null
      })
    })
  }

  const up = (i: number) => {
    const parent = panes?.[i].listing?.parent
    if (parent) go(i, parent)
  }

  const runSel = async (i: number, kind: 'copy' | 'move' | 'trash' | 'delete') => {
    if (!panes) return
    const me = panes[i]
    if (!me.sel.length) {
      setNote(t('چیزی انتخاب نشده'))
      return
    }
    if (me.archive) {
      const dest = tabOf(panes[1 - i])
      const names = me.sel.map((p) => p.slice(me.archive!.length + 1))
      setNote(t('در حال استخراج…'))
      const r = await api.extract(me.archive, names, dest)
      setNote(
        r.errors.length
          ? `استخراج: ${fa(r.done)} فایل، ${fa(r.errors.length)} خطا — ${r.errors[0]}`
          : `استخراج: ${fa(r.done)} فایل به ${baseName(dest)}`
      )
      setPanes((p) => p && patch(p, i, { sel: [] }))
      await load(1 - i, dest)
      return
    }
    if (kind === 'copy' || kind === 'move') {
      const dest = tabOf(panes[1 - i])
      await api.jobs.start(kind, me.sel, dest, transferOpts())
      setNote(t('{op} برای {n} مورد آغاز شد', { op: t(OP_LABEL[kind]), n: fa(me.sel.length) }))
      setPanes((p) => p && patch(p, i, { sel: [] }))
      return
    }
    if (prefs.confirmDelete) {
      setConfirmAsk({ kind, paths: me.sel })
      return
    }
    const res = await api.remove(me.sel, kind === 'delete')
    setNote(
      res.errors.length
        ? `${t(OP_LABEL[kind])}: ${fa(res.done)} انجام شد، ${fa(res.errors.length)} خطا — ${res.errors[0]}`
        : t('{op}: {n} مورد', { op: t(OP_LABEL[kind]), n: fa(res.done) })
    )
    setPanes((p) => p && patch(p, i, { sel: [] }))
    reloadAll()
  }

  const runRemove = async (kind: 'trash' | 'delete', paths: string[]) => {
    const res = await api.remove(paths, kind === 'delete')
    setNote(
      res.errors.length
        ? `${t(OP_LABEL[kind])}: ${fa(res.done)} انجام شد، ${fa(res.errors.length)} خطا — ${res.errors[0]}`
        : t('{op}: {n} مورد', { op: t(OP_LABEL[kind]), n: fa(res.done) })
    )
    setPanes((p) => p && p.map((x, j) => ({ ...x, sel: [] })))
    reloadAll()
  }

  const doUndo = async () => {
    const r = await api.undo.run()
    setNote(r.done ? `بازگردانی شد: ${r.label} (${fa(r.done)})` : t('چیزی برای بازگردانی نیست'))
    if (r.done) reloadAll()
  }

  const computeSizes = async (i: number) => {
    if (!panes) return
    const me = panes[i]
    const targets = me.sel.length ? me.sel : [tabOf(me)]
    setNote(t('در حال محاسبهٔ اندازه…'))
    for (const t of targets) {
      const r = await api.size(t)
      setSizes((s) => ({ ...s, [t]: fmtSize(r.bytes, false) + (r.capped ? '…' : '') }))
    }
    setNote(t('اندازهٔ {n} مورد محاسبه شد', { n: fa(targets.length) }))
  }

  const applyTabName = () => {
    if (!tabPrompt) return
    const { pane, path, value } = tabPrompt
    setTabPrompt(null)
    setPanes((p) => {
      if (!p) return p
      const names = { ...p[pane].tabNames }
      if (value.trim()) names[path] = value.trim()
      else delete names[path]
      return patch(p, pane, { tabNames: names })
    })
  }

  const submitPrompt = async () => {
    if (!panes || !prompt) return
    const { kind, content, ext } = prompt
    const rawVal = prompt.value.trim()
    setPrompt(null)
    if (!rawVal) return
    const me = panes[active]
    if (kind === 'rename' && !me.sel[0]) {
      setNote(t('چیزی انتخاب نشده'))
      return
    }
    let value = rawVal
    if (kind === 'createFile' && ext && !value.includes('.')) {
      value = `${value}${ext}`
    }
    const res =
      kind === 'mkdir'
        ? await api.mkdir(tabOf(me), value)
        : kind === 'createFile'
          ? await api.createFile(tabOf(me), value, content ?? '')
          : await api.renameMany([{ from: me.sel[0], to: joinPath(dirOf(me.sel[0]), value) }])
    const kindLabel =
      kind === 'mkdir' ? t('پوشهٔ نو') : kind === 'createFile' ? t('فایل نو') : t('تغییر نام')
    setNote(res.errors.length ? `خطا — ${res.errors[0]}` : `${kindLabel}: ${value}`)
    await load(active, tabOf(me))
    if (res.errors.length === 0 && (kind === 'createFile' || kind === 'mkdir')) {
      const createdPath = joinPath(tabOf(me), value)
      setPanes((p) => p && patch(p, active, { sel: [createdPath] }))
    }
  }

  const openArchive = async (i: number, archive: string) => {
    setPanes((p) => p && patch(p, i, { loading: true }))
    const r = await api.archive(archive)
    setPanes((p) =>
      p &&
      patch(p, i, {
        virtual: { kind: 'archive', label: `${baseName(archive)} · ${fa(r.entries.length)}` },
        results: r.entries,
        archive,
        sel: [],
        loading: false
      })
    )
  }

  /** Compress the selection into a zip; the dialog decides name, level and destination. */
  const openCompress = (i: number) => {
    if (!panes) return
    const me = panes[i]
    if (!me.sel.length) {
      setNote(t('چیزی انتخاب نشده'))
      return
    }
    const name =
      me.sel.length === 1 ? baseName(me.sel[0]).replace(/\.[^.]+$/, '') : baseName(tabOf(me))
    setArchiveResult('')
    setArchiveJob({
      mode: 'compress',
      files: me.sel,
      path: '',
      name,
      here: tabOf(me),
      other: tabOf(panes[1 - i]),
      level: prefs.zipLevel
    })
  }

  const openExtract = (i: number, path?: string) => {
    if (!panes) return
    const p = path ?? panes[i].sel[0]
    if (!p || !isArchiveName(baseName(p))) {
      setNote(t('یک فایل فشرده انتخاب کن'))
      return
    }
    setArchiveResult('')
    setArchiveJob({
      mode: 'extract',
      files: [],
      path: p,
      name: baseName(p),
      here: tabOf(panes[i]),
      other: tabOf(panes[1 - i]),
      level: 0
    })
  }

  const runArchive = async (opts: { name: string; level: number; dest: string }) => {
    if (!archiveJob || !panes) return
    setArchiveBusy(true)
    if (archiveJob.mode === 'compress') {
      setNote(t('در حال ساخت آرشیو…'))
      const r = await api.createArchive(opts.dest, opts.name, archiveJob.files, opts.level)
      setArchiveBusy(false)
      setArchiveResult(
        'error' in r
          ? `${t('آرشیو ساخته نشد')} — ${r.error}`
          : `${baseName(r.path)} · ${t('{n} فایل', { n: fa(r.files) })} · ${fmtSize(r.bytes, false, prefs.sizeFormat)}`
      )
      if (!('error' in r)) setNote(`${t('آرشیو ساخته شد')}: ${baseName(r.path)}`)
    } else {
      setNote(t('در حال استخراج…'))
      const r = await api.extract(archiveJob.path, [], opts.dest)
      setArchiveBusy(false)
      setArchiveResult(
        r.errors.length
          ? `${t('{n} فایل', { n: fa(r.done) })} · ${t('{n} خطا', { n: fa(r.errors.length) })} — ${r.errors[0]}`
          : `${t('{n} فایل', { n: fa(r.done) })} ${getLang() === 'fa' ? '←' : '→'} ${baseName(opts.dest)}`
      )
    }
    await Promise.all([load(0, tabOf(panes[0])), load(1, tabOf(panes[1]))])
  }

  /** The editor and the gallery are both full-window modes: entering one leaves the other. */
  const openEditor = (p: string) => {
    setGallery(null)
    setEditor(p)
  }

  /**
   * With the editor docked, changing the file in the browsing pane means «show this one»: the
   * Editor saves its old buffer on the path change and loads the new file in place.
   */
  const followEditor = (i: number, paths: string[]) => {
    if (!editor || editorMax || paths.length !== 1) return
    const target = paths[0]
    if (!target || target === editor) return
    const e = entryOf(i, target)
    if (e && opensInEditor(e)) openEditor(target)
  }

  /** The global side preview (works in single and dual layout). */
  const openPreview = (p: string) => {
    setPreviewPath(p)
    setPreviewOn(true)
  }

  /** Open a file with the user's per-extension app, else the OS default. */
  const openExternal = (p: string): void => {
    const ext = p.includes('.') ? (p.split('.').pop() ?? '').toLowerCase() : ''
    const app = ext ? prefs.defaultApps[ext] : undefined
    const fallback = (): void => {
      void api.open(p).then((r) => {
        if ('error' in r) {
          setNote(t('برنامهٔ پیش‌فرض این فایل را باز نکرد'))
          setOpenWith(p)
        }
      })
    }
    if (!app) {
      fallback()
      return
    }
    void api.apps.launch(app.id, p).then((r) => {
      if ('error' in r) fallback()
    })
  }

  const openEntry = (i: number, p: string) => {
    const e =
      panes?.[i].listing?.entries.find((x) => x.path === p) ??
      panes?.[i].results?.find((x) => x.path === p)
    if (!e) return
    if (e.dir) {
      go(i, e.path)
      return
    }
    // thumbnail („gallery") view opens the viewer/editor in its own window, so the file manager
    // stays visible behind it; the list keeps the inline editor and the in-window gallery
    if (viewOf(i) === 'grid' && isImage(e.ext)) {
      void api.app.openViewer('gallery', e.path)
      return
    }
    if (viewOf(i) === 'grid' && opensInEditor(e)) {
      void api.app.openViewer('editor', e.path)
      return
    }
    const action = openAction(e, prefs.doubleClick, {
      hasDefaultApp: !!prefs.defaultApps[e.ext],
      virtual: !!panes?.[i].archive
    })
    if (action === 'navigate') go(i, e.path)
    else if (action === 'archive') void openArchive(i, e.path)
    else if (action === 'preview') openPreview(e.path)
    else if (action === 'gallery') openGallery(i, e.path)
    else if (action === 'editor') openEditor(e.path)
    else openExternal(e.path)
  }

  const loadRef = useRef(load)
  loadRef.current = load
  const panesRef = useRef(panes)
  panesRef.current = panes

  // Only the folders on screen are watched. Navigating swaps the watch set, so a big tree is never
  // watched wholesale; nothing polls.
  const watchKey = panes
    ? panes.map((p) => (p.archive || p.virtual ? '' : p.tabs[p.ti])).join('\u0000')
    : ''
  useEffect(() => {
    const dirs = panes ? panes.filter((p) => !p.archive && !p.virtual).map((p) => p.tabs[p.ti]) : []
    void api.watchDirs(dirs).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchKey])

  // a change on disk reloads the pane showing that folder, quietly: same listing, fresh names,
  // sizes and mtimes (which in turn re-versions the thumbnails)
  useEffect(
    () =>
      api.onFsChange((dir) => {
        const cur = panesRef.current
        if (!cur) return
        cur.forEach((p, i) => {
          if (!p.archive && !p.virtual && p.tabs[p.ti] === dir) void loadRef.current(i, dir, true)
        })
      }),
    []
  )

  /** A starred folder is the selected one when a single folder is selected, else the open folder. */
  const bookmarkTarget = (i: number): string => {
    const me = panes?.[i]
    if (!me) return ''
    const source = me.virtual && me.results ? me.results : (me.listing?.entries ?? [])
    const picked = me.sel
      .map((p) => source.find((e) => e.path === p))
      .find((e) => e?.dir)
    return picked?.path ?? tabOf(me)
  }

  const toggleMark = (i: number, path?: string) => {
    const target = path ?? bookmarkTarget(i)
    if (!target) return
    setMarks((m) => (m.includes(target) ? m.filter((x) => x !== target) : [...m, target]))
  }

  /** A folder dropped on the sidebar becomes a bookmark; a plain file is refused with a note. */
  const addMarks = async (paths: string[]) => {
    dragLog(`addMarks '${paths.join(',')}'`)
    const isDir = new Map<string, boolean>()
    for (const pane of panes ?? []) {
      for (const e of pane.listing?.entries ?? []) isDir.set(e.path, e.dir)
      for (const e of pane.results ?? []) isDir.set(e.path, e.dir)
    }
    // a folder dragged from the Places tree itself or a symlink might not be known as a dir, so ask the disk
    await Promise.all(
      paths.map(async (p) => {
        if (isDir.get(p) !== true) {
          const r = await api.properties(p).catch(() => null)
          if (r && !('error' in r) && r.dir) isDir.set(p, true)
        }
      })
    )
    const dirs = paths.filter((p) => isDir.get(p) === true)
    dragLog(`addMarks dirs='${dirs.join(',')}'`)
    if (!dirs.length) {
      setNote(t('فقط پوشه نشان می‌شود'))
      return
    }
    const added = dirs.filter((d) => !marks.includes(d))
    if (!added.length) {
      setNote(t('این پوشه از قبل نشان شده است'))
      return
    }
    setMarks((m) => [...m, ...added.filter((d) => !m.includes(d))])
    setNote(t('{n} پوشه نشان شد', { n: fa(added.length) }))
    if (prefs.sidebarCollapsed?.includes('bookmarks')) {
      updatePrefs({ sidebarCollapsed: prefs.sidebarCollapsed.filter((x) => x !== 'bookmarks') })
    }
  }

  const setVirtual = (i: number, kind: 'flat' | 'search' | 'dupes', label: string, results: Entry[]) =>
    setPanes((p) => p && patch(p, i, { virtual: { kind, label }, results, sel: [], loading: false }))

  const runFlat = async (i: number) => {
    if (!panes) return
    setPanes((p) => p && patch(p, i, { loading: true }))
    const r = await api.walk(tabOf(panes[i]), { limit: 5000 })
    setVirtual(i, 'flat', `نمای تخت · ${fa(r.entries.length)}${r.capped ? '+' : ''}`, r.entries)
  }

  const runSearch = async (i: number, q: SearchQuery) => {
    if (!panes) return
    setPanes((p) => p && patch(p, i, { loading: true }))
    setNote(t('در حال جست‌وجو…'))
    try {
      const r = await api.walk(tabOf(panes[i]), {
        query: q.query,
        content: q.content,
        regex: q.regex,
        limit: 5000,
        // without a budget and the ignore list, searching a home folder walked node_modules for minutes
        exclude: prefs.showHidden ? prefs.searchExclude : [...prefs.searchExclude, '.*'],
        budgetMs: 2500
      })
      setVirtual(i, 'search', `جست‌وجو · ${fa(r.entries.length)}${r.capped ? '+' : ''}`, r.entries)
      setNote(
        r.capped
          ? t('جست‌وجو به سقف زمان رسید؛ نتیجه‌های نزدیک‌تر اول آمده‌اند')
          : t('{n} نتیجه', { n: fa(r.entries.length) })
      )
    } catch {
      setPanes((p) => p && patch(p, i, { loading: false }))
      setNote(t('جست‌وجو انجام نشد'))
    }
  }

  const runDupes = async (i: number) => {
    if (!panes) return
    setPanes((p) => p && patch(p, i, { loading: true }))
    setNote(t('در حال محاسبهٔ hash…'))
    const r = await api.dupes(tabOf(panes[i]))
    const groups = new Set(r.entries.map((e) => e.group)).size
    setVirtual(i, 'dupes', `تکراری‌ها · ${fa(groups)} گروه`, r.entries)
    setNote(r.entries.length ? `${fa(r.entries.length)} فایل تکراری در ${fa(groups)} گروه` : t('فایل تکراری پیدا نشد'))
  }

  /**
   * Colour/icon belong to the folders the user selected, never to the folder they
   * happen to be standing in. `path` is the row the context menu was opened on.
   */
  const openFolderLook = async (i: number, path?: string) => {
    if (!panes) return
    const me = panes[i]
    const source = me.virtual && me.results ? me.results : (me.listing?.entries ?? [])
    const dirs = path
      ? [path]
      : me.sel.filter((p) => source.find((e) => e.path === p)?.dir)
    if (!dirs.length) {
      setNote(t('اول پوشه‌ای را انتخاب کن'))
      return
    }
    const meta = await api.getMeta(dirs[0])
    setFolderLook({
      dirs,
      name: dirs.length > 1 ? t('{n} پوشه', { n: fa(dirs.length) }) : baseName(dirs[0]),
      meta
    })
  }

  /** The blank-area menu means the folder that is open right now. */
  const openFolderLookAt = async (dir: string) => {
    const meta = await api.getMeta(dir)
    setFolderLook({ dirs: [dir], name: baseName(dir), meta })
  }

  const saveFolderLook = async (patch: FolderMeta) => {
    if (!folderLook) return
    const metas = await Promise.all(folderLook.dirs.map((d) => api.setMeta(d, patch)))
    setFolderLook({ ...folderLook, meta: metas[0] ?? null })
    setTabIconTick((n) => n + 1)
    reloadAll()
  }

  const entryOf = (i: number, path: string | null) => {
    const me = panes?.[i]
    if (!me || !path) return undefined
    const source = me.virtual && me.results ? me.results : (me.listing?.entries ?? [])
    return source.find((e) => e.path === path)
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setNote(t('در حافظه کپی شد'))
    } catch {
      setNote(text)
    }
  }

  const shaOf = async (paths: string[]) => {
    if (!paths.length) return
    setNote(t('محاسبهٔ SHA-256…'))
    const r = await api.hash(paths, 'sha256')
    const ok = r.filter((x) => x.hash)
    if (!ok.length) {
      setNote(t('hash محاسبه نشد'))
      return
    }
    setNote(
      paths.length === 1
        ? `SHA-256: ${ok[0].hash!.slice(0, 24)}…`
        : `${fa(ok.length)} فایل hash شد`
    )
    await copyText(
      paths.length === 1 ? ok[0].hash! : ok.map((x) => `${x.hash}  ${baseName(x.path)}`).join('\n')
    )
  }

  const dropInternal = async (paths: string[], dest: string, copy: boolean) => {
    if (!paths.length) return
    await api.jobs.start(copy ? 'copy' : 'move', paths, dest, transferOpts())
    setNote(
      t('{op} {n} مورد به {dest}', {
        op: copy ? t('کپی') : t('انتقال'),
        n: fa(paths.length),
        dest: baseName(dest)
      })
    )
  }

  const dropFiles = async (files: File[], dest: string, copy: boolean) => {
    const paths = files.map((f) => api.pathForFile(f)).filter((p) => typeof p === 'string' && p)
    if (!paths.length) return
    // a native drag of our own rows comes back as `Files`: treat it as the internal move/copy
    // it was, not as a foreign copy
    const mine = lastDragPaths()
    const internal = mine.length > 0 && paths.every((p) => mine.includes(p))
    clearDragPaths()
    if (internal) {
      await dropInternal(paths, dest, copy)
      return
    }
    await api.jobs.start('copy', paths, dest, transferOpts())
    setNote(t('کپی {n} مورد از بیرون', { n: fa(paths.length) }))
  }

  const togglePreview = () => {
    // opening the panel with something already selected must show it, not an empty pane
    if (!previewOn) setPreviewPath((cur) => cur ?? panes?.[active]?.sel[0] ?? null)
    setPreviewOn((o) => !o)
  }

  const reopenStack = useRef<{ pane: number; path: string }[]>([])

  const addTab = (i: number, dir: string, opts: { pinned?: boolean } = {}) =>
    setPanes((p) => {
      if (!p) return p
      const s = p[i]
      const tabs = [...s.tabs]
      const tabIds = ensureTabIds(s.tabs, s.tabIds)
      const newId = newTabId()
      let at = tabs.length
      if (opts.pinned) at = s.pinCount
      else if (prefs.newTabPos === 'next') at = Math.max(s.pinCount, Math.min(s.ti + 1, tabs.length))
      tabs.splice(at, 0, dir)
      tabIds.splice(at, 0, newId)
      return patch(p, i, {
        tabs,
        tabIds,
        ti: at,
        pinCount: s.pinCount + (opts.pinned ? 1 : 0),
        sel: [],
        virtual: null,
        results: null,
        archive: null,
        preview: null
      })
    })

  const closeTab = (i: number, idx: number) => {
    const s = panes?.[i]
    if (!s) return
    const curIds = ensureTabIds(s.tabs, s.tabIds)
    if (idx < 0 || idx >= s.tabs.length) return
    if (idx < s.pinCount) {
      setNote(t('تب سنجاق‌شده بسته نمی‌شود'))
      return
    }
    const tabId = curIds[idx]
    if (s.tabLocks[tabId]) {
      setNote(t('تب قفل شده بسته نمی‌شود'))
      return
    }
    if (s.tabs.length <= 1) return
    reopenStack.current.push({ pane: i, path: s.tabs[idx] })
    setPanes((p) => {
      if (!p) return p
      const cur = p[i]
      const ids = ensureTabIds(cur.tabs, cur.tabIds)
      const removingId = ids[idx]
      const tabs = cur.tabs.filter((_, j) => j !== idx)
      const tabIds = ids.filter((_, j) => j !== idx)
      const locks = { ...cur.tabLocks }
      delete locks[removingId]
      const nextTi = cur.ti > idx ? cur.ti - 1 : Math.min(cur.ti, tabs.length - 1)
      return patch(p, i, { tabs, tabIds, tabLocks: locks, ti: Math.max(0, nextTi), sel: [] })
    })
  }

  const closeTabs = (i: number, idx: number, mode: 'others' | 'right') => {
    const s = panes?.[i]
    if (!s) return
    setPanes((p) => {
      if (!p) return p
      const cur = p[i]
      const ids = ensureTabIds(cur.tabs, cur.tabIds)
      const keepIndices: number[] = []
      cur.tabs.forEach((_, j) => {
        if (j < cur.pinCount) {
          keepIndices.push(j)
          return
        }
        const jId = ids[j]
        if (cur.tabLocks[jId]) {
          keepIndices.push(j)
          return
        }
        if (mode === 'others' ? j === idx : j <= idx) {
          keepIndices.push(j)
        }
      })
      const tabs = keepIndices.map((j) => cur.tabs[j])
      const tabIds = keepIndices.map((j) => ids[j])
      const locks: Record<string, boolean> = {}
      tabIds.forEach((id) => {
        if (cur.tabLocks[id]) locks[id] = true
      })
      const activePath = cur.tabs[cur.ti]
      const activeId = ids[cur.ti]
      const tiById = tabIds.indexOf(activeId)
      const ti = tiById >= 0 ? tiById : Math.max(0, tabs.indexOf(activePath))
      return patch(p, i, {
        tabs,
        tabIds,
        tabLocks: locks,
        ti: Math.min(ti, tabs.length - 1),
        sel: [],
        pinCount: Math.min(cur.pinCount, tabs.length)
      })
    })
  }

  const togglePin = (i: number, idx: number) =>
    setPanes((p) => {
      if (!p) return p
      const s = p[i]
      const tabs = [...s.tabs]
      const tabIds = ensureTabIds(s.tabs, s.tabIds)
      const [path] = tabs.splice(idx, 1)
      const [id] = tabIds.splice(idx, 1)
      if (idx < s.pinCount) {
        const at = Math.max(0, s.pinCount - 1)
        tabs.splice(at, 0, path)
        tabIds.splice(at, 0, id)
        return patch(p, i, { tabs, tabIds, pinCount: s.pinCount - 1, ti: at })
      }
      tabs.splice(s.pinCount, 0, path)
      tabIds.splice(s.pinCount, 0, id)
      return patch(p, i, { tabs, tabIds, pinCount: s.pinCount + 1, ti: s.pinCount })
    })

  const moveTab = (i: number, from: number, to: number) =>
    setPanes((p) => {
      if (!p) return p
      const s = p[i]
      if (from === to || from < 0 || to < 0 || from >= s.tabs.length || to >= s.tabs.length) return p
      // a pinned tab stays in the pinned region and vice versa
      if (from < s.pinCount !== to < s.pinCount) return p
      const tabs = [...s.tabs]
      const tabIds = ensureTabIds(s.tabs, s.tabIds)
      const [moved] = tabs.splice(from, 1)
      const [movedId] = tabIds.splice(from, 1)
      tabs.splice(to, 0, moved)
      tabIds.splice(to, 0, movedId)
      return patch(p, i, { tabs, tabIds, ti: s.ti === from ? to : s.ti })
    })

  const reopenTab = () => {
    const last = reopenStack.current.pop()
    if (!last) {
      setNote(t('تب بسته‌شده‌ای نیست'))
      return
    }
    addTab(last.pane, last.path)
  }

  const jumpTab = (n: number) =>
    setPanes((p) => {
      if (!p) return p
      const s = p[active]
      if (n >= s.tabs.length) return p
      return patch(p, active, { ti: n, sel: [] })
    })

  const pasteClipboard = async (dest: string): Promise<void> => {
    if (!clip?.paths.length) return
    const cut = clip.cut
    await api.jobs.start(cut ? 'move' : 'copy', clip.paths, dest)
    setNote(
      t('{op} برای {n} مورد آغاز شد', {
        op: cut ? t('انتقال') : t('کپی'),
        n: fa(clip.paths.length)
      })
    )
    if (cut) setClip(null)
  }

  /** Ctrl+C/Ctrl+X: remember the selection for in-app paste and put real files on the OS clipboard. */
  const copySelection = async (cut: boolean) => {
    if (!panes) return
    const me = panes[active]
    const targets = me.sel
    if (!targets.length) {
      setNote(t('چیزی انتخاب نشده'))
      return
    }
    setClip({ paths: targets, cut })
    const kind = await api.clipboard.copyFiles(targets, cut)
    setNote(
      kind === 'files'
        ? t(cut ? '{n} فایل بریده شد' : '{n} فایل در کلیپ‌بورد کپی شد', { n: fa(targets.length) })
        : t(cut ? 'مسیر {n} فایل بریده شد' : 'مسیر {n} فایل کپی شد', { n: fa(targets.length) })
    )
  }

  const openNewMenu = (anchor?: { x: number; y: number }) => {
    if (anchor) {
      setNewMenu(anchor)
      return
    }
    const paneEl = document.querySelectorAll('.pane')[active] as HTMLElement | undefined
    const r = paneEl?.getBoundingClientRect()
    const rtl = document.documentElement.dir === 'rtl'
    const x = r ? (rtl ? r.right - 200 : r.left + 24) : 100
    const y = r ? r.top + 60 : 100
    setNewMenu({ x, y })
  }

  const handleNewPick = (id: string) => {
    setNewMenu(null)
    setMenu(null)
    if (id === 'new:folder' || id === 'mkdir') {
      setPrompt({ kind: 'mkdir', value: '' })
      return
    }
    const key = id.startsWith('new:') ? id.slice(4) : id
    const tmpl = NEW_FILE_TEMPLATES.find((t) => t.id === key)
    if (tmpl) {
      setPrompt({
        kind: 'createFile',
        value: tmpl.defaultName,
        content: tmpl.content,
        ext: tmpl.ext
      })
    } else {
      setPrompt({
        kind: 'createFile',
        value: 'new-file.txt',
        content: '',
        ext: ''
      })
    }
  }

  const pickMenu = (id: string) => {
    if (id.startsWith('new:') || id === 'newMenu') {
      if (id !== 'newMenu') handleNewPick(id)
      return
    }
    if (!menu || !panes) return
    if (id.startsWith('app:')) {
      const appId = id.slice(4)
      const target = menu.path ?? tabOf(panes[active])
      setMenu(null)
      if (target) {
        void api.apps.launch(appId, target).then((r) => {
          if ('error' in r) setNote(t('برنامه باز نشد'))
        })
      }
      return
    }
    if (id.startsWith('script:')) {
      const name = id.slice(7)
      const cmd = prefs.scripts[name]
      const p = menu.path ?? tabOf(panes[active])
      if (cmd) {
        setNote(t('در حال اجرای {name}…', { name }))
        void api.runScript(cmd, p, dirOf(p)).then((r) => {
          setNote(
            'error' in r
              ? `${name}: ${r.error.slice(0, 120)}`
              : `${name}: ${(r.output || t('انجام شد')).slice(0, 120)}`
          )
        })
      }
      return
    }
    if (id.startsWith('customCmd:')) {
      const cmdId = id.slice(10)
      const cmd = prefs.customCommands?.find((c) => c.id === cmdId)
      const p = menu.path ?? tabOf(panes[active])
      if (cmd && p) {
        setNote(t('در حال اجرای {name}…', { name: cmd.label }))
        void api.runCustomCommand(cmd.command, p).then((r) => {
          if ('error' in r) {
            setNote(`${cmd.label}: ${r.error}`)
          }
        })
      }
      return
    }
    const me = panes[active]
    const path = menu.path
    const tabIdx = menu.tab
    if (id.startsWith('tabColor:')) {
      if (tabIdx != null) {
        const tab = me.tabs[tabIdx]
        const color = id.slice(9)
        const next = { ...prefs.tabColors }
        if (color) next[tab] = color
        else delete next[tab]
        updatePrefs({ tabColors: next })
      }
      return
    }
    switch (id) {
      case 'tabRename': {
        if (tabIdx != null) {
          const tabPath = me.tabs[tabIdx]
          setTabPrompt({
            pane: active,
            path: tabPath,
            value: me.tabNames[tabPath] ?? baseName(tabPath)
          })
        }
        break
      }
      case 'tabLock': {
        if (tabIdx != null) {
          const tabId = me.tabIds?.[tabIdx] ?? ('t_' + tabIdx)
          setPanes((p) =>
            p
              ? patch(p, active, {
                  tabLocks: { ...p[active].tabLocks, [tabId]: !p[active].tabLocks[tabId] }
                })
              : p
          )
        }
        break
      }
      case 'tabPin':
        if (tabIdx != null) togglePin(active, tabIdx)
        break
      case 'tabDup':
        if (tabIdx != null) addTab(active, me.tabs[tabIdx])
        break
      case 'tabClose':
        if (tabIdx != null) closeTab(active, tabIdx)
        break
      case 'tabCloseOthers':
        if (tabIdx != null) closeTabs(active, tabIdx, 'others')
        break
      case 'tabCloseRight':
        if (tabIdx != null) closeTabs(active, tabIdx, 'right')
        break
      case 'tabCopyPath':
        if (tabIdx != null) void copyText(me.tabs[tabIdx])
        break
      case 'open':
        if (path) openEntry(active, path)
        break
      case 'archive':
        if (path) void openArchive(active, path)
        break
      case 'extractOther': {
        if (!path) break
        void (async () => {
        const dest = tabOf(panes![1 - active])
        const r = await api.extract(path, [], dest)
        setNote(
          r.errors.length
            ? `استخراج: ${fa(r.done)} فایل، ${fa(r.errors.length)} خطا — ${r.errors[0]}`
            : `استخراج: ${fa(r.done)} فایل به ${baseName(dest)}`
        )
        await load(1 - active, dest)
        })()
        break
      }
      case 'compress':
        openCompress(active)
        break
      case 'extract':
        openExtract(active, path ?? undefined)
        break
      case 'quickCut':
      case 'quickCopy': {
        const targets = menuTargets(me.sel, path)
        if (targets.length) {
          const cut = id === 'quickCut'
          setClip({ paths: targets, cut })
          void api.clipboard.copyFiles(targets, cut).then((kind) => {
            setNote(
              kind === 'files'
                ? t(cut ? '{n} فایل بریده شد' : '{n} فایل در کلیپ‌بورد کپی شد', { n: fa(targets.length) })
                : t(cut ? 'مسیر {n} فایل بریده شد' : 'مسیر {n} فایل کپی شد', { n: fa(targets.length) })
            )
          })
        }
        break
      }
      case 'quickPaste': {
        if (!clip?.paths.length) break
        const dirEntry = path ? entryOf(active, path) : null
        const dest = dirEntry?.dir && path ? path : tabOf(me)
        void pasteClipboard(dest)
        break
      }
      case 'quickDelete': {
        const targets = menuTargets(me.sel, path)
        if (!targets.length) break
        if (prefs.confirmDelete) setConfirmAsk({ kind: 'trash', paths: targets })
        else void runRemove('trash', targets)
        break
      }
      case 'quickDeleteForever': {
        const targets = menuTargets(me.sel, path)
        if (!targets.length) break
        if (prefs.confirmDelete) setConfirmAsk({ kind: 'delete', paths: targets })
        else void runRemove('delete', targets)
        break
      }
      case 'copy':
        void runSel(active, 'copy')
        break
      case 'move':
        void runSel(active, 'move')
        break
      case 'rename':
        openRename(active)
        break
      case 'batch':
        if (me.sel.length > 1) setRenameTargets(me.sel)
        break
      case 'trash':
        void runSel(active, 'trash')
        break
      case 'delete':
        void runSel(active, 'delete')
        break
      case 'copyPath':
        if (path) void copyText(path)
        break
      case 'symlink':
        if (path) setSymlinkFor(path)
        break
      case 'sha':
        void shaOf(me.sel.length ? me.sel : path ? [path] : [])
        break
      case 'size':
        void computeSizes(active)
        break
      case 'breakdown':
        setBreakdownFor(path ?? tabOf(me))
        break
      case 'bookmarkDir':
        if (path) toggleMark(active, path)
        break
      case 'columns':
        if (menu) setColumnMenu({ x: menu.x, y: menu.y })
        break
      case 'look':
        if (path) void openFolderLook(active, path)
        else void openFolderLookAt(tabOf(panes[active]))
        break
      case 'hideEntry':
        if (path) {
          const hidden = !entryOf(active, path)?.hidden
          void api.setMeta(path, { hidden }).then(() => load(active, tabOf(panes[active])))
        }
        break
      case 'tabHere':
        if (path) addTab(active, path)
        break
      case 'openTab':
        if (path) addTab(active, path)
        break
      case 'sync':
        void openSync()
        break
      case 'diff':
        void openDiff()
        break
      case 'reveal':
        if (path) void api.reveal(path)
        break
      case 'terminal': {
        // a right-click on a folder opens the terminal in that folder; a file means its own
        // folder (flat/search results can live outside the tab), never the archive's fake path
        const target = terminalDir(path, entryOf(active, path)?.dir === true, me.archive ?? null, tabOf(me))
        void api.openTerminal(target).then((r) => {
          if ('error' in r) setNote(`ترمینال باز نشد — ${r.error}`)
        })
        break
      }
      case 'tags':
        if (path)
          void api.tags([path]).then((r) =>
            setTagFor({ path, name: baseName(path), tags: (r?.[path] as Record<string, string>) ?? {} })
          )
        break
      case 'presets':
        setPresetsOpen(true)
        break
      case 'saveFormat': {
        const current = sortOf(active)
        const fmt: FolderView = {
          view: viewOf(active),
          columns: columnsOf(active),
          sortKey: current.key,
          sortAsc: current.asc
        }
        void api
          .setFormat(tabOf(me), fmt)
          .then(() => setPanes((p) => p && patch(p, active, { fmt })))
          .then(() => setNote(t('قالب این پوشه ذخیره شده')))
        break
      }
      case 'rate': {
        if (path) setRateFor({ dir: dirOf(path), name: baseName(path) })
        break
      }
      case 'convert': {
        const imgs = (me.sel.length ? me.sel : path ? [path] : []).filter((p) =>
          /\.(png|jpe?g|webp|bmp|gif|avif)$/i.test(p)
        )
        if (!imgs.length) {
          setNote(t('تصویری انتخاب نشده'))
          break
        }
        setConvertAsk({ files: imgs, busy: false, result: '' })
        break
      }
      case 'exportCsv':
      case 'exportPdf': {
        const pane = panes![active]
        const rows = rowsOf(
          visibleOf(active),
          {
            labels: pane.listing?.labels,
            ratings: pane.listing?.ratings,
            notes: pane.listing?.notes
          },
          (id: string) => palette.find((l) => l.id === id)?.name ?? ''
        )
        void (async () => {
          const r = await api.exportListing(
            tabOf(panes![active]),
            baseName(tabOf(panes![active])) || 'listing',
            rows,
            id === 'exportCsv' ? 'csv' : 'pdf',
            'light'
          )
          setNote(
            'error' in r ? `صدور نشد — ${r.error}` : `فهرست ذخیره شد: ${baseName(r.path)} · ${fa(r.rows)} ردیف`
          )
        })()
        break
      }
      case 'label': {
        if (path) setLabelFor({ dir: dirOf(path), name: baseName(path) })
        break
      }
      case 'edit': {
        if (path && !entryOf(active, path)?.dir) openEditor(path)
        break
      }
      case 'pinFile': {
        if (!path) break
        const dir = dirOf(path)
        const name = baseName(path)
        const wasPinned = (me.listing?.pins ?? []).includes(name)
        void api.togglePin(dir, name).then(() => load(active, tabOf(panes![active])))
        setNote(wasPinned ? t('سنجاق برداشته شد') : t('به بالای پوشه سنجاق شد'))
        break
      }
      case 'tabNew':
        addTab(active, tabOf(me))
        break
      case 'openWith':
      case 'openWithDialog':
        if (path) setOpenWith(path)
        else if (curPath) setOpenWith(curPath)
        break
      case 'openNewWindow':
        if (path) {
          const picked = entryOf(active, path)
          if (picked) void api.app.openViewer(isImage(picked.ext) ? 'gallery' : 'editor', path)
        }
        break
      case 'properties':
        if (path) setPropsFor(path)
        break
      case 'preview':
        if (path) {
          setPreviewPath(path)
          setPreviewOn(true)
        }
        break
      case 'previewOther':
        previewInOther(active)
        break
      case 'gallery':
        openGallery(active, path ?? undefined)
        break
      case 'mkdir':
        setPrompt({ kind: 'mkdir', value: '' })
        break
      case 'refresh':
        void load(active, tabOf(me))
        break
      case 'flat':
        void runFlat(active)
        break
      case 'dupes':
        void runDupes(active)
        break
    }
  }

  /** Columns and the small captions under a grid tile: toggles live where the user is looking. */
  const columnItems = (): MenuItem[] => [
    { head: true, label: t('ستون‌ها') },
    ...COLUMNS.map((c) => ({
      id: 'col:' + c.id,
      label: colLabel(c.id),
      checked: prefs.columns.includes(c.id)
    })),
    { sep: true },
    { head: true, label: t('زیرنویس بندانگشتی') },
    ...COLUMNS.map((c) => ({
      id: 'meta:' + c.id,
      label: colLabel(c.id),
      checked: prefs.gridMeta.includes(c.id)
    })),
    { sep: true },
    { id: 'columnsPrefs', label: t('تنظیمات ستون‌ها…'), icon: <LayersIcon /> }
  ]

  const pickColumn = (id: string) => {
    if (id === 'columnsPrefs') {
      setColumnMenu(null)
      setPrefsOpenPage('columns')
      setSettingsOpen(true)
      return
    }
    if (id.startsWith('col:')) {
      const col = id.slice(4) as ColId
      const on = prefs.columns.includes(col)
      const next = COLUMNS.map((c) => c.id).filter((x) =>
        on ? prefs.columns.includes(x) && x !== col : prefs.columns.includes(x) || x === col
      )
      if (next.length) updatePrefs({ columns: next })
      return
    }
    if (id.startsWith('meta:')) {
      const col = id.slice(5) as ColId
      const on = prefs.gridMeta.includes(col)
      const next = on
        ? prefs.gridMeta.filter((x) => x !== col)
        : [...prefs.gridMeta, col].slice(0, 4)
      updatePrefs({ gridMeta: next })
    }
  }

  /** Bookmarks without the sidebar: anchored at the pane's star caret. */
  const markItems = (): MenuItem[] => {
    const rows: MenuItem[] = marks.map((m) => ({
      id: 'mark:' + m,
      label: baseName(m),
      // the folder's own colour/icon, exactly like the sidebar's bookmark rows
      icon: (
        <EntryIcon
          size={15}
          iconSet={iconSetFor()}
          entry={{
            name: baseName(m),
            path: m,
            dir: true,
            size: 0,
            mtime: 0,
            ext: '',
            color: markIcons[m]?.color,
            icon: markIcons[m]?.icon
          }}
        />
      )
    }))
    if (!rows.length) {
      return [
        { head: true, label: t('نشان‌ها') },
        {
          id: 'noMarks',
          label: t('هنوز نشانی نداری — با ستاره یا کشیدن پوشه روی سایدبار بساز'),
          disabled: true
        }
      ]
    }
    return [{ head: true, label: t('نشان‌ها') }, ...rows]
  }

  const menuItems = (path: string | null): MenuItem[] => {
    const me = panes?.[active]
    if (!me) return []
    if (menu?.tab != null) {
      const idx = menu.tab
      const pinned = idx < me.pinCount
      const tabPath = me.tabs[idx]
      const tabId = me.tabIds?.[idx] ?? ('t_' + idx)
      const locked = !!me.tabLocks[tabId]
      return [
        {
          id: 'tabRename',
          label: t('تغییر نام تب…'),
          icon: <RenameIcon />
        },
        {
          id: 'tabLock',
          label: locked ? t('باز کردن قفل') : t('قفل تب'),
          icon: locked ? <UnlockIcon /> : <LockIcon />
        },
        { id: 'tabPin', label: pinned ? t('برداشتن سنجاق') : t('سنجاق‌کردن تب'), icon: <PinIcon filled={pinned} /> },
        { id: 'tabDup', label: t('تب تکراری'), icon: <PlusIcon /> },
        { sep: true },
        {
          id: 'tabClose',
          label: t('بستن تب'),
          key: 'Ctrl+W',
          icon: <XIcon size={12} />,
          disabled: pinned || locked || me.tabs.length <= 1
        },
        { id: 'tabCloseOthers', label: t('بستن بقیه'), icon: <XIcon size={12} /> },
        { id: 'tabCloseRight', label: t('بستن تب‌های بعدی'), icon: <XIcon size={12} /> },
        { sep: true },
        {
          id: 'group-tab-color',
          label: t('رنگ تب'),
          icon: <PaletteIcon />,
          children: [
            {
              id: 'tabColor:',
              label: t('بدون رنگ'),
              icon: <span className="menu-dot none" />
            },
            ...palette.map((p) => ({
              id: 'tabColor:' + p.color,
              label: t(p.name),
              icon: <span className="menu-dot" style={{ background: p.color }} />
            }))
          ]
        },
        { id: 'tabCopyPath', label: t('کپی مسیر'), icon: <CopyIcon /> }
      ]
    }
    const entry = entryOf(active, path)
    if (!path) {
      const folderCustom = (prefs.customCommands ?? []).filter((cmd) => matchCustomCommand(cmd, curPath, true))
      const folderOpenWith: MenuItem[] =
        folderCustom.length > 0
          ? [
              {
                id: 'openWithFolder',
                label: t('دستورهای این پوشه'),
                icon: <PlayIcon />,
                children: folderCustom.map((c) => ({
                  id: `customCmd:${c.id}`,
                  label: c.label,
                  icon: <PlayIcon />
                }))
              }
            ]
          : []
      return [
        {
          id: 'newMenu',
          label: t('جدید'),
          icon: <PlusIcon />,
          children: buildNewMenuItems(true)
        },
        { id: 'refresh', label: t('نوسازی'), key: 'F3', icon: <RefreshIcon /> },
        ...folderOpenWith,
        { sep: true },
        { id: 'terminal', label: t('ترمینال اینجا'), key: 'Ctrl+Alt+T', icon: <TerminalIcon /> },
        { sep: true },
        { id: 'flat', label: t('نمای تخت'), icon: <LayersIcon /> },
        { id: 'dupes', label: t('فایل‌های تکراری'), icon: <GaugeIcon /> },
        { id: 'size', label: t('اندازهٔ این پوشه'), key: 'F9', icon: <GaugeIcon /> },
        { id: 'breakdown', label: t('نمودار محتوای پوشه…'), icon: <PieIcon /> },
        { id: 'look', label: t('آیکون این پوشه'), icon: <PaletteIcon /> },
        { id: 'columns', label: t('ستون‌ها و اطلاعات…'), icon: <LayersIcon /> },
        { sep: true },
        { id: 'tabNew', label: t('تب نو'), icon: <PlusIcon /> }
      ]
    }
    const matchingCustom = entry
      ? (prefs.customCommands ?? []).filter((cmd) => matchCustomCommand(cmd, entry.path, entry.dir))
      : []
    const osApps = entry && !entry.dir && menuApps?.path === entry.path ? menuApps.apps : []
    const openWithChildren: MenuItem[] = [
      ...matchingCustom.map((c) => ({
        id: `customCmd:${c.id}`,
        label: c.label,
        icon: <PlayIcon />
      })),
      ...(osApps.length ? [{ sep: true } as MenuItem] : []),
      ...osApps.map((a) => ({
        id: `app:${a.id}`,
        label: a.name,
        icon: a.iconPath ? (
          <img className="ic-img" src={mediaUrl(a.iconPath)} alt="" width={16} height={16} draggable={false} />
        ) : (
          <PlayIcon />
        )
      })),
      { sep: true },
      { id: 'openWithDialog', label: t('سایر برنامه‌ها…'), icon: <PlayIcon /> }
    ]
    const openWithItem: MenuItem = {
      id: 'openWith',
      label: t('باز کردن با…'),
      icon: <PlayIcon />,
      children: openWithChildren
    }

    const entryMenu: MenuItem[] = [
      { id: 'open', label: entry?.dir ? t('باز کردن') : t('اجرا کردن'), icon: <PlayIcon /> },
      ...(entry && !entry.dir && (isImage(entry.ext) || opensInEditor(entry))
        ? [
            {
              id: 'openNewWindow',
              label: t('باز کردن در پنجرهٔ نو'),
              icon: <SplitIcon />
            } as MenuItem
          ]
        : []),
      openWithItem,
      { id: 'preview', label: t('پیش‌نمایش'), icon: <PreviewIcon /> },
      { id: 'previewOther', label: t('پیش‌نمایش در پنجرهٔ مقابل'), key: 'F3', icon: <PreviewIcon /> },
      { id: 'properties', label: t('ویژگی‌ها…'), key: 'Alt+Enter', icon: <InfoIcon /> },
      ...(entry?.dir
        ? [
            { id: 'terminal', label: t('ترمینال اینجا'), key: 'Ctrl+Alt+T', icon: <TerminalIcon /> } as MenuItem,
            { id: 'breakdown', label: t('نمودار محتوا…'), icon: <PieIcon /> } as MenuItem
          ]
        : []),
      ...(entry && isImage(entry.ext)
        ? [
            {
              id: 'gallery',
              label: t('گالری تصاویر'),
              key: 'Space',
              icon: <GridIcon />
            } as MenuItem
          ]
        : []),
      { sep: true }
    ]

    const archiveItems: MenuItem[] =
      entry && !entry.dir && isArchiveName(entry.name)
        ? [
            { id: 'archive', label: t('مرور آرشیو'), icon: <ArchiveOpenIcon /> },
            { id: 'extract', label: t('استخراج…'), icon: <ArchiveOpenIcon /> },
            {
              id: 'extractOther',
              label: t('استخراج به پنجرهٔ مقابل'),
              key: 'F5',
              icon: <ArchiveOpenIcon />
            }
          ]
        : []

    const operations: MenuItem[] = [
      { id: 'copy', label: t('کپی به پنجرهٔ مقابل'), key: 'F5', icon: <CopyIcon /> },
      { id: 'move', label: t('انتقال به پنجرهٔ مقابل'), key: 'F6', icon: <MoveIcon /> },
      ...archiveItems,
      { id: 'rename', label: t('تغییر نام'), key: 'F2', icon: <RenameIcon /> },
      ...(me.sel.length > 1
        ? [{ id: 'batch', label: t('تغییر نام گروهی…'), icon: <RenameIcon /> } as MenuItem]
        : []),
      { id: 'compress', label: t('فشرده‌سازی…'), icon: <ArchiveOpenIcon /> },
      { sep: true },
      { id: 'trash', label: t('سطل بازیافت'), key: 'F8', icon: <TrashIcon /> },
      { id: 'delete', label: t('حذف قطعی'), key: 'Shift+F8', icon: <TrashIcon />, danger: true }
    ]

    const pinName = path ? baseName(path) : ''
    const isPinned = !!pinName && (panes[active].listing?.pins ?? []).includes(pinName)
    const folderItems: MenuItem[] = [
      ...(entry?.dir
        ? [
            { id: 'openTab', label: t('باز کردن در تب نو'), icon: <PlusIcon /> },
            { id: 'tabHere', label: t('تب نو در این پوشه'), icon: <PlusIcon /> },
            { id: 'size', label: t('محاسبهٔ اندازه'), key: 'F9', icon: <GaugeIcon /> },
            { id: 'look', label: t('آیکون پوشه'), icon: <PaletteIcon /> },
            {
              id: 'bookmarkDir',
              label:
                path && marks.includes(path) ? t('برداشتن نشان') : t('نشان‌کردن در سایدبار'),
              icon: <StarIcon filled={!!path && marks.includes(path)} />
            },
            {
              id: 'hideEntry',
              label: entry.hidden ? t('نمایش دوباره در فهرست') : t('پنهان‌کردن از فهرست'),
              icon: entry.hidden ? <EyeIcon /> : <EyeOffIcon />
            }
          ]
        : []),
      { id: 'saveFormat', label: t('ذخیرهٔ قالب نمایش این پوشه'), icon: <LayersIcon /> },
      {
        id: 'pinFile',
        label: isPinned ? t('برداشتن سنجاق') : t('سنجاق به بالای پوشه'),
        icon: <PinIcon filled={isPinned} />
      }
    ]

    const systemItems: MenuItem[] = [
      { id: 'copyPath', label: t('کپی مسیر'), icon: <CopyIcon /> },
      { id: 'symlink', label: t('ایجاد پیوند نمادین…'), icon: <LinkIcon /> },
      { id: 'reveal', label: t('نمایش در فایل‌منیجر سیستم'), icon: <DriveIcon /> },
      { id: 'terminal', label: t('ترمینال اینجا'), key: 'Ctrl+Alt+T', icon: <TerminalIcon /> },
      { id: 'sha', label: 'SHA-256', icon: <GaugeIcon /> },
      { sep: true },
      { id: 'sync', label: t('همگام‌سازی با پنجرهٔ مقابل'), key: 'Ctrl+Shift+Y', icon: <SplitIcon /> },
      ...(me.sel.length === 2
        ? [
            {
              id: 'diff',
              label: t('مقایسهٔ دو فایل انتخاب‌شده'),
              key: 'Ctrl+Shift+Z',
              icon: <DupeIcon />
            } as MenuItem
          ]
        : []),
      ...Object.keys(prefs.scripts).map(
        (name) =>
          ({
            id: 'script:' + name,
            label: `اجرای «${name}»`,
            icon: <PlayIcon />
          }) as MenuItem
      )
    ]

    const detailItems: MenuItem[] = [
      { id: 'edit', label: t('ویرایش متن'), key: 'F4', icon: <RenameIcon /> },
      { id: 'label', label: t('برچسب رنگی…'), icon: <PaletteIcon /> },
      { id: 'rate', label: t('امتیاز و توضیح…'), icon: <StarIcon /> },
      ...(/\.(mp3|m4a)$/i.test(path)
        ? [{ id: 'tags', label: t('برچسب‌های صوتی…'), icon: <AudioIcon /> } as MenuItem]
        : []),
      { id: 'convert', label: t('تبدیل تصاویر…'), icon: <ImageIcon /> }
    ]

    return [
      ...entryMenu,
      {
        id: 'newMenu',
        label: t('جدید'),
        icon: <PlusIcon />,
        children: buildNewMenuItems(true)
      },
      {
        id: 'group-operations',
        label: t('عملیات فایل'),
        icon: <CopyIcon />,
        children: operations
      },
      {
        id: 'group-folder',
        label: t('پوشه و نمایش'),
        icon: <FolderIcon />,
        children: folderItems
      },
      {
        id: 'group-system',
        label: t('مسیر و سیستم'),
        icon: <DriveIcon />,
        children: systemItems
      },
      {
        id: 'group-details',
        label: t('برچسب و جزئیات'),
        icon: <StarIcon />,
        children: detailItems
      },
      {
        id: 'group-export',
        label: t('خروجی فهرست'),
        icon: <DocIcon />,
        children: [
          { id: 'exportCsv', label: t('صدور فهرست (CSV)'), icon: <DocIcon /> },
          { id: 'exportPdf', label: t('صدور فهرست (PDF)'), icon: <PdfIcon /> }
        ]
      }
    ]
  }

  /** Icon-only row at the bottom of the context menu, Windows-style. */
  const quickActions = (): MenuAction[] => {
    if (!panes || menu?.tab != null) return []
    const me = panes[active]
    const path = menu?.path ?? null
    const targets = menuTargets(me.sel, path)
    const dirEntry = path ? entryOf(active, path) : null
    const dest = dirEntry?.dir && path ? path : tabOf(me)
    const canPaste =
      !!clip?.paths.length && !(clip.cut && clip.paths.every((p) => dirOf(p) === dest))
    return [
      { id: 'quickCut', label: t('بریدن'), icon: <CutIcon />, disabled: !targets.length },
      { id: 'quickCopy', label: t('کپی'), icon: <CopyIcon />, disabled: !targets.length },
      { id: 'quickPaste', label: t('جایگذاری'), icon: <PasteIcon />, disabled: !canPaste },
      { id: 'quickDelete', label: t('حذف'), icon: <TrashIcon />, danger: true, disabled: !targets.length },
      {
        id: 'quickDeleteForever',
        label: t('حذف قطعی'),
        icon: <TrashXIcon />,
        danger: true,
        disabled: !targets.length
      }
    ]
  }

  /** Entries the colour dots apply to: the clicked row(s), or the open folder on blank space. */
  const colorTargets = (): string[] => {
    if (!panes || menu?.tab != null) return []
    const me = panes[active]
    const path = menu?.path ?? null
    if (!path) return [tabOf(me)]
    return menuTargets(me.sel, path)
  }

  const applyEntryColor = (color: string): void => {
    const targets = colorTargets()
    if (!targets.length) return
    const dirs = targets.filter((p) => entryOf(active, p)?.dir)
    const files = targets.filter((p) => {
      const e = entryOf(active, p)
      return !!e && !e.dir
    })
    void Promise.all([
      ...dirs.map((d) => api.setMeta(d, { color })),
      ...files.map((f) => api.setEntryColor(dirOf(f), baseName(f), color))
    ]).then(() => {
      setTabIconTick((n) => n + 1)
      reloadAll()
      setNote(color ? t('رنگ اعمال شد') : t('رنگ برداشته شد'))
    })
  }

  const colorSwatches = (): { value: string; label: string; active?: boolean }[] | undefined => {
    const dirs = colorTargets()
    if (!dirs.length) return undefined
    const path = menu?.path ?? null
    const colors = path ? dirs.map((d) => entryOf(active, d)?.color ?? '') : []
    const activeColor = colors.length && colors.every((c) => c === colors[0]) ? colors[0] : null
    return [
      { value: '', label: t('بدون رنگ'), active: activeColor === '' },
      ...FOLDER_COLORS.map((c) => ({
        value: c.value,
        label: t(c.name),
        active: activeColor === c.value
      }))
    ]
  }

  const sourceOf = (i: number) => {
    const me = panes?.[i]
    if (!me) return []
    const s = sortOf(i)
    return orderEntries(
      me.virtual && me.results ? me.results : (me.listing?.entries ?? []),
      s.key,
      s.asc,
      me.filter,
      prefs.foldersFirst
    )
  }

  const imagesOf = (i: number) => sourceOf(i).filter((e) => !e.dir && isImage(e.ext))

  const openGallery = (i: number, path?: string) => {
    const images = imagesOf(i)
    if (!images.length) return
    const start = path ?? panes?.[i].sel[0] ?? images[0].path
    setGallery({ images, start: images.some((x) => x.path === start) ? start : images[0].path })
  }

  /** F3: show the selection as a viewer in the *other* pane; pressing again returns its folder. */
  const previewInOther = (i: number) => {
    if (!panes) return
    const path = panes[i].sel[0] ?? panes[i].preview?.entry.path
    if (!path) {
      setNote(t('یک فایل انتخاب کن'))
      return
    }
    const entry = entryOf(i, path) ?? panes[i].preview?.entry
    if (!entry) return
    const target = 1 - i
    if (panes[target].preview?.entry.path === entry.path) {
      setPanes((p) => p && patch(p, target, { preview: null }))
      return
    }
    setPanes((p) => p && patch(p, target, { preview: { entry, from: i } }))
  }

  const navPreviewImage = (target: number, delta: number) => {
    const pv = panes?.[target].preview
    if (!pv) return
    const images = imagesOf(pv.from)
    const at = images.findIndex((e) => e.path === pv.entry.path)
    if (at < 0) return
    const next = images[(at + delta + images.length) % images.length]
    setPanes((p) => p && patch(p, target, { preview: { entry: next, from: pv.from } }))
  }

  const toggleFullscreen = async () => {
    const on = !fullscreen
    setFullscreen(on)
    await api.window.setFullscreen(on)
  }

  const exitVirtual = (i: number) =>
    setPanes((p) => p && patch(p, i, { virtual: null, results: null, archive: null, sel: [] }))

  const openRename = (i: number) => {
    if (!panes) return
    const sel = panes[i].sel
    if (sel.length > 1) setRenameTargets(sel)
    else if (sel.length === 1) setPrompt({ kind: 'rename', value: baseName(sel[0]) })
    else setNote(t('چیزی انتخاب نشده'))
  }

  const visibleOf = (i: number) => {
    const pane = panes?.[i]
    if (!pane) return []
    const source = pane.virtual && pane.results ? pane.results : (pane.listing?.entries ?? [])
    // must match Pane exactly (pins, labels, ratings): the keyboard cursor indexes into this list
    const s = sortOf(i)
    return orderEntries(
      source,
      s.key,
      s.asc,
      pane.filter,
      prefs.foldersFirst,
      new Set(pane.listing?.pins ?? []),
      pane.listing?.labels ?? {},
      pane.listing?.ratings ?? {}
    )
  }

  /** Arrow keys move the selection; shift keeps the range from `navAnchor`. */
  const moveSel = (move: NavMove, extend: boolean) => {
    if (!panes) return
    const list = visibleOf(active)
    if (!list.length) return
    const paths = list.map((e) => e.path)
    const me = panes[active]
    const here = me.sel.length ? paths.indexOf(me.sel[me.sel.length - 1]) : -1
    const m = metrics.current[active] ?? { cols: 1, rows: 20 }
    const next = navIndex(here, move, paths.length, viewOf(active) === 'grid' ? m.cols : 1, m.rows)
    if (next < 0) return
    const path = paths[next]
    if (extend) {
      // after a mouse click the anchor is gone; extend from the focused row instead of the target
      const last = me.sel[me.sel.length - 1] ?? ''
      const from = navAnchor.current && paths.includes(navAnchor.current)
        ? navAnchor.current
        : last && paths.includes(last)
          ? last
          : path
      const at = paths.indexOf(from)
      const lo = Math.min(at, next)
      const hi = Math.max(at, next)
      setPanes((p) => p && patch(p, active, { sel: paths.slice(lo, hi + 1) }))
    } else {
      navAnchor.current = path
      setPanes((p) => p && patch(p, active, { sel: [path] }))
    }
    if (previewOn) setPreviewPath(path)
    followEditor(active, [path])
    setReveal((r) => ({ pane: active, path, tick: r.tick + 1 }))
  }

  const runCompare = async (
    left: string,
    right: string,
    compareBy: 'mtime' | 'ctime' | 'hash',
    ignore: string
  ) => {
    setNote(t('در حال مقایسه…'))
    const r = await api.syncCompare(left, right, {
      compareBy,
      ignore: ignore
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
    })
    setNote(t('{n} تفاوت', { n: fa(r.rows.filter((x) => x.state !== 'same').length) }))
    setSync({ left, right, rows: r.rows, capped: r.capped, result: '', busy: false, compareBy, ignore })
  }

  const openSync = async () => {
    const left = tabOf(panes![active])
    const right = tabOf(panes![1 - active])
    if (!right || right === left) {
      setNote(t('پنجرهٔ مقابل پوشهٔ دیگری باشد'))
      return
    }
    await runCompare(left, right, 'mtime', '')
  }

  const openDiff = async () => {
    const me = panes![active]
    if (me.sel.length !== 2) {
      setNote(t('برای مقایسه دو فایل را انتخاب کن'))
      return
    }
    const [a, b] = me.sel
    const r = await api.diffFiles(a, b)
    setDiff({ a, b, result: r })
  }

  const RUN: Record<CommandId, () => void> = {
    newItem: () => openNewMenu(),
    sync: () => void openSync(),
    diff: () => void openDiff(),
    copy: () => void runSel(active, 'copy'),
    move: () => void runSel(active, 'move'),
    copyFiles: () => void copySelection(false),
    cutFiles: () => void copySelection(true),
    paste: () => void pasteClipboard(tabOf(panes![active])),
    edit: () => {
      const p = panes![active].sel[0]
      if (p) openEditor(p)
      else setNote(t('چیزی انتخاب نشده'))
    },
    rename: () => openRename(active),
    batchRename: () => openRename(active),
    mkdir: () => setPrompt({ kind: 'mkdir', value: '' }),
    compress: () => openCompress(active),
    extract: () => openExtract(active),
    trash: () => void runSel(active, prefs.trashByDefault ? 'trash' : 'delete'),
    hardDelete: () => void runSel(active, 'delete'),
    size: () => void computeSizes(active),
    refresh: () => void load(active, tabOf(panes![active])),
    up: () => up(active),
    previewPane: togglePreview,
    gallery: () => openGallery(active),
    flat: () => void runFlat(active),
    dupes: () => void runDupes(active),
    undo: () => void doUndo(),
    selectAll: () =>
      setPanes((p) => p && patch(p, active, { sel: visibleOf(active).map((e) => e.path) })),
    filter: () => setFilterTicks((ticks) => ticks.map((n, j) => (j === active ? n + 1 : n))),
    hidden: () => setHidden((h) => !h),
    bookmark: () => toggleMark(active),
    newTab: () => addTab(active, tabOf(panes![active])),
    closeTab: () => closeTab(active, panes![active].ti),
    reopenTab,
    nextTab: () =>
      setPanes(
        (p) =>
          p && patch(p, active, { ti: (p[active].ti + 1) % p[active].tabs.length, sel: [] })
      ),
    addressBar: () => setAddrTicks((ticks) => ticks.map((n, j) => (j === active ? n + 1 : n))),
    toggleView: () => setView((v) => (v === 'list' ? 'grid' : 'list')),
    toggleLayout: () => updatePrefs({ layout: prefs.layout === 'dual' ? 'single' : 'dual' }),
    terminal: () => {
      void api.openTerminal(tabOf(panes![active])).then((r) => {
        if ('error' in r) setNote(`ترمینال باز نشد — ${r.error}`)
      })
    },
    reveal: () => {
      const p = panes![active].sel[0] ?? tabOf(panes![active])
      void api.reveal(p)
    },
    searchIndex: () => setSearchOpen(true),
    checkUpdate: () => {
      setNote(t('بررسی به‌روزرسانی…'))
      void api.update.check(true).then((u) => {
        setUpdate(u)
        setNote(
          u.error
            ? `بررسی نشد — ${u.error}`
            : u.newer
              ? `نسخهٔ تازه ${u.latest} موجود است`
              : `نسخهٔ ${u.current} به‌روز است`
        )
      })
    },
    indexSizes: () => {
      const dirs = visibleOf(active).filter((e) => e.dir).map((e) => e.path)
      if (!dirs.length) {
        setNote(t('پوشه‌ای در فهرست نیست'))
        return
      }
      setNote(t('اندازه از ایندکس…'))
      void api.search.sizes(dirs).then((sizes) => {
        const found = Object.keys(sizes).length
        setSizes((prev) => {
          const next = { ...prev }
          for (const [dir, v] of Object.entries(sizes)) next[dir] = fmtSize(v.bytes, false, prefs.sizeFormat)
          return next
        })
        setNote(found ? `${found} پوشه از ایندکس پر شد` : t('این پوشه‌ها در ایندکس نیستند'))
      })
    },
    presets: () => setPresetsOpen(true),
    saveFormat: () => {
      const dir = tabOf(panes![active])
      void api
        .setFormat(dir, {
          view,
          columns: prefs.columns,
          sortKey: sort.key,
          sortAsc: sort.asc
        })
        .then(() => setNote(t('قالب این پوشه ذخیره شد')))
    },
    look: () => void openFolderLook(active),
    properties: () => {
      const p = panes![active].sel[0]
      if (p) setPropsFor(p)
    },
    prefs: () => setSettingsOpen(true)
  }

  /**
   * MCP UI bridge. Everything an agent cannot do on the filesystem alone (navigation, selection,
   * tabs, dialogs, commands) arrives here; `uiHandler` always reads the latest render's state.
   */
  const uiHandler = useRef<(msg: unknown) => void>(() => {})
  /** messages that arrived during boot, replayed once the panes exist */
  const pendingUi = useRef<unknown[]>([])
  const cmdQueue = useRef<{ id: CommandId; pane: number } | null>(null)
  const runRef = useRef(RUN)
  runRef.current = RUN

  useEffect(() => {
    if (!panes || !pendingUi.current.length) return
    for (const m of pendingUi.current.splice(0)) uiHandler.current(m)
  }, [panes])

  useEffect(() => {
    const q = cmdQueue.current
    if (!q || q.pane !== active) return
    cmdQueue.current = null
    runRef.current[q.id]?.()
  }, [active, panes])

  uiHandler.current = (msg) => {
    const m = (msg ?? {}) as { tool?: string; args?: Record<string, any>; prefs?: Partial<Prefs> }
    const tool = String(m.tool ?? '')
    const a = m.args ?? {}
    if (!tool) return
    // the window restores its session after the first render; an early call waits for that
    if (!panes) {
      pendingUi.current.push(msg)
      return
    }
    const pane = Number.isInteger(a.pane) ? Math.min(panes.length - 1, Math.max(0, Number(a.pane))) : active
    const me = panes[pane]
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    // navigation/selection/filtering focus the pane they act on, so a following `command` targets it
    if ((tool === 'goto' || tool === 'select' || tool === 'filter') && pane !== active) setActive(pane)
    switch (tool) {
      case 'note':
        setNote(str(a.text))
        break
      case 'prefs_set': {
        const patch = (m.prefs ?? a.patch ?? {}) as Partial<Prefs>
        const next = mergePrefs({ ...prefs, ...patch })
        setPrefs(next)
        void api.state.setPrefs(next)
        if (patch.titlebar !== undefined || patch.rounded !== undefined) {
          void api.window.setChrome({
            customTitlebar: next.titlebar === 'app',
            rounded: next.rounded
          })
        }
        break
      }
      case 'command': {
        const id = str(a.id) as CommandId
        if (!Object.hasOwn(RUN, id)) {
          setNote(`unknown command: ${id}`)
          break
        }
        if (pane !== active) {
          cmdQueue.current = { id, pane }
          setActive(pane)
        } else RUN[id]()
        break
      }
      case 'goto': {
        const path = str(a.path)
        if (path) go(pane, path)
        break
      }
      case 'select':
        setPanes((p) =>
          p && patch(p, pane, { sel: (Array.isArray(a.paths) ? a.paths : []).filter((x) => typeof x === 'string') })
        )
        break
      case 'filter':
        setPanes((p) => p && patch(p, pane, { filter: str(a.text) }))
        break
      case 'tab': {
        const action = str(a.action)
        const target = typeof a.path === 'string' && me.tabs.includes(a.path) ? a.path : me.tabs[me.ti]
        const idx = me.tabs.indexOf(target)
        if (action === 'new') addTab(pane, str(a.path) || tabOf(me))
        else if (action === 'close') closeTab(pane, idx)
        else if (action === 'reopen') reopenTab()
        else if (action === 'next')
          setPanes((p) => p && patch(p, pane, { ti: (p[pane].ti + 1) % p[pane].tabs.length, sel: [] }))
        else if (action === 'prev')
          setPanes(
            (p) =>
              p &&
              patch(p, pane, {
                ti: (p[pane].ti - 1 + p[pane].tabs.length) % p[pane].tabs.length,
                sel: []
              })
          )
        else if (action === 'select' && idx >= 0) setPanes((p) => p && patch(p, pane, { ti: idx, sel: [] }))
        else if (action === 'rename')
          setPanes((p) => {
            if (!p) return p
            const names = { ...p[pane].tabNames }
            if (str(a.name).trim()) names[target] = str(a.name).trim()
            else delete names[target]
            return patch(p, pane, { tabNames: names })
          })
        else if (action === 'lock')
          setPanes((p) => {
            if (!p) return p
            const curPane = p[pane]
            const targetIdx = typeof a.tab === 'number' ? a.tab : curPane.ti
            const tabId = curPane.tabIds?.[targetIdx] ?? ('t_' + targetIdx)
            const locks = { ...curPane.tabLocks }
            if (a.on === false) delete locks[tabId]
            else locks[tabId] = true
            return patch(p, pane, { tabLocks: locks })
          })
        else if (action === 'color') {
          const next = { ...prefs.tabColors }
          if (str(a.color)) next[target] = str(a.color)
          else delete next[target]
          updatePrefs({ tabColors: next })
        }
        break
      }
      case 'bookmark': {
        const path = str(a.path) || bookmarkTarget(pane)
        if (!path) break
        if (a.action === 'remove') setMarks((x) => x.filter((y) => y !== path))
        else if (a.action === 'add') setMarks((x) => (x.includes(path) ? x : [...x, path]))
        else setMarks((x) => (x.includes(path) ? x.filter((y) => y !== path) : [...x, path]))
        break
      }
      case 'open_editor': {
        const path = str(a.path) || me.sel[0]
        if (path) openEditor(path)
        else setNote(t('چیزی انتخاب نشده'))
        break
      }
      case 'open_gallery':
        openGallery(pane, str(a.path) || undefined)
        break
      case 'open_preview': {
        if (str(a.path)) setPreviewPath(str(a.path))
        setPreviewOn(a.on !== false)
        break
      }
      case 'properties_dialog': {
        const path = str(a.path) || me.sel[0]
        if (path) setPropsFor(path)
        break
      }
    }
  }

  useEffect(() => api.mcp.onUi((m) => uiHandler.current(m)), [])

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      if (!panes) return
      if (confirmAsk) {
        if (ev.key === 'Enter') {
          ev.preventDefault()
          const ask = confirmAsk
          setConfirmAsk(null)
          void runRemove(ask.kind, ask.paths)
          return
        }
        if (ev.key === 'Escape') {
          ev.preventDefault()
          setConfirmAsk(null)
          return
        }
        return
      }
      // a modal owns the keyboard: deleting behind the properties sheet would be invisible
      if (editor || gallery || menu || columnMenu || marksMenu || settingsOpen || openWith || propsFor || breakdownFor || confirmAsk) return
      const me = panes[active]

      if (ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
        ev.preventDefault()
        jump(active, ev.key === 'ArrowLeft' ? -1 : 1)
        return
      }
      if (typing) return

      // double-tapping Shift opens global search; never while typing, and a slow second tap is ignored
      if (ev.key === 'Shift' && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.repeat) {
        const now = Date.now()
        if (prefs.doubleShiftSearch && now - lastShift.current < 420) {
          lastShift.current = 0
          ev.preventDefault()
          setSearchOpen(true)
          return
        }
        lastShift.current = now
      }

      // the keyboard menu key (and Shift+F10) opens the same menu as right-click
      if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
        ev.preventDefault()
        const selected = me.sel[me.sel.length - 1] ?? null
        const row = document.querySelector(
          '.pane.active .row.on, .pane.active .tile.on'
        ) as HTMLElement | null
        const rect = row?.getBoundingClientRect()
        setMenu({
          path: selected,
          x: rect ? Math.round(rect.left + Math.min(48, rect.width / 2)) : Math.round(window.innerWidth / 2),
          y: rect ? Math.round(rect.bottom - 2) : Math.round(window.innerHeight / 2)
        })
        return
      }

      // list/grid cursor first: these are navigation, not commands, and they never scroll the pane
      const NAV: Record<string, NavMove> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        PageUp: 'pageUp',
        PageDown: 'pageDown',
        Home: 'first',
        End: 'last'
      }
      const move = NAV[ev.key]
      if (move) {
        ev.preventDefault()
        typedBuf.current = ''
        moveSel(move, ev.shiftKey)
        return
      }
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        // in a grid the arrows walk the cells; in a list they do what Krusader does: up / open
        if (viewOf(active) === 'grid') {
          ev.preventDefault()
          moveSel(ev.key === 'ArrowLeft' ? 'left' : 'right', ev.shiftKey)
          return
        }
        ev.preventDefault()
        if (ev.key === 'ArrowLeft') up(active)
        else if (me.sel[0]) openEntry(active, me.sel[0])
        return
      }

      // keys that stay hard: they are navigation inside the selection, not commands
      if (ev.key === 'Tab' && !ev.ctrlKey) {
        ev.preventDefault()
        setActive((a) => 1 - a)
        return
      }
      if (ev.key === 'Enter' && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault()
        if (me.sel[0]) openEntry(active, me.sel[0])
        return
      }
      if (ev.key === 'Escape') {
        ev.preventDefault()
        typedBuf.current = ''
        setPanes((p) => p && patch(p, active, { sel: [], filter: '' }))
        return
      }
      if (ev.ctrlKey && /^[1-9]$/.test(ev.key)) {
        ev.preventDefault()
        jumpTab(Number(ev.key) - 1)
        return
      }

      // type-ahead: a plain character starts finding in the folder that is open right now.
      // Space is the gallery key and Backspace is "up", so those only feed the buffer once it has text.
      const pick = (hit: Entry) => {
        navAnchor.current = hit.path
        setPanes((p) => p && patch(p, active, { sel: [hit.path] }))
        setReveal({ pane: active, path: hit.path, tick: Date.now() })
      }
      const findTyped = () => {
        const needle = typedBuf.current.toLowerCase()
        if (!needle) return null
        return visibleOf(active).find((e) => e.name.toLowerCase().startsWith(needle)) ?? null
      }
      // typing narrows the list itself, the way a Linux file manager's quick filter does
      const applyTyped = () => {
        setPanes((p) => p && patch(p, active, { filter: typedBuf.current }))
        const hit = findTyped()
        if (hit) pick(hit)
      }
      if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.length === 1 && ev.key !== ' ') {
        ev.preventDefault()
        if (Date.now() - typedAt.current > 800) typedBuf.current = ''
        typedBuf.current += ev.key
        typedAt.current = Date.now()
        applyTyped()
        return
      }
      if (ev.key === 'Backspace' && typedBuf.current) {
        ev.preventDefault()
        typedBuf.current = typedBuf.current.slice(0, -1)
        typedAt.current = Date.now()
        applyTyped()
        return
      }

      // everything else comes from the shortcut table, so the editor can rebind it
      for (const c of COMMANDS) {
        const accel = prefs.shortcuts[c.id] ?? c.key
        if (!accel || !matchAccel(accel, ev)) continue
        ev.preventDefault()
        RUN[c.id]()
        return
      }
      // typing over the list starts a live name filter (type-ahead, no shortcut needed)
      if (
        !typing &&
        !ev.ctrlKey &&
        !ev.altKey &&
        !ev.metaKey &&
        !ev.isComposing &&
        ev.key.length === 1 &&
        ev.key !== ' '
      ) {
        ev.preventDefault()
        setPanes((p) => p && patch(p, active, { filter: ev.key }))
        setFilterTicks((ticks) => ticks.map((n, j) => (j === active ? n + 1 : n)))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!panes) {
    return <div className="boot">{t(t('در حال آماده‌سازی…'))}</div>
  }

  const visible = visibleOf(active)
  const labelCounts = (() => {
    const labels = panes?.[active]?.listing?.labels ?? {}
    const counts: Record<string, number> = {}
    for (const id of Object.values(labels)) counts[id] = (counts[id] ?? 0) + 1
    return palette
      .map((p) => ({ ...p, count: counts[p.id] ?? 0 }))
      .filter((p) => p.count > 0)
  })()

  const selSize = (() => {
    const me = panes[active]
    const source = me.virtual && me.results ? me.results : (me.listing?.entries ?? [])
    return source.filter((e) => me.sel.includes(e.path)).reduce((n, e) => n + e.size, 0)
  })()
  const running = jobs.filter((j) => j.state === 'running' || j.state === 'paused').length
  const selEntry =
    panes[active].sel.length === 1 ? entryOf(active, panes[active].sel[0]) : undefined
  const selName = selEntry ? baseName(selEntry.path) : ''
  const selRating = selName ? (panes[active].listing?.ratings?.[selName] ?? 0) : 0
  const selLabel = selName
    ? palette.find((l) => l.id === panes[active].listing?.labels?.[selName])
    : undefined

  const searchRoots = prefs.searchRoots.length ? prefs.searchRoots : defaultSearchRoots(home)
  const sideOpen = previewOn || !!editor
  // in dual layout a single-tab pane keeps its strip when the other pane has tabs, so the two
  // sides do not sit at different heights
  const forceTabStrip =
    prefs.layout === 'dual' && !sideOpen && panes.some((p) => p.tabs.length > 1)
  const sideContent = editor && !editorMax ? (
    <Editor
      key="editor-dock"
      path={editor}
      theme={theme}
      docked
      onToggleMax={() => setEditorMax(true)}
      onClose={() => setEditor(null)}
      onNote={setNote}
      onSaved={() => void load(active, tabOf(panes![active]))}
    />
  ) : previewOn ? (
    <PreviewPanel
      entry={entryOf(active, previewPath) ?? null}
      maxKB={prefs.previewMaxKB}
      onOpen={(p) => openExternal(p)}
      onClose={() => setPreviewOn(false)}
    />
  ) : null

  return (
    <div className="app" data-layout={prefs.layout}>
      {editor && editorMax && (
        <Editor
          key="editor-max"
          path={editor}
          theme={theme}
          onToggleMax={() => setEditorMax(false)}
          onClose={() => setEditor(null)}
          onNote={setNote}
          onSaved={() => void load(active, tabOf(panes![active]))}
        />
      )}
      <header
        className="topbar"
        onDoubleClick={(ev) => {
          if (!chrome.customTitlebar) return
          if ((ev.target as HTMLElement).closest('button')) return
          void api.window.maximize()
        }}
      >
        <span className="logo-mark" title={t(t('مدیر فایل مکس'))}>
          {PURE_URL_BY_NAME['org.kde.dolphin'] ? (
            <img src={PURE_URL_BY_NAME['org.kde.dolphin']} alt="" draggable={false} />
          ) : (
            <FolderIcon />
          )}
        </span>
        <button
          className={'tb' + (ui.sidebarOpen ? ' on' : '')}
          title={t(t('سایدبار'))}
          onClick={() => setUi((u) => ({ ...u, sidebarOpen: !u.sidebarOpen }))}
        >
          <MenuIcon />
        </button>
        <button
          className={'tb' + (settingsOpen ? ' on' : '')}
          title={t(t('تنظیمات'))}
          onClick={() => setSettingsOpen((o) => !o)}
        >
          <SettingsIcon />
        </button>
        <span className="spacer" />
        <button
          className={'tb' + (prefs.layout === 'dual' ? ' on' : '')}
          title={prefs.layout === 'dual' ? t('تک‌پنجره') : t('دوپنجره')}
          onClick={() => updatePrefs({ layout: prefs.layout === 'dual' ? 'single' : 'dual' })}
        >
          <SplitIcon />
        </button>
        <button
          className={'tb' + (previewOn ? ' on' : '')}
          title={t(t('پنل پیش‌نمایش'))}
          onClick={togglePreview}
        >
          <PreviewIcon />
        </button>
        <button className="tb" title={t(t('بازگردانی آخرین عملیات (Ctrl+Z)'))} onClick={() => void doUndo()}>
          <UndoIcon />
        </button>
        <button
          className="tb"
          title={viewOf(active) === 'list' ? t('نمای شبکه') : t('نمای فهرست')}
          onClick={() => setView((v) => (v === 'list' ? 'grid' : 'list'))}
        >
          {viewOf(active) === 'list' ? <GridIcon /> : <ListIcon />}
        </button>
        <button className="tb" title={t(t('اندازهٔ پوشه (F9)'))} onClick={() => void computeSizes(active)}>
          <GaugeIcon />
        </button>
        <button
          className={'tb' + (hidden ? ' on' : '')}
          title={t(t('فایل‌های مخفی (Ctrl+H)'))}
          onClick={() => setHidden((h) => !h)}
        >
          {hidden ? <EyeIcon /> : <EyeOffIcon />}
        </button>
        <button
          className="tb"
          title={theme === 'dark' ? t('تم روشن') : t('تم تیره')}
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
        {chrome.customTitlebar && (
          <WindowButtons
            theme={prefs.titlebarButtons}
            side={prefs.titlebarSide}
            // physical left is order -1 in LTR and the last slot in RTL (and vice versa)
            style={{
              order:
                (prefs.titlebarSide === 'left') !== (document.documentElement.dir === 'rtl') ? -1 : 99
            }}
          />
        )}
      </header>

      {prefs.toolbar.length > 0 && (
        <CommandBar
          items={prefs.toolbar as CommandId[]}
          mode={prefs.toolbarMode}
          shortcuts={prefs.shortcuts}
          onRun={(id, anchor) => {
            if (id === 'newItem') openNewMenu(anchor)
            else RUN[id]?.()
          }}
        />
      )}

      {settingsOpen && (
        <Preferences
          prefs={prefs}
          palette={palette}
          openPage={prefsOpenPage ?? undefined}
          searchRoots={searchRoots}
          onChange={updatePrefs}
          onClose={() => {
            setSettingsOpen(false)
            setPrefsOpenPage(null)
          }}
        />
      )}

      <div className="body" onMouseDown={() => settingsOpen && setSettingsOpen(false)}>
        {ui.sidebarOpen && ui.sidebar === 'docked' && (
          <>
            <Sidebar
              style={{ width: prefs.sidebarWidth }}
              labels={labelCounts}
              onPickLabel={(id) => setPanes((p) => p && patch(p, active, { filter: '#' + id }))}
              roots={roots}
              marks={marks}
              markIcons={markIcons}
              iconSet={iconSetFor()}
              activePath={curPath}
              showHidden={hidden}
              floating={false}
              onToggleFloat={() => updatePrefs({ sidebar: 'float' })}
              onNav={(d) => go(active, d)}
              onUnmark={(m) => setMarks((x) => x.filter((y) => y !== m))}
              onMarkDrop={addMarks}
              onReorderMarks={handleReorderMarks}
              drives={drives}
              onMountDrive={handleMountDrive}
              onUnmountDrive={handleUnmountDrive}
              collapsed={prefs.sidebarCollapsed}
              onToggleSection={handleToggleSidebarSection}
            />
            <div
              className="side-split"
              role="separator"
              aria-orientation="vertical"
              title={t('تغییر عرض سایدبار')}
              onPointerDown={startDockedSidebarResize}
              onDoubleClick={() => updatePrefs({ sidebarWidth: 208 })}
            />
          </>
        )}

        {prefs.treePane === 'left' && (
          <>
            <TreePane
              path={curPath}
              showHidden={hidden}
              side="left"
              width={prefs.treeWidth}
              autoFocus={prefs.treeAutoFocus}
              showSymlink={prefs.showSymlink}
              onNav={(d) => go(active, d)}
              onAutoFocus={(on) => updatePrefs({ treeAutoFocus: on })}
              onClose={() => updatePrefs({ treePane: 'off' })}
            />
            <div
              className="tree-split"
              role="separator"
              aria-orientation="vertical"
              title={t('تغییر عرض درخت')}
              onPointerDown={startTreeResize}
              onDoubleClick={() => updatePrefs({ treeWidth: 232 })}
            />
          </>
        )}

        {(prefs.layout === 'dual' ? [0, 1] : [active]).map((i) => {
          const pane = panes[i]
          // the preview/editor sits exactly where the opposite pane is
          if (sideOpen && prefs.layout === 'dual' && i === 1 - active) {
            return (
              <Fragment key="side">
                <div
                  className="vsplit"
                  role="separator"
                  aria-orientation="vertical"
                  title={t('تغییر عرض پیش‌نمایش')}
                  onPointerDown={startSideResize}
                />
                <div
                  className="side-slot"
                  style={{ flex: `0 0 ${Math.round(prefs.sideWidth * 100)}%`, minWidth: 240 }}
                >
                  {sideContent}
                </div>
              </Fragment>
            )
          }
          const isDualBoth = prefs.layout === 'dual' && !sideOpen
          const paneFlexStyle: React.CSSProperties | undefined = isDualBoth
            ? {
                flex: `${i === 0 ? prefs.dualSplit : 1 - prefs.dualSplit} ${
                  i === 0 ? prefs.dualSplit : 1 - prefs.dualSplit
                } 0px`
              }
            : undefined

          const paneEl = (
          <Pane
            key={i}
            index={i}
            pane={pane}
            active={i === active}
            style={paneFlexStyle}
            sort={sortOf(i)}
            view={viewOf(i)}
            sizes={sizes}
            marked={marks.includes(bookmarkTarget(i))}
            filterRef={(el) => {
              filterEls.current[i] = el
            }}
            filterTick={filterTicks[i] ?? 0}
            addrTick={addrTicks[i] ?? 0}
            home={home}
            onActivate={() => setActive(i)}
            onSort={(key) =>
              setSortFor(i, { key, asc: sortOf(i).key === key ? !sortOf(i).asc : true })
            }
            onNav={(dir) => go(i, dir)}
            onBack={() => jump(i, -1)}
            onForward={() => jump(i, 1)}
            onUp={() => up(i)}
            onRefresh={() => void load(i, tabOf(pane))}
            onOpen={(path) => openEntry(i, path)}
            onSel={(paths, mode) => {
              // a single click becomes the anchor for a following shift+arrow
              if (mode === 'set' && paths.length === 1) navAnchor.current = paths[0]
              if (previewOn) setPreviewPath(paths[0] ?? null)
              setPanes((p) => {
                if (!p) return p
                if (mode === 'set') return patch(p, i, { sel: paths })
                const cur = p[i].sel
                const all = paths.every((x) => cur.includes(x))
                return patch(p, i, {
                  sel: all ? cur.filter((x) => !paths.includes(x)) : [...new Set([...cur, ...paths])]
                })
              })
              if (mode === 'set') followEditor(i, paths)
            }}
            onFilter={(q) => setPanes((p) => p && patch(p, i, { filter: q }))}
            onTabNew={() => addTab(i, tabOf(panes![i]))}
            onTabClose={(idx) => closeTab(i, idx)}
            onTabPick={(idx) => setPanes((p) => p && patch(p, i, { ti: idx, sel: [] }))}
            onTabMenu={(idx, x, y) => setMenu({ path: null, tab: idx, x, y })}
            onTabMove={(from, to) => moveTab(i, from, to)}
            middleClickClosesTab={prefs.middleClickClosesTab}
            palette={palette}
            tabColors={prefs.tabColors}
            tabIcons={tabIcons}
            showTabIcons={prefs.tabIcons}
            typeColors={prefs.fileTypes}
            onOp={(kind) => {
              if (kind === 'mkdir') setPrompt({ kind: 'mkdir', value: '' })
              else if (kind === 'rename') openRename(i)
              else void runSel(i, kind)
            }}
            onSize={() => void computeSizes(i)}
            onBookmark={() => toggleMark(i)}
            onBookmarksMenu={(x, y) => setMarksMenu({ x, y, pane: i })}
            onFlat={() => void runFlat(i)}
            onDupes={() => void runDupes(i)}
            onSearch={(q) => void runSearch(i, q)}
            onExitVirtual={() => exitVirtual(i)}
            onFolderLook={() => openFolderLook(i)}
            colWidths={prefs.colWidths}
            gridMeta={prefs.gridMeta}
            onColumnWidth={(id, px) =>
              updatePrefs({ colWidths: { ...prefs.colWidths, [id]: px } })
            }
            onHeaderMenu={(x, y) => setColumnMenu({ x, y })}
            onZoom={(delta) =>
              updatePrefs({ tileSize: Math.min(240, Math.max(80, prefs.tileSize + delta)) })
            }
            previewIndex={
              pane.preview
                ? (() => {
                    const imgs = imagesOf(pane.preview!.from)
                    const at = imgs.findIndex((e) => e.path === pane.preview!.entry.path)
                    return at >= 0 ? { at: at + 1, total: imgs.length } : null
                  })()
                : null
            }
            onPreviewNav={(delta) => navPreviewImage(i, delta)}
            onPreviewClose={() => setPanes((p) => p && patch(p, i, { preview: null }))}
            foldersFirst={prefs.foldersFirst}
            columns={columnsOf(i)}
            nameLines={prefs.gridNameLines}
            tileSize={prefs.tileSize}
            hideSingleTab={prefs.hideSingleTab}
            forceTabStrip={forceTabStrip}
            iconSet={iconSetFor()}
            sizeFormat={prefs.sizeFormat}
            dateFormat={prefs.dateFormat}
            showSeconds={prefs.showSeconds}
            showSymlink={prefs.showSymlink}
            onGallery={() => pane.preview && openGallery(pane.preview.from, pane.preview.entry.path)}
            onContext={(path, x, y) => {
            setMenu({ path, x, y })
            // the «Open with» submenu lists the real handlers for this file; load them now so the
            // submenu is complete instead of just pointing at the full dialog
            setMenuApps(null)
            if (path) {
              const isFile = entryOf(active, path)?.dir === false
              if (isFile) {
                void api.apps
                  .openWith(path)
                  .then((r) => setMenuApps({ path, apps: r.apps }))
                  .catch(() => undefined)
              }
            }
          }}
            onDropInternal={(paths, dest, copy) => void dropInternal(paths, dest, copy)}
            onDropFiles={(files, dest, copy) => void dropFiles(files, dest, copy)}
            onMetrics={(m) => {
              metrics.current[i] = m
            }}
            reveal={reveal.pane === i ? reveal : null}
          />
          )
          const renderedPane =
            prefs.paneTree && prefs.layout === 'dual' ? (
              <div className="pane-with-tree" key={'wrap' + i} style={paneFlexStyle}>
                <PaneTree path={tabOf(pane)} showHidden={hidden} onNav={(d) => go(i, d)} />
                {paneEl}
              </div>
            ) : (
              paneEl
            )

          if (isDualBoth && i === 0) {
            return (
              <Fragment key={i}>
                {renderedPane}
                <div
                  key="dual-split"
                  className="vsplit"
                  role="separator"
                  aria-orientation="vertical"
                  title={t('تغییر عرض دو پنجره')}
                  onPointerDown={startDualResize}
                  onDoubleClick={() => updatePrefs({ dualSplit: 0.5 })}
                />
              </Fragment>
            )
          }

          return renderedPane
        })}

        {prefs.treePane === 'right' && (
          <>
            <div
              className="tree-split"
              role="separator"
              aria-orientation="vertical"
              title={t('تغییر عرض درخت')}
              onPointerDown={startTreeResize}
              onDoubleClick={() => updatePrefs({ treeWidth: 232 })}
            />
            <TreePane
              path={curPath}
              showHidden={hidden}
              side="right"
              width={prefs.treeWidth}
              autoFocus={prefs.treeAutoFocus}
              showSymlink={prefs.showSymlink}
              onNav={(d) => go(active, d)}
              onAutoFocus={(on) => updatePrefs({ treeAutoFocus: on })}
              onClose={() => updatePrefs({ treePane: 'off' })}
            />
          </>
        )}

        {sideOpen && prefs.layout === 'single' && (
          <>
            <div
              className="vsplit"
              role="separator"
              aria-orientation="vertical"
              title={t('تغییر عرض پیش‌نمایش')}
              onPointerDown={startSideResize}
            />
            <div
              className="side-slot"
              style={{ flex: `0 0 ${Math.round(prefs.sideWidth * 100)}%`, minWidth: 240 }}
            >
              {sideContent}
            </div>
          </>
        )}

        {ui.sidebarOpen && ui.sidebar === 'float' && (
          <div className="side-float">
            <div
              className={'side-float-panel' + (floatDragging ? ' dragging' : '')}
              style={{
                width: prefs.sidebarWidth,
                transform:
                  floatPos.x !== 0 || floatPos.y !== 0
                    ? `translate(${floatPos.x}px, ${floatPos.y}px)`
                    : undefined
              }}
            >
              <Sidebar
                labels={labelCounts}
                onPickLabel={(id) => setPanes((p) => p && patch(p, active, { filter: '#' + id }))}
                roots={roots}
                marks={marks}
                markIcons={markIcons}
                iconSet={iconSetFor()}
                activePath={curPath}
                showHidden={hidden}
                floating={true}
                onToggleFloat={() => updatePrefs({ sidebar: 'docked' })}
                onNav={(d) => {
                  go(active, d)
                  setUi((u) => ({ ...u, sidebarOpen: false }))
                }}
                onUnmark={(m) => setMarks((x) => x.filter((y) => y !== m))}
                onMarkDrop={addMarks}
                onReorderMarks={handleReorderMarks}
                drives={drives}
                onMountDrive={handleMountDrive}
                onUnmountDrive={handleUnmountDrive}
                onPointerDownHead={startFloatDrag}
                onDoubleClickHead={() => setFloatPos({ x: 0, y: 0 })}
                collapsed={prefs.sidebarCollapsed}
                onToggleSection={handleToggleSidebarSection}
              />
              <div
                className="side-float-resize"
                title={t('تغییر عرض سایدبار')}
                onPointerDown={startFloatSidebarResize}
                onDoubleClick={() => updatePrefs({ sidebarWidth: 208 })}
              />
            </div>
            <div
              className="side-float-backdrop"
              onMouseDown={() => {
                if (!floatDragging) {
                  setUi((u) => ({ ...u, sidebarOpen: false }))
                }
              }}
            />
          </div>
        )}
      </div>

      <JobsBar
        jobs={jobs}
        onPause={(id) => void api.jobs.pause(id)}
        onResume={(id) => void api.jobs.resume(id)}
        onCancel={(id) => void api.jobs.cancel(id)}
        onClear={() => {
          void api.jobs.clear().then(() => api.jobs.list().then(setJobs))
        }}
      />

      <footer className="status">
        <span>
          {panes[active].virtual
            ? `${fa(visible.length)} نتیجه`
            : panes[active].listing
              ? t('{n} مورد', { n: fa(visible.length) })
              : panes[active].loading
                ? t('در حال خواندن…')
                : t('فهرستی نیست')}
        </span>
        <span>
          {panes[active].sel.length > 1
            ? t('{n} انتخاب‌شده · {size}', {
                n: fa(panes[active].sel.length),
                size: fmtSize(selSize, false, prefs.sizeFormat)
              })
            : ''}
        </span>
        {selEntry && (
          <span className="selinfo" title={selEntry.path}>
            <span className="selname" dir="auto">
              {selName}
            </span>
            <span>{typeLabel(selEntry)}</span>
            {!selEntry.dir && <span>{fmtSize(selEntry.size, false, prefs.sizeFormat)}</span>}
            <span className="sel-date" dir="ltr">
              {fmtDate(selEntry.mtime, prefs.dateFormat, prefs.showSeconds)}
            </span>
            {selEntry.mode != null && <span className="sel-mode">{modeString(selEntry.mode)}</span>}
            {selLabel && (
              <span className="sel-label">
                <i style={{ background: selLabel.color }} />
                {t(selLabel.name)}
              </span>
            )}
            {selRating > 0 && (
              <span className="sel-rate">
                <StarIcon filled size={11} />
                {fa(selRating)}
              </span>
            )}
            {selEntry.link && <span>{t('پیوند نمادین')}</span>}
          </span>
        )}
        {indexStatus?.running && (
          <span
            className="index-chip"
            title={t('ایندکس جست‌وجو در جریان است')}
          >
            {t('ایندکس: {scanned} بررسی‌شده · {done}/{total} پوشه', {
              scanned: fa(indexStatus.scanned),
              done: fa(indexStatus.done),
              total: fa(indexStatus.total)
            })}
          </span>
        )}
        {free != null && <span>{t('آزاد:')} {fmtSize(free, false, prefs.sizeFormat)}</span>}
        {update?.newer && (
          <button
            className="update-chip"
            title={t(t('یادداشت‌های نسخه'))}
            onClick={() => update.url && void api.update.open(update.url)}
          >
            نسخهٔ تازه {update.latest}
          </button>
        )}
        <span>{running ? `${fa(running)} عملیات در جریان` : ''}</span>
        {prefs.layout === 'single' && (
          <span title={t(t('مقصد کپی/انتقال در حالت تک‌پنجره'))}>
            {t('مقصد:')} {baseName(tabOf(panes[1 - active]))}
          </span>
        )}
        <span className="spacer" />
        {note && <span className="status-note">{note}</span>}
      </footer>

      {searchOpen && (
        <SearchOverlay
          roots={searchRoots}
          exclude={prefs.searchExclude}
          onClose={() => setSearchOpen(false)}
          onManage={() => {
            setSearchOpen(false)
            setSettingsOpen(true)
          }}
          onReveal={(hit) => {
            setSearchOpen(false)
            const dir = hit.dir ? hit.path : dirOf(hit.path)
            go(active, dir)
            setTimeout(() => {
              setPanes((p) =>
                p
                  ? patch(p, active, {
                      sel: hit.dir ? [] : [hit.path]
                    })
                  : p
              )
            }, 350)
          }}
          onOpen={(hit) => {
            setSearchOpen(false)
            openExternal(hit.path)
          }}
        />
      )}

      {presetsOpen && (
        <PresetsDialog
          layouts={prefs.layouts}
          filters={prefs.filters}
          currentFilter={panes?.[active]?.filter ?? ''}
          onClose={() => setPresetsOpen(false)}
          onSaveLayout={(name) =>
            updatePrefs({
              layouts: {
                ...prefs.layouts,
                [name]: {
                  layout: prefs.layout,
                  sidebar: prefs.sidebar,
                  sidebarOpen: prefs.sidebarOpen,
                  view: viewOf(active),
                  columns: columnsOf(active),
                  toolbar: prefs.toolbar
                }
              }
            })
          }
          onApplyLayout={(name) => {
            const l = prefs.layouts[name]
            if (!l) return
            updatePrefs({
              layout: l.layout ?? prefs.layout,
              sidebar: l.sidebar ?? prefs.sidebar,
              sidebarOpen: l.sidebarOpen ?? prefs.sidebarOpen,
              view: l.view ?? prefs.view,
              columns: (l.columns as typeof prefs.columns) ?? prefs.columns,
              toolbar: l.toolbar ?? prefs.toolbar
            })
            if (l.view) setView(l.view)
            setNote(`چیدمان «${name}» اعمال شد`)
          }}
          onDeleteLayout={(name) => {
            const next = { ...prefs.layouts }
            delete next[name]
            updatePrefs({ layouts: next })
          }}
          onSaveFilter={(name, pattern) =>
            updatePrefs({ filters: { ...prefs.filters, [name]: pattern } })
          }
          onApplyFilter={(pattern) => {
            setPanes((p) => p && patch(p, active, { filter: pattern }))
            setPresetsOpen(false)
          }}
          onDeleteFilter={(name) => {
            const next = { ...prefs.filters }
            delete next[name]
            updatePrefs({ filters: next })
          }}
        />
      )}

      {sync && (
        <SyncDialog
          left={sync.left}
          right={sync.right}
          rows={sync.rows}
          capped={sync.capped}
          busy={sync.busy}
          result={sync.result}
          compareBy={sync.compareBy}
          ignore={sync.ignore}
          onRecompare={(by, ig) => void runCompare(sync.left, sync.right, by, ig)}
          onClose={() => setSync(null)}
          onApply={(mode, deleteExtra) => {
            setSync({ ...sync, busy: true })
            void api.syncApply(sync.left, sync.right, sync.rows, mode, deleteExtra).then(async (r) => {
              setSync({
                ...sync,
                busy: false,
                result: r.errors.length
                  ? `کپی ${fa(r.copied)} · حذف ${fa(r.deleted)} · ${fa(r.errors.length)} خطا — ${r.errors[0]}`
                  : `کپی ${fa(r.copied)} · حذف ${fa(r.deleted)} · بدون خطا`
              })
              await Promise.all([load(0, tabOf(panes![0])), load(1, tabOf(panes![1]))])
            })
          }}
        />
      )}

      {diff && (
        <DiffDialog a={diff.a} b={diff.b} result={diff.result} onClose={() => setDiff(null)} />
      )}

      {tagFor && (
        <TagDialog
          name={tagFor.name}
          tags={tagFor.tags}
          onClose={() => setTagFor(null)}
          onSave={(fields) => {
            const target = tagFor
            setTagFor(null)
            void api.writeTags(target.path, fields).then(async (r) => {
              setNote('error' in r ? `نوشتن برچسب نشد — ${r.error}` : 'برچسب‌های صوتی ذخیره شد')
              await load(active, tabOf(panes![active]))
            })
          }}
        />
      )}

      {rateFor && (
        <RatingDialog
          name={rateFor.name}
          stars={panes?.[active]?.listing?.ratings?.[rateFor.name] ?? 0}
          note={panes?.[active]?.listing?.notes?.[rateFor.name] ?? ''}
          onClose={() => setRateFor(null)}
          onSave={(stars, note) => {
            const target = rateFor
            setRateFor(null)
            void Promise.all([
              api.setRating(target.dir, target.name, stars),
              api.setNote(target.dir, target.name, note)
            ]).then(() => load(active, tabOf(panes![active])))
            setNote(stars ? `${stars} ستاره ثبت شد` : t('امتیاز برداشته شد'))
          }}
        />
      )}

      {convertAsk && (
        <ConvertDialog
          count={convertAsk.files.length}
          busy={convertAsk.busy}
          result={convertAsk.result}
          otherPane={tabOf(panes![1 - active])}
          onClose={() => setConvertAsk(null)}
          onRun={(opts) => {
            setConvertAsk({ ...convertAsk, busy: true })
            const job =
              opts.format === 'webp'
                ? convertToWebp(convertAsk.files, opts.maxSide, opts.quality)
                : api.convertImages(convertAsk.files, {
                    format: opts.format,
                    maxSide: opts.maxSide,
                    quality: opts.quality,
                    dest: opts.toOtherPane ? tabOf(panes![1 - active]) : undefined
                  })
            void job
              .then(async (r) => {
                setConvertAsk({
                  ...convertAsk,
                  busy: false,
                  result: r.errors.length
                    ? `${fa(r.done)} تبدیل شد، ${fa(r.errors.length)} خطا — ${r.errors[0]}`
                    : `${fa(r.done)} تصویر تبدیل شد`
                })
                await Promise.all([load(0, tabOf(panes![0])), load(1, tabOf(panes![1]))])
              })
          }}
        />
      )}

      {labelFor && (
        <div className="modal" onMouseDown={() => setLabelFor(null)}>
          <div className="dialog label-dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dialog-title" dir="auto">
              {t('برچسب برای')} {labelFor.name}
            </div>
            <div className="label-grid">
              {palette.map((l) => (
                <button
                  key={l.id}
                  className="label-chip"
                  onClick={() => {
                    void api
                      .setLabel(labelFor.dir, labelFor.name, l.id)
                      .then(() => load(active, tabOf(panes![active])))
                    setLabelFor(null)
                    setNote(`برچسب «${l.name}» گذاشته شد`)
                  }}
                >
                  <span className="lbl" style={{ background: l.color }} />
                  <span>{l.name}</span>
                </button>
              ))}
              <button
                className="label-chip clear"
                onClick={() => {
                  void api
                    .setLabel(labelFor.dir, labelFor.name, null)
                    .then(() => load(active, tabOf(panes![active])))
                  setLabelFor(null)
                  setNote(t('برچسب برداشته شد'))
                }}
              >{t('بدون برچسب')}</button>
            </div>
          </div>
        </div>
      )}

      {confirmAsk && (
        <div className="modal" onMouseDown={() => setConfirmAsk(null)}>
          <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dlg-title">
              {confirmAsk.kind === 'trash' ? t('به سطل بازیافت برود؟') : t('برای همیشه حذف شود؟')}
            </div>
            <div className="hint" dir="auto">
              {t('{n} مورد', { n: fa(confirmAsk.paths.length) })} ·{' '}
              {confirmAsk.paths.slice(0, 3).map(baseName).join(t('، '))}
              {confirmAsk.paths.length > 3 ? ' …' : ''}
            </div>
            <div className="dlg-actions">
              <button
                autoFocus
                className={confirmAsk.kind === 'delete' ? 'danger' : ''}
                onClick={() => {
                  const ask = confirmAsk
                  setConfirmAsk(null)
                  void runRemove(ask.kind, ask.paths)
                }}
              >
                {t('بله')}
              </button>
              <button onClick={() => setConfirmAsk(null)}>{t('انصراف')}</button>
            </div>
          </div>
        </div>
      )}

      {gallery && (
        <Gallery
          key={gallery.start + gallery.images.length}
          images={gallery.images}
          startPath={gallery.start}
          fullscreen={fullscreen}
          onSaved={setNote}
          onChanged={reloadAll}
          slideshowSec={prefs.slideshowSec}
          loop={prefs.galleryLoop}
          imageFormat={prefs.imageFormat}
          imageQuality={prefs.imageQuality}
          chrome={chrome}
          titlebarButtons={prefs.titlebarButtons}
          titlebarSide={prefs.titlebarSide}
          infoOpen={prefs.galleryInfo}
          onInfoToggle={(open) => updatePrefs({ galleryInfo: open })}
          onFullscreen={() => void toggleFullscreen()}
          onClose={() => {
            setGallery(null)
            if (fullscreen) void toggleFullscreen()
          }}
        />
      )}

      {archiveJob && (
        <ArchiveDialog
          job={archiveJob}
          busy={archiveBusy}
          result={archiveResult}
          onRun={(o) => void runArchive(o)}
          onClose={() => setArchiveJob(null)}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.path)}
          actions={quickActions()}
          swatches={colorSwatches()}
          onSwatch={applyEntryColor}
          onPick={pickMenu}
          onClose={() => setMenu(null)}
        />
      )}

      {marksMenu && (
        <ContextMenu
          x={marksMenu.x}
          y={marksMenu.y}
          items={markItems()}
          onPick={(id) => {
            const target = marksMenu.pane
            setMarksMenu(null)
            if (id.startsWith('mark:')) go(target, id.slice(5))
          }}
          onClose={() => setMarksMenu(null)}
        />
      )}

      {openWith && (
        <OpenWithDialog
          path={openWith}
          customCommands={prefs.customCommands}
          isDir={entryOf(active, openWith)?.dir}
          onClose={() => setOpenWith(null)}
          onNote={setNote}
          onRemember={(app) => {
            const ext = openWith.includes('.') ? (openWith.split('.').pop() ?? '').toLowerCase() : ''
            if (!ext) return
            updatePrefs({ defaultApps: { ...prefs.defaultApps, [ext]: app } })
          }}
        />
      )}

      {propsFor && (
        <PropertiesDialog
          path={propsFor}
          onClose={() => setPropsFor(null)}
          onNote={setNote}
          onPathChange={(next) => {
            setPropsFor(next)
            if (panes) void load(active, tabOf(panes[active]))
          }}
          onUpdate={() => {
            if (panes) void load(active, tabOf(panes[active]))
          }}
          onChangeIcon={() => {
            const target = propsFor
            setPropsFor(null)
            if (target) void openFolderLookAt(target)
          }}
        />
      )}

      {breakdownFor && <BreakdownDialog path={breakdownFor} onClose={() => setBreakdownFor(null)} />}

      {columnMenu && (
        <ContextMenu
          x={columnMenu.x}
          y={columnMenu.y}
          items={columnItems()}
          onPick={pickColumn}
          onClose={() => setColumnMenu(null)}
        />
      )}

      {folderLook && (
        <FolderDialog
          dirs={folderLook.dirs}
          name={folderLook.name}
          meta={folderLook.meta}
          iconDirs={ui.iconDirs ?? []}
          onSave={(patch) => void saveFolderLook(patch)}
          onAddIconDir={(dir) => setUi((u) => ({ ...u, iconDirs: [...(u.iconDirs ?? []), dir] }))}
          onClose={() => setFolderLook(null)}
        />
      )}

      {symlinkFor && (
        <SymlinkDialog
          target={symlinkFor}
          onDone={(link) => {
            setSymlinkFor(null)
            reloadAll()
            setNote(`${t('پیوند ساخته شد')}: ${baseName(link)}`)
          }}
          onClose={() => setSymlinkFor(null)}
        />
      )}

      {renameTargets && (
        <RenameDialog
          paths={renameTargets}
          onClose={() => setRenameTargets(null)}
          onApply={async (pairs) => {
            setRenameTargets(null)
            const res = await api.renameMany(pairs)
            setNote(
              res.errors.length
                ? `${fa(res.done)} تغییر نام، ${fa(res.errors.length)} خطا — ${res.errors[0]}`
                : `${fa(res.done)} تغییر نام انجام شد`
            )
            reloadAll()
          }}
        />
      )}

      {tabPrompt && (
        <div className="modal" onMouseDown={() => setTabPrompt(null)}>
          <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dlg-title">{t('نام تازهٔ تب')}</div>
            <input
              autoFocus
              dir="auto"
              value={tabPrompt.value}
              onChange={(e) => setTabPrompt({ ...tabPrompt, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyTabName()
                if (e.key === 'Escape') setTabPrompt(null)
              }}
            />
            <div className="dlg-actions">
              <button onClick={applyTabName}>{t('ذخیره')}</button>
              <button onClick={() => setTabPrompt(null)}>{t('انصراف')}</button>
            </div>
          </div>
        </div>
      )}

      {prompt && (
        <div className="modal" onMouseDown={() => setPrompt(null)}>
          <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dlg-title">
              {prompt.kind === 'mkdir'
                ? t('نام پوشهٔ نو')
                : prompt.kind === 'createFile'
                  ? t('نام فایل جدید')
                  : t('نام تازه')}
            </div>
            <input
              ref={promptInputRef}
              autoFocus
              dir="auto"
              value={prompt.value}
              onChange={(e) => setPrompt({ ...prompt, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitPrompt()
                if (e.key === 'Escape') setPrompt(null)
              }}
            />
            <div className="dlg-actions">
              <button onClick={() => void submitPrompt()}>{t('تأیید')}</button>
              <button onClick={() => setPrompt(null)}>{t('انصراف')}</button>
            </div>
          </div>
        </div>
      )}

      {newMenu && (
        <ContextMenu
          x={newMenu.x}
          y={newMenu.y}
          items={buildNewMenuItems(true)}
          onPick={handleNewPick}
          onClose={() => setNewMenu(null)}
        />
      )}
    </div>
  )
}
