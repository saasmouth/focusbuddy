import { useEffect, useRef, useState } from 'react'
import { useWidgetStore } from '../stores/widgets'
import { isOverFloatingChrome } from './floatingChrome'
import { EDGE_PAN_MARGIN, createEdgePanArming, isInEdgeZone, type PointerPlace, type PointerSample } from './edgePanArming'

// Edge-pan / "infinite map" camera control for the canvas.
//
// When the cursor enters a configurable margin (default 80px) near any
// edge of the canvas viewport, the camera pans in that direction. The
// closer to the edge, the faster the pan — speed eases quadratically
// from 0 at the inner boundary of the zone to MAX_SPEED at the very
// edge. Diagonals fall out naturally: top-right corner = both top AND
// right edges active → northeast pan.
//
// Driven by requestAnimationFrame so motion is smooth at the monitor's
// refresh rate. The hook returns the live per-edge intensity map so the
// caller can render matching glowing edge indicators.
//
// DRAG MODE — the hook autodetects when the user is dragging something
// onto/around the canvas, in which case the caller's `disabled` flag
// is OVERRIDDEN so edge-pan still works. This is crucial UX: when the
// user is dragging a widget toward the edge of the visible canvas,
// they want the camera to scroll. There are two flavours we detect:
//   1. Rnd drag (existing widget being repositioned) — WidgetFrame adds
//      a `fb-canvas-dragging` class to <html> on dragstart and removes
//      it on dragend, exactly so a global observer like this hook can
//      see it.
//   2. HTML5 drag (palette item or external file being dropped onto the
//      canvas) — we listen to document-level `dragstart`/`dragend` and
//      flip a ref.
// During drag mode we ALSO read cursor position from `dragover` events
// on the canvas (because mousemove doesn't fire during HTML5 drag —
// the OS is showing the drag image instead).
//
// ARMING — a pan starts only when the pointer MOVED into the edge zone
// (lib/edgePanArming). A cursor that ends up "in the zone" because the
// surface, the zone or the content shifted under it while it rested — a
// scroll, a layout shift, the dock widening --fb-dock-inset — never starts
// one; Chromium's fake mousemove and repeating dragover carry the old screen
// point, and those re-read the position without arming. An HTML5 drag that
// started OFF the desk (the Files panel, the side menu) must also have reached
// the desk's interior first, since it can only arrive across an edge zone.
// Both are one rule, in lib/edgePanArming; this hook only reports events to it.
//
// Pauses regardless of drag mode when:
//   - the camera is mid-animation (animatingPan)
//   - keyboard focus is on a form input / contenteditable
//   - the cursor has left the canvas viewport

interface EdgeIntensity {
  // 0 (inactive) → 1 (mouse pressed up against the edge).
  top: number
  right: number
  bottom: number
  left: number
}

const ZERO_INTENSITY: EdgeIntensity = { top: 0, right: 0, bottom: 0, left: 0 }

interface Geometry {
  left: number
  top: number
  width: number
  height: number
  // --fb-dock-inset: the visible left edge sits this far into the element.
  inset: number
}

// A client point relative to the canvas's VISIBLE area (right of the dock),
// with that area's size and whether the point is on it.
function canvasPoint(
  client: { x: number; y: number },
  g: Geometry
): { x: number; y: number; width: number; height: number; inside: boolean } {
  const x = client.x - g.left - g.inset
  const y = client.y - g.top
  const width = g.width - g.inset
  const height = g.height
  return { x, y, width, height, inside: x >= 0 && y >= 0 && x <= width && y <= height }
}

interface Options {
  // Pixel width of the active edge zone (distance from the edge within
  // which the camera starts moving). Default 80px.
  margin?: number
  // Maximum pan speed in world units per second when the mouse is
  // pressed up against the edge. Default 1100 → at 60 fps that's ~18
  // pixels per frame, brisk but controllable.
  maxSpeedPerSecond?: number
  /**
   * The canvas container ELEMENT, not a ref to it. Mouse position is read
   * relative to its bounding box.
   *
   * It takes the node rather than a RefObject because a ref object's identity
   * never changes, so an effect listing it as a dependency runs exactly once —
   * binding mousemove to whichever node existed at mount. When React recreates
   * that div the ref is repointed and the listeners are left on the dead one,
   * and edge-pan silently stops with no error. Taking the element means the
   * effect re-runs the moment the node changes, which is the only thing that
   * makes the binding reliable. (The wheel listener in Canvas had the same
   * fault and the same cause.)
   */
  container: HTMLDivElement | null
  // Soft-disable: pauses edge-pan but is overridden during active widget
  // drag so the user can still scroll by moving a widget toward the edge.
  // Use for system conditions like animatingPan that shouldn't block drag.
  disabled: boolean
  // Hard-disable: stops edge-pan completely, even during drag. Use for
  // explicit user preferences (edgePanEnabled = false).
  hardDisabled?: boolean
}

export function useEdgePan({
  container,
  disabled,
  hardDisabled = false,
  margin = EDGE_PAN_MARGIN,
  maxSpeedPerSecond = 1100
}: Options): EdgeIntensity {
  const panBy = useWidgetStore((s) => s.panBy)
  const [intensity, setIntensity] = useState<EdgeIntensity>(ZERO_INTENSITY)
  // Refs so the rAF loop reads the latest values without re-binding.
  // The pointer's last CLIENT point (viewport coordinates), not a position
  // relative to the canvas: the canvas-relative position is derived from it
  // each frame against the current geometry. Storing the relative position
  // went stale the moment the geometry changed under a resting pointer — the
  // dock widening moved --fb-dock-inset and shrank the zone's width, so a
  // pointer resting 120 px from the right edge was computed to be 94 px PAST
  // it, and the desk flew off at over three times the maximum speed.
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const lastFrameRef = useRef<number>(0)
  const disabledRef = useRef(disabled)
  const hardDisabledRef = useRef(hardDisabled)
  // Sync during render (not in an effect) so the rAF loop never reads a
  // stale value — effects run after paint, but rAF can fire in the same
  // post-paint window before effects, leaving a gap of one or more frames.
  disabledRef.current = disabled
  hardDisabledRef.current = hardDisabled
  const marginRef = useRef(margin)
  const maxSpeedRef = useRef(maxSpeedPerSecond)
  // Cached geometry of the container (its rect and the dock inset) — read in
  // the rAF loop, so we memoise via observers instead of calling gbcr every
  // frame. Every pointer event refreshes it too (it reads gbcr anyway).
  const geomRef = useRef<Geometry>({ left: 0, top: 0, width: 0, height: 0, inset: 0 })

  useEffect(() => {
    marginRef.current = margin
    maxSpeedRef.current = maxSpeedPerSecond
  }, [margin, maxSpeedPerSecond])

  useEffect(() => {
    const el = container
    if (!el) return

    // Cache the container's size so the rAF loop doesn't call gbcr
    // every frame (which forces a synchronous layout).
    function refreshSize(): void {
      if (!el) return
      const rect = el.getBoundingClientRect()
      geomRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height, inset: dockInset() }
    }
    refreshSize()
    // The dock publishes --fb-dock-inset on <html>; the canvas element itself
    // does not resize when the dock collapses, so watch that attribute too.
    const mo = new MutationObserver(refreshSize)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    const ro = new ResizeObserver(refreshSize)
    ro.observe(el)

    // Drag-mode detection. Two sources:
    //   (a) Rnd drag — WidgetFrame toggles `fb-canvas-dragging` on
    //       <html>. We mirror it via a MutationObserver because the
    //       class toggle is imperative, not React state.
    //   (b) HTML5 drag — we listen to document-level dragstart/dragend.
    //       Includes drags from the widget palette, the sidebar's
    //       Connected Apps, file drops from Finder, etc.
    // Fresh per binding: a new surface starts disarmed, so the fake mousemove
    // Chromium sends when a desk mounts under a resting cursor cannot arm it.
    const arming = createEdgePanArming()

    let rndDragging = document.documentElement.classList.contains('fb-canvas-dragging')
    let htmlDragging = false
    const isDragging = (): boolean => rndDragging || htmlDragging

    const classObserver = new MutationObserver(() => {
      rndDragging = document.documentElement.classList.contains('fb-canvas-dragging')
      // Fresh dt when transitioning so we don't get a jump.
      if (rndDragging) lastFrameRef.current = 0
    })
    classObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    })

    // Where the drag started decides how it may arm (lib/edgePanArming): one
    // from off the desk (the Files panel beside the menu, the side menu's work
    // widgets) enters across an edge zone, so it pans only once it has reached
    // the desk's interior. Whether the source is on the desk is a DOM question,
    // so it is answered here and handed to the arming rule.
    function onHtmlDragStart(e: DragEvent): void {
      htmlDragging = true
      lastFrameRef.current = 0
      arming.dragBegan(!!el && e.target instanceof Node && el.contains(e.target))
    }
    function onHtmlDragEnd(): void {
      htmlDragging = false
      arming.dragEnded()
      // After drag ends the next event is a click — clear the cached
      // mouse position so the indicators don't pulse from the last
      // drag point until the user moves the mouse again.
      pointerRef.current = null
      setIntensity((i) => (i === ZERO_INTENSITY ? i : ZERO_INTENSITY))
    }
    document.addEventListener('dragstart', onHtmlDragStart, true)
    document.addEventListener('dragend', onHtmlDragEnd, true)
    // `drop` doesn't always fire (only on valid targets), and `dragend`
    // fires on the source even when drop was rejected — but we also
    // wire drop just in case a stray drag ends mid-air.
    document.addEventListener('drop', onHtmlDragEnd, true)

    function isFormFocused(): boolean {
      const ae = document.activeElement as HTMLElement | null
      if (!ae) return false
      const tag = ae.tagName.toLowerCase()
      const isForm =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        ae.isContentEditable
      if (!isForm) return false
      // Form outside the canvas (chat textarea, settings inputs,
      // modals, AICommandBar) — never blocks canvas navigation. The
      // user has clearly moved their attention away from the form
      // when they swing the cursor over to the canvas.
      if (!el || !el.contains(ae)) return false
      // Form INSIDE the canvas surface (widget labels, sticky text,
      // mindmap node inputs) — only block when the cursor is actually
      // over that form. If the user has moved the cursor to the edge
      // margin, they're asking for navigation regardless of where the
      // focused input is. Previously we treated ANY focused canvas-
      // internal input as a hard block, which made edge-pan silently
      // stop working after the user clicked into a mindmap label or
      // a sticky and didn't explicitly blur.
      const pointer = pointerRef.current
      if (!pointer) return false
      const screenX = pointer.x
      const screenY = pointer.y
      const aeRect = ae.getBoundingClientRect()
      // 40px padding so the user gets a small "grace area" around
      // the input — moving the cursor a little bit off the input
      // while still glancing at it shouldn't engage edge-pan.
      const PAD = 40
      const insideForm =
        screenX >= aeRect.left - PAD &&
        screenX <= aeRect.right + PAD &&
        screenY >= aeRect.top - PAD &&
        screenY <= aeRect.bottom + PAD
      return insideForm
    }

    // While the canvas runs beneath the dock column (Edges + Glass Phase 1b)
    // the visible left edge is the dock's right edge: --fb-dock-inset carries
    // that width (0px otherwise), so the left zone starts where the user can
    // actually see it instead of under the menu.
    function dockInset(): number {
      const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fb-dock-inset'))
      return Number.isFinite(v) ? v : 0
    }

    function placeOf(p: ReturnType<typeof canvasPoint>): PointerPlace {
      if (!p.inside) return 'off'
      return isInEdgeZone(p, p, marginRef.current) ? 'zone' : 'interior'
    }

    function readPositionFromEvent(e: PointerSample): void {
      if (!el) return
      refreshSize()
      const p = canvasPoint({ x: e.clientX, y: e.clientY }, geomRef.current)
      if (!p.inside) {
        arming.note(e)
        // Outside the canvas — clear so the camera doesn't drift on
        // stale coordinates. Don't clear during drag mode though, so
        // the user can momentarily leave the canvas (e.g. while
        // crossing over a docked widget) without losing momentum.
        if (!isDragging()) {
          pointerRef.current = null
          arming.disarm()
          setIntensity((i) => (i === ZERO_INTENSITY ? i : ZERO_INTENSITY))
        }
        return
      }
      pointerRef.current = { x: e.clientX, y: e.clientY }
      arming.observe(e, placeOf(p))
    }

    // The floating menus (sidebar, segment/office menus, the minimised-menu
    // restore pill) overlay the canvas near its edges. Hovering one must not
    // start edge-pan, so we treat a pointer over any floating chrome the same as
    // a pointer that left the canvas. Routing through onLeave() keeps the
    // "don't clear mid-drag" invariant so dragging a widget past a menu toward
    // the edge still pans.
    // Suppress while the cursor is over ANY floating menu: the docked menus
    // (.fb-floating-chrome) and everything tagged data-floating-menu (the
    // control pill, breadcrumb, toolbar, presence bar, zoom pill, minimap FAB,
    // context menus, popovers). This is pointer-over only, so panning resumes
    // the instant the cursor leaves the menu. It never latches edge-pan off.
    // The predicate lives in lib/floatingChrome so components can be tested
    // against the same definition.

    function onMove(e: MouseEvent): void {
      if (isOverFloatingChrome(e.target)) {
        arming.note(e)
        onLeave()
        return
      }
      readPositionFromEvent(e)
    }
    function onLeave(): void {
      // Same as outside-the-canvas behaviour from readPositionFromEvent.
      if (!isDragging()) {
        pointerRef.current = null
        arming.disarm()
        setIntensity((i) => (i === ZERO_INTENSITY ? i : ZERO_INTENSITY))
      }
    }
    // Moves that land on something that is NOT the canvas still move the
    // pointer, and arming judges them by where they are on the canvas's
    // visible area. Over the dock or the header that is "off the canvas", so
    // they disarm. Over an overlay portalled above the canvas (a context
    // menu, a scrim) they can be a real move into the zone: the canvas gets
    // no event for them, but when the overlay goes, Chromium re-sends the
    // point to the canvas and the pan resumes, as it always has. Events on
    // the canvas itself were judged by onMove already (this runs after it,
    // in the bubble phase), so they are skipped here.
    function onDocMove(e: MouseEvent): void {
      if (!el || (e.target instanceof Node && el.contains(e.target))) return
      refreshSize()
      arming.observe(e, placeOf(canvasPoint({ x: e.clientX, y: e.clientY }, geomRef.current)))
    }
    // During HTML5 drag the OS suppresses mousemove and instead emits
    // dragover on valid drop targets. The canvas already accepts drops
    // (Canvas.tsx wires its own onDragOver that preventDefaults), so
    // dragover fires here too. We listen at the document level so we
    // also catch drags being dragged OVER docked widgets etc., and
    // hit-test against our canvas bounds in `readPositionFromEvent`.
    function onDocDragOver(e: DragEvent): void {
      if (isOverFloatingChrome(e.target)) {
        arming.note(e)
        onLeave()
        return
      }
      readPositionFromEvent(e)
    }

    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)
    document.addEventListener('mousemove', onDocMove)
    document.addEventListener('dragover', onDocDragOver, true)

    let rafId = 0
    function tick(now: number): void {
      const dtMs = lastFrameRef.current === 0 ? 16 : now - lastFrameRef.current
      lastFrameRef.current = now
      // Clamp dt to avoid huge jumps on first frame or tab refocus.
      const dt = Math.min(0.05, dtMs / 1000)

      const pointer = pointerRef.current
      const m = marginRef.current
      const maxSpeed = maxSpeedRef.current
      // Where the resting pointer is NOW, against the current geometry. If
      // the geometry moved it out of the zone (or off the canvas), the pan is
      // over; a later move back in re-arms it. Geometry moving it INTO the
      // zone changes nothing on its own: that is not a move.
      const pos = pointer ? canvasPoint(pointer, geomRef.current) : null
      if (pos && !(pos.inside && isInEdgeZone(pos, pos, m))) arming.disarm()
      const { width, height } = pos ?? { width: 0, height: 0 }

      // `disabled` (soft) is overridden during active widget drag so
      // moving a widget toward the edge still scrolls the canvas. Use it
      // for system conditions like animatingPan that shouldn't block drag.
      // `hardDisabled` is NEVER overridden — it carries the user's explicit
      // preference (edgePanEnabled = false) and must always be respected.
      const dragging = isDragging()
      const effectiveDisabled = hardDisabledRef.current || (disabledRef.current && !dragging)

      // Skip while disabled, no cursor, not armed (the cursor did not move
      // into the zone), or container has zero size.
      if (
        effectiveDisabled ||
        !pos ||
        !arming.armed ||
        width === 0 ||
        height === 0 ||
        isFormFocused()
      ) {
        if (intensity !== ZERO_INTENSITY) {
          setIntensity(ZERO_INTENSITY)
        }
        rafId = requestAnimationFrame(tick)
        return
      }

      // Per-edge "depth into zone" — 0 when mouse is OUTSIDE the zone,
      // 1 when mouse is AT the edge. Linear distance, quadratic speed.
      // Clamped: a point past an edge must never exceed full speed.
      const depth = (d: number): number => Math.min(1, Math.max(0, (m - d) / m))
      const tTop = depth(pos.y)
      const tBottom = depth(height - pos.y)
      const tLeft = depth(pos.x)
      const tRight = depth(width - pos.x)

      const nextIntensity: EdgeIntensity = {
        top: Math.min(1, tTop),
        bottom: Math.min(1, tBottom),
        left: Math.min(1, tLeft),
        right: Math.min(1, tRight)
      }
      // Only call setIntensity when something actually changed beyond a
      // small threshold — keeps the React commits cheap during steady-state.
      const changed =
        Math.abs(nextIntensity.top - intensity.top) > 0.02 ||
        Math.abs(nextIntensity.bottom - intensity.bottom) > 0.02 ||
        Math.abs(nextIntensity.left - intensity.left) > 0.02 ||
        Math.abs(nextIntensity.right - intensity.right) > 0.02
      if (changed) setIntensity(nextIntensity)

      // Speed in pixels-per-second per axis. Pan delta vector is
      // OPPOSITE the mouse direction (mouse at top edge → world scrolls
      // DOWN visually, so panY increases). Quadratic ramp so the inner
      // half of the zone barely moves and the last 30% accelerates.
      const sx = (tRight * tRight - tLeft * tLeft) * maxSpeed
      const sy = (tBottom * tBottom - tTop * tTop) * maxSpeed
      if (sx !== 0 || sy !== 0) {
        // panBy expects deltas to the pan offset. mouse at right → we
        // want to see things to the right → world translates left →
        // panX becomes more negative. So sx (positive at right) → panX
        // delta -sx.
        panBy(-sx * dt, -sy * dt)
      }

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mouseleave', onLeave)
      document.removeEventListener('mousemove', onDocMove)
      document.removeEventListener('dragover', onDocDragOver, true)
      document.removeEventListener('dragstart', onHtmlDragStart, true)
      document.removeEventListener('dragend', onHtmlDragEnd, true)
      document.removeEventListener('drop', onHtmlDragEnd, true)
      classObserver.disconnect()
      ro.disconnect()
      mo.disconnect()
    }
    // intensity is intentionally read via closure; we don't want to
    // re-bind the rAF loop every time it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, panBy])

  return intensity
}
