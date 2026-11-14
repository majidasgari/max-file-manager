import { promises as fs } from 'node:fs'
import path from 'node:path'
import { freeName } from './ops.ts'

const DATA_URL = /^data:image\/(png|jpeg|webp|bmp);base64,([A-Za-z0-9+/=]+)$/
const MIME: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', bmp: 'bmp' }

/**
 * Writes an edited image the renderer produced on a canvas.
 * `overwrite` replaces the file atomically; otherwise a sibling `name-edit.ext` is created.
 */
export async function saveImage(
  src: string,
  dataUrl: string,
  mode: 'overwrite' | 'copy'
): Promise<{ path: string } | { error: string }> {
  const m = DATA_URL.exec(dataUrl)
  if (!m) return { error: 'دادهٔ تصویر نامعتبر است' }
  if (!path.isAbsolute(src)) return { error: 'مسیر نامعتبر' }
  const buf = Buffer.from(m[2], 'base64')
  if (!buf.length) return { error: 'تصویر خالی است' }

  const ext = MIME[m[1]] ?? 'png'
  const dir = path.dirname(src)
  const base = path.basename(src, path.extname(src))
  const target =
    mode === 'overwrite'
      ? src
      : await freeName(path.join(dir, `${base}-edit.${ext}`))

  const tmp = path.join(dir, `.mfm-save-${process.pid}-${Date.now()}`)
  try {
    await fs.writeFile(tmp, buf)
    await fs.rename(tmp, target)
    return { path: target }
  } catch (e: any) {
    await fs.rm(tmp, { force: true })
    return { error: String(e?.message ?? e) }
  }
}

/** Writes a converted image as `name.ext` (conversion, not an edit copy). */
export async function saveImageAs(
  src: string,
  dataUrl: string,
  dest?: string
): Promise<{ path: string } | { error: string }> {
  const m = DATA_URL.exec(dataUrl)
  if (!m) return { error: 'دادهٔ تصویر نامعتبر است' }
  if (!path.isAbsolute(src)) return { error: 'مسیر نامعتبر' }
  const buf = Buffer.from(m[2], 'base64')
  if (!buf.length) return { error: 'تصویر خالی است' }
  const ext = MIME[m[1]] ?? 'png'
  // «convert into the other pane» writes there; an invalid destination falls back beside the source
  const dir = dest && path.isAbsolute(dest) ? dest : path.dirname(src)
  const base = path.basename(src, path.extname(src))
  const target = await freeName(path.join(dir, `${base}.${ext}`))
  try {
    await fs.writeFile(target, buf)
    return { path: target }
  } catch (e: any) {
    return { error: String(e?.message ?? e) }
  }
}
