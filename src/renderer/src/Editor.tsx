import { t } from './i18n.ts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import { baseName, fmtDate } from './format'
import { highlightCode, langFor } from './highlight'
import { renderMarkdown } from './md'
import { dirOfText } from './direction'
import { ConfirmIcon, XIcon } from './Icons'
import { createVisualEditor, type VisualEditor } from './visual'

type Props = {
  path: string
  theme: 'dark' | 'light'
  /** sit in the preview slot instead of covering the window */
  docked?: boolean
  onToggleMax?(): void
  /** the standalone window already has caption buttons */
  hideClose?: boolean
  onClose(): void
  onNote(msg: string): void
  /** the file changed on disk, so the pane behind the editor reloads */
  onSaved(): void
}

const MD = /\.(md|markdown|mdx)$/i

export function Editor({
  path,
  theme,
  docked = false,
  onToggleMax,
  hideClose = false,
  onClose,
  onNote,
  onSaved
}: Props) {
  const [text, setText] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [split, setSplit] = useState(true)
  const [fontSize, setFontSize] = useState(12.5)
  /** markdown opens in the visual (WYSIWYG) surface; source stays one click away */
  const [mode, setMode] = useState<'visual' | 'source'>('visual')
  const [visualReady, setVisualReady] = useState(false)
  const visualRoot = useRef<HTMLDivElement>(null)
  const visual = useRef<VisualEditor | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const hl = useRef<HTMLPreElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  /** the last fully-loaded buffer, so switching files can save the old one first */
  const buf = useRef<{ path: string; text: string | null; saved: string }>({ path, text: null, saved: '' })
  const [loadedPath, setLoadedPath] = useState<string | null>(null)
  /** a draft from a previous session, offered instead of restored silently */
  const [draftText, setDraftText] = useState<string | null>(null)
  const [draftAt, setDraftAt] = useState<number | null>(null)

  const isMd = MD.test(path)
  const lang = useMemo(() => langFor(path), [path])

  // keep the buffer current while typing (only when the loaded file matches the prop)
  useEffect(() => {
    if (loadedPath === path && text !== null) buf.current = { path, text, saved }
  }, [loadedPath, path, text, saved])

  // A change of file must not lose unsaved work: write the previous buffer, then load the new
  // one into the same component (the key no longer contains the path, so no remount).
  useEffect(() => {
    let live = true
    const prev = buf.current
    void (async () => {
      if (prev.path !== path && prev.text !== null && prev.text !== prev.saved) {
        const w = await api.writeText(prev.path, prev.text)
        if ('error' in w) onNote(`${baseName(prev.path)} ذخیره نشد — ${w.error}`)
        else {
          onNote(t('{name} ذخیره شد', { name: baseName(prev.path) }))
          onSaved()
        }
      }
      const r = await api.readText(path)
      if (!live) return
      if ('error' in r) {
        setErr(r.error)
        setText('')
        setSaved('')
        setDraftText(null)
        setDraftAt(null)
        setLoadedPath(path)
        return
      }
      setErr('')
      setText(r.text)
      setSaved(r.text)
      setMode('visual')
      setLoadedPath(path)
      // a draft is offered, never applied silently: the file on disk is the truth
      const draft = await api.drafts.get(path).catch(() => null)
      if (!live) return
      if (draft && typeof draft.text === 'string' && draft.text !== r.text) {
        setDraftText(draft.text)
        setDraftAt(draft.at)
      } else {
        setDraftText(null)
        setDraftAt(null)
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  const dirty = text !== null && text !== saved
  const rich = isMd && mode === 'visual'

  /** The buffer is kept as a draft while it differs from the file (debounced, then on close). */
  useEffect(() => {
    if (loadedPath !== path || text === null || text === saved) return
    const timer = setTimeout(() => void api.drafts.set(path, text), 700)
    return () => clearTimeout(timer)
  }, [path, loadedPath, text, saved])

  useEffect(() => {
    return () => {
      const b = buf.current
      if (b.text !== null && b.text !== b.saved) void api.drafts.set(b.path, b.text)
    }
  }, [])

  useEffect(() => {
    if (!rich || text === null) return
    const el = visualRoot.current
    if (!el) return
    let dead = false
    void createVisualEditor(el, text, (md) => {
      if (!dead) setText(md)
    }).then((v) => {
      if (dead) {
        v.destroy()
        return
      }
      visual.current = v
      setVisualReady(true)
      v.focus()
    }).catch((e) => {
      console.error('visual editor failed', e)
      onNote(t('ویرایشگر بصری باز نشد؛ از حالت «متن» استفاده کن'))
      setMode('source')
    })
    return () => {
      dead = true
      setVisualReady(false)
      visual.current = null
      const node = el.querySelector('.milkdown')
      node?.remove()
    }
    // mount once per file and per mode: `text === null` flips when the file loads, and typing
    // later must not re-create the editor (that would reset the caret)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rich, path, text === null])

  const save = async () => {
    if (text === null || busy) return
    setBusy(true)
    const r = await api.writeText(path, text)
    setBusy(false)
    if ('error' in r) {
      onNote(`ذخیره نشد — ${r.error}`)
      return
    }
    setSaved(text)
    setDraftText(null)
    setDraftAt(null)
    void api.drafts.clear(path)
    onNote(`${baseName(path)} ذخیره شد`)
    onSaved()
  }

  const toPdf = async () => {
    if (text === null || busy) return
    setBusy(true)
    onNote(t('در حال ساخت PDF…'))
    const body = isMd
      ? renderMarkdown(text)
      : `<pre dir="ltr" style="white-space:pre-wrap;unicode-bidi:plaintext;text-align:start">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`
    const out = path.replace(/\.[^./\\]+$/, '') + '.pdf'
    // paper is light: a dark PDF is unreadable when printed or previewed
    const r = await api.htmlToPdf(body, out, 'light')
    setBusy(false)
    onNote('error' in r ? `PDF ساخته نشد — ${r.error}` : `PDF ساخته شد: ${baseName(r.path)}`)
    if (!('error' in r)) onSaved()
  }

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        onClose()
        return
      }
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
        ev.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // the highlighted layer sits under the transparent textarea; they must scroll together
  const syncScroll = () => {
    const el = ta.current
    if (!el) return
    if (hl.current) {
      hl.current.scrollTop = el.scrollTop
      hl.current.scrollLeft = el.scrollLeft
    }
    if (gutter.current) gutter.current.scrollTop = el.scrollTop
  }

  const value = text ?? ''
  const lineCount = useMemo(() => value.split('\n').length, [value])
  const html = useMemo(
    () => highlightCode(value, lang) + '\n',
    [value, lang]
  )
  const rendered = useMemo(() => (isMd ? renderMarkdown(value) : ''), [isMd, value])
  const dir = isMd ? dirOfText(value) : 'ltr'

  return (
    <div className={'ed-shell' + (docked ? ' docked' : '')}>
      {draftText !== null && (
        <div className="ed-draft" dir="auto">
          <span>
            {t('پیش‌نویس ذخیره‌شده از {time}', {
              time: draftAt ? fmtDate(draftAt, 'iso', true) : ''
            })}
          </span>
          <span className="spacer" />
          <button
            className="btn mini"
            onClick={() => {
              setText(draftText)
              setDraftText(null)
              setDraftAt(null)
              onNote(t('پیش‌نویس بازیابی شد؛ هنوز ذخیره نشده'))
            }}
          >
            {t('بازیابی پیش‌نویس')}
          </button>
          <button
            className="btn ghost mini"
            onClick={() => {
              void api.drafts.clear(path)
              setDraftText(null)
              setDraftAt(null)
            }}
          >
            {t('دور انداختن پیش‌نویس')}
          </button>
        </div>
      )}
      <header className="ed-head">
        <span className="ed-name" dir="auto" title={path}>
          {baseName(path)}
        </span>
        {dirty && <span className="ed-dot" title={t(t('تغییرات ذخیره‌نشده'))} />}
        <span className="ed-lang">{lang ?? (isMd ? 'markdown' : 'text')}</span>
        {isMd && (
          <div className="seg ed-mode">
            <button className={rich ? 'on' : ''} onClick={() => setMode('visual')} title={t(t('ویرایشگر بصری'))}>
              {t('بصری')}
            </button>
            <button
              className={!rich ? 'on' : ''}
              onClick={() => setMode('source')}
              title={t(t('متن مارک‌داون'))}
            >
              {t('متن')}
            </button>
          </div>
        )}
        <span className="spacer" />
        {!rich && (
          <button className="tb" title={t(t('شکستن خطوط'))} onClick={() => setWrap((w) => !w)}>
            <span className={wrap ? 'on-txt' : ''}>¶</span>
          </button>
        )}
        <button className="tb" title={t(t('کوچک‌تر'))} onClick={() => setFontSize((f) => Math.max(9, f - 1))}>
          <span>{t(t('ا−'))}</span>
        </button>
        <button className="tb" title={t(t('بزرگ‌تر'))} onClick={() => setFontSize((f) => Math.min(22, f + 1))}>
          <span>{t(t('ا+'))}</span>
        </button>
        {isMd && !rich && (
          <button
            className={'tb' + (split ? ' on' : '')}
            title={t(t('پیش‌نمایش کنار'))}
            onClick={() => setSplit((s) => !s)}
          >
            ◫
          </button>
        )}
        {isMd && (
          <button className="btn" title={t(t('ساخت PDF از این فایل'))} onClick={() => void toPdf()} disabled={busy}>
            PDF
          </button>
        )}
        <button className="btn" title={t(t('ذخیره (Ctrl+S)'))} onClick={() => void save()} disabled={busy || !dirty}>
          <ConfirmIcon />
          <span>{t(t('ذخیره'))}</span>
        </button>
        {onToggleMax && (
          <button
            className="tb"
            title={docked ? t('تمام صفحه') : t('برگرداندن به کنار پیش‌نمایش')}
            onClick={onToggleMax}
          >
            {docked ? '⛶' : '❐'}
          </button>
        )}
        {!hideClose && (
          <button className="tb" title={t(t('بستن (Esc)'))} onClick={onClose}>
            <XIcon size={12} />
          </button>
        )}
      </header>

      {err ? (
        <div className="ed-err">{err}</div>
      ) : (
        <div className={'ed-body' + (isMd && !rich && split ? ' split' : '')}>
          {rich ? (
            <div className="ed-visual" ref={visualRoot} data-ready={visualReady} />
          ) : (
          <div className="ed-code" style={{ fontSize }}>
            <div className="ed-gutter" ref={gutter} aria-hidden>
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <div className="ed-wrap">
              <pre
                className={'ed-hl' + (wrap ? ' wrap' : '')}
                ref={hl}
                dir={dir}
                aria-hidden
                dangerouslySetInnerHTML={{ __html: html }}
              />
              <textarea
                className={'ed-ta' + (wrap ? ' wrap' : '')}
                ref={ta}
                dir={dir}
                value={value}
                spellCheck={false}
                onChange={(e) => setText(e.target.value)}
                onScroll={syncScroll}
                autoFocus
              />
            </div>
          </div>
          )}
          {isMd && !rich && split && (
            <div className="ed-md md-body" dir="auto" dangerouslySetInnerHTML={{ __html: rendered }} />
          )}
        </div>
      )}

      <footer className="ed-foot">
        <span>{t('{n} خط', { n: lineCount })}</span>
        <span>{t('{n} کاراکتر', { n: value.length })}</span>
        <span className="spacer" />
        <span>{dirty ? t('ذخیره‌نشده') : t('ذخیره‌شده')}</span>
        <span className="dim">{t(t('Ctrl+S ذخیره · Esc بستن'))}</span>
      </footer>
    </div>
  )
}
