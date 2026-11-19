import { safeStorage } from 'electron'
import { readStore, writeStore } from './store.ts'
import {
  cleanCloudAccounts,
  cleanCloudBindings,
  type CloudAccount,
  type CloudBinding
} from '../shared/cloud.ts'

/**
 * Accounts, bindings and the small runtime snapshot live in the SQLite `app` table next to every
 * other setting — not in `prefs`, because prefs are mirrored to the renderer and to a JSON backup.
 *
 * The password never touches the disk in plain text: `safeStorage` (KWallet/GNOME Keyring/DPAPI)
 * encrypts it, exactly like a remote profile. Without a real keyring the secret stays in memory for
 * this session and the account is marked `sessionOnly`; writing it anyway would be worse.
 */
type RuntimeStored = {
  lastRunAt: number | null
  lastError: string | null
  conflicts: string[]
  failures: number
  dirty: boolean
  /** Drive change feed cursor; null means the next run is a full scan */
  pageToken: string | null
  /** when the node tree was last rebuilt from a complete scan (unix ms) */
  fullScanAt: number | null
}

type StoreShape = {
  version: 1
  accounts: CloudAccount[]
  bindings: CloudBinding[]
  secrets: Record<string, string>
  runtime: Record<string, RuntimeStored>
}

const STORE_KEY = 'cloud'
const SECRET_PREFIX = 'v1:'
const sessionSecrets = new Map<string, string>()

const empty = (): StoreShape => ({ version: 1, accounts: [], bindings: [], secrets: {}, runtime: {} })

let cache: StoreShape | null = null

function encryptionAvailable(): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false
    // Chromium's "basic_text" backend uses a hard-coded key; that is not encryption in any useful
    // sense, so treat it as no keyring at all (same rule as remotes.ts).
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false
    return true
  } catch {
    return false
  }
}

function shape(raw: unknown): StoreShape {
  const base = empty()
  if (!raw || typeof raw !== 'object') return base
  const s = raw as Record<string, unknown>
  const accounts = cleanCloudAccounts(s.accounts)
  const bindings = cleanCloudBindings(s.bindings, accounts)
  const secrets: Record<string, string> = {}
  if (s.secrets && typeof s.secrets === 'object') {
    for (const [k, v] of Object.entries(s.secrets as Record<string, unknown>)) {
      if (typeof v === 'string' && v.startsWith(SECRET_PREFIX)) secrets[k] = v
    }
  }
  const runtime: Record<string, RuntimeStored> = {}
  const ids = new Set(bindings.map((b) => b.id))
  if (s.runtime && typeof s.runtime === 'object') {
    for (const [k, v] of Object.entries(s.runtime as Record<string, unknown>)) {
      if (!ids.has(k) || !v || typeof v !== 'object') continue
      const r = v as Record<string, unknown>
      runtime[k] = {
        lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : null,
        lastError: typeof r.lastError === 'string' ? r.lastError.slice(0, 400) : null,
        conflicts: Array.isArray(r.conflicts) ? r.conflicts.filter((x) => typeof x === 'string').slice(0, 500) : [],
        failures: typeof r.failures === 'number' && r.failures >= 0 ? Math.min(20, Math.floor(r.failures)) : 0,
        dirty: r.dirty === true,
        pageToken: typeof r.pageToken === 'string' && r.pageToken ? r.pageToken.slice(0, 2048) : null,
        fullScanAt:
          typeof r.fullScanAt === 'number' && Number.isFinite(r.fullScanAt) && r.fullScanAt > 0
            ? r.fullScanAt
            : null
      }
    }
  }
  return { version: 1, accounts, bindings, secrets, runtime }
}

function db(): StoreShape {
  if (!cache) cache = shape(readStore<unknown>(STORE_KEY))
  return cache
}

function write(next: StoreShape): void {
  cache = next
  writeStore(STORE_KEY, next)
}

export function cloudAccounts(): CloudAccount[] {
  return db().accounts
}

export function cloudBindings(): CloudBinding[] {
  return db().bindings
}

export function findBinding(id: string): CloudBinding | null {
  return db().bindings.find((b) => b.id === id) ?? null
}

export function findAccount(id: string): CloudAccount | null {
  return db().accounts.find((a) => a.id === id) ?? null
}

export function putAccount(account: CloudAccount): void {
  const cur = db()
  const accounts = [...cur.accounts.filter((a) => a.id !== account.id), account]
  write({ ...cur, accounts })
}

export function deleteAccount(id: string): void {
  const cur = db()
  const bindings = cur.bindings.filter((b) => b.accountId !== id)
  const runtime = { ...cur.runtime }
  for (const b of cur.bindings) if (b.accountId === id) delete runtime[b.id]
  const secrets = { ...cur.secrets }
  delete secrets[id]
  sessionSecrets.delete(id)
  write({ ...cur, accounts: cur.accounts.filter((a) => a.id !== id), bindings, runtime, secrets })
}

export function putBinding(binding: CloudBinding): void {
  const cur = db()
  const bindings = [...cur.bindings.filter((b) => b.id !== binding.id), binding]
  write({ ...cur, bindings })
}

export function deleteBinding(id: string): void {
  const cur = db()
  const runtime = { ...cur.runtime }
  delete runtime[id]
  write({ ...cur, bindings: cur.bindings.filter((b) => b.id !== id), runtime })
}

function storeRawSecret(id: string, plain: string): { sessionOnly: boolean } {
  const cur = db()
  const secrets = { ...cur.secrets }
  if (encryptionAvailable()) {
    let buf: Buffer
    try {
      buf = safeStorage.encryptString(plain)
    } catch {
      sessionSecrets.set(id, plain)
      delete secrets[id]
      write({ ...cur, secrets })
      return { sessionOnly: true }
    }
    secrets[id] = SECRET_PREFIX + buf.toString('base64')
    sessionSecrets.delete(id)
    write({ ...cur, secrets })
    return { sessionOnly: false }
  }
  sessionSecrets.set(id, plain)
  delete secrets[id]
  write({ ...cur, secrets })
  return { sessionOnly: true }
}

export function setSecret(id: string, plain: string): { sessionOnly: boolean } {
  return storeRawSecret(id, plain)
}

export function getSecret(id: string): string | null {
  const hit = db().secrets[id]
  if (hit) {
    try {
      return safeStorage.decryptString(Buffer.from(hit.slice(SECRET_PREFIX.length), 'base64'))
    } catch {
      return null
    }
  }
  return sessionSecrets.get(id) ?? null
}

export function hasSecret(id: string): boolean {
  return !!db().secrets[id] || sessionSecrets.has(id)
}

export function runtimeOf(id: string): RuntimeStored {
  return (
    db().runtime[id] ?? {
      lastRunAt: null,
      lastError: null,
      conflicts: [],
      failures: 0,
      dirty: false,
      pageToken: null,
      fullScanAt: null
    }
  )
}

export function patchRuntime(id: string, patch: Partial<RuntimeStored>): RuntimeStored {
  const cur = db()
  const next = { ...runtimeOf(id), ...patch }
  write({ ...cur, runtime: { ...cur.runtime, [id]: next } })
  return next
}

/** Tests and «reset» in settings: nothing about a cloud account survives. */
export function wipeCloud(): void {
  sessionSecrets.clear()
  write(empty())
}

/** What one account keeps in the keyring: a DAV password, or the OAuth tokens and client. */
export type CloudSecretBundle =
  | { kind: 'password'; password: string }
  | {
      kind: 'oauth'
      access: string
      refresh?: string
      /** unix ms */
      expiresAt: number
      clientId: string
      clientSecret?: string
    }

export function setSecretBundle(id: string, bundle: CloudSecretBundle): { sessionOnly: boolean } {
  return storeRawSecret(id, JSON.stringify(bundle))
}

/** A bundle, or a legacy raw password written by the DAV flow before OAuth existed. */
export function getSecretBundle(id: string): CloudSecretBundle | null {
  const raw = getSecret(id)
  if (!raw) return null
  if (raw.startsWith('{"kind":"')) {
    try {
      const parsed = JSON.parse(raw) as CloudSecretBundle
      if (parsed && (parsed.kind === 'password' || parsed.kind === 'oauth')) return parsed
    } catch {
      // fall through to the password shape
    }
  }
  return { kind: 'password', password: raw }
}
