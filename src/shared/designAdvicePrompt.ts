// The brief handed to a model when someone asks it to improve a design.
//
// The advisor already knows what is measurably wrong: contrast, measure,
// leading, margins, hierarchy, overset. A model asked "what is wrong with
// this design?" would re-derive some of that, miss some, and invent the
// rest — it cannot see the page, only a description of it. So the findings
// go IN as fact, and the model is asked for the thing it is actually good
// at: what to write instead, and which of several fixes suits this piece.
//
// That split is the same one the advisor itself rests on. Arithmetic answers
// the measurable questions; judgement answers the rest; neither is asked to
// do the other's job.
//
// The work is in two halves on purpose:
//
//   designBrief()       runs where the document is — the renderer — and
//                       reduces it to a few hundred bytes of flat facts.
//   buildAdvicePrompt() runs in main, next to the key, and turns those facts
//                       into what the model is told.
//
// Which means the IPC call carries a digest, the findings and the words, not
// the document: a design with embedded images is megabytes, and none of those
// bytes say anything a model could act on. It also means the renderer never
// supplies prose that becomes a system prompt — it supplies facts, and main
// owns the wording.
//
// Both halves are pure, so what the model is told can be tested without a
// network call or a key — which matters, because the failure mode here is a
// prompt that quietly invites invention.

import type { Advice } from './designAdvisor'
import type { DesignBody } from './design'
import type { SlideElement, SlideTextElement } from './types'

/** One measured finding, flattened for the wire. */
export interface BriefFinding {
  severity: string
  title: string
  detail: string
}

/**
 * Everything the model is given about a design: facts only, no judgement and
 * no prose that steers it. Small enough to send on every pass.
 */
export interface DesignBrief {
  /** A factual description of the document. */
  digest: string
  /** The measured findings, already filtered by whatever the person dismissed. */
  findings: BriefFinding[]
  /** The words currently on the page, in reading order, capped. */
  text: string
  /** What the piece is for, when the person has said. Never guessed. */
  purpose?: string
}

export interface AdvicePrompt {
  /**
   * The designer instructions, WITHOUT the grounding rule.
   *
   * GROUNDING_RULE lives in src/main/ai, and src/shared must not reach into
   * the main process — so the caller in main appends it, along with whatever
   * output contract that call site needs.
   */
  system: string
  user: string
}

const isText = (e: SlideElement): e is SlideTextElement => e.type === 'text'

/** The words actually on the page, in reading order, as the model's material. */
export function designText(body: DesignBody, limit = 2000): string {
  const pages = body.pages?.length ? body.pages.map((p) => p.elements ?? []) : [body.elements ?? []]
  const out: string[] = []
  let used = 0
  pages.forEach((els, i) => {
    const texts = els
      .filter(isText)
      .slice()
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((t) =>
        (t.flowLines?.length
          ? t.flowLines.map((l) => l.text).join(' ')
          : (t.paragraphs ?? []).flatMap((p) => p.runs ?? []).map((r) => r.text).join('')
        ).trim()
      )
      .filter(Boolean)
    if (!texts.length) return
    const header = pages.length > 1 ? `Page ${i + 1}:` : ''
    for (const t of [header, ...texts].filter(Boolean)) {
      if (used >= limit) return
      const clipped = t.slice(0, Math.max(0, limit - used))
      out.push(clipped)
      used += clipped.length
    }
  })
  return out.join('\n')
}

/** A factual description of the document, with no judgement in it. */
export function designDigest(body: DesignBody): string {
  const pages = body.pages?.length ? body.pages.map((p) => p.elements ?? []) : [body.elements ?? []]
  const all = pages.flat()
  const counts = new Map<string, number>()
  for (const e of all) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
  const parts = [
    `Canvas ${Math.round(body.width)}x${Math.round(body.height)}px`,
    `${pages.length} page${pages.length === 1 ? '' : 's'}`,
    [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(', ') || 'no elements'
  ]
  if (body.bleed) parts.push(`${body.bleed}px bleed`)
  if (body.columns) parts.push(`${body.columns.count}-column grid`)
  return parts.join('. ') + '.'
}

export interface BriefOptions {
  /** What the piece is for, when the person has said so. Never inferred. */
  purpose?: string
  /** Cap on text sampled from the design, in characters. */
  maxTextChars?: number
}

/** Reduce a live document and its measured findings to the flat brief. */
export function designBrief(body: DesignBody, advice: Advice[], opts: BriefOptions = {}): DesignBrief {
  const brief: DesignBrief = {
    digest: designDigest(body),
    findings: advice.map((a) => ({ severity: a.severity, title: a.title, detail: a.detail })),
    text: designText(body, opts.maxTextChars ?? 2000)
  }
  const purpose = opts.purpose?.trim()
  if (purpose) brief.purpose = purpose
  return brief
}

// Ceilings for a brief that arrived over IPC. The renderer that builds one is
// first-party, but the prompt is spent next to a key and a credit balance, so
// the side holding those decides how much it will read.
const MAX_FINDINGS = 24
const MAX_TEXT = 4000
const MAX_DIGEST = 600
const MAX_PURPOSE = 400
const MAX_FIELD = 400

const clampStr = (s: unknown, n: number): string => (typeof s === 'string' ? s.slice(0, n) : '')

/** Trim a brief to what a prompt will carry. Applied in main, to anything inbound. */
export function clampBrief(brief: DesignBrief): DesignBrief {
  const out: DesignBrief = {
    digest: clampStr(brief?.digest, MAX_DIGEST),
    findings: (Array.isArray(brief?.findings) ? brief.findings : []).slice(0, MAX_FINDINGS).map((f) => ({
      severity: clampStr(f?.severity, 20),
      title: clampStr(f?.title, MAX_FIELD),
      detail: clampStr(f?.detail, MAX_FIELD)
    })),
    text: clampStr(brief?.text, MAX_TEXT)
  }
  const purpose = clampStr(brief?.purpose, MAX_PURPOSE).trim()
  if (purpose) out.purpose = purpose
  return out
}

/**
 * A short, stable key for one brief.
 *
 * The panel reviews proactively while someone works, so it needs to know when
 * the document has actually changed in a way the model would answer
 * differently — not merely that React re-rendered. Two equal briefs give the
 * same key, and any change to the words, the findings or the canvas gives a
 * different one.
 */
export function briefKey(brief: DesignBrief): string {
  const s = JSON.stringify([brief.digest, brief.findings, brief.text, brief.purpose ?? ''])
  // djb2. Not a security hash: a key for "has this changed", kept cheap
  // because it is recomputed on every keystroke.
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36) + ':' + s.length.toString(36)
}

/**
 * Build the brief.
 *
 * The findings are given as SETTLED FACTS, with an explicit instruction not
 * to dispute or re-derive them. A model that cannot see the page will
 * otherwise hedge — "the contrast may be low" — which turns a measured 2.1:1
 * into a maybe, and the person stops trusting the panel.
 */
export function buildAdvicePrompt(brief: DesignBrief): AdvicePrompt {
  const system =
    'You are a senior designer reviewing a colleague\'s layout. ' +
    'A measuring tool has already checked this design and its findings are given to you as fact: they are arithmetic on the document, not opinions, so do not dispute them, re-derive them, or hedge them with "may be" or "appears to". ' +
    'Your job is the part measurement cannot do. For each finding, say what you would actually DO about it in this specific piece, not the general rule. Then, separately, suggest improvements to the WORDS and the IDEA that no measurement would catch: a sharper headline, a cut that tightens it, a structure that lands better. ' +
    'Be concrete and brief. Three or four suggestions a person can act on today beat a list of twelve. ' +
    'If the measuring tool found nothing and the copy reads well, say so plainly rather than inventing work.'

  const findings = brief.findings.length
    ? brief.findings.map((f) => `- [${f.severity}] ${f.title} — ${f.detail}`).join('\n')
    : '(The measuring tool found nothing. Contrast, measure, leading, margins and hierarchy are all within range.)'

  const user = [
    brief.purpose ? `What this is for: ${brief.purpose}` : null,
    `The document: ${brief.digest}`,
    '',
    'Measured findings:',
    findings,
    '',
    brief.text ? 'The words currently on the page:' : 'The page has no text yet.',
    brief.text
  ]
    .filter((l) => l !== null && l !== '')
    .join('\n')

  return { system, user }
}
