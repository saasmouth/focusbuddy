// PlexiBuild buttons that "Open a link".
//
// The address is whatever the app's author typed -- and on the public share
// page, the app's author is whoever minted the link. Preview used to call
// window.open(url, '_blank') on it as-is: javascript: ran in the page's own
// origin, and the opened tab kept window.opener and got the page's URL (share
// token included) as its Referer.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
// The view's stores pull in the whole app graph; the two leaf components under
// test take everything they need as props.
vi.mock('../../src/renderer/src/stores/apps', () => ({ useAppsStore: () => undefined }))
vi.mock('../../src/renderer/src/stores/quickCreate', () => ({ useQuickCreate: () => undefined }))
vi.mock('../../src/renderer/src/hooks/useLandOnContent', () => ({ useLandOnContent: () => undefined }))
vi.mock('../../src/renderer/src/components/ModuleDashboard', () => ({ default: () => null }))

import { BuildComponent, PreviewComponent } from '../../src/renderer/src/components/views/PlexiBuildView'
import type { AppComponent } from '../../src/shared/apps'

const button = (url: string): AppComponent => ({ id: 'c1', type: 'button', label: 'Go', action: { kind: 'link', url } })

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
  vi.restoreAllMocks()
})

const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('PlexiBuild preview button', () => {
  it('opens an http(s) link in a new tab with noopener and noreferrer', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    await act(async () => root.render(<PreviewComponent c={button('https://example.com/book')} />))
    await click(host.querySelector('button')!)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('https://example.com/book', '_blank', 'noopener,noreferrer')
  })

  it.each(['javascript:alert(document.cookie)', 'data:text/html,<script>alert(1)</script>', 'https://u:p@example.com', 'fb-file://abc'])(
    'opens nothing for %s, and says why on hover',
    async (url) => {
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      await act(async () => root.render(<PreviewComponent c={button(url)} />))
      const btn = host.querySelector('button')!
      await click(btn)
      expect(open).not.toHaveBeenCalled()
      expect(btn.getAttribute('title')).toMatch(/cannot be opened/)
    }
  )
})

describe('PlexiBuild build mode', () => {
  const props = { first: true, last: true, onPatch: () => {}, onRemove: () => {}, onMove: () => {} }

  it('warns, where it can be fixed, that a non-web address will not open', async () => {
    await act(async () => root.render(<BuildComponent c={button('javascript:alert(1)')} {...props} />))
    expect(host.querySelector('[data-testid="plexibuild-link-refused"]')?.textContent).toMatch(/http or https/)
  })

  it('says nothing for a web address', async () => {
    await act(async () => root.render(<BuildComponent c={button('https://example.com')} {...props} />))
    expect(host.querySelector('[data-testid="plexibuild-link-refused"]')).toBeNull()
  })
})
