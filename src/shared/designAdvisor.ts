// Proactive design advice: what a good art director would say, continuously,
// without being asked.
//
// WHY THIS IS NOT AN AI CALL. Most of what makes a layout bad is measurable —
// text that does not fit, type too pale to read, lines 140 characters long,
// six typefaces, a heading no bigger than the body. Asking a language model
// to notice those is slower, costs money, needs a key, and will sometimes
// invent a problem that is not there or miss one that is. Every rule here is
// arithmetic on the document, so the advice is instant, free, offline, and
// either true or a bug.
//
// That leaves judgement — tone, imagery, what the page should actually SAY —
// which is where a model earns its place. The split is deliberate: this module
// is the floor, and AI builds on top of it rather than being asked to
// rediscover it. Advice that can be wrong is worse than none, because a panel
// that cries wolf gets closed and never reopened.
//
// Pure and dependency-free so it can run on every keystroke.

import { contrastRatio } from './brandKit'
import type { DesignBody, DesignMargins } from './design'
import type { SlideElement, SlideTextElement, SlideFill } from './types'
import type { FlowLine } from './designFlow'

export type AdviceSeverity = 'problem' | 'suggestion' | 'idea'

export interface Advice {
  /** Stable per rule+target, so the UI can dismiss one without losing the rest. */
  id: string
  rule: string
  severity: AdviceSeverity
  /** One line, written to be read at a glance in a side panel. */
  title: string
  /** Why it matters and what to do. Never more than a sentence or two. */
  detail: string
  /** The element it concerns, when it is about one. */
  elementId?: string
  /** Page index, for a multi-page document. */
  page?: number
}

export interface AdviceOptions {
  /** Rules to leave out, by rule name. */
  mute?: string[]
  /** Cap, highest severity first. Default 12. */
  limit?: number
}

const SEVERITY_ORDER: AdviceSeverity[] = ['problem', 'suggestion', 'idea']

const isText = (e: SlideElement): e is SlideTextElement => e.type === 'text'

/** Every line the flow engine produced for a text element, if it has flowed. */
function linesOf(e: SlideTextElement): FlowLine[] {
  return e.flowLines ?? []
}

/**
 * The type sizes in an element, from its flow when it has one.
 *
 * Size and colour live on RUNS, not on the paragraph — a paragraph is a list
 * of runs and each may differ — so an un-flowed element is read run by run.
 */
function sizesOf(e: SlideTextElement): number[] {
  const flow = linesOf(e).map((l) => l.size)
  if (flow.length) return flow
  return (e.paragraphs ?? [])
    .flatMap((p) => p.runs ?? [])
    .map((r) => r.fontSize)
    .filter((n): n is number => typeof n === 'number' && n > 0)
}

/**
 * Solid background behind an element: its own fill, else the page's.
 *
 * Typed against SlideFill rather than cast to a structural shape. The first
 * version of this checked `fill.kind === 'solid'`, and the field is `type` —
 * so backdrop always returned null and the contrast rule, the most useful one
 * here, never fired on a real document. The tests passed because the fixtures
 * were written from the same wrong assumption as the code. A real type makes
 * the compiler catch it instead.
 */
function solidOf(fill: SlideFill | undefined): string | null {
  return fill && fill.type === 'solid' && typeof fill.color === 'string' ? fill.color : null
}

function backdrop(e: SlideElement, body: DesignBody): string | null {
  const own = 'fill' in e ? solidOf((e as { fill?: SlideFill }).fill) : null
  return own ?? solidOf(body.background)
}

/**
 * WCAG's own threshold: large type needs 3:1, body needs 4.5:1. "Large" is
 * 24px, or 18.66px when bold — not a round number because it is the published
 * boundary rather than a guess.
 */
function contrastFloor(sizePx: number, bold: boolean): number {
  return sizePx >= 24 || (bold && sizePx >= 18.66) ? 3 : 4.5
}

function elementsOf(body: DesignBody, page: number): SlideElement[] {
  if (body.pages?.length) return body.pages[page]?.elements ?? []
  return body.elements ?? []
}

function pageCount(body: DesignBody): number {
  return body.pages?.length || 1
}

/** Advice about one page's elements. */
function advisePage(body: DesignBody, page: number, out: Advice[]): void {
  const els = elementsOf(body, page)
  const texts = els.filter(isText)
  const at = (rule: string, id?: string): string => `${rule}:${page}:${id ?? '-'}`
  const push = (a: Omit<Advice, 'id'> & { rule: string }): void => {
    out.push({ ...a, id: at(a.rule, a.elementId), page })
  }

  // ── Text that does not fit ────────────────────────────────────────────────
  for (const t of texts) {
    if ((t as { oversetHere?: boolean }).oversetHere) {
      push({
        rule: 'overset',
        severity: 'problem',
        elementId: t.id,
        title: 'Text does not fit in its frame',
        detail:
          'The end of this story has nowhere to go, so readers never see it. Make the frame taller, link it to another frame, or cut the copy.'
      })
    }
  }

  // ── Contrast ──────────────────────────────────────────────────────────────
  for (const t of texts) {
    const bg = backdrop(t, body)
    if (!bg) continue
    const lines = linesOf(t)
    const sample = lines.length
      ? lines.map((l) => ({ color: l.color, size: l.size, bold: !!l.bold }))
      : (t.paragraphs ?? [])
          .flatMap((p) => p.runs ?? [])
          .map((r) => ({ color: r.color, size: r.fontSize ?? 16, bold: !!r.bold }))
    let worst: { ratio: number; need: number } | null = null
    for (const s of sample) {
      if (!s.color) continue
      const ratio = contrastRatio(s.color, bg)
      const need = contrastFloor(s.size ?? 16, s.bold)
      if (ratio < need && (!worst || ratio < worst.ratio)) worst = { ratio, need }
    }
    if (worst) {
      push({
        rule: 'contrast',
        severity: 'problem',
        elementId: t.id,
        title: `Text is too pale to read (${worst.ratio.toFixed(1)}:1)`,
        detail: `This needs at least ${worst.need}:1 against its background to be legible. Darken the type or lighten what is behind it.`
      })
    }
  }

  // ── Line length ───────────────────────────────────────────────────────────
  // The 45-75 character measure is the oldest rule in typesetting and the one
  // most often broken by making a frame as wide as the page.
  for (const t of texts) {
    const lines = linesOf(t).filter((l) => !l.lastOfPara && l.text.trim().length > 0)
    if (lines.length < 4) continue
    const avg = lines.reduce((s, l) => s + l.text.length, 0) / lines.length
    if (avg > 95) {
      push({
        rule: 'measure-long',
        severity: 'suggestion',
        elementId: t.id,
        title: `Lines are long (about ${Math.round(avg)} characters)`,
        detail:
          'Past roughly 75 characters the eye loses its place returning to the next line. Narrow the frame or set it in columns.'
      })
    } else if (avg < 32) {
      push({
        rule: 'measure-short',
        severity: 'suggestion',
        elementId: t.id,
        title: `Lines are short (about ${Math.round(avg)} characters)`,
        detail:
          'Very narrow measures break the rhythm of reading and force awkward hyphenation. Widen the frame or reduce the type size.'
      })
    }
  }

  // ── Leading ───────────────────────────────────────────────────────────────
  for (const t of texts) {
    const lines = linesOf(t)
    const tight = lines.find((l) => l.size > 0 && l.lh > 0 && l.lh / l.size < 1.15 && l.size <= 20)
    if (tight) {
      push({
        rule: 'leading',
        severity: 'suggestion',
        elementId: t.id,
        title: 'Body text is set tight',
        detail:
          'Line spacing under about 1.2 times the type size makes paragraphs look dense and harder to scan. Open the leading a little.'
      })
    }
  }

  // ── Elements outside the margin box ───────────────────────────────────────
  const m: DesignMargins | undefined = body.margins
  if (m) {
    for (const e of els) {
      const outTop = e.y < m.top - 0.5
      const outLeft = e.x < m.left - 0.5
      const outRight = e.x + e.w > body.width - m.right + 0.5
      const outBottom = e.y + e.h > body.height - m.bottom + 0.5
      if (outTop || outLeft || outRight || outBottom) {
        push({
          rule: 'margins',
          severity: 'suggestion',
          elementId: e.id,
          title: 'This sits outside the margins',
          detail:
            'Margins are what keep a page from feeling crowded, and on a printed piece they are what survives trimming. Deliberate bleeds are fine; strays are not.'
        })
      }
    }
  }

  // ── Off the page entirely ─────────────────────────────────────────────────
  const bleed = body.bleed ?? 0
  for (const e of els) {
    if (e.x + e.w < -bleed || e.y + e.h < -bleed || e.x > body.width + bleed || e.y > body.height + bleed) {
      push({
        rule: 'offcanvas',
        severity: 'problem',
        elementId: e.id,
        title: 'This is off the page',
        detail: 'It will not appear in the export. Move it back on, or delete it if it was left behind.'
      })
    }
  }

  // ── Hierarchy ─────────────────────────────────────────────────────────────
  const allSizes = texts.flatMap(sizesOf).filter((n) => n > 0)
  if (allSizes.length >= 2) {
    const biggest = Math.max(...allSizes)
    // The commonest size is the body; the largest should clearly outrank it.
    const counts = new Map<number, number>()
    for (const s of allSizes) counts.set(Math.round(s), (counts.get(Math.round(s)) ?? 0) + 1)
    const bodySize = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    if (bodySize > 0 && biggest / bodySize < 1.3) {
      push({
        rule: 'hierarchy',
        severity: 'suggestion',
        title: 'Nothing stands out',
        detail:
          'The largest type is barely bigger than the body, so the eye has no entry point. Make the headline clearly dominant, or set it in a heavier weight.'
      })
    }
  }
}

/** Advice about the document as a whole. */
function adviseDocument(body: DesignBody, out: Advice[]): void {
  const all: SlideElement[] = []
  for (let p = 0; p < pageCount(body); p++) all.push(...elementsOf(body, p))
  const texts = all.filter(isText)

  const families = new Set<string>()
  for (const t of texts) {
    if (t.fontFamily) families.add(t.fontFamily)
    for (const l of linesOf(t)) if (l.family) families.add(l.family)
  }
  if (families.size > 3) {
    out.push({
      id: 'fonts:-:-',
      rule: 'fonts',
      severity: 'suggestion',
      title: `${families.size} typefaces in one document`,
      detail:
        'Two usually does it, three at the most. Extra families read as inconsistency rather than variety — use weight and size for contrast instead.'
    })
  }

  const sizes = new Set(texts.flatMap(sizesOf).map((s) => Math.round(s)))
  if (sizes.size > 6) {
    out.push({
      id: 'sizes:-:-',
      rule: 'sizes',
      severity: 'suggestion',
      title: `${sizes.size} different type sizes`,
      detail:
        'A scale of four or five sizes makes a document feel designed. More than that and the hierarchy stops being readable as a system.'
    })
  }
}

/**
 * Everything worth saying about this document, worst first.
 *
 * Deterministic: the same document always produces the same advice, in the
 * same order. A panel whose contents shuffle on every keystroke is unusable,
 * and a rule that fires intermittently cannot be trusted or fixed.
 */
export function adviseDesign(body: DesignBody, opts: AdviceOptions = {}): Advice[] {
  const out: Advice[] = []
  for (let p = 0; p < pageCount(body); p++) advisePage(body, p, out)
  adviseDocument(body, out)

  const muted = new Set(opts.mute ?? [])
  const kept = out.filter((a) => !muted.has(a.rule))
  kept.sort((a, b) => {
    const s = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    if (s !== 0) return s
    return a.id.localeCompare(b.id)
  })
  return kept.slice(0, opts.limit ?? 12)
}

/** A one-line summary for a status bar: "3 problems, 2 suggestions". */
export function adviceSummary(advice: Advice[]): string {
  const problems = advice.filter((a) => a.severity === 'problem').length
  const suggestions = advice.filter((a) => a.severity !== 'problem').length
  if (!problems && !suggestions) return 'No issues found'
  const parts: string[] = []
  if (problems) parts.push(`${problems} problem${problems === 1 ? '' : 's'}`)
  if (suggestions) parts.push(`${suggestions} suggestion${suggestions === 1 ? '' : 's'}`)
  return parts.join(', ')
}
