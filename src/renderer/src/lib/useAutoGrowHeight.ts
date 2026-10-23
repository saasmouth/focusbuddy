import { useEffect, type RefObject } from 'react'
import { useWidgetStore } from '../stores/widgets'
import type { Widget, WidgetKind } from '@shared/types'
import { GROW_MAX_HEIGHT } from './useGrowToFit'
import { GROW_CEILING } from '@shared/widgetSizing'

// Auto-grow: a free widget's height follows its content. The widget gives a ref
// to the element whose natural (unconstrained) height is the content height; the
// hook grows — and gently shrinks — the widget so the content always fits,
// without an internal scrollbar. It writes widget.height through the store; the
// frame's existing sync effect pushes that into react-rnd imperatively (no
// remount, so webviews/editors are never torn down).
//
// Loop-safe: it only writes when the target differs from the current height by
// more than a threshold, and once the widget fits its content the next
// measurement matches and it stops. Skipped for section children (the section
// lays them out) and pinned widgets (screen-docked).

// Which kinds grow to fit their content. This is an explicit ALLOWLIST: a kind
// auto-grows only once its widget renders natural-height content (and has been
// verified), so adding the behaviour is opt-in per widget and can never clip a
// kind that still manages its own size. Everything not listed keeps its current
// behaviour — long-form text (note/page/markdown/living-doc) scrolls, the
// browser + embedded viewports keep their size, media keeps its fit, and the
// internal-scroll / pan-canvas / geometry-computed kinds are unchanged.
//
// One owner per kind: a kind that grows itself with useGrowToFit (markdown,
// custom-block) is not listed. The ceiling is the kind's GROW_MAX_HEIGHT where
// it has one (a sticky stops at 640, a card at 560), else MAX_H.
// tests/unit/growOwner.test.ts guards both.
const AUTO_GROW_KINDS: ReadonlySet<WidgetKind> = new Set<WidgetKind>([
  'sticky',
  'card',
  'field',
  'task-link'
])

export function autoGrowsHeight(kind: WidgetKind): boolean {
  return AUTO_GROW_KINDS.has(kind)
}

const MIN_H = 120
const MAX_H = 900

/** The height this hook grows a kind to at most: its GROW_MAX_HEIGHT, else MAX_H. */
export function autoGrowMax(kind: WidgetKind): number {
  return GROW_MAX_HEIGHT[kind] ?? MAX_H
}
// Only react to changes bigger than this, so sub-pixel reflow + our own writes
// don't ping-pong.
const THRESHOLD = 6

/**
 * What height the frame should give a widget, or null to leave it alone.
 *
 * Content drives the height up to the kind's cap (`max`). A height ABOVE the cap
 * was set by the person (auto-grow never puts a widget there): it is theirs, so
 * it is kept, whatever the content measures, up to GROW_CEILING (the owner's
 * "resize everything to any size" ruling). Without this, typing in a sticky the
 * person had grown to 1200 snapped it back to 640.
 */
export function autoGrowTarget(cur: number, natural: number, client: number, min: number, max: number): number | null {
  if (natural <= 0 || client <= 0) return null
  if (cur > max) return cur > GROW_CEILING.h ? GROW_CEILING.h : null
  // Everything in the widget that ISN'T the measured box: header, borders.
  const overhead = Math.max(0, cur - client)
  const target = Math.max(min, Math.min(max, Math.round(natural + overhead)))
  return Math.abs(target - cur) >= THRESHOLD ? target : null
}

export function useAutoGrowHeight(
  widget: Widget,
  // The element whose content height drives the widget. Usually the body; the
  // hook derives the non-body chrome (header + borders) from the gap between the
  // current widget height and this element's client height, so it needs no fixed
  // header constant.
  measureRef: RefObject<HTMLElement | null>,
  opts?: { min?: number; max?: number; enabled?: boolean }
): void {
  const update = useWidgetStore((s) => s.update)
  const enabled =
    opts?.enabled !== false &&
    autoGrowsHeight(widget.kind) &&
    !widget.parentSectionId &&
    !widget.pinned
  const widgetId = widget.id
  const min = opts?.min ?? MIN_H
  const max = opts?.max ?? autoGrowMax(widget.kind)

  useEffect(() => {
    if (!enabled) return
    const el = measureRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let raf = 0
    const apply = (): void => {
      const cur = useWidgetStore.getState().widgets.find((w) => w.id === widgetId)?.height
      if (cur == null) return
      // scrollHeight: content height incl. any overflow; clientHeight: the box as rendered.
      const target = autoGrowTarget(cur, el.scrollHeight, el.clientHeight, min, max)
      if (target != null) void update(widgetId, { height: target })
    }
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(apply)
    })
    ro.observe(el)
    apply()
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [enabled, widgetId, min, max, update, measureRef])
}
