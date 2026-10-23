// PlexiiDesign gets a real readOnly (4.3.41); it had NONE. A viewer of a
// shared live design got the full editor, and d8 found the same across all
// six apps.
//
// A read-only design never calls onChange. That is four guards, not one: the
// ordinary edit funnel (commit), the typing funnel (commitTyping, which
// coalesces a run of keystrokes into one undo step and emits on its own),
// undo and redo — plus the story RE-FLOW effect, which writes flowLines back
// into the document as a consequence of an edit and would otherwise churn a
// document nobody may change. I claimed "guard commit()" before reading the
// file; there were five emitters.
//
// The last test is the CONTROL CASE, following slidesReadOnly: it mounts the
// SAME editor editable and makes the same change, so the harness is proven to
// see an emit when there is one. Without it, every assertion here would pass
// just as happily against an editor that ignored the prop entirely.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesignBody } from '../../src/shared/design'
import { DEFAULT_BRAND_KIT } from '../../src/shared/brandKit'

beforeAll(() => {
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  // A catch-all api, EXCEPT brand.get: the brand store seeds itself with
  // DEFAULT_BRAND_KIT and then overwrites it with whatever brand.get()
  // resolves to, so a catch-all that answers [] leaves `kit` undefined and
  // DesignEditor crashes reading brand.fontHeading. That is the harness's
  // fault, not the editor's — but it does mean a malformed brand response
  // blanks the editor, which is worth someone's attention separately.
  const anyFn = new Proxy(() => Promise.resolve([]), { get: () => () => Promise.resolve([]) })
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {},
    {
      get: (_t, ns) =>
        ns === 'brand'
          ? { get: () => Promise.resolve({ kit: DEFAULT_BRAND_KIT, isSet: false }), set: (k: unknown) => Promise.resolve(k) }
          : anyFn
    }
  )
})

const body = (): DesignBody =>
  ({
    width: 800,
    height: 600,
    background: { type: 'solid', color: '#ffffff' },
    elements: [
      { id: 'e1', type: 'shape', shape: 'rect', x: 40, y: 40, w: 200, h: 120, z: 1, fill: { type: 'solid', color: '#2563eb' } },
      { id: 'e2', type: 'text', x: 40, y: 220, w: 300, h: 80, z: 2, paragraphs: [{ runs: [{ text: 'A line', fontSize: 18 }] }] },
      { id: 'e3', type: 'text', x: 400, y: 40, w: 300, h: 400, z: 3, storyId: 'st-a', storyOrder: 1, paragraphs: [] }
    ],
    pages: [
      {
        id: 'pg-1',
        background: { type: 'solid', color: '#ffffff' },
        elements: [
          { id: 'e1', type: 'shape', shape: 'rect', x: 40, y: 40, w: 200, h: 120, z: 1, fill: { type: 'solid', color: '#2563eb' } },
          { id: 'e2', type: 'text', x: 40, y: 220, w: 300, h: 80, z: 2, paragraphs: [{ runs: [{ text: 'A line', fontSize: 18 }] }] },
          // A THREADED frame with a story behind it, so the re-flow effect has
          // real work to do. Without one, applyStoryFlows returns the same body
          // and the re-flow test below passes whether the guard exists or not —
          // which is what it did on its first run.
          { id: 'e3', type: 'text', x: 400, y: 40, w: 300, h: 400, z: 3, storyId: 'st-a', storyOrder: 1, paragraphs: [] }
        ]
      }
    ],
    activePage: 0,
    stories: {
      'st-a': { blocks: [{ kind: 'paragraph', text: 'word '.repeat(300).trim() }] }
    }
  }) as unknown as DesignBody

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function mount(readOnly: boolean, onChange: (b: unknown) => void): Promise<void> {
  const { default: DesignEditor } = await import('../../src/renderer/src/components/documents/DesignEditor')
  act(() => root.render(<DesignEditor content={body()} title="A design" onChange={onChange} readOnly={readOnly} />))
  await act(async () => {
    await Promise.resolve()
  })
}
const q = (sel: string): HTMLElement | null => host.querySelector(sel)
const key = (k: string, mod = false): void =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: mod, ctrlKey: mod, bubbles: true }))
  })

describe('DesignEditor readOnly never emits', () => {
  it('mounts, and the shell disables what is not readOnlySafe', async () => {
    await mount(true, vi.fn())
    expect(q('[data-testid="design-editor"]')).not.toBeNull()
    // The office shell's own machinery: anything without readOnlySafe goes
    // disabled once the bar and rail are told.
    const undo = q('[data-testid="design-undo"]') as HTMLButtonElement | null
    expect(undo?.disabled ?? true).toBe(true)
  })

  it('the keyboard, every enabled control, and undo/redo write nothing', async () => {
    const onChange = vi.fn()
    await mount(true, onChange)

    // The editor's own keys: duplicate, delete, undo, redo.
    key('d', true)
    key('Delete')
    key('Backspace')
    key('z', true)
    key('y', true)

    // Press everything the shell still offers. Navigation, panes and panel
    // toggles are not writes, so they are allowed to be enabled — the point
    // is that NONE of them produces a change.
    for (const b of Array.from(host.querySelectorAll<HTMLButtonElement>('button'))) {
      const id = b.getAttribute('data-testid') ?? ''
      if (b.disabled || /sidepane|panel|tab-|^$/.test(id)) continue
      act(() => b.click())
    }
    await act(async () => {
      await Promise.resolve()
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('the story re-flow does not write either', async () => {
    // applyStoryFlows runs on every document change and writes flowLines back.
    // In a read-only document that would be a write nobody asked for — and in
    // a live one the server now refuses it, so it could only churn.
    const onChange = vi.fn()
    await mount(true, onChange)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60))
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('control: the same editor, editable, DOES emit on the same keystroke', async () => {
    const onChange = vi.fn()
    await mount(false, onChange)
    // ⌘D duplicates the selection; with nothing selected it is a no-op, so
    // select first through the canvas the way a person would.
    const el = q('[data-testid="slide-element"]')
    expect(el, 'an element to select').not.toBeNull()
    act(() => {
      const r = el!.closest('[data-testid]') as HTMLElement
      r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 60, clientY: 60 }))
      r.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 60, clientY: 60 }))
    })
    key('d', true)
    await act(async () => {
      await Promise.resolve()
    })
    expect(onChange, 'the harness sees an emit when one is allowed').toHaveBeenCalled()
  })
})
