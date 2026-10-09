// The Plexii pill's footprint, and where the desk's corner chrome goes around it.
//
// The pill is the primary action in the bottom-right corner (2026-10-09: 52px,
// purple, findable). The desk keeps two of its own controls in that corner — the
// minimap and the automations button — and for a while all three were stacked on
// top of each other: the pill sat on the minimap's toggle, so a click meant for
// the minimap opened Plexii, and the automations button sat on the open minimap
// panel's close button.
//
// These numbers are in the same authored px as the pill's classes in
// AssistantOverlay (right-[14px], h-[52px] w-[52px]). Tailwind needs those class
// names written out literally, so this is the second copy, and
// tests/unit/cornerChrome.test.tsx holds the two together.
//
// Vertically the pill always sits 14px above the canvas's bottom edge: with no
// open-item tray it is 42px above the window bottom and the footer is 28px, and
// with the tray the tray publishes an offset 14px above its own top.

export const PILL_RIGHT_PX = 14
export const PILL_SIZE_PX = 52
export const PILL_CANVAS_INSET_PX = 14
export const CORNER_GAP_PX = 10

/** Where the minimap's right edge goes while the pill shows: beside it. */
export const PILL_CLEAR_RIGHT_PX = PILL_RIGHT_PX + PILL_SIZE_PX + CORNER_GAP_PX // 76

/** Where the automations button's bottom edge goes while the pill shows: above it. */
export const PILL_STACK_BOTTOM_PX = PILL_CANVAS_INSET_PX + PILL_SIZE_PX + CORNER_GAP_PX // 76

/** The CSS variables the pill publishes on <html> while it renders. */
export function pillCornerVars(): Record<'--fb-pill-clear-right' | '--fb-corner-stack-bottom', string> {
  return {
    '--fb-pill-clear-right': `${PILL_CLEAR_RIGHT_PX}px`,
    '--fb-corner-stack-bottom': `${PILL_STACK_BOTTOM_PX}px`
  }
}
