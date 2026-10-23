// File menu: new, copy, presets, export, rename, history, trash.

import { DRAW_SIZES, blankDrawBody } from '@shared/draw'
import { openDocHistory } from '../../DocHistoryPanel'
import { confirmDialog, promptText } from '../../../plexi/PromptDialog'
import { useDocumentsStore } from '../../../../stores/documents'
import { useViewStore } from '../../../../stores/view'
import type { Command, EditorCtx, ExportOptions, MenuSpec } from '../editor/types'

const writable = (ctx: EditorCtx): boolean => !ctx.get().readOnly

function title(): string {
  return useDocumentsStore.getState().active?.title ?? 'Untitled artwork'
}

/** Export: straight away with one artboard; with several, ask what to export unless the caller said. */
function exportFormat(ctx: EditorCtx, format: 'png' | 'svg' | 'pdf', args: unknown): Promise<void> | void {
  const opts = args && typeof args === 'object' && 'scope' in (args as object) ? (args as ExportOptions) : undefined
  if (opts || ctx.doc().artboards.length < 2) return ctx.host.exportAs(format, opts)
  ctx.set({ dialog: { id: 'export-artboards', props: { format } } })
}

export const menus: MenuSpec[] = [
  { path: 'file', label: 'File', order: 10 },
  { path: 'file/New from preset', label: 'New from preset', icon: 'aspect_ratio', order: 200 }
]

export const commands: Command[] = [
  {
    id: 'file.new',
    label: 'New artwork',
    icon: 'note_add',
    menu: { path: 'file', order: 100 },
    run: async () => {
      const doc = await useDocumentsStore.getState().createBlank('draw')
      useViewStore.getState().goDocument(doc.id)
    }
  },
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
    enabled: (ctx) => !!ctx.host.saveRequest?.() && writable(ctx),
    disabledReason: (ctx) =>
      !ctx.host.saveRequest?.() ? 'drawings save as you work' : !writable(ctx) ? 'this drawing is read-only' : null,
    keyWhen: (ctx) => !!ctx.host.saveRequest?.(),
    run: (ctx) => {
      const save = ctx.host.saveRequest?.()
      if (save && writable(ctx)) save()
    }
  },
  {
    id: 'file.copy',
    label: 'Make a copy',
    icon: 'file_copy',
    menu: { path: 'file', order: 110 },
    run: async () => {
      const active = useDocumentsStore.getState().active
      const copy = await window.api.documents.create({ docType: 'draw', title: `Copy of ${title()}`, body: active?.body })
      useViewStore.getState().goDocument(copy.id)
    }
  },
  ...DRAW_SIZES.map(
    (s, i): Command => ({
      id: `file.newPreset.${s.id}`,
      label: `${s.label} — ${s.w}×${s.h}`,
      menu: { path: 'file/New from preset', order: i },
      run: async () => {
        const doc = await window.api.documents.create({ docType: 'draw', title: s.label, body: blankDrawBody(s) })
        useViewStore.getState().goDocument(doc.id)
      }
    })
  ),
  // Off when read-only: the file would leave out what a newer app added.
  // With several artboards, the export asks what it covers (dialogs/exportArtboards.dialog.tsx).
  { id: 'file.exportPng', label: 'Export PNG…', icon: 'image', menu: { path: 'file', order: 300 }, enabled: writable, run: (ctx, args) => exportFormat(ctx, 'png', args) },
  { id: 'file.exportSvg', label: 'Export SVG…', icon: 'polyline', menu: { path: 'file', order: 310 }, enabled: writable, run: (ctx, args) => exportFormat(ctx, 'svg', args) },
  { id: 'file.exportPdf', label: 'Export PDF…', icon: 'picture_as_pdf', menu: { path: 'file', order: 320 }, enabled: writable, run: (ctx, args) => exportFormat(ctx, 'pdf', args) },
  {
    id: 'file.rename',
    label: 'Rename',
    icon: 'edit',
    menu: { path: 'file', order: 400 },
    run: async () => {
      const next = await promptText({ title: 'Rename artwork', initial: title(), confirmLabel: 'Rename' })
      if (next != null && next.trim()) void useDocumentsStore.getState().rename(next.trim())
    }
  },
  {
    id: 'file.history',
    label: 'Version history',
    icon: 'history',
    menu: { path: 'file', order: 410 },
    run: () => {
      const active = useDocumentsStore.getState().active
      if (active) openDocHistory(active.id)
    }
  },
  {
    id: 'file.trash',
    label: 'Move to trash',
    icon: 'delete',
    menu: { path: 'file', order: 420 },
    run: async () => {
      const active = useDocumentsStore.getState().active
      if (!active) return
      const ok = await confirmDialog({
        title: `Move "${title()}" to trash?`,
        body: 'You can restore it from the Documents trash.',
        confirmLabel: 'Move to trash'
      })
      if (!ok) return
      await useDocumentsStore.getState().remove(active.id)
      useViewStore.getState().goDocuments()
    }
  }
]
