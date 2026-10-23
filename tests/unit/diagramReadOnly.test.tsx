// A read-only PlexiiDiagrams editor never calls onChange. Its host may be a
// shared desk, a viewer link or a live snippet instance; if any of them wires
// onChange to persistence, a viewer must not write the content it was shown.
// Two leaks closed (4.3.41): the debounced emit effect ignored readOnly, and
// switching pages wrote the viewport into the body. Read-only page viewports
// are now view state; the active page's edit menu does not open.
//
// The control case mounts the SAME editor editable and does the same page
// switch, proving the harness sees an emit when there is one.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MapBody } from '../../src/shared/types'

beforeAll(() => {
  // Fake timers ONCE for the file: React Flow animates zoom with d3-timer, which
  // captures the clock on first use, so re-faking per test would leave later
  // tests driving a clock d3 no longer reads.
  vi.useFakeTimers()
  // React Flow measures with ResizeObserver and DOMMatrix, which happy-dom lacks.
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  if (!(globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly) {
    ;(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class {
      m22 = 1
      constructor(_t?: string) {}
    }
  }
  ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => new Proxy(() => Promise.resolve(null), { get: () => () => Promise.resolve(null) }) })
})

afterAll(() => {
  vi.useRealTimers()
})

const body = (): MapBody =>
  ({
    version: 1,
    nodes: [
      { id: 'a', type: 'process', position: { x: 0, y: 0 }, data: { label: 'Alpha' } },
      { id: 'b', type: 'process', position: { x: 240, y: 0 }, data: { label: 'Beta' } }
    ],
    edges: [{ id: 'e1', source: 'a', target: 'b' }],
    // A stored viewport the live one will not match, so leaving this page is a
    // real body change for an editor (it saves where the page was looking).
    viewport: { x: 123, y: 45, zoom: 0.5 },
    pageName: 'Page 1',
    pages: [{ id: 'p2', name: 'Page 2', nodes: [{ id: 'c', type: 'process', position: { x: 0, y: 0 }, data: { label: 'Gamma' } }], edges: [] }]
  }) as unknown as MapBody

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  localStorage.clear() // the editor remembers view prefs; each case starts fresh
  host = document.createElement('div')
  host.style.width = '1000px'
  host.style.height = '700px'
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function mount(readOnly: boolean, onChange: (b: MapBody) => void): Promise<void> {
  const { default: MapEditor } = await import('../../src/renderer/src/components/documents/MapEditor')
  act(() => root.render(<MapEditor body={body()} title="Flow" onChange={onChange} readOnly={readOnly} />))
  await act(async () => {
    vi.advanceTimersByTime(1000)
  })
}
const q = (sel: string): HTMLElement | null => host.querySelector(sel)
// Zoom to 200% from the bar's Zoom menu (read-only safe: a viewer may zoom).
const zoomIn = async (): Promise<void> => {
  const menu = q('[data-testid="diagram-zoom"]')
  expect(menu, 'the Zoom menu renders').not.toBeNull()
  act(() => menu!.click())
  const item = Array.from(host.ownerDocument.querySelectorAll('button, [role="menuitem"]')).find((b) => b.textContent?.trim().startsWith('200%'))
  expect(item, 'the Zoom menu offers 200%').toBeDefined()
  act(() => (item as HTMLElement).click())
  await act(async () => {
    vi.advanceTimersByTime(1000)
  })
}
const settle = async (): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(2000) // past the 350 ms emit debounce and the 30 ms viewport restore
  })
}

describe('DiagramEditor readOnly never emits', () => {
  it('mounting read-only writes nothing', async () => {
    const onChange = vi.fn()
    await mount(true, onChange)
    await settle()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('switching pages, selecting and pressing Delete write nothing', async () => {
    const onChange = vi.fn()
    await mount(true, onChange)
    const page2 = q('[data-testid="diagram-page-1"]')
    expect(page2, 'the pages bar renders').not.toBeNull()
    // A viewer zooms (allowed), then leaves the page: an editor would save that
    // viewport into the body here (see the control below); a viewer must not.
    await zoomIn()
    act(() => page2!.click())
    await settle()
    act(() => q('[data-testid="diagram-page-0"]')!.click())
    await settle()
    // Click the active page: a read-only diagram has no page menu to open.
    act(() => q('[data-testid="diagram-page-0"]')!.click())
    expect(host.textContent).not.toContain('Delete page')
    // Select a node and try to delete it.
    const node = host.querySelector('.react-flow__node') as HTMLElement | null
    if (node) act(() => node.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })))
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true })))
    await settle()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('control: an editable editor saves the viewport on a page switch (the leak a viewer must not have)', async () => {
    const onChange = vi.fn()
    await mount(false, onChange)
    onChange.mockClear()
    await zoomIn()
    act(() => q('[data-testid="diagram-page-1"]')!.click())
    await settle()
    expect(onChange, 'switching pages writes the viewport into the body').toHaveBeenCalled()
  })

  it('control: the same editor, editable, does emit (the page menu edits the body)', async () => {
    const onChange = vi.fn()
    await mount(false, onChange)
    onChange.mockClear()
    // Click the active page: an editable diagram opens its page menu...
    act(() => q('[data-testid="diagram-page-0"]')!.click())
    const dup = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Duplicate')
    expect(dup, 'the page menu opens when editable').toBeDefined()
    // ...and duplicating a page is an edit, emitted after the debounce.
    act(() => dup!.click())
    await settle()
    expect(onChange).toHaveBeenCalled()
    const last = onChange.mock.calls.at(-1)![0] as MapBody
    expect((last.pages ?? []).length, 'a third page was added').toBe(2)
  })
})
