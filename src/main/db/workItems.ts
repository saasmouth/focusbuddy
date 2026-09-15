// work_item data model — columns, projection, satellites, remote apply
// (Attention layer S2; ARCHITECTURE §2.2–§2.4, §3).
//
// One code path (F008): every work_item write — user, AI, or sync arrival —
// lands in this module. `work_item_state` is the single source of truth; the
// legacy `status` column is a derived coarse projection computed HERE at every
// write and recomputed at every sync apply, so cross-version mapping drift can
// never produce divergent projections (F012). Dismissed/reclassified project to
// 'parked', NEVER 'done' (A-02).
//
// The column manifest is THE export the CRDT allowlists, the emit snapshot,
// ensureColumns, the arrival router, and the CI parity test all consume — one
// source, drift impossible.
//
// Handle-taking core + thin getDb wrappers, same testability pattern as
// nodeLifecycle.ts.

import { randomUUID } from 'crypto'
import { getDb } from './database'
import { getActiveOrgId, PERSONAL_ORG_ID } from './activeOrg'
import { nodesTableAcceptsWorkItems } from './migrateNodesKind'
import { isWorkItemsEnabled } from '../workItemsPref'
import { mapNodeRow, type NodeRow } from './nodes'
import { postNotification } from '../notifications/substrate'
import { attentionPrecision } from '../meta/metrics'
import { asAttentionItem } from '@shared/attentionProjection'
import type { FbNode } from '@shared/types'
import type { LifecycleDb } from './nodeLifecycle'
import {
  WORK_ITEM_COLUMNS,
  WORK_ITEM_SCHEMA_EPOCH,
  WORK_ITEM_STATES,
  ACTIVE_WORK_ITEM_STATES,
  TERMINAL_WORK_ITEM_STATES,
  DEFAULT_INTENT_CLASS,
  MAX_GROUP_DEPTH,
  canonicalIntentClass,
  initialWorkItemState,
  statusForWorkItemState,
  type WorkItemState
} from '@shared/workItems'

export { WORK_ITEM_COLUMNS, WORK_ITEM_SCHEMA_EPOCH, WORK_ITEM_STATES, statusForWorkItemState }
export type { WorkItemState }

// SQL IN-list built from the one shared state source, so adding a state can
// never miss a predicate (the pre-alignment inline lists drifted per-query).
const sqlIn = (xs: readonly string[]): string => xs.map((s) => `'${s}'`).join(',')
const ACTIVE_IN = sqlIn(ACTIVE_WORK_ITEM_STATES)
const TERMINAL_IN = sqlIn(TERMINAL_WORK_ITEM_STATES)

// ── Schema (columns + satellites §2.4) ──────────────────────────────────────

export function ensureWorkItemSchema(d: LifecycleDb & { exec(sql: string): void }): void {
  const cols = d.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>
  const have = new Set(cols.map((c) => c.name))
  for (const def of WORK_ITEM_COLUMNS) {
    if (!have.has(def.column)) d.exec(`ALTER TABLE nodes ADD COLUMN ${def.column} ${def.ddl}`)
  }
  // Satellites: org-scoped, never synced, never in sync bodies (§2.4).
  // detached_from_id lives HERE, not on nodes (F-M6″): it names a row
  // hard-deleted on THE PURGING DEVICE — a device-local fact whose replication
  // would show peers an un-honorable re-attach.
  d.exec(`
    CREATE TABLE IF NOT EXISTS wi_local (
      item_id TEXT PRIMARY KEY,
      snooze_until INTEGER,
      read_at INTEGER,
      local_flags TEXT,
      detached_from_id TEXT
    );
    CREATE TABLE IF NOT EXISTS wi_deliveries (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      dedupe_key TEXT UNIQUE,
      delivered_at INTEGER
    );
  `)
  // Orphan reconciliation (R017): satellite rows whose item is gone are swept
  // at startup — satellites carry no FK (nodes hard-deletes must not cascade
  // into device-local bookkeeping mid-lifecycle; the sweep is the contract).
  d.exec('DELETE FROM wi_local WHERE item_id NOT IN (SELECT id FROM nodes)')
  d.exec('DELETE FROM wi_deliveries WHERE item_id NOT IN (SELECT id FROM nodes)')
}

// ── wi_local helpers + the detach hook (§2.5.3 seam, wired at S2) ───────────

export function setDetachedFrom(d: LifecycleDb, itemId: string, fromId: string | null): void {
  d.prepare(
    `INSERT INTO wi_local (item_id, detached_from_id) VALUES (?, ?)
     ON CONFLICT(item_id) DO UPDATE SET detached_from_id = excluded.detached_from_id`
  ).run(itemId, fromId)
}

/** The DetachHook nodes.ts / workspaceSync pass into the lifecycle module so a
 *  lifecycle detach records where the item came from (the Detached surface's
 *  context + the re-attach predicate, F-M8″). */
export function workItemDetachHook(d: LifecycleDb): { onDetached(id: string, from: string | null): void } {
  return {
    onDetached: (id, from) => {
      try {
        setDetachedFrom(d, id, from)
      } catch (err) {
        // Bookkeeping must never break the detach itself (F-m3).
        // eslint-disable-next-line no-console
        console.warn('[workItems] detach bookkeeping failed:', err)
      }
    }
  }
}

// ── Creation + state writes (the ONE code path, F008) ───────────────────────

export interface WorkItemDraft {
  id?: string
  title: string
  notes?: string
  parentId?: string | null
  intentClass?: string
  dueAt?: string | null
  wiUrgency?: string | null
  /** DEC-047 D-5: an ACTIVE birth state (open/in_progress/waiting/blocked);
   *  anything else falls to 'open'. Terminal states stay setState-only. */
  state?: string
  tags?: string | null
  mentions?: string | null
  sourceRef?: string | null
  sourceUrl?: string | null
  sourceType?: string | null
  confidence?: number | null
  approvalState?: string
  reasonCode?: string | null
  wiOrigin?: 'human' | 'ai' | 'system'
  originatorId?: string | null
  recipientId?: string | null
}

/** DEC-018 A-1 (Dispatch D4 seam): who performed a write — a person, an agent
 *  acting for one, or the system. v1 threads and logs it; persistent storage
 *  (columns vs event log) is a D4-time DEC. Reserved NOW because these cores
 *  are the only write path (F008): a parameter today, a caller sweep later. */
export interface WorkItemActor {
  kind: 'human' | 'agent' | 'system'
  agentRef?: string
  missionRef?: string
}

function logActor(op: string, id: string, actor?: WorkItemActor): void {
  if (!actor || actor.kind === 'human') return
  // eslint-disable-next-line no-console
  console.info(
    `[workItems] ${op} ${id} by ${actor.kind}${actor.agentRef ? ` agent=${actor.agentRef}` : ''}${actor.missionRef ? ` mission=${actor.missionRef}` : ''}`
  )
}

export class WorkItemWriteRefusedError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'WorkItemWriteRefusedError'
  }
}

function assertWritable(d: LifecycleDb): void {
  if (!isWorkItemsEnabled())
    throw new WorkItemWriteRefusedError('WORK_ITEMS_DISABLED', 'Work items are not enabled.')
  if (!nodesTableAcceptsWorkItems(d as never))
    throw new WorkItemWriteRefusedError(
      'WORK_ITEMS_NOT_MIGRATED',
      'This device has not migrated for work items yet.'
    )
}

export function createWorkItemCore(
  d: LifecycleDb,
  draft: WorkItemDraft,
  orgId: string,
  actor?: WorkItemActor
): { id: string } {
  assertWritable(d)
  if (orgId !== PERSONAL_ORG_ID)
    throw new WorkItemWriteRefusedError(
      'WORK_ITEMS_PERSONAL_ONLY',
      'Work items are personal-scope only while the sharing switch is off.'
    )
  // Leaf invariant: a work_item parent must be a desk/room, never a work_item.
  if (draft.parentId) {
    const parent = d.prepare('SELECT kind FROM nodes WHERE id = ?').get(draft.parentId) as
      | { kind: string }
      | undefined
    if (parent?.kind === 'work_item')
      throw new WorkItemWriteRefusedError('WORK_ITEM_PARENT_REFUSED', 'Nothing nests under a work item.')
  }
  const id = draft.id ?? randomUUID()
  const state: WorkItemState = initialWorkItemState(draft.approvalState, draft.state)
  const now = Date.now()
  d.prepare(
    `INSERT INTO nodes (
       id, parent_id, kind, title, description, status,
       priority, interest, importance, sort_order, created_at, updated_at,
       org_id, work_item_state, intent_class, originator_id, recipient_id,
       due_at, wi_urgency, tags, mentions, source_ref, source_url, source_type, confidence,
       approval_state, reason_code, wi_origin, schema_epoch
     ) VALUES (?, ?, 'work_item', ?, ?, ?, 3, 3, 3, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    draft.parentId ?? null,
    draft.title,
    draft.notes ?? '',
    statusForWorkItemState(state),
    now,
    now,
    orgId,
    state,
    canonicalIntentClass(draft.intentClass) ?? DEFAULT_INTENT_CLASS,
    draft.originatorId ?? null,
    draft.recipientId ?? draft.originatorId ?? null,
    draft.dueAt ?? null,
    draft.wiUrgency ?? null,
    draft.tags ?? null,
    draft.mentions ?? null,
    draft.sourceRef ?? null,
    draft.sourceUrl ?? null,
    draft.sourceType ?? null,
    draft.confidence ?? null,
    draft.approvalState ?? 'auto',
    draft.reasonCode ?? null,
    draft.wiOrigin ?? 'human',
    WORK_ITEM_SCHEMA_EPOCH
  )
  logActor('create', id, actor)
  return { id }
}

export function setWorkItemStateCore(
  d: LifecycleDb,
  id: string,
  state: WorkItemState,
  actor?: WorkItemActor
): boolean {
  if (!(WORK_ITEM_STATES as readonly string[]).includes(state)) return false
  const row = d.prepare('SELECT kind FROM nodes WHERE id = ?').get(id) as
    | { kind: string }
    | undefined
  if (row?.kind === 'task') {
    // A desk task closed from Attention -- but ONLY a task filed on a desk.
    // The write path applies the same rule as the read path (a task whose
    // parent is also a task), because a desk is itself kind='task' and a desk
    // is not an item to be done. Without this, an id that Attention can never
    // show could still be closed through it, and read and write would disagree
    // about what an attention item is.
    const parent = d
      .prepare('SELECT p.kind AS kind FROM nodes n JOIN nodes p ON p.id = n.parent_id WHERE n.id = ?')
      .get(id) as { kind: string } | undefined
    if (parent?.kind !== 'task') return false
    // Only `status` is written: for a task status IS the truth, and stamping
    // work_item_state onto it would create the second, drifting copy this
    // unification exists to remove. The desk's own task list reads the same
    // row and sees the change immediately.
    d.prepare('UPDATE nodes SET status = ?, updated_at = ? WHERE id = ?').run(
      statusForWorkItemState(state),
      Date.now(),
      id
    )
    logActor(`setState:${state}`, id, actor)
    return true
  }
  if (row?.kind !== 'work_item') return false
  d.prepare(
    'UPDATE nodes SET work_item_state = ?, status = ?, updated_at = ? WHERE id = ?'
  ).run(state, statusForWorkItemState(state), Date.now(), id)
  logActor(`setState:${state}`, id, actor)
  return true
}

// ── Sync-side apply (§2.1 branches + §2.3 F012 + §3 D1) ─────────────────────

export type RemoteWorkItemVerdict = 'applied' | 'parked-epoch' | 'not-work-item'

/**
 * Post-apply normalization for a work_item row that just arrived by ANY
 * transport: recompute the status projection locally from work_item_state
 * (cross-version drift cannot produce divergent projections — F012), enforce
 * the leaf invariant on replicated parent_ids (F-M3″: detach rather than
 * accept a child under a work_item), and park rows from a NEWER schema epoch.
 * Parking here = revert to un-materialized is impossible post-upsert on the
 * poll path, so the epoch guard normalizes conservatively: state untouched,
 * flagged via return for the caller to surface.
 */
export function normalizeAppliedWorkItem(d: LifecycleDb, id: string): RemoteWorkItemVerdict {
  const row = d
    .prepare('SELECT kind, parent_id, work_item_state, intent_class, schema_epoch FROM nodes WHERE id = ?')
    .get(id) as
    | {
        kind: string
        parent_id: string | null
        work_item_state: string | null
        intent_class: string | null
        schema_epoch: number | null
      }
    | undefined
  if (row?.kind !== 'work_item') return 'not-work-item'
  if ((row.schema_epoch ?? 0) > WORK_ITEM_SCHEMA_EPOCH) {
    // Newer writer: leave the row as-delivered, surface to the caller.
    return 'parked-epoch'
  }
  // Projection recompute — local mapping wins over whatever status rode the body.
  const state = row.work_item_state ?? 'open'
  d.prepare('UPDATE nodes SET status = ? WHERE id = ? AND status != ?').run(
    statusForWorkItemState(state),
    id,
    statusForWorkItemState(state)
  )
  // Taxonomy alignment: a LEGACY intent_class arriving by any transport — an
  // un-updated peer's push, or a 409 conflict-apply delivering a stale server
  // copy — canonicalizes ON APPLY. The UPDATE fires the dirty trigger, so the
  // canonical value pushes back next cycle and the fleet converges FORWARD.
  // Without this, a conflict-apply regresses renamed rows until the next
  // startup migration (observed live on the migration's first sync cycle).
  // Unknown non-legacy values still store verbatim (S2's philosophy — only
  // the known legacy set maps).
  if (row.intent_class != null) {
    const canonical = canonicalIntentClass(row.intent_class)
    if (canonical && canonical !== row.intent_class) {
      d.prepare('UPDATE nodes SET intent_class = ? WHERE id = ?').run(canonical, id)
    }
  }
  // Leaf invariant on the replicated parent chain.
  if (row.parent_id) {
    const parent = d.prepare('SELECT kind FROM nodes WHERE id = ?').get(row.parent_id) as
      | { kind: string }
      | undefined
    if (parent?.kind === 'work_item') {
      d.prepare('UPDATE nodes SET parent_id = NULL WHERE id = ?').run(id)
    }
  }
  return 'applied'
}

// ── getDb-bound wrappers ────────────────────────────────────────────────────

export function createWorkItem(draft: WorkItemDraft, actor?: WorkItemActor): FbNode {
  const { id } = createWorkItemCore(getDb(), draft, getActiveOrgId(), actor)
  const item = getWorkItem(id)
  if (!item) throw new Error('work_item creation failed post-insert')
  return item
}

// Closure = terminal minus 'archived' (DEC-024: archiving is a shelf move,
// never a loop closure — no notification).
const CLOSURE_STATES = TERMINAL_WORK_ITEM_STATES.filter((s) => s !== 'archived')
const TERMINAL_STATES: ReadonlySet<string> = new Set(CLOSURE_STATES)

const CLOSURE_VERB: Record<string, string> = Object.fromEntries(CLOSURE_STATES.map((s) => [s, s]))

export function setWorkItemState(id: string, state: WorkItemState, actor?: WorkItemActor): boolean {
  const db = getDb()
  const ok = setWorkItemStateCore(db, id, state, actor)
  // The CLOSED LOOP (S5, §6): a terminal transition posts through the S4
  // substrate — durable, deduped (item+transition = once ever), rate-capped.
  // At P0 self-routing this is the originator's own receipt; at P1 the same
  // post reaches the routed originator.
  if (ok && TERMINAL_STATES.has(state)) {
    try {
      const row = db
        .prepare('SELECT title, intent_class, wi_origin FROM nodes WHERE id = ?')
        .get(id) as { title: string; intent_class: string | null; wi_origin: string | null } | undefined
      if (row) {
        postNotification(db, {
          ref: id,
          queue: canonicalIntentClass(row.intent_class) ?? DEFAULT_INTENT_CLASS,
          title: `${row.title || 'Work item'} — ${CLOSURE_VERB[state] ?? state}`,
          body: 'Loop closed.',
          dedupeKey: `wi-close:${id}:${state}`,
          category: 'attention',
          layer: 'inbox',
          trigger: 'loop-closure',
          origin: (row.wi_origin as 'human' | 'ai' | 'system' | null) ?? 'system'
        })
      }
    } catch {
      // Closure notification is best-effort; the state change already landed.
    }
  }
  return ok
}

/** Δ3 (analysis/20, v1-simple decay): untouched loose thoughts dismiss after
 *  LOOSE_THOUGHT_DECAY_DAYS with reason 'decayed' — the decay tier that keeps
 *  idle captures from polluting queues or memory. Promotion (reclassify) or
 *  any touch (updated_at moves) resets the clock. Run from the scheduler sweep. */
export const LOOSE_THOUGHT_DECAY_DAYS = 14

export function decayLooseThoughtsCore(d: LifecycleDb, nowMs: number): number {
  const cutoff = nowMs - LOOSE_THOUGHT_DECAY_DAYS * 24 * 60 * 60 * 1000
  const stale = d
    .prepare(
      `SELECT id FROM nodes WHERE kind = 'work_item' AND intent_class = 'to_remember'
         AND trashed_at IS NULL AND updated_at < ?
         AND work_item_state NOT IN (${TERMINAL_IN})`
    )
    .all(cutoff) as Array<{ id: string }>
  for (const row of stale) {
    d.prepare(
      `UPDATE nodes SET work_item_state = 'dismissed', status = 'parked', reason_code = 'decayed', updated_at = ? WHERE id = ?`
    ).run(nowMs, row.id)
  }
  return stale.length
}

export function decayLooseThoughts(nowMs = Date.now()): number {
  return decayLooseThoughtsCore(getDb(), nowMs)
}

/** S7 nudge restraint: the ONE proactive OS-notification trigger for items —
 *  deadline proximity. An actionable item due within 24h posts once per item
 *  per due-day (UNIQUE dedupe), through the capped substrate. Stale desks and
 *  everything else surface passively (page/widget), never as banners. */
export function postDeadlineNudgesCore(
  d: LifecycleDb & { exec(sql: string): void },
  nowMs: number
): number {
  const soon = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString()
  const nowIso = new Date(nowMs).toISOString()
  const rows = d
    .prepare(
      `SELECT id, title, intent_class, due_at FROM nodes
       WHERE kind = 'work_item' AND trashed_at IS NULL
         AND intent_class IN ('to_do','to_review','to_meet','to_decide','to_respond')
         AND due_at IS NOT NULL AND due_at > ? AND due_at <= ?
         AND work_item_state IN (${ACTIVE_IN})`
    )
    .all(nowIso, soon) as Array<{ id: string; title: string; intent_class: string; due_at: string }>
  let posted = 0
  for (const r of rows) {
    const day = r.due_at.slice(0, 10)
    const { posted: ok } = postNotification(d, {
      ref: r.id,
      queue: r.intent_class,
      title: r.title || 'Work item',
      body: 'Due within 24 hours.',
      deliverAt: nowMs,
      dedupeKey: `wi-due:${r.id}:${day}`,
      category: 'attention',
      layer: 'interruptive',
      trigger: 'deadline-proximity',
      origin: 'system'
    })
    if (ok) posted++
  }
  // DEC-024 — the To Know deadline backstop: a dated to_know item gets ONE
  // quiet nudge when its date ARRIVES (not before — nothing here is "due"),
  // on the inbox layer, same dedupe shape and caps. The 24h lookback keeps
  // ancient pre-feature dates from spamming a first sweep; anything older
  // missed its window silently, by restraint.
  const dayAgo = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString()
  const fyis = d
    .prepare(
      `SELECT id, title, due_at FROM nodes
       WHERE kind = 'work_item' AND trashed_at IS NULL
         AND intent_class = 'to_know'
         AND due_at IS NOT NULL AND due_at > ? AND due_at <= ?
         AND work_item_state IN (${ACTIVE_IN})`
    )
    .all(dayAgo, nowIso) as Array<{ id: string; title: string; due_at: string }>
  for (const r of fyis) {
    const day = r.due_at.slice(0, 10)
    const { posted: ok } = postNotification(d, {
      ref: r.id,
      queue: 'to_know',
      title: r.title || 'FYI',
      body: 'Its date arrived.',
      deliverAt: nowMs,
      dedupeKey: `wi-due:${r.id}:${day}`,
      category: 'attention',
      layer: 'inbox',
      trigger: 'deadline-proximity',
      origin: 'system'
    })
    if (ok) posted++
  }
  return posted
}

export function postDeadlineNudges(nowMs = Date.now()): number {
  return postDeadlineNudgesCore(getDb(), nowMs)
}

/** Δ10 (main-side half): a source type is SUPPRESSED for auto-surfacing when
 *  its last N AI-suggested items were all dismissed with no acceptance among
 *  them. Every future auto-creating path (feeders that materialize, mission
 *  suggestions at D-phases) MUST consult this before surfacing. */
export const SOURCE_SUPPRESS_THRESHOLD = 3

export function sourceTypeSuppressedCore(
  d: LifecycleDb,
  sourceType: string,
  orgId: string
): boolean {
  const rows = d
    .prepare(
      `SELECT work_item_state AS state FROM nodes
       WHERE kind = 'work_item' AND org_id = ? AND source_type = ?
         AND wi_origin = 'ai' AND approval_state IN ('suggested','dismissed','approved','merged')
         AND work_item_state IN (${sqlIn(CLOSURE_STATES)})
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(orgId, sourceType, SOURCE_SUPPRESS_THRESHOLD) as Array<{ state: string }>
  if (rows.length < SOURCE_SUPPRESS_THRESHOLD) return false
  return rows.every((r) => r.state === 'dismissed')
}

export function sourceTypeSuppressed(sourceType: string): boolean {
  return sourceTypeSuppressedCore(getDb(), sourceType, getActiveOrgId())
}

export function listWorkItems(): FbNode[] {
  const db = getDb()
  // Work items AND the tasks filed on desks: one record seen through one lens.
  //
  // A desk task is selected by its PARENT being a task, because a desk and a
  // task are the same node kind here -- a desk is a task you opened as a canvas
  // -- and a desk is not itself an item to be done. Projection (not a second
  // row) fills in the fields Attention reads; see shared/attentionProjection.
  const rows = db
    .prepare(
      `SELECT n.*, l.detached_from_id AS _detached_from_id, l.snooze_until AS _snooze_until
       FROM nodes n
       LEFT JOIN wi_local l ON l.item_id = n.id
       LEFT JOIN nodes p ON p.id = n.parent_id
       WHERE n.trashed_at IS NULL AND n.org_id = ?
         AND (
           n.kind = 'work_item'
           OR (n.kind = 'task' AND COALESCE(n.archived, 0) = 0 AND p.kind = 'task')
         )
       ORDER BY n.created_at DESC`
    )
    .all(getActiveOrgId()) as Array<NodeRow & { _detached_from_id: string | null; _snooze_until: number | null }>
  return rows.map((r) =>
    asAttentionItem({
      ...mapNodeRow(r),
      // Device-local satellite fields ride the read model only (§2.4).
      detachedFromId: r._detached_from_id ?? null,
      snoozeUntil: r._snooze_until ?? null
    })
  )
}

export function getWorkItem(id: string): FbNode | null {
  const db = getDb()
  const row = db.prepare(`SELECT * FROM nodes WHERE id = ? AND kind = 'work_item'`).get(id) as
    | NodeRow
    | undefined
  return row ? mapNodeRow(row) : null
}

export function updateWorkItemFields(
  id: string,
  patch: Record<string, unknown>,
  actor?: WorkItemActor
): FbNode | null {
  if (!updateWorkItemFieldsCore(getDb(), id, patch, actor)) return null
  return getWorkItem(id)
}

/** §5's badge model: per-intent-class counts of NON-TERMINAL items derived
 *  from work_item_state exclusively (never status — F013), plus a headline
 *  total that excludes wi_origin='system' (DEC-016). */
export function attentionBadgeCounts(): { headline: number; byIntent: Record<string, number> } {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT intent_class AS intent, wi_origin AS origin, COUNT(*) AS n FROM nodes
       WHERE kind = 'work_item' AND trashed_at IS NULL AND org_id = ?
         AND work_item_state IN (${ACTIVE_IN})
       GROUP BY intent_class, wi_origin`
    )
    .all(getActiveOrgId()) as Array<{ intent: string | null; origin: string | null; n: number }>
  const byIntent: Record<string, number> = {}
  let headline = 0
  for (const r of rows) {
    // Canonical keys even for a straggler row an un-updated peer pushed
    // between migrations — the badge never shows a legacy bucket.
    const key = canonicalIntentClass(r.intent) ?? r.intent ?? DEFAULT_INTENT_CLASS
    byIntent[key] = (byIntent[key] ?? 0) + r.n
    if (r.origin !== 'system') headline += r.n
  }
  return { headline, byIntent }
}

export function reclassifyWorkItem(id: string, intentClass: string): FbNode | null {
  if (!reclassifyWorkItemCore(getDb(), id, intentClass)) return null
  return getWorkItem(id)
}

export function snoozeWorkItem(id: string, until: number | null): void {
  snoozeWorkItemCore(getDb(), id, until)
}

export function markWorkItemRead(id: string): void {
  markWorkItemReadCore(getDb(), id)
}

/** Clear the Detached marker after the item is re-homed (the MOVE recovery,
 *  F-M8″: moving IS the resolution — the marker must not linger). */
export function clearWorkItemDetached(id: string): void {
  setDetachedFrom(getDb(), id, null)
}

/** MET-006 wiring: attention precision over recent terminal transitions.
 *  acted = the item was closed with its class verb; dismissed = it was noise.
 *  'reclassified' is neutral (a re-bin, not a verdict) and decayed dismissals
 *  are the system's own act — both excluded. R-03 (taxonomy alignment):
 *  to_know items leave the denominator entirely — information is never
 *  "acted on or noise", and counting it inflated the metric the Q1 0.70
 *  threshold recalibrates against (S7). The legacy 'fyi' value stays
 *  excluded for straggler rows an un-updated peer may push. */
export function workItemAttentionPrecision(windowDays = 30): number | null {
  const db = getDb()
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000
  const rows = db
    .prepare(
      `SELECT work_item_state AS state, reason_code FROM nodes
       WHERE kind = 'work_item' AND org_id = ? AND updated_at > ?
         AND (intent_class IS NULL OR intent_class NOT IN ('to_know','fyi'))
         AND work_item_state IN (${sqlIn(CLOSURE_STATES.filter((s) => s !== 'reclassified'))})`
    )
    .all(getActiveOrgId(), cutoff) as Array<{ state: string; reason_code: string | null }>
  const transitions = rows
    .filter((r) => !(r.state === 'dismissed' && r.reason_code === 'decayed'))
    .map((r) => ({
      state: 'attention-required' as const,
      outcome: r.state === 'dismissed' ? ('dismissed' as const) : ('acted' as const)
    }))
  return attentionPrecision(transitions)
}

export function workItemCounts(): Record<string, number> {
  return workItemCountsCore(getDb(), getActiveOrgId())
}

/** The arrival router's server side (§3 D1): materialize or update an inbound
 *  work_item event from the LIVE path through the one code path — never
 *  through nodes:create/tryCreateNode (which force status='open' and refuse
 *  the kind at the protocol boundary). */
export function applyRemoteWorkItemSnapshot(snapshot: Record<string, unknown>): RemoteWorkItemVerdict {
  const db = getDb()
  const id = String(snapshot.id ?? '')
  if (!id) return 'not-work-item'
  const exists = db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(id)
  if (!exists) {
    const cols = [
      'id',
      'parent_id',
      'kind',
      'title',
      'description',
      'status',
      'priority',
      'interest',
      'importance',
      'sort_order',
      'created_at',
      'updated_at',
      'org_id',
      ...WORK_ITEM_COLUMNS.map((c) => c.column)
    ]
    const now = Date.now()
    const vals: Record<string, unknown> = {
      id,
      parent_id: (snapshot.parentId as string | null) ?? null,
      kind: 'work_item',
      title: String(snapshot.title ?? ''),
      description: String(snapshot.description ?? ''),
      status: 'open',
      priority: 3,
      interest: 3,
      importance: 3,
      sort_order: 0,
      created_at: now,
      updated_at: now,
      org_id: PERSONAL_ORG_ID
    }
    for (const def of WORK_ITEM_COLUMNS) vals[def.column] = (snapshot[def.attr] as never) ?? null
    db.prepare(
      `INSERT INTO nodes (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`
    ).run(vals)
  } else {
    const sets: string[] = []
    const params: Record<string, unknown> = { id }
    for (const def of WORK_ITEM_COLUMNS) {
      if (def.attr in snapshot) {
        sets.push(`${def.column} = @${def.column}`)
        params[def.column] = snapshot[def.attr] as never
      }
    }
    if (typeof snapshot.title === 'string') {
      sets.push('title = @title')
      params.title = snapshot.title
    }
    if (sets.length) db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }
  return normalizeAppliedWorkItem(db, id)
}

/** The live path's inbound attr write for a work_item (router branch of
 *  applyNodeAttr): manifest attrs land on their columns; a bare 'status' attr
 *  is IGNORED (the projection is derived, never written from the wire). */
export function applyRemoteWorkItemAttr(id: string, attr: string, value: unknown): RemoteWorkItemVerdict {
  const db = getDb()
  const def = WORK_ITEM_COLUMNS.find((c) => c.attr === attr)
  if (def) {
    db.prepare(`UPDATE nodes SET ${def.column} = ? WHERE id = ? AND kind = 'work_item'`).run(
      value as never,
      id
    )
  } else if (attr === 'title' || attr === 'description') {
    db.prepare(`UPDATE nodes SET ${attr} = ? WHERE id = ? AND kind = 'work_item'`).run(
      value as never,
      id
    )
  }
  return normalizeAppliedWorkItem(db, id)
}

/** Sync-propagated trash/restore of a work_item (its desk was trashed on the
 *  origin device — §2.5.1's device-scoped semantics arriving over the wire).
 *  Distinct from the C2-guarded USER delete path on purpose. */
export function applyRemoteWorkItemTrash(id: string, trashed: boolean): void {
  const db = getDb()
  db.prepare(
    `UPDATE nodes SET trashed_at = ? WHERE id = ? AND kind = 'work_item'`
  ).run(trashed ? Date.now() : null, id)
}

// ── The workItems:* verb set (S3, §4) — handle-taking cores + wrappers ──────

/** Fields a caller may patch through updateFields. State changes go through
 *  setWorkItemState ONLY (the projection recompute lives there); status is
 *  never patchable (derived). */
//
// DEC-064 — DERIVED from the manifest, minus an explicit refusal list. This was
// a hand-kept map, so a new manifest column got DDL, sync and emit but was
// silently un-writable: updateFields dropped the unknown key without erroring,
// the caller saw success, and the value never landed. Deriving it inverts the
// default — a new column is patchable unless somebody says why not, and the
// why-not is written down here rather than implied by an omission.
const NOT_PATCHABLE: Record<string, string> = {
  // State changes go through setWorkItemState ONLY — the status projection is
  // recomputed there, and a bare UPDATE would leave it lying.
  work_item_state: 'setWorkItemState owns the state machine and its projection',
  // Provenance and routing identity: written once at creation, never edited.
  originator_id: 'who raised it is history, not a field',
  recipient_id: 'routing identity — SPEC-027 owns it',
  source_ref: 'where it came from is history',
  source_type: 'where it came from is history',
  wi_origin: 'how it was born is history',
  confidence: "the classifier's own number; a human editing it would be a lie",
  // The writer's schema version. Stamped by the writer, read by the receiver.
  schema_epoch: 'stamped by the writer, never by a caller'
}

const PATCHABLE: Record<string, string> = {
  title: 'title',
  notes: 'description',
  // DEC-035: manual placement within a queue. A base `nodes` column that
  // already rides the sync body, so a hand-ordered queue travels between
  // devices without joining the work_item manifest.
  sortOrder: 'sort_order',
  ...Object.fromEntries(
    WORK_ITEM_COLUMNS.filter((c) => !(c.column in NOT_PATCHABLE)).map((c) => [c.attr, c.column])
  )
}

export function updateWorkItemFieldsCore(
  d: LifecycleDb,
  id: string,
  patch: Record<string, unknown>,
  actor?: WorkItemActor
): boolean {
  const row = d.prepare('SELECT kind FROM nodes WHERE id = ?').get(id) as
    | { kind: string }
    | undefined

  if (row?.kind === 'task') {
    // A desk task, reclassified from the Tasks widget.
    //
    // Same boundary as setWorkItemStateCore: a task filed ON a desk, never a
    // desk itself (a desk is kind='task' too, and a desk has no queue).
    const parent = d
      .prepare('SELECT p.kind AS kind FROM nodes n JOIN nodes p ON p.id = n.parent_id WHERE n.id = ?')
      .get(id) as { kind: string } | undefined
    if (parent?.kind !== 'task') return false

    // ONLY the queue. The rest of the work-item manifest -- work_item_state,
    // groupId, wiUrgency, approvalState -- is a machine a task does not run:
    // its `status` is the truth, and stamping a second state onto it is the
    // drifting copy the tasks/Attention unification exists to prevent.
    const canonical =
      patch.intentClass === undefined ? undefined : canonicalIntentClass(patch.intentClass)
    if (patch.intentClass !== undefined && !canonical) return false
    if (canonical === undefined) return false
    d.prepare('UPDATE nodes SET intent_class = ?, updated_at = ? WHERE id = ?').run(
      canonical,
      Date.now(),
      id
    )
    logActor('reclassify', id, actor)
    return true
  }

  if (row?.kind !== 'work_item') return false
  if (patch.intentClass !== undefined) {
    // Only the eight primaries land in intent_class; legacy values map
    // forward, garbage is a refusal (not the silent store it used to be).
    const canonical = canonicalIntentClass(patch.intentClass)
    if (!canonical) return false
    patch = { ...patch, intentClass: canonical }
  }
  if (patch.groupId !== undefined && patch.groupId !== null) {
    // DEC-048 — nesting is real (supersedes DEC-035's one-level flattening),
    // capped at MAX_GROUP_DEPTH levels and enforced HERE, not only in the UI:
    // whatever writes group_id (a drag, an agent, a peer's sync arrival
    // replayed through this path) meets the same wall. Grouping under a child
    // now genuinely nests under that child.
    const parentId = String(patch.groupId)
    if (parentId === id) return false // never its own parent
    const parentRow = d.prepare('SELECT kind FROM nodes WHERE id = ?').get(parentId) as
      | { kind: string }
      | undefined
    if (parentRow?.kind !== 'work_item') return false
    // Walk UP from the new parent: its level, refusing a cycle (the walk
    // reaching the item being grouped) and any over-deep legacy chain.
    const up = d.prepare(`SELECT group_id FROM nodes WHERE id = ? AND kind = 'work_item'`)
    const seen = new Set<string>([id])
    let level = 1
    let cursor: string | null = parentId
    while (cursor) {
      if (seen.has(cursor)) return false // would close a cycle
      seen.add(cursor)
      const r = up.get(cursor) as { group_id: string | null } | undefined
      const next = r?.group_id && r.group_id !== cursor ? r.group_id : null
      if (!next) break
      level++
      cursor = next
      if (level >= MAX_GROUP_DEPTH) return false // parent already at the floor
    }
    // Walk DOWN from the item: its own subtree rides along, so the deepest
    // resulting level is parent-level + subtree-height.
    const kidsOf = d.prepare(
      `SELECT id FROM nodes WHERE kind = 'work_item' AND group_id = ? AND id != ?`
    )
    const height = (nodeId: string, depth: number): number => {
      if (depth >= MAX_GROUP_DEPTH) return depth
      let h = depth
      for (const k of kidsOf.all(nodeId, nodeId) as Array<{ id: string }>)
        h = Math.max(h, height(k.id, depth + 1))
      return h
    }
    if (level + height(id, 1) > MAX_GROUP_DEPTH) return false
  }
  const sets: string[] = []
  const params: Record<string, unknown> = { id, now: Date.now() }
  for (const [key, col] of Object.entries(PATCHABLE)) {
    if (patch[key] !== undefined) {
      sets.push(`${col} = @${key}`)
      params[key] = patch[key]
    }
  }
  if (!sets.length) return true
  sets.push('updated_at = @now')
  d.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = @id`).run(params)
  logActor('updateFields', id, actor)
  return true
}

/** Reclassify = re-bin the item's intent (it stays active). The terminal
 *  'reclassified' STATE is a separate outcome (an item superseded by its
 *  replacement) and goes through setWorkItemState. */
export function reclassifyWorkItemCore(d: LifecycleDb, id: string, intentClass: string): boolean {
  return updateWorkItemFieldsCore(d, id, { intentClass })
}

export function snoozeWorkItemCore(d: LifecycleDb, id: string, until: number | null): void {
  d.prepare(
    `INSERT INTO wi_local (item_id, snooze_until) VALUES (?, ?)
     ON CONFLICT(item_id) DO UPDATE SET snooze_until = excluded.snooze_until`
  ).run(id, until)
}

export function markWorkItemReadCore(d: LifecycleDb, id: string): void {
  d.prepare(
    `INSERT INTO wi_local (item_id, read_at) VALUES (?, ?)
     ON CONFLICT(item_id) DO UPDATE SET read_at = excluded.read_at`
  ).run(id, Date.now())
}

export function workItemCountsCore(d: LifecycleDb, orgId: string): Record<string, number> {
  const rows = d
    .prepare(
      `SELECT work_item_state AS state, COUNT(*) AS n FROM nodes
       WHERE kind = 'work_item' AND trashed_at IS NULL AND org_id = ?
       GROUP BY work_item_state`
    )
    .all(orgId) as Array<{ state: string | null; n: number }>
  const out: Record<string, number> = {}
  for (const r of rows) out[r.state ?? 'open'] = r.n
  return out
}
