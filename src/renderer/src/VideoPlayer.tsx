import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { api, type PlayerChapter, type PlayerSubtitle } from './api'
import { t } from './i18n.ts'
import { clock, fa } from './format'
import {
  CameraIcon,
  ExitFullscreenIcon,
  ForwardIcon,
  FullscreenIcon,
  LoopIcon,
  MuteIcon,
  PauseIcon,
  PlayIcon,
  RewindIcon,
  VolumeIcon,
  XIcon
} from './Icons'

type Props = {
  src: string
  /** original file, used for «save frame» and the external-open fallback */
  sourcePath: string
  title: string
  poster?: string
  duration?: number
  chapters?: PlayerChapter[]
  subtitles?: PlayerSubtitle[]
  onNote?(msg: string): void
  onExternal?(path: string): void
  /** when given, the fullscreen button asks the host window to go real fullscreen instead of cinema */
  onFullscreen?: () => void
  fullscreen?: boolean
  /** standalone windows hide their controls on their own instead of keeping them under the pointer */
  autoHide?: boolean
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

const typingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable
}

/**
 * The embedded media player. Everything (controls, cinema mode, subtitles, frame capture) lives
 * inside the app: no native surface and no external player. `src` is always an mfm:// URL, which
 * now answers HTTP Range requests so seeking works for both direct and prepared files.
 */
export function VideoPlayer({
  src,
  sourcePath,
  title,
  poster,
  duration = 0,
  chapters = [],
  subtitles = [],
  onNote,
  onExternal,
  onFullscreen,
  fullscreen = false,
  autoHide = false
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [rate, setRate] = useState(1)
  const [loop, setLoop] = useState(false)
  const [cinema, setCinema] = useState(false)
  const [current, setCurrent] = useState(0)
  const [total, setTotal] = useState(duration)
  const [buffered, setBuffered] = useState(0)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  const [controlsOn, setControlsOn] = useState(true)
  const [hovered, setHovered] = useState(false)
  const [compact, setCompact] = useState(false)
  const [cc, setCc] = useState(0)
  const [tracks, setTracks] = useState<{ label: string; lang: string; url: string }[]>([])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = volume
    video.muted = muted
    video.playbackRate = rate
    video.loop = loop
  }, [volume, muted, rate, loop])

  // Closing the standalone video window must also stop the same file if the preview pane was
  // playing it: that <video> is a separate element in this window and would keep going.
  useEffect(() => {
    return api.player.onWindowClosed((kind) => {
      if (kind === 'video') videoRef.current?.pause()
    })
  }, [])

  useEffect(() => {
    const made = subtitles.map((s) => ({
      label: s.label,
      lang: s.lang,
      url: URL.createObjectURL(new Blob([s.vtt], { type: 'text/vtt' }))
    }))
    setTracks(made)
    setCc(0)
    return () => {
      for (const track of made) URL.revokeObjectURL(track.url)
    }
  }, [subtitles])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    for (let i = 0; i < video.textTracks.length; i++) {
      video.textTracks[i].mode = cc === i + 1 ? 'showing' : 'disabled'
    }
  }, [cc, tracks])

  useEffect(() => {
    const el = shellRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setCompact(el.getBoundingClientRect().width < 430))
    ro.observe(el)
    setCompact(el.getBoundingClientRect().width < 430)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('vp-cinema', cinema)
    if (cinema) shellRef.current?.focus()
    return () => document.documentElement.classList.remove('vp-cinema')
  }, [cinema])

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    },
    []
  )

  const poke = (): void => {
    setControlsOn(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    if (playing && (autoHide || !hovered)) {
      hideTimer.current = setTimeout(() => setControlsOn(false), 2400)
    }
  }

  const toggle = (): void => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void video
        .play()
        .then(() => setError(''))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    } else {
      video.pause()
    }
    poke()
  }

  const seekTo = (time: number): void => {
    const video = videoRef.current
    if (!video) return
    const end = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : total
    const at = clamp(time, 0, Math.max(0, end))
    video.currentTime = at
    setCurrent(at)
  }

  const seekBy = (delta: number): void => seekTo(current + delta)

  const step = (dir: number): void => {
    const video = videoRef.current
    if (!video) return
    video.pause()
    seekTo(video.currentTime + dir / 30)
  }

  const changeSpeed = (delta: number): void => {
    const at = SPEEDS.indexOf(rate)
    const next = SPEEDS[clamp((at < 0 ? 2 : at) + delta, 0, SPEEDS.length - 1)]
    setRate(next)
    onNote?.(t('سرعت پخش: {rate}×', { rate: fa(String(next)) }))
  }

  const cycleCc = (): void => {
    if (!tracks.length) return
    setCc((n) => (n + 1) % (tracks.length + 1))
  }

  const saveFrame = (): void => {
    const video = videoRef.current
    if (!video) return
    const end = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : total
    const at = Math.max(0, Math.min(video.currentTime, Math.max(0, end - 0.05)))
    void api.player.saveFrame(sourcePath, at).then((r) => {
      onNote?.(
        'error' in r
          ? t('ذخیرهٔ فریم ممکن نشد — {error}', { error: r.error })
          : t('فریم ذخیره شد: {name}', { name: r.path.split(/[\\/]/).pop() ?? '' })
      )
    })
  }

  const handleKey = (ev: KeyboardEvent): boolean => {
    if (typingTarget(ev.target)) return false
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return false
    switch (ev.key) {
      case ' ':
      case 'Spacebar':
        toggle()
        return true
      case 'ArrowLeft':
        seekBy(ev.shiftKey ? -30 : -5)
        return true
      case 'ArrowRight':
        seekBy(ev.shiftKey ? 30 : 5)
        return true
      case 'ArrowUp':
        setVolume((v) => clamp(v + 0.05, 0, 1))
        setMuted(false)
        return true
      case 'ArrowDown':
        setVolume((v) => clamp(v - 0.05, 0, 1))
        setMuted(false)
        return true
      case 'Home':
        seekTo(0)
        return true
      case 'End':
        seekTo(total)
        return true
      case 'm':
      case 'M':
        setMuted((m) => !m)
        return true
      case 'f':
      case 'F':
        // in a standalone window the host owns fullscreen, so the player must not eat F for cinema
        if (onFullscreen) onFullscreen()
        else setCinema((c) => !c)
        return true
      case 'l':
      case 'L':
        setLoop((l) => !l)
        return true
      case 'c':
      case 'C':
        cycleCc()
        return true
      case '[':
        changeSpeed(-1)
        return true
      case ']':
        changeSpeed(1)
        return true
      case ',':
        step(-1)
        return true
      case '.':
        step(1)
        return true
      case 'Escape':
        if (cinema) {
          setCinema(false)
          return true
        }
        return false
      default:
        return false
    }
  }

  const keyRef = useRef(handleKey)
  keyRef.current = handleKey
  useEffect(() => {
    if (!hovered && !cinema) return
    const onKey = (ev: KeyboardEvent): void => {
      if (!keyRef.current(ev)) return
      ev.preventDefault()
      ev.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [hovered, cinema])

  const pct = total > 0 ? clamp((current / total) * 100, 0, 100) : 0
  const bufPct = total > 0 ? clamp((buffered / total) * 100, 0, 100) : 0
  const seekStyle = {
    '--vp-play': `${pct}%`,
    '--vp-buf': `${Math.max(pct, bufPct)}%`
  } as CSSProperties

  return (
    <div
      ref={shellRef}
      className={
        'vp' +
        (autoHide ? ' autohide' : '') +
        (cinema ? ' cinema' : '') +
        (compact ? ' compact' : '') +
        (playing ? ' playing' : '') +
        (controlsOn || !playing ? ' controls' : '')
      }
      tabIndex={0}
      dir="ltr"
      onKeyDown={(ev) => {
        if (handleKey(ev.nativeEvent)) {
          ev.preventDefault()
          ev.stopPropagation()
        }
      }}
      onPointerMove={poke}
      onClick={poke}
      onMouseEnter={() => {
        setHovered(true)
        setControlsOn(true)
        if (hideTimer.current) clearTimeout(hideTimer.current)
      }}
      onMouseLeave={() => {
        setHovered(false)
        if (hideTimer.current) clearTimeout(hideTimer.current)
        if (playing) hideTimer.current = setTimeout(() => setControlsOn(false), 800)
      }}
    >
      <video
        ref={videoRef}
        className="vp-video"
        src={src}
        poster={poster}
        preload="metadata"
        playsInline
        onClick={() => {
          shellRef.current?.focus()
          toggle()
        }}
        onDoubleClick={() => setCinema((c) => !c)}
        onLoadedMetadata={(ev) => {
          const v = ev.currentTarget
          setTotal(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : duration)
          setWaiting(false)
        }}
        onDurationChange={(ev) => {
          const v = ev.currentTarget
          if (Number.isFinite(v.duration) && v.duration > 0) setTotal(v.duration)
        }}
        onTimeUpdate={(ev) => {
          const v = ev.currentTarget
          setCurrent(v.currentTime)
          const b = v.buffered
          if (b.length) setBuffered(b.end(b.length - 1))
        }}
        onProgress={(ev) => {
          const b = ev.currentTarget.buffered
          if (b.length) setBuffered(b.end(b.length - 1))
        }}
        onPlay={() => {
          setPlaying(true)
          setWaiting(false)
          poke()
        }}
        onPause={() => {
          setPlaying(false)
          poke()
        }}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onRateChange={(ev) => setRate(ev.currentTarget.playbackRate)}
        onVolumeChange={(ev) => {
          setMuted(ev.currentTarget.muted)
          setVolume(ev.currentTarget.volume)
        }}
        onEnded={() => {
          setPlaying(false)
          poke()
        }}
        onError={() => {
          const message = t('پخش این ویدئو با موتور داخلی ممکن نشد')
          setError(message)
          setWaiting(false)
          onNote?.(message)
        }}
      >
        {tracks.map((track) => (
          <track key={track.url} kind="subtitles" src={track.url} srcLang={track.lang || 'und'} label={track.label} />
        ))}
      </video>

      {!playing && !error && (
        <button className="vp-bigplay" title={t('پخش (Space)')} onClick={toggle}>
          <PlayIcon />
        </button>
      )}
      {waiting && !error && <span className="vp-spin" aria-label={t('در حال بارگذاری…')} />}
      {error && (
        <div className="vp-error" role="alert">
          <span>{error}</span>
          {onExternal && (
            <button className="btn" onClick={() => onExternal(sourcePath)}>
              {t('باز کردن بیرونی')}
            </button>
          )}
        </div>
      )}

      <div className="vp-cine-head">
        <span dir="auto">{title}</span>
        <button className="tb" title={t('خروج از حالت سینما (Esc)')} onClick={() => setCinema(false)}>
          <XIcon />
        </button>
      </div>

      <div className="vp-bar" onPointerMove={poke}>
        <div className="vp-seek-line" style={seekStyle}>
          <div className="vp-seek-buffer" />
          <div className="vp-seek-played" />
          {chapters.map((c, i) => (
            <span
              key={i}
              className="vp-chapter"
              style={{ left: `${total > 0 ? clamp((c.start / total) * 100, 0, 100) : 0}%` }}
              title={c.title || t('فصل {n}', { n: fa(String(i + 1)) })}
              onClick={() => seekTo(c.start)}
            />
          ))}
          <input
            className="vp-seek"
            type="range"
            min={0}
            max={Math.max(0.01, total)}
            step={0.01}
            value={Math.min(current, Math.max(0.01, total))}
            aria-label={t('موقعیت پخش')}
            onChange={(ev) => seekTo(Number(ev.currentTarget.value))}
          />
        </div>
        <div className="vp-row">
          <button className="vp-btn" title={playing ? t('توقف (Space)') : t('پخش (Space)')} onClick={toggle}>
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button className="vp-btn" title={t('۱۰ ثانیه عقب (←)')} onClick={() => seekBy(-10)}>
            <RewindIcon />
          </button>
          <button className="vp-btn" title={t('۱۰ ثانیه جلو (→)')} onClick={() => seekBy(10)}>
            <ForwardIcon />
          </button>
          <span className="vp-time">
            {fa(clock(current))} / {fa(clock(total))}
          </span>
          <span className="spacer" />
          {tracks.length > 0 && (
            <button
              className={'vp-btn' + (cc ? ' on' : '')}
              title={t('زیرنویس')}
              onClick={cycleCc}
            >
              CC
            </button>
          )}
          <select
            className="vp-speed"
            title={t('سرعت پخش')}
            value={rate}
            onChange={(ev) => setRate(Number(ev.currentTarget.value))}
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {fa(String(s))}×
              </option>
            ))}
          </select>
          <button
            className={'vp-btn' + (loop ? ' on' : '')}
            title={t('تکرار')}
            onClick={() => setLoop((l) => !l)}
          >
            <LoopIcon />
          </button>
          <button className="vp-btn vp-camera" title={t('ذخیرهٔ فریم')} onClick={saveFrame}>
            <CameraIcon />
          </button>
          <div className="vp-vol">
            <button className="vp-btn" title={muted ? t('صدا') : t('بی‌صدا')} onClick={() => setMuted((m) => !m)}>
              {muted || volume === 0 ? <MuteIcon /> : <VolumeIcon />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              aria-label={t('بلندی صدا')}
              onChange={(ev) => {
                const v = Number(ev.currentTarget.value)
                setVolume(v)
                setMuted(v === 0)
              }}
            />
          </div>
          <button
            className="vp-btn"
            title={
              onFullscreen
                ? fullscreen
                  ? t('خروج از تمام‌صفحه (Esc)')
                  : t('تمام‌صفحه (F)')
                : cinema
                  ? t('خروج از حالت سینما (Esc)')
                  : t('حالت سینما (F)')
            }
            onClick={onFullscreen ?? (() => setCinema((c) => !c))}
          >
            {(onFullscreen ? fullscreen : cinema) ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </button>
        </div>
      </div>
    </div>
  )
}
