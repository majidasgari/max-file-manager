import { t } from './i18n.ts'
import { useEffect, useState } from 'react'
import { api, type SearchProgress } from './api'
import {
  COLUMNS,
  DEFAULT_IGNORE_FILES,
  DEFAULT_TOOLBAR,
  cleanFontFamily,
  fontStack,
  mergePrefs,
  type ColId,
  type CustomCommand,
  type Prefs
} from './prefs'
import { fa } from './format'
import { XIcon } from './Icons'
import { AgentsPage } from './AgentsPage'
import { COMMANDS, COMMAND_BY_ID, DEFAULT_SHORTCUTS, GROUP_ORDER, groupLabelOf, labelOf, type CommandGroup } from './commands'
import { accelFromEvent, findConflicts, formatAccel } from './keys'
import { COLOR_THEMES } from './themes'

const FONT_SUGGESTIONS = [
  'Vazirmatn',
  'Noto Sans',
  'Noto Sans Arabic',
  'DejaVu Sans',
  'Ubuntu',
  'Cantarell',
  'Inter',
  'Tahoma',
  'Segoe UI',
  'SF Pro Text',
  'Arial',
  'system-ui',
  'serif',
  'monospace'
]

type Page =
  | 'appearance'
  | 'display'
  | 'columns'
  | 'toolbar'
  | 'keys'
  | 'layout'
  | 'agents'
  | 'search'
  | 'filetypes'
  | 'defaultApps'
  | 'archive'
  | 'transfer'
  | 'operations'
  | 'launch'
  | 'advanced'

/** Persian stays the key here; the nav translates at render so a language switch applies at once. */
const PAGES: { id: Page; label: string }[] = [
  { id: 'appearance', label: 'ظاهر و رنگ' },
  { id: 'display', label: 'نمایش فایل‌ها' },
  { id: 'columns', label: 'ستون‌ها' },
  { id: 'toolbar', label: 'نوار ابزار' },
  { id: 'keys', label: 'کلید میان‌بر' },
  { id: 'layout', label: 'پنجره و چیدمان' },
  { id: 'agents', label: 'ایجنت‌ها (MCP)' },
  { id: 'search', label: 'جست‌وجو' },
  { id: 'filetypes', label: 'انواع فایل' },
  { id: 'defaultApps', label: 'برنامه‌های پیش‌فرض' },
  { id: 'archive', label: 'بایگانی و گالری' },
  { id: 'transfer', label: 'انتقال' },
  { id: 'operations', label: 'عملیات فایل' },
  { id: 'launch', label: 'راه‌اندازی' },
  { id: 'advanced', label: 'پیشرفته' }
]

type Props = {
  prefs: Prefs
  palette: { id: string; name: string; color: string }[]
  /** jump straight to a page (the column menu opens «columns») */
  openPage?: Page
  searchRoots: string[]
  onChange(patch: Partial<Prefs>): void
  onClose(): void
}

export function Preferences({ prefs, palette, openPage, searchRoots, onChange, onClose }: Props) {
  const [extInput, setExtInput] = useState('')
  const [appExt, setAppExt] = useState('')
  const [appIdDraft, setAppIdDraft] = useState('')
  const [appChoices, setAppChoices] = useState<{ id: string; name: string }[]>([])
  const [osDefault, setOsDefault] = useState('')
  const [newRoot, setNewRoot] = useState('')
  const [page, setPage] = useState<Page>(openPage ?? 'appearance')
  const [capturing, setCapturing] = useState<string | null>(null)
  const [isDefault, setIsDefault] = useState<boolean | null>(null)
  const [settingDefault, setSettingDefault] = useState(false)
  const [portalBusy, setPortalBusy] = useState(false)
  const [portalMsg, setPortalMsg] = useState('')
  const [indexSt, setIndexSt] = useState<SearchProgress | null>(null)
  const [ioBusy, setIoBusy] = useState(false)
  const [settingsMsg, setSettingsMsg] = useState('')
  const [cmdIdDraft, setCmdIdDraft] = useState<string | null>(null)
  const [cmdLabel, setCmdLabel] = useState('')
  const [cmdPattern, setCmdPattern] = useState('')
  const [cmdType, setCmdType] = useState<'ext' | 'folder'>('ext')
  const [cmdLine, setCmdLine] = useState('')

  const handleSaveCmd = () => {
    const label = cmdLabel.trim()
    const pattern = (cmdType === 'folder' ? 'folder' : cmdPattern.trim()).toLowerCase().replace(/^\./, '')
    const command = cmdLine.trim()
    if (!label || !pattern || !command) return

    const list = [...(prefs.customCommands ?? [])]
    if (cmdIdDraft) {
      const idx = list.findIndex((c) => c.id === cmdIdDraft)
      if (idx >= 0) {
        list[idx] = { id: cmdIdDraft, label, pattern, command }
      } else {
        list.push({ id: cmdIdDraft, label, pattern, command })
      }
    } else {
      list.push({
        id: `cmd_${Date.now()}`,
        label,
        pattern,
        command
      })
    }
    onChange({ customCommands: list })
    setCmdIdDraft(null)
    setCmdLabel('')
    setCmdPattern('')
    setCmdLine('')
  }

  const handleEditCmd = (c: CustomCommand) => {
    setCmdIdDraft(c.id)
    setCmdLabel(c.label)
    setCmdLine(c.command)
    if (c.pattern === 'folder' || c.pattern === 'dir' || c.pattern === 'directory' || c.pattern === 'پوشه') {
      setCmdType('folder')
      setCmdPattern('folder')
    } else {
      setCmdType('ext')
      setCmdPattern(c.pattern)
    }
  }

  const handleDeleteCmd = (id: string) => {
    const list = (prefs.customCommands ?? []).filter((c) => c.id !== id)
    onChange({ customCommands: list })
    if (cmdIdDraft === id) {
      setCmdIdDraft(null)
      setCmdLabel('')
      setCmdPattern('')
      setCmdLine('')
    }
  }

  // the index page shows the live run, so «is it indexing?» is answerable without guessing
  useEffect(() => {
    if (page !== 'search') return
    let live = true
    void api.search
      .status()
      .then((s) => {
        if (live) setIndexSt(s)
      })
      .catch(() => undefined)
    const off = api.search.onProgress((p) => {
      if (live) setIndexSt((cur) => ({ ...cur, ...p }) as SearchProgress)
    })
    return () => {
      live = false
      off()
    }
  }, [page])

  const indexAge = (ts: number): string => {
    if (!ts) return t('هنوز ایندکس نشده')
    const mins = Math.round((Date.now() - ts) / 60000)
    return mins < 1 ? t('همین حالا') : `${fa(mins)} ${t('دقیقه پیش')}`
  }

  const exportSettings = async () => {
    setIoBusy(true)
    setSettingsMsg('')
    const r = await api.settings.export(prefs)
    setIoBusy(false)
    if ('canceled' in r) return
    setSettingsMsg('error' in r ? r.error : t('تنظیمات در {path} ذخیره شد', { path: r.path }))
  }

  const importSettings = async () => {
    setIoBusy(true)
    setSettingsMsg('')
    const r = await api.settings.import()
    setIoBusy(false)
    if ('canceled' in r) return
    if ('error' in r) {
      setSettingsMsg(r.error)
      return
    }
    onChange(mergePrefs(r.prefs as Partial<Prefs>))
    setSettingsMsg(t('تنظیمات وارد شد'))
  }

  useEffect(() => {
    if (page === 'launch') {
      void api.isDefaultFileManager().then(setIsDefault).catch(() => setIsDefault(false))
    }
  }, [page])

  useEffect(() => {
    const ext = appExt.trim().toLowerCase().replace(/^\./, '')
    if (!ext) {
      setAppChoices([])
      setOsDefault('')
      return
    }
    let live = true
    const probe = `/mfm-probe.${ext}`
    void api.apps
      .list(probe)
      .then((list) => {
        if (live) setAppChoices(list.map((a) => ({ id: a.id, name: a.name })))
      })
      .catch(() => undefined)
    void api.apps
      .default(probe)
      .then((d) => {
        if (live) setOsDefault(d?.name ?? '')
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [appExt])

  // while capturing, the next keydown becomes the accelerator for that command
  useEffect(() => {
    if (!capturing) return
    const onKey = (ev: KeyboardEvent) => {
      ev.preventDefault()
      ev.stopPropagation()
      if (ev.key === 'Escape') {
        setCapturing(null)
        return
      }
      const accel = accelFromEvent(ev)
      if (!accel) return
      onChange({ shortcuts: { ...prefs.shortcuts, [capturing]: accel } })
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, prefs.shortcuts])

  const conflicts = findConflicts(prefs.shortcuts)

  const row = (label: string, hint: string | null, control: React.ReactNode) => (
    <div className="pref-row">
      <div className="pref-label">
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div className="pref-control">{control}</div>
    </div>
  )

  const seg = <T extends string | number>(
    value: T,
    options: { v: T; label: string }[],
    key: keyof Prefs,
    disabled = false
  ) => (
    <div className="seg">
      {options.map((o) => (
        <button
          key={String(o.v)}
          className={value === o.v ? 'on' : ''}
          disabled={disabled}
          onClick={() => onChange({ [key]: o.v } as Partial<Prefs>)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )

  const check = (checked: boolean, key: keyof Prefs) => (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange({ [key]: e.target.checked } as Partial<Prefs>)}
      />
    </label>
  )

  return (
    <div className="modal" onMouseDown={onClose}>
      <div className="prefs" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="prefs-nav">
          <div className="prefs-title">{t(t('تنظیمات'))}</div>
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={'prefs-tab' + (page === p.id ? ' on' : '')}
              onClick={() => setPage(p.id)}
            >
              {t(p.label)}
            </button>
          ))}
          <span className="spacer" />
          <button className="prefs-tab" onClick={onClose}>{t('بستن')}</button>
        </nav>

        <section className="prefs-body">
          {page === 'appearance' && (
            <>
              {row(
                t('زبان'),
                t('فوراً اعمال می‌شود؛ کل رابط و جهت چیدمان هم عوض می‌شود'),
                seg(
                  prefs.lang,
                  [
                    { v: 'en', label: t('انگلیسی') },
                    { v: 'fa', label: t('فارسی') }
                  ],
                  'lang'
                )
              )}
              {row(
                t('تم'),
                t('«سیستم» روشن/تیرهٔ سیستم‌عامل را زنده دنبال می‌کند'),
                seg(
                  prefs.theme,
                  [
                    { v: 'dark', label: t('تیره') },
                    { v: 'light', label: t('روشن') },
                    { v: 'system', label: t('سیستم') }
                  ],
                  'theme'
                )
              )}
              {row(
                t('تم رنگی'),
                t('رنگ سطوح و لهجهٔ برنامه؛ روی حالت روشن و تیره هر دو اعمال می‌شود'),
                <div className="theme-grid">
                  {COLOR_THEMES.map((ct) => (
                    <button
                      key={ct.id}
                      className={'theme-chip' + (prefs.colorTheme === ct.id ? ' on' : '')}
                      title={t(ct.label)}
                      onClick={() => onChange({ colorTheme: ct.id })}
                    >
                      <span
                        className="theme-dot"
                        style={{
                          background: `linear-gradient(135deg, ${ct.accent} 0 52%, ${ct.surface} 52% 100%)`
                        }}
                      />
                      {t(ct.label)}
                    </button>
                  ))}
                </div>
              )}
              {row(
                t('فونت رابط کاربری'),
                t('نام فونت نصب‌شده؛ خالی = وزیرمتن'),
                <div className="font-row">
                  <input
                    className="pref-input"
                    dir="ltr"
                    list="ui-font-suggestions"
                    placeholder="Vazirmatn"
                    value={prefs.fontFamily}
                    onChange={(e) => onChange({ fontFamily: cleanFontFamily(e.target.value) })}
                  />
                  <button className="btn ghost mini" onClick={() => onChange({ fontFamily: '' })}>
                    {t('پیش‌فرض')}
                  </button>
                  <datalist id="ui-font-suggestions">
                    {FONT_SUGGESTIONS.map((f) => (
                      <option key={f} value={f} />
                    ))}
                  </datalist>
                </div>
              )}
              <div className="font-preview" dir="auto" style={{ fontFamily: fontStack(prefs.fontFamily) }}>
                {t('نمونهٔ متن')} · Aa 0123
              </div>
              {row(
                t('تایتل‌بار'),
                t('سیستم = قاب سیستم‌عامل، برنامه = نوار خود اپ'),
                seg(prefs.titlebar, [{ v: 'system', label: t('سیستم') }, { v: 'app', label: t('برنامه') }], 'titlebar')
              )}
              {row(
                t('گوشه‌های گرد پنجره'),
                prefs.titlebar === 'system' ? t('فقط با تایتل‌بار برنامه ممکن است') : null,
                <label className="check">
                  <input
                    type="checkbox"
                    checked={prefs.rounded}
                    disabled={prefs.titlebar === 'system'}
                    onChange={(e) => onChange({ rounded: e.target.checked })}
                  />
                </label>
              )}
              {row(
                t('دکمه‌های پنجره'),
                prefs.titlebar === 'system' ? t('فقط با تایتل‌بار برنامه ممکن است') : null,
                seg(
                  prefs.titlebarButtons,
                  [
                    { v: 'default', label: t('پیش‌فرض') },
                    { v: 'mcmojave', label: t('مک (McMojave)') },
                    { v: 'windows', label: t('ویندوز') },
                    { v: 'minimal', label: t('مینیمال') }
                  ],
                  'titlebarButtons',
                  prefs.titlebar === 'system'
                )
              )}
              {row(
                t('سمت دکمه‌های پنجره'),
                prefs.titlebar === 'system' ? t('فقط با تایتل‌بار برنامه ممکن است') : null,
                seg(
                  prefs.titlebarSide,
                  [
                    { v: 'left', label: t('چپ') },
                    { v: 'right', label: t('راست') }
                  ],
                  'titlebarSide',
                  prefs.titlebar === 'system'
                )
              )}
            </>
          )}

          {page === 'display' && (
            <>
              {row(t('نمای پیش‌فرض'), null, seg(prefs.view, [{ v: 'list', label: t('فهرست') }, { v: 'grid', label: t('شبکه') }], 'view'))}
              {row(
                t('اندازهٔ کاشی'),
                t('بندانگشتی و آیکون با کاشی بزرگ می‌شوند'),
                <div className="seg">
                  {[
                    { v: 88, label: t('کاشی کوچک') },
                    { v: 112, label: t('کاشی متوسط') },
                    { v: 148, label: t('کاشی بزرگ') },
                    { v: 196, label: t('کاشی بزرگ‌تر') }
                  ].map((o) => (
                    <button
                      key={o.v}
                      className={prefs.tileSize === o.v ? 'on' : ''}
                      onClick={() => onChange({ tileSize: o.v })}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
              {row(
                t('خطوط نام در نمای شبکه'),
                t('نام بلند در همین تعداد خط بریده می‌شود'),
                <div className="seg">
                  {[1, 2, 3, 4].map((n) => (
                    <button
                      key={n}
                      className={prefs.gridNameLines === n ? 'on' : ''}
                      onClick={() => onChange({ gridNameLines: n })}
                    >
                      {fa(n)}
                    </button>
                  ))}
                </div>
              )}
              {row(t('پوشه‌ها اول فهرست'), t('مانند Directory Opus و FreeCommander'), check(prefs.foldersFirst, 'foldersFirst'))}
              {row(
                t('آیکون فایل‌ها و پوشه‌ها'),
                t('Pure همراه برنامه پیش‌فرض است؛ برای آیکون‌های خود سیستم‌عامل «آیکون‌ست سیستم» را بزن'),
                seg(
                  prefs.fileIcons,
                  [
                    { v: 'pure', label: t('Pure همراه برنامه') },
                    { v: 'system', label: t('آیکون‌ست سیستم') },
                    { v: 'line', label: t('خطی') }
                  ],
                  'fileIcons'
                )
              )}
              {row(
                t('نادیده‌گرفتن فایل‌ها'),
                t('نام فایل‌هایی که هیچ‌جا نشان داده نشوند، با کاما جدا کن؛ * و ? مجاز است'),
                <div className="pref-control">
                  <input
                    className="pref-input wide"
                    dir="ltr"
                    value={prefs.ignoreFiles.join(', ')}
                    placeholder=".directory, desktop.ini"
                    onChange={(e) =>
                      onChange({
                        ignoreFiles: e.target.value
                          .split(',')
                          .map((x) => x.trim())
                          .filter(Boolean)
                      })
                    }
                  />
                  <button
                    className="btn ghost mini"
                    title={t('بازگرداندن فهرست پیش‌فرض')}
                    onClick={() => onChange({ ignoreFiles: [...DEFAULT_IGNORE_FILES] })}
                  >
                    {t('پیش‌فرض')}
                  </button>
                </div>
              )}
              {row(
                t('گروه‌بندی پیش‌فرض'),
                t('فهرست پوشه‌هایی که قالب خودشان را ندارند با این کلید گروه‌بندی می‌شود'),
                seg(
                  prefs.groupBy,
                  [
                    { v: 'none', label: t('بدون گروه‌بندی') },
                    { v: 'name', label: t('نام') },
                    { v: 'type', label: t('نوع') },
                    { v: 'size', label: t('اندازه') },
                    { v: 'date', label: t('تاریخ') },
                    { v: 'ext', label: t('پسوند') }
                  ],
                  'groupBy'
                )
              )}
              {row(
                t('نمایش فایل‌های مخفی'),
                t('پوشه‌هایی که از فهرست پنهان شده‌اند هم با این گزینه دیده می‌شوند'),
                check(prefs.showHidden, 'showHidden')
              )}
              {row(
                t('نمایش نشان پیوند نمادین'),
                t('نمایش آیکون پیوند در انتهای نام فایل‌ها و پوشه‌های دارای Symbolic Link'),
                check(prefs.showSymlink, 'showSymlink')
              )}
              {row(
                t('قالب اندازه'),
                null,
                seg(
                  prefs.sizeFormat,
                  [{ v: 'human', label: t('خوانا') }, { v: 'bytes', label: t('بایت دقیق') }],
                  'sizeFormat'
                )
              )}
              {row(
                t('قالب تاریخ'),
                null,
                seg(
                  prefs.dateFormat,
                  [
                    { v: 'jalali', label: t('شمسی') },
                    { v: 'iso', label: t('میلادی') },
                    { v: 'short', label: t('فقط ساعت') }
                  ],
                  'dateFormat'
                )
              )}
              {row(t('ثانیه در تاریخ'), null, check(prefs.showSeconds, 'showSeconds'))}
            </>
          )}

          {page === 'columns' && (
            <>
              {COLUMNS.map((c, idx) => {
                const on = prefs.columns.includes(c.id)
                const move = (delta: number) => {
                  const next = [...prefs.columns]
                  const at = next.indexOf(c.id)
                  const to = at + delta
                  if (at < 0 || to < 0 || to >= next.length) return
                  ;[next[at], next[to]] = [next[to], next[at]]
                  onChange({ columns: next })
                }
                return (
                  <div className="pref-row" key={c.id}>
                    <div className="pref-label">
                      <span>{labelOf(c)}</span>
                    </div>
                    <div className="pref-control">
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            onChange({
                              columns: e.target.checked
                                ? [...prefs.columns, c.id]
                                : prefs.columns.filter((x) => x !== c.id)
                            })
                          }
                        />
                      </label>
                      <button
                        className="tb"
                        title={t(t('بالا'))}
                        disabled={!on || idx === 0}
                        onClick={() => move(-1)}
                      >
                        ▲
                      </button>
                      <button
                        className="tb"
                        title={t(t('پایین'))}
                        disabled={!on || idx === 0}
                        onClick={() => move(1)}
                      >
                        ▼
                      </button>
                    </div>
                  </div>
                )
              })}
              <div className="hint">{t('ستون «نام» همیشه اول است. ترتیب انتخاب‌شده در فهرست اعمال می‌شود.')}</div>

              <div className="pref-group">{t('زیرنویس بندانگشتی')}</div>
              <div className="hint">
                {t('زیر نام فایل در نمای بندانگشتی، کوچک و کم‌رنگ؛ حداکثر چهار مورد.')}
              </div>
              {COLUMNS.map((c) => {
                const on = prefs.gridMeta.includes(c.id)
                return (
                  <div className="pref-row" key={'meta-' + c.id}>
                    <div className="pref-label">
                      <span>{labelOf(c)}</span>
                    </div>
                    <div className="pref-control">
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            onChange({
                              gridMeta: e.target.checked
                                ? [...prefs.gridMeta, c.id].slice(0, 4)
                                : prefs.gridMeta.filter((x) => x !== c.id)
                            })
                          }
                        />
                      </label>
                    </div>
                  </div>
                )
              })}
            </>
          )}

          {page === 'toolbar' && (
            <>
              <div className="hint">{t('دکمه‌های نوار فرمان را انتخاب و مرتب کن. نوار خالی یعنی نوار پنهان.')}</div>
              {row(
                t('ظاهر دکمه‌ها'),
                t('فقط آیکون جا بیشتری می‌دهد؛ فقط متن ساده‌تر است'),
                seg(
                  prefs.toolbarMode,
                  [
                    { v: 'icon', label: t('فقط آیکون') },
                    { v: 'icon-text', label: t('آیکون و متن') },
                    { v: 'text', label: t('فقط متن') }
                  ],
                  'toolbarMode'
                )
              )}
              {COMMANDS.map((c) => {
                const on = prefs.toolbar.includes(c.id)
                const move = (delta: number) => {
                  const next = [...prefs.toolbar]
                  const at = next.indexOf(c.id)
                  const to = at + delta
                  if (at < 0 || to < 0 || to >= next.length) return
                  ;[next[at], next[to]] = [next[to], next[at]]
                  onChange({ toolbar: next })
                }
                return (
                  <div className="pref-row" key={c.id}>
                    <div className="pref-label">
                      <span>{labelOf(c)}</span>
                      <span className="hint">{groupLabelOf(c.group)}</span>
                    </div>
                    <div className="pref-control">
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            onChange({
                              toolbar: e.target.checked
                                ? [...prefs.toolbar, c.id]
                                : prefs.toolbar.filter((x) => x !== c.id)
                            })
                          }
                        />
                      </label>
                      <button className="tb" title={t(t('بالا'))} disabled={!on} onClick={() => move(-1)}>
                        ▲
                      </button>
                      <button className="tb" title={t(t('پایین'))} disabled={!on} onClick={() => move(1)}>
                        ▼
                      </button>
                    </div>
                  </div>
                )
              })}
              <div className="pref-row">
                <div className="pref-label">
                  <span>{t(t('بازنشانی نوار ابزار'))}</span>
                </div>
                <div className="pref-control">
                  <button className="btn ghost" onClick={() => onChange({ toolbar: DEFAULT_TOOLBAR })}>{t('پیش‌فرض')}</button>
                </div>
              </div>
            </>
          )}

          {page === 'keys' && (
            <>
              {conflicts.length > 0 && (
                <div className="warn">
                  تعارض: {conflicts.map((id) => labelOf(COMMAND_BY_ID[id]) || id).join(t(' ، '))} — یک کلید
                  به چند فرمان داده شده؛ اولی در فهرست اجرا می‌شود.|is bound to several commands; the first one in the list wins.
                </div>
              )}
              {GROUP_ORDER.map((g) => (
                <div key={g}>
                  <div className="pref-group">{groupLabelOf(g)}</div>
                  {COMMANDS.filter((c) => c.group === g).map((c) => {
                    const accel = prefs.shortcuts[c.id] ?? ''
                    const bad = conflicts.includes(c.id)
                    return (
                      <div className="pref-row" key={c.id}>
                        <div className="pref-label">
                          <span className={bad ? 'bad' : ''}>{labelOf(c)}</span>
                        </div>
                        <div className="pref-control">
                          <button
                            className={'keycap' + (capturing === c.id ? ' live' : '') + (bad ? ' bad' : '')}
                            onClick={() => setCapturing(capturing === c.id ? null : c.id)}
                          >
                            {capturing === c.id ? t('کلید را بزن…') : accel ? formatAccel(accel) : t('بدون کلید')}
                          </button>
                          <button
                            className="tb"
                            title={t(t('حذف کلید'))}
                            onClick={() =>
                              onChange({ shortcuts: { ...prefs.shortcuts, [c.id]: '' } })
                            }
                          >
                            <XIcon size={11} />
                          </button>
                          <button
                            className="tb"
                            title={t(t('پیش‌فرض'))}
                            onClick={() =>
                              onChange({
                                shortcuts: { ...prefs.shortcuts, [c.id]: DEFAULT_SHORTCUTS[c.id] }
                              })
                            }
                          >
                            ↺
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}
              <div className="pref-row">
                <div className="pref-label">
                  <span>{t(t('بازنشانی همهٔ کلیدها'))}</span>
                </div>
                <div className="pref-control">
                  <button className="btn ghost" onClick={() => onChange({ shortcuts: DEFAULT_SHORTCUTS })}>{t('همه پیش‌فرض')}</button>
                </div>
              </div>
            </>
          )}

          {page === 'layout' && (
            <>
              {row(
                t('چیدمان پنجره'),
                t('تک‌پنجره = مثل Explorer، دوپنجره = مثل Total Commander'),
                seg(prefs.layout, [{ v: 'single', label: t('تک‌پنجره') }, { v: 'dual', label: t('دوپنجره') }], 'layout')
              )}
              {row(
                t('سایدبار'),
                null,
                seg(prefs.sidebar, [{ v: 'docked', label: t('چسبیده') }, { v: 'float', label: t('شناور') }], 'sidebar')
              )}
              {row(
                t('درخت پوشه‌ها (پنل جدا)'),
                t('یک پنل مستقل برای درخت پوشه‌ها، جدا از سایدبار و پنجره‌ها؛ جای آن را انتخاب کن'),
                seg(
                  prefs.treePane,
                  [
                    { v: 'off', label: t('خاموش') },
                    { v: 'left', label: t('چپ') },
                    { v: 'right', label: t('راست') }
                  ],
                  'treePane'
                )
              )}
              {row(
                t('درخت، پوشهٔ جاری را دنبال کند'),
                t('با هر تغییر پوشه در پنل فعال، درخت خودش همان پوشه را باز و نمایان می‌کند'),
                check(prefs.treeAutoFocus, 'treeAutoFocus')
              )}
              {row(
                t('حافظه‌های جانبی در سایدبار'),
                t('بخش USB و دیسک‌های جداشدنی در سایدبار نمایش داده شود'),
                check(prefs.sidebarDrives, 'sidebarDrives')
              )}
              {row(
                t('سطح رنگ تم سایدبار'),
                t('تنظیم میزان غلظت رنگ تم روی سایدبار در ۶ سطح (۱ = کمترین رنگ، ۶ = پررنگ‌ترین)'),
                seg(
                  prefs.sidebarTone,
                  [
                    { v: 1, label: fa(1) },
                    { v: 2, label: fa(2) },
                    { v: 3, label: fa(3) },
                    { v: 4, label: fa(4) },
                    { v: 5, label: fa(5) },
                    { v: 6, label: fa(6) }
                  ],
                  'sidebarTone'
                )
              )}
              {row(
                t('پنهان‌کردن نوار تب با یک تب'),
                t('وقتی پنل فقط یک تب دارد، نوار بالای فهرست حذف می‌شود؛ در دوپنجره اگر یک طرف چند تب داشته باشد، نوار هر دو طرف می‌ماند'),
                check(prefs.hideSingleTab, 'hideSingleTab')
              )}
              {row(
                t('آیکون در تب‌ها'),
                t('آیکون خود پوشهٔ هر تب کنار نامش نمایش داده شود'),
                check(prefs.tabIcons, 'tabIcons')
              )}
            </>
          )}

          {page === 'agents' && (
            <AgentsPage />
          )}

          {page === 'search' && (
            <>
              <div className="pref-row">
                <div className="pref-label">{t('وضعیت ایندکس')}</div>
                <div className="pref-value dim" dir="auto">
                  {indexSt?.running
                    ? t('در حال ایندکس: {scanned} بررسی‌شده · پوشهٔ {done}/{total}', {
                        scanned: fa(indexSt.scanned),
                        done: fa(indexSt.done),
                        total: fa(indexSt.total)
                      })
                    : indexSt?.error
                      ? t('ایندکس متوقف شد: {error}', { error: indexSt.error })
                      : indexSt?.files
                        ? t('{files} فایل · {dirs} پوشه · آخرین ایندکس {age}', {
                            files: fa(indexSt.files),
                            dirs: fa(indexSt.dirs),
                            age: indexAge(indexSt.lastIndex)
                          })
                        : t('هنوز ایندکس نشده')}
                </div>
                <button
                  className="btn ghost"
                  disabled={!!indexSt?.running}
                  onClick={() => void api.search.index({ roots: searchRoots, exclude: prefs.searchExclude })}
                >
                  {t('به‌روزرسانی ایندکس')}
                </button>
              </div>
              <div className="hint">
                {t('ایندکس روی این پوشه‌ها ساخته می‌شود (خالی = پوشه‌های پیش‌فرض سیستم: Documents, Downloads, Desktop, Pictures, Music, Videos). جست‌وجو با {key} یا دو بار Shift.', {
                  key: prefs.shortcuts.searchIndex || 'Ctrl+K'
                })}
              </div>
              {row(
                t('باز کردن جست‌وجوی گلوبال با دو بار Shift'),
                t('برای عوض کردن کلید، تنظیمات → کلید میان‌بر → جست‌وجوی گلوبال'),
                check(prefs.doubleShiftSearch, 'doubleShiftSearch')
              )}
              <div className="preset-list">
                {prefs.searchRoots.length === 0 && (
                  <div className="dim">{t(t('پوشهٔ پیش‌فرض سیستم استفاده می‌شود'))}</div>
                )}
                {prefs.searchRoots.map((r) => (
                  <div className="preset-row" key={r}>
                    <span className="preset-name" dir="auto">
                      {r}
                    </span>
                    <button
                      className="tb"
                      title={t(t('حذف از ایندکس'))}
                      onClick={() =>
                        onChange({ searchRoots: prefs.searchRoots.filter((x) => x !== r) })
                      }
                    >
                      <XIcon size={11} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="preset-save">
                <input
                  className="pref-input wide"
                  dir="ltr"
                  placeholder="/path/to/folder"
                  value={newRoot}
                  onChange={(e) => setNewRoot(e.target.value)}
                />
                <button
                  className="btn"
                  disabled={!newRoot.startsWith('/')}
                  onClick={() => {
                    onChange({ searchRoots: [...prefs.searchRoots, newRoot.trim()] })
                    setNewRoot('')
                  }}
                >{t('افزودن پوشه')}</button>
              </div>
              {row(
                t('استثناها'),
                t('با کاما جدا کن؛ * هم مجاز است (مثلاً node_modules, *.tmp)'),
                <input
                  className="pref-input wide"
                  dir="ltr"
                  value={prefs.searchExclude.join(', ')}
                  onChange={(e) =>
                    onChange({
                      searchExclude: e.target.value
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean)
                    })
                  }
                />
              )}
            </>
          )}

          {page === 'filetypes' && (
            <>
              <div className="hint">{t('برای هر پسوند یک رنگ بگذار؛ نقطهٔ رنگی کنار نام فایل در فهرست دیده می‌شود.')}</div>
              <div className="preset-save">
                <input
                  className="pref-input"
                  dir="ltr"
                  placeholder={t(t('پسوند، مثلاً pdf'))}
                  value={extInput}
                  onChange={(e) => setExtInput(e.target.value.replace(/^\./, '').toLowerCase())}
                />
                {palette.map((c) => (
                  <button
                    key={c.id}
                    className="swatch"
                    title={t(c.name)}
                    style={{ background: c.color }}
                    disabled={!extInput.trim()}
                    onClick={() =>
                      onChange({
                        fileTypes: { ...prefs.fileTypes, [extInput.trim()]: c.color }
                      })
                    }
                  />
                ))}
              </div>
              <div className="preset-list">
                {Object.keys(prefs.fileTypes).length === 0 && (
                  <div className="dim">{t(t('هنوز پسوندی رنگ نگرفته'))}</div>
                )}
                {Object.entries(prefs.fileTypes).map(([ext, color]) => (
                  <div className="preset-row" key={ext}>
                    <span className="ftdot" style={{ background: color }} />
                    <span className="preset-name" dir="ltr">
                      .{ext}
                    </span>
                    <button
                      className="tb"
                      title={t(t('حذف'))}
                      onClick={() => {
                        const next = { ...prefs.fileTypes }
                        delete next[ext]
                        onChange({ fileTypes: next })
                      }}
                    >
                      <XIcon size={11} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {page === 'defaultApps' && (
            <>
              <div className="hint">
                {t(
                  'برای هر پسوند مشخص کن کدام برنامه باز شود؛ بدون تنظیم، برنامهٔ پیش‌فرض سیستم استفاده می‌شود.'
                )}
              </div>
              {Object.entries(prefs.defaultApps)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([ext, app]) => (
                  <div className="pref-row" key={ext}>
                    <div className="pref-label">
                      <span dir="ltr">.{ext}</span>
                      <span className="hint">{app.name}</span>
                    </div>
                    <div className="pref-control">
                      <button
                        className="btn ghost mini"
                        onClick={() => {
                          setAppExt(ext)
                          setAppIdDraft(app.id)
                        }}
                      >
                        {t('تغییر')}
                      </button>
                      <button
                        className="btn ghost mini"
                        onClick={() => {
                          const next = { ...prefs.defaultApps }
                          delete next[ext]
                          onChange({ defaultApps: next })
                        }}
                      >
                        {t('حذف')}
                      </button>
                    </div>
                  </div>
                ))}
              <div className="preset-save">
                <input
                  className="pref-input"
                  dir="ltr"
                  placeholder={t('پسوند')}
                  value={appExt}
                  onChange={(e) => {
                    setAppExt(e.target.value)
                    setAppIdDraft('')
                  }}
                />
                <select
                  className="pref-input"
                  value={appIdDraft}
                  onChange={(e) => setAppIdDraft(e.target.value)}
                >
                  <option value="">{t('انتخاب برنامه…')}</option>
                  {(appIdDraft && !appChoices.some((a) => a.id === appIdDraft)
                    ? [{ id: appIdDraft, name: prefs.defaultApps[appExt]?.name ?? appIdDraft }, ...appChoices]
                    : appChoices
                  ).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <button
                  className="btn"
                  disabled={!appExt.trim() || !appIdDraft}
                  onClick={() => {
                    const ext = appExt.trim().toLowerCase().replace(/^\./, '')
                    if (!/^[a-z0-9._+-]{1,24}$/.test(ext) || !appIdDraft) return
                    const app = appChoices.find((a) => a.id === appIdDraft)
                    onChange({
                      defaultApps: {
                        ...prefs.defaultApps,
                        [ext]: { id: appIdDraft, name: app?.name ?? appIdDraft }
                      }
                    })
                    setAppExt('')
                    setAppIdDraft('')
                  }}
                >
                  {t('ذخیره')}
                </button>
              </div>
              <div className="hint">
                {osDefault
                  ? t('پیش‌فرض سیستم: {name}', { name: osDefault })
                  : appExt.trim()
                    ? t('برنامه‌ای برای این پسوند پیدا نشد')
                    : t('بدون نقطه؛ مثلاً png')}
              </div>

              <div className="pref-section-title" style={{ marginTop: 24 }}>
                {t('دستورهای سفارشی (Open with)')}
              </div>
              <div className="hint">
                {t(
                  'برای پسوندها یا پوشه‌ها دستور سفارشی تعریف کن که در پس‌زمینه اجرا شود. %f با مسیر فایل یا پوشه جایگزین می‌شود.'
                )}
              </div>
              {(prefs.customCommands ?? []).map((cmd) => (
                <div className="pref-row" key={cmd.id}>
                  <div className="pref-label">
                    <span className="badge" dir="ltr" style={{ fontWeight: 600 }}>
                      {cmd.pattern === 'folder' ? t('پوشه') : cmd.pattern === '*' ? t('همه') : `.${cmd.pattern}`}
                    </span>
                    <span>{cmd.label}</span>
                    <span className="hint" dir="ltr" style={{ fontSize: '0.85em', opacity: 0.8 }}>
                      {cmd.command}
                    </span>
                  </div>
                  <div className="pref-control">
                    <button className="btn ghost mini" onClick={() => handleEditCmd(cmd)}>
                      {t('ویرایش')}
                    </button>
                    <button className="btn ghost mini" onClick={() => handleDeleteCmd(cmd.id)}>
                      {t('حذف')}
                    </button>
                  </div>
                </div>
              ))}
              <div className="preset-save" style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', gap: 6, width: '100%' }}>
                  <button
                    type="button"
                    className={'btn mini' + (cmdType === 'ext' ? ' primary' : ' ghost')}
                    onClick={() => setCmdType('ext')}
                  >
                    {t('پسوند فایل')}
                  </button>
                  <button
                    type="button"
                    className={'btn mini' + (cmdType === 'folder' ? ' primary' : ' ghost')}
                    onClick={() => {
                      setCmdType('folder')
                      setCmdPattern('folder')
                    }}
                  >
                    {t('پوشه')}
                  </button>
                </div>
                <input
                  className="pref-input"
                  style={{ minWidth: 160 }}
                  placeholder={t('عنوان در منو (مثلاً باز کردن در کد)')}
                  value={cmdLabel}
                  onChange={(e) => setCmdLabel(e.target.value)}
                />
                {cmdType === 'ext' && (
                  <input
                    className="pref-input"
                    dir="ltr"
                    style={{ width: 110 }}
                    placeholder={t('پسوند (مثلاً pdf)')}
                    value={cmdPattern}
                    onChange={(e) => setCmdPattern(e.target.value)}
                  />
                )}
                <input
                  className="pref-input"
                  dir="ltr"
                  style={{ flex: 1, minWidth: 180 }}
                  placeholder={t('دستور با %f (مثلاً code %f)')}
                  value={cmdLine}
                  onChange={(e) => setCmdLine(e.target.value)}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={!cmdLabel.trim() || !cmdLine.trim() || (cmdType === 'ext' && !cmdPattern.trim())}
                  onClick={handleSaveCmd}
                >
                  {cmdIdDraft ? t('به‌روزرسانی') : t('افزودن')}
                </button>
                {cmdIdDraft && (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      setCmdIdDraft(null)
                      setCmdLabel('')
                      setCmdPattern('')
                      setCmdLine('')
                    }}
                  >
                    {t('انصراف')}
                  </button>
                )}
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                {t('راهنما: %f با مسیر فایل یا پوشه جایگزین می‌شود. مثال: code %f یا subl %f یا python %f')}
              </div>
            </>
          )}

          {page === 'archive' && (
            <>
              {row(
                t('سطح فشرده‌سازی zip'),
                t('۰ = بدون فشرده‌سازی (سریع‌ترین)، ۹ = بیشترین فشرده‌سازی'),
                <div className="inline-field">
                  <input
                    type="number"
                    min={0}
                    max={9}
                    value={prefs.zipLevel}
                    onChange={(e) =>
                      onChange({ zipLevel: Math.min(9, Math.max(0, Number(e.target.value) || 0)) })
                    }
                  />
                </div>
              )}
              {row(
                t('قالب ذخیرهٔ تصویر'),
                t('فقط روی «ذخیره به‌عنوان کپی» اثر دارد؛ جایگزینی همیشه قالب خود فایل را نگه می‌دارد'),
                seg(
                  prefs.imageFormat,
                  [
                    { v: 'png', label: 'PNG' },
                    { v: 'jpeg', label: 'JPEG' },
                    { v: 'webp', label: 'WebP' }
                  ],
                  'imageFormat'
                )
              )}
              {row(
                t('کیفیت تصویر'),
                t('۵۰ تا ۱۰۰؛ برای PNG بی‌اثر است'),
                <div className="inline-field">
                  <input
                    type="number"
                    min={50}
                    max={100}
                    step={5}
                    value={prefs.imageQuality}
                    onChange={(e) =>
                      onChange({ imageQuality: Math.min(100, Math.max(50, Number(e.target.value) || 90)) })
                    }
                  />
                  <span>%</span>
                </div>
              )}
              {row(
                t('فاصلهٔ پخش خودکار گالری'),
                t('ثانیه بین دو عکس در حالت اسلاید'),
                <div className="inline-field">
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={prefs.slideshowSec}
                    onChange={(e) =>
                      onChange({ slideshowSec: Math.min(60, Math.max(1, Number(e.target.value) || 3)) })
                    }
                  />
                  <span>{t(t('ثانیه'))}</span>
                </div>
              )}
              {row(t('حلقه‌ای بودن گالری'), t('در آخرین عکس به اولی برگردد'), check(prefs.galleryLoop, 'galleryLoop'))}
              {row(
                t('سقف پیش‌نمایش متن'),
                t('کیلوبایت؛ فایل بزرگ‌تر بریده می‌شود'),
                <div className="inline-field">
                  <input
                    type="number"
                    min={16}
                    max={8192}
                    step={16}
                    value={prefs.previewMaxKB}
                    onChange={(e) =>
                      onChange({ previewMaxKB: Math.min(8192, Math.max(16, Number(e.target.value) || 200)) })
                    }
                  />
                  <span>KB</span>
                </div>
              )}
            </>
          )}

          {page === 'transfer' && (
            <>
              {row(
                t('رد کردن فایل‌های موجود'),
                t('اگر نامی در مقصد هست، همان‌جا بمانَد و کپی نشود (به‌جای ساختن «نام (۲)»)'),
                check(prefs.transferSkipExisting, 'transferSkipExisting')
              )}
              {row(
                t('فقط جدیدترها'),
                t('اگر فایل مقصد جدیدتر یا هم‌زمان باشد، منتقل نشود'),
                check(prefs.transferNewerOnly, 'transferNewerOnly')
              )}
              {row(
                t('محدودیت سرعت'),
                t('کیلوبایت بر ثانیه؛ ۰ یعنی بی‌نهایت'),
                <div className="inline-field">
                  <input
                    type="number"
                    min={0}
                    step={256}
                    value={prefs.speedLimitKB}
                    onChange={(e) =>
                      onChange({ speedLimitKB: Math.max(0, Number(e.target.value) || 0) })
                    }
                  />
                  <span>KB/s</span>
                </div>
              )}
              <div className="hint">
                {t('فیلترها روی هر سه مسیر کپی/انتقال (دکمه‌ها، کلیدها و کشیدن‌و‌رهاکردن) اعمال می‌شوند و تعداد فایل‌های رد‌شده در نوار عملیات‌ها نوشته می‌شود.')}
              </div>
            </>
          )}

          {page === 'operations' && (
            <>
              {row(
                t('دوبار کلیک روی فایل'),
                null,
                seg(
                  prefs.doubleClick,
                  [
                    { v: 'open', label: t('اجرا') },
                    { v: 'gallery', label: t('گالری') },
                    { v: 'preview', label: t('پیش‌نمایش') }
                  ],
                  'doubleClick'
                )
              )}
              {row(t('تأیید پیش از حذف'), t('پرسش قبل از سطل بازیافت یا حذف قطعی'), check(prefs.confirmDelete, 'confirmDelete'))}
              {row(t('حذف پیش‌فرض به سطل بازیافت'), t('خاموش = حذف قطعی'), check(prefs.trashByDefault, 'trashByDefault'))}
            </>
          )}

          {page === 'launch' && (
            <>
              {row(
                t('کلید سراسری باز کردن'),
                t('روی X11 کار می‌کند؛ روی Wayland باید همان کلید را در تنظیمات KDE به «Add Command» بدهی (راهنما در docs/INTEGRATION.md)'),
                check(prefs.hotkeyEnabled, 'hotkeyEnabled')
              )}
              {row(
                t('ترکیب کلید'),
                t('مثال: Super+E یا Ctrl+Alt+M'),
                <input
                  className="pref-input"
                  dir="ltr"
                  value={prefs.hotkey}
                  onChange={(e) => onChange({ hotkey: e.target.value })}
                />
              )}
            </>
          )}

          {page === 'launch' && (
            <>
              {row(
                t('انتخابگر فایل مکس برای برنامه‌های دیگر'),
                t('فایرفاکس و برنامه‌های سازگار با XDG، دیالوگ باز کردن و ذخیره فایل را با مکس نمایش می‌دهند'),
                <label className="check">
                  <input
                    type="checkbox"
                    checked={prefs.portalPicker}
                    disabled={portalBusy}
                    onChange={async (e) => {
                      const enabled = e.target.checked
                      setPortalBusy(true)
                      setPortalMsg('')
                      try {
                        const result = await api.portal.configure(enabled)
                        onChange({ portalPicker: enabled ? result.installed : result.installed ? prefs.portalPicker : false })
                        if (result.error) setPortalMsg(result.error)
                        else setPortalMsg(enabled ? t('انتخابگر فایل مکس فعال شد') : t('انتخابگر فایل مکس غیرفعال شد'))
                      } finally {
                        setPortalBusy(false)
                      }
                    }}
                  />
                </label>
              )}
              {portalMsg && <div className="hint" dir="auto">{portalMsg}</div>}
              {row(
                t('تک‌نمونه (single instance)'),
                t('اجرای دوباره، پنجرهٔ موجود را جلو می‌آورد · با راه‌اندازی بعدی اعمال می‌شود'),
                check(prefs.singleInstance, 'singleInstance')
              )}
              {row(
                t('شروع برنامه'),
                t('نشست قبلی را برگردان یا همیشه یک پوشه را باز کن'),
                seg(
                  prefs.startup,
                  [
                    { v: 'session', label: t('نشست قبلی') },
                    { v: 'folder', label: t('پوشهٔ مشخص') }
                  ],
                  'startup'
                )
              )}
              {row(
                t('پوشهٔ شروع'),
                prefs.startup === 'session'
                  ? t('در حالت «نشست قبلی» استفاده نمی‌شود')
                  : t('خالی = پوشهٔ خانه'),
                <input
                  className="pref-input"
                  dir="ltr"
                  value={prefs.startFolder}
                  placeholder="/home/…"
                  disabled={prefs.startup === 'session'}
                  onChange={(e) => onChange({ startFolder: e.target.value })}
                />
              )}
              {row(
                t('کوچک‌کردن به سینی'),
                prefs.singleInstance
                  ? t('پنجره پنهان می‌شود و آیکون در سینی می‌ماند')
                  : t('فقط با تک‌نمونه در دسترس است'),
                <label className="check">
                  <input
                    type="checkbox"
                    checked={prefs.minimizeToTray}
                    disabled={!prefs.singleInstance}
                    onChange={(e) => onChange({ minimizeToTray: e.target.checked })}
                  />
                </label>
              )}
              {row(
                t('بستن به سینی'),
                prefs.singleInstance
                  ? t('بستن پنجره برنامه را نمی‌بندد؛ از منوی سینی خارج شو')
                  : t('فقط با تک‌نمونه در دسترس است'),
                <label className="check">
                  <input
                    type="checkbox"
                    checked={prefs.closeToTray}
                    disabled={!prefs.singleInstance}
                    onChange={(e) => onChange({ closeToTray: e.target.checked })}
                  />
                </label>
              )}
              {row(
                t('مدیر فایل پیش‌فرض سیستم'),
                isDefault
                  ? t('این برنامه مدیر فایل پیش‌فرض سیستم برای باز کردن پوشه‌ها است')
                  : t('باز کردن پوشه‌ها از برنامه‌های دیگر در این برنامه انجام شود'),
                <button
                  type="button"
                  className="btn"
                  disabled={isDefault === true || settingDefault}
                  onClick={async () => {
                    setSettingDefault(true)
                    try {
                      const res = await api.setDefaultFileManager()
                      if (res.ok) setIsDefault(true)
                    } finally {
                      setSettingDefault(false)
                    }
                  }}
                >
                  {isDefault ? t('پیش‌فرض است') : settingDefault ? t('در حال تنظیم…') : t('تنظیم به عنوان پیش‌فرض')}
                </button>
              )}
            </>
          )}

          {page === 'advanced' && (
            <>
              <div className="pref-row">
                <div className="pref-label">{t('تنظیمات')}</div>
                <div className="pref-value">
                  <button className="btn" disabled={ioBusy} onClick={() => void exportSettings()}>
                    {t('خروجی تنظیمات…')}
                  </button>
                  <button className="btn ghost" disabled={ioBusy} onClick={() => void importSettings()}>
                    {t('ورود تنظیمات…')}
                  </button>
                </div>
              </div>
              {settingsMsg && <div className="hint" dir="auto">{settingsMsg}</div>}
              <div className="hint">
                {t('پک‌های آیکون افزوده‌شده:')} {prefs.iconDirs.length ? prefs.iconDirs.join(' · ') : t('هیچ')}
              </div>
              <div className="hint">{t('تنظیمات در')} <code>search.db</code> {t('کنار پروفایل برنامه ذخیره می‌شود؛ رنگ و آیکون هر پوشه در فایل')} <code>.mfm.json</code> {t('داخل خود پوشه.')}</div>
              <div className="hint">
                {t('دسته‌های بعدی طبق نقشهٔ راه (docs/PREFERENCES.md): ستون‌های سفارشی، نوار ابزار و کلیدها، فیلتر و مرتب‌سازی، تب‌ها، درخت پوشه، بایگانی، شبکه.')}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
