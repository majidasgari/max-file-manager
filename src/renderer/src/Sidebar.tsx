import { t } from './i18n.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type DirRef, type Drive } from './api'
import { baseName, fa } from './format'
import { clearDragPaths, keepDragPaths, lastDragPaths } from './drag'
import { dragLog } from './draglog'
import { ChevronDownIcon, ChevronLeftIcon, DriveIcon, EjectIcon, EntryIcon, FolderIcon, HomeIcon, PinIcon, StarIcon, UsbIcon, XIcon } from './Icons'

type LabelCount = { id: string; name: string; color: string; count: number }

/** `file://` URI → path, the shape external file managers put on the drag. */
const fileUrlToPath = (uri: string): string => {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'file:') return ''
    let p = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
    return p
  } catch {
    return ''
  }
}

/** Our own payload, or the `Files`/`uri-list` an external file manager sends. */
const pathsOf = (dt: DataTransfer): string[] => {
  const raw = dt.getData('application/x-mfm') || dt.getData('application/x-mfm-mark')
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        const list = parsed.filter((p): p is string => typeof p === 'string')
        if (list.length) return list
      }
    } catch {
      // fall through to the in-memory copy of our own drag
    }
  }
  // a Wayland drop can lose the custom data; the drag that started here is still known
  const internal = lastDragPaths()
  if (internal.length) return internal
  if (dt.files.length) {
    return [...dt.files].map((f) => api.pathForFile(f)).filter(Boolean)
  }
  const text = dt.getData('text/uri-list') || dt.getData('text/plain')
  if (text) {
    const list = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => (l.startsWith('file://') ? fileUrlToPath(l) : l))
      .filter(Boolean)
    if (list.length) return list
  }
  return []
}

type Props = {
  labels: LabelCount[]
  onPickLabel(id: string): void
  roots: DirRef[]
  marks: string[]
  /** custom bookmark titles (path → title); empty means «use the folder name» */
  markNames?: Record<string, string>
  onRenameMark?(path: string, title: string | null): void
  /** folders expanded under Places, remembered by the app across restarts */
  treeExpanded?: string[]
  onTreeToggle?(path: string, open: boolean): void
  /** the app asks the row to open its inline editor (context-menu «Rename») */
  renameRequest?: { path: string; tick: number } | null
  onMarkMenu?(path: string, x: number, y: number): void
  /** each bookmark's own folder colour/icon, resolved once by the app */
  markIcons: Record<string, { color?: string; icon?: string }>
  iconSet?: Record<string, string>
  activePath: string
  onNav(dir: string): void
  onUnmark(dir: string): void
  /** folders dropped on the sidebar become bookmarks */
  onMarkDrop(paths: string[]): void
  /** marked-hidden folders follow the pane's hidden-files switch */
  showHidden: boolean
  /** the sidebar is floating over the panes; the pin docks it again */
  floating: boolean
  onToggleFloat(): void
  drives?: Drive[]
  onMountDrive?(device: string): void
  onUnmountDrive?(deviceOrMount: string): void
  style?: React.CSSProperties
  onPointerDownHead?(ev: React.PointerEvent): void
  onDoubleClickHead?(): void
  collapsed?: string[]
  onToggleSection?(id: string): void
  onReorderMarks?(from: number, to: number, place: 'before' | 'after'): void
}

export function Sidebar({
  labels,
  onPickLabel,
  roots,
  marks,
  treeExpanded,
  onTreeToggle,
  markNames,
  onRenameMark,
  renameRequest,
  onMarkMenu,
  markIcons,
  iconSet,
  activePath,
  onNav,
  onUnmark,
  onMarkDrop,
  showHidden,
  floating,
  onToggleFloat,
  drives,
  onMountDrive,
  onUnmountDrive,
  style,
  onPointerDownHead,
  onDoubleClickHead,
  collapsed,
  onToggleSection,
  onReorderMarks
}: Props) {
  const [dragMarkIdx, setDragMarkIdx] = useState<number | null>(null)
  /** path of the bookmark whose title is being edited inline */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const renameInput = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (renameRequest?.path) {
      setRenaming(renameRequest.path)
      setRenameDraft(markNames?.[renameRequest.path] ?? '')
    }
    // only a new request (tick) re-opens the editor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameRequest?.tick])
  useEffect(() => {
    if (renaming) renameInput.current?.select()
  }, [renaming])
  const commitRename = (path: string, value: string) => {
    const name = value.trim()
    onRenameMark?.(path, name ? name : null)
    setRenaming(null)
  }
  const [dropMarkTarget, setDropMarkTarget] = useState<{ idx: number; place: 'before' | 'after' } | null>(null)
  /** Expanded tree nodes in «Places», and the sub-folders already read for them (lazy). */
  const [treeOpenLocal, setTreeOpenLocal] = useState<Set<string>>(() => new Set())
  // the app owns the expanded set when it passes one: it survives a restart
  const treeOpen = useMemo(
    () => (treeExpanded ? new Set(treeExpanded) : treeOpenLocal),
    [treeExpanded, treeOpenLocal]
  )
  const [treeKids, setTreeKids] = useState<Record<string, DirRef[]>>({})
  const treeLoading = useRef<Set<string>>(new Set())
  const [localCollapsed, setLocalCollapsed] = useState<Set<string>>(() => new Set())
  const isCollapsed = (id: string) =>
    collapsed ? collapsed.includes(id) : localCollapsed.has(id)
  const toggleSection = (id: string) => {
    if (onToggleSection) {
      onToggleSection(id)
    } else {
      setLocalCollapsed((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }
  }
  const [over, setOver] = useState(false)
  const ref = useRef<HTMLElement>(null)
  const lastOver = useRef<{ x: number; y: number; at: number } | null>(null)
  const dragCounter = useRef(0)
  const dropped = useRef(false)
  const markDrop = useRef(onMarkDrop)
  useEffect(() => {
    markDrop.current = onMarkDrop
  }, [onMarkDrop])
  /** Enter and over both count: a drop must work even if the pointer stops moving. */
  const acceptDrag = (ev: React.DragEvent) => {
    const types = ev.dataTransfer.types
    if (types.includes('application/x-mfm-bookmark')) return
    const ours = types.includes('application/x-mfm') || types.includes('application/x-mfm-mark')
    const outside = types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain')
    if (!ours && !outside && !lastDragPaths().length) return
    ev.preventDefault()
    ev.dataTransfer.dropEffect = 'copy'
    lastOver.current = { x: ev.clientX, y: ev.clientY, at: performance.now() }
    setOver(true)
    dragLog(
      `over ${ev.type} at ${ev.clientX},${ev.clientY} types=${[...ev.dataTransfer.types].join('|')}`
    )
  }

  const handleDragEnter = (ev: React.DragEvent) => {
    dragCounter.current++
    acceptDrag(ev)
  }

  const handleDragLeave = (ev: React.DragEvent) => {
    dragCounter.current--
    if (dragCounter.current <= 0) {
      dragCounter.current = 0
      setOver(false)
      dragLog(`leave exit counter=0 over=false`)
    }
  }

  const handleDrop = (ev: React.DragEvent) => {
    dropped.current = true
    dragCounter.current = 0
    setOver(false)
    lastOver.current = null
    ev.preventDefault()
    ev.stopPropagation()
    const paths = pathsOf(ev.dataTransfer)
    dragLog(
      `drop at ${ev.clientX},${ev.clientY} types=${[...ev.dataTransfer.types].join('|')} getData='${ev.dataTransfer
        .getData('application/x-mfm')}' internal='${lastDragPaths().join(',')}' files=${ev.dataTransfer.files.length} resolved='${paths.join(',')}'`
    )
    if (!paths.length) return
    onMarkDrop(paths)
  }

  // a refused drag (a file, or a drop outside) must not leave the sidebar highlighted
  useEffect(() => {
    const onDrop = () => {
      dropped.current = true
      dragCounter.current = 0
    }
    /**
     * Wayland can end the drag over the sidebar without ever sending `drop`. If the last
     * dragover was inside the sidebar and the drag was not cancelled, the release still means
     * «bookmark this folder» — so the in-memory paths are applied here.
     */
    const onEnd = (ev: DragEvent) => {
      const wasDropped = dropped.current
      const point = lastOver.current
      const paths = lastDragPaths()
      dropped.current = false
      lastOver.current = null
      dragCounter.current = 0
      setOver(false)
      clearDragPaths()
      dragLog(
        `dragend at ${ev.clientX},${ev.clientY} effect=${ev.dataTransfer?.dropEffect} wasDropped=${wasDropped} paths='${paths.join(',')}' point=${point ? `${point.x},${point.y} ${Math.round(performance.now() - point.at)}ms` : '-'}`
      )
      if (wasDropped || !paths.length || !point) return
      if (performance.now() - point.at > 15000) return
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      if (point.x < r.left || point.x > r.right || point.y < r.top || point.y > r.bottom) return
      markDrop.current(paths)
    }
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragend', onEnd)
    return () => {
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', onEnd)
    }
  }, [])

  /** Read a folder's sub-directories once; expanding again reuses the result. */
  const treeLoaded = useRef<Set<string>>(new Set())
  const loadTreeKids = (dir: string): void => {
    if (treeLoaded.current.has(dir) || treeLoading.current.has(dir)) return
    treeLoading.current.add(dir)
    void api
      .dirs(dir, showHidden)
      .then((list) => {
        treeLoaded.current.add(dir)
        setTreeKids((prev) => ({
          ...prev,
          [dir]: [...list].sort((a, b) => a.name.localeCompare(b.name))
        }))
      })
      .catch(() => {
        treeLoaded.current.add(dir)
        setTreeKids((prev) => ({ ...prev, [dir]: [] }))
      })
      .finally(() => treeLoading.current.delete(dir))
  }

  const toggleTree = (dir: string): void => {
    const willOpen = !treeOpen.has(dir)
    if (onTreeToggle) {
      onTreeToggle(dir, willOpen)
    } else {
      setTreeOpenLocal((prev) => {
        const next = new Set(prev)
        if (willOpen) next.add(dir)
        else next.delete(dir)
        return next
      })
    }
    if (willOpen) loadTreeKids(dir)
  }

  /** after a restart the saved nodes are expanded: read their children again */
  useEffect(() => {
    for (const dir of treeExpanded ?? []) loadTreeKids(dir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeExpanded?.join('\u0000')])

  // the hidden-files switch changes what a folder contains: drop the cache and re-read open nodes
  useEffect(() => {
    treeLoaded.current.clear()
    treeLoading.current.clear()
    setTreeKids({})
    for (const p of treeOpen) loadTreeKids(p)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden])

  /** One level of the Places tree; children render themselves so any depth works. */
  const renderTree = (parent: string, depth: number): React.ReactNode => {
    const list = treeKids[parent]
    if (!list) return null
    if (!list.length) {
      return (
        <div className="tree-empty" style={{ paddingInlineStart: 16 + depth * 12 }}>
          {t('پوشه‌ای نیست')}
        </div>
      )
    }
    return list.map((c) => {
      const isOpen = treeOpen.has(c.path)
      const known = treeKids[c.path]
      // once a folder is known to have no sub-folders, its arrow would only offer an empty panel
      const hasKids = known === undefined || known.length > 0
      return (
        <div key={c.path}>
          <div
            className={'tree-row' + (activePath === c.path ? ' on' : '')}
            style={{ paddingInlineStart: 4 + depth * 12 }}
          >
            {hasKids ? (
              <button
                type="button"
                className="twisty tree-twisty"
                title={isOpen ? t('جمع کردن') : t('باز کردن')}
                aria-label={isOpen ? t('جمع کردن') : t('باز کردن')}
                aria-expanded={isOpen}
                onClick={() => toggleTree(c.path)}
              >
                {isOpen ? <ChevronDownIcon size={11} /> : <ChevronLeftIcon size={11} />}
              </button>
            ) : (
              <span className="twisty" />
            )}
            <button className="tree-name" dir="auto" title={c.path} onClick={() => onNav(c.path)}>
              <FolderIcon size={14} />
              <span>{c.name}</span>
            </button>
          </div>
          {isOpen && renderTree(c.path, depth + 1)}
        </div>
      )
    })
  }

  return (
    <aside
      ref={ref}
      style={style}
      className={'side' + (over ? ' drop' : '')}
      onDragEnter={handleDragEnter}
      onDragOver={acceptDrag}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className="side-head"
        onPointerDown={onPointerDownHead}
        onDoubleClick={onDoubleClickHead}
      >
        <button
          type="button"
          className="side-section-toggle"
          onClick={() => toggleSection('places')}
          aria-expanded={!isCollapsed('places')}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="side-twisty">
            {!isCollapsed('places') ? <ChevronDownIcon size={11} /> : <ChevronLeftIcon size={11} />}
          </span>
          <span className="side-title">{t('مکان‌ها')}</span>
        </button>
        <button
          type="button"
          className={'side-pin' + (floating ? ' on' : '')}
          title={floating ? t('چسباندن سایدبار') : t('شناور کردن سایدبار')}
          aria-label={floating ? t('چسباندن سایدبار') : t('شناور کردن سایدبار')}
          aria-pressed={floating}
          onClick={onToggleFloat}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <PinIcon filled={floating} />
        </button>
      </div>
      {over && (
        <div className="side-drop-hint">
          <StarIcon size={12} />
          <span>{t('پوشه را رها کن تا نشان شود')}</span>
        </div>
      )}
      {!isCollapsed('places') &&
        roots.map((r) => {
          const active = activePath === r.path
          const Glyph = r.name === '~' ? HomeIcon : DriveIcon
          const label = r.name === '~' ? t('خانه') : r.name === '/' ? t('ریشه') : r.name
          return (
            <div key={r.path}>
              <div
                className={'tree-row' + (active ? ' on' : '')}
                draggable
                onDragStart={(ev) => {
                  keepDragPaths([r.path])
                  dragLog(`place start ${r.path}`)
                  ev.dataTransfer.setData('application/x-mfm-mark', JSON.stringify([r.path]))
                  ev.dataTransfer.effectAllowed = 'all'
                }}
                onDragOver={acceptDrag}
                onDrop={handleDrop}
              >
                <button
                  type="button"
                  className="twisty tree-twisty"
                  title={treeOpen.has(r.path) ? t('جمع کردن') : t('باز کردن')}
                  aria-label={treeOpen.has(r.path) ? t('جمع کردن') : t('باز کردن')}
                  aria-expanded={treeOpen.has(r.path)}
                  onClick={() => toggleTree(r.path)}
                >
                  {treeOpen.has(r.path) ? <ChevronDownIcon size={11} /> : <ChevronLeftIcon size={11} />}
                </button>
                <button className="tree-name" dir="auto" title={r.path} onClick={() => onNav(r.path)}>
                  <Glyph />
                  <span>{label}</span>
                </button>
              </div>
              {treeOpen.has(r.path) && renderTree(r.path, 1)}
            </div>
          )
        })}

      {(marks.length > 0 || over) && (
        <div className="side-section-head">
          <button
            type="button"
            className="side-section-toggle"
            onClick={() => toggleSection('bookmarks')}
            aria-expanded={!isCollapsed('bookmarks')}
          >
            <span className="side-twisty">
              {!isCollapsed('bookmarks') ? <ChevronDownIcon size={11} /> : <ChevronLeftIcon size={11} />}
            </span>
            <span className="side-title">{t('نشان‌شده‌ها')}</span>
            {marks.length > 0 && <span className="side-section-badge">{fa(marks.length)}</span>}
          </button>
        </div>
      )}
      {!isCollapsed('bookmarks') &&
        marks.map((m, idx) => {
          const isDragging = dragMarkIdx === idx
          const isTarget = dropMarkTarget?.idx === idx && dragMarkIdx !== idx
          const dropPlace = isTarget ? dropMarkTarget?.place : null
          const targetClass = dropPlace ? ` drop-${dropPlace}` : ''
          return (
            <div
              key={m}
              className={
                'tree-row mark' +
                (activePath === m ? ' on' : '') +
                (isDragging ? ' dragging' : '') +
                targetClass
              }
              draggable
              onDragStart={(ev) => {
                ev.dataTransfer.setData('application/x-mfm-bookmark', String(idx))
                ev.dataTransfer.setData('application/x-mfm', JSON.stringify([m]))
                ev.dataTransfer.setData('text/plain', m)
                ev.dataTransfer.effectAllowed = 'move'
                setDragMarkIdx(idx)
              }}
              onDragOver={(ev) => {
                if (ev.dataTransfer.types.includes('application/x-mfm-bookmark')) {
                  ev.preventDefault()
                  ev.stopPropagation()
                  ev.dataTransfer.dropEffect = 'move'
                  const rect = ev.currentTarget.getBoundingClientRect()
                  const place: 'before' | 'after' =
                    ev.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                  if (
                    !dropMarkTarget ||
                    dropMarkTarget.idx !== idx ||
                    dropMarkTarget.place !== place
                  ) {
                    setDropMarkTarget({ idx, place })
                  }
                }
              }}
              onDragLeave={(ev) => {
                if (
                  dropMarkTarget?.idx === idx &&
                  !ev.currentTarget.contains(ev.relatedTarget as Node | null)
                ) {
                  setDropMarkTarget(null)
                }
              }}
              onDrop={(ev) => {
                const raw = ev.dataTransfer.getData('application/x-mfm-bookmark')
                if (raw !== '') {
                  ev.preventDefault()
                  ev.stopPropagation()
                  const fromIdx = Number(raw)
                  const target = dropMarkTarget
                  setDragMarkIdx(null)
                  setDropMarkTarget(null)
                  if (!Number.isNaN(fromIdx) && onReorderMarks) {
                    const place = target?.place ?? (fromIdx < idx ? 'after' : 'before')
                    onReorderMarks(fromIdx, idx, place)
                  }
                }
              }}
              onDragEnd={() => {
                setDragMarkIdx(null)
                setDropMarkTarget(null)
              }}
              onContextMenu={(ev) => {
                if (!onMarkMenu) return
                ev.preventDefault()
                ev.stopPropagation()
                onMarkMenu(m, ev.clientX, ev.clientY)
              }}
            >
              <span className="twisty" />
              <button
                className="tree-name"
                dir="auto"
                title={(markNames?.[m] ? `${markNames[m]} — ${m}` : m) + ' · ' + t('دوبار کلیک: تغییر نام')}
                onClick={() => onNav(m)}
                onDoubleClick={(ev) => {
                  ev.preventDefault()
                  ev.stopPropagation()
                  setRenaming(m)
                  setRenameDraft(markNames?.[m] ?? '')
                }}
              >
                <EntryIcon
                  size={14}
                  iconSet={iconSet}
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
                {renaming === m ? (
                  <input
                    ref={renameInput}
                    className="mark-rename"
                    dir="auto"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitRename(m, renameDraft)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitRename(m, renameDraft)
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setRenaming(null)
                      }
                    }}
                  />
                ) : (
                  <span>{markNames?.[m] || baseName(m)}</span>
                )}
              </button>
              <button
                className="x"
                title={t('حذف نشان')}
                draggable={false}
                onPointerDown={(e) => e.stopPropagation()}
                onDragStart={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={() => onUnmark(m)}
              >
                <XIcon size={12} />
              </button>
            </div>
          )
        })}

      {labels.length > 0 && (
        <div className="side-section-head">
          <button
            type="button"
            className="side-section-toggle"
            onClick={() => toggleSection('labels')}
            aria-expanded={!isCollapsed('labels')}
          >
            <span className="side-twisty">
              {!isCollapsed('labels') ? <ChevronDownIcon size={11} /> : <ChevronLeftIcon size={11} />}
            </span>
            <span className="side-title">{t('برچسب‌ها')}</span>
            <span className="side-section-badge">{fa(labels.length)}</span>
          </button>
        </div>
      )}
      {!isCollapsed('labels') &&
        labels.map((l) => (
          <div key={l.id} className="tree-row">
            <span className="twisty" />
            <button className="tree-name" onClick={() => onPickLabel(l.id)} title={`${t('فیلتر')}: ${t(l.name)}`}>
              <span className="lbl" style={{ background: l.color }} />
              <span>{t(l.name)}</span>
              <span className="dim count">{fa(l.count)}</span>
            </button>
          </div>
        ))}

      {drives && drives.length > 0 && (
        <div className="side-section-head">
          <button
            type="button"
            className="side-section-toggle"
            onClick={() => toggleSection('drives')}
            aria-expanded={!isCollapsed('drives')}
          >
            <span className="side-twisty">
              {!isCollapsed('drives') ? <ChevronDownIcon size={11} /> : <ChevronLeftIcon size={11} />}
            </span>
            <span className="side-title">{t('حافظه‌های جانبی')}</span>
            <span className="side-section-badge">{fa(drives.length)}</span>
          </button>
        </div>
      )}
      {!isCollapsed('drives') && drives?.map((d) => {
        const isCur = Boolean(
          d.mountpoint && (activePath === d.mountpoint || activePath.startsWith(d.mountpoint + '/'))
        )
        return (
          <div
            key={d.device}
            className={'tree-row side-drive' + (isCur ? ' on' : '') + (!d.mounted ? ' unmounted' : '')}
          >
            <span className="twisty" />
            <button
              className="tree-name"
              dir="auto"
              title={
                d.mounted
                  ? `${d.name} (${d.mountpoint})`
                  : `${d.name} — ${t('برای اتصال کلیک کنید')}`
              }
              onClick={() => {
                if (d.mounted && d.mountpoint) {
                  onNav(d.mountpoint)
                } else if (onMountDrive) {
                  onMountDrive(d.device)
                }
              }}
            >
              <UsbIcon size={14} />
              <span className="side-drive-label">{d.name}</span>
              {!d.mounted && <span className="side-mount-tag">{t('اتصال')}</span>}
            </button>
            {d.mounted && onUnmountDrive && (
              <button
                type="button"
                className="side-eject-btn"
                title={t('جداسازی ایمن')}
                aria-label={t('جداسازی ایمن')}
                onClick={(e) => {
                  e.stopPropagation()
                  onUnmountDrive(d.device)
                }}
              >
                <EjectIcon size={12} />
              </button>
            )}
          </div>
        )
      })}
    </aside>
  )
}
