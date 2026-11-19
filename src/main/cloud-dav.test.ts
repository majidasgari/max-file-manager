import test from 'node:test'
import assert from 'node:assert/strict'
import { createDav, davMessage, networkMessage, parseMultistatus, parseStat, parseTree } from './cloud-dav.ts'

const XML = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/Max/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Mon, 10 Nov 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/Max/a%20b.txt</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12</d:getcontentlength><d:getlastmodified>Mon, 10 Nov 2026 10:01:00 GMT</d:getlastmodified><d:getetag>&quot;abc123&quot;</d:getetag></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/Max/Sub/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/Max/Sub/deep.txt</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1</d:getcontentlength></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/Other.txt</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1</d:getcontentlength></d:prop></d:propstat>
  </d:response>
</d:multistatus>`

test('multistatus is parsed relative to the requested folder', () => {
  const rows = parseMultistatus(XML, '/remote.php/dav/files/alice/Max')
  // the folder itself is not a child, a deeper path and a sibling are not children either
  assert.deepEqual(
    rows.map((r) => r.name),
    ['a b.txt', 'Sub']
  )
  const file = rows[0]
  assert.equal(file.dir, false)
  assert.equal(file.size, 12)
  assert.equal(file.etag, 'abc123')
  assert.equal(file.path, '/remote.php/dav/files/alice/Max/a b.txt')
  assert.equal(Date.parse('Mon, 10 Nov 2026 10:01:00 GMT'), file.mtime)
  assert.equal(rows[1].dir, true)
})

test('an absolute href and a namespaced element still resolve', () => {
  const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>https://cloud.example/dav/x/F.txt</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>`
  const rows = parseMultistatus(xml, '/dav/x')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'F.txt')
})

test('a depth 0 response gives the resource itself', () => {
  const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a/b/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`
  const st = parseStat(xml)
  assert.ok(st)
  assert.equal(st.dir, true)
  assert.equal(st.size, 0)
})

test('a response without any prop is not a resource', () => {
  assert.equal(parseStat('<d:multistatus xmlns:d="DAV:"/>'), null)
})

test('the NAS web console is reported as a wrong port, never as raw markup', () => {
  const html =
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN">\n<html><head><title>QTS</title></head><body>…</body></html>'
  const msg = davMessage(501, html, 'PROPFIND')
  assert.match(msg, /not WebDAV/)
  assert.match(msg, /5000/)
  assert.doesNotMatch(msg, /DOCTYPE|<html>/)
})

test('an auth failure and an unwritable root say what to do', () => {
  assert.match(davMessage(401, ''), /user name or password/)
  assert.match(davMessage(403, '<html></html>'), /not writable/)
  assert.match(davMessage(404, ''), /does not exist/)
  assert.match(davMessage(500, 'disk on fire'), /disk on fire/)
})

test('transport failures translate the cause code instead of «fetch failed»', () => {
  assert.match(networkMessage({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }), /port/)
  assert.match(networkMessage({ message: 'fetch failed', cause: { code: 'ENOTFOUND' } }), /resolved/)
  assert.match(
    networkMessage({ message: 'fetch failed', cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }),
    /certificate/
  )
  assert.match(networkMessage({ message: 'AbortError: aborted' }), /timed out/)
})

const DEEP_XML = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/Max/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/Max/a.txt</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>5</d:getcontentlength><d:getlastmodified>Mon, 10 Nov 2026 10:01:00 GMT</d:getlastmodified><d:getetag>&quot;e-a&quot;</d:getetag></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/Max/Sub/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/Max/Sub/b.txt</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>7</d:getcontentlength></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/Other/outside.txt</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1</d:getcontentlength></d:prop></d:propstat>
  </d:response>
</d:multistatus>`

const davFetch = (
  respond: (init: RequestInit) => Response
): { impl: typeof fetch; seen: { method: string; depth: string; body: unknown }[] } => {
  const seen: { method: string; depth: string; body: unknown }[] = []
  const impl = (async (_input: string | URL | Request, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    seen.push({ method: String(init.method), depth: headers.Depth, body: init.body })
    return respond(init)
  }) as typeof fetch
  return { impl, seen }
}

test('flatten: one Depth infinity PROPFIND lists every level, rebased below the root', async () => {
  const { impl, seen } = davFetch(
    () =>
      new Response(DEEP_XML, {
        status: 207,
        headers: { 'content-type': 'application/xml; charset=utf-8' }
      })
  )
  const dav = createDav({ base: 'https://nas.local/dav/Max', user: 'u', pass: 'p' }, impl)
  const { nodes, capped } = await dav.flatten('/')

  assert.equal(capped, false)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'PROPFIND')
  assert.equal(seen[0].depth, 'infinity')

  const byRel = new Map(nodes.map((n) => [n.rel, n]))
  assert.deepEqual([...byRel.keys()].sort(), ['Sub', 'Sub/b.txt', 'a.txt'])
  assert.equal(byRel.has('outside.txt'), false)
  assert.equal(byRel.get('a.txt')?.size, 5)
  assert.equal(byRel.get('a.txt')?.etag, 'e-a')
  assert.equal(byRel.get('a.txt')?.mtime, Date.parse('Mon, 10 Nov 2026 10:01:00 GMT'))
  assert.equal(byRel.get('Sub')?.dir, true)
  assert.equal(byRel.get('Sub/b.txt')?.parentId, 'Sub')
  assert.equal(byRel.get('a.txt')?.parentId, null)
})

test('flatten: a server that refuses Depth infinity is capped, never a short tree', async () => {
  const { impl, seen } = davFetch(() => new Response('forbidden', { status: 403 }))
  const dav = createDav({ base: 'https://nas.local/dav/Max', user: 'u', pass: 'p' }, impl)
  const out = await dav.flatten('/')
  assert.equal(out.capped, true)
  assert.deepEqual(out.nodes, [])
  assert.equal(seen[0].depth, 'infinity')
})

test('parseTree: only responses below the requested folder become nodes', () => {
  const nodes = parseTree(DEEP_XML, '/dav/Max')
  assert.deepEqual(nodes.map((n) => n.rel).sort(), ['Sub', 'Sub/b.txt', 'a.txt'])
})
