/**
 * Every font the UI can show lives here. Bundled faces come from npm (offline, OFL) and are
 * registered with the FontFace API, which fetches a woff2 only once a family is actually used.
 * Fonts the person imports are copied into `userData/fonts` by main and registered from their
 * bytes — no `file://`, no protocol change, and the CSP stays exactly as it was.
 */
import interLatin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url'
import notoSansLatin from '@fontsource-variable/noto-sans/files/noto-sans-latin-wght-normal.woff2?url'
import notoSansArabic from '@fontsource-variable/noto-sans-arabic/files/noto-sans-arabic-arabic-wght-normal.woff2?url'
import sourceSansLatin from '@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2?url'
import ibmPlexLatin from '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2?url'
import jetbrainsLatin from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url'
import { BUNDLED_FONTS } from '../../shared/fonts.ts'
import { api } from './api'

export type UserFont = { id: string; family: string; size: number }

/** Vazirmatn is not here: its variable face arrives as CSS from `main.tsx` and is always available. */
const BUNDLED_URLS: Record<string, string> = {
  inter: interLatin,
  'noto-sans': notoSansLatin,
  'noto-sans-arabic': notoSansArabic,
  'source-sans-3': sourceSansLatin,
  'ibm-plex-sans': ibmPlexLatin,
  'jetbrains-mono': jetbrainsLatin
}

const registered = new Set<string>()
const userFaces = new Map<string, FontFace>()
let userFonts: UserFont[] = []

const familyOf = (id: string): string => BUNDLED_FONTS.find((f) => f.id === id)?.family ?? id

/** One call at boot is enough; a face that fails to register simply falls through the stack. */
export function registerBundledFonts(): void {
  for (const [id, url] of Object.entries(BUNDLED_URLS)) {
    if (registered.has(id)) continue
    registered.add(id)
    try {
      // every fontsource variable face carries the whole 100–900 axis
      document.fonts.add(
        new FontFace(familyOf(id), `url("${url}")`, { weight: '100 900', display: 'swap' })
      )
    } catch {
      /* the fallback stack still renders */
    }
  }
}

export const getUserFonts = (): UserFont[] => userFonts

async function registerUserFont(font: UserFont): Promise<void> {
  if (userFaces.has(font.id)) return
  const bytes = await api.fonts.read(font.id)
  if (!bytes || !bytes.length) return
  try {
    const face = new FontFace(font.family, bytes, { weight: '100 900', display: 'swap' })
    document.fonts.add(face)
    userFaces.set(font.id, face)
  } catch {
    /* an unreadable file: keep it listed, the stack just falls through it */
  }
}

/** Reads `userData/fonts` and registers everything in it; called at boot in every window. */
export async function refreshUserFonts(): Promise<UserFont[]> {
  const list = await api.fonts.list().catch(() => [] as UserFont[])
  userFonts = list
  await Promise.all(list.map(registerUserFont))
  return list
}

/** Native picker in main; the imported files stay on disk so the choice survives a restart. */
export async function importUserFonts(): Promise<UserFont[]> {
  const added = await api.fonts.import().catch(() => [] as UserFont[])
  await Promise.all(added.map(registerUserFont))
  userFonts = [...userFonts.filter((f) => !added.some((a) => a.id === f.id)), ...added].sort((a, b) =>
    a.family.localeCompare(b.family)
  )
  return added
}

export async function removeUserFont(id: string): Promise<boolean> {
  const ok = await api.fonts.remove(id).catch(() => false)
  if (!ok) return false
  const face = userFaces.get(id)
  if (face) document.fonts.delete(face)
  userFaces.delete(id)
  userFonts = userFonts.filter((f) => f.id !== id)
  return true
}
