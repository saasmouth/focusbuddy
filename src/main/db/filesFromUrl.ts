// Turning a linked image into an owned one.
//
// A picture dragged out of a chat or a web page arrives as a URL, and the desk
// stores the URL. That looks fine on the machine it was dropped on and is not
// really a file at all: nothing was saved, and whether it ever appears again
// depends on a server we do not control and, often, on a login we do not have.
//
// One real desk had 21 image widgets pointing at
// chatgpt.com/backend-api/estuary/content?id=... -- links into a chat session.
// They render for a browser holding that session and return 422 for everyone
// else, so the pictures were invisible in the cloud app, would be invisible to
// anyone the desk was shared with, and will eventually be invisible to their
// owner too.
//
// Fetching the bytes once and putting them in the Drive fixes all of those at
// the same time: the desk owns the picture, it syncs like any other file, it
// survives the link rotating, and it goes through the same downsampling as
// every other image.
//
// Desktop only, deliberately. A main-process fetch has no CORS to satisfy; the
// same fetch from a browser tab would be refused for most hosts, so the browser
// keeps rendering the link and inherits the fix when the desktop rewrites it.
//
// It is also how a table's attachment field takes a picture dragged out of a
// browser (2026-11-04, lib/attachmentDrop): the drop carries an address, the
// bytes are fetched here, and data:image addresses are decoded rather than
// fetched. Either way they are capped and must really be an image
// (@shared/imageDrop) before a byte is stored.
import { ingestFromBuffer } from './files'
import type { FbFile } from '@shared/fields'
import {
  MAX_DROPPED_IMAGE_BYTES,
  decodeImageDataUrl,
  imageNameFromUrl,
  judgeImageBody
} from '@shared/imageDrop'

// Large enough for a real screenshot, small enough that a mistaken URL cannot
// pull something enormous into the Drive. Enforced while the body streams in
// (and from Content-Length before it does), not after it has all been read.
const MAX_FETCH_BYTES = MAX_DROPPED_IMAGE_BYTES
const FETCH_TIMEOUT_MS = 20_000
const TOO_LARGE = 'The image is too large to attach (over 25 MB).'

export interface InternaliseResult {
  ok: boolean
  file?: FbFile
  /** Why it could not be stored, in words worth showing someone. */
  error?: string
}

/** Whether this is a remote URL worth trying to store. */
export function isRemoteImageUrl(content: string | null | undefined): boolean {
  const s = (content ?? '').trim()
  if (!/^https?:\/\//i.test(s)) return false
  // A data: URL is already the bytes, and a blob: URL is this session's own.
  return true
}

/** The address's own filename; else the one it redirected to (an ?id= endpoint onto a CDN file); else a generated one. */
function nameFor(asked: string, landed: string | undefined, mime: string): string {
  const now = Date.now()
  const first = imageNameFromUrl(asked, mime, now)
  if (!landed || landed === asked || !first.startsWith(`image-${now}`)) return first
  return imageNameFromUrl(landed, mime, now)
}

/** Read a response body, giving up the moment it passes `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body
  if (!body || typeof body.getReader !== 'function') {
    const buf = new Uint8Array(await res.arrayBuffer())
    return buf.length > max ? null : buf
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/**
 * Store a dropped or linked image in the Drive: an http(s) address is fetched
 * here (no CORS in the main process), a data:image address is decoded. Both
 * are size-capped and must really be an image (judgeImageBody) before a byte
 * is stored.
 *
 * Never throws: a link that cannot be fetched is a normal outcome here -- the
 * session expired, the host refuses us, the URL rotated -- and the caller keeps
 * the original URL (an image work widget) or says so (an attachment drop).
 */
export async function ingestImageFromUrl(
  url: string,
  opts: { parentId?: string | null } = {}
): Promise<InternaliseResult> {
  const address = (url ?? '').trim()
  if (/^data:/i.test(address)) {
    const decoded = decodeImageDataUrl(address, MAX_FETCH_BYTES)
    if (!decoded.ok) return { ok: false, error: decoded.error }
    try {
      const file = await ingestFromBuffer({
        buffer: decoded.bytes,
        originalName: imageNameFromUrl(address, decoded.mime),
        mimeType: decoded.mime,
        parentId: opts.parentId ?? null
      })
      return { ok: true, file }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
  if (!isRemoteImageUrl(address)) return { ok: false, error: 'Only web (http or https) and data: images can be stored.' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(address, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Ask for a picture (some CDNs negotiate the format), as a browser would.
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PlexiiDesk/1.0'
      }
    })
    if (!res.ok) {
      // 401/403/422 here is the interesting case: the link needs a session this
      // app does not have, which is exactly why it must not stay a link.
      return { ok: false, error: `The image could not be fetched (${res.status}).` }
    }
    const declared = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    // Refuse what is plainly not a picture before reading a byte of it.
    if (declared && !declared.startsWith('image/') && declared !== 'application/octet-stream' && declared !== 'binary/octet-stream') {
      await res.body?.cancel().catch(() => undefined)
      return {
        ok: false,
        error: declared === 'text/html' || declared === 'application/xhtml+xml'
          ? 'That address is a web page, not an image.'
          : `That address returned ${declared}, not an image.`
      }
    }
    const length = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(length) && length > MAX_FETCH_BYTES) {
      await res.body?.cancel().catch(() => undefined)
      return { ok: false, error: TOO_LARGE }
    }
    const buf = await readCapped(res, MAX_FETCH_BYTES)
    if (!buf) return { ok: false, error: TOO_LARGE }
    const verdict = judgeImageBody(declared, buf)
    if (!verdict.ok) return { ok: false, error: verdict.error }
    const file = await ingestFromBuffer({
      buffer: buf,
      originalName: nameFor(address, res.url, verdict.mime),
      mimeType: verdict.mime,
      parentId: opts.parentId ?? null
    })
    return { ok: true, file }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: /abort/i.test(msg) ? 'The image took too long to fetch.' : msg }
  } finally {
    clearTimeout(timer)
  }
}
