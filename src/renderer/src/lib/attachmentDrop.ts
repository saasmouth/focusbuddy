// Dropping a picture onto a table's attachment field (owner, 2026-11-04: "I
// need to be able to drag images from a browser into a table attachment field,
// in all layouts and in focus mode and focus tiled mode").
//
// A drop can carry what we want in three shapes, and which one depends on where
// the drag began:
//   - FILES: a drag from Finder, and often an <img> dragged out of a Chromium
//     page (a desk browser's <webview> hands over the picture's bytes);
//   - text/html: Chrome and the desk browser describe an image drag as
//     `<img src="…">`. Preferred over the URL list, because when the picture is
//     inside a link the URL list carries the LINK (a page), not the picture;
//   - text/uri-list (and a bare URL as text/plain): Safari, a dragged address.
// Files win outright (they are the bytes). Otherwise the image addresses are
// stored by the main process (files:ingestUrl), which fetches http(s) without
// CORS, decodes data:image, caps the size and checks it is really an image.
//
// What the drop ADDS is appended to the field, never put in place of it.
//
// Pure, apart from DOMParser for reading the dropped HTML (inert: nothing in
// it loads or runs). The React side is components/fields/useAttachmentDrop.

import { isAttachableImageAddress, imageSourceLabel } from '@shared/imageDrop'

/** The readable part of a DataTransfer (a real one, or a test's stand-in). */
export interface DropDataLike {
  readonly types: ArrayLike<string> | Iterable<string>
  readonly files?: ArrayLike<File> | null
  getData(type: string): string
}

/** Our own drags (work widgets, Files rows, documents, Kanban cards, connected apps): never an attachment. */
const INTERNAL_TYPE = /^(application\/(x-)?(fb|plexii)-|text\/fb-)/i

function typeList(types: DropDataLike['types'] | null | undefined): string[] {
  if (!types) return []
  try {
    return Array.from(types as Iterable<string>)
  } catch {
    return []
  }
}

/** Is this one of the app's own drags (a widget, a Files row, a document)? Those keep their own targets. */
export function isAppInternalDrag(types: DropDataLike['types'] | null | undefined): boolean {
  return typeList(types).some((t) => INTERNAL_TYPE.test(t))
}

/**
 * Might this drag hold something to attach? Only the TYPES are readable while a
 * drag is held (dragover), so this is the promise the highlight makes; the drop
 * itself then reads the data and says plainly if there was nothing usable.
 */
export function dragMayCarryAttachment(types: DropDataLike['types'] | null | undefined): boolean {
  const list = typeList(types)
  if (list.some((t) => INTERNAL_TYPE.test(t))) return false
  return list.includes('Files') || list.includes('text/uri-list') || list.includes('text/html')
}

/** The drop effect to show: copy where the source allows it, else whatever it does allow. */
export function pickDropEffect(effectAllowed: string | null | undefined): 'copy' | 'link' | 'move' {
  const a = (effectAllowed ?? 'all').toLowerCase()
  if (a === 'all' || a === 'uninitialized' || a.includes('copy')) return 'copy'
  if (a.includes('link')) return 'link'
  if (a.includes('move')) return 'move'
  return 'copy'
}

/** How many image addresses one drop may store (an HTML selection can carry dozens of icons). */
export const MAX_URLS_PER_DROP = 10

export interface AttachmentDropPayload {
  /** Files to store as they are (Finder, or the bytes a browser handed over). */
  files: File[]
  /** Image addresses to store (http(s) or data:image), in order, without repeats. */
  urls: string[]
  /** Addresses the drop carried that cannot be attached (blob:, file:, fb-file:, relative). */
  refused: string[]
}

/** RFC 2483: one URI per line, `#` lines are comments. */
export function parseUriList(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

/** The pictures named in dropped HTML: each <img>'s src (or, without one, its first srcset candidate). */
export function imageSrcsFromHtml(html: string | null | undefined): string[] {
  const text = html ?? ''
  if (!/<img[\s>]/i.test(text)) return []
  const out: string[] = []
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(text, 'text/html')
    for (const img of Array.from(doc.querySelectorAll('img'))) {
      const src = (img.getAttribute('src') ?? '').trim() || firstSrcset(img.getAttribute('srcset'))
      if (src) out.push(src)
    }
    return out
  }
  // No DOM (never the case in the renderer): a tolerant attribute scan.
  for (const m of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const v = (m[2] ?? m[3] ?? m[4] ?? '').trim().replace(/&amp;/g, '&')
    if (v) out.push(v)
  }
  return out
}

function firstSrcset(srcset: string | null): string {
  return (srcset ?? '').split(',')[0]?.trim().split(/\s+/)[0] ?? ''
}

/**
 * Read a drop: its files, else the image addresses it carries. Call it inside
 * the drop handler itself (getData only answers during the event).
 */
export function extractAttachmentDrop(dt: DropDataLike | null | undefined): AttachmentDropPayload {
  if (!dt) return { files: [], urls: [], refused: [] }
  const files = Array.from(dt.files ?? []).filter(Boolean)
  if (files.length > 0) return { files, urls: [], refused: [] }
  const read = (type: string): string => {
    try {
      return dt.getData(type) ?? ''
    } catch {
      return ''
    }
  }
  // HTML first: for a picture inside a link, the URL list names the page.
  let candidates = imageSrcsFromHtml(read('text/html'))
  if (candidates.length === 0) {
    candidates = parseUriList(read('text/uri-list'))
    if (candidates.length === 0) {
      const plain = read('text/plain').trim()
      // A bare address only; prose that mentions one is not a picture.
      if (plain && !/\s/.test(plain)) candidates = [plain]
    }
  }
  const urls: string[] = []
  const refused: string[] = []
  for (const c of candidates) {
    const s = c.trim()
    if (!s) continue
    if (isAttachableImageAddress(s)) {
      if (!urls.includes(s) && urls.length < MAX_URLS_PER_DROP) urls.push(s)
    } else if (!refused.includes(s)) {
      refused.push(s)
    }
  }
  return { files: [], urls, refused }
}

/**
 * The field's next value: what it held (an attachment field stores fb_files
 * ids), followed by the new ids. Appends, never replaces; an id already there
 * is not listed twice; a malformed stored value is treated as empty rather
 * than thrown away into a crash.
 */
export function appendAttachmentIds(current: unknown, ids: readonly string[]): string[] {
  const base = Array.isArray(current) ? current.filter((v): v is string => typeof v === 'string' && v.length > 0) : []
  const out = [...base]
  for (const id of ids) if (id && !out.includes(id)) out.push(id)
  return out
}

const DESKTOP_ONLY = 'Pictures from links can only be stored in the desktop app.'

/** What storing needs: the two file-ingest calls (window.api.files in the app). */
export interface AttachDeps {
  ingestBuffer: (input: { buffer: ArrayBuffer; originalName: string; mimeType: string }) => Promise<{ id: string }>
  ingestUrl?: (url: string) => Promise<{ ok: boolean; file?: { id: string }; error?: string }>
}

export interface AttachFailure {
  /** A file's name, or the host an image came from. */
  what: string
  /** A sentence worth showing. */
  why: string
}

export interface AttachOutcome {
  ids: string[]
  failures: AttachFailure[]
}

/**
 * Store everything a drop carried, one at a time (ingest writes to disk and
 * the database; twenty parallel writes is a spinner that never ends). One bad
 * item never loses the others; each failure is named.
 */
export async function ingestAttachmentDrop(payload: AttachmentDropPayload, deps: AttachDeps): Promise<AttachOutcome> {
  const ids: string[] = []
  const failures: AttachFailure[] = []
  for (const file of payload.files) {
    try {
      const stored = await deps.ingestBuffer({
        buffer: await file.arrayBuffer(),
        originalName: file.name || 'dropped-file',
        mimeType: file.type || 'application/octet-stream'
      })
      if (stored?.id) ids.push(stored.id)
      else failures.push({ what: file.name || 'the file', why: 'It could not be stored.' })
    } catch (err) {
      failures.push({ what: file.name || 'the file', why: err instanceof Error && err.message ? err.message : 'It could not be read.' })
    }
  }
  for (const url of payload.urls) {
    const what = imageSourceLabel(url)
    if (!deps.ingestUrl) {
      failures.push({ what, why: DESKTOP_ONLY })
      continue
    }
    try {
      const res = await deps.ingestUrl(url)
      if (res?.ok && res.file?.id) ids.push(res.file.id)
      else failures.push({ what, why: res?.error || 'The image could not be stored.' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      // The browser build has no main process to fetch with; its refusal names
      // a channel, which means nothing to the person dropping a picture.
      failures.push({ what, why: /not available in the browser runtime/i.test(msg) ? DESKTOP_ONLY : msg || 'The image could not be stored.' })
    }
  }
  return { ids, failures }
}

const ONLY_IN_PAGE =
  'That picture only exists inside the page it came from, so it cannot be attached. Save it, then drop the file here.'
const NOT_WEB = 'Only pictures from the web (http, https or data:) and files can be attached here.'

/**
 * The one line to show after a drop, or null when everything it carried was
 * attached. Nothing usable, a refused address, and a failed fetch all say so:
 * a drop never ends in silence.
 */
export function attachDropNotice(payload: AttachmentDropPayload, outcome: AttachOutcome | null): string | null {
  const offered = payload.files.length + payload.urls.length
  if (offered === 0) {
    if (payload.refused.some((u) => /^blob:/i.test(u))) return ONLY_IN_PAGE
    if (payload.refused.length > 0) return NOT_WEB
    return 'Nothing to attach. Drop a picture from a browser, or a file.'
  }
  if (!outcome) return null
  const failed = outcome.failures
  if (failed.length === 0) return null
  const first = failed[0]!
  if (outcome.ids.length === 0) {
    if (failed.length === 1) {
      const noun = payload.files.length > 0 ? first.what : `the image from ${first.what}`
      return `Could not attach ${noun}. ${first.why}`
    }
    return `Could not attach any of the ${failed.length} items. ${first.what}: ${first.why}`
  }
  const names = failed.map((f) => f.what).join(', ')
  return `Attached ${outcome.ids.length} of ${offered}. Could not attach ${names}. ${first.why}`
}
