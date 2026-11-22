/**
 * Everything the media player decides without touching Electron, FFmpeg or the filesystem:
 * probing results, «can Chromium play this directly, remux it, or transcode it?», HTTP byte
 * ranges for seeking, subtitle conversion and progress parsing.
 *
 * Kept pure so `node --test` can cover the cross-platform cases (MP4/WebM/MKV/AVI, HEVC,
 * AC-3, missing encoders) without a media file or a display.
 */
import path from 'node:path'

// `.ts` is deliberately absent: in a source tree it is TypeScript, not MPEG-TS.
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'ogv', 'wmv', 'flv', 'm2ts', 'mpg', 'mpeg', '3gp']

export function isVideoFile(file: string): boolean {
  const ext = path.extname(file).slice(1).toLowerCase()
  return VIDEO_EXTENSIONS.includes(ext)
}

export type ByteRange = { start: number; end: number }

/**
 * One HTTP range (`bytes=start-end`, `bytes=start-`, `bytes=-suffix`) against a known size.
 * Multi-range requests are deliberately treated as a full response; Chromium's media stack
 * asks for a single range. Returns null when the header is absent or unusable.
 */
export function parseByteRange(value: string | null | undefined, size: number): ByteRange | null {
  if (!value || !Number.isFinite(size) || size <= 0) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (!rawStart && !rawEnd) return null
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    const length = Math.min(size, Math.floor(suffix))
    return { start: size - length, end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isFinite(start) || start < 0 || start >= size) return null
  const end = rawEnd ? Math.min(size - 1, Math.floor(Number(rawEnd))) : size - 1
  if (!Number.isFinite(end) || end < start) return null
  return { start: Math.floor(start), end }
}

export type MediaStream = {
  index: number
  type: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment'
  codec: string
  width: number
  height: number
  channels: number
  language: string
  title: string
}

export type MediaChapter = { start: number; end: number; title: string }

export type MediaProbe = {
  format: string
  duration: number
  size: number
  video: MediaStream | null
  audio: MediaStream | null
  subtitles: MediaStream[]
  chapters: MediaChapter[]
}

const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** `ffprobe -print_format json` output → the small shape the player needs. */
export function parseProbe(json: unknown): MediaProbe | null {
  const root = record(json)
  const format = record(root?.format)
  if (!root || !format) return null
  const streams = Array.isArray(root.streams) ? root.streams : []
  const parsed: MediaStream[] = streams.map((raw, i) => {
    const s = record(raw) ?? {}
    const tags = record(s.tags) ?? {}
    const type = text(s.codec_type)
    return {
      index: num(s.index) || i,
      type:
        type === 'video' || type === 'audio' || type === 'subtitle' || type === 'data' || type === 'attachment'
          ? type
          : 'data',
      codec: text(s.codec_name).toLowerCase(),
      width: num(s.width),
      height: num(s.height),
      channels: num(s.channels),
      language: text(tags.language),
      title: text(tags.title)
    }
  })
  const chapters = (Array.isArray(root.chapters) ? root.chapters : []).map((raw) => {
    const c = record(raw) ?? {}
    const tags = record(c.tags) ?? {}
    return {
      start: num(c.start_time),
      end: num(c.end_time),
      title: text(tags.title)
    }
  })
  return {
    format: text(format.format_name),
    duration: num(format.duration),
    size: num(format.size),
    video: parsed.find((s) => s.type === 'video') ?? null,
    audio: parsed.find((s) => s.type === 'audio') ?? null,
    subtitles: parsed.filter((s) => s.type === 'subtitle'),
    chapters: chapters.filter((c) => c.end > c.start)
  }
}

export type EncoderSupport = {
  h264: boolean
  aac: boolean
  vp9: boolean
  opus: boolean
  /** a hardware H.264 encoder that already proved it works; absent means none */
  hw?: HwEncoder
}

/** `device` is VAAPI's render node — it is addressed by file, not by driver name. */
export type HwEncoder = {
  name: 'vaapi' | 'qsv' | 'nvenc' | 'amf' | 'videotoolbox'
  device?: string
}

export type ConvertPlan = {
  mode: 'remux' | 'transcode'
  container: 'mp4' | 'webm'
  video: 'copy' | 'h264' | 'vp9'
  audio: 'copy' | 'aac' | 'opus' | 'none'
  /** 0 means «keep the source size» */
  maxWidth: number
  reason: 'container' | 'codec' | 'audio'
}

export type PlaybackPlan =
  | { mode: 'direct'; reason: 'native' }
  | ConvertPlan
  | { mode: 'unsupported'; reason: 'no-video' | 'no-encoder' }

const DIRECT_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1'])
const MP4_VIDEO = new Set(['h264', 'av1'])
const WEBM_VIDEO = new Set(['vp8', 'vp9', 'av1'])
const MP4_AUDIO = new Set(['aac', 'mp3'])
const WEBM_AUDIO = new Set(['opus', 'vorbis'])

/**
 * Pick the cheapest path Chromium can play:
 * 1. native MP4/WebM with supported codecs → stream the original (seeking is byte-range based)
 * 2. supported codecs in another container → remux, copying video and usually audio
 * 3. anything else → transcode to H.264/AAC MP4 (or VP9/Opus WebM when x264 is unavailable)
 */
export function choosePlayback(
  probe: MediaProbe,
  opts: { ext: string; encoders: EncoderSupport }
): PlaybackPlan {
  const v = probe.video
  if (!v) return { mode: 'unsupported', reason: 'no-video' }
  const ext = opts.ext.toLowerCase().replace(/^\./, '')
  const vcodec = v.codec
  const acodec = probe.audio?.codec ?? ''
  const hasAudio = !!probe.audio
  if (DIRECT_VIDEO.has(vcodec)) {
    if (
      ['mp4', 'm4v', 'mov'].includes(ext) &&
      MP4_VIDEO.has(vcodec) &&
      (!hasAudio || MP4_AUDIO.has(acodec))
    ) {
      return { mode: 'direct', reason: 'native' }
    }
    if (ext === 'webm' && WEBM_VIDEO.has(vcodec) && (!hasAudio || WEBM_AUDIO.has(acodec))) {
      return { mode: 'direct', reason: 'native' }
    }
  }

  const maxWidth = v.width > 1920 ? 1920 : 0

  if (vcodec === 'h264') {
    const audio: ConvertPlan['audio'] = !hasAudio
      ? 'none'
      : MP4_AUDIO.has(acodec)
        ? 'copy'
        : opts.encoders.aac
          ? 'aac'
          : 'none'
    if (audio === 'none' && hasAudio) {
      // no AAC encoder: H.264 cannot go into WebM, so the only real fallback would be VP9
    } else {
      return {
        mode: 'remux',
        container: 'mp4',
        video: 'copy',
        audio,
        maxWidth: 0,
        reason: 'container'
      }
    }
  }

  if (WEBM_VIDEO.has(vcodec)) {
    const audio: ConvertPlan['audio'] = !hasAudio
      ? 'none'
      : WEBM_AUDIO.has(acodec)
        ? 'copy'
        : opts.encoders.opus
          ? 'opus'
          : 'none'
    if (!(audio === 'none' && hasAudio)) {
      return {
        mode: 'remux',
        container: 'webm',
        video: 'copy',
        audio,
        maxWidth: 0,
        reason: 'container'
      }
    }
  }

  if ((opts.encoders.h264 || opts.encoders.hw) && (!hasAudio || opts.encoders.aac)) {
    return {
      mode: 'transcode',
      container: 'mp4',
      video: 'h264',
      audio: hasAudio ? 'aac' : 'none',
      maxWidth,
      reason: 'codec'
    }
  }
  if (opts.encoders.vp9 && (!hasAudio || opts.encoders.opus)) {
    return {
      mode: 'transcode',
      container: 'webm',
      video: 'vp9',
      audio: hasAudio ? 'opus' : 'none',
      maxWidth,
      reason: 'codec'
    }
  }
  return { mode: 'unsupported', reason: 'no-encoder' }
}

/**
 * Encoder flags for H.264: hardware when one is known to work, libx264 otherwise. `prefix` lands
 * before `-i` (VAAPI/QSV create their device there) and `filters` join the one `-vf` chain after
 * the scale, so a downscaled frame is uploaded to the GPU once instead of twice.
 */
export function h264Encoder(
  hw: HwEncoder | undefined,
  maxWidth: number
): { prefix: string[]; video: string[]; filters: string[] } {
  const scale = maxWidth > 0 ? [`scale='min(${maxWidth},iw)':-2`] : []
  const upload = [...scale, 'format=nv12', 'hwupload']
  switch (hw?.name) {
    case 'vaapi':
      if (!hw.device) break
      return {
        prefix: ['-vaapi_device', hw.device],
        video: ['-c:v', 'h264_vaapi', '-qp', '22'],
        filters: upload
      }
    case 'qsv':
      return {
        prefix: ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw'],
        video: ['-c:v', 'h264_qsv', '-global_quality', '22', '-preset', 'veryfast'],
        filters: upload
      }
    case 'nvenc':
      return {
        prefix: [],
        video: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '22', '-b:v', '0'],
        filters: scale
      }
    case 'amf':
      return {
        prefix: [],
        video: ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '22'],
        filters: scale
      }
    case 'videotoolbox':
      return { prefix: [], video: ['-c:v', 'h264_videotoolbox', '-q:v', '55'], filters: scale }
  }
  return {
    prefix: [],
    video: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p'],
    filters: scale
  }
}

/**
 * FFmpeg command for a remux/transcode. `-progress pipe:1` is part of the command so the job
 * can report real percentages; thumbnails use their own small command and never call this.
 */
export function ffmpegArgs(
  plan: ConvertPlan,
  input: string,
  output: string,
  hw?: HwEncoder
): string[] {
  const maxWidth = plan.video === 'copy' ? 0 : plan.maxWidth
  const enc =
    plan.video === 'h264'
      ? h264Encoder(hw, maxWidth)
      : plan.video === 'vp9'
        ? {
            prefix: [],
            video: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-cpu-used', '2'],
            filters: maxWidth > 0 ? [`scale='min(${maxWidth},iw)':-2`] : []
          }
        : { prefix: [], video: ['-c:v', 'copy'], filters: [] }
  const args = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...enc.prefix]
  args.push('-i', input)
  args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-max_muxing_queue_size', '1024')
  args.push(...enc.video)
  if (enc.filters.length) args.push('-vf', enc.filters.join(','))

  if (plan.audio === 'copy') args.push('-c:a', 'copy')
  else if (plan.audio === 'aac') args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2')
  else if (plan.audio === 'opus') args.push('-c:a', 'libopus', '-b:a', '128k')
  else args.push('-an')

  if (plan.container === 'mp4') args.push('-movflags', '+faststart')
  args.push(output)
  return args
}

/** Parse `-progress pipe:1` output; `out_time_ms` is microseconds despite its name. */
export function parseFfmpegProgress(chunk: string, duration: number): number | null {
  if (!Number.isFinite(duration) || duration <= 0) return null
  let last = -1
  for (const line of chunk.split(/\r?\n/)) {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim())
    if (m) last = Number(m[1])
  }
  return last < 0 ? null : Math.max(0, Math.min(100, (last / 1_000_000 / duration) * 100))
}

/** A frame a little inside the video usually beats a black first frame. */
export function thumbnailSeek(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 1
  return Math.min(30, Math.max(0.5, duration * 0.1))
}

export type SubtitleCandidate = { file: string; label: string; lang: string }

/** Sibling `.srt`/`.vtt` files: `movie.srt`, `movie.fa.srt`, `movie.en.vtt` … */
export function subtitleCandidates(video: string, siblings: string[]): SubtitleCandidate[] {
  const dir = path.dirname(video)
  const stem = path.basename(video, path.extname(video)).toLowerCase()
  const out: SubtitleCandidate[] = []
  for (const name of siblings) {
    const lower = name.toLowerCase()
    const ext = path.extname(lower)
    if (ext !== '.srt' && ext !== '.vtt') continue
    const base = lower.slice(0, -ext.length)
    if (base !== stem && !base.startsWith(stem + '.')) continue
    const suffix = base === stem ? '' : base.slice(stem.length + 1)
    if (suffix && !/^[a-z0-9._-]{1,24}$/.test(suffix)) continue
    out.push({
      file: path.join(dir, name),
      label: suffix ? suffix.toUpperCase() : 'CC',
      lang: suffix.split(/[._-]/)[0] || ''
    })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label))
}

/** SubRip → WebVTT. Browsers only accept VTT tracks; timestamps and the header differ. */
export function srtToVtt(input: string): string {
  const body = input
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (/^WEBVTT\b/.test(body)) return body + '\n'
  const cues = body
    // SRT timestamps use a comma; VTT uses a dot
    .replace(/(\d{1,2}:\d{2}(?::\d{2})?),(\d{3})/g, '$1.$2')
    // a numeric cue id is legal in SRT and meaningless in VTT, but WebVTT accepts it too
    .replace(/^\d+\n(?=\d{1,2}:\d{2}(?::\d{2})?\.\d{3}\s+-->)/gm, '')
  return `WEBVTT\n\n${cues}\n`
}


/** Keep external cues above the player's control bar unless the file positions them itself. */
export function vttAboveControls(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line.includes('-->') && !/\bline:/.test(line) ? `${line.trimEnd()} line:-3` : line))
    .join('\n')
}
