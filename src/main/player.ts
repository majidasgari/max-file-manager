import { app, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  choosePlayback,
  ffmpegArgs,
  isVideoFile,
  parseFfmpegProgress,
  srtToVtt,
  subtitleCandidates,
  vttAboveControls,
  type ConvertPlan,
  type HwEncoder,
  type MediaChapter,
  type MediaProbe
} from './player-core.ts'
import { encoderSupport, ffmpegCapabilities, findBinary, probeMedia, videoFrame } from './ffmpeg.ts'
import { freeName } from './ops.ts'

export type PlayerMode = 'direct' | 'remux' | 'transcode'
export type PlayerChapter = { start: number; end: number; title: string }
export type PlayerSubtitle = { label: string; lang: string; vtt: string }
export type PlayerSource = {
  /** absolute file on disk; the renderer turns it into an mfm:// URL */
  path: string
  mode: PlayerMode
  duration: number
  width: number
  height: number
  chapters: PlayerChapter[]
  subtitles: PlayerSubtitle[]
}
export type PlayerJobInfo = {
  id: string
  mode: 'remux' | 'transcode'
  progress: number
  duration: number
  width: number
  height: number
  chapters: PlayerChapter[]
}
export type PlayerOpen =
  | { kind: 'ready'; source: PlayerSource }
  | { kind: 'preparing'; job: PlayerJobInfo }
  | { kind: 'unsupported'; error: string }
export type PlayerEvent =
  | { id: string; path: string; type: 'progress'; progress: number }
  | { id: string; path: string; type: 'done'; source: PlayerSource }
  | { id: string; path: string; type: 'error'; error: string }

const CACHE_VERSION = 'player1'
const MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_CACHE_FILES = 400
const NATIVE_DIRECT = new Set(['mp4', 'm4v', 'mov', 'webm'])

type Job = {
  id: string
  sourcePath: string
  owner: WebContents
  plan: ConvertPlan
  final: string
  temp: string
  proc: ChildProcess | null
  progress: number
  lastSent: number
  duration: number
  width: number
  height: number
  chapters: PlayerChapter[]
  stderr: string
  cancelled: boolean
  done: boolean
}

const jobs = new Map<string, Job>()
let initPromise: Promise<void> | null = null

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'video-cache')
}

async function ensureCache(): Promise<void> {
  await fs.mkdir(cacheDir(), { recursive: true }).catch(() => undefined)
}

/** Old partial files are leftovers from a crash or a force-quit, never an active conversion. */
async function cleanPartials(): Promise<void> {
  const dir = cacheDir()
  const names = await fs.readdir(dir).catch(() => [] as string[])
  // no conversion is alive at startup, so every `.part-` file is a crash leftover
  for (const name of names) {
    if (!name.includes('.part-')) continue
    await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined)
  }
}

async function pruneCache(): Promise<void> {
  const dir = cacheDir()
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const stats: { file: string; at: number; size: number }[] = []
  const recent = Date.now() - 60_000
  for (const name of names) {
    if (name.includes('.part-')) continue
    const p = path.join(dir, name)
    const st = await fs.stat(p).catch(() => null)
    // never evict the file a conversion just produced (or one currently being opened)
    if (st?.isFile() && st.mtimeMs < recent) stats.push({ file: p, at: st.mtimeMs, size: st.size })
  }
  let total = stats.reduce((n, s) => n + s.size, 0)
  if (stats.length <= MAX_CACHE_FILES && total <= MAX_CACHE_BYTES) return
  stats.sort((a, b) => a.at - b.at)
  let count = stats.length
  for (const s of stats) {
    if (count <= MAX_CACHE_FILES && total <= MAX_CACHE_BYTES) break
    await fs.rm(s.file, { force: true }).catch(() => undefined)
    total -= s.size
    count--
  }
}

/** Called once after `ready` so a previous crash cannot leave dangling partials forever. */
export function initPlayer(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await ensureCache()
      await cleanPartials()
      void pruneCache()
    })()
  }
  return initPromise
}

function broadcast(event: PlayerEvent, owner: WebContents): void {
  if (!owner.isDestroyed()) owner.send('player:event', event)
}

async function readSubtitles(file: string): Promise<PlayerSubtitle[]> {
  const dir = path.dirname(file)
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const out: PlayerSubtitle[] = []
  for (const candidate of subtitleCandidates(file, names)) {
    const buf = await fs.readFile(candidate.file).catch(() => null)
    if (!buf || buf.length > 4 * 1024 * 1024) continue
    const raw = buf.toString('utf8')
    const vtt = candidate.file.toLowerCase().endsWith('.srt') ? srtToVtt(raw) : raw.replace(/^\uFEFF/, '')
    if (!/^WEBVTT\b/.test(vtt.trim())) continue
    out.push({ label: candidate.label, lang: candidate.lang, vtt: vttAboveControls(vtt) })
  }
  return out
}

function chaptersOf(probe: MediaProbe): PlayerChapter[] {
  return probe.chapters.map((c) => ({ start: c.start, end: c.end, title: c.title }))
}

async function sourceFor(
  file: string,
  planMode: PlayerMode,
  probe: MediaProbe | null
): Promise<PlayerSource> {
  return {
    path: file,
    mode: planMode,
    duration: probe?.duration ?? 0,
    width: probe?.video?.width ?? 0,
    height: probe?.video?.height ?? 0,
    chapters: probe ? chaptersOf(probe) : [],
    subtitles: await readSubtitles(file)
  }
}

function cacheKey(file: string, st: { mtimeMs: number; size: number }, plan: ConvertPlan): string {
  return createHash('sha1')
    .update(
      `${CACHE_VERSION}|${file}|${Math.round(st.mtimeMs)}|${st.size}|${plan.container}|${plan.video}|${plan.audio}|${plan.maxWidth}`
    )
    .digest('hex')
}

function jobInfo(job: Job): PlayerJobInfo {
  return {
    id: job.id,
    mode: job.plan.mode,
    progress: job.progress,
    duration: job.duration,
    width: job.width,
    height: job.height,
    chapters: job.chapters
  }
}

function finishCleanup(job: Job): void {
  jobs.delete(job.id)
  if (job.proc && !job.proc.killed) job.proc.kill('SIGKILL')
  job.proc = null
  void fs.rm(job.temp, { force: true }).catch(() => undefined)
}

function failJob(job: Job, message: string): void {
  if (job.done) return
  job.done = true
  const wasCancelled = job.cancelled
  finishCleanup(job)
  if (!wasCancelled) broadcast({ id: job.id, path: job.sourcePath, type: 'error', error: message || 'FFmpeg failed' }, job.owner)
}

async function completeJob(job: Job): Promise<void> {
  if (job.done) return
  if (job.cancelled) {
    job.done = true
    finishCleanup(job)
    return
  }
  const ok = await fs
    .rm(job.final, { force: true })
    .then(() => fs.rename(job.temp, job.final))
    .then(
      () => true,
      () => false
    )
  if (job.cancelled) {
    job.done = true
    await fs.rm(job.final, { force: true }).catch(() => undefined)
    finishCleanup(job)
    return
  }
  if (!ok) {
    failJob(job, 'could not move the converted video into the cache')
    return
  }
  const now = new Date()
  await fs.utimes(job.final, now, now).catch(() => undefined)
  const source: PlayerSource = {
    path: job.final,
    mode: job.plan.mode,
    duration: job.duration,
    width: job.width,
    height: job.height,
    chapters: job.chapters,
    subtitles: await readSubtitles(job.sourcePath).catch(() => [] as PlayerSubtitle[])
  }
  job.done = true
  jobs.delete(job.id)
  job.proc = null
  broadcast({ id: job.id, path: job.sourcePath, type: 'done', source }, job.owner)
  void pruneCache()
  // the fresh file is protected for a minute; prune again once it is old enough to evict
  setTimeout(() => void pruneCache(), 90_000)
}

function startJob(
  id: string,
  sourcePath: string,
  final: string,
  plan: ConvertPlan,
  probe: MediaProbe,
  owner: WebContents,
  hw: HwEncoder | undefined
): PlayerJobInfo {
  const temp = `${final}.part-${process.pid}-${Date.now()}.${plan.container}`
  const job: Job = {
    id,
    sourcePath,
    owner,
    plan,
    final,
    temp,
    proc: null,
    progress: 0,
    lastSent: 0,
    duration: probe.duration,
    width: probe.video?.width ?? 0,
    height: probe.video?.height ?? 0,
    chapters: chaptersOf(probe),
    stderr: '',
    cancelled: false,
    done: false
  }
  jobs.set(id, job)
  const exe = findBinary('ffmpeg')
  if (!exe) {
    failJob(job, 'FFmpeg was not found')
    return jobInfo(job)
  }
  let proc: ChildProcess
  try {
    proc = spawn(exe, ffmpegArgs(plan, sourcePath, temp, hw), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
  } catch (e) {
    failJob(job, e instanceof Error ? e.message : String(e))
    return jobInfo(job)
  }
  job.proc = proc
  let out = ''
  proc.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString()
    const nl = out.lastIndexOf('\n')
    if (nl < 0) return
    const lines = out.slice(0, nl)
    out = out.slice(nl + 1)
    const progress = parseFfmpegProgress(lines, job.duration)
    if (progress === null) return
    job.progress = Math.max(job.progress, progress)
    const now = Date.now()
    if (now - job.lastSent > 200 || job.progress >= 99) {
      job.lastSent = now
      broadcast({ id: job.id, path: job.sourcePath, type: 'progress', progress: job.progress }, job.owner)
    }
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    job.stderr = (job.stderr + chunk.toString()).slice(-8000)
  })
  proc.on('error', (e) => failJob(job, e.message))
  proc.on('close', (code) => {
    if (job.done) return
    if (code === 0) void completeJob(job)
    else failJob(job, job.stderr.trim() || `FFmpeg exited with code ${String(code)}`)
  })
  return jobInfo(job)
}

/**
 * Open a video for the embedded player: native files go straight to the element; unsupported
 * containers/codecs are remuxed or transcoded once into `video-cache`, with live progress.
 */
export async function openPlayerFile(file: string, owner: WebContents): Promise<PlayerOpen> {
  if (!path.isAbsolute(file) || !isVideoFile(file)) {
    return { kind: 'unsupported', error: 'invalid video path' }
  }
  const st = await fs.stat(file).catch(() => null)
  if (!st?.isFile() || st.size === 0) return { kind: 'unsupported', error: 'the file is empty' }
  await initPlayer()

  const ext = path.extname(file).slice(1).toLowerCase()
  const probe = await probeMedia(file)
  if (!probe) {
    // Chromium can still play the common containers itself without ffprobe.
    if (NATIVE_DIRECT.has(ext)) {
      return { kind: 'ready', source: await sourceFor(file, 'direct', null) }
    }
    return {
      kind: 'unsupported',
      error: findBinary('ffprobe') ? 'probe-failed' : 'ffprobe-missing'
    }
  }

  const encoders = await encoderSupport()
  const plan = choosePlayback(probe, { ext, encoders })
  if (plan.mode === 'direct') {
    return { kind: 'ready', source: await sourceFor(file, 'direct', probe) }
  }
  if (plan.mode === 'unsupported' && plan.reason === 'no-video') {
    return { kind: 'unsupported', error: plan.reason }
  }
  if (!findBinary('ffmpeg')) return { kind: 'unsupported', error: 'ffmpeg-missing' }
  if (plan.mode === 'unsupported') return { kind: 'unsupported', error: plan.reason }

  const key = cacheKey(file, st, plan)
  const id = key
  const running = jobs.get(id)
  if (running) {
    running.owner = owner
    return { kind: 'preparing', job: jobInfo(running) }
  }

  const dir = cacheDir()
  const final = path.join(dir, `${key}.${plan.container}`)
  const hit = await fs.stat(final).catch(() => null)
  if (hit?.isFile()) {
    const now = new Date()
    await fs.utimes(final, now, now).catch(() => undefined)
    return { kind: 'ready', source: { ...(await sourceFor(file, plan.mode, probe)), path: final } }
  }
  await ensureCache()
  return { kind: 'preparing', job: startJob(id, file, final, plan, probe, owner, encoders.hw) }
}

/** Save one frame beside the video through FFmpeg, so the canvas never has to be untainted. */
export async function saveVideoFrame(file: string, at: number): Promise<{ path: string } | { error: string }> {
  if (!path.isAbsolute(file) || !isVideoFile(file)) return { error: 'invalid video path' }
  if (!Number.isFinite(at) || at < 0) return { error: 'invalid frame position' }
  if (!findBinary('ffmpeg')) return { error: 'FFmpeg was not found' }
  const out = await freeName(path.join(path.dirname(file), `${path.basename(file, path.extname(file))}-frame.png`))
  const ok = await videoFrame(file, out, 1920, 0, at)
  if (!ok) {
    await fs.rm(out, { force: true }).catch(() => undefined)
    return { error: 'FFmpeg could not extract this frame' }
  }
  return { path: out }
}

export function cancelPlayerJob(id: string): boolean {
  const job = jobs.get(id)
  if (!job) return false
  job.cancelled = true
  job.done = true
  jobs.delete(id)
  if (job.proc && !job.proc.killed) job.proc.kill('SIGKILL')
  job.proc = null
  void fs.rm(job.temp, { force: true }).catch(() => undefined)
  return true
}

/** Called from `will-quit`: never leave a transcoder behind. */
export function stopPlayerJobs(): void {
  for (const job of jobs.values()) {
    job.cancelled = true
    job.done = true
    if (job.proc && !job.proc.killed) job.proc.kill('SIGKILL')
    void fs.rm(job.temp, { force: true }).catch(() => undefined)
  }
  jobs.clear()
}

export { ffmpegCapabilities }
