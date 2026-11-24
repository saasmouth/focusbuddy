// A widget writes the edit it is still holding when it unmounts.
//
// Six widgets debounce their writes (Page 250 ms, Card 300, Calculator 400,
// Colour 300, Shape 250, Form block 300) and CLEARED the pending timer when
// they unmounted, so an edit made just before the widget went away -- closing
// a desk, switching away, the canvas remounting its widgets on a layout change,
// a widget file's tile closing in PlexiiLite -- was never written. Sticky and
// Note already wrote it ("Flush any pending save on unmount"); these now do
// the same (lib/useSaveOnUnmount.ts).
//
// Each test makes one real edit through the widget's own control, unmounts at
// once with the timers frozen, and expects the edit to have been written.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const update = vi.fn(async () => {})
vi.mock('../../src/renderer/src/stores/widgets', () => {
  const state = { update: (...a: unknown[]) => update(...(a as [])), setFocused: () => {}, setActive: () => {}, widgets: [] }
  const useWidgetStore = Object.assign((sel?: (s: unknown) => unknown) => (sel ? sel(state) : state), { getState: () => state, setState: () => {}, subscribe: () => () => {} })
  return { useWidgetStore }
})
vi.mock('../../src/renderer/src/components/widgets/WidgetFrame', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('../../src/renderer/src/components/Icon', () => ({ default: () => <i /> }))
// The @-mention list loads the people directory; nothing here is about mentions.
vi.mock('../../src/renderer/src/lib/useMentionAutocomplete', () => ({
  useMentionAutocomplete: () => ({ open: false, candidates: [], activeIndex: 0, onInput: () => {}, onKeyDown: () => {}, close: () => {}, choose: () => {} })
}))

// The page's editor: TipTap, stood in for by an editor whose update the test fires.
const tiptap = vi.hoisted(() => ({ onUpdate: null as null | ((p: { editor: unknown }) => void), doc: { type: 'doc', content: [] as unknown[] } }))
vi.mock('@tiptap/react', () => ({
  useEditor: (opts: { onUpdate?: (p: { editor: unknown }) => void }) => {
    tiptap.onUpdate = opts.onUpdate ?? null
    return { getJSON: () => tiptap.doc, isDestroyed: false, commands: { setContent: () => {} }, setEditable: () => {}, on: () => {}, off: () => {}, view: { dom: document.createElement('div') }, isEditable: true, state: {} }
  },
  EditorContent: () => <div data-testid="editor" />
}))

import CardWidget from '../../src/renderer/src/components/widgets/CardWidget'
import CalculatorWidget from '../../src/renderer/src/components/widgets/CalculatorWidget'
import ColorWidget from '../../src/renderer/src/components/widgets/ColorWidget'
import ShapeWidget from '../../src/renderer/src/components/widgets/ShapeWidget'
import CustomBlockWidget from '../../src/renderer/src/components/widgets/CustomBlockWidget'
import PageWidget from '../../src/renderer/src/components/widgets/PageWidget'
import type { Widget } from '../../src/shared/types'
import { WidgetReadOnlyContext } from '../../src/renderer/src/lib/widgetSurface'

let root: Root
let host: HTMLElement
beforeEach(() => {
  vi.useFakeTimers()
  update.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  vi.useRealTimers()
  host.remove()
})

const widget = (kind: string, content = ''): Widget =>
  ({ id: `w-${kind}`, taskId: 't1', kind, title: '', content, x: 0, y: 0, width: 320, height: 240, zIndex: 1, color: null }) as unknown as Widget
/** A fresh root each time, so one test can mount, unmount and mount again. */
const mount = (el: JSX.Element): void => {
  root = createRoot(host)
  act(() => root.render(el))
}
/** A real change event on a controlled input or select, as React listens for it. */
function change(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}
const contentWritten = (id: string): string | undefined => {
  const call = update.mock.calls.find((c) => (c as unknown[])[0] === id) as unknown[] | undefined
  return (call?.[1] as { content?: string } | undefined)?.content
}
const unmountAtOnce = (): void => act(() => root.unmount())

describe('an edit made just before the widget unmounts is written', () => {
  it('Card: a title typed, then closed', () => {
    mount(<CardWidget widget={widget('card', JSON.stringify({ title: 'Plan', body: '' }))} />)
    act(() => change(host.querySelector('input[placeholder="Title"]') as HTMLInputElement, 'Plan B'))
    expect(update).not.toHaveBeenCalled()
    unmountAtOnce()
    expect(JSON.parse(contentWritten('w-card')!)).toMatchObject({ title: 'Plan B' })
  })

  it('Calculator: a key pressed, then closed', () => {
    mount(<CalculatorWidget widget={widget('calculator', '1+')} />)
    const seven = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '7')!
    act(() => seven.click())
    unmountAtOnce()
    expect(contentWritten('w-calculator')).toBe('1+7')
  })

  it('Colour: a colour typed, then closed', () => {
    mount(<ColorWidget widget={widget('color', '#fbbf24')} />)
    act(() => change(host.querySelectorAll('input')[1] as HTMLInputElement, '#123456'))
    unmountAtOnce()
    expect(contentWritten('w-color')).toBe('#123456')
  })

  it('Shape: the shape changed, then closed', () => {
    mount(<ShapeWidget widget={widget('shape', JSON.stringify({ shape: 'rect', label: '' }))} />)
    const select = host.querySelector('select[title="Shape"]') as HTMLSelectElement
    const other = [...select.options].map((o) => o.value).find((v) => v !== select.value)!
    act(() => change(select, other))
    unmountAtOnce()
    expect(JSON.parse(contentWritten('w-shape')!)).toMatchObject({ shape: other })
  })

  it('Form block: its title typed, then closed', () => {
    mount(<CustomBlockWidget widget={widget('custom-block', '')} />)
    act(() => change(host.querySelector('input[placeholder="Block title"]') as HTMLInputElement, 'Intake'))
    unmountAtOnce()
    expect(JSON.parse(contentWritten('w-custom-block')!)).toMatchObject({ title: 'Intake' })
  })

  it('Page: a keystroke in the editor, then closed', () => {
    mount(<PageWidget widget={widget('page', '')} />)
    tiptap.doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Agenda' }] }] }
    act(() => tiptap.onUpdate!({ editor: { getJSON: () => tiptap.doc, isDestroyed: false } }))
    unmountAtOnce()
    expect(JSON.parse(contentWritten('w-page')!)).toEqual(tiptap.doc)
  })
})

describe('nothing pending, nothing written; the debounce is unchanged', () => {
  it('unmounting with nothing pending writes nothing', () => {
    // A card writes its content in its own normalised form once after it mounts
    // (unchanged behaviour); once that has gone, nothing is pending.
    mount(<CardWidget widget={widget('card', JSON.stringify({ title: 'Plan', body: '' }))} />)
    act(() => vi.advanceTimersByTime(1000))
    update.mockClear()
    unmountAtOnce()
    mount(<CalculatorWidget widget={widget('calculator', '1+')} />)
    unmountAtOnce()
    expect(update).not.toHaveBeenCalled()
  })

  it('an edit is still written once, after its debounce, and not again on unmount', () => {
    mount(<CalculatorWidget widget={widget('calculator', '1+')} />)
    const seven = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '7')!
    act(() => seven.click())
    expect(update).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(400))
    expect(update).toHaveBeenCalledTimes(1)
    unmountAtOnce()
    expect(update).toHaveBeenCalledTimes(1)
  })
})

describe('read-only (the widget host showing a file it may not change): nothing is written', () => {
  // 9e, 2026-11-24: 4.3.54's save-on-close met the host's read-only mode in
  // these six widgets. A read-only widget shows no controls, so no edit is
  // pending; but a widget also writes its content back in its own normalised
  // form (a card adds the fields it lacks), and that must not happen to a file
  // the reader may only look at -- neither after the debounce nor on close.
  const readOnly = (el: JSX.Element): JSX.Element => <WidgetReadOnlyContext.Provider value={true}>{el}</WidgetReadOnlyContext.Provider>
  const cases: Array<[string, JSX.Element]> = [
    ['card', <CardWidget key="c" widget={widget('card', JSON.stringify({ title: 'Plan' }))} />],
    ['calculator', <CalculatorWidget key="k" widget={widget('calculator', '1+')} />],
    ['color', <ColorWidget key="o" widget={widget('color', '')} />],
    ['shape', <ShapeWidget key="s" widget={widget('shape', JSON.stringify({ label: 'Box' }))} />],
    ['form block', <CustomBlockWidget key="f" widget={widget('custom', JSON.stringify({ fields: [] }))} />],
    ['page', <PageWidget key="p" widget={widget('page', '')} />]
  ]
  for (const [name, el] of cases) {
    it(`a read-only ${name} writes nothing, after its debounce or when it closes`, () => {
      mount(readOnly(el))
      act(() => vi.advanceTimersByTime(1000))
      unmountAtOnce()
      expect(update, `${name} wrote while read-only`).not.toHaveBeenCalled()
    })
  }
})

