import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { applyAutoDirection, dirOfText } from './direction.ts'
import { highlightCode } from './highlight.ts'
import { isAbsolutePath, joinPath, mediaUrl, normalizePath } from './format.ts'

const marked = new Marked({ gfm: true, breaks: true })

// fenced code goes through highlight.js, everything else stays as marked wrote it
marked.use({
  renderer: {
    code({ text, lang }) {
      const out = highlightCode(text, lang || null)
      const cls = lang ? ` class="hljs language-${lang}"` : ' class="hljs"'
      return `<pre dir="ltr"><code dir="ltr"${cls}>${out}</code></pre>\n`
    }
  }
})

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

/**
 * `docs/screenshot.png` in a markdown file means "next to that markdown file", not "next to the
 * renderer's own URL". Local images therefore go through `mediaUrl`, exactly like every other
 * image surface in the app; absolute paths and remote/data URLs are already loadable as-is.
 */
export function resolveMdAsset(src: string, baseDir?: string): string {
  const value = String(src ?? '')
  if (!value || value.startsWith('#') || URI_SCHEME.test(value)) return value
  if (isAbsolutePath(value)) return mediaUrl(percentDecode(value))
  if (!baseDir) return value
  // marked percent-encodes spaces in `<a b.png>`, while mediaUrl encodes the real path itself
  return mediaUrl(normalizePath(joinPath(baseDir, percentDecode(value))))
}

function rewriteImageSources(html: string, baseDir: string): string {
  return html.replace(IMG_SRC, (_all, head: string, quote: string, src: string) => {
    const resolved = resolveMdAsset(decodeAttr(src), baseDir)
    return `${head}${quote}${escapeAttr(resolved)}${quote}`
  })
}

/**
 * markdown → sanitized HTML with per-block direction. Everything the editor shows and everything
 * the PDF export prints goes through here, so both always agree.
 */
export function renderMarkdown(text: string, baseDir?: string): string {
  let raw = marked.parse(text || '') as string
  // only `src` of images is touched: links, code and prose keep exactly what marked produced
  if (baseDir) raw = rewriteImageSources(raw, baseDir)
  return applyAutoDirection(
    DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true },
      // mfm:// is how every other surface in the app loads a local file
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|mfm):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i
    })
  )
}

export const firstDir = (text: string): 'rtl' | 'ltr' => dirOfText(text)
