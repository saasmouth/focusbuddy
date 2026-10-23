// Shared by every builder: the refusal reasons, form picking, picture sizing
// and the few element builders more than one destination uses.

import type { SnippetBody, SnippetKind } from '../snippets'
import type { Form, FormKind, ImageValue, LinkValue, SnippetAppName } from '../snippetForms'
import type { SnippetConversion } from '../snippetConvert'
import { PAGE_WIDGET_KINDS, TEXT_WIDGET_KINDS } from '../snippetForms/fromWidget'
import { fileKindFromMime } from '../fields'

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

// ── Refusals for a link (a file, document or folder dropped from Files) ─────
//
// A link carries no content, so a destination that cannot hold a link refuses
// it with a sentence that names where it CAN go. The wording is the Files
// panel plan's (§4.3, §4.4), verbatim; the drop handler asserts on it.

/** A file a destination cannot hold, in any app but PlexiiCells. */
const cannotHoldFile = (app: string, what: string): string => `${app} cannot hold ${what}. Drop it on a desk, or into PlexiiWrite as a link.`
/** A folder: only a desk (a Drive work widget) and the link-holding destinations take one. */
const folderCannotGo = (dest: string): string => `A folder cannot go into ${dest}. Drop it on a desk for a Drive work widget.`
/** A document as a link: PlexiiWrite embeds it, a desk places it. */
const documentCannotGo = (dest: string): string => `A document cannot go into ${dest} as a link. Drop it on a desk, or into PlexiiWrite to embed it.`

export const REASON = {
  cellsNoPictures: 'PlexiiCells holds values, not pictures.',
  drawNoTables: 'PlexiiDraw has no tables; insert it into PlexiiWrite or a page instead.',
  drawingNeedsApp: 'A picture of this drawing can only be made in the app window.',
  linkedPictureDraw: 'This picture is linked rather than stored in the work widget, so PlexiiDraw cannot hold it yet.',
  empty: 'There is nothing in this snippet to insert.',

  // A file, document or folder dropped from Files where it cannot go.
  deckVideo: cannotHoldFile('PlexiiDeck', 'a video file'),
  deckAudio: cannotHoldFile('PlexiiDeck', 'an audio file'),
  deckFile: cannotHoldFile('PlexiiDeck', 'this kind of file'),
  deckFolder: folderCannotGo('PlexiiDeck'),
  deckDocument: documentCannotGo('PlexiiDeck'),
  designVideo: cannotHoldFile('PlexiiDesign', 'a video file'),
  designAudio: cannotHoldFile('PlexiiDesign', 'an audio file'),
  designFile: cannotHoldFile('PlexiiDesign', 'this kind of file'),
  designFolder: folderCannotGo('PlexiiDesign'),
  designDocument: documentCannotGo('PlexiiDesign'),
  drawVideo: cannotHoldFile('PlexiiDraw', 'a video file'),
  drawAudio: cannotHoldFile('PlexiiDraw', 'an audio file'),
  drawFile: cannotHoldFile('PlexiiDraw', 'this kind of file'),
  drawFolder: folderCannotGo('PlexiiDraw'),
  drawDocument: documentCannotGo('PlexiiDraw'),
  diagramVideo: cannotHoldFile('PlexiiDiagrams', 'a video file'),
  diagramAudio: cannotHoldFile('PlexiiDiagrams', 'an audio file'),
  diagramFile: cannotHoldFile('PlexiiDiagrams', 'this kind of file'),
  diagramFolder: folderCannotGo('PlexiiDiagrams'),
  diagramDocument: documentCannotGo('PlexiiDiagrams'),
  /** Any file (video, audio or otherwise) into PlexiiCells. */
  cellsFiles: 'PlexiiCells holds values, not files. Drop it on a desk, or into PlexiiWrite as a link.',
  cellsFolder: folderCannotGo('PlexiiCells'),
  cellsDocument: documentCannotGo('PlexiiCells'),
  /** Any file into a table work widget. */
  tableFile: 'A table work widget holds values, and this file has none.',
  tableFolder: folderCannotGo('a table work widget'),
  tableDocument: documentCannotGo('a table work widget'),
  /** An image work widget given something with no picture in it (snippetWidgets.ts IMAGE_NEEDS_PICTURE). */
  imageNeedsPicture: 'An image work widget holds a picture, and this has none.',
  imageFolder: folderCannotGo('an image work widget'),
  /** A link whose address is not one of ours or the web's (never followed, never shown as a link). */
  linkUnsafe: 'This link cannot be added, because its address is not one PlexiiDesk opens.',

  // The same refusals worded for a drop (ConvertVerb 'drop'); insert and paste keep the lines above.
  emptyDrop: 'There is nothing in what was dropped to add.',
  drawNoTablesDrop: 'PlexiiDraw has no tables; drop it into PlexiiWrite or a page instead.',
  widgetEmptyDrop: 'This work widget is empty, so there is nothing to add.'
} as const

/**
 * How the content is arriving: inserted from the library, pasted, or dropped
 * (a file from the Files panel). It changes only the WORDING of a refusal or
 * a no-content message; it never changes what lands. Absent means today's
 * wording, which is the same for insert and paste.
 */
export type ConvertVerb = 'insert' | 'paste' | 'drop'

/** "There is nothing in this snippet to insert.", or its drop wording. */
export function emptyReason(verb?: ConvertVerb): string {
  return verb === 'drop' ? REASON.emptyDrop : REASON.empty
}

/** PlexiiDraw's no-tables refusal, worded by verb. */
export function drawNoTablesReason(verb?: ConvertVerb): string {
  return verb === 'drop' ? REASON.drawNoTablesDrop : REASON.drawNoTables
}

/** What a dropped file is, as a refusal names it. */
export type LinkFileKind = 'video' | 'audio' | 'file'

/** A link's file kind, from its type or, failing that, its name's extension (shared/fields.ts buckets). */
export function linkFileKind(link: LinkValue): LinkFileKind {
  const ext = /\.([a-z0-9]+)$/i.exec(link.title ?? '')?.[1] ?? ''
  const k = fileKindFromMime((link.mime ?? '').toLowerCase(), ext)
  return k === 'video' ? 'video' : k === 'audio' ? 'audio' : 'file'
}

/** Addresses a link may carry: our own deep links and the web's. Anything else (javascript:, file:, data:) is never written as a link. */
export function isSafeLinkHref(href: unknown): href is string {
  return typeof href === 'string' && /^(plexii:\/\/|https?:\/\/|mailto:)/i.test(href.trim())
}

/** An fb_files id as a Files drop carries it: letters, digits, dash and underscore (a UUID). Anything else is ignored. */
export function isFileId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

/**
 * The src a WORK WIDGET stores for a picture: the fb_files row it already is
 * (`fb-file://<id>`, so nothing is stored twice) when it came from Files, else
 * its own src. Office builders do not use this: they keep `src`.
 */
export function widgetPictureSrc(v: ImageValue): string {
  return isFileId(v.fileId) ? `fb-file://${v.fileId}` : v.src
}

/** A link as plain text, for a destination that holds text (a sticky, a note): "title (href)". */
export function linkAsText(link: LinkValue): string {
  const title = link.title.trim()
  const href = link.href.trim()
  return title && title !== href ? `${title} (${href})` : href
}

/** The first link among the forms, if any. */
export function firstLink(forms: Form[]): LinkValue | undefined {
  const f = forms.find((x) => x.kind === 'link')
  return f?.kind === 'link' ? f.value : undefined
}

/** The destinations that refuse a link, and how each names the five cases. */
type LinkRefuser = 'slide' | 'design' | 'draw' | 'diagram' | 'sheet' | 'table' | 'image'

const LINK_REASONS: Record<LinkRefuser, Record<'video' | 'audio' | 'file' | 'folder' | 'document', string>> = {
  slide: { video: REASON.deckVideo, audio: REASON.deckAudio, file: REASON.deckFile, folder: REASON.deckFolder, document: REASON.deckDocument },
  design: { video: REASON.designVideo, audio: REASON.designAudio, file: REASON.designFile, folder: REASON.designFolder, document: REASON.designDocument },
  draw: { video: REASON.drawVideo, audio: REASON.drawAudio, file: REASON.drawFile, folder: REASON.drawFolder, document: REASON.drawDocument },
  diagram: { video: REASON.diagramVideo, audio: REASON.diagramAudio, file: REASON.diagramFile, folder: REASON.diagramFolder, document: REASON.diagramDocument },
  sheet: { video: REASON.cellsFiles, audio: REASON.cellsFiles, file: REASON.cellsFiles, folder: REASON.cellsFolder, document: REASON.cellsDocument },
  table: { video: REASON.tableFile, audio: REASON.tableFile, file: REASON.tableFile, folder: REASON.tableFolder, document: REASON.tableDocument },
  // A file or document has no picture for an image work widget: its own IMAGE_NEEDS_PICTURE line.
  image: { video: REASON.imageNeedsPicture, audio: REASON.imageNeedsPicture, file: REASON.imageNeedsPicture, folder: REASON.imageFolder, document: REASON.imageNeedsPicture }
}

/** Why `to` cannot hold this link: the sentence for its target (a folder, a document) or, for a file, its kind. */
export function linkReason(link: LinkValue, to: LinkRefuser): string {
  const row = LINK_REASONS[to]
  if (link.target === 'folder') return row.folder
  if (link.target === 'document') return row.document
  return row[linkFileKind(link)]
}

/**
 * The refusal for forms whose only usable content is a link, in a destination
 * that cannot hold one. Null when there is no link among the forms (the
 * caller's ordinary refusal applies).
 */
export function linkRefusal(forms: Form[], to: LinkRefuser): { ok: false; reason: string } | null {
  const link = firstLink(forms)
  return link ? { ok: false, reason: linkReason(link, to) } : null
}

/** Why a paste (or a drop) with no source body cannot land: nothing in it is something `to` holds. */
export function nothingUsable(to: SnippetKind, verb?: ConvertVerb): string {
  return `Nothing that was ${verb === 'drop' ? 'dropped' : 'copied'} is something ${DEST_APP[to]} can hold.`
}

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
export function widgetReason(widgetKind: string, to: SnippetKind, verb?: ConvertVerb): string {
  if (widgetKind === 'table') {
    return to === 'doc'
      ? 'A table work widget is linked to its table and cannot be copied into a document yet.'
      : `A table work widget is linked to its table and cannot be copied into ${DEST_APP[to]} yet.`
  }
  const name = WIDGET_NAME[widgetKind] ?? widgetKind.replace(/-/g, ' ')
  return `A ${name} work widget cannot be placed in ${DEST_APP[to]} yet. ${verb === 'drop' ? 'Drop' : 'Insert'} it on a desk instead.`
}

/**
 * The refusal for a body none of whose forms the destination can take. With no
 * body (a paste of something that is not one of our apps' content: a web
 * page's HTML, a picture, text) the refusal names the destination instead.
 * `verb` words it for how the content arrived (a drop says "dropped").
 */
export function refusal(body: SnippetBody | undefined, to: SnippetKind, verb?: ConvertVerb): SnippetConversion {
  if (!body) return { ok: false, reason: nothingUsable(to, verb) }
  if (body.kind === 'widget') {
    const k = body.widgetKind
    if ((TEXT_WIDGET_KINDS.has(k) || PAGE_WIDGET_KINDS.has(k)) && !String(body.content ?? '').trim()) {
      return { ok: false, reason: verb === 'drop' ? REASON.widgetEmptyDrop : 'This work widget is empty, so there is nothing to insert.' }
    }
    if (k === 'image' && !String(body.content ?? '').trim()) return { ok: false, reason: 'This image work widget has no picture in it yet.' }
    return { ok: false, reason: widgetReason(k, to, verb) }
  }
  if (body.kind === 'draw' && Array.isArray(body.objects) && body.objects.length) return { ok: false, reason: REASON.drawingNeedsApp }
  return { ok: false, reason: emptyReason(verb) }
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
export function pick(forms: Form[], takes: FormKind[], body: SnippetBody | undefined): Form | undefined {
  const art = body ? PICTURE_KINDS.has(body.kind) : false
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
