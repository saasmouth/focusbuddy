// File › Open SVG…, Place…, Place as template…, Import SVG…, Replace image…
// (WP-IMPORT). Placed and imported files are always EMBEDDED in the drawing;
// see editor/place.ts for why linking is not offered.

import { drawId } from '@shared/draw'
import { drawDocForStorage } from '@shared/draw/compat'
import { putAsset } from '@shared/draw/assets'
import type { DrawAsset, DrawDoc, DrawImageNode, DrawNode } from '@shared/draw/model'
import { editableIds, getObject, mapObject, primaryArtboard } from '@shared/draw/ops'
import { domImportDeps, importStructure, newDocStructure, openSvgAsDoc, prepareFile, prepareFiles, type ImportDeps, type ImportFile } from '../editor/importFiles'
import { copySvgCode, copyableIds, registerFilePasteImporter, registerSvgPasteImporter, type FilePasteImporter, type SvgPasteImporter } from '../editor/clipboard'
import { loadPlaceCursor, placeIntoDoc, showImportReport } from '../editor/place'
import type { Command, EditorCtx, MenuSpec } from '../editor/types'
import { documentCommand } from '../editor/session'
import type { DocumentOps } from '../../editor/documentOps'
import { v2BlockedReason } from '../editor/v2gate'
import { firstOf, gate, notReadOnly, unless, writableGate } from './gate'

/**
 * What the commands need from the app; tests replace it (setImportHost).
 * Storing and opening a new drawing (Open SVG) is not here: it goes through
 * the DocumentOps the studio's host bound (editor/session.ts documentCommand).
 */
export interface ImportHost {
  deps(): ImportDeps
  pick(purpose: 'place' | 'open' | 'import' | 'replace'): Promise<{ ok: boolean; files: ImportFile[]; skipped: Array<{ name: string; reason: string }> }>
}

const appHost: ImportHost = {
  deps: domImportDeps,
  pick: (purpose) => window.api.draw.pickImportFiles({ purpose })
}

let host: ImportHost = appHost

/** For tests: drive the commands without dialogs or the main process. */
export function setImportHost(h: ImportHost | null): void {
  host = h ?? appHost
}


/** A PDF waiting for its page to be chosen (the Place PDF dialog). */
let pendingPdf: { file: ImportFile; template: boolean } | null = null

function skippedLines(skipped: Array<{ name: string; reason: string }>): string[] {
  return skipped.map((s) => `${s.name} was not read: ${s.reason}.`)
}

function report(ctx: EditorCtx, errors: string[]): void {
  if (!errors.length) return
  if (errors.length === 1) ctx.status(errors[0])
  else showImportReport(ctx, [{ name: 'Not placed', lines: errors }])
}

async function place(ctx: EditorCtx, template: boolean): Promise<void> {
  const picked = await host.pick('place')
  const errors = skippedLines(picked.skipped)
  if (!picked.files.length) return report(ctx, errors)
  const deps = host.deps()
  const opts = { structure: importStructure(ctx.get()), docDpi: ctx.doc().settings.dpi, newId: drawId }
  // One multi-page PDF: ask which page, as Illustrator's Place PDF does.
  if (picked.files.length === 1) {
    const f = picked.files[0]
    const head = new TextDecoder('latin1').decode(f.bytes.slice(0, 1024))
    if (head.includes('%PDF-')) {
      ctx.busy('Reading PDF…')
      try {
        const r = await deps.pdfPage(f.bytes, 1)
        if (r.ok && (r.pages ?? 1) > 1) {
          pendingPdf = { file: f, template }
          ctx.set({ dialog: { id: 'place-pdf-page', props: { name: f.name, pages: r.pages, template } } })
          return
        }
      } finally {
        ctx.busy(null)
      }
    }
  }
  ctx.busy(`Preparing ${picked.files.length === 1 ? picked.files[0].name : `${picked.files.length} files`}…`)
  try {
    const { items, errors: bad } = await prepareFiles(picked.files, deps, opts)
    errors.push(...bad)
    if (items.length) loadPlaceCursor(ctx, items, template)
    report(ctx, errors)
  } finally {
    ctx.busy(null)
  }
}

async function importSvg(ctx: EditorCtx): Promise<void> {
  const picked = await host.pick('import')
  if (!picked.files.length) return report(ctx, skippedLines(picked.skipped))
  const f = picked.files[0]
  ctx.busy(`Importing ${f.name}…`)
  try {
    const item = await prepareFile(f, host.deps(), { structure: importStructure(ctx.get()), docDpi: ctx.doc().settings.dpi, newId: drawId })
    if ('error' in item) return ctx.status(item.error)
    if (item.label !== 'SVG') return ctx.status(`${f.name} is not an SVG file. Use File › Place for images and PDFs.`)
    // Import keeps the file's own coordinates: its page lands on this artboard's.
    const board = primaryArtboard(ctx.doc())
    const { doc, ids } = placeIntoDoc(ctx.doc(), item, { x: board.x, y: board.y, w: item.size.w, h: item.size.h }, { newId: drawId })
    ctx.history.commit(doc, 'Import SVG')
    ctx.select(ids)
    if (item.report?.length) showImportReport(ctx, [{ name: f.name, lines: item.report }])
    else ctx.status(`Imported ${f.name}.`)
  } finally {
    ctx.busy(null)
  }
}

async function openSvg(ctx: EditorCtx, ops: DocumentOps): Promise<void> {
  const picked = await host.pick('open')
  if (!picked.files.length) return report(ctx, skippedLines(picked.skipped))
  const f = picked.files[0]
  ctx.busy(`Opening ${f.name}…`)
  let result: Awaited<ReturnType<typeof openSvgAsDoc>>
  try {
    result = await openSvgAsDoc(f, host.deps(), { structure: newDocStructure(), newId: drawId })
  } finally {
    ctx.busy(null)
  }
  if ('error' in result) return ctx.status(result.error)
  const title = f.name.replace(/\.svgz?$/i, '') || 'Untitled artwork'
  const body = drawDocForStorage(result.doc)
  const open = (): void => void ops.newDocument({ title, body })
  // Anything worth knowing is said BEFORE the drawing replaces this one.
  if (result.report.length > 1) showImportReport(ctx, [{ name: f.name, lines: result.report }], { label: 'Open drawing', run: open })
  else open()
}

/** The one selected image, when exactly one editable image is selected. */
function selectedImage(ctx: EditorCtx): DrawImageNode | null {
  const s = ctx.get()
  const ids = editableIds(s.doc, s.selection)
  if (ids.length !== 1 || s.selection.length !== 1) return null
  const n = getObject(s.doc, ids[0])
  return n && n.type === 'image' ? n : null
}

async function replaceImage(ctx: EditorCtx): Promise<void> {
  const target = selectedImage(ctx)
  if (!target) return
  const picked = await host.pick('replace')
  if (!picked.files.length) return report(ctx, skippedLines(picked.skipped))
  const f = picked.files[0]
  const item = await prepareFile(f, host.deps(), { structure: importStructure(ctx.get()), docDpi: ctx.doc().settings.dpi, newId: drawId })
  if ('error' in item) return ctx.status(item.error)
  if (item.label === 'SVG') return ctx.status('Replace takes an image or a PDF page. To bring in SVG art, use File › Place.')
  // Illustrator keeps the placed item's scale: the new picture is sized by the
  // same factor the old one was shown at, from the same top-left corner.
  const doc = ctx.doc()
  const now = getObject(doc, target.id) as DrawImageNode
  const old = doc.assets[now.assetId]
  const kx = old?.w ? now.w / old.w : now.w / item.size.w
  const ky = old?.h ? now.h / old.h : now.h / item.size.h
  const made = item.make({ x: now.x, y: now.y, w: item.size.w, h: item.size.h })
  const fresh = made.nodes[0] as DrawImageNode
  const a = made.assets[fresh.assetId]
  const put = putAsset(doc.assets, a.dataUrl, a.w !== undefined && a.h !== undefined ? { w: a.w, h: a.h } : undefined)
  const natural = { w: a.w ?? item.size.w, h: a.h ?? item.size.h }
  const next: DrawDoc = mapObject({ ...doc, assets: put.assets }, now.id, (n) => ({
    ...(n as DrawImageNode),
    assetId: put.id,
    w: natural.w * kx,
    h: natural.h * ky,
    name: fresh.name,
    alt: fresh.alt
  }))
  ctx.history.commit(next, 'Replace image')
  if (item.report?.length) showImportReport(ctx, [{ name: f.name, lines: item.report }])
  else ctx.status(`Replaced with ${f.name}.`)
}

async function placePdfPage(ctx: EditorCtx, args: unknown): Promise<void> {
  const p = pendingPdf
  pendingPdf = null
  if (!p) return
  const page = Math.max(1, Math.round(Number((args as { page?: number } | undefined)?.page) || 1))
  ctx.busy(`Rendering page ${page}…`)
  try {
    const item = await prepareFile(p.file, host.deps(), { structure: importStructure(ctx.get()), docDpi: ctx.doc().settings.dpi, newId: drawId, page })
    if ('error' in item) return ctx.status(item.error)
    loadPlaceCursor(ctx, [item], p.template)
  } finally {
    ctx.busy(null)
  }
}

// ── SVG paste (WP-CLIPBOARD's seam) ──────────────────────────────────────────

const PASTED_SVG_NAME = 'Pasted SVG.svg'

/**
 * SVG on the clipboard pastes as editable vectors, through exactly what
 * File › Import SVG does: the shared importer, anything it cannot edit
 * rasterised and reported, v1 lowering for a drawing that must stay v1, and
 * (in a v2 drawing) one group, as Illustrator pastes SVG code.
 */
export const pasteSvgImporter: SvgPasteImporter = async (svg, target, info) => {
  const item = await prepareFile({ name: PASTED_SVG_NAME, bytes: new TextEncoder().encode(svg) }, host.deps(), {
    structure: importStructure({ storedSchema: info.storedSchema, doc: target, v2Writes: info.v2Writes }),
    docDpi: target.settings.dpi,
    newId: drawId
  })
  if ('error' in item) return { error: item.error.startsWith(`${PASTED_SVG_NAME}: `) ? item.error.slice(PASTED_SVG_NAME.length + 2) : item.error }
  const made = item.make({ x: 0, y: 0, w: item.size.w, h: item.size.h })
  return { nodes: made.nodes, assets: made.assets, ...(item.report?.length ? { report: item.report.join(' ') } : {}) }
}

registerSvgPasteImporter(pasteSvgImporter)

/** Gap between several pasted files, laid side by side. */
const FILE_PASTE_GAP = 16

/**
 * Files copied in Finder paste exactly as File › Place would place them --
 * an image, an SVG as editable art, a PDF's first page as an image -- each at
 * its actual size, several side by side (the paste then centres them in the
 * window). Never their names: that was all a Finder copy used to paste.
 */
export const pasteFileImporter: FilePasteImporter = async (files, target, info) => {
  const opts = { structure: importStructure({ storedSchema: info.storedSchema, doc: target, v2Writes: info.v2Writes }), docDpi: target.settings.dpi, newId: drawId }
  const { items, errors } = await prepareFiles(files, host.deps(), opts)
  if (!items.length) return { error: errors.join(' ') || 'Nothing in the copied files can be placed.' }
  const nodes: DrawNode[] = []
  let assets: Record<string, DrawAsset> = {}
  let x = 0
  for (const item of items) {
    const made = item.make({ x, y: 0, w: item.size.w, h: item.size.h })
    nodes.push(...made.nodes)
    assets = { ...assets, ...made.assets }
    x += item.size.w + FILE_PASTE_GAP
  }
  const lines = [...items.flatMap((it) => it.report ?? []), ...errors]
  return { nodes, assets, note: lines.length ? lines.join(' ') : `Pasted ${items.length === 1 ? items[0].name : `${items.length} files`}.` }
}

registerFilePasteImporter(pasteFileImporter)

export const menus: MenuSpec[] = [{ path: 'edit/Copy As', label: 'Copy As', icon: 'content_copy', order: 207 }]

export const commands: Command[] = [
  // Opens the SVG as a NEW drawing, through the host's DocumentOps (it opens
  // where the host says): off in a snippet edit session, or with no document
  // host (editor/session.ts).
  documentCommand({
    id: 'file.openSvg',
    label: 'Open SVG…',
    icon: 'folder_open',
    menu: { path: 'file', order: 105 },
    run: (ctx, ops) => openSvg(ctx, ops)
  }),
  {
    id: 'file.place',
    label: 'Place…',
    icon: 'add_photo_alternate',
    menu: { path: 'file', order: 250 },
    ...writableGate,
    run: (ctx) => place(ctx, false)
  },
  {
    id: 'file.placeTemplate',
    label: 'Place as template…',
    icon: 'layers',
    menu: { path: 'file', order: 251 },
    // A template layer is something only the newer drawing format stores.
    ...gate(
      firstOf(notReadOnly, (ctx) =>
        importStructure(ctx.get()) === 'v2' ? null : `Template layers need the newer drawing format: ${v2BlockedReason(ctx.get())}.`
      )
    ),
    run: (ctx) => place(ctx, true)
  },
  {
    id: 'file.importSvg',
    label: 'Import SVG…',
    icon: 'polyline',
    menu: { path: 'file', order: 252 },
    ...writableGate,
    run: (ctx) => importSvg(ctx)
  },
  {
    id: 'file.replaceImage',
    label: 'Replace image…',
    icon: 'swap_horiz',
    menu: { path: 'file', order: 253 },
    ...gate(firstOf(notReadOnly, unless((ctx) => selectedImage(ctx) !== null, 'Select one image to replace it.'))),
    run: (ctx) => replaceImage(ctx)
  },
  { id: 'file.placePdfPage', label: 'Place PDF page', ...writableGate, run: (ctx, args) => placePdfPage(ctx, args) },
  {
    id: 'edit.copySvgCode',
    label: 'SVG Code',
    icon: 'code',
    menu: { path: 'edit/Copy As', order: 0 },
    // Copying never edits: allowed on a read-only drawing too.
    ...gate(unless((ctx) => copyableIds(ctx).length > 0, 'Select something to copy as SVG code.')),
    run: (ctx) => copySvgCode(ctx).then(() => undefined)
  }
]
