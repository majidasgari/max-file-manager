import { contextBridge, ipcRenderer, webUtils } from 'electron'

// mcp:ui messages are buffered until the renderer subscribes, so an early agent call is not lost
let uiListener: ((msg: unknown) => void) | null = null
const uiQueue: unknown[] = []
ipcRenderer.on('mcp:ui', (_e, msg) => {
  if (uiListener) uiListener(msg)
  else uiQueue.push(msg)
})

// The whole main-process surface. Nothing else crosses the boundary.
contextBridge.exposeInMainWorld('api', {
  portal: {
    request: () => ipcRenderer.invoke('portal:request'),
    respond: (result: unknown) => ipcRenderer.invoke('portal:respond', result),
    rememberDir: (dir: string) => ipcRenderer.invoke('portal:rememberDir', dir),
    status: () => ipcRenderer.invoke('portal:status'),
    configure: (enabled: boolean) => ipcRenderer.invoke('portal:configure', enabled)
  },
  list: (dir: string, showHidden: boolean, dims = false) =>
    ipcRenderer.invoke('fs:list', dir, showHidden, dims),
  /** Watch the folders on screen; main sends `fs:changed` when one of them changes on disk. */
  watchDirs: (dirs: string[]) => ipcRenderer.invoke('fs:watch', dirs),
  onFsChange: (cb: (dir: string) => void) => {
    const fn = (_e: unknown, dir: string) => cb(dir)
    ipcRenderer.on('fs:changed', fn)
    return () => ipcRenderer.removeListener('fs:changed', fn)
  },
  statfs: (p: string) => ipcRenderer.invoke('fs:statfs', p),
  breakdown: (path: string, mode?: string) => ipcRenderer.invoke('fs:breakdown', { path, mode }),
  debugLog: (msg: string) => ipcRenderer.invoke('debug:log', String(msg)),
  chmod: (p: string, mode: number) => ipcRenderer.invoke('fs:chmod', { path: p, mode }),
  properties: (p: string) => ipcRenderer.invoke('fs:properties', p),
  imageData: (p: string) => ipcRenderer.invoke('fs:imageData', p),
  readBytes: (p: string, max?: number) => ipcRenderer.invoke('fs:readBytes', { path: p, max }),
  saveImage: (src: string, dataUrl: string, mode: string) =>
    ipcRenderer.invoke('image:save', { src, dataUrl, mode }),
  dirs: (dir: string, showHidden = false, followLinks = false) =>
    ipcRenderer.invoke('fs:dirs', dir, showHidden, followLinks),
  roots: () => ipcRenderer.invoke('fs:roots'),
  home: () => ipcRenderer.invoke('fs:home'),
  size: (p: string) => ipcRenderer.invoke('fs:size', p),
  remove: (paths: string[], permanent: boolean) =>
    ipcRenderer.invoke('fs:remove', { paths, permanent }),
  walk: (dir: string, opts: unknown) => ipcRenderer.invoke('fs:walk', dir, opts),
  dupes: (dir: string) => ipcRenderer.invoke('fs:dupes', dir),
  archive: (p: string) => ipcRenderer.invoke('fs:archive', p),
  registerHotkey: (accel: string) => ipcRenderer.invoke('hotkey:register', accel),
  runScript: (command: string, path?: string, dir?: string) =>
    ipcRenderer.invoke('app:runScript', { command, path, dir }),
  runCustomCommand: (command: string, path: string) =>
    ipcRenderer.invoke('app:runCustomCommand', { command, path }),
  openTerminal: (dir: string) => ipcRenderer.invoke('app:terminal', dir),
  reveal: (path: string) => ipcRenderer.invoke('app:reveal', path),
  isDefaultFileManager: () => ipcRenderer.invoke('desktop:isDefaultFileManager'),
  setDefaultFileManager: () => ipcRenderer.invoke('desktop:setDefaultFileManager'),
  dragOut: (files: string[]) => ipcRenderer.send('app:dragOut', files),
  clearThumbs: () => ipcRenderer.invoke('thumbs:clear'),
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    configure: (patch: unknown) => ipcRenderer.invoke('mcp:configure', patch),
    token: () => ipcRenderer.invoke('mcp:token'),
    // buffered here: an agent may call before the window has mounted its listener
    onUi: (cb: (msg: unknown) => void) => {
      uiListener = cb
      for (const m of uiQueue.splice(0)) cb(m)
      return () => {
        if (uiListener === cb) uiListener = null
      }
    }
  },
  drives: {
    list: () => ipcRenderer.invoke('drives:list'),
    mount: (device: string) => ipcRenderer.invoke('drives:mount', device),
    unmount: (deviceOrMount: string) => ipcRenderer.invoke('drives:unmount', deviceOrMount)
  },
  update: {
    check: (force?: boolean) => ipcRenderer.invoke('update:check', force),
    open: (url: string) => ipcRenderer.invoke('update:open', url)
  },
  search: {
    index: (cfg: unknown) => ipcRenderer.invoke('search:index', cfg),
    query: (query: string, limit?: number) => ipcRenderer.invoke('search:query', { query, limit }),
    stats: () => ipcRenderer.invoke('search:stats'),
    status: () => ipcRenderer.invoke('search:status'),
    sizes: (dirs: string[]) => ipcRenderer.invoke('search:sizes', dirs),
    clear: () => ipcRenderer.invoke('search:clear'),
    onProgress: (cb: (p: unknown) => void) => {
      const fn = (_e: unknown, p: unknown) => cb(p)
      ipcRenderer.on('search:progress', fn)
      return () => ipcRenderer.removeListener('search:progress', fn)
    }
  },
  settings: {
    export: (prefs: unknown) => ipcRenderer.invoke('settings:export', { prefs }),
    import: () => ipcRenderer.invoke('settings:import')
  },
  tags: (paths: string[]) => ipcRenderer.invoke('fs:tags', paths),
  writeTags: (path: string, fields: unknown) => ipcRenderer.invoke('meta:writeTags', { path, fields }),
  saveImageAs: (src: string, dataUrl: string) => ipcRenderer.invoke('image:saveAs', { src, dataUrl }),
  convertImages: (files: string[], opts: unknown) =>
    ipcRenderer.invoke('image:batchConvert', { files, opts }),
  exportListing: (dir: string, name: string, rows: unknown, format: string, theme?: string) =>
    ipcRenderer.invoke('export:listing', { dir, name, rows, format, theme }),
  syncCompare: (left: string, right: string, opts?: unknown) =>
    ipcRenderer.invoke('sync:compare', { left, right, ...(opts as object) }),
  syncApply: (left: string, right: string, rows: unknown, mode: string, deleteExtra?: boolean) =>
    ipcRenderer.invoke('sync:apply', { left, right, rows, mode, deleteExtra }),
  diffFiles: (a: string, b: string) => ipcRenderer.invoke('fs:diff', { a, b }),
  readText: (p: string) => ipcRenderer.invoke('fs:readText', p),
  drafts: {
    get: (p: string) => ipcRenderer.invoke('drafts:get', p),
    set: (path: string, text: string) => ipcRenderer.invoke('drafts:set', { path, text }),
    clear: (p: string) => ipcRenderer.invoke('drafts:clear', p)
  },
  writeText: (path: string, text: string) => ipcRenderer.invoke('fs:writeText', { path, text }),
  htmlToPdf: (html: string, out: string, theme?: string) =>
    ipcRenderer.invoke('pdf:html', { html, out, theme }),
  createArchive: (dir: string, name: string, sources: string[], level?: number) =>
    ipcRenderer.invoke('fs:archiveCreate', { dir, name, sources, level }),
  extract: (archive: string, names: string[], dest: string) =>
    ipcRenderer.invoke('fs:extract', { archive, names, dest }),
  getMeta: (dir: string) => ipcRenderer.invoke('meta:get', dir),
  labelPalette: () => ipcRenderer.invoke('meta:labels'),
  setFormat: (dir: string, format: unknown) => ipcRenderer.invoke('meta:setFormat', { dir, format }),
  setRating: (dir: string, name: string, stars: number) =>
    ipcRenderer.invoke('meta:setRating', { dir, name, stars }),
  setNote: (dir: string, name: string, text: string) =>
    ipcRenderer.invoke('meta:setNote', { dir, name, text }),
  setLabel: (dir: string, name: string, label: string | null) =>
    ipcRenderer.invoke('meta:setLabel', { dir, name, label }),
  setEntryColor: (dir: string, name: string, color: string) =>
    ipcRenderer.invoke('meta:setEntryColor', { dir, name, color }),
  togglePin: (dir: string, name: string, on?: boolean) =>
    ipcRenderer.invoke('meta:togglePin', { dir, name, on }),
  setMeta: (dir: string, meta: unknown) => ipcRenderer.invoke('meta:set', { dir, meta }),
  iconThemes: (extra: string[]) => ipcRenderer.invoke('icons:themes', extra),
  iconsIn: (themeDir: string) => ipcRenderer.invoke('icons:in', themeDir),
  iconSet: () => ipcRenderer.invoke('icons:set'),
  folderLook: (p: string) => ipcRenderer.invoke('icons:folderLook', p),
  mkdir: (dir: string, name: string) => ipcRenderer.invoke('fs:mkdir', dir, name),
  createFile: (dir: string, name: string, content?: string) =>
    ipcRenderer.invoke('fs:createFile', dir, name, content),
  symlink: (target: string, linkPath: string) =>
    ipcRenderer.invoke('fs:symlink', target, linkPath),
  renameMany: (pairs: { from: string; to: string }[]) => ipcRenderer.invoke('fs:renameMany', pairs),
  open: (p: string) => ipcRenderer.invoke('shell:open', p),
  clipboard: {
    releaseFiles: () => ipcRenderer.invoke('clipboard:releaseFiles'),
    copyFiles: (paths: string[], cut = false) => ipcRenderer.invoke('clipboard:copyFiles', { paths, cut }),
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
    saveImage: (dir: string, name: string, data: Uint8Array) =>
      ipcRenderer.invoke('clipboard:saveImage', { dir, name, data })
  },
  apps: {
    list: (p: string) => ipcRenderer.invoke('apps:list', p),
    openWith: (p: string, all = false) => ipcRenderer.invoke('apps:openWith', { path: p, all }),
    setDefault: (p: string, id: string) => ipcRenderer.invoke('apps:setDefault', { path: p, id }),
    default: (p: string) => ipcRenderer.invoke('apps:default', p),
    launch: (id: string, p: string) => ipcRenderer.invoke('apps:launch', id, p)
  },
  preview: (p: string) => ipcRenderer.invoke('fs:preview', p),
  hash: (paths: string[], algo: string) => ipcRenderer.invoke('fs:hash', paths, algo),
  // a dropped File only becomes a path here, in preload
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  jobs: {
    start: (kind: string, sources: string[], dest: string, opts?: unknown) =>
      ipcRenderer.invoke('job:start', { kind, sources, dest, opts }),
    pause: (id: string) => ipcRenderer.invoke('job:pause', id),
    resume: (id: string) => ipcRenderer.invoke('job:resume', id),
    cancel: (id: string) => ipcRenderer.invoke('job:cancel', id),
    list: () => ipcRenderer.invoke('job:list'),
    clear: () => ipcRenderer.invoke('job:clear'),
    onUpdate: (cb: (job: unknown) => void) => {
      const fn = (_e: unknown, job: unknown) => cb(job)
      ipcRenderer.on('job:update', fn)
      return () => ipcRenderer.removeListener('job:update', fn)
    }
  },
  app: {
    onOpenPath: (cb: (p: string) => void) => {
      const fn = (_e: unknown, p: string) => cb(p)
      ipcRenderer.on('app:open-path', fn)
      return () => ipcRenderer.removeListener('app:open-path', fn)
    },
    launchPath: () => ipcRenderer.invoke('app:launchPath'),
    openViewer: (kind: 'gallery' | 'editor', file: string) =>
      ipcRenderer.invoke('app:openViewer', { kind, path: file })
  },
  undo: { run: () => ipcRenderer.invoke('undo:run'), depth: () => ipcRenderer.invoke('undo:depth') },
  window: {
    minimize: () => ipcRenderer.invoke('window:control', 'minimize'),
    maximize: () => ipcRenderer.invoke('window:control', 'maximize'),
    close: () => ipcRenderer.invoke('window:control', 'close'),
    isMaximized: () => ipcRenderer.invoke('window:isMax'),
    setFullscreen: (on: boolean) => ipcRenderer.invoke('window:fullscreen', on),
    getChrome: () => ipcRenderer.invoke('window:getChrome'),
    setChrome: (c: { customTitlebar: boolean; rounded: boolean }) =>
      ipcRenderer.invoke('window:setChrome', c),
    setTray: (a: { minimize: boolean; close: boolean; show: string; quit: string }) =>
      ipcRenderer.invoke('window:setTray', a),
    onMaximized: (cb: (max: boolean) => void) => {
      const fn = (_e: unknown, max: boolean) => cb(max)
      ipcRenderer.on('window:maximized', fn)
      return () => ipcRenderer.removeListener('window:maximized', fn)
    }
  },
  state: {
    get: () => ipcRenderer.invoke('state:get'),
    set: (s: unknown) => ipcRenderer.invoke('state:set', s),
    setPrefs: (prefs: unknown) => ipcRenderer.invoke('state:setPrefs', prefs),
    patchPrefs: (patch: Record<string, unknown>) => ipcRenderer.invoke('state:patchPrefs', patch),
    onPrefsPatch: (cb: (patch: Record<string, unknown>) => void) => {
      const fn = (_e: unknown, patch: Record<string, unknown>) => cb(patch)
      ipcRenderer.on('state:prefs-patch', fn)
      return () => ipcRenderer.removeListener('state:prefs-patch', fn)
    },
    marks: (change?: { path: string; on: boolean }) => ipcRenderer.invoke('state:marks', change),
    onMarks: (cb: (marks: string[]) => void) => {
      const fn = (_e: unknown, marks: string[]) => cb(marks)
      ipcRenderer.on('state:marks', fn)
      return () => ipcRenderer.removeListener('state:marks', fn)
    }
  }
})
