import { randomUUID } from 'crypto'
import { getDb } from './database'
import type { WireRun } from '@shared/types'

// Durable history of reactive-wire writes (transform / mirror) into text targets.
// Each row stores the target's content before and after the write, so the user
// can see what an automation did and revert it in one click. We keep the last
// MAX_PER_WIRE per wire and prune older ones, so a chatty mirror can't grow the
// log without bound. Table-target writes are not recorded here (row-level, a
// different diff shape).

const MAX_PER_WIRE = 30

interface WireRunRow {
  id: string
  wire_id: string
  task_id: string
  source_widget_id: string
  target_widget_id: string
  source_label: string
  wire_type: string
  verb: string
  at: number
  prev_content: string
  next_content: string
}

function rowToRun(r: WireRunRow): WireRun {
  return {
    id: r.id,
    wireId: r.wire_id,
    taskId: r.task_id,
    sourceWidgetId: r.source_widget_id,
    targetWidgetId: r.target_widget_id,
    sourceLabel: r.source_label,
    wireType: r.wire_type === 'mirror' ? 'mirror' : r.wire_type === 'context' ? 'context' : 'transform',
    verb: r.verb ?? '',
    at: r.at,
    prevContent: r.prev_content ?? '',
    nextContent: r.next_content ?? ''
  }
}

export type WireRunInput = Omit<WireRun, 'id'>

// Record one write. Returns the stored run (with its new id). Prunes the wire's
// history to the most recent MAX_PER_WIRE afterwards.
export function recordWireRun(input: WireRunInput): WireRun {
  const db = getDb()
  const id = randomUUID()
  db.prepare(
    `INSERT INTO wire_runs
      (id, wire_id, task_id, source_widget_id, target_widget_id, source_label,
       wire_type, verb, at, prev_content, next_content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.wireId,
    input.taskId,
    input.sourceWidgetId,
    input.targetWidgetId,
    input.sourceLabel,
    input.wireType,
    input.verb,
    input.at,
    input.prevContent,
    input.nextContent
  )
  db.prepare(
    `DELETE FROM wire_runs
      WHERE wire_id = ?
        AND id NOT IN (
          SELECT id FROM wire_runs WHERE wire_id = ? ORDER BY at DESC LIMIT ?
        )`
  ).run(input.wireId, input.wireId, MAX_PER_WIRE)
  return { id, ...input }
}

// The recent write history for one wire, newest first.
export function listWireRunsByWire(wireId: string, limit = MAX_PER_WIRE): WireRun[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM wire_runs WHERE wire_id = ? ORDER BY at DESC LIMIT ?')
    .all(wireId, limit) as WireRunRow[]
  return rows.map(rowToRun)
}
