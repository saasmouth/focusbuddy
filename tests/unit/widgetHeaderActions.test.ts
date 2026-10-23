// The work-widget header's fold rule and modifier-click guard
// (src/renderer/src/lib/widgetHeaderActions.ts).
//
// Fold: at a sticky's default 240px the eight header tools left ~16px to grab
// the widget by and no title at all. The rule keeps a minimum title and grab
// area and folds the lower-priority tools into "…", the same way for every kind.
//
// Guard: shift-clicking a header button selected the widget AND ran the button
// (shift-click "Rewrite with AI" opened the dialog). The modifier now wins.

import { describe, expect, it, vi } from 'vitest'
import {
  foldHeaderActions,
  guardHeaderClick,
  headerActionBudget,
  HEADER_ACTION_ORDER,
  HEADER_ACTION_PRIORITY,
  HEADER_MIN_GRAB_PX,
  HEADER_MIN_TITLE_PX,
  resolveModifierClick,
  rowWidth,
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
      // Nothing lost, nothing duplicated.
      expect([...visible, ...overflow].sort()).toEqual([...ALL].sort())
      // The visible set is always a priority prefix…
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

  it('a budget too small even for "…" still gets "…", so no tool is unreachable', () => {
    expect(foldHeaderActions(ALL, 0)).toEqual({ visible: [], overflow: HEADER_ACTION_ORDER })
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

  it('shift on a widget that cannot join the selection still never runs the action', () => {
    for (const ctx of [
      { ...free, isPinned: true },
      { ...free, isChildOfSection: true }
    ]) {
      expect(resolveModifierClick({ ...none, shiftKey: true }, ctx)).toMatchObject({
        toggleSelection: false,
        runAction: false
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

describe('guardHeaderClick — the header capture guard, on a real DOM tree', () => {
  // The same wiring as WidgetFrame: a header with the guard in the CAPTURE
  // phase, a button inside it with its own click handler.
  function mount(ctx = { zoom: 1, isChildOfSection: false, isPinned: false }) {
    const header = document.createElement('div')
    const button = document.createElement('button')
    header.appendChild(button)
    document.body.appendChild(header)
    const action = vi.fn()
    const toggleSelection = vi.fn()
    const dive = vi.fn()
    header.addEventListener('click', (e) => guardHeaderClick(e, ctx, { toggleSelection, dive }), true)
    button.addEventListener('click', action)
    const click = (init: MouseEventInit & { detail?: number }): void => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...init }))
    }
    return { action, toggleSelection, dive, click, cleanup: () => header.remove() }
  }

  it('plain click: the button runs', () => {
    const t = mount()
    t.click({})
    expect(t.action).toHaveBeenCalledTimes(1)
    expect(t.toggleSelection).not.toHaveBeenCalled()
    t.cleanup()
  })

  it('shift pointer click: the button does NOT run (mousedown already selected)', () => {
    const t = mount()
    t.click({ shiftKey: true })
    expect(t.action).not.toHaveBeenCalled()
    // Selection happened on mousedown in the frame; the click must not toggle it back.
    expect(t.toggleSelection).not.toHaveBeenCalled()
    t.cleanup()
  })

  it('Shift+Enter (keyboard click, detail 0): selects here, button does not run', () => {
    const t = mount()
    t.click({ shiftKey: true, detail: 0 })
    expect(t.action).not.toHaveBeenCalled()
    expect(t.toggleSelection).toHaveBeenCalledTimes(1)
    t.cleanup()
  })

  it('⌘-click while zoomed out: the button does not run', () => {
    const t = mount({ zoom: 0.5, isChildOfSection: false, isPinned: false })
    t.click({ metaKey: true })
    expect(t.action).not.toHaveBeenCalled()
    t.click({ metaKey: true, detail: 0 })
    expect(t.dive).toHaveBeenCalledTimes(1)
    t.cleanup()
  })

  it('Alt-click: the button runs', () => {
    const t = mount()
    t.click({ altKey: true })
    expect(t.action).toHaveBeenCalledTimes(1)
    t.cleanup()
  })
})
