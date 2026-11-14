import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type Entry, type PortalRequestData } from './api'
import { matchesPortalFilter } from '../../shared/portal-filters.ts'
import { crumbs, baseName, fa, fmtDate, fmtSize, joinPath, sortEntries } from './format'
import { ArrowUpIcon, ChevronDownIcon, ChevronLeftIcon, ConfirmIcon, EntryIcon, EyeIcon, EyeOffIcon, FolderIcon, HomeIcon, RefreshIcon, StarIcon } from './Icons'
import { mergePrefs, migrateLegacy, type Prefs } from './prefs'
import { t } from './i18n'
import { applyPrefs } from './apply-prefs'

const ROW_H = 38
const OVERSCAN = 8

type Place = { name: string; path: string }

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
  const [overwrite, setOverwrite] = useState<string | null>(null)
  const [marks, setMarks] = useState<string[]>([])
  const [markLooks, setMarkLooks] = useState<Record<string, { color?: string; icon?: string }>>({})
  const [iconSet, setIconSet] = useState<Record<string, string>>({})
  const [marksOpen, setMarksOpen] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)
  const anchor = useRef(0)
  const loadGeneration = useRef(0)

  useEffect(() => {
    let live = true
    void Promise.all([api.portal.request(), api.state.get(), api.home(), api.iconSet()]).then(([req, state, homeDir, icons]) => {
      if (!live) return
      const merged = mergePrefs({ ...migrateLegacy(state), ...(state?.prefs ?? {}) })
      applyPrefs(merged)
      setPrefs(merged)
      setShowHidden(merged.showHidden)
      setHome(homeDir)
      setIconSet(icons ?? {})
      // the same list the file manager's sidebar shows: bookmarks live in the shared state
      setMarks(Array.isArray(state?.marks) ? state.marks.filter((m): m is string => typeof m === 'string' && m.startsWith('/')) : [])
      setRequest(req)
      setFileName(req?.currentName ?? '')
      setDir(req?.currentFolder || merged.pickerLastDir || homeDir)
      document.title = req?.title || 'Max File Manager'
    }).catch((e) => {
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
    setDir(listing.path)
    setEntries(listing.entries)
    setSelected([])
    setActive(0)
    anchor.current = 0
    setScrollTop(0)
    scroller.current?.scrollTo({ top: 0 })
    setLoading(false)
  }, [])

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
    const observer = new ResizeObserver(() => setViewport(el.clientHeight))
    observer.observe(el)
    setViewport(el.clientHeight)
    return () => observer.disconnect()
  }, [request])

  const navigate = useCallback((target: string) => {
    setAddress(null)
    void load(target, showHidden)
  }, [load, showHidden])

  const activeFilter = request?.filters[filterIndex] ?? null
  const ordered = useMemo(() => {
    const kept = entries.filter((e) => e.dir || matchesPortalFilter(e.name, e.ext, activeFilter))
    return sortEntries(kept, 'name', true, true)
  }, [entries, activeFilter])

  useEffect(() => {
    if (active >= ordered.length) setActive(Math.max(0, ordered.length - 1))
  }, [active, ordered.length])

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

  const selectEntry = (entry: Entry, index: number, ev: React.MouseEvent) => {
    let next = [entry.path]
    if (request?.multiple && ev.shiftKey) {
      const from = Math.min(anchor.current, index)
      const to = Math.max(anchor.current, index)
      next = ordered.slice(from, to + 1).map((e) => e.path)
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
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      const next = Math.max(0, Math.min(ordered.length - 1, active + (ev.key === 'ArrowDown' ? 1 : -1)))
      setActive(next)
      if (!ev.ctrlKey && !ev.metaKey) setSelected(ordered[next] ? [ordered[next].path] : [])
      if (ev.shiftKey && request?.multiple) {
        const from = Math.min(anchor.current, next)
        const to = Math.max(anchor.current, next)
        setSelected(ordered.slice(from, to + 1).map((e) => e.path))
      } else anchor.current = next
      scroller.current?.scrollTo({ top: Math.max(0, Math.min(next * ROW_H - viewport + ROW_H * 2, next * ROW_H - ROW_H)) })
    } else if (ev.key === 'Enter') {
      ev.preventDefault()
      const entry = ordered[active]
      if (entry?.dir) openEntry(entry)
      else void accept()
    } else if (ev.key.toLowerCase() === 'a' && (ev.ctrlKey || ev.metaKey) && request?.multiple) {
      ev.preventDefault()
      setSelected(ordered.filter((e) => request.directory === e.dir || (!request.directory && !e.dir)).map((e) => e.path))
    }
  }

  if (!request || !prefs) return <div className="boot">{error || t('در حال باز کردن…')}</div>
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(ordered.length, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN)
  const acceptLabel = request.acceptLabel || (request.operation === 'open'
    ? request.directory ? t('انتخاب پوشه') : t('باز کردن')
    : request.operation === 'saveFiles' ? t('انتخاب پوشه') : t('ذخیره'))

  return (
    <main className="portal-picker" tabIndex={0} onKeyDown={keyboard}>
      <header className="picker-header">
        <div className="picker-title" dir="auto">{request.title}</div>
        <div className="picker-tools">
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
          <nav className="picker-crumbs" aria-label={t('نشانی')} onDoubleClick={() => setAddress(dir)}>
            {crumbs(dir).map((c) => <button key={c.path} dir="auto" onClick={() => navigate(c.path)}>{c.name}</button>)}
          </nav>
        ) : (
          <input
            className="picker-address"
            dir="ltr"
            autoFocus
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate(address)
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
                    name: baseName(m),
                    path: m,
                    dir: true,
                    size: 0,
                    mtime: 0,
                    ext: '',
                    color: markLooks[m]?.color,
                    icon: markLooks[m]?.icon
                  }}
                />
                <span dir="auto">{baseName(m)}</span>
              </button>
            ))}
          </>}
        </aside>
        <section className="picker-files">
          <div className="picker-columns"><span>{t('نام')}</span><span>{t('اندازه')}</span><span>{t('تاریخ')}</span></div>
          <div className="picker-scroll" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
            <div className="picker-spacer" style={{ height: ordered.length * ROW_H }}>
              {ordered.slice(start, end).map((entry, offset) => {
                const index = start + offset
                return <div
                  key={entry.path}
                  className={`picker-row ${selected.includes(entry.path) ? 'selected' : ''} ${index === active ? 'active' : ''}`}
                  style={{ top: index * ROW_H }}
                  onClick={(e) => selectEntry(entry, index, e)}
                  onDoubleClick={() => openEntry(entry)}
                >
                  <span className="picker-name"><EntryIcon entry={entry} size={18} /><span dir="auto">{entry.name}</span></span>
                  <span className="picker-size">{entry.dir ? '—' : fmtSize(entry.size, false, prefs.sizeFormat)}</span>
                  <span className="picker-date" dir="ltr">{fmtDate(entry.mtime, prefs.dateFormat)}</span>
                </div>
              })}
            </div>
            {!loading && !ordered.length && <div className="picker-empty">{t('چیزی با این نام نیست')}</div>}
            {loading && <div className="picker-empty">{t('در حال باز کردن…')}</div>}
          </div>
        </section>
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
