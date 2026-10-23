// Converting a local document's comment anchors when it is shared.
//
// A local anchor is a plain range plus a quote; a live anchor is a pair of Yjs
// RelativePositions, which survive other people typing because they name an
// ITEM rather than count characters. Sharing is the one moment when the two
// have to meet, and it has an awkward shape: at share time the live document's
// Yjs room is EMPTY. The content is poured in later, by whoever opens it first
// (LiveDocEditorView -> seedYDocFromPm). So there is no Y.Doc here to make a
// relative position against.
//
// What makes it possible anyway is the pin that is already in seedYDocFromPm
// for a different reason: the seeding clientID is a CONSTANT, so two clients
// seeding identical content produce byte-identical items and Yjs merges a
// duplicate seed instead of doubling the document. The consequence we use is
// that a THROWAWAY Y.Doc seeded from the same body here produces the same item
// ids the real room will, so positions made against it resolve there.
//
// That is a property, not an assumption: tests/unit/commentShareSeedDeterminism
// seeds two documents independently, converts against one and resolves in the
// other, and reads the words back. If it ever stops holding, every copied
// comment silently loses its highlight, so it is asserted rather than trusted.
//
// THE QUOTE IS VERIFIED FIRST, and that is the whole point of doing it here.
// Converting a range into relative positions is irreversible: afterwards there
// is nothing left to compare against the text, so a range that had already
// drifted is baked in permanently where no later check can catch it. A comment
// whose text cannot be found is copied with NO ANCHOR rather than a guess — it
// keeps its words in the panel and loses its highlight, which is the honest
// outcome for a comment on a passage that is no longer there.

import * as Y from 'yjs'
import type { Schema } from 'prosemirror-model'
import { absolutePositionToRelativePosition, initProseMirrorDoc } from '@tiptap/y-tiptap'
import { quoteFor, readCommentAnchor, resolveAnchor, type YjsCommentAnchor } from '@shared/commentAnchor'
import { positionText } from '../components/documents/editor/commentPositions'
import { COLLAB_FIELD, seedYDocFromPm } from './yjsSeed'

export interface ShareThread {
  id: string
  /** The stored anchor: the JSON string SQLite hands back, or an object. */
  anchor: unknown
}

export interface ShareConversion {
  /** Thread id -> the live anchor to post with the copied comment. */
  converted: Map<string, YjsCommentAnchor>
  /**
   * Threads copied with no anchor, and why. Not failures to hide: the comment
   * still travels, and the caller should be able to say how many lost their
   * highlight rather than quietly dropping the fact.
   */
  unanchored: Array<{ id: string; reason: 'missing' | 'ambiguous' | 'malformed' | 'no-quote' | 'already-live' }>
}

/**
 * Convert every local anchor into a live one, against the body being shared.
 *
 * `pmJSON` is the ProseMirror document the live copy will be seeded from — the
 * same value LiveDocEditorView passes to seedYDocFromPm, so the coordinate
 * space and the item ids both match what the room will hold.
 */
export function convertAnchorsForShare(
  pmJSON: object,
  schema: Schema,
  threads: readonly ShareThread[]
): ShareConversion {
  const converted = new Map<string, YjsCommentAnchor>()
  const unanchored: ShareConversion['unanchored'] = []
  if (!threads.length) return { converted, unanchored }

  const ydoc = new Y.Doc()
  seedYDocFromPm(ydoc, pmJSON, schema)
  const frag = ydoc.getXmlFragment(COLLAB_FIELD)
  // The document and the mapping come from ONE derivation, so the positions
  // the quote is checked at are the positions the relative positions are made
  // from. Two derivations would be the coordinate-space bug again, one level in.
  const { doc, mapping } = initProseMirrorDoc(frag, schema)
  const docText = positionText(doc)

  for (const t of threads) {
    const parsed = readCommentAnchor(t.anchor)
    if (!parsed) {
      unanchored.push({ id: t.id, reason: 'malformed' })
      continue
    }
    if (parsed.kind !== 'local') {
      // Already live. Nothing to convert, and rewriting it would replace
      // working relative positions with ones made from a throwaway document.
      unanchored.push({ id: t.id, reason: 'already-live' })
      continue
    }
    if (!parsed.quote) {
      // Blind by definition, and the conversion cannot be undone. An
      // unverifiable range keeps its comment; it just keeps no highlight.
      unanchored.push({ id: t.id, reason: 'no-quote' })
      continue
    }
    const out = resolveAnchor(parsed, docText, { from: parsed.from, to: parsed.to })
    if (out.status === 'orphan') {
      unanchored.push({ id: t.id, reason: out.reason })
      continue
    }
    const start = absolutePositionToRelativePosition(out.range.from, frag, mapping)
    const end = absolutePositionToRelativePosition(out.range.to, frag, mapping)
    if (!start || !end) {
      unanchored.push({ id: t.id, reason: 'missing' })
      continue
    }
    // Re-quoted from the shared body, so the stored quote describes the text as
    // the live document's first reader will see it — including when the range
    // had to be re-found rather than believed.
    const quote = quoteFor(docText, out.range.from, out.range.to) ?? parsed.quote
    converted.set(t.id, {
      kind: 'yjs',
      start: Y.relativePositionToJSON(start) as Record<string, unknown>,
      end: Y.relativePositionToJSON(end) as Record<string, unknown>,
      quote
    })
  }
  ydoc.destroy()
  return { converted, unanchored }
}
