// File menu: new, copy, presets, export, rename, history, trash.

import { DRAW_SIZES, blankDrawBody } from '@shared/draw'
import { drawDocForStorage } from '@shared/draw/compat'
import type { Command, EditorCtx, ExportOptions, MenuSpec } from '../editor/types'
import { documentCommand } from '../editor/session'
import { READ_ONLY_REASON, gate, writableGate } from './gate'

const writable = (ctx: EditorCtx): boolean => !ctx.get().readOnly

/**
 * The name of what is on screen, for anything that names it. For a drawing,
 * the title the HOST bound with the document (DocumentOps.title), so a desk
 * widget names its own drawing. In a snippet edit session, the studio's own
 * title. Never the documents store's `active` document, which on a desk is a
 * different one: a label never names the wrong thing.
 */
export function documentTitle(ctx: EditorCtx): string {
  if (ctx.host.session?.()) return ctx.host.title?.() || 'Untitled snippet'
  const ops = ctx.host.docOps?.()
  return (ops ? ops.title() : ctx.host.title?.())?.trim() || 'Untitled artwork'
}

/**
 * The drawing as it is on screen, in the form it is stored in (exactly what
 * the studio emits). Make a copy copies THIS rather than the stored row, which
 * can lag the canvas by the host's save debounce. Undefined when read-only (a
 * drawing from a newer PlexiiDraw): the studio shows less than the file holds,
 * so the stored row is copied as it is (DocumentOps.makeCopy's default).
 */
function storedBody(ctx: EditorCtx): unknown {
  const s = ctx.get()
  if (s.readOnly) return undefined
  return drawDocForStorage(s.doc, { stored: s.storedSchema, allowV2: s.v2Writes })
}

/** Export: straight away with one artboard; with several, ask what to export unless the caller said. */
function exportFormat(ctx: EditorCtx, format: 'png' | 'svg' | 'pdf', args: unknown): Promise<void> | void {
  const opts = args && typeof args === 'object' && 'scope' in (args as object) ? (args as ExportOptions) : undefined
  if (opts || ctx.doc().artboards.length < 2) return ctx.host.exportAs(format, opts)
  ctx.set({ dialog: { id: 'export-artboards', props: { format } } })
}

export const menus: MenuSpec[] = [
  { path: 'file', label: 'File', order: 10 },
  { path: 'file/New from preset', label: 'New from preset', icon: 'aspect_ratio', order: 200 },
  // Download ▸, as in every office app (SPEC §9.2, G8). The commands keep their
  // full names for the palette and the shortcuts dialog; the submenu shows the format.
  { path: 'file/Download', label: 'Download', icon: 'download', order: 300 }
]

// documentCommand: acts through the DocumentOps the host bound to the drawing
// on screen, and only that; off with a reason in a snippet edit session or
// where no host supplied a document (editor/session.ts). Save and Export stay
// on everywhere.
//
// New, New from preset and Make a copy create a document and open it where the
// host says (DocumentOps.onOpen: the Documents view, also from a desk widget,
// which leaves the widget showing what it showed).
export const commands: Command[] = [
  documentCommand({
    id: 'file.new',
    label: 'New artwork',
    icon: 'note_add',
    menu: { path: 'file', order: 100 },
    run: (_ctx, ops) => ops.newDocument()
  }),
  // Save (Illustrator's ⌘S). A drawing is persisted from every edit by its
  // host, so there is nothing to save and this shows disabled -- and ⌘S is not
  // claimed (keyWhen), so the key does exactly what it did before. Where the
  // host writes only when asked (a saved snippet's edit session), this is that
  // host's Save. It never writes anything itself.
  {
    id: 'file.save',
    label: 'Save',
    icon: 'save',
    // After Open (105) and before Make a copy (110), as Save sits in Illustrator's File menu.
    menu: { path: 'file', order: 108 },
    ...gate((ctx) => (!ctx.host.saveRequest?.() ? 'Drawings save as you work.' : !writable(ctx) ? READ_ONLY_REASON : null)),
    keyWhen: (ctx) => !!ctx.host.saveRequest?.(),
    run: (ctx) => {
      const save = ctx.host.saveRequest?.()
      if (save && writable(ctx)) save()
    }
  },
  documentCommand({
    id: 'file.copy',
    label: 'Make a copy',
    icon: 'file_copy',
    menu: { path: 'file', order: 110 },
    run: (ctx, ops) => ops.makeCopy(storedBody(ctx))
  }),
  ...DRAW_SIZES.map(
    (s, i): Command =>
      documentCommand({
        id: `file.newPreset.${s.id}`,
        label: `${s.label} — ${s.w}×${s.h}`,
        menu: { path: 'file/New from preset', order: i },
        run: (_ctx, ops) => ops.newDocument({ title: s.label, body: blankDrawBody(s) })
      })
  ),
  // Off when read-only: the file would leave out what a newer app added.
  // With several artboards, the export asks what it covers (dialogs/exportArtboards.dialog.tsx).
  { id: 'file.exportPng', label: 'Download PNG…', menuLabel: () => 'PNG image (.png)…', icon: 'image', menu: { path: 'file/Download', order: 0 }, ...writableGate, run: (ctx, args) => exportFormat(ctx, 'png', args) },
  { id: 'file.exportSvg', label: 'Download SVG…', menuLabel: () => 'SVG vector (.svg)…', icon: 'polyline', menu: { path: 'file/Download', order: 1 }, ...writableGate, run: (ctx, args) => exportFormat(ctx, 'svg', args) },
  { id: 'file.exportPdf', label: 'Download PDF…', menuLabel: () => 'PDF document (.pdf)…', icon: 'picture_as_pdf', menu: { path: 'file/Download', order: 2 }, ...writableGate, run: (ctx, args) => exportFormat(ctx, 'pdf', args) },
  documentCommand({
    id: 'file.rename',
    label: 'Rename',
    icon: 'edit',
    menu: { path: 'file', order: 400 },
    // By id (DocumentOps.rename: renameById). The store's rename(title) has no
    // id and renames its `active` document, which is never used here.
    run: (_ctx, ops) => ops.rename()
  }),
  documentCommand({
    id: 'file.history',
    label: 'Version history',
    icon: 'history',
    menu: { path: 'file', order: 410 },
    run: (_ctx, ops) => ops.openHistory()
  }),
  documentCommand({
    id: 'file.trash',
    label: 'Move to Trash',
    icon: 'delete',
    // Last in File, behind its own separator (SPEC §9.2).
    menu: { path: 'file', order: 900 },
    // Confirms, naming the bound drawing; trashes it by id (with Undo); then
    // the host decides what is left on screen (DocumentOps.onTrashed).
    run: (_ctx, ops) => ops.moveToTrash()
  })
]
