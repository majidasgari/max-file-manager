import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_FONT_FAMILY, DEFAULT_TOOLBAR, DEFAULTS, cleanFontFamily, fontStack, mergePrefs, migrateLegacy } from './prefs.ts'
import { DEFAULT_SHORTCUTS } from './commands.ts'

test('mergePrefs fills defaults and rejects nonsense', () => {
  const p = mergePrefs({ theme: 'neon' as any, layout: 'triple' as any, foldersFirst: undefined })
  assert.equal(p.theme, 'dark')
  assert.equal(p.layout, 'dual')
  assert.equal(p.dualSplit, 0.5)
  assert.equal(p.foldersFirst, true)
  assert.equal(p.titlebar, 'app')
  assert.deepEqual(p.iconDirs, [])
})

test('mergePrefs keeps real values and coerces booleans', () => {
  const p = mergePrefs({ theme: 'light', layout: 'single', sidebar: 'float', rounded: false, dualSplit: 0.65 })
  assert.equal(p.theme, 'light')
  assert.equal(p.layout, 'single')
  assert.equal(p.sidebar, 'float')
  assert.equal(p.rounded, false)
  assert.equal(p.dualSplit, 0.65)
  assert.equal(p.sidebarWidth, 208)
  assert.equal(p.confirmDelete, DEFAULTS.confirmDelete)
  assert.equal(mergePrefs({ dualSplit: 0.95 }).dualSplit, 0.8)
  assert.equal(mergePrefs({ dualSplit: 0.05 }).dualSplit, 0.2)
  assert.equal(mergePrefs({ sidebarWidth: 100 }).sidebarWidth, 160)
  assert.equal(mergePrefs({ sidebarWidth: 800 }).sidebarWidth, 600)
  assert.equal(mergePrefs({ sidebarWidth: 320 }).sidebarWidth, 320)
  assert.equal(p.sidebarTone, 1)
  assert.equal(mergePrefs({ sidebarTone: 2 }).sidebarTone, 2)
  assert.equal(mergePrefs({ sidebarTone: 5 }).sidebarTone, 5)
  assert.equal(mergePrefs({ sidebarTone: 6 }).sidebarTone, 6)
  assert.equal(mergePrefs({ sidebarTone: 0 as any }).sidebarTone, 1)
  assert.equal(mergePrefs({ sidebarTone: 7 as any }).sidebarTone, 1)
  assert.deepEqual(p.sidebarCollapsed, [])
  assert.deepEqual(mergePrefs({ sidebarCollapsed: ['places', 'labels'] }).sidebarCollapsed, ['places', 'labels'])
  assert.deepEqual(mergePrefs({ sidebarCollapsed: 'invalid' as any }).sidebarCollapsed, [])
  assert.equal(p.showSymlink, false)
  assert.equal(mergePrefs({ showSymlink: true }).showSymlink, true)
  assert.equal(mergePrefs({ showSymlink: 'yes' as any }).showSymlink, false)
})

test('language: English is the default, Persian survives, nonsense falls back', () => {
  assert.equal(mergePrefs({}).lang, 'en')
  assert.equal(mergePrefs({ lang: 'fa' }).lang, 'fa')
  assert.equal(mergePrefs({ lang: 'de' as never }).lang, 'en')
})

test('file icons: bundled Pure by default, old “theme” becomes the OS theme', () => {
  assert.equal(mergePrefs({}).fileIcons, 'pure')
  assert.equal(mergePrefs({ fileIcons: 'pure' }).fileIcons, 'pure')
  assert.equal(mergePrefs({ fileIcons: 'system' }).fileIcons, 'system')
  assert.equal(mergePrefs({ fileIcons: 'line' }).fileIcons, 'line')
  assert.equal(mergePrefs({ fileIcons: 'theme' as never }).fileIcons, 'system')
  assert.equal(mergePrefs({ fileIcons: 'neon' as never }).fileIcons, 'pure')
})

test('colour theme: default survives, known ids keep, unknown falls back', () => {
  assert.equal(mergePrefs({}).colorTheme, 'default')
  assert.equal(mergePrefs({ colorTheme: 'wine' }).colorTheme, 'wine')
  assert.equal(mergePrefs({ colorTheme: 'neon' as never }).colorTheme, 'default')
})

test('caption buttons: known themes and sides keep, nonsense falls back', () => {
  assert.equal(mergePrefs({}).titlebarButtons, 'default')
  assert.equal(mergePrefs({}).titlebarSide, 'right')
  assert.equal(mergePrefs({ titlebarButtons: 'mcmojave' }).titlebarButtons, 'mcmojave')
  assert.equal(mergePrefs({ titlebarButtons: 'windows' }).titlebarButtons, 'windows')
  assert.equal(mergePrefs({ titlebarButtons: 'minimal' }).titlebarButtons, 'minimal')
  assert.equal(mergePrefs({ titlebarButtons: 'aqua' as never }).titlebarButtons, 'default')
  assert.equal(mergePrefs({ titlebarSide: 'left' }).titlebarSide, 'left')
  assert.equal(mergePrefs({ titlebarSide: 'top' as never }).titlebarSide, 'right')
})

test('mergePrefs drops non-string icon dirs', () => {
  const p = mergePrefs({ iconDirs: ['/icons', 42 as any, ''] })
  assert.deepEqual(p.iconDirs, ['/icons'])
})

test('migrateLegacy folds the old top-level keys into prefs', () => {
  const p = migrateLegacy({
    theme: 'light',
    view: 'grid',
    hidden: true,
    chrome: { customTitlebar: false, rounded: false },
    ui: { sidebar: 'float', sidebarOpen: false, iconDirs: ['/p'], iconTheme: 'breeze' }
  })
  assert.deepEqual(p, {
    theme: 'light',
    view: 'grid',
    showHidden: true,
    titlebar: 'system',
    rounded: false,
    sidebar: 'float',
    sidebarOpen: false,
    iconDirs: ['/p'],
    iconTheme: 'breeze'
  })
})

test('named layouts, filters and file-type colours survive only in valid form', () => {
  const p = mergePrefs({
    layouts: {
      good: { layout: 'single', view: 'grid', columns: ['size', 'bogus'], sidebar: 'float' },
      bad: 'nope'
    } as never,
    filters: { تصاویر: '*.jpg', empty: '   ' } as never,
    fileTypes: { PDF: '#4f8ff0', '.txt': '#4fb56a', bad: 'red', evil: '#zzzzzz' } as never
  })
  assert.deepEqual(Object.keys(p.layouts), ['good'])
  assert.deepEqual(p.layouts.good.columns, ['size'], 'unknown columns are dropped')
  assert.equal(p.layouts.good.layout, 'single')
  assert.deepEqual(Object.keys(p.filters), ['تصاویر'])
  assert.deepEqual(p.fileTypes, { pdf: '#4f8ff0', txt: '#4fb56a' })
})

test('fontFamily: empty by default, trimmed, and never breaks the declaration', () => {
  assert.equal(mergePrefs({}).fontFamily, '')
  assert.equal(mergePrefs({ fontFamily: '  Inter  ' }).fontFamily, 'Inter')
  assert.equal(mergePrefs({ fontFamily: 42 as never }).fontFamily, '')
  assert.equal(cleanFontFamily('Inter; color: red'), 'Inter color: red')
  assert.equal(cleanFontFamily('x{}()<>\\/y'), 'xy')
  assert.ok(cleanFontFamily('a'.repeat(300)).length <= 120)
})

test('fontStack keeps a full stack and gives a single family a Persian fallback', () => {
  assert.equal(fontStack(''), DEFAULT_FONT_FAMILY)
  assert.match(fontStack('Inter'), /^Inter, Vazirmatn/)
  assert.equal(fontStack('Inter, sans-serif'), 'Inter, sans-serif')
})

test('tab colours: only absolute paths and real hex colours survive', () => {
  assert.deepEqual(mergePrefs({}).tabColors, {})
  const p = mergePrefs({
    tabColors: {
      '/home/max/Downloads': '#4f8ff0',
      'C:\\Users\\max': '#e0564d',
      relative: '#4fb56a',
      '/home/max/Documents': 'not-a-colour'
    } as never
  })
  assert.deepEqual(p.tabColors, { '/home/max/Downloads': '#4f8ff0', 'C:\\Users\\max': '#e0564d' })
})

test('global search moves to Ctrl+K once, then a deliberate old binding is kept', () => {
  const old = { shortcuts: { ...DEFAULT_SHORTCUTS, searchIndex: 'Ctrl+Shift+K' } }
  assert.equal(mergePrefs(old).shortcuts.searchIndex, 'Ctrl+K')
  assert.equal(mergePrefs({ ...old, prefsVersion: 2 }).shortcuts.searchIndex, 'Ctrl+Shift+K')
})

test('customCommands: valid entries keep, invalid/empty entries rejected', () => {
  assert.deepEqual(mergePrefs({}).customCommands, [])
  const p = mergePrefs({
    customCommands: [
      { id: 'c1', label: 'Open in Code', pattern: 'py, js', command: 'code %f' },
      { id: 'c2', label: 'Open in Terminal', pattern: 'folder', command: 'kitty --directory %f' },
      { id: 'bad1', label: '', pattern: 'pdf', command: 'evince %f' },
      { id: 'bad2', label: 'Bad Command', pattern: '', command: 'test' },
      'not-an-object' as any
    ]
  })
  assert.equal(p.customCommands.length, 2)
  assert.equal(p.customCommands[0].label, 'Open in Code')
  assert.equal(p.customCommands[0].pattern, 'py, js')
  assert.equal(p.customCommands[0].command, 'code %f')
  assert.equal(p.customCommands[1].pattern, 'folder')
})

test('tree pane: side, width and auto-focus survive only in valid form', () => {
  const left = mergePrefs({ treePane: 'left', treeWidth: 300, treeAutoFocus: false })
  assert.equal(left.treePane, 'left')
  assert.equal(left.treeWidth, 300)
  assert.equal(left.treeAutoFocus, false)
  assert.equal(mergePrefs({ treePane: 'right' }).treePane, 'right')
  assert.equal(mergePrefs({ treePane: 'top' as never }).treePane, 'off')
  assert.equal(mergePrefs({ treeWidth: 5 }).treeWidth, 160)
  assert.equal(mergePrefs({ treeWidth: 9999 }).treeWidth, 520)
  assert.equal(mergePrefs({}).treeAutoFocus, true)
})

test('gallery info sidebar: on by default and a chosen state survives', () => {
  assert.equal(mergePrefs({}).galleryInfo, true)
  assert.equal(mergePrefs({ galleryInfo: false }).galleryInfo, false)
  assert.equal(mergePrefs({ galleryInfo: 'nonsense' as never }).galleryInfo, true)
})

test('ignore list: defaults hide metadata files and junk entries are dropped', () => {
  assert.deepEqual(mergePrefs({}).ignoreFiles, ['.directory', 'desktop.ini'])
  assert.deepEqual(mergePrefs({ ignoreFiles: ['  .DS_Store ', '', 'x/y', 42 as never] }).ignoreFiles, [
    '.DS_Store'
  ])
  assert.deepEqual(mergePrefs({ ignoreFiles: [] }).ignoreFiles, [])
  assert.deepEqual(
    mergePrefs({ ignoreFiles: ['.directory', '.DIRECTORY'] }).ignoreFiles,
    ['.directory']
  )
})
