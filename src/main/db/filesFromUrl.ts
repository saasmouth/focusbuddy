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
import { ingestFromBuffer } from './files'
import type { FbFile } from '@shared/fields'

// Large enough for a real screenshot, small enough that a mistaken URL cannot
// pull something enormous into the Drive.
const MAX_FETCH_BYTES = 25 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000

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

function nameFromUrl(url: string, mime: string): string {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop() ?? ''
    if (/\.[a-z0-9]{2,5}$/i.test(last)) return last
  } catch {
    /* fall through to a generated name */
  }
  const ext = mime.includes('png')
    ? '.png'
    : mime.includes('webp')
      ? '.webp'
      : mime.includes('gif')
        ? '.gif'
        : mime.includes('svg')
          ? '.svg'
          : '.jpg'
  return `image-${Date.now()}${ext}`
}

/**
 * Fetch a remote image and store it in the Drive.
 *
 * Never throws: a link that cannot be fetched is a normal outcome here -- the
 * session expired, the host refuses us, the URL rotated -- and the caller keeps
 * the original URL so the widget is no worse off than before.
 */
export async function ingestImageFromUrl(
  url: string,
  opts: { parentId?: string | null } = {}
): Promise<InternaliseResult> {
  if (!isRemoteImageUrl(url)) return { ok: false, error: 'Not a remote URL.' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) {
      // 401/403/422 here is the interesting case: the link needs a session this
      // app does not have, which is exactly why it must not stay a link.
      return { ok: false, error: `The image could not be fetched (${res.status}).` }
    }
    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (mime && !mime.startsWith('image/')) {
      return { ok: false, error: `That address returned ${mime || 'no image'}.` }
    }
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length === 0) return { ok: false, error: 'The image was empty.' }
    if (buf.length > MAX_FETCH_BYTES) {
      return { ok: false, error: 'The image is too large to store.' }
    }
    const file = await ingestFromBuffer({
      buffer: buf,
      originalName: nameFromUrl(url, mime || 'image/jpeg'),
      mimeType: mime || 'image/jpeg',
      parentId: opts.parentId ?? null
    })
    return { ok: true, file }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg.includes('abort') ? 'The image took too long to fetch.' : msg }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Store every linked image on a desk, so its pictures survive the links.
 *
 * Walks image widgets whose content is still a URL, fetches each, and rewrites
 * the widget to point at the stored file. A widget whose link cannot be fetched
 * is left exactly as it was and reported -- a picture that only ever existed
 * behind someone else's login cannot be rescued, and pretending otherwise by
 * blanking the widget would destroy the one clue about where it came from.
 */
export async function internaliseDeskImages(
  deskId: string
): Promise<{ stored: number; failed: Array<{ widgetId: string; url: string; error: string }> }> {
  const { getDb } = await import('./database')
  const { updateWidget } = await import('./widgets')
  const rows = getDb()
    .prepare(
      `SELECT id, content FROM widgets
        WHERE task_id = ? AND trashed_at IS NULL AND kind IN ('image', 'file')`
    )
    .all(deskId) as Array<{ id: string; content: string | null }>

  let stored = 0
  const failed: Array<{ widgetId: string; url: string; error: string }> = []
  for (const w of rows) {
    const url = (w.content ?? '').trim()
    if (!isRemoteImageUrl(url)) continue
    const res = await ingestImageFromUrl(url)
    if (res.ok && res.file) {
      updateWidget(w.id, { content: `fb-file://${res.file.id}` })
      stored++
    } else {
      failed.push({ widgetId: w.id, url, error: res.error ?? 'Unknown error.' })
    }
  }
  return { stored, failed }
}
