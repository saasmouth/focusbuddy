// Dropping files onto the canvas: each becomes placed art at the drop point,
// at its actual size (several files cascade down and to the right), as one
// undo step -- what Illustrator does with files dragged in from the desktop.
// Images are embedded; SVGs arrive as editable vectors; a PDF as an image of
// its first page. Anything that cannot be placed is said, not skipped.

import { drawId } from '@shared/draw'
import type { Pt } from '@shared/drawGeometry'
import type { DrawDoc } from '@shared/draw/model'
import { domImportDeps, importStructure, prepareFiles, type ImportDeps, type ImportFile } from './importFiles'
import { placeIntoDoc, showImportReport } from './place'
import type { EditorCtx } from './types'
import type { FileDragRef } from '@shared/filesDragPayload'
import { sourceKindOf } from '@shared/filesDragPayload'
import { widgetFileGroupId } from '@shared/widgetFiles'
import { runContentDrop } from '../../../../lib/filesContentDrop'
import { useNoticeStore } from '../../../../stores/notice'
import { landConvertedAt } from './clipboard'

/** Does this drag carry files from the desktop (not a work widget, not text)? */
export function dragHasFiles(dt: { types: ArrayLike<string> | readonly string[] } | null): boolean {
  if (!dt) return false
  return Array.from(dt.types as ArrayLike<string>).includes('Files')
}

/** Read browser File objects as bytes. */
export async function readDroppedFiles(list: ArrayLike<File>): Promise<ImportFile[]> {
  const out: ImportFile[] = []
  for (const f of Array.from(list).slice(0, 64)) out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })
  return out
}

const CASCADE = 16

/** Place dropped files at `at` (artboard coordinates). */
export async function placeDroppedFiles(ctx: EditorCtx, files: ImportFile[], at: Pt, deps: ImportDeps = domImportDeps()): Promise<void> {
  if (ctx.get().readOnly) {
    ctx.status('This artwork is read-only, so files cannot be placed in it.')
    return
  }
  if (!files.length) return
  ctx.busy(`Placing ${files.length === 1 ? files[0].name : `${files.length} files`}…`)
  try {
    const { items, errors } = await prepareFiles(files, deps, { structure: importStructure(ctx.get()), docDpi: ctx.doc().settings.dpi, newId: drawId })
    let doc: DrawDoc = ctx.doc()
    const ids: string[] = []
    items.forEach((item, i) => {
      const r = placeIntoDoc(doc, item, { x: at.x + i * CASCADE, y: at.y + i * CASCADE, w: item.size.w, h: item.size.h }, { newId: drawId })
      doc = r.doc
      ids.push(...r.ids)
    })
    if (items.length) {
      ctx.history.commit(doc, items.length === 1 ? `Place ${items[0].label}` : `Place ${items.length} files`)
      ctx.select(ids)
    }
    const reports = items.filter((it) => it.report?.length).map((it) => ({ name: it.name, lines: it.report! }))
    if (errors.length) reports.push({ name: 'Not placed', lines: errors })
    if (reports.length) showImportReport(ctx, reports)
    else if (items.length) ctx.status(items.length === 1 ? `Placed ${items[0].name}.` : `Placed ${items.length} files.`)
  } finally {
    ctx.busy(null)
  }
}

// ── From the Files panel ─────────────────────────────────────────────────────
//
// Pictures, SVG and PDFs dragged out of Files go through Place, exactly as the
// same files dragged in from the desktop: actual size, SVG as editable
// vectors, a PDF as its first page, Draw's own report. Everything else
// (documents, text files, work widget files with ⌥) is converted to Draw
// objects by the same path as a paste from another app and lands at the drop
// point. A work widget file is a live widget object, as its own drag lands.

/** Drop refs dragged out of Files at `at` (artboard coordinates). */
export async function dropFromFiles(
  ctx: EditorCtx,
  refs: FileDragRef[],
  at: Pt,
  opts: { alt: boolean; ownDocumentId: string | null; addWidget: (widgetId: string) => void }
): Promise<void> {
  const readOnly = ctx.get().readOnly
  const placeable = readOnly ? [] : refs.filter((r) => PLACED.has(sourceKindOf(r)))
  const rest = refs.filter((r) => !placeable.includes(r))
  if (placeable.length) {
    const files: ImportFile[] = []
    const missing: string[] = []
    for (const r of placeable) {
      const read = await window.api.files.read(r.entryId).catch(() => null)
      // A copy: a view over the bridged buffer does not serialise back to the main process (the PDF renderer).
      if (read) files.push({ name: r.name, bytes: Uint8Array.from(new Uint8Array(read.buffer as ArrayBuffer)) })
      else missing.push(r.name)
    }
    if (files.length) await placeDroppedFiles(ctx, files, at)
    if (missing.length) useNoticeStore.getState().show({ text: NOTICE_BYTES_MISSING_DRAW, icon: 'warning' })
  }
  if (!rest.length) return
  await runContentDrop(rest, { target: 'draw', alt: opts.alt, readOnly, ownDocumentId: opts.ownDocumentId }, async (read, ref) => {
    if (ref.kind === 'doc' && ref.docType === 'widget' && ref.docId && !opts.alt) {
      opts.addWidget(widgetFileGroupId(ref.docId))
      return true
    }
    return landConvertedAt(ctx, read, at)
  })
}

const PLACED = new Set(['image', 'svg', 'pdf'])
const NOTICE_BYTES_MISSING_DRAW = "This file's contents are not on this device yet, so it cannot be placed."
