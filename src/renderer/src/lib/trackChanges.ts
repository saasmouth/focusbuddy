// Pure accept/reject logic for tracked changes (suggesting mode). Works on the
// Tiptap/ProseMirror JSON document so it is testable without an editor instance
// and reusable by the accept/reject-all commands.
//
// Two marks record a suggestion: `insertion` wraps text a suggester added, and
// `deletion` wraps text a suggester proposes removing (shown struck through, not
// actually removed). Accepting realises the suggestions; rejecting discards them.
//   accept: keep inserted text (drop the mark), remove deletion-marked text.
//   reject: remove inserted text, keep deletion-marked text (drop the mark).

export interface PmMark {
  type: string
  attrs?: Record<string, unknown>
}
export interface PmNode {
  type: string
  text?: string
  marks?: PmMark[]
  content?: PmNode[]
  attrs?: Record<string, unknown>
}

export const INSERTION_MARK = 'insertion'
export const DELETION_MARK = 'deletion'

function hasMark(node: PmNode, name: string): boolean {
  return !!node.marks?.some((m) => m.type === name)
}

function stripMark(node: PmNode, name: string): PmNode {
  const marks = (node.marks ?? []).filter((m) => m.type !== name)
  const next: PmNode = { ...node }
  if (marks.length) next.marks = marks
  else delete next.marks
  return next
}

// A suggestion read back from HTML the old renderer wrote (a span with an
// inline text-decoration) arrives with an ordinary underline or strike mark
// beside it, plus an empty textStyle from the span itself. Those are artefacts of
// the round trip, not formatting anyone chose, so resolving the suggestion clears
// them too. Only marks flagged `legacyStyle` are treated this way: a suggestion
// written by the current renderer keeps any underline the author really added.
function isLegacy(node: PmNode, name: string): boolean {
  return !!node.marks?.some((m) => m.type === name && m.attrs?.legacyStyle === true)
}

function isEmptyTextStyle(m: PmMark): boolean {
  if (m.type !== 'textStyle') return false
  return Object.values(m.attrs ?? {}).every((v) => v === null || v === undefined || v === '')
}

function resolveSuggestion(node: PmNode, name: string, artefact: 'underline' | 'strike'): PmNode {
  if (!isLegacy(node, name)) return stripMark(node, name)
  const marks = (node.marks ?? []).filter((m) => m.type !== name && m.type !== artefact && !isEmptyTextStyle(m))
  const next: PmNode = { ...node }
  if (marks.length) next.marks = marks
  else delete next.marks
  return next
}

// Resolve one node under the given mode, returning the node to keep or null to
// drop it entirely (a whole inserted/deleted text run, or a block emptied by it).
function resolveNode(node: PmNode, mode: 'accept' | 'reject'): PmNode | null {
  if (node.type === 'text') {
    if (mode === 'accept') {
      if (hasMark(node, DELETION_MARK)) return null // proposed deletion realised
      return hasMark(node, INSERTION_MARK) ? resolveSuggestion(node, INSERTION_MARK, 'underline') : node
    }
    // reject
    if (hasMark(node, INSERTION_MARK)) return null // proposed insertion discarded
    return hasMark(node, DELETION_MARK) ? resolveSuggestion(node, DELETION_MARK, 'strike') : node
  }
  if (node.content) {
    const content = node.content.map((c) => resolveNode(c, mode)).filter((c): c is PmNode => c !== null)
    return { ...node, content }
  }
  return node
}

export function acceptTrackedChanges(doc: PmNode): PmNode {
  return resolveNode(doc, 'accept') ?? doc
}

export function rejectTrackedChanges(doc: PmNode): PmNode {
  return resolveNode(doc, 'reject') ?? doc
}

// Whether a document carries any tracked change at all (drives the review UI).
export function hasTrackedChanges(doc: PmNode): boolean {
  if (doc.type === 'text') return hasMark(doc, INSERTION_MARK) || hasMark(doc, DELETION_MARK)
  return !!doc.content?.some(hasTrackedChanges)
}

// Count of tracked changes (a contiguous run of the same mark counts once), for
// a badge. Adjacent text nodes with the same tracked mark are treated as one.
export function countTrackedChanges(doc: PmNode): number {
  let count = 0
  const walk = (node: PmNode, prevMark: string | null): string | null => {
    if (node.type === 'text') {
      const mark = hasMark(node, INSERTION_MARK) ? INSERTION_MARK : hasMark(node, DELETION_MARK) ? DELETION_MARK : null
      if (mark && mark !== prevMark) count++
      return mark
    }
    let prev: string | null = null
    for (const c of node.content ?? []) prev = walk(c, prev)
    return null
  }
  walk(doc, null)
  return count
}
