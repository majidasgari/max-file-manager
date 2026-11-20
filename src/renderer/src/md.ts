import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { applyAutoDirection, dirOfText } from './direction.ts'
import { highlightCode } from './highlight.ts'
import { rewriteImageSources } from './md-asset.ts'

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

/**
 * markdown → sanitized HTML with per-block direction. Everything the editor shows and everything
 * the PDF export prints goes through here, so both always agree.
 */
export function renderMarkdown(text: string, baseDir?: string): string {
  const raw = marked.parse(text || '') as string
  return applyAutoDirection(
    DOMPurify.sanitize(rewriteImageSources(raw, baseDir), {
      USE_PROFILES: { html: true },
      // the default scheme list plus mfm://, which is how every other surface loads a local file
      ALLOWED_URI_REGEXP:
        /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|mfm):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
    })
  )
}

export const firstDir = (text: string): 'rtl' | 'ltr' => dirOfText(text)
