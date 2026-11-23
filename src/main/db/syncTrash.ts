// What was deleted elsewhere, in this device's Trash (4.3.55).
//
// A delete made on another device, or by a collaborator, reaches this device by
// sync and was always soft here (trashed_at). But widgets, tables, table rows and
// time blocks have no Trash view, so they simply vanished, and nothing said a desk
// or a Drive file had been deleted elsewhere: recoverable in principle, lost in
// practice (the 16 Nov case, a Drive folder an admin had to restore).
//
// workspaceSync.ts stamps such a delete (deleted_elsewhere_at), at the pull or on
// the CRDT channel, never for this device's own delete. This module is what the
// Trash does with the stamp:
//   - listDeletedElsewhere: every kind but desks and rooms (nodes:listTrash lists
//     those, labelled), with where it was and when the purge claims it;
//   - restoreDeletedElsewhere: an explicit Restore. It clears trashed_at like any
//     restore, the row goes up dirty, and the push carries it at the tombstone's
//     rev, so it comes back on every device. Nothing ever comes back by itself;
//   - deleteForeverDeletedElsewhere: removes it here only. The server already
//     holds the delete, so nothing is sent.
// Both refuse an item this device deleted itself: that is the ordinary Trash
// (desks, Drive, Office) and Undo.
//
// Retention lives in trashRetention.ts: 30 days for widgets and Drive files
// deleted elsewhere; tables, rows, time blocks and documents never aged out and
// still do not.
import { getDb } from './database'
import { deletedElsewhereSql, purgeAtFor } from './trashRetention'
import { restoreWidget } from './widgets'
import { restoreRow } from './tables'
import { restoreEntryDeep, purgeEntry } from './files'
import { restoreDocument, deleteDocument } from './documents'
import { restoreTree } from './nodes'
import { widgetDisplayName } from '@shared/widgetDisplayName'
import type { WidgetKind } from '@shared/types'

import type { DeletedElsewhereKind, DeletedElsewhereEntry, DeletedElsewhereRestore } from '@shared/syncTrash'
export type { DeletedElsewhereKind, DeletedElsewhereEntry, DeletedElsewhereRestore } from '@shared/syncTrash'

const TABLE_OF: Record<DeletedElsewhereKind, string> = {
  widget: 'widgets',
  node: 'nodes',
  table: 'fb_tables',
  row: 'fb_rows',
  timeblock: 'time_blocks',
  file: 'fb_files',
  document: 'documents'
}

// Rows deleted with their table within this long of it (a table's delete reaches
// this device as one tombstone per row, a moment apart) come back with it.
const WITH_TABLE_MS = 60_000

const ELSEWHERE = deletedElsewhereSql()
const ELSEWHERE_OF = (alias: string): string => deletedElsewhereSql(`${alias}.`)

function cleanTitle(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  return s ? (s.length > 80 ? `${s.slice(0, 79)}…` : s) : fallback
}

// A row has no title of its own: its first text cell stands in for one.
function rowTitle(cellsJson: unknown): string {
  try {
    const cells = JSON.parse(String(cellsJson ?? '{}')) as Record<string, unknown>
    for (const v of Object.values(cells)) if (typeof v === 'string' && v.trim()) return cleanTitle(v, 'A row')
  } catch {
    /* unreadable cells: the generic title */
  }
  return 'A row'
}

export function listDeletedElsewhere(): DeletedElsewhereEntry[] {
  const db = getDb()
  const out: DeletedElsewhereEntry[] = []

  // Widgets on a desk that is still here. Those on a desk that is itself in the
  // Trash come back with it; a work widget file's instances travel with the file.
  for (const r of db
    .prepare(
      `SELECT w.id, w.kind, w.title, w.content, w.trashed_at, n.title AS desk,
              (w.shared_root_id IS NOT NULL OR COALESCE(n.org_id, 'personal') != 'personal') AS shared_scope FROM widgets w
       LEFT JOIN nodes n ON n.id = w.task_id
       WHERE w.trashed_at IS NOT NULL AND ${ELSEWHERE_OF('w')}
         AND (n.id IS NULL OR n.trashed_at IS NULL)
         AND NOT (w.sync_group_id LIKE 'wf:%' AND EXISTS (
           SELECT 1 FROM documents d WHERE d.id = substr(w.sync_group_id, 4) AND d.trashed_at IS NOT NULL))`
    )
    .all() as Array<{ id: string; kind: string; title: string | null; content: string | null; trashed_at: number; desk: string | null; shared_scope: number }>) {
    out.push({
      kind: 'widget',
      id: r.id,
      // Named as its frame names it on the desk (the house rule, widgetDisplayName).
      title: widgetDisplayName({ kind: r.kind as WidgetKind, content: r.content ?? '', title: r.title ?? '' }),
      where: r.desk,
      deletedAt: r.trashed_at,
      purgeAt: purgeAtFor(r.trashed_at, true),
      sharedScope: !!r.shared_scope
    })
  }

  for (const r of db
    .prepare(
      `SELECT t.id, t.title, t.trashed_at, n.title AS desk,
              (t.shared_root_id IS NOT NULL OR COALESCE(t.org_id, 'personal') != 'personal') AS shared_scope FROM fb_tables t
       LEFT JOIN nodes n ON n.id = t.task_id
       WHERE t.trashed_at IS NOT NULL AND ${ELSEWHERE_OF('t')} AND (n.id IS NULL OR n.trashed_at IS NULL)`
    )
    .all() as Array<{ id: string; title: string | null; trashed_at: number; desk: string | null; shared_scope: number }>) {
    out.push({ kind: 'table', id: r.id, title: cleanTitle(r.title, 'A table'), where: r.desk, deletedAt: r.trashed_at, purgeAt: null, sharedScope: !!r.shared_scope })
  }

  // A row on its own: its table is still here (rows deleted with their table come
  // back with it).
  for (const r of db
    .prepare(
      `SELECT r.id, r.cells_json, r.trashed_at, t.title AS tbl,
              (r.shared_root_id IS NOT NULL OR COALESCE(t.org_id, 'personal') != 'personal') AS shared_scope FROM fb_rows r
       JOIN fb_tables t ON t.id = r.table_id
       WHERE r.trashed_at IS NOT NULL AND ${ELSEWHERE_OF('r')} AND t.trashed_at IS NULL`
    )
    .all() as Array<{ id: string; cells_json: string | null; trashed_at: number; tbl: string | null; shared_scope: number }>) {
    out.push({ kind: 'row', id: r.id, title: rowTitle(r.cells_json), where: cleanTitle(r.tbl, 'A table'), deletedAt: r.trashed_at, purgeAt: null, sharedScope: !!r.shared_scope })
  }

  for (const r of db
    .prepare(
      `SELECT id, title, trashed_at, COALESCE(org_id, 'personal') != 'personal' AS shared_scope
       FROM time_blocks WHERE trashed_at IS NOT NULL AND ${ELSEWHERE}`
    )
    .all() as Array<{ id: string; title: string | null; trashed_at: number; shared_scope: number }>) {
    out.push({ kind: 'timeblock', id: r.id, title: cleanTitle(r.title, 'A time block'), where: null, deletedAt: r.trashed_at, purgeAt: null, sharedScope: !!r.shared_scope })
  }

  // Drive files and folders: the roots of what was deleted (a folder's contents
  // come back with it). Pointers to documents are listed as the documents.
  for (const r of db
    .prepare(
      `SELECT f.id, COALESCE(f.display_name, f.original_name) AS name, f.trashed_at, p.display_name AS pd, p.original_name AS po,
              COALESCE(f.org_id, 'personal') != 'personal' AS shared_scope
       FROM fb_files f LEFT JOIN fb_files p ON p.id = f.parent_id
       WHERE f.trashed_at IS NOT NULL AND ${ELSEWHERE_OF('f')} AND f.kind IN ('file','folder')
         AND (p.id IS NULL OR p.trashed_at IS NULL)`
    )
    .all() as Array<{ id: string; name: string | null; trashed_at: number; pd: string | null; po: string | null; shared_scope: number }>) {
    out.push({
      kind: 'file',
      id: r.id,
      title: cleanTitle(r.name, 'A file'),
      where: r.pd ?? r.po ?? null,
      deletedAt: r.trashed_at,
      purgeAt: purgeAtFor(r.trashed_at, true),
      sharedScope: !!r.shared_scope
    })
  }

  for (const r of db
    .prepare(
      `SELECT id, title, trashed_at, COALESCE(org_id, 'personal') != 'personal' AS shared_scope
       FROM documents WHERE trashed_at IS NOT NULL AND ${ELSEWHERE}`
    )
    .all() as Array<{ id: string; title: string | null; trashed_at: number; shared_scope: number }>) {
    out.push({ kind: 'document', id: r.id, title: cleanTitle(r.title, 'A document'), where: null, deletedAt: r.trashed_at, purgeAt: null, sharedScope: !!r.shared_scope })
  }

  return out.sort((a, b) => b.deletedAt - a.deletedAt)
}

function isDeletedElsewhere(kind: DeletedElsewhereKind, id: string): { trashed_at: number } | undefined {
  // The kind arrives over IPC as a plain string and picks a table: only these.
  if (!Object.prototype.hasOwnProperty.call(TABLE_OF, kind) || typeof id !== 'string') return undefined
  return getDb()
    .prepare(`SELECT trashed_at FROM ${TABLE_OF[kind]} WHERE id = ? AND trashed_at IS NOT NULL AND ${ELSEWHERE}`)
    .get(id) as { trashed_at: number } | undefined
}

/** Restore something deleted elsewhere. Returns the ids that came back (a desk's subtree, a table's rows). */
export function restoreDeletedElsewhere(kind: DeletedElsewhereKind, id: string): DeletedElsewhereRestore {
  const hit = isDeletedElsewhere(kind, id)
  if (!hit) return { restored: false, ids: [] }
  const db = getDb()
  const now = Date.now()
  switch (kind) {
    case 'widget':
      return { restored: restoreWidget(id), ids: [id] }
    case 'row':
      return { restored: !!restoreRow(id), ids: [id] }
    case 'node': {
      const ids = restoreTree(id)
      return { restored: ids.length > 0, ids }
    }
    case 'file':
      return { restored: restoreEntryDeep(id), ids: [id] }
    case 'document':
      return { restored: restoreDocument(id), ids: [id] }
    case 'timeblock': {
      const r = db.prepare('UPDATE time_blocks SET trashed_at = NULL, updated_at = ? WHERE id = ? AND trashed_at IS NOT NULL').run(now, id) as {
        changes?: number
      }
      return { restored: (r.changes ?? 0) > 0, ids: [id] }
    }
    case 'table': {
      return db.transaction(() => {
        const rows = db
          .prepare(
            `SELECT id FROM fb_rows WHERE table_id = ? AND trashed_at IS NOT NULL AND ${ELSEWHERE} AND ABS(trashed_at - ?) <= ?`
          )
          .all(id, hit.trashed_at, WITH_TABLE_MS) as Array<{ id: string }>
        db.prepare('UPDATE fb_tables SET trashed_at = NULL, updated_at = ? WHERE id = ?').run(now, id)
        const back = db.prepare('UPDATE fb_rows SET trashed_at = NULL, updated_at = ? WHERE id = ?')
        for (const r of rows) back.run(now, r.id)
        return { restored: true, ids: [id, ...rows.map((r) => r.id)] }
      })()
    }
  }
}

/**
 * Delete something deleted elsewhere for good, on this device only: the server
 * already holds the delete, so nothing is pushed. Desks and rooms go through the
 * Trash's own permanent delete (it also purges what Plexii learned from them).
 */
export function deleteForeverDeletedElsewhere(kind: DeletedElsewhereKind, id: string): boolean {
  if (kind === 'node' || !isDeletedElsewhere(kind, id)) return false
  const db = getDb()
  switch (kind) {
    case 'file':
      return purgeEntry(id)
    case 'document':
      return deleteDocument(id)
    case 'table':
      return db.transaction(() => {
        db.prepare('DELETE FROM fb_rows WHERE table_id = ?').run(id)
        return gone(db.prepare('DELETE FROM fb_tables WHERE id = ?').run(id))
      })()
    case 'widget':
      return gone(db.prepare('DELETE FROM widgets WHERE id = ? AND trashed_at IS NOT NULL').run(id))
    case 'row':
      return gone(db.prepare('DELETE FROM fb_rows WHERE id = ? AND trashed_at IS NOT NULL').run(id))
    case 'timeblock':
      return gone(db.prepare('DELETE FROM time_blocks WHERE id = ? AND trashed_at IS NOT NULL').run(id))
  }
}

const gone = (r: unknown): boolean => ((r as { changes?: number }).changes ?? 0) > 0
