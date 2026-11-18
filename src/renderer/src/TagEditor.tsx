import { useEffect, useState } from 'react'
import { api, type AudioRead, type AudioWriteRequest, type Id3Fields } from './api'
import { t } from './i18n.ts'
import { baseName, fa } from './format'
import { TAG_FIELDS, TAG_SINGLE_FIELDS, autoTracks, commonValues, tagPlan, type TagFieldKey } from './tags'
import { XIcon, AudioIcon } from './Icons'
import { SheetHead } from './Sheet'

type Props = {
  paths: string[]
  /** App writes through `api.audioWrite`, sets the status note and refreshes the pane. */
  onSave(req: AudioWriteRequest): Promise<void>
  onClose(): void
}

const LABELS: Record<TagFieldKey, string> = {
  title: 'عنوان',
  artist: 'هنرمند',
  albumArtist: 'هنرمند آلبوم',
  album: 'آلبوم',
  year: 'سال',
  genre: 'ژانر',
  composer: 'آهنگساز',
  disc: 'شماره دیسک',
  discTotal: 'تعداد دیسک',
  comment: 'توضیح',
  track: 'شماره آهنگ',
  trackTotal: 'تعداد آهنگ'
}

/** LTR for years and numbers: RTL digits inside a mixed line read backwards. */
const LTR_FIELDS: TagFieldKey[] = ['year', 'track', 'trackTotal', 'disc', 'discTotal']

const MIXED_HINT = 'مقادیر متفاوت — با نوشتن، برای همه اعمال می‌شود'

/**
 * Full audio tag editor for one or many mp3 files: shared fields, one title/track row per file,
 * and the embedded cover. Writes go through the merging ID3 writer in the main process.
 */
export function TagEditor({ paths, onSave, onClose }: Props) {
  const [read, setRead] = useState<AudioRead | null>(null)
  const [loadError, setLoadError] = useState('')
  const [common, setCommon] = useState<Id3Fields>({})
  const [mixed, setMixed] = useState<Record<string, boolean>>({})
  const [dirty, setDirty] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, { title?: string; track?: string }>>({})
  const [cover, setCover] = useState<'keep' | 'folder' | 'clear'>('keep')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const single = paths.length === 1

  useEffect(() => {
    let alive = true
    setRead(null)
    setLoadError('')
    setCommon({})
    setMixed({})
    setDirty([])
    setRows({})
    setCover('keep')
    void api
      .audioRead(paths)
      .then((r) => {
        if (!alive) return
        setRead(r)
        const nextCommon: Id3Fields = {}
        const nextMixed: Record<string, boolean> = {}
        for (const key of [...TAG_FIELDS, ...TAG_SINGLE_FIELDS]) {
          const values = paths.map((p) => r.files[p]?.[key] ?? '')
          const found = commonValues(values)
          nextCommon[key] = found.value
          if (found.mixed) nextMixed[key] = true
        }
        setCommon(nextCommon)
        setMixed(nextMixed)
      })
      .catch(() => {
        if (alive) setLoadError(t('خواندن برچسب‌ها ممکن نشد'))
      })
    return () => {
      alive = false
    }
  }, [paths])

  const touch = (key: TagFieldKey, value: string) => {
    setCommon((prev) => ({ ...prev, [key]: value }))
    setDirty((prev) => (prev.includes(key) ? prev : [...prev, key]))
    setMixed((prev) => ({ ...prev, [key]: false }))
  }

  const rowValue = (p: string, key: 'title' | 'track'): string =>
    rows[p]?.[key] ?? read?.files[p]?.[key] ?? ''

  const touchRow = (p: string, key: 'title' | 'track', value: string) => {
    setRows((prev) => ({ ...prev, [p]: { ...prev[p], [key]: value } }))
  }

  const numberAll = () => {
    const numbers = autoTracks(paths.length)
    setRows((prev) => {
      const next = { ...prev }
      paths.forEach((p, i) => {
        next[p] = { ...next[p], track: numbers[i] }
      })
      return next
    })
  }

  const plan = read
    ? tagPlan({
        files: paths.map((p) => ({ path: p, fields: read.files[p] ?? {} })),
        common,
        dirty,
        rows
      })
    : []
  const changed = plan.some((item) => Object.keys(item.fields).length > 0) || cover !== 'keep'
  const someCover = !!read && Object.values(read.hasCover).some(Boolean)
  const currentCover = read ? (read.sharedCover ?? read.folderCover) : null

  const save = async () => {
    if (!read || !changed || busy) return
    setBusy(true)
    setError('')
    try {
      await onSave({ items: plan, cover })
      onClose()
    } catch {
      setError(t('نوشتن برچسب نشد'))
    } finally {
      setBusy(false)
    }
  }

  const field = (key: TagFieldKey) => (
    <div className="pref-row" key={key}>
      <div className="pref-label">
        <span>{t(LABELS[key])}</span>
      </div>
      <div className="pref-control">
        <input
          className="pref-input"
          dir={LTR_FIELDS.includes(key) ? 'ltr' : 'auto'}
          value={common[key] ?? ''}
          placeholder={mixed[key] ? t(MIXED_HINT) : undefined}
          onChange={(e) => touch(key, e.target.value)}
        />
      </div>
    </div>
  )

  return (
    <div className="modal" onMouseDown={() => !busy && onClose()}>
      <div className="dialog tag-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <SheetHead
          icon={<AudioIcon size={17} />}
          title={
            single
              ? t('برچسب‌های صوتی')
              : t('برچسب‌های صوتی ({n} فایل)', { n: fa(paths.length) })
          }
          sub={single && paths[0] ? baseName(paths[0]) : undefined}
          subTitle={single ? paths[0] : undefined}
        />

        {loadError && <div className="hint">{loadError}</div>}
        {!read && !loadError && <div className="hint">{t('در حال خواندن…')}</div>}

        {read && (
          <>
            <div className="tag-grid">
              {TAG_FIELDS.map(field)}
              {single && TAG_SINGLE_FIELDS.map(field)}
            </div>

            {!single && (
              <div className="tag-files-block">
                <div className="tag-files-tools">
                  <button className="btn ghost small" onClick={numberAll} disabled={busy}>
                    {t('شماره‌گذاری خودکار')}
                  </button>
                  <span className="hint">{t('ترتیب فعلی فایل‌ها')}</span>
                </div>
                <div className="tag-files">
                  <div className="tag-file-head">
                    <span>{t('فایل')}</span>
                    <span>{t('عنوان')}</span>
                    <span>{t('شماره')}</span>
                  </div>
                  {paths.map((p) => (
                    <div className="tag-file-row" key={p}>
                      <span className="tag-file-name" dir="ltr" title={p}>
                        {baseName(p)}
                      </span>
                      <input
                        className="pref-input"
                        dir="auto"
                        value={rowValue(p, 'title')}
                        onChange={(e) => touchRow(p, 'title', e.target.value)}
                      />
                      <input
                        className="pref-input"
                        dir="ltr"
                        value={rowValue(p, 'track')}
                        onChange={(e) => touchRow(p, 'track', e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="pref-row tag-cover-row">
              <div className="pref-label">
                <span>{t('کاور')}</span>
              </div>
              <div className="pref-control tag-cover">
                {currentCover ? (
                  <img className="tag-cover-img" src={currentCover} alt="" />
                ) : (
                  <span className="hint">{t('بدون کاور')}</span>
                )}
                <div className="seg">
                  <button
                    className={cover === 'folder' ? 'on' : ''}
                    disabled={!read.folderCover || busy}
                    onClick={() => setCover(cover === 'folder' ? 'keep' : 'folder')}
                  >
                    {t('کاور از پوشه')}
                  </button>
                  <button
                    className={cover === 'clear' ? 'on' : ''}
                    disabled={!someCover || busy}
                    onClick={() => setCover(cover === 'clear' ? 'keep' : 'clear')}
                  >
                    {t('حذف کاور')}
                  </button>
                  <button className={cover === 'keep' ? 'on' : ''} disabled={busy} onClick={() => setCover('keep')}>
                    {t('نگه‌داشتن کاور فعلی')}
                  </button>
                </div>
              </div>
            </div>

            {read.skipped > 0 && (
              <div className="hint">{t('{n} مورد نادیده گرفته شد (فقط mp3)', { n: fa(read.skipped) })}</div>
            )}
            {error && <div className="hint">{error}</div>}
          </>
        )}

        <div className="dialog-actions">
          <button
            className="btn"
            disabled={!read || !changed || busy}
            onClick={() => void save()}
          >
            {busy ? t('در حال ذخیره…') : t('ذخیره')}
          </button>
          <button className="btn ghost" disabled={busy} onClick={onClose}>
            <XIcon size={11} /> {t('بستن')}
          </button>
        </div>
      </div>
    </div>
  )
}
