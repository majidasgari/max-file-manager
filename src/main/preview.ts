import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isVideoFile } from './player-core.ts'

export type PreviewKind = 'dir' | 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'binary'
export type Preview = {
  kind: PreviewKind
  size: number
  mtime: number
  text?: string
  /** the text/image was cut at the size cap */
  capped?: boolean
}

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'])
const AUDIO = new Set(['mp3', 'flac', 'wav', 'ogg', 'm4a', 'opus'])
// office documents never get a textual preview: they open in the desktop app, like any other
// unknown binary file. Kept as an extension guard so a renamed/plain-text .docx is not read as text.
const NO_PREVIEW = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'])

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
