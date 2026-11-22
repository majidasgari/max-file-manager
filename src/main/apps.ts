/**
 * The system's «open with» list and a launcher that actually starts the chosen app.
 *
 * Electron's `shell.openPath` returns an empty string even when `xdg-open` fails, and some
 * desktops are launched without `XDG_CURRENT_DESKTOP`, so a file can silently never open.
 * Here the failure is detectable, and the app list is parsed from the `.desktop` files the
 * user already has — no network, no extra dependency.
 */

import { promises as fs, unlink, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'

export type DesktopApp = {
  id: string
  name: string
  exec: string
  icon: string
  desktop: string
  /** absolute icon file the renderer can show, '' when the theme has none */
  iconPath: string
  /** the desktop's current handler for this MIME type */
  isDefault: boolean
}

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/x-wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odp: 'application/vnd.oasis.opendocument.presentation',
  apk: 'application/vnd.android.package-archive',
  deb: 'application/vnd.debian.binary-package',
  sh: 'application/x-shellscript'
}

/** The MIME type a desktop file would be matched against; unknown files fall back to text/plain. */
export function mimeForPath(p: string): string {
  const ext = path.extname(p).slice(1).toLowerCase()
  return EXT_MIME[ext] ?? 'application/octet-stream'
}

/** Values of a `[Desktop Entry]` group, last occurrence wins (the spec allows repeats). */
export function parseDesktopEntry(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let inEntry = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inEntry = trimmed === '[Desktop Entry]'
      continue
    }
    if (!inEntry || !trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

/** True when the entry is a visible application that claims this MIME type. */
export function appHandles(entry: Record<string, string>, mime: string): boolean {
  if (entry['Type'] !== 'Application' || !entry['Exec']) return false
  if (entry['NoDisplay'] === 'true' || entry['Hidden'] === 'true') return false
  const types = (entry['MimeType'] ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  return types.includes(mime)
}

const splitExec = (exec: string): string[] => {
  const out: string[] = []
  let current = ''
  let quote = ''
  for (const ch of exec) {
    if (quote) {
      if (ch === quote) quote = ''
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) out.push(current)
  return out
}

/** `Exec=` → argv, with the file token replaced (and the other specifiers removed). */
export function execFor(exec: string, file: string): string[] {
  const argv: string[] = []
  for (const token of splitExec(exec)) {
    if (/^%[fFuUdDnNickvm]$/.test(token)) {
      if (token === '%f' || token === '%F' || token === '%u' || token === '%U') argv.push(file)
      continue
    }
    argv.push(token.replace(/^%i/, ''))
  }
  return argv.filter((part) => !part.startsWith('%%'))
}

/** Ask the desktop which application is the default for this MIME type. */
const defaultDesktopName = (mime: string): Promise<string> =>
  new Promise((resolve) => {
    const child = execFile('xdg-mime', ['query', 'default', mime], { timeout: 2000 }, (err, out) => {
      resolve(err ? '' : String(out).trim())
    })
    child.on('error', () => resolve(''))
  })

/** Resolve a desktop file name (`foo.desktop`) to the full path the app dirs hold. */
async function findDesktop(name: string): Promise<string | null> {
  if (!name) return null
  for (const dir of appDirs()) {
    const full = path.join(dir, name)
    if (await fs.access(full).then(() => true, () => false)) return full
  }
  return null
}

/**
 * The system launcher for a platform that has no `.desktop` registry, or null on Linux.
 * Pure so the argv is testable without opening a real file.
 */
export function systemOpenCommand(
  platform: NodeJS.Platform | string,
  file: string
): [cmd: string, args: string[]] | null {
  if (platform === 'darwin') return ['open', [file]]
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', file]]
  return null
}

/**
 * macOS and Windows have no `.desktop` registry: hand the file to the OS launcher and read the
 * exit code, so a missing handler is reported instead of silently dropped. `open` on macOS exits
 * non-zero and prints the reason when nothing claims the type.
 */
const openWithSystem = (cmd: string, args: string[]): Promise<{ ok: true } | { error: string }> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, _out, stderr) => {
      if (!err) {
        resolve({ ok: true })
        return
      }
      const msg = String(stderr || err.message || '').trim()
      resolve({ error: msg || 'open_failed' })
    })
  })

/**
 * The system's default handler for this file, launched the same way «Open with» does.
 * `shell.openPath` cannot be trusted to report failure, so the default app is started
 * directly; only when no default exists do the generic openers take over.
 */
export async function openWithDefault(file: string): Promise<{ ok: true } | { error: string }> {
  // The `.desktop` path below is Linux-only; every other platform would fall through to
  // gio/xdg-open/kioclient and report «no application» even when Finder or Explorer has one.
  const native = systemOpenCommand(process.platform, file)
  if (native) return openWithSystem(native[0], native[1])
  const desktop = await findDesktop(await defaultDesktopName(mimeForPath(file)))
  if (desktop) {
    const result = await launchApp(desktop, file)
    if ('ok' in result) return result
  }
  for (const [cmd, args] of [
    ['gio', ['open', file]],
    ['xdg-open', [file]],
    ['kioclient5', ['exec', file]],
    ['kde-open5', [file]]
  ] as [string, string[]][]) {
    if (await spawnDetached(cmd, args)) return { ok: true }
  }
  return { error: 'open_failed' }
}

/** The desktop's default handler for this file, or null when the type has none. */
export async function defaultApp(file: string): Promise<{ id: string; name: string } | null> {
  if (process.platform === 'win32') {
    // the shell knows the default handler even when it is a packaged app
    const assoc = parseAssocHandlers(await assocRaw(extOf(file), false))
    const hit = assoc.apps.find((a) => a.name.toLowerCase() === assoc.defaultName.toLowerCase())
    if (hit) return { id: hit.id, name: hit.name }
    const parsed = parseWindowsOpenWith(await runPowerShell(WIN_LIST_SCRIPT, { MFM_EXT: extOf(file) }))
    const fallback = parsed.apps.find((a) => a.id === parsed.defaultId)
    return fallback ? { id: fallback.id, name: fallback.name } : null
  }
  if (process.platform === 'darwin') return macDefaultApp(file)
  const desktop = await findDesktop(await defaultDesktopName(mimeForPath(file)))
  if (!desktop) return null
  const entry = parseDesktopEntry(await fs.readFile(desktop, 'utf8').catch(() => ''))
  return { id: desktop, name: entry['Name'] ?? path.basename(desktop, '.desktop') }
}

/** Launch a helper and treat a clean quick exit as success; it is never waited on. */
export const spawnDetached = (cmd: string, args: string[]): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
      child.on('error', () => done(false))
      child.on('exit', (code) => done(code === 0))
      child.on('spawn', () => setTimeout(() => done(true), 1200))
      child.unref()
    } catch {
      done(false)
    }
  })

/** Windows has no exec bit: the extension is the bit. Only the two shapes «Run» covers. */
export const winRunnableExt = (file: string): boolean => /\.(exe|msi)$/i.test(file)

/** A `.msi` is not an executable; the Windows installer owns it. */
export function runCommand(file: string): { bin: string; args: string[] } {
  return /\.msi$/i.test(file) ? { bin: 'msiexec.exe', args: ['/i', file] } : { bin: file, args: [] }
}

/**
 * An executable script or AppImage: the user asked the file manager to run it, not to hand it to a
 * text editor. Only those two shapes are claimed; a `.desktop` file or another binary keeps its
 * normal handler. On Windows the extension decides instead: `.exe`/`.msi` are recognized there.
 */
export async function isRunnableFile(file: string): Promise<boolean> {
  if (process.platform === 'win32') return winRunnableExt(file)
  try {
    const st = await fs.stat(file)
    if (!st.isFile() || (st.mode & 0o111) === 0) return false
    const fh = await fs.open(file, 'r')
    try {
      const buf = Buffer.alloc(12)
      const { bytesRead } = await fh.read(buf, 0, 12, 0)
      if (bytesRead >= 2 && buf[0] === 0x23 && buf[1] === 0x21) return true // #!
      // AppImage: an ELF whose offset 8 carries the "AI" magic
      return bytesRead >= 10 && buf[0] === 0x7f && buf[1] === 0x45 && buf[8] === 0x41 && buf[9] === 0x49
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
}

/** Start the file itself, detached and without a console: the same hand-off «Run» means. */
export const runFile = (file: string): Promise<{ ok: true } | { error: string }> =>
  new Promise((resolve) => {
    try {
      const { bin, args } = runCommand(file)
      const child = spawn(bin, args, { cwd: path.dirname(file), detached: true, stdio: 'ignore' })
      child.once('error', (e: Error) => resolve({ error: e.message }))
      child.once('spawn', () => {
        child.unref()
        resolve({ ok: true })
      })
    } catch (e) {
      resolve({ error: e instanceof Error ? e.message : String(e) })
    }
  })

/** A Windows shortcut: the folder worth opening is its target's, not the `.lnk`'s own. */
export const isShortcutFile = (file: string): boolean => /\.lnk$/i.test(file)

const WIN_LNK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:MFM_LNK)
[pscustomobject]@{ target = [string]$s.TargetPath } | ConvertTo-Json -Compress
`

/** Where a `.lnk` points, '' when Windows cannot read it (a Store-app alias has no target path). */
export async function shortcutTarget(file: string): Promise<string> {
  if (process.platform !== 'win32' || !isShortcutFile(file) || !path.isAbsolute(file)) return ''
  const raw = await runPowerShell(WIN_LNK_SCRIPT, { MFM_LNK: file })
  try {
    const parsed = JSON.parse(raw.trim() || '{}') as { target?: unknown }
    return typeof parsed.target === 'string' ? parsed.target.trim() : ''
  } catch {
    return ''
  }
}

const WIN_RUN_ADMIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:MFM_RUN_PATH
if ([IO.Path]::GetExtension($target) -ieq '.msi') {
  Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"' + $target + '"')) -Verb RunAs
} else {
  Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target) -Verb RunAs
}
'ok'
`

/**
 * «Run as administrator»: the UAC prompt belongs to the user, and declining it is an error we
 * report instead of a silent no-op. Only the two shapes «Run» covers may be elevated.
 */
export async function runFileAsAdmin(file: string): Promise<{ ok: true } | { error: string }> {
  if (process.platform !== 'win32') return { error: 'unsupported' }
  if (!path.isAbsolute(file) || !winRunnableExt(file)) return { error: 'not_executable' }
  const raw = (await runPowerShell(WIN_RUN_ADMIN_SCRIPT, { MFM_RUN_PATH: file })).trim()
  return raw === 'ok' ? { ok: true } : { error: 'elevation_failed' }
}

const appDirs = (): string[] => {
  const dirs = [path.join(os.homedir(), '.local/share/applications'), '/usr/share/applications']
  for (const base of (process.env['XDG_DATA_DIRS'] ?? '').split(':')) {
    if (base) dirs.push(path.join(base, 'applications'))
  }
  return [...new Set(dirs)]
}

const iconExists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

/** Themes that between them cover KDE, GNOME, Xfce and most icon packs; the full tree is too slow. */
const ICON_THEMES = ['hicolor', 'breeze', 'breeze-dark', 'Adwaita', 'Yaru', 'Papirus', 'oxygen', 'Tango']
const ICON_SIZES = ['256x256', '128x128', '64x64', '48x48', '32x32', 'scalable', 'symbolic']

const iconCache = new Map<string, string>()

/**
 * Resolve a `.desktop` `Icon=` name to a real file. Absolute paths are used as given; a name is
 * looked up in pixmaps and in the common themes' `apps` folders (cached — a listing asks once
 * per application).
 */
export async function appIconPath(icon: string): Promise<string> {
  if (!icon) return ''
  if (path.isAbsolute(icon)) return (await iconExists(icon)) ? icon : ''
  const cached = iconCache.get(icon)
  if (cached !== undefined) return cached
  const names = [`${icon}.svg`, `${icon}.png`, `${icon}.xpm`]
  const roots = [path.join(os.homedir(), '.local/share/icons'), '/usr/share/icons', '/usr/share/pixmaps']
  for (const base of (process.env['XDG_DATA_DIRS'] ?? '').split(':')) {
    if (base) roots.push(path.join(base, 'icons'))
  }
  for (const name of names) {
    const direct = path.join('/usr/share/pixmaps', name)
    if (await iconExists(direct)) {
      iconCache.set(icon, direct)
      return direct
    }
  }
  for (const root of roots) {
    for (const theme of ICON_THEMES) {
      for (const size of ICON_SIZES) {
        for (const name of names) {
          const full = path.join(root, theme, size, 'apps', name)
          if (await iconExists(full)) {
            iconCache.set(icon, full)
            return full
          }
        }
      }
    }
  }
  iconCache.set(icon, '')
  return ''
}

// ── Windows ────────────────────────────────────────────────────────────────────────────────
// There is no `.desktop` registry: handlers live under HKCR\<ext> as command lines. PowerShell
// runs read-only, and every parser below is pure so it can be tested on any platform.
// «Always open with» stays Linux-only: Windows 8+ only lets the user change an association
// through the system UI.

const WIN_CACHE = new Map<string, string>()

export type OpenWithRow = { id: string; name: string; command?: string; icon?: string }

const runPowerShell = (script: string, env: Record<string, string> = {}): Promise<string> =>
  new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('')
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { timeout: 12_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } },
        (err, out) => resolve(err ? '' : String(out))
      )
    } catch {
      resolve('')
    }
  })

/**
 * The same runner for the association scripts: they carry an inline C# helper (several KB), and a
 * temp `.ps1` reaches PowerShell exactly as written instead of fighting command-line quoting.
 */
const runPowerShellFile = (script: string, env: Record<string, string> = {}): Promise<string> =>
  new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('')
    const file = path.join(os.tmpdir(), `mfm-assoc-${process.pid}-${Date.now()}.ps1`)
    try {
      // a BOM keeps PowerShell 5.1 from reading the file as the ANSI code page
      writeFileSync(file, '\ufeff' + script, 'utf8')
    } catch {
      return resolve('')
    }
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
        { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } },
        (err, out) => {
          unlink(file, () => undefined)
          resolve(err ? '' : String(out))
        }
      )
    } catch {
      unlink(file, () => undefined)
      resolve('')
    }
  })

/** PowerShell JSON is a single object or an array depending on the row count. */
export function parseWindowsOpenWith(json: string): { defaultId: string; apps: OpenWithRow[] } {
  const text = String(json ?? '').trim()
  if (!text) return { defaultId: '', apps: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { defaultId: '', apps: [] }
  }
  const raw = Array.isArray(parsed) ? { defaultId: '', apps: parsed } : (parsed as Record<string, unknown>)
  // a bare row (no wrapper) is still a row; PowerShell's ConvertTo-Json does that for one object
  const box = raw.apps === undefined && typeof raw.id === 'string' ? { defaultId: '', apps: [raw] } : raw
  const rows = Array.isArray(box.apps) ? box.apps : box.apps ? [box.apps] : []
  const apps: OpenWithRow[] = []
  for (const raw of rows) {
    const row = raw as Record<string, unknown>
    if (!row || typeof row.id !== 'string' || !row.id) continue
    apps.push({
      id: row.id,
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : row.id,
      command: typeof row.command === 'string' ? row.command : ''
    })
  }
  return { defaultId: typeof box.defaultId === 'string' ? box.defaultId : '', apps }
}

/** `"%ProgramFiles%\App\app.exe" "%1"` → argv with the file in place of the placeholder. */
export function windowsArgv(command: string, file: string): string[] {
  const expanded = String(command ?? '').replace(/%([^%]+)%/g, (all, name: string) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? String(process.env[key]) : all
  })
  const argv: string[] = []
  let current = ''
  let quote = ''
  for (const ch of expanded) {
    if (quote) {
      if (ch === quote) quote = ''
      else current += ch
      continue
    }
    if (ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) argv.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) argv.push(current)
  const out: string[] = []
  for (const token of argv) {
    if (/^%[lL1-9]$/.test(token)) out.push(file)
    else if (/^%\*$/.test(token)) out.push(file)
    else if (/^%[a-zA-Z]$/.test(token)) continue
    else out.push(token)
  }
  if (!out.includes(file)) out.push(file)
  return out
}

const WIN_LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ext = $env:MFM_EXT
$ids = New-Object System.Collections.ArrayList
$rows = New-Object System.Collections.ArrayList
try { $main = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $ext)).'(default)' } catch {}
if ($main) { [void]$ids.Add($main) }
try { $uc = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + $ext + '\UserChoice')).ProgId } catch {}
if ($uc) { [void]$ids.Add($uc) }
try { $owp = Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $ext + '\OpenWithProgids') } catch {}
if ($owp) { foreach ($p in $owp.PSObject.Properties) { if ($p.Name -notlike 'PS*' -and $p.Name) { [void]$ids.Add($p.Name) } } }
try { $owl = Get-ItemProperty -LiteralPath ('Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + $ext + '\OpenWithList') } catch {}
if ($owl) { foreach ($p in $owl.PSObject.Properties) { if ($p.Name -ne 'MRUList' -and $p.Value) { [void]$ids.Add('Applications\' + $p.Value) } } }
$seen = @{}
foreach ($prog in $ids) {
  if (-not $prog -or $seen.ContainsKey($prog)) { continue }
  $seen[$prog] = $true
  try { $cmd = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $prog + '\shell\open\command')).'(default)' } catch {}
  if (-not $cmd) { continue }
  $name = ''
  try {
    $k = Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $prog)
    $name = $k.'(default)'
    if (-not $name) { $name = $k.FriendlyAppName }
    if (-not $name) { $name = $k.ApplicationName }
  } catch {}
  if (-not $name) { $name = $prog }
  [void]$rows.Add([pscustomobject]@{ id = ('progid:' + $prog); name = [string]$name; command = [string]$cmd })
}
# Applications that declare this extension in SupportedTypes. Explorer builds its own "recommended"
# list from these keys; reading only the extension's own ProgIDs left the picker empty on a fresh app.
foreach ($root in @('Registry::HKEY_CLASSES_ROOT\Applications', 'Registry::HKEY_CURRENT_USER\Software\Classes\Applications')) {
  foreach ($app in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
    if ($rows.Count -ge 80) { break }
    $exe = Split-Path -Leaf $app.PSPath
    if (-not $exe -or $seen.ContainsKey('exe:' + $exe)) { continue }
    $supported = Get-ItemProperty -LiteralPath ($app.PSPath + '\SupportedTypes') -ErrorAction SilentlyContinue
    if (-not $supported) { continue }
    $hit = $false
    foreach ($p in $supported.PSObject.Properties) {
      if ($p.Name -like 'PS*') { continue }
      if ($p.Name -eq $ext -or $p.Name -eq '*') { $hit = $true; break }
    }
    if (-not $hit) { continue }
    $cmd = (Get-ItemProperty -LiteralPath ($app.PSPath + '\shell\open\command') -ErrorAction SilentlyContinue).'(default)'
    if (-not $cmd) {
      $ap = (Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\' + $exe) -ErrorAction SilentlyContinue).'(default)'
      if ($ap) { $cmd = '"' + $ap + '" "%1"' }
    }
    if (-not $cmd) { continue }
    $name = (Get-ItemProperty -LiteralPath $app.PSPath -ErrorAction SilentlyContinue).'(default)'
    if (-not $name) {
      $path = $cmd -replace '^"([^"]+)".*$', '$1'
      if ($path -eq $cmd) { $path = $cmd -replace '^([^\s]+\.exe).*$', '$1' }
      $fi = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
      if ($fi) { $name = $fi.VersionInfo.FileDescription }
    }
    if (-not $name) { $name = [System.IO.Path]::GetFileNameWithoutExtension($exe) }
    $seen['exe:' + $exe] = $true
    [void]$rows.Add([pscustomobject]@{ id = ('exe:' + $exe); name = [string]$name; command = [string]$cmd })
  }
}
$def = $uc
if (-not $def) { $def = $main }
[pscustomobject]@{ defaultId = $(if ($def) { 'progid:' + $def } else { '' }); apps = @($rows) } | ConvertTo-Json -Compress -Depth 5
`

const WIN_ALL_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$rows = New-Object System.Collections.ArrayList
foreach ($a in (Get-StartApps)) {
  if ($a.Name -and $a.AppID) { [void]$rows.Add([pscustomobject]@{ id = ('appid:' + $a.AppID); name = [string]$a.Name; command = '' }) }
}
[pscustomobject]@{ defaultId = ''; apps = @($rows) } | ConvertTo-Json -Compress -Depth 5
`

const WIN_PROGID_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$prog = $env:MFM_PROGID
$cmd = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $prog + '\shell\open\command')).'(default)'
if ($cmd) { [pscustomobject]@{ command = [string]$cmd } | ConvertTo-Json -Compress } else { '{}' }
`

/** The «open with» command of an application id (`exe:notepad.exe`) when the list has been forgotten. */
const WIN_EXE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$exe = $env:MFM_EXE
$cmd = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\Applications\' + $exe + '\shell\open\command') -ErrorAction SilentlyContinue).'(default)'
if (-not $cmd) { $cmd = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CURRENT_USER\Software\Classes\Applications\' + $exe + '\shell\open\command') -ErrorAction SilentlyContinue).'(default)' }
if (-not $cmd) {
  $ap = (Get-ItemProperty -LiteralPath ('Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\' + $exe) -ErrorAction SilentlyContinue).'(default)'
  if ($ap) { $cmd = '"' + $ap + '" "%1"' }
}
if ($cmd) { [pscustomobject]@{ command = [string]$cmd } | ConvertTo-Json -Compress } else { '{}' }
`

/** `IAssocHandler` rows for the extension, exactly what Explorer's own «Open with» shows. */
export function parseAssocHandlers(json: string): { defaultName: string; apps: OpenWithRow[] } {
  const text = String(json ?? '').trim()
  if (!text) return { defaultName: '', apps: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { defaultName: '', apps: [] }
  }
  const box = (parsed ?? {}) as Record<string, unknown>
  const rows = Array.isArray(box.apps) ? box.apps : []
  const apps: OpenWithRow[] = []
  const seen = new Set<string>()
  for (const raw of rows) {
    const row = raw as Record<string, unknown>
    if (!row || typeof row.id !== 'string' || !row.id) continue
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : row.id
    const id = 'assoc:' + row.id
    if (seen.has(id)) continue
    seen.add(id)
    apps.push({
      id,
      name,
      command: '',
      icon: typeof row.icon === 'string' ? row.icon.trim() : ''
    })
  }
  return { defaultName: typeof box.default === 'string' ? box.default : '', apps }
}

/**
 * Windows' own association API (`SHAssocEnumHandlers` + `IAssocHandler`), compiled inline.
 *
 * Reading only the registry left out every packaged app: the default handler for images is the
 * Store «Photos» app, whose ProgID has a `DelegateExecute` and no command line, so it vanished
 * from the list. The shell API returns Explorer's recommended list with localized names, and
 * `Invoke` launches a handler (packaged or classic) with a real data object for the file.
 */
const ASSOC_CS = `
using System;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IEnumAssocHandlers {
  [PreserveSig] int Next(uint celt, out IntPtr rgelt, out uint pceltFetched);
}

[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItem {
  [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
}

[ComImport, Guid("F04061AC-1659-4a3f-A954-775AA57FC083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAssocHandler {
  [PreserveSig] int GetName([MarshalAs(UnmanagedType.LPWStr)] out string ppsz);
  [PreserveSig] int GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string ppsz);
  [PreserveSig] int GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string ppszPath, out int pIndex);
  [PreserveSig] int IsRecommended();
  [PreserveSig] int MakeDefault([MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
  [PreserveSig] int Invoke(IntPtr pdo);
  [PreserveSig] int CreateInvoker(IntPtr pdo, out IntPtr ppInvoker);
}

public static class Assoc {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHAssocEnumHandlers(string pszExtra, int afFilter, out IEnumAssocHandlers ppEnum);

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern int AssocQueryString(int flags, int str, string assoc, string extra, StringBuilder outBuf, ref uint outLen);

  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHLoadIndirectString(string pszSource, StringBuilder pszOutBuf, uint cchOutBuf, IntPtr ppvReserved);

  static readonly Guid BhidDataObject = new Guid("b8c0bd9f-ed24-455c-83e6-d5390c4fe8c4");
  static readonly Guid IidDataObject = new Guid("0000010e-0000-0000-C000-000000000046");

  static string Esc(string s) {
    if (s == null) return "";
    return s.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"").Replace("\\r", " ").Replace("\\n", " ");
  }

  static string Default(string ext) {
    uint len = 1024;
    var sb = new StringBuilder(1024);
    int hr = AssocQueryString(0, 4, ext, null, sb, ref len);
    return hr == 0 ? sb.ToString() : "";
  }

  /** A packaged app's icon is an indirect resource string; resolve it to the real asset path. */
  static string ResolveIcon(string location) {
    if (string.IsNullOrEmpty(location)) return "";
    if (location[0] != '@') return location;
    var sb = new StringBuilder(2048);
    try {
      SHLoadIndirectString(location, sb, 2048, IntPtr.Zero);
    } catch {
      return "";
    }
    return sb.ToString();
  }

  public static string List(string ext, int filter) {
    var sb = new StringBuilder("{\\"default\\":\\"").Append(Esc(Default(ext))).Append("\\",\\"apps\\":[");
    bool first = true;
    IEnumAssocHandlers e;
    SHAssocEnumHandlers(ext, filter, out e);
    IntPtr ptr;
    uint fetched;
    while (e.Next(1, out ptr, out fetched) == 0 && fetched == 1) {
      var h = (IAssocHandler)Marshal.GetObjectForIUnknown(ptr);
      string name, ui, icon;
      int idx;
      h.GetName(out name);
      h.GetUIName(out ui);
      h.GetIconLocation(out icon, out idx);
      Marshal.Release(ptr);
      string id = string.IsNullOrEmpty(name) ? ui : name;
      if (string.IsNullOrEmpty(id)) continue;
      if (!first) sb.Append(",");
      first = false;
      sb.Append("{\\"id\\":\\"").Append(Esc(id)).Append("\\",\\"name\\":\\"")
        .Append(Esc(string.IsNullOrEmpty(ui) ? id : ui)).Append("\\",\\"icon\\":\\"")
        .Append(Esc(ResolveIcon(icon))).Append("\\"}");
    }
    return sb.Append("]}").ToString();
  }

  static IntPtr DataObjectFor(string file) {
    Guid iid = typeof(IShellItem).GUID;
    IShellItem item;
    SHCreateItemFromParsingName(file, IntPtr.Zero, ref iid, out item);
    Guid bhid = BhidDataObject;
    Guid dio = IidDataObject;
    IntPtr pdo;
    if (item.BindToHandler(IntPtr.Zero, ref bhid, ref dio, out pdo) != 0) return IntPtr.Zero;
    return pdo;
  }

  public static string Invoke(string name, string file) {
    IEnumAssocHandlers e;
    SHAssocEnumHandlers(System.IO.Path.GetExtension(file), 0, out e);
    IntPtr ptr;
    uint fetched;
    while (e.Next(1, out ptr, out fetched) == 0 && fetched == 1) {
      var h = (IAssocHandler)Marshal.GetObjectForIUnknown(ptr);
      string n, ui;
      h.GetName(out n);
      h.GetUIName(out ui);
      if (string.IsNullOrEmpty(n)) n = ui;
      if (!string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) {
        Marshal.Release(ptr);
        continue;
      }
      IntPtr pdo = DataObjectFor(file);
      if (pdo == IntPtr.Zero) {
        Marshal.Release(ptr);
        return "no-data";
      }
      int hr = h.Invoke(pdo);
      Marshal.Release(ptr);
      return hr == 0 ? "ok" : "err_0x" + hr.ToString("X8");
    }
    return "not_found";
  }
}
`

/** Explorer's recommended handlers for the extension (filter 0 = everything). */
const WIN_ASSOC_SCRIPT =
  `$ErrorActionPreference = 'SilentlyContinue'\n` +
  `$code = @'\n${ASSOC_CS}\n'@\n` +
  `Add-Type -TypeDefinition $code\n` +
  `[Assoc]::List($env:MFM_EXT, [int]$env:MFM_FILTER)\n`

/** Launch one handler from that list with the file it is meant to open. */
const WIN_ASSOC_INVOKE_SCRIPT =
  `$ErrorActionPreference = 'SilentlyContinue'\n` +
  `$code = @'\n${ASSOC_CS}\n'@\n` +
  `Add-Type -TypeDefinition $code\n` +
  `[Assoc]::Invoke($env:MFM_ASSOC, $env:MFM_FILE)\n`

const extOf = (file: string): string => path.extname(file).toLowerCase() || '.dat'

const windowsRows = (rows: OpenWithRow[], defaultName: string): DesktopApp[] =>
  rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      exec: row.command ?? '',
      icon: '',
      desktop: '',
      // a source icon (exe or packaged PNG); `withAppIcons` turns it into a cacheable PNG
      iconPath: row.icon ?? '',
      isDefault: !!defaultName && row.name.toLowerCase() === defaultName.toLowerCase()
    }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))

/** The shell list costs a PowerShell + C# round trip; a right-click repeat should be instant. */
const ASSOC_CACHE = new Map<string, { at: number; raw: string }>()

const assocRaw = async (ext: string, all: boolean): Promise<string> => {
  const key = `${ext}:${all ? '1' : '0'}`
  const hit = ASSOC_CACHE.get(key)
  if (hit && Date.now() - hit.at < 20_000) return hit.raw
  const raw = await runPowerShellFile(WIN_ASSOC_SCRIPT, { MFM_EXT: ext, MFM_FILTER: all ? '0' : '1' })
  if (raw) ASSOC_CACHE.set(key, { at: Date.now(), raw })
  return raw
}

/** `IAssocHandler` ids carry no command line: `launchAppWindows` invokes them through the shell. */
export async function listAppsWindowsAssoc(file: string, all: boolean): Promise<DesktopApp[]> {
  const ext = extOf(file)
  const [handlerRaw, startRaw] = await Promise.all([
    assocRaw(ext, all),
    all ? runPowerShell(WIN_ALL_SCRIPT) : Promise.resolve('')
  ])
  const handlers = parseAssocHandlers(handlerRaw)
  const rows = windowsRows(handlers.apps, handlers.defaultName)
  if (!all || !startRaw) return rows
  // the Start menu still holds apps that open a type through their own argument handling
  const known = new Set(rows.map((r) => r.name.toLowerCase()))
  for (const app of parseWindowsOpenWith(startRaw).apps) {
    if (known.has(app.name.toLowerCase())) continue
    known.add(app.name.toLowerCase())
    rows.push({
      id: app.id,
      name: app.name,
      exec: '',
      icon: '',
      desktop: '',
      iconPath: '',
      isDefault: false
    })
  }
  return rows
}

const listAppsWindows = async (file: string, all: boolean): Promise<DesktopApp[]> => {
  const rows = await listAppsWindowsAssoc(file, all)
  if (rows.length) return rows
  // Fallback for a shell that refuses the association API: read the registry directly.
  if (all) {
    const parsed = parseWindowsOpenWith(await runPowerShell(WIN_ALL_SCRIPT))
    return parsed.apps.map((row) => ({
      id: row.id,
      name: row.name,
      exec: '',
      icon: '',
      desktop: '',
      iconPath: '',
      isDefault: false
    }))
  }
  const parsed = parseWindowsOpenWith(await runPowerShell(WIN_LIST_SCRIPT, { MFM_EXT: extOf(file) }))
  for (const row of parsed.apps) if (row.command) WIN_CACHE.set(row.id, row.command)
  return parsed.apps
    .map((row) => ({
      id: row.id,
      name: row.name,
      exec: row.command ?? '',
      icon: '',
      desktop: '',
      iconPath: '',
      isDefault: row.id === parsed.defaultId
    }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}

// ── macOS ──────────────────────────────────────────────────────────────────────────────────
// Spotlight (`mdfind kMDItemContentTypeTree == …`) indexes documents, not handlers: it returned
// nothing for markdown and image *files* for png, so the recommended list was always empty.
// LaunchServices is the only correct source, and JXA exposes it through NSWorkspace. Apps are
// started with `open`.

const MAC_APP_DIRS = [
  '/Applications',
  path.join(os.homedir(), 'Applications'),
  '/System/Applications',
  '/System/Applications/Utilities'
]

/** One line per bundle path; keep the bundles and drop duplicates. */
export function parseMacAppPaths(stdout: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const p = line.trim().replace(/\/+$/, '')
    if (!p.endsWith('.app') || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

export function macAppName(appPath: string): string {
  return path.basename(String(appPath ?? '').replace(/\/+$/, ''), '.app')
}

const macAppsIn = async (dir: string): Promise<string[]> =>
  (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.name.endsWith('.app'))
    .map((d) => path.join(dir, d.name))

/** Handlers and the current default straight from LaunchServices, as JSON. */
const MAC_OPEN_WITH_SCRIPT = String.raw`
function run(argv) {
  ObjC.import('AppKit')
  const url = $.NSURL.fileURLWithPath(argv[0])
  const ws = $.NSWorkspace.sharedWorkspace
  const list = ws.URLsForApplicationsToOpenURL(url)
  const apps = []
  if (list) for (let i = 0; i < list.count; i++) apps.push(list.objectAtIndex(i).path.js)
  let def = ''
  try { def = ws.URLForApplicationToOpenURL(url).path.js } catch (e) {}
  return JSON.stringify({ apps: apps, def: def })
}
`

export function parseMacOpenWith(json: string): { apps: string[]; def: string } {
  const text = String(json ?? '').trim()
  if (!text) return { apps: [], def: '' }
  try {
    const raw = JSON.parse(text) as { apps?: unknown; def?: unknown }
    const apps = Array.isArray(raw.apps)
      ? [...new Set(raw.apps.filter((a): a is string => typeof a === 'string' && a.endsWith('.app')))]
      : []
    return { apps, def: typeof raw.def === 'string' ? raw.def : '' }
  } catch {
    return { apps: [], def: '' }
  }
}

const macOpenWith = (file: string): Promise<{ apps: string[]; def: string }> =>
  new Promise((resolve) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', MAC_OPEN_WITH_SCRIPT, '--', file],
      { timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, out) => resolve(err ? { apps: [], def: '' } : parseMacOpenWith(String(out ?? '')))
    )
  })

const macRow = (appPath: string, def: string): DesktopApp => ({
  id: appPath,
  name: macAppName(appPath),
  exec: '',
  icon: '',
  desktop: appPath,
  iconPath: '',
  isDefault: !!def && appPath === def
})

const listAppsMac = async (file: string, all: boolean): Promise<DesktopApp[]> => {
  if (all) {
    const paths = [...new Set((await Promise.all(MAC_APP_DIRS.map(macAppsIn))).flat())]
    return paths
      .sort((a, b) => macAppName(a).localeCompare(macAppName(b)))
      .map((appPath) => macRow(appPath, ''))
  }
  const info = await macOpenWith(file)
  return info.apps
    .sort(
      (a, b) =>
        Number(b === info.def) - Number(a === info.def) || macAppName(a).localeCompare(macAppName(b))
    )
    .map((appPath) => macRow(appPath, info.def))
}

const macDefaultApp = async (file: string): Promise<{ id: string; name: string } | null> => {
  const { def } = await macOpenWith(file)
  return def ? { id: def, name: macAppName(def) } : null
}

/** Every application that can open the file: `.desktop` entries on Linux, registry command
 * lines on Windows, LaunchServices bundles on macOS; the current handler first. */
export async function listApps(p: string, all = false): Promise<DesktopApp[]> {
  if (process.platform === 'win32') return listAppsWindows(p, all)
  if (process.platform === 'darwin') return listAppsMac(p, all)
  const mime = mimeForPath(p)
  const defaultName = await defaultDesktopName(mime)
  const seen = new Set<string>()
  const apps: DesktopApp[] = []
  for (const dir of appDirs()) {
    const files = await fs.readdir(dir).catch(() => [])
    for (const file of files) {
      if (!file.endsWith('.desktop')) continue
      const full = path.join(dir, file)
      const entry = parseDesktopEntry(await fs.readFile(full, 'utf8').catch(() => ''))
      // «all» is Dolphin's «all applications» page: anything launchable, not just this MIME
      const usable = all
        ? entry['Type'] === 'Application' &&
          !!entry['Exec'] &&
          entry['NoDisplay'] !== 'true' &&
          entry['Hidden'] !== 'true'
        : appHandles(entry, mime)
      if (!usable) continue
      const name = entry['Name'] ?? file.replace(/\.desktop$/, '')
      if (seen.has(name) || !entry['Exec']) continue
      seen.add(name)
      apps.push({
        id: full,
        name,
        exec: entry['Exec'],
        icon: entry['Icon'] ?? '',
        desktop: full,
        iconPath: '',
        isDefault: !!defaultName && path.basename(full) === defaultName
      })
    }
  }
  // resolving icons is filesystem work: do it in small parallel batches, not one stat chain per app
  for (let i = 0; i < apps.length; i += 16) {
    await Promise.all(
      apps.slice(i, i + 16).map(async (app) => {
        app.iconPath = await appIconPath(app.icon)
      })
    )
  }
  return apps.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}

/** What the «Open with» sheet needs: the type, the current handler and the apps. */
export async function openWithInfo(
  file: string,
  all = false
): Promise<{ mime: string; canSetDefault: boolean; apps: DesktopApp[] }> {
  return {
    mime: mimeForPath(file),
    canSetDefault: process.platform === 'linux',
    apps: await listApps(file, all)
  }
}

/** Make a desktop entry the system handler for this file's type (`xdg-mime`, user scope). */
export async function setDefaultApp(
  file: string,
  desktopPath: string
): Promise<{ ok: true } | { error: string }> {
  if (process.platform !== 'linux') return { error: 'unsupported' }
  if (!path.isAbsolute(desktopPath)) return { error: 'bad_path' }
  // only an application MFM can actually list may be written to the association file
  const known = await listApps(file, true)
  if (!known.some((a) => a.id === desktopPath)) return { error: 'unknown_app' }
  const mime = mimeForPath(file)
  return new Promise((resolve) => {
    execFile(
      'xdg-mime',
      ['default', path.basename(desktopPath), mime],
      { timeout: 4000 },
      (err, _out, stderr) => {
        if (err) resolve({ error: String(stderr || err.message || 'failed').trim() })
        else resolve({ ok: true })
      }
    )
  })
}

/** Start an app and resolve as soon as the process exists; it is not waited on. */
export async function launchApp(
  id: string,
  file: string
): Promise<{ ok: true } | { error: string }> {
  if (process.platform === 'win32') return launchAppWindows(id, file)
  if (process.platform === 'darwin') {
    if (!path.isAbsolute(id) || !id.endsWith('.app')) return { error: 'app_not_found' }
    return launchArgvDetached(['open', '-a', id, file])
  }
  const entry = parseDesktopEntry(await fs.readFile(id, 'utf8').catch(() => ''))
  if (!entry['Exec']) return { error: 'app_not_found' }
  const argv = execFor(entry['Exec'], file)
  if (!argv.length) return { error: 'app_not_found' }
  try {
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
    return { ok: true }
  } catch {
    return { error: 'launch_failed' }
  }
}

const launchArgvDetached = (argv: string[]): { ok: true } | { error: string } => {
  if (!argv.length) return { error: 'app_not_found' }
  try {
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
    return { ok: true }
  } catch {
    return { error: 'launch_failed' }
  }
}

const launchAppWindows = async (
  id: string,
  file: string
): Promise<{ ok: true } | { error: string }> => {
  // a Start-menu entry (Store apps included) opens through the shell namespace
  if (id.startsWith('appid:')) {
    const appId = id.slice(6)
    if (!appId) return { error: 'app_not_found' }
    return launchArgvDetached(['explorer.exe', `shell:AppsFolder\\${appId}`])
  }
  // an `IAssocHandler` from Explorer's list: only the shell can start a packaged app with the file
  if (id.startsWith('assoc:')) {
    const name = id.slice(6)
    if (!name) return { error: 'app_not_found' }
    const raw = (await runPowerShellFile(WIN_ASSOC_INVOKE_SCRIPT, { MFM_ASSOC: name, MFM_FILE: file })).trim()
    return raw === 'ok' ? { ok: true } : { error: 'launch_failed' }
  }
  if (!id.startsWith('progid:') && !id.startsWith('exe:')) return { error: 'app_not_found' }
  let command = WIN_CACHE.get(id) ?? ''
  if (!command && id.startsWith('progid:')) {
    const raw = await runPowerShell(WIN_PROGID_SCRIPT, { MFM_PROGID: id.slice(7) })
    try {
      const parsed = JSON.parse(raw || '{}') as { command?: string }
      command = typeof parsed.command === 'string' ? parsed.command : ''
    } catch {
      command = ''
    }
  }
  if (!command && id.startsWith('exe:')) {
    const raw = await runPowerShell(WIN_EXE_SCRIPT, { MFM_EXE: id.slice(4) })
    try {
      const parsed = JSON.parse(raw || '{}') as { command?: string }
      command = typeof parsed.command === 'string' ? parsed.command : ''
    } catch {
      command = ''
    }
  }
  if (command) WIN_CACHE.set(id, command)
  if (!command) return { error: 'app_not_found' }
  return launchArgvDetached(windowsArgv(command, file))
}

/** Query whether max-file-manager is currently the default handler for inode/directory. */
export async function isDefaultFileManager(): Promise<boolean> {
  if (process.platform === 'linux') {
    const current = await defaultDesktopName('inode/directory')
    return current.includes('max-file-manager') || current.includes('mfm')
  }
  if (process.platform === 'win32') {
    const defaults = await Promise.all(WIN_FOLDER_CLASSES.map(shellDefault))
    return defaults.every((d) => d === WIN_FM_VERB)
  }
  return false
}

// ── Windows: folders open in this app ─────────────────────────────────────────────────────
// A double-click on a folder (desktop included) is a ShellExecute on the folder's class, so the
// per-user HKCU handler wins. Explorer windows still navigate in place — that is Explorer's own
// behaviour and not something a registry handler can change.
const WIN_FOLDER_CLASSES = ['Folder', 'Directory', 'Drive'] as const
const WIN_FM_VERB = 'MaxFileManager'

/** `"app.exe" "%1"`, or `"electron.exe" "<appDir>" "%1"` when running from a checkout. */
export function windowsFileManagerCommand(exe: string, appDir: string, packaged: boolean): string {
  const q = (s: string): string => `"${s}"`
  return packaged ? `${q(exe)} "%1"` : `${q(exe)} ${q(appDir)} "%1"`
}

const reg = (args: string[]): Promise<{ ok: boolean; out: string }> =>
  new Promise((resolve) => {
    try {
      execFile('reg.exe', args, { timeout: 5000, windowsHide: true }, (err, out) =>
        resolve({ ok: !err, out: String(out ?? '') })
      )
    } catch {
      resolve({ ok: false, out: '' })
    }
  })

/** The class's own default verb, '' when the value does not exist. */
const shellDefault = async (cls: string): Promise<string> => {
  const r = await reg(['query', `HKCU\\Software\\Classes\\${cls}\\shell`, '/ve'])
  const m = r.out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)
  return m ? m[1].trim() : ''
}

/**
 * Registers the folder verb in HKCU and makes it the class default. The previous defaults come
 * back so the caller can store them and undo the change exactly.
 */
export async function setDefaultFileManagerWindows(
  exe: string,
  appDir: string,
  packaged: boolean
): Promise<{ ok: boolean; error?: string; previous?: Record<string, string> }> {
  if (!path.isAbsolute(exe)) return { ok: false, error: 'bad_path' }
  const command = windowsFileManagerCommand(exe, appDir, packaged)
  const previous: Record<string, string> = {}
  for (const cls of WIN_FOLDER_CLASSES) {
    previous[cls] = await shellDefault(cls)
    const base = `HKCU\\Software\\Classes\\${cls}\\shell`
    const verb = `${base}\\${WIN_FM_VERB}`
    const steps = [
      ['add', verb, '/ve', '/d', 'Open with Max File Manager', '/f'],
      ['add', `${verb}\\command`, '/ve', '/d', command, '/f'],
      ['add', base, '/ve', '/d', WIN_FM_VERB, '/f']
    ]
    for (const step of steps) {
      if (!(await reg(step)).ok) return { ok: false, error: 'reg_failed', previous }
    }
  }
  return { ok: true, previous }
}

/** The standard Explorer command for a folder; `%SystemRoot%` needs REG_EXPAND_SZ. */
const WIN_EXPLORER_OPEN = '"%SystemRoot%\\Explorer.exe" "%1"'

/**
 * Some tweak tools leave `Directory\shell` with the literal default verb `none` and no `open`
 * command at all — every folder then fails with «Application not found». Restoring that value
 * would keep the machine broken, so the undo writes a working Explorer verb instead.
 */
async function repairFolderOpen(cls: string): Promise<void> {
  const probe = await reg(['query', `HKCR\\${cls}\\shell\\open\\command`, '/ve'])
  if (!probe.ok) {
    await reg([
      'add',
      `HKCU\\Software\\Classes\\${cls}\\shell\\open\\command`,
      '/ve',
      '/t',
      'REG_EXPAND_SZ',
      '/d',
      WIN_EXPLORER_OPEN,
      '/f'
    ])
  }
  await reg(['add', `HKCU\\Software\\Classes\\${cls}\\shell`, '/ve', '/d', 'open', '/f'])
}

/** Undo: drop the verb and give each class its old default back (empty → remove the value). */
export async function clearDefaultFileManagerWindows(
  previous: Record<string, string> | null
): Promise<{ ok: boolean }> {
  for (const cls of WIN_FOLDER_CLASSES) {
    const base = `HKCU\\Software\\Classes\\${cls}\\shell`
    await reg(['delete', `${base}\\${WIN_FM_VERB}`, '/f'])
    const was = previous?.[cls] ?? ''
    if (was && was !== WIN_FM_VERB && was !== 'none') await reg(['add', base, '/ve', '/d', was, '/f'])
    else await repairFolderOpen(cls)
  }
  return { ok: true }
}

/** Set max-file-manager as the system default file manager (folder handler). */
export async function setDefaultFileManager(
  execPath?: string,
  appPath?: string,
  packaged = true
): Promise<{ ok: boolean; error?: string; previous?: Record<string, string> }> {
  if (process.platform === 'win32') {
    const exe = execPath || process.execPath
    const dir = appPath || process.cwd()
    return setDefaultFileManagerWindows(exe, dir, packaged)
  }
  if (process.platform === 'linux') {
    const home = os.homedir()
    const appDir = path.join(home, '.local', 'share', 'applications')
    const desktopFile = path.join(appDir, 'max-file-manager.desktop')
    const bin = execPath || process.execPath
    const dir = appPath || process.cwd()
    const iconPath = path.join(dir, 'build', 'icon.png')
    const content = `[Desktop Entry]
Type=Application
Version=1.0
Name=مدیر فایل مکس
Name[en]=Max File Manager
Comment=File manager (dual pane, tabs, sync)
Comment[en]=Dual-pane file manager
Exec=${bin} ${dir} %U
Icon=${iconPath}
Terminal=false
Categories=System;FileManager;Utility;
MimeType=inode/directory;x-scheme-handler/file;application/x-gnome-saved-search;
Keywords=files;manager;explorer;
StartupNotify=true
StartupWMClass=max-file-manager
`
    await fs.mkdir(appDir, { recursive: true }).catch(() => {})
    await fs.writeFile(desktopFile, content, 'utf8').catch(() => {})

    // Install org.freedesktop.FileManager1 DBus services so Firefox, Chrome, etc. use max-file-manager
    const dbusDir = path.join(home, '.local', 'share', 'dbus-1', 'services')
    const bridgeScript = path.join(dir, 'src', 'main', 'filemanager1-bridge.py')
    if (await fs.access(bridgeScript).then(() => true, () => false)) {
      await fs.mkdir(dbusDir, { recursive: true }).catch(() => {})
      const srvContent = `[D-BUS Service]\nName=org.freedesktop.FileManager1\nExec=${bridgeScript}\n`
      await fs.writeFile(path.join(dbusDir, 'org.freedesktop.FileManager1.service'), srvContent, 'utf8').catch(() => {})
      await fs.writeFile(path.join(dbusDir, 'org.kde.dolphin.FileManager1.service'), srvContent, 'utf8').catch(() => {})

      // Mask & stop plasma-dolphin.service if on KDE so it does not intercept FileManager1
      execFile('systemctl', ['--user', 'stop', 'plasma-dolphin.service'], { timeout: 2000 }, () => {})
      execFile('systemctl', ['--user', 'mask', 'plasma-dolphin.service'], { timeout: 2000 }, () => {})

      // Start the bridge in background
      try {
        const child = spawn(bridgeScript, [], { detached: true, stdio: 'ignore' })
        child.unref()
      } catch {}
    }

    return new Promise((resolve) => {
      execFile(
        'xdg-mime',
        ['default', 'max-file-manager.desktop', 'inode/directory'],
        { timeout: 5000 },
        (err) => {
          if (err) {
            resolve({ ok: false, error: err.message })
            return
          }
          execFile(
            'xdg-mime',
            ['default', 'max-file-manager.desktop', 'x-scheme-handler/file'],
            { timeout: 3000 },
            () => resolve({ ok: true })
          )
        }
      )
    })
  }
  return { ok: false, error: 'پشتیبانی فقط روی لینوکس و ویندوز فعال است' }
}





