// Shrinking an image on the way into the Drive.
//
// A photo off a phone is 4000px wide and several megabytes. On a desk it is
// displayed in a widget a few hundred pixels across, and it has to be synced to
// the server and then down to every other device. Storing the original is
// paying for resolution nobody sees -- one real workspace measured 5.2 GB
// across 136 files, against a server volume of 1 GB.
//
// So an image is resized to fit within MAX_EDGE and re-encoded on ingest. The
// rules are deliberately conservative, because this replaces what the user gave
// us and there is no undo:
//
//   - the format family never changes. A PNG stays a PNG so transparency
//     survives, a JPEG stays a JPEG. Converting everything to WebP would save
//     more and would also change every file's extension, its MIME type, and
//     what the file is called when someone exports it.
//   - GIF and SVG are left alone entirely: one would lose its animation, the
//     other is vector and already small.
//   - if the result is not actually smaller, the original is kept. Re-encoding
//     an already-optimised image usually makes it bigger, and a "shrink" that
//     grows the file is worse than doing nothing.
export interface DownsampleResult {
  bytes: Uint8Array
  /** True when the bytes differ from the input, so callers can log honestly. */
  changed: boolean
  width: number
  height: number
}

// 2560 keeps an image crisp on a Retina desk at any realistic widget size while
// cutting a 12-megapixel photo to about a fifth of its pixels.
export const MAX_EDGE = 2560
// Below this, resizing saves little and risks visible loss for nothing.
export const MIN_BYTES_TO_BOTHER = 256 * 1024
export const JPEG_QUALITY = 82

/** Formats worth resizing. GIF and SVG are deliberately absent. */
export function isDownsampleable(mimeType: string, ext: string): boolean {
  const m = (mimeType || '').toLowerCase()
  const e = (ext || '').toLowerCase().replace(/^\./, '')
  if (m.includes('gif') || e === 'gif') return false
  if (m.includes('svg') || e === 'svg') return false
  return m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'heic', 'heif'].includes(e)
}

import { nativeImage } from 'electron'

/**
 * Desktop implementation, on Electron's own image encoder.
 *
 * nativeImage is used rather than a dependency because it is already here and
 * handles the formats a desktop actually receives. It has no WebP encoder,
 * which is one more reason the format family is preserved rather than converted.
 */
export async function downsampleImage(
  bytes: Uint8Array,
  mimeType: string,
  ext: string
): Promise<DownsampleResult> {
  const unchanged = (w = 0, h = 0): DownsampleResult => ({ bytes, changed: false, width: w, height: h })
  if (!isDownsampleable(mimeType, ext) || bytes.length < MIN_BYTES_TO_BOTHER) return unchanged()

  try {
    const img = nativeImage.createFromBuffer(Buffer.from(bytes))
    if (img.isEmpty()) return unchanged()
    const { width, height } = img.getSize()
    if (!width || !height) return unchanged()

    const scale = Math.min(MAX_EDGE / width, MAX_EDGE / height, 1)
    const outW = Math.max(1, Math.round(width * scale))
    const outH = Math.max(1, Math.round(height * scale))
    // Already small enough AND not worth re-encoding: leave it alone.
    if (scale === 1 && bytes.length < MIN_BYTES_TO_BOTHER * 4) return unchanged(width, height)

    const resized = scale === 1 ? img : img.resize({ width: outW, height: outH, quality: 'better' })
    const keepsAlpha = /png/i.test(mimeType) || /^\.?png$/i.test(ext)
    const out = keepsAlpha ? resized.toPNG() : resized.toJPEG(JPEG_QUALITY)

    // Never grow a file in the name of shrinking it.
    if (out.length >= bytes.length) return unchanged(width, height)
    return { bytes: new Uint8Array(out), changed: true, width: outW, height: outH }
  } catch {
    // A format Electron cannot decode is not a failure worth surfacing: keep
    // the original and carry on, exactly as if downsampling were switched off.
    return unchanged()
  }
}
