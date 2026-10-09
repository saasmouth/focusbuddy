import { createContext, useContext } from 'react'
import type { PinZone, Widget } from '@shared/types'

// Pin-zone layout — compute the screen-space rectangle for each zone-pinned
// widget so multiple pins to the same zone dock side-by-side without overlap.
// Top-/bottom-left zones flow rightward from their corner; top-/bottom-right
// zones flow leftward. The pinned-layer's bounds are passed in so widgets
// always anchor to the visible main-pane corners (not the OS window).

export interface ZoneRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Chrome insets — distance in pixels each corner / edge needs to reserve
 * for non-widget UI (AI rail on the right, zoom controls + floating
 * toolbar on the left, etc.) so zone-pinned widgets never sit underneath
 * the persistent chrome.
 *
 * Each value is the cumulative inset for that side. A "right: 296" inset
 * pushes anything pinned to TR or BR leftward. Nothing sets one today —
 * the AI rail it existed for is gone — but the mechanism stays for a future
 * dock or control strip
 * by 296px relative to the container's right edge.
 */
export interface ChromeInsets {
  top: number
  right: number
  bottom: number
  left: number
}

export const ZERO_INSETS: ChromeInsets = { top: 0, right: 0, bottom: 0, left: 0 }

const PADDING = 16
const GAP = 8

/**
 * For each zone-pinned widget, compute its position + size inside the
 * pinned-layer container. Returns a Map keyed by widget.id.
 *
 * Stacking order within a zone is deterministic by widget creation time —
 * earliest pinned widget sits closest to the corner.
 *
 * `insets` reserves space for persistent chrome so widgets don't
 * disappear behind the AI rail, the zoom controls, the floating
 * toolbar, etc. When the rail collapses, the calling component should
 * re-render with a smaller right inset and pinned widgets glide back
 * toward the corner.
 */
export function computeZonePinPositions(
  widgets: Widget[],
  container: { width: number; height: number },
  insets: ChromeInsets = ZERO_INSETS
): Map<string, ZoneRect> {
  const out = new Map<string, ZoneRect>()
  const byZone: Record<PinZone, Widget[]> = {
    tl: [],
    tr: [],
    bl: [],
    br: []
  }
  for (const w of widgets) {
    if (!w.pinned || w.pinnedZone === null || w.parentSectionId !== null) continue
    byZone[w.pinnedZone].push(w)
  }
  for (const zone of Object.keys(byZone) as PinZone[]) {
    byZone[zone].sort((a, b) => a.createdAt - b.createdAt)
  }

  // Per-edge available coordinate after subtracting chrome.
  const leftEdge = PADDING + insets.left
  const rightEdge = container.width - PADDING - insets.right
  const topEdge = PADDING + insets.top
  const bottomEdge = container.height - PADDING - insets.bottom

  for (const zone of Object.keys(byZone) as PinZone[]) {
    const list = byZone[zone]
    let offset = 0
    for (const w of list) {
      const width = w.width
      const height = w.height
      let x: number
      let y: number
      switch (zone) {
        case 'tl':
          x = leftEdge + offset
          y = topEdge
          break
        case 'tr':
          x = rightEdge - width - offset
          y = topEdge
          break
        case 'bl':
          x = leftEdge + offset
          y = bottomEdge - height
          break
        case 'br':
        default:
          x = rightEdge - width - offset
          y = bottomEdge - height
          break
      }
      out.set(w.id, { x, y, width, height })
      offset += width + GAP
    }
  }
  return out
}

export const PIN_ZONE_LABELS: Record<PinZone, string> = {
  tl: 'Top left',
  tr: 'Top right',
  bl: 'Bottom left',
  br: 'Bottom right'
}

export const PIN_ZONE_ICONS: Record<PinZone, string> = {
  tl: 'north_west',
  tr: 'north_east',
  bl: 'south_west',
  br: 'south_east'
}

// Context provided by Canvas's pinned-layer so WidgetFrame can look up the
// computed zone position for its widget without prop-drilling through every
// widget kind (sticky, note, webview, etc.).
export const PinLayoutContext = createContext<Map<string, ZoneRect> | null>(null)

export function useZonePosition(widgetId: string): ZoneRect | undefined {
  const ctx = useContext(PinLayoutContext)
  return ctx?.get(widgetId)
}
