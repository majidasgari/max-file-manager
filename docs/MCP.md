# MCP contract — letting other agents drive the file manager

Status: **implemented.** `src/main/mcp.ts` owns the tool list and `src/main/index.ts` the handlers;
every tool calls the same function its IPC counterpart does, so the agent never gets a second,
divergent implementation. Settings and the search index share `search.db` (see *Storage*).

## Why a local API and not a fat MCP server

Everything the UI can do already lives behind the app's own IPC surface (`fs:*`, `job:*`, `meta:*`,
`pdf:*`, `app:*`). An MCP server that re-implements file operations would drift from the app within
a phase. So: the running app exposes its **existing** operations over a loopback JSON-RPC endpoint,
and the MCP server is a thin stdio bridge that renames them into tools. One source of truth, one
implementation, and the agent sees exactly what the user would see (same panes, same state, same
undo stack).

```
agent ──stdio(MCP)──> bin/mfm-mcp.mjs ──HTTP 127.0.0.1:47321 + token──> max-file-manager (main process)
```

## Security rules (not negotiable)

1. **Off by default.** `prefs.mcp.enabled = false`; enabling it writes `~/.config/max-file-manager/mcp.json`
   with `{port, token, mode}` and `chmod 600`.
2. **Loopback only.** Bind `127.0.0.1`, reject any request whose `Origin` is set or whose `Host`
   is not `127.0.0.1:<port>`. No CORS headers at all.
3. **Token required** on every request (`Authorization: Bearer <token>`), compared in constant time.
4. **Two modes.** `read-only` (default) exposes only the read tools; any mutating tool answers
   `E_READONLY` until the user switches to `read-write` in Preferences → «ایجنت‌ها».
5. **Never secrets.** Card numbers, passwords, vault entries and the token itself are never returned
   by any tool. `prefs` reads redact nothing today because prefs hold no secrets — keep it that way.
6. **Audit log.** Every call appends `{ts, tool, args-summary, ok}` to `~/.config/max-file-manager/mcp.log`
   (append-only, no file contents). The Preferences page shows the last 50 lines.
7. **Trash by default.** `trash` uses `shell.trashItem`; `delete` (permanent) needs `confirm: true`
   in the call, exactly like Shift+F8 in the UI.

## Tools

`mcp_status` reports the mode and audit log, but enabling/disabling MCP itself (and rotating its
token) is deliberately **not** an MCP tool: an agent must never be able to widen its own access.
That switch stays in Preferences → Agents, in front of the human.

Paths must be absolute; relative paths are rejected with `E_PATH`. Every listing call returns
the same `Entry` shape the UI uses (`name, path, dir, size, mtime, ext, mode, uid, gid, nlink, w, h`).

### Read (always available)

| tool | args | returns |
| --- | --- | --- |
| `roots` | – | home folder and mounted drives |
| `drives_list` | – | connected USB and removable block devices and their mount points |
| `list` | `path`, `hidden?`, `dims?` | entries + `pins`, `labels`, `ratings`, `notes`, `format`, file colours |
| `dirs` | `path`, `hidden?`, `links?` | child folders only (`links`: include symlinked folders, flagged `link`) |
| `walk` | `dir`, `pattern?`, `regex?`, `content?`, `exclude[]?`, `cap?` | recursive matches with a budget |
| `properties` | `path` | mode, owner/group, links, inode, timestamps, image size, mime |
| `statfs` | `path` | free and total bytes |
| `size` | `path` | recursive folder size (capped) |
| `hash` | `paths[]`, `algo?` | digests (sha256 by default) |
| `dupes` | `dir` | duplicate files grouped by content hash |
| `search` | `query`, `limit?` | FTS5 filename hits from the index |
| `search_stats` | – | indexed file/dir counts and last index time |
| `search_status` | – | is indexing running, scanned/added counts, folder progress, errors |
| `search_sizes` | `dirs[]` | folder sizes straight from the index |
| `preview` | `path`, `maxKB?` | preview payload (text/image/audio/office/PDF) |
| `read_text` | `path` | text up to 8 MB |
| `archive_list` | `path` | entries inside a zip/tar |
| `diff` | `a`, `b` | line diff of two text files |
| `sync_compare` | `left`, `right`, `deep?`, `compareBy?`, `ignore[]?` | a two-way synchronisation plan |
| `tags` | `paths[]` | ID3 / EXIF tags |
| `meta_get` | `dir` | `{color, icon, pins, labels, colors, ratings, notes, format}` |
| `labels` | – | the colour-label palette (id, name, colour) |
| `folder_look` | `path` | colour/icon from `.mfm.json`, Dolphin `.directory` or Windows `desktop.ini` |
| `icons` | `theme?`, `extra[]?` | icon themes, or the icon names inside one theme |
| `jobs_list` | – | jobs with progress |
| `undo_depth` | – | how many transfers can still be undone |
| `state` | – | panes, tabs, marks and preferences |
| `mcp_status` | – | mode, port and the last 50 audit lines |
| `apps` | `path`, `all?` | applications that can open the file (`all`: every launchable app, like Dolphin's list) |
| `app_default` | `path` | the default application for the type |
| `desktop_default_manager` | – | is this app the system default file manager |
| `breakdown` | `path`, `mode?` | bytes/counts per extension, largest files and direct-child totals (`mode`: `all` or `level1`) |
| `portal_status` | – | is the XDG file chooser installed, running and used by other apps |
| `update_check` | `force?` | compare the running version with the latest release |
| `image_get` | `path` | data URL (max 40 MB) |

### Write (needs `read-write`)

| tool | args | notes |
| --- | --- | --- |
| `write_text` | `path`, `text` | atomic (temp + rename), 8 MB cap |
| `mkdir` | `dir`, `name` | |
| `create_file` | `dir`, `name`, `content?` | create a new file (never overwrites) |
| `rename` | `path`, `name` | never overwrites |
| `rename_many` | `pairs[{from,to}]` | one batch, checked as a whole |
| `copy` / `move` | `paths[]`, `dest`, `skipExisting?`, `newerOnly?`, `limitBps?` | queued as jobs |
| `trash` | `paths[]` | system trash |
| `delete` | `paths[]`, `confirm: true` | permanent, refuses without confirm |
| `symlink` | `target`, `link` | |
| `chmod` | `path`, `mode` | `0..0o7777` |
| `extract` | `archive`, `dest`, `names[]?` | never overwrites (free name) |
| `create_zip` | `dir`, `name`, `sources[]`, `level?` | streamed |
| `tags_write` | `path`, `fields` | ID3 (audio only) |
| `export_listing` | `dir`, `name`, `rows[]`, `format`, `theme?` | CSV or PDF |
| `pdf` | `html`, `out`, `theme?` | always rendered light |
| `image_save` | `src`, `dataUrl`, `mode` | `overwrite` keeps the original format |
| `image_save_as` | `src`, `dataUrl` | new file beside the original |
| `image_convert` | `files[]`, `format`, `maxSide?`, `quality?`, `dest?` | batch |
| `clipboard_image` | `dir`, `name`, `base64` | save pasted image bytes as a file |
| `thumbs_clear` | – | empty the thumbnail cache |
| `label_set` | `dir`, `name`, `label\|null` | palette ids only |
| `file_color_set` | `dir`, `name`, `color` | hex, empty clears |
| `rating_set` | `dir`, `name`, `stars` | `0..5` |
| `note_set` | `dir`, `name`, `text` | per-file note in the folder marker |
| `meta_set` | `dir`, `patch` | colour/icon/labels/notes/pins |
| `sort_set` | `dir`, `key`, `asc?` | remembered in `.mfm.json` |
| `pin_set` | `dir`, `name`, `on` | |
| `job_start` / `job_pause` / `job_resume` / `job_cancel` / `job_clear` | `kind`, `sources[]`, `dest`, `opts?` / `id` | full transfer control |
| `undo` | – | undo the last transfer |
| `sync_apply` | `left`, `right`, `rows[]`, `mode`, `deleteExtra?` | apply a sync plan; extras go to trash |
| `run_script` | `command`, `path?`, `dir?` | the user's own script text with `{path}`/`{dir}` |
| `search_index` | `roots[]`, `exclude[]?`, `wait?` | build the index; `wait:false` starts it and returns at once |
| `search_clear` | – | wipe the index; **settings are kept** |
| `prefs_set` | `patch` | validated through `mergePrefs`, written to SQLite at once |
| `settings_export` | `path?` | preferences as one JSON file (dialog when no path) |
| `settings_import` | `path?`, `apply?` | load a JSON file and apply its preferences |
| `open` | `path` | default application |
| `reveal` | `path` | system file manager |
| `terminal` | `dir` | desktop terminal |
| `apps_launch` | `id`, `path` | chosen `.desktop` |
| `app_set_default` | `path`, `app` | make that app the system handler for the file type (`xdg-mime`); `.desktop` path or exact name. Linux only — Windows/macOS reject programmatic association changes |
| `set_default_manager` | – | register this app as the default |
| `update_open` | `url` | release page |
| `hotkey` | `accel` | global shortcut; a Wayland failure is reported |
| `drive_mount` | `device` | mount a removable block device (e.g. /dev/sdb1) |
| `drive_unmount` | `device` | unmount a removable block device or mount point |

### UI (needs `read-write`; they change what the user sees)

| tool | args | effect |
| --- | --- | --- |
| `command` | `id`, `pane?` | run any command from `commands.ts` (copy, rename, gallery, prefs, …) |
| `goto` | `path`, `pane?` | navigate a pane and focus it |
| `select` | `paths[]`, `pane?` | set the selection |
| `filter` | `text`, `pane?` | set the name filter (empty clears) |
| `tab` | `action` (`new`,`close`,`next`,`prev`,`reopen`,`select`,`rename`,`lock`,`color`), `pane?`, `path?`, `name?`, `color?`, `on?` | tab management |
| `bookmark` | `action` (`add`,`remove`,`toggle`,`list`), `path?` | sidebar bookmarks |
| `open_editor` | `path?` | built-in editor (selection fallback) |
| `open_gallery` | `path?`, `pane?` | image gallery |
| `open_preview` | `on`, `path?` | side preview panel |
| `properties_dialog` | `path?` | properties sheet |
| `note` | `text` | message in the status bar |
| `window` | `action` (`minimize`,`maximize`,`close`,`show`,`fullscreen`,`chrome`), `on?` | window control |

Editor drafts are a UI safety net only: the file itself is still read/written with `read_text`
and `write_text`, and a draft is never applied to the file without the user restoring it.

The gallery's information sheet and edit tools add no new file operation: it reads `properties`
and `tags` and writes through `image_save` / `image_save_as`, which agents already have.

The folder-tree pane needs no tool of its own: `prefs_set` with `treePane` (`off|left|right`),
`treeWidth` and `treeAutoFocus` controls it, and `goto` makes auto-focus reveal the folder.

The UI tools go through `mcp:ui` to the window (one-way IPC) because panes, selection, tabs and
marks live in renderer state. `command` with a `pane` first focuses that pane, then runs the
command through the same `RUN` table a click uses.

## Storage

`search.db` (SQLite, `~/.config/max-file-manager/`) holds both indexes:

- `files`, `dirs`, `fts` — the searchable filename index, built from `prefs.searchRoots`.
- `app(k, v)` — the whole window state and preferences as JSON, under `state` and `window`.

Clearing the search index (`search_clear`, Preferences → Search) deletes only `files`/`dirs`/`fts`
and their `meta` bookkeeping; the `app` table is untouched, so no setting is ever lost that way.
On first launch after upgrading, `state.json`/`window.json` are imported once and left on disk as
a backup.

## Resources and prompts

- `mfm://state` — JSON snapshot of the whole window.
- `mfm://pane/{0,1}/listing` — current entries of that pane.
- `mfm://prefs` — the preference object.
- prompt `organize-folder` — "look at this folder, group obvious duplicates, tag them, propose a
  rename plan; make no changes until I say yes".

## Client wiring (what the user pastes into an agent config)

```json
{
  "mcpServers": {
    "max-file-manager": {
      "command": "node",
      "args": ["/data/Codes/max-file-manager/bin/mfm-mcp.mjs"]
    }
  }
}
```

The bridge reads `~/.config/max-file-manager/mcp.json` for the port and token, so nothing secret
lives in the agent's config file.

## Phases

1. ~~HTTP endpoint + token + audit log + read tools.~~
2. ~~Write tools behind `read-write`, with a confirmation flag on destructive ones.~~
3. ~~UI tools; the `organize-folder` prompt is documentation only for now.~~
4. ~~Preferences → «ایجنت‌ها» page: enable, mode switch, token regenerate, log viewer.~~
5. Resources over MCP (`mfm://state`, `mfm://pane/{0,1}/listing`, `mfm://prefs`) are not exposed
   yet; the same data is available through the `state` and `list` tools today.
