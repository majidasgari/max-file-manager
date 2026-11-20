import { useEffect, useState } from 'react'
import { t } from './i18n.ts'
import { api, musicBridge, type MusicWindowState, type Tags } from './api'
import { baseName, clock, fa } from './format'
import {
  AudioIcon,
  CompactIcon,
  ForwardIcon,
  ListIcon,
  PauseIcon,
  PlayIcon,
  RewindIcon,
  VolumeIcon
} from './Icons'
import { useStandalonePrefs } from './Standalone'
import { WindowButtons } from './WindowButtons'

const EMPTY: MusicWindowState = {
  items: [],
  index: -1,
  playing: false,
  pos: 0,
  dur: 0,
  volume: 1
}

const splitKey = (items: string[]): string => items.join('\u0000')

/**
 * The music player in its own window: a large cover, the playlist and the transport bar.
 *
 * It never owns audio. The one `<audio>` element lives in the main window's `music.ts`; this
 * window mirrors its state over `musicBridge` and sends commands back, so closing it or opening
 * a second view can never start a second sound.
 */
export function StandaloneMusic({ path }: { path: string }) {
  const prefs = useStandalonePrefs()
  const [state, setState] = useState<MusicWindowState | null>(null)
  const [tags, setTags] = useState<Record<string, Tags>>({})
  const [cover, setCover] = useState<string | null>(null)
  const [durations, setDurations] = useState<Record<string, number>>({})
  const [compact, setCompact] = useState(false)
  const [listOpen, setListOpen] = useState(true)

  const m = state ?? EMPTY
  const current = m.index >= 0 ? (m.items[m.index] ?? '') : ''
  const info = current ? tags[current] : undefined
  const title = info?.title || (current ? baseName(current) : path ? baseName(path) : '')
  const itemKey = splitKey(m.items)

  useEffect(() => musicBridge.onState(setState), [])

  // Tags for every row arrive in one call; lengths come from the main process (ffprobe + cache).
  useEffect(() => {
    if (!m.items.length) {
      setTags({})
      setDurations({})
      return
    }
    let live = true
    void api
      .tags(m.items)
      .then((r) => live && setTags(r))
      .catch(() => undefined)
    // fifty rows is plenty for the visible first screen; the rest keep `--:--`
    void api
      .audioDurations(m.items.slice(0, 50))
      .then((r) => live && setDurations(r))
      .catch(() => undefined)
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemKey])

  // The cover belongs to the loaded track, so it is read again only when the index changes.
  useEffect(() => {
    setCover(null)
    if (!current) return
    let live = true
    void (async () => {
      const c = /\.mp3$/i.test(current)
        ? await api
            .audioRead([current])
            .then((r) => r.sharedCover ?? r.folderCover)
            .catch(() => null)
        : null
      if (live) setCover(c)
    })()
    return () => {
      live = false
    }
  }, [current])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === 'Escape') {
        e.preventDefault()
        void api.window.close()
        return
      }
      if (e.key === ' ' && !typing) {
        e.preventDefault()
        musicBridge.send({ type: 'toggle' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!prefs) return <div className="boot">{t('در حال باز کردن…')}</div>
  if (!state) return <div className="boot">{t('در حال خواندن…')}</div>

  const rowDuration = (p: string, i: number): string => {
    if (i === m.index && m.dur) return fa(clock(m.dur))
    const d = durations[p]
    return d ? fa(clock(d)) : '--:--'
  }

  return (
    <div className={'mx' + (compact ? ' compact' : '')}>
      <div className="mx-body">
        <div className="mx-cover">
          {cover ? (
            <img className="mx-cover-img" src={cover} alt="" />
          ) : (
            <span className="mx-cover-none">
              <AudioIcon size={44} />
              {t('کاور ندارد')}
            </span>
          )}
        </div>
        <div className="mx-side">
          <div className={'mx-meta' + (prefs.titlebar === 'app' ? ' with-btns' : '')}>
            <span className="mx-title" dir="auto" title={title}>
              {title || t('پلی‌لیست خالی است')}
            </span>
            {info?.album && <span className="mx-album" dir="auto">{info.album}</span>}
            {info?.artist && <span className="mx-artist" dir="auto">{info.artist}</span>}
          </div>
          {listOpen && (
            <div className="mx-list">
              {/* shortcut: rows are not virtualised, swap to windowing if a playlist of thousands shows up */}
              {m.items.map((p, i) => (
                <div
                  key={`${i}:${p}`}
                  className={'mx-row' + (i === m.index ? ' on' : '')}
                  onDoubleClick={() => musicBridge.send({ type: 'play', index: i })}
                  onClick={() => musicBridge.send({ type: 'play', index: i })}
                >
                  <span className="mx-num">{fa(i + 1)}</span>
                  <span className="mx-thumb">
                    {i === m.index &&
                      (cover ? <img src={cover} alt="" /> : <AudioIcon size={14} />)}
                  </span>
                  <span className="mx-rowtext">
                    <span className="mx-rowtitle" dir="auto">
                      {tags[p]?.title || baseName(p)}
                    </span>
                    {tags[p]?.artist && (
                      <span className="mx-rowartist" dir="auto">
                        {tags[p]?.artist}
                      </span>
                    )}
                  </span>
                  <span className="mx-dur">{rowDuration(p, i)}</span>
                </div>
              ))}
              {!m.items.length && (
                <div className="mx-empty">
                  <AudioIcon size={24} />
                  {t('پلی‌لیست خالی است')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mx-bar">
        <button className="tb" title={t('قطعهٔ قبلی')} onClick={() => musicBridge.send({ type: 'prev' })}>
          <RewindIcon />
        </button>
        <button
          className="tb mx-play"
          title={m.playing ? t('توقف') : t('پخش')}
          onClick={() => musicBridge.send({ type: 'toggle' })}
        >
          {m.playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button className="tb" title={t('قطعهٔ بعدی')} onClick={() => musicBridge.send({ type: 'next' })}>
          <ForwardIcon />
        </button>
        <span className="mx-time">{fa(clock(m.pos))}</span>
        <input
          className="mx-seek"
          type="range"
          min={0}
          max={Math.max(0.01, m.dur)}
          step={0.1}
          value={Math.min(m.pos, Math.max(0.01, m.dur))}
          disabled={!m.dur}
          aria-label={t('موقعیت پخش')}
          onChange={(e) => musicBridge.send({ type: 'seek', pos: Number(e.currentTarget.value) })}
        />
        <span className="mx-total">{fa(clock(m.dur))}</span>
        <button
          className="tb"
          title={t('بلندی صدا')}
          onClick={() => musicBridge.send({ type: 'volume', volume: m.volume > 0 ? 0 : 1 })}
        >
          <VolumeIcon />
        </button>
        <input
          className="mx-vol"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={m.volume}
          aria-label={t('بلندی صدا')}
          onChange={(e) => musicBridge.send({ type: 'volume', volume: Number(e.currentTarget.value) })}
        />
        <button
          className="tb mx-toggle-list"
          title={t('نمایش/پنهان‌کردن پلی‌لیست')}
          onClick={() => setListOpen((v) => !v)}
        >
          <ListIcon />
        </button>
        <button
          className="tb mx-compact"
          title={t('حالت فشرده')}
          onClick={() => setCompact((v) => !v)}
        >
          <CompactIcon />
        </button>
      </div>

      {prefs.titlebar === 'app' && (
        <div className={'mx-winbtns side-' + prefs.titlebarSide}>
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
