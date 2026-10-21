// Where should a NEW widget land when it is spawned by any path other than a
// deliberate drag-and-drop or a right-click-at-cursor add?
//
// The paths in scope are the "+" palette add button and every AI applier
// (create-widget, open-url, create-page, create-table, create-todo, create-
// field). Historically those dropped the widget at the viewport centre with
// jitter, or worse, at a fixed canvas (60, 60) for the AI paths, which put it
// high and far away so the user had to hunt for it and drag it into view.
//
// The rule here: snap the new widget to the immediate RIGHT of the widget the
// user last touched (the active widget), if there is clear space there. If the
// right is occupied, try the LEFT. If neither immediate side is free, slide to
// the nearest clear slot near the active widget. With no active widget (or when
// the active widget is so far off-screen that snapping beside it would repeat
// the very problem we are fixing), fall back to the centre of the current
// viewport and slide to the nearest clear slot so we never stack on top of
// whatever is already there.
//
// The geometry is pure and lives in computeSpawnPosition so it can be unit
// tested. spawnPositionFor is the convenience wrapper that reads the live store
// snapshot plus the on-screen canvas size and returns a concrete {x, y}.

import type { Widget } from '@shared/types'
import { findNonOverlapPosition } from './sectionGeometry'
import { useWidgetStore } from '../stores/widgets'

// Matches createConnectedTool's ADJACENT_GAP so an AI-spawned neighbour and a
// right-click-connected neighbour sit at the same comfortable distance.
const ADJACENT_GAP = 40
// A looser gap for the viewport-centre fallback, where we are not trying to
// hug a specific source widget.
const CENTRE_GAP = 24

export interface SpawnGeometry {
  newWidth: number
  newHeight: number
  activeWidgetId: string | null
  widgets: Widget[]
  panX: number
  panY: number
  zoom: number
  viewportWidth: number
  viewportHeight: number
}

// Widgets that occupy real, comparable canvas coordinates. Pinned widgets are
// screen-anchored so their x/y are meaningless here; section children store
// section-local coordinates; minimaps and archived widgets should not block a
// spawn slot.
function placeableObstacles(widgets: Widget[]): Widget[] {
  return widgets.filter(
    (w) => !w.archived && !w.pinned && w.parentSectionId === null && w.kind !== 'minimap'
  )
}

export function computeSpawnPosition(g: SpawnGeometry): { x: number; y: number } {
  const { newWidth, newHeight, activeWidgetId, widgets, panX, panY, zoom } = g
  const obstacles = placeableObstacles(widgets)

  // The viewport rectangle expressed in canvas coordinates.
  const viewLeft = -panX / zoom
  const viewTop = -panY / zoom
  const viewW = g.viewportWidth / zoom
  const viewH = g.viewportHeight / zoom

  const active =
    activeWidgetId !== null ? obstacles.find((w) => w.id === activeWidgetId) ?? null : null

  if (active) {
    // Snapping beside a widget that has been panned far out of view would just
    // recreate the "where did it go" problem in a different direction, so only
    // snap beside the active widget when it is at least partly on screen.
    const activeOnScreen =
      active.x + active.width >= viewLeft &&
      active.x <= viewLeft + viewW &&
      active.y + active.height >= viewTop &&
      active.y <= viewTop + viewH

    if (activeOnScreen) {
      // Right of the active widget, top-aligned with it.
      const right = {
        x: active.x + active.width + ADJACENT_GAP,
        y: active.y,
        width: newWidth,
        height: newHeight
      }
      const posR = findNonOverlapPosition(right, obstacles, ADJACENT_GAP)
      // findNonOverlapPosition returns the desired rect unchanged when it is
      // already clear, so an exact match means the right slot was free.
      if (posR.x === right.x && posR.y === right.y) {
        return { x: Math.round(posR.x), y: Math.round(posR.y) }
      }

      // Right was taken — try the left, top-aligned with the active widget.
      const left = {
        x: active.x - newWidth - ADJACENT_GAP,
        y: active.y,
        width: newWidth,
        height: newHeight
      }
      const posL = findNonOverlapPosition(left, obstacles, ADJACENT_GAP)
      if (posL.x === left.x && posL.y === left.y) {
        return { x: Math.round(posL.x), y: Math.round(posL.y) }
      }

      // Neither immediate side is clear. Take the nearest free slot to the
      // right anchor unless the solver had to push it absurdly far, in which
      // case fall through to the viewport-centre placement below.
      const reach = Math.max(2000, viewW * 1.5, viewH * 1.5)
      if (Math.abs(posR.x - active.x) <= reach && Math.abs(posR.y - active.y) <= reach) {
        return { x: Math.round(posR.x), y: Math.round(posR.y) }
      }
    }
  }

  // No usable active widget. Place at the centre of what the user is currently
  // looking at, then slide to the nearest clear slot.
  const centre = {
    x: viewLeft + viewW / 2 - newWidth / 2,
    y: viewTop + viewH / 2 - newHeight / 2,
    width: newWidth,
    height: newHeight
  }
  const pos = findNonOverlapPosition(centre, obstacles, CENTRE_GAP)
  return { x: Math.round(pos.x), y: Math.round(pos.y) }
}

// Read the visible canvas surface so the viewport-centre fallback lands inside
// what the user is actually looking at. Falls back to the window when the
// surface is not mounted (e.g. a unit-test environment with no DOM).
function readCanvasViewport(): { width: number; height: number } {
  if (typeof document !== 'undefined') {
    const el = document.querySelector<HTMLElement>('[data-canvas-surface="true"]')
    if (el) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) return { width: r.width, height: r.height }
    }
  }
  if (typeof window !== 'undefined') return { width: window.innerWidth, height: window.innerHeight }
  return { width: 1440, height: 900 }
}

// Convenience wrapper for call sites that just want "where should this widget
// of size W x H go right now". Reads the live widget-store snapshot (active
// widget, widgets, pan, zoom) and the on-screen canvas size.
export function spawnPositionFor(
  newWidth: number,
  newHeight: number
): { x: number; y: number } {
  const s = useWidgetStore.getState()
  const vp = readCanvasViewport()
  return computeSpawnPosition({
    newWidth,
    newHeight,
    activeWidgetId: s.activeWidgetId,
    widgets: s.widgets,
    panX: s.panX,
    panY: s.panY,
    zoom: s.zoom,
    viewportWidth: vp.width,
    viewportHeight: vp.height
  })
}
