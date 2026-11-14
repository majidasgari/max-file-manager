/**
 * Drafts are the editor's safety net: the buffer is stored while it differs from the file, so a
 * closed window, a crash or a reboot does not lose typing. One key per file plus one index key
 * keeps a huge document from rewriting every other draft.
 */
export type Draft = { text: string; at: number }

export type DraftKV = {
  get(key: string): string | null
  set(key: string, value: string): void
}

const INDEX = 'draftIndex'
const keyFor = (path: string): string => `draft:${path}`
const MAX_DRAFTS = 200

export interface Drafts {
  get(path: string): Draft | null
  set(path: string, text: string, at?: number): Draft
  clear(path: string): void
  /** drop stale entries; returns how many were removed */
  prune(max?: number, now?: number, maxAgeDays?: number): number
}

const parse = <T>(raw: string | null): T | null => {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function createDrafts(kv: DraftKV): Drafts {
  const index = (): { path: string; at: number }[] => parse<{ path: string; at: number }[]>(kv.get(INDEX)) ?? []
  const saveIndex = (rows: { path: string; at: number }[]): void => kv.set(INDEX, JSON.stringify(rows))

  return {
    get(path) {
      const draft = parse<Draft>(kv.get(keyFor(path)))
      return draft && typeof draft.text === 'string' ? draft : null
    },
    set(path, text, at = Date.now()) {
      const draft: Draft = { text, at }
      kv.set(keyFor(path), JSON.stringify(draft))
      const rows = index().filter((r) => r.path !== path)
      rows.push({ path, at })
      saveIndex(rows)
      return draft
    },
    clear(path) {
      kv.set(keyFor(path), '')
      saveIndex(index().filter((r) => r.path !== path))
    },
    prune(max = MAX_DRAFTS, now = Date.now(), maxAgeDays = 60) {
      const rows = index()
      const alive = rows
        .filter((r) => now - r.at < maxAgeDays * 86_400_000)
        .sort((a, b) => a.at - b.at)
      // the newest `max` drafts survive, an ancient or over-quota one is forgotten
      const keep = alive.slice(-Math.max(0, max))
      const kept = new Set(keep.map((r) => r.path))
      const dropped = rows.filter((r) => !kept.has(r.path))
      for (const row of dropped) kv.set(keyFor(row.path), '')
      if (dropped.length) saveIndex(keep)
      return dropped.length
    }
  }
}
