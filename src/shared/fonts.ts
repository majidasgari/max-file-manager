/**
 * The UI fonts that ship with the app. Only metadata lives here, so the renderer (which owns the
 * woff2 URLs and registers them with `FontFace`) and main (MCP, tests) agree on the same list.
 * Everything is OFL and comes from npm, never a CDN: the app must work offline.
 */
export type BundledFont = {
  id: string
  /** CSS family name; this is what `prefs.fontFamily` stores when the chip is clicked */
  family: string
  /** a short Persian note shown under the name (translated with `t()` at render time) */
  note: string
}

export const BUNDLED_FONTS: BundledFont[] = [
  { id: 'vazirmatn', family: 'Vazirmatn', note: 'فارسی و لاتین' },
  { id: 'inter', family: 'Inter', note: 'لاتین، رابط مدرن' },
  { id: 'noto-sans', family: 'Noto Sans', note: 'لاتین، پوشش گسترده' },
  { id: 'noto-sans-arabic', family: 'Noto Sans Arabic', note: 'فارسی و عربی' },
  { id: 'source-sans-3', family: 'Source Sans 3', note: 'لاتین، خوانا' },
  { id: 'ibm-plex-sans', family: 'IBM Plex Sans', note: 'لاتین، فنی' },
  { id: 'jetbrains-mono', family: 'JetBrains Mono', note: 'عرض ثابت' }
]
