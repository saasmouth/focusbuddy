// Footnotes as text: the bridge between what a person types and what the
// footnote engine (designFootnotes.ts) needs.
//
// A person writes the Markdown they already know:
//
//   The press moved to Leipzig[^1] that spring.
//
//   [^1]: Rosenthal, *A History of Type*, p.212.
//
// designContent.ts parses the definition line into a `footnote` block. What is
// left is the inline token, and the engine needs three things this module
// produces: the notes, a REAL superscript marker in the paragraph text where
// each token was (the flow engine measures text to break lines, so a marker it
// cannot see makes every following line slightly too long), and the character
// offset of that marker so the engine can tell which frame it landed in.
//
// A reference to an id nobody defined is left exactly as typed. Silently
// dropping it would hide the typo; turning it into a marker would print a
// number with no note under it.
//
// Pure string work, so the whole arrangement is testable without a DOM.

import type { ContentDoc } from './designContent'
import { footnoteMarker, numberFootnotes, type FootnoteDef, type FootnoteRefParagraph } from './designFootnotes'
import type { FlowParagraph } from './designFlow'

/** An inline reference: [^1], [^note-a]. */
const REF = /\[\^([A-Za-z0-9_-]{1,32})\]/g

/** The notes a story defines, in the order they are written. */
export function storyFootnotes(doc: ContentDoc | undefined): FootnoteDef[] {
  const out: FootnoteDef[] = []
  const seen = new Set<string>()
  for (const b of doc?.blocks ?? []) {
    if (b.kind !== 'footnote' || seen.has(b.id)) continue
    seen.add(b.id)
    out.push({ id: b.id, text: b.text })
  }
  return out
}

/** Does this story reference any note it has defined? */
export function hasFootnotes(doc: ContentDoc | undefined): boolean {
  const defined = new Set(storyFootnotes(doc).map((n) => n.id))
  if (defined.size === 0) return false
  for (const b of doc?.blocks ?? []) {
    if (b.kind === 'footnote') continue
    const text = 'text' in b ? b.text : 'items' in b ? b.items.join(' ') : ''
    for (const m of text.matchAll(REF)) if (defined.has(m[1])) return true
  }
  return false
}

/**
 * Rewrite paragraphs for the footnote engine.
 *
 * Numbering follows the order the markers appear in the STORY, so a note keeps
 * its number when the text reflows onto another page, and a second reference
 * to the same note repeats its number rather than taking a new one.
 */
export function withFootnoteMarkers(
  paragraphs: FlowParagraph[],
  notes: FootnoteDef[]
): FootnoteRefParagraph[] {
  const defined = new Set(notes.map((n) => n.id))
  if (defined.size === 0) return paragraphs

  // Pass one: the ids in reading order, which fixes the numbering before any
  // text is rewritten.
  const order: string[] = []
  for (const p of paragraphs) {
    for (const m of p.text.matchAll(REF)) if (defined.has(m[1])) order.push(m[1])
  }
  if (order.length === 0) return paragraphs
  const numbers = numberFootnotes(order)

  // Pass two: swap each token for its marker and record where it landed.
  return paragraphs.map((p) => {
    if (!REF.test(p.text)) {
      REF.lastIndex = 0
      return p
    }
    REF.lastIndex = 0
    let text = ''
    let last = 0
    const refs: Array<{ id: string; offset: number }> = []
    for (const m of p.text.matchAll(REF)) {
      const id = m[1]
      const at = m.index ?? 0
      text += p.text.slice(last, at)
      last = at + m[0].length
      if (!defined.has(id)) {
        // Unknown note: leave the token as written, and do not record a ref.
        text += m[0]
        continue
      }
      refs.push({ id, offset: text.length })
      text += numbers.get(id) ?? footnoteMarker(1)
    }
    text += p.text.slice(last)
    return refs.length ? { ...p, text, footnoteRefs: refs } : { ...p, text }
  })
}
