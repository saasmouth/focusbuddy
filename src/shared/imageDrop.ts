// What makes a dropped picture acceptable, in one place for both processes.
//
// An image dragged out of a browser (a desk browser's <webview>, or Chrome and
// Safari beside the app) arrives as an ADDRESS: an http(s) URL, or the bytes
// themselves as a data: URL. The main process fetches the http(s) ones (no
// CORS there) and decodes the data: ones; both go through the checks below
// before anything is stored, so a link to a login page, a 200 MB download or a
// page-local blob: never becomes an "attachment".
//
// Pure: no DOM, no Node. Main imports it for the fetch path, the renderer for
// its unit-tested drop parsing.

/** The most a single dropped image may weigh. A real screenshot fits; a mistaken link to a video does not. */
export const MAX_DROPPED_IMAGE_BYTES = 25 * 1024 * 1024

/** The addresses a drop may attach: web images and inline image bytes. Nothing else is fetched. */
export function isAttachableImageAddress(raw: string | null | undefined): boolean {
  const s = (raw ?? '').trim()
  if (/^https?:\/\/[^\s]+$/i.test(s)) {
    try {
      const u = new URL(s)
      return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
    } catch {
      return false
    }
  }
  return /^data:image\/[a-z0-9.+-]+[;,]/i.test(s)
}

const EXT_FOR_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/pjpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/tiff': '.tiff',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif'
}
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tif', '.tiff', '.avif', '.heic', '.heif'])

/** The file extension (with its dot) for an image type; `.img` for an image type we have no name for. */
export function imageExtFor(mime: string): string {
  const m = mime.toLowerCase().split(';')[0]!.trim()
  const known = EXT_FOR_MIME[m]
  if (known) return known
  // image/jxl → .jxl; anything longer or odder (image/x-portable-pixmap) → .img.
  const sub = m.startsWith('image/') ? m.slice(6).replace(/^x-/, '') : ''
  return /^[a-z0-9]{2,5}$/.test(sub) ? `.${sub}` : '.img'
}

const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  if (b.length < at + s.length) return false
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false
  return true
}

/**
 * The image type the bytes actually are, from their signature; null when they
 * are not a picture we recognise. Trusted over a server's Content-Type when
 * the header is missing or generic (application/octet-stream).
 */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'image/gif'
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp'
  // ISO media (before the icon test: a 256-byte ftyp box also starts 00 00 01 00).
  // Only the still-image brands count; an MP4 is not a picture.
  if (ascii(b, 4, 'ftyp')) {
    if (ascii(b, 8, 'avif') || ascii(b, 8, 'avis')) return 'image/avif'
    if (ascii(b, 8, 'heic') || ascii(b, 8, 'heix') || ascii(b, 8, 'mif1') || ascii(b, 8, 'msf1')) return 'image/heic'
    return null
  }
  if (ascii(b, 0, 'BM') && b.length > 14) return 'image/bmp'
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && (b[4]! | b[5]!) !== 0) return 'image/x-icon'
  if (ascii(b, 0, 'II*\u0000') || ascii(b, 0, 'MM\u0000*')) return 'image/tiff'
  if (looksLikeSvg(b)) return 'image/svg+xml'
  return null
}

/** A text body that opens (after an optional BOM, XML prolog, comments or doctype) with <svg. */
function looksLikeSvg(b: Uint8Array): boolean {
  const head = decodeLatin1(b.subarray(0, 1024)).replace(/^﻿|^ï»¿/, '')
  const stripped = head.replace(/^\s*(<\?xml[^>]*>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*/i, '')
  return /^<svg[\s>]/i.test(stripped)
}

/** Does this body look like a web page? (A login wall or an error page served as image/*.) */
export function looksLikeHtml(b: Uint8Array): boolean {
  const head = decodeLatin1(b.subarray(0, 512)).replace(/^﻿|^ï»¿/, '').trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head') || head.startsWith('<body')
}

function decodeLatin1(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!)
  return s
}

export type ImageVerdict = { ok: true; mime: string } | { ok: false; error: string }

/**
 * Is this body an image, given what the server (or the data: URL) declared?
 * - a declared image/* is believed, unless the bytes are plainly a web page;
 * - no type, or a generic one, is accepted only when the bytes sniff as an image;
 * - anything else declared (text/html, application/json …) is refused.
 */
export function judgeImageBody(declared: string, bytes: Uint8Array): ImageVerdict {
  if (bytes.length === 0) return { ok: false, error: 'The image was empty.' }
  const mime = declared.toLowerCase().split(';')[0]!.trim()
  const sniffed = sniffImageMime(bytes)
  if (mime.startsWith('image/')) {
    if (!sniffed && looksLikeHtml(bytes)) return { ok: false, error: 'That address returned a web page, not an image.' }
    // An SVG declared as something else, or a PNG labelled image/jpeg: the bytes decide the name.
    return { ok: true, mime: sniffed ?? mime }
  }
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    if (sniffed) return { ok: true, mime: sniffed }
    return { ok: false, error: 'That address did not return an image.' }
  }
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return { ok: false, error: 'That address is a web page, not an image.' }
  return { ok: false, error: `That address returned ${mime}, not an image.` }
}

/** A name worth showing for a picture fetched from `url`: the URL's own filename when it has one. */
export function imageNameFromUrl(url: string, mime: string, now: number = Date.now()): string {
  const ext = imageExtFor(mime)
  if (/^data:/i.test(url)) return `image-${now}${ext}`
  try {
    const u = new URL(url)
    const raw = u.pathname.split('/').filter(Boolean).pop() ?? ''
    let last = raw
    try {
      last = decodeURIComponent(raw)
    } catch {
      /* keep it encoded */
    }
    // No path separators or control characters in a stored name.
    last = last.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
    const m = /^(.+?)(\.[a-z0-9]{2,5})$/i.exec(last)
    if (m && last.length <= 120) {
      // photo.png stays photo.png; thumb.php (served as image/jpeg) becomes thumb.jpg.
      return IMAGE_EXTS.has(m[2]!.toLowerCase()) ? last : `${m[1]}${ext}`
    }
  } catch {
    /* fall through to a generated name */
  }
  return `image-${now}${ext}`
}

export type DataUrlDecode = { ok: true; mime: string; bytes: Uint8Array } | { ok: false; error: string }

/** Decode a data:image/… URL into its bytes, refusing other types and anything over the cap. */
export function decodeImageDataUrl(url: string, maxBytes: number = MAX_DROPPED_IMAGE_BYTES): DataUrlDecode {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),/i.exec(url)
  if (!m) return { ok: false, error: 'That is not a readable data: address.' }
  const mime = (m[1] ?? '').trim().toLowerCase()
  if (!mime.startsWith('image/')) return { ok: false, error: `That data: address holds ${mime || 'text'}, not an image.` }
  const base64 = /;base64/i.test(m[2] ?? '')
  const payload = url.slice(m[0].length)
  // Refuse before decoding: base64 is 4 characters per 3 bytes.
  const estimate = base64 ? Math.floor((payload.replace(/[^A-Za-z0-9+/]/g, '').length * 3) / 4) : payload.length / 3
  if (estimate > maxBytes) return { ok: false, error: 'The image is too large to attach (over 25 MB).' }
  let bytes: Uint8Array
  try {
    bytes = base64 ? base64ToBytes(payload) : percentToBytes(payload)
  } catch {
    return { ok: false, error: 'That data: image could not be read.' }
  }
  if (bytes.length > maxBytes) return { ok: false, error: 'The image is too large to attach (over 25 MB).' }
  const verdict = judgeImageBody(mime, bytes)
  if (!verdict.ok) return verdict
  return { ok: true, mime: verdict.mime, bytes }
}

function base64ToBytes(s: string): Uint8Array {
  const clean = decodeURIComponent(s).replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(clean)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Percent-encoded data (as an SVG usually is): %XX is a byte, anything else its UTF-8. */
function percentToBytes(s: string): Uint8Array {
  const out: number[] = []
  const enc = new TextEncoder()
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c === '%' && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      for (const byte of enc.encode(c)) out.push(byte)
    }
  }
  return Uint8Array.from(out)
}

/** A short, human label for where a dropped image came from: its host, or "a pasted image". */
export function imageSourceLabel(url: string): string {
  if (/^data:/i.test(url)) return 'the dropped image'
  try {
    return new URL(url).hostname.replace(/^www\./, '') || 'that address'
  } catch {
    return 'that address'
  }
}
