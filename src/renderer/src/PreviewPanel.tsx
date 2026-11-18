import { t } from './i18n.ts'
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react'
import {
  api,
  type Entry,
  type PlayerCapabilities,
  type PlayerJobInfo,
  type PlayerSource,
  type Preview
} from './api'
import { fa, fmtDate, fmtSize, mediaUrl, thumbUrl } from './format'
import { ChevronLeftIcon, ChevronRightIcon, FileIcon, GridIcon, VideoIcon, XIcon } from './Icons'
import { renderMarkdown } from './md'
import { cleanHtml, isHtmlPath } from './html'
import { highlightCode, langFor } from './highlight'
import { VideoPlayer } from './VideoPlayer'
import { musicState, subscribeMusic } from './music'

/** The player's own chunk, fetched the first time it opens: a disabled module has no UI code loaded. */
const MusicPanel = lazy(() => import('./MusicPlayer').then((m) => ({ default: m.MusicPlayer })))

type Props = {
  entry: Entry | null
  /** fill a whole pane instead of the narrow side strip */
  fill?: boolean
  /** position inside the folder's image list, when the entry is an image */
  imageIndex?: { at: number; total: number } | null
  onNavImage?(delta: number): void
  onGallery?(): void
  onOpen(path: string): void
  onClose(): void
  /** short feedback in the status bar (player errors, save-frame result, …) */
  onNote?(msg: string): void
  /** text previews stop at this size */
  maxKB?: number
}

const MAX_INLINE_IMAGE = 8_000_000

type PlayerState =
  | { kind: 'loading'; path: string }
  | { kind: 'preparing'; path: string; job: PlayerJobInfo }
  | { kind: 'ready'; path: string; source: PlayerSource }
  | { kind: 'error'; path: string; message: string }

const playerErrorText = (code: string): string => {
  if (code === 'no-video') return t('این فایل جریان ویدئو ندارد')
  if (code === 'no-encoder') return t('FFmpeg برای تبدیل این ویدئو انکودر مناسبی ندارد')
  if (code === 'ffmpeg-missing' || code === 'ffprobe-missing') {
    return t('FFmpeg/ffprobe نصب نیست؛ فقط MP4/WebM پخش می‌شود')
  }
  if (code === 'probe-failed') {
    return t('این فایل ویدئوی معتبر نیست یا FFmpeg نتوانست آن را بخواند')
  }
  if (/empty/i.test(code)) return t('فایل خالی است')
  return t('پخش این ویدئو ممکن نشد — {error}', { error: code })
}

export function PreviewPanel({
  maxKB = 200,
  entry,
  fill,
  imageIndex,
  onNavImage,
  onGallery,
  onOpen,
  onClose,
  onNote
}: Props) {
  const [rawData, setData] = useState<Preview | null>(null)
  /** which file the payload belongs to: a render between selection and fetch must not reuse it */
  const [dataPath, setDataPath] = useState('')
  const data = dataPath && dataPath === entry?.path ? rawData : null
  const [err, setErr] = useState('')
  const [htmlCode, setHtmlCode] = useState(false)
  const [tags, setTags] = useState<Record<string, string> | null>(null)
  /** Chromium's PDF viewer sizes itself once, on load; a remount after layout fixes the zoom */
  const [pdfBoot, setPdfBoot] = useState(0)
  const [player, setPlayer] = useState<PlayerState | null>(null)
  const [caps, setCaps] = useState<PlayerCapabilities | null>(null)
  // an open player owns this slot: no other preview is fetched while it is up
  const musicOpen = useSyncExternalStore(subscribeMusic, musicState).open
  useEffect(() => {
    if (data?.kind !== 'video') return
    let live = true
    void api.player
      .capabilities()
      .then((c) => live && setCaps(c))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [data?.kind])

  const videoPath = data?.kind === 'video' && entry ? entry.path : ''
  const videoStamp = entry ? `${entry.mtime}:${entry.size}` : ''
  const pv = player && player.path === entry?.path ? player : null

  // Direct files need no work; other containers are prepared by FFmpeg in main with progress.
  // Events carry the original path, so a late done/error from a previous selection is ignored.
  useEffect(() => {
    if (!videoPath) {
      setPlayer(null)
      return
    }
    let live = true
    let jobId = ''
    let settled = false
    setPlayer({ kind: 'loading', path: videoPath })
    const fail = (message: string): void => {
      setPlayer({ kind: 'error', path: videoPath, message })
      onNote?.(message)
    }
    const off = api.player.onEvent((e) => {
      if (!live || e.path !== videoPath) return
      if (e.type === 'progress') {
        setPlayer((p) =>
          p?.kind === 'preparing' && p.job.id === e.id
            ? { kind: 'preparing', path: videoPath, job: { ...p.job, progress: e.progress } }
            : p
        )
        return
      }
      if (settled) return
      if (jobId && e.id !== jobId) return
      settled = true
      jobId = ''
      if (e.type === 'done') setPlayer({ kind: 'ready', path: videoPath, source: e.source })
      else fail(playerErrorText(e.error))
    })
    void api.player
      .open(videoPath)
      .then((r) => {
        if (!live) {
          if (r.kind === 'preparing') void api.player.cancel(r.job.id)
          return
        }
        if (settled) return
        if (r.kind === 'ready') {
          settled = true
          setPlayer({ kind: 'ready', path: videoPath, source: r.source })
        } else if (r.kind === 'preparing') {
          jobId = r.job.id
          setPlayer({ kind: 'preparing', path: videoPath, job: r.job })
        } else {
          settled = true
          fail(playerErrorText(r.error))
        }
      })
      .catch((e: unknown) => live && fail(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
      off()
      if (jobId) void api.player.cancel(jobId)
    }
  }, [videoPath, videoStamp, onNote])

  const cancelPrepare = (): void => {
    if (player?.kind !== 'preparing') return
    void api.player.cancel(player.job.id)
    setPlayer({ kind: 'error', path: player.path, message: t('آماده‌سازی ویدئو لغو شد') })
  }

  useEffect(() => {
    setData(null)
    setDataPath('')
    setErr('')
    if (!entry || entry.dir || musicOpen) return
    let live = true
    void api
      .preview(entry.path, maxKB)
      .then((p) => {
        if (!live) return
        if (p) {
          setData(p)
          setDataPath(entry.path)
        } else {
          setErr(t('پیش‌نمایش ممکن نشد'))
        }
      })
      .catch((e) => live && setErr(String(e?.message ?? e)))
    return () => {
      live = false
    }
  }, [entry?.path, entry?.mtime, entry?.size, entry?.dir, maxKB, musicOpen])

  const lines = (data?.text ?? '').split(/\r?\n/)
  const lang = entry ? langFor(entry.path) : null

  useEffect(() => {
    if (!entry || !/\.pdf$/i.test(entry.path)) return
    const boot = setTimeout(() => setPdfBoot((n) => n + 1), 450)
    return () => clearTimeout(boot)
  }, [entry])

  useEffect(() => {
    if (!entry || entry.dir) {
      setTags(null)
      return
    }
    let live = true
    void api.tags([entry.path]).then((r) => {
      if (!live) return
      const tagRow = r?.[entry.path]
      setTags(tagRow && tagRow.kind && tagRow.kind !== 'none' ? tagRow : null)
    })
    return () => {
      live = false
    }
  }, [entry])

  return (
    <aside className={'preview' + (fill ? ' fill' : '')}>
      <div className="preview-head">
        {onNavImage && (
          <button className="tb" title={t(t('تصویر قبلی (←)'))} onClick={() => onNavImage(-1)}>
            <ChevronRightIcon />
          </button>
        )}
        {entry && isHtmlPath(entry.path) && (
          <div className="seg preview-html-toggle">
            <button className={htmlCode ? '' : 'on'} onClick={() => setHtmlCode(false)}>
              {t('نمایش')}
            </button>
            <button className={htmlCode ? 'on' : ''} onClick={() => setHtmlCode(true)}>
              {t('کد')}
            </button>
          </div>
        )}
        <span className="preview-title" dir="auto">
          {entry ? entry.name : t('پیش‌نمایش')}
        </span>
        {imageIndex && (
          <span className="pill">
            {t('{a} از {b}', { a: fa(imageIndex.at), b: fa(imageIndex.total) })}
          </span>
        )}
        <span className="spacer" />
        {onGallery && imageIndex && (
          <button className="tb" title={t(t('گالری (Space)'))} onClick={onGallery}>
            <GridIcon />
          </button>
        )}
        {onNavImage && (
          <button className="tb" title={t(t('تصویر بعدی (→)'))} onClick={() => onNavImage(1)}>
            <ChevronLeftIcon />
          </button>
        )}
        <button className="tb" title={t(t('بستن پیش‌نمایش (F3)'))} onClick={onClose}>
          <XIcon size={12} />
        </button>
      </div>

      {musicOpen ? (
        <div className="preview-body music-body">
          <Suspense fallback={null}>
            <MusicPanel onNote={onNote} />
          </Suspense>
        </div>
      ) : !entry ? (
        <div className="preview-empty">{t(t('یک فایل انتخاب کن'))}</div>
      ) : entry.dir ? (
        <div className="preview-empty">{t(t('پوشه — برای دیدن محتوا بازش کن'))}</div>
      ) : (
        <>
          <div
            className={
              'preview-body' +
              (data?.kind === 'text' ? ' text' : '') +
              (data?.kind === 'video' ? ' video' : '')
            }
            onDoubleClick={() => imageIndex && onGallery?.()}
          >
            {data?.kind === 'image' && entry.size < MAX_INLINE_IMAGE && (
              <img
                className="preview-img"
                src={mediaUrl(entry.path, `${Math.round(entry.mtime)}-${entry.size}`)}
                alt=""
              />
            )}
            {data?.kind === 'image' && entry.size >= MAX_INLINE_IMAGE && (
              <div className="preview-empty">{t(t('تصویر بزرگ است؛ برای دیدن بازش کن'))}</div>
            )}
            {data?.kind === 'pdf' && (
              <iframe
                className="preview-pdf"
                // the viewer honours these fragment hints; without zoom the page renders tiny
                key={pdfBoot}
                src={`${mediaUrl(entry.path, `${Math.round(entry.mtime)}-${entry.size}`)}#zoom=page-width&view=FitH&t=${pdfBoot}`}
                title={entry.name}
              />
            )}
            {data?.kind === 'office' && (
              <div className="preview-text" dir="auto">
                {(data.text ?? '').split('\n').slice(0, 4000).map((ln, n) => (
                  <div className="pline" key={n}>
                    <span className="pln">{n + 1}</span>
                    <span
                      className="ptext"
                      dangerouslySetInnerHTML={{ __html: ln ? highlightCode(ln, 'xml') : ' ' }}
                    />
                  </div>
                ))}
              </div>
            )}
            {data?.kind === 'audio' && (
              <audio
                className="preview-media"
                controls
                src={mediaUrl(entry.path, `${Math.round(entry.mtime)}-${entry.size}`)}
              />
            )}
            {data?.kind === 'video' &&
              (pv?.kind === 'ready' ? (
                <VideoPlayer
                  key={`${pv.source.path}:${videoStamp}`}
                  src={mediaUrl(pv.source.path)}
                  sourcePath={entry.path}
                  title={entry.name}
                  duration={pv.source.duration}
                  chapters={pv.source.chapters}
                  subtitles={pv.source.subtitles}
                  poster={thumbUrl(entry.path, 512, `${Math.round(entry.mtime)}-${entry.size}`)}
                  onNote={onNote}
                  onExternal={onOpen}
                />
              ) : pv?.kind === 'preparing' ? (
                <div className="preview-prep">
                  <div className="preview-prep-title">{t('آماده‌سازی ویدئو…')}</div>
                  <progress max={100} value={Math.round(pv.job.progress)} />
                  <span className="dim">
                    {t('{n}٪', { n: fa(Math.round(pv.job.progress)) })}
                    {' · '}
                    {pv.job.mode === 'remux'
                      ? t('سازگارسازی ظرف ویدئو')
                      : t('تبدیل برای پخش')}
                  </span>
                  <button className="btn" onClick={cancelPrepare}>
                    {t('لغو')}
                  </button>
                </div>
              ) : pv?.kind === 'error' ? (
                <div className="preview-empty">
                  <VideoIcon />
                  <span>{pv.message}</span>
                  {caps && !caps.ffmpeg && (
                    <span className="dim">{t('FFmpeg نصب نیست؛ فقط فرمت‌های مرورگر پخش می‌شوند')}</span>
                  )}
                  <button className="btn" onClick={() => onOpen(entry.path)}>
                    {t('باز کردن بیرونی')}
                  </button>
                </div>
              ) : (
                <div className="preview-empty">
                  <span className="vp-spin" />
                  {t('در حال آماده‌سازی…')}
                </div>
              ))}
            {data?.kind === 'text' && isHtmlPath(entry.path) && !htmlCode && (
              <iframe
                className="preview-html"
                sandbox=""
                referrerPolicy="no-referrer"
                title={entry.name}
                srcDoc={cleanHtml(data.text ?? '')}
              />
            )}
            {data?.kind === 'text' && isHtmlPath(entry.path) && htmlCode && (
              <div className="preview-text" dir="ltr">
                {(data.text ?? '').split('\n').slice(0, 4000).map((ln, n) => (
                  <div className="pline" key={n}>
                    <span className="pln">{n + 1}</span>
                    <span
                      className="ptext"
                      dangerouslySetInnerHTML={{ __html: ln ? highlightCode(ln, 'xml') : ' ' }}
                    />
                  </div>
                ))}
              </div>
            )}
            {data?.kind === 'text' && /\.(md|markdown|mdx)$/i.test(entry.path) && (
              <div
                className="preview-body md-body"
                dir="auto"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(data.text ?? '') }}
              />
            )}
            {data?.kind === 'text' && !/\.(md|markdown|mdx)$/i.test(entry.path) && !isHtmlPath(entry.path) && (
              <div className="preview-text" dir="auto">
                {lines.slice(0, 4000).map((ln, n) => (
                  <div className="pline" key={n}>
                    <span className="pln">{n + 1}</span>
                    <span
                      className="ptext"
                      // each line picks its own direction, so Persian previews are not left-aligned
                      dir="auto"
                      // highlight.js escapes first, so the markup is safe to inject
                      dangerouslySetInnerHTML={{ __html: ln ? highlightCode(ln, lang) : ' ' }}
                    />
                  </div>
                ))}
                {lines.length > 4000 && (
                  <div className="pln-more">{t('… {n} خط دیگر نمایش داده نشد', { n: fa(lines.length - 4000) })}</div>
                )}
              </div>
            )}
            {data?.kind === 'binary' && (
              <div className="preview-empty">
                <FileIcon />
                {t('پیش‌نمایش برای این نوع فایل نیست')}
              </div>
            )}
            {err && <div className="preview-empty">{err}</div>}
          </div>

          <div className="preview-foot">
            <div className="preview-meta" dir="auto">
              {!entry.dir && <span>{fmtSize(entry.size, false)}</span>}
              <span>{fmtDate(entry.mtime)}</span>
              {tags && tags.title && <span className="tag-pill">🎵 {tags.title}</span>}
              {tags && tags.artist && <span className="tag-pill">{tags.artist}</span>}
              {tags && tags.album && <span className="tag-pill">{tags.album}</span>}
              {tags && tags.camera && <span className="tag-pill">📷 {tags.camera}</span>}
              {tags && tags.date && <span className="tag-pill">{tags.date.slice(0, 10)}</span>}
              {tags && tags.iso && <span className="tag-pill">ISO {tags.iso}</span>}
              {data?.capped && <span className="dim">{t(t('نمایش بریده شد'))}</span>}
            </div>
            {!entry.dir && (
              <button className="btn" onClick={() => onOpen(entry.path)}>
                {t('باز کردن')}
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  )
}
