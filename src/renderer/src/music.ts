/**
 * The embedded music player's state, kept outside React and outside the preview pane.
 *
 * One `<audio>` serves the whole window and is created on the first play, so closing the preview
 * pane, selecting another file or unmounting any panel never interrupts playback. Nothing here
 * allocates until something is played, and `disposeMusic` gives it all back when the module is off.
 */
import { mediaUrl, seekTarget } from './format.ts'

export type Music = {
  /** absolute paths, in playlist order */
  items: string[]
  /** -1 when nothing is loaded */
  index: number
  playing: boolean
  /** while true the panel owns the preview slot and no other preview is fetched */
  open: boolean
  /** the last play() was rejected (missing file, unsupported codec) */
  error: boolean
  /** playback position in seconds, kept live by the element's timeupdate */
  pos: number
  /** track length in seconds, 0 until the metadata arrives */
  dur: number
}

export const NO_MUSIC: Music = {
  items: [],
  index: -1,
  playing: false,
  open: false,
  error: false,
  pos: 0,
  dur: 0
}

let state: Music = NO_MUSIC
let audio: HTMLAudioElement | null = null
let persist = (_paths: string[]): void => undefined
const subs = new Set<() => void>()

const set = (patch: Partial<Music>): void => {
  state = { ...state, ...patch }
  for (const fn of subs) fn()
}

export const musicState = (): Music => state

export const subscribeMusic = (fn: () => void): (() => void) => {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}

/** Where «save» writes: the prefs writer in App, the only owner of prefs. */
export const bindMusicSave = (fn: (paths: string[]) => void): void => {
  persist = fn
}

/** The same track twice is never what was meant; the order of the existing list is kept. */
export function addTracks(list: string[], paths: string[]): string[] {
  const out = [...list]
  for (const p of paths) if (!out.includes(p)) out.push(p)
  return out
}

/** -1 means there is no such track (past either end of the list). */
export function stepIndex(list: string[], index: number, step: number): number {
  const next = index + step
  return next >= 0 && next < list.length ? next : -1
}

const element = (): HTMLAudioElement => {
  if (!audio) {
    audio = new Audio()
    audio.preload = 'metadata'
    // attached (invisible) so the element is inspectable from the page and counts as window media
    audio.style.display = 'none'
    document.body.append(audio)
    audio.addEventListener('ended', () => {
      const next = stepIndex(state.items, state.index, 1)
      if (next >= 0) playAt(next)
      else set({ playing: false })
    })
    audio.addEventListener('play', () => set({ playing: true }))
    audio.addEventListener('pause', () => set({ playing: false }))
    audio.addEventListener('error', () => set({ playing: false, error: true }))
    audio.addEventListener('timeupdate', () => set({ pos: audio!.currentTime }))
    audio.addEventListener('loadedmetadata', () =>
      set({ dur: Number.isFinite(audio!.duration) ? audio!.duration : 0 })
    )
    audio.addEventListener('durationchange', () =>
      set({ dur: Number.isFinite(audio!.duration) ? audio!.duration : 0 })
    )
  }
  return audio
}

export function playAt(index: number): void {
  const path = state.items[index]
  if (!path) return
  const el = element()
  // Only a real source change resets the clock: replaying the loaded track keeps its known
  // duration, since `loadedmetadata` would not fire again for the same `src`.
  const changed = index !== state.index || !el.src
  if (changed) el.src = mediaUrl(path)
  set({ index, open: true, error: false, ...(changed ? { pos: 0, dur: 0 } : {}) })
  void el.play().catch(() => set({ playing: false, error: true }))
}

export function toggleMusic(): void {
  if (state.playing) audio?.pause()
  else playAt(state.index >= 0 ? state.index : 0)
}

export function stepMusic(step: number): void {
  const next = stepIndex(state.items, state.index, step)
  if (next >= 0) playAt(next)
}

/** Jumps inside the loaded track; ignored until the duration is known. */
export function seekMusic(sec: number): void {
  if (!audio || !state.dur) return
  const at = seekTarget(sec, state.dur)
  audio.currentTime = at
  set({ pos: at })
}

/** Appends and starts the first track when nothing was loaded yet. */
export function addMusic(paths: string[]): void {
  const items = addTracks(state.items, paths)
  const empty = state.index < 0
  set({ items, open: true })
  if (empty && items.length) playAt(0)
}

/** Replaces the list with a playlist file's tracks (not saved) and starts the first one. */
export function openMusicPlaylist(paths: string[]): void {
  const items = addTracks([], paths)
  if (!items.length) return
  set({ items, index: -1, open: true, error: false, pos: 0, dur: 0 })
  playAt(0)
}

export function removeMusic(index: number): void {
  const items = state.items.filter((_, i) => i !== index)
  if (!items.length) {
    clearMusic()
    return
  }
  const wasPlaying = index === state.index
  if (wasPlaying && audio) {
    audio.pause()
    audio.removeAttribute('src')
  }
  set({ items, index: wasPlaying ? -1 : index < state.index ? state.index - 1 : state.index })
  // whatever took its place continues; at the end of the list that is the new last track
  if (wasPlaying) playAt(Math.min(index, items.length - 1))
}

export function clearMusic(): void {
  if (audio) {
    audio.pause()
    audio.removeAttribute('src')
  }
  set({ ...NO_MUSIC })
}

/** Hides the panel and stops the sound; the list stays so play resumes where it was. */
export const closeMusic = (): void => {
  audio?.pause()
  set({ open: false, playing: false })
}

/** Shows the panel with whatever is loaded (the saved list after a restart, or nothing). */
export const openMusicPanel = (): void => set({ open: true })

export const saveMusic = (): void => persist(state.items)

/** Enabling loads the saved playlist; the audio element still waits for the first play. */
export function loadMusic(paths: string[]): void {
  if (!state.items.length) set({ items: addTracks([], paths) })
}

/** Turning the module off leaves nothing behind: no element, no source, no state. */
export function disposeMusic(): void {
  if (audio) {
    audio.pause()
    audio.removeAttribute('src')
    audio.remove()
    audio = null
  }
  state = { ...NO_MUSIC }
  for (const fn of subs) fn()
}
