/**
 * Image formats Chromium can draw itself but `nativeImage` cannot decode.
 *
 * Electron's decoder knows PNG and JPEG only, so a WebP or an SVG produced an empty image and the
 * grid fell back to the type icon. For these formats the `thumb://` protocol hands the original
 * bytes over with the right MIME type instead of a cached PNG: SVG stays a vector (crisp at every
 * tile size) and WebP/GIF/BMP/ICO/AVIF are decoded by the renderer.
 *
 * Chromium cannot draw TIFF/TGA/PSD and those keep showing their type icon.
 */
const RAW: Record<string, string> = {
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}

/**
 * Above this a 100 px tile would decode a very large bitmap in the renderer; the type icon is the
 * honest fallback. A normal photo or an SVG stays far below it.
 */
export const RAW_IMAGE_MAX_BYTES = 32 * 1024 * 1024

/** The MIME type Chromium needs, or `null` when the format is not one of these. */
export function rawImageType(p: string): string | null {
  const name = p.replace(/[?#].*$/, '')
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  return RAW[name.slice(dot + 1).toLowerCase()] ?? null
}
