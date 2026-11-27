import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The folder/file the app was asked to open.
 *
 * The desktop launcher runs `electron <appDir> %U`, so argv[1] is the app itself — the old code
 * treated it as the target and every double-clicked folder landed on the app directory. The first
 * argument is ignored only when it *is* the app path, so explicitly opening the app's own folder
 * still works through the second (real) argument.
 */
export function targetPath(argv: string[], appPath: string): string | null {
  const target = openTarget(argv, appPath)
  return target?.kind === 'path' ? target.value : null
}

/**
 * What the app was asked to open: a real path, or a Windows *shell namespace* target — the Control
 * Panel (`::{26EE0668-A00A-44D7-9371-BEB064C98683}`), This PC, the Recycle Bin, a packaged app's
 * folder (`shell:AppsFolder\…`) — which has no file-system path behind it at all.
 *
 * The second kind only ever arrives on Windows, and it arrives exactly when this app owns the
 * folder verb in `HKCU\Software\Classes\Folder\shell`: ShellExecute on a double-clicked folder is
 * what Windows uses for a double-clicked *special* folder too, so opening the Control Panel while
 * this app is the system file manager launched the app with the CLSID as its only argument. Such a
 * target is handed back to Explorer instead of being accepted (see `openShellNamespace`).
 */
export type OpenTarget = { kind: 'path'; value: string } | { kind: 'shell'; value: string }

/** `::{CLSID}`, `::{CLSID}\child`, `shell:…` — never a file-system path. */
export function shellNamespaceTarget(arg: string): string | null {
  let value = String(arg ?? '').trim()
  // a shell handler may quote the argument for us; `%1` normally arrives bare
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).trim()
  if (!/^(?:::|shell:)/i.test(value)) return null
  return value
}

export function openTarget(argv: string[], appPath: string): OpenTarget | null {
  const app = path.resolve(appPath)
  let skippedApp = false
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue
    const shellTarget = shellNamespaceTarget(arg)
    if (shellTarget) return { kind: 'shell', value: shellTarget }
    let p: string | null = null
    if (arg.startsWith('file://')) {
      try {
        p = fileURLToPath(arg)
      } catch {
        continue
      }
    } else if (path.isAbsolute(arg)) {
      p = arg
    }
    if (!p) continue
    if (!skippedApp && path.resolve(p) === app) {
      skippedApp = true
      continue
    }
    return { kind: 'path', value: p }
  }
  return null
}
