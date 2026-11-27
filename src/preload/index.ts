import { contextBridge, ipcRenderer, webUtils } from 'electron'

// mcp:ui messages are buffered until the renderer subscribes, so an early agent call is not lost
let uiListener: ((msg: unknown) => void) | null = null
const uiQueue: unknown[] = []
ipcRenderer.on('mcp:ui', (_e, msg) => {
  if (uiListener) uiListener(msg)
  else uiQueue.push(msg)
})

// The music window may mount after the main window's first push; keep the latest state here.
let musicStateListener: ((state: unknown) => void) | null = null
let lastMusicState: unknown = null
ipcRenderer.on('music:state', (_e, state) => {
  lastMusicState = state
  if (musicStateListener) musicStateListener(state)
})

// FFmpeg conversion can finish before the panel subscribes; buffer progress/done events.
let playerListener: ((msg: unknown) => void) | null = null
const playerQueue: unknown[] = []
ipcRenderer.on('player:event', (_e, msg) => {
  if (playerListener) playerListener(msg)
  else playerQueue.push(msg)
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
  wineTakeover: (on: boolean, autostart = false) => ipcRenderer.invoke('wine:takeover', on, autostart),
  platform: process.platform,
  desktop:
    process.env['XDG_CURRENT_DESKTOP'] ||
    process.env['XDG_SESSION_DESKTOP'] ||
    (process.env['KDE_FULL_SESSION'] ? 'KDE' : ''),
  runScript: (command: string, path?: string, dir?: string) =>
    ipcRenderer.invoke('app:runScript', { command, path, dir }),
  runCustomCommand: (command: string, path: string) =>
    ipcRenderer.invoke('app:runCustomCommand', { command, path }),
  openTerminal: (dir: string, shell?: string) => ipcRenderer.invoke('app:terminal', dir, shell),
  terminalOptions: () => ipcRenderer.invoke('app:terminalOptions'),
  // bundled fonts are renderer assets; these four only carry fonts the person imported
  fonts: {
    list: () => ipcRenderer.invoke('fonts:list'),
    read: (id: string) => ipcRenderer.invoke('fonts:read', String(id)),
    import: () => ipcRenderer.invoke('fonts:import'),
    remove: (id: string) => ipcRenderer.invoke('fonts:remove', String(id))
  },
  reveal: (path: string) => ipcRenderer.invoke('app:reveal', path),
  isDefaultFileManager: () => ipcRenderer.invoke('desktop:isDefaultFileManager'),
  /** Windows: the header's Control Panel link, opened by Explorer (a shell namespace has no path) */
  openControlPanel: () => ipcRenderer.invoke('desktop:openControlPanel'),
  setDefaultFileManager: () => ipcRenderer.invoke('desktop:setDefaultFileManager'),
  clearDefaultFileManager: () => ipcRenderer.invoke('desktop:clearDefaultFileManager'),
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
  remote: {
    profiles: () => ipcRenderer.invoke('remote:profiles'),
    save: (draft: unknown) => ipcRenderer.invoke('remote:save', draft),
    remove: (id: string) => ipcRenderer.invoke('remote:remove', id),
    test: (draft: unknown) => ipcRenderer.invoke('remote:test', draft),
    testSaved: (id: string) => ipcRenderer.invoke('remote:testSaved', id),
    uri: (id: string) => ipcRenderer.invoke('remote:uri', id),
    sshConfig: () => ipcRenderer.invoke('remote:sshConfig'),
    forgetHostKey: (id: string) => ipcRenderer.invoke('remote:forgetHostKey', id),
    clearCache: () => ipcRenderer.invoke('remote:clearCache')
  },
  drives: {
    list: () => ipcRenderer.invoke('drives:list'),
    volumes: () => ipcRenderer.invoke('drives:volumes'),
    mount: (device: string) => ipcRenderer.invoke('drives:mount', device),
    unmount: (deviceOrMount: string) => ipcRenderer.invoke('drives:unmount', deviceOrMount)
  },
  system: {
    memory: () => ipcRenderer.invoke('system:memory')
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
  audioRead: (paths: string[]) => ipcRenderer.invoke('meta:audioRead', paths),
  audioWrite: (req: unknown) => ipcRenderer.invoke('meta:audioWrite', req),
  audioDurations: (paths: string[]) => ipcRenderer.invoke('audio:durations', paths),
  saveImageAs: (src: string, dataUrl: string, dest?: string) =>
    ipcRenderer.invoke('image:saveAs', { src, dataUrl, dest }),
  convertImages: (files: string[], opts: unknown) =>
    ipcRenderer.invoke('image:batchConvert', { files, opts }),
  exportListing: (dir: string, name: string, rows: unknown, format: string, theme?: string) =>
    ipcRenderer.invoke('export:listing', { dir, name, rows, format, theme }),
  sync: {
    compare: (opts: unknown) => ipcRenderer.invoke('sync:compare', opts),
    plan: (opts: unknown) => ipcRenderer.invoke('sync:plan', opts),
    run: (opts: unknown) => ipcRenderer.invoke('sync:run', opts),
    jobs: () => ipcRenderer.invoke('sync:jobs'),
    saveJob: (job: unknown) => ipcRenderer.invoke('sync:jobSave', job),
    removeJob: (id: string) => ipcRenderer.invoke('sync:jobRemove', id),
    history: (limit?: number) => ipcRenderer.invoke('sync:history', limit),
    restore: (id: string, confirmRemote?: boolean) =>
      ipcRenderer.invoke('sync:restore', { id, confirmRemote }),
    status: () => ipcRenderer.invoke('sync:status'),
    cancel: (id?: string) => ipcRenderer.invoke('sync:cancel', id),
    pause: (id?: string) => ipcRenderer.invoke('sync:pause', id),
    resume: (id?: string) => ipcRenderer.invoke('sync:resume', id),
    clearBaseline: (left: string, right: string) =>
      ipcRenderer.invoke('sync:clearBaseline', { left, right }),
    secretSet: (id: string, value: string) => ipcRenderer.invoke('sync:secretSet', { id, value }),
    secretHas: (id: string) => ipcRenderer.invoke('sync:secretHas', id),
    secretRemove: (id: string) => ipcRenderer.invoke('sync:secretRemove', id),
    secretReveal: (id: string) => ipcRenderer.invoke('sync:secretReveal', id),
    keypair: () => ipcRenderer.invoke('sync:keypair'),
    recipientOf: (identity: string) => ipcRenderer.invoke('sync:recipientOf', identity),
    versionsAvailable: () => ipcRenderer.invoke('sync:versionsAvailable'),
    versions: (opts: unknown) => ipcRenderer.invoke('sync:versions', opts),
    versionsRestore: (repo: string, secretId: string, id: string) =>
      ipcRenderer.invoke('sync:versionsRestore', { repo, secretId, id }),
    onProgress: (cb: (p: unknown) => void) => {
      const fn = (_e: unknown, p: unknown) => cb(p)
      ipcRenderer.on('sync:progress', fn)
      return () => ipcRenderer.removeListener('sync:progress', fn)
    },
    onDone: (cb: (r: unknown) => void) => {
      const fn = (_e: unknown, r: unknown) => cb(r)
      ipcRenderer.on('sync:done', fn)
      return () => ipcRenderer.removeListener('sync:done', fn)
    },
    onJobs: (cb: (jobs: unknown) => void) => {
      const fn = (_e: unknown, jobs: unknown) => cb(jobs)
      ipcRenderer.on('sync:jobs', fn)
      return () => ipcRenderer.removeListener('sync:jobs', fn)
    }
  },
  cloud: {
    list: () => ipcRenderer.invoke('cloud:list'),
    accountSave: (draft: unknown) => ipcRenderer.invoke('cloud:accountSave', draft),
    accountRemove: (id: string) => ipcRenderer.invoke('cloud:accountRemove', id),
    browse: (accountId: string, path: string) => ipcRenderer.invoke('cloud:browse', { accountId, path }),
    folderCreate: (accountId: string, parent: string, name: string) =>
      ipcRenderer.invoke('cloud:folderCreate', { accountId, parent, name }),
    docs: (provider: string) => ipcRenderer.invoke('cloud:docs', provider),
    preview: (accountId: string, localPath: string, remoteId: string) =>
      ipcRenderer.invoke('cloud:preview', { accountId, localPath, remoteId }),
    bindingSave: (draft: unknown) => ipcRenderer.invoke('cloud:bindingSave', draft),
    bindingUpdate: (id: string, patch: unknown) => ipcRenderer.invoke('cloud:bindingUpdate', { id, patch }),
    bindingRemove: (id: string) => ipcRenderer.invoke('cloud:bindingRemove', id),
    syncNow: (id: string, confirm = false) => ipcRenderer.invoke('cloud:syncNow', { id, confirm }),
    onState: (cb: (v: unknown) => void) => {
      const fn = (_e: unknown, v: unknown) => cb(v)
      ipcRenderer.on('cloud:state', fn)
      return () => ipcRenderer.removeListener('cloud:state', fn)
    }
  },
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
  createArchive: (a: Record<string, unknown>) => ipcRenderer.invoke('fs:archiveCreate', a),
  extract: (a: Record<string, unknown>) => ipcRenderer.invoke('fs:extract', a),
  verifyArchive: (a: Record<string, unknown>) => ipcRenderer.invoke('fs:archiveVerify', a),
  cancelArchive: (opId: string) => ipcRenderer.invoke('fs:archiveCancel', opId),
  onArchiveProgress: (cb: (v: unknown) => void) => {
    const fn = (_e: unknown, v: unknown) => cb(v)
    ipcRenderer.on('archive:progress', fn)
    return () => ipcRenderer.removeListener('archive:progress', fn)
  },
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
  toggleShown: (dir: string, name: string, on?: boolean) =>
    ipcRenderer.invoke('meta:toggleShown', { dir, name, on }),
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
  shortcut: (targets: string[], where: 'here' | 'desktop') =>
    ipcRenderer.invoke('fs:shortcut', { targets, where }),
  renameMany: (pairs: { from: string; to: string }[]) => ipcRenderer.invoke('fs:renameMany', pairs),
  open: (p: string) => ipcRenderer.invoke('shell:open', p),
  run: (p: string) => ipcRenderer.invoke('shell:run', p),
  clipboard: {
    releaseFiles: () => ipcRenderer.invoke('clipboard:releaseFiles'),
    copyFiles: (paths: string[], cut = false) => ipcRenderer.invoke('clipboard:copyFiles', { paths, cut }),
    readFiles: () => ipcRenderer.invoke('clipboard:readFiles'),
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
    saveImage: (dir: string, name: string, data: Uint8Array) =>
      ipcRenderer.invoke('clipboard:saveImage', { dir, name, data })
  },
  apps: {
    list: (p: string) => ipcRenderer.invoke('apps:list', p),
    openWith: (p: string, all = false) => ipcRenderer.invoke('apps:openWith', { path: p, all }),
    setDefault: (p: string, id: string) => ipcRenderer.invoke('apps:setDefault', { path: p, id }),
    default: (p: string) => ipcRenderer.invoke('apps:default', p),
    launch: (id: string, p: string) => ipcRenderer.invoke('apps:launch', id, p),
    shortcutTarget: (p: string) => ipcRenderer.invoke('apps:shortcutTarget', p),
    runAdmin: (p: string) => ipcRenderer.invoke('apps:runAdmin', p)
  },
  preview: (p: string, maxKB?: number) => ipcRenderer.invoke('fs:preview', p, maxKB),
  player: {
    open: (path: string) => ipcRenderer.invoke('player:open', path),
    cancel: (id: string) => ipcRenderer.invoke('player:cancel', id),
    saveFrame: (path: string, at: number) => ipcRenderer.invoke('player:saveFrame', path, at),
    capabilities: () => ipcRenderer.invoke('player:capabilities'),
    onEvent: (cb: (msg: unknown) => void) => {
      playerListener = cb
      for (const m of playerQueue.splice(0)) cb(m)
      return () => {
        if (playerListener === cb) playerListener = null
      }
    },
    onWindowClosed: (cb: (kind: 'music' | 'video') => void) => {
      const fn = (_e: unknown, kind: 'music' | 'video') => cb(kind)
      ipcRenderer.on('player:window-closed', fn)
      return () => ipcRenderer.removeListener('player:window-closed', fn)
    }
  },
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
    files: (id: string) => ipcRenderer.invoke('job:files', id),
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
    openViewer: (kind: 'gallery' | 'editor' | 'music' | 'video', file: string) =>
      ipcRenderer.invoke('app:openViewer', { kind, path: file }),
    setWallpaper: (p: string, fillMode?: string) =>
      ipcRenderer.invoke('app:setWallpaper', p, fillMode),
    quit: () => ipcRenderer.invoke('app:quit')
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
    },
    onFullscreen: (cb: (on: boolean) => void) => {
      const fn = (_e: unknown, on: boolean) => cb(on)
      ipcRenderer.on('window:fullscreen-state', fn)
      return () => ipcRenderer.removeListener('window:fullscreen-state', fn)
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

// The standalone music window only mirrors state and sends commands: playback stays in the main window.
contextBridge.exposeInMainWorld('musicBridge', {
  push: (state: unknown) => ipcRenderer.send('music:state', state),
  send: (cmd: unknown) => ipcRenderer.send('music:cmd', cmd),
  onState: (cb: (state: unknown) => void) => {
    musicStateListener = cb
    if (lastMusicState !== null) cb(lastMusicState)
    return () => {
      if (musicStateListener === cb) musicStateListener = null
    }
  },
  onCmd: (cb: (cmd: unknown) => void) => {
    const fn = (_e: unknown, cmd: unknown) => cb(cmd)
    ipcRenderer.on('music:cmd', fn)
    return () => ipcRenderer.removeListener('music:cmd', fn)
  }
})
