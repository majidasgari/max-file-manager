import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { t } from './i18n.ts'
import { api } from './api'
import type { Job, JobFile, JobLog, SyncProgress } from './api'
import type { ConflictPolicy } from '../../shared/conflict.ts'
import { baseName, fa, fmtSize } from './format'
import { durationText } from './sync-view.ts'
import {
  CheckIcon,
  ChevronDownIcon,
  ConfirmIcon,
  CopyIcon,
  GaugeIcon,
  MinusIcon,
  MoveIcon,
  PauseIcon,
  PlayIcon,
  SwapIcon,
  XIcon
} from './Icons'

type Props = {
  jobs: Job[]
  /** pixels the strip leaves free at the side the docked sidebar occupies */
  inset?: number
  /** which inline edge that is: `sidebarSide` is inline-relative, so RTL mirrors it */
  insetSide?: 'start' | 'end'
  collapsed: boolean
  onToggleCollapsed(): void
  onPause(id: string): void
  onResume(id: string): void
  onCancel(id: string): void
  onClear(): void
  /** the sync run currently in progress, if any */
  sync?: SyncProgress | null
  syncPaused?: boolean
  onSyncPause?(): void
  onSyncResume?(): void
  onSyncCancel?(): void
}

const POLICY_LABEL: Record<ConflictPolicy, string> = {
  keep: 'نگه‌داشتن هر دو',
  overwrite: 'رونویسی',
  skip: 'رد کردن',
  newer: 'فقط جدیدتر'
}

const STATE_LABEL: Record<Job['state'], string> = {
  queued: 'در صف',
  running: 'در حال اجرا',
  paused: 'مکث',
  done: 'انجام شد',
  cancelled: 'لغو شد',
  error: 'خطا'
}

type Chip = { text: string; tone: string; title?: string }

/**
 * One row of the strip: an icon tile, the label with its state chip, a progress line and a
 * detail line. Everything that is action lives at the inline end, so RTL reads right to left.
 */
function JobCard({
  tone,
  stateText,
  icon,
  label,
  title,
  kind,
  dest,
  pct,
  chips = [],
  meta,
  paused = false,
  onPause,
  onCancel,
  filesOpen = false,
  onToggleFiles,
  cardRef,
  children
}: {
  tone: string
  stateText: string
  icon: ReactNode
  label: string
  title?: string
  kind: string
  dest?: string
  pct: number
  chips?: Chip[]
  meta: ReactNode
  paused?: boolean
  onPause?: () => void
  onCancel?: () => void
  /** the job's per-file panel is open, so the chevron points down */
  filesOpen?: boolean
  onToggleFiles?: () => void
  cardRef?: (el: HTMLDivElement | null) => void
  children?: ReactNode
}) {
  return (
    <div className={'job ' + tone + (filesOpen ? ' files-open' : '')} ref={cardRef}>
      <div className="job-row">
        <span className="job-ic">{icon}</span>
        <div className="job-main">
          <div className="job-top">
            <span className="job-label" dir="auto" title={title ?? label}>
              {label || '…'}
            </span>
            <span className={'job-chip ' + tone}>{stateText}</span>
            {chips.map((c, i) => (
              <span key={i} className={'job-chip ' + c.tone} title={c.title}>
                {c.text}
              </span>
            ))}
          </div>
          <div className="job-line">
            <span className="job-bar">
              <i style={{ width: pct + '%' }} />
            </span>
            <span className="job-pct">{t('{n}٪', { n: fa(pct) })}</span>
          </div>
          <div className="job-meta">
            <span className="job-kind">{kind}</span>
            {dest && (
              <span className="job-dest" title={dest} dir="ltr">
                <span className="job-arrow">→</span> {baseName(dest)}
              </span>
            )}
            {meta}
          </div>
        </div>
        <span className="job-acts">
          {onToggleFiles && (
            <button
              className={'job-act files' + (filesOpen ? ' on' : '')}
              title={t('جزئیات فایل‌ها')}
              aria-expanded={filesOpen}
              onClick={onToggleFiles}
            >
              <ChevronDownIcon size={13} />
            </button>
          )}
          {onPause && (
            <button
              className="job-act"
              title={paused ? t('ادامه') : t('مکث')}
              onClick={onPause}
            >
              {paused ? <PlayIcon size={13} /> : <PauseIcon size={13} />}
            </button>
          )}
          {onCancel && (
            <button className="job-act danger" title={t('لغو')} onClick={onCancel}>
              <XIcon size={12} />
            </button>
          )}
        </span>
      </div>
      {children}
    </div>
  )
}

type FileTab = 'all' | 'copied' | 'skipped' | 'failed'

/** Rows the panel renders at once; a 20k-file copy would otherwise stall the strip. */
const ROWS_SHOWN = 300

/** Parent folder of a path, for the muted prefix of a log line. */
function dirOfFile(p: string): string {
  const name = baseName(p)
  return p.slice(0, Math.max(0, p.length - name.length))
}

/**
 * The per-file log of one job: what reached the destination, what a filter skipped and why, and
 * what failed. Skips and failures come first because they are the reason to open this at all.
 */
function JobFiles({
  log,
  tab,
  onTab,
  loading
}: {
  log: JobLog | null
  tab: FileTab
  onTab(next: FileTab): void
  loading: boolean
}) {
  if (!log) {
    return (
      <div className="job-files">
        <div className="jf-empty">{loading ? t('در حال خواندن…') : t('چیزی برای نمایش نیست')}</div>
      </div>
    )
  }
  const groups: Record<FileTab, JobFile[]> = {
    all: [],
    copied: [...log.copied.entries].reverse(),
    skipped: [...log.skipped.entries].reverse(),
    failed: [...log.failed.entries].reverse()
  }
  groups.all = [...groups.failed, ...groups.skipped, ...groups.copied]
  const rows = groups[tab].slice(0, ROWS_SHOWN)
  const counts: Array<{ id: FileTab; label: string; n: number }> = [
    { id: 'all', label: t('همه'), n: log.copied.total + log.skipped.total + log.failed.total },
    { id: 'copied', label: t('کپی‌شده'), n: log.copied.total },
    { id: 'skipped', label: t('رد‌شده'), n: log.skipped.total },
    { id: 'failed', label: t('ناموفق'), n: log.failed.total }
  ]
  const hidden = groups[tab].length - rows.length
  const note = (f: JobFile): string => {
    if (f.state === 'skipped') return f.note === 'newer' ? t('مقصد جدیدتر بود') : t('در مقصد از قبل بود')
    if (f.state === 'failed') return f.note ?? ''
    return f.overwrote ? t('رونویسی شد') : ''
  }
  return (
    <div className="job-files">
      <div className="jf-tabs">
        {counts.map(
          (c) =>
            (c.id === 'all' || c.n > 0 || c.id === 'copied') && (
              <button
                key={c.id}
                className={'jf-tab' + (tab === c.id ? ' on' : '') + (c.id !== 'all' && c.n === 0 ? ' zero' : '')}
                onClick={() => onTab(c.id)}
              >
                {c.label}
                <span className="jf-count">{fa(c.n)}</span>
              </button>
            )
        )}
        <span className="spacer" />
        {tab === 'copied' && log.copied.dropped > 0 && (
          <span className="jf-note" title={t('{n} مورد قدیمی‌تر نگاه داشته نشد', { n: fa(log.copied.dropped) })}>
            {t('{n} مورد قدیمی‌تر نگاه داشته نشد', { n: fa(log.copied.dropped) })}
          </span>
        )}
      </div>
      <div className="jf-list">
        {rows.map((f, i) => (
          <div key={i} className={'jf-row ' + f.state} title={f.note}>
            <span className="jf-ic">
              {f.state === 'copied' ? (
                <CheckIcon size={12} />
              ) : f.state === 'skipped' ? (
                <MinusIcon />
              ) : (
                <ConfirmIcon />
              )}
            </span>
            <span className="jf-path" dir="ltr">
              <span className="jf-dir">{dirOfFile(f.path)}</span>
              <span className="jf-name">{baseName(f.path)}</span>
            </span>
            <span className="jf-size">{f.size ? fmtSize(f.size, false) : ''}</span>
            <span className="jf-why">{note(f)}</span>
          </div>
        ))}
        {rows.length === 0 && <div className="jf-empty">{t('چیزی برای نمایش نیست')}</div>}
        {hidden > 0 && (
          <div className="jf-empty">{t('{n} مورد دیگر…', { n: fa(hidden) })}</div>
        )}
      </div>
    </div>
  )
}

export function JobsBar({
  jobs,
  inset = 0,
  insetSide = 'start',
  collapsed,
  onToggleCollapsed,
  onPause,
  onResume,
  onCancel,
  onClear,
  sync,
  syncPaused,
  onSyncPause,
  onSyncResume,
  onSyncCancel
}: Props) {
  /** the job whose per-file panel is open (one at a time) */
  const [openId, setOpenId] = useState<string | null>(null)
  const [tab, setTab] = useState<FileTab>('all')
  const [log, setLog] = useState<{ id: string; data: JobLog | null } | null>(null)
  const [loading, setLoading] = useState(false)
  const openCard = useRef<HTMLDivElement | null>(null)
  const lastFetch = useRef(0)

  const openJob = jobs.find((j) => j.id === openId) ?? null
  // refetch while the open job moves; a live copy must not be hammered at the 120ms update rate
  const sig = openJob
    ? `${openJob.state}:${openJob.filesDone}:${openJob.skipped ?? 0}:${openJob.errors.length}`
    : ''
  useEffect(() => {
    if (!openId) {
      setLog(null)
      return
    }
    let alive = true
    const wait = Math.max(0, 600 - (Date.now() - lastFetch.current))
    setLoading(true)
    const timer = setTimeout(() => {
      lastFetch.current = Date.now()
      void api.jobs.files(openId).then(
        (data) => {
          if (!alive) return
          setLog({ id: openId, data })
          setLoading(false)
        },
        () => {
          if (alive) setLoading(false)
        }
      )
    }, wait)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [openId, sig])
  useEffect(() => {
    if (openId) openCard.current?.scrollIntoView({ block: 'nearest' })
  }, [openId])

  const toggleFiles = (id: string) => {
    setOpenId((cur) => (cur === id ? null : id))
    setTab('all')
    setLog(null)
  }
  const openLog = log && log.id === openId ? log.data : null

  const syncLive = !!sync && sync.state === 'running'
  // nothing to show: no rows and no running sync means no strip at all
  if (!jobs.length && !syncLive) return null
  const syncPct = sync
    ? sync.bytesTotal
      ? Math.min(100, Math.round((sync.bytesDone / sync.bytesTotal) * 100))
      : sync.files
        ? Math.min(100, Math.round((sync.filesDone / sync.files) * 100))
        : 0
    : 0
  const count = (state: Job['state']) => jobs.filter((j) => j.state === state).length
  const running = count('running') + (syncLive ? 1 : 0)
  const queued = count('queued')
  const finished = count('done') + count('cancelled') + count('error')
  const failed = count('error')
  // collapsed, the header still carries the whole run: bytes over bytes, not a job count
  const bytes = jobs.reduce((s, j) => s + (j.bytes || 0), 0)
  const doneBytes = jobs.reduce((s, j) => s + (j.state === 'done' ? j.bytes || 0 : j.done || 0), 0)
  const overall = bytes
    ? Math.min(100, Math.round((doneBytes / bytes) * 100))
    : running || queued
      ? null
      : 100
  const shown = syncLive ? syncPct : overall
  // running first, finished last; the sort is stable so the queue keeps its order
  const ORDER: Record<Job['state'], number> = {
    running: 0,
    paused: 1,
    queued: 2,
    error: 3,
    cancelled: 4,
    done: 5
  }
  const rows = [...jobs].sort((a, b) => ORDER[a.state] - ORDER[b.state])

  return (
    <div
      className={'jobs' + (collapsed ? ' collapsed' : '')}
      data-inset-side={inset > 0 ? insetSide : 'none'}
      style={inset > 0 ? ({ '--jobs-inset': inset + 'px' } as CSSProperties) : undefined}
    >
      <div className="jobs-head">
        <button
          className="jobs-toggle"
          title={collapsed ? t('باز کردن نوار عملیات‌ها') : t('جمع کردن نوار عملیات‌ها')}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <span className="jobs-mark">
            <GaugeIcon />
          </span>
          <span className="jobs-title">{t('عملیات‌ها')}</span>
          <ChevronDownIcon size={13} />
        </button>
        {running > 0 && (
          <span className="jobs-chip run">{t('{n} در حال اجرا', { n: fa(running) })}</span>
        )}
        {queued > 0 && <span className="jobs-chip">{t('{n} در صف', { n: fa(queued) })}</span>}
        {finished > 0 && (
          <span className="jobs-chip ok">{t('{n} انجام شد', { n: fa(finished) })}</span>
        )}
        {failed > 0 && <span className="jobs-chip bad">{t('{n} خطا', { n: fa(failed) })}</span>}
        <span className="spacer" />
        {collapsed && (
          <span className="jobs-agg" title={t('{n} از {m}', { n: fmtSize(doneBytes, false), m: fmtSize(bytes, false) })}>
            <span className={'jobs-aggbar' + (shown == null ? ' scan' : '')}>
              <i style={{ width: (shown ?? 35) + '%' }} />
            </span>
            <span dir="ltr">{shown == null ? '…' : `${fa(shown)}٪`}</span>
          </span>
        )}
        {finished > 0 && (
          <button className="tb" title={t('پاک کردن تمام‌شده‌ها')} onClick={onClear}>
            <XIcon size={12} />
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="jobs-list">
          {sync && syncLive && (
            <JobCard
              tone={syncPaused ? 'paused' : 'running'}
              stateText={syncPaused ? t('مکث') : t('در حال اجرا')}
              icon={<SwapIcon size={15} />}
              label={`${t('همگام‌سازی')} · ${sync.current || '…'}`}
              title={sync.current}
              kind={t('همگام‌سازی')}
              pct={syncPct}
              paused={syncPaused}
              onPause={() => (syncPaused ? onSyncResume?.() : onSyncPause?.())}
              onCancel={() => onSyncCancel?.()}
              meta={
                <>
                  <span>
                    {t('{n} از {m}', {
                      n: fmtSize(sync.bytesDone, false),
                      m: fmtSize(sync.bytesTotal ?? 0, false)
                    })}
                  </span>
                  {!!sync.speed && <span>{fmtSize(sync.speed, false)}/s</span>}
                  {sync.etaMs != null && (
                    <span>{t('{t} باقی', { t: fa(durationText(sync.etaMs)) })}</span>
                  )}
                  <span>{t('{n} از {m} فایل', { n: fa(sync.filesDone), m: fa(sync.files) })}</span>
                </>
              }
            />
          )}
          {rows.map((j) => {
            const pct =
              j.state === 'done'
                ? 100
                : j.bytes
                  ? Math.min(99, Math.round((j.done / j.bytes) * 100))
                  : 0
            const eta =
              j.speed > 0 && j.bytes > j.done ? ((j.bytes - j.done) / j.speed) * 1000 : null
            const live = j.state === 'running' || j.state === 'paused' || j.state === 'queued'
            const chips: Chip[] = []
            if (j.skipped) chips.push({ text: t('{n} رد‌شده', { n: fa(j.skipped) }), tone: 'warn', title: t('با فیلتر انتقال رد شد') })
            if (j.overwrites)
              chips.push({
                text: t('{n} رونویسی', { n: fa(j.overwrites) }),
                tone: 'warn',
                title: t('جای فایل موجود در مقصد نوشته شد')
              })
            if (j.errors.length)
              chips.push({ text: t('{n} خطا', { n: fa(j.errors.length) }), tone: 'bad', title: j.errors.join('\n') })
            return (
              <JobCard
                key={j.id}
                tone={j.state}
                stateText={t(STATE_LABEL[j.state])}
                icon={j.kind === 'copy' ? <CopyIcon size={15} /> : <MoveIcon />}
                label={j.label}
                title={j.current || j.label}
                kind={
                  j.conflict && j.conflict !== 'keep'
                    ? `${j.kind === 'copy' ? t('کپی') : t('انتقال')} · ${t(POLICY_LABEL[j.conflict])}`
                    : j.kind === 'copy'
                      ? t('کپی')
                      : t('انتقال')
                }
                dest={j.dest}
                pct={pct}
                chips={chips}
                paused={j.state === 'paused'}
                onPause={
                  live && j.state !== 'queued'
                    ? () => (j.state === 'paused' ? onResume(j.id) : onPause(j.id))
                    : undefined
                }
                onCancel={live ? () => onCancel(j.id) : undefined}
                meta={
                  <>
                    {j.state === 'running' && (
                      <>
                        <span>
                          {t('{n} از {m}', {
                            n: fmtSize(j.done, false),
                            m: fmtSize(j.bytes, false)
                          })}
                        </span>
                        {!!j.speed && <span>{fmtSize(j.speed, false)}/s</span>}
                        {eta != null && (
                          <span>{t('{t} باقی', { t: fa(durationText(eta)) })}</span>
                        )}
                        {j.current && j.current !== j.label && (
                          <span className="job-cur" dir="auto" title={j.current}>
                            {j.current}
                          </span>
                        )}
                      </>
                    )}
                    {j.state === 'paused' && (
                      <span>{t('{n} از {m}', { n: fmtSize(j.done, false), m: fmtSize(j.bytes, false) })}</span>
                    )}
                    {j.state === 'queued' && <span>{t('در انتظار شروع')}</span>}
                    {(j.state === 'done' || j.state === 'cancelled' || j.state === 'error') &&
                      (j.bytes || j.done) > 0 && (
                        <span>{fmtSize(j.bytes || j.done, false)}</span>
                      )}
                    {!!j.files && <span>{t('{n} از {m} فایل', { n: fa(j.filesDone), m: fa(j.files) })}</span>}
                  </>
                }
                filesOpen={openId === j.id}
                onToggleFiles={() => toggleFiles(j.id)}
                cardRef={(el) => {
                  if (j.id === openId) openCard.current = el
                }}
              >
                {openId === j.id && (
                  <JobFiles log={openLog} tab={tab} onTab={setTab} loading={loading} />
                )}
              </JobCard>
            )
          })}
        </div>
      )}
    </div>
  )
}
