// Preflight — will this document actually come out of a printer correctly?
//
// Distinct from designAdvisor, which asks whether a layout is any GOOD.
// Preflight asks a narrower and more consequential question: will what you
// see survive output. A page can be beautifully designed and still cost a
// re-run because an image was 72 PPI, the background stopped at the trim
// edge, or a rule was thinner than the press can hold.
//
// Everything here is arithmetic on the document, like the advisor, and for
// the same reason: a preflight that guesses is worse than none, because its
// whole value is that you can act on it without checking.
//
// WHAT IS DELIBERATELY NOT CHECKED, because the data does not exist:
//
//   Colour space. Every colour in this model is RGB hex. There is no CMYK
//   pipeline, so "this will shift on press" would be invented. Spot inks ARE
//   reported, because those are named and countable.
//   Total ink coverage and rich black. Same reason — they are CMYK figures.
//   Font embedding. The exporter's business, not the document's.
//
// An honest gap is better than a confident guess: a preflight report that
// lists a problem the tool cannot actually see teaches people to ignore the
// ones it can.

import { CSS_DPI } from './draw'
import { spotInks } from './designSwatches'
import type { DesignBody } from './design'
import type { SlideElement, SlideImageElement, SlideTextElement, SlideBorder } from './types'

export type PreflightSeverity = 'error' | 'warning' | 'info'

export interface PreflightItem {
  id: string
  rule: string
  severity: PreflightSeverity
  title: string
  detail: string
  elementId?: string
  page?: number
}

export interface PreflightOptions {
  /** PPI below which an image is an error. Default 150. */
  minImagePpi?: number
  /** PPI below which an image is a warning. Default 300, the usual print bar. */
  goodImagePpi?: number
  /**
   * Thinnest rule the press can hold, in points. Default 0.25pt, which is the
   * common "hairline" floor; below it a line prints broken or not at all.
   */
  minStrokePt?: number
  /** Smallest text, in points, that prints legibly. Default 5pt. */
  minTextPt?: number
  /** Keep live content this far inside the trim, in px. Default 1/8 inch. */
  safeMargin?: number
}

const PT_PER_PX = 72 / CSS_DPI

const pages = (body: DesignBody): SlideElement[][] =>
  body.pages?.length ? body.pages.map((p) => p.elements ?? []) : [body.elements ?? []]

const isImage = (e: SlideElement): e is SlideImageElement => e.type === 'image'
const isText = (e: SlideElement): e is SlideTextElement => e.type === 'text'

/**
 * Effective resolution of a placed image, in PPI, or null when unknown.
 *
 * null is a real answer and is reported as such. The natural size is captured
 * on insert, so an image that predates that, or came in by a path which did
 * not record it, genuinely has an unknown resolution — and "unknown" is what
 * the printer needs to hear, not a number derived from nothing.
 */
export function effectivePpi(e: SlideImageElement): number | null {
  if (!e.naturalW || !e.naturalH || e.w <= 0 || e.h <= 0) return null
  const crop = e.crop
  const usedW = e.naturalW * (1 - (crop?.l ?? 0) - (crop?.r ?? 0))
  const usedH = e.naturalH * (1 - (crop?.t ?? 0) - (crop?.b ?? 0))
  if (usedW <= 0 || usedH <= 0) return null
  // Cropping REDUCES the pixels available to the same frame, so it lowers
  // effective resolution — the commonest way a good photograph becomes an
  // unprintable one.
  return Math.min((usedW / e.w) * CSS_DPI, (usedH / e.h) * CSS_DPI)
}

const borderOf = (e: SlideElement): SlideBorder | undefined =>
  (e as { border?: SlideBorder }).border

/** Everything that would stop this document printing correctly, worst first. */
export function preflight(body: DesignBody, opts: PreflightOptions = {}): PreflightItem[] {
  const minPpi = opts.minImagePpi ?? 150
  const goodPpi = opts.goodImagePpi ?? 300
  const minStroke = opts.minStrokePt ?? 0.25
  const minText = opts.minTextPt ?? 5
  const safe = opts.safeMargin ?? CSS_DPI / 8
  const bleed = body.bleed ?? 0
  const out: PreflightItem[] = []
  const add = (i: Omit<PreflightItem, 'id'>): void => {
    out.push({ ...i, id: `${i.rule}:${i.page ?? '-'}:${i.elementId ?? '-'}` })
  }

  pages(body).forEach((els, page) => {
    for (const e of els) {
      // ── Images ────────────────────────────────────────────────────────────
      if (isImage(e)) {
        if (!e.src) {
          add({
            rule: 'image-missing', severity: 'error', page, elementId: e.id,
            title: 'An image frame has no image',
            detail: 'It will print as an empty box. Replace it or delete the frame.'
          })
        } else {
          const ppi = effectivePpi(e)
          if (ppi === null) {
            add({
              rule: 'image-unknown', severity: 'info', page, elementId: e.id,
              title: 'Image resolution is unknown',
              detail:
                'This image did not record its pixel size, so its print resolution cannot be checked here. Open it at full size before committing to a print run.'
            })
          } else if (ppi < minPpi) {
            add({
              rule: 'image-low', severity: 'error', page, elementId: e.id,
              title: `Image is ${Math.round(ppi)} PPI at this size`,
              detail: `Below about ${minPpi} PPI an image prints visibly soft. Use a larger original or make the frame smaller.`
            })
          } else if (ppi < goodPpi) {
            add({
              rule: 'image-soft', severity: 'warning', page, elementId: e.id,
              title: `Image is ${Math.round(ppi)} PPI at this size`,
              detail: `Print usually wants ${goodPpi} PPI. It will be acceptable rather than crisp.`
            })
          }
        }
      }

      // ── Hairlines ─────────────────────────────────────────────────────────
      const b = borderOf(e)
      if (b && b.width > 0 && b.width * PT_PER_PX < minStroke) {
        add({
          rule: 'hairline', severity: 'warning', page, elementId: e.id,
          title: `Rule is thinner than ${minStrokePt(minStroke)}`,
          detail:
            'A line this fine can print broken, or disappear entirely, depending on the press and the paper. Thicken it or accept that it may not survive.'
        })
      }

      // ── Type too small to read ────────────────────────────────────────────
      if (isText(e)) {
        const sizes = (e.flowLines ?? []).map((l) => l.size)
        const smallest = sizes.length ? Math.min(...sizes) : null
        if (smallest !== null && smallest * PT_PER_PX < minText) {
          add({
            rule: 'tiny-text', severity: 'warning', page, elementId: e.id,
            title: `Text is about ${(smallest * PT_PER_PX).toFixed(1)}pt`,
            detail: `Under ${minText}pt is hard to read in print and can fill in on absorbent paper.`
          })
        }
        if ((e as { oversetHere?: boolean }).oversetHere) {
          add({
            rule: 'overset', severity: 'error', page, elementId: e.id,
            title: 'Text does not fit and will not print',
            detail: 'The end of this story has nowhere to go. Enlarge the frame, link it onward, or cut the copy.'
          })
        }
      }

      // ── Trim safety ───────────────────────────────────────────────────────
      // Trimming is mechanical and moves by a millimetre or two, so content
      // near the edge is content that might be cut.
      const nearTrim =
        e.x < safe || e.y < safe || e.x + e.w > body.width - safe || e.y + e.h > body.height - safe
      const intentionalBleed =
        bleed > 0 && (e.x <= 0 || e.y <= 0 || e.x + e.w >= body.width || e.y + e.h >= body.height)
      if (nearTrim && !intentionalBleed) {
        add({
          rule: 'trim-safety', severity: 'warning', page, elementId: e.id,
          title: 'This sits close to the trimmed edge',
          detail:
            'Trimming moves by a millimetre or two, so anything this near the edge may be cut into. Pull it in, or run it fully off the page so it bleeds.'
        })
      }
    }
  })

  // ── Bleed coverage ──────────────────────────────────────────────────────
  // A background that stops exactly at the trim leaves a white sliver when
  // the cut lands a hair outside it — the single commonest print fault.
  if (bleed > 0) {
    const bg = body.background
    if (!bg || bg.type === 'none') {
      add({
        rule: 'bleed-empty', severity: 'info',
        title: 'Bleed is set but the page has no background',
        detail: 'Only elements that run off the edge will bleed. If the page should print edge to edge, give it a background.'
      })
    }
  }

  // ── Spot inks ───────────────────────────────────────────────────────────
  const spots = spotInks(body)
  if (spots.length) {
    add({
      rule: 'spot-inks', severity: 'info',
      title: `${spots.length} spot ink${spots.length === 1 ? '' : 's'}: ${spots.map((s) => s.spot?.inkName).join(', ')}`,
      detail:
        'Each spot ink is a separate plate and is priced as one. Convert them to process if the job does not need exact colour matching.'
    })
  }

  const order: PreflightSeverity[] = ['error', 'warning', 'info']
  return out.sort((a, b) => {
    const s = order.indexOf(a.severity) - order.indexOf(b.severity)
    return s !== 0 ? s : a.id.localeCompare(b.id)
  })
}

function minStrokePt(pt: number): string {
  return `${pt}pt`
}

/** One line for a status bar or an export dialog. */
export function preflightSummary(items: PreflightItem[]): string {
  const errors = items.filter((i) => i.severity === 'error').length
  const warnings = items.filter((i) => i.severity === 'warning').length
  if (!errors && !warnings) return 'Ready to print'
  const parts: string[] = []
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`)
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`)
  return parts.join(', ')
}
