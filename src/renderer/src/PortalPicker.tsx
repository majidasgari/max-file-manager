import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type Entry, type PortalRequestData } from './api'
import { matchesPortalFilter } from '../../shared/portal-filters.ts'
import { cleanMarkNames, crumbs, baseName, fa, fmtDate, fmtSize, groupEntries, isImage, isVideo, joinPath, orderEntries, thumbUrl, type GroupKey, type SortKey } from './format'
import { ArrowUpIcon, ChevronDownIcon, ChevronLeftIcon, CompactIcon, ConfirmIcon, EntryIcon, EyeIcon, EyeOffIcon, FolderIcon, GridIcon, HomeIcon, ListIcon, PlayIcon, PreviewIcon, RefreshIcon, StarIcon } from './Icons'
import { PreviewPanel } from './PreviewPanel'
import { type FolderView } from './Pane'
import { PURE_ICON_SET } from './pure-icons'
import { folderFormatFor, mergePrefs, migrateLegacy, type Prefs } from './prefs'
import { t } from './i18n'
import { applyPrefs } from './apply-prefs'

const ROW_H = 38
const GROUP_H = 24
const GRID_TILE_W = 112
const GRID_TILE_H = 130
const COMPACT_ROW = 30
const COMPACT_MIN_W = 170
const OVERSCAN = 8

type Place = { name: string; path: string }
type View = 'list' | 'grid' | 'compact'

export function PortalPicker() {
  const [request, setRequest] = useState<PortalRequestData | null>(null)
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [home, setHome] = useState('')
  const [dir, setDir] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [active, setActive] = useState(0)
  const [showHidden, setShowHidden] = useState(false)
  const [filterIndex, setFilterIndex] = useState(0)
  const [fileName, setFileName] = useState('')
  const [address, setAddress] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(400)
  const [contentWidth, setContentWidth] = useState(600)
  const [view, setView] = useState<View>('list')
  const [fmt, setFmt] = useState<FolderView | null>(null)
  const [group, setGroup] = useState<GroupKey>('none')
  const [previewOpen, setPreviewOpen] = useState(true)
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'name', asc: true })
  const [overwrite, setOverwrite] = useState<string | null>(null)
  const [marks, setMarks] = useState<string[]>([])
  const [markNames, setMarkNames] = useState<Record<string, string>>({})
  const [markLooks, setMarkLooks] = useState<Record<string, { color?: string; icon?: string }>>({})
  const [iconSet, setIconSet] = useState<Record<string, string>>({})
  const [marksOpen, setMarksOpen] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)
  const anchor = useRef(0)
  const loadGeneration = useRef(0)
  // `load` is a `useCallback([])`, so it must read these defaults from refs, not the first render's prefs.
  const rememberRef = useRef(true)
  const defaultGroupRef = useRef<GroupKey>('none')

  useEffect(() => {
    let live = true
    void (async () => {
      const [req, state, homeDir] = await Promise.all([api.portal.request(), api.state.get(), api.home()])
      if (!live) return
      const merged = mergePrefs({ ...migrateLegacy(state), ...(state?.prefs ?? {}) })
      // Match the main app's icon setting exactly: line glyphs, the bundled Pure set, or the
      // desktop theme with Pure as a guaranteed fallback when the OS theme cannot be resolved.
      const systemIcons = merged.fileIcons === 'system' ? await api.iconSet().catch(() => ({})) : {}
      if (!live) return
      const icons = merged.fileIcons === 'line'
        ? {}
        : merged.fileIcons === 'pure'
          ? PURE_ICON_SET
          : Object.keys(systemIcons).length ? systemIcons : PURE_ICON_SET
      applyPrefs(merged)
      setPrefs(merged)
      rememberRef.current = merged.rememberFolderView
      defaultGroupRef.current = merged.groupBy as GroupKey
      setShowHidden(merged.showHidden)
      setHome(homeDir)
      setIconSet(icons)
      // the same list the file manager's sidebar shows: bookmarks live in the shared state
      setMarks(Array.isArray(state?.marks) ? state.marks.filter((m): m is string => typeof m === 'string' && m.startsWith('/')) : [])
      setMarkNames(cleanMarkNames(state?.markNames))
      setRequest(req)
      setFileName(req?.currentName ?? '')
      setDir(req?.currentFolder || merged.pickerLastDir || homeDir)
      document.title = req?.title || 'Max File Manager'
    })().catch((e) => {
      if (live) setError(e instanceof Error ? e.message : String(e))
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!prefs || prefs.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => applyPrefs(prefs)
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [prefs])

  const load = useCallback(async (target: string, hidden: boolean) => {
    const generation = ++loadGeneration.current
    setLoading(true)
    setError('')
    const listing = await api.list(target, hidden).catch((e: unknown) => {
      if (generation === loadGeneration.current) {
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      }
      return null
    })
    if (!listing || generation !== loadGeneration.current) return
    // A folder's own format lives in its .mfm.json; only honor the view when the user asked for that.
    const stored = (listing.format as FolderView | null) ?? null
    const next = stored ? folderFormatFor(stored, rememberRef.current) : null
    setFmt(next)
    if (next?.view) setView(next.view)
    if (next?.sortKey) setSort({ key: next.sortKey as SortKey, asc: next.sortAsc ?? true })
    setGroup((next?.group ?? defaultGroupRef.current) as GroupKey)
    setDir(listing.path)
    setEntries(listing.entries)
    setSelected([])
    setActive(0)
    anchor.current = 0
    setScrollTop(0)
    scroller.current?.scrollTo({ top: 0 })
    setLoading(false)
  }, [])

  const saveFormat = (patch: Partial<FolderView>) => {
    const merged = folderFormatFor({ ...(fmt ?? {}), ...patch }, rememberRef.current)
    setFmt(merged)
    if (dir && rememberRef.current) void api.setFormat(dir, merged).catch(() => undefined)
  }

  useEffect(() => {
    if (dir) void load(dir, showHidden)
    // Initial dir, request and home are committed together; later navigation calls load directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, home])

  const hiddenMounted = useRef(false)
  useEffect(() => {
    if (hiddenMounted.current && dir) void load(dir, showHidden)
    hiddenMounted.current = true
  }, [showHidden]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => {
      setViewport(el.clientHeight)
      setContentWidth(el.clientWidth)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [request])

  // Changing the layout changes the row height, so an old scroll offset would point at empty space.
  useEffect(() => {
    setScrollTop(0)
    scroller.current?.scrollTo({ top: 0 })
  }, [view])

  const navigate = useCallback((target: string) => {
    setAddress(null)
    void load(target, showHidden)
  }, [load, showHidden])

  /**
   * Enter in the path field. A folder goes there; in a save dialog a path that is not a folder is
   * «folder + file name», which is how a full path is typed into that bar.
   */
  const submitAddress = async () => {
    const typed = (address ?? '').trim()
    if (!typed) return
    setAddress(null)
    if ((await api.list(typed, showHidden).catch(() => null)) || request?.operation !== 'save') {
      void load(typed, showHidden)
      return
    }
    const cut = Math.max(typed.lastIndexOf('/'), typed.lastIndexOf('\\'))
    const name = typed.slice(cut + 1)
    const parent = cut > 0 ? typed.slice(0, cut) : ''
    if (name && parent && (await api.list(parent, showHidden).catch(() => null))) {
      setFileName(name)
      void load(parent, showHidden)
      return
    }
    void load(typed, showHidden)
  }

  const activeFilter = request?.filters[filterIndex] ?? null
  const sorted = useMemo(() => {
    const kept = entries.filter((e) => e.dir || matchesPortalFilter(e.name, e.ext, activeFilter))
    // Same rule as the file manager: folders lead for name/size, and interleave for dates etc.
    const groupFolders = sort.key === 'name' || sort.key === 'size'
    return orderEntries(kept, sort.key, sort.asc, '', groupFolders && (prefs?.foldersFirst ?? true))
  }, [entries, activeFilter, sort, prefs?.foldersFirst])
  const groups = useMemo(() => groupEntries(sorted, group), [sorted, group])
  // Every index (selection, active cursor, keyboard, count) is a flat index into this list.
  const flat = useMemo(() => groups.flatMap((g) => g.entries), [groups])

  useEffect(() => {
    if (active >= flat.length) setActive(Math.max(0, flat.length - 1))
  }, [active, flat.length])

  // A column click changes the visual order; keep the keyboard cursor on the selected row.
  useEffect(() => {
    if (!selected.length) return
    const index = flat.findIndex((e) => e.path === selected[0])
    if (index >= 0) {
      setActive(index)
      anchor.current = index
    }
    // Selection is deliberately omitted: Ctrl-click may keep the first selected row while focusing
    // another one, and re-sorting is the only case where the index must be repaired.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat])

  // All three layouts stay windowed: only the rows/tiles touching the viewport are mounted.
  const isList = view === 'list'
  const cols = isList
    ? 1
    : view === 'compact'
      ? Math.max(1, Math.floor((Math.max(1, contentWidth) - 8) / COMPACT_MIN_W))
      : Math.max(1, Math.floor(Math.max(1, contentWidth) / GRID_TILE_W))
  const itemH = isList ? ROW_H : view === 'compact' ? COMPACT_ROW : GRID_TILE_H
  const compactW = Math.max(120, Math.floor((Math.max(1, contentWidth) - 8) / cols))
  const gridW = Math.max(96, Math.floor((Math.max(1, contentWidth) - 8) / cols))

  // Group headers only exist in the list view; grid/compact keep the grouped order without headings.
  const listLayout = useMemo(() => {
    const items: ({ kind: 'head'; label: string } | { kind: 'entry'; entry: Entry; index: number })[] = []
    const tops: number[] = []
    const heights: number[] = []
    const entryRow: number[] = []
    let y = 0
    let index = 0
    for (const g of groups) {
      if (g.label) {
        items.push({ kind: 'head', label: g.label })
        tops.push(y)
        heights.push(GROUP_H)
        y += GROUP_H
      }
      for (const entry of g.entries) {
        entryRow[index] = items.length
        items.push({ kind: 'entry', entry, index })
        tops.push(y)
        heights.push(ROW_H)
        y += ROW_H
        index++
      }
    }
    return { items, tops, heights, entryRow, total: y }
  }, [groups])

  // First item whose bottom edge is past `offset`; binary search because list rows have mixed heights.
  const listAt = (offset: number): number => {
    let lo = 0
    let hi = listLayout.items.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (listLayout.tops[mid] + listLayout.heights[mid] <= offset) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const rowCount = isList ? 0 : Math.ceil(flat.length / cols)
  const startRow = Math.max(0, Math.floor(scrollTop / itemH) - OVERSCAN)
  const endRow = Math.min(rowCount, Math.ceil((scrollTop + viewport) / itemH) + OVERSCAN)
  const startIndex = isList ? Math.max(0, listAt(scrollTop) - OVERSCAN) : startRow * cols
  const endIndex = isList
    ? Math.min(listLayout.items.length, listAt(scrollTop + viewport) + 1 + OVERSCAN)
    : Math.min(flat.length, endRow * cols)
  const visibleItems = isList ? listLayout.items.slice(startIndex, endIndex) : []
  const visibleEntries = isList ? [] : flat.slice(startIndex, endIndex)
  const spacerHeight = isList ? listLayout.total : rowCount * itemH

  /** The side preview follows the selection, and in a save dialog it also follows a typed name. */
  const previewEntry = useMemo(() => {
    const picked = flat.find((e) => selected.includes(e.path))
    if (picked) return picked
    if (request?.operation === 'save' && fileName.trim()) {
      return flat.find((e) => e.name === fileName.trim()) ?? null
    }
    return null
  }, [flat, selected, request, fileName])

  useEffect(() => {
    // the same list the file manager's sidebar shows: bookmarks live in the shared state
    return api.state.onMarks(setMarks)
  }, [])

  useEffect(() => {
    if (!marks.length) return
    let live = true
    void Promise.all(marks.slice(0, 60).map(async (m) => [m, await api.folderLook(m)] as const)).then((pairs) => {
      if (live) setMarkLooks(Object.fromEntries(pairs))
    })
    return () => {
      live = false
    }
  }, [marks])

  const places = useMemo<Place[]>(() => {
    if (!home) return [{ name: '/', path: '/' }]
    return [
      { name: t('خانه'), path: home },
      { name: t('دسکتاپ'), path: joinPath(home, 'Desktop') },
      { name: t('اسناد'), path: joinPath(home, 'Documents') },
      { name: t('دانلودها'), path: joinPath(home, 'Downloads') },
      { name: t('تصاویر'), path: joinPath(home, 'Pictures') },
      { name: t('ریشه'), path: '/' }
    ]
  }, [home])

  const finish = async (paths: string[]) => {
    if (busy) return
    setBusy(true)
    setError('')
    await api.portal.rememberDir(dir)
    const result = await api.portal.respond({ paths, filter: activeFilter })
    if ('error' in result) {
      setError(result.error)
      setBusy(false)
    }
  }

  const accept = async () => {
    if (!request || busy) return
    if (request.operation === 'open') {
      if (request.directory) {
        const chosen = selected.filter((p) => entries.find((e) => e.path === p)?.dir)
        await finish(chosen.length ? chosen : [dir])
      } else {
        const files = selected.filter((p) => entries.find((e) => e.path === p && !e.dir))
        if (!files.length) {
          setError(t('اول یک فایل را انتخاب کن'))
          return
        }
        await finish(files)
      }
      return
    }
    if (request.operation === 'saveFiles') {
      if (!request.fileNames.length) {
        setError(t('نام فایل برای ذخیره مشخص نشده است'))
        return
      }
      await finish(request.fileNames.map((name) => joinPath(dir, name)))
      return
    }
    const clean = fileName.trim()
    if (!clean || clean === '.' || clean === '..' || /[/\\\0]/.test(clean)) {
      setError(t('یک نام فایل معتبر بنویس'))
      return
    }
    const target = joinPath(dir, clean)
    const stat = await api.properties(target)
    if (!('error' in stat) && !overwrite) {
      setOverwrite(target)
      return
    }
    await finish(target ? [target] : [])
  }

  const openEntry = (entry: Entry) => {
    if (entry.dir) navigate(entry.path)
    else if (request?.operation === 'open' && !request.directory) {
      setSelected([entry.path])
      void finish([entry.path])
    } else if (request?.operation === 'save') {
      setFileName(entry.name)
    }
  }

  const changeSort = (key: SortKey) => {
    const next = sort.key === key ? { key, asc: !sort.asc } : { key, asc: true }
    setSort(next)
    saveFormat({ sortKey: next.key, sortAsc: next.asc })
    setOverwrite(null)
  }
  const sortMark = (key: SortKey) => sort.key === key ? (sort.asc ? ' ▲' : ' ▼') : ''

  const saveView = (next: View) => {
    setView(next)
    saveFormat({ view: next })
  }

  const selectEntry = (entry: Entry, index: number, ev: React.MouseEvent) => {
    let next = [entry.path]
    if (request?.multiple && ev.shiftKey) {
      const from = Math.min(anchor.current, index)
      const to = Math.max(anchor.current, index)
      next = flat.slice(from, to + 1).map((e) => e.path)
    } else if (request?.multiple && (ev.ctrlKey || ev.metaKey)) {
      next = selected.includes(entry.path) ? selected.filter((p) => p !== entry.path) : [...selected, entry.path]
      anchor.current = index
    } else anchor.current = index
    setSelected(next)
    setActive(index)
    setOverwrite(null)
    if (request?.operation === 'save' && !entry.dir) setFileName(entry.name)
  }

  const keyboard = (ev: React.KeyboardEvent) => {
    const target = ev.target as HTMLElement
    if (target.matches('input,select,textarea,[contenteditable=true]')) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      if (overwrite) setOverwrite(null)
      else void api.portal.respond(null)
    } else if (ev.altKey && ev.key === 'ArrowUp' || ev.key === 'Backspace') {
      ev.preventDefault()
      const parent = crumbs(dir).at(-2)?.path
      if (parent) navigate(parent)
    } else if (
      ev.key === 'ArrowDown' ||
      ev.key === 'ArrowUp' ||
      (!isList && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight'))
    ) {
      ev.preventDefault()
      const delta =
        ev.key === 'ArrowDown' || ev.key === 'ArrowRight'
          ? view === 'list' ? 1 : ev.key === 'ArrowDown' ? cols : 1
          : view === 'list' ? -1 : ev.key === 'ArrowUp' ? -cols : -1
      const next = Math.max(0, Math.min(flat.length - 1, active + delta))
      setActive(next)
      if (!ev.ctrlKey && !ev.metaKey) setSelected(flat[next] ? [flat[next].path] : [])
      if (ev.shiftKey && request?.multiple) {
        const from = Math.min(anchor.current, next)
        const to = Math.max(anchor.current, next)
        setSelected(flat.slice(from, to + 1).map((e) => e.path))
      } else anchor.current = next
      const itemIndex = isList ? listLayout.entryRow[next] : Math.floor(next / cols)
      const top = itemIndex === undefined ? 0 : isList ? listLayout.tops[itemIndex] : itemIndex * itemH
      const height = itemIndex === undefined ? itemH : isList ? listLayout.heights[itemIndex] : itemH
      const el = scroller.current
      if (el) {
        if (top < el.scrollTop) el.scrollTo({ top })
        else if (top + height > el.scrollTop + el.clientHeight) {
          el.scrollTo({ top: top + height - el.clientHeight })
        }
      }
    } else if (ev.key === 'F3') {
      ev.preventDefault()
      setPreviewOpen((open) => !open)
    } else if (ev.key === 'Enter') {
      ev.preventDefault()
      const entry = flat[active]
      if (entry?.dir) openEntry(entry)
      else void accept()
    } else if (ev.key.toLowerCase() === 'a' && (ev.ctrlKey || ev.metaKey) && request?.multiple) {
      ev.preventDefault()
      setSelected(flat.filter((e) => request.directory === e.dir || (!request.directory && !e.dir)).map((e) => e.path))
    }
  }

  if (!request || !prefs) return <div className="boot">{error || t('در حال باز کردن…')}</div>
  const acceptLabel = request.acceptLabel || (request.operation === 'open'
    ? request.directory ? t('انتخاب پوشه') : t('باز کردن')
    : request.operation === 'saveFiles' ? t('انتخاب پوشه') : t('ذخیره'))

  return (
    <main className="portal-picker" tabIndex={0} onKeyDown={keyboard}>
      <header className="picker-header">
        <div className="picker-title" dir="auto">{request.title}</div>
        <div className="picker-tools">
          <select
            className="picker-sort"
            dir="auto"
            title={t('مرتب‌سازی بر اساس')}
            aria-label={t('مرتب‌سازی بر اساس')}
            value={`${sort.key}:${sort.asc ? 'asc' : 'desc'}`}
            onChange={(e) => {
              const [key, asc] = e.target.value.split(':') as [SortKey, 'asc' | 'desc']
              const next = { key, asc: asc === 'asc' }
              setSort(next)
              saveFormat({ sortKey: next.key, sortAsc: next.asc })
              setOverwrite(null)
            }}
          >
            <option value="name:asc">{t('نام')} ↑</option>
            <option value="name:desc">{t('نام')} ↓</option>
            <option value="size:asc">{t('اندازه')} ↑</option>
            <option value="size:desc">{t('اندازه')} ↓</option>
            <option value="mtime:desc">{t('تاریخ')} ↓</option>
            <option value="mtime:asc">{t('تاریخ')} ↑</option>
          </select>
          <select
            className="picker-sort"
            dir="auto"
            title={t('گروه‌بندی')}
            aria-label={t('گروه‌بندی')}
            value={group}
            onChange={(e) => {
              const next = e.target.value as GroupKey
              setGroup(next)
              saveFormat({ group: next })
            }}
          >
            <option value="none">{t('بدون گروه‌بندی')}</option>
            <option value="name">{t('نام')}</option>
            <option value="type">{t('نوع')}</option>
            <option value="size">{t('اندازه')}</option>
            <option value="date">{t('تاریخ')}</option>
            <option value="ext">{t('پسوند')}</option>
          </select>
          <div className="view-switch" role="group" aria-label={t('تعویض نما')}>
            <button className={`tb ${view === 'list' ? 'on' : ''}`} title={t('نمای فهرست')} aria-pressed={view === 'list'} onClick={() => saveView('list')}><ListIcon /></button>
            <button className={`tb ${view === 'grid' ? 'on' : ''}`} title={t('نمای شبکه')} aria-pressed={view === 'grid'} onClick={() => saveView('grid')}><GridIcon /></button>
            <button className={`tb ${view === 'compact' ? 'on' : ''}`} title={t('نمای فشرده')} aria-pressed={view === 'compact'} onClick={() => saveView('compact')}><CompactIcon /></button>
          </div>
          <button
            className={`tb ${previewOpen ? 'on' : ''}`}
            title={previewOpen ? t('بستن پیش‌نمایش (F3)') : t('پنل پیش‌نمایش')}
            aria-pressed={previewOpen}
            onClick={() => setPreviewOpen((open) => !open)}
          >
            <PreviewIcon />
          </button>
          <button
            className={`tb ${marks.includes(dir) ? 'on' : ''}`}
            disabled={!dir}
            title={marks.includes(dir) ? t('برداشتن نشان') : t('نشان‌کردن در سایدبار')}
            onClick={async () => {
              const next = await api.state.marks({ path: dir, on: !marks.includes(dir) })
              setMarks(next)
            }}
          >
            <StarIcon filled={marks.includes(dir)} />
          </button>
          <button className="tb" title={t('پوشهٔ بالایی')} disabled={dir === '/'} onClick={() => {
            const parent = crumbs(dir).at(-2)?.path
            if (parent) navigate(parent)
          }}><ArrowUpIcon /></button>
          <button className="tb" title={t('نوسازی')} onClick={() => navigate(dir)}><RefreshIcon /></button>
          <button className={`tb ${showHidden ? 'on' : ''}`} title={showHidden ? t('پنهان‌کردن فایل‌های مخفی') : t('نمایش فایل‌های مخفی')} onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? <EyeIcon /> : <EyeOffIcon />}
          </button>
        </div>
      </header>

      <div className="picker-path-row">
        {address === null ? (
          <nav
            className="picker-crumbs"
            aria-label={t('نشانی')}
            onDoubleClick={() => setAddress(dir)}
            // same rule as the panes: a click on the row's empty space edits the path
            onClick={(e) => {
              if (e.target === e.currentTarget) setAddress(dir)
            }}
          >
            {crumbs(dir).map((c, i) => (
              <Fragment key={c.path}>
                {i > 0 && <ChevronLeftIcon size={13} />}
                <button
                  dir="auto"
                  onClick={(e) => {
                    // the folder you are already in has nowhere to go: edit the path instead
                    if (e.detail > 1 || c.path === dir) setAddress(dir)
                    else navigate(c.path)
                  }}
                >
                  {c.name}
                </button>
              </Fragment>
            ))}
          </nav>
        ) : (
          <input
            className="picker-address"
            dir="ltr"
            autoFocus
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitAddress()
              if (e.key === 'Escape') setAddress(null)
            }}
          />
        )}
      </div>

      <div className="picker-body">
        <aside className="picker-places">
          {places.map((p) => <button key={p.path} className={dir === p.path ? 'on' : ''} onClick={() => navigate(p.path)}>
            {p.path === home ? <HomeIcon /> : <FolderIcon />}<span>{p.name}</span>
          </button>)}
          {marks.length > 0 && <>
            <div className="picker-side-head">
              <button className="picker-side-toggle" onClick={() => setMarksOpen((o) => !o)} aria-expanded={marksOpen}>
                {marksOpen ? <ChevronDownIcon size={11} /> : <ChevronLeftIcon size={11} />}
                <span>{t('نشان‌شده‌ها')}</span>
                <span className="picker-badge">{fa(marks.length)}</span>
              </button>
            </div>
            {marksOpen && marks.map((m) => (
              <button key={m} className={`mark${dir === m ? ' on' : ''}`} title={m} onClick={() => navigate(m)}>
                <EntryIcon
                  size={15}
                  iconSet={iconSet}
                  entry={{
                    name: markNames[m] || baseName(m),
                    path: m,
                    dir: true,
                    size: 0,
                    mtime: 0,
                    ext: '',
                    color: markLooks[m]?.color,
                    icon: markLooks[m]?.icon
                  }}
                />
                <span dir="auto">{markNames[m] || baseName(m)}</span>
              </button>
            ))}
          </>}
        </aside>
        <section className={`picker-files view-${view}`}>
          {view === 'list' && <div className="picker-columns">
            <button className={sort.key === 'name' ? 'on' : ''} onClick={() => changeSort('name')}>{t('نام')}{sortMark('name')}</button>
            <button className={sort.key === 'size' ? 'on' : ''} onClick={() => changeSort('size')}>{t('اندازه')}{sortMark('size')}</button>
            <button className={sort.key === 'mtime' ? 'on' : ''} onClick={() => changeSort('mtime')}>{t('تاریخ')}{sortMark('mtime')}</button>
          </div>}
          <div className="picker-scroll" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
            <div className="picker-spacer" style={{ height: spacerHeight }}>
              {isList && visibleItems.map((item, offset) => {
                const at = startIndex + offset
                if (item.kind === 'head') {
                  return (
                    <div
                      key={`head:${at}`}
                      className="picker-group-head"
                      style={{ top: listLayout.tops[at], height: GROUP_H }}
                      dir="auto"
                    >
                      {item.label}
                    </div>
                  )
                }
                const entry = item.entry
                const index = item.index
                const on = selected.includes(entry.path)
                const activeClass = index === active ? ' active' : ''
                return (
                  <div
                    key={entry.path}
                    className={`picker-row${on ? ' selected' : ''}${activeClass}`}
                    style={{ top: listLayout.tops[at] }}
                    onClick={(e) => selectEntry(entry, index, e)}
                    onDoubleClick={() => openEntry(entry)}
                  >
                    <span className="picker-name"><EntryIcon entry={entry} size={18} iconSet={iconSet} /><span dir="auto">{entry.name}</span></span>
                    <span className="picker-size">{entry.dir ? '—' : fmtSize(entry.size, false, prefs.sizeFormat)}</span>
                    <span className="picker-date" dir="ltr">{fmtDate(entry.mtime, prefs.dateFormat)}</span>
                  </div>
                )
              })}
              {!isList && visibleEntries.map((entry, offset) => {
                const index = startIndex + offset
                const row = Math.floor(index / cols)
                const col = index % cols
                const on = selected.includes(entry.path)
                const activeClass = index === active ? ' active' : ''
                if (view === 'compact') {
                  return (
                    <div
                      key={entry.path}
                      className={`picker-compact-row${on ? ' selected' : ''}${activeClass}`}
                      style={{
                        top: row * COMPACT_ROW,
                        insetInlineStart: col * compactW,
                        width: compactW - 4,
                        height: COMPACT_ROW - 2
                      }}
                      title={entry.path}
                      onClick={(e) => selectEntry(entry, index, e)}
                      onDoubleClick={() => openEntry(entry)}
                    >
                      <EntryIcon entry={entry} size={17} iconSet={iconSet} />
                      <span dir="auto">{entry.name}</span>
                    </div>
                  )
                }
                const video = !entry.dir && isVideo(entry.ext)
                const pic = !entry.dir && (isImage(entry.ext) || video)
                const thumbSize = Math.max(48, Math.min(88, gridW - 26))
                return (
                  <div
                    key={entry.path}
                    className={`picker-tile${on ? ' selected' : ''}${activeClass}`}
                    style={{
                      top: row * GRID_TILE_H,
                      insetInlineStart: col * gridW,
                      width: gridW - 6,
                      height: GRID_TILE_H - 6
                    }}
                    title={entry.path}
                    onClick={(e) => selectEntry(entry, index, e)}
                    onDoubleClick={() => openEntry(entry)}
                  >
                    <span
                      className={`picker-tile-thumb${pic ? ' pic' : ''}`}
                      style={{ width: thumbSize, height: thumbSize }}
                    >
                      <EntryIcon entry={entry} size={pic ? Math.round(thumbSize * 0.55) : thumbSize * 0.62} iconSet={iconSet} />
                      {pic && (
                        <img
                          className="picker-tile-photo"
                          src={thumbUrl(entry.path, 256, `${Math.round(entry.mtime)}-${entry.size}`)}
                          alt=""
                          loading="lazy"
                          draggable={false}
                          onError={(ev) => { ev.currentTarget.style.display = 'none' }}
                        />
                      )}
                      {video && <span className="picker-video-badge" aria-hidden="true"><PlayIcon /></span>}
                    </span>
                    <span className="picker-tile-name" dir="auto">{entry.name}</span>
                  </div>
                )
              })}
            </div>
            {!loading && !flat.length && <div className="picker-empty">{t('چیزی با این نام نیست')}</div>}
            {loading && <div className="picker-empty">{t('در حال باز کردن…')}</div>}
          </div>
        </section>
        {previewOpen && (
          <aside className="picker-preview">
            <PreviewPanel
              entry={previewEntry}
              maxKB={prefs.previewMaxKB}
              onOpen={(path) => {
                const entry = flat.find((e) => e.path === path)
                if (entry) openEntry(entry)
              }}
              onClose={() => setPreviewOpen(false)}
            />
          </aside>
        )}
      </div>

      {error && <div className="picker-error" dir="auto">{error}</div>}
      {overwrite && <div className="picker-overwrite" dir="auto">
        <span>{t('فایلی با این نام وجود دارد. جایگزین شود؟')}</span>
        <button className="btn" onClick={() => { const p = overwrite; setOverwrite(null); void finish([p]) }}>{t('جایگزین کن')}</button>
        <button className="btn ghost" onClick={() => setOverwrite(null)}>{t('لغو')}</button>
      </div>}
      <footer className="picker-footer">
        <div className="picker-save-fields">
          {request.operation === 'save' && <label><span>{t('نام فایل')}</span><input dir="auto" value={fileName} autoFocus onChange={(e) => { setFileName(e.target.value); setOverwrite(null) }} onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void accept() }
            if (e.key === 'Escape') { e.preventDefault(); void api.portal.respond(null) }
          }} /></label>}
          {request.filters.length > 0 && <select aria-label={t('نوع فایل')} value={filterIndex} onChange={(e) => { setFilterIndex(Number(e.target.value)); setSelected([]) }}>
            {request.filters.map((f, i) => <option key={`${f.name}-${i}`} value={i}>{f.name}</option>)}
          </select>}
          {selected.length > 1 && <span className="picker-selection-count">{fa(selected.length)} {t('انتخاب‌شده')}</span>}
        </div>
        <div className="picker-actions">
          <button className="btn ghost" disabled={busy} onClick={() => void api.portal.respond(null)}>{t('لغو')}</button>
          <button className="btn primary" disabled={busy || loading} onClick={() => void accept()}><ConfirmIcon />{acceptLabel}</button>
        </div>
      </footer>
    </main>
  )
}
