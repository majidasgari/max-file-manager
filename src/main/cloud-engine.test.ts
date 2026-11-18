/**
 * A real WebDAV stub on 127.0.0.1 and a real sync run over it: the point is that `cloudOps` is
 * enough for the untouched `compareTrees`/`applyPlan` to copy in both directions, create nested
 * folders and delete. No Electron, no network beyond loopback.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDav } from './cloud-dav.ts'
import { cloudOps } from './cloud-engine.ts'
import { applyPlan, compareTrees, createOps } from './sync-engine.ts'
import { planRows } from './sync-core.ts'
import { cleanCloudBinding, cloudPath } from '../shared/cloud.ts'
import type { CloudHashRow } from './sync-store.ts'

const USER = 'alice'
const PASS = 'secret'

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const hrefOf = (rel: string, dir: boolean): string => {
  const enc = rel
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `/dav/${enc}${dir ? '/' : ''}`
}

function responseFor(rel: string, st: { dir: boolean; size: number; mtime: Date }, etag: string): string {
  return `<d:response><d:href>${hrefOf(rel, st.dir)}</d:href><d:propstat><d:prop><d:resourcetype>${st.dir ? '<d:collection/>' : ''}</d:resourcetype>${st.dir ? '' : `<d:getcontentlength>${st.size}</d:getcontentlength>`}<d:getlastmodified>${st.mtime.toUTCString()}</d:getlastmodified><d:getetag>"${etag}"</d:getetag></d:prop></d:propstat></d:response>`
}

/** A deliberately small WebDAV server: PROPFIND/MKCOL/PUT/GET/DELETE over one folder. */
async function startDav(root: string): Promise<{ base: string; server: Server }> {
  const server = createServer(async (req: IncomingMessage, res) => {
    const auth = req.headers.authorization ?? ''
    if (auth !== 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64')) {
      res.statusCode = 401
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const rel = decodeURIComponent(url.pathname).replace(/^\/dav\/?/, '')
    const target = path.resolve(root, rel)
    if (target !== path.resolve(root) && !target.startsWith(path.resolve(root) + path.sep)) {
      res.statusCode = 403
      res.end()
      return
    }
    const method = req.method ?? 'GET'
    try {
      if (method === 'PROPFIND') {
        const st = await fs.stat(target)
        const depth = String(req.headers.depth ?? '0')
        const etag = `${Math.round(st.mtimeMs)}-${st.size}`
        let body = responseFor(rel, { dir: st.isDirectory(), size: st.size, mtime: st.mtime }, etag)
        if (depth === '1' && st.isDirectory()) {
          for (const name of await fs.readdir(target)) {
            const child = path.join(target, name)
            const cst = await fs.stat(child)
            const crel = rel ? `${rel}/${name}` : name
            body += responseFor(
              crel,
              { dir: cst.isDirectory(), size: cst.size, mtime: cst.mtime },
              `${Math.round(cst.mtimeMs)}-${cst.size}`
            )
          }
        }
        res.statusCode = 207
        res.setHeader('Content-Type', 'application/xml; charset=utf-8')
        res.end(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`)
        return
      }
      if (method === 'MKCOL') {
        await fs.mkdir(target)
        res.statusCode = 201
        res.end()
        return
      }
      if (method === 'PUT') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, Buffer.concat(chunks))
        res.statusCode = 201
        res.end()
        return
      }
      if (method === 'GET') {
        const st = await fs.stat(target)
        res.setHeader('Content-Length', String(st.size))
        createReadStream(target).pipe(res)
        return
      }
      if (method === 'DELETE') {
        await fs.rm(target, { recursive: true, force: true })
        res.statusCode = 204
        res.end()
        return
      }
      res.statusCode = 405
      res.end()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      res.statusCode = code === 'ENOENT' ? 404 : 500
      res.end(code ?? 'error')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { base: `http://127.0.0.1:${port}/dav`, server }
}

test('a cloud binding syncs both ways through the existing engine', async () => {
  const local = await fs.mkdtemp(path.join(os.tmpdir(), 'mfm-cloud-local-'))
  const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mfm-cloud-remote-'))
  const { base, server } = await startDav(remoteRoot)
  try {
    await fs.writeFile(path.join(local, 'a.txt'), 'hello')
    await fs.mkdir(path.join(local, 'sub'))
    await fs.writeFile(path.join(local, 'sub', 'b b.txt'), 'world')

    const dav = createDav({ base, user: USER, pass: PASS })
    const binding = cleanCloudBinding({
      id: 'cloud-test01',
      accountId: 'cloud-acct01',
      name: 'test',
      localPath: local,
      remoteId: '/',
      remoteLabel: '/',
      direction: 'both',
      compareBy: 'hash',
      deleteExtra: true,
      intervalMs: 15 * 60_000,
      enabled: true,
      paused: false,
      createdAt: 1
    })
    assert.ok(binding)
    const root = cloudPath(binding.id)
    const ops = createOps(undefined, cloudOps(binding, dav))

    // local → cloud (a nested folder has to be created with MKCOL first)
    const first = await compareTrees(local, root, ops, { compareBy: 'hash' })
    assert.equal(first.rows.filter((r) => r.state === 'leftOnly').length, 2)
    const plan1 = planRows(first.rows, 'ltr')
    const applied1 = await applyPlan(local, root, plan1, ops, {
      trash: (p) => fs.rm(p, { force: true })
    })
    assert.equal(applied1.copied, 2, applied1.errors.join('; '))
    assert.equal(await fs.readFile(path.join(remoteRoot, 'a.txt'), 'utf8'), 'hello')
    assert.equal(await fs.readFile(path.join(remoteRoot, 'sub', 'b b.txt'), 'utf8'), 'world')

    // nothing left to do
    const again = await compareTrees(local, root, ops, { compareBy: 'hash' })
    assert.deepEqual(
      again.rows.map((r) => r.state),
      ['same', 'same']
    )

    // cloud → local: a file that exists only on the server is pulled (right-to-left)
    const fromCloud = path.join(remoteRoot, 'from cloud.txt')
    await fs.writeFile(fromCloud, 'remote side')
    const rtl = await compareTrees(local, root, ops, { compareBy: 'hash' })
    const plan2 = planRows(rtl.rows, 'rtl')
    const applied2 = await applyPlan(local, root, plan2, ops, { trash: (p) => fs.rm(p, { force: true }) })
    assert.equal(applied2.copied, 1, applied2.errors.join('; '))
    assert.equal(await fs.readFile(path.join(local, 'from cloud.txt'), 'utf8'), 'remote side')

    // a local delete propagates to the cloud only because deleteExtra is on
    await fs.rm(path.join(local, 'a.txt'))
    const third = await compareTrees(local, root, ops, { compareBy: 'hash' })
    const plan3 = planRows(third.rows, 'ltr', { deleteExtra: true })
    assert.equal(plan3.remove.length, 1)
    const applied3 = await applyPlan(local, root, plan3, ops, { trash: (p) => fs.rm(p, { force: true }) })
    assert.equal(applied3.removed, 1, applied3.errors.join('; '))
    await assert.rejects(fs.stat(path.join(remoteRoot, 'a.txt')))
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    await fs.rm(local, { recursive: true, force: true })
    await fs.rm(remoteRoot, { recursive: true, force: true })
  }
})

test('the DAV client refuses a redirect instead of leaking Basic auth', async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 302
    res.setHeader('Location', 'http://example.invalid/steal')
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    const dav = createDav({ base: `http://127.0.0.1:${port}/dav`, user: 'u', pass: 'p' })
    await assert.rejects(dav.test(), /redirect/i)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('a remembered hash costs one download, not one per run', async () => {
  const local = await fs.mkdtemp(path.join(os.tmpdir(), 'mfm-hash-local-'))
  const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mfm-hash-remote-'))
  const { base, server } = await startDav(remoteRoot)
  let gets = 0
  server.on('request', (req) => {
    if (req.method === 'GET') gets++
  })
  try {
    await fs.writeFile(path.join(local, 'a.txt'), 'same bytes on both sides')
    const dav = createDav({ base, user: USER, pass: PASS })
    const binding = cleanCloudBinding({
      id: 'cloud-hash01',
      accountId: 'cloud-acct01',
      name: 'hash',
      localPath: local,
      remoteId: '/',
      remoteLabel: '/',
      direction: 'both',
      compareBy: 'hash',
      deleteExtra: false,
      intervalMs: 15 * 60_000,
      enabled: true,
      paused: false,
      createdAt: 1
    })
    assert.ok(binding)
    const hashes = new Map<string, CloudHashRow>()
    const root = cloudPath(binding.id)
    const ops = createOps(undefined, cloudOps(binding, dav, os.tmpdir(), hashes))

    // upload so both sides exist, then hash the pair: the remote side is read once
    const first = await compareTrees(local, root, ops, { compareBy: 'hash' })
    await applyPlan(local, root, planRows(first.rows, 'ltr'), ops, {
      trash: (p) => fs.rm(p, { force: true })
    })
    assert.equal(hashes.size, 0, 'an upload does not fill the cache by itself')

    const before = gets
    const second = await compareTrees(local, root, ops, { compareBy: 'hash' })
    assert.deepEqual(second.rows.map((r) => r.state), ['same'])
    assert.equal(gets - before, 1, 'the first comparison of both sides downloads once')
    assert.equal(hashes.get('a.txt')?.hash.length, 64)
    const etag = hashes.get('a.txt')?.etag
    assert.ok(etag)

    // the ETag did not move, so the remembered hash is reused and nothing is downloaded
    const beforeThird = gets
    const third = await compareTrees(local, root, ops, { compareBy: 'hash' })
    assert.deepEqual(third.rows.map((r) => r.state), ['same'])
    assert.equal(gets - beforeThird, 0, 'an unchanged file is not downloaded again')

    // a changed file has a new ETag, so it is read again and the cache follows it
    await fs.writeFile(path.join(remoteRoot, 'a.txt'), 'now the cloud copy changed!')
    const beforeFourth = gets
    const fourth = await compareTrees(local, root, ops, { compareBy: 'hash' })
    assert.equal(fourth.rows[0].state, 'sizeDiff')
    assert.equal(gets - beforeFourth, 1)
    assert.notEqual(hashes.get('a.txt')?.etag, etag)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    await fs.rm(local, { recursive: true, force: true })
    await fs.rm(remoteRoot, { recursive: true, force: true })
  }
})
