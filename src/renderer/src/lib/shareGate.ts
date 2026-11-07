// "Download this desk on Plexii" -- the one door out of a shared desk.
//
// Owner, 2026-11-07: a public link opens shared rooms and desks with the whole
// app around them (menus, the side menu, the assistant), but a visitor may only
// look around and drag apps, widgets, files and tools onto the desk. Anything
// else -- creating a desk or a room, AI, editing, settings, and (owner,
// 2026-11-07, "yes") moving or resizing what is on the desk -- says "Download
// this desk on Plexii" and starts the download.
//
// Most of that is enforced where every call passes (src/web/api/readOnly.ts,
// at the bridge). This is for the doors that open no call, or open one only
// after the visitor has watched something happen: a settings panel, a
// body-double dialog, a sign-in prompt, and a widget being dragged or
// resized. The share page listens for the event (src/web/boot.tsx) and shows
// the gate; the desktop never sees it.
import { isShareRecipient } from './shareMode'

export const SHARE_GATE_EVENT = 'plexii:share-gate'

export interface ShareGateDetail {
  /** What the visitor tried, as a phrase: "Creating a desk", "AI". */
  what: string
  /** The call that was refused, when a call was (web/api/dbClient.ts); null for a gesture or a panel. */
  channel?: string | null
}

/**
 * In a share window: show the gate for `what` and return true (the caller
 * stops). Anywhere else: false, and the caller carries on as normal.
 */
export function shareGate(what: string): boolean {
  if (!isShareRecipient()) return false
  try {
    window.dispatchEvent(new CustomEvent<ShareGateDetail>(SHARE_GATE_EVENT, { detail: { what } }))
  } catch {
    /* no window (a test): the caller still stops */
  }
  return true
}

// ── Arranging (owner, 2026-11-07: moving and resizing open the gate too) ────
//
// Moving or resizing a widget is refused where the gesture starts, not at the
// save: by the time a save is refused the widget has already moved on screen,
// and a desk that shows one thing and keeps another is worse than a door.
// The saves themselves stay allowed at the bridge, because the app moves
// things on its own (a drop pushes its neighbours aside, a Workcentre settles
// its tiles), often a moment after a click, and that must never be the gate.

export const MOVING = 'Moving things on this desk'
export const RESIZING = 'Resizing things on this desk'
export const ARRANGING = 'Arranging this desk'

/** How far the pointer travels before a press is a drag, not a click. */
export const DRAG_SLOP_PX = 4

/** Is this window a visitor's? Then the caller must not start its own drag or resize. */
export function arrangingIsGated(): boolean {
  return isShareRecipient()
}

/**
 * A press on something that drags (a widget's header, a tile, an edge).
 *
 * In a share window: returns true, so the caller starts nothing of its own,
 * and opens the gate only if the pointer then actually travels -- a press that
 * is a click (selecting a widget, opening its menu) stays a click. Anywhere
 * else: false, and the caller drags as normal.
 */
export function shareGateOnDrag(
  e: { clientX: number; clientY: number; button?: number },
  what: string,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window
): boolean {
  if (!isShareRecipient()) return false
  // A right or middle press is a menu or a scroll, never a drag.
  if (e.button !== undefined && e.button !== 0) return true
  const x0 = e.clientX
  const y0 = e.clientY
  const stop = (): void => {
    target.removeEventListener('pointermove', onMove as EventListener, true)
    target.removeEventListener('pointerup', stop, true)
    target.removeEventListener('pointercancel', stop, true)
  }
  const onMove = (m: PointerEvent): void => {
    if (Math.hypot(m.clientX - x0, m.clientY - y0) < DRAG_SLOP_PX) return
    stop()
    shareGate(what)
  }
  target.addEventListener('pointermove', onMove as EventListener, true)
  target.addEventListener('pointerup', stop, true)
  target.addEventListener('pointercancel', stop, true)
  return true
}

/** Right-click menu items that only arrange the desk (lib/contextMenu/universal.ts ids). */
const ARRANGING_MENU_IDS = new Set(['core/front', 'core/eject', 'core/pin'])

/**
 * The gate phrase for a right-click menu item that arranges the desk, or null.
 * Every other item either opens no call or is decided at the bridge.
 */
export function arrangingMenuItem(id: string | undefined): string | null {
  if (!id) return null
  const root = id.split('/').slice(0, 2).join('/')
  if (!ARRANGING_MENU_IDS.has(root)) return null
  return root === 'core/pin' ? 'Pinning things on this desk' : ARRANGING
}
