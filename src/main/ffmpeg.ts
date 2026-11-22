import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants, promises as fs, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  h264Encoder,
  parseProbe,
  thumbnailSeek,
  type EncoderSupport,
  type HwEncoder,
  type MediaProbe
} from './player-core.ts'

/**
 * System FFmpeg only, with no shell: a missing binary simply disables the advanced path.
 * Chromium still plays MP4/WebM natively, so the app degrades to «browser formats» rather than
 * failing. FFmpeg is what unlocks MKV/AVI/WMV, HEVC/AC-3 and video thumbnails on all platforms.
 */
const NAMES = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg']
const PROBE_NAMES = process.platform === 'win32' ? ['ffprobe.exe', 'ffprobe'] : ['ffprobe']

function pathDirs(): string[] {
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean)
  const extra = [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin',
    '/opt/local/bin',
    '/snap/bin'
  ]
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA']
    if (local) {
      extra.push(path.join(local, 'Microsoft', 'WinGet', 'Links'))
      extra.push(path.join(local, 'Programs', 'ffmpeg', 'bin'))
    }
    const programFiles = process.env['ProgramFiles']
    if (programFiles) extra.push(path.join(programFiles, 'ffmpeg', 'bin'))
  }
  return [...new Set([...dirs, ...extra])]
}

const found = new Map<string, string | null>()

export function findBinary(which: 'ffmpeg' | 'ffprobe'): string | null {
  if (found.has(which)) return found.get(which) ?? null
  const names = which === 'ffmpeg' ? NAMES : PROBE_NAMES
  const mode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK
  for (const dir of pathDirs()) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        accessSync(candidate, mode)
        found.set(which, candidate)
        return candidate
      } catch {
        // keep looking
      }
    }
  }
  found.set(which, null)
  return null
}

type Run = { code: number; stdout: string; stderr: string }

function run(file: string, args: string[], timeout = 20_000, buffer = 16 * 1024 * 1024): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout, maxBuffer: buffer, windowsHide: true },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException).code === 'number'
            ? Number((err as NodeJS.ErrnoException).code)
            : err
              ? 1
              : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      }
    )
  })
}

export async function probeMedia(file: string): Promise<MediaProbe | null> {
  const exe = findBinary('ffprobe')
  if (!exe || !path.isAbsolute(file)) return null
  const r = await run(
    exe,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      file
    ],
    20_000
  )
  if (r.code !== 0) return null
  try {
    return parseProbe(JSON.parse(r.stdout))
  } catch {
    return null
  }
}

let encoderCache: EncoderSupport | null = null
let versionCache = ''

const HW_ORDER: HwEncoder['name'][] =
  process.platform === 'darwin'
    ? ['videotoolbox']
    : process.platform === 'win32'
      ? ['qsv', 'nvenc', 'amf']
      : ['vaapi', 'qsv', 'nvenc']

const HW_ENCODER: Record<HwEncoder['name'], string> = {
  vaapi: 'h264_vaapi',
  qsv: 'h264_qsv',
  nvenc: 'h264_nvenc',
  amf: 'h264_amf',
  videotoolbox: 'h264_videotoolbox'
}

/** VAAPI is addressed by a render node; the first one is the GPU the session already uses. */
function vaapiDevice(): string {
  try {
    const node = readdirSync('/dev/dri')
      .filter((name) => /^renderD\d+$/.test(name))
      .sort()[0]
    return node ? path.join('/dev/dri', node) : ''
  } catch {
    return ''
  }
}

/**
 * Being listed is not working: NVENC ships in most FFmpeg builds with no NVIDIA card present, and
 * VAAPI/QSV fail when the driver or the render node is missing. One real 5-frame encode through
 * the same flags the job will use is the only honest test — and it decides once per app start.
 */
async function hwWorks(exe: string, hw: HwEncoder): Promise<boolean> {
  const { prefix, video, filters } = h264Encoder(hw, 0)
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    ...prefix,
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=320x240:r=25',
    '-frames:v',
    '5',
    ...video,
    ...(filters.length ? ['-vf', filters.join(',')] : []),
    '-f',
    'null',
    '-'
  ]
  const r = await run(exe, args, 20_000, 256 * 1024)
  return r.code === 0
}

async function detectHw(exe: string, listed: string): Promise<HwEncoder | undefined> {
  for (const name of HW_ORDER) {
    if (!new RegExp(`\\b${HW_ENCODER[name]}\\b`).test(listed)) continue
    const hw: HwEncoder = { name, device: name === 'vaapi' ? vaapiDevice() : undefined }
    if (name === 'vaapi' && !hw.device) continue
    if (await hwWorks(exe, hw)) return hw
  }
  return undefined
}

/** Parsed once: FFmpeg's encoder list does not change while the app runs. */
export async function encoderSupport(): Promise<EncoderSupport> {
  if (encoderCache) return encoderCache
  const exe = findBinary('ffmpeg')
  if (!exe) {
    encoderCache = { h264: false, aac: false, vp9: false, opus: false }
    return encoderCache
  }
  const [enc, ver] = await Promise.all([
    run(exe, ['-hide_banner', '-encoders'], 15_000),
    run(exe, ['-hide_banner', '-version'], 10_000, 512 * 1024)
  ])
  const out = enc.stdout + enc.stderr
  const hw = await detectHw(exe, out)
  encoderCache = {
    h264: /\blibx264\b/.test(out) || !!hw,
    aac: /\baac\b/.test(out),
    vp9: /\blibvpx-vp9\b/.test(out),
    opus: /\blibopus\b/.test(out),
    hw
  }
  versionCache = (ver.stdout.split(/\r?\n/)[0] ?? '').trim()
  return encoderCache
}

export async function ffmpegCapabilities(): Promise<{
  ffmpeg: boolean
  ffprobe: boolean
  encoders: EncoderSupport
  version: string
}> {
  const encoders = await encoderSupport()
  return {
    ffmpeg: !!findBinary('ffmpeg'),
    ffprobe: !!findBinary('ffprobe'),
    encoders,
    version: versionCache
  }
}

/**
 * One representative frame as PNG. `-ss` before `-i` seeks cheaply; short clips get a second
 * attempt at the very beginning because 10% of a 0.3-second clip can land past the end.
 */
export async function videoFrame(
  input: string,
  output: string,
  side: number,
  duration = 0,
  exactAt?: number
): Promise<boolean> {
  const exe = findBinary('ffmpeg')
  if (!exe || !path.isAbsolute(input)) return false
  const seek = exactAt !== undefined && Number.isFinite(exactAt) && exactAt >= 0 ? exactAt : thumbnailSeek(duration)
  const base = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    '',
    '-i',
    input,
    '-an',
    '-sn',
    '-dn',
    '-frames:v',
    '1',
    '-vf',
    `scale=${side}:${side}:force_original_aspect_ratio=decrease`,
    '-f',
    'image2',
    output
  ]
  const attempts = exactAt !== undefined ? [String(seek)] : [String(seek), '0']
  for (const at of attempts) {
    const args = [...base]
    args[6] = at
    const r = await run(exe, args, 30_000)
    const written = await fs.stat(output).catch(() => null)
    if (r.code === 0 && written && written.size > 0) return true
  }
  return false
}
