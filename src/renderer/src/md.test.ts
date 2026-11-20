import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'

// DOMPurify binds to `window` when its module is evaluated, and md.ts imports it. The test
// therefore installs a DOM first and only then imports the module under test.
const dom = parseHTML('<!doctype html><html><body></body></html>')
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  DOMParser: dom.window.DOMParser
})

const { renderMarkdown, resolveMdAsset } = await import('./md.ts')

test('resolveMdAsset: relative paths resolve against the markdown folder', () => {
  assert.equal(resolveMdAsset('docs/a.png', '/repo'), 'mfm://local/repo/docs/a.png')
  assert.equal(resolveMdAsset('./a.png', '/repo'), 'mfm://local/repo/a.png')
  assert.equal(resolveMdAsset('../a.png', '/repo/sub'), 'mfm://local/repo/a.png')
})

test('resolveMdAsset: absolute local paths become mfm', () => {
  assert.equal(resolveMdAsset('/abs/a.png'), 'mfm://local/abs/a.png')
})

test('resolveMdAsset: URLs, schemes and anchors are untouched', () => {
  assert.equal(resolveMdAsset('https://x/a.png', '/repo'), 'https://x/a.png')
  assert.equal(resolveMdAsset('data:image/png;base64,AAA', '/repo'), 'data:image/png;base64,AAA')
  assert.equal(resolveMdAsset('mfm://local/repo/a.png', '/repo'), 'mfm://local/repo/a.png')
  assert.equal(resolveMdAsset('#anchor', '/repo'), '#anchor')
})

test('resolveMdAsset: without a base folder a relative src stays as written', () => {
  assert.equal(resolveMdAsset('docs/a.png'), 'docs/a.png')
})

test('renderMarkdown resolves images and keeps them through DOMPurify', () => {
  const html = renderMarkdown('![x](a.png)', '/repo')
  assert.match(html, /<img\b/)
  assert.match(html, /src="mfm:\/\/local\/repo\/a\.png"/)
  // DOMPurify is really active: a javascript: image source is stripped
  const unsafe = renderMarkdown('![x](javascript:alert(1))', '/repo')
  assert.doesNotMatch(unsafe, /javascript:/)
})

test('renderMarkdown without a base folder keeps the previous behaviour', () => {
  const html = renderMarkdown('![x](a.png)')
  assert.match(html, /src="a\.png"/)
  assert.doesNotMatch(html, /mfm:\/\//)
})

test('renderMarkdown only rewrites image src: links and prose stay put', () => {
  const html = renderMarkdown('[docs](docs/a.png) and `docs/a.png`\n\n![x](docs/a.png)', '/repo')
  assert.match(html, /href="docs\/a\.png"/)
  assert.match(html, /<code[^>]*>docs\/a\.png<\/code>/)
  assert.match(html, /src="mfm:\/\/local\/repo\/docs\/a\.png"/)
})
