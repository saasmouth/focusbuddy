// Copy and paste for canvas elements — the slides, pages and designs clipboard.
//
// PlexiiDesign and PlexiiDeck both hold a page as SlideElement[], and both had
// ⌘D (duplicate in place) and nothing else: no ⌘C, no ⌘V, no Edit › Copy. You
// could not take a shape from one page to another, or from one document to
// another, which is most of what a person does with a layout tool.
//
// What goes on the clipboard, written in one copy event:
//   - this module's JSON under a private MIME type, which is what a paste back
//     into the suite reads: the elements exactly, with their groups;
//   - the words in those elements as text/plain, so a paste into a message or
//     a document gets the copy rather than a wall of JSON.
//
// Everything that comes back is UNTRUSTED. It has been through the system
// clipboard, where another app (or a person with a text editor) can rewrite
// it, so parse() validates the shape and paste() mints fresh ids rather than
// trusting the ones it is given.
//
// Pure on purpose: no DOM, no ClipboardEvent, no React. The editors own the
// events; this owns what the payload means. That is what makes the awkward
// parts — group remapping, z-order, clamping a paste back onto the canvas —
// testable without an app.

import type { SlideElement } from './types'

export const ELEMENT_CLIP_KIND = 'plexii/elements'
export const ELEMENT_CLIP_VERSION = 1

/**
 * The private clipboard type. Chromium allows an arbitrary type on a DataTransfer
 * in a copy handler, and hands it back verbatim on paste, which is what lets a
 * paste tell "elements I copied" from "text someone copied".
 */
export const ELEMENT_CLIP_MIME = 'application/x-plexii-elements'

export interface ElementClipboard {
  kind: typeof ELEMENT_CLIP_KIND
  version: number
  /** The canvas the elements were copied from, so a paste can keep them on the page. */
  source: { w: number; h: number }
  /** The copied elements, in their original z order. Ids are the source's; a paste mints new ones. */
  elements: SlideElement[]
}

/** Build the payload for a copy. */
export function buildElementClipboard(elements: SlideElement[], source: { w: number; h: number }): ElementClipboard {
  return {
    kind: ELEMENT_CLIP_KIND,
    version: ELEMENT_CLIP_VERSION,
    source: { w: Math.max(1, Math.round(source.w)), h: Math.max(1, Math.round(source.h)) },
    // Sorted by z so a paste can lay them back down in the same order whatever
    // order the selection was made in.
    elements: [...elements].sort((a, b) => (a.z ?? 0) - (b.z ?? 0)).map((e) => clone(e))
  }
}

export function serializeElementClipboard(clip: ElementClipboard): string {
  return JSON.stringify(clip)
}

/**
 * Parse what came back off the clipboard, or null when it is not ours.
 *
 * Deliberately strict about the envelope and forgiving about the elements: an
 * element from a newer version of the app may carry fields this one does not
 * know, and dropping it would lose someone's artwork for no reason. What must
 * hold is that every element has an id, a type and finite geometry — anything
 * else cannot be drawn and would land as an invisible, unselectable ghost.
 */
export function parseElementClipboard(text: string | null | undefined): ElementClipboard | null {
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Partial<ElementClipboard>
  if (o.kind !== ELEMENT_CLIP_KIND) return null
  if (!Array.isArray(o.elements)) return null
  const elements = o.elements.filter(isDrawable)
  if (elements.length === 0) return null
  const w = num(o.source?.w, 0)
  const h = num(o.source?.h, 0)
  return {
    kind: ELEMENT_CLIP_KIND,
    version: typeof o.version === 'number' ? o.version : ELEMENT_CLIP_VERSION,
    source: { w: w > 0 ? w : 0, h: h > 0 ? h : 0 },
    elements: elements.map((e) => clone(e))
  }
}

/** The words in these elements, for the text/plain flavour of a copy. */
export function elementsPlainText(elements: SlideElement[]): string {
  const out: string[] = []
  for (const e of [...elements].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (e.type !== 'text') continue
    const t = e as { flowLines?: Array<{ text: string }>; paragraphs?: Array<{ runs?: Array<{ text: string }> }> }
    const text = t.flowLines?.length
      ? t.flowLines.map((l) => l.text).join(' ')
      : (t.paragraphs ?? []).map((p) => (p.runs ?? []).map((r) => r.text).join('')).join('\n')
    if (text.trim()) out.push(text.trim())
  }
  return out.join('\n\n')
}

export interface PasteOptions {
  /** The canvas being pasted onto. */
  canvas: { w: number; h: number }
  /** Highest z currently on the page, so the paste lands on top. */
  topZ: number
  /** Fresh element id. The caller's, because ids are minted differently per editor. */
  newId: () => string
  /**
   * How far to nudge the paste, so it does not hide exactly behind the
   * original. Default 20, as ⌘D uses. Pass 0 for a paste in place.
   */
  offset?: number
  /** A group id for pasted elements that were grouped. Defaults to a derived one. */
  newGroupId?: (oldId: string) => string
}

/**
 * Turn a payload into elements ready to add to a page.
 *
 * Three things have to be right, and each was a bug in some editor in this
 * codebase at some point:
 *
 *   FRESH IDS, deeply. Two elements sharing an id makes selection and
 *   deletion ambiguous; two elements sharing a nested object (a fill, a
 *   paragraph) means editing one edits the other — the bug fixed in 6d22bff2
 *   for ⌘D.
 *
 *   GROUPS REMAPPED. Keeping the source's groupId puts the pasted copy into
 *   the original's group, so dragging one drags the other, from a different
 *   page or even a different document.
 *
 *   ON THE PAGE. A nudged paste near the right edge, or a paste from a bigger
 *   canvas, lands partly outside the page where it cannot be seen or clicked.
 *   The nudge is dropped before anything is allowed off the edge.
 */
export function pasteElements(clip: ElementClipboard, opts: PasteOptions): SlideElement[] {
  const nudge = opts.offset ?? 20
  const groups = new Map<string, string>()
  const groupFor = (old: string): string => {
    const seen = groups.get(old)
    if (seen) return seen
    const next = opts.newGroupId ? opts.newGroupId(old) : `grp-${opts.newId()}`
    groups.set(old, next)
    return next
  }

  // One nudge for the whole paste, not per element, so a group keeps its shape.
  const bounds = boundsOf(clip.elements)
  const dx = fitShift(bounds.x + nudge, bounds.w, opts.canvas.w) - bounds.x
  const dy = fitShift(bounds.y + nudge, bounds.h, opts.canvas.h) - bounds.y

  return clip.elements.map((src, i) => {
    const e = clone(src) as SlideElement & { groupId?: string | null }
    e.id = opts.newId()
    e.x = round2(e.x + dx)
    e.y = round2(e.y + dy)
    // Relative order kept, all of it above whatever is already on the page.
    e.z = opts.topZ + 1 + i
    if (e.groupId) e.groupId = groupFor(e.groupId)
    return e
  })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** Can this be drawn at all? Anything else would be an invisible ghost. */
function isDrawable(v: unknown): v is SlideElement {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    e.id !== '' &&
    typeof e.type === 'string' &&
    e.type !== '' &&
    Number.isFinite(e.x) &&
    Number.isFinite(e.y) &&
    Number.isFinite(e.w) &&
    Number.isFinite(e.h)
  )
}

/** structuredClone where it exists, a JSON round trip where it does not. */
function clone<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v)
  return JSON.parse(JSON.stringify(v)) as T
}

function boundsOf(els: SlideElement[]): { x: number; y: number; w: number; h: number } {
  if (els.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  const x = Math.min(...els.map((e) => e.x))
  const y = Math.min(...els.map((e) => e.y))
  const r = Math.max(...els.map((e) => e.x + e.w))
  const b = Math.max(...els.map((e) => e.y + e.h))
  return { x, y, w: r - x, h: b - y }
}

/**
 * Where an edge of the given size can sit so it stays on the canvas: the
 * wanted position, pulled back from the far edge, but never past 0 — something
 * larger than the page keeps its top-left corner on it rather than being
 * centred off the other side.
 */
function fitShift(wanted: number, size: number, canvas: number): number {
  return Math.max(0, Math.min(wanted, canvas - size))
}
