// What the system clipboard holds, as conversion forms (src/shared/snippetForms.ts).
//
// ⌘V and right-click › Paste in every destination go through the SAME acceptors
// as inserting a saved snippet, so one conversion matrix serves both and the two
// can never drift apart. This module is the clipboard half: it reads every
// flavour our apps and the system put on the pasteboard and turns them into the
// best-first Form[] that formsOf() produces for a snippet.
//
// Order of preference, most faithful first:
//   1. a Plexii app's own format → its snippet body → formsOf(body), so a copy
//      from PlexiiDraw, PlexiiDeck/PlexiiDesign, PlexiiDiagrams or PlexiiCells
//      lands exactly as a saved snippet of the same selection would. The body
//      is made by each app's OWN capture function (slideBodyFromSelection,
//      designBodyFromSelection, diagramBodyFromSelection, Draw's clipboard
//      parser), so a paste and a saved snippet of one selection are the same;
//   2. SVG (raw macOS flavour, never getType('image/svg+xml'), which blocks the
//      main process on macOS) → 'svg';
//   3. PNG / JPEG → 'image';
//   4. HTML → 'docNodes' (via htmlToDoc) and 'rows' when it is a table;
//   5. plain text → 'rows' when it is TSV, then 'docNodes' and 'text'.
//
// A flavour whose envelope carries a version this build does not understand is
// refused, never guessed at (PlexiiDraw's rule).
//
// The reading is done in the main process (src/main/appClipboard.ts, through
// window.api.snippets.readClipboard), because only the main process can see the
// raw OS flavours. Where that is not available (the browser build) a paste
// event's DataTransfer is read instead, which carries our private types, HTML
// and text but not Draw's native format or SVG.

import type { AppClipboardRead } from '@shared/appClipboard'
import type { DrawSnippetBody, SheetSnippetBody, SnippetBody, SnippetKind } from '@shared/snippets'
import type { ConvertVerb } from '@shared/snippetConvert'
import { formsOf, type ConvertDeps, type Form } from '@shared/snippetForms'
import { DRAW_CLIPBOARD_KIND, DRAW_CLIPBOARD_VERSION } from '@shared/draw/clipboardFormat'
import { CELLS_CLIP_MIME, parseCellsClipboard } from '@shared/cellsClipboardFormat'
import { translateNode } from '@shared/draw/ops/geometry'
import { ELEMENT_CLIP_MIME, parseElementClipboard } from '@shared/elementClipboard'
import { isClip } from '@shared/diagram/ops'
import { parseTsv } from '@shared/gridClipboard'
import { firstTableRows } from '@shared/snippetForms/tiptap'
import { looksLikeHeader, paragraphNode, rowsToTableNode } from '@shared/snippetForms/rows'
import { SOURCE_APP } from '@shared/snippetConvert/common'
import { parseClipboardValue } from '../components/documents/draw/editor/clipboard'
import { slideBodyFromSelection } from '../components/documents/slides/deckSnippets'
import { designBodyFromSelection } from '../components/documents/design/designSnippets'
import { diagramBodyFromSelection } from '../components/documents/diagram/diagramSnippets'
import { htmlToDocContent } from './docHtml'
import { snippetConvertDeps } from './snippetConvertDeps'

/** PlexiiDiagrams' private clipboard type (diagram/commands.ts writes it in its copy event). */
export const DIAGRAM_CLIP_MIME = 'application/x-plexii-diagram'

export interface ClipboardForms {
  forms: Form[]
  /** Which Plexii app the copy came from, when it is one of ours. */
  source: string | null
  /** The kind of snippet body the copy is, when it came from one of our apps. */
  kind?: SnippetKind | null
  /**
   * Why the clipboard cannot be pasted at all, when it holds our content in a
   * form this build must not guess at (a newer PlexiiDraw's envelope). Forms
   * are then empty, and the reason is shown verbatim.
   */
  refused?: string
  /**
   * How these forms arrive, when it is not a paste: the Files drop reader sets
   * 'drop', so an office app's existing paste path (pasteConverted, given
   * `{ read }`) words a refusal "Nothing that was dropped …". Absent for the
   * clipboard, which keeps today's wording.
   */
  verb?: ConvertVerb
}

/**
 * Forms read from anywhere that is not a saved snippet, in the one shape every
 * destination takes: the clipboard (readClipboardForms) and a file dropped from
 * the Files panel (its drop reader). `refused` set means nothing goes in and
 * that sentence is shown verbatim.
 */
export type FormsRead = ClipboardForms

// ── PlexiiCells' copy ────────────────────────────────────────────────────────
//
// A Cells copy carries its own flavour beside the TSV (CELLS_CLIP_MIME,
// shared/cellsClipboardFormat.ts): the range as a saved snippet of it, read
// first, from any window and after a restart. What follows is the fallback for
// a paste that cannot see that flavour (the browser build's menu paste, which
// has no paste event to read): Cells also records here what it last wrote and
// where it came from, so a paste whose text is STILL exactly that copy is known
// to be a Cells range: its cells are raw input (formulas as written) at a known
// origin, and it becomes a sheet body whose formulas are computed for the
// destination, as a saved sheet snippet's are. In this renderer only, and only
// while the clipboard text is unchanged; anything else is plain text.

let cellsCopy: { text: string; origin: { r: number; c: number } } | null = null

/** Called by PlexiiCells' copy and cut with the TSV it wrote and the range's top-left. */
export function markCellsCopy(text: string, origin: { r: number; c: number }): void {
  cellsCopy = { text, origin: { r: origin.r, c: origin.c } }
}

/** Is this text exactly what PlexiiCells last copied (so a paste of it is a Cells range)? */
export function isCellsCopyText(text: string | null | undefined): boolean {
  return !!cellsCopy && typeof text === 'string' && text === cellsCopy.text
}

/**
 * Should a paste event in an app that is not the copy's own be routed through
 * the conversion, judged synchronously from the event (an editor must decide
 * before the browser's own paste runs)? Yes for our apps' private types, a
 * Diagrams clip or Cells range in the text, and a clipboard holding no text at
 * all (a PlexiiDraw copy or a picture: there is nothing for a text paste to do).
 */
export function pasteNeedsConversion(data: DataTransfer | null | undefined): boolean {
  if (!data) return false
  const types = Array.from(data.types ?? [])
  if (types.includes(ELEMENT_CLIP_MIME) || types.includes(DIAGRAM_CLIP_MIME) || types.includes(CELLS_CLIP_MIME)) return true
  const text = types.includes('text/plain') ? data.getData('text/plain') : ''
  if (text.includes('plexii-diagram/v1') || isCellsCopyText(text)) return true
  return !text && !types.includes('text/html') && types.length > 0
}

/** Test seam. */
export function resetCellsCopy(): void {
  cellsCopy = null
}

// ── From each app's own format to its snippet body ──────────────────────────

/** Draw's versioned envelope → a draw body, or a refusal for a version this build does not know. */
function drawBody(json: string): { body: DrawSnippetBody; lossy: string[] } | { refused: string } | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || (raw as { kind?: unknown }).kind !== DRAW_CLIPBOARD_KIND) return null
  const version = (raw as { version?: unknown }).version
  if (version !== DRAW_CLIPBOARD_VERSION) {
    return { refused: 'This was copied from a newer PlexiiDraw, which this version cannot read. Update PlexiiDraw to paste it here.' }
  }
  // Draw's own parser: normalised exactly like a stored drawing, objects a
  // newer PlexiiDraw made are left out and counted.
  const parsed = parseClipboardValue(raw)
  if (!parsed || !parsed.nodes.length) return null
  const dx = -parsed.bounds.x
  const dy = -parsed.bounds.y
  // Deep copies, moved so the block's top-left is the origin, as a saved draw
  // snippet is (drawBodyFromSelection).
  const objects = parsed.nodes.map((n) => translateNode(structuredClone(n), dx, dy))
  const lossy = parsed.dropped
    ? [`${parsed.dropped} object${parsed.dropped === 1 ? '' : 's'} made in a newer PlexiiDraw ${parsed.dropped === 1 ? 'was' : 'were'} left out.`]
    : []
  return { body: { kind: 'draw', objects, assets: structuredClone(parsed.assets), swatches: structuredClone(parsed.swatches) }, lossy }
}

/** Deck/Design elements → a slide or design body, through each app's own capture. */
function elementsBody(json: string): SnippetBody | null {
  const clip = parseElementClipboard(json)
  if (!clip) return null
  const ids = clip.elements.map((e) => e.id)
  const app = clip.app ?? (clip.stories ? 'design' : 'slide')
  if (app === 'design') {
    const elements = clip.elements
    return designBodyFromSelection(
      { schemaVersion: 1, width: clip.source.w || 1, height: clip.source.h || 1, elements, pages: [{ id: 'clipboard', elements }], activePage: 0, stories: (clip.stories ?? {}) as never, swatches: [] } as never,
      ids
    )
  }
  return slideBodyFromSelection({ id: 'clipboard', notes: '', elements: clip.elements } as never, ids)
}

/** A Diagrams copy (its JSON clip) → a diagram body, through Diagrams' own capture. */
function diagramBody(json: string): SnippetBody | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (!isClip(raw)) return null
  const nodes = raw.nodes.filter((n) => n && typeof n === 'object' && typeof n.id === 'string')
  const edges = Array.isArray(raw.edges) ? raw.edges : []
  return diagramBodyFromSelection({ nodes, edges }, { nodes: new Set(nodes.map((n) => n.id)), edges: new Set() })
}

// ── Pictures and text from anywhere ─────────────────────────────────────────

/** An SVG's size from its width/height, else its viewBox; a sensible frame when it says neither. */
export function svgSize(svg: string): { w: number; h: number } {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? ''
  const attr = (n: string): number => {
    const m = new RegExp(`\\s${n}\\s*=\\s*["']\\s*([0-9.]+)\\s*(px)?\\s*["']`, 'i').exec(open)
    return m ? Number(m[1]) : NaN
  }
  let w = attr('width')
  let h = attr('height')
  const vb = /\sviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(open)
  if (!(w > 0) && vb) w = Number(vb[1])
  if (!(h > 0) && vb) h = Number(vb[2])
  if (w > 0 && !(h > 0)) h = w
  if (h > 0 && !(w > 0)) w = h
  return w > 0 && h > 0 ? { w: Math.round(w), h: Math.round(h) } : { w: 300, h: 150 }
}

/** Text that is a block of tab-separated cells (two or more cells somewhere). */
function isTsv(text: string): boolean {
  return /\t/.test(text.replace(/\r\n?/g, '\n').replace(/\n+$/, ''))
}

export interface FormsOptions {
  deps?: ConvertDeps
  /** HTML → top-level TipTap nodes (PlexiiWrite's own sanitising importer by default). */
  htmlToNodes?: (html: string) => unknown[]
}

/**
 * Turn what was read off the clipboard into forms, best first. Pure apart from
 * the injected HTML importer, so it is unit-testable with plain data.
 */
export function formsFromClipboardRead(read: AppClipboardRead, opts: FormsOptions = {}): ClipboardForms {
  const deps = opts.deps ?? {}
  const ours = (body: SnippetBody | null, extra: string[] = []): ClipboardForms | null => {
    if (!body) return null
    const forms = formsOf(body, deps).map((f) => (extra.length ? ({ ...f, lossy: [...f.lossy, ...extra] } as Form) : f))
    return { forms, source: SOURCE_APP[body.kind], kind: body.kind }
  }

  // 1. One of our apps' own formats.
  if (read.drawNative) {
    const d = drawBody(read.drawNative)
    if (d && 'refused' in d) return { forms: [], source: 'PlexiiDraw', kind: 'draw', refused: d.refused }
    const hit = d ? ours(d.body, d.lossy) : null
    if (hit) return hit
  }
  const custom = read.custom ?? {}
  if (custom[ELEMENT_CLIP_MIME]) {
    const hit = ours(elementsBody(custom[ELEMENT_CLIP_MIME]))
    if (hit) return hit
  }
  // Diagrams also writes its clip as text/plain, so a Diagrams copy read
  // without the private type (the browser build) is still recognised.
  const diagramJson = custom[DIAGRAM_CLIP_MIME] ?? (read.text && read.text.includes('plexii-diagram/v1') ? read.text : undefined)
  if (diagramJson) {
    const hit = ours(diagramBody(diagramJson))
    if (hit) return hit
  }
  if (custom[CELLS_CLIP_MIME]) {
    const cells = parseCellsClipboard(custom[CELLS_CLIP_MIME])
    if (cells && 'refused' in cells) return { forms: [], source: 'PlexiiCells', kind: 'sheet', refused: cells.refused }
    if (cells) {
      // What the cells displayed on the sheet they were copied from, when the
      // copy says: a formula reading a cell outside the range then lands as
      // the value the person saw, not the #REF! a saved snippet (which has
      // only itself to compute from) must show.
      const values = cells.values
      const shown: ConvertDeps = values
        ? {
            ...deps,
            evaluateSheet: (b) => ({
              values: values.map((r) => [...r]),
              formulas: b.rows.reduce((n, r) => n + r.filter((c) => typeof c === 'string' && c.trim().startsWith('=')).length, 0),
              outside: 0
            })
          }
        : deps
      const forms = formsOf(cells.body, shown)
      return { forms, source: SOURCE_APP.sheet, kind: 'sheet' }
    }
  }
  if (read.text !== undefined && cellsCopy && cellsCopy.text === read.text) {
    const rows = parseTsv(read.text)
    const body: SheetSnippetBody = { kind: 'sheet', rows, origin: { ...cellsCopy.origin } }
    const hit = ours(body)
    if (hit) return hit
  }

  // 2–5. Anything else, as forms with no source body.
  const forms: Form[] = []
  if (read.svg && /<svg[\s>]/i.test(read.svg)) {
    const size = svgSize(read.svg)
    forms.push({ kind: 'svg', value: { svg: read.svg, width: size.w, height: size.h, vector: true, app: 'the app it came from' }, lossy: [] })
  }
  if (read.image?.dataUrl) {
    const { dataUrl, w, h } = read.image
    forms.push({ kind: 'image', value: { src: dataUrl, ...(w > 0 && h > 0 ? { width: w, height: h } : {}) }, lossy: [] })
  }
  if (read.html && read.html.trim()) {
    const nodes = (opts.htmlToNodes ?? ((h: string) => htmlToDocContent(h) as unknown[]))(read.html)
    const meaningful = nodes.filter((n) => {
      const o = n as { type?: string; content?: unknown[] }
      return o && (o.type !== 'paragraph' || (Array.isArray(o.content) && o.content.length > 0))
    })
    if (meaningful.length) {
      forms.push({ kind: 'docNodes', value: meaningful, lossy: [] })
      const t = firstTableRows(meaningful)
      if (t && t.rows.length) forms.push({ kind: 'rows', value: { rows: t.rows, header: t.header }, lossy: [] })
    }
  }
  const text = read.text ?? ''
  if (text.trim()) {
    if (isTsv(text)) {
      const rows = parseTsv(text)
      const header = looksLikeHeader(rows)
      if (!forms.some((f) => f.kind === 'rows')) forms.push({ kind: 'rows', value: { rows, header }, lossy: [] })
      if (!forms.some((f) => f.kind === 'docNodes')) forms.push({ kind: 'docNodes', value: [rowsToTableNode(rows, header)], lossy: [] })
    } else if (!forms.some((f) => f.kind === 'docNodes')) {
      const lines = text.replace(/\r\n?/g, '\n').split('\n')
      forms.push({ kind: 'docNodes', value: lines.map((l) => paragraphNode(l)), lossy: [] })
    }
    forms.push({ kind: 'text', value: text.replace(/\r\n?/g, '\n'), lossy: [] })
  }
  return { forms, source: null, kind: null }
}

/** What a paste event's DataTransfer carries, as the main process would have read it. */
export function readFromDataTransfer(data: DataTransfer): AppClipboardRead {
  const out: AppClipboardRead = {}
  const get = (t: string): string => {
    try {
      return data.getData(t)
    } catch {
      return ''
    }
  }
  const custom: Record<string, string> = {}
  for (const t of [ELEMENT_CLIP_MIME, DIAGRAM_CLIP_MIME, CELLS_CLIP_MIME]) {
    const v = get(t)
    if (v) custom[t] = v
  }
  if (Object.keys(custom).length) out.custom = custom
  const html = get('text/html')
  if (html) out.html = html
  const text = get('text/plain')
  if (text) out.text = text
  return out
}

/**
 * Read the system clipboard as conversion forms, best first. Empty when it
 * holds nothing usable. `data` is the paste event's DataTransfer, used only
 * where the main process cannot be asked (the browser build).
 */
export async function readClipboardForms(data?: DataTransfer | null, opts: FormsOptions = {}): Promise<ClipboardForms> {
  const api = (globalThis as unknown as { api?: { snippets?: { readClipboard?: () => Promise<AppClipboardRead> } } }).api
  let read: AppClipboardRead | null = null
  if (api?.snippets?.readClipboard) {
    try {
      read = await api.snippets.readClipboard()
    } catch {
      read = null
    }
  }
  if ((!read || read.error) && data) {
    const fromEvent = readFromDataTransfer(data)
    read = read && !read.error ? read : { ...(read ?? {}), ...fromEvent, error: undefined }
  }
  if (!read) return { forms: [], source: null, kind: null }
  return formsFromClipboardRead(read, { deps: opts.deps ?? snippetConvertDeps(), htmlToNodes: opts.htmlToNodes })
}
