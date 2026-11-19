/**
 * The one shape every cloud adapter exposes. It is deliberately the same surface the WebDAV
 * client already had, so `cloudOps`, the preview and the sync run never learn which provider they
 * are talking to.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import type { ReadableStream as WebReadable } from 'node:stream/web'
// a type-only cycle: `cloud-changes.ts` imports the change-page shape from here, and this file
// needs the node shape to describe `flatten`. Erased at runtime, so nothing circular is loaded.
import type { CloudNode } from './cloud-changes.ts'

export type CloudEntry = {
  name: string
  /** absolute provider path, used by the folder browser */
  path: string
  dir: boolean
  size: number
  mtime: number
  etag?: string
}

export type CloudStat = { size: number; mtime: number; dir: boolean; etag?: string }

/** One entry from a provider's change feed, already flattened to the fields the tree needs. */
export type CloudChange = {
  id: string
  removed: boolean
  /** شناسهٔ والد در سمت ارائه‌دهنده؛ برای فایل حذف‌شده null */
  parentId: string | null
  name: string
  dir: boolean
  size: number
  mtime: number
  /** md5 در Drive */
  etag?: string
}

export type CloudChangePage = { changes: CloudChange[]; nextToken: string; newStartToken?: string }

export type CloudClient = {
  stat(p: string): Promise<CloudStat | null>
  list(p: string): Promise<CloudEntry[]>
  mkdir(p: string): Promise<void>
  createFolder(parent: string, name: string): Promise<string>
  remove(p: string): Promise<void>
  download(p: string, dest: string, onBytes?: (n: number) => void): Promise<void>
  upload(src: string, p: string, mtime?: number, onBytes?: (n: number) => void): Promise<void>
  test?(): Promise<{ ok: true; detail: string }>
  /**
   * Optional incremental feed. A provider without it is still compared by walking the whole tree,
   * so adding these two methods never breaks an adapter.
   */
  startToken?(): Promise<string>
  changes?(pageToken: string): Promise<CloudChangePage>
  /**
   * Every node below `base` from one paginated provider query instead of one folder request per
   * level. `capped` means the adapter stopped at its own budget, so the tree is incomplete and must
   * not seed an adoption pass. A provider without it simply cannot use the fast first run.
   */
  flatten?(base: string): Promise<{ nodes: CloudNode[]; capped: boolean }>
  /**
   * The provider id of the binding root. The change feed addresses entries by id and its records
   * only become relative paths when the parent chain starts here. Dropbox has no ids, so its
   * adapter returns the root path and uses paths as ids throughout.
   */
  rootKey?(base: string): Promise<string | null>
  /**
   * Nodes the full scan already saw through `list`. Drive fills this for free; an adapter without
   * it pays one `flatten` call when the incremental cursor is seeded.
   */
  treeNodes?(base: string): CloudNode[]
}

export class CloudHttpError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(body || `HTTP ${status}`)
    this.name = 'CloudHttpError'
    this.status = status
    this.body = body
  }
}

/** Write a fetch body to a file with backpressure, reporting the bytes as they land. */
export async function writeBody(
  body: WebReadable<Uint8Array> | null,
  dest: string,
  onBytes?: (n: number) => void
): Promise<void> {
  if (!body) throw new CloudHttpError(502, 'the server sent no body')
  const out = createWriteStream(dest)
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onBytes?.(value.byteLength)
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((r) => out.once('drain', () => r()))
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()))
  }
}

/**
 * The body of an upload, reporting bytes as they leave the disk. A provider that only calls
 * `onBytes(size)` after the response makes the bar sit at 0% and jump to 100% at the end, which is
 * exactly what a progress bar must not do.
 */
export function countedBody(src: string, onBytes?: (n: number) => void): ReadableStream<Uint8Array> {
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      onBytes?.(chunk.length)
      cb(null, chunk)
    }
  })
  const stream = createReadStream(src).pipe(counter)
  // a provider that rejects mid-body must not leave an unhandled stream error behind
  stream.on('error', () => undefined)
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
}

export const encodePath = (p: string): string =>
  p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')

export const normPath = (p: string): string => {
  const clean = p.replace(/\/+$/, '')
  return clean || '/'
}

export const parentOf = (p: string): string => {
  const clean = normPath(p)
  if (clean === '/') return '/'
  const i = clean.lastIndexOf('/')
  return i <= 0 ? '/' : clean.slice(0, i)
}

export const nameOf = (p: string): string => {
  const clean = normPath(p)
  return clean === '/' ? '/' : clean.slice(clean.lastIndexOf('/') + 1)
}

/** Accept a 404 as «not there» instead of an error, for stat. */
export const isNotFound = (e: unknown): boolean => e instanceof CloudHttpError && e.status === 404
