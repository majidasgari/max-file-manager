import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveMdAsset, rewriteImageSources } from './md-asset.ts'

test('a relative image resolves against the markdown folder', () => {
  assert.equal(resolveMdAsset('docs/a.png', '/repo'), 'mfm://local/repo/docs/a.png')
  assert.equal(resolveMdAsset('./a.png', '/repo'), 'mfm://local/repo/a.png')
  assert.equal(resolveMdAsset('../a.png', '/repo/sub'), 'mfm://local/repo/a.png')
  assert.equal(resolveMdAsset('a b.png', '/repo'), 'mfm://local/repo/a%20b.png')
})

test('an absolute local path becomes an mfm URL', () => {
  assert.equal(resolveMdAsset('/abs/a.png'), 'mfm://local/abs/a.png')
})

test('URLs, schemes and anchors are left exactly as written', () => {
  assert.equal(resolveMdAsset('https://x/a.png', '/repo'), 'https://x/a.png')
  assert.equal(resolveMdAsset('data:image/png;base64,AAA', '/repo'), 'data:image/png;base64,AAA')
  assert.equal(resolveMdAsset('mfm://local/repo/a.png', '/repo'), 'mfm://local/repo/a.png')
  assert.equal(resolveMdAsset('#anchor', '/repo'), '#anchor')
})

test('without a base folder nothing is rewritten', () => {
  assert.equal(resolveMdAsset('docs/a.png'), 'docs/a.png')
  assert.equal(rewriteImageSources('<img src="a.png">'), '<img src="a.png">')
})

test('only image sources are rewritten, links and code are untouched', () => {
  const html = '<a href="docs/a.png">x</a> <code>docs/a.png</code> <img alt="x" src="docs/a.png">'
  const out = rewriteImageSources(html, '/repo')
  assert.match(out, /href="docs\/a\.png"/)
  assert.match(out, /<code>docs\/a\.png<\/code>/)
  assert.match(out, /src="mfm:\/\/local\/repo\/docs\/a\.png"/)
})

test('a javascript: source is not turned into a local path', () => {
  // DOMPurify drops it later; this only proves the rewrite cannot make it look safe
  const out = rewriteImageSources('<img src="javascript:alert(1)">', '/repo')
  assert.match(out, /javascript:alert\(1\)/)
  assert.doesNotMatch(out, /mfm:/)
})
