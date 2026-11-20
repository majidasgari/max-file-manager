import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from './i18n.ts'
import { api, type Entry } from './api'
import { baseName, clock, dirOf, fa, fmtSize, isVideo, mediaUrl, thumbUrl } from './format'
import { ListIcon, VideoIcon } from './Icons'
import { usePlayerOpen } from './use-player-open'
import { useStandalonePrefs } from './Standalone'
import { VideoPlayer } from './VideoPlayer'
import { WindowButtons } from './WindowButtons'

const typingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable
}

/**
 * The video player in its own window, apart from the preview pane.
 *
 * It owns the player (`api.player.open` binds to this window's WebContents), so unlike the music
 * window there is no bridge to the main window: switching files only swaps the local path.
 */
export function StandaloneVideo({ path }: { path: string }) {
  const prefs = useStandalonePrefs()
  const [current, setCurrent] = useState(path)
  const [videos, setVideos] = useState<Entry[] | null>(null)
  const [durations, setDurations] = useState<Record<string, number>>({})
  const [listOpen, setListOpen] = useState(true)
  const [full, setFull] = useState(false)
  const [note, setNote] = useState('')
  const stageRef = useRef<HTMLDivElement>(null)

  useEffect(() => setCurrent(path), [path])

  // the OS/window manager can toggle fullscreen too (F11, caption button); keep the UI in step
  useEffect(() => api.window.onFullscreen(setFull), [])

  const toggleFull = useCallback((): void => {
    const next = !full
    setFull(next)
    void api.window.setFullscreen(next)
    if (next) setListOpen(false)
  }, [full])

  const dir = dirOf(current) || '/'
  const itemKey = (videos ?? []).map((e) => e.path).join('\u0000')
  const currentEntry = videos?.find((e) => e.path === current)
  const { player, cancelPrepare } = usePlayerOpen(current, '', setNote)

  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => setNote(''), 3500)
    return () => clearTimeout(timer)
  }, [note])

  // The folder's other videos become the row list; the requested file stays first-class even when
  // the listing filters it out (hidden file, ignore rule).
  useEffect(() => {
    if (!prefs) return
    let live = true
    void api
      .list(dir, prefs.showHidden)
      .then(async (l) => {
        if (!live) return
        const list = l.entries.filter((e) => !e.dir && isVideo(e.ext))
        if (!list.some((e) => e.path === current)) {
          const meta = await api.properties(current).catch(() => null)
          if (!live) return
          if (meta && 'path' in meta && !meta.dir && isVideo(meta.ext)) {
            list.unshift({
              name: meta.name,
              path: meta.path,
              dir: false,
              size: meta.size,
              mtime: meta.mtime,
              ext: meta.ext
            })
          }
        }
        setVideos(list)
      })
      .catch(() => live && setVideos([]))
    return () => {
      live = false
    }
  }, [dir, prefs, current])

  // ffprobe covers the browser-playable containers as well; the row falls back to the file size.
  useEffect(() => {
    const items = (videos ?? []).map((e) => e.path).slice(0, 100)
    if (!items.length) {
      setDurations({})
      return
    }
    let live = true
    void api
      .audioDurations(items)
      .then((r) => live && setDurations(r))
      .catch(() => undefined)
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (full) toggleFull()
        else void api.window.close()
        return
      }
      if ((e.key === 'f' || e.key === 'F') && !typingTarget(e.target)) {
        e.preventDefault()
        toggleFull()
        return
      }
      if (e.key === ' ' && !typingTarget(e.target)) {
        e.preventDefault()
        // VideoPlayer keeps its own Space handler (capture) while hovered/cinema; here we use the
        // same control the user would click, so the component itself stays untouched.
        const button = stageRef.current?.querySelector<HTMLButtonElement>('.vp-bar .vp-btn')
        button?.click()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full, toggleFull])

  if (!prefs) return <div className="boot">{t('در حال باز کردن…')}</div>

  const title = currentEntry?.name || (current ? baseName(current) : '')
  const rows = videos ?? []
  const showList = listOpen && rows.length > 1

  return (
    <div className={'vx' + (full ? ' full' : '')}>
      {!full && (
        <div className={'vx-head' + (prefs.titlebar === 'app' ? ' with-btns' : '')}>
          <span className="vx-title" dir="auto" title={title}>
            {title || t('فهرست')}
          </span>
          <span className="spacer" />
          {rows.length > 1 && (
            <button
              className={'tb' + (showList ? ' on' : '')}
              title={t('نمایش/پنهان‌کردن فهرست')}
              onClick={() => setListOpen((v) => !v)}
            >
              <ListIcon />
            </button>
          )}
        </div>
      )}

      <div className="vx-body">
        <div className="vx-stage" ref={stageRef}>
          {player?.kind === 'ready' ? (
            <VideoPlayer
              key={`${player.source.path}:${current}`}
              src={mediaUrl(player.source.path)}
              sourcePath={current}
              title={title}
              duration={player.source.duration}
              chapters={player.source.chapters}
              subtitles={player.source.subtitles}
              poster={
                currentEntry
                  ? thumbUrl(
                      current,
                      512,
                      `${Math.round(currentEntry.mtime)}-${currentEntry.size}`
                    )
                  : undefined
              }
              onNote={setNote}
              onExternal={(p) => void api.open(p)}
              onFullscreen={toggleFull}
              fullscreen={full}
              autoHide
            />
          ) : player?.kind === 'preparing' ? (
            <div className="vx-state">
              <div className="preview-prep">
                <div className="preview-prep-title">{t('آماده‌سازی ویدئو…')}</div>
                <progress max={100} value={Math.round(player.job.progress)} />
                <span className="dim">
                  {t('{n}٪', { n: fa(Math.round(player.job.progress)) })}
                  {' · '}
                  {player.job.mode === 'remux'
                    ? t('سازگارسازی ظرف ویدئو')
                    : t('تبدیل برای پخش')}
                </span>
                <button className="btn" onClick={cancelPrepare}>
                  {t('لغو')}
                </button>
              </div>
            </div>
          ) : player?.kind === 'error' ? (
            <div className="vx-state">
              <div className="preview-empty">
                <VideoIcon size={26} />
                <span>{player.message}</span>
                <button className="btn" onClick={() => void api.open(current)}>
                  {t('باز کردن بیرونی')}
                </button>
              </div>
            </div>
          ) : (
            <div className="vx-state">
              <span className="vp-spin" />
              <span className="dim">{t('در حال آماده‌سازی…')}</span>
            </div>
          )}
        </div>

        {rows.length > 1 && (showList || full) && (
          <div className="vx-list">
            {rows.map((e) => {
              const dur = durations[e.path]
              return (
                <div
                  key={e.path}
                  className={'vx-row' + (e.path === current ? ' on' : '')}
                  onClick={() => setCurrent(e.path)}
                  onDoubleClick={() => setCurrent(e.path)}
                >
                  <span className="vx-row-name" dir="auto">
                    {e.name}
                  </span>
                  <span className="vx-row-meta">
                    {dur ? fa(clock(dur)) : fmtSize(e.size, false, prefs.sizeFormat)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {note && <div className="vx-note">{note}</div>}

      {!full && prefs.titlebar === 'app' && (
        <div className={'standalone-winbtns side-' + prefs.titlebarSide}>
          <WindowButtons
            theme={prefs.titlebarButtons}
            side={prefs.titlebarSide}
            onClose={() => void api.window.close()}
          />
        </div>
      )}
    </div>
  )
}
