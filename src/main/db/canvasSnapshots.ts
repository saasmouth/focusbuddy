import { randomUUID } from 'crypto'
import { getDb } from './database'
import { createNode } from './nodes'
import { listWidgetsByTask } from './widgets'
import { adoptWidgetAsFile } from './widgetFiles'
import type { SnapshotMeta, Widget } from '@shared/types'

// Desk time-travel snapshots. A snapshot is the full widget set for a task at a
// moment in time. We keep the last MAX_PER_TASK and prune older ones.

const MAX_PER_TASK = 40

interface SnapshotRow {
  id: string
  task_id: string
  at: number
  label: string
  widget_count: number
  payload: string
}

function rowToMeta(r: Omit<SnapshotRow, 'payload'>): SnapshotMeta {
  return { id: r.id, taskId: r.task_id, at: r.at, label: r.label, widgetCount: r.widget_count }
}

// INSERT OR REPLACE the full widget row, preserving its id so links to surviving
// widgets stay intact. Used by restore. Mirrors the widgets table columns.
function upsertWidgetRow(w: Widget, taskId: string): void {
  const db = getDb()
  db.prepare(
    `INSERT OR REPLACE INTO widgets
      (id, task_id, kind, title, content, x, y, width, height, z_index, color,
       pinned, pinned_screen_x, pinned_screen_y, parent_section_id, layout,
       source_app_id, mode, pinned_zone, living_query, living_generated_at,
       living_paused, created_at, updated_at, archived, sync_group_id)
     VALUES
      (@id, @taskId, @kind, @title, @content, @x, @y, @width, @height, @zIndex, @color,
       @pinned, @pinnedScreenX, @pinnedScreenY, @parentSectionId, @layout,
       @sourceAppId, @mode, @pinnedZone, @livingQuery, @livingGeneratedAt,
       @livingPaused, @createdAt, @updatedAt, @archived, @syncGroupId)`
  ).run({
    id: w.id,
    taskId,
    kind: w.kind,
    title: w.title ?? '',
    content: w.content ?? '',
    x: w.x,
    y: w.y,
    width: w.width,
    height: w.height,
    zIndex: w.zIndex ?? 0,
    color: w.color ?? null,
    pinned: w.pinned ? 1 : 0,
    pinnedScreenX: w.pinnedScreenX ?? null,
    pinnedScreenY: w.pinnedScreenY ?? null,
    parentSectionId: w.parentSectionId ?? null,
    layout: w.layout ?? null,
    sourceAppId: w.sourceAppId ?? null,
    mode: w.mode ?? null,
    pinnedZone: w.pinnedZone ?? null,
    livingQuery: w.livingQuery ?? null,
    livingGeneratedAt: w.livingGeneratedAt ?? null,
    livingPaused: w.livingPaused ? 1 : 0,
    createdAt: w.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    archived: w.archived ? 1 : 0,
    syncGroupId: w.syncGroupId ?? null
  })
}

export function createSnapshot(taskId: string, widgets: Widget[], label = ''): SnapshotMeta {
  const db = getDb()
  // Tolerate a missing parent: a debounced history snapshot can fire moments after
  // the desk it belongs to was removed (e.g. a shared desk revoked seconds after an
  // edit landed). canvas_snapshots.task_id has a FK to nodes(id), so inserting
  // against a deleted desk throws. No-op gracefully instead, mirroring
  // createWidgetIfTaskExists — there is nothing meaningful to snapshot for a desk
  // that no longer exists.
  const taskExists = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(taskId)
  if (!taskExists) return { id: '', taskId, at: Date.now(), label, widgetCount: widgets.length }
  const payload = JSON.stringify(widgets)
  // Dedup: if the desk is identical to the most recent snapshot, don't record a
  // duplicate. (Compare payloads ignoring volatile updatedAt churn is overkill;
  // exact match is enough because recording is debounced after real edits.)
  const last = db
    .prepare('SELECT id, task_id, at, label, widget_count, payload FROM canvas_snapshots WHERE task_id = ? ORDER BY at DESC LIMIT 1')
    .get(taskId) as SnapshotRow | undefined
  if (last && last.payload === payload) {
    return rowToMeta(last)
  }
  const id = randomUUID()
  const at = Date.now()
  db.prepare(
    'INSERT INTO canvas_snapshots (id, task_id, at, label, widget_count, payload) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, taskId, at, label, widgets.length, payload)
  // Prune to the most recent MAX_PER_TASK.
  db.prepare(
    `DELETE FROM canvas_snapshots
      WHERE task_id = ?
        AND id NOT IN (
          SELECT id FROM canvas_snapshots WHERE task_id = ? ORDER BY at DESC LIMIT ?
        )`
  ).run(taskId, taskId, MAX_PER_TASK)
  return { id, taskId, at, label, widgetCount: widgets.length }
}

export function listSnapshots(taskId: string): SnapshotMeta[] {
  const db = getDb()
  const rows = db
    .prepare(
      'SELECT id, task_id, at, label, widget_count FROM canvas_snapshots WHERE task_id = ? ORDER BY at DESC'
    )
    .all(taskId) as Array<Omit<SnapshotRow, 'payload'>>
  return rows.map(rowToMeta)
}

export function getSnapshot(id: string): { meta: SnapshotMeta; widgets: Widget[] } | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM canvas_snapshots WHERE id = ?').get(id) as
    | SnapshotRow
    | undefined
  if (!row) return null
  let widgets: Widget[] = []
  try {
    widgets = JSON.parse(row.payload) as Widget[]
  } catch {
    widgets = []
  }
  return { meta: rowToMeta(row), widgets }
}

// Restore a snapshot onto its task: bring the live widget set back to exactly
// what the snapshot holds. Auto-snapshots the current state first (so the
// restore itself is reversible), deletes widgets the snapshot doesn't have, and
// upserts the snapshot's widgets (ids preserved). Returns the restored set.
export function restoreSnapshot(snapshotId: string): { taskId: string; widgets: Widget[] } | null {
  const snap = getSnapshot(snapshotId)
  if (!snap) return null
  const taskId = snap.meta.taskId
  const db = getDb()

  // Reversibility: capture the current state before we overwrite it.
  const current = db
    .prepare('SELECT id, sync_group_id FROM widgets WHERE task_id = ?')
    .all(taskId) as Array<{ id: string; sync_group_id: string | null }>
  // A snapshot taken before a widget became a work widget file holds it
  // without its `wf:` link. Rewinding the desk's CONTENT must not unlink it
  // from its file (docs/widget-files.md): the link is kept as it is now.
  const fileLinks = new Map(
    current.filter((r) => r.sync_group_id?.startsWith('wf:')).map((r) => [r.id, r.sync_group_id as string])
  )
  createSnapshot(taskId, listWidgetsByTask(taskId), 'Before restore')

  const keep = new Set(snap.widgets.map((w) => w.id))
  const tx = db.transaction(() => {
    for (const row of current) {
      if (!keep.has(row.id)) db.prepare('DELETE FROM widgets WHERE id = ?').run(row.id)
    }
    for (const w of snap.widgets) {
      const link = fileLinks.get(w.id)
      upsertWidgetRow(link && w.syncGroupId !== link ? { ...w, syncGroupId: link } : w, taskId)
    }
  })
  tx()
  // A widget the snapshot brings back that is not a file yet becomes one.
  for (const w of snap.widgets) {
    if (!fileLinks.has(w.id)) {
      try {
        adoptWidgetAsFile(w.id)
      } catch {
        /* stays a plain desk row */
      }
    }
  }

  return { taskId, widgets: listWidgetsByTask(taskId) }
}

// Branch: create a fresh task from a snapshot, copying its widgets with NEW ids
// (section membership remapped). Returns the new task id.
export function branchSnapshot(snapshotId: string, title: string): { taskId: string } | null {
  const snap = getSnapshot(snapshotId)
  if (!snap) return null
  const task = createNode({ parentId: null, kind: 'task', title: title || 'Branched desk' })

  // Remap old widget ids → new ids so parentSectionId references stay valid.
  const idMap = new Map<string, string>()
  for (const w of snap.widgets) idMap.set(w.id, randomUUID())

  const db = getDb()
  const tx = db.transaction(() => {
    for (const w of snap.widgets) {
      const newId = idMap.get(w.id)!
      const newParent = w.parentSectionId ? idMap.get(w.parentSectionId) ?? null : null
      upsertWidgetRow(
        { ...w, id: newId, parentSectionId: newParent, syncGroupId: null },
        task.id
      )
    }
  })
  tx()
  // A branch is a copy: each work widget on it is a new, independent file
  // (docs/widget-files.md, "Copies"), not another instance of the original's.
  for (const newId of idMap.values()) {
    try {
      adoptWidgetAsFile(newId)
    } catch {
      /* stays a plain desk row */
    }
  }
  return { taskId: task.id }
}
