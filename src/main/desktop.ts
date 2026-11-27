import { spawn } from 'node:child_process'
import path from 'node:path'
import { nativeImage, shell, type WebContents } from 'electron'
import { selectCommand } from './reveal-core.ts'
import { hasBin } from './terminals.ts'

/**
 * Shows the file inside the system's own file manager, with the file selected.
 *
 * `shell.showItemInFolder` goes through `org.freedesktop.FileManager1`, which only opens the folder
 * (and here the app's own bridge answers that name), so the start is done directly — see reveal-core.
 */
export function revealFile(p: string): { ok: true } | { error: string } {
  if (!path.isAbsolute(p)) return { error: 'مسیر نامعتبر' }
  const pick =
    process.platform === 'linux'
      ? selectCommand(p, process.env['XDG_CURRENT_DESKTOP'] ?? '', hasBin)
      : null
  if (pick) {
    const child = spawn(pick.cmd, pick.args, { detached: true, stdio: 'ignore' })
    // the binary was checked just now; if it vanished in between there is nothing left to do
    child.on('error', () => {})
    child.unref()
    return { ok: true }
  }
  shell.showItemInFolder(p)
  return { ok: true }
}

let dragIcon: Electron.NativeImage | null = null

/**
 * Hands a Windows *shell namespace* target back to Explorer.
 *
 * «::{CLSID}» (Control Panel, This PC, the Recycle Bin, a packaged app's folder) has no
 * file-system path behind it, so the panes cannot list it. It is not opened with
 * `shell.openPath`/`ShellExecute` either: while this app owns the folder verb that call comes
 * straight back here (see `openTarget`). `explorer.exe <target>` is the one route the shell
 * resolves for itself, so the Control Panel really opens in the Control Panel.
 */
export function openShellNamespace(target: string): { ok: true } | { error: string } {
  if (process.platform !== 'win32') return { error: 'windows only' }
  const t = String(target ?? '').trim()
  if (!/^(?:::|shell:)/i.test(t)) return { error: 'مسیر نامعتبر' }
  try {
    // `/n,` is the form Explorer reads as a real navigation: a bare `explorer.exe ::{CLSID}` opens a
    // window that never shows (measured: six hidden «Control Panel» windows in explorer.exe and no
    // visible one), while `/n,::{CLSID}` gives exactly one visible window.
    const child = spawn('explorer.exe', [`/n,${t}`], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** The Control Panel's own CLSID: what a «Control Panel» link hands over on Windows. */
export const WINDOWS_CONTROL_PANEL = '::{26EE0668-A00A-44D7-9371-BEB064C98683}'

/**
 * Starts a real OS drag so the file can be dropped into Dolphin, a chat window, an upload field…
 * Called from `ipcRenderer.send` during `dragstart`.
 */
export function startFileDrag(wc: WebContents, files: string[]): { ok: true } | { error: string } {
  if (wc.isDestroyed()) return { error: 'پنجره بسته شده' }
  const list = files.filter((f) => path.isAbsolute(f))
  if (!list.length) return { error: 'مسیر نامعتبر' }
  if (!dragIcon) {
    // a 32×32 dot is enough: the target app draws the file, the cursor only needs an image
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAMklEQVR4nOzOMQ0AMAgAMLLMJAbRgiuQwdMq6J/KjkMvjgkICAgICAgICAgICAgICCwAAAD//1rIWFMAAAAGSURBVAMA+XwDCUIWSBAAAAAASUVORK5CYII=',
      'base64'
    )
    dragIcon = nativeImage.createFromBuffer(png)
  }
  // `file` is required by Electron; `files` carries a multi-selection. Passing only `files`
  // is rejected by the type and by the runtime.
  try {
    wc.startDrag({ file: list[0], files: list, icon: dragIcon })
    return { ok: true }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Executes a custom command in the background with %f substituted by the quoted file/folder path.
 * Detached and unreferenced so GUI apps and background jobs run independently.
 */
export async function runCustomCommand(
  cmdTemplate: string,
  targetPath: string
): Promise<{ ok: true } | { error: string }> {
  const cmd = String(cmdTemplate ?? '').trim()
  if (!cmd) return { error: 'دستوری تعریف نشده' }
  if (!path.isAbsolute(targetPath)) return { error: 'مسیر نامعتبر' }

  const isWin = process.platform === 'win32'
  const quote = (p: string) => (isWin ? `"${p.replace(/"/g, '""')}"` : `'${p.replace(/'/g, `'\\''`)}'`)
  const quoted = quote(targetPath)
  const dir = path.dirname(targetPath)
  const quotedDir = quote(dir)

  let line = cmd
  if (line.includes('%f') || line.includes('{path}')) {
    line = line.replace(/%f|\{path\}/g, quoted)
  } else {
    line = `${line} ${quoted}`
  }
  line = line.replace(/%d|\{dir\}/g, quotedDir)

  return new Promise((resolve) => {
    try {
      const child = isWin
        ? spawn('cmd.exe', ['/c', line], {
            cwd: dir,
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          })
        : spawn('sh', ['-c', line], {
            cwd: dir,
            detached: true,
            stdio: 'ignore'
          })
      child.once('error', (e: Error) => resolve({ error: e.message }))
      child.once('spawn', () => {
        child.unref()
        resolve({ ok: true })
      })
    } catch (e) {
      resolve({ error: e instanceof Error ? e.message : String(e) })
    }
  })
}
