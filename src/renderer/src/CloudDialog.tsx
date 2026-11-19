import { useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type CloudAccount,
  type CloudBinding,
  type CloudPreview,
  type CloudProvider,
  type CloudTarget
} from './api'
import { CLOUD_PROVIDERS, MINUTE, OAUTH_REDIRECT_URI, cloudProvider } from '../../shared/cloud.ts'
import { t } from './i18n.ts'
import { errText, fa, fmtSize, isAbsolutePath } from './format'
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloudIcon,
  FolderIcon,
  LockIcon,
  PlusIcon,
  ServerIcon,
  XIcon
} from './Icons'
import { intervalLabel } from './cloud-view'

type Props = {
  /** the folder the dialog starts from; usually the active pane */
  activeDir: string
  onClose(): void
  /** a binding was created: the caller reloads its panes and the sidebar */
  onSaved(binding: CloudBinding): void
}

type Step = 'provider' | 'auth' | 'folder' | 'local'
const STEPS: { id: Step; label: string }[] = [
  { id: 'provider', label: 'سرویس ابری' },
  { id: 'auth', label: 'ورود به حساب' },
  { id: 'folder', label: 'پوشهٔ ابری' },
  { id: 'local', label: 'پوشهٔ لوکال' }
]

const familyLabel = (p: CloudProvider): string =>
  p.family === 'oauth' ? 'OAuth · ورود در مرورگر' : p.id === 'qsync' ? 'QNAP · WebDAV' : 'WebDAV · رمز برنامه'

/**
 * Connect → pick a folder on the remote → pick the local folder. The dialog never stores a secret
 * itself: it hands the form to main, which tests the connection and keeps the password in the OS
 * keyring.
 */
export function CloudDialog({ activeDir, onClose, onSaved }: Props) {
  const [step, setStep] = useState<Step>('provider')
  const [provider, setProvider] = useState<CloudProvider | null>(null)
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [label, setLabel] = useState('')
  const [account, setAccount] = useState<CloudAccount | null>(null)
  const [remotePath, setRemotePath] = useState('/')
  const [targets, setTargets] = useState<CloudTarget[]>([])
  const [newName, setNewName] = useState('')
  const [makingFolder, setMakingFolder] = useState(false)
  const [localPath, setLocalPath] = useState(activeDir)
  const [name, setName] = useState('')
  const [intervalMs, setIntervalMs] = useState(15 * MINUTE)
  const [seed, setSeed] = useState<'fast' | 'full'>('fast')
  const [deleteExtra, setDeleteExtra] = useState(false)
  const [preview, setPreview] = useState<CloudPreview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const seq = useRef(0)
  const firstInput = useRef<HTMLInputElement | null>(null)

  const current = STEPS.findIndex((s) => s.id === step)
  const accountProvider = account ? cloudProvider(account.provider) : null
  const activeProvider = provider

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  useEffect(() => {
    if (step === 'auth') firstInput.current?.focus()
  }, [step])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const loadRemote = (p: string): Promise<void> =>
    run(async () => {
      if (!account) return
      const rows = await api.cloud.browse(account.id, p)
      setTargets(rows)
      setRemotePath(p)
      setMakingFolder(false)
      setNewName('')
    })

  const connect = (): Promise<void> =>
    run(async () => {
      if (!provider) return
      const acc = await api.cloud.accountSave(
        provider.family === 'oauth'
          ? {
              provider: provider.id,
              clientId: clientId.trim(),
              clientSecret: clientSecret.trim() || undefined
            }
          : {
              provider: provider.id,
              url,
              user,
              password,
              label: label || undefined
            }
      )
      setAccount(acc)
      setStep('folder')
      const rows = await api.cloud.browse(acc.id, '/')
      setTargets(rows)
      setRemotePath('/')
    })

  const createFolder = (): Promise<void> =>
    run(async () => {
      if (!account || !newName.trim()) return
      const path = await api.cloud.folderCreate(account.id, remotePath, newName.trim())
      setMakingFolder(false)
      setNewName('')
      await loadRemote(remotePath)
      setRemotePath(path)
      setName(path.slice(path.lastIndexOf('/') + 1))
      setStep('local')
    })

  const save = (): Promise<void> =>
    run(async () => {
      if (!account) return
      const binding = await api.cloud.bindingSave({
        accountId: account.id,
        localPath,
        remoteId: remotePath,
        remoteLabel: remotePath,
        name: name || remotePath,
        intervalMs,
        seed,
        deleteExtra
      })
      onSaved(binding)
      onClose()
    })

  const runPreview = async (): Promise<void> => {
    if (!account || !isAbsolutePath(localPath)) return
    const mine = ++seq.current
    setPreviewBusy(true)
    setPreviewError('')
    try {
      const out = await api.cloud.preview(account.id, localPath, remotePath)
      if (seq.current === mine) setPreview(out)
    } catch (e) {
      if (seq.current === mine) {
        setPreview(null)
        setPreviewError(errText(e))
      }
    } finally {
      if (seq.current === mine) setPreviewBusy(false)
    }
  }

  // the estimate follows the local path with a short debounce; it never blocks «Create»
  useEffect(() => {
    if (step !== 'local' || !account || !isAbsolutePath(localPath)) return
    const h = setTimeout(() => void runPreview(), 450)
    return () => clearTimeout(h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, account, localPath, remotePath])

  const choose = (p: CloudProvider): void => {
    if (!p.ready) return
    setProvider(p)
    setUrl('')
    setUser('')
    setPassword('')
    setClientId('')
    setClientSecret('')
    setLabel('')
    setIntervalMs(p.defaultIntervalMs)
    setSeed('fast')
    setError('')
    setStep('auth')
  }

  const crumbs = useMemo(() => {
    const parts = remotePath.split('/').filter(Boolean)
    return [
      { name: '/', path: '/' },
      ...parts.map((p, i) => ({ name: p, path: '/' + parts.slice(0, i + 1).join('/') }))
    ]
  }, [remotePath])

  const floor = accountProvider?.minIntervalMs ?? 5 * MINUTE
  const presets = [5 * MINUTE, 15 * MINUTE, 30 * MINUTE, 60 * MINUTE, 6 * 60 * MINUTE].filter(
    (ms) => ms >= floor
  )
  const canDelete = accountProvider?.trash === true
  const subtitle =
    step === 'provider'
      ? t('پوشه‌ای در ابر را با یک پوشهٔ لوکال دوطرفه همگام کن.')
      : step === 'auth'
        ? t('مشخصات اتصال را وارد کن؛ قبل از ذخیره آزمایش می‌شود.')
        : step === 'folder'
          ? t('پوشه‌ای در ابر انتخاب کن یا همان‌جا بساز.')
          : t('پوشهٔ لوکال و فاصلهٔ بررسی را انتخاب کن.')
  const oauth = activeProvider?.family === 'oauth'
  const primary =
    step === 'auth'
      ? oauth
        ? t('ورود در مرورگر')
        : t('اتصال و آزمایش')
      : step === 'folder'
        ? t('همین پوشه')
        : t('ایجاد همگام‌سازی')
  const authReady = oauth
    ? !!clientId.trim() && (activeProvider?.id !== 'gdrive' || !!clientSecret.trim())
    : !!url && !!user && !!password

  return (
    <div className="modal cld-modal" onMouseDown={onClose}>
      <div className="cld-sheet" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="cld-head">
          <span className="cld-logo">
            <CloudIcon size={19} />
          </span>
          <div className="cld-titles">
            <h2>{t('ابرها')}</h2>
            <p>{subtitle}</p>
          </div>
          <button className="cld-close" onClick={onClose} aria-label={t('بستن')} title={t('بستن')}>
            <XIcon size={13} />
          </button>
        </header>

        <nav className="cld-steps" aria-label={t('مراحل')}>
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className={'cld-step' + (i === current ? ' on' : '') + (i < current ? ' done' : '')}
              disabled={i > current || busy}
              onClick={() => setStep(s.id)}
            >
              <span className="cld-step-num">{i < current ? <CheckIcon size={11} /> : fa(i + 1)}</span>
              <span>{t(s.label)}</span>
            </button>
          ))}
        </nav>

        <div className="cld-body">
          {step === 'provider' && (
            <div className="cld-panel">
              <div className="cld-grouplabel">{t('آماده برای اتصال')}</div>
              <div className="cld-providers">
                {CLOUD_PROVIDERS.filter((p) => p.ready).map((p) => (
                  <button key={p.id} type="button" className="cld-provider" onClick={() => choose(p)}>
                    <span className={`cld-pico ${p.id}`}>
                      <CloudIcon size={18} />
                    </span>
                    <span className="cld-ptext">
                      <strong>{p.label}</strong>
                      <em dir="auto">{t(p.soonReason ?? familyLabel(p))}</em>
                    </span>
                    <span className="cld-chev">
                      <ChevronLeftIcon size={14} />
                    </span>
                  </button>
                ))}
              </div>
              <div className="cld-grouplabel">{t('به‌زودی')}</div>
              <div className="cld-providers muted">
                {CLOUD_PROVIDERS.filter((p) => !p.ready).map((p) => (
                  <button key={p.id} type="button" className="cld-provider" disabled title={t('به‌زودی')}>
                    <span className={`cld-pico ${p.id}`}>
                      <CloudIcon size={18} />
                    </span>
                    <span className="cld-ptext">
                      <strong>{p.label}</strong>
                      <em dir="auto">{t(p.soonReason ?? familyLabel(p))}</em>
                    </span>
                    <span className="cld-soon">{t('به‌زودی')}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 'auth' && activeProvider && (
            <div className="cld-panel narrow">
              <div className="cld-cardhead">
                <span className={`cld-pico ${activeProvider.id}`}>
                  <CloudIcon size={17} />
                </span>
                <div className="cld-ptext">
                  <strong>{activeProvider.label}</strong>
                  <em dir="auto">{activeProvider.note ?? familyLabel(activeProvider)}</em>
                </div>
              </div>

              <div className="cld-form">
                {activeProvider.family === 'oauth' ? (
                  <>
                    <label className="cld-field">
                      <span>Client ID</span>
                      <input
                        ref={firstInput}
                        dir="ltr"
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        placeholder="…apps.googleusercontent.com"
                        spellCheck={false}
                        autoComplete="off"
                      />
                      <small>
                        {t('شناسهٔ اپ OAuth خودت؛ مکس هیچ کلاینتی از خودش همراه ندارد.')}
                      </small>
                    </label>
                    <label className="cld-field">
                      <span>
                        Client Secret
                        {activeProvider.id === 'gdrive' ? ` (${t('الزامی')})` : ` (${t('اختیاری')})`}
                      </span>
                      <span className="cld-input">
                        <LockIcon size={13} />
                        <input
                          dir="ltr"
                          type="password"
                          value={clientSecret}
                          onChange={(e) => setClientSecret(e.target.value)}
                          autoComplete="new-password"
                        />
                      </span>
                    </label>
                    <div className="cld-redirect">
                      <span>Redirect URI</span>
                      <code dir="ltr">{OAUTH_REDIRECT_URI}</code>
                      <button
                        type="button"
                        className="cld-mini ghost"
                        onClick={() => void navigator.clipboard.writeText(OAUTH_REDIRECT_URI)}
                      >
                        {t('کپی')}
                      </button>
                    </div>
                    <button
                      type="button"
                      className="cld-doclink"
                      onClick={() => void api.cloud.docs(activeProvider.id)}
                    >
                      {t('راهنمای ساخت اپ OAuth')}
                    </button>
                    <div className="hint">
                      {t('مرورگر باز می‌شود؛ بعد از تأیید، خودکار به همین پنجره برمی‌گردی.')}
                    </div>
                  </>
                ) : (
                  <>
                <label className="cld-field">
                  <span>{t('آدرس سرور')}</span>
                  <span className="cld-input">
                    <ServerIcon size={14} />
                    <input
                      ref={firstInput}
                      dir="ltr"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder={activeProvider.urlPlaceholder ?? 'https://cloud.example.com'}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </span>
                  <small>{t(activeProvider.urlHint ?? 'مسیر کامل WebDAV، بدون اسلش آخر.')}</small>
                </label>
                <div className="cld-row">
                  <label className="cld-field">
                    <span>{t('نام کاربری')}</span>
                    <input
                      dir="ltr"
                      value={user}
                      onChange={(e) => setUser(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </label>
                  <label className="cld-field">
                    <span>{t('رمز برنامه')}</span>
                    <span className="cld-input">
                      <LockIcon size={13} />
                      <input
                        dir="ltr"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="new-password"
                      />
                    </span>
                  </label>
                </div>
                <label className="cld-field">
                  <span>{t('نام نمایشی (اختیاری)')}</span>
                  <input dir="auto" value={label} onChange={(e) => setLabel(e.target.value)} />
                </label>
                  </>
                )}
              </div>
            </div>
          )}

          {step === 'folder' && account && (
            <div className="cld-panel">
              <div className="cld-crumbs">
                <span className="cld-crumb-ico">
                  <FolderIcon size={13} />
                </span>
                {crumbs.map((c, i) => (
                  <span key={c.path} className="cld-crumb-wrap">
                    {i > 0 && <span className="cld-sep">/</span>}
                    <button
                      type="button"
                      className={'cld-crumb' + (i === crumbs.length - 1 ? ' on' : '')}
                      onClick={() => void loadRemote(c.path)}
                    >
                      {c.name}
                    </button>
                  </span>
                ))}
                <span className="cld-crumb-note">
                  {busy ? <span className="cld-spin" /> : null}
                  {!busy && targets.length > 0 ? t('{n} پوشه', { n: fa(targets.length) }) : ''}
                </span>
              </div>

              <div className="cld-folderlist">
                {targets.map((row) => (
                  <div key={row.path} className="cld-frow" onClick={() => void loadRemote(row.path)}>
                    <span className="cld-fico">
                      <FolderIcon size={16} />
                    </span>
                    <span dir="auto" className="cld-fname">
                      {row.name}
                    </span>
                    <span className="cld-chev">
                      <ChevronLeftIcon size={13} />
                    </span>
                  </div>
                ))}
                {!targets.length && !busy && (
                  <div className="cld-empty">
                    <FolderIcon size={22} />
                    <span>{t('پوشه‌ای اینجا نیست. با «پوشهٔ نو» بساز.')}</span>
                  </div>
                )}
              </div>

              {makingFolder ? (
                <div className="cld-newrow">
                  <PlusIcon size={14} />
                  <input
                    dir="auto"
                    autoFocus
                    value={newName}
                    placeholder={t('نام پوشهٔ نو')}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createFolder()
                      if (e.key === 'Escape') setMakingFolder(false)
                    }}
                  />
                  <button className="cld-mini" disabled={busy || !newName.trim()} onClick={() => void createFolder()}>
                    {t('بساز')}
                  </button>
                  <button className="cld-mini ghost" onClick={() => setMakingFolder(false)}>
                    {t('لغو')}
                  </button>
                </div>
              ) : (
                <button className="cld-newrow cld-newbtn" type="button" onClick={() => setMakingFolder(true)}>
                  <PlusIcon size={14} />
                  <span>{t('پوشهٔ نو در همین مسیر')}</span>
                </button>
              )}
            </div>
          )}

          {step === 'local' && account && (
            <div className="cld-panel">
              <div className="cld-route">
                <div className="cld-route-row">
                  <span className={`cld-pico ${account.provider}`}>
                    <CloudIcon size={15} />
                  </span>
                  <div>
                    <small>{t('از ابر')}</small>
                    <strong dir="ltr">{remotePath}</strong>
                  </div>
                </div>
                <span className="cld-route-line" />
                <div className="cld-route-row">
                  <span className="cld-pico local">
                    <FolderIcon size={15} />
                  </span>
                  <div>
                    <small>{t('به لوکال')}</small>
                    <strong dir="ltr">{localPath || '—'}</strong>
                  </div>
                </div>
              </div>

              <div className="cld-form tight">
                <label className="cld-field">
                  <span>{t('پوشهٔ لوکال')}</span>
                  <input dir="ltr" value={localPath} onChange={(e) => setLocalPath(e.target.value)} spellCheck={false} />
                  {!isAbsolutePath(localPath) && <small className="bad">{t('مسیر مطلق لازم است.')}</small>}
                </label>
                <div className="cld-row">
                  <label className="cld-field">
                    <span>{t('نام')}</span>
                    <input dir="auto" value={name} onChange={(e) => setName(e.target.value)} placeholder={remotePath} />
                  </label>
                  <div className="cld-field">
                    <span>{t('فاصلهٔ بررسی')}</span>
                    <div className="cld-seg">
                      {presets.map((ms) => (
                        <button
                          key={ms}
                          type="button"
                          className={'cld-segbtn' + (intervalMs === ms ? ' on' : '')}
                          onClick={() => setIntervalMs(ms)}
                        >
                          {intervalLabel(ms)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="cld-field">
                  <span>{t('حالت اولین همگام‌سازی')}</span>
                  <div className="cld-seg">
                    <button
                      type="button"
                      className={'cld-segbtn' + (seed === 'fast' ? ' on' : '')}
                      onClick={() => setSeed('fast')}
                    >
                      {t('سینک سریع (پیشنهادی)')}
                    </button>
                    <button
                      type="button"
                      className={'cld-segbtn' + (seed === 'full' ? ' on' : '')}
                      onClick={() => setSeed('full')}
                    >
                      {t('سینک کامل')}
                    </button>
                  </div>
                  <small>
                    {t('در حالت سریع، فایلی که در دو طرف اندازهٔ یکسان دارد همگام فرض می‌شود و منتقل نمی‌شود؛ مناسب وقتی این پوشه را قبلاً با ابزار دیگری همگام کرده‌ای.')}
                  </small>
                </div>

                <label className={'cld-switch' + (canDelete ? '' : ' off')}>
                  <input
                    type="checkbox"
                    checked={deleteExtra && canDelete}
                    disabled={!canDelete}
                    onChange={(e) => setDeleteExtra(e.target.checked)}
                  />
                  <span className="cld-track">
                    <span className="cld-thumb" />
                  </span>
                  <span className="cld-switch-text">
                    <strong>{t('حذف دوطرفه')}</strong>
                    <em>
                      {canDelete
                        ? t('فایل حذف‌شده در یک طرف، در طرف دیگر هم حذف شود.')
                        : t('این سرور سطل بازیافت ندارد؛ حذف ابری خاموش می‌ماند.')}
                    </em>
                  </span>
                </label>
              </div>

              <div className="cld-preview">
                <div className="cld-preview-head">
                  <span>{t('برآورد اولین همگام‌سازی')}</span>
                  <button className="cld-mini ghost" onClick={() => void runPreview()} disabled={previewBusy}>
                    {t('بررسی دوباره')}
                  </button>
                </div>
                {previewBusy ? (
                  <div className="cld-preview-busy">
                    <span className="cld-spin" /> {t('در حال مقایسه…')}
                  </div>
                ) : previewError ? (
                  <div className="cld-preview-busy muted">{previewError}</div>
                ) : preview ? (
                  <>
                    <div className="cld-stats">
                      <div className="cld-stat up">
                        <strong>{fa(preview.up)}</strong>
                        <span>{t('آپلود')}</span>
                        <em>{fmtSize(preview.bytesUp, false, 'human')}</em>
                      </div>
                      <div className="cld-stat down">
                        <strong>{fa(preview.down)}</strong>
                        <span>{t('دانلود')}</span>
                        <em>{fmtSize(preview.bytesDown, false, 'human')}</em>
                      </div>
                      <div className={'cld-stat' + (preview.conflicts ? ' conflict' : '')}>
                        <strong>{fa(preview.conflicts)}</strong>
                        <span>{t('تعارض')}</span>
                        <em>{preview.conflicts ? t('بعداً حل می‌شود') : t('بدون تعارض')}</em>
                      </div>
                    </div>
                    {(preview.capped || preview.hashMode) && (
                      <div className="cld-preview-note">
                        {preview.capped
                          ? t('این برآورد به سقف پیمایش رسید؛ اجرای واقعی کامل بررسی می‌کند.')
                          : t('اجرای واقعی محتوا را با هش مقایسه می‌کند.')}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="cld-preview-busy muted">{t('برای برآورد، مسیر لوکال را کامل کن.')}</div>
                )}
              </div>
            </div>
          )}
        </div>

        <footer className="cld-foot">
          <div className="cld-status">
            {error ? (
              <span className="cld-error">{error}</span>
            ) : (
              <span className="cld-hint">
                {step === 'provider' && t('۴ سرویس WebDAV فعال است؛ بقیه در فاز بعد.')}
                {step === 'auth' &&
                  (oauth
                    ? t('توکن‌ها فقط در کی‌رینگ سیستم ذخیره می‌شوند.')
                    : t('رمز فقط در کی‌رینگ سیستم ذخیره می‌شود.'))}
                {step === 'folder' && t('پوشهٔ انتخاب‌شده، مقصد ابری این همگام‌سازی است.')}
                {step === 'local' && !canDelete && t('حذف سمت ابر روی این سرور بازگشت‌پذیر نیست.')}
              </span>
            )}
          </div>
          <div className="cld-actions">
            {step !== 'provider' && (
              <button
                className="cld-btn ghost"
                disabled={busy}
                onClick={() => setStep(STEPS[Math.max(0, current - 1)].id)}
              >
                <ChevronRightIcon size={12} />
                {t('بازگشت')}
              </button>
            )}
            {step === 'provider' && (
              <button className="cld-btn ghost" onClick={onClose}>
                {t('بستن')}
              </button>
            )}
            {step === 'auth' && (
              <button className="cld-btn primary" disabled={busy || !authReady} onClick={() => void connect()}>
                {busy && <span className="cld-spin light" />}
                {busy ? (oauth ? t('در انتظار تأیید در مرورگر…') : t('در حال اتصال…')) : primary}
              </button>
            )}
            {step === 'folder' && (
              <button
                className="cld-btn primary"
                disabled={busy}
                onClick={() => {
                  if (!name) {
                    setName(
                      remotePath === '/' ? (account?.label ?? '') : remotePath.slice(remotePath.lastIndexOf('/') + 1)
                    )
                  }
                  setStep('local')
                }}
              >
                {primary}
              </button>
            )}
            {step === 'local' && (
              <button
                className="cld-btn primary"
                disabled={busy || !isAbsolutePath(localPath)}
                onClick={() => void save()}
              >
                {busy && <span className="cld-spin light" />}
                {busy ? t('در حال ساخت…') : primary}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
