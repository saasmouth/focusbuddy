// A read link's snapshot, made into a desk this page can unpack.
//
// A desk shared as "a snapshot they can read" (shareAudience.ts, 'read') lives
// at view.plexiidesk.com/share/<token> as a frozen JSON snapshot
// (lib/shareSnapshot.ts). With scope 'copy' the sender said anyone who wants it
// may have it -- and until now the only way to have it was to sign up, install
// the desktop app and accept it from an inbox. A prospect who opened the link
// got a list of the desk's contents and a sign-up form.
//
// This turns that snapshot into the same thing a 'use' link carries -- a desk
// bundle (main/db/deskBundle.ts) -- so the share page unpacks it through the
// one path it already has (shareCopy:importDesk), with everything that path
// keeps: one record per link, no duplicates on a second visit, a gone link
// taking only its own copy. Nothing downstream can tell the two apart, which
// is the point: there is one way a desk lands in a visitor's browser.
//
// THE SENDER'S IDS ARE KEPT, as a bundle keeps them. The desk's id is how the
// page finds the copy again on the next visit (shareCopy:deskPresent), and how
// it notices the same desk arriving from two links. A table widget's content
// IS its table's id, so the table is unpacked under that id and the widget
// finds it.
//
// NOTHING HERE IS TRUSTED. The snapshot was written by whoever minted the link
// and travels through a public route. Every field is read for its type and
// anything else is dropped or replaced by a default, never repaired into
// something that looks like the sender's: a widget without a kind is left out,
// a column type this build does not know is shown as plain text, a section
// membership naming a widget that is not here is dropped. A SpeedDeck's
// run-shell buttons are stripped as the desktop's own accept path strips them.
//
// WHAT A SNAPSHOT DOES NOT CARRY, and so a copy made from one does not have:
// documents and Drive files behind widgets that point at them (the snapshot
// holds only their ids), connector wires between widgets, the sender's view
// and Workcentre arrangement, and pictures of websites. Tables made before
// columns carried their choices (shareSnapshot.serializeColumn) have no option
// names: their select cells show as empty, as the app shows any value whose
// option it cannot find, rather than as "o4".
//
// Pure: no database, no network, no DOM. The format constants are imported as
// types only, so a literal here that drifted from deskBundle.ts would not
// compile -- and the page bundle never reaches the data layer for them.
import type { DeskBundle, DESK_BUNDLE_FORMAT, DESK_BUNDLE_VERSION } from '../../main/db/deskBundle'
import { defaultConfig, FIELD_TYPE_LABELS, type FieldType } from '@shared/fields'
import { stripRunShellFromDeckContent } from '@shared/streamdeck'
import type { SectionLayout } from '@shared/types'

const FORMAT: typeof DESK_BUNDLE_FORMAT = 'plexii.desk'
const VERSION: typeof DESK_BUNDLE_VERSION = 1

/** The snapshot shape this reads (lib/shareSnapshot.ts SHARE_SNAPSHOT_VERSION). */
export const READABLE_SNAPSHOT_VERSION = 1

export type SnapshotDeskResult =
  | { ok: true; bundle: DeskBundle }
  // not-a-desk: a folder, a widget, a document, a file -- something the share
  // page has no desk to open for. unreadable: not a snapshot this build reads.
  | { ok: false; why: 'not-a-desk' | 'unreadable' }

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max = 100_000): string => (typeof v === 'string' ? v.slice(0, max) : '')
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const MAX_ID = 200
const id = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= MAX_ID ? v : null)
const SECTION_LAYOUTS: ReadonlySet<string> = new Set<SectionLayout>(['free', 'grid', 'stacks', 'icons', 'list'])
const SELECT_TYPES: ReadonlySet<string> = new Set(['single-select', 'multi-select'])

/** A column as the copy's table keeps it: the app's own FieldDefinition shape. */
function columnOf(raw: unknown, i: number): Obj | null {
  if (!isObj(raw)) return null
  const colId = id(raw.id) ?? `c${i + 1}`
  const declared = str(raw.type, 64)
  // A type this build does not know shows its values as text rather than
  // asking the table to render something it has no editor for.
  const type: FieldType = Object.prototype.hasOwnProperty.call(FIELD_TYPE_LABELS, declared)
    ? (declared as FieldType)
    : 'text-short'
  const config: Obj = SELECT_TYPES.has(type)
    ? { options: optionsOf(raw.options) }
    : (defaultConfig(type) as Obj)
  return { id: colId, type, label: str(raw.label, 500), config }
}

function optionsOf(raw: unknown): Array<{ id: string; label: string; color?: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ id: string; label: string; color?: string }> = []
  const seen = new Set<string>()
  for (const o of raw) {
    if (!isObj(o)) continue
    const oid = id(o.id)
    if (!oid || seen.has(oid) || typeof o.label !== 'string') continue
    seen.add(oid)
    const color = typeof o.color === 'string' && o.color.length <= 64 ? o.color : undefined
    out.push(color ? { id: oid, label: str(o.label, 500), color } : { id: oid, label: str(o.label, 500) })
  }
  return out
}

/** The ids already used in this bundle, shared across a room's desks. */
interface Seen {
  widgets: Set<string>
  rows: Set<string>
  tables: Map<string, Obj>
}

/**
 * One desk of a snapshot (a task snapshot's task, or one of a room's tasks)
 * as rows: its node, widgets, and the tables and rows its table widgets carry.
 */
function deskRows(
  task: Obj,
  ctx: { at: number; handle: string | null; parentId: string | null; sortOrder: number; seen: Seen }
): { node: Obj; widgets: Obj[]; rows: Obj[] } | null {
  if (!Array.isArray(task.widgets)) return null
  const deskId = id(task.id)
  if (!deskId) return null
  const { at, handle, seen } = ctx
  const title = str(task.title, 500).trim() || 'Shared desk'
  const whole = (v: unknown, fallback: number): number => {
    const n = finite(v)
    return n === null ? fallback : Math.round(n)
  }
  const when = (v: unknown): number | null => {
    const n = finite(v)
    return n !== null && n > 0 ? n : null
  }

  const node: Obj = {
    id: deskId,
    parent_id: ctx.parentId,
    kind: 'task',
    title,
    description: str(task.description),
    status: str(task.status, 32) || 'open',
    priority: whole(task.priority, 3),
    importance: whole(task.importance, 3),
    interest: whole(task.interest, 3),
    sort_order: ctx.sortOrder,
    created_at: when(task.createdAt) ?? at,
    updated_at: when(task.updatedAt) ?? at,
    completed_at: when(task.completedAt),
    due_date: when(task.dueDate),
    estimate_minutes: finite(task.estimateMinutes),
    shared_from_handle: handle
  }

  const widgets: Obj[] = []
  const rows: Obj[] = []
  const deskWidgetIds = new Set<string>()
  const sections: Array<[Obj, unknown]> = []

  task.widgets.forEach((raw: unknown, i: number) => {
    if (!isObj(raw)) return
    const kind = str(raw.kind, 64).trim()
    if (!kind) return
    let wid = id(raw.id) ?? `${deskId}-w${i + 1}`
    if (seen.widgets.has(wid)) wid = `${wid}-${i + 1}`
    seen.widgets.add(wid)
    deskWidgetIds.add(wid)

    let content = str(raw.content, 2_000_000)
    if (kind === 'streamdeck') content = stripRunShellFromDeckContent(content)

    const snap = kind === 'table' && isObj(raw.tableSnapshot) ? raw.tableSnapshot : null
    if (snap) {
      const tableId = id(content.trim()) ?? `${wid}-table`
      content = tableId
      if (!seen.tables.has(tableId)) {
        const columns = (Array.isArray(snap.columns) ? snap.columns : [])
          .map(columnOf)
          .filter((c): c is Obj => c !== null)
        seen.tables.set(tableId, {
          id: tableId,
          task_id: deskId,
          title: str(snap.title, 500) || str(raw.title, 500) || 'Untitled',
          schema_json: JSON.stringify({ columns }),
          created_at: at,
          updated_at: at
        })
        ;(Array.isArray(snap.rows) ? snap.rows : []).forEach((r: unknown, j: number) => {
          if (!isObj(r)) return
          let rid = id(r.id) ?? `${tableId}-r${j + 1}`
          if (seen.rows.has(rid)) rid = `${rid}-${j + 1}`
          seen.rows.add(rid)
          rows.push({
            id: rid,
            table_id: tableId,
            cells_json: JSON.stringify(isObj(r.cells) ? r.cells : {}),
            sort_order: j,
            created_at: at,
            updated_at: at
          })
        })
      }
    }

    const w = finite(raw.width)
    const h = finite(raw.height)
    const widget: Obj = {
      id: wid,
      task_id: deskId,
      kind,
      title: str(raw.title, 500),
      content,
      x: whole(raw.x, 80),
      y: whole(raw.y, 80),
      width: w !== null && w > 0 ? Math.round(w) : 280,
      height: h !== null && h > 0 ? Math.round(h) : 200,
      z_index: i + 1,
      color: typeof raw.color === 'string' && raw.color.length <= 64 ? raw.color : null,
      parent_section_id: null,
      layout: typeof raw.layout === 'string' && SECTION_LAYOUTS.has(raw.layout) ? raw.layout : null,
      created_at: at,
      updated_at: at
    }
    widgets.push(widget)
    if (raw.parentSectionId != null) sections.push([widget, raw.parentSectionId])
  })

  // Section membership only for a section that is here, on this desk: a widget
  // filed under one that is not would be drawn inside nothing.
  for (const [widget, parent] of sections) {
    const pid = id(parent)
    if (pid && pid !== widget.id && deskWidgetIds.has(pid)) widget.parent_section_id = pid
  }
  return { node, widgets, rows }
}

/**
 * Make a desk bundle from a read link's snapshot: a DESK (kind 'task'), or a
 * ROOM (kind 'folder') -- the room and every desk in it, each with its widgets
 * (owner, 2026-11-07: every share link opens the full web app; a room link
 * used to stay in the viewer). A room's nested rooms arrive flattened, as the
 * snapshot carries them.
 *
 * `snapshot` is the `record.snapshot` Signal returns for GET /share/<token>.
 * `fromHandle` is the record's sender handle, used when the snapshot has none.
 */
export function snapshotToDeskBundle(snapshot: unknown, opts: { fromHandle?: unknown; now?: number } = {}): SnapshotDeskResult {
  if (!isObj(snapshot)) return { ok: false, why: 'unreadable' }
  if (snapshot.kind !== 'task' && snapshot.kind !== 'folder') {
    // A snapshot of another kind is still a snapshot; it is just not a desk.
    return typeof snapshot.kind === 'string' ? { ok: false, why: 'not-a-desk' } : { ok: false, why: 'unreadable' }
  }
  if (snapshot._version !== READABLE_SNAPSHOT_VERSION) return { ok: false, why: 'unreadable' }

  const captured = finite(snapshot.capturedAt)
  const at = captured !== null && captured > 0 ? captured : (opts.now ?? Date.now())
  const handle = (str(snapshot.fromHandle, 64) || str(opts.fromHandle, 64)).trim() || null
  const seen: Seen = { widgets: new Set(), rows: new Set(), tables: new Map() }
  const nodes: Obj[] = []
  const widgets: Obj[] = []
  const rows: Obj[] = []
  let root: { id: string; title: string }

  if (snapshot.kind === 'task') {
    const task = snapshot.task
    if (!isObj(task)) return { ok: false, why: 'unreadable' }
    const desk = deskRows(task, { at, handle, parentId: null, sortOrder: 0, seen })
    if (!desk) return { ok: false, why: 'unreadable' }
    nodes.push(desk.node)
    widgets.push(...desk.widgets)
    rows.push(...desk.rows)
    root = { id: String(desk.node.id), title: String(desk.node.title) }
  } else {
    const folder = snapshot.folder
    const tasks = snapshot.tasks
    if (!isObj(folder) || !Array.isArray(tasks)) return { ok: false, why: 'unreadable' }
    const roomId = id(folder.id)
    if (!roomId) return { ok: false, why: 'unreadable' }
    const title = str(folder.title, 500).trim() || 'Shared room'
    nodes.push({
      id: roomId,
      parent_id: null,
      kind: 'folder',
      title,
      description: str(folder.description),
      status: str(folder.status, 32) || 'open',
      priority: 3,
      importance: 3,
      interest: 3,
      sort_order: 0,
      created_at: at,
      updated_at: at,
      shared_from_handle: handle
    })
    tasks.forEach((t: unknown, i: number) => {
      if (!isObj(t)) return
      const desk = deskRows(t, { at, handle, parentId: roomId, sortOrder: i, seen })
      if (!desk || nodes.some((n) => n.id === desk.node.id)) return
      nodes.push(desk.node)
      widgets.push(...desk.widgets)
      rows.push(...desk.rows)
    })
    root = { id: roomId, title }
  }

  const fbTables = [...seen.tables.values()]
  return {
    ok: true,
    bundle: {
      format: FORMAT,
      formatVersion: VERSION,
      exportedAt: new Date(at).toISOString(),
      desk: root,
      counts: { nodes: nodes.length, widgets: widgets.length, fb_tables: fbTables.length, fb_rows: rows.length },
      tables: { nodes, widgets, fb_tables: fbTables, fb_rows: rows },
      files: [],
      filesOmitted: []
    }
  }
}
