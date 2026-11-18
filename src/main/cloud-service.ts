/**
 * Cloud folders as a thin layer over the existing sync engine.
 *
 * Nothing here re-implements a file operation: `compareTrees` builds the rows, `planRows` decides,
 * `applyPlan` copies/deletes through `PathOps`, and the baseline lives in `sync_baseline`. This
 * service only owns the account/binding lifecycle, the single scheduler, the local watcher and the
 * live state the UI draws.
 */
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { RemoteFs } from './remote-core.ts'
import type { SyncControl } from './sync-engine.ts'
import { applyPlan, compareTrees, createOps } from './sync-engine.ts'
import { makePlan } from './sync-engine.ts'
import { nextBaseline } from './sync-core.ts'
import { conflictPaths, entryState, entryStates, nextRunAt, ZERO_COUNTS, type EntryStates } from './cloud-core.ts'
import { cloudOps } from './cloud-engine.ts'
import { shell } from 'electron'
import { createDav, davAccountLabel, nextcloudRoot } from './cloud-dav.ts'
import { createDrive } from './cloud-drive.ts'
import { createDropbox } from './cloud-dropbox.ts'
import { createOneDrive } from './cloud-onedrive.ts'
import type { CloudClient } from './cloud-client.ts'
import { oauthDocs, oauthLogin, oauthRefresh, type OAuthProviderId } from './cloud-oauth.ts'
import {
  cloudBindings,
  cloudAccounts,
  deleteAccount,
  deleteBinding,
  findAccount,
  findBinding,
  patchRuntime,
  putAccount,
  putBinding,
  runtimeOf,
  getSecretBundle,
  setSecret,
  setSecretBundle,
  wipeCloud
} from './cloud-store.ts'
import {
  cleanCloudBinding,
  cleanCloudInterval,
  cleanCloudUrl,
  cloudPath,
  cloudProvider,
  isAbsoluteFolder,
  isCloudPath,
  newCloudId,
  overlaps,
  type CloudAccount,
  type CloudBinding,
  type CloudBindingStatus,
  type CloudCounts,
  type CloudEntryState,
  type CloudPreview,
  type CloudProgress,
  type CloudState,
  type CloudTarget,
  type CloudView
} from '../shared/cloud.ts'
import { cleanRemoteName, remoteJoin } from './cloud-core.ts'
import { clearCloudHashes, loadBaseline, loadCloudHashes, saveBaseline, saveCloudHashes, type CloudHashRow } from './sync-store.ts'
import { hashFile } from './hash.ts'
import { pairKey } from '../shared/sync.ts'

export type CloudDeps = {
  remote?: RemoteFs
  trash(p: string): Promise<void>
  emit(channel: string, payload: unknown): void
}

/** A binding's local root, pre-normalised once so a 100 000-row listing does not re-normalise it. */
type BindingRoot = { norm: string; id: string; provider: string }

type Live = {
  state: CloudState
  lastRunAt: number | null
  nextRunAt: number | null
  lastError: string | null
  conflicts: string[]
  dirty: boolean
  failures: number
  /** the run in flight, as the panes and the sidebar draw it */
  progress: CloudProgress | null
  /** what the last comparison found, per file state */
  counts: CloudCounts
}

export type CloudAccountDraft = {
  provider: string
  url?: string
  user?: string
  password?: string
  label?: string
  /** OAuth providers: the user's own registered app (this repository ships no client id) */
  clientId?: string
  clientSecret?: string
}

export type CloudBindingDraft = {
  id?: string
  accountId: string
  localPath: string
  remoteId: string
  remoteLabel?: string
  name?: string
  compareBy?: string
  deleteExtra?: boolean
  intervalMs?: number
  direction?: string
}

export type CloudBindingPatch = {
  name?: string
  intervalMs?: number
  deleteExtra?: boolean
  compareBy?: string
  direction?: string
  enabled?: boolean
  paused?: boolean
}

export type CloudPreviewDraft = {
  accountId: string
  localPath: string
  remoteId: string
}

const TICK_MS = 30_000
const DEBOUNCE_MS = 1_500

const liveOf = (id: string): Live => {
  const stored = runtimeOf(id)
  return {
    state: stored.conflicts.length ? 'conflict' : 'idle',
    lastRunAt: stored.lastRunAt,
    nextRunAt: null,
    lastError: stored.lastError,
    conflicts: stored.conflicts,
    dirty: stored.dirty,
    failures: stored.failures,
    progress: null,
    counts: { ...ZERO_COUNTS }
  }
}

export function createCloudService(deps: CloudDeps) {
  const live = new Map<string, Live>()
  /** the last comparison, per binding: what each local path should draw */
  const states = new Map<string, EntryStates>()
  /**
   * `fs:list` asks for a badge on every row of a folder that can hold 100 000 entries. The binding
   * list is the same for the whole listing, so it is normalised once and rebuilt only when an
   * account or binding changes.
   */
  let roots: BindingRoot[] | null = null
  const bindingRoots = (): BindingRoot[] => {
    if (roots) return roots
    const out: BindingRoot[] = []
    for (const b of cloudBindings()) {
      const account = findAccount(b.accountId)
      if (!account) continue
      out.push({
        norm: b.localPath.replace(/\\/g, '/').replace(/\/+$/, ''),
        id: b.id,
        provider: account.provider
      })
    }
    roots = out
    return out
  }
  const forgetRoots = (): void => {
    roots = null
  }
  const running = new Set<string>()
  const watchers = new Map<string, FSWatcher>()
  const debounces = new Map<string, NodeJS.Timeout>()
  /** when a run last wrote into its own folder; those events must not start another run */
  const settledAt = new Map<string, number>()
  let timer: NodeJS.Timeout | null = null

  const status = (id: string): CloudBindingStatus => {
    const l = live.get(id) ?? liveOf(id)
    return {
      bindingId: id,
      state: l.state,
      lastRunAt: l.lastRunAt,
      nextRunAt: l.nextRunAt,
      lastError: l.lastError,
      conflicts: l.conflicts,
      dirty: l.dirty,
      counts: l.counts,
      progress: l.progress
    }
  }

  const view = (): CloudView => {
    const bindings = cloudBindings()
    return {
      accounts: cloudAccounts(),
      bindings,
      status: bindings.map((b) => status(b.id)),
      busy: running.size > 0
    }
  }

  const broadcast = (): void => deps.emit('cloud:state', view())

  const setLive = (id: string, patch: Partial<Live>): Live => {
    const next = { ...(live.get(id) ?? liveOf(id)), ...patch }
    live.set(id, next)
    return next
  }

  /** Persist the small part that must survive a restart (not the live clock). */
  const persist = (id: string): void => {
    const l = live.get(id) ?? liveOf(id)
    patchRuntime(id, {
      lastRunAt: l.lastRunAt,
      lastError: l.lastError,
      conflicts: l.conflicts,
      failures: l.failures,
      dirty: l.dirty
    })
  }

  const makeClient = (provider: string, access: string): CloudClient => {
    if (provider === 'gdrive') return createDrive(access)
    if (provider === 'dropbox') return createDropbox(access)
    if (provider === 'onedrive') return createOneDrive(access)
    throw new Error('this provider is not supported yet')
  }

  /**
   * One client for every family. OAuth tokens are refreshed here (and written back to the keyring)
   * so no adapter has to know about expiry.
   */
  const clientFor = async (account: CloudAccount): Promise<CloudClient> => {
    const bundle = getSecretBundle(account.id)
    if (!bundle) throw new Error('the stored sign-in is not available; reconnect this account')
    if (bundle.kind === 'password') {
      if (!account.url) throw new Error('this account has no server address')
      return createDav({ base: account.url, user: account.user ?? '', pass: bundle.password })
    }
    let access = bundle.access
    if (bundle.expiresAt - 60_000 <= Date.now()) {
      if (!bundle.refresh) throw new Error('the sign-in expired; reconnect this account')
      const next = await oauthRefresh(
        account.provider as OAuthProviderId,
        { clientId: bundle.clientId, clientSecret: bundle.clientSecret },
        bundle.refresh,
        { access: bundle.access, refresh: bundle.refresh, expiresAt: bundle.expiresAt }
      )
      access = next.access
      setSecretBundle(account.id, {
        kind: 'oauth',
        clientId: bundle.clientId,
        ...(bundle.clientSecret ? { clientSecret: bundle.clientSecret } : {}),
        ...next
      })
    }
    return makeClient(account.provider, access)
  }

  const bindingsFor = (accountId: string): CloudBinding[] => cloudBindings().filter((b) => b.accountId === accountId)

  // ---------------------------------------------------------------- accounts

  async function saveAccount(draft: CloudAccountDraft): Promise<CloudAccount> {
    const provider = cloudProvider(String(draft.provider ?? ''))
    if (!provider) throw new Error('unknown provider')
    if (!provider.ready) throw new Error('this provider is not available yet')
    const label = String(draft.label ?? '').trim().slice(0, 120)
    const id = newCloudId([...cloudAccounts().map((a) => a.id), ...cloudBindings().map((b) => b.accountId)])

    if (provider.family === 'dav') {
      const user = String(draft.user ?? '').trim()
      if (!user) throw new Error('a user name is required')
      const password = String(draft.password ?? '')
      if (!password) throw new Error('an app password is required')
      const base = cleanCloudUrl(draft.url)
      if (!base) throw new Error('a valid http(s) URL is required')
      const url =
        provider.id === 'nextcloud' || provider.id === 'owncloud'
          ? nextcloudRoot(base, user)
          : base.replace(/\/+$/, '')
      const dav = createDav({ base: url, user, pass: password })
      await dav.test()
      // the id is only minted once the connection is proven, so a failed attempt leaves nothing behind
      const { sessionOnly } = setSecret(id, password)
      const account: CloudAccount = {
        id,
        provider: provider.id,
        label: label || davAccountLabel(url, user),
        url,
        user,
        sessionOnly,
        createdAt: Date.now()
      }
      putAccount(account)
      forgetRoots()
      setLive(account.id, { ...liveOf(account.id), state: 'idle', lastError: null })
      broadcast()
      return account
    }

    // OAuth: the consent page opens in the system browser and the code returns to 127.0.0.1
    const clientId = String(draft.clientId ?? '').trim()
    const clientSecret = String(draft.clientSecret ?? '').trim() || undefined
    if (!clientId) throw new Error('a client id is required')
    const result = await oauthLogin(
      provider.id as OAuthProviderId,
      { clientId, clientSecret },
      (url) => void shell.openExternal(url)
    )
    const probe = makeClient(provider.id, result.tokens.access)
    await probe.list('/')
    const { sessionOnly } = setSecretBundle(id, {
      kind: 'oauth',
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...result.tokens
    })
    const account: CloudAccount = {
      id,
      provider: provider.id,
      label: label || result.label,
      sessionOnly,
      createdAt: Date.now()
    }
    putAccount(account)
    forgetRoots()
    setLive(account.id, { ...liveOf(account.id), state: 'idle', lastError: null })
    broadcast()
    return account
  }

  function removeAccount(id: string): void {
    for (const b of bindingsFor(id)) {
      stopBinding(b.id)
      clearCloudHashes(pairKey(b.localPath, cloudPath(b.id)))
      states.delete(b.id)
    }
    deleteAccount(id)
    live.delete(id)
    forgetRoots()
    broadcast()
  }

  function accountById(id: string): CloudAccount {
    const a = findAccount(String(id ?? ''))
    if (!a) throw new Error('unknown account')
    return a
  }

  // ---------------------------------------------------------------- browsing

  async function browse(accountId: string, remotePath = '/'): Promise<CloudTarget[]> {
    const account = accountById(accountId)
    const dav = await clientFor(account)
    const p = remotePath.startsWith('/') ? remotePath.replace(/\/+$/, '') || '/' : `/${remotePath}`
    const rows = await dav.list(p)
    return rows
      .filter((r) => r.dir)
      .map((r) => ({ path: r.path, name: r.name, dir: true, size: 0, mtime: r.mtime }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async function createFolder(accountId: string, parent: string, name: string): Promise<string> {
    const account = accountById(accountId)
    const clean = cleanRemoteName(name)
    if (!clean) throw new Error('a folder name is required')
    const dav = await clientFor(account)
    return dav.createFolder(parent.startsWith('/') ? parent : `/${parent}`, clean)
  }

  /**
   * The estimate the dialog shows before a binding exists. It compares by mtime on purpose: a
   * content hash would download every file just to draw three numbers. The real binding still uses
   * the provider's own mode, and the payload says so.
   */
  async function preview(draft: CloudPreviewDraft): Promise<CloudPreview> {
    const account = accountById(draft.accountId)
    const localPath = String(draft.localPath ?? '').trim()
    if (!isAbsoluteFolder(localPath)) throw new Error('an absolute local folder is required')
    const st = await fs.stat(localPath).catch(() => null)
    if (!st || !st.isDirectory()) throw new Error('the local folder does not exist')
    const remoteId = String(draft.remoteId ?? '/').trim()
    if (!remoteId.startsWith('/')) throw new Error('a remote folder is required')
    const dav = await clientFor(account)
    const remoteStat = await dav.stat(remoteId)
    if (!remoteStat || !remoteStat.dir) throw new Error('the remote folder does not exist')
    const provider = cloudProvider(account.provider)
    const hashMode = provider?.preservesMtime === false
    const probe: CloudBinding = {
      id: 'cloud-preview01',
      accountId: account.id,
      name: 'preview',
      localPath,
      remoteId,
      remoteLabel: remoteId,
      direction: 'both',
      compareBy: 'mtime',
      deleteExtra: false,
      intervalMs: 900_000,
      enabled: true,
      paused: true,
      createdAt: 0
    }
    const ops = createOps(deps.remote, cloudOps(probe, dav))
    const ctl: SyncControl = { cancelled: false, paused: false }
    const cmp = await compareTrees(localPath, cloudPath(probe.id), ops, {
      compareBy: 'mtime',
      twoWay: true,
      maxRows: 5_000,
      budgetMs: 15_000,
      ctl
    })
    const out: CloudPreview = {
      up: 0,
      down: 0,
      same: 0,
      conflicts: 0,
      bytesUp: 0,
      bytesDown: 0,
      capped: cmp.capped,
      hashMode
    }
    for (const row of cmp.rows) {
      if (row.state === 'leftOnly' || row.state === 'leftNewer') {
        out.up++
        out.bytesUp += row.left?.size ?? 0
      } else if (row.state === 'rightOnly' || row.state === 'rightNewer') {
        out.down++
        out.bytesDown += row.right?.size ?? 0
      } else if (row.state === 'conflict' || row.state === 'typeDiff') {
        out.conflicts++
      } else {
        out.same++
      }
    }
    return out
  }

  // ---------------------------------------------------------------- bindings

  async function saveBinding(draft: CloudBindingDraft): Promise<CloudBinding> {
    const account = accountById(draft.accountId)
    const localPath = String(draft.localPath ?? '').trim()
    if (!isAbsoluteFolder(localPath)) throw new Error('an absolute local folder is required')
    const st = await fs.stat(localPath).catch(() => null)
    if (!st || !st.isDirectory()) throw new Error('the local folder does not exist')
    const remoteId = String(draft.remoteId ?? '/').trim()
    if (!remoteId.startsWith('/')) throw new Error('a remote folder is required')
    const dav = await clientFor(account)
    const remoteStat = await dav.stat(remoteId)
    if (!remoteStat || !remoteStat.dir) throw new Error('the remote folder does not exist')
    const others = cloudBindings().filter((b) => b.id !== draft.id)
    if (others.some((b) => overlaps(b.localPath, localPath))) throw new Error('this folder is already used by another cloud binding')
    const existing = draft.id ? findBinding(String(draft.id)) : null
    const provider = cloudProvider(account.provider)
    // a server that does not keep the timestamp would bounce every upload, so it compares by hash
    const compareBy = draft.compareBy === 'mtime' || draft.compareBy === 'hash'
      ? draft.compareBy
      : provider?.preservesMtime === false
        ? 'hash'
        : 'mtime'
    const binding = cleanCloudBinding({
      id: existing?.id ?? newCloudId([...cloudBindings().map((b) => b.id), ...cloudAccounts().map((a) => a.id)]),
      accountId: account.id,
      name: draft.name || path.basename(localPath),
      localPath,
      remoteId,
      remoteLabel: draft.remoteLabel || remoteId,
      direction: draft.direction ?? 'both',
      compareBy,
      deleteExtra: draft.deleteExtra === true,
      intervalMs: cleanCloudInterval(provider?.id ?? 'webdav', draft.intervalMs),
      enabled: true,
      paused: false,
      createdAt: existing?.createdAt ?? Date.now()
    })
    if (!binding) throw new Error('invalid cloud folder')
    // the binding keeps the account's provider floor
    binding.intervalMs = cleanCloudInterval(account.provider, binding.intervalMs)
    putBinding(binding)
    forgetRoots()
    if (existing) stopBinding(existing.id)
    const prev = runtimeOf(binding.id)
    setLive(binding.id, {
      state: prev.conflicts.length ? 'conflict' : 'idle',
      lastRunAt: prev.lastRunAt,
      nextRunAt: Date.now(),
      lastError: prev.lastError,
      conflicts: prev.conflicts,
      dirty: true,
      failures: 0
    })
    startWatcher(binding)
    broadcast()
    // the first run starts in a moment instead of on the next 30 s tick
    arm(binding.id)
    pump()
    return binding
  }

  function updateBinding(id: string, patch: CloudBindingPatch): CloudBinding {
    const cur = findBinding(String(id ?? ''))
    if (!cur) throw new Error('unknown cloud folder')
    const account = findAccount(cur.accountId)
    const next: CloudBinding = {
      ...cur,
      name: typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim().slice(0, 120) : cur.name,
      intervalMs:
        patch.intervalMs === undefined
          ? cur.intervalMs
          : cleanCloudInterval(account?.provider ?? 'webdav', patch.intervalMs),
      deleteExtra: patch.deleteExtra === undefined ? cur.deleteExtra : patch.deleteExtra === true,
      compareBy: patch.compareBy === 'mtime' ? 'mtime' : patch.compareBy === 'hash' ? 'hash' : cur.compareBy,
      direction: patch.direction === 'ltr' || patch.direction === 'rtl' ? patch.direction : patch.direction === 'both' ? 'both' : cur.direction,
      enabled: patch.enabled === undefined ? cur.enabled : patch.enabled !== false,
      paused: patch.paused === undefined ? cur.paused : patch.paused === true
    }
    putBinding(next)
    forgetRoots()
    startWatcher(next)
    const l = setLive(next.id, {
      state: next.paused ? 'paused' : (live.get(next.id)?.state ?? 'idle'),
      nextRunAt: next.paused ? null : Date.now()
    })
    persist(next.id)
    if (l.state === 'paused') {
      arm(next.id)
      broadcast()
    } else {
      schedule(next.id)
      pump()
    }
    broadcast()
    return next
  }

  function removeBinding(id: string): void {
    const binding = findBinding(String(id ?? ''))
    stopBinding(String(id ?? ''))
    if (binding) clearCloudHashes(pairKey(binding.localPath, cloudPath(binding.id)))
    deleteBinding(String(id ?? ''))
    live.delete(String(id ?? ''))
    states.delete(String(id ?? ''))
    forgetRoots()
    broadcast()
  }

  function stopBinding(id: string): void {
    const timerFor = timers.get(id)
    if (timerFor) clearTimeout(timerFor)
    timers.delete(id)
    const w = watchers.get(id)
    if (w) {
      try {
        w.close()
      } catch {
        // already gone
      }
      watchers.delete(id)
    }
    const d = debounces.get(id)
    if (d) clearTimeout(d)
    debounces.delete(id)
  }

  /** A recursive watch on the local folder; a change pulls the next run forward. */
  function startWatcher(binding: CloudBinding): void {
    if (watchers.has(binding.id)) return
    try {
      const w = watch(binding.localPath, { recursive: true }, () => {
        const l = live.get(binding.id)
        if (l?.state === 'paused') return
        // a run writes into this folder; those events must not schedule another run. The guard is
        // also time-based because fs.watch delivers the events of a finished download a moment later.
        if (running.has(binding.id)) return
        if (Date.now() - (settledAt.get(binding.id) ?? 0) < 3_000) return
        setLive(binding.id, { dirty: true })
        const prev = debounces.get(binding.id)
        if (prev) clearTimeout(prev)
        debounces.set(
          binding.id,
          setTimeout(() => {
            debounces.delete(binding.id)
            persist(binding.id)
            schedule(binding.id, true)
            pump()
          }, DEBOUNCE_MS)
        )
      })
      w.on('error', () => undefined)
      watchers.set(binding.id, w)
    } catch {
      // some network mounts have no watcher; the interval still catches up
    }
  }

  // ---------------------------------------------------------------- running

  function schedule(id: string, soon = false): void {
    const binding = findBinding(id)
    if (!binding) return
    const l = live.get(id) ?? liveOf(id)
    const next = soon
      ? Date.now() + 500
      : nextRunAt(binding, { lastRunAt: l.lastRunAt, dirty: l.dirty }, Date.now(), l.failures)
    setLive(id, { nextRunAt: next })
    arm(id)
  }

  const failState = (message: string): CloudState =>
    /EAI_AGAIN|ENOTFOUND|ECONNREFUSED|timeout|timed out|network|fetch failed/i.test(message) ? 'offline' : 'error'

  async function run(bindingId: string, opts: { confirmDelete?: boolean } = {}): Promise<{
    ok: boolean
    copied: number
    removed: number
    conflicts: number
    blockedDeletes: number
    error?: string
  }> {
    const id = String(bindingId ?? '')
    const binding = findBinding(id)
    if (!binding) return { ok: false, copied: 0, removed: 0, conflicts: 0, blockedDeletes: 0, error: 'unknown cloud folder' }
    if (running.has(id)) return { ok: false, copied: 0, removed: 0, conflicts: 0, blockedDeletes: 0, error: 'a run is already in flight' }
    const account = findAccount(binding.accountId)
    if (!account) return { ok: false, copied: 0, removed: 0, conflicts: 0, blockedDeletes: 0, error: 'the account is gone' }
    running.add(id)
    // the previous map described the folder before this run; while it is in flight every row
    // falls back to the binding state, which is exactly «syncing»
    states.delete(id)
    let progress: CloudProgress = {
      phase: 'scan',
      files: 0,
      filesDone: 0,
      bytesTotal: 0,
      bytesDone: 0,
      current: '',
      startedAt: Date.now()
    }
    let lastEmit = 0
    // a walk reports every file; the UI only needs four frames a second
    const push = (force = false): void => {
      const now = Date.now()
      if (!force && now - lastEmit < 250) return
      lastEmit = now
      setLive(id, { progress: { ...progress } })
      broadcast()
    }
    setLive(id, { state: 'checking', lastError: null, progress: { ...progress } })
    broadcast()
    const ctl: SyncControl = { cancelled: false, paused: false }
    try {
      const dav = await clientFor(account)
      const root = cloudPath(binding.id)
      const pair = pairKey(binding.localPath, root)
      const baseline = loadBaseline(pair)
      // a server without a content hash is read once and remembered by its ETag
      const hashes = binding.compareBy === 'hash' ? loadCloudHashes(pair) : new Map<string, CloudHashRow>()
      // a run that changed nothing must not rewrite the table
      const hashesBefore = new Map(hashes)
      const ops = createOps(deps.remote, cloudOps(binding, dav, undefined, hashes))
      setLive(id, { state: 'syncing' })
      broadcast()
      const cmp = await compareTrees(binding.localPath, root, ops, {
        compareBy: binding.compareBy,
        twoWay: binding.direction === 'both',
        baseline,
        maxRows: 20_000,
        budgetMs: 120_000,
        ctl,
        onProgress: (_phase, done, current) => {
          progress.files = done
          progress.current = current
          push()
        }
      })
      const conflicts = conflictPaths(cmp.rows)
      const plan = makePlan(cmp.rows, binding.direction, { deleteExtra: binding.deleteExtra })
      // a scheduled run never deletes on the remote side without a human saying so
      let blockedDeletes = 0
      if (!opts.confirmDelete) {
        const kept = plan.remove.filter((a) => a.to !== 'right')
        blockedDeletes = plan.remove.length - kept.length
        plan.remove = kept
      }
      // the plan — not the row count — is the honest total: every action is one file
      const byRel = new Map(cmp.rows.map((r) => [r.rel, r]))
      progress = {
        ...progress,
        phase: 'copy',
        files: plan.copy.length + plan.remove.length,
        filesDone: 0,
        bytesTotal: plan.copy.reduce((n, a) => {
          const row = byRel.get(a.rel)
          return n + (a.from === 'left' ? (row?.left?.size ?? 0) : (row?.right?.size ?? 0))
        }, 0),
        bytesDone: 0,
        current: ''
      }
      ctl.onFile = (rel) => {
        progress.filesDone++
        progress.current = rel
        push()
      }
      ctl.onBytes = (n) => {
        progress.bytesDone += n
        push()
      }
      push(true)
      const applied = await applyPlan(binding.localPath, root, plan, ops, { trash: deps.trash, ctl })
      // a failed action must not enter the baseline: the next run has to retry it
      const failed = (rel: string): boolean => applied.errors.some((e) => e.startsWith(`${rel}: `))
      const settled: typeof plan = {
        ...plan,
        copy: plan.copy.filter((a) => !failed(a.rel)),
        remove: plan.remove.filter((a) => !failed(a.rel))
      }
      const next = nextBaseline(cmp.rows, baseline, settled)
      await refreshUploadedBaseline(next, settled, dav, binding, hashes)
      saveBaseline(pair, next)
      if (binding.compareBy === 'hash') {
        // a path that no longer exists on the cloud side does not need a remembered hash
        const present = new Set(cmp.rows.filter((r) => r.right && !r.right.dir).map((r) => r.rel))
        for (const rel of [...hashes.keys()]) if (!present.has(rel)) hashes.delete(rel)
        const moved =
          hashes.size !== hashesBefore.size ||
          [...hashes].some(([rel, v]) => {
            const old = hashesBefore.get(rel)
            return !old || old.etag !== v.etag || old.hash !== v.hash || old.size !== v.size
          })
        if (moved) saveCloudHashes(pair, hashes)
      }
      const map = entryStates(cmp.rows, settled, applied.errors)
      states.set(id, map)
      const l = setLive(id, {
        state: conflicts.length ? 'conflict' : applied.errors.length ? 'error' : 'idle',
        lastRunAt: Date.now(),
        lastError: applied.errors[0] ?? null,
        conflicts,
        dirty: false,
        failures: applied.errors.length ? l0(id) + 1 : 0,
        progress: null,
        counts: map.counts
      })
      l.nextRunAt = nextRunAt(binding, { lastRunAt: l.lastRunAt, dirty: false }, Date.now(), l.failures)
      persist(id)
      broadcast()
      return {
        ok: applied.errors.length === 0,
        copied: applied.copied,
        removed: applied.removed,
        conflicts: conflicts.length,
        blockedDeletes,
        ...(applied.errors.length ? { error: applied.errors.slice(0, 3).join('; ') } : {})
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const l = setLive(id, {
        state: failState(message),
        lastError: message.slice(0, 400),
        failures: l0(id) + 1,
        dirty: true,
        progress: null
      })
      l.nextRunAt = nextRunAt({ intervalMs: binding.intervalMs, enabled: binding.enabled }, { lastRunAt: Date.now(), dirty: false }, Date.now(), l.failures)
      persist(id)
      broadcast()
      return { ok: false, copied: 0, removed: 0, conflicts: 0, blockedDeletes: 0, error: message }
    } finally {
      running.delete(id)
      settledAt.set(id, Date.now())
      arm(id)
      broadcast()
      pump()
    }
  }


  /**
   * A server that does not keep the source timestamp answers an upload with its own `Last-Modified`,
   * so a baseline recorded from the *local* side can never match it again: the next run would call a
   * locally deleted file «edited on both sides» and badge it as a conflict forever. One PROPFIND per
   * uploaded file records what the server actually says. Uploads are the only direction that needs
   * this — a download takes the source timestamp, and mtime comparison is exact by definition.
   */
  async function refreshUploadedBaseline(
    next: Record<string, { size: number; mtime: number; dir: boolean; hash?: string }>,
    plan: { copy: { rel: string; to: 'left' | 'right' }[] },
    dav: CloudClient,
    binding: CloudBinding,
    hashes: Map<string, CloudHashRow>
  ): Promise<void> {
    if (binding.compareBy !== 'hash') return
    const rels = plan.copy.filter((a) => a.to === 'right').map((a) => a.rel)
    if (!rels.length) return
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++
        if (i >= rels.length) return
        const rel = rels[i]
        const st = await dav.stat(remoteJoin(binding.remoteId, rel)).catch(() => null)
        if (!st) continue
        next[rel] = { size: st.size, mtime: st.mtime, dir: st.dir }
        // the content that was just uploaded is on disk here, so its hash is free
        if (st.etag) {
          const h = await hashFile(path.join(binding.localPath, rel)).catch(() => null)
          if (h) hashes.set(rel, { size: st.size, etag: st.etag, hash: h })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, rels.length) }, worker))
  }

  const l0 = (id: string): number => live.get(id)?.failures ?? runtimeOf(id).failures

  // ---------------------------------------------------------------- scheduler

  const timers = new Map<string, NodeJS.Timeout>()

  /** Arm one binding for its own `nextRunAt`; nothing has to wait for the safety tick. */
  function arm(id: string): void {
    const prev = timers.get(id)
    if (prev) clearTimeout(prev)
    timers.delete(id)
    const binding = findBinding(id)
    if (!binding || !binding.enabled || binding.paused) return
    const l = live.get(id) ?? liveOf(id)
    if (l.nextRunAt === null) return
    const wait = Math.max(60, Math.min(2_147_000_000, l.nextRunAt - Date.now() + 60))
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        pump()
      }, wait)
    )
  }

  /**
   * Scheduled runs are serial: a cloud run is mostly network, and starting every due binding at the
   * same moment (which is what a loop over «due» bindings did) turned app start into a burst of tree
   * walks and PROPFINDs. A manual «Sync now» still starts at once, even while another binding runs.
   */
  function pump(): void {
    if (running.size > 0) return
    const now = Date.now()
    for (const binding of cloudBindings()) {
      if (!binding.enabled || binding.paused || running.has(binding.id)) continue
      const l = live.get(binding.id) ?? liveOf(binding.id)
      if (!live.has(binding.id)) live.set(binding.id, l)
      if (l.nextRunAt === null) {
        schedule(binding.id)
        arm(binding.id)
        continue
      }
      if (l.nextRunAt > now) continue
      void run(binding.id).catch(() => undefined)
      return
    }
  }

  /** The 30 s tick is a safety net now: re-arm a lost timer and start anything already due. */
  function tick(): void {
    for (const binding of cloudBindings()) arm(binding.id)
    pump()
  }

  function start(): void {
    if (timer) return
    let i = 0
    for (const b of cloudBindings()) {
      if (!live.has(b.id)) live.set(b.id, liveOf(b.id))
      startWatcher(b)
      // staggered catch-up: the first binding starts in under a second, the rest follow instead of
      // all of them walking the cloud at once
      setLive(b.id, { nextRunAt: Date.now() + 800 + i++ * 1_200 })
      arm(b.id)
    }
    timer = setInterval(tick, TICK_MS)
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
    for (const id of [...watchers.keys()]) stopBinding(id)
    for (const d of debounces.values()) clearTimeout(d)
    debounces.clear()
  }

  /** Called after a successful account connection so the first run does not wait an interval. */
  function wake(id: string): void {
    if (!findBinding(id)) return
    schedule(id, true)
    pump()
  }

  // ---------------------------------------------------------------- badges

  /**
   * The state a pane row should draw, or `null` when the path is not inside a binding.
   * Few bindings exist, so a prefix check is cheaper than maintaining a second index.
   */
  function forPath(p: string): { provider: string; state: CloudEntryState; root: boolean } | null {
    if (!isAbsoluteFolder(p)) return null
    const norm = p.replace(/\\/g, '/').replace(/\/+$/, '')
    let best: BindingRoot | null = null
    for (const r of bindingRoots()) {
      if (norm === r.norm || norm.startsWith(r.norm + '/')) {
        if (!best || r.norm.length > best.norm.length) best = r
      }
    }
    if (!best) return null
    const l = live.get(best.id) ?? liveOf(best.id)
    const isRoot = norm === best.norm
    let state = entryState(l.state, l.dirty)
    const map = states.get(best.id)
    // paused/offline/error/conflict belong to the whole binding and outrank a file's own verdict
    if (map && l.state === 'idle') {
      const rel = isRoot ? '' : norm.slice(best.norm.length + 1)
      // a file row wins; a folder (and the root) carries the worst state below it
      state = (isRoot ? map.dirs.get('') : (map.files.get(rel) ?? map.dirs.get(rel))) ?? state
    }
    return { provider: best.provider, state, root: isRoot }
  }

  return {
    start,
    stop,
    view,
    status,
    saveAccount,
    removeAccount,
    browse,
    createFolder,
    preview,
    saveBinding,
    updateBinding,
    removeBinding,
    run,
    wake,
    forPath,
    wipe: wipeCloud,
    docs: (provider: string): string => oauthDocs(provider as OAuthProviderId),
    bindingRoot: (id: string): string | null => findBinding(id)?.localPath ?? null,
    remotePathOf: (id: string): string | null => {
      const b = findBinding(id)
      return b ? `${b.accountId}\u0000${b.remoteId}` : null
    }
  }
}

export type CloudService = ReturnType<typeof createCloudService>
