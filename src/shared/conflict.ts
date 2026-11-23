/**
 * What a copy or move does when the destination name is already taken. `keep` never loses the
 * existing file (it becomes "name (2)"), so it stays the default; the other three are the
 * Explorer-style "overwrite all / skip all / only newer" answers, applied to the whole job.
 */
export type ConflictPolicy = 'keep' | 'overwrite' | 'skip' | 'newer'

export const CONFLICT_POLICIES: ConflictPolicy[] = ['keep', 'overwrite', 'skip', 'newer']

export function isConflictPolicy(v: unknown): v is ConflictPolicy {
  return typeof v === 'string' && (CONFLICT_POLICIES as string[]).includes(v)
}

/** Old jobs (and old MCP callers) carried two booleans; they map onto the same four answers. */
export function conflictOf(o: {
  conflict?: ConflictPolicy
  skipExisting?: boolean
  newerOnly?: boolean
}): ConflictPolicy {
  if (isConflictPolicy(o.conflict)) return o.conflict
  if (o.skipExisting) return 'skip'
  if (o.newerOnly) return 'newer'
  return 'keep'
}
