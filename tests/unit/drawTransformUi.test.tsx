// The Transform panel, the Align panel and the transform dialogs, mounted on
// the real editor (the tool harness) and driven through the DOM: typing an
// expression into a field, Preview, Cancel, OK and Copy.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))

import { nodeBounds } from '../../src/shared/draw/ops'
import type { DrawDoc, DrawPathNode } from '../../src/shared/draw/model'
import transformPanel from '../../src/renderer/src/components/documents/draw/panels/transform.panel'
import alignPanel from '../../src/renderer/src/components/documents/draw/panels/align.panel'
import { dialogById } from '../../src/renderer/src/components/documents/draw/dialogs/registry'
import { resetTransformPrefs, setTransformPrefs } from '../../src/renderer/src/components/documents/draw/transform/prefs'
import { blank, harness, rect, type Harness } from './drawTools/harness'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  resetTransformPrefs()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const q = (id: string): HTMLElement => {
  const el = host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
  if (!el) throw new Error(`no ${id}`)
  return el
}

/** Type into a field the way a person does, then press Enter. */
function type(id: string, text: string): void {
  const input = q(id) as HTMLInputElement
  act(() => {
    input.focus()
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

const click = (id: string): void => act(() => q(id).click())
const box = (h: Harness, id: string): ReturnType<typeof nodeBounds> => nodeBounds(h.objects().find((o) => o.id === id)!)

function mountPanel(h: Harness, p: typeof transformPanel): void {
  const C = p.component
  act(() => root.render(<C ctx={h.ed.ctx} />))
}

function mountDialog(h: Harness, id: string, props: Record<string, unknown> = {}): { closed: () => boolean } {
  const d = dialogById(id)!
  let closed = false
  const C = d.component
  act(() =>
    root.render(
      <C
        ctx={h.ed.ctx}
        props={props}
        close={() => {
          closed = true
          act(() => root.render(<div />))
        }}
      />
    )
  )
  return { closed: () => closed }
}

describe('Transform panel', () => {
  it('typing W = 200 makes the object 200 wide, about the reference point, as one undo step', () => {
    const h = harness(blank([rect('a', 50, 50, 100, 40)]))
    h.ed.ctx.select(['a'])
    mountPanel(h, transformPanel)
    expect((q('draw-transform-w') as HTMLInputElement).value).toBe('100 px')
    expect((q('draw-transform-x') as HTMLInputElement).value).toBe('100 px') // centre reference point
    type('draw-transform-w', '200')
    expect(box(h, 'a')).toEqual({ x: 0, y: 50, w: 200, h: 40 })
    expect(h.state().past).toHaveLength(1)
    // The top-left reference point keeps the left edge where it is.
    click('draw-transform-ref-tl')
    type('draw-transform-w', '50%')
    expect(box(h, 'a')).toEqual({ x: 0, y: 50, w: 100, h: 40 })
  })

  it('constrain proportions scales H with W; X and Y take expressions; rotate turns', () => {
    const h = harness(blank([rect('a', 0, 0, 100, 50)]))
    h.ed.ctx.select(['a'])
    setTransformPrefs({ refPoint: 'tl' })
    mountPanel(h, transformPanel)
    click('draw-transform-constrain')
    type('draw-transform-w', '100+100')
    expect(box(h, 'a')).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    type('draw-transform-x', '10*2')
    expect(box(h, 'a').x).toBe(20)
    type('draw-transform-rotate', '90')
    const b = box(h, 'a')
    expect(b.w).toBeCloseTo(100)
    expect(b.h).toBeCloseTo(200)
  })

  it('shows lengths in the document\'s units', () => {
    const base = harness(blank([rect('a', 0, 0, 96, 48)]))
    const doc: DrawDoc = { ...base.doc(), settings: { units: 'in' } }
    const h = harness(doc)
    h.ed.ctx.select(['a'])
    mountPanel(h, transformPanel)
    expect((q('draw-transform-w') as HTMLInputElement).value).toBe('1 in')
    type('draw-transform-h', '25.4mm')
    expect(box(h, 'a').h).toBeCloseTo(96)
  })

  it('a field refuses what does not parse and keeps the old value', () => {
    const h = harness(blank([rect('a', 0, 0, 100, 50)]))
    h.ed.ctx.select(['a'])
    mountPanel(h, transformPanel)
    type('draw-transform-w', 'wide')
    expect(box(h, 'a').w).toBe(100)
    expect(h.state().past).toHaveLength(0)
  })
})

describe('transform dialogs', () => {
  it('Scale: Preview streams the result with no undo step; Cancel puts the drawing back exactly', () => {
    const h = harness(blank([rect('a', 100, 100, 100, 100)]))
    h.ed.ctx.select(['a'])
    const before = h.doc()
    const d = mountDialog(h, 'transform-scale')
    type('draw-scale-uniform', '50')
    click('draw-scale-dialog-preview')
    expect(box(h, 'a')).toEqual({ x: 125, y: 125, w: 50, h: 50 })
    expect(h.state().past).toHaveLength(1) // the open preview step
    click('draw-scale-dialog-cancel')
    expect(d.closed()).toBe(true)
    expect(h.doc()).toBe(before)
    expect(h.state().past).toHaveLength(0)
  })

  it('Scale OK is one labelled step; Copy keeps the original and selects the copy', () => {
    const h = harness(blank([rect('a', 100, 100, 100, 100)]))
    h.ed.ctx.select(['a'])
    mountDialog(h, 'transform-scale')
    click('draw-scale-dialog-preview')
    type('draw-scale-uniform', '200')
    click('draw-scale-dialog-ok')
    expect(box(h, 'a')).toEqual({ x: 50, y: 50, w: 200, h: 200 })
    expect(h.state().past.map((p) => p.label)).toEqual(['Scale'])
    mountDialog(h, 'transform-rotate')
    type('draw-rotate-angle', '45')
    click('draw-rotate-dialog-copy')
    expect(h.objects()).toHaveLength(2)
    expect(h.state().selection).not.toContain('a')
    expect(h.state().past.map((p) => p.label)).toEqual(['Scale', 'Rotate copy'])
  })

  it('Move: distance and angle drive horizontal and vertical', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    mountDialog(h, 'transform-move')
    type('draw-move-distance', '10')
    type('draw-move-angle', '90')
    expect((q('draw-move-v') as HTMLInputElement).value).toBe('-10 px')
    click('draw-move-dialog-ok')
    expect(box(h, 'a').y).toBe(-10)
  })

  it('Reflect about a vertical axis through a tool-set origin; Shear refuses 90°', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    mountDialog(h, 'transform-reflect', { origin: { x: 20, y: 0 } })
    click('draw-reflect-axis-vertical')
    click('draw-reflect-dialog-ok')
    expect(box(h, 'a').x).toBe(30)
    mountDialog(h, 'transform-shear')
    type('draw-shear-angle', '90')
    expect(q('draw-shear-dialog-error').textContent).toMatch(/flatten/)
    expect((q('draw-shear-dialog-ok') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Transform Patterns is shown but honestly unavailable; unticking Transform Objects disables OK', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    mountDialog(h, 'transform-rotate')
    expect((q('draw-rotate-dialog-patterns') as HTMLInputElement).disabled).toBe(true)
    click('draw-rotate-dialog-objects')
    expect((q('draw-rotate-dialog-ok') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Transform Each with Random: what the preview shows is what OK applies', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10), rect('b', 100, 0, 10, 10)]))
    h.ed.ctx.select(['a', 'b'])
    mountDialog(h, 'transform-each')
    type('draw-each-move-h', '100')
    click('draw-each-random')
    click('draw-each-dialog-preview')
    const shown = h.objects().map((o) => nodeBounds(o).x)
    click('draw-each-dialog-ok')
    expect(h.objects().map((o) => nodeBounds(o).x)).toEqual(shown)
    for (const [i, x] of shown.entries()) expect(x - [0, 100][i]).toBeGreaterThanOrEqual(0)
    expect(h.state().past.map((p) => p.label)).toEqual(['Transform Each'])
  })
})

describe('Align panel', () => {
  it('buttons are off until they can work; distribute right edges evens them out', () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10), rect('b', 30, 0, 20, 10), rect('c', 100, 0, 40, 10)]))
    h.ed.ctx.select(['a', 'b'])
    mountPanel(h, alignPanel)
    expect((q('draw-distribute-right') as HTMLButtonElement).disabled).toBe(true)
    act(() => h.ed.ctx.select(['a', 'b', 'c']))
    expect((q('draw-distribute-right') as HTMLButtonElement).disabled).toBe(false)
    click('draw-distribute-right')
    expect(['a', 'b', 'c'].map((id) => box(h, id).x + box(h, id).w)).toEqual([10, 75, 140])
    const p = h.objects()[0] as DrawPathNode
    expect(p.shapeKind).toBe('rect')
  })
})
