// Which objects belong to the desk you are standing on.
//
// Retrieval could scope tasks, tables, notes and canvas widgets to a desk,
// because those records carry a desk id. Documents and files could not: the
// `documents` table is (id, doc_type, title, body, archived, created_at,
// updated_at) and no migration ever added a desk column. So asking a question
// from a desk retrieved desk-relevant widgets alongside the best keyword
// matches among EVERY document in the workspace, with no preference for the
// desk — which is exactly what it felt like.
//
// But a document on a desk is already recorded. A doc widget stores the
// document's id in `widgets.content`, with `widgets.task_id` pointing at the
// desk — the same shape table widgets use (see db/widgets.ts, which looks a
// table up by `kind = 'table' AND content = ?`). The affiliation exists; it was
// one join away from the retrieval layer.
//
// Resolved at QUERY time rather than stamped into fb_chunks.room_id at index
// time, for two reasons: a document can sit on several desks at once and one
// column cannot say so, and the affiliation changes whenever a widget is added
// or removed — an indexed copy would be stale exactly when someone has just
// dropped a document on a desk to ask about it.

/** The widget kinds whose `content` is the id of another object. */
export const OBJECT_WIDGET_KINDS = [
  'doc',
  'table',
  'sheet',
  'slides',
  'file',
  'pdf',
  'living-doc',
  'diagram',
  'design'
] as const

/** The narrow slice of the database this needs — injectable so it is testable. */
export interface AffinityDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
  }
}

/**
 * Every object id reachable from these desks, plus the desk ids themselves.
 *
 * The desk ids are included because a source can BE a desk (a task/node in the
 * extras pool), and the caller tests membership with one set.
 *
 * An empty or absent scope returns an empty set, which callers read as "no desk
 * scope is active" and fall back to flat whole-workspace ranking — the same
 * behaviour as before this existed.
 */
export function deskObjectIds(db: AffinityDb, scopeNodeIds: string[] | undefined): Set<string> {
  if (!scopeNodeIds || scopeNodeIds.length === 0) return new Set()
  const ids = new Set<string>(scopeNodeIds)
  const nodePlaceholders = scopeNodeIds.map(() => '?').join(',')
  const kindPlaceholders = OBJECT_WIDGET_KINDS.map(() => '?').join(',')
  let rows: unknown[]
  try {
    rows = db
      .prepare(
        `SELECT DISTINCT content FROM widgets
         WHERE task_id IN (${nodePlaceholders})
           AND kind IN (${kindPlaceholders})
           AND content IS NOT NULL AND content <> ''`
      )
      .all(...scopeNodeIds, ...OBJECT_WIDGET_KINDS)
  } catch {
    // Retrieval must never break on a schema surprise: a desk we cannot resolve
    // is a desk with no extra objects, and ranking carries on unscoped. The same
    // contract chunkSearch* keeps.
    return ids
  }
  for (const r of rows) {
    const content = (r as { content?: unknown }).content
    if (typeof content === 'string' && content.trim()) ids.add(content.trim())
  }
  return ids
}
