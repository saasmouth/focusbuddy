// PlexiiDeck gets a real readOnly (4.3.41); it had none (DeckCtx.readOnly was
// hard-coded false). A read-only deck never calls onChange: commit, undo, redo
// and import all refuse, the stage is the static slide face, the shell disables
// every control that is not readOnlySafe, and the navigator offers no
// move/duplicate/delete/add. The control case mounts the SAME editor editable
// and makes the same notes edit, proving the harness sees an emit when there is one.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlidesBody } from '../../src/shared/types'

beforeAll(() => {
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  ;(window as unknown as { api: unknown }).api = new Proxy({}, { get: () => new Proxy(() => Promise.resolve([]), { get: () => () => Promise.resolve([]) }) })
})

const body = (): SlidesBody =>
  ({
    slides: [
      { id: 's1', layout: 'title', title: 'Hello', body: '', notes: 'Say hello', elements: [{ id: 'e1', type: 'text', x: 100, y: 100, w: 400, h: 80, text: 'Hello' }] },
      { id: 's2', layout: 'content', title: 'Second', body: '', notes: '', elements: [] }
    ]
  }) as unknown as SlidesBody

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

async function mount(readOnly: boolean, onChange: (b: SlidesBody) => void): Promise<void> {
  const { default: SlidesEditor } = await import('../../src/renderer/src/components/documents/SlidesEditor')
  act(() => root.render(<SlidesEditor body={body()} title="Deck" onChange={onChange} readOnly={readOnly} />))
  await act(async () => {
    await Promise.resolve()
  })
}
const q = (sel: string): HTMLElement | null => host.querySelector(sel)
function typeInto(el: HTMLTextAreaElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const key = (k: string, mod = false): void =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: mod, ctrlKey: mod, bubbles: true }))
  })

describe('SlidesEditor readOnly never emits', () => {
  it('shows the static stage and no navigator edits', async () => {
    await mount(true, vi.fn())
    expect(q('[data-testid="slides-readonly-stage"]'), 'the static slide face, not the interactive canvas').not.toBeNull()
    expect(q('[data-testid="slides-add"]')).toBeNull()
    expect(q('[data-testid="slides-delete-0"]')).toBeNull()
    expect(q('[data-testid="slides-duplicate-0"]')).toBeNull()
    expect((q('[data-testid="slides-notes-editor"]') as HTMLTextAreaElement).readOnly).toBe(true)
  })

  it('selecting a slide, typing in notes, Delete, Cmd+Z and the shell buttons write nothing', async () => {
    const onChange = vi.fn()
    await mount(true, onChange)
    // Select the second slide (navigation is allowed).
    act(() => (host.querySelector('[aria-label="Slide 2"]') as HTMLElement).click())
    expect(host.querySelector('[aria-label="Slide 2"]')!.getAttribute('aria-current')).toBe('true')
    // Try to edit the notes.
    typeInto(q('[data-testid="slides-notes-editor"]') as HTMLTextAreaElement, 'edited by a viewer')
    // Try the keyboard.
    key('Delete')
    key('Backspace')
    key('z', true)
    // Press every enabled button in the shell that is not navigation or a pane toggle.
    for (const b of Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="slides-editor"] button, button'))) {
      const id = b.getAttribute('data-testid') ?? ''
      if (b.disabled || /present|sidepane|thumbnails|^$/.test(id)) continue
      act(() => b.click())
    }
    await act(async () => {
      await Promise.resolve()
    })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('control: the same notes edit in an editable deck does emit', async () => {
    const onChange = vi.fn()
    await mount(false, onChange)
    typeInto(q('[data-testid="slides-notes-editor"]') as HTMLTextAreaElement, 'edited by the owner')
    expect(onChange).toHaveBeenCalled()
    const last = onChange.mock.calls.at(-1)![0] as SlidesBody
    expect(last.slides[0]!.notes).toBe('edited by the owner')
    expect(q('[data-testid="slides-readonly-stage"]')).toBeNull()
  })
})
