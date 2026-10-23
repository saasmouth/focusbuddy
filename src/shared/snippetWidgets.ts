// Any content into a WORK WIDGET, and onto a desk.
//
// The office apps convert a snippet into their own native body through
// shared/snippetConvert.ts. A work widget's native form is smaller and
// different per kind (a sticky holds markdown-lite text, a page TipTap nodes,
// a markdown widget markdown, a table widget rows in its fb_table, an image
// widget one picture), so each kind has an ACCEPTOR here that takes the
// best-first Form[] (shared/snippetForms.ts) and returns exactly what that
// widget holds, or a refusal whose reason a person can act on.
//
// The SAME acceptors serve inserting a saved snippet (formsOf(body)) and ⌘V
// (readClipboardForms()), so a paste and an insert of the same thing land
// identically. Every result carries `lossy`: the plain sentences the widget
// shows after a converted insert, so nothing is ever silently lossy.
//
// Pure and deterministic: no React, no DOM, no ids. Storing a picture in the
// file store, creating an fb_table and placing a widget are the renderer's
// side effects (renderer/src/lib/widgetSnippetInsert.ts).

import type { SnippetBody } from './snippets'
import type { Form, FormKind, ImageValue, LinkValue, SvgValue } from './snippetForms'
import { docFeatures, firstTableRows, inlineText, tiptapToMarkdown, type TipNode } from './snippetForms/tiptap'
import { paragraphNode, rowsToGfm, rowsToTableNode } from './snippetForms/rows'
import { L, docMarkdownLossy, uniq } from './snippetForms/lossy'
import { pictureLossy } from './snippetForms/picture'
import { REASON, fitWithin, isSafeLinkHref, linkAsText, linkRefusal, refusal, widgetPictureSrc } from './snippetConvert/common'

/** The work widgets that take inserted and pasted content. */
export type WidgetTargetKind = 'sticky' | 'note' | 'page' | 'markdown' | 'table' | 'image'

export const WIDGET_TARGET_KINDS: readonly WidgetTargetKind[] = ['sticky', 'note', 'page', 'markdown', 'table', 'image']

export function isWidgetTargetKind(k: string): k is WidgetTargetKind {
  return (WIDGET_TARGET_KINDS as readonly string[]).includes(k)
}

/**
 * Insert from the library, paste from the clipboard, or drop (a file from the
 * Files panel): only the wording of a refusal differs.
 */
export type WidgetVerb = 'insert' | 'paste' | 'drop'

/** "Nothing on the clipboard …" for a paste, "Nothing that was dropped …" for a drop. */
function nothingFrom(verb: WidgetVerb): string {
  return verb === 'drop' ? 'Nothing that was dropped' : 'Nothing on the clipboard'
}

export interface AcceptContext {
  /** The snippet body the forms came from. Absent for a paste. */
  body?: SnippetBody
  verb: WidgetVerb
}

export type Refusal = { ok: false; reason: string }

export type StickyAccept = { ok: true; text: string; lossy: string[] } | Refusal
export type PageAccept = { ok: true; nodes: unknown[]; lossy: string[] } | Refusal
export type MarkdownAccept = { ok: true; markdown: string; lossy: string[] } | Refusal
export type TableAccept = { ok: true; rows: string[][]; header: boolean; lossy: string[] } | Refusal
/** A picture by reference (`src`), or as SVG markup still to be stored. */
export type Picture = { src: string; alt?: string; width?: number; height?: number; fileId?: string } | { svg: SvgValue }
export type ImageAccept = { ok: true; picture: Picture; lossy: string[] } | Refusal

// ── Picking ──────────────────────────────────────────────────────────────────

const ART_KINDS = new Set(['slide', 'design', 'diagram', 'draw'])

/**
 * Is this content a PICTURE? A slide, design, diagram or drawing is art, as is
 * an image work widget; on the clipboard, anything whose best form is a
 * picture. Art never falls back to its words: landing "Logo mark" in a sticky
 * would drop the art and call it a conversion.
 */
export function isArt(forms: Form[], body?: SnippetBody): boolean {
  if (body) return ART_KINDS.has(body.kind) || (body.kind === 'widget' && body.widgetKind === 'image')
  const first = forms.find((f) => f.kind !== 'native')
  return !!first && (first.kind === 'svg' || first.kind === 'image')
}

/** The first form, in the source's order, of a kind in `takes`. Art skips text. */
function pickForm(forms: Form[], takes: FormKind[], art: boolean): Form | undefined {
  return forms.find((f) => f.kind !== 'native' && takes.includes(f.kind) && !(art && f.kind === 'text'))
}

/** A rows form that is a real grid: at least two columns. */
function gridOf(forms: Form[]): (Form & { kind: 'rows' }) | undefined {
  return forms.find((f): f is Form & { kind: 'rows' } => f.kind === 'rows' && f.value.rows.some((r) => r.length >= 2))
}

/**
 * Clipboard forms as a widget should read them. Plain tab-separated text (a
 * PlexiiCells range, a copy from Excel) is a grid, not a paragraph of tabs, so
 * when the best form is text and the clipboard also reads as a grid of two or
 * more columns, the grid moves to the front, followed by the same table as
 * TipTap nodes and as markdown, so each widget takes it in its own shape.
 */
export function pasteForms(forms: Form[]): Form[] {
  const first = forms.find((f) => f.kind !== 'native')
  const grid = gridOf(forms)
  if (!first || !grid || (first.kind !== 'text' && first.kind !== 'rows')) return forms
  const rest = forms.filter((f) => f !== grid)
  return [
    grid,
    { kind: 'docNodes', value: [rowsToTableNode(grid.value.rows, grid.value.header)], lossy: [...grid.lossy] },
    { kind: 'markdown', value: rowsToGfm(grid.value.rows), lossy: [...grid.lossy] },
    ...rest.filter((f) => f.kind !== 'docNodes' && f.kind !== 'markdown')
  ]
}

/** What to tell a person, as one line, after a converted insert or paste. Empty when nothing was lost. */
export function lossyLine(lossy: string[]): string {
  return uniq(lossy).join(' ')
}

// ── Sticky and note: text ────────────────────────────────────────────────────

/**
 * Stickies and notes hold TEXT. A picture is refused with where it CAN go,
 * rather than quietly becoming an image widget nobody asked for.
 */
export function textWidgetRefusal(kind: 'sticky' | 'note', verb: WidgetVerb): Refusal {
  const who = kind === 'sticky' ? 'Stickies' : 'Notes'
  const where =
    verb === 'paste'
      ? 'Paste on the desk to add it as an image.'
      : verb === 'drop'
        ? 'Drop on the desk to add it as an image.'
        : 'Insert it on the desk to add it as an image.'
  return { ok: false, reason: `${who} hold text. ${where}` }
}

/**
 * TipTap nodes as a sticky's markdown-lite: one line per paragraph, "- " for
 * bullets, "[ ] " / "[x] " for tasks, "1. " for numbered items, a GFM pipe
 * table for a table, and **bold** (the only mark a sticky draws). Everything
 * else keeps its words and is named in `lossy`.
 */
export function nodesToStickyText(nodes: unknown[]): { text: string; lossy: string[] } {
  const lossy: string[] = []
  const lines: string[] = []
  const inline = (n: TipNode): string => {
    const kids = Array.isArray(n.content) ? n.content : []
    return kids
      .map((k) => {
        if (k.type === 'hardBreak') return '\n'
        if (typeof k.text === 'string') {
          const marks = (k.marks ?? []).map((m) => m?.type)
          if (marks.some((m) => m && m !== 'bold')) lossy.push(L.someStyles)
          return marks.includes('bold') && k.text.trim() ? `**${k.text}**` : k.text
        }
        if (k.type === 'image') {
          lossy.push(L.pictures)
          return ''
        }
        lossy.push(L.embeds)
        return inlineText(k)
      })
      .join('')
  }
  const block = (n: TipNode, depth: number, prefix?: string): void => {
    const pad = '  '.repeat(depth)
    switch (n.type) {
      case 'paragraph':
        inline(n)
          .split('\n')
          .forEach((l, i) => lines.push(i === 0 && prefix ? `${pad}${prefix}${l}` : `${pad}${l}`))
        return
      case 'heading': {
        lossy.push(L.someStyles)
        const t = inline(n).replace(/\n/g, ' ').trim()
        lines.push(t ? `${pad}**${t.replace(/\*\*/g, '')}**` : '')
        return
      }
      case 'bulletList':
      case 'orderedList':
      case 'taskList': {
        const start = Number(n.attrs?.start ?? 1) || 1
        ;(n.content ?? []).forEach((item, i) => {
          const marker =
            n.type === 'taskList' ? `[${item.attrs?.checked ? 'x' : ' '}] ` : n.type === 'orderedList' ? `${start + i}. ` : '- '
          ;(item.content ?? []).forEach((child, ci) => {
            if (ci === 0 && child.type === 'paragraph') block(child, depth, marker)
            else block(child, depth + 1)
          })
        })
        return
      }
      case 'table': {
        const t = firstTableRows([n])
        if (t && t.rows.length) {
          if (lines.length && lines[lines.length - 1] !== '') lines.push('')
          lines.push(...rowsToGfm(t.rows).split('\n'))
          lines.push('')
          if (t.spans) lossy.push(L.mergedSplit)
        }
        return
      }
      case 'blockquote':
        lossy.push(L.someStyles)
        for (const k of n.content ?? []) block(k, depth)
        return
      case 'codeBlock':
        lossy.push(L.someStyles)
        lines.push(...inlineText(n).split('\n').map((l) => pad + l))
        return
      case 'horizontalRule':
        lines.push('')
        return
      case 'image':
        lossy.push(L.pictures)
        return
      default: {
        const kids = n.content ?? []
        if (kids.length) {
          lossy.push(L.embeds)
          for (const k of kids) block(k, depth)
          return
        }
        const t = inlineText(n)
        if (t) {
          lossy.push(L.embeds)
          lines.push(pad + t)
        }
      }
    }
  }
  for (const n of nodes) if (n && typeof n === 'object') block(n as TipNode, 0)
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  while (lines.length && lines[0].trim() === '') lines.shift()
  return { text: lines.join('\n'), lossy: uniq(lossy) }
}

/** Into a sticky or a note: text, with pipe tables for grids. Pictures are refused. */
export function acceptForTextWidget(kind: 'sticky' | 'note', forms: Form[], ctx: AcceptContext): StickyAccept {
  const { body } = ctx
  // A sticky or a note copied into another keeps exactly what was typed.
  if (body?.kind === 'widget' && (body.widgetKind === 'sticky' || body.widgetKind === 'note')) {
    const raw = String(body.content ?? '').replace(/\r\n?/g, '\n')
    if (!raw.trim()) return refusal(body, 'widget') as Refusal
    return { ok: true, text: raw, lossy: [] }
  }
  const art = isArt(forms, body)
  if (art) return textWidgetRefusal(kind, ctx.verb)
  const f = pickForm(forms, ['rows', 'docNodes', 'markdown', 'text', 'link'], false)
  if (!f) return body ? (refusal(body, 'widget') as Refusal) : textWidgetRefusal(kind, ctx.verb)
  // A file, document or folder from Files: its name and where it is, as text.
  if (f.kind === 'link') return { ok: true, text: linkAsText(f.value), lossy: [...f.lossy] }
  if (f.kind === 'rows') {
    // A grid is a pipe table; a single column is its lines.
    const rows = f.value.rows
    if (!rows.length) return textWidgetRefusal(kind, ctx.verb)
    const text = rows.some((r) => r.length >= 2) ? rowsToGfm(rows) : rows.map((r) => r[0] ?? '').join('\n')
    return { ok: true, text, lossy: [...f.lossy] }
  }
  if (f.kind === 'docNodes') {
    const { text, lossy } = nodesToStickyText(f.value)
    if (!text.trim()) return textWidgetRefusal(kind, ctx.verb)
    return { ok: true, text, lossy: uniq([...f.lossy, ...lossy]) }
  }
  const text = String(f.value).replace(/\r\n?/g, '\n').trim()
  if (!text) return textWidgetRefusal(kind, ctx.verb)
  return { ok: true, text, lossy: [...f.lossy] }
}

// ── Page: TipTap nodes, pictures included ────────────────────────────────────

/** Marks a page work widget's editor holds (StarterKit, Link). */
const PAGE_MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link', 'underline'])
/** Nodes a page work widget's editor holds (StarterKit, tasks, tables, images). */
const PAGE_NODES = new Set([
  'paragraph', 'text', 'hardBreak', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
  'blockquote', 'codeBlock', 'horizontalRule', 'table', 'tableRow', 'tableHeader', 'tableCell', 'image'
])

function hasAlignment(nodes: unknown[]): boolean {
  return nodes.some((n) => {
    const o = n as { attrs?: { textAlign?: unknown }; content?: unknown[] }
    if (!o || typeof o !== 'object') return false
    const a = o.attrs?.textAlign
    if (typeof a === 'string' && a !== 'left') return true
    return Array.isArray(o.content) && hasAlignment(o.content)
  })
}

/** What a page work widget does not keep of these nodes. */
export function pageLossy(nodes: unknown[]): string[] {
  const f = docFeatures(nodes)
  const out: string[] = []
  if ([...f.marks].some((m) => !PAGE_MARKS.has(m))) out.push(L.colourSize)
  if ([...f.other].some((t) => !PAGE_NODES.has(t))) out.push(L.embeds)
  if (hasAlignment(nodes)) out.push(L.alignment)
  return out
}

/** An image node as the page and markdown editors store it (ResizableImage). */
export function imageNode(src: string, alt: string, width?: number): Record<string, unknown> {
  return { type: 'image', attrs: { src, alt, title: null, width: width ?? null } }
}

/** The widest a picture lands in a page or markdown widget. */
export const WIDGET_PICTURE_MAX_WIDTH = 560

function pictureNodes(f: Form): { nodes: unknown[]; lossy: string[] } | null {
  if (f.kind === 'image') {
    const v = f.value
    // A picture from Files is referred to as the row it already is (fb-file://),
    // never stored a second time: storeNodePictures leaves anything that is not
    // a data: URL alone.
    return { nodes: [imageNode(widgetPictureSrc(v), v.alt ?? '', v.width ? Math.min(v.width, WIDGET_PICTURE_MAX_WIDTH) : undefined)], lossy: [...f.lossy] }
  }
  if (f.kind === 'svg') {
    const v = f.value
    const size = fitWithin(v.width, v.height, WIDGET_PICTURE_MAX_WIDTH, Number.MAX_SAFE_INTEGER)
    // The SVG markup rides in a data: URL here; the renderer stores it in the
    // file store before it lands (lib/widgetPictures.ts).
    return { nodes: [imageNode(svgSrc(v), `Picture from ${v.app}`, size.w)], lossy: [pictureLossy(v.app), ...f.lossy] }
  }
  return null
}

/** SVG markup as the data: URL a picture node carries until it is stored. */
export function svgSrc(v: SvgValue): string {
  // Percent-encoding (not base64) keeps this pure without a base64 encoder and
  // is just as valid a data: URL; widgetPictures decodes either.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(v.svg)}`
}

/**
 * A link as a page or markdown editor holds it: a paragraph holding the title
 * under a link mark. A document is a link too (a page has no document embed).
 */
export function linkParagraph(v: LinkValue): unknown {
  const href = v.href.trim()
  return { type: 'paragraph', content: [{ type: 'text', text: v.title.trim() || href, marks: [{ type: 'link', attrs: { href } }] }] }
}

/** Into a page work widget: TipTap nodes. Pictures are now kept, as image nodes. */
export function acceptForPage(forms: Form[], ctx: AcceptContext): PageAccept {
  const { body } = ctx
  const art = isArt(forms, body)
  const f = pickForm(forms, ['docNodes', 'image', 'svg', 'text', 'link'], art)
  if (!f) return body ? (refusal(body, 'doc') as Refusal) : { ok: false, reason: `${nothingFrom(ctx.verb)} can go in a page.` }
  if (f.kind === 'link') {
    if (!isSafeLinkHref(f.value.href)) return { ok: false, reason: REASON.linkUnsafe }
    return { ok: true, nodes: [linkParagraph(f.value)], lossy: [...f.lossy] }
  }
  if (f.kind === 'docNodes') {
    if (!f.value.length) return { ok: false, reason: 'There is nothing in this snippet to insert.' }
    const nodes = structuredClone(f.value)
    return { ok: true, nodes, lossy: uniq([...f.lossy, ...pageLossy(nodes)]) }
  }
  const pic = pictureNodes(f)
  if (pic) return { ok: true, nodes: pic.nodes, lossy: uniq(pic.lossy) }
  const text = String(f.value).replace(/\r\n?/g, '\n')
  if (!text.trim()) return { ok: false, reason: 'There is nothing in this to insert.' }
  return { ok: true, nodes: text.split('\n').map((l) => paragraphNode(l)), lossy: [...f.lossy] }
}

// ── Markdown: markdown, pictures and GFM tables included ─────────────────────

/** Into a markdown work widget: markdown. Pictures are ![alt](src); grids are GFM tables. */
export function acceptForMarkdown(forms: Form[], ctx: AcceptContext): MarkdownAccept {
  const { body } = ctx
  // A markdown widget copied into another keeps its source exactly.
  if (body?.kind === 'widget' && body.widgetKind === 'markdown') {
    const raw = String(body.content ?? '')
    if (!raw.trim()) return refusal(body, 'widget') as Refusal
    return { ok: true, markdown: raw, lossy: [] }
  }
  const art = isArt(forms, body)
  const f = pickForm(forms, ['docNodes', 'markdown', 'image', 'svg', 'text', 'link'], art)
  if (!f) return body ? (refusal(body, 'doc') as Refusal) : { ok: false, reason: `${nothingFrom(ctx.verb)} can go in a markdown work widget.` }
  if (f.kind === 'link') {
    if (!isSafeLinkHref(f.value.href)) return { ok: false, reason: REASON.linkUnsafe }
    return { ok: true, markdown: tiptapToMarkdown([linkParagraph(f.value)]), lossy: [...f.lossy] }
  }
  if (f.kind === 'docNodes') {
    if (!f.value.length) return { ok: false, reason: 'There is nothing in this snippet to insert.' }
    // Width is not markdown: a picture lands at its natural size.
    const nodes = structuredClone(f.value)
    return { ok: true, markdown: tiptapToMarkdown(nodes), lossy: uniq([...f.lossy, ...docMarkdownLossy(docFeatures(nodes))]) }
  }
  if (f.kind === 'markdown') return { ok: true, markdown: f.value, lossy: [...f.lossy] }
  const pic = pictureNodes(f)
  if (pic) return { ok: true, markdown: tiptapToMarkdown(pic.nodes.map(withoutWidth)), lossy: uniq(pic.lossy) }
  const text = String(f.value).replace(/\r\n?/g, '\n')
  if (!text.trim()) return { ok: false, reason: 'There is nothing in this to insert.' }
  return { ok: true, markdown: tiptapToMarkdown(text.split('\n').map((l) => paragraphNode(l))), lossy: [...f.lossy] }
}

function withoutWidth(n: unknown): unknown {
  const o = n as { attrs?: Record<string, unknown> }
  return o?.attrs ? { ...o, attrs: { ...o.attrs, width: null } } : n
}

// ── Table: rows ──────────────────────────────────────────────────────────────

export const TABLE_NO_PICTURES = 'A table work widget holds values, not pictures.'

/** Into a table work widget: rows of values (written into its fb_table by the renderer). */
export function acceptForTable(forms: Form[], ctx: AcceptContext): TableAccept {
  const { body } = ctx
  if (isArt(forms, body)) return { ok: false, reason: TABLE_NO_PICTURES }
  const f = pickForm(forms, ['rows'], false)
  if (!f || f.kind !== 'rows' || !f.value.rows.length) {
    if (body) return refusal(body, 'sheet') as Refusal
    return linkRefusal(forms, 'table') ?? { ok: false, reason: `${nothingFrom(ctx.verb)} reads as rows for this table.` }
  }
  return { ok: true, rows: structuredClone(f.value.rows), header: f.value.header, lossy: [...f.lossy] }
}

// ── Image: one picture ───────────────────────────────────────────────────────

/** A picture for a work widget: a picture from Files keeps its row (fb-file://<id>) instead of its bytes. */
export function widgetPicture(v: ImageValue): Picture {
  const out: ImageValue = { ...v, src: widgetPictureSrc(v) }
  delete out.fileId
  return out
}

export const IMAGE_NEEDS_PICTURE: string = REASON.imageNeedsPicture

/** Into an image work widget: one picture, which replaces the one it shows. */
export function acceptForImage(forms: Form[], ctx: AcceptContext): ImageAccept {
  const { body } = ctx
  const f = pickForm(forms, ['image', 'svg'], true)
  if (!f) {
    if (body && isArt(forms, body)) return refusal(body, 'widget') as Refusal
    // A folder names where it can go; a file or a document has no picture.
    return linkRefusal(forms, 'image') ?? { ok: false, reason: IMAGE_NEEDS_PICTURE }
  }
  if (f.kind === 'image') return { ok: true, picture: widgetPicture(f.value), lossy: [...f.lossy] }
  if (f.kind === 'svg') return { ok: true, picture: { svg: f.value }, lossy: uniq([pictureLossy(f.value.app), ...f.lossy]) }
  return { ok: false, reason: IMAGE_NEEDS_PICTURE }
}

// ── The desk ─────────────────────────────────────────────────────────────────

/**
 * What a non-widget snippet, or the clipboard, becomes on a desk.
 *
 *   table     a real table work widget with its own fb_table (a sheet block, a grid)
 *   page      a page work widget holding the document's nodes, pictures included
 *   image     an image work widget holding the picture (stored in the file store)
 *   markdown  a markdown work widget
 *   sticky    a sticky holding the text
 */
export type DeskPlan =
  | { ok: true; widget: 'table'; rows: string[][]; header: boolean; width: number; height: number; lossy: string[] }
  | { ok: true; widget: 'page'; nodes: unknown[]; width: number; height: number; lossy: string[] }
  | { ok: true; widget: 'image'; picture: Picture; width: number; height: number; lossy: string[] }
  | { ok: true; widget: 'markdown'; markdown: string; width: number; height: number; lossy: string[] }
  | { ok: true; widget: 'sticky'; text: string; width: number; height: number; lossy: string[] }
  | Refusal

/** Only paragraphs of unstyled text: what plain text reads as. */
export function isPlainProse(nodes: unknown[]): boolean {
  const f = docFeatures(nodes)
  if (f.marks.size || f.headings || f.lists || f.quotes || f.codeBlocks || f.tables || f.images || f.other.size) return false
  return nodes.every((n) => (n as { type?: string })?.type === 'paragraph')
}

/** A table widget's starting size for this many rows and columns. */
export function tableSize(rows: number, cols: number): { width: number; height: number } {
  return { width: Math.min(900, Math.max(360, 64 + 32 + cols * 160)), height: Math.min(560, Math.max(220, 120 + rows * 36)) }
}

/**
 * Plan a desk placement from forms, best first. A grid (a sheet block, or a
 * clipboard of two or more tab-separated columns) becomes a table work widget;
 * a document a page; a picture an image work widget; text a sticky.
 */
export function planDesk(forms: Form[], ctx: AcceptContext): DeskPlan {
  const { body } = ctx
  const art = isArt(forms, body)
  const ordered = body ? forms : pasteForms(forms)
  for (const f of ordered) {
    if (f.kind === 'native') continue
    if (art && f.kind === 'text') continue
    switch (f.kind) {
      case 'rows': {
        const rows = f.value.rows
        if (!rows.length) continue
        // One column of lines from a text source is text, not a table.
        if (!rows.some((r) => r.length >= 2) && body && body.kind !== 'sheet') continue
        const size = tableSize(rows.length, rows[0]?.length ?? 1)
        return { ok: true, widget: 'table', rows: structuredClone(rows), header: f.value.header, ...size, lossy: [...f.lossy] }
      }
      case 'docNodes': {
        if (!f.value.length) continue
        // Plain lines off the clipboard (no styles, no lists, no tables) are
        // text, and text on a desk is a sticky, not a page.
        const text = !body ? ordered.find((t) => t.kind === 'text') : undefined
        if (text && text.kind === 'text' && isPlainProse(f.value) && text.value.trim()) {
          return { ok: true, widget: 'sticky', text: text.value.replace(/\r\n?/g, '\n').trim(), width: 240, height: 200, lossy: [...text.lossy] }
        }
        const nodes = structuredClone(f.value)
        return { ok: true, widget: 'page', nodes, width: 480, height: 400, lossy: uniq([...f.lossy, ...pageLossy(nodes)]) }
      }
      case 'image': {
        const v = f.value
        const size = fitWithin(v.width ?? 360, v.height ?? 280, 640, 640)
        return { ok: true, widget: 'image', picture: widgetPicture(v), width: Math.max(160, size.w), height: Math.max(120, size.h), lossy: [...f.lossy] }
      }
      case 'link':
        // The Files drop handler places a dropped file as a file widget itself;
        // a link that reaches a desk plan is written down, as a sticky.
        return { ok: true, widget: 'sticky', text: linkAsText(f.value), width: 240, height: 200, lossy: [...f.lossy] }
      case 'svg': {
        const v = f.value
        const size = fitWithin(v.width, v.height, 640, 640)
        return { ok: true, widget: 'image', picture: { svg: v }, width: Math.max(160, size.w), height: Math.max(120, size.h), lossy: uniq([pictureLossy(v.app), ...f.lossy]) }
      }
      case 'markdown':
        if (!f.value.trim()) continue
        return { ok: true, widget: 'markdown', markdown: f.value, width: 460, height: 360, lossy: [...f.lossy] }
      case 'text': {
        const t = f.value.replace(/\r\n?/g, '\n').trim()
        if (!t) continue
        return { ok: true, widget: 'sticky', text: t, width: 240, height: 200, lossy: [...f.lossy] }
      }
    }
  }
  if (body) return refusal(body, 'widget') as Refusal
  return { ok: false, reason: ctx.verb === 'drop' ? 'Nothing that was dropped can be placed on a desk.' : 'There is nothing on the clipboard that can be placed on a desk.' }
}
