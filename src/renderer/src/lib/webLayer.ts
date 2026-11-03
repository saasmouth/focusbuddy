// Live web pages that survive the view around them (owner, 2026-11-03: "I care
// about browser windows").
//
// A <webview> that leaves the document is destroyed: Electron detaches its
// guest on disconnect and builds a new one on reconnect, so the page reloads.
// Every desk view (canvas, Workcentre, Columns) renders its own widget tree,
// so switching views unmounted every page and mounted it again. Measured on
// the owner's Day Trading desk (eleven real sites): canvas → Workcentre →
// canvas loaded every page three times, 33 loads for 11 pages, each losing
// its chart state, sign-in flow, scroll and drafts.
//
// So the page lives HERE, not in the view. Each canvas surface owns one web
// layer (components/browser/WebLayer); a BrowserSurface inside it renders an
// empty SLOT and claims its page from the layer by surface id. The layer keeps
// the <webview> in one place in the document for its whole life and, every
// frame, lays it over whichever slot currently shows it: position, the
// canvas's zoom (as a scale, exactly as the transformed desk applied it), the
// clipping of every scrolling ancestor, and holes for anything that paints
// above the page in its view (a widget on top of it, a dragged tile). A page
// whose slot goes away is parked: hidden and muted, still alive, until a slot
// claims it again — or for WEB_LAYER_KEEP_MS, after which it is freed.
//
// Surfaces outside a canvas surface (the web panel, Office's browser) find no
// layer and render their <webview> inline, as before.

/** How long a page with no slot stays alive before it is freed. */
export const WEB_LAYER_KEEP_MS = 60_000

/** The attribute on a layer's page wrapper naming the surface it belongs to. */
export const WEB_FOR_ATTR = 'data-web-for'
/** Set on a page wrapper while its slot sits inside a full-screen desk view. */
export const WEB_IN_DESK_VIEW_ATTR = 'data-web-in-desk-view'
/** Marks an element that must paint above any web page under it. */
export const WEB_OCCLUDER_ATTR = 'data-web-occluder'

/** Elements that stack against a page in its view: canvas widgets and Workcentre tiles. */
const STACK_SELECTOR = '[data-widget-id], [data-testid^="workcentre-tile-"]'
const DESK_VIEW_SELECTOR = '[data-desk-view-host]'

type PageEl = HTMLElement & {
  setAudioMuted?: (muted: boolean) => void
  getURL?: () => string
  loadURL?: (url: string) => Promise<void>
}

/** How many of a page's own addresses it remembers (see Entry.visited). */
const VISITED_MAX = 200

interface Entry {
  id: string
  host: HTMLElement
  wrapper: HTMLDivElement
  webview: PageEl
  overlayHost: HTMLDivElement
  partition: string
  /** The address this page was last ASKED to show (not where it has wandered). */
  askedSrc: string
  /** Slots that want this page; the last one shows it. */
  claims: HTMLElement[]
  parkedSince: number | null
  /** Last applied geometry, so an unchanged frame writes nothing. */
  sig: string
  /**
   * Addresses this page navigated to itself. A view that mounts with one of
   * them is behind the page (its saved address lags an in-page move), so it
   * must not send the page back; any other address was chosen elsewhere while
   * the page was parked (the focus view moved on, the URL was edited) and is
   * loaded.
   */
  visited: Set<string>
}

export interface WebLayerClaim {
  webview: HTMLElement
  /** Where the surface portals what it draws over its page. */
  overlayHost: HTMLElement
  /** True when an existing, live page was handed over (no load). */
  adopted: boolean
}

const entries = new Map<string, Entry>()
const hosts = new Set<HTMLElement>()
const clipAncestorCache = new WeakMap<HTMLElement, HTMLElement[]>()
let frame = 0
let sweepTimer: ReturnType<typeof setInterval> | null = null

/** Register a canvas surface's layer element. Returns the unregister (which frees its pages). */
export function registerWebLayerHost(el: HTMLElement): () => void {
  hosts.add(el)
  return () => {
    hosts.delete(el)
    for (const e of [...entries.values()]) if (e.host === el) destroy(e)
  }
}

function hostFor(slot: HTMLElement): HTMLElement | null {
  for (const h of hosts) {
    if (h.isConnected && h.parentElement && h.parentElement.contains(slot) && !h.contains(slot)) return h
  }
  return null
}

/**
 * Claim the live page for `id` and show it over `slot`. Creates it on first
 * claim; hands over the existing page (no reload) on every later one. Null
 * when the slot is not inside a canvas surface: render the page inline.
 */
export function claimWebview(id: string, slot: HTMLElement, init: { src: string; partition: string }): WebLayerClaim | null {
  const host = hostFor(slot)
  if (!host) return null
  let e = entries.get(id)
  // The partition is locked when the guest attaches; a page in another layer
  // cannot be moved there without reloading anyway.
  if (e && (e.partition !== init.partition || e.host !== host || !e.wrapper.isConnected)) {
    destroy(e)
    e = undefined
  }
  let adopted = true
  if (!e) {
    e = create(id, host, init)
    adopted = false
  } else {
    // Handing a page to a new view is not a request to navigate it, unless
    // the address it was mounted with was chosen somewhere else meanwhile.
    e.askedSrc = init.src
    catchUp(e, init.src)
  }
  e.claims = e.claims.filter((s) => s !== slot && s.isConnected)
  e.claims.push(slot)
  e.parkedSince = null
  e.sig = ''
  setMuted(e, false)
  ensureLoop()
  return { webview: e.webview, overlayHost: e.overlayHost, adopted }
}

/** The slot no longer shows the page. With no other slot, the page is parked. */
function catchUp(e: Entry, src: string): void {
  if (!src || !/^https?:\/\//i.test(src) || e.visited.has(src)) return
  let current = ''
  try {
    current = e.webview.getURL?.() ?? ''
  } catch {
    return // not attached yet: the src attribute is still loading
  }
  if (!current || current === src) return
  try {
    void e.webview.loadURL?.(src)
  } catch {
    // ignore: the next request retries
  }
}

export function releaseWebview(id: string, slot: HTMLElement): void {
  const e = entries.get(id)
  if (!e) return
  e.claims = e.claims.filter((s) => s !== slot)
  if (e.claims.length === 0) park(e)
  else e.sig = ''
}

/**
 * Should a layer page load `src`? Only when it is a NEW request: not the
 * address it was last asked for, and not where it already is.
 */
export function webLayerShouldLoad(id: string, src: string): boolean {
  const e = entries.get(id)
  if (!e) return true
  if (src === e.askedSrc) return false
  e.askedSrc = src
  try {
    if (e.webview.getURL?.() === src) return false
  } catch {
    // not attached yet: the src attribute loads it
  }
  return true
}

/** Test and diagnostics: the pages the layer holds. */
export function webLayerStats(): { live: number; shown: number; parked: number } {
  let shown = 0
  let parked = 0
  for (const e of entries.values()) {
    if (e.claims.length) shown++
    else parked++
  }
  return { live: entries.size, shown, parked }
}

function create(id: string, host: HTMLElement, init: { src: string; partition: string }): Entry {
  const wrapper = document.createElement('div')
  wrapper.className = 'fb-web-layer-page'
  wrapper.setAttribute(WEB_FOR_ATTR, id)
  wrapper.style.cssText =
    'position:absolute;left:0;top:0;width:0;height:0;visibility:hidden;transform-origin:0 0;pointer-events:auto'
  const webview = document.createElement('webview') as PageEl
  // Both are read when the guest attaches and ignored afterwards
  // (BrowserSurface's hard-won rules): set them before it is in the document.
  webview.setAttribute('partition', init.partition)
  webview.setAttribute('allowpopups', 'true')
  if (init.src) webview.setAttribute('src', init.src)
  webview.style.cssText = 'width:100%;height:100%;display:inline-flex'
  const overlayHost = document.createElement('div')
  overlayHost.className = 'fb-web-overlay'
  overlayHost.style.cssText = 'position:absolute;inset:0;pointer-events:none'
  wrapper.append(webview, overlayHost)
  host.appendChild(wrapper)
  const visited = new Set<string>()
  if (init.src) visited.add(init.src)
  const remember = (ev: Event): void => {
    const x = ev as Event & { url?: string; isMainFrame?: boolean }
    if (x.isMainFrame === false || !x.url) return
    visited.delete(x.url)
    visited.add(x.url)
    if (visited.size > VISITED_MAX) visited.delete(visited.values().next().value as string)
  }
  for (const name of ['did-navigate', 'did-navigate-in-page', 'did-redirect-navigation']) webview.addEventListener(name, remember)
  const e: Entry = {
    id,
    host,
    wrapper,
    webview,
    overlayHost,
    partition: init.partition,
    askedSrc: init.src,
    claims: [],
    parkedSince: null,
    sig: '',
    visited
  }
  entries.set(id, e)
  return e
}

function destroy(e: Entry): void {
  entries.delete(e.id)
  e.claims = []
  e.wrapper.remove()
  // Nothing left to sweep or lay out: stop both, so the next park or claim
  // starts them afresh instead of trusting a handle that may be gone.
  if (entries.size === 0) {
    if (sweepTimer) clearInterval(sweepTimer)
    sweepTimer = null
    if (frame) cancelAnimationFrame(frame)
    frame = 0
  }
}

function park(e: Entry): void {
  e.parkedSince = Date.now()
  e.sig = 'parked'
  e.wrapper.style.visibility = 'hidden'
  e.wrapper.style.clipPath = 'none'
  setMuted(e, true)
  if (!sweepTimer) sweepTimer = setInterval(sweep, 5_000)
}

function sweep(): void {
  const now = Date.now()
  let parked = 0
  for (const e of [...entries.values()]) {
    if (e.claims.length || e.parkedSince === null) continue
    if (now - e.parkedSince >= WEB_LAYER_KEEP_MS || !e.host.isConnected) destroy(e)
    else parked++
  }
  if (!parked && sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

function setMuted(e: Entry, muted: boolean): void {
  try {
    e.webview.setAudioMuted?.(muted)
  } catch {
    // before dom-ready: nothing is playing yet
  }
}

function ensureLoop(): void {
  if (!frame) frame = requestAnimationFrame(tick)
}

interface Rect {
  l: number
  t: number
  r: number
  b: number
}
const rectOf = (d: DOMRect): Rect => ({ l: d.left, t: d.top, r: d.right, b: d.bottom })
const intersect = (a: Rect, b: Rect): Rect => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) })
const isEmpty = (a: Rect): boolean => a.r - a.l < 0.5 || a.b - a.t < 0.5

/** Ancestors between the slot and the layer's surface that clip their content. */
function clipAncestors(slot: HTMLElement, host: HTMLElement): HTMLElement[] {
  const cached = clipAncestorCache.get(slot)
  if (cached) return cached
  const out: HTMLElement[] = []
  const stop = host.parentElement
  for (let el = slot.parentElement; el && el !== stop; el = el.parentElement) {
    const cs = getComputedStyle(el)
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') out.push(el)
  }
  clipAncestorCache.set(slot, out)
  return out
}

interface Stacker {
  el: HTMLElement
  rect: Rect
  z: number
}

function zOf(el: HTMLElement): number {
  const z = Number.parseInt(getComputedStyle(el).zIndex, 10)
  return Number.isFinite(z) ? z : 0
}

/** Does `b` paint above `a` among the view's stacking elements? */
function paintsAbove(b: Stacker, a: Stacker): boolean {
  if (b.z !== a.z) return b.z > a.z
  return (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

interface Geometry {
  sig: string
  hidden: boolean
  left: number
  top: number
  width: number
  height: number
  scale: number
  clip: string
  z: number
  inDeskView: boolean
  /**
   * The slot's own pointer-events. A view that makes its content
   * pointer-transparent (a Workcentre tile during a move, resize or drag-in
   * preview) must make the page transparent too, or the page's guest process
   * takes the pointer and the gesture stops under it.
   */
  pointer: string
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

interface Occluder {
  el: HTMLElement
  rect: Rect
}

function measure(e: Entry, slot: HTMLElement, stackers: Stacker[], occluders: Occluder[]): Geometry {
  const hidden: Geometry = { sig: 'hidden', hidden: true, left: 0, top: 0, width: 0, height: 0, scale: 1, clip: 'none', z: 0, inDeskView: false, pointer: 'none' }
  const w0 = slot.offsetWidth
  const h0 = slot.offsetHeight
  if (!w0 || !h0) return hidden
  const r = slot.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return hidden
  const hr = e.host.getBoundingClientRect()
  const scale = r.width / w0
  let vis = intersect(rectOf(r), rectOf(hr))
  for (const a of clipAncestors(slot, e.host)) vis = intersect(vis, rectOf(a.getBoundingClientRect()))
  if (isEmpty(vis)) return hidden

  // What paints above this page in its view.
  const ownEl = slot.closest<HTMLElement>(STACK_SELECTOR)
  const own = ownEl ? stackers.find((s) => s.el === ownEl) : undefined
  const holes: Rect[] = []
  if (own) {
    for (const s of stackers) {
      if (s === own || s.el.contains(ownEl) || ownEl!.contains(s.el)) continue
      if (!paintsAbove(s, own)) continue
      const h = intersect(s.rect, vis)
      if (!isEmpty(h)) holes.push(h)
    }
  }
  // An explicit occluder (a takeover, a handle) covers the pages UNDER it,
  // never one shown inside it.
  for (const o of occluders) {
    if (o.el.contains(slot)) continue
    const h = intersect(o.rect, vis)
    if (!isEmpty(h)) holes.push(h)
  }
  // Wholly covered: hide it, so the page is not composited for nothing.
  if (holes.some((h) => h.l <= vis.l + 0.5 && h.t <= vis.t + 0.5 && h.r >= vis.r - 0.5 && h.b >= vis.b - 0.5)) return hidden

  // To the page's own (unscaled) coordinates.
  const lx = (x: number): number => round((x - r.left) / scale)
  const ly = (y: number): number => round((y - r.top) / scale)
  const box = { l: lx(vis.l), t: ly(vis.t), r: lx(vis.r), b: ly(vis.b) }
  let clip: string
  if (holes.length === 0) {
    const insets = [box.t, round(w0 - box.r), round(h0 - box.b), box.l]
    clip = insets.every((v) => Math.abs(v) < 0.5) ? 'none' : `inset(${insets.map((v) => `${Math.max(0, v)}px`).join(' ')})`
  } else {
    // Even-odd: a point inside two overlapping holes would be filled again, so
    // the holes are merged into non-overlapping rectangles first.
    const rectPath = (q: Rect): string => `M${q.l} ${q.t}H${q.r}V${q.b}H${q.l}Z`
    const local = holes.map((h) => ({ l: lx(h.l), t: ly(h.t), r: lx(h.r), b: ly(h.b) }))
    clip = `path(evenodd, "${rectPath(box)}${disjointUnion(local).map(rectPath).join('')}")`
  }
  const left = round(r.left - hr.left)
  const top = round(r.top - hr.top)
  const z = own ? own.z : 0
  const inDeskView = !!slot.closest(DESK_VIEW_SELECTOR)
  const pointer = getComputedStyle(slot).pointerEvents === 'none' ? 'none' : 'auto'
  return {
    sig: [left, top, w0, h0, round(scale), clip, z, inDeskView, pointer].join('|'),
    hidden: false,
    left,
    top,
    width: w0,
    height: h0,
    scale,
    clip,
    z,
    inDeskView,
    pointer
  }
}

/**
 * The union of rectangles as non-overlapping rectangles: the plane is cut on
 * every edge, covered cells are kept, and runs along a row are joined. Holes
 * per page are few (widgets over it, a handle or two), so the grid is tiny.
 */
export function disjointUnion(rects: Rect[]): Rect[] {
  if (rects.length <= 1) return rects
  const xs = [...new Set(rects.flatMap((r) => [r.l, r.r]))].sort((a, b) => a - b)
  const ys = [...new Set(rects.flatMap((r) => [r.t, r.b]))].sort((a, b) => a - b)
  const out: Rect[] = []
  for (let j = 0; j < ys.length - 1; j++) {
    const t = ys[j]!
    const b = ys[j + 1]!
    let run: Rect | null = null
    for (let i = 0; i < xs.length - 1; i++) {
      const l = xs[i]!
      const r = xs[i + 1]!
      const covered = rects.some((q) => q.l <= l && q.r >= r && q.t <= t && q.b >= b)
      if (covered && run && run.r === l) run.r = r
      else if (covered) {
        run = { l, t, r, b }
        out.push(run)
      } else run = null
    }
  }
  return out
}

function apply(e: Entry, g: Geometry): void {
  const s = e.wrapper.style
  if (g.hidden) {
    s.visibility = 'hidden'
    return
  }
  s.left = `${g.left}px`
  s.top = `${g.top}px`
  s.width = `${g.width}px`
  s.height = `${g.height}px`
  s.transform = Math.abs(g.scale - 1) > 0.001 ? `scale(${g.scale})` : 'none'
  s.clipPath = g.clip
  s.zIndex = String(g.z)
  s.pointerEvents = g.pointer
  s.visibility = 'visible'
  if (g.inDeskView) e.wrapper.setAttribute(WEB_IN_DESK_VIEW_ATTR, '')
  else e.wrapper.removeAttribute(WEB_IN_DESK_VIEW_ATTR)
}

function tick(): void {
  frame = 0
  // Collect every stacking element and explicit occluder once per frame, for
  // all pages (reads first, writes after: one layout per frame).
  const byHost = new Map<HTMLElement, { stackers: Stacker[]; occluders: Occluder[] }>()
  const context = (host: HTMLElement): { stackers: Stacker[]; occluders: Occluder[] } => {
    let c = byHost.get(host)
    if (c) return c
    const root = host.parentElement
    const stackers: Stacker[] = []
    const occluders: Occluder[] = []
    if (root) {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(STACK_SELECTOR))) {
        if (host.contains(el)) continue
        const d = el.getBoundingClientRect()
        if (d.width < 1 || d.height < 1) continue
        stackers.push({ el, rect: rectOf(d), z: zOf(el) })
      }
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${WEB_OCCLUDER_ATTR}]`))) {
        if (host.contains(el)) continue
        const d = el.getBoundingClientRect()
        if (d.width >= 1 && d.height >= 1) occluders.push({ el, rect: rectOf(d) })
      }
    }
    c = { stackers, occluders }
    byHost.set(host, c)
    return c
  }
  const writes: Array<[Entry, Geometry]> = []
  let showing = false
  for (const e of entries.values()) {
    while (e.claims.length && !e.claims[e.claims.length - 1]!.isConnected) e.claims.pop()
    if (!e.claims.length) {
      if (e.parkedSince === null) park(e)
      continue
    }
    showing = true
    const slot = e.claims[e.claims.length - 1]!
    const { stackers, occluders } = context(e.host)
    const g = measure(e, slot, stackers, occluders)
    if (g.sig !== e.sig) {
      e.sig = g.sig
      writes.push([e, g])
    }
  }
  for (const [e, g] of writes) apply(e, g)
  if (showing) frame = requestAnimationFrame(tick)
}
