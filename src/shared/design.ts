// PlexiDesign: the free-form page designer — somewhere between Microsoft
// Publisher and Adobe InDesign. A design is a multi-page document of
// arbitrary-size pages built from freely-placed elements (text, image, shape,
// line), reusing the proven slide element engine and renderer.
//
// What makes it a LAYOUT program rather than a poster tool lives here:
//
//   master pages   a page can inherit a master's furniture (running heads,
//                  folios, rules) which draws beneath its own elements
//   threaded text  a story pours through a chain of linked frames and reports
//                  overset rather than dropping what will not fit
//   text wrap      objects push story text aside instead of sitting on top of it
//   guides         margins, a column grid, and draggable ruler guides
//   layers         named document layers with their own visibility and locks
//   facing pages   spreads, so a booklet is laid out the way it is read
//   print output   bleed and crop marks (already present, and now per-page)
//
// This module is the pure core: the body shape, the size presets, the brand-aware
// starter templates, and the HTML rendering the exporter captures.

import type { SlideElement, SlideFill, SlideTextElement, SlideShapeElement } from './types'
import { hasPageToken, resolvePageTokens } from './designFlow'
import { normalizeContent, parsePlainText, type ContentDoc } from './designContent'
import { type OrgBrandKit, DEFAULT_BRAND_KIT, readableTextOn, contrastRatio, hexToRgb } from './brandKit'
import { fillToCss, gradient } from './fills'
import { chartToSvg } from './chart'

export interface DesignBody {
  schemaVersion: 1
  // The canvas size in logical px. Any size is allowed; presets are a convenience.
  width: number
  height: number
  background?: SlideFill
  elements: SlideElement[]
  // The size/template family this design started from, for the picker UI.
  category?: DesignCategory
  // True once the brand kit has been applied, so the UI can show the state.
  brandApplied?: boolean
  // Print bleed in logical px — the extra printed area beyond the trim edge that
  // a print shop cuts off. 0 (or absent) means no bleed. When > 0, the print
  // export extends the background into the bleed and adds crop marks.
  bleed?: number
  // Multi-page documents (booklets, brochures). Every page shares the doc's
  // width/height. pages[activePage] mirrors the top-level background/elements, so
  // single-page code paths and older readers still work; the page rail switches
  // which page is live. Legacy single-page bodies migrate to one page on load.
  pages?: DesignPage[]
  activePage?: number
  // ── Page-layout state ──────────────────────────────────────────────────────
  /** Master pages available to this document. */
  masters?: DesignMaster[]
  /** Ruler guides the author has dragged out. */
  guides?: DesignGuides
  /** The margin box drawn on every page; also the default text-frame column. */
  margins?: DesignMargins
  /** The column grid inside the margin box. */
  columns?: DesignColumnGrid
  /** Named layers. Absent means a single implicit base layer. */
  layers?: DesignLayer[]
  /** Facing pages: pages are laid out and previewed as spreads. */
  facing?: boolean
  /**
   * Threaded stories, keyed by story id. A story is a structured DOCUMENT — a
   * sequence of typed blocks (headings, body, lists, quotes) — not a lump of
   * text, which is what lets one thread carry a 40pt heading and 10pt body and
   * still flow as a single chain. It lives here ONCE; each frame renders the
   * slice the flow engine gives it, so re-flowing after a geometry change is a
   * pure recomputation rather than a risky redistribution of text.
   */
  stories?: Record<string, ContentDoc>
  /** The auto-layout style this document was last built with, for re-running it. */
  layoutStyleId?: string
  /**
   * The document the wizard laid out, kept whole so a re-run with a different
   * look is lossless. The story holds only the FLOWING blocks — the title and
   * subtitle become display type on the opener — so without this, reopening the
   * wizard would quietly lose the headline.
   */
  sourceContent?: ContentDoc
  /** The number printed on the first page. Defaults to 1. */
  pageNumberStart?: number
  /** Which master is being edited, or null when editing normal pages. */
  editingMasterId?: string | null
}

export interface DesignPage {
  id: string
  background?: SlideFill
  elements: SlideElement[]
  /**
   * The master this page inherits. `undefined` means "the document default"
   * (the first master, if there is one); `null` means the author explicitly
   * detached this page, which is why the two are not collapsed.
   */
  masterId?: string | null
}

/**
 * A master page: furniture that repeats across pages. Its elements are drawn
 * BENEATH the page's own and are not selectable while editing a normal page, so
 * a running head cannot be nudged by accident.
 */
export interface DesignMaster {
  id: string
  name: string
  background?: SlideFill
  elements: SlideElement[]
  /**
   * For a facing-pages document, which side this master applies to. 'both' is
   * the default and is what a single-sided document uses.
   */
  side?: 'both' | 'left' | 'right'
}

/** Ruler guides, in page coordinates. */
export interface DesignGuides {
  /** x positions of vertical guides. */
  v: number[]
  /** y positions of horizontal guides. */
  h: number[]
}

export interface DesignMargins {
  top: number
  right: number
  bottom: number
  left: number
}

export interface DesignColumnGrid {
  count: number
  /** Space between columns, in logical px. */
  gutter: number
}

/** A named document layer. Layer order is the array order; index 0 is the back. */
export interface DesignLayer {
  id: string
  name: string
  visible: boolean
  locked: boolean
}

export type DesignCategory = 'publication' | 'social' | 'marketing' | 'presentation' | 'logo' | 'custom'

export interface DesignSize {
  id: string
  category: DesignCategory
  label: string
  w: number
  h: number
}

// Size presets across the four families the studio ships with. Logical px chosen
// to match each medium's real aspect ratio at a comfortable on-canvas resolution.
export const DESIGN_SIZES: DesignSize[] = [
  // Publications — the multi-page page-layout sizes, at 96dpi so 1 logical px is
  // 1 CSS px and the print exporter's px-to-micron conversion is exact.
  { id: 'a4-portrait', category: 'publication', label: 'A4 portrait', w: 794, h: 1123 },
  { id: 'a4-landscape', category: 'publication', label: 'A4 landscape', w: 1123, h: 794 },
  { id: 'letter-portrait', category: 'publication', label: 'US Letter portrait', w: 816, h: 1056 },
  { id: 'letter-landscape', category: 'publication', label: 'US Letter landscape', w: 1056, h: 816 },
  { id: 'a5-booklet', category: 'publication', label: 'A5 booklet', w: 559, h: 794 },
  { id: 'half-letter', category: 'publication', label: 'Half Letter', w: 528, h: 816 },
  { id: 'newsletter-tabloid', category: 'publication', label: 'Tabloid newsletter', w: 1056, h: 1632 },
  { id: 'tri-fold', category: 'publication', label: 'Tri-fold panel', w: 372, h: 816 },
  // Social
  { id: 'ig-post', category: 'social', label: 'Instagram post', w: 1080, h: 1080 },
  { id: 'ig-story', category: 'social', label: 'Instagram story / Reel', w: 1080, h: 1920 },
  { id: 'fb-post', category: 'social', label: 'Facebook post', w: 1200, h: 630 },
  { id: 'li-post', category: 'social', label: 'LinkedIn post', w: 1200, h: 627 },
  { id: 'x-post', category: 'social', label: 'X / Twitter post', w: 1600, h: 900 },
  { id: 'yt-thumb', category: 'social', label: 'YouTube thumbnail', w: 1280, h: 720 },
  // Marketing
  { id: 'poster-a4', category: 'marketing', label: 'Poster (A4)', w: 794, h: 1123 },
  { id: 'flyer-letter', category: 'marketing', label: 'Flyer (US Letter)', w: 816, h: 1056 },
  { id: 'business-card', category: 'marketing', label: 'Business card', w: 1050, h: 600 },
  { id: 'ad-rectangle', category: 'marketing', label: 'Ad (medium rectangle)', w: 300, h: 250 },
  { id: 'ad-leaderboard', category: 'marketing', label: 'Ad (leaderboard)', w: 728, h: 90 },
  // Presentation & docs
  { id: 'slide-169', category: 'presentation', label: 'Presentation (16:9)', w: 1280, h: 720 },
  { id: 'slide-43', category: 'presentation', label: 'Presentation (4:3)', w: 1024, h: 768 },
  { id: 'doc-cover', category: 'presentation', label: 'Document cover', w: 816, h: 1056 },
  // Logo & brand assets
  { id: 'logo', category: 'logo', label: 'Logo', w: 800, h: 800 },
  { id: 'avatar', category: 'logo', label: 'Social avatar', w: 512, h: 512 },
  { id: 'li-banner', category: 'logo', label: 'LinkedIn banner', w: 1584, h: 396 },
  { id: 'email-sig', category: 'logo', label: 'Email signature', w: 600, h: 200 }
]

export function findDesignSize(id: string): DesignSize | undefined {
  return DESIGN_SIZES.find((s) => s.id === id)
}

// Normalise a stored or partial body into a valid DesignBody. Bad sizes clamp to
// a sane default; missing elements become an empty canvas.
export function normalizeDesignBody(raw: unknown): DesignBody {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const width = clampDim(r.width, 1080)
  const height = clampDim(r.height, 1080)
  const topElements = Array.isArray(r.elements) ? (r.elements as SlideElement[]) : []
  const topBackground: SlideFill = isFill(r.background) ? (r.background as SlideFill) : { type: 'solid', color: '#ffffff' }

  // Pages: use a stored multi-page array, else migrate the legacy single canvas
  // into one page. The active page is mirrored back to top-level elements/background.
  let n = 0
  const rawPages = Array.isArray(r.pages) ? (r.pages as unknown[]) : []
  const pages: DesignPage[] = rawPages
    .map((p) => {
      const pr = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
      return {
        id: typeof pr.id === 'string' && pr.id ? pr.id : `pg-${++n}`,
        background: isFill(pr.background) ? (pr.background as SlideFill) : topBackground,
        elements: Array.isArray(pr.elements) ? (pr.elements as SlideElement[]) : [],
        ...(typeof pr.masterId === 'string' ? { masterId: pr.masterId } : pr.masterId === null ? { masterId: null } : {})
      }
    })
  if (pages.length === 0) pages.push({ id: 'pg-1', background: topBackground, elements: topElements })
  const activePage = Math.max(0, Math.min(pages.length - 1, typeof r.activePage === 'number' ? Math.round(r.activePage) : 0))
  const active = pages[activePage]

  // ── Page-layout state ──────────────────────────────────────────────────────
  const masters: DesignMaster[] = (Array.isArray(r.masters) ? (r.masters as unknown[]) : [])
    .map((m, i) => {
      const mr = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
      return {
        id: typeof mr.id === 'string' && mr.id ? mr.id : `master-${i + 1}`,
        name: typeof mr.name === 'string' && mr.name ? mr.name : `Master ${String.fromCharCode(65 + i)}`,
        ...(isFill(mr.background) ? { background: mr.background as SlideFill } : {}),
        elements: Array.isArray(mr.elements) ? (mr.elements as SlideElement[]) : [],
        ...(mr.side === 'left' || mr.side === 'right' ? { side: mr.side } : {})
      }
    })

  const rawGuides = (r.guides && typeof r.guides === 'object' ? r.guides : {}) as Record<string, unknown>
  const guides: DesignGuides = {
    v: (Array.isArray(rawGuides.v) ? (rawGuides.v as unknown[]) : []).filter((n): n is number => typeof n === 'number' && Number.isFinite(n)),
    h: (Array.isArray(rawGuides.h) ? (rawGuides.h as unknown[]) : []).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  }

  const rawMargins = (r.margins && typeof r.margins === 'object' ? r.margins : null) as Record<string, unknown> | null
  const margins: DesignMargins | undefined = rawMargins
    ? {
        top: numOr(rawMargins.top, 0),
        right: numOr(rawMargins.right, 0),
        bottom: numOr(rawMargins.bottom, 0),
        left: numOr(rawMargins.left, 0)
      }
    : undefined

  const rawCols = (r.columns && typeof r.columns === 'object' ? r.columns : null) as Record<string, unknown> | null
  const columns: DesignColumnGrid | undefined = rawCols
    ? { count: Math.max(1, Math.min(20, Math.round(numOr(rawCols.count, 1)))), gutter: Math.max(0, numOr(rawCols.gutter, 16)) }
    : undefined

  const layers: DesignLayer[] = (Array.isArray(r.layers) ? (r.layers as unknown[]) : [])
    .map((l, i) => {
      const lr = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>
      return {
        id: typeof lr.id === 'string' && lr.id ? lr.id : `layer-${i + 1}`,
        name: typeof lr.name === 'string' && lr.name ? lr.name : `Layer ${i + 1}`,
        visible: lr.visible !== false,
        locked: lr.locked === true
      }
    })

  const stories: Record<string, ContentDoc> = {}
  if (r.stories && typeof r.stories === 'object') {
    for (const [k, v] of Object.entries(r.stories as Record<string, unknown>)) {
      // A story used to be a plain string. Reading one back parses it into
      // blocks rather than discarding it, so an older document opens with its
      // text intact and gains structure for free.
      if (typeof v === 'string') stories[k] = parsePlainText(v, { firstLineIsTitle: false })
      else if (v && typeof v === 'object') {
        const doc = normalizeContent(v)
        if (doc.blocks.length) stories[k] = doc
      }
    }
  }

  return {
    schemaVersion: 1,
    width,
    height,
    background: active.background ?? topBackground,
    elements: active.elements,
    pages,
    activePage,
    category: typeof r.category === 'string' ? (r.category as DesignCategory) : 'custom',
    brandApplied: r.brandApplied === true,
    ...(typeof r.bleed === 'number' && r.bleed > 0 ? { bleed: Math.round(r.bleed) } : {}),
    ...(masters.length ? { masters } : {}),
    ...(guides.v.length || guides.h.length ? { guides } : {}),
    ...(margins ? { margins } : {}),
    ...(columns ? { columns } : {}),
    ...(layers.length ? { layers } : {}),
    ...(r.facing === true ? { facing: true } : {}),
    ...(Object.keys(stories).length ? { stories } : {}),
    ...(typeof r.pageNumberStart === 'number' ? { pageNumberStart: Math.round(r.pageNumberStart) } : {}),
    ...(typeof r.layoutStyleId === 'string' ? { layoutStyleId: r.layoutStyleId } : {}),
    ...(r.sourceContent && typeof r.sourceContent === 'object' && normalizeContent(r.sourceContent).blocks.length
      ? { sourceContent: normalizeContent(r.sourceContent) }
      : {}),
    // The master being edited is deliberately NOT persisted as a live mode: a
    // document that reopened straight into master-editing would be a trap.
    editingMasterId: null
  }
}

function numOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

function clampDim(n: unknown, dflt: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : dflt
  return Math.max(16, Math.min(10000, v))
}
function isFill(v: unknown): boolean {
  return !!v && typeof v === 'object' && 'type' in (v as Record<string, unknown>)
}

// ── Brand-aware starter templates ────────────────────────────────────────────

export interface DesignTemplate {
  id: string
  category: DesignCategory
  label: string
  // The size this template is composed for; the editor can still resize after.
  sizeId: string
  build: (w: number, h: number, brand: OrgBrandKit) => { background: SlideFill; elements: SlideElement[] }
}

// Small element builders, brand-driven.
function text(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  z: number,
  content: string,
  opts: { size: number; color: string; bold?: boolean; align?: 'left' | 'center' | 'right'; font?: string; vAlign?: 'top' | 'middle' | 'bottom' }
): SlideTextElement {
  return {
    id,
    type: 'text',
    x,
    y,
    w,
    h,
    z,
    fontFamily: opts.font,
    vAlign: opts.vAlign ?? 'top',
    paragraphs: [{ runs: [{ text: content, bold: opts.bold, color: opts.color, fontSize: opts.size }], align: opts.align ?? 'left' }]
  }
}
function band(id: string, x: number, y: number, w: number, h: number, z: number, color: string): SlideShapeElement {
  return { id, type: 'shape', shape: 'rect', x, y, w, h, z, fill: { type: 'solid', color } }
}

export const DESIGN_TEMPLATES: DesignTemplate[] = [
  {
    id: 'social-quote',
    category: 'social',
    label: 'Quote post',
    sizeId: 'ig-post',
    build: (w, h, brand) => {
      const text2 = readableTextOn(brand.colorPrimary)
      return {
        background: gradient(shade(brand.colorPrimary, 0.06), shade(brand.colorPrimary, -0.3), 145),
        elements: [
          band('accent', w * 0.08, h * 0.28, w * 0.12, 8, 1, brand.colorSecondary ?? text2),
          text('quote', w * 0.08, h * 0.32, w * 0.84, h * 0.36, 2, 'Your bold statement goes here.', {
            size: Math.round(w * 0.07),
            color: text2,
            bold: true,
            font: brand.fontHeading
          }),
          text('author', w * 0.08, h * 0.74, w * 0.84, h * 0.08, 3, 'Attribution or handle', {
            size: Math.round(w * 0.03),
            color: text2,
            font: brand.fontBody
          })
        ]
      }
    }
  },
  {
    id: 'social-announcement',
    category: 'social',
    label: 'Announcement',
    sizeId: 'ig-post',
    build: (w, h, brand) => ({
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        band('topband', 0, 0, w, h * 0.16, 1, brand.colorPrimary),
        text('eyebrow', w * 0.08, h * 0.05, w * 0.84, h * 0.06, 2, 'ANNOUNCING', {
          size: Math.round(w * 0.028),
          color: readableTextOn(brand.colorPrimary),
          bold: true,
          font: brand.fontHeading
        }),
        text('headline', w * 0.08, h * 0.3, w * 0.84, h * 0.3, 3, 'Something worth sharing', {
          size: Math.round(w * 0.075),
          color: brand.colorPrimary,
          bold: true,
          font: brand.fontHeading
        }),
        text('body', w * 0.08, h * 0.62, w * 0.84, h * 0.22, 4, 'A sentence or two of supporting detail that explains the news.', {
          size: Math.round(w * 0.034),
          color: '#44403c',
          font: brand.fontBody
        })
      ]
    })
  },
  {
    id: 'marketing-flyer',
    category: 'marketing',
    label: 'Event flyer',
    sizeId: 'flyer-letter',
    build: (w, h, brand) => ({
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        band('hero', 0, 0, w, h * 0.42, 1, brand.colorPrimary),
        text('title', w * 0.08, h * 0.12, w * 0.84, h * 0.2, 2, 'Event Title', {
          size: Math.round(w * 0.1),
          color: readableTextOn(brand.colorPrimary),
          bold: true,
          align: 'center',
          font: brand.fontHeading
        }),
        text('subtitle', w * 0.08, h * 0.3, w * 0.84, h * 0.08, 3, 'A short, punchy subtitle', {
          size: Math.round(w * 0.04),
          color: readableTextOn(brand.colorPrimary),
          align: 'center',
          font: brand.fontBody
        }),
        text('details', w * 0.1, h * 0.52, w * 0.8, h * 0.3, 4, 'Date and time\nVenue and address\nWhat to expect', {
          size: Math.round(w * 0.045),
          color: '#292524',
          font: brand.fontBody
        }),
        text('cta', w * 0.1, h * 0.86, w * 0.8, h * 0.08, 5, 'Register at yourbrand.com', {
          size: Math.round(w * 0.038),
          color: brand.colorPrimary,
          bold: true,
          align: 'center',
          font: brand.fontHeading
        })
      ]
    })
  },
  {
    id: 'presentation-cover',
    category: 'presentation',
    label: 'Title cover',
    sizeId: 'slide-169',
    build: (w, h, brand) => ({
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        band('sidebar', 0, 0, w * 0.04, h, 1, brand.colorPrimary),
        band('accent', w * 0.1, h * 0.4, w * 0.08, 10, 2, brand.colorPrimary),
        text('title', w * 0.1, h * 0.44, w * 0.8, h * 0.2, 3, 'Presentation title', {
          size: Math.round(h * 0.09),
          color: brand.colorPrimary,
          bold: true,
          font: brand.fontHeading
        }),
        text('subtitle', w * 0.1, h * 0.66, w * 0.8, h * 0.08, 4, 'Presenter name and date', {
          size: Math.round(h * 0.035),
          color: '#44403c',
          font: brand.fontBody
        })
      ]
    })
  },
  {
    id: 'logo-wordmark',
    category: 'logo',
    label: 'Wordmark',
    sizeId: 'logo',
    build: (w, h, brand) => ({
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        band('mark', w * 0.32, h * 0.3, w * 0.36, w * 0.36, 1, brand.colorPrimary),
        text('initial', w * 0.32, h * 0.3, w * 0.36, w * 0.36, 2, 'A', {
          size: Math.round(w * 0.22),
          color: readableTextOn(brand.colorPrimary),
          bold: true,
          align: 'center',
          vAlign: 'middle',
          font: brand.fontHeading
        }),
        text('name', w * 0.1, h * 0.72, w * 0.8, h * 0.1, 3, 'BRAND', {
          size: Math.round(w * 0.08),
          color: '#1c1917',
          bold: true,
          align: 'center',
          font: brand.fontHeading
        })
      ]
    })
  },
  {
    id: 'social-stat',
    category: 'social',
    label: 'Big stat',
    sizeId: 'ig-post',
    build: (w, h, brand) => {
      const onP = readableTextOn(brand.colorPrimary)
      return {
        background: gradient(shade(brand.colorPrimary, 0.06), shade(brand.colorPrimary, -0.3), 145),
        elements: [
          text('stat', w * 0.08, h * 0.26, w * 0.84, h * 0.3, 2, '92%', { size: Math.round(w * 0.22), color: onP, bold: true, align: 'center', font: brand.fontHeading }),
          text('label', w * 0.1, h * 0.58, w * 0.8, h * 0.12, 3, 'of customers would recommend us', { size: Math.round(w * 0.04), color: onP, align: 'center', font: brand.fontBody })
        ]
      }
    }
  },
  {
    id: 'social-cover',
    category: 'social',
    label: 'Story cover',
    sizeId: 'ig-story',
    build: (w, h, brand) => ({
      background: { type: 'solid', color: '#0f172a' },
      elements: [
        band('bar', w * 0.1, h * 0.34, w * 0.16, 10, 1, brand.colorPrimary),
        text('title', w * 0.1, h * 0.37, w * 0.8, h * 0.22, 2, 'Swipe up for the full story', { size: Math.round(w * 0.085), color: '#ffffff', bold: true, font: brand.fontHeading }),
        text('sub', w * 0.1, h * 0.6, w * 0.8, h * 0.1, 3, 'A short supporting line goes here.', { size: Math.round(w * 0.04), color: '#cbd5e1', font: brand.fontBody })
      ]
    })
  },
  {
    id: 'marketing-promo',
    category: 'marketing',
    label: 'Sale promo',
    sizeId: 'poster-a4',
    build: (w, h, brand) => {
      const onP = readableTextOn(brand.colorPrimary)
      return {
        background: gradient(shade(brand.colorPrimary, 0.06), shade(brand.colorPrimary, -0.3), 145),
        elements: [
          text('kicker', w * 0.1, h * 0.16, w * 0.8, h * 0.06, 1, 'LIMITED TIME', { size: Math.round(w * 0.04), color: onP, bold: true, align: 'center', font: brand.fontHeading }),
          text('big', w * 0.06, h * 0.3, w * 0.88, h * 0.2, 2, '25% OFF', { size: Math.round(w * 0.2), color: onP, bold: true, align: 'center', font: brand.fontHeading }),
          text('detail', w * 0.1, h * 0.56, w * 0.8, h * 0.2, 3, 'Everything in store, this week only. Use code SAVE25 at checkout.', { size: Math.round(w * 0.05), color: onP, align: 'center', font: brand.fontBody })
        ]
      }
    }
  },
  {
    id: 'marketing-card',
    category: 'marketing',
    label: 'Business card',
    sizeId: 'business-card',
    build: (w, h, brand) => ({
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        band('side', 0, 0, w * 0.06, h, 1, brand.colorPrimary),
        text('name', w * 0.12, h * 0.22, w * 0.8, h * 0.18, 2, 'Your Name', { size: Math.round(h * 0.16), color: '#1c1917', bold: true, font: brand.fontHeading }),
        text('role', w * 0.12, h * 0.44, w * 0.8, h * 0.12, 3, 'Title, Company', { size: Math.round(h * 0.09), color: brand.colorPrimary, font: brand.fontBody }),
        text('contact', w * 0.12, h * 0.66, w * 0.8, h * 0.24, 4, 'you@company.com\n+1 555 0123\ncompany.com', { size: Math.round(h * 0.07), color: '#44403c', font: brand.fontBody })
      ]
    })
  },
  {
    id: 'presentation-section',
    category: 'presentation',
    label: 'Section divider',
    sizeId: 'slide-169',
    build: (w, h, brand) => {
      const onP = readableTextOn(brand.colorPrimary)
      return {
        background: gradient(shade(brand.colorPrimary, 0.06), shade(brand.colorPrimary, -0.3), 145),
        elements: [
          text('num', w * 0.1, h * 0.3, w * 0.3, h * 0.2, 1, '01', { size: Math.round(h * 0.16), color: onP, bold: true, font: brand.fontHeading }),
          text('section', w * 0.1, h * 0.52, w * 0.8, h * 0.18, 2, 'Section title', { size: Math.round(h * 0.1), color: onP, bold: true, font: brand.fontHeading })
        ]
      }
    }
  },
  {
    id: 'presentation-quote',
    category: 'presentation',
    label: 'Pull quote',
    sizeId: 'slide-169',
    build: (w, h, brand) => ({
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        text('mark', w * 0.08, h * 0.14, w * 0.2, h * 0.2, 1, '“', { size: Math.round(h * 0.28), color: brand.colorPrimary, bold: true, font: brand.fontHeading }),
        text('quote', w * 0.1, h * 0.32, w * 0.8, h * 0.32, 2, 'A short, memorable quote that carries the slide.', { size: Math.round(h * 0.06), color: '#1c1917', font: brand.fontHeading }),
        text('attr', w * 0.1, h * 0.72, w * 0.8, h * 0.08, 3, 'Name, Title', { size: Math.round(h * 0.035), color: brand.colorPrimary, font: brand.fontBody })
      ]
    })
  },
  {
    id: 'logo-badge',
    category: 'logo',
    label: 'Badge mark',
    sizeId: 'logo',
    build: (w, h, brand) => ({
      background: { type: 'solid', color: '#ffffff' },
      elements: [
        { id: 'ring', type: 'shape', shape: 'ellipse', x: w * 0.18, y: h * 0.18, w: w * 0.64, h: h * 0.64, z: 1, fill: { type: 'solid', color: brand.colorPrimary } },
        text('mono', w * 0.18, h * 0.18, w * 0.64, h * 0.64, 2, 'AB', { size: Math.round(w * 0.2), color: readableTextOn(brand.colorPrimary), bold: true, align: 'center', vAlign: 'middle', font: brand.fontHeading })
      ]
    })
  },
  {
    id: 'logo-banner',
    category: 'logo',
    label: 'LinkedIn banner',
    sizeId: 'li-banner',
    build: (w, h, brand) => {
      const onP = readableTextOn(brand.colorPrimary)
      return {
        background: gradient(shade(brand.colorPrimary, 0.06), shade(brand.colorPrimary, -0.3), 145),
        elements: [
          text('tag', w * 0.05, h * 0.3, w * 0.6, h * 0.24, 1, 'We build better workdays', { size: Math.round(h * 0.16), color: onP, bold: true, font: brand.fontHeading }),
          text('url', w * 0.05, h * 0.6, w * 0.6, h * 0.12, 2, 'company.com', { size: Math.round(h * 0.08), color: onP, font: brand.fontBody })
        ]
      }
    }
  }
]

export function templatesForCategory(category: DesignCategory): DesignTemplate[] {
  return DESIGN_TEMPLATES.filter((t) => t.category === category)
}

// Build a fresh design body from a template + size, applying the brand kit (or the
// default kit when no brand is set).
export function designFromTemplate(template: DesignTemplate, size: DesignSize, brand: OrgBrandKit = DEFAULT_BRAND_KIT): DesignBody {
  const { background, elements } = template.build(size.w, size.h, brand)
  return {
    schemaVersion: 1,
    width: size.w,
    height: size.h,
    background,
    elements,
    category: size.category,
    brandApplied: brand !== DEFAULT_BRAND_KIT
  }
}

// ── AI design composition ────────────────────────────────────────────────────

// The content fields an AI fills in for a generated design. All optional so a
// sparse response still composes.
export interface DesignContent {
  eyebrow?: string
  headline?: string
  subhead?: string
  body?: string
  cta?: string
  // Background treatment the AI chose for the piece.
  background?: 'brand' | 'light' | 'dark'
  // Optional layout style the AI picked for this concept; otherwise the variations
  // builder rotates through the styles.
  layout?: DesignLayoutId
}

// Compose a finished, on-brand layout from AI copy at a given size. This is the
// "10 seconds" path: structured copy in, a designed branded piece out, with a
// gradient background, decorative depth, a strong type hierarchy and a real CTA
// pill. It is the left-aligned variant of the premium stack layout.
export function composeDesign(size: DesignSize, brand: OrgBrandKit, content: DesignContent): DesignBody {
  return composeStack(size, brand, content, 'left')
}

// ── Static HTML render (for export) ──────────────────────────────────────────

const SHADOW: Record<string, string> = {
  sm: '0 1px 3px rgba(0,0,0,0.18)',
  md: '0 6px 16px rgba(0,0,0,0.22)',
  lg: '0 14px 38px rgba(0,0,0,0.28)'
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function styleStr(props: Record<string, string | number | undefined>): string {
  return Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`)
    .join(';')
}

// Render one element to absolutely-positioned HTML, mirroring SlideElementView so
// the export matches the on-canvas appearance pixel for pixel.
function elementHtml(el: SlideElement): string {
  const base = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;overflow:hidden;${
    el.rotation ? `transform:rotate(${el.rotation}deg);` : ''
  }${el.opacity != null ? `opacity:${el.opacity};` : ''}${el.cornerRadius ? `border-radius:${el.cornerRadius}px;` : ''}${
    el.shadow ? `box-shadow:${SHADOW[el.shadow]};` : ''
  }`
  const border = (b?: { width: number; style?: string; color: string }): string =>
    b ? `border:${b.width}px ${b.style ?? 'solid'} ${b.color};` : ''

  if (el.type === 'text') {
    // A threaded frame shows the slice of the story the flow engine gave it,
    // as absolutely-positioned lines. Using the engine's own output (rather than
    // re-wrapping here with a different measurer) is what makes the exported
    // page identical to the one on screen, line break for line break.
    if (el.flowLines && el.flowLines.length) {
      const lines = el.flowLines
        .map((ln) => {
          const justified = ln.align === 'justify' && !ln.lastOfPara
          const rule = ln.rule
            ? `<div style="${styleStr({
                position: 'absolute',
                left: `${ln.x}px`,
                top: `${ln.y - ln.size * 0.55}px`,
                width: `${ln.w * ln.rule.width}px`,
                height: `${ln.rule.thickness}px`,
                background: ln.rule.color
              })}"></div>`
            : ''
          const bullet = ln.bullet
            ? `<div style="${styleStr({
                position: 'absolute',
                left: `${ln.x - ln.size * 1.4}px`,
                top: `${ln.y}px`,
                width: `${ln.size * 1.15}px`,
                textAlign: 'right',
                lineHeight: `${ln.lh}px`,
                fontSize: `${ln.size}px`,
                fontFamily: ln.family,
                color: ln.color
              })}">${escHtml(ln.bullet)}</div>`
            : ''
          const cap = ln.dropCap
            ? `<div style="${styleStr({
                position: 'absolute',
                left: `${ln.x - ln.dropCap.width - ln.size * 0.12}px`,
                top: `${ln.y}px`,
                fontSize: `${ln.dropCap.size}px`,
                lineHeight: `${ln.dropCap.size}px`,
                fontFamily: ln.family,
                fontWeight: 700,
                color: ln.color
              })}">${escHtml(ln.dropCap.text)}</div>`
            : ''
          const body = `<div style="${styleStr({
            position: 'absolute',
            left: `${ln.x}px`,
            top: `${ln.y}px`,
            width: `${ln.w}px`,
            lineHeight: `${ln.lh}px`,
            fontSize: `${ln.size}px`,
            fontFamily: ln.family,
            fontWeight: ln.bold ? 700 : undefined,
            fontStyle: ln.italic ? 'italic' : undefined,
            color: ln.color,
            letterSpacing: ln.letterSpacing ? `${ln.letterSpacing}px` : undefined,
            whiteSpace: 'pre',
            textAlign: justified ? 'justify' : ln.align === 'justify' ? 'left' : ln.align,
            textAlignLast: justified ? 'justify' : undefined
          })}">${escHtml(ln.text) || '&#8203;'}</div>`
          return rule + bullet + cap + body
        })
        .join('')
      const fillCss = fillToCss(el.fill)
      return `<div style="${base}${fillCss ? `background:${fillCss};` : ''}${border(el.border)}">${lines}</div>`
    }
    const justify = el.vAlign === 'middle' ? 'center' : el.vAlign === 'bottom' ? 'flex-end' : 'flex-start'
    const paras = el.paragraphs
      .map((p) => {
        const align = p.align ?? 'left'
        const jc = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start'
        const runs = p.runs
          .map(
            (r) =>
              `<span style="${styleStr({
                fontWeight: r.bold ? 700 : undefined,
                fontStyle: r.italic ? 'italic' : undefined,
                textDecoration: r.underline ? 'underline' : undefined,
                color: r.color,
                fontSize: r.fontSize ? `${r.fontSize}px` : undefined
              })}">${escHtml(r.text || '​')}</span>`
          )
          .join('')
        return `<div style="text-align:${align};display:flex;gap:8px;justify-content:${jc}"><span>${runs}</span></div>`
      })
      .join('')
    const fillCss = fillToCss(el.fill)
    const fill = fillCss ? `background:${fillCss};` : ''
    return `<div style="${base}${fill}${border(el.border)}"><div style="display:flex;flex-direction:column;justify-content:${justify};height:100%;${
      el.fontFamily ? `font-family:${el.fontFamily};` : ''
    }">${paras}</div></div>`
  }
  if (el.type === 'image') {
    return `<div style="${base}${border(el.border)}"><img src="${el.src}" style="width:100%;height:100%;object-fit:${el.fit ?? 'contain'}"/></div>`
  }
  if (el.type === 'shape') {
    if (el.shape === 'triangle') {
      return `<div style="${base}${el.shadow ? `filter:drop-shadow(${SHADOW[el.shadow]});` : ''}"><div style="width:100%;height:100%;clip-path:polygon(50% 0%,0% 100%,100% 100%);background:${
        fillToCss(el.fill) ?? 'transparent'
      }"></div></div>`
    }
    const radius = el.shape === 'ellipse' ? '50%' : el.cornerRadius ?? (el.shape === 'roundRect' ? '16px' : '0')
    return `<div style="${base}background:${fillToCss(el.fill) ?? 'transparent'};border-radius:${
      typeof radius === 'number' ? radius + 'px' : radius
    };${border(el.border)}"></div>`
  }
  if (el.type === 'widget') {
    // Static export cannot include the live widget (it resolves through the
    // renderer's IPC), so export an honest labelled frame instead of a fake.
    return `<div style="${base}border:1px solid #d6d3d1;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#a8a29e;font-size:12px;font-family:system-ui,sans-serif">Embedded desk widget</div>`
  }
  if (el.type === 'chart') {
    // Static SVG of the chart from its data snapshot, so exports are faithful.
    return `<div style="${base}">${chartToSvg(el.chart, el.w, el.h)}</div>`
  }
  if (el.type === 'table') {
    const accent = el.accent ?? '#e2e8f0'
    const rows = el.cells
      .map(
        (row, r) =>
          `<tr>${row
            .map((cell) => {
              const head = el.headerRow && r === 0
              return `<td style="border:1px solid ${accent};padding:4px 8px;${head ? `font-weight:700;background:${accent};` : ''}">${cell.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>`
            })
            .join('')}</tr>`
      )
      .join('')
    return `<div style="${base}"><table style="width:100%;height:100%;border-collapse:collapse;table-layout:fixed;font-size:${el.fontSize ?? 16}px">${rows}</table></div>`
  }
  // line
  return `<div style="${base}"><svg width="100%" height="100%" viewBox="0 0 ${el.w} ${el.h}" preserveAspectRatio="none">${
    el.arrowEnd
      ? `<defs><marker id="arrow-${el.id}" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="${el.stroke}"/></marker></defs>`
      : ''
  }<line x1="0" y1="0" x2="${el.w}" y2="${el.h}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}" ${
    el.arrowEnd ? `marker-end="url(#arrow-${el.id})"` : ''
  }/></svg></div>`
}

/**
 * The elements of one page as HTML: the master's furniture first (so it sits
 * beneath everything), then the page's own elements, each group in z order.
 * Hidden layers are left out, exactly as they are on screen.
 */
export function pageElementsHtml(design: DesignBody, pageIndex: number): string {
  const pages = design.pages ?? []
  const page = pages[pageIndex] ?? { id: 'p1', background: design.background, elements: design.elements }
  const master = masterForPage(design, page as DesignPage)
  const ctx = { page: pageNumberOf(design, pageIndex), pages: pageCountOf(design) }
  const visible = (el: SlideElement): boolean => elementVisible(design, el)
  const masterHtml = master
    ? resolveMasterElements(master, ctx).filter(visible).slice().sort((a, b) => a.z - b.z).map(elementHtml).join('')
    : ''
  const pageHtml = page.elements.filter(visible).slice().sort((a, b) => a.z - b.z).map(elementHtml).join('')
  return masterHtml + pageHtml
}

// A full standalone HTML document rendering the design at its exact pixel size,
// for the export pipeline (offscreen capture to PNG / print to PDF).
export function designToHtml(design: DesignBody): string {
  const pageIndex = design.activePage ?? 0
  const page = (design.pages ?? [])[pageIndex]
  const bg = fillToCss(page?.background ?? design.background) ?? '#ffffff'
  const els = pageElementsHtml(design, pageIndex)
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${design.width}px;height:${design.height}px}</style></head><body><div style="position:relative;width:${design.width}px;height:${design.height}px;background:${bg};overflow:hidden">${els}</div></body></html>`
}

// The print dimensions of a design: the trim (design) size plus bleed on every
// side, plus a margin for crop marks. Pure, so the exporter and tests agree.
export function designPrintSize(design: DesignBody, opts: { bleed?: number; cropMarks?: boolean } = {}): {
  bleed: number
  markMargin: number
  pageWidth: number
  pageHeight: number
} {
  const bleed = Math.max(0, Math.round(opts.bleed ?? design.bleed ?? 0))
  const cropMarks = opts.cropMarks ?? bleed > 0
  const markMargin = cropMarks ? 24 : 0
  return {
    bleed,
    markMargin,
    pageWidth: design.width + 2 * (bleed + markMargin),
    pageHeight: design.height + 2 * (bleed + markMargin)
  }
}

// A print-ready standalone HTML page: the design centred on a larger sheet, its
// background extended into the bleed, and crop marks at the four trim corners so
// a print shop knows exactly where to cut. This is the Publisher/InDesign print
// output that ordinary PNG/PDF export can't produce.
export function designPrintHtml(design: DesignBody, opts: { bleed?: number; cropMarks?: boolean } = {}): string {
  const { bleed, markMargin, pageWidth, pageHeight } = designPrintSize(design, opts)
  const cropMarks = (opts.cropMarks ?? bleed > 0) && markMargin > 0
  const pageIndex = design.activePage ?? 0
  const page = (design.pages ?? [])[pageIndex]
  const bg = fillToCss(page?.background ?? design.background) ?? '#ffffff'
  const els = pageElementsHtml(design, pageIndex)

  const trimLeft = markMargin + bleed
  const trimTop = markMargin + bleed
  // The background fills the trim + bleed area so a full-bleed design prints with
  // no white slivers after the cut.
  const bleedBox = `<div style="position:absolute;left:${markMargin}px;top:${markMargin}px;width:${design.width + 2 * bleed}px;height:${design.height + 2 * bleed}px;background:${bg};overflow:hidden"></div>`
  // Elements sit in trim coordinates; overflow is visible so a deliberately
  // oversized (full-bleed) element extends into the bleed.
  const trimBox = `<div style="position:absolute;left:${trimLeft}px;top:${trimTop}px;width:${design.width}px;height:${design.height}px;overflow:visible">${els}</div>`

  let marks = ''
  if (cropMarks) {
    const L = 14 // crop-mark length
    const line = (x1: number, y1: number, x2: number, y2: number): string =>
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="0.75" />`
    const tR = trimLeft + design.width
    const tB = trimTop + design.height
    const bl = markMargin // bleed-box edge (marks live in the margin outside it)
    const br = markMargin + design.width + 2 * bleed
    const bt = markMargin
    const bb = markMargin + design.height + 2 * bleed
    marks =
      `<svg style="position:absolute;left:0;top:0;pointer-events:none" width="${pageWidth}" height="${pageHeight}">` +
      // top-left
      line(trimLeft, bt - L, trimLeft, bt) +
      line(bl - L, trimTop, bl, trimTop) +
      // top-right
      line(tR, bt - L, tR, bt) +
      line(br, trimTop, br + L, trimTop) +
      // bottom-left
      line(trimLeft, bb, trimLeft, bb + L) +
      line(bl - L, tB, bl, tB) +
      // bottom-right
      line(tR, bb, tR, bb + L) +
      line(br, tB, br + L, tB) +
      `</svg>`
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${pageWidth}px;height:${pageHeight}px}</style></head><body><div style="position:relative;width:${pageWidth}px;height:${pageHeight}px;background:#ffffff;overflow:hidden">${bleedBox}${trimBox}${marks}</div></body></html>`
}

// Every page of a multi-page design stacked with page breaks, for a single
// multi-page PDF. Each page is drawn at the doc's exact pixel size.
export function designToHtmlAllPages(design: DesignBody): string {
  const pages = design.pages && design.pages.length ? design.pages : [{ id: 'p1', background: design.background, elements: design.elements }]
  const pageDivs = pages
    .map((pg, i) => {
      const bg = fillToCss(pg.background) ?? '#ffffff'
      const els = pageElementsHtml(design, i)
      const brk = i < pages.length - 1 ? 'page-break-after:always;' : ''
      return `<div style="position:relative;width:${design.width}px;height:${design.height}px;background:${bg};overflow:hidden;${brk}">${els}</div>`
    })
    .join('')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}</style></head><body>${pageDivs}</body></html>`
}

// ── AI template generator: layout variants ───────────────────────────────────

export type DesignLayoutId = 'left' | 'centered' | 'band' | 'bold' | 'split' | 'minimal'
export const DESIGN_LAYOUT_IDS: DesignLayoutId[] = ['left', 'centered', 'band', 'bold', 'split', 'minimal']

// Lighten (pct > 0) or darken (pct < 0) a hex color, for gradient stops and tints.
function shade(hex: string, pct: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const f = (c: number): number => Math.round(pct >= 0 ? c + (255 - c) * pct : c * (1 + pct))
  const h = (n: number): string => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
  return `#${h(f(rgb.r))}${h(f(rgb.g))}${h(f(rgb.b))}`
}
function withAlpha(hex: string, a: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`
}

// A soft, large decorative circle (low-opacity brand tint) for depth and texture,
// the kind of background ornament a designed piece has and a flat color block does
// not. Positioned by its center; clipped by the canvas.
function blob(id: string, cx: number, cy: number, d: number, z: number, color: string): SlideShapeElement {
  return { id, type: 'shape', shape: 'ellipse', x: Math.round(cx - d / 2), y: Math.round(cy - d / 2), w: d, h: d, z, fill: { type: 'solid', color } }
}

interface Palette {
  bg: SlideFill
  onBg: string
  accent: string
  accentSolid: string
  bodyColor: string
  decor: string
  mode: 'brand' | 'light' | 'dark'
}
// The full color treatment for a composition: a real gradient background (not a
// flat fill), readable text, an accent that contrasts the background, and a soft
// decorative tint.
function paletteFor(brand: OrgBrandKit, mode: 'brand' | 'light' | 'dark'): Palette {
  const primary = brand.colorPrimary
  const secondary = brand.colorSecondary
  let bg: SlideFill
  let baseColor: string
  if (mode === 'brand') {
    // A rich diagonal in the brand color, deepening toward the corner.
    const end = secondary && contrastRatio(secondary, primary) < 3 ? secondary : shade(primary, -0.32)
    bg = gradient(shade(primary, 0.06), end, 145)
    baseColor = primary
  } else if (mode === 'dark') {
    bg = gradient('#0b1220', shade(primary, -0.55), 145)
    baseColor = '#0b1220'
  } else {
    // Light: a near-white field with the faintest brand tint, so it still reads as
    // designed rather than a blank page.
    bg = gradient('#ffffff', shade(primary, 0.9), 160)
    baseColor = '#ffffff'
  }
  const onBg = readableTextOn(baseColor)
  const accentSolid =
    mode === 'brand'
      ? secondary && contrastRatio(secondary, baseColor) >= 2.2
        ? secondary
        : onBg
      : primary
  const bodyColor = mode === 'light' ? '#44403c' : withAlpha(onBg, 0.85)
  const decor = mode === 'light' ? withAlpha(primary, 0.08) : withAlpha(onBg, 0.08)
  return { bg, onBg, accent: accentSolid, accentSolid, bodyColor, decor, mode }
}

// A centered or minimal stacked layout. Distinct from composeDesign (the 'left'
// variant) so a set of variations reads as genuinely different designs.
function composeStack(
  size: DesignSize,
  brand: OrgBrandKit,
  content: DesignContent,
  align: 'left' | 'center',
  opts: { mode?: 'brand' | 'light' | 'dark'; scale?: number; minimal?: boolean } = {}
): DesignBody {
  const { w, h } = size
  const mode = opts.mode ?? content.background ?? 'light'
  const p = paletteFor(brand, mode)
  const scale = opts.scale ?? 1
  const mx = Math.round(w * 0.09)
  const cw = w - mx * 2
  const els: SlideElement[] = []
  let z = 1
  // Decorative blobs for depth, behind the content.
  els.push(blob('decor1', w * 0.92, h * 0.12, Math.round(w * 0.5), z++, p.decor))
  els.push(blob('decor2', w * 0.08, h * 0.95, Math.round(w * 0.42), z++, p.decor))
  let y = Math.round(h * (opts.minimal ? 0.14 : 0.17))
  const ax = align === 'center' ? Math.round(w / 2 - w * 0.05) : mx
  // A bold, rounded accent bar sets the composition off.
  els.push({ id: 'accent', type: 'shape', shape: 'roundRect', x: ax, y, w: Math.round(w * 0.1), h: Math.max(8, Math.round(h * 0.014)), z: z++, cornerRadius: 999, fill: { type: 'solid', color: p.accent } })
  y += Math.round(h * 0.04)
  if (content.eyebrow && !opts.minimal) {
    els.push(text('eyebrow', mx, y, cw, Math.round(h * 0.05), z++, content.eyebrow.toUpperCase(), { size: Math.round(w * 0.026), color: p.accent, bold: true, align, font: brand.fontHeading }))
    y += Math.round(h * 0.065)
  }
  if (content.headline) {
    const lines = Math.max(1, Math.ceil(content.headline.length / (opts.minimal ? 14 : 18)))
    const hh = Math.round(h * 0.135 * lines * scale)
    els.push(text('headline', mx, y, cw, hh, z++, content.headline, { size: Math.round(w * (opts.minimal ? 0.095 : 0.082) * scale), color: p.onBg, bold: true, align, vAlign: 'top', font: brand.fontHeading }))
    y += hh + Math.round(h * 0.025)
  }
  if (content.subhead && !opts.minimal) {
    els.push(text('subhead', mx, y, cw, Math.round(h * 0.1), z++, content.subhead, { size: Math.round(w * 0.04), color: p.bodyColor, align, font: brand.fontBody }))
    y += Math.round(h * 0.115)
  }
  if (content.body) {
    els.push(text('body', mx, y, cw, Math.round(h * 0.22), z++, content.body, { size: Math.round(w * 0.031), color: p.bodyColor, align, font: brand.fontBody }))
  }
  if (content.cta) {
    const ch = Math.round(h * 0.085)
    const cwid = Math.round(w * 0.46)
    const cx = align === 'center' ? Math.round((w - cwid) / 2) : mx
    const cyy = h - Math.round(h * 0.14)
    const pill = p.accent === p.onBg ? brand.colorPrimary : p.accent
    // A real pill button with rounded corners and a soft shadow.
    els.push({ id: 'ctabg', type: 'shape', shape: 'roundRect', x: cx, y: cyy, w: cwid, h: ch, z: z++, cornerRadius: Math.round(ch / 2), shadow: 'md', fill: { type: 'solid', color: pill } })
    els.push(text('cta', cx, cyy, cwid, ch, z++, content.cta, { size: Math.round(w * 0.032), color: readableTextOn(pill), bold: true, align: 'center', vAlign: 'middle', font: brand.fontHeading }))
  }
  return { schemaVersion: 1, width: w, height: h, background: p.bg, elements: els, category: size.category, brandApplied: true }
}

// A gradient hero band carrying the eyebrow + headline, body on a clean field
// below, with a soft decorative blob and a rounded bottom edge for depth.
function composeBand(size: DesignSize, brand: OrgBrandKit, content: DesignContent): DesignBody {
  const { w, h } = size
  const p = paletteFor(brand, 'brand')
  const onHero = readableTextOn(brand.colorPrimary)
  const mx = Math.round(w * 0.09)
  const cw = w - mx * 2
  const bandH = Math.round(h * 0.46)
  const els: SlideElement[] = []
  let z = 1
  // Gradient hero with a rounded bottom and a faint blob inside it.
  els.push({ id: 'hero', type: 'shape', shape: 'roundRect', x: -Math.round(w * 0.06), y: -Math.round(h * 0.1), w: w + Math.round(w * 0.12), h: bandH + Math.round(h * 0.1), z: z++, cornerRadius: Math.round(w * 0.06), shadow: 'md', fill: p.bg })
  els.push(blob('heroblob', w * 0.86, h * 0.06, Math.round(w * 0.4), z++, withAlpha(onHero, 0.1)))
  let y = Math.round(h * 0.1)
  if (content.eyebrow) {
    els.push(text('eyebrow', mx, y, cw, Math.round(h * 0.05), z++, content.eyebrow.toUpperCase(), { size: Math.round(w * 0.028), color: onHero, bold: true, font: brand.fontHeading }))
    y += Math.round(h * 0.065)
  }
  if (content.headline) {
    els.push(text('headline', mx, y, cw, Math.round(h * 0.26), z++, content.headline, { size: Math.round(w * 0.08), color: onHero, bold: true, font: brand.fontHeading }))
  }
  let by = bandH + Math.round(h * 0.08)
  if (content.subhead) {
    els.push(text('subhead', mx, by, cw, Math.round(h * 0.12), z++, content.subhead, { size: Math.round(w * 0.042), color: '#1c1917', bold: true, font: brand.fontBody }))
    by += Math.round(h * 0.12)
  }
  if (content.body) {
    els.push(text('body', mx, by, cw, Math.round(h * 0.22), z++, content.body, { size: Math.round(w * 0.032), color: '#44403c', font: brand.fontBody }))
  }
  if (content.cta) {
    const ch = Math.round(h * 0.085)
    const cwid = Math.round(w * 0.46)
    els.push({ id: 'ctabg', type: 'shape', shape: 'roundRect', x: mx, y: h - Math.round(h * 0.14), w: cwid, h: ch, z: z++, cornerRadius: Math.round(ch / 2), shadow: 'md', fill: { type: 'solid', color: brand.colorPrimary } })
    els.push(text('cta', mx, h - Math.round(h * 0.14), cwid, ch, z++, content.cta, { size: Math.round(w * 0.032), color: onHero, bold: true, align: 'center', vAlign: 'middle', font: brand.fontHeading }))
  }
  return { schemaVersion: 1, width: w, height: h, background: gradient('#ffffff', shade(brand.colorPrimary, 0.92), 160), elements: els, category: size.category, brandApplied: true }
}

// A split: a gradient brand block on one side, text on the other. Splits along the
// long edge (side block for wide canvases, top block for tall ones).
function composeSplit(size: DesignSize, brand: OrgBrandKit, content: DesignContent): DesignBody {
  const { w, h } = size
  const wide = w >= h
  const p = paletteFor(brand, 'brand')
  const onHero = readableTextOn(brand.colorPrimary)
  const els: SlideElement[] = []
  let z = 1
  if (wide) {
    const bw = Math.round(w * 0.44)
    els.push({ id: 'block', type: 'shape', shape: 'rect', x: 0, y: 0, w: bw, h, z: z++, fill: p.bg })
    els.push(blob('bblob', bw * 0.5, h * 0.85, Math.round(w * 0.3), z++, withAlpha(onHero, 0.1)))
    els.push(text('headline', Math.round(w * 0.05), Math.round(h * 0.28), Math.round(bw - w * 0.1), Math.round(h * 0.44), z++, content.headline ?? '', { size: Math.round(w * 0.055), color: onHero, bold: true, vAlign: 'middle', font: brand.fontHeading }))
    const tx = bw + Math.round(w * 0.06)
    const tw = w - tx - Math.round(w * 0.06)
    let y = Math.round(h * 0.26)
    els.push({ id: 'taccent', type: 'shape', shape: 'roundRect', x: tx, y: y - Math.round(h * 0.06), w: Math.round(w * 0.07), h: Math.max(8, Math.round(h * 0.012)), z: z++, cornerRadius: 999, fill: { type: 'solid', color: brand.colorPrimary } })
    if (content.subhead) {
      els.push(text('subhead', tx, y, tw, Math.round(h * 0.14), z++, content.subhead, { size: Math.round(w * 0.032), color: '#1c1917', bold: true, font: brand.fontBody }))
      y += Math.round(h * 0.16)
    }
    if (content.body) els.push(text('body', tx, y, tw, Math.round(h * 0.3), z++, content.body, { size: Math.round(w * 0.025), color: '#44403c', font: brand.fontBody }))
    if (content.cta) els.push(text('cta', tx, h - Math.round(h * 0.16), tw, Math.round(h * 0.08), z++, content.cta, { size: Math.round(w * 0.027), color: brand.colorPrimary, bold: true, font: brand.fontHeading }))
  } else {
    const bh = Math.round(h * 0.44)
    els.push({ id: 'block', type: 'shape', shape: 'rect', x: 0, y: 0, w, h: bh, z: z++, fill: p.bg })
    els.push(blob('bblob', w * 0.88, bh * 0.4, Math.round(w * 0.36), z++, withAlpha(onHero, 0.1)))
    els.push(text('headline', Math.round(w * 0.09), Math.round(h * 0.09), Math.round(w * 0.82), Math.round(bh - h * 0.12), z++, content.headline ?? '', { size: Math.round(w * 0.085), color: onHero, bold: true, vAlign: 'middle', font: brand.fontHeading }))
    let y = bh + Math.round(h * 0.07)
    if (content.subhead) {
      els.push(text('subhead', Math.round(w * 0.09), y, Math.round(w * 0.82), Math.round(h * 0.1), z++, content.subhead, { size: Math.round(w * 0.042), color: '#1c1917', bold: true, font: brand.fontBody }))
      y += Math.round(h * 0.11)
    }
    if (content.body) els.push(text('body', Math.round(w * 0.09), y, Math.round(w * 0.82), Math.round(h * 0.24), z++, content.body, { size: Math.round(w * 0.032), color: '#44403c', font: brand.fontBody }))
    if (content.cta) els.push(text('cta', Math.round(w * 0.09), h - Math.round(h * 0.1), Math.round(w * 0.82), Math.round(h * 0.07), z++, content.cta, { size: Math.round(w * 0.034), color: brand.colorPrimary, bold: true, font: brand.fontHeading }))
  }
  return { schemaVersion: 1, width: w, height: h, background: gradient('#ffffff', shade(brand.colorPrimary, 0.93), 160), elements: els, category: size.category, brandApplied: true }
}

// Compose one design in a named layout style.
export function composeVariant(size: DesignSize, brand: OrgBrandKit, content: DesignContent, layout: DesignLayoutId): DesignBody {
  switch (layout) {
    case 'centered':
      return composeStack(size, brand, content, 'center')
    case 'bold':
      return composeStack(size, brand, { ...content, background: 'brand' }, 'center', { mode: 'brand', scale: 1.15 })
    case 'band':
      return composeBand(size, brand, content)
    case 'split':
      return composeSplit(size, brand, content)
    case 'minimal':
      return composeStack(size, brand, content, 'left', { minimal: true })
    case 'left':
    default:
      return composeDesign(size, brand, content)
  }
}

// Turn a set of AI copy concepts into a set of distinct on-brand designs, cycling
// through the layout styles so the variations look genuinely different. An AI may
// also pin a layout per concept via content.layout; otherwise the style rotates.
export function buildDesignVariations(size: DesignSize, brand: OrgBrandKit, contents: DesignContent[]): DesignBody[] {
  return contents.map((c, i) => composeVariant(size, brand, c, c.layout ?? DESIGN_LAYOUT_IDS[i % DESIGN_LAYOUT_IDS.length]))
}

// Magic resize: scale a whole design to a new size, repositioning and resizing
// every element proportionally (and scaling text by the average ratio) so the
// layout is preserved rather than the canvas just changing under fixed elements.
/**
 * Resize the document to a new page size, scaling everything that lives in page
 * coordinates: EVERY page (not just the one on screen), every master page's
 * furniture, the margin box and the ruler guides.
 *
 * Scaling only the active page — which is what this used to do — left the other
 * pages of a brochure at the old geometry and stranded the master furniture and
 * margins, so a resize silently broke a multi-page document.
 */
export function resizeDesign(design: DesignBody, target: DesignSize): DesignBody {
  const sx = design.width ? target.w / design.width : 1
  const sy = design.height ? target.h / design.height : 1
  const fs = (sx + sy) / 2

  const scaleElement = (el: SlideElement): SlideElement => {
    const moved = {
      ...el,
      x: Math.round(el.x * sx),
      y: Math.round(el.y * sy),
      w: Math.round(el.w * sx),
      h: Math.round(el.h * sy)
    }
    if (moved.type === 'text') {
      return {
        ...moved,
        // Threaded frames are set in points on the element itself; unthreaded
        // ones carry their size per run. Both scale.
        ...(moved.fontSize ? { fontSize: Math.max(6, Math.round(moved.fontSize * fs)) } : {}),
        // The cached line breaks are measured for the OLD geometry, so they are
        // dropped rather than scaled — the next re-flow recomputes them honestly.
        flowLines: undefined,
        paragraphs: moved.paragraphs.map((p) => ({
          ...p,
          runs: p.runs.map((r) => ({ ...r, fontSize: r.fontSize ? Math.max(6, Math.round(r.fontSize * fs)) : r.fontSize }))
        })),
        ...(moved.wrap ? { wrap: { ...moved.wrap, offset: moved.wrap.offset != null ? Math.round(moved.wrap.offset * fs) : undefined } } : {})
      }
    }
    if (moved.type === 'line') {
      return { ...moved, x2: Math.round(moved.x2 * sx), y2: Math.round(moved.y2 * sy) }
    }
    return moved
  }

  const pages = (design.pages ?? []).map((pg) => ({ ...pg, elements: pg.elements.map(scaleElement) }))
  const activePage = design.activePage ?? 0
  const active = pages[activePage]

  return {
    ...design,
    width: target.w,
    height: target.h,
    category: target.category,
    // Top-level elements mirror the active page, exactly as everywhere else.
    elements: active ? active.elements : design.elements.map(scaleElement),
    ...(pages.length ? { pages } : {}),
    ...(design.masters ? { masters: design.masters.map((m) => ({ ...m, elements: m.elements.map(scaleElement) })) } : {}),
    ...(design.margins
      ? {
          margins: {
            top: Math.round(design.margins.top * sy),
            right: Math.round(design.margins.right * sx),
            bottom: Math.round(design.margins.bottom * sy),
            left: Math.round(design.margins.left * sx)
          }
        }
      : {}),
    ...(design.columns ? { columns: { ...design.columns, gutter: Math.round(design.columns.gutter * sx) } } : {}),
    ...(design.guides
      ? { guides: { v: design.guides.v.map((x) => Math.round(x * sx)), h: design.guides.h.map((y) => Math.round(y * sy)) } }
      : {}),
    ...(design.bleed ? { bleed: Math.max(0, Math.round(design.bleed * fs)) } : {})
  }
}

// A blank design at a given size.
export function blankDesign(size: DesignSize): DesignBody {
  return {
    schemaVersion: 1,
    width: size.w,
    height: size.h,
    background: { type: 'solid', color: '#ffffff' },
    elements: [],
    category: size.category
  }
}

// ── Page-layout helpers ──────────────────────────────────────────────────────
// Everything below is what turns the element list into a real page-layout
// document: which master a page inherits, what a page's printed number is, which
// frames a story threads through, and which objects text has to flow around.

/** The master a page inherits, or null when it has none (or detached itself). */
export function masterForPage(design: DesignBody, page: DesignPage | undefined): DesignMaster | null {
  const masters = design.masters ?? []
  if (!page || masters.length === 0) return null
  // An explicit null means the author detached this page from its master.
  if (page.masterId === null) return null
  if (page.masterId) return masters.find((m) => m.id === page.masterId) ?? null
  return masters[0] ?? null
}

/** The number PRINTED on a page, honouring a document that starts at anything but 1. */
export function pageNumberOf(design: DesignBody, index: number): number {
  return (design.pageNumberStart ?? 1) + index
}

export function pageCountOf(design: DesignBody): number {
  return design.pages?.length ?? 1
}

/**
 * A master's elements with their page-number tokens resolved for one page.
 * Only text elements are touched, and only when they actually carry a token, so
 * an untokenised master is returned as-is with no copying.
 */
export function resolveMasterElements(master: DesignMaster, ctx: { page: number; pages: number }): SlideElement[] {
  return master.elements.map((el) => {
    if (el.type !== 'text') return el
    const needs = el.paragraphs.some((p) => p.runs.some((r) => hasPageToken(r.text)))
    if (!needs) return el
    return {
      ...el,
      paragraphs: el.paragraphs.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, text: resolvePageTokens(r.text, ctx) })) }))
    }
  })
}

/** Every frame of a story, across every page, in thread order. */
export function storyFrames(design: DesignBody, storyId: string): Array<{ pageIndex: number; element: SlideTextElement }> {
  const pages = design.pages ?? []
  const out: Array<{ pageIndex: number; element: SlideTextElement }> = []
  pages.forEach((pg, pageIndex) => {
    for (const el of pg.elements) {
      if (el.type === 'text' && el.storyId === storyId) out.push({ pageIndex, element: el })
    }
  })
  // The thread order is explicit where it exists; page order is the tie-break,
  // so a newly linked frame with no order yet still lands somewhere sensible.
  return out.sort((a, b) => {
    const ao = a.element.storyOrder ?? Number.MAX_SAFE_INTEGER
    const bo = b.element.storyOrder ?? Number.MAX_SAFE_INTEGER
    if (ao !== bo) return ao - bo
    return a.pageIndex - b.pageIndex
  })
}

/** Every story id present anywhere in the document. */
export function storyIds(design: DesignBody): string[] {
  const ids = new Set<string>()
  for (const pg of design.pages ?? []) {
    for (const el of pg.elements) if (el.type === 'text' && el.storyId) ids.add(el.storyId)
  }
  return [...ids]
}

/**
 * The boxes story text must flow around on one page: every element set to wrap,
 * minus the frames of the story being flowed (a frame never wraps around itself).
 */
export function wrapObstacles(page: DesignPage, excludeIds: string[] = []): Array<{ x: number; y: number; w: number; h: number; offset: number }> {
  const skip = new Set(excludeIds)
  const out: Array<{ x: number; y: number; w: number; h: number; offset: number }> = []
  for (const el of page.elements) {
    if (skip.has(el.id)) continue
    if (!el.wrap || el.wrap.mode !== 'square') continue
    out.push({ x: el.x, y: el.y, w: el.w, h: el.h, offset: el.wrap.offset ?? 0 })
  }
  return out
}

/** The margin box, or the whole page when no margins are set. */
export function marginBox(design: DesignBody): { x: number; y: number; w: number; h: number } {
  const m = design.margins
  if (!m) return { x: 0, y: 0, w: design.width, h: design.height }
  return {
    x: m.left,
    y: m.top,
    w: Math.max(1, design.width - m.left - m.right),
    h: Math.max(1, design.height - m.top - m.bottom)
  }
}

/**
 * The column rectangles inside the margin box. A text frame dropped on a column
 * snaps to it, and the guides are drawn from the same numbers, so what you see
 * and what you snap to can never disagree.
 */
export function columnBoxes(design: DesignBody): Array<{ x: number; y: number; w: number; h: number }> {
  const box = marginBox(design)
  const grid = design.columns
  if (!grid || grid.count <= 1) return [box]
  const total = box.w - grid.gutter * (grid.count - 1)
  const colW = total / grid.count
  if (colW <= 0) return [box]
  return Array.from({ length: grid.count }, (_, i) => ({
    x: box.x + i * (colW + grid.gutter),
    y: box.y,
    w: colW,
    h: box.h
  }))
}

/** Every x/y a drag should snap to: page edges and centre, margins, columns, guides. */
export function snapTargets(design: DesignBody): { xs: number[]; ys: number[] } {
  const xs = [0, design.width / 2, design.width]
  const ys = [0, design.height / 2, design.height]
  const m = design.margins
  if (m) {
    xs.push(m.left, design.width - m.right)
    ys.push(m.top, design.height - m.bottom)
  }
  for (const c of columnBoxes(design)) xs.push(c.x, c.x + c.w)
  xs.push(...(design.guides?.v ?? []))
  ys.push(...(design.guides?.h ?? []))
  return { xs, ys }
}

/** The base layer every element without an explicit layer belongs to. */
export const BASE_LAYER_ID = 'base'

export function designLayers(design: DesignBody): DesignLayer[] {
  const layers = design.layers ?? []
  if (layers.length) return layers
  return [{ id: BASE_LAYER_ID, name: 'Layer 1', visible: true, locked: false }]
}

export function layerOfElement(el: SlideElement): string {
  return el.layerId ?? BASE_LAYER_ID
}

/** True when an element's layer is currently visible. */
export function elementVisible(design: DesignBody, el: SlideElement): boolean {
  const layer = designLayers(design).find((l) => l.id === layerOfElement(el))
  return layer ? layer.visible : true
}

/** True when an element cannot be selected or moved, because its layer is locked. */
export function elementLocked(design: DesignBody, el: SlideElement): boolean {
  const layer = designLayers(design).find((l) => l.id === layerOfElement(el))
  return layer ? layer.locked : false
}

/**
 * How the pages of a facing-pages document pair up into spreads. Page 1 stands
 * alone on the right, as the cover of a bound document does; after that pages
 * pair left/right. A single-sided document is one page per spread.
 */
export function spreadsOf(design: DesignBody): number[][] {
  const count = pageCountOf(design)
  if (!design.facing) return Array.from({ length: count }, (_, i) => [i])
  const out: number[][] = [[0]]
  for (let i = 1; i < count; i += 2) {
    out.push(i + 1 < count ? [i, i + 1] : [i])
  }
  return out
}

/** A sensible starting margin for a page size: 5% of the short edge, rounded. */
export function defaultMargins(width: number, height: number): DesignMargins {
  const m = Math.round(Math.min(width, height) * 0.075)
  return { top: m, right: m, bottom: m, left: m }
}

/** A blank multi-page publication at a given size, set up like a real document. */
export function blankPublication(size: DesignSize, pages = 1): DesignBody {
  const background: SlideFill = { type: 'solid', color: '#ffffff' }
  const list: DesignPage[] = Array.from({ length: Math.max(1, pages) }, (_, i) => ({
    id: `pg-${i + 1}`,
    background,
    elements: []
  }))
  return {
    schemaVersion: 1,
    width: size.w,
    height: size.h,
    background,
    elements: list[0].elements,
    pages: list,
    activePage: 0,
    category: size.category,
    margins: defaultMargins(size.w, size.h),
    columns: { count: 1, gutter: 16 },
    masters: [{ id: 'master-1', name: 'Master A', elements: [] }],
    layers: [{ id: BASE_LAYER_ID, name: 'Layer 1', visible: true, locked: false }],
    guides: { v: [], h: [] },
    pageNumberStart: 1,
    editingMasterId: null
  }
}
