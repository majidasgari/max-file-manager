import test from 'node:test'
import assert from 'node:assert/strict'
import { createDropbox } from './cloud-dropbox.ts'

type Call = { url: string; body: unknown; headers: Record<string, string> }

const fakeFetch = (
  responder: (call: Call) => unknown
): { impl: typeof fetch; calls: Call[] } => {
  const calls: Call[] = []
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    const call = { url: raw, body, headers: (init.headers ?? {}) as Record<string, string> }
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

const file = (name: string, path: string, extra: Record<string, unknown> = {}) => ({
  '.tag': 'file',
  name,
  path_display: path,
  size: 0,
  ...extra
})

const folder = (name: string, path: string) => ({
  '.tag': 'folder',
  name,
  path_display: path
})

test('flatten: one recursive listing, two pages, paths rebased below the binding root', async () => {
  // base '/Max' and a sibling '/Other' prove that `rel` is not the account-wide path
  const { impl, calls } = fakeFetch((call) => {
    if (call.url.endsWith('/files/list_folder')) {
      return {
        cursor: 'c1',
        has_more: true,
        entries: [
          folder('Docs', '/Max/Docs'),
          file('a.txt', '/Max/a.txt', {
            size: 5,
            server_modified: '2024-01-01T00:00:00.000Z',
            content_hash: 'hash-a'
          }),
          folder('Outside', '/Other/Outside')
        ]
      }
    }
    return {
      cursor: 'c2',
      has_more: false,
      entries: [
        folder('Sub', '/Max/Docs/Sub'),
        file('b.txt', '/Max/Docs/Sub/b.txt', {
          size: 7,
          server_modified: '2024-01-02T00:00:00.000Z',
          rev: 'rev-b'
        }),
        { '.tag': 'deleted', name: 'gone.txt', path_display: '/Max/gone.txt' }
      ]
    }
  })
  const dropbox = createDropbox('access-flat', impl)
  const { nodes, capped } = await dropbox.flatten!('/Max')

  assert.equal(capped, false)
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[0].url).pathname, '/2/files/list_folder')
  assert.deepEqual(calls[0].body, {
    path: '/Max',
    recursive: true,
    limit: 2000,
    include_deleted: false
  })
  assert.equal(calls[0].headers.Authorization, 'Bearer access-flat')
  assert.equal(new URL(calls[1].url).pathname, '/2/files/list_folder/continue')
  assert.deepEqual(calls[1].body, { cursor: 'c1' })

  const byRel = new Map(nodes.map((n) => [n.rel, n]))
  assert.deepEqual(
    [...byRel.keys()].sort(),
    ['Docs', 'Docs/Sub', 'Docs/Sub/b.txt', 'a.txt']
  )
  assert.equal(byRel.has('Outside'), false)
  assert.equal(byRel.has('gone.txt'), false)

  assert.equal(byRel.get('Docs')?.dir, true)
  assert.equal(byRel.get('Docs')?.id, '/Max/Docs')
  assert.equal(byRel.get('Docs')?.parentId, '/Max')
  assert.equal(byRel.get('Docs')?.name, 'Docs')
  assert.equal(byRel.get('Docs/Sub')?.parentId, '/Max/Docs')
  assert.equal(byRel.get('a.txt')?.size, 5)
  assert.equal(byRel.get('a.txt')?.mtime, Date.parse('2024-01-01T00:00:00.000Z'))
  assert.equal(byRel.get('a.txt')?.etag, 'hash-a')
  assert.equal(byRel.get('Docs/Sub/b.txt')?.etag, 'rev-b')
})

test('flatten: the root binding strips only the leading slash', async () => {
  const { impl } = fakeFetch(() => ({
    cursor: 'c',
    has_more: false,
    entries: [file('a.txt', '/a.txt'), folder('Docs', '/Docs')]
  }))
  const dropbox = createDropbox('access-root', impl)
  const { nodes } = await dropbox.flatten!('/')
  assert.deepEqual(nodes.map((n) => n.rel).sort(), ['Docs', 'a.txt'])
  assert.equal(nodes.find((n) => n.rel === 'a.txt')?.parentId, '/')
})

test('startToken: a recursive root listing with limit 1 returns its cursor', async () => {
  const { impl, calls } = fakeFetch(() => ({ entries: [], cursor: 'cur-start', has_more: false }))
  const dropbox = createDropbox('access-token', impl)
  assert.equal(await dropbox.startToken!(), 'cur-start')
  assert.deepEqual(calls[0].body, {
    path: '',
    recursive: true,
    limit: 1,
    include_deleted: false
  })
})

test('changes: continue pages until has_more is false, deleted entries become removals', async () => {
  const { impl, calls } = fakeFetch((call) => {
    const cursor = (call.body as { cursor: string }).cursor
    if (cursor === 'tok-1') {
      return {
        cursor: 'tok-2',
        has_more: true,
        entries: [
          file('a.txt', '/Max/a.txt', {
            size: 9,
            server_modified: '2024-01-03T00:00:00.000Z',
            content_hash: 'hash-9'
          }),
          { '.tag': 'deleted', name: 'b.txt', path_display: '/Max/b.txt' }
        ]
      }
    }
    return { cursor: 'tok-3', has_more: false, entries: [folder('New', '/Max/New')] }
  })
  const dropbox = createDropbox('access-changes', impl)
  const page = await dropbox.changes!('tok-1')

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].body, { cursor: 'tok-1' })
  assert.deepEqual(calls[1].body, { cursor: 'tok-2' })
  assert.equal(page.nextToken, 'tok-3')
  assert.equal(page.changes.length, 3)

  const changed = page.changes.find((c) => c.id === '/Max/a.txt')
  assert.equal(changed?.removed, false)
  assert.equal(changed?.name, 'a.txt')
  assert.equal(changed?.parentId, '/Max')
  assert.equal(changed?.size, 9)
  assert.equal(changed?.mtime, Date.parse('2024-01-03T00:00:00.000Z'))
  assert.equal(changed?.etag, 'hash-9')

  const removed = page.changes.find((c) => c.id === '/Max/b.txt')
  assert.equal(removed?.removed, true)
  assert.equal(removed?.parentId, null)

  const added = page.changes.find((c) => c.id === '/Max/New')
  assert.equal(added?.dir, true)
  assert.equal(added?.parentId, '/Max')
})

test('flatten: a paging overflow reports capped instead of a silently short tree', async () => {
  const { impl, calls } = fakeFetch(() => ({ entries: [], cursor: 'again', has_more: true }))
  const dropbox = createDropbox('access-capped', impl)
  const out = await dropbox.flatten!('/Max')
  assert.equal(out.capped, true)
  assert.deepEqual(out.nodes, [])
  assert.ok(calls.length > 1000)
})
