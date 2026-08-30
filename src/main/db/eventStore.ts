// Append-only Event Store (spec §35, §49, ADR-0001).
//
// The system of record for Plexi 4.0. Events are immutable and append-only,
// enforced by SQLite triggers, not convention (PLX-EVT-010, PLX-EVT-030). Each
// append assigns a UUIDv7 id, an ingestion time distinct from occurrence time,
// and a monotonic per-partition sequence (PLX-EVT-013, PLX-EVT-022). State
// mutation and its Event commit atomically via a transactional outbox
// (PLX-EVT-014). Large state is externalised to a content-addressed blob and
// carried as a digest (PLX-EVT-045). Consumers dedupe via processOnce so
// at-least-once delivery is safe (PLX-EVT-015).
//
// The store binds to any better-sqlite3 handle, so tests use an in-memory DB.

import { createHash } from 'node:crypto'
import { plexiId } from '../../shared/plexiId'
import {
  assertEventTypeName,
  assertPayloadWithinCeiling,
  byteLength,
  INLINE_STATE_THRESHOLD_BYTES,
  isDigestRef,
  partitionKey,
  type EventCategory,
  type PermissionSnapshot,
  type PlexiEvent,
  type StatePayload
} from '../../shared/events'
import { upcastEvent } from './upcasting'

// Minimal SQLite surface the store needs. better-sqlite3's Database satisfies it
// structurally (production passes getDb() directly); tests pass a node:sqlite
// adapter, so the store never depends on a native binding the test runner cannot
// load (better-sqlite3 is compiled for Electron's ABI).
export interface SqlStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}
export interface SqlDb {
  exec(sql: string): unknown
  prepare(sql: string): SqlStatement
  transaction<T>(fn: () => T): () => T
}

export interface AppendInput {
  eventType: string
  schemaVersion?: number
  category: EventCategory
  actor: string
  organisationId: string
  deskId?: string | null
  objectId?: string | null
  previousState?: StatePayload
  currentState?: StatePayload
  changeSummary?: string | null
  correlationId?: string | null // defaults to a fresh id (starts a new chain)
  causationId?: string | null
  source?: string
  timestamp?: string // occurrence time; defaults to now
  permissions?: PermissionSnapshot
  confidence?: number | null
  metadata?: Record<string, unknown>
}

export function ensureEventSchema(db: SqlDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      category TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      organisation_id TEXT NOT NULL,
      desk_id TEXT,
      object_id TEXT,
      partition_key TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      previous_state TEXT,
      current_state TEXT,
      change_summary TEXT,
      correlation_id TEXT NOT NULL,
      causation_id TEXT,
      source TEXT NOT NULL,
      permissions TEXT NOT NULL,
      confidence REAL,
      metadata TEXT NOT NULL,
      UNIQUE(source, id),
      UNIQUE(partition_key, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_events_partition_seq ON events(partition_key, sequence);
    CREATE INDEX IF NOT EXISTS idx_events_desk_seq ON events(desk_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id);

    -- Immutability, enforced at the database layer (PLX-EVT-010 / PLX-EVT-030).
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'events are immutable once written (PLX-EVT-010)'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'the event store is append-only (PLX-EVT-030)'); END;

    -- Content-addressed store for large state carried as digests (PLX-EVT-045).
    CREATE TABLE IF NOT EXISTS event_blobs (
      digest TEXT PRIMARY KEY,
      bytes INTEGER NOT NULL,
      content TEXT NOT NULL
    );

    -- Transactional outbox: an Event is queued for the bus in the same
    -- transaction as its state mutation (PLX-EVT-014).
    CREATE TABLE IF NOT EXISTS event_outbox (
      event_id TEXT PRIMARY KEY REFERENCES events(id),
      published INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    -- Per-consumer processed set for idempotent, at-least-once consumption (PLX-EVT-015).
    CREATE TABLE IF NOT EXISTS event_consumer_offsets (
      consumer TEXT NOT NULL,
      event_id TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      PRIMARY KEY (consumer, event_id)
    );
  `)
}

function sha256(json: string): string {
  return 'sha256:' + createHash('sha256').update(json).digest('hex')
}

// Externalise large state to the blob store, returning a DigestRef; small state
// stays inline. Digests are content-addressed, so identical state is stored once.
function externalise(db: SqlDb, state: StatePayload): StatePayload {
  if (state == null || isDigestRef(state)) return state
  const json = JSON.stringify(state)
  if (byteLength(json) <= INLINE_STATE_THRESHOLD_BYTES) return state
  const digest = sha256(json)
  db.prepare('INSERT OR IGNORE INTO event_blobs (digest, bytes, content) VALUES (?, ?, ?)').run(digest, byteLength(json), json)
  return { $digest: digest }
}

export interface EventStore {
  append: (input: AppendInput) => PlexiEvent
  appendWithMutation: <T>(input: AppendInput, mutate: (db: SqlDb) => T) => { event: PlexiEvent; result: T }
  replayDesk: (deskId: string, opts?: { untilSequence?: number }) => PlexiEvent[]
  resolveState: (state: StatePayload) => StatePayload
  processOnce: (consumer: string, eventId: string, fn: () => void) => boolean
  pendingOutbox: (limit?: number) => PlexiEvent[]
  markPublished: (eventIds: string[]) => void
  pruneOutbox: (keep?: number) => number
  db: SqlDb
}

// An optional organisation binding scopes replay to a single tenant, so a desk
// replay can never surface another organisation's Events (PLX-SEC-010 defence in
// depth; desks are already org-specific, this makes it enforced not incidental).
export function createEventStore(db: SqlDb, organisationId?: string | (() => string | null)): EventStore {
  const resolveOrg: () => string | null = typeof organisationId === 'function' ? organisationId : () => organisationId ?? null
  const orgBound = organisationId != null
  ensureEventSchema(db)

  function rowToEvent(r: Record<string, unknown>): PlexiEvent {
    const parse = (v: unknown): StatePayload => (v == null ? null : (JSON.parse(v as string) as StatePayload))
    return {
      id: r.id as string,
      eventType: r.event_type as string,
      schemaVersion: r.schema_version as number,
      category: r.category as EventCategory,
      timestamp: r.timestamp as string,
      recordedAt: r.recorded_at as string,
      actor: r.actor as string,
      organisationId: r.organisation_id as string,
      deskId: (r.desk_id as string) ?? null,
      objectId: (r.object_id as string) ?? null,
      previousState: parse(r.previous_state),
      currentState: parse(r.current_state),
      changeSummary: (r.change_summary as string) ?? null,
      correlationId: r.correlation_id as string,
      causationId: (r.causation_id as string) ?? null,
      source: r.source as string,
      sequence: r.sequence as number,
      permissions: JSON.parse(r.permissions as string) as PermissionSnapshot,
      confidence: (r.confidence as number) ?? null,
      metadata: JSON.parse(r.metadata as string) as Record<string, unknown>
    }
  }

  // Read-time upcasting (ADR-0004, PLX-EVT-035): an Event written under an older
  // schema is upcast to the current shape as it is read. The stored row is never
  // rewritten (INV-05). A no-op until an upcaster is registered for the type.
  function readEvent(r: Record<string, unknown>): PlexiEvent {
    return upcastEvent(rowToEvent(r))
  }

  // Core append. Runs inside a transaction so the sequence read and the insert
  // are atomic. NEVER exposes update/delete (PLX-EVT-010).
  // Positional binding keeps the store portable across better-sqlite3 (prod) and
  // the node:sqlite adapter (tests).
  const insertStmt = db.prepare(`
    INSERT INTO events (id, event_type, schema_version, category, timestamp, recorded_at, actor,
      organisation_id, desk_id, object_id, partition_key, sequence, previous_state, current_state,
      change_summary, correlation_id, causation_id, source, permissions, confidence, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  function buildAndInsert(input: AppendInput): PlexiEvent {
    assertEventTypeName(input.eventType)
    const now = new Date().toISOString()
    const id = plexiId()
    const organisationId = input.organisationId
    const deskId = input.deskId ?? null
    const objectId = input.objectId ?? null
    const pk = partitionKey({ deskId, objectId, organisationId })
    const nextSeq =
      (db.prepare('SELECT COALESCE(MAX(sequence), 0) AS s FROM events WHERE partition_key = ?').get(pk) as { s: number }).s + 1

    const prev = externalise(db, input.previousState ?? null)
    const cur = externalise(db, input.currentState ?? null)

    const evt: PlexiEvent = {
      id,
      eventType: input.eventType,
      schemaVersion: input.schemaVersion ?? 1,
      category: input.category,
      timestamp: input.timestamp ?? now,
      recordedAt: now,
      actor: input.actor,
      organisationId,
      deskId,
      objectId,
      previousState: prev,
      currentState: cur,
      changeSummary: input.changeSummary ?? null,
      correlationId: input.correlationId ?? id, // a root cause starts its own chain
      causationId: input.causationId ?? null,
      source: input.source ?? `/plexi/org/${organisationId}/service/desktop`,
      sequence: nextSeq,
      permissions: input.permissions ?? { grants: [] },
      confidence: input.confidence ?? null,
      metadata: input.metadata ?? {}
    }

    assertPayloadWithinCeiling(evt)

    insertStmt.run(
      evt.id,
      evt.eventType,
      evt.schemaVersion,
      evt.category,
      evt.timestamp,
      evt.recordedAt,
      evt.actor,
      evt.organisationId,
      evt.deskId,
      evt.objectId,
      pk,
      evt.sequence,
      evt.previousState == null ? null : JSON.stringify(evt.previousState),
      evt.currentState == null ? null : JSON.stringify(evt.currentState),
      evt.changeSummary,
      evt.correlationId,
      evt.causationId,
      evt.source,
      JSON.stringify(evt.permissions),
      evt.confidence,
      JSON.stringify(evt.metadata)
    )
    db.prepare('INSERT INTO event_outbox (event_id, published, created_at) VALUES (?, 0, ?)').run(evt.id, now)
    return evt
  }

  const append: EventStore['append'] = (input) => db.transaction(() => buildAndInsert(input))()

  const appendWithMutation: EventStore['appendWithMutation'] = (input, mutate) =>
    db.transaction(() => {
      // Mutation and Event commit together, or neither does (PLX-EVT-014).
      const result = mutate(db)
      const event = buildAndInsert(input)
      return { event, result }
    })()

  const resolveState: EventStore['resolveState'] = (state) => {
    if (!isDigestRef(state)) return state
    const row = db.prepare('SELECT content FROM event_blobs WHERE digest = ?').get(state.$digest) as { content: string } | undefined
    return row ? (JSON.parse(row.content) as StatePayload) : state
  }

  const replayDesk: EventStore['replayDesk'] = (deskId, opts) => {
    const orgClause = orgBound ? ' AND organisation_id = ?' : ''
    const orgArg = orgBound ? [resolveOrg()] : []
    const rows = opts?.untilSequence
      ? (db
          .prepare(`SELECT * FROM events WHERE desk_id = ? AND sequence <= ?${orgClause} ORDER BY sequence ASC`)
          .all(deskId, opts.untilSequence, ...orgArg) as Record<string, unknown>[])
      : (db.prepare(`SELECT * FROM events WHERE desk_id = ?${orgClause} ORDER BY sequence ASC`).all(deskId, ...orgArg) as Record<string, unknown>[])
    return rows.map(readEvent)
  }

  // Run fn exactly once per (consumer, event); duplicate delivery is a no-op that
  // returns false. Idempotent by construction (PLX-EVT-015).
  const processOnce: EventStore['processOnce'] = (consumer, eventId, fn) => {
    const already = db.prepare('SELECT 1 FROM event_consumer_offsets WHERE consumer = ? AND event_id = ?').get(consumer, eventId)
    if (already) return false
    db.transaction(() => {
      fn()
      db.prepare('INSERT INTO event_consumer_offsets (consumer, event_id, processed_at) VALUES (?, ?, ?)').run(consumer, eventId, new Date().toISOString())
    })()
    return true
  }

  const pendingOutbox: EventStore['pendingOutbox'] = (limit = 100) => {
    const rows = db
      .prepare('SELECT e.* FROM events e JOIN event_outbox o ON o.event_id = e.id WHERE o.published = 0 ORDER BY e.recorded_at ASC LIMIT ?')
      .all(limit) as Record<string, unknown>[]
    return rows.map(readEvent)
  }

  const markPublished: EventStore['markPublished'] = (eventIds) => {
    const stmt = db.prepare('UPDATE event_outbox SET published = 1 WHERE event_id = ?')
    db.transaction(() => eventIds.forEach((id) => stmt.run(id)))()
  }

  // DEC-056 — retention for the DELIVERY QUEUE ONLY. There is deliberately no
  // equivalent for `events`: PLX-EVT-030 forbids ANY interface, "including
  // administrative and database-level access", from deleting a written Event,
  // and PLX-EVT-031 requires replay to reconstruct any Desk at any point in its
  // history. Writing a pruneEvents() would itself be the prohibited interface,
  // so it does not exist and must not be added — the events_no_delete trigger
  // is the enforcement, this comment is the reason.
  //
  // `event_outbox` carries no history. Each row is delivery bookkeeping — a
  // pointer saying "this Event still needs publishing" — and the Event it
  // points at stays in `events`, replayable. Capping the backlog therefore
  // destroys nothing the spec protects. The cap matters because the outbox
  // gains a row per Event and only sheds one when a publisher drains it; with
  // no bus attached it grows forever (764,373 rows / 51.6 MB on the operator's
  // machine, every one still unpublished).
  const pruneOutbox: EventStore['pruneOutbox'] = (keep = 5000) => {
    const info = db
      .prepare(
        `DELETE FROM event_outbox WHERE event_id NOT IN (
           SELECT event_id FROM event_outbox ORDER BY created_at DESC, event_id DESC LIMIT ?
         )`
      )
      .run(keep) as { changes?: number } | undefined
    return Number(info?.changes ?? 0)
  }

  return { append, appendWithMutation, replayDesk, resolveState, processOnce, pendingOutbox, markPublished, pruneOutbox, db }
}
