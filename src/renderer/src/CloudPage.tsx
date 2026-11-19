import { useEffect, useState } from 'react'
import { api, type CloudBinding, type CloudView } from './api'
import { CLOUD_PROVIDERS, MINUTE, cloudProvider, type CloudProviderId } from '../../shared/cloud.ts'
import { t } from './i18n.ts'
import { errText, fa, fmtSize, dirOf, joinPath } from './format'
import { CloudIcon, FolderIcon, PlayIcon, PlusIcon, TrashIcon } from './Icons'
import { CloudDialog } from './CloudDialog'
import {
  INTERVAL_OPTIONS,
  agoLabel,
  bindingSubtitle,
  cloudStateClass,
  intervalLabel,
  progressFilesLabel,
  progressPercent
} from './cloud-view'

type Props = {
  activeDir: string
  onOpenFolder(path: string): void
  /** a run changed files: the caller reloads the visible panes */
  onChanged(): void
}

/** Every binding in one place: interval, deletion policy, pause, run now and removal. */
export function CloudPage({ activeDir, onOpenFolder, onChanged }: Props) {
  const [view, setView] = useState<CloudView | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const refresh = (): void => {
    void api.cloud.list().then(setView)
  }

  useEffect(() => {
    refresh()
    const off = api.cloud.onState((v) => setView(v))
    return () => off()
  }, [])

  const runNow = async (b: CloudBinding): Promise<void> => {
    setBusy(b.id)
    setNote('')
    try {
      const r = await api.cloud.syncNow(b.id)
      if (r.error) setNote(`${t('خطا')}: ${r.error}`)
      else
        setNote(
          `${t('همگام‌سازی شد')} · ${fa(r.copied)} ${t('کپی')} · ${fa(r.removed)} ${t('حذف')}` +
            (r.conflicts ? ` · ${fa(r.conflicts)} ${t('تعارض')}` : '') +
            (r.blockedDeletes ? ` · ${fa(r.blockedDeletes)} ${t('حذف ابری رد شد')}` : '')
        )
      onChanged()
    } catch (e) {
      setNote(errText(e))
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const patch = async (b: CloudBinding, p: Parameters<typeof api.cloud.bindingUpdate>[1]): Promise<void> => {
    await api.cloud.bindingUpdate(b.id, p)
    refresh()
  }

  /**
   * «قطع اتصال» on the last binding of an account also forgets the account (and its keyring
   * sign-in): an account without bindings would otherwise stay behind with no way to reach it.
   */
  const disconnect = async (b: CloudBinding): Promise<void> => {
    await api.cloud.bindingRemove(b.id)
    const after = await api.cloud.list()
    if (!after.bindings.some((x) => x.accountId === b.accountId)) await api.cloud.accountRemove(b.accountId)
    refresh()
    onChanged()
  }

  const statusOf = (id: string) => view?.status.find((s) => s.bindingId === id)
  const accountOf = (id: string) => view?.accounts.find((a) => a.id === id)

  return (
    <>
      <div className="pref-row">
        <div className="pref-label">{t('اتصال‌های ابری')}</div>
        <div className="pref-value">
          <button className="btn" onClick={() => setAdding(true)}>
            <PlusIcon size={13} /> {t('افزودن ابر')}
          </button>
        </div>
      </div>
      <div className="hint">
        {t('هر اتصال، یک پوشهٔ لوکال را با یک پوشه در ابر دوطرفه همگام می‌کند. موتور همان همگام‌سازی دوپنجره است؛ تعارض‌ها حدس زده نمی‌شوند.')}
      </div>

      {note && <div className="hint" dir="auto">{note}</div>}

      {view && view.bindings.length === 0 && (
        <div className="hint">{t('هنوز اتصالی ساخته نشده. «افزودن ابر» را بزن.')}</div>
      )}

      {view?.bindings.map((b) => {
        const st = statusOf(b.id)
        const acc = accountOf(b.accountId)
        const provider = acc ? cloudProvider(acc.provider) : null
        const paused = st?.state === 'paused'
        return (
          <div key={b.id} className="cloud-bind">
            <div className="cloud-bind-head">
              <span className={`cloud-mark ${acc?.provider ?? 'webdav'}`}>
                <CloudIcon size={15} />
              </span>
              <strong dir="auto">{b.name}</strong>
              <span className={`cloud-dot ${cloudStateClass(st?.state ?? 'idle')}`} />
              <span className="hint" style={{ margin: 0 }}>
                {bindingSubtitle(st?.state ?? 'idle', st?.lastRunAt ?? null, st?.conflicts.length ?? 0)}
              </span>
              {b.seed === 'fast' && (
                <span className="hint" style={{ margin: 0 }}>
                  {t('پذیرش سریع')}
                </span>
              )}
            </div>
            <div className="cloud-path" dir="ltr">
              {b.localPath}
            </div>
            <div className="cloud-path" dir="ltr">
              {acc?.label ?? ''} · {b.remoteLabel}
            </div>
            {st?.progress && (
              <div className="cloud-run">
                <span
                  className={'cloud-bar' + (progressPercent(st.progress) === null ? ' scan' : '')}
                  dir="ltr"
                >
                  <i style={{ width: (progressPercent(st.progress) ?? 35) + '%' }} />
                </span>
                <span className="cloud-run-meta" dir="auto">
                  {st.progress.phase === 'scan' ? (
                    <>
                      {t('در حال بررسی تغییرات…')}
                      {st.progress.current ? ` · ${st.progress.current}` : ''}
                    </>
                  ) : (
                    <>
                      {fa(progressPercent(st.progress) ?? 0)}٪ · {progressFilesLabel(st.progress)}
                      {st.progress.bytesTotal > 0
                        ? ` · ${fmtSize(st.progress.bytesDone, false)} / ${fmtSize(st.progress.bytesTotal, false)}`
                        : ''}
                      {st.progress.current ? ` · ${st.progress.current}` : ''}
                    </>
                  )}
                </span>
              </div>
            )}
            {st && (st.counts.synced + st.counts.pending + st.counts.localOnly + st.counts.cloudOnly + st.counts.conflict > 0) && (
              <div className="cloud-counts">
                {(
                  [
                    ['synced', t('همگام'), st.counts.synced],
                    ['pending', t('در انتظار'), st.counts.pending],
                    ['localOnly', t('فقط لوکال'), st.counts.localOnly],
                    ['cloudOnly', t('فقط در ابر'), st.counts.cloudOnly],
                    ['conflict', t('تعارض'), st.counts.conflict]
                  ] as const
                )
                  .filter(([, , n]) => n > 0)
                  .map(([key, label, n]) => (
                    <span key={key} className={`cloud-count ${cloudStateClass(key)}`}>
                      <i />
                      {fa(n)} {label}
                    </span>
                  ))}
              </div>
            )}
            {st?.lastError && (
              <div className="hint" dir="auto" style={{ color: 'var(--danger, #e0564d)' }}>
                {st.lastError}
              </div>
            )}
            {!!st?.conflicts.length && (
              <div className="cloud-conflicts">
                <div className="hint" style={{ margin: 0 }}>
                  {fa(st.conflicts.length)} {t('تعارض حل‌نشده')} ·{' '}
                  {t('هر دو طرف بعد از آخرین همگام‌سازی عوض شده‌اند؛ موتور هیچ‌کدام را روی دیگری نمی‌نویسد.')}
                </div>
                <ul>
                  {st.conflicts.map((rel) => (
                    <li key={rel}>
                      <button
                        className="btn ghost"
                        dir="ltr"
                        title={joinPath(b.localPath, rel)}
                        onClick={() => onOpenFolder(dirOf(joinPath(b.localPath, rel)))}
                      >
                        <FolderIcon size={12} /> {rel}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="cloud-bind-actions">
              <button className="btn ghost" disabled={busy === b.id} onClick={() => void runNow(b)}>
                <PlayIcon size={12} /> {busy === b.id ? t('در حال اجرا…') : t('همین حالا')}
              </button>
              <button className="btn ghost" onClick={() => void patch(b, { paused: !paused })}>
                {paused ? t('ادامه') : t('مکث')}
              </button>
              <button className="btn ghost" onClick={() => onOpenFolder(b.localPath)}>
                <FolderIcon size={12} /> {t('پوشه')}
              </button>
              <button className="btn ghost" onClick={() => void disconnect(b)}>
                <TrashIcon size={12} /> {t('قطع اتصال')}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <label className="check" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={b.deleteExtra}
                  onChange={(e) => void patch(b, { deleteExtra: e.target.checked })}
                />
                <span>{t('حذف دوطرفه')}</span>
              </label>
              <label className="check" style={{ gap: 6 }}>
                <span>{t('فاصله')}</span>
                <select
                  value={b.intervalMs}
                  onChange={(e) => void patch(b, { intervalMs: Number(e.target.value) })}
                >
                  {INTERVAL_OPTIONS.filter((min) => min * MINUTE >= (provider?.minIntervalMs ?? MINUTE)).map((min) => (
                    <option key={min} value={min * MINUTE}>
                      {intervalLabel(min * MINUTE)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check" style={{ gap: 6 }}>
                <span>{t('مقایسه')}</span>
                <select value={b.compareBy} onChange={(e) => void patch(b, { compareBy: e.target.value as 'hash' | 'mtime' })}>
                  <option value="mtime">{t('تاریخ تغییر')}</option>
                  <option value="hash">{t('هش محتوا')}</option>
                </select>
              </label>
              <span className="hint" style={{ margin: 0 }}>
                {t('آخرین بررسی')}: {agoLabel(st?.lastRunAt ?? null)}
              </span>
            </div>
          </div>
        )
      })}

      {!!view?.accounts.length && (
        <>
          <div className="pref-row" style={{ marginTop: 12 }}>
            <div className="pref-label">{t('حساب‌ها')}</div>
          </div>
          {view.accounts.map((a) => (
            <div key={a.id} className="cloud-bind">
              <div className="cloud-bind-head">
                <span className={`cloud-mark ${a.provider}`}>
                  <CloudIcon size={14} />
                </span>
                <strong dir="auto">{a.label}</strong>
                <span className="hint" style={{ margin: 0 }}>
                  {CLOUD_PROVIDERS.find((p) => p.id === a.provider)?.label ?? a.provider}
                  {a.sessionOnly ? ` · ${t('فقط این نشست')}` : ''}
                </span>
              </div>
              {a.url && (
                <div className="cloud-path" dir="ltr">
                  {a.url}
                </div>
              )}
              <div className="cloud-bind-actions">
                <button
                  className="btn ghost"
                  onClick={() => {
                    void api.cloud.accountRemove(a.id).then(() => {
                      refresh()
                      onChanged()
                    })
                  }}
                >
                  <TrashIcon size={12} /> {t('حذف حساب')}
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {adding && (
        <CloudDialog
          activeDir={activeDir}
          onClose={() => setAdding(false)}
          onSaved={() => {
            refresh()
            onChanged()
          }}
        />
      )}
    </>
  )
}

/** The provider ids the settings page writes; kept here so an invalid value never reaches main. */
export const cloudProviderIdOf = (id: string): CloudProviderId | null =>
  (CLOUD_PROVIDERS.find((p) => p.id === id)?.id as CloudProviderId | undefined) ?? null
