// "Check this": marking the specifics an answer states that its sources do not
// (main/ai/answerGrounding.ts). Shared by the chat (markdown, via the remark
// plugin) and the plain-text answers (PlexiSearch Ask, Ask your workspace).
// Pure, so it unit-tests without React.
import type { AnswerGrounding } from '@shared/types'

/** What a repaired span reads as (main/ai/answerGrounding.ts ANSWER_GAP). */
export const ANSWER_GAP = '[not in your documents]'

export interface CheckSpan {
  span: string
  reason: string
}

/** The spans to mark: each flagged specific, and the gaps the on-device check left. */
export function checkSpansFor(g: AnswerGrounding | undefined | null): CheckSpan[] {
  if (!g) return []
  const out: CheckSpan[] = g.flagged.map((f) => ({ span: f.span, reason: `Check this: ${f.reason}.` }))
  if (g.repaired.length > 0) {
    out.push({
      span: ANSWER_GAP,
      reason: `The answer stated ${g.repaired.map((f) => `“${f.span}”`).join(', ')}, which your documents do not say, so it was taken out.`
    })
  }
  return out
}

/** One line under an answer saying what was marked, or null when nothing was. */
export function checkSummary(g: AnswerGrounding | undefined | null): string | null {
  if (!g) return null
  const parts: string[] = []
  if (g.repaired.length) parts.push(`${g.repaired.length === 1 ? 'one detail' : `${g.repaired.length} details`} your documents do not support ${g.repaired.length === 1 ? 'was' : 'were'} taken out`)
  if (g.flagged.length) parts.push(`${g.flagged.length === 1 ? 'one detail is' : `${g.flagged.length} details are`} not in your documents: check ${g.flagged.length === 1 ? 'it' : 'them'} before relying on this`)
  return parts.length ? `${parts.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()) : null
}

/** Split text into plain and marked pieces, longest spans first, never overlapping. */
export function splitCheck(text: string, spans: CheckSpan[]): Array<{ text: string; check?: string }> {
  if (!spans.length || !text) return [{ text }]
  const hits: Array<{ at: number; end: number; reason: string }> = []
  for (const s of [...spans].sort((a, b) => b.span.length - a.span.length)) {
    if (!s.span) continue
    let from = 0
    for (;;) {
      const at = text.indexOf(s.span, from)
      if (at < 0) break
      const end = at + s.span.length
      if (!hits.some((h) => at < h.end && end > h.at)) hits.push({ at, end, reason: s.reason })
      from = end
    }
  }
  if (!hits.length) return [{ text }]
  hits.sort((a, b) => a.at - b.at)
  const out: Array<{ text: string; check?: string }> = []
  let last = 0
  for (const h of hits) {
    if (h.at > last) out.push({ text: text.slice(last, h.at) })
    out.push({ text: text.slice(h.at, h.end), check: h.reason })
    last = h.end
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}
const SKIP = new Set(['code', 'inlineCode', 'link', 'linkReference', 'definition'])

/** remark plugin: wrap marked spans in <mark data-check="reason">. */
export function remarkCheckThis(spans: CheckSpan[]): () => (tree: MdNode) => void {
  const walk = (node: MdNode): void => {
    const kids = node.children
    if (!Array.isArray(kids)) return
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]
      if (SKIP.has(child.type)) continue
      if (child.type === 'text' && typeof child.value === 'string') {
        const parts = splitCheck(child.value, spans)
        if (parts.length > 1 || parts[0]?.check) {
          const nodes: MdNode[] = parts.map((p) =>
            p.check
              ? { type: 'checkThis', children: [{ type: 'text', value: p.text }], data: { hName: 'mark', hProperties: { 'data-check': p.check } } }
              : { type: 'text', value: p.text }
          )
          kids.splice(i, 1, ...nodes)
          i += nodes.length - 1
        }
        continue
      }
      walk(child)
    }
  }
  return () => (tree: MdNode) => walk(tree)
}
