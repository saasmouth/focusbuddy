// WP1b guard, mounted: the real sticky and note bodies (the two that draw a
// read view and an editing textarea) leave a right-click on text to the text
// menu and open the work widget's menu everywhere else, including a note being
// read, which used to do nothing (AUDIT §1.3). Companion to
// contextMenuContract.wp1b.test.ts.

import { act, forwardRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const menuOpened = vi.fn()
vi.mock('../../src/renderer/src/components/contextMenu/UnifiedConnectedMenu', () => ({
  default: (p: { x: number; y: number; selectionContext?: unknown }) => {
    menuOpened(p)
    return <div data-testid="widget-menu" />
  }
}))
vi.mock('../../src/renderer/src/components/widgets/WidgetFrame', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('../../src/renderer/src/components/Icon', () => ({ default: () => <i /> }))
vi.mock('../../src/renderer/src/stores/widgets', () => ({
  useWidgetStore: (sel: (s: unknown) => unknown) => sel({ update: async () => {} })
}))
vi.mock('../../src/renderer/src/components/widgets/useWidgetSnippets', () => ({
  useTextWidgetSnippets: () => ({ onTextareaPaste: () => {} })
}))
vi.mock('../../src/renderer/src/lib/useMentionAutocomplete', () => ({
  useMentionAutocomplete: () => ({
    open: false,
    candidates: [],
    activeIndex: 0,
    onInput: () => {},
    onKeyDown: () => {},
    close: () => {},
    choose: () => {}
  })
}))
vi.mock('../../src/renderer/src/components/MentionTextarea', () => ({
  default: forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { wrapperClassName?: string }>(
    function MentionTextarea({ wrapperClassName: _w, ...rest }, ref) {
      return <textarea ref={ref} {...rest} />
    }
  )
}))

import NoteWidget from '../../src/renderer/src/components/widgets/NoteWidget'
import StickyWidget from '../../src/renderer/src/components/widgets/StickyWidget'
import type { Widget } from '../../src/shared/types'

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  menuOpened.mockClear()
  window.getSelection()?.removeAllRanges()
})

function render(el: JSX.Element): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(el))
  return host
}

/** A real contextmenu event, as the browser dispatches it; returns whether the body prevented it. */
function rightClick(target: Element): boolean {
  const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50, button: 2 })
  act(() => {
    target.dispatchEvent(ev)
  })
  return ev.defaultPrevented
}

const widget = (kind: 'note' | 'sticky', content: string): Widget =>
  ({ id: `w-${kind}`, kind, taskId: 't1', content, title: '', x: 0, y: 0, width: 300, height: 200 }) as unknown as Widget

describe('note body', () => {
  it('read mode: a right-click on the note opens the work widget menu (it did nothing)', () => {
    const el = render(<NoteWidget widget={widget('note', 'Plain words')} inline />)
    const rendered = el.querySelector('.fb-note-rendered')!
    expect(rendered, 'note in read mode').toBeTruthy()
    expect(rightClick(rendered)).toBe(true)
    expect(menuOpened).toHaveBeenCalledTimes(1)
    // Nothing was selected, so nothing poses as a selection.
    expect(menuOpened.mock.calls[0][0].selectionContext).toBeUndefined()
  })

  it('read mode with text selected: the text menu’s, not prevented', () => {
    const el = render(<NoteWidget widget={widget('note', 'Plain words')} inline />)
    const rendered = el.querySelector('.fb-note-rendered')!
    const range = document.createRange()
    range.selectNodeContents(rendered)
    window.getSelection()!.addRange(range)
    expect(rightClick(rendered.querySelector('div') ?? rendered)).toBe(false)
    expect(menuOpened).not.toHaveBeenCalled()
  })

  it('edit mode: a right-click in the textarea is the text menu’s, not prevented', () => {
    const el = render(<NoteWidget widget={widget('note', '')} inline />)
    const ta = el.querySelector('textarea')!
    expect(ta, 'an empty note opens as a textarea').toBeTruthy()
    expect(rightClick(ta)).toBe(false)
    expect(menuOpened).not.toHaveBeenCalled()
    // The padding around it is still the note's.
    expect(rightClick(el.querySelector('[data-testid="note-body"]')!)).toBe(true)
    expect(menuOpened).toHaveBeenCalledTimes(1)
  })
})

describe('sticky body', () => {
  it('read mode: the work widget menu; edit mode: the textarea is the text menu’s', () => {
    const el = render(<StickyWidget widget={widget('sticky', 'Buy milk')} inline />)
    const rendered = el.querySelector('.fb-sticky-rendered')!
    expect(rightClick(rendered)).toBe(true)
    expect(menuOpened).toHaveBeenCalledTimes(1)
    act(() => root!.unmount())
    menuOpened.mockClear()
    const el2 = render(<StickyWidget widget={widget('sticky', '')} inline />)
    const ta = el2.querySelector('textarea')!
    expect(ta, 'an empty sticky opens as a textarea').toBeTruthy()
    expect(rightClick(ta)).toBe(false)
    expect(menuOpened).not.toHaveBeenCalled()
  })
})
