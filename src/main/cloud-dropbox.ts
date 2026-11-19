/**
 * Dropbox: paths are real paths (`/Docs/a.txt`), so this adapter is a thin JSON wrapper.
 * Uploads send `client_modified`, which is what makes an mtime comparison stable.
 */
import { promises as fs } from 'node:fs'
import {
  CloudHttpError,
  encodePath,
  nameOf,
  normPath,
  parentOf,
  countedBody,
  writeBody,
  type CloudChange,
  type CloudClient,
  type CloudEntry
} from './cloud-client.ts'
import type { CloudNode } from './cloud-changes.ts'
import { remoteJoin } from './cloud-core.ts'

type DbxEntry = {
  '.tag': 'file' | 'folder' | 'deleted'
  name: string
  path_display?: string
  size?: number
  client_modified?: string
  server_modified?: string
  /** content hash and version: either changes when the bytes change */
  content_hash?: string
  rev?: string
}

type DbxList = { entries: DbxEntry[]; cursor: string; has_more: boolean }

/** Dropbox speaks paths, so a node id is the entry's path and the parent id is its folder path. */
const dropboxId = (e: DbxEntry): string =>
  normPath(e.path_display ?? `/${e.name}`)

/** The path below the binding root, or null when the entry lives outside it. */
const relBelow = (base: string, id: string): string | null => {
  const clean = normPath(base)
  if (clean === '/') return id.replace(/^\/+/, '') || null
  if (!id.startsWith(`${clean}/`)) return null
  return id.slice(clean.length + 1) || null
}


export function createDropbox(access: string, impl: typeof fetch = fetch): CloudClient {
  const api = 'https://api.dropboxapi.com/2'
  const content = 'https://content.dropboxapi.com/2'
  const auth = { Authorization: `Bearer ${access}` }

  const apiPath = (p: string): string => (normPath(p) === '/' ? '' : normPath(p))

  const call = async <T>(endpoint: string, body: unknown): Promise<T> => {
    const res = await impl(`${api}${endpoint}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    if (!res.ok) {
      let summary = text.slice(0, 300)
      try {
        const j = JSON.parse(text) as { error_summary?: string }
        if (j.error_summary) summary = j.error_summary
      } catch {
        // keep the raw body
      }
      throw new CloudHttpError(res.status, summary)
    }
    return (text ? JSON.parse(text) : {}) as T
  }

  const entryOf = (e: DbxEntry, fallbackParent = '/'): CloudEntry => {
    const path = e.path_display ?? remoteJoin(fallbackParent, e.name)
    const when = e.client_modified ?? e.server_modified
    return {
      name: e.name,
      path,
      dir: e['.tag'] === 'folder',
      size: e.size ?? 0,
      mtime: when ? Date.parse(when) : 0,
      ...(e.content_hash || e.rev ? { etag: e.content_hash ?? e.rev } : {})
    }
  }

  const client: CloudClient = {
    async test() {
      await client.list('/')
      return { ok: true, detail: 'Dropbox responded' }
    },

    /**
     * One recursive listing for the whole binding. `list_folder/continue` pages the same cursor,
     * so the fast first run costs one request per 2000 nodes instead of one per folder.
     */
    async flatten(base) {
      const clean = normPath(base)
      let res = await call<DbxList>('/files/list_folder', {
        path: apiPath(clean),
        recursive: true,
        limit: 2000,
        include_deleted: false
      })
      const out: CloudNode[] = []
      let guard = 0
      let capped = false
      for (;;) {
        for (const e of res.entries) {
          if (e['.tag'] === 'deleted') continue
          const id = dropboxId(e)
          const rel = relBelow(clean, id)
          if (!rel) continue
          out.push({
            id,
            rel,
            parentId: parentOf(id),
            name: nameOf(id),
            dir: e['.tag'] === 'folder',
            size: e['.tag'] === 'folder' ? 0 : (e.size ?? 0),
            mtime: e.server_modified ? Date.parse(e.server_modified) : 0,
            ...(e.content_hash || e.rev ? { etag: e.content_hash ?? e.rev } : {})
          })
        }
        if (!res.has_more) break
        if (guard++ > 1000) {
          // an incomplete list would make the adoption pass treat every missing node as
          // «local only» and upload the whole other side; the caller must fall back to a walk
          capped = true
          break
        }
        res = await call<DbxList>('/files/list_folder/continue', { cursor: res.cursor })
      }
      return { nodes: out, capped }
    },

    async rootKey(base) {
      // paths are the ids here, so the root of the binding is simply its path
      return normPath(base)
    },

    /**
     * The cursor of a recursive root listing is Dropbox's change cursor. One entry is allowed
     * through (it is already in the seeded tree) so the feed resumes from a real cursor instead of
     * a hand-built one.
     */
    async startToken() {
      const res = await call<DbxList>('/files/list_folder', {
        path: '',
        recursive: true,
        limit: 1,
        include_deleted: false
      })
      return res.cursor
    },

    async changes(token) {
      const changes: CloudChange[] = []
      let cursor = token
      let guard = 0
      for (;;) {
        const res = await call<DbxList>('/files/list_folder/continue', { cursor })
        for (const e of res.entries) {
          const id = dropboxId(e)
          const removed = e['.tag'] === 'deleted'
          changes.push({
            id,
            removed,
            parentId: removed ? null : parentOf(id),
            name: nameOf(id),
            dir: e['.tag'] === 'folder',
            size: e['.tag'] === 'folder' ? 0 : (e.size ?? 0),
            mtime: e.server_modified ? Date.parse(e.server_modified) : 0,
            ...(e.content_hash || e.rev ? { etag: e.content_hash ?? e.rev } : {})
          })
        }
        cursor = res.cursor
        if (!res.has_more || guard++ > 1000) break
      }
      return { changes, nextToken: cursor }
    },

    async stat(p) {
      try {
        const e = await call<DbxEntry>('/files/get_metadata', { path: apiPath(p) })
        const out = entryOf(e, parentOf(p))
        return { size: out.size, mtime: out.mtime, dir: out.dir }
      } catch (e) {
        if (e instanceof CloudHttpError && e.status === 409 && /not_found/.test(e.body)) return null
        throw e
      }
    },

    async list(p) {
      let res = await call<{ entries: DbxEntry[]; cursor: string; has_more: boolean }>('/files/list_folder', {
        path: apiPath(p),
        recursive: false,
        limit: 2000,
        include_deleted: false
      })
      const rows: CloudEntry[] = []
      for (;;) {
        for (const e of res.entries) if (e['.tag'] !== 'deleted') rows.push(entryOf(e, p))
        if (!res.has_more) break
        res = await call('/files/list_folder/continue', { cursor: res.cursor })
      }
      return rows.sort((a, b) => a.name.localeCompare(b.name))
    },

    async mkdir(p) {
      try {
        await call('/files/create_folder_v2', { path: apiPath(p), autorename: false })
      } catch (e) {
        if (e instanceof CloudHttpError && e.status === 409 && /conflict/.test(e.body)) return
        throw e
      }
    },

    async createFolder(parent, name) {
      const target = remoteJoin(parent, name)
      const found = await client.stat(target)
      if (found) {
        if (found.dir) return target
        throw new Error('a file with that name already exists')
      }
      await client.mkdir(target)
      return target
    },

    async remove(p) {
      try {
        await call('/files/delete_v2', { path: apiPath(p) })
      } catch (e) {
        if (e instanceof CloudHttpError && e.status === 409 && /not_found/.test(e.body)) return
        throw e
      }
    },

    async download(p, dest, onBytes) {
      const res = await impl(`${content}/files/download`, {
        method: 'POST',
        headers: { ...auth, 'Dropbox-API-Arg': JSON.stringify({ path: apiPath(p) }) }
      })
      if (!res.ok) throw new CloudHttpError(res.status, (await res.text()).slice(0, 300))
      await fs.mkdir(dest.slice(0, dest.lastIndexOf('/')) || '.', { recursive: true }).catch(() => undefined)
      await writeBody(res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>, dest, onBytes)
    },

    async upload(src, p, mtime, onBytes) {
      const st = await fs.stat(src)
      const arg = {
        path: apiPath(p),
        mode: 'overwrite',
        autorename: false,
        mute: true,
        ...(mtime ? { client_modified: new Date(mtime).toISOString() } : {})
      }
      const body = countedBody(src, onBytes)
      const res = await impl(`${content}/files/upload`, {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(st.size),
          'Dropbox-API-Arg': JSON.stringify(arg)
        },
        body,
        duplex: 'half'
      } as RequestInit)
      if (!res.ok) throw new CloudHttpError(res.status, (await res.text()).slice(0, 300))
    }
  }
  return client
}

/** Folders the comparison can ignore without asking the server. */
export const dropboxPathShape = (p: string): { name: string; safe: boolean } => {
  const n = nameOf(p)
  return { name: n, safe: n !== '/' && !encodePath(n).includes('%2F') }
}
