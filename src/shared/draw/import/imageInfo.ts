// What a file someone is placing actually IS, read from its bytes -- never
// from its name -- plus the facts placement needs: a raster image's pixel size,
// the resolution it declares (so it can be placed at its real size, as
// Illustrator does), and its EXIF orientation (a portrait phone photo is stored
// sideways and shown upright; its placed frame must be the upright one).
//
// Pure and dependency-free: the main process, the renderer and the tests all
// classify the same bytes the same way.

export type ImportKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif' | 'svg' | 'svgz' | 'pdf'

/** Raster kinds an <image> can show, with the MIME type each is embedded as. */
export const RASTER_MIME: Record<'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif', string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif'
}

export function isRasterKind(k: ImportKind): k is keyof typeof RASTER_MIME {
  return Object.prototype.hasOwnProperty.call(RASTER_MIME, k)
}

/** The largest file Place accepts. A drawing is stored and synced whole, so the bytes ride along with it. */
export const MAX_PLACE_BYTES = 40 * 1024 * 1024
/** The largest SVG text (after decompression) the importer reads. */
export const MAX_SVG_BYTES = 20 * 1024 * 1024

export interface RasterInfo {
  /** Pixel size as SHOWN (EXIF orientation applied). */
  w: number
  h: number
  /** Declared resolution in pixels per inch, when the file states one. */
  ppi?: number
  /** EXIF orientation 1..8 when present. */
  orientation?: number
}

function ascii(b: Uint8Array, at: number, len: number): string {
  let s = ''
  for (let i = at; i < at + len && i < b.length; i++) s += String.fromCharCode(b[i])
  return s
}

function u16be(b: Uint8Array, i: number): number {
  return (b[i] << 8) | b[i + 1]
}
function u32be(b: Uint8Array, i: number): number {
  return ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]
}
function u16le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8)
}
function u24le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
}
function i32le(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)
}

/** The start of the text, decoded loosely, for sniffing SVG markup. */
function head(b: Uint8Array, n = 4096): string {
  // UTF-16 SVGs exist (old Windows tools); drop the zero bytes to sniff them.
  const s = ascii(b, 0, Math.min(b.length, n * 2))
  return b.length > 1 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) ? s.replace(/\0/g, '') : s
}

/**
 * The kind of file `bytes` holds, or null when it is nothing Place can use.
 * The file NAME only breaks one tie: gzip bytes are SVGZ when the name says
 * .svgz (a gzip of anything else is not ours to open).
 */
export function sniffImportKind(bytes: Uint8Array, name = ''): ImportKind | null {
  const b = bytes
  if (b.length >= 8 && u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'gif'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp'
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp' && /^avi[fs]$/.test(ascii(b, 8, 4))) return 'avif'
  // A PDF -- and an Illustrator .ai saved with PDF compatibility, which is one.
  if (b.length >= 5 && ascii(b, 0, 1024).includes('%PDF-')) return 'pdf'
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return /\.svgz$/i.test(name) ? 'svgz' : null
  const h = head(b)
  // Markup whose first element is <svg (after a BOM, XML declaration,
  // comments or a DOCTYPE).
  if (/^[\s﻿\xEF\xBB\xBF]*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[\s\S]*?>\s*)*<svg[\s>]/i.test(h)) return 'svg'
  if (/^[\s﻿\xEF\xBB\xBF]*<\?xml/i.test(h) && /<svg[\s>]/i.test(h)) return 'svg'
  return null
}

// ── Raster headers ───────────────────────────────────────────────────────────

function pngInfo(b: Uint8Array): RasterInfo | null {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null
  const info: RasterInfo = { w: u32be(b, 16), h: u32be(b, 20) }
  // pHYs: pixels per unit, unit 1 = the metre.
  let off = 8
  while (off + 12 <= b.length) {
    const len = u32be(b, off)
    const type = ascii(b, off + 4, 4)
    if (type === 'pHYs' && len >= 9 && off + 17 <= b.length) {
      const ppu = u32be(b, off + 8)
      if (b[off + 16] === 1 && ppu > 0) info.ppi = ppu * 0.0254
      break
    }
    if (type === 'IDAT' || type === 'IEND') break
    off += 12 + len
  }
  return info
}

/** EXIF (a TIFF structure inside APP1): orientation and declared resolution. */
function exifInfo(b: Uint8Array, start: number, end: number): { orientation?: number; ppi?: number } {
  if (ascii(b, start, 6) !== 'Exif\0\0') return {}
  const t = start + 6
  const le = ascii(b, t, 2) === 'II'
  const r16 = (i: number): number => (le ? u16le(b, i) : u16be(b, i))
  const r32 = (i: number): number => (le ? (u16le(b, i) | (u16le(b, i + 2) << 16)) >>> 0 : u32be(b, i))
  if (t + 8 > end) return {}
  const ifd = t + r32(t + 4)
  if (ifd + 2 > end) return {}
  const count = r16(ifd)
  const out: { orientation?: number; ppi?: number } = {}
  let xres: number | undefined
  let unit = 2
  for (let i = 0; i < count && i < 512; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > end) break
    const tag = r16(e)
    if (tag === 0x0112) out.orientation = r16(e + 8)
    else if (tag === 0x0128) unit = r16(e + 8)
    else if (tag === 0x011a) {
      const at = t + r32(e + 8)
      if (at + 8 <= end) {
        const den = r32(at + 4)
        if (den > 0) xres = r32(at) / den
      }
    }
  }
  if (xres && xres > 0) out.ppi = unit === 3 ? xres * 2.54 : unit === 2 ? xres : undefined
  if (out.ppi === undefined) delete out.ppi
  return out
}

function jpegInfo(b: Uint8Array): RasterInfo | null {
  let i = 2
  let w = 0
  let h = 0
  let ppi: number | undefined
  let exif: { orientation?: number; ppi?: number } = {}
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) {
      i++
      continue
    }
    const marker = b[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) break
    const len = u16be(b, i + 2)
    const seg = i + 4
    if (marker === 0xe0 && ascii(b, seg, 5) === 'JFIF\0' && seg + 12 <= b.length) {
      const units = b[seg + 7]
      const xd = u16be(b, seg + 8)
      if (xd > 0 && units === 1) ppi = xd
      else if (xd > 0 && units === 2) ppi = xd * 2.54
    } else if (marker === 0xe1) {
      exif = exifInfo(b, seg, Math.min(b.length, i + 2 + len))
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && seg + 5 <= b.length) {
      h = u16be(b, seg + 1)
      w = u16be(b, seg + 3)
    }
    i += 2 + len
  }
  if (!w || !h) return null
  const orientation = exif.orientation && exif.orientation >= 1 && exif.orientation <= 8 ? exif.orientation : undefined
  // Orientations 5..8 turn the picture a quarter: it is shown h x w.
  const turned = orientation !== undefined && orientation >= 5
  const out: RasterInfo = { w: turned ? h : w, h: turned ? w : h }
  const res = ppi ?? exif.ppi
  if (res && res > 0) out.ppi = res
  if (orientation) out.orientation = orientation
  return out
}

function webpInfo(b: Uint8Array): RasterInfo | null {
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8 ' && b.length >= 30) return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff }
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0
    return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X' && b.length >= 30) return { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 }
  return null
}

function bmpInfo(b: Uint8Array): RasterInfo | null {
  const w = i32le(b, 18)
  const h = Math.abs(i32le(b, 22))
  if (w <= 0 || h <= 0) return null
  const info: RasterInfo = { w, h }
  if (b.length >= 42) {
    const ppm = i32le(b, 38)
    if (ppm > 0) info.ppi = ppm * 0.0254
  }
  return info
}

function avifInfo(b: Uint8Array): RasterInfo | null {
  // The image spatial extents ('ispe') property: version/flags, then w, h.
  const limit = Math.min(b.length - 16, 1 << 20)
  for (let i = 0; i < limit; i++) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
      const w = u32be(b, i + 8)
      const h = u32be(b, i + 12)
      if (w > 0 && h > 0) return { w, h }
    }
  }
  return null
}

/** Pixel size, declared resolution and orientation of a raster file; null when its header is unreadable. */
export function rasterInfo(bytes: Uint8Array, kind: ImportKind): RasterInfo | null {
  let info: RasterInfo | null = null
  if (kind === 'png') info = pngInfo(bytes)
  else if (kind === 'jpeg') info = jpegInfo(bytes)
  else if (kind === 'gif') info = bytes.length >= 10 ? { w: u16le(bytes, 6), h: u16le(bytes, 8) } : null
  else if (kind === 'webp') info = webpInfo(bytes)
  else if (kind === 'bmp') info = bmpInfo(bytes)
  else if (kind === 'avif') info = avifInfo(bytes)
  if (!info || !(info.w > 0) || !(info.h > 0)) return null
  // A declared resolution outside any real device's range is noise, not a size.
  if (info.ppi !== undefined && !(info.ppi >= 1 && info.ppi <= 10000)) delete info.ppi
  return info
}

/**
 * The size an image is placed at when the user just clicks (Illustrator's
 * "actual size"). A drawing's unit is one logical pixel; a drawing that
 * declares its resolution (`docDpi`, e.g. an "A4 at 150dpi" artboard) has that
 * many units to the inch, and one that does not is treated as Illustrator
 * treats its documents, 72 units to the inch. An image that declares its own
 * resolution is placed at its physical size -- a 144 ppi screenshot at half its
 * pixel count, a 300 ppi photo at its print size -- and an image that declares
 * none is placed one pixel to one unit.
 */
export function actualSize(info: Pick<RasterInfo, 'w' | 'h' | 'ppi'>, docDpi?: number): { w: number; h: number } {
  const d = typeof docDpi === 'number' && Number.isFinite(docDpi) && docDpi > 0 ? docDpi : 72
  const p = info.ppi && info.ppi > 0 ? info.ppi : d
  const k = d / p
  return { w: info.w * k, h: info.h * k }
}

// ── Bytes to a data URL ──────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard base64 of bytes (no line breaks), identical in every runtime. */
export function bytesToBase64(b: Uint8Array): string {
  const parts: string[] = []
  const CHUNK = 3 * 4096
  for (let start = 0; start < b.length; start += CHUNK) {
    const end = Math.min(b.length, start + CHUNK)
    let s = ''
    let i = start
    for (; i + 2 < end; i += 3) {
      const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
    }
    if (end - i === 1) {
      const n = b[i] << 16
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '=='
    } else if (end - i === 2) {
      const n = (b[i] << 16) | (b[i + 1] << 8)
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '='
    }
    parts.push(s)
  }
  return parts.join('')
}

/** Raw bytes back from a base64 data URL's payload; null when it is not base64. */
export function base64ToBytes(s: string): Uint8Array | null {
  const clean = s.replace(/[\s]/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4) - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((clean[i + 2] === '=' || clean[i + 2] === undefined ? 0 : B64.indexOf(clean[i + 2])) << 6) |
      (clean[i + 3] === '=' || clean[i + 3] === undefined ? 0 : B64.indexOf(clean[i + 3]))
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

/** The raster bytes as an embeddable data URL. */
export function rasterDataUrl(bytes: Uint8Array, kind: keyof typeof RASTER_MIME): string {
  return `data:${RASTER_MIME[kind]};base64,${bytesToBase64(bytes)}`
}
