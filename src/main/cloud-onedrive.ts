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
  type CloudClient,
  type CloudEntry
} from './cloud-client.ts'
import { remoteJoin } from './cloud-core.ts'

type GraphItem = {
  id: string
  name: string
  size?: number
  folder?: { childCount: number }
  file?: { mimeType?: string; hashes?: { quickXorHash?: string; sha1Hash?: string } }
  eTag?: string
  lastModifiedDateTime?: string
  parentReference?: { path?: string }
}

const MAX_SIMPLE = 250 * 1024 * 1024

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
    ...(it.file?.hashes?.quickXorHash || it.eTag
      ? { etag: it.file?.hashes?.quickXorHash ?? it.eTag }
      : {})
  })

  const client: CloudClient = {
    async test() {
      await json(`${api}/root`)
      return { ok: true, detail: 'OneDrive responded' }
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
