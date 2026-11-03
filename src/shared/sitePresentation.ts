// How a shared desk is presented to someone who opens its link: which view it
// opens in, whether they may switch, and what each website on it shows.
//
// Two problems this exists to solve, both visible on a real standing link (a
// day-trading desk, 11 websites out of 21 widgets, 2026-11-03):
//
//   1. Websites. On the desktop a browser widget is an Electron <webview>, a
//      real browser that can show any site. On the share page it can only be an
//      <iframe>, and most sites forbid being framed (X-Frame-Options or a CSP
//      frame-ancestors policy). Of those 11, nine refused: the visitor saw nine
//      "refused to connect" pages. There is no way around that refusal from the
//      page, and proxying other companies' pages through our own domain would
//      be worse than the blank (their logins break, bot walls trip, and our
//      domain starts serving look-alikes of theirs). So the SENDER's desktop,
//      which can load any site, decides per site when the link is made:
//
//        live     the site permits framing: shown live, as now
//        embed    the site has an official embeddable version (a YouTube
//                 player, a TradingView chart widget): that is shown live
//        picture  neither: a picture of the page, taken in a clean signed-out
//                 window so none of the sender's accounts can appear in it,
//                 labelled as a picture, one click from the real site
//        link     no usable picture (the site turned the visit away, or the
//                 sender chose not to include one): a card that opens the site
//
//   2. Views. A desk's view (canvas, workcentre, columns) and the columns and
//      workcentre arrangements were the sender's local preferences, so every
//      visitor landed on the free canvas, and a workcentre arranged for them
//      came up auto-arranged with the tiles the sender had hidden showing. The
//      sender now picks the view the link opens in, and can lock it.
//
// Everything here is pure: the desktop main process (taking pictures, packing
// the bundle), the renderer (the share sheet, the widget) and the share page's
// Worker all read it.
import { toHttpUrl } from './safeUrl'

/** The views a link can open in. The data views (list, table…) are not offered. */
export type ShareView = 'canvas' | 'workcentre' | 'columns'

export const SHARE_VIEWS: ReadonlyArray<{ id: ShareView; label: string; blurb: string }> = [
  { id: 'canvas', label: 'Canvas', blurb: 'The free canvas, as you lay it out.' },
  { id: 'workcentre', label: 'Workcentre', blurb: 'Your dashboard of tiles, as you arranged it.' },
  { id: 'columns', label: 'Columns', blurb: 'Your columns, grouped as you set them.' }
]

export function isShareView(v: unknown): v is ShareView {
  return v === 'canvas' || v === 'workcentre' || v === 'columns'
}

/** What one website widget shows on the share page. See the header. */
export type SiteShow = 'live' | 'embed' | 'picture' | 'link'

/** What the sender asked for one site. 'auto' is the best the site allows. */
export type SiteChoice = 'auto' | 'live' | 'picture' | 'link'

export function isSiteChoice(v: unknown): v is SiteChoice {
  return v === 'auto' || v === 'live' || v === 'picture' || v === 'link'
}

/** A picture as the visitor's copy keeps it: bytes in the file store, under `id`. */
export interface SitePicture {
  id: string
  width: number
  height: number
  /** When the picture was taken (ms). Shown to the visitor: a picture is a moment. */
  capturedAt: number
}

/** A picture as it travels in a bundle: the same, plus its bytes. */
export interface BundledSitePicture extends SitePicture {
  ext: '.jpg'
  mimeType: 'image/jpeg'
  sizeBytes: number
  /** base64 of the JPEG. */
  data: string
}

export interface SitePresentation {
  /** The address this was decided for. A widget that now says something else is not covered by it. */
  url: string
  show: SiteShow
  picture?: SitePicture
}

export interface BundledSitePresentation {
  url: string
  show: SiteShow
  picture?: BundledSitePicture
}

/** Presentation as the visitor's copy keeps it (pictures are in the file store). */
export interface SharePresentation {
  view?: ShareView
  /** Only `view`: the visitor cannot switch to another view. */
  lockView?: boolean
  /** The sender's Columns setup for this desk (DeskColumnsConfig), when it has one. */
  columns?: Record<string, unknown>
  /** Keyed by widget id. */
  sites?: Record<string, SitePresentation>
}

/** Presentation as it travels in a bundle. */
export interface BundledPresentation {
  view?: ShareView
  lockView?: boolean
  columns?: Record<string, unknown>
  /**
   * Whose desk_layouts row is the sender's. Layouts are stored per account, and
   * a visitor has none, so the share page copies this row to its own ('local')
   * -- otherwise the visitor's workcentre is an auto-arrangement.
   */
  layoutUserId?: string
  sites?: Record<string, BundledSitePresentation>
}

/** What the share sheet sends the main process when a link is made or updated. */
export interface SharePresentationRequest {
  view?: ShareView
  lockView?: boolean
  columns?: Record<string, unknown>
  layoutUserId?: string
  /** Widget id -> what the sender chose. A website widget not named here is 'auto'. */
  sites?: Record<string, SiteChoice>
  /** Origin of the page links open on (https://plexiidesk.com), for the framing check. */
  embedderOrigin?: string
}

/**
 * The account id a share visitor's layouts are stored under. A visitor has no
 * account, and the renderer falls back to this literal wherever it keys a
 * layout (stores/widgets.ts, Canvas.tsx, WorkcentreView.tsx);
 * tests/unit/sharePresentationVisitor.test.ts holds the two together.
 */
export const VISITOR_LAYOUT_USER = 'local'

// ── how the share page frames a site ───────────────────────────────────────
//
// Here rather than in EmbeddedSiteWidget so the sender's desktop can test a site
// in exactly the frame a visitor's browser will put it in (sitePreview.ts).
// The reasoning for each flag is on the widget, which re-exports these.

export const EMBED_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
export const EMBED_SANDBOX_SAME_ORIGIN = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'
export const EMBED_REFERRER_POLICY = 'strict-origin' as const

// ── which widgets are websites ─────────────────────────────────────────────

/**
 * Kinds that store a web address and render as a website on the share page
 * (renderWidget sends them all to EmbeddedSiteWidget there). 'pdf' is not one:
 * it stores a Drive file id.
 */
export const WEBSITE_KINDS: ReadonlySet<string> = new Set(['webview', 'gdoc', 'gsheet', 'gslide', 'email'])

export function isWebsiteWidget(w: { kind: string; content?: string | null }): boolean {
  return WEBSITE_KINDS.has(w.kind) && toHttpUrl((w.content ?? '').trim()) !== null
}

// ── pictures ───────────────────────────────────────────────────────────────

/** Ids the file store and the share page's file server accept. Same as deskBundle.SAFE_FILE_ID. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/

/**
 * The file id a widget's picture is stored under. Derived from the widget, so a
 * desk's pictures are found from its widgets alone when the desk is replaced or
 * removed -- no list to keep in step.
 */
export function sitePictureId(widgetId: string): string | null {
  const id = `sitepic-${widgetId}`
  return SAFE_ID.test(id) ? id : null
}

/** Largest picture a bundle carries, after resizing (bytes). A busy page at 1440px is ~170 KB. */
export const MAX_SITE_PICTURE_BYTES = 600 * 1024
/** Width a picture is resized down to. Matches the widest common browser widget. */
export const SITE_PICTURE_WIDTH = 1440

// ── framing ────────────────────────────────────────────────────────────────

type HeaderValue = string | string[] | undefined | null

function headerList(headers: Record<string, HeaderValue>, name: string): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== name) continue
    if (Array.isArray(v)) out.push(...v.map(String))
    else if (v != null) out.push(String(v))
  }
  return out
}

/** Does one frame-ancestors source list let `embedder` frame the page? */
function ancestorsAllow(sources: string[], embedder: URL | null): boolean {
  if (sources.length === 0) return false // an empty list is 'none'
  for (const raw of sources) {
    const s = raw.trim()
    const lower = s.toLowerCase()
    if (lower === "'none'") return false
    if (lower === '*') return true
    if (!embedder) continue
    if (lower === "'self'") continue // the site's own origin, never ours
    if (lower === 'https:' || lower === 'https://') {
      if (embedder.protocol === 'https:') return true
      continue
    }
    // A host source: [scheme://]host[:port][/path]. Paths do not matter for
    // frame-ancestors matching of an origin.
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?/i.exec(s)
    if (!m) continue
    const [, scheme, wildcard, host, port] = m
    if (scheme && scheme.toLowerCase() + ':' !== embedder.protocol) continue
    if (!scheme && embedder.protocol !== 'https:' && embedder.protocol !== 'http:') continue
    const want = host.toLowerCase()
    const have = embedder.hostname.toLowerCase()
    const hostOk = wildcard ? have.endsWith('.' + want) : have === want
    if (!hostOk) continue
    if (port && port !== '*') {
      const effective = embedder.port || (embedder.protocol === 'https:' ? '443' : '80')
      if (port !== effective) continue
    }
    return true
  }
  return false
}

/**
 * May a page with these response headers be framed by `embedderOrigin`?
 *
 * The rules browsers apply: when any enforced Content-Security-Policy carries
 * frame-ancestors, those decide and X-Frame-Options is ignored; every policy
 * that has one must allow the embedder. Otherwise X-Frame-Options DENY or
 * SAMEORIGIN refuses (ALLOW-FROM is not supported by browsers, which ignore it).
 * Report-Only policies enforce nothing.
 */
export function frameVerdict(headers: Record<string, HeaderValue>, embedderOrigin: string): 'allowed' | 'refused' {
  let embedder: URL | null = null
  try {
    embedder = embedderOrigin ? new URL(embedderOrigin) : null
  } catch {
    embedder = null
  }
  const policies = headerList(headers, 'content-security-policy')
    .flatMap((v) => v.split(','))
    .map((p) =>
      p
        .split(';')
        .map((d) => d.trim())
        .find((d) => /^frame-ancestors(\s|$)/i.test(d))
    )
    .filter((d): d is string => typeof d === 'string')
  if (policies.length > 0) {
    const ok = policies.every((d) => ancestorsAllow(d.split(/\s+/).slice(1).filter(Boolean), embedder))
    return ok ? 'allowed' : 'refused'
  }
  const xfo = headerList(headers, 'x-frame-options').join(',').toLowerCase()
  if (/\b(deny|sameorigin)\b/.test(xfo)) return 'refused'
  return 'allowed'
}

/**
 * Why a clean visit produced no usable picture, in words for the sender, or null
 * when the page answered normally. The status is the main frame's last one: a
 * bot wall answers 401/403 with a "verify you are human" page, a rate limit 429,
 * and a picture of either would be a picture of a refusal.
 */
export function pictureRefusal(status: number | null | undefined, host: string): string | null {
  if (status == null || status === 0) return null
  if (status >= 200 && status < 400) return null
  if (status === 401 || status === 403) return `${host} asked for a human check, so no picture could be taken.`
  if (status === 429) return `${host} turned the visit away (too many visits). Try again later.`
  if (status === 404 || status === 410) return `${host} said the page does not exist.`
  if (status >= 500) return `${host} had a problem showing the page just now.`
  return `${host} refused the visit (${status}).`
}

// ── official embeds ────────────────────────────────────────────────────────

const YT_ID = /^[A-Za-z0-9_-]{11}$/

/** "90", "1m30s", "1h2m3s" -> seconds; null when it is none of those. */
function seconds(raw: string | null): number | null {
  if (!raw) return null
  if (/^\d+$/.test(raw)) return Number(raw)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw)
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

function youtube(u: URL): string | null {
  const host = u.hostname.replace(/^(www|m|music)\./, '')
  let id: string | null = null
  if (host === 'youtu.be') id = u.pathname.split('/')[1] ?? null
  else if (host === 'youtube.com') {
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts[0] === 'watch') id = u.searchParams.get('v')
    else if (parts[0] === 'shorts' || parts[0] === 'live') id = parts[1] ?? null
    else if (parts[0] === 'playlist') {
      const list = u.searchParams.get('list')
      return list && /^[A-Za-z0-9_-]{2,64}$/.test(list)
        ? `https://www.youtube-nocookie.com/embed/videoseries?list=${list}`
        : null
    }
  } else return null
  if (!id || !YT_ID.test(id)) return null
  const start = seconds(u.searchParams.get('t') ?? u.searchParams.get('start'))
  return `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`
}

function vimeo(u: URL): string | null {
  if (u.hostname.replace(/^www\./, '') !== 'vimeo.com') return null
  const m = /^\/(\d{3,12})(?:\/([0-9a-f]{6,20}))?\/?$/.exec(u.pathname)
  if (!m) return null
  return `https://player.vimeo.com/video/${m[1]}${m[2] ? `?h=${m[2]}` : ''}`
}

function loom(u: URL): string | null {
  if (u.hostname.replace(/^www\./, '') !== 'loom.com') return null
  const m = /^\/share\/([0-9a-f]{32})\/?$/.exec(u.pathname)
  return m ? `https://www.loom.com/embed/${m[1]}` : null
}

function spotify(u: URL): string | null {
  if (u.hostname !== 'open.spotify.com') return null
  const m = /^\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{22})\/?$/.exec(u.pathname)
  return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}` : null
}

const TV_SYMBOL = /^[A-Za-z0-9_.!]{1,20}(?::[A-Za-z0-9_.!-]{1,30})?$/

/**
 * TradingView's own chart widget -- the iframe their embed script creates. The
 * symbol comes from the address when it names one (?symbol=NASDAQ:AAPL or
 * /symbols/NASDAQ-AAPL/); otherwise TradingView's own default is used, which is
 * what a signed-out visitor to tradingview.com/chart/ sees anyway.
 */
function tradingview(u: URL): string | null {
  if (u.hostname.replace(/^(www|[a-z]{2})\./, '') !== 'tradingview.com') return null
  const parts = u.pathname.split('/').filter(Boolean)
  let symbol: string | null = null
  if (parts[0] === 'chart') symbol = u.searchParams.get('symbol')
  else if (parts[0] === 'symbols' && parts[1]) {
    const dash = parts[1].indexOf('-')
    symbol = dash > 0 ? `${parts[1].slice(0, dash)}:${parts[1].slice(dash + 1)}` : parts[1]
  } else return null
  const params = new URLSearchParams({
    interval: 'D',
    symboledit: '1',
    saveimage: '0',
    hideideas: '1',
    theme: 'light',
    style: '1',
    timezone: 'exchange',
    withdateranges: '1',
    locale: 'en'
  })
  if (symbol && TV_SYMBOL.test(symbol)) params.set('symbol', symbol.toUpperCase())
  return `https://s.tradingview.com/widgetembed/?${params.toString()}`
}

const PROVIDERS: Array<{ name: string; embed: (u: URL) => string | null }> = [
  { name: 'YouTube', embed: youtube },
  { name: 'Vimeo', embed: vimeo },
  { name: 'Loom', embed: loom },
  { name: 'Spotify', embed: spotify },
  { name: 'TradingView', embed: tradingview }
]

/**
 * The official embeddable version of a page, when its site publishes one and
 * permits framing it (each was checked: no X-Frame-Options, no frame-ancestors).
 * Null for everything else, including addresses that are already embeds.
 */
export function officialEmbedFor(raw: string | null | undefined): { embedUrl: string; provider: string } | null {
  const u = toHttpUrl((raw ?? '').trim())
  if (!u || u.protocol !== 'https:') return null
  for (const p of PROVIDERS) {
    const embedUrl = p.embed(u)
    if (embedUrl) return { embedUrl, provider: p.name }
  }
  return null
}

// ── reading a presentation that arrived in a link ──────────────────────────

const MAX_COLUMNS_JSON = 64 * 1024

function finitePositive(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : null
}

/**
 * The presentation a bundle carries, reduced to what is well-formed. The bundle
 * came from whoever made the link, so nothing in it is trusted: a site entry
 * must name a widget of this desk and an http(s) address; a picture must sit
 * under the id derived from its widget (so a bundle cannot point one widget at
 * another's picture, or at a Drive file); the columns setup must be a plain
 * object of modest size. Anything else is dropped, never repaired. Null when
 * nothing usable is left.
 */
export function readPresentation(raw: unknown, widgetIds: ReadonlySet<string> | null): SharePresentation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const out: SharePresentation = {}
  if (isShareView(r.view)) out.view = r.view
  if (out.view && r.lockView === true) out.lockView = true
  if (r.columns && typeof r.columns === 'object' && !Array.isArray(r.columns)) {
    try {
      if (JSON.stringify(r.columns).length <= MAX_COLUMNS_JSON) out.columns = r.columns as Record<string, unknown>
    } catch {
      /* not serialisable: dropped */
    }
  }
  if (r.sites && typeof r.sites === 'object' && !Array.isArray(r.sites)) {
    const sites: Record<string, SitePresentation> = {}
    for (const [wid, v] of Object.entries(r.sites as Record<string, unknown>)) {
      if (!SAFE_ID.test(wid) || (widgetIds && !widgetIds.has(wid))) continue
      if (!v || typeof v !== 'object') continue
      const s = v as Record<string, unknown>
      const url = toHttpUrl(typeof s.url === 'string' ? s.url : '')
      if (!url) continue
      const show = s.show
      if (show !== 'live' && show !== 'embed' && show !== 'picture' && show !== 'link') continue
      const entry: SitePresentation = { url: url.href, show }
      if (show === 'picture') {
        const p = (s.picture ?? null) as Record<string, unknown> | null
        const id = sitePictureId(wid)
        const width = finitePositive(p?.width, 20000)
        const height = finitePositive(p?.height, 20000)
        const capturedAt = finitePositive(p?.capturedAt, 8.64e15)
        if (!p || !id || p.id !== id || !width || !height || !capturedAt) {
          // A picture entry without a usable picture is a link card, not a blank.
          entry.show = 'link'
        } else {
          entry.picture = { id, width, height, capturedAt }
        }
      }
      sites[wid] = entry
    }
    if (Object.keys(sites).length) out.sites = sites
  }
  return Object.keys(out).length ? out : null
}

/** The site entry that covers this widget as it is now, or null. */
export function siteEntryFor(
  p: SharePresentation | null | undefined,
  widget: { id: string; content?: string | null }
): SitePresentation | null {
  const entry = p?.sites?.[widget.id]
  if (!entry) return null
  const now = toHttpUrl((widget.content ?? '').trim())
  return now && now.href === entry.url ? entry : null
}
