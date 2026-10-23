// A thing dragged out of Files, as the conversion FORMS a content target takes
// (shared/snippetForms.ts). Pure: the bytes, the rendered PDF page and the
// document body are read by the renderer (lib/filesDragForms.ts) and handed
// in; nothing here touches the DOM, the disk or the clock.
//
// The same forms then go through each destination's EXISTING path: an office
// app's converted paste (convertForms) and a work widget's acceptor. So a file
// dropped, the same content pasted, and the same content inserted as a snippet
// land identically. The only drop-specific choices are made here, from the
// plan's matrix (§4.3, §4.4):
//
//   REFERENCE FIRST. Documents, work widget files, PDFs, video, audio, other
//   files and folders are things you point at: a destination that holds links
//   (PlexiiWrite, page, markdown, sticky, note) gets the LINK (a document in
//   PlexiiWrite becomes its live DocEmbed card). Holding ⌥ swaps to a COPY of
//   the content where there is one. A destination that cannot hold a link gets
//   the content (a PDF's first page, a document's slide or rows), and the link
//   only as the last resort, so its refusal names somewhere it can go.
//
//   CONTENT FILES (pictures, SVG, .md .txt .csv .tsv .json) are what you put
//   in: they land as their content, and ⌥ makes a link instead.
//
// Every refusal and notice line is plain, British, with no em dashes.

import type { ImageValue, Form, LinkForm, LinkValue, RowsValue } from './snippetForms'
import { PDF_FIRST_PAGE } from './snippetForms'
import { formsOfDocNodes } from './snippetForms/fromDoc'
import { markdownLiteToNodes } from './snippetForms/markdownLite'
import { looksLikeHeader, paragraphNode, rowsToGfm, rowsToTableNode } from './snippetForms/rows'
import { sourceKindOf, type FileDragRef, type FileSourceKind } from './filesDragPayload'

// ── Lines ────────────────────────────────────────────────────────────────────

export const NOTICE_BYTES_MISSING = "This file's contents are not on this device yet, so it can only be added as a link."
export const NOTICE_TOO_LONG = 'This file is too long to insert, so it was added as a link.'
export const REASON_INTO_ITSELF = 'A document cannot go inside itself.'
export const REASON_FOLDER_INTO_ITSELF = 'A folder cannot go inside itself.'
export const REASON_READ_ONLY = 'This document is read-only, so nothing can be added to it.'

/** Text inserted as content is capped; longer files arrive as a link. */
export const MAX_TEXT_INSERT_BYTES = 1024 * 1024
/** Pictures carried inside a Write, Deck or Design document (data URLs sync inside the body). */
export const MAX_EMBED_PICTURE_BYTES = 20 * 1024 * 1024
/** PlexiiDiagrams' own picture cap (commands.addImageFiles). */
export const MAX_DIAGRAM_PICTURE_BYTES = 2.5 * 1024 * 1024
/** PlexiiDraw's Place cap (shared/draw/import/imageInfo MAX_PLACE_BYTES). */
export const MAX_DRAW_PLACE_BYTES = 40 * 1024 * 1024

export function megabytes(n: number): string {
  const mb = n / (1024 * 1024)
  return mb >= 10 ? `${Math.round(mb)} MB` : `${Math.round(mb * 10) / 10} MB`
}

/** "This picture is 48 MB. PlexiiDeck takes pictures up to 20 MB." */
export function pictureTooLarge(bytes: number, app: string, cap: number): string {
  return `This picture is ${megabytes(bytes)}. ${app} takes pictures up to ${megabytes(cap)}.`
}

// ── Where it can go ──────────────────────────────────────────────────────────

/** A content destination: the six office apps (by snippet kind) and the work widgets that take content. */
export type ContentTarget = 'doc' | 'sheet' | 'slide' | 'design' | 'diagram' | 'draw' | 'page' | 'markdown' | 'sticky' | 'note' | 'table' | 'image'

/** Destinations that hold text only: a copy is the content's words, never a picture. */
export const TEXT_ONLY: ReadonlySet<ContentTarget> = new Set(['sticky', 'note'])
const TEXT_FORMS = new Set(['text', 'markdown', 'docNodes', 'rows'])

/** Destinations that hold a link to a file, document or folder. */
export const LINK_HOLDERS: ReadonlySet<ContentTarget> = new Set(['doc', 'page', 'markdown', 'sticky', 'note'])

export const TARGET_APP: Record<ContentTarget, string> = {
  doc: 'PlexiiWrite',
  sheet: 'PlexiiCells',
  slide: 'PlexiiDeck',
  design: 'PlexiiDesign',
  diagram: 'PlexiiDiagrams',
  draw: 'PlexiiDraw',
  page: 'A page work widget',
  markdown: 'A markdown work widget',
  sticky: 'A sticky',
  note: 'A note',
  table: 'A table work widget',
  image: 'An image work widget'
}

/** The picture cap a destination applies, or null when it refers to the file instead of carrying it. */
export function pictureCap(target: ContentTarget): number | null {
  if (target === 'doc' || target === 'slide' || target === 'design') return MAX_EMBED_PICTURE_BYTES
  if (target === 'diagram') return MAX_DIAGRAM_PICTURE_BYTES
  if (target === 'draw') return MAX_DRAW_PLACE_BYTES
  return null // work widgets refer to the fb_files row (fb-file://<id>)
}

/** Families that are pointed at (reference first); everything else is content. */
const REFERENCE_KINDS: ReadonlySet<FileSourceKind> = new Set(['office-doc', 'widget', 'pdf', 'video', 'audio', 'generic', 'folder'])

export function isReferenceKind(k: FileSourceKind): boolean {
  return REFERENCE_KINDS.has(k)
}

/** Does this kind need the file's bytes to make its content (so missing bytes matter)? */
export function needsBytes(k: FileSourceKind): boolean {
  return k === 'image' || k === 'svg' || k === 'pdf' || k === 'text'
}

// ── The link ─────────────────────────────────────────────────────────────────

/** `plexii://file/<id>`, `plexii://document/<id>` or `plexii://folder/<id>`. */
export function linkHref(ref: FileDragRef): string {
  if (ref.kind === 'folder') return `plexii://folder/${encodeURIComponent(ref.entryId)}`
  if (ref.kind === 'doc' && ref.docId) return `plexii://document/${encodeURIComponent(ref.docId)}`
  return `plexii://file/${encodeURIComponent(ref.entryId)}`
}

export function linkValue(ref: FileDragRef): LinkValue {
  const target: LinkValue['target'] = ref.kind === 'folder' ? 'folder' : ref.kind === 'doc' && ref.docId ? 'document' : 'file'
  return { href: linkHref(ref), title: ref.name || 'Untitled', target, ...(target === 'file' && ref.mimeType ? { mime: ref.mimeType } : {}) }
}

export function linkForm(ref: FileDragRef, lossy: string[] = []): LinkForm {
  return { kind: 'link', value: linkValue(ref), lossy }
}

// ── CSV and TSV (RFC 4180) ───────────────────────────────────────────────────

/**
 * RFC 4180: fields separated by `sep`, records by CRLF or LF, a field in double
 * quotes may hold separators, newlines and doubled quotes (""). A trailing
 * newline does not make an empty record. Ragged rows are padded to the widest.
 */
export function parseDelimited(text: string, sep: ',' | '\t' = ','): string[][] {
  const s = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  let fieldStarted = false
  while (i < s.length) {
    const ch = s[i]!
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && !fieldStarted) {
      quoted = true
      fieldStarted = true
      i++
      continue
    }
    if (ch === sep) {
      row.push(field)
      field = ''
      fieldStarted = false
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      fieldStarted = false
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    fieldStarted = true
    i++
  }
  if (fieldStarted || field || row.length) {
    row.push(field)
    rows.push(row)
  }
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0)
  return rows.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill('')] : r))
}

// ── Content forms ────────────────────────────────────────────────────────────

/** What the renderer read for one ref (all optional: absent means not read or not there). */
export interface FileContent {
  /** The file's bytes were needed but are not on this device. */
  bytesMissing?: boolean
  /** The file's size, for the caps. */
  sizeBytes?: number
  /** A raster picture (or a PDF's first page, rendered): a data: URL with its pixel size. */
  picture?: { src: string; width?: number; height?: number }
  /** SVG markup and its size. */
  svg?: { text: string; width: number; height: number }
  /** The text of a text-like file. */
  text?: string
  /** A document's or work widget file's own forms (formsOf its snippet body), native first. */
  docForms?: Form[]
}

const TEXT_EXT = /\.([a-z0-9]+)$/i
function extOf(ref: FileDragRef): string {
  return ((ref.ext ?? '').replace(/^\./, '') || TEXT_EXT.exec(ref.name)?.[1] || '').toLowerCase()
}

function rowsValue(rows: string[][]): RowsValue {
  return { rows, header: looksLikeHeader(rows) }
}

/** The forms of a text-like file's text, best first for its type. */
export function textFileForms(ref: FileDragRef, text: string): Form[] {
  const ext = extOf(ref)
  const body = text.replace(/\r\n?/g, '\n')
  if (ext === 'csv' || ext === 'tsv' || ref.mimeType === 'text/csv' || ref.mimeType === 'text/tab-separated-values') {
    const rows = parseDelimited(body, ext === 'tsv' ? '\t' : ',')
    if (!rows.length) return [{ kind: 'text', value: '', lossy: [] }]
    const v = rowsValue(rows)
    return [
      { kind: 'rows', value: v, lossy: [] },
      { kind: 'docNodes', value: [rowsToTableNode(rows, v.header)], lossy: [] },
      { kind: 'markdown', value: rowsToGfm(rows), lossy: [] },
      { kind: 'text', value: body.trimEnd(), lossy: [] }
    ]
  }
  if (ext === 'md' || ext === 'markdown' || ref.mimeType === 'text/markdown') {
    const nodes = markdownLiteToNodes(body)
    const derived = formsOfDocNodes(nodes)
    // The file's own markdown, not a re-rendering of it.
    return derived.map((f) => (f.kind === 'markdown' ? { kind: 'markdown', value: body.trimEnd(), lossy: [] } : f))
  }
  if (ext === 'json' || ref.mimeType === 'application/json') {
    const code = { type: 'codeBlock', attrs: { language: 'json' }, content: body.trim() ? [{ type: 'text', text: body.trimEnd() }] : [] }
    return [
      { kind: 'docNodes', value: [code], lossy: [] },
      { kind: 'markdown', value: '```json\n' + body.trimEnd() + '\n```', lossy: [] },
      { kind: 'text', value: body.trimEnd(), lossy: [] }
    ]
  }
  // .txt and anything else plain: paragraphs, one per line; for a grid, one
  // line per row in a single column (the plan: ".txt lines as one column").
  const lines = body.trimEnd().split('\n')
  return [
    { kind: 'docNodes', value: lines.map((l) => paragraphNode(l)), lossy: [] },
    { kind: 'text', value: body.trimEnd(), lossy: [] },
    { kind: 'rows', value: { rows: lines.map((l) => [l]), header: false }, lossy: [] }
  ]
}

/** The content forms of one ref (no link), from what was read. Empty when it has none. */
export function contentForms(ref: FileDragRef, content: FileContent): Form[] {
  const kind = sourceKindOf(ref)
  switch (kind) {
    case 'image':
      if (!content.picture) return []
      return [{ kind: 'image', value: pictureValue(ref, content.picture, true), lossy: [] }]
    case 'svg':
      if (!content.svg) return []
      return [{ kind: 'svg', value: { svg: content.svg.text, width: content.svg.width, height: content.svg.height, vector: true, app: 'the original file' }, lossy: [] }]
    case 'pdf':
      // The first page, rendered by the reader. Not the file's own bytes, so
      // no fileId: a work widget stores the rendered page as a picture.
      if (!content.picture) return []
      return [{ kind: 'image', value: pictureValue(ref, content.picture, false), lossy: [PDF_FIRST_PAGE] }]
    case 'text':
      return content.text === undefined ? [] : textFileForms(ref, content.text)
    case 'office-doc':
    case 'widget':
      return content.docForms ?? []
    default:
      return []
  }
}

function pictureValue(ref: FileDragRef, p: { src: string; width?: number; height?: number }, sameFile: boolean): ImageValue {
  return {
    src: p.src,
    ...(p.width ? { width: p.width } : {}),
    ...(p.height ? { height: p.height } : {}),
    alt: ref.name,
    ...(sameFile ? { fileId: ref.entryId } : {})
  }
}

// ── The forms a TARGET is given ──────────────────────────────────────────────

export interface TargetForms {
  forms: Form[]
  /** Nothing goes in; shown verbatim. */
  refused?: string
}

export interface TargetOptions {
  target: ContentTarget
  /** ⌥ at drop: swap reference and copy where both exist. */
  alt?: boolean
  /** The document the target IS (a document cannot go inside itself). */
  ownDocumentId?: string | null
  /** The target is read-only. */
  readOnly?: boolean
}

/**
 * The forms one dropped ref hands to one target, best first, per the matrix.
 * The builders and acceptors then take the first form they can hold, so the
 * ORDER here is the reference-or-copy decision.
 */
export function formsForTarget(ref: FileDragRef, content: FileContent, o: TargetOptions): TargetForms {
  if (o.readOnly) return { forms: [], refused: REASON_READ_ONLY }
  const kind = sourceKindOf(ref)
  if (kind === 'office-doc' || kind === 'widget') {
    if (o.ownDocumentId && ref.docId === o.ownDocumentId) return { forms: [], refused: REASON_INTO_ITSELF }
  }
  const holdsLinks = LINK_HOLDERS.has(o.target)
  const alt = !!o.alt

  // A content file whose bytes are not here, or a text too long to insert: a
  // link, said so, where the target holds links; elsewhere the link's refusal.
  if (needsBytes(kind) && content.bytesMissing) return { forms: [linkForm(ref, [NOTICE_BYTES_MISSING])] }
  if (kind === 'text' && (content.sizeBytes ?? 0) > MAX_TEXT_INSERT_BYTES) {
    return { forms: [linkForm(ref, holdsLinks ? [NOTICE_TOO_LONG] : [])] }
  }

  let content_ = contentForms(ref, content)

  // A picture over the target's cap: a link where links are held, else the exact refusal.
  const cap = pictureCap(o.target)
  const pictureBytes = kind === 'image' || kind === 'svg' ? (content.sizeBytes ?? 0) : 0
  if (cap !== null && pictureBytes > cap) {
    if (holdsLinks) return { forms: [linkForm(ref)] }
    return { forms: [], refused: pictureTooLarge(pictureBytes, TARGET_APP[o.target], cap) }
  }

  const link = linkForm(ref)
  if (!isReferenceKind(kind)) {
    // Content files: the content; ⌥ makes a link where links are held.
    if (alt && holdsLinks) return { forms: [link] }
    return { forms: content_.length ? content_ : [link] }
  }

  // Reference kinds.
  if (holdsLinks) {
    // The link; ⌥ the content, link last (never the native body ahead of a
    // link by default: a same-kind builder would copy it).
    if (!alt || !content_.length) return { forms: [link] }
    // A sticky or note copies the words: not the picture of a drawing or a
    // PDF page, and not the source body (whose kind would make it refuse).
    if (TEXT_ONLY.has(o.target)) {
      const words = content_.filter((f) => TEXT_FORMS.has(f.kind))
      return { forms: words.length ? [...words, link] : [link] }
    }
    return { forms: [...content_, link] }
  }
  if (o.target === 'image' && !alt) {
    // An image work widget is filled by a picture you choose to copy (⌥); a
    // plain drop of a document or a PDF has no picture of its own.
    content_ = []
  }
  return { forms: [...content_, link] }
}

/** The kind of snippet body a read's native form is, for the conversion notice. */
export function nativeKind(forms: Form[]): string | null {
  const n = forms.find((f) => f.kind === 'native')
  return n && n.kind === 'native' ? n.value.kind : null
}
