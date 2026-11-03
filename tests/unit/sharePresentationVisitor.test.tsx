// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"disableJavaScriptFileLoading":true,"disableCSSFileLoading":true}}
// What a visitor to a share link sees, given the sender's presentation:
//   - each website as live, its official embed, a picture, or a link card
//     (EmbeddedSiteWidget), on a real mount;
//   - the view held where the sender locked it (stores/deskView);
//   - the renderer keying a visitor's layouts by the same id the share page
//     copies the sender's layout to (VISITOR_LAYOUT_USER).
//
// Frames are rendered but never loaded (the options above): a unit test has no
// business fetching finviz.com, and happy-dom otherwise would.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
vi.mock('../../src/renderer/src/lib/fileUrl', () => ({
  webBase: () => '/share/',
  fileSrc: (id: string) => `/share/fb-file/${encodeURIComponent(id)}`
}))

import EmbeddedSiteWidget from '../../src/renderer/src/components/widgets/EmbeddedSiteWidget'
import { markShareRecipient, setSharePresentation } from '../../src/renderer/src/lib/shareMode'
import { useDeskViewStore, resolveDeskView } from '../../src/renderer/src/stores/deskView'
import { VISITOR_LAYOUT_USER, type SharePresentation } from '../../src/shared/sitePresentation'
import type { Widget } from '../../src/shared/types'

const W = 'w-site'
const widget = (content: string, title = ''): Widget => ({ id: W, kind: 'webview', title, content }) as unknown as Widget

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
  setSharePresentation(null)
})

async function show(content: string, p: SharePresentation | null, title = ''): Promise<string> {
  markShareRecipient('tok')
  setSharePresentation(p)
  await act(async () => {
    root.render(<EmbeddedSiteWidget widget={widget(content, title)} />)
  })
  return host.querySelector('[data-testid="embedded-site"]')?.getAttribute('data-site-shows') ?? ''
}

describe('a website on a share page', () => {
  it('shows the picture the sender took, labelled with when, opening the real site', async () => {
    const at = new Date(2026, 10, 3, 12, 34).getTime()
    const kind = await show('https://finviz.com/futures', {
      sites: { [W]: { url: 'https://finviz.com/futures', show: 'picture', picture: { id: `sitepic-${W}`, width: 1440, height: 810, capturedAt: at } } }
    })
    expect(kind).toBe('picture')
    const img = host.querySelector('img')!
    expect(img.getAttribute('src')).toBe(`/share/fb-file/sitepic-${W}?v=${at}`)
    expect(img.getAttribute('alt')).toMatch(/A picture of finviz\.com, taken/)
    const a = host.querySelector('[data-testid="embedded-site-picture"]') as HTMLAnchorElement
    expect(a.getAttribute('href')).toBe('https://finviz.com/futures')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
    expect(host.querySelector('[data-testid="embedded-site-label"]')?.textContent).toMatch(/^Picture · /)
    expect(host.querySelector('iframe')).toBeNull()
  })

  it('falls back to a link card when the picture will not load, never a broken image', async () => {
    await show('https://finviz.com/futures', {
      sites: { [W]: { url: 'https://finviz.com/futures', show: 'picture', picture: { id: `sitepic-${W}`, width: 1, height: 1, capturedAt: 1 } } }
    })
    await act(async () => {
      host.querySelector('img')!.dispatchEvent(new Event('error'))
    })
    expect(host.querySelector('[data-testid="embedded-site"]')?.getAttribute('data-site-shows')).toBe('link')
    expect(host.querySelector('[data-testid="embedded-site-link-open"]')?.textContent).toBe('Open finviz.com ↗')
  })

  it('shows a link card, with the widget’s own title, when the sender chose no picture', async () => {
    const kind = await show(
      'https://www.reuters.com/business/',
      { sites: { [W]: { url: 'https://www.reuters.com/business/', show: 'link' } } },
      'Market news'
    )
    expect(kind).toBe('link')
    expect(host.textContent).toContain('Market news')
    expect(host.querySelector('iframe')).toBeNull()
  })

  it('frames a site the sender found allows it', async () => {
    const kind = await show('https://www.eia.gov/petroleum/weekly/', {
      sites: { [W]: { url: 'https://www.eia.gov/petroleum/weekly/', show: 'live' } }
    })
    expect(kind).toBe('frame')
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://www.eia.gov/petroleum/weekly/')
  })

  it('shows the official embed, worked out from the address and not taken from the link', async () => {
    const kind = await show('https://www.tradingview.com/chart/', {
      sites: { [W]: { url: 'https://www.tradingview.com/chart/', show: 'embed' } }
    })
    expect(kind).toBe('embed')
    const frame = host.querySelector('[data-testid="embedded-site-embed"]') as HTMLIFrameElement
    expect(frame.getAttribute('src')!.startsWith('https://s.tradingview.com/widgetembed/?')).toBe(true)
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation')
    expect(frame.getAttribute('referrerpolicy')).toBe('strict-origin')
    expect(host.querySelector('[data-testid="embedded-site-label"]')?.textContent).toBe('Live · TradingView')
  })

  it('an "embed" entry for a site with no embed of any kind is a link card, not a frame of whatever it says', async () => {
    const kind = await show('https://finance.yahoo.com/calendar/earnings', {
      sites: { [W]: { url: 'https://finance.yahoo.com/calendar/earnings', show: 'embed' } }
    })
    expect(kind).toBe('link')
  })

  it('a site that blocks frames but has a TradingView equivalent shows that, labelled, opening the original', async () => {
    const kind = await show('https://finviz.com/futures', { sites: { [W]: { url: 'https://finviz.com/futures', show: 'embed' } } })
    expect(kind).toBe('embed')
    const frame = host.querySelector('[data-testid="embedded-site-embed"]') as HTMLIFrameElement
    expect(frame.getAttribute('src')!.startsWith('https://www.tradingview-widget.com/embed-widget/market-overview/')).toBe(true)
    expect(frame.getAttribute('title')).toBe('TradingView markets board, standing in for finviz.com')
    expect(host.querySelector('[data-testid="embedded-site-label"]')?.textContent).toBe('Live · TradingView markets board')
    expect(host.querySelector('[data-testid="embedded-site-open"]')?.getAttribute('href')).toBe('https://finviz.com/futures')
  })

  it('ignores an entry made for another address, and uses the official embed where there is one', async () => {
    const p: SharePresentation = { sites: { [W]: { url: 'https://finviz.com/futures', show: 'link' } } }
    expect(await show('https://www.youtube.com/watch?v=dQw4w9WgXcQ', p)).toBe('embed')
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
  })

  it('with no presentation at all (a link already sent), uses an equivalent where there is one, else frames the site', async () => {
    expect(await show('https://finviz.com/screener/stocks?v=111', null)).toBe('embed')
    expect(host.querySelector('iframe')?.getAttribute('src')).toMatch(/^https:\/\/www\.tradingview-widget\.com\/embed-widget\/screener\//)
    expect(await show('https://finance.yahoo.com/calendar/earnings', null)).toBe('frame')
  })
})

describe('the view a share link holds', () => {
  beforeEach(() => {
    useDeskViewStore.setState({ modes: {}, defaults: {}, locked: {} })
  })

  it('a locked desk shows its view whatever was last used, and set/toggle leave it alone', () => {
    const s = useDeskViewStore.getState()
    s.set('desk', 'canvas')
    s.lock('desk', 'workcentre')
    expect(resolveDeskView(useDeskViewStore.getState(), 'desk')).toBe('workcentre')
    useDeskViewStore.getState().set('desk', 'columns')
    useDeskViewStore.getState().toggle('desk')
    expect(useDeskViewStore.getState().get('desk')).toBe('workcentre')
    expect(useDeskViewStore.getState().modes.desk).toBe('canvas')
  })

  it('an unlocked desk resolves last-used, then its default, then Canvas', () => {
    const s = useDeskViewStore.getState()
    expect(s.get('desk')).toBe('canvas')
    s.setDefault('desk', 'columns')
    expect(useDeskViewStore.getState().get('desk')).toBe('columns')
    useDeskViewStore.getState().set('desk', 'workcentre')
    expect(useDeskViewStore.getState().get('desk')).toBe('workcentre')
    expect(resolveDeskView(useDeskViewStore.getState(), null)).toBe('canvas')
  })

  it('the lock is never written to storage: it is the link’s rule, not the visitor’s preference', () => {
    useDeskViewStore.getState().lock('desk', 'columns')
    expect(localStorage.getItem('fb.deskView.v1') ?? '').not.toContain('columns')
  })
})

describe('the visitor’s layout id', () => {
  it("is the literal the renderer falls back to wherever it keys a layout", () => {
    const files = [
      'src/renderer/src/stores/widgets.ts',
      'src/renderer/src/components/Canvas.tsx',
      'src/renderer/src/components/views/WorkcentreView.tsx'
    ]
    for (const f of files) {
      const src = readFileSync(resolve(__dirname, '../..', f), 'utf8')
      expect(src, f).toContain(`?? '${VISITOR_LAYOUT_USER}'`)
    }
  })
})
