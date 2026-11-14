import assert from 'node:assert/strict'
import { setLang } from './i18n.ts'
import test from 'node:test'
import {thumbUrl, baseName, crumbs, dirOf, groupEntries, isIgnoredName, fa, fileUri, fmtDate, fmtSize, groupLabel, joinPath, kindOf, matchCustomCommand, mediaUrl, menuTargets, modeString, navIndex, openAction, opensInEditor, orderEntries, permLevel, permMode, planRename, reorderItem, sortEntries, terminalDir, toJalali, typeLabel, downloadUrl} from './format.ts'

type Entry = {
  name: string
  path: string
  dir: boolean
  size: number
  mtime: number
  ext: string
  mode?: number
  uid?: number
  nlink?: number
  w?: number
  h?: number
}

const e = (name: string, dir: boolean, size = 0, mtime = 0, ext = ''): Entry => ({
  name,
  path: '/' + name,
  dir,
  size,
  mtime,
  ext
})

test('fa: Persian digits', () => {
  setLang('fa')
  assert.equal(fa(2026), '۲۰۲۶')
  assert.equal(fa('a1b2'), 'a۱b۲')
})

test('fmtSize in Persian', () => {
  setLang('fa')
  assert.equal(fmtSize(0, false), '۰ بایت')
  assert.equal(fmtSize(999, false), '۹۹۹ بایت')
  assert.equal(fmtSize(1024, false), '۱٫۰ کیلوبایت')
  assert.equal(fmtSize(1536, false), '۱٫۵ کیلوبایت')
  assert.equal(fmtSize(1048576, false), '۱٫۰ مگابایت')
  assert.equal(fmtSize(12345678, false), '۱۲ مگابایت')
  assert.equal(fmtSize(5000, true), '', 'folders report nothing unless computed')
})

test('fmtDate: padded and Persian', () => {
  setLang('fa')
  assert.equal(fmtDate(0), '')
  assert.match(fmtDate(Date.UTC(2026, 0, 2, 3, 4)), /^[۰-۹]{4}-[۰-۹]{2}-[۰-۹]{2} [۰-۹]{2}:[۰-۹]{2}$/)
})

test('the same helpers read as English when the language is English', () => {
  setLang('en')
  assert.equal(fa(2026), '2026')
  assert.equal(fmtSize(0, false), '0 B')
  assert.match(fmtDate(Date.UTC(2024, 2, 20, 9, 5), 'iso'), /^2024-03-20 \d{2}:\d{2}$/)
  setLang('fa')
})

test('crumbs: posix and windows', () => {
  assert.deepEqual(crumbs('/').map((c) => c.name), ['/'])
  assert.deepEqual(crumbs('/home/maxv').map((c) => c.path), ['/', '/home', '/home/maxv'])
  assert.deepEqual(crumbs('C:\\Users\\max').map((c) => c.path), ['C:\\', 'C:\\Users', 'C:\\Users\\max'])
  assert.deepEqual(crumbs('D:/a/b').map((c) => c.name), ['D:', 'a', 'b'])
})

test('baseName', () => {
  assert.equal(baseName('/home/maxv/'), 'maxv')
  assert.equal(baseName('C:\\x\\y.txt'), 'y.txt')
})

test('mediaUrl: encodable and windows-safe', () => {
  assert.equal(mediaUrl('/home/a b/c.png'), 'mfm://local/home/a%20b/c.png')
  assert.equal(mediaUrl('C:\\Users\\max\\x.png'), 'mfm://local/C:/Users/max/x.png')
})

test('kindOf and typeLabel', () => {
  setLang('fa')
  assert.equal(kindOf(e('d', true)), 'dir')
  assert.equal(kindOf(e('p.png', false, 1, 0, 'png')), 'image')
  assert.equal(kindOf(e('m.ts', false, 1, 0, 'ts')), 'code')
  assert.equal(kindOf(e('x.qqq', false, 1, 0, 'qqq')), 'file')
  assert.equal(typeLabel(e('d', true)), 'پوشه')
  assert.equal(typeLabel(e('p.png', false, 1, 0, 'png')), 'تصویر')
  assert.equal(typeLabel(e('x.qqq', false, 1, 0, 'qqq')), 'QQQ', 'unknown extensions show themselves')
  assert.equal(typeLabel(e('noext', false, 1, 0, '')), 'فایل')
})

test('sortEntries: folders first, then column', () => {
  const list = [e('b.txt', false, 10), e('a.txt', false, 30), e('zdir', true), e('file10', false, 5), e('file2', false, 5)]
  assert.deepEqual(
    sortEntries(list, 'name', true).map((x) => x.name),
    ['zdir', 'a.txt', 'b.txt', 'file2', 'file10']
  )
  assert.deepEqual(
    sortEntries(list, 'size', true).map((x) => x.name),
    ['zdir', 'file2', 'file10', 'b.txt', 'a.txt']
  )
  assert.equal(sortEntries(list, 'name', false)[0].name, 'zdir', 'folders stay first when descending')
})

test('orderEntries: live filter keeps the sort', () => {
  const list = [e('zdir', true), e('file10', false, 5), e('file2', false, 5), e('other', false, 9)]
  assert.deepEqual(
    orderEntries(list, 'name', true, 'file').map((x) => x.name),
    ['file2', 'file10']
  )
  assert.deepEqual(
    orderEntries(list, 'name', true, '  FILE  ').map((x) => x.name),
    ['file2', 'file10'],
    'filter is trimmed and case-insensitive'
  )
  assert.equal(orderEntries(list, 'name', true, '').length, 4)
  assert.equal(orderEntries(list, 'name', true, 'nothing').length, 0)
})

test('planRename: template numbering with padding', () => {
  const out = planRename(['a.txt', 'b.jpg', 'noext'], {
    mode: 'template',
    template: 'photo-{nn}',
    find: '',
    replace: '',
    start: 3,
    pad: 3
  })
  assert.deepEqual(out, ['photo-003.txt', 'photo-004.jpg', 'photo-005'])
})

test('planRename: {name} and {ext} tokens', () => {
  assert.deepEqual(
    planRename(['holiday.png'], {
      mode: 'template',
      template: '{name}-small.{ext}',
      find: '',
      replace: '',
      start: 1,
      pad: 2
    }),
    ['holiday-small.png']
  )
})

test('planRename: regex groups, and an invalid pattern renames nothing', () => {
  assert.deepEqual(
    planRename(['IMG_1234.jpg'], {
      mode: 'regex',
      template: '',
      find: 'IMG_(\\d+)',
      replace: 'photo-$1',
      start: 1,
      pad: 2
    }),
    ['photo-1234.jpg']
  )
  assert.deepEqual(
    planRename(['a.txt'], { mode: 'regex', template: '', find: '(', replace: 'x', start: 1, pad: 2 }),
    ['a.txt']
  )
})

test('dirOf / joinPath keep the platform separator', () => {
  assert.equal(dirOf('/home/maxv/a.txt'), '/home/maxv')
  assert.equal(dirOf('/a'), '/')
  assert.equal(dirOf('C:\\x\\y.txt'), 'C:\\x')
  assert.equal(joinPath('/a/b', 'c.txt'), '/a/b/c.txt')
  assert.equal(joinPath('/a/b/', 'c.txt'), '/a/b/c.txt')
  assert.equal(joinPath('C:\\a', 'c.txt'), 'C:\\a\\c.txt')
})

test('groupLabel prefers the duplicate group number', () => {
  setLang('fa')
  assert.equal(groupLabel({ ...e('x.txt', false, 1, 0, 'txt'), group: 2 }), 'گروه ۲')
  assert.equal(groupLabel(e('d', true)), 'پوشه')
})

test('sortEntries: foldersFirst=false mixes folders into the order', () => {
  const list = [e('zdir', true), e('a.txt', false), e('bfile', false)]
  assert.deepEqual(sortEntries(list, 'name', true, false).map((x) => x.name), ['a.txt', 'bfile', 'zdir'])
  assert.deepEqual(sortEntries(list, 'name', true).map((x) => x.name), ['zdir', 'a.txt', 'bfile'])
})

test('toJalali: Nowruz 1403 is 2024-03-20', () => {
  assert.deepEqual(toJalali(Date.UTC(2024, 2, 20, 12)), [1403, 1, 1])
  assert.deepEqual(toJalali(Date.UTC(2024, 2, 21, 12)), [1403, 1, 2])
})

test('fmtDate honours the format setting', () => {
  const t = Date.UTC(2024, 2, 20, 9, 5, 7)
  assert.match(fmtDate(t, 'jalali'), /^۱۴۰۳-۰۱-۰۱/)
  assert.match(fmtDate(t, 'short'), /^[۰-۹]{2}:[۰-۹]{2}$/)
  assert.match(fmtDate(t, 'short', true), /^[۰-۹]{2}:[۰-۹]{2}:[۰-۹]{2}$/)
})

test('fmtSize can print exact bytes', () => {
  assert.equal(fmtSize(1536, false, 'bytes'), '۱۵۳۶ بایت')
  assert.equal(fmtSize(1536, false), '۱٫۵ کیلوبایت')
})

test('modeString', () => {
  assert.equal(modeString(0o755), 'rwxr-xr-x')
  assert.equal(modeString(0o644), 'rw-r--r--')
  assert.equal(modeString(0o000), '---------')
})

test('the #token in the filter matches labels, not names', () => {
  const entries = [
    { name: 'a.txt', path: '/x/a.txt', dir: false, size: 1, mtime: 1, ext: 'txt' },
    { name: 'b.txt', path: '/x/b.txt', dir: false, size: 1, mtime: 1, ext: 'txt' },
    { name: 'c-red.txt', path: '/x/c-red.txt', dir: false, size: 1, mtime: 1, ext: 'txt' }
  ]
  const labels = { 'a.txt': 'red', 'b.txt': 'blue' }
  assert.deepEqual(
    orderEntries(entries, 'name', true, '#red', true, undefined, labels).map((e) => e.name),
    ['a.txt']
  )
  assert.deepEqual(
    orderEntries(entries, 'name', true, '#blu', true, undefined, labels).map((e) => e.name),
    ['b.txt'],
    'partial label ids match'
  )
  assert.deepEqual(
    orderEntries(entries, 'name', true, '#nothing', true, undefined, labels).map((e) => e.name),
    []
  )
  assert.equal(
    orderEntries(entries, 'name', true, 'red', true, undefined, labels).length,
    1,
    'without # it stays a name filter'
  )
})

test('navIndex: list steps one row, clamps at both ends', () => {
  assert.equal(navIndex(-1, 'down', 5), 0, 'nothing selected starts at the top')
  assert.equal(navIndex(0, 'up', 5), 0, 'up from the top stays put')
  assert.equal(navIndex(2, 'down', 5), 3)
  assert.equal(navIndex(4, 'down', 5), 4)
  assert.equal(navIndex(2, 'first', 5), 0)
  assert.equal(navIndex(2, 'last', 5), 4)
  assert.equal(navIndex(-1, 'last', 5), 4)
  assert.equal(navIndex(0, 'down', 0), -1, 'an empty list has no cursor')
})

test('navIndex: grid steps a whole row and a whole page', () => {
  // 10 columns, 3 visible rows: 30 items
  assert.equal(navIndex(2, 'down', 30, 10, 3), 12)
  assert.equal(navIndex(12, 'up', 30, 10, 3), 2)
  assert.equal(navIndex(2, 'right', 30, 10, 3), 3)
  assert.equal(navIndex(2, 'left', 30, 10, 3), 1)
  assert.equal(navIndex(2, 'pageDown', 30, 10, 3), 29, 'clamped to the last item')
  assert.equal(navIndex(22, 'pageUp', 30, 10, 3), 0, 'a page up from row 3 lands on the first row')
  assert.equal(navIndex(24, 'pageUp', 30, 10, 3), 0, 'clamped to the first item')
})

test('opensInEditor: text and extensionless files, never folders or binaries', () => {
  assert.equal(opensInEditor(e('notes.txt', false, 10, 0, 'txt')), true)
  assert.equal(opensInEditor(e('README', false, 10, 0, '')), true)
  assert.equal(opensInEditor(e('post.md', false, 10, 0, 'md')), true)
  assert.equal(opensInEditor(e('photo.png', false, 10, 0, 'png')), false)
  assert.equal(opensInEditor(e('archive.zip', false, 10, 0, 'zip')), false)
  assert.equal(opensInEditor(e('folder', true, 0, 0, '')), false)
})

test('permLevel: reads the three classes out of a mode', () => {
  assert.equal(permLevel(0o644, 0), 'rw')
  assert.equal(permLevel(0o644, 1), 'r')
  assert.equal(permLevel(0o644, 2), 'r')
  assert.equal(permLevel(0o600, 2), 'none')
  assert.equal(permLevel(0o777, 1), 'rw')
})

test('permMode: files keep their execute bit, folders follow read with x', () => {
  assert.equal(permMode(0o644, 2, 'rw', false), 0o646)
  assert.equal(permMode(0o644, 0, 'r', false), 0o444)
  assert.equal(permMode(0o755, 0, 'rw', false), 0o755, 'write does not clear x on a file')
  assert.equal(permMode(0o644, 1, 'rw', false), 0o664)
  assert.equal(permMode(0o755, 0, 'r', true), 0o555, 'a folder keeps x with read')
  assert.equal(permMode(0o755, 1, 'rw', true), 0o775)
  assert.equal(permMode(0o755, 2, 'none', true), 0o750)
})

test('menuTargets: the clicked row wins unless it is part of the selection', () => {
  assert.deepEqual(menuTargets(['/a', '/b'], '/a'), ['/a', '/b'])
  assert.deepEqual(menuTargets(['/a', '/b'], '/c'), ['/c'])
  assert.deepEqual(menuTargets(['/a'], null), ['/a'])
})

test('fileUri: external drags get a real file URL, spaces and non-Latin names encoded', () => {
  assert.equal(fileUri('/home/max/My File.mp3'), 'file:///home/max/My%20File.mp3')
  assert.equal(fileUri('/home/max/آهنگ.mp3'), 'file:///home/max/%D8%A2%D9%87%D9%86%DA%AF.mp3')
  assert.equal(fileUri('C:\\Users\\max\\a b.txt'), 'file:///C:/Users/max/a%20b.txt')
})

test('sortEntries: optional columns (mode, owner, links, dims, rating) sort too', () => {
  const mk = (name: string, extra: Partial<Entry>): Entry => ({
    name,
    path: '/' + name,
    dir: false,
    size: 0,
    mtime: 0,
    ext: '',
    ...extra
  })
  const list = [
    mk('a', { mode: 0o644, uid: 1000, nlink: 1, w: 10, h: 10 }),
    mk('b', { mode: 0o755, uid: 0, nlink: 3, w: 100, h: 50 }),
    mk('c', { mode: 0o600, uid: 1001, nlink: 2, w: 20, h: 20 })
  ]
  assert.deepEqual(sortEntries(list, 'mode', true, false).map((e) => e.name), ['c', 'a', 'b'])
  assert.deepEqual(sortEntries(list, 'owner', true, false).map((e) => e.name), ['b', 'a', 'c'])
  assert.deepEqual(sortEntries(list, 'links', false, false).map((e) => e.name), ['b', 'c', 'a'])
  assert.deepEqual(sortEntries(list, 'dims', true, false).map((e) => e.name), ['a', 'c', 'b'])
  const ratings = { a: 1, b: 5, c: 3 }
  assert.deepEqual(sortEntries(list, 'rating', false, false, ratings).map((e) => e.name), ['b', 'c', 'a'])
})

test('orderEntries: size keeps folders first, date interleaves them', () => {
  const list = [
    e('zdir', true, 7),
    e('a.txt', false, 30),
    e('b.txt', false, 5),
    e('c.txt', false, 10)
  ]
  assert.deepEqual(
    orderEntries(list, 'size', true).map((x) => x.name),
    ['zdir', 'b.txt', 'c.txt', 'a.txt']
  )
  assert.deepEqual(
    orderEntries(list, 'name', true).map((x) => x.name),
    ['zdir', 'a.txt', 'b.txt', 'c.txt']
  )
  const dated = [
    { ...e('zdir', true, 7), mtime: 3 },
    { ...e('a.txt', false, 30), mtime: 1 },
    { ...e('b.txt', false, 5), mtime: 2 }
  ]
  assert.deepEqual(
    orderEntries(dated, 'mtime', true).map((x) => x.name),
    ['a.txt', 'b.txt', 'zdir']
  )
})

test('downloadUrl hands browser drop zones a real file payload', () => {
  assert.equal(
    downloadUrl('/tmp/a b.txt'),
    'application/octet-stream:a b.txt:file:///tmp/a%20b.txt'
  )
  // a colon in the name would split the three-part payload
  assert.equal(
    downloadUrl('/tmp/a:b.txt'),
    'application/octet-stream:a_b.txt:file:///tmp/a%3Ab.txt'
  )
})

test('reorderItem: shifts elements correctly before and after', () => {
  const items = ['a', 'b', 'c', 'd']
  // Move 0 ('a') to before 2 ('c') -> ['b', 'a', 'c', 'd']
  assert.deepEqual(reorderItem(items, 0, 2, 'before'), ['b', 'a', 'c', 'd'])
  // Move 0 ('a') to after 2 ('c') -> ['b', 'c', 'a', 'd']
  assert.deepEqual(reorderItem(items, 0, 2, 'after'), ['b', 'c', 'a', 'd'])
  // Move 3 ('d') to before 1 ('b') -> ['a', 'd', 'b', 'c']
  assert.deepEqual(reorderItem(items, 3, 1, 'before'), ['a', 'd', 'b', 'c'])
  // Move 3 ('d') to after 1 ('b') -> ['a', 'b', 'd', 'c']
  assert.deepEqual(reorderItem(items, 3, 1, 'after'), ['a', 'b', 'd', 'c'])
  // Move to same index or out of bounds returns unchanged
  assert.deepEqual(reorderItem(items, 1, 1, 'before'), items)
  assert.deepEqual(reorderItem(items, -1, 2, 'before'), items)
  assert.deepEqual(reorderItem(items, 0, 5, 'after'), items)
})

test('matchCustomCommand: matches file extensions and folder patterns accurately', () => {
  // Extension matching
  assert.equal(matchCustomCommand({ pattern: 'pdf' }, '/docs/invoice.pdf', false), true)
  assert.equal(matchCustomCommand({ pattern: '.pdf' }, '/docs/invoice.PDF', false), true)
  assert.equal(matchCustomCommand({ pattern: 'jpg, png, webp' }, '/img/photo.PNG', false), true)
  assert.equal(matchCustomCommand({ pattern: 'jpg, png, webp' }, '/img/photo.gif', false), false)
  // Folder matching
  assert.equal(matchCustomCommand({ pattern: 'folder' }, '/home/user/myfolder', true), true)
  assert.equal(matchCustomCommand({ pattern: 'dir' }, '/home/user/myfolder', true), true)
  assert.equal(matchCustomCommand({ pattern: 'directory' }, '/home/user/myfolder', true), true)
  assert.equal(matchCustomCommand({ pattern: 'پوشه' }, '/home/user/myfolder', true), true)
  assert.equal(matchCustomCommand({ pattern: 'folder' }, '/home/user/file.txt', false), false)
  assert.equal(matchCustomCommand({ pattern: 'txt' }, '/home/user/myfolder', true), false)
  // Wildcard matching
  assert.equal(matchCustomCommand({ pattern: '*' }, '/home/user/file.xyz', false), true)
  assert.equal(matchCustomCommand({ pattern: '*' }, '/home/user/myfolder', true), true)
})

test('openAction: the «Run» preference beats the HTML preview and the built-in editor', () => {
  // the regression: a document type stayed in the preview pane even with double-click = Run
  assert.equal(openAction(e('notes.md', false, 10, 0, 'md'), 'open'), 'external')
  assert.equal(openAction(e('page.html', false, 10, 0, 'html'), 'open'), 'external')
  assert.equal(openAction(e('app.php', false, 10, 0, 'php'), 'open'), 'external')
  // folders always navigate, archives always open the reader, a chosen app always wins
  assert.equal(openAction(e('src', true), 'open'), 'navigate')
  assert.equal(openAction(e('bundle.zip', false, 10, 0, 'zip'), 'open'), 'archive')
  assert.equal(openAction(e('photo.png', false, 10, 0, 'png'), 'open', { hasDefaultApp: true }), 'external')
  // the other modes keep their specialised behaviour
  assert.equal(openAction(e('notes.md', false, 10, 0, 'md'), 'preview'), 'preview')
  assert.equal(openAction(e('page.html', false, 10, 0, 'html'), 'gallery'), 'preview')
  assert.equal(openAction(e('photo.png', false, 10, 0, 'png'), 'gallery'), 'gallery')
  assert.equal(openAction(e('notes.md', false, 10, 0, 'md'), 'gallery'), 'editor')
  // a virtual listing (inside an archive) has nothing to read or preview
  assert.equal(openAction(e('notes.md', false, 10, 0, 'md'), 'preview', { virtual: true }), 'preview')
  assert.equal(openAction(e('notes.md', false, 10, 0, 'md'), 'gallery', { virtual: true }), 'external')
})

test('terminalDir: a folder is itself, a file is its folder, an archive means the real parent', () => {
  assert.equal(terminalDir('/home/me/projects', true, null, '/home/me'), '/home/me/projects')
  assert.equal(terminalDir('/home/me/projects/a.txt', false, null, '/home/me'), '/home/me/projects')
  // a flat/search hit can point outside the tab: its own folder wins
  assert.equal(terminalDir('/data/deep/x.log', false, null, '/home/me'), '/data/deep')
  // inside an archive the entry path is not a real directory
  assert.equal(terminalDir('/data/set.zip/inner/a.txt', false, '/data/set.zip', '/data/set.zip'), '/data')
  assert.equal(terminalDir(null, false, null, '/home/me'), '/home')
})


test('thumbUrl carries the file version so a replaced image is not served from cache', () => {
  const a = thumbUrl('/p/a.png', 256, '1000-42')
  assert.equal(a, 'thumb://local/p/a.png?s=256&v=1000-42')
  // a changed file (new mtime or size) gets a different URL
  assert.notEqual(a, thumbUrl('/p/a.png', 256, '1001-42'))
  assert.notEqual(a, thumbUrl('/p/a.png', 256, '1000-43'))
  // no version (properties dialog and older callers) keeps the plain form
  assert.equal(thumbUrl('/p/a b.png', 96), 'thumb://local/p/a%20b.png?s=96')
})

const G = (name: string, extra: Partial<Entry> = {}): Entry => ({
  name,
  path: '/tmp/' + name,
  dir: false,
  size: 0,
  mtime: 0,
  ext: (name.includes('.') ? name.split('.').pop()! : '').toLowerCase(),
  ...extra
})

test('groupEntries by name: A…Z alphabetical, digits and symbols in «#»', () => {
  const groups = groupEntries([G('beta.txt'), G('1file'), G('Alpha'), G('_x')], 'name')
  assert.deepEqual(groups.map((g) => g.label), ['#', 'A', 'B'])
  assert.deepEqual(groups[0].entries.map((e) => e.name), ['1file', '_x'])
})

test('groupEntries by type keeps folders first and uses the kind names', () => {
  const now = Date.now()
  const groups = groupEntries(
    [G('a.png'), G('b.txt'), G('dir', { dir: true, ext: '' }), G('c.jpg')],
    'type',
    now
  )
  assert.equal(groups[0].key, 'dir')
  const image = groups.find((g) => g.key === 'image')
  assert.deepEqual(image?.entries.map((e) => e.name), ['a.png', 'c.jpg'])
  assert.ok(groups.some((g) => g.key === 'text'))
})

test('groupEntries by date uses today → older buckets in order', () => {
  const now = new Date(2026, 4, 20, 12, 0, 0).getTime()
  const day = 86_400_000
  const groups = groupEntries(
    [
      G('today', { mtime: now }),
      G('yesterday', { mtime: now - day }),
      G('old', { mtime: now - 400 * day })
    ],
    'date',
    now
  )
  assert.deepEqual(groups.map((g) => g.key), ['today', 'yesterday', 'older'])
})

test('groupEntries by size puts folders aside and walks the size buckets', () => {
  const groups = groupEntries(
    [
      G('small', { size: 1000 }),
      G('big', { size: 5 * 1024 * 1024 }),
      G('folder', { dir: true, size: 0 }),
      G('huge', { size: 2 * 1024 * 1024 * 1024 })
    ],
    'size'
  )
  assert.deepEqual(groups.map((g) => g.key), ['folders', 'lt1', 'lt10', 'gte1024'])
})

test('groupEntries by extension upper-cases extensions and keeps folders first', () => {
  const groups = groupEntries([G('a.PNG'), G('b.txt'), G('f', { dir: true })], 'ext')
  assert.deepEqual(groups.map((g) => g.label), ['پوشه', 'PNG', 'TXT'])
})

test('groupEntries: none is one unnamed group and an empty listing has no groups', () => {
  assert.deepEqual(groupEntries([], 'name'), [])
  const one = groupEntries([G('a.txt')], 'none')
  assert.equal(one.length, 1)
  assert.equal(one[0].label, '')
})

test('isIgnoredName matches exact names case-insensitively and honours wildcards', () => {
  assert.equal(isIgnoredName('.directory', ['.directory', 'desktop.ini']), true)
  assert.equal(isIgnoredName('Desktop.ini', ['.directory', 'desktop.ini']), true)
  assert.equal(isIgnoredName('notes.txt', ['.directory', 'desktop.ini']), false)
  assert.equal(isIgnoredName('a.tmp', ['*.tmp']), true)
  assert.equal(isIgnoredName('a.tmp', ['?.tmp']), true)
  assert.equal(isIgnoredName('ab.tmp', ['?.tmp']), false)
  assert.equal(isIgnoredName('anything', []), false)
  assert.equal(isIgnoredName('', ['*']), false)
})
