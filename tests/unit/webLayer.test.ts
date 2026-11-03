// lib/webLayer: a desk's live web pages outlive the view showing them.
//
// Owner, 2026-11-03: "I care about browser windows". Measured on their Day
// Trading desk (eleven real sites): canvas → Workcentre → canvas loaded every
// page three times — a <webview> that leaves the document is destroyed, and
// each view mounted its own. The layer keeps one page per surface for its
// whole life and hands it from view to view.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimWebview, disjointUnion, registerWebLayerHost, releaseWebview, webLayerShouldLoad, webLayerStats, WEB_LAYER_KEEP_MS } from '../../src/renderer/src/lib/webLayer'

type FakePage = HTMLElement & { setAudioMuted: ReturnType<typeof vi.fn>; getURL: () => string; loadURL: ReturnType<typeof vi.fn>; url: string }

let surface: HTMLDivElement
let layer: HTMLDivElement
let unregister: () => void
const created: FakePage[] = []
const realCreate = document.createElement.bind(document)

beforeEach(() => {
  vi.useFakeTimers()
  created.length = 0
  // A <webview> stand-in: records muting and loads, reports its address.
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = realCreate(tag) as FakePage
    if (tag === 'webview') {
      el.url = ''
      el.setAudioMuted = vi.fn()
      el.getURL = () => el.url
      el.loadURL = vi.fn(async (u: string) => {
        el.url = u
      })
      created.push(el)
    }
    return el
  }) as typeof document.createElement)
  surface = realCreate('div')
  layer = realCreate('div')
  surface.appendChild(layer)
  document.body.appendChild(surface)
  unregister = registerWebLayerHost(layer)
})
afterEach(() => {
  unregister()
  surface.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function slot(): HTMLDivElement {
  const s = realCreate('div')
  surface.appendChild(s)
  return s
}
const init = { src: 'https://www.tradingview.com/chart/', partition: 'persist:web' }

describe('one live page per surface, handed from view to view', () => {
  it('a view switch hands the SAME page over: created once, never reloaded', () => {
    const canvasSlot = slot()
    const first = claimWebview('w1', canvasSlot, init)!
    expect(first.adopted).toBe(false)
    expect(created).toHaveLength(1)
    expect(first.webview.getAttribute('src')).toBe(init.src)
    // Partition and popups are set before the guest attaches (read only then).
    expect(first.webview.getAttribute('partition')).toBe('persist:web')
    expect(first.webview.getAttribute('allowpopups')).toBe('true')

    // Canvas → Workcentre: the canvas slot goes, the Workcentre's appears.
    releaseWebview('w1', canvasSlot)
    canvasSlot.remove()
    const wcSlot = slot()
    const second = claimWebview('w1', wcSlot, init)!
    expect(second.adopted).toBe(true)
    expect(second.webview).toBe(first.webview)
    expect(created).toHaveLength(1)
    expect((first.webview as FakePage).loadURL).not.toHaveBeenCalled()
    // It never left the layer, so Electron never detached its guest.
    expect(first.webview.isConnected).toBe(true)
    expect(layer.contains(first.webview)).toBe(true)
  })

  it('a page with no slot is parked — hidden, muted, alive — and freed after the keep time', () => {
    const s = slot()
    const c = claimWebview('w1', s, init)!
    const page = c.webview as FakePage
    releaseWebview('w1', s)
    const wrapper = page.parentElement!
    expect(wrapper.style.visibility).toBe('hidden')
    expect(page.setAudioMuted).toHaveBeenLastCalledWith(true)
    expect(webLayerStats()).toEqual({ live: 1, shown: 0, parked: 1 })

    vi.advanceTimersByTime(WEB_LAYER_KEEP_MS - 10_000)
    expect(page.isConnected).toBe(true)
    // Claimed again within the window: the same page, unmuted.
    const back = claimWebview('w1', slot(), init)!
    expect(back.webview).toBe(page)
    expect(page.setAudioMuted).toHaveBeenLastCalledWith(false)

    releaseWebview('w1', back.webview.parentElement as HTMLDivElement) // not its slot: no effect
    expect(webLayerStats().shown).toBe(1)
  })

  it('freed once the keep time passes with no slot', () => {
    const s = slot()
    const page = claimWebview('w1', s, init)!.webview
    releaseWebview('w1', s)
    vi.advanceTimersByTime(WEB_LAYER_KEEP_MS + 6_000)
    expect(page.isConnected).toBe(false)
    expect(webLayerStats().live).toBe(0)
    // A later claim makes a fresh page.
    claimWebview('w1', slot(), init)
    expect(created).toHaveLength(2)
  })

  it('two slots at once: the newest shows it; when it goes, the older one has it back', () => {
    const a = slot()
    const b = slot()
    claimWebview('w1', a, init)
    claimWebview('w1', b, init)
    releaseWebview('w1', b)
    expect(webLayerStats()).toEqual({ live: 1, shown: 1, parked: 0 })
  })

  it('a different partition is a different guest: rebuilt, not reused', () => {
    const s = slot()
    const one = claimWebview('w1', s, init)!.webview
    releaseWebview('w1', s)
    const two = claimWebview('w1', slot(), { ...init, partition: 'persist:app-gmail' })!.webview
    expect(two).not.toBe(one)
    expect(one.isConnected).toBe(false)
  })

  it('outside a desk (no layer) there is nothing to claim: the surface renders inline', () => {
    const loose = realCreate('div')
    document.body.appendChild(loose)
    expect(claimWebview('panel', loose, init)).toBeNull()
    loose.remove()
  })

  it('the desk closing frees its pages', () => {
    const page = claimWebview('w1', slot(), init)!.webview
    unregister()
    expect(page.isConnected).toBe(false)
    unregister = registerWebLayerHost(layer)
  })
})

describe('a page loads only on a NEW request', () => {
  it('not for the address it was asked for, not where it already is; yes for a new one', () => {
    const page = claimWebview('w1', slot(), init)!.webview as FakePage
    page.url = init.src
    expect(webLayerShouldLoad('w1', init.src)).toBe(false)
    expect(webLayerShouldLoad('w1', 'https://finviz.com/news.php')).toBe(true)
    // Asked again for the same: no second load.
    expect(webLayerShouldLoad('w1', 'https://finviz.com/news.php')).toBe(false)
  })

  it('a view mounted with an address the page already moved past does not send it back', () => {
    const s = slot()
    const page = claimWebview('w1', s, init)!.webview as FakePage
    // The page moves on by itself (in-page navigation).
    page.url = 'https://www.tradingview.com/chart/?symbol=NASDAQ:AAPL'
    page.dispatchEvent(Object.assign(new Event('did-navigate-in-page'), { url: page.url, isMainFrame: true }))
    releaseWebview('w1', s)
    // The next view mounts with the saved (older) address.
    claimWebview('w1', slot(), init)
    expect(page.loadURL).not.toHaveBeenCalled()
  })

  it('an address chosen ELSEWHERE while it was parked (the focus view, an edit) is loaded on hand-over', () => {
    const s = slot()
    const page = claimWebview('w1', s, init)!.webview as FakePage
    page.url = init.src
    releaseWebview('w1', s)
    claimWebview('w1', slot(), { ...init, src: 'https://www.reuters.com/markets/' })
    expect(page.loadURL).toHaveBeenCalledWith('https://www.reuters.com/markets/')
  })
})

describe('holes in a page are merged before clipping', () => {
  // The clip is even-odd: two overlapping holes would fill each other back in
  // (seen live: lines of page drawn back inside a sticky's border).
  const area = (rs: Array<{ l: number; t: number; r: number; b: number }>): number => rs.reduce((a, q) => a + (q.r - q.l) * (q.b - q.t), 0)
  const overlaps = (rs: Array<{ l: number; t: number; r: number; b: number }>): boolean =>
    rs.some((a, i) => rs.some((b, j) => i < j && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b))

  it('overlapping holes become disjoint rectangles covering exactly their union', () => {
    const holes = [
      { l: 0, t: 0, r: 100, b: 100 },
      { l: 90, t: 90, r: 110, b: 110 },
      { l: 50, t: -5, r: 60, b: 5 }
    ]
    const u = disjointUnion(holes)
    expect(overlaps(u)).toBe(false)
    // 100×100 + the 20×20 corner square less its 10×10 overlap + nothing new from the third inside the first except its top 5px strip (10×5).
    expect(area(u)).toBe(10_000 + 400 - 100 + 50)
  })

  it('one hole, or none, passes through unchanged', () => {
    expect(disjointUnion([])).toEqual([])
    expect(disjointUnion([{ l: 1, t: 2, r: 3, b: 4 }])).toEqual([{ l: 1, t: 2, r: 3, b: 4 }])
  })
})
