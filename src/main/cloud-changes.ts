/**
 * Pure incremental bookkeeping for a provider change feed. The tree in `cloud_nodes` is the map
 * from provider id to the path the sync engine understands; this file only applies one page of
 * changes to it and reports the relative paths whose local/remote comparison is now stale.
 *
 * No fs, no electron: `node --test` imports this file directly.
 */
import type { CloudChangePage } from './cloud-client.ts'

export type CloudNode = {
  id: string
  /** path below the binding root, '/'-joined */
  rel: string
  parentId: string | null
  name: string
  dir: boolean
  size: number
  mtime: number
  etag?: string
}

/** A full tree scan older than this is not trusted as the base of an incremental run. */
export const FULL_SCAN_MAX_AGE_MS = 24 * 60 * 60_000

export type CloudRunMode = 'adopt' | 'feed' | 'local' | 'full'

export type RunModeInput = {
  /** the adapter can list the whole subtree in one paginated query */
  hasFlatten: boolean
  /** the adapter can report changes *and* name the binding root by id (`changes`/`startToken`/`rootKey`) */
  hasFeed: boolean
  /** 'fast' enables the one-time adoption pass; 'full' asks for a plain tree comparison */
  seed: string
  nodeCount: number
  pageToken: string | null
  fullScanAt: number | null
  now: number
}

/**
 * Which comparison a run may use. Kept pure (and outside `cloud-service`, which imports electron)
 * because this decision silently changes whether a run copies the whole tree or only the moved
 * paths, so it needs its own tests.
 */
export function chooseRunMode(input: RunModeInput): CloudRunMode {
  // an empty node map means this binding has never been seeded: the first run may accept the
  // existing files by size instead of transferring them. `seed: 'full'` is the user asking for a
  // real comparison, so adoption never overrides it.
  if (input.hasFlatten && input.seed !== 'full' && input.nodeCount === 0) return 'adopt'
  const fresh =
    typeof input.fullScanAt === 'number' && input.now - input.fullScanAt < FULL_SCAN_MAX_AGE_MS
  if (!fresh || input.nodeCount === 0) return 'full'
  if (!input.hasFeed) return 'local'
  return input.pageToken ? 'feed' : 'full'
}


export type ChangeOutcome = {
  /** relative paths that must be compared again (deleted paths included) */
  dirty: string[]
  rescan: boolean
  nodes: Map<string, CloudNode>
}

const parentRelOf = (
  node: CloudNode | undefined,
  parentId: string | null,
  rootId: string
): string | null => {
  if (parentId === rootId || parentId === null) return ''
  return node?.rel ?? null
}

const relOf = (parentRel: string, name: string): string => (parentRel ? `${parentRel}/${name}` : name)

/**
 * Apply one page. A change whose parent is unknown cannot be placed below the binding root, so the
 * caller must fall back to a full scan instead of guessing a path (`rescan`).
 */
export function applyChanges(
  nodes: Map<string, CloudNode>,
  rootId: string,
  page: CloudChangePage
): ChangeOutcome {
  const out = new Map(nodes)
  const dirty: string[] = []
  const seen = new Set<string>()
  const mark = (rel: string): void => {
    if (!rel || seen.has(rel)) return
    seen.add(rel)
    dirty.push(rel)
  }
  let rescan = false

  for (const change of page.changes) {
    if (change.removed) {
      const known = out.get(change.id)
      if (!known) continue
      out.delete(change.id)
      mark(known.rel)
      continue
    }

    if (!change.name) continue
    const parent = out.get(change.parentId ?? '')
    const parentRel = parentRelOf(parent, change.parentId, rootId)
    if (parentRel === null) {
      // the parent is outside this binding (or a change we have not seen yet); a partial tree
      // would silently lose a subtree, so ask for a full rescan
      rescan = true
      continue
    }

    const rel = relOf(parentRel, change.name)
    const known = out.get(change.id)
    if (!known) {
      out.set(change.id, {
        id: change.id,
        rel,
        parentId: change.parentId,
        name: change.name,
        dir: change.dir,
        size: change.size,
        mtime: change.mtime,
        ...(change.etag ? { etag: change.etag } : {})
      })
      mark(rel)
      continue
    }

    const oldRel = known.rel
    const updated: CloudNode = {
      id: change.id,
      rel,
      parentId: change.parentId,
      name: change.name,
      dir: change.dir,
      size: change.size,
      mtime: change.mtime,
      ...(change.etag ? { etag: change.etag } : {})
    }
    out.set(change.id, updated)
    if (oldRel === rel) {
      mark(rel)
      continue
    }

    // a rename or a move changes every descendant path; the subtree itself is not new content
    mark(oldRel)
    mark(rel)
    if (!updated.dir) continue
    const prefix = `${oldRel}/`
    for (const [childId, child] of out) {
      if (childId === change.id || !child.rel.startsWith(prefix)) continue
      out.set(childId, { ...child, rel: rel + child.rel.slice(oldRel.length) })
    }
  }

  return { dirty, rescan, nodes: out }
}
