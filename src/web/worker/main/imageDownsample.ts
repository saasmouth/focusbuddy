// The browser's image downsampler, on OffscreenCanvas.
//
// Same rules and the same constants as the desktop's (see
// src/main/db/imageDownsample.ts for why each one is what it is): fit within
// MAX_EDGE, keep the format family so transparency and file extensions survive,
// leave GIF and SVG alone, and never return something larger than the input.
//
// The encoder is different because the runtime is: a Worker has no nativeImage,
// and OffscreenCanvas is the only thing here that can decode and re-encode
// without pulling in a library.
export interface DownsampleResult {
  bytes: Uint8Array
  changed: boolean
  width: number
  height: number
}

export const MAX_EDGE = 2560
export const MIN_BYTES_TO_BOTHER = 256 * 1024
export const JPEG_QUALITY = 82

export function isDownsampleable(mimeType: string, ext: string): boolean {
  const m = (mimeType || '').toLowerCase()
  const e = (ext || '').toLowerCase().replace(/^\./, '')
  if (m.includes('gif') || e === 'gif') return false
  if (m.includes('svg') || e === 'svg') return false
  return m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'heic', 'heif'].includes(e)
}

export async function downsampleImage(
  bytes: Uint8Array,
  mimeType: string,
  ext: string
): Promise<DownsampleResult> {
  const unchanged = (w = 0, h = 0): DownsampleResult => ({ bytes, changed: false, width: w, height: h })
  if (!isDownsampleable(mimeType, ext) || bytes.length < MIN_BYTES_TO_BOTHER) return unchanged()
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return unchanged()

  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: mimeType || 'image/png' }))
    const { width, height } = bitmap
    if (!width || !height) return unchanged()

    const scale = Math.min(MAX_EDGE / width, MAX_EDGE / height, 1)
    const outW = Math.max(1, Math.round(width * scale))
    const outH = Math.max(1, Math.round(height * scale))
    if (scale === 1 && bytes.length < MIN_BYTES_TO_BOTHER * 4) return unchanged(width, height)

    const canvas = new OffscreenCanvas(outW, outH)
    const ctx = canvas.getContext('2d')
    if (!ctx) return unchanged(width, height)
    ctx.drawImage(bitmap, 0, 0, outW, outH)

    const keepsAlpha = /png/i.test(mimeType) || /^\.?png$/i.test(ext)
    const blob = await canvas.convertToBlob(
      keepsAlpha ? { type: 'image/png' } : { type: 'image/jpeg', quality: JPEG_QUALITY / 100 }
    )
    const out = new Uint8Array(await blob.arrayBuffer())
    if (out.length >= bytes.length) return unchanged(width, height)
    return { bytes: out, changed: true, width: outW, height: outH }
  } catch {
    return unchanged()
  } finally {
    bitmap?.close()
  }
}
