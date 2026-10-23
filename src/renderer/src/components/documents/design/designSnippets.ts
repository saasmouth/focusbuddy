import { useEffect, useRef } from 'react'
import type { SlideElement, SlideFill, SlideTextElement } from '@shared/types'
import type { DesignSnippetBody, Snippet, SnippetTarget } from '@shared/snippets'
import {
  buildElementClipboard,
  ELEMENT_CLIP_KIND,
  ELEMENT_CLIP_VERSION,
  parseElementClipboard,
  pasteElements
} from '@shared/elementClipboard'
import { storyFrames, withPages, type DesignBody, type DesignPage } from '@shared/design'
import { normalizeContent, toPlainText, type ContentDoc } from '@shared/designContent'
import { defaultSwatches, swatchId as mintSwatchId, tintedColor, type DesignSwatch, type SwatchRef } from '@shared/designSwatches'
import { DEFAULT_BRAND_KIT, type OrgBrandKit } from '@shared/brandKit'
import { registerSnippetTarget } from '../../../stores/snippets'
import { insertIntoOffice, officeAccepts } from '../../../lib/officeSnippets'
import { READ_ONLY_REASON } from '../../office/shell/primitives'

// PlexiiDesign as a snippet surface: how selected page elements become a saved
// snippet, and how a saved one gets back onto a page.
//
// A design snippet is Design's copy and paste with a name. Capture runs the
// clipboard's own builder (z-sorted deep copy) and insertion runs the
// clipboard's own validating parser and paste engine (fresh ids deeply,
// groups remapped, z above everything on the page, clamped onto the page).
// On top of that it carries the two things a design element can POINT AT
// rather than hold, because a fragment without them lands broken:
//
//   STORIES. A threaded text frame holds no text: it shows a slice of a story
//   that lives once on the document (DesignBody.stories). The stories the
//   selected frames read travel in the body; insertion gives each one a FRESH
//   story id and points the new frames at it, so the copy is an independent
//   story and never joins the original's chain. Threads between frames inside
//   the selection are kept, in their original order. Threads to frames
//   outside the selection are cut: the copy is a chain of just the selected
//   frames, and it carries the WHOLE story, as InDesign does when one frame
//   of a threaded story is copied. Whatever no longer fits shows as overset
//   (the red marker), so no words are ever silently dropped.
//
//   SWATCHES. A fill can name a swatch (`fill.swatchId`). The swatches the
//   fills name travel in the body and are RESOLVED BY NAME on insert: a
//   destination swatch with the same name wins (the fill is pointed at it and
//   its cached colour rewritten to what that swatch draws, the invariant
//   designSwatches.ts keeps), otherwise the swatch is added to the
//   destination's palette under a fresh id. No swatch id is ever left
//   dangling.
//
// Paragraph styles are NOT carried, deliberately. A story's blocks name no
// style: each block resolves through the DOCUMENT's sheet by its kind (Body,
// Heading 1, Quote…, styleIdForBlock), and normalizeContent strips any
// explicit override on load. So a heading lands set as the destination's
// Heading 1, which is what pasting text into another document means, and
// there is no style id that could dangle.
//
// DUPLICATE ONLY, on purpose. See "Why a design offers Duplicate only" in
// docs/saved-snippets.md.

/** One place both host and picker agree on. */
export function designSnippetTargetId(instanceId: string): string {
  return `design:${instanceId}`
}

/** The link modes a design honours. Exported so the unit test asserts the real list. */
export const DESIGN_SNIPPET_LINKS: SnippetTarget['supports'] = ['duplicate']

/** A story id the way linkFrames mints one, with room for several in one millisecond. */
export function newDesignStoryId(): string {
  return `story-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// ── Capture ──────────────────────────────────────────────────────────────────

/**
 * The elements on the surface being edited: the open master's furniture while
 * a master is being edited, otherwise the active page (whose live copy is the
 * top-level `elements`).
 */
function surfaceElements(design: DesignBody): SlideElement[] {
  if (design.editingMasterId) {
    return (design.masters ?? []).find((m) => m.id === design.editingMasterId)?.elements ?? []
  }
  return design.elements ?? []
}

/**
 * The pages with the active page's live elements in place, so chain order is
 * read from what is on screen even when the mirror has not been synced yet.
 */
function pagesView(design: DesignBody): DesignBody {
  const base = withPages(design)
  const active = base.activePage ?? 0
  const pages = (base.pages ?? []).map((p, i) => (i === active && !design.editingMasterId ? { ...p, elements: design.elements ?? [] } : p))
  return { ...base, pages }
}

/**
 * Turn the selected elements into a design snippet body.
 *
 * Pure. Returns null when nothing is selected (or the ids match nothing on the
 * surface), rather than an empty body: the caller must tell "nothing to save"
 * from "saved something empty".
 *
 * Positions are made relative to the selection's top-left, z is renumbered
 * 0..n-1 in the original stacking order, and group ids are kept (insertion
 * remaps them). A threaded frame carries its story (see the header); its
 * flowLines and overset flag are dropped, because they are a cache of the
 * flow through THIS document's chain and the destination re-flows it. A fill
 * naming a swatch carries that swatch; a fill naming a swatch this document
 * no longer has keeps its colour and loses the dead link, as detaching does.
 */
export function designBodyFromSelection(design: DesignBody | null | undefined, selectedIds: readonly string[]): DesignSnippetBody | null {
  if (!design || selectedIds.length === 0) return null
  const ids = new Set(selectedIds)
  const picked = surfaceElements(design).filter((e) => ids.has(e.id))
  if (picked.length === 0) return null

  const { elements } = buildElementClipboard(picked, { w: design.width, h: design.height })

  // Stories: which selected frames read which story, in chain order.
  const view = pagesView(design)
  const stories: Record<string, ContentDoc> = {}
  const orderOf = new Map<string, number>()
  const storyIdsHere = new Set(
    elements.filter((e): e is SlideTextElement => e.type === 'text' && !!e.storyId).map((e) => e.storyId as string)
  )
  for (const sid of storyIdsHere) {
    const doc = design.stories?.[sid]
    const normalised = doc ? normalizeContent(doc) : null
    if (!normalised || normalised.blocks.length === 0) continue
    stories[sid] = normalised
    const chain = storyFrames(view, sid)
      .map((f) => f.element.id)
      .filter((id) => ids.has(id))
    // A frame the chain scan did not see (a master's, or an unsynced one) goes
    // last, in its stored order, rather than being dropped.
    const rest = elements
      .filter((e): e is SlideTextElement => e.type === 'text' && e.storyId === sid && !chain.includes(e.id))
      .sort((a, b) => (a.storyOrder ?? 0) - (b.storyOrder ?? 0))
      .map((e) => e.id)
    ;[...chain, ...rest].forEach((id, i) => orderOf.set(id, i + 1))
  }

  // Swatches: exactly those the fills name and this document defines.
  const palette = new Map((design.swatches ?? []).map((s) => [s.id, s]))
  const carried = new Map<string, DesignSwatch>()

  const minX = Math.min(...elements.map((e) => e.x))
  const minY = Math.min(...elements.map((e) => e.y))
  const out = elements.map((src, i) => {
    let e = translate({ ...src, z: i } as SlideElement, -minX, -minY)
    if (e.type === 'text') {
      const t = { ...e } as SlideTextElement
      delete t.flowLines
      delete t.overset
      if (t.storyId) {
        if (stories[t.storyId]) t.storyOrder = orderOf.get(t.id) ?? 1
        else {
          // The story it named is gone from this document: it showed nothing,
          // and a copy pointing nowhere would land as a dangling reference.
          delete t.storyId
          delete t.storyOrder
        }
      }
      e = t
    }
    const fill = (e as { fill?: SlideFill & SwatchRef }).fill
    if (fill?.swatchId) {
      const sw = palette.get(fill.swatchId)
      if (sw) carried.set(sw.id, structuredClone(sw))
      else e = { ...e, fill: detached(fill) } as SlideElement
    }
    return e
  })

  return {
    kind: 'design',
    elements: out,
    ...(Object.keys(stories).length ? { stories } : {}),
    ...(carried.size ? { swatches: [...carried.values()] } : {})
  }
}

/** A default name for the save dialog: the first words in the block, or what it holds. */
export function suggestedDesignSnippetName(body: DesignSnippetBody): string {
  const els = body.elements as SlideElement[]
  const words: string[] = []
  for (const e of [...els].sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (e.type !== 'text') continue
    const story = e.storyId ? body.stories?.[e.storyId] : undefined
    const text = story
      ? toPlainText(normalizeContent(story))
      : (e.paragraphs ?? []).map((p) => (p.runs ?? []).map((r) => r.text).join('')).join('\n')
    if (text.trim()) words.push(text)
  }
  const first = words
    .join('\n')
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  if (first) {
    const cut = first.length > 60 ? first.slice(0, 57).replace(/\s+\S*$/, '') : first
    return cut.replace(/[:.,;\s]+$/, '')
  }
  if (els.length === 1) return TYPE_NAME[els[0]?.type ?? ''] ?? 'Design element'
  return `${els.length} design elements`
}

const TYPE_NAME: Record<string, string> = {
  text: 'Text frame',
  shape: 'Shape',
  line: 'Line',
  image: 'Image',
  table: 'Table',
  chart: 'Chart',
  widget: 'Work widget embed'
}

// ── Insertion ────────────────────────────────────────────────────────────────

export interface DesignSnippetPlacement {
  /** Mints an element id the way the editor does. */
  newId: () => string
  /** Mints a story id. Defaults to newDesignStoryId. */
  newStoryId?: () => string
  /** The design cannot be edited right now. */
  readOnly: boolean
  /** The brand kit, for the default palette a document with none starts from. */
  brand?: OrgBrandKit
  /**
   * Where the block's centre goes, in page coordinates (a drop from Files lands
   * where it was dropped). Absent: centred on the page, as before. Additive
   * (Files beside, Phase 3); the block is kept on the page.
   */
  centre?: { x: number; y: number }
}

export type DesignSnippetLanding = { body: DesignBody; ids: string[] } | { declined: string }

/**
 * The design with a duplicate of the snippet on the surface being edited, or
 * the reason it declined.
 *
 * Pure, and never mutates the snippet or the design: the body is untrusted (it
 * has been through the database, which another version of the app may have
 * written), so the elements go through the clipboard's validating parser,
 * which clones them and drops anything that cannot be drawn. The block is
 * centred on the page and handed to the paste engine with no nudge, which
 * mints fresh ids, remaps groups, stacks it on top and clamps it onto the page.
 *
 * Then what the elements point at is landed with them: each story under a
 * fresh story id, each swatch resolved by name or added, and a layer that this
 * document does not have, or has hidden or locked, dropped so the copy lands
 * on the base layer where it can be seen and selected.
 *
 * The returned body is fully synced: `pages` is materialised (a design's one
 * page is implied until something needs it) and the active page's elements are
 * the SAME array as the top-level `elements`, the mirror the editor keeps. One
 * commit of it is one undo step.
 */
export function insertDesignSnippet(design: DesignBody, snippet: Snippet, at: DesignSnippetPlacement): DesignSnippetLanding {
  if (at.readOnly) return { declined: READ_ONLY_REASON }
  if (snippet.kind !== 'design' || snippet.body.kind !== 'design') return { declined: 'That snippet is not a design snippet.' }
  const body = snippet.body
  if (!Array.isArray(body.elements)) return { declined: 'That snippet has nothing in it to insert.' }
  const clip = parseElementClipboard(
    JSON.stringify({ kind: ELEMENT_CLIP_KIND, version: ELEMENT_CLIP_VERSION, source: { w: design.width, h: design.height }, elements: body.elements })
  )
  if (!clip) return { declined: 'That snippet has nothing in it that can be drawn.' }

  // Stories, validated as a loaded document validates them. A frame naming a
  // story the body does not carry (or an empty one) becomes a plain frame.
  const carriedStories = new Map<string, ContentDoc>()
  const rawStories = body.stories && typeof body.stories === 'object' ? body.stories : {}
  for (const [sid, raw] of Object.entries(rawStories)) {
    const doc = normalizeContent(raw)
    if (doc.blocks.length) carriedStories.set(sid, doc)
  }
  const threaded = clip.elements.some((e) => e.type === 'text' && !!e.storyId && carriedStories.has(e.storyId))
  if (threaded && design.editingMasterId) {
    // A master's frames are never part of the flow (storyFrames reads pages),
    // so threaded text on a master would land as an empty box.
    return { declined: 'Threaded text cannot go on a master page. Stop editing the master and insert it on a page.' }
  }

  const surface = surfaceElements(design)
  const topZ = surface.reduce((m, e) => Math.max(m, e.z ?? 0), 0)
  const minX = Math.min(...clip.elements.map((e) => e.x))
  const minY = Math.min(...clip.elements.map((e) => e.y))
  const w = Math.max(...clip.elements.map((e) => e.x + e.w)) - minX
  const h = Math.max(...clip.elements.map((e) => e.y + e.h)) - minY
  // Centred: the body carries no position of its own, so the destination
  // decides, and the middle of the page is where a person is looking.
  const left = at.centre ? Math.max(0, Math.min(design.width - w, Math.round(at.centre.x - w / 2))) : Math.round((design.width - w) / 2)
  const top = at.centre ? Math.max(0, Math.min(design.height - h, Math.round(at.centre.y - h / 2))) : Math.round((design.height - h) / 2)
  const dx = left - minX
  const dy = top - minY
  const centred = { ...clip, elements: clip.elements.map((e) => translate(e, dx, dy)) }
  const pasted = pasteElements(centred, { canvas: { w: design.width, h: design.height }, topZ, newId: at.newId, offset: 0 }).map((e, i) => {
    const src = centred.elements[i]
    if (!src) return e
    const moved = translateLineEnd(e, e.x - src.x, e.y - src.y)
    // The story a frame read is taken from the SOURCE element, never from what
    // pasteElements returned: an ordinary paste may drop storyId/storyOrder
    // (it cannot know which stories travelled), and the remap below must see
    // the snippet's own ids to give each carried story a fresh one.
    if (moved.type === 'text' && src.type === 'text') {
      const t = { ...moved } as SlideTextElement
      const from = src as SlideTextElement
      if (from.storyId) {
        t.storyId = from.storyId
        if (from.storyOrder !== undefined) t.storyOrder = from.storyOrder
      }
      return t
    }
    return moved
  })

  // Fresh story ids, never one the destination already uses.
  const mint = at.newStoryId ?? newDesignStoryId
  const taken = new Set(Object.keys(design.stories ?? {}))
  const storyMap = new Map<string, string>()
  for (const sid of carriedStories.keys()) {
    let next = mint()
    while (taken.has(next)) next = mint()
    taken.add(next)
    storyMap.set(sid, next)
  }

  // Swatches, resolved by name against the destination's palette.
  const carriedSwatches = new Map<string, DesignSwatch>()
  for (const raw of Array.isArray(body.swatches) ? body.swatches : []) {
    const s = readSwatch(raw)
    if (s) carriedSwatches.set(s.id, s)
  }
  // A holder, not a `let`: TypeScript does not see a closure assign it.
  const pal: { list: DesignSwatch[] | null } = { list: null }
  const swatchMap = new Map<string, DesignSwatch>()
  const resolveSwatch = (oldId: string): DesignSwatch | null => {
    const seen = swatchMap.get(oldId)
    if (seen) return seen
    const carried = carriedSwatches.get(oldId)
    if (!carried) return null
    // A document with no palette shows the default one (Brand primary, Black,
    // White…), so that is what a name is resolved against, and what is
    // written when the first reference lands.
    if (!pal.list) pal.list = [...(design.swatches ?? defaultSwatches(at.brand ?? DEFAULT_BRAND_KIT))]
    const palette = pal.list
    const name = carried.name.trim().toLowerCase()
    let target = palette.find((s) => s.name.trim().toLowerCase() === name) ?? null
    if (!target) {
      target = {
        id: mintSwatchId(carried.name, palette.map((s) => s.id)),
        name: carried.name,
        color: carried.color,
        ...(carried.spot ? { spot: { inkName: carried.spot.inkName } } : {})
      }
      palette.push(target)
    }
    swatchMap.set(oldId, target)
    return target
  }

  const layers = new Map((design.layers ?? []).map((l) => [l.id, l]))

  const landed = pasted.map((src) => {
    let e = src
    if (e.type === 'text') {
      const t = { ...e } as SlideTextElement
      delete t.flowLines
      delete t.overset
      const mapped = t.storyId ? storyMap.get(t.storyId) : undefined
      if (mapped) {
        t.storyId = mapped
        t.paragraphs = []
      } else {
        delete t.storyId
        delete t.storyOrder
      }
      e = t
    }
    const fill = (e as { fill?: SlideFill & SwatchRef }).fill
    if (fill?.swatchId) {
      const target = resolveSwatch(fill.swatchId)
      const next: SlideFill & SwatchRef = target
        ? { ...fill, swatchId: target.id, color: tintedColor(target.color, fill.tint) }
        : detached(fill)
      e = { ...e, fill: next } as SlideElement
    }
    if (e.layerId) {
      const layer = layers.get(e.layerId)
      if (!layer || !layer.visible || layer.locked) {
        const { layerId: _drop, ...rest } = e
        e = rest as SlideElement
      }
    }
    return e
  })

  const stories = storyMap.size
    ? { ...(design.stories ?? {}), ...Object.fromEntries([...storyMap].map(([oldId, nextId]) => [nextId, structuredClone(carriedStories.get(oldId)!)])) }
    : design.stories
  const extras: Partial<DesignBody> = {
    ...(stories ? { stories } : {}),
    ...(pal.list ? { swatches: pal.list } : {})
  }

  let next: DesignBody
  if (design.editingMasterId) {
    const masterId = design.editingMasterId
    next = {
      ...design,
      ...extras,
      masters: (design.masters ?? []).map((m) => (m.id === masterId ? { ...m, elements: [...m.elements, ...landed] } : m))
    }
  } else {
    // The mirror the editor's syncActivePage keeps: the active page holds the
    // SAME array as the top level. withPages first, because a design's single
    // page is implied until something materialises it.
    const elements = [...(design.elements ?? []), ...landed]
    const base = withPages({ ...design, elements })
    const active = base.activePage ?? 0
    const pages: DesignPage[] = (base.pages ?? []).map((p, i) => (i === active ? { ...p, elements, background: design.background ?? p.background } : p))
    next = { ...base, ...extras, pages, elements }
  }
  return { body: next, ids: landed.map((e) => e.id) }
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register a mounted design as a place design snippets can go.
 *
 * `instanceId` is the MOUNTED SURFACE (the editor's React `useId`), not the
 * document: the same design open in the editor and in a desk widget is two
 * destinations, and a closed design is none.
 *
 * `insert` changes every render (it closes over the current design), so it is
 * read through a ref updated each render rather than re-registering on every
 * edit. The registry calls the ref, and the ref is always this render's
 * function, so it never runs a stale closure.
 */
export function useDesignSnippetTarget(instanceId: string, title: string, insert: (snippet: Snippet) => boolean): void {
  const ref = useRef(insert)
  ref.current = insert
  useEffect(() => registerSnippetTarget(designSnippetTarget(instanceId, title, (s) => ref.current(s))), [instanceId, title])
}

/**
 * The target a mounted design registers. Pure, so its contract is
 * unit-testable. Every kind with a conversion into page elements is accepted
 * (a document as a text frame reading a new story, a sheet block as a table,
 * art as a picture), converted and then inserted through the same path as a
 * design snippet, which mints fresh element and story ids.
 */
export function designSnippetTarget(instanceId: string, title: string, insert: (snippet: Snippet) => boolean): SnippetTarget {
  return {
    id: designSnippetTargetId(instanceId),
    label: title?.trim() ? `“${title.trim()}”` : 'This design',
    accepts: officeAccepts('design'),
    host: 'design',
    supports: DESIGN_SNIPPET_LINKS,
    insert: (snippet, link) => insertIntoOffice(snippet, link, 'design', (s, l) => (l === 'duplicate' ? insert(s) : false))
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Drop a swatch link but keep the colour, so detaching never changes the artwork. */
function detached(fill: SlideFill & SwatchRef): SlideFill {
  const next = { ...fill }
  delete next.swatchId
  delete next.tint
  return next
}

/** A swatch from an untrusted body, or null when it is not one. */
function readSwatch(raw: unknown): DesignSwatch | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id || typeof r.color !== 'string' || !r.color) return null
  const name = typeof r.name === 'string' && r.name.trim() ? r.name : r.id
  const spot = r.spot && typeof r.spot === 'object' ? (r.spot as Record<string, unknown>).inkName : undefined
  return { id: r.id, name, color: r.color, ...(typeof spot === 'string' && spot.trim() ? { spot: { inkName: spot } } : {}) }
}

function translate(e: SlideElement, dx: number, dy: number): SlideElement {
  return translateLineEnd({ ...e, x: e.x + dx, y: e.y + dy } as SlideElement, dx, dy)
}

function translateLineEnd(e: SlideElement, dx: number, dy: number): SlideElement {
  if (e.type !== 'line' || (dx === 0 && dy === 0)) return e
  const l = e as SlideElement & { x2?: number; y2?: number }
  return {
    ...l,
    ...(Number.isFinite(l.x2) ? { x2: (l.x2 as number) + dx } : {}),
    ...(Number.isFinite(l.y2) ? { y2: (l.y2 as number) + dy } : {})
  } as SlideElement
}
