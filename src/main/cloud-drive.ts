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
  type CloudClient,
  type CloudEntry
} from './cloud-client.ts'
import { remoteJoin } from './cloud-core.ts'

const FOLDER = 'application/vnd.google-apps.folder'
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,md5Checksum'

type DriveFile = {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime?: string
  md5Checksum?: string
}

const escapeQ = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

export function createDrive(access: string, impl: typeof fetch = fetch): CloudClient {
  const api = 'https://www.googleapis.com/drive/v3'
  const uploadApi = 'https://www.googleapis.com/upload/drive/v3'
  const auth = { Authorization: `Bearer ${access}` }
  const ids = new Map<string, string>([['/', 'root']])

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
    dir: f.mimeType === FOLDER,
    size: f.size ? Number(f.size) : 0,
    mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
    ...(f.md5Checksum ? { etag: f.md5Checksum } : {})
  })

  const client: CloudClient = {
    async test() {
      await json(`${api}/about?fields=user`)
      return { ok: true, detail: 'Google Drive responded' }
    },

    async stat(p) {
      const id = await resolve(p)
      if (!id) return null
      try {
        const f = await json<DriveFile>(`${api}/files/${id}?fields=${encodeURIComponent(FILE_FIELDS)}`)
        return {
          size: f.mimeType === FOLDER ? 0 : f.size ? Number(f.size) : 0,
          mtime: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
          dir: f.mimeType === FOLDER,
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
        for (const f of page.files ?? []) rows.push(entryOf(f, p))
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
      ids.delete(normPath(p))
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
      const res = await impl(`${uploadApi}/files?uploadType=multipart&fields=id`, {
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
      const created = (await res.json()) as { id?: string }
      if (created.id) ids.set(normPath(p), created.id)
    }
  }
  return client
}

/** Exported for the URL tests: the query Drive uses to find one name under a parent. */
export const driveNameQuery = (parentId: string, name: string): string =>
  `name = '${escapeQ(name)}' and '${parentId}' in parents and trashed = false`

export const driveFolderMime = FOLDER
export const drivePathFor = (p: string): string => encodePath(normPath(p))
