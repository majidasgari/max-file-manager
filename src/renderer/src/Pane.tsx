import { t } from './i18n.ts'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type Entry, type Listing } from './api'
import { keepDragPaths } from './drag'
import { dragLog } from './draglog'
import type { ColId } from './prefs'
import {
  crumbs,
  fa,
  fileUri,
  fmtDate,
  fmtSize,
  groupEntries,
  groupLabel,
  type GroupKey,
  modeString,
  isImage,
  mediaUrl,
  thumbUrl,
  orderEntries,
  typeLabel,
  type SortKey
} from './format'
import { PreviewPanel } from './PreviewPanel'
import { EntryIcon, EyeOffIcon, FilterIcon, LinkIcon, LockIcon, SortIcon } from './Icons'
import {
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DupeIcon,
  FolderPlusIcon,
  GaugeIcon,
  LayersIcon,
  MoveIcon,
  PaletteIcon,
  PinIcon,
  PlusIcon,
  RefreshIcon,
  RenameIcon,
  SearchIcon,
  StarIcon,
  TrashIcon,
  XIcon
} from './Icons'

export type View = 'list' | 'grid'

export type Virtual = { kind: 'flat' | 'search' | 'dupes' | 'archive'; label: string }

/** A folder's own view format (Opus «Folder Format»), applied while its pane is there. */
export type FolderView = {
  view?: View
  columns?: string[]
  sortKey?: string
  sortAsc?: boolean
  group?: GroupKey
}

export type PaneState = {
  tabs: string[]
  tabIds?: string[]
  ti: number
  /** custom tab titles keyed by folder path */
  tabNames: Record<string, string>
  /** locked tabs keep their folder; navigation opens a new tab */
  tabLocks: Record<string, boolean>
  /** tabs before this index are pinned: first, protected from closing, no boundary crossing */
  pinCount: number
  hist: string[]
  hi: number
  sel: string[]
  filter: string
  listing: Listing | null
  /** flat view / search / duplicates / archive replace the folder listing with these */
  virtual: Virtual | null
  results: Entry[] | null
  /** archive path while virtual.kind === 'archive' */
  archive: string | null
  /** this pane shows a preview of an entry instead of a listing */
  preview: { entry: Entry; from: number } | null
  error: string
  loading: boolean
  /** the loaded folder's own format; null means «use the app defaults» */
  fmt: FolderView | null
}

export type SearchQuery = { query: string; content: string; regex: boolean }

type Props = {
  index: number
  pane: PaneState
  active: boolean
  sort: { key: SortKey; asc: boolean }
  /** Dolphin-style grouping of the listing */
  groupBy: GroupKey
  view: View
  foldersFirst: boolean
  columns: ColId[]
  /** per-column pixel width (a missing key uses the built-in width) */
  colWidths: Record<string, number>
  /** fields shown under a grid tile name */
  gridMeta: ColId[]
  onColumnWidth(id: ColId, px: number): void
  onHeaderMenu(x: number, y: number): void
  /** max lines a grid tile name may use */
  nameLines: number
  /** grid tile width in px; the thumbnail and the name box scale from it */
  tileSize: number
  /** a pane with one tab shows no tab strip */
  hideSingleTab: boolean
  /** dual layout with a multi-tab sibling: keep both strips so the panes stay symmetric */
  forceTabStrip?: boolean
  /** kind → icon file of the preferred desktop theme; empty means our line glyphs */
  iconSet?: Record<string, string>
  sizeFormat: 'human' | 'bytes'
  dateFormat: 'iso' | 'jalali' | 'short'
  showSeconds: boolean
  showSymlink?: boolean
  sizes: Record<string, string>
  marked: boolean
  /** Ctrl+wheel in the grid resizes the tiles (icons and thumbnails alike) */
  onZoom(delta: number): void
  /** the command bar's «filter» bumps this to open the floating input */
  filterTick: number
  filterRef(el: HTMLInputElement | null): void
  /** Ctrl+L bumps this to edit the current path in place of the breadcrumbs */
  addrTick: number
  /** the user's home folder, so `~` in the address field resolves */
  home: string
  onActivate(): void
  onSort(key: SortKey): void
  onNav(dir: string): void
  onBack(): void
  onForward(): void
  onUp(): void
  onRefresh(): void
  onOpen(path: string): void
  onSel(paths: string[], mode: 'set' | 'toggle'): void
  onFilter(q: string): void
  /** sort + grouping menu, anchored at the button (works in both views) */
  onSortMenu(x: number, y: number): void
  onTabNew(): void
  onTabClose(idx: number): void
  onTabPick(idx: number): void
  onTabMenu(idx: number, x: number, y: number): void
  onTabMove(from: number, to: number): void
  middleClickClosesTab: boolean
  palette: { id: string; name: string; color: string }[]
  /** folder path → tab colour chosen in the tab menu */
  tabColors: Record<string, string>
  /** folder path → its own colour/icon for the tab strip */
  tabIcons: Record<string, { color?: string; icon?: string }>
  /** settings switch: show the folder icon inside each tab */
  showTabIcons: boolean
  typeColors: Record<string, string>
  onOp(kind: 'copy' | 'move' | 'trash' | 'mkdir' | 'rename'): void
  onSize(): void
  onBookmark(): void
  /** open the bookmarks list for this pane, anchored at the caret */
  onBookmarksMenu(x: number, y: number): void
  onFlat(): void
  onDupes(): void
  onSearch(q: SearchQuery): void
  onExitVirtual(): void
  onFolderLook(): void
  previewIndex?: { at: number; total: number } | null
  onPreviewNav?(delta: number): void
  onPreviewClose?(): void
  onGallery?(): void
  onContext(path: string | null, x: number, y: number): void
  onDropInternal(paths: string[], dest: string, copy: boolean): void
  onDropFiles(files: File[], dest: string, copy: boolean): void
  /** visible columns/rows, so the app can move the selection by a page or a grid row */
  onMetrics?(m: { cols: number; rows: number }): void
  /** bump `tick` to scroll this entry into view */
  reveal?: { path: string; tick: number } | null
  style?: React.CSSProperties
}

const ROW = 28
/** a tile grows with its width: bigger thumbnail, same number of name lines underneath */
const tileGeo = (width: number, nameLines: number, metaLines = 0) => {
  const w = Math.max(80, Math.min(240, Math.round(width) || 108))
  const thumb = Math.round(w * 0.66)
  return {
    w,
    thumb,
    glyph: Math.round(w * 0.52),
    h: thumb + 24 + Math.max(1, nameLines) * 17 + metaLines * 14,
    font: w >= 170 ? 13 : w >= 130 ? 12 : 11.5
  }
}

const isImageName = (n: string) => /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i.test(n)

export function Pane(props: Props) {
  const { pane, sort, active, view } = props
  const [scrollTop, setScrollTop] = useState(0)
  const [box, setBox] = useState({ w: 600, h: 600 })
  const [searchOpen, setSearchOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  /** rubber-band rectangle, in the scroll content's coordinates */
  const [band, setBand] = useState<{ left: number; top: number; width: number; height: number } | null>(
    null
  )
  const marquee = useRef<{ x: number; y: number; base: Set<string> } | null>(null)
  const filterInput = useRef<HTMLInputElement | null>(null)
  const lastFilterTick = useRef(props.filterTick)
  /** the inline address field; null means the breadcrumbs are showing */
  const [addrEdit, setAddrEdit] = useState<string | null>(null)
  const addrInput = useRef<HTMLInputElement | null>(null)
  const lastAddrTick = useRef(props.addrTick)
  const [query, setQuery] = useState('')
  const [content, setContent] = useState('')
  const [regex, setRegex] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const anchor = useRef(0)

  // a ref callback, not a mount effect: the rows element is unmounted while this pane shows a
  // preview, and a `[]` effect would leave the fresh element unmeasured (stale 600px → 5 columns)
  // Escape closes the floating filter even when the caret is elsewhere
  useEffect(() => {
    if (!filterOpen) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setFilterOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [filterOpen])

  useEffect(() => {
    if (props.filterTick === lastFilterTick.current) return
    lastFilterTick.current = props.filterTick
    setFilterOpen(true)
    setTimeout(() => {
      const el = filterInput.current
      el?.focus()
      el?.setSelectionRange(el.value.length, el.value.length)
    }, 0)
  }, [props.filterTick])

  /** Ctrl+L, or a double-click on the breadcrumbs, edits the path where it is displayed. */
  const startAddrEdit = (path?: string): void => {
    setAddrEdit(path ?? props.pane.tabs[props.pane.ti])
    setTimeout(() => {
      addrInput.current?.focus()
      addrInput.current?.select()
    }, 0)
  }

  // Ctrl+L: the breadcrumbs turn into an address field in place, not a bar over the panes
  useEffect(() => {
    if (props.addrTick === lastAddrTick.current) return
    lastAddrTick.current = props.addrTick
    startAddrEdit()
  }, [props.addrTick])

  // clicking anywhere outside the field closes it; blur alone is unreliable (the window may lose focus)
  useEffect(() => {
    if (addrEdit === null) return
    const onDown = (ev: MouseEvent) => {
      const el = ev.target as HTMLElement | null
      if (el?.closest('.addr-edit')) return
      setAddrEdit(null)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setAddrEdit(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [addrEdit])

  /** `~` is the only shorthand; everything else goes to the loader as typed. */
  const commitAddr = (): void => {
    const raw = (addrEdit ?? '').trim()
    setAddrEdit(null)
    if (!raw) return
    const path = raw === '~' ? props.home : raw.startsWith('~/') ? props.home + raw.slice(1) : raw
    if (path) props.onNav(path)
  }

  /** Drag on empty space to select everything the rectangle touches. */
  const startMarquee = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return
    const target = ev.target as HTMLElement
    if (target.closest('.row,.tile')) return
    const el = listRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    marquee.current = {
      x: ev.clientX,
      y: ev.clientY,
      base: new Set(ev.ctrlKey ? pane.sel : [])
    }
    const move = (e: PointerEvent) => {
      const start = marquee.current
      if (!start) return
      const left = Math.min(start.x, e.clientX)
      const top = Math.min(start.y, e.clientY)
      const width = Math.abs(e.clientX - start.x)
      const height = Math.abs(e.clientY - start.y)
      setBand({
        left: left - rect.left + el.scrollLeft,
        top: top - rect.top + el.scrollTop,
        width,
        height
      })
      if (width < 4 && height < 4) return
      const hits: string[] = []
      for (const node of el.querySelectorAll<HTMLElement>('.row,.tile')) {
        const r = node.getBoundingClientRect()
        if (r.left < left + width && left < r.right && r.top < top + height && top < r.bottom) {
          const p = node.dataset['path']
          if (p) hits.push(p)
        }
      }
      props.onSel([...new Set([...start.base, ...hits])], 'set')
    }
    const up = () => {
      marquee.current = null
      setBand(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const attachList = useCallback((el: HTMLDivElement | null) => {
    listRef.current = el
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const source = pane.virtual && pane.results ? pane.results : (pane.listing?.entries ?? [])
  const pinSet = useMemo(() => new Set(pane.listing?.pins ?? []), [pane.listing?.pins])
  const labelMap = pane.listing?.labels ?? {}
  const ratingMap = pane.listing?.ratings ?? {}
  const labelColor = (name: string) =>
    props.palette.find((l) => l.id === labelMap[name])?.color ?? ''

  const ordered = useMemo(
    () =>
      orderEntries(
        source,
        sort.key,
        sort.asc,
        pane.filter,
        props.foldersFirst,
        pinSet,
        labelMap,
        ratingMap
      ),
    [source, pane.filter, sort, props.foldersFirst]
  )
  const groupBy = props.groupBy
  const groups = useMemo(() => groupEntries(ordered, groupBy), [ordered, groupBy])
  // the visual order is group by group: click indexes, navigation and grouping all share it
  const entries = useMemo(() => groups.flatMap((g) => g.entries), [groups])

  const cur = pane.tabs[pane.ti]
  // a single tab needs no strip; the + then lives in the path row so a new tab is still one click away
  const showTabs = props.forceTabStrip || pane.tabs.length > 1 || !props.hideSingleTab
  const TILE = tileGeo(props.tileSize, props.nameLines, props.gridMeta.length)
  const TILE_W = TILE.w
  const TILE_H = TILE.h
  const cols = Math.max(1, Math.floor(box.w / TILE_W))
  const rows = view === 'list' ? Math.max(1, Math.floor(box.h / ROW)) : Math.max(1, Math.floor(box.h / TILE_H))

  // the app needs these to step by a page or by one grid row
  useEffect(() => {
    props.onMetrics?.({ cols, rows })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, rows])

  // windowing: blocks (groups) are laid out first, then only the rows/tiles on screen are mounted
  const HEADER_H = 26
  const blocks = useMemo(() => {
    let top = 0
    let startIdx = 0
    const header = groupBy === 'none' ? 0 : HEADER_H
    return groups.map((g) => {
      const rows = view === 'list' ? g.entries.length : Math.ceil(g.entries.length / cols)
      const h = header + rows * (view === 'list' ? ROW : TILE_H)
      const block = { ...g, startIdx, top, headerH: header, h }
      startIdx += g.entries.length
      top += h
      return block
    })
  }, [groups, groupBy, view, cols, TILE_H])
  const totalHeight = blocks.length ? blocks[blocks.length - 1].top + blocks[blocks.length - 1].h : 0
  /** blocks below and above the viewport (with a little overscan) are not touched */
  const visibleBlocks = blocks.filter(
    (b) => b.top + b.h > scrollTop - ROW * 2 && b.top < scrollTop + box.h + ROW * 2
  )

  // keyboard navigation asks for the focused row to be visible; the windowing above only mounts
  // what is on screen, so this has to work from the index rather than scrollIntoView
  useEffect(() => {
    const el = listRef.current
    const t = props.reveal
    if (!el || !t) return
    const idx = entries.findIndex((e) => e.path === t.path)
    if (idx < 0) return
    const block = blocks.find((b) => idx >= b.startIdx && idx < b.startIdx + b.entries.length)
    if (!block) return
    const local = idx - block.startIdx
    const top =
      block.top + block.headerH + (view === 'list' ? local * ROW : Math.floor(local / cols) * TILE_H)
    const h = view === 'list' ? ROW : TILE_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + h > el.scrollTop + el.clientHeight) el.scrollTop = top + h - el.clientHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reveal?.tick])

  const click = (idx: number, ev: React.MouseEvent) => {
    const path = entries[idx].path
    // clicking a row hands the keyboard back to the list; otherwise arrows keep editing the filter
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur()
    // toggle is resolved against the newest selection in App, so fast ctrl-clicks accumulate
    if (ev.ctrlKey || ev.metaKey) {
      props.onSel([path], 'toggle')
      anchor.current = idx
    } else if (ev.shiftKey) {
      const a = Math.min(anchor.current, idx)
      const b = Math.max(anchor.current, idx)
      props.onSel(entries.slice(a, b + 1).map((e) => e.path), 'set')
    } else {
      props.onSel([path], 'set')
      anchor.current = idx
    }
  }

  if (pane.preview) {
    return (
      <section
        className={'pane previewing' + (active ? ' active' : '')}
        onMouseDown={props.onActivate}
      >
        <PreviewPanel
          fill
          entry={pane.preview.entry}
          imageIndex={props.previewIndex ?? null}
          onNavImage={props.onPreviewNav}
          onGallery={props.onGallery}
          onOpen={props.onOpen}
          onClose={() => props.onPreviewClose?.()}
        />
      </section>
    )
  }

  const cell = (id: ColId, e: Entry): string => {
    switch (id) {
      case 'type':
        return e.group ? groupLabel(e) : typeLabel(e)
      case 'size':
        return props.sizes[e.path] ?? fmtSize(e.size, e.dir, props.sizeFormat)
      case 'date':
        return fmtDate(e.mtime, props.dateFormat, props.showSeconds)
      case 'mode':
        return e.mode != null ? modeString(e.mode) : ''
      case 'owner':
        return e.uid != null ? `${fa(e.uid)}:${fa(e.gid ?? 0)}` : ''
      case 'links':
        return e.nlink != null ? fa(e.nlink) : ''
      case 'dims':
        return e.w && e.h ? `${fa(e.w)}×${fa(e.h)}` : ''
      case 'rating': {
        const n = ratingMap[e.name] ?? 0
        return n ? '★'.repeat(n) : ''
      }
    }
  }

  const COL_META: Record<ColId, { label: string; width: number; sort?: SortKey; end?: boolean }> = {
    type: { label: t('نوع'), width: 88, sort: 'ext' },
    size: { label: t('اندازه'), width: 94, sort: 'size', end: true },
    date: { label: t('تاریخ'), width: 120, sort: 'mtime' },
    mode: { label: t('مجوز'), width: 92, sort: 'mode' },
    owner: { label: t('مالک'), width: 72, sort: 'owner', end: true },
    links: { label: t('لینک'), width: 52, sort: 'links', end: true },
    dims: { label: t('ابعاد'), width: 90, sort: 'dims', end: true },
    rating: { label: t('امتیاز'), width: 74, sort: 'rating', end: true }
  }

  const widthOf = (c: ColId) => props.colWidths[c] ?? COL_META[c].width
  const gridTemplate =
    'minmax(0, 1fr) ' + props.columns.map((c) => `${widthOf(c)}px`).join(' ')

  // with many columns a narrow pane has to scroll sideways instead of clipping them
  const minWidth = 200 + props.columns.reduce((n, c) => n + widthOf(c) + 8, 0)

  /** Drag the edge of a header cell; pointer maths flips in RTL so the edge follows the cursor. */
  const startResize = (ev: React.PointerEvent, id: ColId) => {
    ev.preventDefault()
    ev.stopPropagation()
    const startX = ev.clientX
    const startWidth = widthOf(id)
    const dir = document.documentElement.dir === 'rtl' ? -1 : 1
    const move = (e: PointerEvent) => {
      const next = Math.round(Math.min(420, Math.max(48, startWidth + (e.clientX - startX) * dir)))
      props.onColumnWidth(id, next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const sortMark = (k: SortKey) => (sort.key === k ? (sort.asc ? ' ▲' : ' ▼') : '')

  // rows carry their own paths (not text) so a drag between panes stays typed
  const dragPaths = (path: string) => (pane.sel.includes(path) ? pane.sel : [path])

  const startDrag = (ev: React.DragEvent, path: string, _dir = false) => {
    const paths = dragPaths(path)
    if (!paths.length) return
    keepDragPaths(paths)
    dragLog(`start ${path} all='${paths.join(',')}'`)
    ev.dataTransfer.setData('application/x-mfm', JSON.stringify(paths))
    ev.dataTransfer.setData('text/uri-list', paths.map(fileUri).join('\r\n'))
    ev.dataTransfer.setData('text/plain', paths.join('\n'))
    ev.dataTransfer.effectAllowed = 'all'
    api.dragOut(paths)
  }

  const allowDrop = (ev: React.DragEvent) => {
    const dtTypes = ev.dataTransfer.types
    if (dtTypes.includes('application/x-mfm') || dtTypes.includes('Files')) {
      ev.preventDefault()
      ev.dataTransfer.dropEffect = ev.ctrlKey ? 'copy' : 'move'
    }
  }

  const dropOn = (ev: React.DragEvent, dest: string) => {
    ev.preventDefault()
    ev.stopPropagation()
    const raw = ev.dataTransfer.getData('application/x-mfm')
    if (raw) {
      try {
        props.onDropInternal(JSON.parse(raw) as string[], dest, ev.ctrlKey)
      } catch {
        // a foreign payload is not ours to act on
      }
      return
    }
    const files = [...ev.dataTransfer.files]
    if (files.length) props.onDropFiles(files, dest, ev.ctrlKey)
  }

  const menu = (ev: React.MouseEvent, path: string | null) => {
    ev.preventDefault()
    ev.stopPropagation()
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur()
    // A right-click selects what it points at, like Dolphin: the menu and every action in it must
    // act on the clicked row, not on whatever happened to be selected before. Right-clicking a row
    // that is already part of a multi-selection keeps the selection.
    if (path === null) {
      if (pane.sel.length) props.onSel([], 'set')
    } else if (!pane.sel.includes(path)) {
      const idx = entries.findIndex((e) => e.path === path)
      props.onSel([path], 'set')
      if (idx >= 0) anchor.current = idx
    }
    props.onContext(path, ev.clientX, ev.clientY)
  }

  const runSearch = () => {
    if (!query && !content) return
    props.onSearch({ query, content, regex })
  }

  return (
    <section
      className={'pane' + (active ? ' active' : '')}
      style={props.style}
      onMouseDown={props.onActivate}
    >
      {showTabs && (
      <div className="tabs">
        {pane.tabs.map((tabPath, i) => {
          const tabId = pane.tabIds?.[i] ?? ('t_' + i)
          const pinned = i < pane.pinCount
          const locked = pane.tabLocks[tabId] === true
          const title = pane.tabNames[tabPath] || tabPath.split(/[\\/]/).filter(Boolean).pop() || tabPath
          const tabColor = props.tabColors[tabPath]
          return (
            <div
              key={tabId}
              className={'tab' + (i === pane.ti ? ' on' : '') + (pinned ? ' pinned' : '')}
              style={
                tabColor && i === pane.ti
                  ? { background: `color-mix(in srgb, ${tabColor} 18%, var(--panel))` }
                  : undefined
              }
              draggable
              onDragStart={(ev) => {
                ev.dataTransfer.setData('application/x-mfm-tab', String(i))
                ev.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(ev) => {
                if (ev.dataTransfer.types.includes('application/x-mfm-tab')) ev.preventDefault()
              }}
              onDrop={(ev) => {
                const raw = ev.dataTransfer.getData('application/x-mfm-tab')
                if (!raw) return
                ev.preventDefault()
                ev.stopPropagation()
                props.onTabMove(Number(raw), i)
              }}
              onClick={() => props.onTabPick(i)}
              onAuxClick={(ev) => {
                if (ev.button === 1 && props.middleClickClosesTab && !locked) {
                  ev.preventDefault()
                  props.onTabClose(i)
                }
              }}
              onContextMenu={(ev) => {
                ev.preventDefault()
                ev.stopPropagation()
                props.onTabMenu(i, ev.clientX, ev.clientY)
              }}
              title={tabPath}
            >
              {pinned && <PinIcon filled />}
              {locked && <LockIcon size={11} />}
              {props.showTabIcons && (
                <EntryIcon
                  size={14}
                  iconSet={props.iconSet}
                  entry={{
                    name: tabPath.split(/[\\/]/).filter(Boolean).pop() || tabPath,
                    path: tabPath,
                    dir: true,
                    size: 0,
                    mtime: 0,
                    ext: '',
                    color: props.tabIcons[tabPath]?.color,
                    icon: props.tabIcons[tabPath]?.icon
                  }}
                />
              )}
              {tabColor && <span className="tab-dot" style={{ background: tabColor }} />}
              <span dir="auto">{title}</span>
              {!pinned && !locked && pane.tabs.length > 1 && (
                <button
                  className="x"
                  title={t(t('بستن تب'))}
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onTabClose(i)
                  }}
                >
                  <XIcon size={11} />
                </button>
              )}
            </div>
          )
        })}
        <button className="tb" title={t(t('تب نو (Ctrl+T)'))} onClick={props.onTabNew}>
          <PlusIcon size={13} />
        </button>
      </div>
      )}

      <div
        className="path"
        onClick={(ev) => {
          if (ev.detail > 1) return
          const el = ev.target as HTMLElement
          // nav buttons, the breadcrumbs and the field keep their own click behaviour
          if (el instanceof HTMLInputElement || el.closest('.crumb, .vchip, button')) return
          startAddrEdit()
        }}
        onDoubleClick={(ev) => {
          const el = ev.target as HTMLElement
          // nav/action buttons and the field itself keep their own double-click behaviour
          if (el instanceof HTMLInputElement || el.closest('button:not(.crumb)')) return
          ev.preventDefault()
          // the first click already navigated; edit the crumb under the pointer, not a stale path
          startAddrEdit((el.closest('.crumb') as HTMLElement | null)?.dataset.path)
        }}
      >
        <button className="tb" title={t(t('بازگشت (Alt+←)'))} onClick={props.onBack}>
          <ChevronRightIcon />
        </button>
        <button className="tb" title={t(t('جلو (Alt+→)'))} onClick={props.onForward}>
          <ChevronLeftIcon />
        </button>
        <button className="tb" title={t(t('بالا (Backspace)'))} onClick={props.onUp}>
          <ArrowUpIcon />
        </button>
        <button className="tb" title={t(t('نوسازی (Ctrl+R)'))} onClick={props.onRefresh}>
          <RefreshIcon />
        </button>
        {addrEdit === null ? (
          <div className="crumbs">
            {crumbs(cur).map((c) => (
              <span key={c.path} className="crumb-wrap">
                <button
                  className="crumb"
                  dir="auto"
                  data-path={c.path}
                  title={c.path}
                  onClick={(ev) => {
                    // the second click of a double-click opens the editor instead of navigating again
                    if (ev.detail > 1) return
                    // clicking the folder we are already in edits the path; a parent crumb navigates
                    if (c.path === cur) {
                      startAddrEdit(c.path)
                      return
                    }
                    props.onNav(c.path)
                  }}
                >
                  {c.name}
                </button>
                <ChevronLeftIcon size={11} />
              </span>
            ))}
          </div>
        ) : (
          <div className="addr-edit">
            <input
              ref={addrInput}
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              aria-label={t('مسیر')}
              title={t('مسیر را بنویس و Enter بزن · Esc انصراف')}
              placeholder="/path/to/folder"
              value={addrEdit}
              onChange={(e) => setAddrEdit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setAddrEdit(null)
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitAddr()
                }
              }}
            />
          </div>
        )}
        {pane.virtual && (
          <span className="vchip">
            {pane.virtual.label}
            <button className="x" title={t(t('بازگشت به پوشه'))} onClick={props.onExitVirtual}>
              <XIcon size={11} />
            </button>
          </span>
        )}
        <span className="spacer" />
        {!showTabs && (
          <button className="tb" title={t(t('تب نو (Ctrl+T)'))} onClick={props.onTabNew}>
            <PlusIcon size={13} />
          </button>
        )}
        <button
          className="tb"
          title={t(t('مرتب‌سازی و گروه‌بندی'))}
          aria-haspopup="menu"
          onClick={(ev) => {
            const r = (ev.currentTarget as HTMLElement).getBoundingClientRect()
            props.onSortMenu(Math.round(r.right), Math.round(r.bottom + 4))
          }}
        >
          <SortIcon />
        </button>
        <button
          className={'tb' + (pane.filter || filterOpen ? ' on' : '')}
          title={t(t('فیلتر نام (Ctrl+F)'))}
          aria-pressed={!!pane.filter || filterOpen}
          onClick={() => {
            setFilterOpen((open) => {
              if (!open) setTimeout(() => filterInput.current?.focus(), 0)
              return !open
            })
          }}
        >
          <FilterIcon />
        </button>
        <button
          className={'tb' + (searchOpen ? ' on' : '')}
          title={t(t('جست‌وجو (Ctrl+Shift+S)'))}
          onClick={() => setSearchOpen((o) => !o)}
        >
          <SearchIcon />
        </button>
        <button
          className={'tb' + (props.marked ? ' on' : '')}
          title={t(t('نشان‌کردن این پوشه (Ctrl+D)'))}
          onClick={props.onBookmark}
        >
          <StarIcon filled={props.marked} />
        </button>
        <button
          className="tb tb-caret"
          title={t(t('نشان‌ها'))}
          aria-haspopup="menu"
          onClick={(ev) => {
            const r = (ev.currentTarget as HTMLElement).getBoundingClientRect()
            props.onBookmarksMenu(Math.round(r.right), Math.round(r.bottom + 4))
          }}
        >
          <ChevronDownIcon size={11} />
        </button>
      </div>

      {(filterOpen || pane.filter.length > 0) && (
        <div className="filter-float">
          <label className="filter">
            <FilterIcon />
            <input
              ref={(el) => {
                filterInput.current = el
                props.filterRef(el)
              }}
              dir="auto"
              placeholder={t(t('فیلتر نام'))}
              value={pane.filter}
              onChange={(e) => props.onFilter(e.target.value)}
              onBlur={() => {
                if (!pane.filter) setFilterOpen(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  props.onFilter('')
                  setFilterOpen(false)
                  e.currentTarget.blur()
                }
                if (e.key === 'Enter' && entries[0]) props.onOpen(entries[0].path)
              }}
            />
            {pane.filter && (
              <button
                type="button"
                className="x"
                title={t(t('پاک کردن فیلتر'))}
                onClick={() => {
                  props.onFilter('')
                  filterInput.current?.focus()
                }}
              >
                <XIcon size={11} />
              </button>
            )}
          </label>
        </div>
      )}

      {searchOpen && (
        <div className="searchbar">
          <label className="filter grow">
            <SearchIcon />
            <input
              dir="auto"
              placeholder={t(t('نام (* و ? مجاز)'))}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            />
          </label>
          <label className="filter grow">
            <input
              dir="auto"
              placeholder={t(t('داخل محتوا (متن)'))}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
            />
          </label>
          <label className="check" title={t(t('الگوی نام را عبارت باقاعده بگیر'))}>
            <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
            regex
          </label>
          <button className="btn" onClick={runSearch}>{t('جست‌وجو')}</button>
        </div>
      )}

      {view === 'list' && (
        <div className="headwrap" ref={headRef}>
        <div
          className="head"
          style={{ gridTemplateColumns: gridTemplate, minWidth }}
          onContextMenu={(ev) => {
            ev.preventDefault()
            props.onHeaderMenu(ev.clientX, ev.clientY)
          }}
        >
          <button className="col" onClick={() => props.onSort('name')}>
            {t('نام')}{sortMark('name')}
          </button>
          {props.columns.map((c) => {
            const meta = COL_META[c]
            return (
              <button
                key={c}
                className={'col' + (meta.end ? ' num' : '')}
                onClick={() => meta.sort && props.onSort(meta.sort)}
              >
                {meta.label}
                {meta.sort ? sortMark(meta.sort) : ''}
                <span
                  className="col-resize"
                  role="separator"
                  aria-orientation="vertical"
                  title={t('تغییر عرض ستون')}
                  onPointerDown={(ev) => startResize(ev, c)}
                  onClick={(ev) => ev.stopPropagation()}
                />
              </button>
            )
          })}
        </div>
        </div>
      )}

      <div
        className="rows"
        ref={attachList}
        onPointerDown={startMarquee}
        onWheel={(ev) => {
          if (view !== 'grid' || !ev.ctrlKey) return
          ev.preventDefault()
          props.onZoom(ev.deltaY < 0 ? 8 : -8)
        }}
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop)
          if (headRef.current) headRef.current.scrollLeft = e.currentTarget.scrollLeft
        }}
        onDragOver={allowDrop}
        onDrop={(e) => dropOn(e, cur)}
        onContextMenu={(e) => menu(e, null)}
      >
        {band && (
          <div
            className="marquee"
            style={{ left: band.left, top: band.top, width: band.width, height: band.height }}
            aria-hidden="true"
          />
        )}
        {pane.error ? (
          <div className="error">{pane.error}</div>
        ) : entries.length === 0 ? (
          <div className="empty">
            {pane.loading
              ? t('در حال خواندن…')
              : pane.virtual
                ? t('چیزی پیدا نشد')
                : pane.filter
                  ? t('چیزی با این نام نیست')
                  : t('پوشه خالی است')}
          </div>
        ) : view === 'list' ? (
          <div style={{ height: totalHeight, position: 'relative', minWidth }}>
            {visibleBlocks.map((b) => {
              const headerVisible = b.headerH > 0 && b.top + b.headerH > scrollTop && b.top < scrollTop + box.h
              const rowsFrom = Math.max(0, Math.floor((scrollTop - (b.top + b.headerH)) / ROW))
              const rowsTo = Math.min(
                b.entries.length,
                Math.ceil((scrollTop + box.h - (b.top + b.headerH)) / ROW)
              )
              return (
                <Fragment key={b.key || 'all'}>
                  {headerVisible && (
                    <div className="grp-head" style={{ top: b.top, height: b.headerH }}>
                      <span dir="auto">{b.label}</span>
                      <span className="grp-count">{fa(b.entries.length)}</span>
                    </div>
                  )}
                  {rowsTo > rowsFrom &&
                    b.entries.slice(rowsFrom, rowsTo).map((e, k) => {
                      const idx = b.startIdx + rowsFrom + k
                      return (
                        <div
                          key={e.path}
                          data-path={e.path}
                          className={
                            'row' +
                            (pane.sel.includes(e.path) ? ' on' : '') +
                            (pinSet.has(e.name) ? ' pinned' : '') +
                            (e.hidden ? ' meta-hidden' : '')
                          }
                          style={{
                            top: b.top + b.headerH + (rowsFrom + k) * ROW,
                            gridTemplateColumns: gridTemplate
                          }}
                          title={e.path}
                          draggable
                          onDragStart={(ev) => startDrag(ev, e.path, e.dir)}
                          onDragOver={allowDrop}
                          onDrop={(ev) => dropOn(ev, e.dir ? e.path : cur)}
                          onContextMenu={(ev) => menu(ev, e.path)}
                          onClick={(ev) => click(idx, ev)}
                          onDoubleClick={() => props.onOpen(e.path)}
                        >
                          <span className="name">
                            {!e.dir && props.typeColors[(e.ext || '').toLowerCase()] && (
                              <span
                                className="ftdot"
                                style={{ background: props.typeColors[(e.ext || '').toLowerCase()] }}
                                title={`${t('نوع')} ${e.ext}`}
                              />
                            )}
                            {labelColor(e.name) && (
                              <span className="lbl" style={{ background: labelColor(e.name) }} title={t(t('برچسب'))} />
                            )}
                            {!e.dir && e.color && (
                              <span className="file-color" style={{ background: e.color }} title={t('رنگ')} />
                            )}
                            {pinSet.has(e.name) && (
                              <span className="pinmark" title={t(t('سنجاق‌شده'))}>
                                <PinIcon filled />
                              </span>
                            )}
                            {e.hidden && (
                              <span className="hidmark" title={t('پنهان از فهرست')}>
                                <EyeOffIcon />
                              </span>
                            )}
                            <EntryIcon entry={e} iconSet={props.iconSet} />
                            <span dir="auto" className="trunc">{e.name}</span>
                            {props.showSymlink && e.link && (
                              <span className="symmark" title={t('پیوند نمادین')}>
                                <LinkIcon />
                              </span>
                            )}
                          </span>
                          {props.columns.map((c) => (
                            <span key={c} className={COL_META[c].sort === 'mtime' || !COL_META[c].sort ? 'dim' : 'kind'}>
                              {cell(c, e)}
                            </span>
                          ))}
                        </div>
                      )
                    })}
                </Fragment>
              )
            })}
          </div>
        ) : (
          <div style={{ height: totalHeight, position: 'relative' }}>
            {visibleBlocks.map((b) => {
              const headerVisible = b.headerH > 0 && b.top + b.headerH > scrollTop && b.top < scrollTop + box.h
              const rowFrom = Math.max(0, Math.floor((scrollTop - (b.top + b.headerH)) / TILE_H))
              const rowTo = Math.min(
                Math.ceil(b.entries.length / cols),
                Math.ceil((scrollTop + box.h - (b.top + b.headerH)) / TILE_H)
              )
              return (
                <Fragment key={b.key || 'all'}>
                  {headerVisible && (
                    <div className="grp-head" style={{ top: b.top, height: b.headerH }}>
                      <span dir="auto">{b.label}</span>
                      <span className="grp-count">{fa(b.entries.length)}</span>
                    </div>
                  )}
                  {rowTo > rowFrom &&
                    b.entries.slice(rowFrom * cols, rowTo * cols).map((e, k) => {
                      const local = rowFrom * cols + k
                      const idx = b.startIdx + local
                      const r = Math.floor(local / cols)
                      const c = local % cols
                      const pic = !e.dir && isImage(e.ext) && e.size < 8_000_000
                      const metaParts = props.gridMeta.map((col) => cell(col, e)).filter(Boolean)
                      return (
                        <div
                          key={e.path}
                          data-path={e.path}
                          className={
                            'tile' + (pane.sel.includes(e.path) ? ' on' : '') + (e.hidden ? ' meta-hidden' : '')
                          }
                          style={{
                            top: b.top + b.headerH + r * TILE_H,
                            insetInlineStart: c * TILE_W,
                            width: TILE_W - 6,
                            height: TILE_H - 6
                          }}
                          draggable
                          onDragStart={(ev) => startDrag(ev, e.path, e.dir)}
                          onDragOver={allowDrop}
                          onDrop={(ev) => dropOn(ev, e.dir ? e.path : cur)}
                          onContextMenu={(ev) => menu(ev, e.path)}
                          onClick={(ev) => click(idx, ev)}
                          onDoubleClick={() => props.onOpen(e.path)}
                          title={e.path}
                        >
                          <span
                            className={'thumb' + (pic ? ' pic' : ' flat')}
                            style={{ width: TILE.thumb, height: TILE.thumb }}
                          >
                            {pic ? (
                              <img
                                src={isImageName(e.name) ? thumbUrl(e.path, 256, `${Math.round(e.mtime)}-${e.size}`) : mediaUrl(e.path)}
                                alt=""
                                loading="lazy"
                                draggable={false}
                              />
                            ) : (
                              <EntryIcon entry={e} size={TILE.glyph} iconSet={props.iconSet} />
                            )}
                            {labelColor(e.name) && (
                              <span
                                className="lbl tile-lbl"
                                style={{ background: labelColor(e.name) }}
                                title={t(t('برچسب'))}
                              />
                            )}
                          </span>
                          <span className="tile-name-row">
                            {!e.dir && e.color && (
                              <span className="file-color" style={{ background: e.color }} title={t('رنگ')} />
                            )}
                            <span
                              className="tile-name"
                              dir="auto"
                              style={{ WebkitLineClamp: props.nameLines, fontSize: TILE.font }}
                            >{e.name}</span>
                            {props.showSymlink && e.link && (
                              <span className="symmark tile-link" title={t('پیوند نمادین')}>
                                <LinkIcon />
                              </span>
                            )}
                          </span>
                          {metaParts.length > 0 && (
                            <span className="tile-meta" dir="auto">
                              {metaParts.map((part, mi) => (
                                <span className="tile-meta-line" key={mi}>
                                  {part}
                                </span>
                              ))}
                            </span>
                          )}
                        </div>
                      )
                    })}
                </Fragment>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}
