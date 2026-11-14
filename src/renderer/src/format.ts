import { getLang, t } from './i18n.ts'
import { isHtmlPath } from './html.ts'
import type { Entry } from './api.ts'

export type SortKey =
  | 'name'
  | 'size'
  | 'mtime'
  | 'ext'
  | 'mode'
  | 'owner'
  | 'links'
  | 'dims'
  | 'rating'

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹'

/** Persian digits for anything the user reads; paths and file names stay untouched. */
export const fa = (s: string | number): string =>
  getLang() === 'fa' ? String(s).replace(/[0-9]/g, (d) => FA_DIGITS[+d]) : String(s)

const UNITS = ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت', 'ترابایت', 'پتابایت']

/** Persian civil (Jalali) date from a unix ms timestamp — the conversion users actually read. */
export function toJalali(ms: number): [number, number, number] {
  const d = new Date(ms)
  let gy = d.getFullYear()
  const gm = d.getMonth() + 1
  const gd = d.getDate()
  const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
  let jy = gy <= 1600 ? 0 : 979
  gy -= gy <= 1600 ? 621 : 1600
  const gy2 = gm > 2 ? gy + 1 : gy
  let days =
    365 * gy +
    Math.floor((gy2 + 3) / 4) -
    Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) -
    80 +
    gd +
    gdm[gm - 1]
  jy += 33 * Math.floor(days / 12053)
  days %= 12053
  jy += 4 * Math.floor(days / 1461)
  days %= 1461
  if (days > 365) {
    jy += Math.floor((days - 1) / 365)
    days = (days - 1) % 365
  }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30)
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30)
  return [jy, jm, jd]
}

export type SizeFormat = 'human' | 'bytes'
export type DateFormat = 'iso' | 'jalali' | 'short'

/** Human size; folders report nothing unless their size was computed. */
export function fmtSize(bytes: number, dir: boolean, format: SizeFormat = 'human'): string {
  if (dir) return ''
  if (format === 'bytes') return `${fa(bytes)} ${t('بایت')}`
  if (!bytes) return `${fa(0)} ${t(UNITS[0])}`
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const v = bytes / 1024 ** i
  const n = i === 0 ? String(v) : v.toFixed(v < 10 ? 1 : 0).replace('.', getLang() === 'fa' ? t('٫') : '.')
  return `${fa(n)} ${t(UNITS[i])}`
}

/** ۲۰۲۶-۱۱-۱۱ ۰۱:۰۵ (میلادی) · ۱۴۰۵-۰۸-۲۰ (شمسی) · ۰۱:۰۵ امروز (کوتاه) */
export function fmtDate(ms: number, format: DateFormat = 'iso', seconds = false): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  const time = `${p(d.getHours())}:${p(d.getMinutes())}${seconds ? ':' + p(d.getSeconds()) : ''}`
  if (format === 'jalali') {
    const [jy, jm, jd] = toJalali(ms)
    return fa(`${jy}-${p(jm)}-${p(jd)} ${time}`)
  }
  if (format === 'short') return fa(time)
  return fa(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time}`)
}

export type PermLevel = 'rw' | 'r' | 'none'

const PERM_SHIFT = [6, 3, 0]

/** One permission class (0 owner, 1 group, 2 others) as the permissions table shows it. */
export function permLevel(mode: number, cls: 0 | 1 | 2): PermLevel {
  const shift = PERM_SHIFT[cls]
  const read = (mode >> shift) & 4
  const write = (mode >> shift) & 2
  return read && write ? 'rw' : read ? 'r' : 'none'
}

/**
 * New mode for one class. Folders need x to be entered, so it follows read; on files the
 * existing execute bit is kept (the dialog has a separate «Is executable» switch).
 */
export function permMode(mode: number, cls: 0 | 1 | 2, level: PermLevel, dir: boolean): number {
  const shift = PERM_SHIFT[cls]
  const base = level === 'rw' ? 6 : level === 'r' ? 4 : 0
  const exec = level === 'none' ? 0 : dir ? 1 : (mode >> shift) & 1
  return (mode & ~(7 << shift)) | ((base | exec) << shift)
}

/** Unix mode bits → rwxr-xr-x */
export function modeString(mode: number): string {
  const bits = ['r', 'w', 'x']
  let out = ''
  for (let i = 8; i >= 0; i--) out += mode & (1 << i) ? bits[(8 - i) % 3] : '-'
  return out
}

export type Crumb = { name: string; path: string }

/** Breadcrumb segments for POSIX and Windows paths. */
export function crumbs(p: string): Crumb[] {
  const win = /^[A-Za-z]:[\\/]/.test(p)
  const parts = p.split(/[\\/]+/).filter(Boolean)
  if (win) {
    const out: Crumb[] = [{ name: parts[0], path: parts[0] + '\\' }]
    let acc = parts[0] + '\\'
    for (const s of parts.slice(1)) {
      acc = acc.endsWith('\\') ? acc + s : acc + '\\' + s
      out.push({ name: s, path: acc })
    }
    return out
  }
  const out: Crumb[] = [{ name: '/', path: '/' }]
  let acc = ''
  for (const s of parts) {
    acc += '/' + s
    out.push({ name: s, path: acc })
  }
  return out
}

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Folders always first (Directory Opus default), then the chosen column. */
export function sortEntries(
  entries: Entry[],
  key: SortKey,
  asc: boolean,
  foldersFirst = true,
  ratings?: Record<string, number>
): Entry[] {
  const dir = asc ? 1 : -1
  const num = (x: number | undefined) => x ?? 0
  return [...entries].sort((a, b) => {
    if (foldersFirst && a.dir !== b.dir) return a.dir ? -1 : 1
    if (key === 'size' && a.size !== b.size) return (a.size - b.size) * dir
    if (key === 'mtime' && a.mtime !== b.mtime) return (a.mtime - b.mtime) * dir
    if (key === 'ext' && a.ext !== b.ext) return COLLATOR.compare(a.ext, b.ext) * dir
    if (key === 'mode' && num(a.mode) !== num(b.mode)) return (num(a.mode) - num(b.mode)) * dir
    if (key === 'owner' && num(a.uid) !== num(b.uid)) return (num(a.uid) - num(b.uid)) * dir
    if (key === 'links' && num(a.nlink) !== num(b.nlink)) return (num(a.nlink) - num(b.nlink)) * dir
    if (key === 'dims' && num(a.w) * num(a.h) !== num(b.w) * num(b.h)) {
      return (num(a.w) * num(a.h) - num(b.w) * num(b.h)) * dir
    }
    if (key === 'rating' && num(ratings?.[a.name]) !== num(ratings?.[b.name])) {
      return (num(ratings?.[a.name]) - num(ratings?.[b.name])) * dir
    }
    return COLLATOR.compare(a.name, b.name) * (key === 'name' ? dir : 1)
  })
}

/** What the pane shows: live name filter, then sort. */
export function orderEntries(
  entries: Entry[],
  key: SortKey,
  asc: boolean,
  filter = '',
  foldersFirst = true,
  pins?: Set<string>,
  labels?: Record<string, string>,
  ratings?: Record<string, number>
): Entry[] {
  const q = filter.trim().toLowerCase()
  // `#red` keeps only that label; `*3` keeps files rated 3 or more
  let kept = q
    ? entries.filter((e) => {
        if (q.startsWith('#')) return (labels?.[e.name] ?? '').includes(q.slice(1))
        if (q.startsWith('*')) {
          const min = Number(q.slice(1)) || 0
          return (ratings?.[e.name] ?? 0) >= min
        }
        return e.name.toLowerCase().includes(q)
      })
    : entries
  // folders first is meaningful for name and size; date/owner/… interleave everything
  const groupFolders = key === 'name' || key === 'size'
  const sorted = sortEntries(kept, key, asc, groupFolders ? foldersFirst : false, ratings)
  if (!pins || !pins.size) return sorted
  // pinned names float to the very top, keeping the sort order among themselves
  const pinned = sorted.filter((e) => pins.has(e.name))
  if (!pinned.length) return sorted
  return [...pinned, ...sorted.filter((e) => !pins.has(e.name))]
}

export function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, '')
  return s.split(/[\\/]/).pop() || s
}

/**
 * Small cached thumbnail for grid tiles; falls back to mfm:// for non-images.
 *
 * `version` is the entry's mtime+size. Putting it in the URL is what makes a replaced file show a
 * new picture: the browser keys its image cache by URL, so with a bare path it served the old
 * thumbnail for a day. The server's cache key already includes mtime/size, so an unchanged file
 * never regenerates anything — no polling and no watcher needed.
 */
export function thumbUrl(p: string, side = 256, version = ''): string {
  const segs = p.split(/[\\/]/).map((s) => (/^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)))
  return `thumb://local${segs.join('/')}?s=${side}${version ? `&v=${encodeURIComponent(version)}` : ''}`
}

/** Local file → the mfm:// URL the renderer may load in <img>. */
export function mediaUrl(p: string): string {
  const segs = p.split(/[\\/]/).map((s) => (/^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)))
  const tail = segs.join('/')
  return `mfm://local${tail.startsWith('/') ? '' : '/'}${tail}`
}

/** Which entries a context-menu action applies to: the whole selection or the row clicked. */
export function menuTargets(selection: string[], path: string | null): string[] {
  if (!path) return selection
  return selection.includes(path) ? selection : [path]
}

/** Local path → the `file://` URI external apps expect on a drag (`text/uri-list`). */
export function fileUri(p: string): string {
  const segs = p.split(/[\\/]/).map((s) => (/^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)))
  const tail = segs.join('/')
  return `file://${tail.startsWith('/') ? '' : '/'}${tail}`
}

/**
 * Chrome's non-standard `DownloadURL` drag type. Native apps (Telegram, Dolphin) read the
 * `text/uri-list`, but a browser drop zone only fills `dataTransfer.files` when the drag also
 * offers this — a `text/uri-list` from another Chromium window stays plain text for security.
 * VSCode uses the same type to keep in-app HTML5 drops working.
 */
export function downloadUrl(p: string): string {
  const name = (p.split(/[\\/]/).pop() || 'file').replace(/:/g, '_')
  return `application/octet-stream:${name}:${fileUri(p)}`
}

export type Kind = 'dir' | 'image' | 'video' | 'audio' | 'archive' | 'text' | 'doc' | 'pdf' | 'sheet' | 'slides' | 'code' | 'file'

const KIND: Record<string, Kind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  bmp: 'image', avif: 'image', ico: 'image',
  mp4: 'video', mkv: 'video', mov: 'video', webm: 'video', avi: 'video',
  mp3: 'audio', flac: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', opus: 'audio',
  zip: 'archive', tar: 'archive', gz: 'archive', xz: 'archive', '7z': 'archive',
  rar: 'archive', bz2: 'archive', zst: 'archive',
  txt: 'text', md: 'text', log: 'text', rtf: 'text',
  doc: 'doc', docx: 'doc', odt: 'doc', pdf: 'pdf',
  xls: 'sheet', xlsx: 'sheet', csv: 'sheet', ods: 'sheet',
  ppt: 'slides', pptx: 'slides', odp: 'slides',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', py: 'code', rs: 'code', c: 'code', h: 'code',
  cpp: 'code', hpp: 'code', java: 'code', go: 'code', rb: 'code', sh: 'code', css: 'code',
  html: 'code', json: 'code', yml: 'code', yaml: 'code', toml: 'code', sql: 'code'
}

export const kindOfExt = (ext: string): Kind => KIND[ext.toLowerCase()] ?? 'file'
export const kindOf = (e: Entry): Kind => (e.dir ? 'dir' : kindOfExt(e.ext))

/** Persian source names; translated at call time so the language can change at runtime. */
const LABEL: Record<Kind, string> = {
  dir: 'پوشه', image: 'تصویر', video: 'ویدئو', audio: 'صدا', archive: 'بایگانی',
  text: 'متن', doc: 'سند', pdf: 'PDF', sheet: 'صفحه گسترده', slides: 'ارائه',
  code: 'کد', file: 'فایل'
}

/** Persian type name; unknown extensions show themselves instead of a useless «فایل». */
export function typeLabel(e: Entry): string {
  const k = kindOf(e)
  return k === 'file' && e.ext ? e.ext.toUpperCase() : kindLabel(k)
}

/** Translated name of a kind, for aggregated charts where there is no single entry. */
export const kindLabel = (k: Kind): string => t(LABEL[k])

export const isImage = (ext: string): boolean => KIND[ext] === 'image'

/** Files the built-in editor is the right default app for; no extension counts as text. */
const EDITOR_EXT = new Set(['txt', 'text', 'log', 'md', 'markdown', 'mdx', 'rst'])

export const opensInEditor = (e: Pick<Entry, 'dir' | 'ext'>): boolean =>
  !e.dir && (e.ext === '' || EDITOR_EXT.has(e.ext.toLowerCase()))

/** One keystroke of list/grid navigation. */
export type NavMove = 'up' | 'down' | 'left' | 'right' | 'pageUp' | 'pageDown' | 'first' | 'last'

/**
 * Next focused entry: in a grid `cols` rows step sideways, a page is one viewport.
 * Always clamped, so End/PgDn on the last row never runs past the list.
 */
export function navIndex(cur: number, move: NavMove, count: number, cols = 1, pageRows = 1): number {
  if (count <= 0) return -1
  if (cur < 0) return move === 'last' ? count - 1 : 0
  const step = Math.max(1, Math.min(cols, count))
  const page = Math.max(1, pageRows) * step
  const target: Record<NavMove, number> = {
    up: cur - step,
    down: cur + step,
    left: cur - 1,
    right: cur + 1,
    pageUp: cur - page,
    pageDown: cur + page,
    first: 0,
    last: count - 1
  }
  return Math.max(0, Math.min(count - 1, target[move]))
}

/** Formats the archive reader understands (zip + tar family). */
export const isArchiveName = (name: string): boolean =>
  /\.(zip|tar|tgz|tar\.gz|tar\.bz2|tbz2)$/i.test(name)

export type OpenAction = 'navigate' | 'external' | 'archive' | 'preview' | 'gallery' | 'editor'

/**
 * What a double-click on an entry should do.
 *
 * Kept pure so the preference can be tested. «Run» is the user's explicit request for the system
 * app, so it wins over the per-type defaults (HTML preview, built-in editor); Preview and Gallery
 * keep their specialised behaviour for everything that is not an image or a document.
 */
export function openAction(
  e: Pick<Entry, 'dir' | 'name' | 'ext' | 'path'>,
  mode: 'open' | 'gallery' | 'preview',
  opts: { hasDefaultApp?: boolean; virtual?: boolean } = {}
): OpenAction {
  if (e.dir) return 'navigate'
  if (opts.hasDefaultApp) return 'external'
  if (isArchiveName(e.name)) return 'archive'
  if (mode === 'open') return 'external'
  if (mode === 'preview') return 'preview'
  if (isHtmlPath(e.path) && !opts.virtual) return 'preview'
  if (isImage(e.ext) && mode === 'gallery') return 'gallery'
  if (opensInEditor(e) && !opts.virtual) return 'editor'
  return 'external'
}

/** POSIX or Windows: parent folder of a path, keeping its own separator. */
export function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i < 0) return ''
  if (i === 0) return p.slice(0, 1)
  return p.slice(0, i)
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name
  return /[\\/]$/.test(dir) ? dir + name : dir + (dir.includes('\\') ? '\\' : '/') + name
}

/**
 * The folder «terminal here» must start in. A clicked folder wins; a file always means its own
 * folder (flat and search results can point outside the tab), and inside an archive listing the
 * archive's own folder is the only real directory.
 */
export function terminalDir(
  path: string | null,
  isDir: boolean,
  archive: string | null,
  tabPath: string
): string {
  if (path && isDir) return path
  if (archive) return dirOf(archive)
  return dirOf(path ?? tabPath)
}


/** Group number for duplicate results; anything else shows its type. */
export const groupLabel = (e: Entry): string =>
  e.group ? t('گروه {n}', { n: fa(e.group) }) : typeLabel(e)

export type RenameMode = 'template' | 'regex'
export type RenameOpts = {
  mode: RenameMode
  /** template tokens: {name} {ext} {n} {nn} */
  template: string
  find: string
  replace: string
  start: number
  pad: number
  /** per-file tags (ID3/EXIF) for `{title} {artist} {album} {year} {date} {camera}` */
  tags?: Record<string, Record<string, string>>
}

/**
 * Batch-rename planner: takes base names, returns the new base names in the same order.
 * Pure so the dialog can preview exactly what will happen before touching a file.
 */
export function planRename(names: string[], o: RenameOpts): string[] {
  if (o.mode === 'regex') {
    let re: RegExp
    try {
      re = new RegExp(o.find, 'g')
    } catch {
      return [...names] // an invalid pattern must not rename anything
    }
    return names.map((n) => n.replace(re, o.replace))
  }
  return names.map((n, i) => {
    const dot = n.lastIndexOf('.')
    const base = dot > 0 ? n.slice(0, dot) : n
    const ext = dot > 0 ? n.slice(dot + 1) : ''
    const num = o.start + i
    const tag = o.tags?.[n] ?? {}
    const out = o.template
      .replace(/\{name\}/g, base)
      .replace(/\{ext\}/g, ext)
      .replace(/\{title\}/g, tag.title ?? base)
      .replace(/\{artist\}/g, tag.artist ?? '')
      .replace(/\{album\}/g, tag.album ?? '')
      .replace(/\{year\}/g, tag.year ?? '')
      .replace(/\{date\}/g, (tag.date ?? '').slice(0, 10))
      .replace(/\{camera\}/g, tag.camera ?? '')
      .replace(/\{nn\}/g, String(num).padStart(Math.max(1, o.pad), '0'))
      .replace(/\{n\}/g, String(num))
    return ext && !out.toLowerCase().endsWith('.' + ext.toLowerCase()) ? `${out}.${ext}` : out
  })
}



/** The folders every desktop expects to be searchable by default. */
export function defaultSearchRoots(home: string): string[] {
  if (!home) return []
  return ['Documents', 'Downloads', 'Desktop', 'Pictures', 'Music', 'Videos'].map((d) => joinPath(home, d))
}

/** Reorders an item in an array by placing it before or after a target index. */
export function reorderItem<T>(list: T[], from: number, to: number, place: 'before' | 'after'): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list
  if (from === to) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  let targetIndex = to
  if (from < to) {
    targetIndex = place === 'before' ? to - 1 : to
  } else {
    targetIndex = place === 'before' ? to : to + 1
  }
  targetIndex = Math.max(0, Math.min(next.length, targetIndex))
  next.splice(targetIndex, 0, item)
  return next
}

/** Matches a file or directory path against a custom command pattern (extension, folder, or wildcard). */
export function matchCustomCommand(cmd: { pattern: string }, targetPath: string, isDir: boolean): boolean {
  if (!cmd?.pattern) return false
  const rawPatterns = cmd.pattern
    .split(/[,;\s]+/)
    .map((p) => p.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
  if (isDir) {
    return rawPatterns.some((p) => p === 'folder' || p === 'dir' || p === 'directory' || p === '*' || p === 'پوشه')
  }
  const ext = targetPath.split('.').pop()?.toLowerCase() ?? ''
  return rawPatterns.some((p) => p === ext || p === '*' || p === 'all' || p === 'file')
}

export type GroupKey = 'none' | 'name' | 'type' | 'size' | 'date' | 'ext'
export type EntryGroup = { key: string; label: string; entries: Entry[] }

const NAME_GROUPS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Dolphin-style grouping: «A»…«Z» and a bucket for digits/symbols. */
function nameGroupOf(name: string): string {
  const first = [...name.trim()][0]?.toUpperCase() ?? ''
  return NAME_GROUPS.includes(first) ? first : '#'
}

function sizeGroupOf(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return 'lt1'
  if (mb < 10) return 'lt10'
  if (mb < 100) return 'lt100'
  if (mb < 1024) return 'lt1024'
  return 'gte1024'
}

function dateGroupOf(ms: number, now: number): string {
  const day = 86_400_000
  const date = new Date(ms)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (ms >= startOfToday) return 'today'
  if (ms >= startOfToday - day) return 'yesterday'
  if (ms >= startOfToday - 7 * day) return 'week'
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth()) return 'month'
  if (date.getFullYear() === today.getFullYear()) return 'year'
  return 'older'
}

const SIZE_LABELS: Record<string, string> = {
  folders: 'پوشه‌ها',
  lt1: 'کمتر از ۱ مگابایت',
  lt10: '۱ تا ۱۰ مگابایت',
  lt100: '۱۰ تا ۱۰۰ مگابایت',
  lt1024: '۱۰۰ مگابایت تا ۱ گیگابایت',
  gte1024: 'بیشتر از ۱ گیگابایت'
}
const SIZE_ORDER = ['folders', 'lt1', 'lt10', 'lt100', 'lt1024', 'gte1024']

const DATE_LABELS: Record<string, string> = {
  today: 'امروز',
  yesterday: 'دیروز',
  week: '۷ روز گذشته',
  month: 'این ماه',
  year: 'امسال',
  older: 'قدیمی‌تر'
}
const DATE_ORDER = ['today', 'yesterday', 'week', 'month', 'year', 'older']

const groupKeyFor = (e: Entry, mode: GroupKey, now: number): string => {
  if (mode === 'name') return nameGroupOf(e.name)
  if (mode === 'type') return e.dir ? 'dir' : kindOf(e)
  if (mode === 'ext') return e.dir ? 'dir' : (e.ext || 'none').toLowerCase()
  if (mode === 'size') return e.dir ? 'folders' : sizeGroupOf(e.size)
  if (mode === 'date') return dateGroupOf(e.mtime, now)
  return ''
}

export const groupHeading = (key: string, mode: GroupKey): string => {
  if (mode === 'name') return key
  if (mode === 'type') return key === 'dir' ? t('پوشه') : kindLabel(key as Kind)
  if (mode === 'ext') return key === 'dir' ? t('پوشه') : key === 'none' ? t('بدون پسوند') : key.toUpperCase()
  if (mode === 'size') return t(SIZE_LABELS[key] ?? key)
  if (mode === 'date') return t(DATE_LABELS[key] ?? key)
  return key
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Split an already-sorted listing into contiguous groups. Order inside a group is preserved, and
 * the group order is the one people expect (A…Z, today → older, small → large), not alphabetical.
 */
export function groupEntries(entries: Entry[], mode: GroupKey, now = Date.now()): EntryGroup[] {
  if (mode === 'none') return entries.length ? [{ key: '', label: '', entries }] : []
  const buckets = new Map<string, Entry[]>()
  for (const e of entries) {
    const key = groupKeyFor(e, mode, now)
    const row = buckets.get(key)
    if (row) row.push(e)
    else buckets.set(key, [e])
  }
  const keys = [...buckets.keys()]
  let ordered: string[]
  if (mode === 'name') ordered = keys.sort((a, b) => (a === '#' ? -1 : b === '#' ? 1 : collator.compare(a, b)))
  else if (mode === 'size') ordered = SIZE_ORDER.filter((k) => buckets.has(k))
  else if (mode === 'date') ordered = DATE_ORDER.filter((k) => buckets.has(k))
  else if (mode === 'type' || mode === 'ext') {
    // folders are their own group and always come first, exactly like the listing itself
    ordered = keys.sort((a, b) =>
      a === 'dir' ? -1 : b === 'dir' ? 1 : collator.compare(groupHeading(a, mode), groupHeading(b, mode))
    )
  } else ordered = keys.sort((a, b) => collator.compare(groupHeading(a, mode), groupHeading(b, mode)))
  return ordered.map((key) => ({ key, label: groupHeading(key, mode), entries: buckets.get(key)! }))
}

/**
 * Global «ignore these file names» list (Settings → File display). Dolphin and Explorer leave
 * metadata files behind — .directory, desktop.ini — that nobody wants to see in a listing.
 * Patterns are file names, not paths, and `*`/`?` are allowed.
 */
export function isIgnoredName(name: string, patterns: string[]): boolean {
  if (!name || !patterns.length) return false
  const lower = name.toLowerCase()
  for (const raw of patterns) {
    const p = raw.trim().toLowerCase()
    if (!p) continue
    if (!/[*?]/.test(p)) {
      if (lower === p) return true
      continue
    }
    const rx = new RegExp(
      '^' +
        p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') +
        '$'
    )
    if (rx.test(lower)) return true
  }
  return false
}

/**
 * Custom bookmark titles, keyed by the folder path. They are display names only — the bookmark
 * itself stays a path, so renaming one never touches the disk.
 */
export function cleanMarkNames(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue
    const name = value.trim().slice(0, 80)
    if (!key || !name || key.length > 4096) continue
    out[key] = name
    if (Object.keys(out).length >= 500) break
  }
  return out
}
