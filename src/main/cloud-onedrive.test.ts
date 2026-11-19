import test from 'node:test'
import assert from 'node:assert/strict'
import { createOneDrive } from './cloud-onedrive.ts'

type Call = { url: string; path: string; method: string; body: unknown; headers: Record<string, string> }

const fakeFetch = (
  responder: (call: Call) => unknown
): { impl: typeof fetch; calls: Call[] } => {
  const calls: Call[] = []
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const call: Call = {
      url: raw,
      path: new URL(raw).pathname,
      method: init.method ?? 'GET',
      body: init.body,
      headers: (init.headers ?? {}) as Record<string, string>
    }
    calls.push(call)
    const out = responder(call)
    if (out instanceof Response) return out
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  return { impl, calls }
}

const GRAPH = 'https://graph.microsoft.com/v1.0/me/drive'
const DELTA_LINK = `${GRAPH}/root:/Max:/delta?$deltatoken=done`
const NEXT_LINK = `${GRAPH}/root:/Max:/delta?$skiptoken=two`

const folderItem = (id: string, name: string, parent: string) => ({
  id,
  name,
  folder: { childCount: 0 },
  parentReference: { id: parent }
})

const fileItem = (id: string, name: string, parent: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  size: 0,
  file: {},
  parentReference: { id: parent },
  ...extra
})

test('flatten: follows nextLink to the deltaLink, rebuilds paths and skips deletions/outsiders', async () => {
  const { impl, calls } = fakeFetch((call) => {
    if (call.path === '/v1.0/me/drive/root:/Max') {
      return { id: 'root-1', name: 'Max', folder: { childCount: 2 } }
    }
    if (call.path.endsWith('/root:/Max:/delta') && !new URL(call.url).search) {
      return {
        value: [
          folderItem('docs', 'Docs', 'root-1'),
          fileItem('a', 'a.txt', 'docs', {
            size: 5,
            lastModifiedDateTime: '2024-01-01T00:00:00Z',
            file: { hashes: { quickXorHash: 'qx-a' } }
          }),
          { id: 'gone', name: 'gone.txt', deleted: { state: 'deleted' }, parentReference: { id: 'root-1' } }
        ],
        '@odata.nextLink': NEXT_LINK
      }
    }
    return {
      value: [
        folderItem('sub', 'Sub', 'docs'),
        fileItem('b', 'b.txt', 'sub', { size: 7, eTag: 'etag-b' }),
        fileItem('out', 'outside.txt', 'other-root', { size: 1 })
      ],
      '@odata.deltaLink': DELTA_LINK
    }
  })
  const drive = createOneDrive('access-flat', impl)
  const { nodes, capped } = await drive.flatten!('/Max')

  assert.equal(capped, false)
  assert.equal(calls.length, 3)
  assert.match(calls[0].path, /\/root:\/Max$/)
  assert.match(calls[1].url, /\/root:\/Max:\/delta$/)
  assert.equal(calls[1].headers.Authorization, 'Bearer access-flat')
  assert.equal(calls[2].url, NEXT_LINK)

  const byRel = new Map(nodes.map((n) => [n.rel, n]))
  assert.deepEqual([...byRel.keys()].sort(), ['Docs', 'Docs/Sub', 'Docs/Sub/b.txt', 'Docs/a.txt'])
  assert.equal(byRel.has('gone.txt'), false)
  assert.equal(byRel.has('outside.txt'), false)

  assert.equal(byRel.get('Docs')?.dir, true)
  assert.equal(byRel.get('Docs')?.parentId, 'root-1')
  assert.equal(byRel.get('Docs/a.txt')?.size, 5)
  assert.equal(byRel.get('Docs/a.txt')?.etag, 'qx-a')
  assert.equal(byRel.get('Docs/a.txt')?.mtime, Date.parse('2024-01-01T00:00:00Z'))
  assert.equal(byRel.get('Docs/Sub')?.parentId, 'docs')
  assert.equal(byRel.get('Docs/Sub/b.txt')?.etag, 'etag-b')
})

test('startToken: reuses the delta link of the flatten that seeded the tree', async () => {
  const { impl, calls } = fakeFetch((call) => {
    if (call.path === '/v1.0/me/drive/root:/Max') return { id: 'root-1', name: 'Max' }
    return { value: [], '@odata.deltaLink': DELTA_LINK }
  })
  const drive = createOneDrive('access-token', impl)
  await drive.flatten!('/Max')
  const before = calls.length
  const token = await drive.startToken!()
  assert.equal(token, DELTA_LINK)
  // no second enumeration: the link came from the flatten call
  assert.equal(calls.length, before)
})

test('changes: both pages, a deletion becomes removed, the delta link is the next cursor', async () => {
  const START = `${GRAPH}/root:/Max:/delta?$deltatoken=start`
  const { impl, calls } = fakeFetch((call) => {
    if (call.url === START) {
      return {
        value: [
          fileItem('a', 'a.txt', 'docs', {
            size: 9,
            lastModifiedDateTime: '2024-01-02T00:00:00Z',
            file: { hashes: { quickXorHash: 'qx-9' } }
          }),
          { id: 'gone', deleted: { state: 'deleted' } }
        ],
        '@odata.nextLink': NEXT_LINK
      }
    }
    return {
      value: [folderItem('new', 'New', 'docs')],
      '@odata.deltaLink': `${GRAPH}/root:/Max:/delta?$deltatoken=next`
    }
  })
  const drive = createOneDrive('access-changes', impl)
  const page = await drive.changes!(START)

  assert.equal(calls.length, 2)
  assert.equal(page.changes.length, 3)
  assert.match(page.nextToken, /deltatoken=next/)
  assert.match(page.nextToken, /^https:\/\/graph\.microsoft\.com\//)

  const changed = page.changes.find((c) => c.id === 'a')
  assert.equal(changed?.removed, false)
  assert.equal(changed?.name, 'a.txt')
  assert.equal(changed?.parentId, 'docs')
  assert.equal(changed?.size, 9)
  assert.equal(changed?.etag, 'qx-9')
  assert.equal(changed?.mtime, Date.parse('2024-01-02T00:00:00Z'))

  const removed = page.changes.find((c) => c.id === 'gone')
  assert.equal(removed?.removed, true)
  assert.equal(removed?.parentId, null)

  assert.equal(page.changes.find((c) => c.id === 'new')?.dir, true)
})

test('changes: a cursor pointing outside Graph is refused instead of leaking the token', async () => {
  const { impl, calls } = fakeFetch(() => ({ value: [] }))
  const drive = createOneDrive('access-unsafe', impl)
  await assert.rejects(() => drive.changes!('https://evil.example/v1.0/me/drive/root/delta'))
  assert.equal(calls.length, 0)
})

test('flatten: a paging overflow reports capped instead of a silently short tree', async () => {
  const { impl } = fakeFetch((call) => {
    if (call.path === '/v1.0/me/drive/root:/Max') return { id: 'root-1', name: 'Max' }
    return { value: [], '@odata.nextLink': `${GRAPH}/root:/Max:/delta?$skiptoken=again` }
  })
  const drive = createOneDrive('access-capped', impl)
  const out = await drive.flatten!('/Max')
  assert.equal(out.capped, true)
  assert.deepEqual(out.nodes, [])
})
