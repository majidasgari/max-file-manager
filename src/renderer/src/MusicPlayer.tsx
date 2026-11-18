import { useSyncExternalStore, useEffect, useState } from 'react'
import { t } from './i18n.ts'
import { api, type Tags } from './api'
import { baseName, fa } from './format'
import { AudioIcon, ForwardIcon, PauseIcon, PlayIcon, RewindIcon, TrashIcon, XIcon } from './Icons'
import {
  clearMusic,
  closeMusic,
  musicState,
  playAt,
  removeMusic,
  saveMusic,
  stepMusic,
  subscribeMusic,
  toggleMusic
} from './music'

/**
 * Playlist and transport, drawn in the preview panel. It only drives `music.ts`: the `<audio>` lives
 * there, so closing the pane keeps the sound going.
 */
export function MusicPlayer({ onNote }: { onNote?(msg: string): void }) {
  const m = useSyncExternalStore(subscribeMusic, musicState)
  const now = m.index >= 0 ? baseName(m.items[m.index]) : ''
  const current = m.index >= 0 ? (m.items[m.index] ?? '') : ''
  /** tags and embedded cover of the track that is loaded, read once per track change */
  const [info, setInfo] = useState<{ tags: Tags; cover: string | null } | null>(null)

  useEffect(() => {
    setInfo(null)
    if (!current) return
    let live = true
    void (async () => {
      // `audioRead` is the only router that hands out cover bytes (as a data URL); for a single
      // mp3 its sharedCover is that file's own art, and folderCover is the album image beside it.
      const cover = /\.mp3$/i.test(current)
        ? await api
            .audioRead([current])
            .then((r) => r.sharedCover ?? r.folderCover)
            .catch(() => null)
        : null
      const rows = await api.tags([current]).catch(() => ({}) as Record<string, Tags>)
      if (live) setInfo({ tags: rows[current] ?? { kind: 'none' }, cover })
    })()
    return () => {
      live = false
    }
  }, [current])

  return (
    <div className="music">
      <div className="music-head">
        <button className="tb" title={t('قطعهٔ قبلی')} onClick={() => stepMusic(-1)}>
          <RewindIcon />
        </button>
        <button className="tb" title={m.playing ? t('توقف') : t('پخش')} onClick={toggleMusic}>
          {m.playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button className="tb" title={t('قطعهٔ بعدی')} onClick={() => stepMusic(1)}>
          <ForwardIcon />
        </button>
        <span className="music-now" dir="auto" title={now}>
          {now || t('پلی‌لیست خالی است')}
        </span>
        <span className="dim">{t('{n} قطعه', { n: fa(m.items.length) })}</span>
        <button className="tb" title={t('بستن پخش‌کننده')} onClick={closeMusic}>
          <XIcon size={12} />
        </button>
      </div>

      <div className="music-list">
        {/* shortcut: rows are not virtualised, swap to windowing if a playlist of thousands shows up */}
        {m.items.map((p, i) => (
          <div key={p} className={'music-row' + (i === m.index ? ' on' : '')}>
            <button className="music-pick" onClick={() => playAt(i)} title={p}>
              <span className="idx">{fa(i + 1)}</span>
              <span className="name" dir="auto">
                {baseName(p)}
              </span>
            </button>
            <button className="tb" title={t('حذف از پلی‌لیست')} onClick={() => removeMusic(i)}>
              <TrashIcon size={12} />
            </button>
          </div>
        ))}
        {!m.items.length && (
          <div className="preview-empty">
            <AudioIcon size={22} />
            {t('روی فایل‌های موسیقی راست‌کلیک کن و «افزودن به پلی‌لیست موسیقی» را بزن')}
          </div>
        )}
      </div>

      {current && (
        <div className="music-info">
          {info?.cover ? (
            <img className="music-cover" src={info.cover} alt="" />
          ) : (
            <span className="music-cover none">
              <AudioIcon size={22} />
            </span>
          )}
          <div className="music-tags" dir="auto">
            <span className="music-title">{info?.tags.title || now}</span>
            {info?.tags.artist && <span className="dim">{info.tags.artist}</span>}
            {(info?.tags.album || info?.tags.year) && (
              <span className="dim">
                {[info?.tags.album ?? '', info?.tags.year ? fa(info.tags.year) : '']
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
            {(info?.tags.track || info?.tags.genre || info?.tags.composer) && (
              <span className="dim">
                {[
                  info?.tags.track ? t('قطعهٔ {n}', { n: fa(info.tags.track) }) : '',
                  info?.tags.genre ?? '',
                  info?.tags.composer ?? ''
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </div>
        </div>
      )}

      {m.error && <div className="dim">{t('پخش این فایل ممکن نشد')}</div>}

      <div className="music-foot">
        <button
          className="btn"
          onClick={() => {
            saveMusic()
            onNote?.(t('پلی‌لیست ذخیره شد'))
          }}
        >
          {t('ذخیرهٔ پلی‌لیست')}
        </button>
        <button className="btn ghost" onClick={clearMusic}>
          {t('پاک کردن')}
        </button>
      </div>
    </div>
  )
}
