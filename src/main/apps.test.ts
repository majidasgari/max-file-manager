import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  appHandles,
  execFor,
  isRunnableFile,
  macAppName,
  mimeForPath,
  parseDesktopEntry,
  parseMacAppPaths,
  parseMacOpenWith,
  parseAssocHandlers,
  parseWindowsOpenWith,
  runCommand,
  runFile,
  systemOpenCommand,
  winRunnableExt,
  windowsArgv,
  windowsFileManagerCommand
} from './apps.ts'

const ENTRY = `[Desktop Entry]
Type=Application
Name=Foo Viewer
Exec=/usr/bin/foo --open %F
Icon=foo
MimeType=application/pdf;image/png;
NoDisplay=false
`

test('desktop entries are parsed from the [Desktop Entry] group only', () => {
  const entry = parseDesktopEntry(
    '[Desktop Action new]\nName=New\nExec=/bin/x\n[Desktop Entry]\nType=Application\nName=Real\nExec=/bin/real %f\n'
  )
  assert.equal(entry['Name'], 'Real', 'the last group wins, actions do not leak in')
  assert.equal(entry['Exec'], '/bin/real %f')
})

test('an app is offered only for a MIME type it claims', () => {
  const entry = parseDesktopEntry(ENTRY)
  assert.equal(appHandles(entry, 'application/pdf'), true)
  assert.equal(appHandles(entry, 'text/plain'), false)
  assert.equal(appHandles({ ...entry, NoDisplay: 'true' }, 'application/pdf'), false)
  assert.equal(appHandles({ ...entry, Hidden: 'true' }, 'application/pdf'), false)
  assert.equal(appHandles({ ...entry, Type: 'Link' }, 'application/pdf'), false)
})

test('Exec tokens: the file replaces %f/%F/%u/%U and other codes disappear', () => {
  assert.deepEqual(execFor('/usr/bin/foo --open %F', '/tmp/a.pdf'), [
    '/usr/bin/foo',
    '--open',
    '/tmp/a.pdf'
  ])
  assert.deepEqual(execFor('"/opt/My App/run" %u', '/tmp/a b.pdf'), ['/opt/My App/run', '/tmp/a b.pdf'])
  assert.deepEqual(execFor('foo %i %c %k %f', '/x'), ['foo', '/x'])
  assert.deepEqual(execFor('foo %%', '/x'), ['foo'])
})

test('file extensions map to the MIME type the desktop uses', () => {
  assert.equal(mimeForPath('/a/b/report.pdf'), 'application/pdf')
  assert.equal(mimeForPath('/a/PHOTO.JPG'), 'image/jpeg')
  assert.equal(mimeForPath('/a/note.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(mimeForPath('/a/unknown.weird'), 'application/octet-stream')
})

test('macOS and Windows hand the file to the OS launcher, Linux stays on .desktop', () => {
  assert.deepEqual(systemOpenCommand('darwin', '/a/b.pdf'), ['open', ['/a/b.pdf']])
  assert.deepEqual(systemOpenCommand('win32', '/a/b.pdf'), ['cmd', ['/c', 'start', '', '/a/b.pdf']])
  assert.equal(systemOpenCommand('linux', '/a/b.pdf'), null)
})


test('windowsFileManagerCommand quotes the app and the folder placeholder', () => {
  assert.equal(
    windowsFileManagerCommand('C:\\Program Files\\Max File Manager.exe', 'C:\\app', true),
    '"C:\\Program Files\\Max File Manager.exe" "%1"'
  )
  // a checkout runs through electron.exe with the app directory as the first argument
  assert.equal(
    windowsFileManagerCommand('C:\\repo\\node_modules\\electron\\electron.exe', 'C:\\repo', false),
    '"C:\\repo\\node_modules\\electron\\electron.exe" "C:\\repo" "%1"'
  )
})

test('parseAssocHandlers turns the shell handler list into app rows', () => {
  const json = JSON.stringify({
    default: 'Photos',
    apps: [
      { id: 'Snip & Sketch', name: 'Snip & Sketch', icon: '@{x?ms-resource://y}' },
      { id: 'C:\\Windows\\system32\\mspaint.exe', name: 'Paint', icon: '' },
      { id: 'C:\\Windows\\system32\\mspaint.exe', name: 'Paint', icon: '' },
      { name: 'no id' },
      { id: '', name: 'empty' }
    ]
  })
  const parsed = parseAssocHandlers(json)
  assert.equal(parsed.defaultName, 'Photos')
  assert.deepEqual(
    parsed.apps.map((a) => a.id),
    ['assoc:Snip & Sketch', 'assoc:C:\\Windows\\system32\\mspaint.exe'],
    'duplicates and rows without an id are dropped'
  )
  assert.equal(parsed.apps[0].name, 'Snip & Sketch')
  assert.deepEqual(parseAssocHandlers(''), { defaultName: '', apps: [] })
  assert.deepEqual(parseAssocHandlers('not json'), { defaultName: '', apps: [] })
})

test('parseWindowsOpenWith accepts the object shape PowerShell emits', () => {
  const json = JSON.stringify({
    defaultId: 'progid:AcroExch.Document.DC',
    apps: [
      {
        id: 'progid:AcroExch.Document.DC',
        name: 'Adobe Acrobat',
        command: '"C:\\Program Files\\Adobe\\Acrobat.exe" "%1"'
      },
      {
        id: 'progid:Applications\\firefox.exe',
        name: 'Firefox',
        command: '"C:\\Program Files\\Mozilla Firefox\\firefox.exe" -osint -url "%1"'
      }
    ]
  })
  const parsed = parseWindowsOpenWith(json)
  assert.equal(parsed.defaultId, 'progid:AcroExch.Document.DC')
  assert.deepEqual(parsed.apps.map((a) => a.name), ['Adobe Acrobat', 'Firefox'])
  assert.match(parsed.apps[1].command ?? '', /firefox\.exe/)
})

test('parseWindowsOpenWith handles a single row, junk and an array', () => {
  assert.deepEqual(parseWindowsOpenWith(''), { defaultId: '', apps: [] })
  assert.deepEqual(parseWindowsOpenWith('not json'), { defaultId: '', apps: [] })
  const one = parseWindowsOpenWith(JSON.stringify({ id: 'appid:MSEdge', name: 'Edge' }))
  assert.deepEqual(one.apps.map((a) => a.id), ['appid:MSEdge'])
  const arrayOnly = parseWindowsOpenWith(JSON.stringify([{ id: 'progid:Foo', name: '' }]))
  assert.deepEqual(arrayOnly.apps, [{ id: 'progid:Foo', name: 'progid:Foo', command: '' }])
})

test('windowsArgv keeps quoted paths and puts the file on the placeholder', () => {
  const argv = windowsArgv('"C:\\Program Files\\App\\app.exe" --open "%1"', 'C:\\Users\\me\\a b.txt')
  assert.deepEqual(argv, ['C:\\Program Files\\App\\app.exe', '--open', 'C:\\Users\\me\\a b.txt'])
  const noPlaceholder = windowsArgv('"C:\\App\\viewer.exe"', 'C:\\x.pdf')
  assert.deepEqual(noPlaceholder, ['C:\\App\\viewer.exe', 'C:\\x.pdf'])
  const upper = windowsArgv('C:\\App\\viewer.exe "%L"', 'C:\\y.pdf')
  assert.deepEqual(upper, ['C:\\App\\viewer.exe', 'C:\\y.pdf'])
  const dropped = windowsArgv('C:\\App\\viewer.exe /dde %v %1', 'C:\\z.pdf')
  assert.deepEqual(dropped, ['C:\\App\\viewer.exe', '/dde', 'C:\\z.pdf'])
})

test('parseMacAppPaths keeps bundles only and removes duplicates', () => {
  const out = [
    '/Applications/Preview.app',
    '/Applications/Preview.app',
    '/System/Applications/TextEdit.app/',
    '/Users/me/Downloads/file.pdf',
    '',
    '  /Applications/Safari.app  '
  ].join('\n')
  assert.deepEqual(parseMacAppPaths(out), [
    '/Applications/Preview.app',
    '/System/Applications/TextEdit.app',
    '/Applications/Safari.app'
  ])
  assert.equal(macAppName('/Applications/Visual Studio Code.app/'), 'Visual Studio Code')
})

test('macOS handlers come from LaunchServices JSON, bundles only and de-duplicated', () => {
  const parsed = parseMacOpenWith(
    JSON.stringify({
      apps: ['/Applications/Xcode.app', '/Applications/Xcode.app', '/System/Applications/TextEdit.app', '/tmp/a.txt', ''],
      def: '/Applications/Xcode.app'
    })
  )
  assert.deepEqual(parsed.apps, ['/Applications/Xcode.app', '/System/Applications/TextEdit.app'])
  assert.equal(parsed.def, '/Applications/Xcode.app')
  // a failed or empty osascript run must not throw or invent handlers
  assert.deepEqual(parseMacOpenWith(''), { apps: [], def: '' })
  assert.deepEqual(parseMacOpenWith('execution error'), { apps: [], def: '' })
})

test('only an executable script or AppImage counts as runnable', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mfm-run-'))
  try {
    const script = path.join(dir, 'go.sh')
    await writeFile(script, '#!/bin/sh\nexit 0\n')
    await chmod(script, 0o755)
    assert.equal(await isRunnableFile(script), true, 'shebang + exec bit')

    const plain = path.join(dir, 'plain.sh')
    await writeFile(plain, '#!/bin/sh\nexit 0\n')
    await chmod(plain, 0o644)
    assert.equal(await isRunnableFile(plain), false, 'no exec bit')

    const notes = path.join(dir, 'notes.txt')
    await writeFile(notes, 'just text, no shebang\n')
    await chmod(notes, 0o755)
    assert.equal(await isRunnableFile(notes), false, 'exec bit alone is not a script')

    const appimage = path.join(dir, 'tool.AppImage')
    const elf = Buffer.alloc(12)
    elf[0] = 0x7f; elf[1] = 0x45; elf[8] = 0x41; elf[9] = 0x49
    await writeFile(appimage, elf)
    await chmod(appimage, 0o755)
    assert.equal(await isRunnableFile(appimage), true, 'AppImage magic')

    await chmod(appimage, 0o644)
    assert.equal(await isRunnableFile(appimage), false, 'AppImage without exec bit')
    assert.equal(await isRunnableFile(dir), false, 'a folder is not runnable')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('on Windows the extension decides, and an msi goes through msiexec', () => {
  assert.equal(winRunnableExt('setup.exe'), true)
  assert.equal(winRunnableExt('Setup.MSI'), true)
  assert.equal(winRunnableExt('run.sh'), false, 'a script is not an exe')
  assert.equal(winRunnableExt('notes.exe.txt'), false, 'the extension must be the last one')
  assert.deepEqual(runCommand('C:\\dl\\tool.msi'), { bin: 'msiexec.exe', args: ['/i', 'C:\\dl\\tool.msi'] })
  assert.deepEqual(runCommand('C:\\dl\\tool.exe'), { bin: 'C:\\dl\\tool.exe', args: [] })
})

test('runFile really starts the file, in its own folder', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mfm-run2-'))
  const stamp = path.join(dir, 'ran.txt')
  const script = path.join(dir, 'write.sh')
  try {
    await writeFile(script, `#!/bin/sh\npwd > '${stamp}'\n`)
    await chmod(script, 0o755)
    const r = await runFile(script)
    assert.deepEqual(r, { ok: true })
    let seen = ''
    for (let i = 0; i < 40 && !seen; i++) {
      await new Promise((res) => setTimeout(res, 50))
      seen = await readFile(stamp, 'utf8').catch(() => '')
    }
    // macOS reports /private/var/... for the temp dir; both spellings are the same folder
    assert.equal(
      await realpath(seen.trim()),
      await realpath(dir),
      'the script ran with its own folder as cwd'
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
