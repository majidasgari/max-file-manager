/**
 * File list on the system clipboard.
 * On Wayland, standard unfocused processes cannot write the clipboard via wl_data_device.
 * We use a dedicated helper (wayland-clip) utilizing ext-data-control / wlr-data-control,
 * which owns the selection with text/uri-list, x-special/gnome-copied-files, and
 * application/x-kde-cutselection. On X11, a detached PySide fallback owns the selection.
 * The helper stays alive and receives new paths over stdin.
 * Its pid is kept per profile so a new app run can retire a stale owner.
 * If neither helper is available, the paths go to the clipboard as plain text.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { EOL, tmpdir } from 'node:os'
import path from 'node:path'
import { app, clipboard } from 'electron'
import { mergeClipTexts, type ClipFiles } from '../shared/clip.ts'

/**
 * Windows gets a real file list (`CF_HDROP` + `Preferred DropEffect`), which Electron's clipboard
 * cannot write, so a short PowerShell script builds the DataObject. It runs with `windowsHide` and
 * `-WindowStyle Hidden`: a console window flashing on every Ctrl+X is not acceptable, and the
 * `-WindowStyle` flag alone still flashes because it is applied after the console is created.
 */
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$paths = [System.IO.File]::ReadAllLines($env:MFM_CLIP_LIST, [System.Text.Encoding]::UTF8) | Where-Object { $_ -ne '' }
if (-not $paths.Count) { Write-Output 'empty'; exit 1 }
$list = New-Object System.Collections.Specialized.StringCollection
foreach ($p in $paths) { [void]$list.Add($p) }
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($list)
# 2 = move (cut), 1 = copy: Explorer decides on paste from this value
$effect = if ($env:MFM_CLIP_CUT -eq '1') { 2 } else { 1 }
$data.SetData('Preferred DropEffect', [byte[]]@($effect, 0, 0, 0))
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
Write-Output 'ok'
`

const SCRIPT = String.raw`
import sys, json, select
from PySide6.QtCore import QMimeData, QTimer, QUrl
from PySide6.QtWidgets import QApplication
app = QApplication([])
cb = app.clipboard()
def apply(msg):
    if msg.get('clear'):
        cb.clear()
        return
    paths = [p for p in (msg.get('paths') or []) if p]
    urls = [QUrl.fromLocalFile(p) for p in paths]
    md = QMimeData()
    md.setUrls(urls)
    if urls:
        cut = bool(msg.get('cut'))
        md.setData('x-special/gnome-copied-files', (('cut' if cut else 'copy') + '\n' + '\n'.join(u.toString() for u in urls)).encode())
        md.setData('application/x-kde-cutselection', b'1' if cut else b'0')
    cb.setMimeData(md)
def poll():
    while select.select([sys.stdin], [], [], 0)[0]:
        line = sys.stdin.readline()
        if not line:
            return  # the app went away; keep owning the selection until the timer fires
        try:
            apply(json.loads(line))
            print('ok', flush=True)
        except Exception as e:
            print('err', str(e), flush=True)
t = QTimer()
t.timeout.connect(poll)
t.start(40)
print('ready', flush=True)
QTimer.singleShot(600000, app.quit)
app.exec()
`

let child: ChildProcess | null = null
let starting: Promise<boolean> | null = null
let ack: (() => void) | null = null
let out = ''

const ownerFile = () => path.join(app.getPath('userData'), 'clipboard-owner')

const isOurHelper = (pid: number): boolean => {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return cmd.includes('wayland-clip') || cmd.includes('PySide6')
  } catch {
    return false
  }
}

function findWaylandBinary(): string | null {
  const candidates = [
    path.join(__dirname, 'wayland-clip'),
    path.join(__dirname, 'wayland-clip', 'wayland-clip'),
    path.join(app.getAppPath(), 'out', 'main', 'wayland-clip'),
    path.join(app.getAppPath(), 'src', 'main', 'wayland-clip', 'wayland-clip')
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

/** Retire an owner left by an earlier run (the pid file is per profile). */
function killOwner(): void {
  try {
    const pid = Number(readFileSync(ownerFile(), 'utf8'))
    if (Number.isInteger(pid) && pid > 0 && isOurHelper(pid)) process.kill(pid, 'SIGTERM')
  } catch {
    // no live owner
  }
  try {
    rmSync(ownerFile(), { force: true })
  } catch {
    // ignore
  }
}

function startHelper(): Promise<boolean> {
  if (child) return Promise.resolve(true)
  if (starting) return starting
  starting = new Promise<boolean>((resolve) => {
    let proc: ChildProcess | null = null
    const waylandBin = process.env.WAYLAND_DISPLAY ? findWaylandBinary() : null

    if (waylandBin) {
      try {
        proc = spawn(waylandBin, [], {
          detached: true,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore']
        })
      } catch {
        proc = null
      }
    }

    if (!proc) {
      try {
        proc = spawn('python3', ['-c', SCRIPT], {
          detached: true,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore']
        })
      } catch {
        starting = null
        resolve(false)
        return
      }
    }

    child = proc
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      starting = null
      resolve(ok)
    }

    proc.stdout?.on('data', (buf: Buffer) => {
      out += String(buf)
      for (;;) {
        const nl = out.indexOf('\n')
        if (nl < 0) break
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        if (line === 'ready') {
          try {
            writeFileSync(ownerFile(), String(proc?.pid ?? ''))
          } catch {
            // the clipboard works without the pid file
          }
          done(true)
        } else if (line === 'ok' || line === 'err') {
          ack?.()
          ack = null
        }
      }
    })

    proc.once('error', () => {
      child = null
      done(false)
    })
    proc.once('exit', () => {
      child = null
      done(false)
    })
    setTimeout(() => done(true), 4000)
  })
  return starting
}

async function send(msg: Record<string, unknown>): Promise<boolean> {
  if (!child) {
    killOwner()
    if (!(await startHelper()) || !child) return false
  }
  const proc = child
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      ack = null
      resolve(ok)
    }
    ack = () => finish(true)
    try {
      proc.stdin?.write(JSON.stringify(msg) + '\n')
    } catch {
      finish(false)
      return
    }
    setTimeout(() => finish(false), 5000)
  })
}

/** Windows: real files on the clipboard through a hidden PowerShell — never a console window. */
function copyFilesWindows(paths: string[], cut: boolean): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let dir = ''
    try {
      dir = mkdtempSync(path.join(tmpdir(), 'mfm-clip-'))
      writeFileSync(path.join(dir, 'paths.txt'), paths.join(EOL), 'utf8')
    } catch (e) {
      console.error('MFM file clipboard: temp list failed', e)
      resolve(false)
      return
    }
    const cleanup = (): void => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // a leftover temp dir is harmless
      }
    }
    let proc: ChildProcess
    try {
      proc = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-Command',
          WINDOWS_SCRIPT
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, MFM_CLIP_LIST: path.join(dir, 'paths.txt'), MFM_CLIP_CUT: cut ? '1' : '0' }
        }
      )
    } catch {
      cleanup()
      resolve(false)
      return
    }
    let out = ''
    let err = ''
    let settled = false
    proc.stdout?.on('data', (buf: Buffer) => {
      out += String(buf)
    })
    proc.stderr?.on('data', (buf: Buffer) => {
      err += String(buf)
    })
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      if (!ok) console.error('MFM file clipboard:', (err || out || 'powershell failed').trim().slice(0, 400))
      resolve(ok)
    }
    proc.once('error', () => finish(false))
    proc.once('exit', (code) => finish(code === 0 && out.includes('ok')))
    setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // already gone
      }
      finish(false)
    }, 5000)
  })
}

/** Explorer's CF_HDROP read back: the intent line first (`cut`/`copy`), then one path per line. */
const WINDOWS_READ = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$list = [System.Windows.Forms.Clipboard]::GetFileDropList()
if (-not $list -or $list.Count -eq 0) { exit 0 }
$eff = [System.Windows.Forms.Clipboard]::GetData('Preferred DropEffect')
if ($eff -and $eff.Length -ge 1 -and $eff[0] -eq 2) { Write-Output 'cut' } else { Write-Output 'copy' }
foreach ($p in $list) { Write-Output $p }
`

function readFilesWindows(): Promise<string> {
  return new Promise<string>((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-Command',
          WINDOWS_READ
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch {
      resolve('')
      return
    }
    let text = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve(text.trim())
    }
    proc.stdout?.on('data', (buf: Buffer) => {
      text += String(buf)
    })
    proc.once('error', finish)
    proc.once('exit', finish)
    setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // already gone
      }
      finish()
    }, 6000)
  })
}

/**
 * Files another application put on the clipboard, so pasting after a copy in Explorer, Finder or
 * Dolphin behaves like the in-app clipboard. `cut` is honoured only where the platform records it
 * (GNOME's header line, Windows' `Preferred DropEffect`); everywhere else it is a plain copy.
 */
export async function readClipboardFiles(): Promise<ClipFiles> {
  if (process.platform === 'win32') return mergeClipTexts([await readFilesWindows()])
  const texts: string[] = []
  try {
    for (const item of await clipboard.read()) {
      for (const type of item.types ?? []) {
        if (!/uri-list|file-url|copied-files|kde-cutselection/i.test(type)) continue
        const one = await item.getType(type)
        if (typeof one === 'string') texts.push(one)
        else if (one instanceof Blob) texts.push(await one.text())
      }
    }
    // some desktops expose a file list only as newline separated paths
    if (!texts.length) texts.push(await clipboard.readText())
  } catch {
    // an unreadable clipboard is an empty one
  }
  return mergeClipTexts(texts)
}

/** Resolves to `files` only after the helper confirms that the selection is set. */
export async function copyFilesToClipboard(paths: string[], cut = false): Promise<'files' | 'text'> {
  const list = paths.filter((p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p))
  if (!list.length) return 'text'
  if (process.platform === 'win32') {
    // Explorer (or a hung shell drag) can hold the clipboard open for a moment and make every
    // write fail with "access denied", so one dead attempt is not a dead copy
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await copyFilesWindows(list, cut)) return 'files'
      await new Promise((r) => setTimeout(r, 250))
    }
    clipboard.writeText(list.join('\n'))
    return 'text'
  }
  if (await send({ paths: list, cut })) return 'files'
  clipboard.writeText(list.join('\n'))
  return 'text'
}

/** Clear a file-list selection before the renderer writes an image (the helper stays alive). */
export function releaseFileClipboard(): void {
  if (child) {
    try {
      child.stdin?.write(JSON.stringify({ clear: true }) + '\n')
    } catch {
      // ignore
    }
  } else {
    killOwner()
  }
}

export function stopFileClipboard(): void {
  child?.kill()
  child = null
}
