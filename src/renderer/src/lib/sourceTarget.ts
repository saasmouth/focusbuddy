// Where a citation actually goes.
//
// A retrieved source is a `{ docId, docType }` pair, and `docType` is a free
// string assembled from three different pools in the main process
// (workspaceSearch.ts): curated knowledge, office documents, and "extras" —
// tasks, tables and note-shaped canvas widgets. Each pool means something
// different by `docId`, so routing a click means knowing which pool a source
// came from.
//
// This mapping is pure and lives on its own so it can be tested without a
// store, a window or an Electron bridge. The navigation that acts on it lives
// in the component; the decision about WHERE lives here.
//
// The routing mirrors what PlexiSearchView already does for a search hit, so a
// citation and a search result for the same thing land in the same place.

// Office document kinds, from the DocType union in shared/types. Listed rather
// than imported as a type-level check because docType arrives as a plain string
// and this has to make a runtime decision about an unvalidated value.
const DOCUMENT_TYPES = new Set(['doc', 'sheet', 'slides', 'map', 'design', 'draw'])

// Widget kinds the chunk index retrieves (A2, #16). Like 'note', each docId is
// the widget's own id; the desk it sits on needs a lookup by the caller.
const WIDGET_TYPES = new Set([
  'living-doc',
  'card',
  'custom-block',
  'field',
  'agent',
  'mindmap',
  'diagram',
  'chart'
])

export type SourceTarget =
  // An office document — open it directly.
  | { kind: 'document'; documentId: string }
  // A curated PlexiBrain knowledge entry.
  | { kind: 'knowledge'; entryId: string }
  // A task/desk — docId IS the node.
  | { kind: 'desk'; taskId: string }
  // A note-shaped widget. It lives on some desk, but which one is not in the
  // source: the caller has to look the widget up to find its canvas.
  | { kind: 'widget'; widgetId: string }
  // A table. Same as a widget — the owning desk needs a lookup.
  | { kind: 'table'; tableId: string }
  // A live web result (F4) — docId IS the URL; opens in the system browser.
  | { kind: 'url'; url: string }
  // A Drive file (A2, #17) — docId is the fb_files id; reveal it in Files.
  | { kind: 'file'; fileId: string }
  // A past Plexii conversation (A2, #17) — docId is the conversation id.
  | { kind: 'chat'; conversationId: string }
  // A meeting transcript (M4, SPEC-003 P4) — docId is the meeting id; opens
  // the meeting in PlexiMeet, where the Thread carries the cited lines.
  | { kind: 'meeting'; meetingId: string }
  // Nothing we know how to open. Better to render a citation as plain text than
  // to offer a click that goes nowhere.
  | null

export function targetForSource(source: { docId: string; docType: string }): SourceTarget {
  const id = source.docId?.trim()
  if (!id) return null
  const type = source.docType?.trim().toLowerCase() ?? ''
  if (type === 'web') return /^https?:\/\//i.test(id) ? { kind: 'url', url: id } : null
  if (type === 'knowledge') return { kind: 'knowledge', entryId: id }
  if (type === 'task') return { kind: 'desk', taskId: id }
  if (type === 'table') return { kind: 'table', tableId: id }
  // 'note' covers every note-shaped widget kind the extras pool collects —
  // note, sticky, markdown and page all arrive under this one label. The
  // chunk-indexed kinds keep their own labels but land the same way.
  if (type === 'note' || WIDGET_TYPES.has(type)) return { kind: 'widget', widgetId: id }
  if (type === 'file') return { kind: 'file', fileId: id }
  if (type === 'chat') return { kind: 'chat', conversationId: id }
  if (type === 'meeting') return { kind: 'meeting', meetingId: id }
  if (DOCUMENT_TYPES.has(type)) return { kind: 'document', documentId: id }
  return null
}

// Whether a citation should be rendered as something you can click. Kept
// separate so the UI asks a question about intent rather than pattern-matching
// on a union it doesn't otherwise care about.
export function isOpenable(source: { docId: string; docType: string }): boolean {
  return targetForSource(source) !== null
}
