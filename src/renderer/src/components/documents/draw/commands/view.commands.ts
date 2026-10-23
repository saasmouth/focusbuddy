// View menu and the zoom buttons.

import type { Box } from '@shared/drawGeometry'
import { nodesWorldBounds } from '@shared/draw/ops'
import { clampZoom, MAX_ZOOM } from '../viewport'
import { setShellPrefs, shellPrefs } from '../editor/shellPrefs'
import { commandShortcutLabel } from './keys'
import type { Command, EditorCtx, MenuSpec } from '../editor/types'
import { gate, unless } from './gate'

/** Screen margin Zoom to Selection keeps around the selection on every side. */
export const ZOOM_TO_SELECTION_PAD = 40

/**
 * The document box Zoom to Selection fits: the selection's visible bounds
 * (members of transformed groups included), or null when nothing is selected.
 * A line has no width or height of its own, so a flat side takes the other
 * side's length (or 1) -- it is still framed, centred, rather than refused.
 */
export function selectionZoomBox(ctx: Pick<EditorCtx, 'get'>): Box | null {
  const s = ctx.get()
  if (!s.selection.length) return null
  const b = nodesWorldBounds(s.doc, s.selection)
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !(b.w >= 0) || !(b.h >= 0)) return null
  const side = Math.max(b.w, b.h, 1)
  const w = b.w > 0 ? b.w : side
  const h = b.h > 0 ? b.h : side
  return { x: b.x - (w - b.w) / 2, y: b.y - (h - b.h) / 2, w, h }
}

export const menus: MenuSpec[] = [{ path: 'view', label: 'View', order: 60 }]

export const commands: Command[] = [
  { id: 'view.fit', label: 'Fit Artboard in Window', icon: 'fit_screen', menu: { path: 'view', order: 100 }, run: (ctx) => ctx.viewport.fit() },
  {
    // Illustrator has no default key for this (Adobe's table, illustratorKeys.ts),
    // so none is bound: Edit › Keyboard shortcuts… can give it one.
    id: 'view.zoomToSelection',
    label: 'Zoom to Selection',
    icon: 'center_focus_weak',
    menu: { path: 'view', order: 102 },
    ...gate(unless((ctx) => selectionZoomBox(ctx) !== null, 'Select something to zoom to.')),
    explainsWhenDisabled: true,
    run: (ctx) => {
      const box = selectionZoomBox(ctx)
      if (!box) return ctx.status('Select something to zoom to.')
      // Fits in the part of the window a pinned panel leaves, like ⌘0.
      if (ctx.viewport.fitBox) ctx.viewport.fitBox(box, { pad: ZOOM_TO_SELECTION_PAD, maxZoom: MAX_ZOOM })
      else ctx.status('Zoom to Selection needs the canvas window.')
    }
  },
  { id: 'view.actualSize', label: 'Zoom to 100%', icon: 'zoom_in', menu: { path: 'view', order: 110 }, run: (ctx) => ctx.set({ zoom: 1 }) },
  { id: 'view.zoomIn', label: 'Zoom in', icon: 'zoom_in', run: (ctx) => ctx.set((s) => ({ zoom: Math.min(16, s.zoom * 1.25) })) },
  { id: 'view.zoomOut', label: 'Zoom out', icon: 'zoom_out', run: (ctx) => ctx.set((s) => ({ zoom: Math.max(0.05, s.zoom / 1.25) })) },
  { id: 'view.zoomTo', label: 'Zoom to', run: (ctx, z) => ctx.set({ zoom: clampZoom(z as number) }) },
  {
    // Illustrator's View › Hide Artboards / Show Artboards (⇧⌘H): the
    // artboards' edges and fill are not drawn, so the art shows on the
    // pasteboard. A view preference (editor/shellPrefs.ts): it never edits
    // the drawing, and export is unaffected.
    id: 'view.artboards',
    label: 'Show/Hide Artboards',
    menuLabel: () => (shellPrefs.getState().hideArtboards ? 'Show Artboards' : 'Hide Artboards'),
    icon: 'select_all',
    menu: { path: 'view', order: 190 },
    run: (ctx) => {
      const hide = !shellPrefs.getState().hideArtboards
      setShellPrefs({ hideArtboards: hide })
      const key = commandShortcutLabel('view.artboards')
      ctx.status(hide ? `Artboards hidden — View › Show Artboards${key ? ` (${key})` : ''} brings them back. Export is unchanged.` : null)
    }
  },
  {
    id: 'view.grid',
    label: 'Grid',
    icon: 'grid_4x4',
    menu: { path: 'view', order: 200 },
    checked: (ctx) => ctx.get().showGrid,
    run: (ctx) => ctx.set((s) => ({ showGrid: !s.showGrid }))
  },
  {
    id: 'view.snap',
    label: 'Snap to edges',
    icon: 'straighten',
    menu: { path: 'view', order: 210 },
    checked: (ctx) => ctx.get().snapOn,
    run: (ctx) => ctx.set((s) => ({ snapOn: !s.snapOn }))
  }
]
