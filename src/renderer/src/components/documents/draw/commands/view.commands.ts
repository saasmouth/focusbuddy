// View menu and the zoom buttons.

import { clampZoom } from '../viewport'
import type { Command, MenuSpec } from '../editor/types'

export const menus: MenuSpec[] = [{ path: 'view', label: 'View', order: 60 }]

export const commands: Command[] = [
  { id: 'view.fit', label: 'Fit Artboard in Window', icon: 'fit_screen', menu: { path: 'view', order: 100 }, run: (ctx) => ctx.viewport.fit() },
  { id: 'view.actualSize', label: 'Zoom to 100%', icon: 'zoom_in', menu: { path: 'view', order: 110 }, run: (ctx) => ctx.set({ zoom: 1 }) },
  { id: 'view.zoomIn', label: 'Zoom in', icon: 'zoom_in', run: (ctx) => ctx.set((s) => ({ zoom: Math.min(16, s.zoom * 1.25) })) },
  { id: 'view.zoomOut', label: 'Zoom out', icon: 'zoom_out', run: (ctx) => ctx.set((s) => ({ zoom: Math.max(0.05, s.zoom / 1.25) })) },
  { id: 'view.zoomTo', label: 'Zoom to', run: (ctx, z) => ctx.set({ zoom: clampZoom(z as number) }) },
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
