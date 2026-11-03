// "Something broke in the UI — Minified React error #185" (owner, 2026-11-03).
// Both crashes' stacks end in BrowserSurface's <webview> ref callback calling
// the parent's setter. The callback was a new function on every render, so
// React detached it (null) and re-attached it (the element) on EVERY render —
// two state updates in the commit phase for each re-render of a web page. On a
// desk of busy pages that is what tipped a burst of renders over React's nested
// update limit. The element is reported when it appears and when it goes, and
// at no other time.
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/browser/EnginePickerChip', () => ({ default: () => null }))

import BrowserSurface from '../../src/renderer/src/components/browser/BrowserSurface'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = {
    history: { record: vi.fn() },
    webview: { onLinkClicked: vi.fn(() => () => undefined) },
    files: { openExternal: vi.fn() }
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('BrowserSurface reports its <webview> element only when it changes', () => {
  it('once on mount, never on a re-render, once (null) on unmount', () => {
    const seen: string[] = []
    const onWebviewEl = (el: HTMLElement | null): void => {
      seen.push(el ? el.tagName.toLowerCase() : 'null')
    }
    const render = (cls: string): void =>
      act(() => root.render(<BrowserSurface surfaceId="w1" src="https://example.com/" partition="persist:t" onWebviewEl={onWebviewEl} toolbarClassName={cls} />))
    render('a')
    expect(seen).toEqual(['webview'])
    for (let i = 0; i < 5; i++) render(`c${i}`) // re-renders, as a busy desk causes
    expect(seen, 'no detach/attach churn on re-render').toEqual(['webview'])
    act(() => root.unmount())
    root = createRoot(host)
    expect(seen.at(-1)).toBe('null')
  })

  it('a parent keeping the element in state is not re-rendered by its own child', () => {
    // The shape of every real parent (WebViewWidget, WebPanel, OfficeBrowser):
    // onWebviewEl={setWvEl}. Re-render the parent for an unrelated reason and
    // count how often it renders: with the churning ref each parent render set
    // its own state twice from the child's commit (null, element) and rendered
    // again; with a stable ref it renders once per cause.
    let parentRenders = 0
    let bump: () => void = () => undefined
    function Parent(): JSX.Element {
      const [, setEl] = useState<HTMLElement | null>(null)
      const [tick, setTick] = useState(0)
      bump = () => setTick((t) => t + 1)
      parentRenders++
      return <BrowserSurface surfaceId="w2" src="https://example.com/" partition="persist:t" onWebviewEl={setEl} toolbarClassName={`t${tick}`} />
    }
    act(() => root.render(<Parent />))
    const afterMount = parentRenders
    for (let i = 0; i < 10; i++) act(() => bump())
    expect(parentRenders - afterMount, 'one render per bump, nothing fed back').toBe(10)
  })
})
