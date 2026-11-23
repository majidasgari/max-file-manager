import { t } from './i18n.ts'
import { useState } from 'react'
import { baseName, fa, fmtSize } from './format'
import type { ArchiveEncryption, ArchiveFormat, ArchiveProgress } from './api'
import type { ConflictPolicy } from '../../shared/conflict.ts'
import { XIcon, ArchiveIcon, EyeIcon, EyeOffIcon } from './Icons'
import { SheetHead } from './Sheet'

export type ArchiveJob = {
  mode: 'compress' | 'extract'
  /** items to compress */
  files: string[]
  /** archive to extract */
  path: string
  /** inner names to extract (empty = the whole archive) */
  names?: string[]
  name: string
  here: string
  other: string
  /** initial destination; the dialog still offers both panes */
  dest?: string
  level: number
  format?: ArchiveFormat
  encrypted?: boolean
  encryption?: ArchiveEncryption
  conflict?: ConflictPolicy
  subfolder?: boolean
  symlinks?: boolean
}

export type ArchiveRunOpts = {
  name: string
  level: number
  dest: string
  format: ArchiveFormat
  password: string
  encryption: ArchiveEncryption
  comment: string
  conflict: ConflictPolicy
  subfolder: boolean
  symlinks: boolean
}

type Props = {
  job: ArchiveJob
  busy: boolean
  progress: ArchiveProgress | null
  result: string
  onRun(opts: ArchiveRunOpts): void
  onVerify(password: string): void
  onCancel(): void
  onClose(): void
}

const FORMATS: { v: ArchiveFormat; label: string; hint: string }[] = [
  { v: 'zip', label: 'ZIP', hint: 'zip' },
  { v: 'tar.gz', label: 'TAR.GZ', hint: 'tar.gz' },
  { v: 'tar', label: 'TAR', hint: 'tar' },
  { v: 'tar.zst', label: 'TAR.ZST', hint: 'tar.zst' }
]

const levelWord = (level: number): string => {
  if (level === 0) return t('بدون فشرده‌سازی')
  if (level <= 3) return t('سریع')
  if (level <= 6) return t('عادی')
  if (level < 9) return t('قوی')
  return t('حداکثر')
}

const CONFLICT_OPTIONS: { v: ConflictPolicy; label: string; hint: string }[] = [
  { v: 'keep', label: 'نگه داشتن هر دو', hint: 'نام تکراری «(۲)» می‌گیرد' },
  { v: 'overwrite', label: 'بازنویسی', hint: 'جای فایل قبلی' },
  { v: 'skip', label: 'رد کردن', hint: 'فایل موجود دست‌نخورده' },
  { v: 'newer', label: 'فقط جدیدتر', hint: 'اگر نسخهٔ آرشیو تازه‌تر باشد' }
]

/** Compress the selection, or unpack one archive — same dialog, one form each. */
export function ArchiveDialog({ job, busy, progress, result, onRun, onVerify, onCancel, onClose }: Props) {
  const compress = job.mode === 'compress'
  const [name, setName] = useState(job.name)
  const [level, setLevel] = useState(job.level)
  const [format, setFormat] = useState<ArchiveFormat>(job.format ?? 'zip')
  const [dest, setDest] = useState(job.dest ?? job.here)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [encryption, setEncryption] = useState<ArchiveEncryption>(job.encryption ?? 'aes256')
  const [comment, setComment] = useState('')
  const [conflict, setConflict] = useState<ConflictPolicy>(job.conflict ?? 'keep')
  const [subfolder, setSubfolder] = useState(job.subfolder === true)
  const [symlinks, setSymlinks] = useState(job.symlinks === true)

  const zip = format === 'zip'
  const wrongConfirm = !!password && password !== confirm
  const canRun = !busy && (compress ? !!name.trim() && !wrongConfirm : true)
  const pct = (() => {
    if (!progress) return 0
    if (progress.totalBytes > 0) {
      return Math.min(100, Math.floor((progress.bytes / progress.totalBytes) * 100))
    }
    return progress.total > 0 ? Math.min(100, Math.floor((progress.done / progress.total) * 100)) : 0
  })()
  const progressText = progress
    ? (progress.total > 1
        ? `${t('{n} مورد', { n: fa(progress.done) })} / ${fa(progress.total)} · `
        : '') +
      (progress.totalBytes > 0
        ? `${fmtSize(progress.bytes, false, 'human')} / ${fmtSize(progress.totalBytes, false, 'human')} · `
        : '') +
      `${fa(pct)}٪`
    : ''

  const run = (): void => {
    if (!canRun) return
    onRun({
      name: name.trim(),
      level,
      dest,
      format,
      password: zip ? password : '',
      encryption,
      comment,
      conflict,
      subfolder,
      symlinks
    })
  }

  return (
    <div className="modal" onMouseDown={busy ? undefined : onClose}>
      <div className="dialog wide archive-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <SheetHead
          icon={<ArchiveIcon size={17} />}
          title={compress ? t('فشرده‌سازی') : t('استخراج')}
          sub={
            compress
              ? t('{n} مورد', { n: fa(job.files.length) })
              : `${baseName(job.path)}${job.names?.length ? ` · ${t('{n} مورد', { n: fa(job.names.length) })}` : ''}`
          }
          subTitle={compress ? job.files[0] : job.path}
        />

        {compress ? (
          <>
            <div className="pref-row">
              <div className="pref-label">
                <span>{t('نام آرشیو')}</span>
                <span className="hint">{t('پسوند بر اساس قالب خودکار اضافه می‌شود')}</span>
              </div>
              <div className="pref-control">
                <input
                  className="pref-input wide"
                  dir="auto"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') run()
                  }}
                />
              </div>
            </div>

            <div className="pref-row">
              <div className="pref-label">
                <span>{t('قالب آرشیو')}</span>
                <span className="hint">{t('zip تنها قالبی است که رمز و سطح فشرده‌سازی کامل دارد')}</span>
              </div>
              <div className="pref-control">
                <select
                  className="pref-input"
                  value={format}
                  onChange={(e) => setFormat(e.target.value as ArchiveFormat)}
                >
                  {FORMATS.map((f) => (
                    <option key={f.v} value={f.v}>
                      {f.label} — {f.hint}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {zip ? (
              <div className="pref-row">
                <div className="pref-label">
                  <span>{t('سطح فشرده‌سازی')}</span>
                  <span className="hint">{t('۰ = بدون فشرده‌سازی (سریع‌ترین)، ۹ = بیشترین فشرده‌سازی')}</span>
                </div>
                <div className="pref-control arc-level">
                  <input
                    type="range"
                    dir="ltr"
                    min={0}
                    max={9}
                    step={1}
                    value={level}
                    onChange={(e) => setLevel(Number(e.target.value))}
                  />
                  <span className="arc-level-word">
                    {fa(level)} · {levelWord(level)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="hint arc-note">
                {format === 'tar.gz'
                  ? t('gzip سطح ۶ (تعادل سرعت و اندازه) استفاده می‌شود')
                  : t('این قالب فشرده‌سازی ندارد؛ فقط بسته‌بندی می‌کند')}
              </div>
            )}

            {zip && (
              <>
                <div className="pref-row">
                  <div className="pref-label">
                    <span>{t('رمز عبور')}</span>
                    <span className="hint">{t('خالی = بدون رمز؛ رمز فقط داخل فایل ذخیره می‌شود')}</span>
                  </div>
                  <div className="pref-control arc-pass">
                    <input
                      className="pref-input"
                      type={showPassword ? 'text' : 'password'}
                      dir="ltr"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t('بدون رمز')}
                    />
                    <button
                      className="btn ghost arc-eye"
                      type="button"
                      title={showPassword ? t('پنهان کردن رمز') : t('نمایش رمز')}
                      onClick={() => setShowPassword((v) => !v)}
                    >
                      {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </div>
                </div>

                {!!password && (
                  <>
                    <div className="pref-row">
                      <div className="pref-label">
                        <span>{t('تکرار رمز')}</span>
                        <span className="hint" style={{ color: wrongConfirm ? 'var(--danger)' : undefined }}>
                          {wrongConfirm ? t('رمزها یکسان نیستند') : t('برای جلوگیری از اشتباه تایپ')}
                        </span>
                      </div>
                      <div className="pref-control">
                        <input
                          className="pref-input"
                          type={showPassword ? 'text' : 'password'}
                          dir="ltr"
                          autoComplete="new-password"
                          value={confirm}
                          onChange={(e) => setConfirm(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="pref-row">
                      <div className="pref-label">
                        <span>{t('روش رمزنگاری')}</span>
                        <span className="hint">
                          {t('AES استاندارد و امن است؛ ZipCrypto فقط برای سازگاری با ابزار قدیمی')}
                        </span>
                      </div>
                      <div className="pref-control">
                        <select
                          className="pref-input"
                          value={encryption}
                          onChange={(e) => setEncryption(e.target.value as ArchiveEncryption)}
                        >
                          <option value="aes256">AES-256</option>
                          <option value="aes192">AES-192</option>
                          <option value="aes128">AES-128</option>
                          <option value="zipcrypto">ZipCrypto (legacy)</option>
                        </select>
                      </div>
                    </div>
                  </>
                )}

                <div className="pref-row">
                  <div className="pref-label">
                    <span>{t('توضیح آرشیو')}</span>
                    <span className="hint">{t('اختیاری؛ داخل خود فایل zip ذخیره می‌شود')}</span>
                  </div>
                  <div className="pref-control">
                    <input
                      className="pref-input wide"
                      dir="auto"
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                    />
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="pref-row">
              <div className="pref-label">
                <span>{t('رمز عبور')}</span>
                <span className="hint">
                  {job.encrypted
                    ? t('این آرشیو رمز دارد')
                    : t('اگر آرشیو رمز دارد اینجا وارد کن')}
                </span>
              </div>
              <div className="pref-control arc-pass">
                <input
                  className="pref-input"
                  type={showPassword ? 'text' : 'password'}
                  dir="ltr"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') run()
                  }}
                  placeholder={t('بدون رمز')}
                />
                <button
                  className="btn ghost arc-eye"
                  type="button"
                  title={showPassword ? t('پنهان کردن رمز') : t('نمایش رمز')}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>

            <div className="pref-row">
              <div className="pref-label">
                <span>{t('اگر نام تکراری بود')}</span>
                <span className="hint">
                  {t(CONFLICT_OPTIONS.find((c) => c.v === conflict)?.hint ?? '')}
                </span>
              </div>
              <div className="pref-control">
                <select
                  className="pref-input"
                  value={conflict}
                  onChange={(e) => setConflict(e.target.value as ConflictPolicy)}
                >
                  {CONFLICT_OPTIONS.map((c) => (
                    <option key={c.v} value={c.v}>
                      {t(c.label)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="arc-check">
              <input type="checkbox" checked={subfolder} onChange={(e) => setSubfolder(e.target.checked)} />
              <span>{t('استخراج به پوشه‌ای هم‌نام آرشیو')}</span>
            </label>
            <label className="arc-check">
              <input type="checkbox" checked={symlinks} onChange={(e) => setSymlinks(e.target.checked)} />
              <span>
                {t('بازسازی پیوندهای نمادین')}
                <span className="hint arc-check-hint">{t('فقط پیوندهایی که داخل مقصد می‌مانند')}</span>
              </span>
            </label>
          </>
        )}

        <div className="pref-row">
          <div className="pref-label">
            <span>{t('مقصد')}</span>
            <span className="hint" dir="auto">
              {dest}
            </span>
          </div>
          <div className="pref-control">
            <div className="seg">
              <button className={dest === job.here ? 'on' : ''} onClick={() => setDest(job.here)}>
                {t('همین پوشه')}
              </button>
              <button className={dest === job.other ? 'on' : ''} onClick={() => setDest(job.other)}>
                {t('پنجرهٔ مقابل')}
              </button>
            </div>
          </div>
        </div>

        {busy && progress && (
          <div className="arc-progress">
            <div className="arc-bar">
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="arc-progress-line">
              <span dir="auto">{progress.name ? baseName(progress.name) : progressText}</span>
              <span className="dim">{progress.name ? progressText : ''}</span>
            </div>
          </div>
        )}

        {result && <div className="dim result-line" dir="auto">{result}</div>}

        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            <XIcon size={11} /> {t('بستن')}
          </button>
          {!compress && (
            <button className="btn ghost" disabled={busy} onClick={() => onVerify(password)}>
              {t('تست آرشیو')}
            </button>
          )}
          {busy ? (
            <button className="btn ghost" onClick={onCancel}>
              {t('لغو عملیات')}
            </button>
          ) : (
            <button className="btn" disabled={!canRun} onClick={run}>
              {compress ? t('فشرده کن') : t('استخراج کن')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
