// Shared by every builder: the refusal reasons, form picking, picture sizing
// and the few element builders more than one destination uses.

import type { SnippetBody, SnippetKind } from '../snippets'
import type { Form, FormKind, SnippetAppName } from '../snippetForms'
import type { SnippetConversion } from '../snippetConvert'
import { PAGE_WIDGET_KINDS, TEXT_WIDGET_KINDS } from '../snippetForms/fromWidget'

export const DEST_APP: Record<SnippetKind, string> = {
  doc: 'PlexiiWrite',
  sheet: 'PlexiiCells',
  slide: 'PlexiiDeck',
  design: 'PlexiiDesign',
  diagram: 'PlexiiDiagrams',
  draw: 'PlexiiDraw',
  widget: 'a desk'
}

export const SOURCE_APP: Record<SnippetKind, SnippetAppName> = {
  doc: 'PlexiiWrite',
  sheet: 'PlexiiCells',
  slide: 'PlexiiDeck',
  design: 'PlexiiDesign',
  diagram: 'PlexiiDiagrams',
  draw: 'PlexiiDraw',
  widget: 'a work widget'
}

export const REASON = {
  cellsNoPictures: 'PlexiiCells holds values, not pictures.',
  drawNoTables: 'PlexiiDraw has no tables; insert it into PlexiiWrite or a page instead.',
  drawingNeedsApp: 'A picture of this drawing can only be made in the app window.',
  linkedPictureDraw: 'This picture is linked rather than stored in the work widget, so PlexiiDraw cannot hold it yet.',
  empty: 'There is nothing in this snippet to insert.'
} as const

const WIDGET_NAME: Record<string, string> = {
  'custom-block': 'custom block',
  'living-doc': 'living page',
  'image-gen': 'image generator',
  'stat-card': 'stat card',
  'task-list': 'task list',
  'mail-thread': 'email thread',
  'voice-recorder': 'voice recorder',
  'location-map': 'location map'
}

/** Why a work widget of this kind cannot go into `to`. */
export function widgetReason(widgetKind: string, to: SnippetKind): string {
  if (widgetKind === 'table') {
    return to === 'doc'
      ? 'A table work widget is linked to its table and cannot be copied into a document yet.'
      : `A table work widget is linked to its table and cannot be copied into ${DEST_APP[to]} yet.`
  }
  const name = WIDGET_NAME[widgetKind] ?? widgetKind.replace(/-/g, ' ')
  return `A ${name} work widget cannot be placed in ${DEST_APP[to]} yet. Insert it on a desk instead.`
}

/** The refusal for a body none of whose forms the destination can take. */
export function refusal(body: SnippetBody, to: SnippetKind): SnippetConversion {
  if (body.kind === 'widget') {
    const k = body.widgetKind
    if ((TEXT_WIDGET_KINDS.has(k) || PAGE_WIDGET_KINDS.has(k)) && !String(body.content ?? '').trim()) {
      return { ok: false, reason: 'This work widget is empty, so there is nothing to insert.' }
    }
    if (k === 'image' && !String(body.content ?? '').trim()) return { ok: false, reason: 'This image work widget has no picture in it yet.' }
    return { ok: false, reason: widgetReason(k, to) }
  }
  if (body.kind === 'draw' && Array.isArray(body.objects) && body.objects.length) return { ok: false, reason: REASON.drawingNeedsApp }
  return { ok: false, reason: REASON.empty }
}

const PICTURE_KINDS = new Set<SnippetKind>(['slide', 'design', 'diagram', 'draw'])

/**
 * The first form, in the source's order, whose kind the destination takes.
 *
 * Art (a slide, a design, a diagram, a drawing) never falls back to its words:
 * when its picture cannot be made here, landing "Logo mark" in a text box
 * would drop the art and call it a conversion. It is refused instead. The
 * text form stays for ⌘V's plain-text flavour.
 */
export function pick(forms: Form[], takes: FormKind[], body: SnippetBody): Form | undefined {
  const art = PICTURE_KINDS.has(body.kind)
  return forms.find((f) => f.kind !== 'native' && takes.includes(f.kind) && !(art && f.kind === 'text'))
}

/** A size that fits inside max × max keeping the aspect ratio, never larger than it was. */
export function fitWithin(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const ww = Math.max(1, w)
  const hh = Math.max(1, h)
  const k = Math.min(1, maxW / ww, maxH / hh)
  return { w: Math.max(1, Math.round(ww * k)), h: Math.max(1, Math.round(hh * k)) }
}

/** Lines of wrapped text a frame of this width shows (an estimate, so it is a starting height, not a promise). */
export function estimateLines(paragraphs: string[], width: number, fontSize: number): number {
  const perLine = Math.max(8, Math.floor(width / (fontSize * 0.52)))
  return paragraphs.reduce((n, p) => n + Math.max(1, Math.ceil(p.length / perLine)), 0)
}

export function ok(body: SnippetBody, lossy: string[]): SnippetConversion {
  return { ok: true, body, lossy: [...new Set(lossy)] }
}
