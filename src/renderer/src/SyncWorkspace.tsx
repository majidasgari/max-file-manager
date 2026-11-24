import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { t } from './i18n.ts'
import {
  api,
  type RsyncOptions,
  type SyncEncryption,
  type SyncIgnoreRule,
  type SyncJob,
  type SyncMode,
  type SyncPlan,
  type SyncProgress,
  type SyncRow,
  type SyncRunSummary,
  type SyncSnapshot,
  type SyncVersions
} from './api'
import { baseName, fa, fmtDate, fmtSize } from './format'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  EyeIcon,
  MinusIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SwapIcon,
  TrashIcon,
  XIcon
} from './Icons'
import { isRemotePath, parseRemote } from '../../shared/remote-path.ts'
import { newSyncJobId } from '../../shared/sync.ts'
import {
  conflictFacts,
  durationText,
  filterSyncRows,
  globRules,
  relativeSpan,
  ruleKey,
  STATUS_FILTERS,
  type Span,
  type StatusFilter
} from './sync-view.ts'

type Tab = 'rows' | 'conflicts' | 'ignore' | 'history' | 'jobs' | 'versions'

type Props = {
  left: string
  right: string
  initialMode: SyncMode
  compareBy: 'mtime' | 'hash'
  ignoreRules: SyncIgnoreRule[]
  deleteExtra: boolean
  jobs: SyncJob[]
  onClose(): void
  onSaveJobs(jobs: SyncJob[]): void
  onOpenJob(job: SyncJob): void
  /** remember the chosen direction for this pair, so the pill and the next open agree */
  onModeChange?(mode: SyncMode): void
  /** open a restored temp tree in one of the panes */
  onOpenPath?(path: string, side: 'left' | 'right'): void
  onFinished?(): void
}

const STATE_LABEL: Record<string, string> = {
  same: 'یکسان',
  leftOnly: 'فقط چپ',
  rightOnly: 'فقط راست',
  leftNewer: 'چپ جدیدتر',
  rightNewer: 'راست جدیدتر',
  sizeDiff: 'اندازه متفاوت',
  contentDiff: 'محتوا متفاوت',
  typeDiff: 'نوع متفاوت',
  conflict: 'تعارض'
}

const CONFLICT_LABEL: Record<string, string> = {
  bothChanged: 'هر دو طرف از آخرین همگام‌سازی تغییر کرده‌اند',
  editDelete: 'یک طرف تغییر کرده، طرف دیگر حذف شده',
  bothNew: 'در هر دو طرف با محتوای متفاوت ساخته شده',
  typeDiff: 'در یک طرف فایل، در طرف دیگر پوشه'
}

const ROW_H = 28

const SIZE_MULT: Record<'B' | 'KB' | 'MB' | 'GB', number> = {
  B: 1,
  KB: 1024,
  MB: 1024 ** 2,
  GB: 1024 ** 3
}

const ruleKindLabel = (r: SyncIgnoreRule): string =>
  r.kind === 'glob'
    ? t('الگو (glob)')
    : r.kind === 'regex'
      ? 'Regex'
      : r.kind === 'path'
        ? t('مسیر')
        : t('حجم')

const ruleText = (r: SyncIgnoreRule): string =>
  r.kind === 'size' ? `${r.op === 'gt' ? '>' : '<'} ${fmtSize(r.bytes, false)}` : r.value

const jobFor = (jobs: SyncJob[], left: string, right: string): SyncJob | undefined =>
  jobs.find((j) => j.left === left && j.right === right)
const currentEvery = (jobs: SyncJob[], left: string, right: string): number =>
  jobFor(jobs, left, right)?.schedule.everyMinutes ?? 0
const currentCron = (jobs: SyncJob[], left: string, right: string): string =>
  jobFor(jobs, left, right)?.schedule.cron ?? ''

/** The three-state checkbox in the table head; `indeterminate` has no HTML attribute. */
function SelectAll({
  checked,
  indeterminate,
  disabled,
  onChange
}: {
  checked: boolean
  indeterminate: boolean
  disabled: boolean
  onChange(): void
}) {
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked
  }, [indeterminate, checked])
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={t('انتخاب همه')}
    />
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange(on: boolean): void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={'toggle' + (on ? ' on' : '')}
      onClick={() => onChange(!on)}
    >
      <span className="knob" />
      <span>{label}</span>
    </button>
  )
}

function Stepper({
  value,
  min,
  max,
  onStep,
  format
}: {
  value: number
  min: number
  max: number
  onStep(delta: number): void
  format?(n: number): string
}) {
  return (
    <span className="stepper">
      <button className="tb" disabled={value <= min} onClick={() => onStep(-1)} aria-label={t('کمتر')}>
        <MinusIcon />
      </button>
      <span className="stepper-value" dir="ltr">
        {format ? format(value) : fa(value)}
      </span>
      <button className="tb" disabled={value >= max} onClick={() => onStep(1)} aria-label={t('بیشتر')}>
        <PlusIcon size={11} />
      </button>
    </span>
  )
}

type EncState = { mode: 'off' | 'passphrase' | 'keypair'; secretId: string; recipient: string }
const toEncState = (e?: SyncEncryption): EncState =>
  e
    ? { mode: e.mode, secretId: e.secretId, recipient: e.recipient ?? '' }
    : { mode: 'off', secretId: '', recipient: '' }
const fromEncState = (s: EncState): SyncEncryption | undefined =>
  s.mode === 'off'
    ? undefined
    : { mode: s.mode, secretId: s.secretId, ...(s.recipient.trim() ? { recipient: s.recipient.trim() } : {}) }

const labelOfState = (state: string): string => t(STATE_LABEL[state] ?? state)
const labelOfConflict = (kind: string | undefined): string => t(CONFLICT_LABEL[kind ?? ''] ?? kind ?? '')

/**
 * A direction rendered as words and an icon, not as a text arrow: bidi keeps a `→` character
 * pointing right in an RTL paragraph, which is exactly the wrong visual direction there.
 */
function ModeLabel({ mode }: { mode: SyncMode }) {
  if (mode === 'both') return <>{t('دوطرفه')}</>
  const rtl = document.documentElement.dir === 'rtl'
  const pointsRight = (mode === 'ltr') !== rtl
  return (
    <span className="mode-label">
      <span>{t('چپ')}</span>
      {pointsRight ? <ArrowRightIcon size={10} /> : <ArrowLeftIcon size={10} />}
      <span>{t('راست')}</span>
    </span>
  )
}

function toneOf(state: string): string {
  if (state === 'conflict') return 'warn'
  if (state === 'leftOnly' || state === 'leftNewer') return 'add'
  if (state === 'rightOnly' || state === 'rightNewer') return 'del'
  if (state === 'same') return ''
  return 'warn'
}

/** A virtualised comparison table; only the visible rows exist in the DOM. */
function Rows({
  rows,
  selected,
  onToggle
}: {
  rows: SyncRow[]
  selected: Set<string>
  onToggle(rel: string): void
}) {
  const box = useRef<HTMLDivElement | null>(null)
  const [scroll, setScroll] = useState(0)
  const [height, setHeight] = useState(420)
  const measure = (el: HTMLDivElement | null): void => {
    box.current = el
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
  }
  // filtering can shrink the list under the current scroll offset; never slice past its end
  const raw = Math.max(0, Math.floor(scroll / ROW_H) - 6)
  const start = Math.min(raw, Math.max(0, rows.length - Math.ceil(height / ROW_H) - 10))
  const end = Math.min(rows.length, start + Math.ceil(height / ROW_H) + 10)
  return (
    <div className="sync-rows" ref={measure} onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
      <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
        {rows.slice(start, end).map((r, i) => {
          const at = start + i
          const size = (s?: { size: number; dir: boolean }): string =>
            s ? (s.dir ? t('پوشه') : fmtSize(s.size, false)) : '—'
          return (
            <div
              className="sync-row"
              key={r.rel}
              style={{ position: 'absolute', top: at * ROW_H, insetInline: 0, height: ROW_H }}
            >
              <span className="sync-check">
                <input
                  type="checkbox"
                  checked={selected.has(r.rel)}
                  disabled={r.state === 'same'}
                  onChange={() => onToggle(r.rel)}
                  aria-label={t('انتخاب')}
                />
              </span>
              <span className="sync-side dim">{size(r.left)}</span>
              <span className={'chip ' + toneOf(r.state)}>{labelOfState(r.state)}</span>
              {/* dir=auto: a Persian relative path reads right-to-left, a Latin one left-to-right */}
              <span className="sync-rel" dir="auto" title={r.rel}>
                {r.rel}
              </span>
              <span className="sync-side dim">{size(r.right)}</span>
            </div>
          )
        })}
      </div>
      {!rows.length && <div className="sync-empty dim">{t('ردیفی نیست')}</div>}
    </div>
  )
}

export function SyncWorkspace({
  left,
  right,
  initialMode,
  compareBy: initialCompareBy,
  ignoreRules: initialIgnoreRules,
  deleteExtra: initialDeleteExtra,
  jobs,
  onClose,
  onSaveJobs,
  onOpenJob,
  onModeChange,
  onOpenPath,
  onFinished
}: Props) {
  const [mode, setMode] = useState<SyncMode>(initialMode)
  const pickMode = (next: SyncMode): void => {
    setMode(next)
    onModeChange?.(next)
  }
  const [compareBy, setCompareBy] = useState<'mtime' | 'hash'>(initialCompareBy)
  const [rules, setRules] = useState<SyncIgnoreRule[]>(initialIgnoreRules)
  const [deleteExtra, setDeleteExtra] = useState(initialDeleteExtra)
  const [rows, setRows] = useState<SyncRow[]>([])
  const [plan, setPlan] = useState<SyncPlan | null>(null)
  const [capped, setCapped] = useState(false)
  const [leftCount, setLeftCount] = useState(0)
  const [rightCount, setRightCount] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [resolutions, setResolutions] = useState<Record<string, 'left' | 'right' | 'skip'>>({})
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [tab, setTab] = useState<Tab>('rows')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [confirm, setConfirm] = useState<{ deletes: number; remote: number } | null>(null)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [history, setHistory] = useState<SyncRunSummary[]>([])
  const [restoreId, setRestoreId] = useState<string | null>(null)
  const [jobName, setJobName] = useState(`${baseName(left)} → ${baseName(right)}`)
  const initEvery = currentEvery(jobs, left, right)
  const [intervalOn, setIntervalOn] = useState(initEvery > 0)
  const [everyUnit, setEveryUnit] = useState<'min' | 'hour'>(initEvery > 0 && initEvery % 60 === 0 ? 'hour' : 'min')
  const [everyAmount, setEveryAmount] = useState(() =>
    initEvery <= 0 ? 30 : initEvery % 60 === 0 ? initEvery / 60 : initEvery
  )
  const [cron, setCron] = useState(currentCron(jobs, left, right))
  const [onStart, setOnStart] = useState(false)
  const [onMount, setOnMount] = useState(false)
  const [onChange, setOnChange] = useState(false)
  const [ruleKind, setRuleKind] = useState<'glob' | 'regex' | 'path' | 'size'>('glob')
  const [ruleValue, setRuleValue] = useState('')
  const [sizeOp, setSizeOp] = useState<'gt' | 'lt'>('gt')
  const [sizeAmount, setSizeAmount] = useState('10')
  const [sizeUnit, setSizeUnit] = useState<'B' | 'KB' | 'MB' | 'GB'>('MB')

  const ignored = useMemo(() => globRules(rules), [rules])
  const visibleRows = useMemo(() => filterSyncRows(rows, statusFilter), [rows, statusFilter])
  const selectableRows = visibleRows.filter((r) => r.state !== 'same')
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.rel))
  const someSelected = selectableRows.some((r) => selected.has(r.rel))
  const rtl = document.documentElement.dir === 'rtl'
  const count = (state: string): number => rows.filter((r) => r.state === state).length
  const conflicts = plan?.conflicts ?? []
  const unresolved = conflicts.filter((c) => !resolutions[c.rel] || resolutions[c.rel] === 'skip')
  const currentJob = jobs.find((j) => j.left === left && j.right === right)
  const [useRsync, setUseRsync] = useState(currentJob?.useRsync === true)
  const [rsyncOpts, setRsyncOpts] = useState<RsyncOptions>(currentJob?.rsync ?? {})
  const [compress, setCompress] = useState(
    currentJob?.compress === true || currentJob?.rsync?.compress === true
  )
  const [encLeftState, setEncLeftState] = useState<EncState>(() => toEncState(currentJob?.encLeft))
  const [encRightState, setEncRightState] = useState<EncState>(() => toEncState(currentJob?.encRight))
  const [secretText, setSecretText] = useState({ left: '', right: '' })
  const [secretReady, setSecretReady] = useState({ left: false, right: false })
  const [revealed, setRevealed] = useState({ left: '', right: '' })
  const [versionsOn, setVersionsOn] = useState(Boolean(currentJob?.versions))
  const [versionsKeep, setVersionsKeep] = useState(String(currentJob?.versions?.keep ?? 5))
  const [versionsRepo, setVersionsRepo] = useState(currentJob?.versions?.repo ?? '')
  const [versionsSecretId, setVersionsSecretId] = useState(currentJob?.versions?.secretId ?? '')
  const [versionsPassword, setVersionsPassword] = useState('')
  const [versionsReady, setVersionsReady] = useState(false)
  const [resticOk, setResticOk] = useState<boolean | null>(null)
  const [snapshots, setSnapshots] = useState<SyncSnapshot[] | null>(null)
  const [snapshotRepo, setSnapshotRepo] = useState('')
  const [versionsError, setVersionsError] = useState('')
  const [restoring, setRestoring] = useState<string | null>(null)
  const versionsDest = mode === 'rtl' ? left : right
  const versionsAllowed = mode !== 'both' && !isRemotePath(versionsDest)
  const encrypted = encLeftState.mode !== 'off' || encRightState.mode !== 'off'
  const effectiveCompareBy: 'mtime' | 'hash' = encrypted ? 'hash' : compareBy
  // rsync can only express glob excludes; regex/size rules need the native engine
  const rsyncRulesOk = rules.every((r) => r.kind === 'glob')
  const rsyncPossible =
    rsyncRulesOk && mode !== 'both' && !encrypted && !isRemotePath(left) && !isRemotePath(right)
  const rsyncAllowed = useRsync && rsyncPossible
  const sftpEndpoint = parseRemote(left)?.scheme === 'sftp' || parseRemote(right)?.scheme === 'sftp'
  // rsync -z, or SSH zlib on an SFTP session; age ciphertext is incompressible, local copies gain nothing
  const compressEngine = sftpEndpoint ? 'sftp' : useRsync && rsyncPossible ? 'rsync' : 'none'
  const compressAllowed = !encrypted && compressEngine !== 'none'
  const compressTitle = encrypted
    ? t('با رمزنگاری، داده قبل از انتقال رمز می‌شود و فشرده‌سازی بی‌فایده است')
    : compressEngine === 'sftp'
      ? t('فشرده‌سازی SSH برای انتقال SFTP')
      : compressEngine === 'rsync'
        ? t('فشرده‌سازی rsync (-z)')
        : rsyncPossible
          ? t('برای فشرده‌سازی، rsync را روشن کن؛ کپی لوکال فشرده نمی‌شود')
          : t('فشرده‌سازی فقط برای SFTP یا rsync است؛ کپی لوکال سود ندارد')

  useEffect(() => {
    if (!currentJob) return
    setJobName(currentJob.name)
    const mins = currentJob.schedule.everyMinutes ?? 0
    setIntervalOn(mins > 0)
    setEveryUnit(mins > 0 && mins % 60 === 0 ? 'hour' : 'min')
    setEveryAmount(mins <= 0 ? 30 : mins % 60 === 0 ? mins / 60 : mins)
    setCron(currentJob.schedule.cron ?? '')
    setOnStart(currentJob.schedule.onStart === true)
    setOnMount(currentJob.schedule.onMount === true)
    setOnChange(currentJob.schedule.onChange === true)
    setUseRsync(currentJob.useRsync === true)
    setRsyncOpts(currentJob.rsync ?? {})
    setCompress(currentJob.compress === true || currentJob.rsync?.compress === true)
    setRules((prev) => {
      const next = currentJob.ignoreRules ?? []
      return prev.length === next.length && prev.every((r, i) => ruleKey(r) === ruleKey(next[i]))
        ? prev
        : next
    })
    setEncLeftState(toEncState(currentJob.encLeft))
    setEncRightState(toEncState(currentJob.encRight))
    setVersionsOn(Boolean(currentJob.versions))
    setVersionsKeep(String(currentJob.versions?.keep ?? 5))
    setVersionsRepo(currentJob.versions?.repo ?? '')
    setVersionsSecretId(currentJob.versions?.secretId ?? '')
    // only a different job repopulates the form; typing must not be overwritten
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentJob?.id])

  const loadHistory = async (): Promise<void> => {
    try {
      setHistory(await api.sync.history(60))
    } catch {
      setHistory([])
    }
  }

  useEffect(() => {
    void api.sync.versionsAvailable().then(setResticOk).catch(() => setResticOk(false))
  }, [])

  useEffect(() => {
    let alive = true
    if (!versionsSecretId) {
      setVersionsReady(false)
      return
    }
    void api.sync.secretHas(versionsSecretId).then((v) => {
      if (alive) setVersionsReady(v)
    }).catch(() => setVersionsReady(false))
    return () => {
      alive = false
    }
  }, [versionsSecretId])

  useEffect(() => {
    let alive = true
    const check = async (s: EncState): Promise<boolean> =>
      s.mode === 'off' || !s.secretId ? false : await api.sync.secretHas(s.secretId).catch(() => false)
    void Promise.all([check(encLeftState), check(encRightState)]).then(([left, right]) => {
      if (alive) setSecretReady({ left, right })
    })
    return () => {
      alive = false
    }
  }, [encLeftState.mode, encLeftState.secretId, encRightState.mode, encRightState.secretId])

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      if (confirm) {
        setConfirm(null)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [confirm, onClose])

  useEffect(() => {
    void loadHistory()
    return api.sync.onProgress((p) => setProgress(p))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    return api.sync.onDone(() => {
      setProgress(null)
      void loadHistory()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const encOf = (side: 'left' | 'right'): EncState => (side === 'left' ? encLeftState : encRightState)
  const setEncOf = (side: 'left' | 'right', next: EncState): void =>
    side === 'left' ? setEncLeftState(next) : setEncRightState(next)

  const changeEncMode = (side: 'left' | 'right', next: EncState['mode']): void => {
    const current = encOf(side)
    if (next === current.mode) return
    if (current.secretId && next !== 'off') void api.sync.secretRemove(current.secretId)
    const fresh: EncState =
      next === 'off'
        ? { mode: 'off', secretId: '', recipient: '' }
        : { mode: next, secretId: crypto.randomUUID(), recipient: '' }
    setEncOf(side, fresh)
    setSecretText((v) => ({ ...v, [side]: '' }))
    setRevealed((v) => ({ ...v, [side]: '' }))
    setSecretReady((v) => ({ ...v, [side]: false }))
    if (next !== 'off') {
      setCompareBy('hash')
      setUseRsync(false)
    }
  }

  const saveSecret = async (side: 'left' | 'right'): Promise<void> => {
    const state = encOf(side)
    if (state.mode === 'off' || !state.secretId) return
    const value = secretText[side]
    if (!value.trim()) {
      setError(t('پسورد یا کلید را بنویس'))
      return
    }
    let recipient = state.recipient
    if (state.mode === 'keypair') {
      try {
        recipient = await api.sync.recipientOf(value)
      } catch {
        setError(t('کلید خصوصی age معتبر نیست'))
        return
      }
    }
    const res = await api.sync.secretSet(state.secretId, value)
    if ('error' in res) {
      setError(res.error)
      return
    }
    setEncOf(side, { ...state, recipient })
    setSecretReady((v) => ({ ...v, [side]: true }))
    setSecretText((v) => ({ ...v, [side]: '' }))
    setMessage(
      res.sessionOnly ? t('کلید فقط تا پایان این نشست نگه داشته می‌شود') : t('کلید ذخیره شد')
    )
  }

  const generateKey = async (side: 'left' | 'right'): Promise<void> => {
    const state = encOf(side)
    if (state.mode !== 'keypair' || !state.secretId) return
    if (
      secretReady[side] &&
      !window.confirm(
        t('جفت‌کلید موجود عوض شود؟ فایل‌های رمزشدهٔ قبلی با کلید تازه باز نمی‌شوند')
      )
    ) {
      return
    }
    const kp = await api.sync.keypair()
    const res = await api.sync.secretSet(state.secretId, kp.identity)
    if ('error' in res) {
      setError(res.error)
      return
    }
    setEncOf(side, { mode: 'keypair', secretId: state.secretId, recipient: kp.recipient })
    setRevealed((v) => ({ ...v, [side]: kp.identity }))
    setSecretReady((v) => ({ ...v, [side]: true }))
    setMessage(res.sessionOnly ? t('کلید فقط تا پایان این نشست نگه داشته می‌شود') : t('جفت‌کلید ساخته شد'))
  }

  const revealKey = async (side: 'left' | 'right'): Promise<void> => {
    const state = encOf(side)
    if (state.mode !== 'keypair' || !state.secretId) return
    const value = await api.sync.secretReveal(state.secretId)
    if (!value) {
      setError(t('کلیدی ذخیره نشده است'))
      return
    }
    setRevealed((v) => ({ ...v, [side]: value }))
  }

  /** Per-side settings live in that side's own column, never in the shared bar. */
  const encRow = (side: 'left' | 'right'): ReactElement => {
    const state = encOf(side)
    return (
      <div className="sync-side-enc" key={side}>
        <div className="sync-side-enc-title">
          <span>{t('رمزنگاری')}</span>
          {/* the select already says «off»; a second badge for the same word only adds noise */}
          {state.mode !== 'off' && (
            <span className={'chip ' + (secretReady[side] ? 'add' : 'warn')}>
              {secretReady[side] ? t('آماده') : t('کلید ناقص')}
            </span>
          )}
        </div>
        <div className="sync-enc-row">
          <select
            value={state.mode}
            onChange={(e) => changeEncMode(side, e.target.value as EncState['mode'])}
            aria-label={t('حالت رمزنگاری')}
          >
            <option value="off">{t('خاموش')}</option>
            <option value="passphrase">{t('پسورد')}</option>
            <option value="keypair">{t('جفت‌کلید')}</option>
          </select>
          {state.mode === 'passphrase' && (
            <>
              <input
                type="password"
                className="ignore-input"
                dir="ltr"
                placeholder={t('پسورد')}
                value={secretText[side]}
                onChange={(e) => setSecretText((v) => ({ ...v, [side]: e.target.value }))}
              />
              <button className="tb" onClick={() => void saveSecret(side)}>
                {secretReady[side] ? t('تغییر') : t('ذخیره')}
              </button>
            </>
          )}
          {state.mode === 'keypair' && (
            <>
              <input
                className="ignore-input"
                dir="ltr"
                placeholder="age1…"
                title={t('کلید عمومی (recipient)')}
                value={state.recipient}
                onChange={(e) => setEncOf(side, { ...state, recipient: e.target.value })}
              />
              <input
                type="password"
                className="ignore-input"
                dir="ltr"
                placeholder="AGE-SECRET-KEY-1…"
                title={t('کلید خصوصی (identity)')}
                value={secretText[side]}
                onChange={(e) => setSecretText((v) => ({ ...v, [side]: e.target.value }))}
              />
              <button className="tb" onClick={() => void saveSecret(side)}>
                {t('ذخیره کلید')}
              </button>
              <button className="tb" onClick={() => void generateKey(side)}>
                {t('ساخت جفت‌کلید')}
              </button>
              <button className="tb" onClick={() => void revealKey(side)} title={t('نمایش کلید برای بکاپ')}>
                <EyeIcon size={12} />
              </button>
            </>
          )}
          {state.mode === 'off' && state.secretId && secretReady[side] && (
            <span className="chip add">{t('ذخیره‌شده')}</span>
          )}
          {revealed[side] && (
            <div className="sync-key-box">
              <div className="dim">
                {t('این کلید خصوصی را جای امن نگه دار؛ بدون آن فایل‌های رمزشده باز نمی‌شوند')}
              </div>
              <textarea dir="ltr" readOnly value={revealed[side]} />
              <button
                className="tb"
                onClick={() => {
                  void navigator.clipboard.writeText(revealed[side])
                  setMessage(t('کپی شد'))
                }}
              >
                <CopyIcon size={11} /> {t('کپی')}
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  const versionsConfig = (): SyncVersions | undefined =>
    versionsOn && versionsSecretId
      ? {
          keep: Math.min(100, Math.max(1, Math.round(Number(versionsKeep) || 5))),
          ...(versionsRepo.trim() ? { repo: versionsRepo.trim() } : {}),
          secretId: versionsSecretId
        }
      : undefined

  const toggleVersions = (on: boolean): void => {
    setVersionsOn(on)
    if (on && !versionsSecretId) setVersionsSecretId(crypto.randomUUID())
    setSnapshots(null)
    setVersionsError('')
  }

  const saveVersionsPassword = async (): Promise<void> => {
    if (!versionsPassword.trim()) {
      setVersionsError(t('رمز مخزن را بنویس'))
      return
    }
    const res = await api.sync.secretSet(versionsSecretId, versionsPassword)
    if ('error' in res) {
      setVersionsError(res.error)
      return
    }
    setVersionsReady(true)
    setVersionsPassword('')
    setMessage(
      res.sessionOnly ? t('کلید فقط تا پایان این نشست نگه داشته می‌شود') : t('رمز مخزن ذخیره شد')
    )
  }

  const loadSnapshots = async (): Promise<void> => {
    if (!versionsSecretId || !versionsAllowed) return
    setVersionsError('')
    try {
      const r = await api.sync.versions({
        left,
        right,
        mode,
        repo: versionsRepo.trim() || undefined,
        secretId: versionsSecretId
      })
      setResticOk(r.available)
      setSnapshotRepo(r.repo)
      setSnapshots(r.snapshots)
      if (r.error) setVersionsError(r.error)
    } catch (e) {
      setVersionsError(e instanceof Error ? e.message : String(e))
    }
  }

  const restoreSnapshot = async (id: string): Promise<void> => {
    if (!snapshotRepo) return
    setRestoring(id)
    setVersionsError('')
    try {
      const dir = await api.sync.versionsRestore(snapshotRepo, versionsSecretId, id)
      onOpenPath?.(dir, mode === 'rtl' ? 'right' : 'left')
      onClose()
    } catch (e) {
      setVersionsError(e instanceof Error ? e.message : String(e))
    } finally {
      setRestoring(null)
    }
  }

  const doCompare = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setMessage('')
    setConfirm(null)
    try {
      const r = await api.sync.plan({
        left,
        right,
        mode,
        compareBy: effectiveCompareBy,
        ignore: ignored,
        ignoreRules: rules,
        compress: compress && compressAllowed,
        deleteExtra,
        useRsync: rsyncAllowed,
        rsync: rsyncOpts,
        encLeft: fromEncState(encLeftState),
        encRight: fromEncState(encRightState)
      })
      setRows(r.rows)
      setPlan(r.plan)
      setCapped(r.cmp.capped)
      setLeftCount(r.cmp.leftCount)
      setRightCount(r.cmp.rightCount)
      setSelected(new Set(r.rows.filter((x) => x.state !== 'same').map((x) => x.rel)))
      setResolutions({})
      setTab((current) =>
        current === 'history' || current === 'jobs' || current === 'versions' || current === 'ignore'
          ? current
          : r.plan.conflicts.length
            ? 'conflicts'
            : 'rows'
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // the mode changes the plan (and the three-way comparison), so a fresh comparison is required
  useEffect(() => {
    void doCompare()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, right, mode, compareBy, useRsync, encrypted, rules])

  const execute = async (dryRun: boolean, confirmed = false): Promise<void> => {
    if (!plan) return
    if (!dryRun && unresolved.length) {
      setTab('conflicts')
      setError(t('{n} تعارض را اول حل کن', { n: fa(unresolved.length) }))
      return
    }
    const remoteDeletes = plan.remove.filter((a) => isRemotePath(a.from === 'left' ? left : right)).length
    if (!dryRun && !confirmed && plan.remove.length > 0) {
      setConfirm({ deletes: plan.remove.length, remote: remoteDeletes })
      return
    }
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const r = await api.sync.run({
        left,
        right,
        mode,
        compareBy: effectiveCompareBy,
        ignore: ignored,
        ignoreRules: rules,
        compress: compress && compressAllowed,
        deleteExtra,
        encLeft: fromEncState(encLeftState),
        encRight: fromEncState(encRightState),
        versions: versionsConfig(),
        selected: [...selected],
        resolutions,
        dryRun,
        useRsync: rsyncAllowed,
        rsync: rsyncOpts,
        confirmRemoteDelete: confirmed && remoteDeletes > 0
      })
      setRows(r.rows)
      setPlan(r.plan)
      if (r.blocked) {
        setTab('conflicts')
        setError(t('تعارض‌های تازه‌ای پیدا شد؛ اول تصمیم بگیر'))
      } else if (dryRun) {
        setMessage(
          t('تمرین خشک: {c} کپی · {d} حذف · {s} رد‌شده', {
            c: fa(r.plan.copy.length),
            d: fa(r.plan.remove.length),
            s: fa(r.plan.skipped)
          })
        )
      } else {
        setMessage(
          t('{c} کپی · {d} حذف · {s} رد‌شده', {
            c: fa(r.applied?.copied ?? 0),
            d: fa(r.applied?.removed ?? 0),
            s: fa(r.applied?.skipped ?? 0)
          })
        )
        if (r.summary.errors.length) setError(r.summary.errors[0])
        await loadHistory()
        onFinished?.()
        // show the state after the run, not the plan that was just applied
        await doCompare()
        setMessage(
          t('{c} کپی · {d} حذف · {s} رد‌شده', {
            c: fa(r.applied?.copied ?? 0),
            d: fa(r.applied?.removed ?? 0),
            s: fa(r.applied?.skipped ?? 0)
          })
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  const toggle = (rel: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
  }

  /** Select/unselect every visible row that can be acted on (the header checkbox). */
  const toggleAll = (): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      const every = selectableRows.length > 0 && selectableRows.every((r) => next.has(r.rel))
      for (const r of selectableRows) {
        if (every) next.delete(r.rel)
        else next.add(r.rel)
      }
      return next
    })
  }

  const stepEvery = (delta: number): void =>
    setEveryAmount((a) => {
      const max = everyUnit === 'hour' ? 168 : 10080
      return Math.min(max, Math.max(1, a + delta))
    })

  const changeEveryUnit = (unit: 'min' | 'hour'): void => {
    if (unit === everyUnit) return
    setEveryAmount((a) => (unit === 'hour' ? Math.max(1, Math.round(a / 60)) : Math.min(10080, a * 60)))
    setEveryUnit(unit)
  }

  const addRule = (): void => {
    let rule: SyncIgnoreRule
    if (ruleKind === 'size') {
      const n = Number(sizeAmount)
      if (!Number.isFinite(n) || n < 0) {
        setError(t('حجم معتبر نیست'))
        return
      }
      rule = { kind: 'size', op: sizeOp, bytes: Math.round(n * SIZE_MULT[sizeUnit]) }
    } else {
      const v = ruleValue.trim()
      if (!v) {
        setError(t('مقدار قاعده را بنویس'))
        return
      }
      if (ruleKind === 'regex') {
        try {
          new RegExp(v)
        } catch {
          setError(t('عبارت باقاعده معتبر نیست'))
          return
        }
        rule = { kind: 'regex', value: v }
      } else if (ruleKind === 'path') {
        const p = v.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
        if (!p || p.startsWith('/') || p.split('/').includes('..')) {
          setError(t('مسیر باید نسبی و بدون .. باشد'))
          return
        }
        rule = { kind: 'path', value: p }
      } else {
        rule = { kind: 'glob', value: v }
      }
    }
    if (rules.some((r) => ruleKey(r) === ruleKey(rule!))) {
      setMessage(t('این قاعده از قبل هست'))
      return
    }
    if (rules.length >= 100) {
      setError(t('حداکثر ۱۰۰ قاعده'))
      return
    }
    setRules([...rules, rule])
    setRuleValue('')
    setError('')
  }

  /** Turn the current row selection into exact-path rules in one click. */
  const addSelectedRules = (): void => {
    const have = new Set(rules.map(ruleKey))
    const fresh = [...selected]
      .filter((rel) => !have.has('path:' + rel))
      .slice(0, Math.max(0, 100 - rules.length))
      .map((rel) => ({ kind: 'path' as const, value: rel }))
    if (!fresh.length) {
      setMessage(t('مسیر تازه‌ای در انتخاب نیست'))
      return
    }
    setRules([...rules, ...fresh])
    setMessage(t('{n} مسیر به نادیده‌گرفتن اضافه شد', { n: fa(fresh.length) }))
  }

  const spanText = (span: Span): string => {
    const n = fa(span.value)
    if (span.value === 1) {
      if (span.unit === 'second') return t('{n} second', { n })
      if (span.unit === 'minute') return t('{n} minute', { n })
      if (span.unit === 'hour') return t('{n} hour', { n })
      if (span.unit === 'day') return t('{n} day', { n })
      if (span.unit === 'month') return t('{n} month', { n })
      return t('{n} year', { n })
    }
    if (span.unit === 'second') return t('{n} ثانیه', { n })
    if (span.unit === 'minute') return t('{n} دقیقه', { n })
    if (span.unit === 'hour') return t('{n} ساعت', { n })
    if (span.unit === 'day') return t('{n} روز', { n })
    if (span.unit === 'month') return t('{n} ماه', { n })
    return t('{n} سال', { n })
  }

  const statusLabel = (f: StatusFilter): string =>
    f === 'all' ? t('همه وضعیت‌ها') : f === 'diff' ? t('فقط تفاوت‌ها') : labelOfState(f)

  const saveJob = (): void => {
    if (
      encrypted &&
      ((encLeftState.mode !== 'off' && !secretReady.left) ||
        (encRightState.mode !== 'off' && !secretReady.right))
    ) {
      setError(t('اول پسورد/کلید هر طرف را ذخیره کن'))
      return
    }
    if (versionsOn) {
      if (!versionsAllowed) {
        setError(t('نسخه‌ها فقط برای مقصد لوکال و اجرای یک‌طرفه‌اند'))
        return
      }
      if (resticOk === false) {
        setError(t('restic نصب نیست'))
        return
      }
      if (!versionsReady) {
        setError(t('اول رمز مخزن را ذخیره کن'))
        return
      }
    }
    const id = currentJob?.id ?? newSyncJobId(jobs.map((j) => j.id))
    const job: SyncJob = {
      id,
      name: jobName.trim() || `${baseName(left)} → ${baseName(right)}`,
      left,
      right,
      direction: mode,
      compareBy,
      ignore: ignored,
      ignoreRules: rules,
      compress: compress && compressAllowed,
      deleteExtra,
      useRsync: rsyncAllowed,
      ...(rsyncAllowed
        ? { rsync: { ...rsyncOpts, ...(compress && compressAllowed ? { compress: true } : {}) } }
        : {}),
      ...(fromEncState(encLeftState) ? { encLeft: fromEncState(encLeftState) } : {}),
      ...(fromEncState(encRightState) ? { encRight: fromEncState(encRightState) } : {}),
      ...(versionsConfig() ? { versions: versionsConfig() } : {}),
      enabled: currentJob?.enabled !== false,
      schedule: {
        ...(intervalOn
          ? { everyMinutes: Math.min(10080, Math.max(1, Math.round(everyAmount)) * (everyUnit === 'hour' ? 60 : 1)) }
          : {}),
        ...(cron.trim() ? { cron: cron.trim() } : {}),
        onStart,
        onMount,
        onChange
      }
    }
    onSaveJobs([...jobs.filter((j) => j.id !== id), job])
    setMessage(t('کار ذخیره شد'))
  }

  const restore = async (id: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const r = await api.sync.restore(id, true)
      setMessage(
        t('بازگردانی: {c} کپی · {e} مورد قابل بازگشت نبود', {
          c: fa(r.applied?.copied ?? 0),
          e: fa(r.summary.errors.length)
        })
      )
      if (r.summary.errors.length) setError(r.summary.errors[0])
      await loadHistory()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setRestoreId(null)
    }
  }

  useEffect(() => {
    if (versionsOn && versionsReady && versionsAllowed) void loadSnapshots()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.length, versionsReady, versionsOn, versionsAllowed])

  // once the plan's byte total is known, the bar follows bytes: one 3 GB file must not show
  // 100 % from the moment its copy starts just because it is the last file in the list
  const pct = progress
    ? progress.bytesTotal
      ? Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100))
      : progress.files
        ? Math.min(100, Math.round((progress.filesDone / progress.files) * 100))
        : 0
    : 0

  /** The headline card for one pane: name, path, its role in this direction and a row count. */
  const sideCard = (side: 'left' | 'right'): ReactElement => {
    const path = side === 'left' ? left : right
    const n = side === 'left' ? leftCount : rightCount
    const source = mode !== 'both' && (side === 'left') === (mode === 'ltr')
    return (
      <div className={'sync-side-card ' + side}>
        <div className="sync-side-top">
          <span className="sync-side-tag">{side === 'left' ? t('چپ') : t('راست')}</span>
          <b className="sync-side-name" dir="auto" title={path}>
            {baseName(path) || path}
          </b>
          <span className={'chip ' + (mode === 'both' ? '' : source ? 'add' : 'del')}>
            {mode === 'both' ? t('هر دو') : source ? t('مبدأ') : t('مقصد')}
          </span>
          <span className="spacer" />
          {n > 0 && <span className="sync-side-count">{t('{n} مورد', { n: fa(n) })}</span>}
        </div>
        <div
          className="sync-side-path"
          dir="ltr"
          title={path}
          style={{ textAlign: side === 'left' ? (rtl ? 'right' : 'left') : rtl ? 'left' : 'right' }}
        >
          {path}
        </div>
        {/* encryption belongs to this side, so it lives in this card instead of a second row of
            panels that pushed the compare results below the fold on a short window */}
        {encRow(side)}
      </div>
    )
  }

  return (
    <div className="modal" onMouseDown={onClose}>
      <div className="dialog sync-workspace" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={t('همگام‌سازی دو پوشه')}>
        <div className="sync-head">
          <span className="sync-title">{t('همگام‌سازی دو پوشه')}</span>
          <span className="spacer" />
          <button className="tb" title={t('بستن')} onClick={onClose}>
            <XIcon size={13} />
          </button>
        </div>

        {/* the settings block scrolls as one unit when the window is short: it may never push the
            compare rows and their footer past the sheet's bottom edge */}
        <div className="sync-config">
          <div className="sync-pair">
          {sideCard('left')}
          <div className="sync-dir">
            <div className="sync-dir-btns" role="group" aria-label={t('جهت همگام‌سازی')}>
              <button
                className={'tb' + (mode === 'ltr' ? ' on' : '')}
                title={`${t('از چپ به راست')}: ${baseName(left)} → ${baseName(right)}`}
                aria-label={t('از چپ به راست')}
                onClick={() => pickMode('ltr')}
              >
                {rtl ? <ArrowLeftIcon size={13} /> : <ArrowRightIcon size={13} />}
              </button>
              <button
                className={'tb' + (mode === 'both' ? ' on' : '')}
                title={t('همگام‌سازی دوطرفه')}
                aria-label={t('دوطرفه')}
                onClick={() => pickMode('both')}
              >
                <SwapIcon size={13} />
              </button>
              <button
                className={'tb' + (mode === 'rtl' ? ' on' : '')}
                title={`${t('از راست به چپ')}: ${baseName(right)} → ${baseName(left)}`}
                aria-label={t('از راست به چپ')}
                onClick={() => pickMode('rtl')}
              >
                {rtl ? <ArrowRightIcon size={13} /> : <ArrowLeftIcon size={13} />}
              </button>
            </div>
            <span className="sync-dir-label"><ModeLabel mode={mode} /></span>
          </div>
          {sideCard('right')}
        </div>

        <div className="sync-common">
          <div className="seg" title={t('معیار مقایسه')}>
            <button
              className={encrypted ? '' : compareBy === 'mtime' ? 'on' : ''}
              disabled={encrypted}
              onClick={() => setCompareBy('mtime')}
            >
              {t('تاریخ تغییر')}
            </button>
            <button
              className={encrypted || compareBy === 'hash' ? 'on' : ''}
              onClick={() => setCompareBy('hash')}
            >
              {t('هش محتوا')}
            </button>
          </div>
          <label className="check-label">
            <input type="checkbox" checked={deleteExtra} onChange={(e) => setDeleteExtra(e.target.checked)} />
            <span>{t('حذف فایل‌های اضافی')}</span>
          </label>
          <label
            className="check-label"
            title={
              mode === 'both'
                ? t('rsync فقط یک‌طرفه است')
                : !rsyncRulesOk
                  ? t('rsync فقط قاعده‌های glob را می‌شناسد')
                  : isRemotePath(left) || isRemotePath(right)
                    ? t('rsync فقط برای دو پوشهٔ لوکال است')
                    : t('موتور rsync (حذف‌ها به .mfm-trash مقصد می‌روند)')
            }
          >
            <input
              type="checkbox"
              checked={useRsync}
              disabled={!rsyncRulesOk || mode === 'both' || isRemotePath(left) || isRemotePath(right)}
              onChange={(e) => setUseRsync(e.target.checked)}
            />
            <span>{t('rsync')}</span>
          </label>
          <label className="check-label" title={compressTitle}>
            <input
              type="checkbox"
              checked={compress}
              disabled={!compressAllowed}
              onChange={(e) => setCompress(e.target.checked)}
            />
            <span>{t('فشرده‌سازی انتقال (-z)')}</span>
          </label>
          {useRsync && rsyncAllowed && (
            <details className="sync-rsync-opts">
              <summary>{t('تنظیمات rsync')}</summary>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={rsyncOpts.checksum === true}
                  onChange={(e) => setRsyncOpts((o) => ({ ...o, checksum: e.target.checked || undefined }))}
                />
                <span>{t('مقایسه با checksum')}</span>
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={rsyncOpts.partial === true}
                  onChange={(e) => setRsyncOpts((o) => ({ ...o, partial: e.target.checked || undefined }))}
                />
                <span>{t('ادامهٔ فایل ناقص')}</span>
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={rsyncOpts.inplace === true}
                  onChange={(e) => setRsyncOpts((o) => ({ ...o, inplace: e.target.checked || undefined }))}
                />
                <span>{t('inplace')}</span>
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={rsyncOpts.sparse === true}
                  onChange={(e) => setRsyncOpts((o) => ({ ...o, sparse: e.target.checked || undefined }))}
                />
                <span>{t('فایل sparse')}</span>
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={rsyncOpts.hardLinks === true}
                  onChange={(e) => setRsyncOpts((o) => ({ ...o, hardLinks: e.target.checked || undefined }))}
                />
                <span>{t('hard link')}</span>
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={rsyncOpts.acls === true}
                  onChange={(e) => setRsyncOpts((o) => ({ ...o, acls: e.target.checked || undefined }))}
                />
                <span>ACL</span>
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={rsyncOpts.xattrs === true}
                  onChange={(e) => setRsyncOpts((o) => ({ ...o, xattrs: e.target.checked || undefined }))}
                />
                <span>xattr</span>
              </label>
              <label className="check-label">
                <span>{t('سقف KB/s')}</span>
                <input
                  className="ignore-input"
                  dir="ltr"
                  placeholder="0"
                  value={rsyncOpts.bwlimitKB ?? ''}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    setRsyncOpts((o) => ({
                      ...o,
                      bwlimitKB: Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
                    }))
                  }}
                />
              </label>
            </details>
          )}
          <button
            className={'chip ' + (rules.length ? 'add' : '')}
            title={t('مدیریت قواعد نادیده‌گرفتن')}
            onClick={() => setTab('ignore')}
          >
            {rules.length ? t('{n} قاعدهٔ نادیده‌گرفتن', { n: fa(rules.length) }) : t('قاعدهٔ نادیده‌گرفتن')}
          </button>
          {encrypted && <span className="chip warn">{t('هش اجباری')}</span>}
        </div>
        {/* the age hint only means something while a side is actually encrypted; as a permanent
            line it ate a row of a short window and pushed the compare table down */}
        {encrypted && (
          <div className="dim sync-enc-note">
            {t('رمزنگاری محتوا با age است؛ نام فایل‌ها روشن می‌ماند و طرف رمزشده با هش مقایسه می‌شود.')}
            {(encLeftState.mode === 'passphrase' || encRightState.mode === 'passphrase') &&
              ' ' + t('حالت پسورد برای درخت بزرگ کند است؛ جفت‌کلید سریع‌تر است.')}
          </div>
        )}
        </div>

        <div className="sync-summary">
          <span className="chip add">{t('{n} از چپ', { n: fa(count('leftOnly') + count('leftNewer')) })}</span>
          <span className="chip del">{t('{n} از راست', { n: fa(count('rightOnly') + count('rightNewer')) })}</span>
          <span className="chip warn">{t('{n} مشکوک', { n: fa(count('sizeDiff') + count('contentDiff') + count('typeDiff')) })}</span>
          <span className="chip warn">{t('{n} تعارض', { n: fa(count('conflict')) })}</span>
          <span className="chip">{t('{n} یکسان', { n: fa(count('same')) })}</span>
          {compress && compressAllowed && <span className="chip add">{t('فشرده‌سازی (-z)')}</span>}
          {encrypted && <span className="chip warn">{t('رمزشده · هش')}</span>}
          {capped && <span className="chip warn">{t('فهرست بریده شد')}</span>}
          {selected.size > 0 && plan && (
            <span className="chip">{t('{n} انتخاب‌شده', { n: fa(selected.size) })}</span>
          )}
          {mode === 'both' && plan && (
            <span className="dim">
              {t('دوطرفه با {n} تصمیم', { n: fa(conflicts.length - unresolved.length) })}
            </span>
          )}
          {unresolved.length > 0 && (
            <span className="chip warn">{t('{n} تعارض حل‌نشده', { n: fa(unresolved.length) })}</span>
          )}
          <span className="spacer" />
          {/* one group, so the three actions wrap together instead of scattering to the left */}
          <div className="sync-run">
            <button className="btn ghost" disabled={busy} onClick={() => void doCompare()}>
              {t('مقایسه')}
            </button>
            <button className="btn ghost" disabled={busy || !plan} onClick={() => void execute(true)}>
              {t('تمرین خشک')}
            </button>
            <button className="btn" disabled={busy || !plan} onClick={() => void execute(false)}>
              {t('اجرا')}
            </button>
          </div>
        </div>

        <div className="sync-tabs">
          {(['rows', 'conflicts', 'ignore', 'history', 'jobs', 'versions'] as Tab[]).map((id) => (
            <button key={id} className={'sync-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
              {id === 'rows'
                ? t('ردیف‌ها')
                : id === 'conflicts'
                  ? t('تعارض‌ها ({n})', { n: fa(unresolved.length) })
                  : id === 'ignore'
                    ? t('نادیده‌گرفتن')
                    : id === 'history'
                      ? t('تاریخچه')
                      : id === 'jobs'
                        ? t('کارها')
                        : t('نسخه‌ها')}
            </button>
          ))}
          {/* the plan used to be its own line under the table, costing a short window a whole row
              of results; it belongs with the tabs that describe what is on screen */}
          {plan && (
            <span className="chip sync-plan-chip">
              {t('طرح: {c} کپی · {d} حذف · {s} رد‌شده', {
                c: fa(plan.copy.length),
                d: fa(plan.remove.length),
                s: fa(plan.skipped)
              })}
            </span>
          )}
          <span className="spacer" />
          {tab === 'rows' && (
            <label className="sync-filter" title={t('صافی وضعیت')}>
              <span className="dim">{t('وضعیت')}</span>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                aria-label={t('صافی وضعیت')}
              >
                {STATUS_FILTERS.map((f) => (
                  <option key={f} value={f}>
                    {statusLabel(f)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="sync-body">
          {tab === 'rows' && (
            <>
              <div className="sync-list-head">
                <span className="sync-check">
                  <SelectAll
                    checked={allSelected}
                    indeterminate={someSelected}
                    disabled={!selectableRows.length}
                    onChange={toggleAll}
                  />
                </span>
                <span className="sync-side">{t('چپ')}</span>
                <span className="sync-head-state">{t('وضعیت')}</span>
                <span className="sync-rel">{t('مسیر')}</span>
                <span className="sync-side">{t('راست')}</span>
              </div>
              <Rows key={statusFilter} rows={visibleRows} selected={selected} onToggle={toggle} />
            </>
          )}

          {tab === 'conflicts' && (
            <div className="sync-conflicts">
              {!conflicts.length && <div className="dim">{t('تعارضی نیست')}</div>}
              {conflicts.map((c) => {
                const f = conflictFacts(c)
                return (
                    <div className="sync-conflict" key={c.rel}>
                      <div className="sync-conflict-head">
                        <span className="chip warn">{labelOfConflict(c.conflict)}</span>
                        <span className="sync-rel" dir="auto">
                          {c.rel}
                        </span>
                      </div>
                      <div className="sync-conflict-sides">
                        {(['left', 'right'] as const).map((side) => {
                          const x = side === 'left' ? c.left : c.right
                          return (
                            <div className={'sync-conflict-side' + (f.newer === side ? ' newer' : '')} key={side}>
                              <div className="sync-conflict-side-head">
                                <b>{side === 'left' ? t('چپ') : t('راست')}</b>
                                {x ? (
                                  <span className="chip">{x.dir ? t('پوشه') : t('فایل')}</span>
                                ) : (
                                  <span className="chip del">{t('وجود ندارد')}</span>
                                )}
                                {f.newer === side && <span className="chip add">{t('جدیدتر')}</span>}
                              </div>
                              {x && (
                                <div className="sync-conflict-meta dim">
                                  <span>{fmtSize(x.size, x.dir)}</span>
                                  <span dir="ltr">{fmtDate(x.mtime)}</span>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                      <div className="sync-conflict-facts">
                        {f.newer && (
                          <span className="chip add">
                            {t('{side} {span} جدیدتر است', {
                              side: f.newer === 'left' ? t('چپ') : t('راست'),
                              span: spanText(relativeSpan(f.newerByMs))
                            })}
                          </span>
                        )}
                        {f.sizeDelta !== null && f.sizeDelta !== 0 && (
                          <span className="chip warn">
                            {t('اختلاف اندازه: {d}', {
                              d: (f.sizeDelta > 0 ? '+' : '−') + fmtSize(Math.abs(f.sizeDelta), false)
                            })}
                          </span>
                        )}
                        {f.sizeDelta === 0 && <span className="chip">{t('اندازه یکسان است')}</span>}
                      </div>
                      {c.conflict === 'typeDiff' ? (
                        <div className="dim">
                          {t('یک طرف فایل است و طرف دیگر پوشه؛ این را باید دستی در فایل‌منیجر حل کنی و بعد دوباره مقایسه کنی')}
                        </div>
                      ) : (
                        <div className="seg">
                          <button
                            className={resolutions[c.rel] === 'left' ? 'on' : ''}
                            onClick={() => setResolutions((r) => ({ ...r, [c.rel]: 'left' }))}
                          >
                            {t('چپ درست است')}
                          </button>
                          <button
                            className={resolutions[c.rel] === 'right' ? 'on' : ''}
                            onClick={() => setResolutions((r) => ({ ...r, [c.rel]: 'right' }))}
                          >
                            {t('راست درست است')}
                          </button>
                          <button
                            className={resolutions[c.rel] === 'skip' ? 'on' : ''}
                            onClick={() => setResolutions((r) => ({ ...r, [c.rel]: 'skip' }))}
                          >
                            {t('رد کن')}
                          </button>
                        </div>
                      )}
                    </div>
                )
              })}
            </div>
          )}

          {tab === 'ignore' && (
            <div className="sync-ignore">
              <div className="sync-ignore-form">
                <select
                  value={ruleKind}
                  onChange={(e) => setRuleKind(e.target.value as 'glob' | 'regex' | 'path' | 'size')}
                  aria-label={t('نوع قاعده')}
                >
                  <option value="glob">{t('الگو (glob)')}</option>
                  <option value="regex">Regex</option>
                  <option value="path">{t('مسیر دقیق')}</option>
                  <option value="size">{t('حجم')}</option>
                </select>
                {ruleKind === 'size' ? (
                  <>
                    <select
                      value={sizeOp}
                      onChange={(e) => setSizeOp(e.target.value as 'gt' | 'lt')}
                      aria-label={t('بزرگ‌تر یا کوچک‌تر')}
                    >
                      <option value="gt">{t('بزرگ‌تر از')}</option>
                      <option value="lt">{t('کوچک‌تر از')}</option>
                    </select>
                    <input
                      className="ignore-input sync-size-amount"
                      dir="ltr"
                      inputMode="decimal"
                      value={sizeAmount}
                      onChange={(e) => setSizeAmount(e.target.value)}
                      aria-label={t('حجم')}
                    />
                    <select
                      value={sizeUnit}
                      onChange={(e) => setSizeUnit(e.target.value as 'B' | 'KB' | 'MB' | 'GB')}
                      aria-label={t('یکای حجم')}
                    >
                      <option value="B">B</option>
                      <option value="KB">KB</option>
                      <option value="MB">MB</option>
                      <option value="GB">GB</option>
                    </select>
                  </>
                ) : (
                  <input
                    className="ignore-input sync-rule-input"
                    dir="ltr"
                    value={ruleValue}
                    placeholder={
                      ruleKind === 'glob' ? '*.log, node_modules' : ruleKind === 'regex' ? '^build/|\.tmp$' : 'docs/private'
                    }
                    onChange={(e) => setRuleValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addRule()}
                  />
                )}
                <button className="btn ghost" onClick={addRule}>
                  <PlusIcon size={11} /> {t('افزودن')}
                </button>
                {selected.size > 0 && (
                  <button className="btn ghost" onClick={addSelectedRules}>
                    <PlusIcon size={11} /> {t('افزودن {n} مسیر انتخاب‌شده', { n: fa(selected.size) })}
                  </button>
                )}
              </div>
              <div className="dim sync-ignore-note">
                {t('فایل‌های نادیده‌گرفته‌شده در مقایسه دیده نمی‌شوند و «حذف فایل‌های اضافی» هرگز آن‌ها را حذف نمی‌کند.')}
              </div>
              <div className="sync-ignore-list">
                {!rules.length && <div className="dim">{t('قاعده‌ای تعریف نشده')}</div>}
                {rules.map((r) => (
                  <div className="sync-ignore-row" key={ruleKey(r)}>
                    <span className="chip">{ruleKindLabel(r)}</span>
                    <span className="sync-ignore-value" dir="ltr">
                      {ruleText(r)}
                    </span>
                    <span className="spacer" />
                    <button
                      className="tb"
                      title={t('حذف قاعده')}
                      onClick={() => setRules(rules.filter((x) => ruleKey(x) !== ruleKey(r)))}
                    >
                      <TrashIcon size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'history' && (
            <div className="sync-history">
              {!history.length && <div className="dim">{t('تاریخچه‌ای نیست')}</div>}
              {history.map((r) => (
                <div className="sync-history-row" key={r.id} title={`${r.left} ↔ ${r.right}`}>
                  <span className="dim" dir="ltr">
                    {fmtDate(r.startedAt)}
                  </span>
                  <span className="chip"><ModeLabel mode={r.mode} /></span>
                  <span className="dim">
                    {t('{c} کپی · {d} حذف · {k} تعارض', {
                      c: fa(r.copied),
                      d: fa(r.removed),
                      k: fa(r.conflicts)
                    })}
                  </span>
                  <span className={'chip ' + (r.state === 'done' ? 'add' : 'warn')}>{t(r.state === 'done' ? 'انجام شد' : r.state === 'cancelled' ? 'لغو' : 'خطا')}</span>
                  <span className="spacer" />
                  {r.copied > 0 && restoreId !== r.id && (
                    <button className="tb" title={t('بازگردانی از تاریخچه')} onClick={() => setRestoreId(r.id)}>
                      <SwapIcon size={12} />
                    </button>
                  )}
                  {restoreId === r.id && (
                    <>
                      <span className="dim">{t('مطمئنی؟')}</span>
                      <button className="tb" title={t('تأیید بازگردانی')} onClick={() => void restore(r.id)}>
                        <CheckIcon size={12} />
                      </button>
                      <button className="tb" onClick={() => setRestoreId(null)}>
                        <XIcon size={12} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'jobs' && (
            <div className="sync-jobs">
              <div className="sync-job-form">
                <label className="sync-field sync-job-name-field">
                  <span>{t('نام')}</span>
                  <input value={jobName} onChange={(e) => setJobName(e.target.value)} />
                </label>
                <div className="sync-field">
                  <Toggle on={intervalOn} onChange={setIntervalOn} label={t('تکرار خودکار')} />
                  {intervalOn && (
                    <>
                      <span>{t('هر')}</span>
                      <Stepper
                        value={everyAmount}
                        min={1}
                        max={everyUnit === 'hour' ? 168 : 10080}
                        onStep={stepEvery}
                      />
                      <select value={everyUnit} onChange={(e) => changeEveryUnit(e.target.value as 'min' | 'hour')}>
                        <option value="min">{t('دقیقه')}</option>
                        <option value="hour">{t('ساعت')}</option>
                      </select>
                    </>
                  )}
                </div>
                <div className="sync-triggers">
                  <Toggle on={onStart} onChange={setOnStart} label={t('در شروع برنامه')} />
                  <Toggle on={onMount} onChange={setOnMount} label={t('روی اتصال درایو')} />
                  <Toggle on={onChange} onChange={setOnChange} label={t('روی تغییر فایل (لوکال)')} />
                </div>
                <details className="sync-cron">
                  <summary>{cron ? `Cron: ${cron}` : t('زمان‌بندی Cron')}</summary>
                  <div className="sync-cron-presets">
                    <button className="btn ghost" onClick={() => setCron('*/15 * * * *')}>
                      {t('هر ۱۵ دقیقه')}
                    </button>
                    <button className="btn ghost" onClick={() => setCron('0 * * * *')}>
                      {t('هر ساعت')}
                    </button>
                    <button className="btn ghost" onClick={() => setCron('0 3 * * *')}>
                      {t('هر روز ۳ بامداد')}
                    </button>
                    <button className="btn ghost" onClick={() => setCron('')}>
                      {t('خاموش')}
                    </button>
                  </div>
                  <input
                    className="ignore-input"
                    dir="ltr"
                    placeholder="0 3 * * *"
                    value={cron}
                    onChange={(e) => setCron(e.target.value)}
                  />
                </details>
                <button className="btn" onClick={saveJob}>
                  <PlusIcon size={11} /> {currentJob ? t('ذخیرهٔ تغییرات') : t('ذخیره به‌عنوان کار')}
                </button>
              </div>
              <div className="sync-job-list">
                {!jobs.length && <div className="dim">{t('کاری ساخته نشده')}</div>}
                {jobs.map((j) => (
                  <div className={'sync-job' + (j.enabled ? '' : ' off')} key={j.id}>
                    <button
                      role="switch"
                      aria-checked={j.enabled}
                      className={'switch' + (j.enabled ? ' on' : '')}
                      title={j.enabled ? t('فعال') : t('غیرفعال')}
                      onClick={() =>
                        onSaveJobs(jobs.map((x) => (x.id === j.id ? { ...x, enabled: !x.enabled } : x)))
                      }
                    >
                      <span className="knob" />
                    </button>
                    <span className="sync-job-name" dir="auto">
                      {j.name}
                    </span>
                    <span className="chip"><ModeLabel mode={j.direction} /></span>
                    <span className="dim" dir="auto">
                      {j.left} ↔ {j.right}
                    </span>
                    {j.schedule.everyMinutes ? (
                      <span className="chip">{t('هر {n} دقیقه', { n: fa(j.schedule.everyMinutes) })}</span>
                    ) : null}
                    {j.schedule.cron ? (
                      <span className="chip" title={j.schedule.cron}>
                        Cron
                      </span>
                    ) : null}
                    <span className="spacer" />
                    <button className="tb" title={t('باز کردن')} onClick={() => onOpenJob(j)}>
                      <PlayIcon size={12} />
                    </button>
                    <button
                      className="tb"
                      title={t('حذف کار')}
                      onClick={() => onSaveJobs(jobs.filter((x) => x.id !== j.id))}
                    >
                      <TrashIcon size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

          {tab === 'versions' && (
            <div className="sync-versions">
              <div className="sync-versions-config">
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={versionsOn}
                    disabled={!versionsAllowed || resticOk === false}
                    onChange={(e) => toggleVersions(e.target.checked)}
                  />
                  <span>{t('نگه‌داشتن نسخه‌ها با restic')}</span>
                </label>
                {resticOk === false && <span className="chip warn">{t('restic نصب نیست')}</span>}
                {!versionsAllowed && (
                  <span className="dim">{t('نسخه‌ها فقط برای مقصد لوکال و اجرای یک‌طرفه‌اند')}</span>
                )}
                {versionsOn && versionsAllowed && (
                  <>
                    <span className="check-label">
                      <span>{t('تعداد نسخه')}</span>
                      <Stepper
                        value={Math.min(100, Math.max(1, Number(versionsKeep) || 5))}
                        min={1}
                        max={100}
                        onStep={(d) =>
                          setVersionsKeep(String(Math.min(100, Math.max(1, (Number(versionsKeep) || 5) + d))))
                        }
                      />
                    </span>
                    <label className="check-label">
                      <span>{t('مخزن')}</span>
                      <input
                        className="ignore-input"
                        dir="ltr"
                        placeholder={t('پیش‌فرض: .mfm-restic در مقصد')}
                        value={versionsRepo}
                        onChange={(e) => setVersionsRepo(e.target.value)}
                      />
                    </label>
                    <label className="check-label">
                      <span>{t('رمز مخزن')}</span>
                      <input
                        type="password"
                        className="ignore-input"
                        dir="ltr"
                        value={versionsPassword}
                        onChange={(e) => setVersionsPassword(e.target.value)}
                      />
                    </label>
                    <button className="tb" onClick={() => void saveVersionsPassword()}>
                      {versionsReady ? t('تغییر رمز') : t('ذخیره رمز')}
                    </button>
                    {versionsReady && <span className="chip add">{t('رمز ذخیره شد')}</span>}
                    <button className="tb" disabled={!versionsReady} onClick={() => void loadSnapshots()}>
                      {t('نوسازی نسخه‌ها')}
                    </button>
                  </>
                )}
              </div>
              {versionsError && <div className="sync-message err">{versionsError}</div>}
              {versionsOn && versionsAllowed && snapshots && (
                <div className="sync-snapshot-list">
                  {!snapshots.length && <div className="dim">{t('نسخه‌ای نیست')}</div>}
                  {snapshots.map((snap) => (
                    <div className="sync-snapshot" key={snap.id}>
                      <span className="dim" dir="ltr">
                        {fmtDate(Date.parse(snap.time))}
                      </span>
                      <span className="dim" dir="ltr">
                        {snap.shortId}
                      </span>
                      <span className="dim">
                        {fmtSize(snap.bytes, false)} · {t('{n} فایل', { n: fa(snap.files) })}
                      </span>
                      <span className="spacer" />
                      <button
                        className="tb"
                        title={t('بازگردانی به پوشهٔ موقت')}
                        disabled={restoring === snap.id}
                        onClick={() => void restoreSnapshot(snap.id)}
                      >
                        {t('بازگردانی نسخه')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

        {confirm && (
          <div className="sync-confirm">
            <span>
              {t('{n} فایل حذف می‌شود', { n: fa(confirm.deletes) })}
              {confirm.remote > 0 &&
                ` — ${t('{n} حذف روی ریموت دائمی است و سطل بازیافت ندارد', { n: fa(confirm.remote) })}`}
              {rsyncAllowed
                ? ` — ${t('به .mfm-trash مقصد منتقل می‌شوند')}`
                : t(' و نسخه‌ای نگه داشته نمی‌شود. مطمئنی؟')}
            </span>
            <span className="spacer" />
            <button className="btn" onClick={() => void execute(false, true)}>
              {t('تأیید و اجرا')}
            </button>
            <button className="btn ghost" onClick={() => setConfirm(null)}>
              {t('لغو')}
            </button>
          </div>
        )}

        {progress && progress.state === 'running' && (
          <div className="sync-progress">
            <span className="bar">
              <i style={{ width: pct + '%' }} />
            </span>
            <span className="dim">
              {fa(pct)}٪ · {fmtSize(progress.bytesDone, false)}
              {progress.speed ? ` · ${fmtSize(progress.speed, false)}/s` : ''}
              {progress.etaMs != null
                ? ` · ${t('زمان باقی‌مانده: {t}', { t: fa(durationText(progress.etaMs)) })}`
                : ''}
              {' · '}
              <span dir="auto">{progress.current}</span>
            </span>
            <span className="spacer" />
            <button
              className="tb"
              title={progress.paused ? t('ادامه') : t('مکث')}
              onClick={() => (progress.paused ? void api.sync.resume() : void api.sync.pause())}
            >
              {progress.paused ? <PlayIcon size={11} /> : <PauseIcon size={11} />}
            </button>
            <button className="tb" title={t('لغو')} onClick={() => void api.sync.cancel()}>
              <XIcon size={11} />
            </button>
          </div>
        )}

        {(error || message) && (
          <div className={'sync-message ' + (error ? 'err' : 'ok')}>{error || message}</div>
        )}

        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose}>
            {t('بستن')}
          </button>
        </div>
      </div>
    </div>
  )
}
