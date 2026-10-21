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
