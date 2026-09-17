import { getDb } from './database'
import { contentToPlainText } from '@shared/widgetText'
import { extractMentions } from '@shared/mentionText'
import { resolveMentions } from '../ai/mentionResolver'
import type { WidgetInput } from '@shared/customWidgetSandbox'
import type { ChatMentionRef } from '@shared/types'

// What a custom widget can see, resolved from the wires drawn into it.
//
// The whole access model in one sentence: a generated widget reads exactly the
// widgets the user connected to it, and has no way to ask for anything else.
// There is no query interface on purpose. The user grants access by drawing a
// line on the canvas, and that line is the grant — visible, revocable by
// deleting it, and obvious to anyone looking at the desk.
//
// Tables come through STRUCTURED rather than flattened to text. A widget that
// receives `rows[]` with typed cells can total a column, chart it or filter it;
// one that receives a rendering of a table can only scrape it.

const MAX_INPUTS = 12
const MAX_ROWS = 500
const MAX_TEXT = 20_000

interface WidgetRow {
  id: string
  kind: string
  title: string | null
  content: string | null
}

/** Table ids this widget may act on — the scope customWidgetActions enforces. */
export function wiredTableIds(widgetId: string): string[] {
  return resolveWidgetInputs(widgetId)
    .map((i) => i.table?.id)
    .filter((id): id is string => !!id)
}

/** Everything this widget was pointed at: its wires, and its @ mentions. */
export function resolveWidgetInputs(widgetId: string): WidgetInput[] {
  const wired = wiredInputs(widgetId)
  const mentioned = mentionedInputs(widgetId)
  // A thing both wired AND mentioned is one input, not two. The wire wins the
  // `via` label because it is the one visible on the canvas.
  const seen = new Set(wired.map((i) => i.id))
  return [...wired, ...mentioned.filter((i) => !seen.has(i.id))].slice(0, MAX_INPUTS)
}

/**
 * The things @ mentioned in this widget's own description.
 *
 * A widget's spec is written in a mention-aware field, so "@Retainers" in the
 * description is the user saying which table this is about. That reference was
 * already reaching the generator as text; this is what makes it reach the
 * running widget as DATA.
 */
function mentionedInputs(widgetId: string): WidgetInput[] {
  const db = getDb()
  const row = db.prepare('SELECT content FROM widgets WHERE id = ?').get(widgetId) as
    | { content?: string }
    | undefined
  if (!row?.content) return []
  let spec = ''
  try {
    const parsed = JSON.parse(row.content) as { spec?: unknown }
    spec = typeof parsed.spec === 'string' ? parsed.spec : ''
  } catch {
    return []
  }
  if (!spec) return []

  const mentions = extractMentions(spec).slice(0, MAX_INPUTS)
  if (mentions.length === 0) return []

  const out: WidgetInput[] = []
  // A mentioned WIDGET resolves down the same path as a wired one, so an @ on a
  // table yields its real columns and rows rather than a rendering of them.
  const widgetMentions = mentions.filter((m) => m.kind === 'widget')
  for (const m of widgetMentions) {
    const w = db
      .prepare(
        `SELECT id, kind, title, content FROM widgets
          WHERE id = ? AND archived = 0 AND trashed_at IS NULL`
      )
      .get(m.id) as WidgetRow | undefined
    if (w) out.push({ ...widgetToInput(w), via: 'mention' })
  }

  // Everything else -- documents, desks, files, knowledge, people -- goes
  // through the same resolver the assistant uses, so an @ means the same thing
  // here as it does in a chat.
  const others = mentions.filter((m) => m.kind !== 'widget') as ChatMentionRef[]
  if (others.length > 0) {
    for (const r of resolveMentions(others)) {
      if (!r.text) continue
      out.push({
        id: r.ref.id,
        kind: r.ref.kind,
        title: r.ref.title || r.kindLabel,
        text: r.text.slice(0, MAX_TEXT),
        via: 'mention'
      })
    }
  }
  return out
}

function wiredInputs(widgetId: string): WidgetInput[] {
  const db = getDb()
  const sources = db
    .prepare(
      `SELECT w.id, w.kind, w.title, w.content
         FROM widget_links l
         JOIN widgets w ON w.id = l.source_widget_id
        WHERE l.target_widget_id = ?
          AND l.enabled = 1
          AND w.archived = 0
          AND w.trashed_at IS NULL
        ORDER BY l.created_at
        LIMIT ?`
    )
    .all(widgetId, MAX_INPUTS) as WidgetRow[]

  return sources.map((w) => ({ ...widgetToInput(w), via: 'wire' as const }))
}

/** One widget row, as the sandbox sees it. Shared by both routes in. */
function widgetToInput(w: WidgetRow): WidgetInput {
  const db = getDb()
  const base: WidgetInput = {
    id: w.id,
    kind: w.kind,
    title: w.title ?? '',
    text: contentToPlainText(w.content).slice(0, MAX_TEXT)
  }
  if (w.kind !== 'table' || !w.content) return base

  // A table widget's content is the id of the table it shows.
  const tableId = w.content
  const t = db
    .prepare('SELECT id, title, schema_json FROM fb_tables WHERE id = ? AND trashed_at IS NULL')
    .get(tableId) as { id: string; title: string; schema_json: string } | undefined
  if (!t) return base

  let columns: Array<{ id: string; label: string; type: string }> = []
  try {
    const parsed = JSON.parse(t.schema_json) as {
      columns?: Array<{ id?: unknown; label?: unknown; type?: unknown }>
    }
    columns = (parsed.columns ?? [])
      .filter((c) => typeof c?.id === 'string')
      .map((c) => ({
        id: String(c.id),
        label: typeof c.label === 'string' ? c.label : String(c.id),
        type: typeof c.type === 'string' ? c.type : 'text-short'
      }))
  } catch {
    // A schema that will not parse yields a table with no columns rather than
    // a thrown request: the widget still gets the title and the row ids.
    columns = []
  }

  const rows = (
    db
      .prepare(
        `SELECT id, cells_json FROM fb_rows
          WHERE table_id = ? AND trashed_at IS NULL
          ORDER BY sort_order, created_at LIMIT ?`
      )
      .all(tableId, MAX_ROWS) as Array<{ id: string; cells_json: string }>
  ).map((r) => {
    let cells: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(r.cells_json) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        cells = parsed as Record<string, unknown>
      }
    } catch {
      cells = {}
    }
    return { id: r.id, cells }
  })

  return {
    ...base,
    title: w.title || t.title || 'Table',
    // Text stays useful even for a table, so a widget that only wants to read
    // it as prose does not have to walk the rows.
    text: [t.title, ...rows.map((r) => Object.values(r.cells).filter(Boolean).join(' · '))]
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_TEXT),
    table: { id: t.id, columns, rows }
  }
}
