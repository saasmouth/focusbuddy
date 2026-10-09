import { useEffect, useRef, useState } from 'react'
import { useWidgetStore } from '../stores/widgets'
import { isOverFloatingChrome } from './floatingChrome'

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

interface Options {
  // Pixel width of the active edge zone (distance from the edge within
  // which the camera starts moving). Default 80px.
  margin?: number
  // Maximum pan speed in world units per second when the mouse is
  // pressed up against the edge. Default 1100 → at 60 fps that's ~18
  // pixels per frame, brisk but controllable.
  maxSpeedPerSecond?: number
  // The canvas container ref. Mouse position is read relative to its
  // bounding box.
  containerRef: React.RefObject<HTMLDivElement>
  // Soft-disable: pauses edge-pan but is overridden during active widget
  // drag so the user can still scroll by moving a widget toward the edge.
  // Use for system conditions like animatingPan that shouldn't block drag.
  disabled: boolean
  // Hard-disable: stops edge-pan completely, even during drag. Use for
  // explicit user preferences (edgePanEnabled = false).
  hardDisabled?: boolean
}

export function useEdgePan({
  containerRef,
  disabled,
  hardDisabled = false,
  margin = 80,
  maxSpeedPerSecond = 1100
}: Options): EdgeIntensity {
  const panBy = useWidgetStore((s) => s.panBy)
  const [intensity, setIntensity] = useState<EdgeIntensity>(ZERO_INTENSITY)
  // Refs so the rAF loop reads the latest values without re-binding.
  const mousePosRef = useRef<{ x: number; y: number } | null>(null)
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
  // Cached size of the container — read in mousemove + rAF, so we
  // memoise via a ResizeObserver instead of calling gbcr every frame.
  const sizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 })

  useEffect(() => {
    marginRef.current = margin
    maxSpeedRef.current = maxSpeedPerSecond
  }, [margin, maxSpeedPerSecond])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // Cache the container's size so the rAF loop doesn't call gbcr
    // every frame (which forces a synchronous layout).
    function refreshSize(): void {
      if (!el) return
      const rect = el.getBoundingClientRect()
      sizeRef.current = { width: rect.width - dockInset(), height: rect.height }
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

    function onHtmlDragStart(): void {
      htmlDragging = true
      lastFrameRef.current = 0
    }
    function onHtmlDragEnd(): void {
      htmlDragging = false
      // After drag ends the next event is a click — clear the cached
      // mouse position so the indicators don't pulse from the last
      // drag point until the user moves the mouse again.
      mousePosRef.current = null
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
      const pos = mousePosRef.current
      if (!pos) return false
      const elRect = el.getBoundingClientRect()
      const screenX = pos.x + elRect.left
      const screenY = pos.y + elRect.top
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

    function readPositionFromEvent(clientX: number, clientY: number): void {
      if (!el) return
      const rect = el.getBoundingClientRect()
      const inset = dockInset()
      const x = clientX - rect.left - inset
      const y = clientY - rect.top
      if (x < 0 || y < 0 || x > rect.width - inset || y > rect.height) {
        // Outside the canvas — clear so the camera doesn't drift on
        // stale coordinates. Don't clear during drag mode though, so
        // the user can momentarily leave the canvas (e.g. while
        // crossing over a docked widget) without losing momentum.
        if (!isDragging()) {
          mousePosRef.current = null
          setIntensity((i) => (i === ZERO_INTENSITY ? i : ZERO_INTENSITY))
        }
        return
      }
      mousePosRef.current = { x, y }
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
        onLeave()
        return
      }
      readPositionFromEvent(e.clientX, e.clientY)
    }
    function onLeave(): void {
      // Same as outside-the-canvas behaviour from readPositionFromEvent.
      if (!isDragging()) {
        mousePosRef.current = null
        setIntensity((i) => (i === ZERO_INTENSITY ? i : ZERO_INTENSITY))
      }
    }
    // During HTML5 drag the OS suppresses mousemove and instead emits
    // dragover on valid drop targets. The canvas already accepts drops
    // (Canvas.tsx wires its own onDragOver that preventDefaults), so
    // dragover fires here too. We listen at the document level so we
    // also catch drags being dragged OVER docked widgets etc., and
    // hit-test against our canvas bounds in `readPositionFromEvent`.
    function onDocDragOver(e: DragEvent): void {
      if (isOverFloatingChrome(e.target)) {
        onLeave()
        return
      }
      readPositionFromEvent(e.clientX, e.clientY)
    }

    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)
    document.addEventListener('dragover', onDocDragOver, true)

    let rafId = 0
    function tick(now: number): void {
      const dtMs = lastFrameRef.current === 0 ? 16 : now - lastFrameRef.current
      lastFrameRef.current = now
      // Clamp dt to avoid huge jumps on first frame or tab refocus.
      const dt = Math.min(0.05, dtMs / 1000)

      const pos = mousePosRef.current
      const m = marginRef.current
      const maxSpeed = maxSpeedRef.current
      const { width, height } = sizeRef.current

      // `disabled` (soft) is overridden during active widget drag so
      // moving a widget toward the edge still scrolls the canvas. Use it
      // for system conditions like animatingPan that shouldn't block drag.
      // `hardDisabled` is NEVER overridden — it carries the user's explicit
      // preference (edgePanEnabled = false) and must always be respected.
      const dragging = isDragging()
      const effectiveDisabled = hardDisabledRef.current || (disabledRef.current && !dragging)

      // Skip while disabled, no cursor, or container has zero size.
      if (
        effectiveDisabled ||
        !pos ||
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
      const tTop = Math.max(0, (m - pos.y) / m)
      const tBottom = Math.max(0, (m - (height - pos.y)) / m)
      const tLeft = Math.max(0, (m - pos.x) / m)
      const tRight = Math.max(0, (m - (width - pos.x)) / m)

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
  }, [containerRef, panBy])

  return intensity
}
