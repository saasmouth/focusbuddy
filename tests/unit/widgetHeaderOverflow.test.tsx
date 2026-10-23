// The "…" overflow menu on a narrow work widget's header
// (components/widgets/WidgetHeaderOverflow.tsx): an accessible menu whose items
// carry the folded header tools' labels and run their handlers.

import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WidgetHeaderOverflow, { type OverflowItem } from '../../src/renderer/src/components/widgets/WidgetHeaderOverflow'

let host: HTMLDivElement
let root: Root
const grow = vi.fn()
const remove = vi.fn()
const ITEMS: OverflowItem[] = [
  { id: 'grow', label: 'Grow work widget', icon: 'add', onSelect: grow, testId: 'widget-grow-w1' },
  { id: 'remove', label: 'Remove work widget', icon: 'close', onSelect: remove, testId: 'widget-remove' }
]

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  return <WidgetHeaderOverflow widgetId="w1" items={ITEMS} open={open} setOpen={setOpen} triggerRef={ref} />
}

const trigger = (): HTMLButtonElement => document.querySelector('[data-testid="widget-overflow-w1"]') as HTMLButtonElement
const menu = (): HTMLElement | null => document.querySelector('[role="menu"]')
const visibleText = (el: HTMLElement): string =>
  Array.from(el.childNodes)
    .filter((n) => !(n instanceof HTMLElement && n.getAttribute('aria-hidden') === 'true'))
    .map((n) => n.textContent)
    .join('')
const items = (): HTMLElement[] => Array.from(document.querySelectorAll('[role="menuitem"]'))
const key = (k: string): void => {
  act(() => {
    ;(document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
}

beforeEach(() => {
  grow.mockReset()
  remove.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Harness />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('WidgetHeaderOverflow', () => {
  it('is a labelled menu button, closed at rest', () => {
    const t = trigger()
    expect(t.getAttribute('aria-label')).toBe('More actions')
    expect(t.getAttribute('aria-haspopup')).toBe('menu')
    expect(t.getAttribute('aria-expanded')).toBe('false')
    expect(t.className).toContain('widget-nodrag')
    expect(menu()).toBeNull()
  })

  it('opens with the folded tools, by the same labels, focus on the first', () => {
    act(() => trigger().click())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    // The visible text (the icon glyph is aria-hidden, so it is not part of the name).
    expect(items().map(visibleText)).toEqual(['Grow work widget', 'Remove work widget'])
    expect(items().map((i) => i.dataset.testid)).toEqual(['widget-grow-w1', 'widget-remove'])
    expect(document.activeElement).toBe(items()[0])
  })

  it('an item runs its handler and closes the menu', () => {
    act(() => trigger().click())
    act(() => items()[0]!.click())
    expect(grow).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    expect(menu()).toBeNull()
  })

  it('arrow keys move between items and wrap; Escape closes and refocuses "…"', () => {
    act(() => trigger().click())
    key('ArrowDown')
    expect(document.activeElement).toBe(items()[1])
    key('ArrowDown')
    expect(document.activeElement).toBe(items()[0])
    key('ArrowUp')
    expect(document.activeElement).toBe(items()[1])
    key('Home')
    expect(document.activeElement).toBe(items()[0])
    key('Escape')
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('a mousedown outside closes it', () => {
    act(() => trigger().click())
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(menu()).toBeNull()
  })
})
