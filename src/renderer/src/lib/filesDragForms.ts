// A ref dragged out of Files, read as conversion forms for one content target.
//
// The result is a FormsRead with verb 'drop': exactly the shape the clipboard
// reader returns, so each office app's EXISTING converted paste takes it
// unchanged (pasteIntoDoc(editor, { read }), pasteConverted(kind, insert,
// { read })), and each work widget's dropForms runs the same `land` as paste
// and insert. A file dropped and the same content pasted land identically.
//
// This is the async, DOM-bound half; every decision is pure and lives in
// shared/fileForms.ts. Bytes are read only when the target will use them
// (never for a link), through files.read, under the caps. A PDF's first page
// is rendered here with PlexiiDraw's own PDF renderer (the one Place uses),
// never inside the pure conversion. An Excel workbook is read in the MAIN
// process (files:readSheet, main/sheetXlsxRead.ts, over SheetJS) into the
// first sheet's PlexiiCells body; here it only becomes forms. The drop waits
// for that read, like the PDF page: nothing lands until there is something to
// land, and a workbook that cannot be read is refused with why.

import { formsOf } from '@shared/snippetForms'
import { formsOfSheet } from '@shared/snippetForms/fromSheet'
import { XLSX_DROP_MAX_BYTES } from '@shared/xlsxSheet'
import type { Form } from '@shared/snippetForms'
import { sourceKindOf, type FileDragRef } from '@shared/filesDragPayload'
import {
  LINK_HOLDERS,
  MAX_TEXT_INSERT_BYTES,
  REASON_INTO_ITSELF,
  REASON_READ_ONLY,
  formsForTarget,
  isReferenceKind,
  nativeKind,
  needsBytes,
  pictureCap,
  type FileContent,
  type TargetOptions
} from '@shared/fileForms'
import { isRasterKind, rasterDataUrl, rasterInfo, sniffImportKind } from '@shared/draw/import/imageInfo'
import type { SnippetKind } from '@shared/snippets'
import type { FormsRead } from './clipboardForms'
import { snippetConvertDeps } from './snippetConvertDeps'
import { documentSnippetBody } from './documentSnippetBody'

/** Never read more than this for a picture we will carry (the largest cap is Draw's 40 MB). */
const READ_CEILING = 64 * 1024 * 1024

/** Does this target, with this modifier, use the ref's content at all (or only its link)? */
export function wantsContent(ref: FileDragRef, o: TargetOptions): boolean {
  const kind = sourceKindOf(ref)
  const holdsLinks = LINK_HOLDERS.has(o.target)
  if (kind === 'folder' || kind === 'video' || kind === 'audio' || kind === 'generic') return false
  if (isReferenceKind(kind)) {
    if (holdsLinks || o.target === 'image') return !!o.alt
    return true
  }
  return !(o.alt && holdsLinks)
}

function svgSize(text: string): { width: number; height: number } {
  const tag = /<svg\b[^>]*>/i.exec(text)?.[0] ?? ''
  const num = (name: string): number | null => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9.]+)`, 'i').exec(tag)
    return m ? Number(m[1]) : null
  }
  const vb = /\bviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)/i.exec(tag)
  const w = num('width') ?? (vb ? Number(vb[1]) : null) ?? 300
  const h = num('height') ?? (vb ? Number(vb[2]) : null) ?? 150
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) }
}

async function readBytes(id: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const r = await window.api.files.read(id)
    if (!r) return null
    // A COPY: the buffer arrives through the context bridge, and a view over
    // it does not serialise back to the main process (Draw's PDF renderer
    // refused it: "Value is none of these types String, Path").
    return { bytes: Uint8Array.from(new Uint8Array(r.buffer as ArrayBuffer)), mime: r.mimeType }
  } catch {
    return null
  }
}

/** Read what the target needs of one ref. */
export async function readFileContent(ref: FileDragRef, o: TargetOptions): Promise<FileContent> {
  const kind = sourceKindOf(ref)
  const content: FileContent = { sizeBytes: ref.sizeBytes }
  if (!wantsContent(ref, o)) return content

  if (kind === 'office-doc' || kind === 'widget') {
    const doc = ref.docId ? await window.api.documents.get(ref.docId).catch(() => null) : null
    if (!doc) return content
    const r = documentSnippetBody(doc)
    if (!r.body) return content
    // What the copy leaves out goes on every form, so the one notice says it.
    // A body the converters cannot read is no content (the link stands), never a broken drop.
    try {
      content.docForms = formsOf(r.body, snippetConvertDeps()).map((f): Form => (f.kind === 'native' || !r.lossy.length ? f : ({ ...f, lossy: [...r.lossy, ...f.lossy] } as Form)))
    } catch {
      content.docForms = undefined
    }
    return content
  }

  if (!needsBytes(kind)) return content
  const size = ref.sizeBytes ?? 0
  if (kind === 'sheet') return size > XLSX_DROP_MAX_BYTES ? content : readWorkbook(ref, content)
  if (kind === 'text' && size > MAX_TEXT_INSERT_BYTES) return content
  const cap = pictureCap(o.target)
  if ((kind === 'image' || kind === 'svg') && cap !== null && size > cap) return content
  if (size > READ_CEILING) return content

  const read = await readBytes(ref.entryId)
  if (!read) return { ...content, bytesMissing: true }
  const bytes = read.bytes
  content.sizeBytes = bytes.byteLength

  if (kind === 'text') {
    content.text = new TextDecoder('utf-8').decode(bytes)
    return content
  }
  // Pictures by what they ARE, never by name.
  const sniffed = sniffImportKind(bytes, ref.name)
  if (kind === 'pdf' || sniffed === 'pdf') {
    try {
      const r = await window.api.draw.pdfPage({ bytes, page: 1 })
      if (r.ok && r.dataUrl) content.picture = { src: r.dataUrl, width: r.w ? Math.round(r.w) : undefined, height: r.h ? Math.round(r.h) : undefined }
    } catch {
      /* not renderable: no picture, the link stands */
    }
    return content
  }
  if (sniffed === 'svg' || kind === 'svg') {
    const text = new TextDecoder('utf-8').decode(bytes)
    content.svg = { text, ...svgSize(text) }
    return content
  }
  if (sniffed && isRasterKind(sniffed)) {
    const info = rasterInfo(bytes, sniffed)
    content.picture = { src: rasterDataUrl(bytes, sniffed), width: info?.w, height: info?.h }
  }
  return content
}

/**
 * An Excel workbook: its first sheet, read and checked in the main process,
 * as the forms a PlexiiCells range has. What the workbook has that the sheet
 * body does not keep ("First sheet of 3.", "Charts are not kept.") goes on
 * EVERY form, the native one included, so PlexiiCells says it too.
 */
async function readWorkbook(ref: FileDragRef, content: FileContent): Promise<FileContent> {
  const r = await window.api.files.readSheet(ref.entryId)
  if (!r.ok) {
    if (r.code === 'bytes') return { ...content, bytesMissing: true }
    return { ...content, sheetRefused: { reason: r.reason, tooLarge: r.code === 'too-large' } }
  }
  const forms = formsOfSheet(r.body, snippetConvertDeps(), { app: 'the original file' })
  content.docForms = r.notes.length ? forms.map((f): Form => ({ ...f, lossy: [...r.notes, ...f.lossy] }) as Form) : forms
  return content
}

/**
 * One ref, read for one target: a FormsRead with verb 'drop' for the target's
 * existing paste or dropForms. `refused` set means nothing goes in and that
 * sentence is shown verbatim.
 */
export async function readFilesDragForms(ref: FileDragRef, o: TargetOptions): Promise<FormsRead> {
  // Refusals that need nothing read come first (read-only, a document into itself).
  const pre = formsForTarget(ref, {}, o)
  if (pre.refused === REASON_READ_ONLY || pre.refused === REASON_INTO_ITSELF) {
    return { forms: [], source: null, refused: pre.refused, verb: 'drop' }
  }
  const content = await readFileContent(ref, o)
  const r = formsForTarget(ref, content, o)
  if (r.refused) return { forms: [], source: null, refused: r.refused, verb: 'drop' }
  // A workbook's sheet body is not one of our apps' content: no "Converted
  // from PlexiiCells", and its notes are said in PlexiiCells too.
  const kind = sourceKindOf(ref) === 'sheet' ? null : ((nativeKind(r.forms) as SnippetKind | null) ?? null)
  return { forms: r.forms, source: null, kind, verb: 'drop' }
}
