/**
 * OneDrive through Microsoft Graph. Graph addresses files by path (`/me/drive/root:/Docs/a.txt`),
 * so this stays a thin wrapper like Dropbox; the timestamp is server-set on upload, which is why
 * the binding defaults to a content-hash comparison for this provider.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  CloudHttpError,
  encodePath,
  normPath,
  countedBody,
  writeBody,
  type CloudChange,
  type CloudClient,
  type CloudEntry
} from './cloud-client.ts'
import type { CloudNode } from './cloud-changes.ts'
import { remoteJoin } from './cloud-core.ts'

type GraphItem = {
  id: string
  name: string
  size?: number
  folder?: { childCount: number }
  file?: { mimeType?: string; hashes?: { quickXorHash?: string; sha1Hash?: string } }
  eTag?: string
  lastModifiedDateTime?: string
  parentReference?: { id?: string; path?: string }
  deleted?: { state: string }
}

type GraphDeltaPage = {
  value?: GraphItem[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

const MAX_SIMPLE = 250 * 1024 * 1024
/** A change enumeration longer than this is treated as «needs a full scan», not paged forever. */
const MAX_DELTA_PAGES = 1000

/**
 * The saved cursor is a full Graph URL, so it is re-checked before it is fetched with the bearer
 * token: a compromised/malformed response must not be able to send the token to another host.
 */
const graphDeltaUrl = (raw: string | undefined): string | null => {
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' &&
      u.hostname === 'graph.microsoft.com' &&
      u.pathname.startsWith('/v1.0/me/drive/')
      ? u.toString()
      : null
  } catch {
    return null
  }
}

const etagOf = (it: GraphItem): { etag?: string } =>
  it.file?.hashes?.quickXorHash || it.eTag ? { etag: it.file?.hashes?.quickXorHash ?? it.eTag } : {}

export function createOneDrive(access: string, impl: typeof fetch = fetch): CloudClient {
  const api = 'https://graph.microsoft.com/v1.0/me/drive'
  const auth = { Authorization: `Bearer ${access}` }

  const itemUrl = (p: string): string => {
    const clean = normPath(p)
    return clean === '/' ? `${api}/root` : `${api}/root:/${encodePath(clean.slice(1))}`
  }
  const childrenUrl = (p: string): string =>
    normPath(p) === '/' ? `${api}/root/children` : `${itemUrl(p)}:/children`

  const json = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
    const res = await impl(url, { ...init, headers: { ...auth, ...(init.headers ?? {}) } })
    const text = await res.text()
    if (!res.ok) {
      let message = text.slice(0, 300)
      try {
        const j = JSON.parse(text) as { error?: { message?: string } }
        if (j.error?.message) message = j.error.message
      } catch {
        // keep the raw body
      }
      throw new CloudHttpError(res.status, message)
    }
    return (text ? JSON.parse(text) : {}) as T
  }

  const entryOf = (it: GraphItem, parent: string): CloudEntry => ({
    name: it.name,
    path: remoteJoin(parent, it.name),
    dir: !!it.folder,
    size: it.size ?? 0,
    mtime: it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) : 0,
    ...etagOf(it)
  })

  const deltaUrl = (p: string): string =>
    normPath(p) === '/' ? `${api}/root/delta` : `${itemUrl(p)}:/delta`

  /** The delta link produced by the last `flatten`: the node tree and the feed cursor are the same snapshot. */
  let lastDeltaLink: string | null = null

  /**
   * Walk `@odata.nextLink` until `@odata.deltaLink`, handing every item to `visit`. Both link kinds
   * are re-validated because the bearer token goes with the request.
   */
  const deltaPages = async (
    start: string,
    visit: (it: GraphItem) => void
  ): Promise<{ deltaLink: string | null; next: string | null; capped: boolean }> => {
    let url = graphDeltaUrl(start)
    if (!url) throw new Error('the change feed address is not a Microsoft Graph address')
    let guard = 0
    for (;;) {
      const page = await json<GraphDeltaPage>(url)
      for (const it of page.value ?? []) visit(it)
      const delta = graphDeltaUrl(page['@odata.deltaLink'])
      if (delta) return { deltaLink: delta, next: null, capped: false }
      const next = graphDeltaUrl(page['@odata.nextLink'])
      if (!next) return { deltaLink: null, next: null, capped: false }
      // the caller keeps `next` as its cursor, so a long enumeration continues on the next run
      if (guard++ >= MAX_DELTA_PAGES) return { deltaLink: null, next, capped: true }
      url = next
    }
  }

  const nodeOf = (it: GraphItem, parentId: string, rel: string): CloudNode => ({
    id: it.id,
    rel,
    parentId,
    name: it.name,
    dir: !!it.folder,
    size: it.folder ? 0 : (it.size ?? 0),
    mtime: it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) : 0,
    ...etagOf(it)
  })

  const client: CloudClient = {
    async test() {
      await json(`${api}/root`)
      return { ok: true, detail: 'OneDrive responded' }
    },

    /**
     * The delta query of the binding root is already a recursive, paged listing: one request per
     * page instead of one per folder. The last delta link is kept because it is exactly the cursor
     * the change feed needs next.
     */
    async flatten(base) {
      const clean = normPath(base)
      const rootId = await client.rootKey!(clean)
      if (!rootId) return { nodes: [], capped: false }
      const items = new Map<string, GraphItem>()
      const run = await deltaPages(deltaUrl(clean), (it) => {
        if (it.id) items.set(it.id, it)
      })
      if (run.deltaLink) lastDeltaLink = run.deltaLink
      // a delta record only knows its parent id, so the paths have to be rebuilt from the root
      const children = new Map<string, GraphItem[]>()
      for (const it of items.values()) {
        if (it.deleted) continue
        const parent = it.parentReference?.id
        if (!parent) continue
        const list = children.get(parent)
        if (list) list.push(it)
        else children.set(parent, [it])
      }
      const out: CloudNode[] = []
      const queue: { id: string; rel: string }[] = [{ id: rootId, rel: '' }]
      const visited = new Set<string>([rootId])
      while (queue.length) {
        const cur = queue.shift()!
        for (const it of children.get(cur.id) ?? []) {
          if (visited.has(it.id)) continue
          visited.add(it.id)
          const rel = cur.rel ? `${cur.rel}/${it.name}` : it.name
          const node = nodeOf(it, cur.id, rel)
          out.push(node)
          if (node.dir) queue.push({ id: it.id, rel })
        }
      }
      return { nodes: out, capped: run.capped }
    },

    async rootKey(p) {
      try {
        const it = await json<GraphItem>(itemUrl(p))
        return it.id || null
      } catch (e) {
        if (e instanceof CloudHttpError && e.status === 404) return null
        throw e
      }
    },

    /**
     * `flatten` already enumerated the same delta and kept its link; reusing it means the tree in
     * `cloud_nodes` and the cursor describe one snapshot with no second full enumeration.
     */
    async startToken() {
      if (!lastDeltaLink) {
        throw new Error('the change cursor is not ready; the next run will do a full scan')
      }
      return lastDeltaLink
    },

    async changes(token) {
      const changes: CloudChange[] = []
      const run = await deltaPages(token, (it) => {
        const removed = !!it.deleted
        changes.push({
          id: it.id,
          removed,
          parentId: removed ? null : (it.parentReference?.id ?? null),
          name: it.name ?? '',
          dir: !!it.folder,
          size: it.folder ? 0 : (it.size ?? 0),
          mtime: it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) : 0,
          ...etagOf(it)
        })
      })
      const next = run.deltaLink ?? run.next
      if (!next) throw new Error('Microsoft Graph returned neither a next page nor a delta link')
      return { changes, nextToken: next }
    },

    async stat(p) {
      try {
        const it = await json<GraphItem>(itemUrl(p))
        return {
          size: it.folder ? 0 : (it.size ?? 0),
          mtime: it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) : 0,
          dir: !!it.folder
        }
      } catch (e) {
        if (e instanceof CloudHttpError && e.status === 404) return null
        throw e
      }
    },

    async list(p) {
      const rows: CloudEntry[] = []
      let url: string | undefined = childrenUrl(p)
      let guard = 0
      while (url && guard++ < 100) {
        const page: { value: GraphItem[]; '@odata.nextLink'?: string } = await json(url)
        for (const it of page.value) rows.push(entryOf(it, p))
        url = page['@odata.nextLink']
      }
      return rows.sort((a, b) => a.name.localeCompare(b.name))
    },

    async mkdir(p) {
      const clean = normPath(p)
      if (clean === '/') return
      const parts = clean.split('/').filter(Boolean)
      let parent = '/'
      for (const part of parts) {
        const target = remoteJoin(parent, part)
        const found = await client.stat(target)
        if (!found) {
          await json(childrenUrl(parent), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: part,
              folder: {},
              '@microsoft.graph.conflictBehavior': 'fail'
            })
          })
        } else if (!found.dir) {
          throw new Error(`a file is in the way of a folder: ${target}`)
        }
        parent = target
      }
    },

    async createFolder(parent, name) {
      const target = remoteJoin(parent, name)
      const found = await client.stat(target)
      if (found) {
        if (found.dir) return target
        throw new Error('a file with that name already exists')
      }
      await json(childrenUrl(parent), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' })
      })
      return target
    },

    async remove(p) {
      try {
        const res = await impl(itemUrl(p), { method: 'DELETE', headers: auth })
        if (!res.ok && res.status !== 404) {
          throw new CloudHttpError(res.status, (await res.text()).slice(0, 300))
        }
      } catch (e) {
        if (e instanceof CloudHttpError && e.status === 404) return
        throw e
      }
    },

    async download(p, dest, onBytes) {
      const res = await impl(`${itemUrl(p)}:/content`, { headers: auth, redirect: 'follow' })
      if (!res.ok) throw new CloudHttpError(res.status, (await res.text()).slice(0, 300))
      await fs.mkdir(path.dirname(dest), { recursive: true }).catch(() => undefined)
      await writeBody(
        res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
        dest,
        onBytes
      )
    },

    async upload(src, p, _mtime, onBytes) {
      const st = await fs.stat(src)
      if (st.size > MAX_SIMPLE) {
        throw new Error('this file is larger than the 250 MB one-request upload limit')
      }
      const body = countedBody(src, onBytes)
      const res = await impl(`${itemUrl(p)}:/content`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Content-Length': String(st.size) },
        body,
        duplex: 'half'
      } as RequestInit)
      if (!res.ok) throw new CloudHttpError(res.status, (await res.text()).slice(0, 300))
    }
  }
  return client
}
