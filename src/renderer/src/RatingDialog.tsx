import { t } from './i18n.ts'
import { useState } from 'react'
import { api } from './api'
import { encodeBmp } from '../../shared/bmp.ts'
import { fa } from './format'
import { XIcon } from './Icons'

type Props = {
  name: string
  stars: number
  note: string
  onSave(stars: number, note: string): void
  onClose(): void
}

/** Stars and a short description for one file, stored in the folder's own .mfm.json. */
export function RatingDialog({ name, stars, note, onSave, onClose }: Props) {
  const [value, setValue] = useState(stars)
  const [text, setText] = useState(note)

  return (
    <div className="modal" onMouseDown={onClose}>
      <div className="dialog rating-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">
          <span>{t('امتیاز و توضیح')}</span>
          <span className="dialog-sub" dir="auto" title={name}>
            {name}
          </span>
        </div>
        <div className="stars" dir="ltr">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              className={'star' + (value >= n ? ' on' : '')}
              title={t('{n} ستاره', { n: fa(n) })}
              onClick={() => setValue(value === n ? 0 : n)}
            >
              ★
            </button>
          ))}
          <span className={'star-value' + (value ? '' : ' dim')}>
            {value ? t('{n} از ۵', { n: fa(value) }) : t('بی‌امتیاز')}
          </span>
        </div>
        <label className="dialog-field">
          <span>{t('توضیح')}</span>
          <textarea
            className="note-input"
            dir="auto"
            rows={4}
            placeholder={t(t('توضیح کوتاه…'))}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={500}
          />
        </label>
        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose}>
            {t('انصراف')}
          </button>
          <button className="btn" onClick={() => onSave(value, text)}>
            {t('ذخیره')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * WebP and BMP have no encoder in the main process, and Electron's nativeImage cannot read
 * GIF/BMP/AVIF — so those conversions run on a canvas here, which decodes every format Chromium
 * knows. Output is returned as a data URL and written by the main process.
 */
export async function convertInRenderer(
  files: string[],
  opts: { format: 'webp' | 'bmp'; maxSide: number; quality: number; dest?: string }
): Promise<{ done: number; errors: string[] }> {
  let done = 0
  const errors: string[] = []
  for (const src of files) {
    try {
      const r = await api.imageData(src)
      if ('error' in r || !r.dataUrl) throw new Error(r.error ?? t('خواندن تصویر ممکن نشد'))
      const img = new Image()
      img.src = r.dataUrl
      await img.decode()
      const scale =
        opts.maxSide > 0 ? Math.min(1, opts.maxSide / Math.max(img.naturalWidth, img.naturalHeight)) : 1
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.naturalWidth * scale))
      c.height = Math.max(1, Math.round(img.naturalHeight * scale))
      const ctx = c.getContext('2d')!
      // BMP has no alpha channel: JPEG-like flattening keeps it from turning black
      if (opts.format === 'bmp') {
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, c.width, c.height)
      }
      ctx.drawImage(img, 0, 0, c.width, c.height)
      let out: string
      if (opts.format === 'webp') {
        out = c.toDataURL('image/webp', Math.min(100, Math.max(1, opts.quality)) / 100)
        if (!out.startsWith('data:image/webp')) throw new Error(t('این نسخهٔ کرومیوم WebP نمی‌سازد'))
      } else {
        const data = ctx.getImageData(0, 0, c.width, c.height).data
        const bytes = encodeBmp(data, c.width, c.height)
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        }
        out = `data:image/bmp;base64,${btoa(binary)}`
      }
      const saved = await api.saveImageAs(src, out, opts.dest)
      if ('error' in saved) throw new Error(saved.error)
      done++
    } catch (e: any) {
      errors.push(`${src.split('/').pop()}: ${e?.message ?? String(e)}`)
    }
  }
  return { done, errors }
}

type ConvertProps = {
  count: number
  onRun(opts: { format: 'jpeg' | 'png' | 'webp' | 'bmp'; maxSide: number; quality: number; toOtherPane?: boolean }): void
  onClose(): void
  otherPane: string
  busy: boolean
  result: string
}

/** Batch image conversion: format, longest side and JPEG quality. */
export function ConvertDialog({ count, onRun, onClose, otherPane, busy, result }: ConvertProps) {
  const [format, setFormat] = useState<'jpeg' | 'png' | 'webp' | 'bmp'>('jpeg')
  const [maxSide, setMaxSide] = useState(1920)
  const [quality, setQuality] = useState(88)
  const [toOther, setToOther] = useState(false)

  return (
    <div className="modal" onMouseDown={onClose}>
      <div className="dialog convert-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{t('تبدیل تصاویر ({n} فایل)', { n: fa(count) })}</div>
        <div className="pref-row">
          <div className="pref-label">
            <span>{t(t('قالب خروجی'))}</span>
          </div>
          <div className="pref-control">
            <div className="seg">
              {(['jpeg', 'png', 'webp', 'bmp'] as const).map((f) => (
                <button key={f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>
                  {f === 'jpeg' ? 'JPEG' : f === 'png' ? 'PNG' : f === 'webp' ? 'WebP' : 'BMP'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="pref-row">
          <div className="pref-label">
            <span>{t(t('بلندترین ضلع'))}</span>
            <span className="hint">{t(t('پیکسل؛ ۰ یعنی اندازهٔ اصلی'))}</span>
          </div>
          <div className="pref-control">
            <input
              className="pref-input"
              type="number"
              min={0}
              step={64}
              value={maxSide}
              onChange={(e) => setMaxSide(Math.max(0, Number(e.target.value) || 0))}
            />
          </div>
        </div>
        <div className="pref-row">
          <div className="pref-label">
            <span>{t(t('کیفیت'))}</span>
            <span className="hint">{t(t('فقط برای JPEG و WebP'))}</span>
          </div>
          <div className="pref-control">
            <input
              className="pref-input"
              type="number"
              min={1}
              max={100}
              value={quality}
              onChange={(e) => setQuality(Math.min(100, Math.max(1, Number(e.target.value) || 88)))}
            />
          </div>
        </div>
        <div className="pref-row">
          <div className="pref-label">
            <span>{t(t('خروجی در پنجرهٔ مقابل'))}</span>
            <span className="hint" dir="auto">
              {otherPane}
            </span>
          </div>
          <div className="pref-control">
            <label className="check">
              <input type="checkbox" checked={toOther} onChange={(e) => setToOther(e.target.checked)} />
            </label>
          </div>
        </div>
        {result && <div className="dim result-line">{result}</div>}
        <div className="dialog-actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => onRun({ format, maxSide, quality, toOtherPane: toOther })}
          >
            {t('تبدیل')}
          </button>
          <button className="btn ghost" onClick={onClose}>
            <XIcon size={11} /> {t('بستن')}
          </button>
        </div>
      </div>
    </div>
  )
}

type TagProps = {
  name: string
  tags: Record<string, string>
  onSave(fields: Record<string, string>): void
  onClose(): void
}

/** Writes ID3 text fields; EXIF is read-only for now. */
export function TagDialog({ name, tags, onSave, onClose }: TagProps) {
  const [title, setTitle] = useState(tags.title ?? '')
  const [artist, setArtist] = useState(tags.artist ?? '')
  const [album, setAlbum] = useState(tags.album ?? '')
  const [year, setYear] = useState(tags.year ?? '')

  const field = (label: string, value: string, set: (v: string) => void) => (
    <div className="pref-row">
      <div className="pref-label">
        <span>{label}</span>
      </div>
      <div className="pref-control">
        <input className="pref-input wide" dir="auto" value={value} onChange={(e) => set(e.target.value)} />
      </div>
    </div>
  )

  return (
    <div className="modal" onMouseDown={onClose}>
      <div className="dialog rating-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title" dir="auto">
          {t('برچسب‌های صوتی —')} {name}
        </div>
        {field(t('عنوان'), title, setTitle)}
        {field(t('هنرمند'), artist, setArtist)}
        {field(t('آلبوم'), album, setAlbum)}
        {field(t('سال'), year, setYear)}
        <div className="hint">{t(t('فقط فایل‌های صوتی (ID3) نوشته می‌شوند؛ EXIF فعلاً فقط خوانده می‌شود.'))}</div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => onSave({ title, artist, album, year })}>
            {t('ذخیره')}
          </button>
          <button className="btn ghost" onClick={onClose}>
            <XIcon size={11} /> {t('بستن')}
          </button>
        </div>
      </div>
    </div>
  )
}
