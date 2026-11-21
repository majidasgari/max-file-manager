/**
 * A file list another application put on the clipboard.
 *
 * Every desktop ships its own flavour — `text/uri-list` (KDE, Dolphin), `x-special/gnome-copied-files`
 * (GNOME: a `copy`/`cut` header line followed by URIs), `public.file-url` (Finder) and CF_HDROP
 * (`FileNameW` on Windows, turned into a path list before it reaches here). One parser keeps the
 * shape identical, so a paste from Explorer behaves like a paste from Finder.
 */
export type ClipFiles = { paths: string[]; cut: boolean }

const toPath = (raw: string): string => {
  const t = raw.trim()
  if (!t) return ''
  if (!t.startsWith('file://')) return t
  try {
    const p = decodeURIComponent(new URL(t).pathname)
    // a file URL on Windows is `/C:/dir/a.txt`
    return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p
  } catch {
    return ''
  }
}

export function parseClipText(text: string): ClipFiles {
  const paths: string[] = []
  let cut = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    // GNOME puts the intent on its own first line
    if (t === 'cut') {
      cut = true
      continue
    }
    if (t === 'copy') continue
    const p = toPath(t)
    if (p && !paths.includes(p)) paths.push(p)
  }
  return { paths, cut }
}

/** Merge several flavours of the same clipboard; a `cut` anywhere wins. */
export function mergeClipTexts(texts: string[]): ClipFiles {
  const paths: string[] = []
  let cut = false
  for (const text of texts) {
    const one = parseClipText(text)
    cut = cut || one.cut
    for (const p of one.paths) if (!paths.includes(p)) paths.push(p)
  }
  return { paths, cut }
}
