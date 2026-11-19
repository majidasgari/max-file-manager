/**
 * A minimal WebDAV client: PROPFIND / GET / PUT / MKCOL / DELETE.
 *
 * It is deliberately small and dependency-free. The same adapter serves Nextcloud, ownCloud, a
 * plain WebDAV server and QNAP's WebDAV (Qsync); only the base URL differs, and the caller already
 * normalises Nextcloud's `/remote.php/dav/files/<user>` root.
 *
 * No redirects across origins: the credential is a Basic header, and following a redirect to
 * another host would hand it over. A 3xx is reported as an error instead.
 */
import { createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { remoteJoin } from './cloud-core.ts'
import { countedBody } from './cloud-client.ts'
import type { CloudNode } from './cloud-changes.ts'

export type DavConfig = { base: string; user: string; pass: string }

export type DavEntry = {
  /** bare name, no slash */
  name: string
  /** absolute DAV path below the configured root */
  path: string
  dir: boolean
  size: number
  /** unix ms; 0 when the server sent nothing */
  mtime: number
  etag?: string
}

export type DavStat = { size: number; mtime: number; dir: boolean; etag?: string }

export class DavError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message || `WebDAV ${status}`)
    this.name = 'DavError'
    this.status = status
  }
}


const HTML_START = /^\s*<(!doctype|html|head|body|\?xml)/i

const htmlTitle = (body: string): string | null => {
  const m = /<title[^>]*>([^<]{1,160})<\/title>/i.exec(body)
  return m ? m[1].replace(/\s+/g, ' ').trim() : null
}

/**
 * A WebDAV path that points at a NAS's own web console answers with an HTML page instead of a
 * DAV response. Passing that markup to the dialog (it used to arrive as a screenful of
 * `<!DOCTYPE html …>`) told the user nothing, so every failure becomes one sentence that names the
 * real cause — the port is nearly always the mistake.
 */
export function davMessage(status: number, body: string, method = 'REQUEST'): string {
  const html = HTML_START.test(body)
  const title = html ? htmlTitle(body) : null
  if (status === 401) return 'the server rejected the user name or password (401)'
  if (status === 403) {
    return 'the server refused this operation (403); this WebDAV root is not writable, choose a shared folder the user may write to'
  }
  if (status === 404) return 'the folder does not exist on the server (404)'
  if (status === 405) return `${method} is not allowed here (405); this address does not look like a WebDAV folder`
  if (status === 409) return 'the parent folder does not exist yet (409)'
  if (status === 423) return 'the file is locked by another program (423)'
  if (status === 507) return 'the server is out of space (507)'
  if (html || status === 501) {
    return (
      `this address answered with a web page, not WebDAV${title ? ` («${title}»)` : ''}. ` +
      'Check the port: a QNAP NAS serves WebDAV on 5000 (http) or 5001 (https), not on the 8080 ' +
      'console; Nextcloud is usually https://<host>/remote.php/dav.'
    )
  }
  const detail = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
  return detail || `${method} failed (${status})`
}

/** `fetch` collapses every transport problem into «fetch failed»; the cause code is the useful part. */
export function networkMessage(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } }
  const code = err?.cause?.code ?? ''
  const text = `${err?.message ?? ''} ${err?.cause?.message ?? ''}`
  if (/DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF|CERT_/i.test(`${code} ${text}`)) {
    return 'the server certificate is not trusted; use http on the local network, or import the NAS certificate first'
  }
  if (code === 'ECONNREFUSED') return 'nothing is listening at that address; check the host and the port'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the host name could not be resolved'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'the server is not reachable from this machine'
  if (code === 'ETIMEDOUT' || /timeout/i.test(text)) return 'the connection timed out'
  if (/abort/i.test(text)) return 'the connection timed out'
  return err?.cause?.message ?? err?.message ?? String(e)
}

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>'
const PROPFIND_BODY = `${XML_HEAD}<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>`

const tagText = (block: string, name: string): string | null => {
  const rx = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i')
  const m = rx.exec(block)
  return m ? m[1] : null
}

const unescapeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')

const decodeHref = (href: string): string => {
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

/** Remove a trailing slash but keep the root as `/`. */
const noSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p)

/**
 * Parse a `207 Multi-Status`. `basePath` is the (decoded) path that was asked for, so every child
 * is named relative to it and a server that ignores `Depth: 1` cannot smuggle in unrelated rows.
 */
const responseBlocks = (xml: string): string[] =>
  xml.match(/<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/gi) ?? []

/** The one `<response>` of a `Depth: 0` request, whether or not the server echoes the href. */
export function parseStat(xml: string): DavStat | null {
  const block = responseBlocks(xml)[0] ?? xml
  const dir = /<(?:[\w-]+:)?collection\s*\/?>/i.test(tagText(block, 'resourcetype') ?? '')
  const lenRaw = tagText(block, 'getcontentlength')
  const whenRaw = tagText(block, 'getlastmodified')
  const etag = tagText(block, 'getetag')
  if (!dir && lenRaw === null && whenRaw === null) return null
  const len = Number(lenRaw ?? '')
  const when = Date.parse(whenRaw ?? '')
  return {
    size: Number.isFinite(len) && len > 0 ? len : 0,
    mtime: Number.isFinite(when) ? when : 0,
    dir,
    ...(etag ? { etag: unescapeXml(etag).replace(/^W\//, '').replace(/^"|"$/g, '') } : {})
  }
}

/**
 * Parse a `207 Multi-Status`. `basePath` is the (decoded) path that was asked for, so every child
 * is named relative to it and a server that ignores `Depth: 1` cannot smuggle in unrelated rows.
 * `prefix` is the pathname of the configured base URL: servers return hrefs from the server root,
 * so `/remote.php/dav/files/alice/x` has to become `/x` before it can be compared.
 */
export function parseMultistatus(
  xml: string,
  basePath: string,
  opts: { prefix?: string; origin?: string } = {}
): DavEntry[] {
  const base = noSlash(decodeHref(basePath))
  const prefix = (opts.prefix ?? '').replace(/\/+$/, '')
  const origin = opts.origin ?? 'https://dav.invalid'
  const relative = (pathname: string): string => {
    const p = noSlash(decodeHref(pathname))
    if (!prefix) return p
    if (p === prefix) return '/'
    if (!p.startsWith(prefix + '/')) return p
    return p.slice(prefix.length) || '/'
  }
  const out: DavEntry[] = []
  for (const block of responseBlocks(xml)) {
    const hrefRaw = tagText(block, 'href')
    if (!hrefRaw) continue
    let pathname: string
    try {
      pathname = new URL(unescapeXml(hrefRaw.trim()), origin).pathname
    } catch {
      continue
    }
    const href = relative(pathname)
    if (href === base) continue
    if (!href.startsWith(base === '/' ? '/' : base + '/')) continue
    const rest = href.slice(base === '/' ? 1 : base.length + 1)
    if (!rest || rest.includes('/')) continue
    const dir = /<(?:[\w-]+:)?collection\s*\/?>/i.test(tagText(block, 'resourcetype') ?? '')
    const len = Number(tagText(block, 'getcontentlength') ?? '')
    const when = Date.parse(tagText(block, 'getlastmodified') ?? '')
    const etag = tagText(block, 'getetag')
    out.push({
      name: rest,
      path: remoteJoin(base, rest),
      dir,
      size: Number.isFinite(len) && len >= 0 ? len : 0,
      mtime: Number.isFinite(when) ? when : 0,
      ...(etag ? { etag: unescapeXml(etag).replace(/^W\//, '').replace(/^"|"$/g, '') } : {})
    })
  }
  return out
}

/** Encode every segment but keep the slashes that carry the path. */
const encodePath = (p: string): string =>
  p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')

/**
 * WebDAV has no change feed, so the whole tree has to come from a single `Depth: infinity`
 * PROPFIND. Both limits matter: a NAS answers for seconds and some servers stream tens of
 * thousands of entries, and a partial tree must never seed an adoption pass.
 */
const FLATTEN_MAX_NODES = 5_000
const FLATTEN_BUDGET_MS = 60_000

/**
 * Parse a multi-status that may go several levels deep (`Depth: infinity`). Every `<response>`
 * below the requested folder becomes a node whose `rel` is its path from there. Rows outside the
 * requested subtree are ignored, so a server that answers with the whole share cannot smuggle in
 * unrelated files. WebDAV entries have no provider id; the relative path is the id.
 */
export function parseTree(
  xml: string,
  basePath: string,
  opts: { prefix?: string; origin?: string } = {}
): CloudNode[] {
  const base = noSlash(decodeHref(basePath))
  const prefix = (opts.prefix ?? '').replace(/\/+$/, '')
  const origin = opts.origin ?? 'https://dav.invalid'
  const relative = (pathname: string): string => {
    const p = noSlash(decodeHref(pathname))
    if (!prefix) return p
    if (p === prefix) return '/'
    if (!p.startsWith(prefix + '/')) return p
    return p.slice(prefix.length) || '/'
  }
  /** With a configured base URL, anything outside its path is not part of this account. */
  const withinPrefix = (pathname: string): boolean => {
    const p = noSlash(decodeHref(pathname))
    return !prefix || p === prefix || p.startsWith(prefix + '/')
  }
  const out: CloudNode[] = []
  for (const block of responseBlocks(xml)) {
    const hrefRaw = tagText(block, 'href')
    if (!hrefRaw) continue
    let pathname: string
    try {
      pathname = new URL(unescapeXml(hrefRaw.trim()), origin).pathname
    } catch {
      continue
    }
    if (!withinPrefix(pathname)) continue
    const href = relative(pathname)
    if (href === base) continue
    if (!href.startsWith(base === '/' ? '/' : base + '/')) continue
    const rel = href.slice(base === '/' ? 1 : base.length + 1)
    if (!rel) continue
    const dir = /<(?:[\w-]+:)?collection\s*\/?>/i.test(tagText(block, 'resourcetype') ?? '')
    const len = Number(tagText(block, 'getcontentlength') ?? '')
    const when = Date.parse(tagText(block, 'getlastmodified') ?? '')
    const etag = tagText(block, 'getetag')
    out.push({
      id: rel,
      rel,
      parentId: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : null,
      name: rel.slice(rel.lastIndexOf('/') + 1),
      dir,
      size: Number.isFinite(len) && len >= 0 ? len : 0,
      mtime: Number.isFinite(when) ? when : 0,
      ...(etag ? { etag: unescapeXml(etag).replace(/^W\//, '').replace(/^"|"$/g, '') } : {})
    })
  }
  return out
}

export type DavClient = ReturnType<typeof createDav>

export function createDav(config: DavConfig, impl: typeof fetch = fetch) {
  const base = config.base.replace(/\/+$/, '')
  let prefix = ''
  try {
    prefix = new URL(base).pathname.replace(/\/+$/, '')
  } catch {
    prefix = ''
  }
  // btoa is not available in main in every Electron build; Buffer always is
  const auth = 'Basic ' + Buffer.from(`${config.user}:${config.pass}`, 'utf8').toString('base64')

  const urlOf = (p: string): string => {
    const clean = p.startsWith('/') ? p : `/${p}`
    return base + encodePath(clean === '/' ? '' : clean)
  }

  const request = async (
    method: string,
    p: string,
    init: { headers?: Record<string, string>; body?: string; depth?: '0' | '1' | 'infinity'; timeoutMs?: number } = {}
  ): Promise<Response> => {
    const headers: Record<string, string> = { Authorization: auth, ...(init.headers ?? {}) }
    if (init.depth) headers.Depth = init.depth
    let res: Response
    try {
      const timeout = init.timeoutMs ?? 30_000
      res = await impl(urlOf(p), {
        method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        redirect: 'manual',
        ...(timeout > 0 ? { signal: AbortSignal.timeout(timeout) } : {})
      })
    } catch (e) {
      throw new DavError(0, networkMessage(e))
    }
    if (res.status >= 300 && res.status < 400) {
      throw new DavError(res.status, 'the server tried to redirect to another address')
    }
    if (!res.ok && res.status !== 207) {
      const detail = await res.text().catch(() => '')
      throw new DavError(res.status, davMessage(res.status, detail, method))
    }
    return res
  }

  const propfind = async (
    p: string,
    depth: '0' | '1' | 'infinity',
    timeoutMs?: number
  ): Promise<string> => {
    const res = await request('PROPFIND', p, {
      depth,
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
      ...(timeoutMs ? { timeoutMs } : {})
    })
    return res.text()
  }

  const client = {
    base,
    urlOf,

    async test(): Promise<{ ok: true; detail: string }> {
      const xml = await propfind('/', '0')
      const rows = parseMultistatus(xml, '/')
      return { ok: true, detail: rows.length ? 'WebDAV responded' : 'WebDAV root' }
    },

    async stat(p: string): Promise<DavStat | null> {
      try {
        const xml = await propfind(p, '0')
        return parseStat(xml)
      } catch (e) {
        if (e instanceof DavError && e.status === 404) return null
        throw e
      }
    },

    async list(p: string): Promise<DavEntry[]> {
      const xml = await propfind(p, '1')
      return parseMultistatus(xml, p, { prefix })
    },

    /**
     * The whole subtree in one PROPFIND. A server that rejects `Depth: infinity`, sends an empty
     * body or gets cut off by the budget yields `capped: true`: the adoption pass must not run on
     * a partial tree, because every missing node would look «local only» and be uploaded again.
     */
    async flatten(p: string): Promise<{ nodes: CloudNode[]; capped: boolean }> {
      const started = Date.now()
      let xml: string
      try {
        xml = await propfind(p, 'infinity', FLATTEN_BUDGET_MS)
      } catch {
        // 4xx/5xx, a timeout or a server that refuses Depth: infinity all mean «no full list»
        return { nodes: [], capped: true }
      }
      if (Date.now() - started > FLATTEN_BUDGET_MS) return { nodes: [], capped: true }
      // an empty body is not «an empty folder»: a 207 always carries at least the folder itself
      if (!xml.trim() || !/<(?:[\w-]+:)?multistatus\b/i.test(xml)) {
        return { nodes: [], capped: true }
      }
      const nodes = parseTree(xml, p, { prefix })
      return { nodes: nodes.slice(0, FLATTEN_MAX_NODES), capped: nodes.length > FLATTEN_MAX_NODES }
    },

    async mkdir(p: string): Promise<void> {
      try {
        await request('MKCOL', p)
      } catch (e) {
        // 405 means the collection already exists; anything else is a real failure
        if (e instanceof DavError && e.status === 405) return
        throw e
      }
    },

    async createFolder(parent: string, name: string): Promise<string> {
      const target = remoteJoin(parent, name)
      const existing = await client.stat(target)
      if (existing) {
        if (existing.dir) return target
        throw new DavError(409, 'a file with that name already exists')
      }
      await client.mkdir(target)
      return target
    },

    async remove(p: string): Promise<void> {
      try {
        await request('DELETE', p)
      } catch (e) {
        if (e instanceof DavError && e.status === 404) return
        throw e
      }
    },

    async download(p: string, dest: string, onBytes?: (n: number) => void): Promise<void> {
      const res = await request('GET', p, { timeoutMs: 0 })
      const body = res.body
      if (!body) throw new DavError(502, 'the server sent no body')
      await fs.mkdir(path.dirname(dest), { recursive: true }).catch(() => undefined)
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
        await new Promise<void>((r) => {
          out.end(() => r())
        })
      }
    },

    async upload(src: string, p: string, mtime = 0, onBytes?: (n: number) => void): Promise<void> {
      const st = await fs.stat(src)
      if (st.isDirectory()) throw new DavError(400, 'cannot upload a folder')
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(st.size)
      }
      // Nextcloud/ownCloud keep the source timestamp when it is offered; other servers ignore it.
      if (mtime > 0) headers['X-OC-Mtime'] = String(Math.floor(mtime / 1000))
      const body = countedBody(src, onBytes)
      const res = await impl(urlOf(p), {
        method: 'PUT',
        headers: { Authorization: auth, ...headers },
        body,
        // Node needs this for a streamed request body
        duplex: 'half',
        redirect: 'manual'
      } as RequestInit)
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new DavError(res.status, davMessage(res.status, detail, 'PUT'))
      }
    }
  }
  return client
}

/** `alice@host` for the account row; falls back to the provider label. */
export function davAccountLabel(url: string, user: string): string {
  try {
    return `${user}@${new URL(url).host}`
  } catch {
    return user
  }
}

/** The full DAV URL for a Nextcloud/ownCloud app password flow. */
export function nextcloudRoot(base: string, user: string): string {
  const clean = base.replace(/\/+$/, '')
  if (/\/remote\.php\/dav\/files\/[^/]+$/.test(clean)) return clean
  return `${clean}/remote.php/dav/files/${encodeURIComponent(user)}`
}
