// The work-widget header's fold rule and modifier-click guard
// (src/renderer/src/lib/widgetHeaderActions.ts).
//
// Fold: at a sticky's default 240px the eight header tools left ~16px to grab
// the widget by and no title at all. The rule keeps a minimum title and grab
// area and folds the lower-priority tools into "…", the same way for every kind.
//
// Modifier clicks: a shift-click (or ⌘/Ctrl-click while zoomed out) did its
// desk job on mousedown and must not also run the control it landed on.

import { describe, expect, it, vi } from 'vitest'
import {
  foldHeaderActions,
  headerActionBudget,
  HEADER_ACTION_ORDER,
  HEADER_ACTION_PRIORITY,
  HEADER_MIN_GRAB_PX,
  HEADER_MIN_TITLE_PX,
  resolveModifierClick,
  rowWidth,
  swallowModifierClick,
  type HeaderActionId
} from '../../src/renderer/src/lib/widgetHeaderActions'

const ALL: HeaderActionId[] = ['ai', 'rename', 'link', 'pin', 'shrink', 'grow', 'expand', 'remove']

describe('foldHeaderActions — one rule for every kind', () => {
  it('priority and row order each name every tool exactly once', () => {
    expect([...HEADER_ACTION_PRIORITY].sort()).toEqual([...ALL].sort())
    expect([...HEADER_ACTION_ORDER].sort()).toEqual([...ALL].sort())
  })

  it('unmeasured (null) shows everything, as the row always did', () => {
    expect(foldHeaderActions(ALL, null)).toEqual({ visible: HEADER_ACTION_ORDER, overflow: [] })
  })

  it('a wide header shows every tool and no "…"', () => {
    expect(foldHeaderActions(ALL, 600)).toEqual({ visible: HEADER_ACTION_ORDER, overflow: [] })
  })

  it('exactly enough room for all eight folds nothing; one pixel less folds', () => {
    const all = rowWidth(8)
    expect(all).toBe(8 * 24 + 7 * 2)
    expect(foldHeaderActions(ALL, all).overflow).toEqual([])
    // One pixel short: "…" takes a slot, so seven buttons fit — six tools + "…".
    const short = foldHeaderActions(ALL, all - 1)
    expect(short.visible).toHaveLength(6)
    // The two lowest priorities fold, listed in row order.
    expect(short.overflow).toEqual(['shrink', 'grow'])
  })

  it('a 240px sticky keeps AI and Expand on the header and folds the rest into "…"', () => {
    // 240px frame − 2×8px padding = 224px; kind chip (18) + gap (7) + bell (20,
    // ml 4) + gap (7) = 56px of fixed title cluster.
    const budget = headerActionBudget(224, 56)
    expect(budget).toBe(224 - 56 - HEADER_MIN_TITLE_PX - HEADER_MIN_GRAB_PX)
    const fold = foldHeaderActions(ALL, budget)
    expect(fold.visible).toEqual(['ai', 'expand'])
    expect(fold.overflow).toEqual(['rename', 'link', 'pin', 'shrink', 'grow', 'remove'])
    // What is left for the row really fits in the budget, "…" included.
    expect(rowWidth(fold.visible.length + 1)).toBeLessThanOrEqual(budget)
  })

  it('shows the highest-priority tools first as the header widens', () => {
    let prev: HeaderActionId[] = []
    for (let budget = 0; budget <= rowWidth(8); budget++) {
      const { visible, overflow } = foldHeaderActions(ALL, budget)
      expect(visible.length).toBeGreaterThanOrEqual(1)
      // Nothing lost, nothing duplicated.
      expect([...visible, ...overflow].sort()).toEqual([...ALL].sort())
      // The visible set is always a priority prefix (AI at least)…
      const prefix = HEADER_ACTION_PRIORITY.slice(0, visible.length)
      expect([...visible].sort()).toEqual([...prefix].sort())
      // …and only ever grows with width.
      for (const id of prev) expect(visible).toContain(id)
      prev = visible
    }
  })

  it('keeps the row order for what is shown, whatever the priority', () => {
    const { visible } = foldHeaderActions(ALL, rowWidth(5))
    // 4 tools + "…": ai, expand, remove, pin by priority — shown in row order.
    expect(visible).toEqual(['ai', 'pin', 'expand', 'remove'])
  })

  it('a budget too small even for "…" keeps AI and "…": no tool is unreachable, AI never moves', () => {
    const fold = foldHeaderActions(ALL, 0)
    expect(fold.visible).toEqual(['ai'])
    expect(fold.overflow).toEqual(HEADER_ACTION_ORDER.filter((id) => id !== 'ai'))
  })

  it('the 180px floor (every kind minimum) keeps AI inline', () => {
    // 180 − 16 padding = 164 inner, 56 of fixed title cluster.
    expect(foldHeaderActions(ALL, headerActionBudget(164, 56)).visible).toEqual(['ai'])
  })

  it('AI is never folded at any width', () => {
    for (let budget = 0; budget <= rowWidth(8); budget++) {
      expect(foldHeaderActions(ALL, budget).visible[0]).toBe('ai')
    }
  })

  it('folds only the tools a widget has (a section child has no pin/size tools)', () => {
    const child: HeaderActionId[] = ['ai', 'rename', 'link', 'expand', 'remove']
    expect(foldHeaderActions(child, rowWidth(5))).toEqual({ visible: child, overflow: [] })
    const narrow = foldHeaderActions(child, rowWidth(3))
    expect(narrow.visible).toEqual(['ai', 'expand'])
    expect(narrow.overflow).toEqual(['rename', 'link', 'remove'])
  })

  it('the budget never goes negative', () => {
    expect(headerActionBudget(100, 80)).toBe(0)
  })
})

describe('resolveModifierClick — what a modifier means on a work widget', () => {
  const none = { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }
  const free = { zoom: 1, isChildOfSection: false, isPinned: false }

  it('a plain click runs the action', () => {
    expect(resolveModifierClick(none, free)).toMatchObject({ kind: 'plain', runAction: true })
  })

  it('shift selects and never runs the action', () => {
    expect(resolveModifierClick({ ...none, shiftKey: true }, free)).toEqual({
      kind: 'select',
      toggleSelection: true,
      dive: false,
      runAction: false
    })
  })

  it('shift on a widget that cannot join the selection is a plain click (the frame rule since 55ea2b30)', () => {
    for (const ctx of [
      { ...free, isPinned: true },
      { ...free, isChildOfSection: true }
    ]) {
      expect(resolveModifierClick({ ...none, shiftKey: true }, ctx)).toMatchObject({
        kind: 'plain',
        toggleSelection: false,
        runAction: true
      })
    }
  })

  it('⌘ or Ctrl dives when zoomed out below 80%, and does not run the action', () => {
    for (const m of [{ metaKey: true }, { ctrlKey: true }]) {
      expect(resolveModifierClick({ ...none, ...m }, { ...free, zoom: 0.5 })).toEqual({
        kind: 'dive',
        toggleSelection: false,
        dive: true,
        runAction: false
      })
    }
  })

  it('⌘ at ordinary zoom, ⌘ in a section, and Alt are plain clicks', () => {
    expect(resolveModifierClick({ ...none, metaKey: true }, free).runAction).toBe(true)
    expect(resolveModifierClick({ ...none, metaKey: true }, { ...free, zoom: 0.5, isChildOfSection: true }).runAction).toBe(true)
    expect(resolveModifierClick({ ...none, altKey: true }, free).runAction).toBe(true)
  })

  it('shift beats ⌘ when both are held', () => {
    expect(resolveModifierClick({ ...none, shiftKey: true, metaKey: true }, { ...free, zoom: 0.5 }).kind).toBe('select')
  })
})

describe('swallowModifierClick — the frame click capture, on a real DOM tree', () => {
  // The same wiring as WidgetFrame: the frame with the handler in the CAPTURE
  // phase, a header button inside it with its own click handler.
  function mount(ctx = { zoom: 1, isChildOfSection: false, isPinned: false }) {
    const frame = document.createElement('div')
    const button = document.createElement('button')
    frame.appendChild(button)
    document.body.appendChild(frame)
    const action = vi.fn()
    const dive = vi.fn()
    frame.addEventListener('click', (e) => swallowModifierClick(e, ctx, dive), true)
    button.addEventListener('click', action)
    const click = (init: MouseEventInit): MouseEvent => {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...init })
      button.dispatchEvent(ev)
      return ev
    }
    return { action, dive, click, cleanup: () => frame.remove() }
  }

  it('plain click: the button runs', () => {
    const t = mount()
    t.click({})
    expect(t.action).toHaveBeenCalledTimes(1)
    t.cleanup()
  })

  it('shift-click: the button does NOT run (mousedown already selected)', () => {
    const t = mount()
    expect(t.click({ shiftKey: true }).defaultPrevented).toBe(true)
    expect(t.action).not.toHaveBeenCalled()
    expect(t.dive).not.toHaveBeenCalled()
    t.cleanup()
  })

  it('⌘ / Ctrl-click while zoomed out: the button does NOT run (mousedown already dived)', () => {
    const t = mount({ zoom: 0.5, isChildOfSection: false, isPinned: false })
    t.click({ metaKey: true })
    t.click({ ctrlKey: true })
    expect(t.action).not.toHaveBeenCalled()
    // The click dives too (a click with no mousedown still dives; idempotent).
    expect(t.dive).toHaveBeenCalledTimes(2)
    t.cleanup()
  })

  it('⌘-click at ordinary zoom, Alt-click, and shift on a pinned widget: the button runs', () => {
    const t = mount()
    t.click({ metaKey: true })
    t.click({ altKey: true })
    expect(t.action).toHaveBeenCalledTimes(2)
    t.cleanup()
    const pinned = mount({ zoom: 1, isChildOfSection: false, isPinned: true })
    pinned.click({ shiftKey: true })
    expect(pinned.action).toHaveBeenCalledTimes(1)
    pinned.cleanup()
  })
})
