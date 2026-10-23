import { randomUUID } from 'crypto'
import { getDb } from './database'
import { adoptWidgetAsFile, syncWidgetFileFromInstance } from './widgetFiles'
import { WIDGET_FILE_GROUP_PREFIX } from '@shared/widgetFiles'
import { clampToKindMin } from '@shared/widgetSizing'
import type { Widget, WidgetDraft, WidgetPatch } from '@shared/types'

interface WidgetRow {
  id: string
  task_id: string
  kind: Widget['kind']
  title: string
  content: string
  x: number
  y: number
  width: number
  height: number
  z_index: number
  color: string | null
  status: string | null
  pinned: number | null
  pinned_screen_x: number | null
  pinned_screen_y: number | null
  parent_section_id: string | null
  layout: string | null
  source_app_id: string | null
  mode: string | null
  pinned_zone: string | null
  living_query: string | null
  living_generated_at: number | null
  living_paused: number | null
  created_at: number
  updated_at: number
  archived: number | null
  sync_group_id: string | null
}

function rowToWidget(row: WidgetRow): Widget {
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    title: row.title,
    content: row.content,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    zIndex: row.z_index,
    color: row.color,
    status: row.status ?? null,
    pinned: row.pinned === 1,
    pinnedScreenX: row.pinned_screen_x,
    pinnedScreenY: row.pinned_screen_y,
    parentSectionId: row.parent_section_id,
    layout: (row.layout as Widget['layout']) ?? null,
    sourceAppId: row.source_app_id,
    mode: (row.mode as Widget['mode']) ?? null,
    pinnedZone: (row.pinned_zone as Widget['pinnedZone']) ?? null,
    livingQuery: row.living_query ?? null,
    livingGeneratedAt: row.living_generated_at ?? null,
    livingPaused: row.living_paused === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
    syncGroupId: row.sync_group_id ?? null
  }
}

export function getWidget(id: string): Widget | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM widgets WHERE id = ?').get(id) as
    | WidgetRow
    | undefined
  return row ? rowToWidget(row) : null
}

let purgedWidgetTrashThisSession = false

export function listWidgetsByTask(taskId: string): Widget[] {
  const db = getDb()
  if (!purgedWidgetTrashThisSession) {
    purgedWidgetTrashThisSession = true
    try {
      purgeTrashedWidgets()
    } catch {
      /* best-effort */
    }
  }
  const rows = db
    .prepare('SELECT * FROM widgets WHERE task_id = ? AND trashed_at IS NULL ORDER BY z_index ASC, created_at ASC')
    .all(taskId) as WidgetRow[]
  return rows.map(rowToWidget)
}

/**
 * Keep a table widget's desk-level name in step with the table's own name.
 *
 * A table widget stores the table id in `content`; the human name lives on the
 * table record. Surfaces that only have the widget -- desk summaries, Gallery,
 * List, the minimap -- called widgetDisplayName with no fallback and so showed
 * "Table" or "Untitled table" long after the user had renamed it.
 *
 * Only widgets that were never given a name of their own, or that still carry
 * the table's previous name, are updated. A widget the user deliberately titled
 * something else keeps that title: this syncs a default, it does not overwrite
 * an intention.
 */
export function syncTableWidgetTitles(
  tableId: string,
  previousTitle: string,
  nextTitle: string
): number {
  const db = getDb()
  const res = db
    .prepare(
      `UPDATE widgets SET title = ?
        WHERE kind = 'table' AND content = ? AND trashed_at IS NULL
          AND (title IS NULL OR title = '' OR title = ?)`
    )
    .run(nextTitle, tableId, previousTitle)
  return res.changes
}

/**
 * How many live objects each of these desks holds. One grouped query rather
 * than a listWidgetsByTask per desk, because this exists to disambiguate
 * search results: two desks with the same name are told apart by what is on
 * them, and that has to be cheap enough to compute while someone is typing.
 */
export function widgetCountsByTask(taskIds: string[]): Record<string, number> {
  if (taskIds.length === 0) return {}
  const db = getDb()
  const placeholders = taskIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT task_id AS taskId, COUNT(*) AS n FROM widgets
        WHERE task_id IN (${placeholders}) AND trashed_at IS NULL
        GROUP BY task_id`
    )
    .all(...taskIds) as { taskId: string; n: number }[]
  const out: Record<string, number> = {}
  for (const id of taskIds) out[id] = 0
  for (const r of rows) out[r.taskId] = r.n
  return out
}

// Every live widget of a given kind across the whole workspace, newest-touched
// first. Used by the PlexiBrain Agents view to list desk agents wherever they
// live, since agents are widgets that otherwise only load per desk.
export function listWidgetsByKind(kind: Widget['kind']): Widget[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM widgets WHERE kind = ? AND trashed_at IS NULL ORDER BY updated_at DESC, created_at DESC')
    .all(kind) as WidgetRow[]
  return rows.map(rowToWidget)
}

function nextZ(taskId: string): number {
  const db = getDb()
  const row = db
    .prepare('SELECT COALESCE(MAX(z_index), 0) + 1 AS next FROM widgets WHERE task_id = ?')
    .get(taskId) as { next: number }
  return row.next
}


// Chunk-index freshness (A2, #16): a widget's content re-enters retrieval the
// moment it changes, whichever path wrote it (IPC, the action executor, the
// living-doc scheduler). Dynamically imported so the db layer never gains a
// static dependency on the retrieval layer; best-effort by design.
function pokeChunkIndex(widgetId: string): void {
  void import('../chunkIndex')
    .then((m) => m.reindexWidgetChunks(widgetId))
    .catch(() => {})
}

export function createWidget(draft: WidgetDraft): Widget {
  const db = getDb()
  // WS01 lifecycle: honour a client-provided id so a widget created on one device
  // materialises with the SAME id when its create event is applied on another
  // (idempotent by primary key). Locally-originated creates pass no id and get a
  // fresh one, exactly as before.
  const id = draft.id ?? randomUUID()
  // Create-if-missing: applying a create event whose id already exists is a no-op
  // that returns the existing row, so a replayed/echoed create never duplicates.
  if (draft.id) {
    const existing = db.prepare('SELECT * FROM widgets WHERE id = ?').get(draft.id) as WidgetRow | undefined
    if (existing) return rowToWidget(existing)
  }
  const now = Date.now()
  // Optional pin at creation — used by the minimap auto-create flow so the
  // widget is docked the moment it spawns instead of "flash on canvas, then
  // jump to corner" on the next render.
  const pinned = draft.pinned ? 1 : 0
  const pinnedZone = draft.pinnedZone ?? null
  db.prepare(
    `INSERT INTO widgets (id, task_id, kind, title, content, x, y, width, height, z_index, color, pinned, pinned_screen_x, pinned_screen_y, pinned_zone, parent_section_id, source_app_id, mode, sync_group_id, created_at, updated_at)
     VALUES (@id, @taskId, @kind, @title, @content, @x, @y, @width, @height, @zIndex, @color, @pinned, NULL, NULL, @pinnedZone, NULL, @sourceAppId, @mode, @syncGroupId, @now, @now)`
  ).run({
    id,
    taskId: draft.taskId,
    kind: draft.kind,
    title: draft.title ?? '',
    content: draft.content,
    x: draft.x ?? 60,
    y: draft.y ?? 60,
    // Stored at the size the frame renders: never below the kind's minimum
    // (an API, agent or MCP create can ask for less than the canvas allows).
    ...clampToKindMin(draft.kind, {
      width: draft.width ?? (draft.kind === 'webview' ? 520 : draft.kind === 'living-doc' ? 500 : 260),
      height: draft.height ?? (draft.kind === 'webview' ? 360 : draft.kind === 'living-doc' ? 400 : 200)
    }),
    zIndex: nextZ(draft.taskId),
    color: draft.color ?? null,
    pinned,
    pinnedZone,
    sourceAppId: draft.sourceAppId ?? null,
    mode: draft.mode ?? null,
    syncGroupId: draft.syncGroupId ?? null,
    now
  })
  const row = db.prepare('SELECT * FROM widgets WHERE id = ?').get(id) as WidgetRow
  pokeChunkIndex(id)
  // Every work widget that can be a file IS one (docs/widget-files.md, "Every
  // work widget is a file"). This is the one place that holds for every way a
  // widget is born locally — the canvas menu, the palette, an AI build, a
  // template, a paste, a duplicate, MCP, the assistant — because each of them
  // ends here. A create that carries its own id is a replay (sync, a restore)
  // of a widget that was born somewhere else and is already whatever it is;
  // its file, if it has one, arrives as a document of its own.
  if (!draft.id) {
    try {
      const adopted = adoptWidgetAsFile(id)
      if (adopted) return adopted
    } catch (e) {
      // The widget stands as a plain desk row; the launch backfill retries.
      console.warn('[widget-files] could not file new work widget:', e instanceof Error ? e.message : e)
    }
  }
  return rowToWidget(row)
}

// Best-effort create for auto-spawned chrome (the minimap): if the parent task
// no longer exists (a desk switch or a trash landed between the renderer
// deciding to create and this running), return null instead of letting the
// task_id foreign key throw a raw SQLite error into the main log. Real,
// user-driven creates keep using createWidget so genuine bugs stay loud.
export function createWidgetIfTaskExists(draft: WidgetDraft): Widget | null {
  const db = getDb()
  const exists = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(draft.taskId)
  if (!exists) return null
  return createWidget(draft)
}

export function updateWidget(id: string, patch: WidgetPatch): Widget | null {
  const db = getDb()
  // A resize is stored at the size the frame renders: never below the kind's
  // minimum, whoever sent it (the canvas already stops there; an API or agent
  // patch may not).
  if (patch.width !== undefined || patch.height !== undefined) {
    const kindRow = db.prepare('SELECT kind FROM widgets WHERE id = ?').get(id) as { kind: string } | undefined
    if (kindRow) patch = clampToKindMin(kindRow.kind, patch)
  }
  const fields: string[] = []
  const params: Record<string, unknown> = { id, now: Date.now() }
  const cols: Array<[keyof WidgetPatch, string]> = [
    ['title', 'title'],
    ['content', 'content'],
    ['x', 'x'],
    ['y', 'y'],
    ['width', 'width'],
    ['height', 'height'],
    ['zIndex', 'z_index'],
    ['color', 'color'],
    ['status', 'status'],
    ['pinnedScreenX', 'pinned_screen_x'],
    ['pinnedScreenY', 'pinned_screen_y'],
    ['parentSectionId', 'parent_section_id'],
    ['layout', 'layout'],
    ['sourceAppId', 'source_app_id'],
    ['mode', 'mode'],
    ['pinnedZone', 'pinned_zone'],
    ['livingQuery', 'living_query'],
    ['livingGeneratedAt', 'living_generated_at'],
    ['syncGroupId', 'sync_group_id']
  ]
  for (const [key, col] of cols) {
    if (patch[key] !== undefined) {
      fields.push(`${col} = @${key}`)
      params[key] = patch[key]
    }
  }
  if (patch.pinned !== undefined) {
    fields.push('pinned = @pinned')
    params.pinned = patch.pinned ? 1 : 0
  }
  if (patch.archived !== undefined) {
    fields.push('archived = @archived')
    params.archived = patch.archived ? 1 : 0
  }
  if (patch.livingPaused !== undefined) {
    fields.push('living_paused = @livingPaused')
    params.livingPaused = patch.livingPaused ? 1 : 0
  }
  if (fields.length === 0) {
    const row = db.prepare('SELECT * FROM widgets WHERE id = ?').get(id) as WidgetRow | undefined
    return row ? rowToWidget(row) : null
  }
  fields.push('updated_at = @now')
  db.prepare(`UPDATE widgets SET ${fields.join(', ')} WHERE id = @id`).run(params)
  const row = db.prepare('SELECT * FROM widgets WHERE id = ?').get(id) as WidgetRow | undefined
  const updated = row ? rowToWidget(row) : null
  // ── Linked-duplicate propagation ────────────────────────────────────────
  // If this widget belongs to a sync group, mirror the SYNCED fields that
  // changed in this patch (content / title / colour) to every other copy in
  // the group — across tasks. A direct DB fan-out: it never re-enters
  // updateWidget, so there is no propagation loop. Position / size / task are
  // deliberately NOT synced (each copy lives independently).
  if (updated?.syncGroupId) {
    const syncSet: string[] = []
    const sp: Record<string, unknown> = {
      sgid: updated.syncGroupId,
      self: id,
      now: Date.now()
    }
    if (patch.content !== undefined) {
      syncSet.push('content = @content')
      sp.content = patch.content
    }
    if (patch.title !== undefined) {
      syncSet.push('title = @title')
      sp.title = patch.title
    }
    if (patch.color !== undefined) {
      syncSet.push('color = @color')
      sp.color = patch.color
    }
    if (syncSet.length > 0) {
      syncSet.push('updated_at = @now')
      db.prepare(
        `UPDATE widgets SET ${syncSet.join(', ')} WHERE sync_group_id = @sgid AND id != @self`
      ).run(sp)
      // The fan-out wrote the copies' content directly, so their chunks are
      // stale too — reindex each copy, not just the edited original.
      const copies = db
        .prepare('SELECT id FROM widgets WHERE sync_group_id = ? AND id != ?')
        .all(updated.syncGroupId, id) as Array<{ id: string }>
      for (const c of copies) pokeChunkIndex(c.id)
    }
    // A widget in a `wf:` group is a desk instance of a WIDGET FILE: the file
    // is the group's off-desk member, so the same synced fields reach it too
    // (docs/widget-files.md). Best-effort: a missing or trashed file never
    // fails the desk edit that triggered it.
    if (syncSet.length > 0 && updated.syncGroupId.startsWith(WIDGET_FILE_GROUP_PREFIX)) {
      try {
        syncWidgetFileFromInstance(updated.syncGroupId, id, {
          content: patch.content,
          title: patch.title,
          color: patch.color
        })
      } catch {
        /* the desk edit stands; the file catches up on its next edit */
      }
    }
  }
  if (updated && (patch.content !== undefined || patch.title !== undefined || patch.livingQuery !== undefined)) {
    pokeChunkIndex(id)
  }
  return updated
}

// Soft-delete so the removal is undoable. The widget's connector links are left
// intact (the link overlay skips trashed endpoints) and come back on restore.
export function deleteWidget(id: string): boolean {
  const db = getDb()
  const result = db.prepare('UPDATE widgets SET trashed_at = ? WHERE id = ? AND trashed_at IS NULL').run(Date.now(), id)
  if (result.changes > 0) pokeChunkIndex(id) // trashed content stops grounding answers
  return result.changes > 0
}

export function restoreWidget(id: string): boolean {
  const db = getDb()
  const result = db.prepare('UPDATE widgets SET trashed_at = NULL WHERE id = ?').run(id)
  if (result.changes > 0) {
    pokeChunkIndex(id) // restored content is retrievable again
    // A widget trashed before it could become a file (the backfill skips the
    // trashed) becomes one when it comes back. A no-op for an instance.
    try {
      adoptWidgetAsFile(id)
    } catch {
      /* stays a plain desk row */
    }
  }
  return result.changes > 0
}

// Permanently remove widgets trashed longer than maxAgeMs (default 7 days). The
// hard DELETE cascades their links. Runs once per session.
export function purgeTrashedWidgets(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  const db = getDb()
  const cutoff = Date.now() - maxAgeMs
  // Except the instances a trashed work widget file took with it: restoring the
  // file from Trash puts them back where they were, for as long as the file
  // sits in Trash (documents have no age-out). Purging the file purges them.
  db.prepare(
    `DELETE FROM widgets WHERE trashed_at IS NOT NULL AND trashed_at < ?
       AND NOT (sync_group_id LIKE 'wf:%' AND EXISTS (
         SELECT 1 FROM documents d
          WHERE d.id = substr(widgets.sync_group_id, 4) AND d.trashed_at = widgets.trashed_at))`
  ).run(cutoff)
}

export function bringToFront(id: string): Widget | null {
  const db = getDb()
  const row = db.prepare('SELECT task_id FROM widgets WHERE id = ?').get(id) as
    | { task_id: string }
    | undefined
  if (!row) return null
  return updateWidget(id, { zIndex: nextZ(row.task_id) })
}
