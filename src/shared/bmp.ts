/**
 * A tiny BMP writer: 24-bit BGR, bottom-up rows, 4-byte aligned. Chromium has no BMP encoder,
 * and BMP is one of the formats people still ask for (old software, Windows tooling). Alpha is
 * composited over white, which is what a viewer without an alpha channel shows anyway.
 */
export function encodeBmp(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number
): Uint8Array {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(1, Math.floor(height))
  const rowSize = Math.ceil((w * 3) / 4) * 4
  const pixelBytes = rowSize * h
  const fileSize = 54 + pixelBytes
  const out = new Uint8Array(fileSize)
  const view = new DataView(out.buffer)

  // BITMAPFILEHEADER
  out[0] = 0x42 // 'B'
  out[1] = 0x4d // 'M'
  view.setUint32(2, fileSize, true)
  view.setUint32(10, 54, true) // pixel data offset

  // BITMAPINFOHEADER
  view.setUint32(14, 40, true)
  view.setInt32(18, w, true)
  view.setInt32(22, h, true) // positive: bottom-up
  view.setUint16(26, 1, true) // planes
  view.setUint16(28, 24, true) // bits per pixel
  view.setUint32(30, 0, true) // BI_RGB
  view.setUint32(34, pixelBytes, true)
  view.setInt32(38, 2835, true) // 72 dpi
  view.setInt32(42, 2835, true)

  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4
    const dstRow = 54 + y * rowSize
    for (let x = 0; x < w; x++) {
      const i = srcRow + x * 4
      const a = rgba[i + 3] / 255
      const r = Math.round(rgba[i] * a + 255 * (1 - a))
      const g = Math.round(rgba[i + 1] * a + 255 * (1 - a))
      const b = Math.round(rgba[i + 2] * a + 255 * (1 - a))
      const o = dstRow + x * 3
      out[o] = b
      out[o + 1] = g
      out[o + 2] = r
    }
  }
  return out
}
