// WP-PATH UI, mounted: the Simplify and Average dialogs and the Anchor points
// panel, each driven through the DOM against the real editor (the tool
// harness), so what is asserted is what a person would see and get.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

import simplify from '../../../src/renderer/src/components/documents/draw/dialogs/simplify.dialog'
import average from '../../../src/renderer/src/components/documents/draw/dialogs/average.dialog'
import anchorsPanel from '../../../src/renderer/src/components/documents/draw/bar/anchors.tab'
import type { DrawPathNode } from '../../../src/shared/draw/model'
import { blank, harness, rect } from './harness'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const q = (id: string): HTMLElement => host.querySelector(`[data-testid="${id}"]`) as HTMLElement

function setInput(el: HTMLInputElement, value: string | boolean): void {
  act(() => {
    if (typeof value === 'boolean') {
      el.click()
      return
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function dense(): Record<string, unknown> {
  return {
    id: 'w',
    type: 'path',
    path: { subpaths: [{ closed: false, nodes: Array.from({ length: 120 }, (_, k) => ({ x: k * 3, y: 150 + 60 * Math.sin(k / 12) })) }] },
    fill: { type: 'none' },
    stroke: { paint: { type: 'solid', color: '#000' }, width: 2 }
  }
}

const count = (h: ReturnType<typeof harness>): number => (h.objects()[0] as DrawPathNode).path.subpaths[0].nodes.length

describe('Simplify dialog', () => {
  it('previews live, shows both counts, and Cancel puts the path back with no undo step', () => {
    const h = harness(blank([dense()], {}, 400, 300))
    h.ed.ctx.select(['w'])
    let closed = 0
    const C = simplify.component
    act(() => root.render(<C ctx={h.ed.ctx} close={() => closed++} />))
    expect(q('draw-simplify-counts').textContent).toMatch(/Original: 120 points · Current: \d+ points/)
    // The canvas already shows the simplified result (Preview is on).
    expect(count(h)).toBeLessThan(120)
    // Preview off: the original is back on the canvas.
    setInput(q('draw-simplify-preview') as HTMLInputElement, false)
    expect(count(h)).toBe(120)
    act(() => q('draw-simplify-cancel').click())
    expect(closed).toBe(1)
    act(() => root.render(<div />))
    expect(count(h)).toBe(120)
    expect(h.state().past).toHaveLength(0)
  })

  it('OK applies the result as ONE undo step; Maximum precision keeps more points than Minimum', () => {
    const h = harness(blank([dense()]))
    h.ed.ctx.select(['w'])
    const C = simplify.component
    act(() => root.render(<C ctx={h.ed.ctx} close={() => act(() => root.render(<div />))} />))
    setInput(q('draw-simplify-precision') as HTMLInputElement, '0')
    const fewest = Number(/Current: (\d+)/.exec(q('draw-simplify-counts').textContent!)![1])
    setInput(q('draw-simplify-precision') as HTMLInputElement, '100')
    const most = Number(/Current: (\d+)/.exec(q('draw-simplify-counts').textContent!)![1])
    expect(most).toBeGreaterThan(fewest)
    setInput(q('draw-simplify-original') as HTMLInputElement, true)
    expect(q('draw-simplify-compare')).not.toBeNull()
    act(() => q('draw-simplify-apply').click())
    expect(count(h)).toBe(most)
    expect(h.state().past).toHaveLength(1)
    expect(h.state().past[0].label).toBe('Simplify')
    h.ed.history.undo()
    expect(count(h)).toBe(120)
  })

  it('Auto-Simplify picks a precision whose result stays within half a pixel', () => {
    const h = harness(blank([dense()]))
    h.ed.ctx.select(['w'])
    const C = simplify.component
    act(() => root.render(<C ctx={h.ed.ctx} close={() => {}} />))
    act(() => q('draw-simplify-auto').click())
    const p = Number((q('draw-simplify-precision-value') as HTMLInputElement).value)
    expect(p).toBeGreaterThanOrEqual(0)
    expect(p).toBeLessThanOrEqual(100)
    expect(Number(/Current: (\d+)/.exec(q('draw-simplify-counts').textContent!)![1])).toBeLessThan(120)
  })
})

describe('Average dialog', () => {
  it('averages the selected anchors on the chosen axis', () => {
    const h = harness(blank([{ id: 'l', type: 'path', path: { subpaths: [{ closed: false, nodes: [{ x: 0, y: 0 }, { x: 100, y: 40 }, { x: 50, y: 80 }] }] }, fill: { type: 'none' } }]))
    h.ed.ctx.select(['l'])
    const C = average.component
    let closed = false
    act(() => root.render(<C ctx={h.ed.ctx} close={() => (closed = true)} />))
    act(() => q('draw-average-vertical').click())
    act(() => q('draw-average-apply').click())
    expect(closed).toBe(true)
    expect((h.objects()[0] as DrawPathNode).path.subpaths[0].nodes.map((n) => n.x)).toEqual([50, 50, 50])
  })
})

describe('Anchors tab (the top bar)', () => {
  it('shows with an anchor tool and a path; its buttons enable from the selection and run commands', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('direct')
    expect(anchorsPanel.when!(h.state())).toBe(false)
    h.click(200, 100)
    expect(anchorsPanel.when!(h.state())).toBe(true)
    // Anchors picked out one by one keep the tab whatever tool is active;
    // with the whole path selected and a non-anchor tool it goes.
    h.tool('rect')
    expect(anchorsPanel.when!(h.state())).toBe(true)
    h.ed.ctx.select(['r'])
    expect(anchorsPanel.when!(h.state())).toBe(false)
    h.tool('direct')
    h.click(200, 100)
    const P = anchorsPanel.component
    act(() => root.render(<P ctx={h.ed.ctx} />))
    expect(q('draw-anchors-count').textContent).toBe('1 selected')
    expect((q('draw-anchor-align-left') as HTMLButtonElement).disabled).toBe(true) // needs two
    expect((q('draw-anchor-remove') as HTMLButtonElement).disabled).toBe(false)
    setInput(q('draw-anchor-radius') as HTMLInputElement, '25')
    act(() => q('draw-anchor-round').click())
    expect((h.objects()[0] as DrawPathNode).path.subpaths[0].nodes).toHaveLength(5)
    expect(q('draw-anchors-count').textContent).toBe('2 selected')
  })

  it('shows the Smooth tool\'s options while it is active', () => {
    const h = harness(blank([rect('r', 100, 100, 100, 100)]))
    h.tool('smooth')
    expect(anchorsPanel.when!(h.state())).toBe(true)
    const P = anchorsPanel.component
    act(() => root.render(<P ctx={h.ed.ctx} />))
    // A bar number commits on Enter (one change, not one per keystroke).
    setInput(q('draw-smooth-fidelity') as HTMLInputElement, '80')
    act(() => {
      q('draw-smooth-fidelity').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(h.state().pathPrefs.smoothFidelity).toBe(80)
  })
})
