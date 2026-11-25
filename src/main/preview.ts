import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isVideoFile } from './player-core.ts'
import { archiveKind, listArchive } from './archives.ts'

export type PreviewKind = 'dir' | 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'archive' | 'binary'

/** What an archive preview shows: the names inside it, capped, with the real count beside them. */
export type ArchivePreview = {
  entries: { name: string; size: number; dir: boolean }[]
  /** every entry in the archive, not just the ones handed over */
  count: number
  capped: boolean
  format?: string
  encrypted?: boolean
  error?: string
}

export type Preview = {
  kind: PreviewKind
  size: number
  mtime: number
  text?: string
  /** the text/image was cut at the size cap */
  capped?: boolean
  /** set for `kind: 'archive'` */
  archive?: ArchivePreview
}

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'])
const AUDIO = new Set(['mp3', 'flac', 'wav', 'ogg', 'm4a', 'opus'])
// office documents never get a textual preview: they open in the desktop app, like any other
// unknown binary file. Kept as an extension guard so a renamed/plain-text .docx is not read as text.
const NO_PREVIEW = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'])

/** A preview is a glance, not a listing: the panel shows this many names of a big archive. */
const ARCHIVE_PREVIEW_MAX = 500
/** Reading a tar family listing means decompressing the whole stream, so a huge one stays a file. */
const TAR_PREVIEW_MAX_BYTES = 64 * 1024 * 1024

async function previewArchive(p: string, size: number): Promise<ArchivePreview> {
  if (archiveKind(p) !== 'zip' && size > TAR_PREVIEW_MAX_BYTES) {
    return { entries: [], count: 0, capped: true, error: 'این آرشیو برای پیش‌نمایش بزرگ است' }
  }
  const listed = await listArchive(p)
  if (listed.error) {
    return { entries: [], count: 0, capped: false, format: listed.format, error: listed.error }
  }
  return {
    entries: listed.entries
      .slice(0, ARCHIVE_PREVIEW_MAX)
      .map((e) => ({ name: e.name, size: e.size, dir: !!e.dir })),
    count: listed.entries.length,
    capped: listed.capped || listed.entries.length > ARCHIVE_PREVIEW_MAX,
    format: listed.format,
    encrypted: listed.encrypted
  }
}

// shortcut: text previews stop at the configured cap (200 KB default) — upgrade to a paging reader when huge logs matter.
export async function preview(p: string, maxKB = 200): Promise<Preview> {
  const cap = Math.min(8192, Math.max(16, maxKB || 200)) * 1024
  const st = await fs.stat(p)
  if (st.isDirectory()) return { kind: 'dir', size: 0, mtime: st.mtimeMs }

  const ext = path.extname(p).slice(1).toLowerCase()
  const base = { size: st.size, mtime: st.mtimeMs }
  if (IMAGE.has(ext)) return { kind: 'image', ...base }
  if (ext === 'pdf') return { kind: 'pdf', ...base }
  if (NO_PREVIEW.has(ext)) return { kind: 'binary', ...base }
  if (AUDIO.has(ext)) return { kind: 'audio', ...base }
  if (isVideoFile(p)) return { kind: 'video', ...base }
  if (archiveKind(p)) return { kind: 'archive', ...base, archive: await previewArchive(p, st.size) }

  const fh = await fs.open(p, 'r').catch(() => null)
  if (!fh) return { kind: 'binary', ...base }
  try {
    const len = Math.min(cap, st.size)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)
    if (buf.subarray(0, 4096).includes(0)) return { kind: 'binary', ...base }
    return { kind: 'text', ...base, text: buf.toString('utf8'), capped: st.size > len }
  } finally {
    await fh.close()
  }
}
