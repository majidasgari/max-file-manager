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
  type CloudClient,
  type CloudEntry
} from './cloud-client.ts'
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
