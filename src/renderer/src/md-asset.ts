import { isAbsolutePath, joinPath, mediaUrl, normalizePath } from './format.ts'

/**
 * Relative image sources in a markdown file are resolved against that file's own folder, not the
 * renderer's URL. Kept free of the DOM (and of DOMPurify) so it can be tested in plain node.
 */

/** Any `<scheme>:` URL (http, data, mfm, …) is already resolved and must not be touched. */
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i

// marked writes image sources into the HTML it returns; these are the only attributes rewritten
const IMG_SRC = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi

const decodeAttr = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const escapeAttr = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

function percentDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** `docs/screenshot.png` in a markdown file lives next to that file; local paths go through mediaUrl. */
export function resolveMdAsset(src: string, baseDir?: string): string {
  const value = String(src ?? '')
  if (!value || value.startsWith('#') || URI_SCHEME.test(value)) return value
  if (isAbsolutePath(value)) return mediaUrl(percentDecode(value))
  if (!baseDir) return value
  // marked percent-encodes spaces in `<a b.png>`, while mediaUrl encodes the real path itself
  return mediaUrl(normalizePath(joinPath(baseDir, percentDecode(value))))
}

/** Only `<img src>` is rewritten: links, code and prose keep exactly what marked produced. */
export function rewriteImageSources(html: string, baseDir?: string): string {
  if (!baseDir) return html
  return html.replace(IMG_SRC, (_all, head: string, quote: string, src: string) => {
    const resolved = resolveMdAsset(decodeAttr(src), baseDir)
    return `${head}${quote}${escapeAttr(resolved)}${quote}`
  })
}
