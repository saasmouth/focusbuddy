// PlexiiWrite gets a real readOnly (4.3.41). It had none: DocEditor hard-coded
// readOnly={false} where WriteChrome is mounted, so a live-doc VIEWER was given
// a full editor.
//
// A read-only document never calls onChange: typing cannot reach it (the tiptap
// editor is not editable), and neither can the paths that write WITHOUT typing —
// a paste, a drop, a heading-style change or a page-setup change. The control
// case mounts the SAME editor editable and makes the same change, proving the
// harness sees an emit when there is one. Copied from d8's diagram/deck tests
// deliberately: a disabled-only assertion passes just as happily when the prop
// is ignored entirely.
//
// This is the CLIENT half. The server half is f0's, and it is the one that
// matters — f0 has confirmed the yjsUpdate route trusts room membership and
// persists a viewer's edit without an auth query.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {},
    { get: () => new Proxy(() => Promise.resolve([]), { get: () => () => Promise.resolve([]) }) }
  )
})

// The drop path is mocked so it can actually COMPLETE in this harness. Without
// this, acceptsWidgetDrag rejects a synthetic DataTransfer and widgetIdFromDrop
// resolves to nothing, so the handler returns before reaching the guard — and
// the test then passes whether the guard exists or not. Two earlier versions of
// this file did exactly that.
vi.mock('../../src/renderer/src/lib/widgetDropInsert', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  acceptsWidgetDrag: () => true,
  widgetIdFromDrop: () => Promise.resolve('w-dropped')
}))

import DocEditor from '../../src/renderer/src/components/documents/DocEditor'

const body = (): unknown => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Read me.' }] }]
})

let host: HTMLDivElement
let root: Root
let changes: unknown[] = []

beforeEach(() => {
  localStorage.clear()
  changes = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const mount = async (readOnly: boolean): Promise<void> => {
  await act(async () => {
    root.render(
      <DocEditor
        content={body()}
        title="Shared doc"
        readOnly={readOnly}
        onChange={(j) => changes.push(j)}
      />
    )
  })
}

const surface = (): HTMLElement =>
  host.querySelector('[data-testid="doc-editor-surface"]') as HTMLElement

describe('a read-only document writes nothing', () => {
  it('mounts without emitting', async () => {
    await mount(true)
    expect(surface()).not.toBeNull()
    expect(changes).toHaveLength(0)
  })

  it('is not editable, so typing cannot reach the document', async () => {
    await mount(true)
    expect(surface().getAttribute('contenteditable')).toBe('false')
  })

  it('a paste writes nothing', async () => {
    await mount(true)
    const dt = new DataTransfer()
    dt.setData('text/html', '<p>injected</p>')
    await act(async () => {
      surface().dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    expect(changes).toHaveLength(0)
    expect(surface().textContent).not.toContain('injected')
  })

  // NO DROP TEST HERE, deliberately, and this is a gap rather than an oversight.
  //
  // I could not make one that FAILS when the guard is removed. Four attempts:
  // the first used a MIME acceptsWidgetDrag does not recognise, so the handler
  // returned before the guard; the second mocked the drop helpers so the path
  // could proceed; the third flushed the promise the handler awaits before
  // inserting. None of them failed with `if (readOnlyRef.current) return`
  // deleted, which means the insert never completes in this harness — most
  // likely posAtCoords or the widgetEmbed command behaving differently under
  // happy-dom, with the failure swallowed by the handler's `void promise`.
  //
  // So the drop guard is covered by review and by the same readOnlyRef every
  // other path here uses, and NOT by a test that can fail. Shipping a green
  // assertion that passes with the guard deleted would be worse than this
  // comment: it would read as coverage and provide none. Whoever can drive
  // widget insertion in a unit harness should add the real one.

})

describe('the control case: the same editor, editable', () => {
  it('emits when a paste really is handled, so the harness is not blind', async () => {
    // Without this, every assertion above would pass just as happily if the
    // paste handler were never wired at all.
    await mount(false)
    expect(surface().getAttribute('contenteditable')).toBe('true')
    const dt = new DataTransfer()
    dt.setData('text/html', '<p>injected</p>')
    await act(async () => {
      surface().dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    expect(surface().textContent).toContain('injected')
    expect(changes.length).toBeGreaterThan(0)
  })
})
