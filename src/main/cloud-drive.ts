/**
 * Google Drive. Unlike the other two, Drive has no path API: every file and folder is an id, so the
 * adapter owns a path→id cache and resolves each segment by name on first use. The sync engine
 * still sees the same path-shaped `CloudClient`.
 *
 * The account uses the full `drive` scope (not `drive.file`) so the picker can show folders that
 * already exist. That is the reason a Google release needs OAuth verification.
 */
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import {
  CloudHttpError,
  encodePath,
  nameOf,
  normPath,
  parentOf,
  writeBody,
  type CloudChange,
  type CloudClient,
  type CloudEntry
} from './cloud-client.ts'
import type { CloudNode } from './cloud-changes.ts'
import { remoteJoin } from './cloud-core.ts'

const FOLDER = 'application/vnd.google-apps.folder'
const GOOGLE_APPS = 'application/vnd.google-apps.'
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,md5Checksum'
const FLATTEN_FIELDS = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum,parents)'
const CHANGE_FIELDS =
  'nextPageToken,newStartPageToken,changes(removed,fileId,file(id,name,mimeType,size,modifiedTime,md5Checksum,trashed,parents))'

type DriveFile = {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime?: string
  md5Checksum?: string
  trashed?: boolean
  parents?: string[]
}

type DriveChange = { removed?: boolean; fileId: string; file?: DriveFile }

/** The Drive-only extras the service keeps for its change feed and node seeding. */
export type DriveClient = CloudClient & {
  rootIdOf(p: string): Promise<string | null>
  /** Every entry seen by `list` in this run, rebased below `base`. */
  treeNodes(base: string): CloudNode[]
}

const escapeQ = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

const isFolder = (f: DriveFile): boolean => f.mimeType === FOLDER

const sizeOf = (f: DriveFile): number => {
  // a native Google document has no downloadable bytes; pretending it does would make every
  // comparison look like a size change
  if (!isFolder(f) && (f.mimeType ?? '').startsWith(GOOGLE_APPS)) return 0
  return f.size ? Number(f.size) || 0 : 0
}

const mtimeOf = (f: DriveFile): number => {
  const parsed = Date.parse(f.modifiedTime ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

export function createDrive(access: string, impl: typeof fetch = fetch): DriveClient {
  const api = 'https://www.googleapis.com/drive/v3'
  const uploadApi = 'https://www.googleapis.com/upload/drive/v3'
  const auth = { Authorization: `Bearer ${access}` }
  const ids = new Map<string, string>([['/', 'root']])
  /** path → node, filled by `list` during a full scan; `treeNodes` rebases it to one binding */
  const seen = new Map<string, CloudNode>()

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

  const findChild = async (parentId: string, name: string): Promise<DriveFile | null> => {
    const q = `name = '${escapeQ(name)}' and '${parentId}' in parents and trashed = false`
    const url = `${api}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(
      'files(id,name,mimeType)'
    )}&pageSize=1`
    const res = await json<{ files?: DriveFile[] }>(url)
    return res.files?.[0] ?? null
  }

  /** The id of a path, or null when any segment is missing. */
  const resolve = async (p: string): Promise<string | null> => {
    const clean = normPath(p)
    if (clean === '/') return 'root'
    const cached = ids.get(clean)
    if (cached) return cached
    let prefix = ''
    let parentId = 'root'
    for (const seg of clean.split('/').filter(Boolean)) {
      const childPath = `${prefix}/${seg}`
      const hit = ids.get(childPath)
      if (hit) {
        parentId = hit
        prefix = childPath
        continue
      }
      const found = await findChild(parentId, seg)
      if (!found) return null
      ids.set(childPath, found.id)
      parentId = found.id
      prefix = childPath
    }
    ids.set(clean, parentId)
    return parentId
  }

  const entryOf = (f: DriveFile, parent: string): CloudEntry => ({
    name: f.name,
    path: remoteJoin(parent, f.name),
    dir: isFolder(f),
    size: sizeOf(f),
    mtime: mtimeOf(f),
    ...(f.md5Checksum ? { etag: f.md5Checksum } : {})
  })

  const changeOf = (c: DriveChange): CloudChange => {
    const f = c.file
    const removed = c.removed === true || f?.trashed === true
    return {
      id: c.fileId || f?.id || '',
      removed,
      parentId: removed ? null : f?.parents?.[0] ?? null,
      name: f?.name ?? '',
      dir: f ? isFolder(f) : false,
      size: f ? sizeOf(f) : 0,
      mtime: f ? mtimeOf(f) : 0,
      ...(f?.md5Checksum ? { etag: f.md5Checksum } : {})
    }
  }

  const client: DriveClient = {
    async test() {
      await json(`${api}/about?fields=user`)
      return { ok: true, detail: 'Google Drive responded' }
    },

    async startToken() {
      const page = await json<{ startPageToken?: string }>(`${api}/changes/startPageToken`)
      if (!page.startPageToken) throw new Error('Drive did not return a change token')
      return page.startPageToken
    },

    async changes(pageToken) {
      const changes: CloudChange[] = []
      let token = pageToken
      let nextToken = pageToken
      let newStartToken: string | undefined
      let guard = 0
      for (;;) {
        const query = new URLSearchParams({
          pageToken: token,
          pageSize: '1000',
          includeRemoved: 'true',
          fields: CHANGE_FIELDS
        })
        const page = await json<{
          changes?: DriveChange[]
          nextPageToken?: string
          newStartPageToken?: string
        }>(`${api}/changes?${query.toString()}`)
        for (const change of page.changes ?? []) changes.push(changeOf(change))
        if (page.newStartPageToken) {
          nextToken = page.newStartPageToken
          newStartToken = page.newStartPageToken
          break
        }
        if (!page.nextPageToken || guard++ > 1000) break
        token = page.nextPageToken
        nextToken = token
      }
      return { changes, nextToken, ...(newStartToken ? { newStartToken } : {}) }
    },

    async rootIdOf(p) {
      return resolve(p)
    },

    async rootKey(p) {
      // Drive's feed carries file ids, so the root of a binding is identified the same way
      return resolve(p)
    },

    treeNodes(base) {
      const clean = normPath(base)
      const out: CloudNode[] = []
      for (const [p, node] of seen) {
        let rel: string
        if (clean === '/') rel = p.replace(/^\/+/, '')
        else if (p === clean) continue
        else if (p.startsWith(`${clean}/`)) rel = p.slice(clean.length + 1)
        else continue
        if (!rel) continue
        out.push({ ...node, rel })
      }
      return out
    },

    async flatten(base) {
      const clean = normPath(base)
      const rootId = await resolve(clean)
      if (!rootId) return { nodes: [], capped: false }
      // one account-wide listing is what turns «a request per folder» into «a page per 1000 nodes».
      // `parents` is the only way to rebuild the paths because Drive has no path API.
      const byId = new Map<string, DriveFile>()
      let pageToken = ''
      let guard = 0
      let capped = false
      for (;;) {
        const url =
          `${api}/files?q=${encodeURIComponent('trashed = false')}` +
          `&pageSize=1000&fields=${encodeURIComponent(FLATTEN_FIELDS)}` +
          `${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
        const page = await json<{ files?: DriveFile[]; nextPageToken?: string }>(url)
        for (const f of page.files ?? []) if (f.id) byId.set(f.id, f)
        if (!page.nextPageToken) break
        if (guard++ > 1000) {
          // a silently truncated list would make the adoption pass treat every missing node as
          // «local only» and upload the whole other side; the caller must fall back to a walk
          capped = true
          break
        }
        pageToken = page.nextPageToken
      }
      const children = new Map<string, DriveFile[]>()
      for (const f of byId.values()) {
        const parent = f.parents?.[0]
        if (!parent) continue
        const list = children.get(parent)
        if (list) list.push(f)
        else children.set(parent, [f])
      }
      // this call replaces the cached tree below the root; keeping old entries would make
      // `treeNodes` (and therefore the change feed's map) contain paths that no longer exist
      const prefix = clean === '/' ? '/' : `${clean}/`
      for (const key of [...seen.keys()]) {
        if (key === clean || key.startsWith(prefix)) seen.delete(key)
      }
      for (const key of [...ids.keys()]) {
        if (key === clean || key.startsWith(prefix)) ids.delete(key)
      }
      ids.set(clean, rootId)
      const out: CloudNode[] = []
      const queue: { id: string; rel: string }[] = [{ id: rootId, rel: '' }]
      const visited = new Set<string>([rootId])
      while (queue.length) {
        const cur = queue.shift()!
        for (const f of children.get(cur.id) ?? []) {
          if (visited.has(f.id)) continue
          visited.add(f.id)
          const rel = cur.rel ? `${cur.rel}/${f.name}` : f.name
          const node: CloudNode = {
            id: f.id,
            rel,
            parentId: cur.id,
            name: f.name,
            dir: isFolder(f),
            size: sizeOf(f),
            mtime: mtimeOf(f),
            ...(f.md5Checksum ? { etag: f.md5Checksum } : {})
          }
          const p = normPath(remoteJoin(clean, rel))
          ids.set(p, f.id)
          seen.set(p, node)
          out.push(node)
          if (node.dir) queue.push({ id: f.id, rel })
        }
      }
      return { nodes: out, capped }
    },

    async stat(p) {
      const id = await resolve(p)
      if (!id) return null
      try {
        const f = await json<DriveFile>(`${api}/files/${id}?fields=${encodeURIComponent(FILE_FIELDS)}`)
        return {
          size: sizeOf(f),
          mtime: mtimeOf(f),
          dir: isFolder(f),
          ...(f.md5Checksum ? { etag: f.md5Checksum } : {})
        }
      } catch (e) {
        if (e instanceof CloudHttpError && e.status === 404) return null
        throw e
      }
    },

    async list(p) {
      const id = await resolve(p)
      if (!id) throw new CloudHttpError(404, 'the folder does not exist')
      const rows: CloudEntry[] = []
      let pageToken = ''
      let guard = 0
      for (;;) {
        const q = `'${id}' in parents and trashed = false`
        const url =
          `${api}/files?q=${encodeURIComponent(q)}` +
          `&fields=${encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)}` +
          `&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
        const page = await json<{ files?: DriveFile[]; nextPageToken?: string }>(url)
        for (const f of page.files ?? []) {
          const childPath = remoteJoin(p, f.name)
          rows.push(entryOf(f, p))
          // a BFS walk asks for the next folder by path; remembering the id here saves the extra
          // `files?q=name=…` lookup `resolve` would otherwise make for every folder
          ids.set(normPath(childPath), f.id)
          // captured for the incremental tree at the end of a full scan; the extra field costs
          // nothing because the listing is already happening
          seen.set(childPath, {
            id: f.id,
            rel: '',
            parentId: id,
            name: f.name,
            dir: isFolder(f),
            size: sizeOf(f),
            mtime: mtimeOf(f),
            ...(f.md5Checksum ? { etag: f.md5Checksum } : {})
          })
        }
        if (!page.nextPageToken || guard++ > 100) break
        pageToken = page.nextPageToken
      }
      return rows.sort((a, b) => a.name.localeCompare(b.name))
    },

    async mkdir(p) {
      const clean = normPath(p)
      if (clean === '/') return
      let prefix = ''
      let parentId = 'root'
      for (const seg of clean.split('/').filter(Boolean)) {
        const childPath = `${prefix}/${seg}`
        let id = ids.get(childPath)
        if (!id) {
          const found = await findChild(parentId, seg)
          id = found?.id
        }
        if (!id) {
          const created = await json<DriveFile>(`${api}/files?fields=id`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: seg, mimeType: FOLDER, parents: [parentId] })
          })
          id = created.id
        }
        ids.set(childPath, id)
        seen.set(normPath(childPath), {
          id,
          rel: '',
          parentId,
          name: seg,
          dir: true,
          size: 0,
          mtime: 0
        })
        parentId = id
        prefix = childPath
      }
    },

    async createFolder(parent, name) {
      const target = remoteJoin(parent, name)
      const parentId = await resolve(parent)
      if (!parentId) throw new Error('the parent folder does not exist')
      const found = await findChild(parentId, name)
      if (found) {
        if (found.mimeType === FOLDER) {
          ids.set(normPath(target), found.id)
          return target
        }
        throw new Error('a file with that name already exists')
      }
      const created = await json<DriveFile>(`${api}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] })
      })
      ids.set(normPath(target), created.id)
      seen.set(normPath(target), {
        id: created.id,
        rel: '',
        parentId,
        name,
        dir: true,
        size: 0,
        mtime: 0
      })
      return target
    },

    async remove(p) {
      const id = await resolve(p)
      if (!id) return
      // to the Drive trash, not a permanent delete
      await json(`${api}/files/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
      })
      const clean = normPath(p)
      ids.delete(clean)
      seen.delete(clean)
      const prefix = `${clean}/`
      for (const key of [...seen.keys()]) if (key.startsWith(prefix)) seen.delete(key)
    },

    async download(p, dest, onBytes) {
      const id = await resolve(p)
      if (!id) throw new CloudHttpError(404, 'the file does not exist')
      const res = await impl(`${api}/files/${id}?alt=media`, { headers: auth, redirect: 'follow' })
      if (!res.ok) throw new CloudHttpError(res.status, (await res.text()).slice(0, 300))
      await fs.mkdir(path.dirname(dest), { recursive: true }).catch(() => undefined)
      await writeBody(
        res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
        dest,
        onBytes
      )
    },

    async upload(src, p, mtime, onBytes) {
      const parentId = await resolve(parentOf(p))
      if (!parentId) throw new Error('the parent folder does not exist')
      const st = await fs.stat(src)
      const boundary = `mfm-${randomUUID()}`
      const meta = JSON.stringify({
        name: nameOf(p),
        parents: [parentId],
        ...(mtime ? { modifiedTime: new Date(mtime).toISOString() } : {})
      })
      const head = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
          `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
      )
      const tail = Buffer.from(`\r\n--${boundary}--`)
      const stream = Readable.from(
        (async function* () {
          yield head
          for await (const chunk of createReadStream(src)) {
            onBytes?.((chunk as Buffer).length)
            yield chunk as Buffer
          }
          yield tail
        })()
      )
      const res = await impl(`${uploadApi}/files?uploadType=multipart&fields=id,md5Checksum`, {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(head.length + st.size + tail.length)
        },
        body: Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>,
        duplex: 'half'
      } as RequestInit)
      if (!res.ok) throw new CloudHttpError(res.status, (await res.text()).slice(0, 300))
      const created = (await res.json()) as { id?: string; md5Checksum?: string }
      if (created.id) {
        const clean = normPath(p)
        ids.set(clean, created.id)
        // a full scan records the tree *after* the plan ran; without this an upload of this very
        // run would be missing from `cloud_nodes` and its first later removal would be invisible
        seen.set(clean, {
          id: created.id,
          rel: '',
          parentId,
          name: nameOf(p),
          dir: false,
          size: st.size,
          mtime: mtime ?? st.mtimeMs,
          ...(created.md5Checksum ? { etag: created.md5Checksum } : {})
        })
      }
    }
  }
  return client
}

/** Exported for the URL tests: the query Drive uses to find one name under a parent. */
export const driveNameQuery = (parentId: string, name: string): string =>
  `name = '${escapeQ(name)}' and '${parentId}' in parents and trashed = false`

export const driveFolderMime = FOLDER
export const drivePathFor = (p: string): string => encodePath(normPath(p))
