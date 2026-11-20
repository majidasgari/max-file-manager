import { useEffect, useState } from 'react'
import { api, type PlayerJobInfo, type PlayerSource } from './api'
import { t } from './i18n.ts'

/** The video preparation state, shared by the preview pane and the standalone video window. */
export type PlayerState =
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

/**
 * Opens `path` through the player IPC and mirrors its events. Direct files need no work; other
 * containers are prepared by FFmpeg in main with progress. Events carry the original path, so a
 * late done/error from a previous selection is ignored.
 *
 * `stamp` (mtime:size) remounts the work when the same path is replaced on disk.
 */
export function usePlayerOpen(
  path: string,
  stamp: string,
  onError?: (msg: string) => void
): { player: PlayerState | null; cancelPrepare(): void } {
  const [player, setPlayer] = useState<PlayerState | null>(null)

  useEffect(() => {
    if (!path) {
      setPlayer(null)
      return
    }
    let live = true
    let jobId = ''
    let settled = false
    setPlayer({ kind: 'loading', path })
    const fail = (message: string): void => {
      setPlayer({ kind: 'error', path, message })
      onError?.(message)
    }
    const off = api.player.onEvent((e) => {
      if (!live || e.path !== path) return
      if (e.type === 'progress') {
        setPlayer((p) =>
          p?.kind === 'preparing' && p.job.id === e.id
            ? { kind: 'preparing', path, job: { ...p.job, progress: e.progress } }
            : p
        )
        return
      }
      if (settled) return
      if (jobId && e.id !== jobId) return
      settled = true
      jobId = ''
      if (e.type === 'done') setPlayer({ kind: 'ready', path, source: e.source })
      else fail(playerErrorText(e.error))
    })
    void api.player
      .open(path)
      .then((r) => {
        if (!live) {
          if (r.kind === 'preparing') void api.player.cancel(r.job.id)
          return
        }
        if (settled) return
        if (r.kind === 'ready') {
          settled = true
          setPlayer({ kind: 'ready', path, source: r.source })
        } else if (r.kind === 'preparing') {
          jobId = r.job.id
          setPlayer({ kind: 'preparing', path, job: r.job })
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
  }, [path, stamp, onError])

  const cancelPrepare = (): void => {
    if (player?.kind !== 'preparing') return
    void api.player.cancel(player.job.id)
    setPlayer({ kind: 'error', path: player.path, message: t('آماده‌سازی ویدئو لغو شد') })
  }

  return { player, cancelPrepare }
}
