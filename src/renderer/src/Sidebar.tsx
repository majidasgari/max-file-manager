import { t } from './i18n.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type DirRef, type CloudBinding, type CloudView, type Drive, type RemoteProfile, type SyncJob } from './api'
import { bindingSubtitle, progressPercent } from './cloud-view'
import { baseName, fa, fmtSize } from './format'
import { clearDragPaths, dragOutPaths, keepDragPaths, lastDragPaths, pathsOf, releaseDragOut } from './drag'
import { dragLog } from './draglog'
import { ChevronDownIcon, ChevronLeftIcon, CloudIcon, DriveIcon, EjectIcon, EntryIcon, FolderIcon, HomeIcon, PinIcon, PlayIcon, PlusIcon, ServerIcon, StarIcon, SwapIcon, UsbIcon, XIcon } from './Icons'
import { profileUri } from '../../shared/remote-profile.ts'

type LabelCount = { id: string; name: string; color: string; count: number }

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
  /** saved FTP/FTPS/S3 connections; undefined hides the section entirely */
  remotes?: RemoteProfile[]
  onRemote?(profile: RemoteProfile): void
  onManageRemotes?(): void
  onMountDrive?(device: string): void
  onUnmountDrive?(deviceOrMount: string): void
  /** the dedicated drives/memory page is currently open */
  drivesPageActive?: boolean
  onOpenDrives?(): void
  style?: React.CSSProperties
  onPointerDownHead?(ev: React.PointerEvent): void
  onDoubleClickHead?(): void
  collapsed?: string[]
  onToggleSection?(id: string): void
  onReorderMarks?(from: number, to: number, place: 'before' | 'after'): void
  /** saved sync jobs; undefined/empty hides the section entirely */
  syncJobs?: SyncJob[]
  onSyncJob?(job: SyncJob): void
  /** cloud bindings; undefined hides the section */
  clouds?: CloudView
  onCloud?(binding: CloudBinding): void
  onManageClouds?(): void
  onCloudMenu?(binding: CloudBinding, x: number, y: number): void
  /** vertical tab strip, rendered above Places when the tabs live in the sidebar */
  tabsSlot?: React.ReactNode
  /** number of open tabs, shown as the section badge */
  tabsCount?: number
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
  remotes,
  onRemote,
  onManageRemotes,
  onMountDrive,
  onUnmountDrive,
  drivesPageActive,
  onOpenDrives,
  style,
  onPointerDownHead,
  onDoubleClickHead,
  collapsed,
  onToggleSection,
  onReorderMarks,
  syncJobs,
  onSyncJob,
  clouds,
  onCloud,
  onManageClouds,
  onCloudMenu,
  tabsSlot,
  tabsCount
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
    if (!ours && !outside && !lastDragPaths().length && !dragOutPaths().length) return
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
    releaseDragOut()
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
      {tabsSlot && (
        <>
          <div className="side-section-head">
            <button
              type="button"
              className="side-section-toggle"
              onClick={() => toggleSection('tabs')}
              aria-expanded={!isCollapsed('tabs')}
            >
              <span className="side-twisty">
                {!isCollapsed('tabs') ? <ChevronDownIcon size={11} /> : <ChevronLeftIcon size={11} />}
              </span>
              <span className="side-title">{t('تب‌ها')}</span>
              {typeof tabsCount === 'number' && tabsCount > 0 && (
                <span className="side-section-badge">{fa(tabsCount)}</span>
              )}
            </button>
          </div>
          {!isCollapsed('tabs') && tabsSlot}
        </>
      )}
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
      {!isCollapsed('places') && onOpenDrives && (
        <div className={'tree-row' + (drivesPageActive ? ' on' : '')}>
          <span className="twisty" />
          <button
            type="button"
            className="tree-name"
            title={t('درایوها و دیسک‌ها')}
            onClick={onOpenDrives}
          >
            <DriveIcon />
            <span>{t('این کامپیوتر')}</span>
          </button>
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

      {remotes && (
        <div className="side-section-head">
          <button
            type="button"
            className="side-section-toggle"
            onClick={() => toggleSection('remote')}
            aria-expanded={!isCollapsed('remote')}
          >
            <span className="side-twisty">
              {!isCollapsed('remote') ? <ChevronDownIcon size={11} /> : <ChevronLeftIcon size={11} />}
            </span>
            <span className="side-title" title={t('اتصال‌های دور')}>{t('دور')}</span>
            {remotes.length > 0 && <span className="side-section-badge">{fa(remotes.length)}</span>}
          </button>
          {onManageRemotes && (
            <button
              type="button"
              className="side-add"
              title={t('مدیریت اتصال‌های دور')}
              aria-label={t('مدیریت اتصال‌های دور')}
              onClick={onManageRemotes}
            >
              <PlusIcon size={12} />
            </button>
          )}
        </div>
      )}
      {remotes && !isCollapsed('remote') && remotes.length === 0 && onManageRemotes && (
        <button type="button" className="tree-row remote-empty-row" onClick={onManageRemotes}>
          <span className="twisty" />
          <CloudIcon size={13} />
          <span>{t('اتصال تازه (FTP/S3)')}</span>
        </button>
      )}
      {remotes &&
        !isCollapsed('remote') &&
        remotes.map((r) => {
          let uri = ''
          try {
            uri = profileUri(r)
          } catch {
            uri = ''
          }
          const active =
            !!uri && (activePath === uri || activePath.startsWith(uri.endsWith('/') ? uri : uri + '/'))
          return (
            <div key={r.id} className={'tree-row remote-row' + (active ? ' on' : '')}>
              <span className="twisty" />
              <button
                type="button"
                className="tree-name"
                dir="auto"
                title={uri || r.name}
                onClick={() => onRemote?.(r)}
              >
                {r.protocol === 's3' ? <CloudIcon size={13} /> : <ServerIcon size={13} />}
                <span>{r.name}</span>
                <span className="remote-proto">{r.protocol === 's3' ? 'S3' : r.protocol.toUpperCase()}</span>
              </button>
            </div>
          )
        })}

      {clouds && (
        <div className="side-section-head">
          <button
            type="button"
            className="side-section-toggle"
            onClick={() => toggleSection('cloud')}
            aria-expanded={!isCollapsed('cloud')}
          >
            <span className="side-twisty">
              {!isCollapsed('cloud') ? <ChevronDownIcon size={11} /> : <ChevronLeftIcon size={11} />}
            </span>
            <span className="side-title">{t('ابرها')}</span>
            {clouds.bindings.length > 0 && <span className="side-section-badge">{fa(clouds.bindings.length)}</span>}
          </button>
          {onManageClouds && (
            <button
              type="button"
              className="side-add"
              title={t('مدیریت ابرها')}
              aria-label={t('مدیریت ابرها')}
              onClick={onManageClouds}
            >
              <PlusIcon size={12} />
            </button>
          )}
        </div>
      )}
      {clouds &&
        !isCollapsed('cloud') &&
        clouds.bindings.map((b) => {
          const account = clouds.accounts.find((a) => a.id === b.accountId)
          const st = clouds.status.find((s) => s.bindingId === b.id)
          return (
            <div
              key={b.id}
              className="tree-row side-cloud"
              onContextMenu={(ev) => {
                if (!onCloudMenu) return
                ev.preventDefault()
                ev.stopPropagation()
                onCloudMenu(b, ev.clientX, ev.clientY)
              }}
            >
              <span className="twisty" />
              <div className="side-cloud-body">
                <button
                  type="button"
                  className="tree-name"
                  dir="auto"
                  title={`${b.localPath}\n${account?.label ?? ''} · ${b.remoteLabel}`}
                  onClick={() => onCloud?.(b)}
                >
                  <span className={`cloud-mark ${account?.provider ?? 'webdav'}`}>
                    <CloudIcon size={13} />
                  </span>
                  <span>{b.name}</span>
                  {!st?.progress && (
                    <span className="side-cloud-sub" dir="auto">
                      {bindingSubtitle(st?.state ?? 'idle', st?.lastRunAt ?? null, st?.conflicts.length ?? 0)}
                    </span>
                  )}
                </button>
                {st?.progress && (
                  <span
                    className="cloud-progress"
                    title={`${st.progress.current || t('در حال همگام‌سازی…')}${
                      st.progress.bytesTotal
                        ? `\n${fmtSize(st.progress.bytesDone, false)} / ${fmtSize(st.progress.bytesTotal, false)}`
                        : ''
                    }`}
                  >
                    <span
                      className={'cloud-bar' + (progressPercent(st.progress) === null ? ' scan' : '')}
                      dir="ltr"
                    >
                      <i style={{ width: (progressPercent(st.progress) ?? 35) + '%' }} />
                    </span>
                    <span className="cloud-progress-pct">
                      {progressPercent(st.progress) === null
                        ? t('بررسی')
                        : `${fa(progressPercent(st.progress) ?? 0)}٪`}
                    </span>
                  </span>
                )}
              </div>
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

      {syncJobs && syncJobs.length > 0 && (
        <div className="side-section-head">
          <button
            type="button"
            className="side-section-toggle"
            onClick={() => toggleSection('sync')}
            aria-expanded={!isCollapsed('sync')}
          >
            <span className="side-twisty">
              {!isCollapsed('sync') ? <ChevronDownIcon size={11} /> : <ChevronLeftIcon size={11} />}
            </span>
            <span className="side-title">{t('همگام‌سازی')}</span>
            <span className="side-section-badge">{fa(syncJobs.length)}</span>
          </button>
        </div>
      )}
      {!isCollapsed('sync') &&
        syncJobs?.map((j) => (
          <div key={j.id} className="tree-row side-sync" title={`${j.left} ↔ ${j.right}`}>
            <span className="twisty" />
            <button className="tree-name" dir="auto" onClick={() => onSyncJob?.(j)}>
              <SwapIcon size={13} />
              <span className="side-sync-name">{j.name}</span>
              <span className="dim side-mount-tag">
                {j.direction === 'rtl' ? '←' : j.direction === 'both' ? '↔' : '→'}
              </span>
            </button>
            <button
              type="button"
              className="side-eject-btn"
              title={t('باز کردن برای اجرا')}
              aria-label={t('باز کردن برای اجرا')}
              onClick={(e) => {
                e.stopPropagation()
                onSyncJob?.(j)
              }}
            >
              <PlayIcon size={11} />
            </button>
          </div>
        ))}
    </aside>
  )
}
