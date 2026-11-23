import type { CloudEntryState } from '../shared/cloud.ts'

export type Entry = {
  name: string
  path: string
  dir: boolean
  size: number
  mtime: number
  ext: string
  /** duplicate group number, only set by findDupes */
  group?: number
  /** per-folder look from the folder's own .mfm.json */
  color?: string
  icon?: string
  /** unix mode bits, owner, hard links — filled by list() */
  mode?: number
  uid?: number
  gid?: number
  nlink?: number
  /** image pixel size, only when the caller asked for it */
  w?: number
  h?: number
  /** a folder marked «don't list me» in its own .mfm.json (shown only with hidden files) */
  hidden?: boolean
  /** the entry is a symbolic link (the path itself, not its target) */
  link?: boolean
  /** the parent folder's marker forces this name visible even with hidden files off */
  forceShow?: boolean
  /** the entry lives inside a cloud-synced folder; filled by main, never by the renderer */
  cloud?: { provider: string; state: CloudEntryState; root: boolean }
  /** inside an archive: the payload needs a password */
  encrypted?: boolean
  /** inside an archive: compressed size and raw ZIP method */
  csize?: number
  method?: number
}
export type DirRef = { name: string; path: string; /** the entry itself is a symbolic link */ link?: boolean }
export type Listing = { path: string; parent: string | null; entries: Entry[] }
export type Result = { done: number; errors: string[] }
