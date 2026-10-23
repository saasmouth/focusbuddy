import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

// The bottom-right corner, as a STACK rather than a pile.
//
// Five things dock there besides the desk's own controls: an incoming call, an
// active call, a meeting invite, the local-AI notice, the completion toast and
// the feature-spotlight card. Each was written as `fixed bottom-5 right-5`, so
// they landed on each other and on the controls underneath — and none of them
// is click-transparent, so whatever lost was simply dead: no panel, no
// feedback, nothing on screen to say why. One of them was fixed by hand
// (the spotlight card); doing that five times would leave the sixth to be
// written the old way next week.
//
// So the corner is a stack with one rule: nothing covers a control, and
// nothing covers anything else.
//
//   slot 0 sits just above the desk's fixed chrome, and each item above the
//   last. PRIORITY DECIDES THE ORDER, lowest first, and priority 0 — a live
//   call — therefore takes the most stable position and can never be pushed
//   off the top by something that appeared later.
//
// WHAT HAPPENS WHEN THEY DO NOT ALL FIT: the item is not rendered, and it
// comes back when the space does. Queued, not collapsed. A collapsed card is
// still a thing in the corner to mis-press, and these are not peers competing
// for attention — a call matters more than a tour offer, and the tour offer is
// re-offered on the next launch anyway. An item that does not fit is skipped
// rather than ending the stack, so a short notice is not blocked by a tall
// card above it; it simply takes the next free slot, never a slot below a
// higher-priority item.

/** The desk chrome that lives in the bottom-right corner. */
export const CORNER_CHROME_SELECTOR =
  '[data-floating-menu], [data-testid="assistant-pill"], [data-minimap-fab], [data-automations-fab]'

/**
 * How near an edge a control has to be to count as docked to it.
 *
 * Enumerated from the running app rather than guessed: the right edge holds
 * the floating toolbar (40x56, mid-height), the automations button, the
 * minimap and the Plexii pill; the bottom-left holds the zoom pill; and the
 * sidebar's resize strip is 10x935, which is why the arithmetic below cannot
 * simply take the tallest thing it finds.
 */
const EDGE_PX = 90
/** Below this much of the window's height, a control is bottom-docked. */
const BOTTOM_ZONE_PX = 160

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * One chrome root's full visual footprint: its own box UNIONED with its
 * descendants'.
 *
 * A BORDER BOX IS NOT A FOOTPRINT. The minimap's desk-jump list is
 * `absolute bottom-full` INSIDE the minimap container — deliberately out of
 * flow, so it cannot disturb the popLayout measurement that once left the map
 * stranded mid-screen — and an out-of-flow child contributes nothing to its
 * parent's border box. So the container measured 160x100 while the live thing
 * above it, 216x57 of clickable desk names, was invisible to the arithmetic
 * and ended up under the lifted card: the same dead click, one level up.
 * Found by probing elementsFromPoint across the card, not by reading the DOM
 * and hoping.
 *
 * Unioning descendants catches it, and catches the next one without anybody
 * having to remember this.
 */
export function footprint(el: Element): Box {
  const r = el.getBoundingClientRect()
  let box: Box = { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
  for (const child of el.querySelectorAll('*')) {
    const c = child.getBoundingClientRect()
    // Empty rects are display:none or not laid out; unioning them would drag
    // the footprint to the origin.
    if (c.right <= c.left || c.bottom <= c.top) continue
    box = {
      left: Math.min(box.left, c.left),
      right: Math.max(box.right, c.right),
      top: Math.min(box.top, c.top),
      bottom: Math.max(box.bottom, c.bottom)
    }
  }
  return box
}

/** Lower is nearer the corner, placed first, and never displaced. */
export const CORNER_PRIORITY = {
  /** A live call. Top of the stack, by the owner's ruling. */
  call: 0,
  meetingInvite: 1,
  /** role="status", short-lived. */
  notice: 2,
  toast: 3,
  /** The largest and the least urgent, so the first to stand down. */
  featureSpotlight: 4
} as const

export interface StackItem {
  id: string
  priority: number
  /** Measured height in client px. */
  height: number
  /** Measured width in client px, for the column the stack occupies. */
  width?: number
}

export interface Placement {
  id: string
  /** Offset from the window's bottom edge, in client px. */
  bottom: number
  /** Offset from the window's right edge: clears any right-edge rail. */
  right: number
  /** False when there was no room: the item renders nothing and waits. */
  visible: boolean
}

/** Clear air between stacked items, and between the stack and the chrome. */
export const STACK_GAP = 12
/** Never let the stack run into the title bar. */
export const TOP_MARGIN = 56

/**
 * Is this obstacle docked to the BOTTOM, or is it a rail down the right edge?
 *
 * The two want different things, which is the whole reason this is split. A
 * short wide control in the corner is cleared by the stack sitting ABOVE it.
 * A tall narrow rail partway up the right edge cannot be: clearing the
 * floating toolbar vertically would start the stack 480px up the window. The
 * stack slides LEFT past that instead, and stays where people look for it.
 */
export function isBottomDocked(c: Box, windowHeight: number, zone = BOTTOM_ZONE_PX): boolean {
  return windowHeight - c.bottom <= zone
}

/**
 * How far in from the right the stack's column must start.
 *
 * Only right-edge obstacles that are NOT bottom-docked count: those are rails
 * the stack goes around rather than over.
 */
export function stackInsetRight(
  chrome: readonly Box[],
  windowWidth: number,
  windowHeight: number,
  floor: number,
  gap = STACK_GAP
): number {
  let inset = floor
  for (const c of chrome) {
    if (c.right <= c.left || c.bottom <= c.top) continue // hidden, not laid out
    if (windowWidth - c.right > EDGE_PX) continue // not on the right edge
    if (isBottomDocked(c, windowHeight)) continue // cleared vertically instead
    inset = Math.max(inset, windowWidth - c.left + gap)
  }
  return Math.ceil(inset)
}

/**
 * How high the stack must start to clear the chrome beneath it.
 *
 * One base for every item rather than one each: they are a stack, so they line
 * up, and `column` is the widest item's span so the base is a superset.
 *
 * THE HORIZONTAL TEST IS NOT OPTIONAL, which I learned by enumerating the
 * edges instead of assuming them: the sidebar's resize strip is 10px wide and
 * 935 tall, so a base that took the tallest thing it found regardless of where
 * it was would push the entire stack off the top of the window.
 */
export function stackBase(
  chrome: readonly Box[],
  column: Pick<Box, 'left' | 'right'>,
  windowHeight: number,
  floor: number,
  gap = STACK_GAP
): number {
  let base = floor
  for (const c of chrome) {
    if (c.right <= c.left || c.bottom <= c.top) continue // hidden, not laid out
    if (c.left >= column.right || c.right <= column.left) continue // beside the stack
    base = Math.max(base, windowHeight - c.top + gap)
  }
  return Math.ceil(base)
}

/**
 * Where each item sits, and which ones had to wait.
 *
 * `available` is the height the stack may use — the window less the top
 * margin. Items are placed in priority order; ties keep a stable order by id,
 * so the stack does not reshuffle itself when two things appear together.
 */
export function placeCornerStack(
  items: readonly StackItem[],
  base: number,
  available: number,
  gap = STACK_GAP,
  right = 0
): Placement[] {
  const ordered = [...items].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  const out: Placement[] = []
  let cursor = base
  for (const item of ordered) {
    // A zero-height item has not been measured yet; give it a slot rather than
    // hiding it, or it would never render and so never get a height.
    const h = Math.max(0, item.height)
    if (cursor + h > available) {
      out.push({ id: item.id, bottom: cursor, right, visible: false })
      continue
    }
    out.push({ id: item.id, bottom: cursor, right, visible: true })
    cursor += h + gap
  }
  return out
}

// ── The shared registry ─────────────────────────────────────────────────────
// Module-level because the items are separate components that never meet in
// the tree: a call overlay and a tour card have no common parent to hold this.

interface Entry extends StackItem {
  enabled: boolean
}

const entries = new Map<string, Entry>()
let placements: Placement[] = []
const listeners = new Set<() => void>()

function recompute(): void {
  const chrome = [...document.querySelectorAll(CORNER_CHROME_SELECTOR)].map(footprint)
  const live = [...entries.values()].filter((e) => e.enabled)
  const W = window.innerWidth
  const H = window.innerHeight
  // Slide left past any right-edge rail first: the column the stack occupies
  // depends on that, and the base depends on the column.
  const right = stackInsetRight(chrome, W, H, BASE_RIGHT_PX)
  const widest = live.reduce((m, e) => Math.max(m, e.width ?? 0), 0)
  const column = { left: W - right - widest, right: W - right }
  const base = stackBase(chrome, column, H, 0)
  const next = placeCornerStack(live, base, H - TOP_MARGIN, STACK_GAP, right)
  // Same answer, same array: re-rendering every item on every measure would
  // make the ResizeObservers fire again and never settle.
  const same =
    next.length === placements.length &&
    next.every((p, i) => {
      const q = placements[i]!
      return p.id === q.id && p.bottom === q.bottom && p.right === q.right && p.visible === q.visible
    })
  if (same) return
  placements = next
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The placement for one id, or null while it is not registered. */
function placementOf(id: string): Placement | null {
  return placements.find((p) => p.id === id) ?? null
}

const QUEUED: Placement = { id: '', bottom: 0, right: 0, visible: false }

/** The stack's resting inset from the right edge — the old `right-5`. */
export const BASE_RIGHT_PX = 20

/**
 * Register a bottom-right overlay in the corner stack.
 *
 * Returns where to sit and whether to render at all. Call it unconditionally —
 * above any early return — and pass `enabled` for whether the overlay wants a
 * slot; a hook behind a condition changes the hook count and crashes the tree.
 */
export function useCornerSlot(
  id: string,
  priority: number,
  enabled: boolean,
  ref: React.RefObject<HTMLElement | null>
): { bottom: number; right: number; visible: boolean } {
  const placement = useSyncExternalStore(
    subscribe,
    useCallback(() => placementOf(id), [id]),
    useCallback(() => null, [])
  )
  const heightRef = useRef(0)
  const widthRef = useRef(0)

  useEffect(() => {
    if (!enabled) {
      if (entries.delete(id)) recompute()
      return
    }
    entries.set(id, { id, priority, height: heightRef.current, width: widthRef.current, enabled: true })
    recompute()
    return () => {
      entries.delete(id)
      recompute()
    }
  }, [id, priority, enabled])

  useEffect(() => {
    const el = ref.current
    if (!enabled || !el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      const h = Math.ceil(r.height)
      const w = Math.ceil(r.width)
      if (h === heightRef.current && w === widthRef.current) return
      heightRef.current = h
      widthRef.current = w
      const e = entries.get(id)
      if (e) {
        e.height = h
        e.width = w
        recompute()
      }
    }
    const raf = requestAnimationFrame(measure)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // The chrome below moves and grows: the tray restyles the root, the
    // minimap's panel and its hover-gated jump list come and go.
    const chromeRo = new ResizeObserver(() => recompute())
    for (const c of document.querySelectorAll(CORNER_CHROME_SELECTOR)) chromeRo.observe(c)
    const mo = new MutationObserver(() => recompute())
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    const tree = new MutationObserver(() => recompute())
    tree.observe(document.body, { childList: true, subtree: true })
    const onResize = (): void => {
      measure()
      recompute()
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      chromeRo.disconnect()
      mo.disconnect()
      tree.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [id, enabled, ref])

  const p = placement ?? (enabled ? null : QUEUED)
  // Not placed yet (first render, before the effect runs): render it at the
  // base so it is measurable. It is corrected on the next frame.
  return { bottom: p?.bottom ?? 0, right: p?.right ?? BASE_RIGHT_PX, visible: p ? p.visible : enabled }
}
