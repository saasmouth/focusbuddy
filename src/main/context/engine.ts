// Context Engine bootstrap (spec §51) — the live wire that binds the deterministic
// brain layer (Event Store, Relationships, Decisions, Context Health) to the real
// application database and the real user actions. Everything here is ADDITIVE and
// DEFENSIVE: emitting an Event or mirroring a Relationship must never break the
// mutation that triggered it. Deterministic first — the product stays fully
// available even if this projection write fails (PLX-ARC-022).

import type Database from 'better-sqlite3'
import { getDb } from '../db/database'
import { getActiveOrgId } from '../db/activeOrg'
import { accountEmail } from '../db/account'
import { createEventStore, ensureEventSchema, type AppendInput, type EventStore, type SqlDb } from '../db/eventStore'
import { createRelationshipStore, type RelationshipStore } from '../db/relationshipStore'
import { createDecisionStore, type DecisionStore } from '../db/decisionStore'
import { graphFromRelationships } from './propagation'
import { buildTransitions } from './contextHealthService'
import type { DecisionAtRisk } from '../../shared/contextHealth'
import type { MaterialityInput, DecisionImpact } from './materiality'
import type { Decision, ActorRef } from '../../shared/decision'
import { plexiId } from '../../shared/plexiId'
import { listAllLinks } from '../db/widgetLinks'
import { deriveHealthSnapshot, ensureReviewSchema, recordReview, reviewPointSeq, type HealthSnapshot } from './health'
import { generateResume } from '../resume/resume'
import { createSummaryCache, type SummaryCache } from '../ai/summaryCache'
import { generateResumeSummaryLive } from '../ai/liveResume'

// better-sqlite3's Database is structurally a SqlDb (exec / prepare→run/get/all /
// transaction). This thin adapter pins the types without copying behaviour.
function asSqlDb(d: Database.Database): SqlDb {
  return {
    exec: (sql) => { d.exec(sql) },
    prepare: (sql) => {
      const s = d.prepare(sql)
      return {
        run: (...a) => s.run(...(a as never[])),
        get: (...a) => s.get(...(a as never[])),
        all: (...a) => s.all(...(a as never[])) as unknown[]
      }
    },
    transaction: <T,>(fn: () => T): (() => T) => d.transaction(fn as () => unknown) as () => T
  }
}

interface Engine {
  events: EventStore
  relationships: RelationshipStore
  decisions: DecisionStore
  db: SqlDb
}

let engine: Engine | null = null

// The local principal for this session. A signed-in user is identified by their
// email; otherwise a stable local principal. Never an agent (PLX-DOM-040 lives in
// the Decision store, but user CRUD is genuinely user-authored here).
// DEC-060 — accountEmail(), never loadAccountState(). This function is on the
// path of EVERY Object Event (emitObjectEvent -> localActor), and
// loadAccountState eagerly decrypts the session token — a synchronous macOS
// Keychain call — to hand back a plaintext field that needed no decrypting.
// That put securityd in the middle of every event emit, and on a boot replay
// the first call raised an authorization prompt that blocked the main thread
// before the window had been shown.
export function localActor(): string {
  const email = accountEmail()
  return email ? `user:${email}` : 'user:local'
}
function localUserId(): string {
  return accountEmail() ?? 'local'
}

export function getContextEngine(): Engine {
  if (engine) return engine
  const db = asSqlDb(getDb())
  ensureEventSchema(db)
  const activeOrg = (): string => getActiveOrgId()
  // Every store is bound to the active organisation (live resolver, tracks the org
  // switcher), so no read can return another tenant's data (PLX-SEC-010/011,
  // GPH-011). ADR-0002.
  const events = createEventStore(db, activeOrg)
  // Event-sourced: each relationship mutation emits a full-snapshot lifecycle Event
  // atomically, so the live graph is a projection rebuildable from the log
  // (PLX-DATA-002/003). ADR-0001/0002.
  const relationships = createRelationshipStore(db, activeOrg, events)
  const decisions = createDecisionStore(db, activeOrg)
  ensureReviewSchema(db)
  engine = { events, relationships, decisions, db }
  return engine
}

// Emit a real Event for a real state change. Swallows failure so the caller's
// mutation is never affected (deterministic-first).
export function emitObjectEvent(input: Omit<AppendInput, 'organisationId' | 'actor'> & { actor?: string; organisationId?: string }): void {
  try {
    const e = getContextEngine()
    e.events.append({
      organisationId: input.organisationId ?? getActiveOrgId(),
      actor: input.actor ?? localActor(),
      ...input
    })
  } catch (err) {
    console.warn('[context-engine] event emit failed (non-fatal):', (err as Error).message)
  }
}

// Mirror a user-created desk relation into the knowledge graph as a CONFIRMED
// RelatedTo edge (the user linked them, so it is confirmed, not provisional —
// PLX-PRD-051). Idempotent against an existing active edge. Non-fatal on failure.
export function mirrorUserRelation(
  a: string,
  b: string,
  correlationId: string,
  excerpt = 'user linked these'
): void {
  if (!a || !b || a === b) return
  try {
    const e = getContextEngine()
    const existing = e.relationships.activeFor(a).some((r) => r.targetEntityId === b || r.sourceEntityId === b)
    if (existing) return
    const org = getActiveOrgId()
    const actor = localUserId()
    const rel = e.relationships.propose({
      organisationId: org,
      sourceEntityId: a,
      targetEntityId: b,
      relationshipType: 'RelatedTo',
      directed: false,
      strength: 0.8,
      confidence: 1,
      evidence: [{ kind: 'event', ref: correlationId, excerpt, weight: 1 }],
      discoveryMethod: 'user',
      correlationId,
      confirmedBy: actor
    })
    // discoveryMethod 'user' + confirmedBy lands it confirmed; belt-and-braces.
    if (rel.state !== 'confirmed') e.relationships.confirm(rel.id, actor)
  } catch (err) {
    console.warn('[context-engine] relation mirror failed (non-fatal):', (err as Error).message)
  }
}

export function unmirrorUserRelation(a: string, b: string): void {
  if (!a || !b) return
  try {
    const e = getContextEngine()
    const actor = localUserId()
    for (const r of e.relationships.activeFor(a)) {
      if (r.targetEntityId === b || r.sourceEntityId === b) e.relationships.reject(r.id, actor)
    }
  } catch (err) {
    console.warn('[context-engine] relation unmirror failed (non-fatal):', (err as Error).message)
  }
}

// One-time-ish backfill: mirror every existing widget link into the relationship
// graph, so connections drawn before links began mirroring still surface as
// related. Idempotent (mirrorUserRelation no-ops on an existing edge) and non-fatal.
export function backfillWidgetLinkRelations(): void {
  try {
    for (const l of listAllLinks()) {
      mirrorUserRelation(l.sourceWidgetId, l.targetWidgetId, l.id, 'user linked these widgets')
    }
  } catch (err) {
    console.warn('[context-engine] widget-link relation backfill failed (non-fatal):', (err as Error).message)
  }
}

// The confirmed neighbours of an Object — "surfaces with relations", read live.
export function relatedObjectIds(objectId: string): string[] {
  try {
    const e = getContextEngine()
    return e.relationships.activeFor(objectId).map((r) => (r.sourceEntityId === objectId ? r.targetEntityId : r.sourceEntityId))
  } catch {
    return []
  }
}

export interface FlagDecisionInput {
  title: string
  decisionStatement?: string
  relatedObjectIds?: string[]
  affectedDeskIds?: string[]
}

// Create a human-owned Decision (PLX-DOM-040) that references the given Objects and
// Desks, so a later material change to a linked Object raises Decision Risk against
// it (the red widget frame / desk decisions-at-risk). The owner is always the local
// human principal; an agent can never own a Decision.
export function createDecision(input: FlagDecisionInput): Decision {
  const e = getContextEngine()
  const email = accountEmail()
  const owner: ActorRef = { kind: 'user', id: localUserId(), displayName: email ?? undefined }
  return e.decisions.create({
    organisationId: getActiveOrgId() || 'local',
    title: input.title,
    decisionStatement: input.decisionStatement?.trim() || input.title,
    decisionOwner: owner,
    relatedObjectIds: input.relatedObjectIds ?? [],
    affectedDeskIds: input.affectedDeskIds ?? [],
    correlationId: plexiId()
  })
}

// Cancel a Decision (supersede with no successor), so it no longer puts any Object
// at risk. Used to undo a "flag as a decision". Human actor, emits DecisionSuperseded.
export function cancelDecision(id: string): void {
  const e = getContextEngine()
  const email = accountEmail()
  const owner: ActorRef = { kind: 'user', id: localUserId(), displayName: email ?? undefined }
  e.decisions.supersede(id, null, owner, e.events, new Date().toISOString())
}

// All Decisions for the active org (live + superseded), newest-first as stored.
export function listDecisions(): Decision[] {
  try {
    return getContextEngine().decisions.all()
  } catch {
    return []
  }
}

// Live Decisions that reference an Object — what puts that Object at decision risk.
export function decisionsForObject(objectId: string): Decision[] {
  return listDecisions().filter(
    (d) => d.state !== 'superseded' && d.state !== 'cancelled' && d.relatedObjectIds.includes(objectId)
  )
}

// Whether any live Decision references this Object, expressed as a materiality
// DecisionImpact. Used so a change to an Object a Decision depends on scores as
// material and can escalate to decision-risk (Context Health state machine).
export function decisionImpactForObject(objectId: string): DecisionImpact {
  try {
    const e = getContextEngine()
    const referenced = e.decisions
      .all()
      .some((d) => d.state !== 'superseded' && d.state !== 'cancelled' && d.relatedObjectIds.includes(objectId))
    return referenced ? 'high' : 'none'
  } catch {
    return 'none'
  }
}

export type { HealthSnapshot }

// Honest per-(user, Object) Context Health, delegating the derivation to the pure
// (testable) health module. Decisions referencing the object become the named
// risks so a Decision Risk state always identifies its Decision (PLX-UX-025).
export function healthFor(objectId: string, materialityInput: MaterialityInput): HealthSnapshot {
  const e = getContextEngine()
  const decisionsAtRisk: DecisionAtRisk[] = e.decisions
    .all()
    .filter((d) => d.state !== 'superseded' && d.state !== 'cancelled' && d.relatedObjectIds.includes(objectId))
    .map((d) => ({ decisionId: d.id, title: d.title, invalidatingChange: 'a linked object changed since your last review' }))
  // Confirmed neighbours feed the signal so a change to a related desk raises this
  // desk's health (PLX-UX-022).
  const related = relatedObjectIds(objectId)
  return deriveHealthSnapshot(e.db, localUserId(), objectId, materialityInput, decisionsAtRisk, related)
}

// Live catch-up Resume for a desk: build the deterministic Resume since the user's
// last review, then add a real AI summary through the seam if a key is present. The
// deterministic Resume always comes back; the AI summary is additive and degrades to
// nothing without a key (ARC-022). This is the live surface the UI/tester can call.
let summaryCache: SummaryCache | null = null
export async function liveResumeForDesk(
  deskId: string
): Promise<{ summary: string; aiSummary: string | null; degraded: boolean; cacheHit: boolean; changedEventCount: number }> {
  const e = getContextEngine()
  if (!summaryCache) summaryCache = createSummaryCache(e.db)
  const userId = localUserId()
  const since = reviewPointSeq(e.db, userId, deskId)
  const objectIds = [deskId, ...relatedObjectIds(deskId)]
  const resume = generateResume(e.db, { deskId, forUserId: userId, objectIds, sinceCursor: since })
  const r = await generateResumeSummaryLive(resume, { cache: summaryCache, now: new Date().toISOString() })
  return {
    summary: r.resume.summary,
    aiSummary: r.resume.aiSummary,
    degraded: r.degraded,
    cacheHit: r.cacheHit,
    changedEventCount: resume.sourceEventIds.length
  }
}

// Record that the user has reviewed an Object now — resets Context Health to
// `current` from this point forward (PLX-UX-020).
export function markReviewed(objectId: string): void {
  try {
    const e = getContextEngine()
    recordReview(e.db, localUserId(), objectId, new Date().toISOString())
  } catch (err) {
    console.warn('[context-engine] markReviewed failed (non-fatal):', (err as Error).message)
  }
}

// Re-export the propagation helper for callers that want a full transition set.
export { graphFromRelationships, buildTransitions }
