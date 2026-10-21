import { getDb } from './database'

// WS01 sync substrate — the local end of the change log. The renderer's sync engine
// records every widget CRDT event here (via the crdt: IPC) so it survives a reload
// and, crucially, so events emitted while the socket is down queue as `synced = 0`
// and flush on reconnect (SYN-010). The store is deliberately dumb: it persists the
// event it is handed and answers "what have I not synced" and "what ids do I know".
// All the merge logic lives in the shared crdtWidgetMerge core.

export interface LocalChangeEvent {
  id: string
  partitionKey: string
  seq: number | null
  ts: string
  objectType: string
  objectId: string
  field: string
  dataClass: string
  actor: string
  payload: unknown
  synced: boolean
}

interface Row {
  id: string
  partition_key: string
  seq: number | null
  occurred_at: string
  object_type: string
  object_id: string
  field: string
  data_class: string
  actor: string
  payload: string
  synced: number
}

function rowTo(r: Row): LocalChangeEvent {
  return {
    id: r.id,
    partitionKey: r.partition_key,
    seq: r.seq,
    ts: r.occurred_at,
    objectType: r.object_type,
    objectId: r.object_id,
    field: r.field,
    dataClass: r.data_class,
    actor: r.actor,
    payload: JSON.parse(r.payload),
    synced: r.synced === 1
  }
}

export interface RecordInput {
  id: string
  partitionKey: string
  ts: string
  objectType: string
  objectId: string
  field: string
  dataClass: string
  actor: string
  payload: unknown
  // Whether the event is already known to be on the server. A locally-originated
  // edit is recorded synced = false and flushed; an event applied FROM the server
  // is recorded synced = true with its authoritative seq.
  synced?: boolean
  seq?: number | null
}

// Record an event. Idempotent by id: re-recording (e.g. a server echo of our own
// event, or a replayed offline event) is a no-op, so it never duplicates. Never
// throws — a sync-bookkeeping failure must not break the user's edit.
export function recordEvent(input: RecordInput): void {
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO change_log
           (id, partition_key, seq, occurred_at, object_type, object_id, field, data_class, actor, payload, synced, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.partitionKey,
        input.seq ?? null,
        input.ts,
        input.objectType,
        input.objectId,
        input.field,
        input.dataClass,
        input.actor,
        JSON.stringify(input.payload ?? null),
        input.synced ? 1 : 0,
        Date.now()
      )
  } catch {
    // best-effort
  }
}

// The locally-originated events not yet acknowledged by the server, oldest-first so
// a flush preserves emission order. Never throws.
export function unsyncedEvents(limit = 500): LocalChangeEvent[] {
  try {
    const rows = getDb()
      .prepare('SELECT * FROM change_log WHERE synced = 0 ORDER BY created_at ASC, rowid ASC LIMIT ?')
      .all(Math.max(1, limit)) as Row[]
    return rows.map(rowTo)
  } catch {
    return []
  }
}

// Mark the given events synced (optionally stamping the server's authoritative
// sequence) once the server has them. Never throws.
export function markSynced(entries: Array<{ id: string; seq?: number | null }>): void {
  if (entries.length === 0) return
  try {
    const db = getDb()
    const stmt = db.prepare('UPDATE change_log SET synced = 1, seq = COALESCE(?, seq) WHERE id = ?')
    db.transaction((list: Array<{ id: string; seq?: number | null }>) => {
      for (const e of list) stmt.run(e.seq ?? null, e.id)
    })(entries)
  } catch {
    // best-effort
  }
}
