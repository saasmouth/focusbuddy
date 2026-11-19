// Serialisation between the composer's rich document and what actually gets
// sent (Phase 4.3), pure and editor-free so both directions are unit-testable
// without mounting TipTap.
//
// Two directions, and they answer the two halves of plan P1 ("two renderings of
// one set"):
//
//   docToInput()      the composer's TipTap JSON  →  { text, refs }
//                     The text is what the model and the transcript see, with
//                     each chip written as a readable "@Title". ChatMessage
//                     stays a plain string — it is load-bearing across every
//                     surface (focus chat, dashboard cards, FieldEditor), and
//                     widening it for this feature would be a change none of
//                     them asked for.
//
//   splitMentionText() a sent message's text + its refs  →  segments
//                     Lets a past turn re-render its chips inline, exactly where
//                     they were typed, without the transcript having to store
//                     markup.
//
// The honesty rule for the second direction: a segment becomes a chip ONLY when
// the reference's own title is genuinely present in the text at that point.
// Nothing is chipped by guesswork, and a reference the user edited out of their
// sentence simply does not render — it never gets a chip pointing at words that
// are not there.

import type { MentionRef } from './assistantMentions'

// The subset of TipTap's JSONContent this module walks. Declared locally so the
// pure module carries no editor dependency.
export interface ComposerNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: ComposerNode[]
}

// How a chip is written into the plain text. Chosen to read naturally to the
// model and in the transcript — "@Q3 brief" is what the user typed and what
// they meant — rather than a machine marker they never asked to see.
export function mentionToken(title: string): string {
  return `@${title}`
}

// Walk the composer document into the message text plus the references it
// contains, in the order they appear. Block-level nodes separate with newlines;
// everything else concatenates, so a paragraph reads as one line.
export function docToInput(doc: ComposerNode | null | undefined): {
  text: string
  refs: MentionRef[]
} {
  const refs: MentionRef[] = []
  const seen = new Set<string>()

  const walk = (node: ComposerNode | undefined): string => {
    if (!node) return ''
    if (node.type === 'text') return node.text ?? ''
    // ⇧↵, and every <br> or <pre> line in pasted text, is a hard break: a line
    // of its own in what the assistant reads. Returning nothing here joined
    // pasted code, logs and emails into one line ("line1line2").
    if (node.type === 'hardBreak') return '\n'
    if (node.type === 'mention') {
      const a = node.attrs ?? {}
      const title = typeof a.title === 'string' ? a.title : ''
      const kind = typeof a.kind === 'string' ? a.kind : ''
      const id = typeof a.id === 'string' ? a.id : ''
      // A malformed chip contributes nothing rather than a half-reference: a
      // token with no id behind it would read like a mention and carry none.
      if (!title || !kind || !id) return ''
      const key = `${kind}:${id}`
      if (!seen.has(key)) {
        seen.add(key)
        refs.push({
          kind: kind as MentionRef['kind'],
          id,
          title,
          icon: typeof a.icon === 'string' ? a.icon : 'attachment',
          taskId: typeof a.taskId === 'string' ? a.taskId : null,
          conversationKey: typeof a.conversationKey === 'string' ? a.conversationKey : ''
        })
      }
      return mentionToken(title)
    }
    const inner = (node.content ?? []).map(walk).join('')
    // Paragraphs and headings are the block boundaries this composer can
    // produce; everything else is inline.
    return node.type === 'paragraph' || node.type === 'heading' ? `${inner}\n` : inner
  }

  const text = (doc?.content ?? []).map(walk).join('').replace(/\n+$/, '')
  return { text, refs }
}

export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; ref: MentionRef }

// Re-derive where each reference sits in a sent message so a past turn can draw
// its chips inline. Each reference claims the FIRST occurrence of its own token
// that has not already been claimed, scanning left to right — so two references
// whose titles overlap cannot both point at the same words.
//
// A reference whose token is absent (the user edited the words away before
// sending) yields no segment at all. The transcript shows what was actually
// sent; it never grows a chip to match a reference that is not in the sentence.
export function splitMentionText(
  text: string,
  refs: readonly MentionRef[]
): MentionSegment[] {
  if (!text) return []
  if (refs.length === 0) return [{ kind: 'text', text }]

  // Longest title first, so "@Q3 brief" wins over "@Q3" when both are present
  // and the shorter one would otherwise swallow the prefix.
  const ordered = [...refs].sort((a, b) => b.title.length - a.title.length)
  const claims: Array<{ start: number; end: number; ref: MentionRef }> = []
  const taken: Array<[number, number]> = []
  const overlaps = (s: number, e: number): boolean =>
    taken.some(([ts, te]) => s < te && ts < e)

  for (const ref of ordered) {
    const token = mentionToken(ref.title)
    if (!token || token === '@') continue
    let from = 0
    for (;;) {
      const at = text.indexOf(token, from)
      if (at < 0) break
      if (!overlaps(at, at + token.length)) {
        claims.push({ start: at, end: at + token.length, ref })
        taken.push([at, at + token.length])
        break
      }
      from = at + 1
    }
  }

  if (claims.length === 0) return [{ kind: 'text', text }]
  claims.sort((a, b) => a.start - b.start)

  const out: MentionSegment[] = []
  let cursor = 0
  for (const c of claims) {
    if (c.start > cursor) out.push({ kind: 'text', text: text.slice(cursor, c.start) })
    out.push({ kind: 'mention', ref: c.ref })
    cursor = c.end
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) })
  return out
}
