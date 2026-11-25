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
 * A wide table must scroll on its own instead of squeezing its columns to the panel width (which
 * stacked every word into a vertical line) or pushing a horizontal scrollbar onto the whole
 * preview. Each table gets its own scroll box.
 */
function wrapTables(html: string): string {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  tpl.content.querySelectorAll('table').forEach((table) => {
    const box = document.createElement('div')
    box.className = 'md-table-scroll'
    table.replaceWith(box)
    box.appendChild(table)
  })
  return tpl.innerHTML
}

/**
 * markdown → sanitized HTML with per-block direction. Everything the editor shows and everything
 * the PDF export prints goes through here, so both always agree.
 */
export function renderMarkdown(text: string, baseDir?: string): string {
  const raw = marked.parse(text || '') as string
  const clean = DOMPurify.sanitize(rewriteImageSources(raw, baseDir), {
    USE_PROFILES: { html: true },
    // the default scheme list plus mfm://, which is how every other surface loads a local file
    ALLOWED_URI_REGEXP:
      /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|mfm):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  })
  return wrapTables(applyAutoDirection(clean))
}

export const firstDir = (text: string): 'rtl' | 'ltr' => dirOfText(text)
