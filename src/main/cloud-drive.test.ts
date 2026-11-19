import test from 'node:test'
import assert from 'node:assert/strict'
import { createDrive } from './cloud-drive.ts'

const fakeFetch = (
  responder: (url: URL) => unknown
): { impl: typeof fetch; calls: string[] } => {
  const calls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(raw)
    return new Response(JSON.stringify(responder(new URL(raw))), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }) as typeof fetch
  return { impl, calls }
}

test('startToken: asks the Drive startPageToken endpoint with the access token', async () => {
  const { impl, calls } = fakeFetch(() => ({ startPageToken: 'tok-1' }))
  const drive = createDrive('access-1', impl)
  assert.equal(await drive.startToken!(), 'tok-1')
  const url = new URL(calls[0])
  assert.equal(url.origin, 'https://www.googleapis.com')
  assert.equal(url.pathname, '/drive/v3/changes/startPageToken')
})

test('changes: parameters, paging until newStartPageToken, native files and removals', async () => {
  let call = 0
  const { impl, calls } = fakeFetch(() => {
    call++
    if (call === 1) {
      return {
        nextPageToken: 'page-2',
        changes: [
          {
            removed: false,
            fileId: 'folder-1',
            file: {
              id: 'folder-1',
              name: 'Folder',
              mimeType: 'application/vnd.google-apps.folder',
              modifiedTime: '2024-01-01T00:00:00.000Z',
              parents: ['root']
            }
          },
          { removed: true, fileId: 'gone-1' }
        ]
      }
    }
    return {
      newStartPageToken: 'start-2',
      changes: [
        {
          removed: false,
          fileId: 'doc-1',
          file: {
            id: 'doc-1',
            name: 'Notes',
            mimeType: 'application/vnd.google-apps.document',
            size: '1234',
            modifiedTime: '2024-01-02T00:00:00.000Z',
            md5Checksum: 'md5-1',
            parents: ['folder-1']
          }
        }
      ]
    }
  })
  const drive = createDrive('access-2', impl)
  const page = await drive.changes!('start-1')

  assert.equal(calls.length, 2)
  const first = new URL(calls[0])
  assert.equal(first.pathname, '/drive/v3/changes')
  assert.equal(first.searchParams.get('pageToken'), 'start-1')
  assert.equal(first.searchParams.get('pageSize'), '1000')
  assert.equal(first.searchParams.get('includeRemoved'), 'true')
  const fields = first.searchParams.get('fields') ?? ''
  assert.ok(fields.includes('md5Checksum'))
  assert.ok(fields.includes('newStartPageToken'))
  assert.ok(fields.includes('trashed'))
  assert.equal(new URL(calls[1]).searchParams.get('pageToken'), 'page-2')

  assert.equal(page.changes.length, 3)
  assert.equal(page.nextToken, 'start-2')
  assert.equal(page.newStartToken, 'start-2')

  const folder = page.changes.find((c) => c.id === 'folder-1')
  assert.equal(folder?.dir, true)
  assert.equal(folder?.parentId, 'root')

  const removed = page.changes.find((c) => c.id === 'gone-1')
  assert.equal(removed?.removed, true)

  const doc = page.changes.find((c) => c.id === 'doc-1')
  assert.equal(doc?.size, 0)
  assert.equal(doc?.dir, false)
  assert.equal(doc?.etag, 'md5-1')
  assert.equal(doc?.parentId, 'folder-1')
  assert.equal(doc?.mtime, Date.parse('2024-01-02T00:00:00.000Z'))
})

test('flatten: one paginated query, parents rebuild the paths, outside nodes are dropped', async () => {
  let call = 0
  const { impl, calls } = fakeFetch(() => {
    call++
    if (call === 1) {
      return {
        nextPageToken: 'page-2',
        files: [
          {
            id: 'docs',
            name: 'Docs',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['root']
          },
          {
            id: 'a',
            name: 'a.txt',
            mimeType: 'text/plain',
            size: '3',
            modifiedTime: '2024-01-01T00:00:00.000Z',
            md5Checksum: 'md5-a',
            parents: ['docs']
          },
          {
            id: 'outside',
            name: 'outside.txt',
            mimeType: 'text/plain',
            size: '9',
            parents: ['other-root']
          }
        ]
      }
    }
    return {
      files: [
        {
          id: 'sub',
          name: 'Sub',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['docs']
        },
        {
          id: 'b',
          name: 'b.txt',
          mimeType: 'text/plain',
          size: '5',
          parents: ['docs']
        },
        {
          id: 'c',
          name: 'c.txt',
          mimeType: 'text/plain',
          size: '7',
          parents: ['sub']
        },
        {
          id: 'empty',
          name: 'Empty',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['root']
        }
      ]
    }
  })
  const drive = createDrive('access-flat', impl)
  const { nodes, capped } = await drive.flatten!('/')
  assert.equal(capped, false)

  assert.equal(calls.length, 2)
  const first = new URL(calls[0])
  assert.equal(first.pathname, '/drive/v3/files')
  assert.equal(first.searchParams.get('q'), 'trashed = false')
  assert.equal(first.searchParams.get('pageSize'), '1000')
  const fields = first.searchParams.get('fields') ?? ''
  assert.ok(fields.includes('nextPageToken'))
  assert.ok(fields.includes('parents'))
  assert.ok(fields.includes('md5Checksum'))
  assert.equal(new URL(calls[1]).searchParams.get('pageToken'), 'page-2')

  const byRel = new Map(nodes.map((n) => [n.rel, n]))
  assert.deepEqual([...byRel.keys()].sort(), ['Docs', 'Docs/Sub', 'Docs/Sub/c.txt', 'Docs/a.txt', 'Docs/b.txt', 'Empty'])
  assert.equal(byRel.has('outside.txt'), false)
  assert.equal(byRel.get('Docs/a.txt')?.parentId, 'docs')
  assert.equal(byRel.get('Docs/a.txt')?.size, 3)
  assert.equal(byRel.get('Docs/a.txt')?.etag, 'md5-a')
  assert.equal(byRel.get('Docs/a.txt')?.mtime, Date.parse('2024-01-01T00:00:00.000Z'))
  assert.equal(byRel.get('Docs/Sub/c.txt')?.dir, false)
  // the same nodes must feed `treeNodes`, which is what the incremental change feed persists
  const seen = drive.treeNodes('/')
  assert.equal(seen.length, 6)
  assert.deepEqual(seen.map((n) => n.rel).sort(), [...byRel.keys()].sort())
})

test('flatten: a missing root is an empty subtree and stops before the account query', async () => {
  const { impl, calls } = fakeFetch(() => ({ files: [] }))
  const drive = createDrive('access-flat-2', impl)
  assert.deepEqual(await drive.flatten!('/Missing'), { nodes: [], capped: false })
  assert.equal(calls.length, 1)
  assert.match(new URL(calls[0]).searchParams.get('q') ?? '', /name = 'Missing'/)
})

test('flatten: a paging overflow reports capped instead of a silently short tree', async () => {
  const { impl, calls } = fakeFetch(() => ({ files: [], nextPageToken: 'again' }))
  const drive = createDrive('access-flat-3', impl)
  const out = await drive.flatten!('/')
  assert.equal(out.capped, true)
  assert.deepEqual(out.nodes, [])
  assert.ok(calls.length > 1000)
})

