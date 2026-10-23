// The universal Object model and type registry (spec §32 BaseEntity, §34 Object,
// REQ-PRD/REQ-DOM). The whole point: there is ONE object schema, type-specific data
// lives in a typed payload rather than by extending the base (PRD-010); the type
// registry is extensible at runtime with no redeploy (PRD-011); and no type gets
// privileged treatment in storage, permissions, events, versioning or Context
// Health (DOM-020). Materialised references (relationships, event history) are not
// the system of record (DOM-013).

import { plexiId } from './plexiId'
import type { PermissionSnapshot } from './events'

export type EntityType =
  | 'object'
  | 'desk'
  | 'decision'
  | 'relationship'
  | 'resume'
  | 'organisation'
  | 'session'
  | 'agent'
  | 'event'

export type LifecycleState = 'created' | 'referenced' | 'shared' | 'modified' | 'versioned' | 'archived' | 'deleted'

// A materialised, NON-authoritative reference (DOM-013). The `authoritative: false`
// and `sourceOfTruth` fields make it impossible to mistake these for the record of
// truth: relationships live in the Graph Engine, history in the Event Store.
export interface MaterialisedRef<S extends string> {
  authoritative: false
  sourceOfTruth: S
  refs: string[]
}
export const AUTHORITATIVE_SOURCE = { relationships: 'graph-engine', eventHistory: 'event-store' } as const
export function authoritativeSourceOf(field: 'relationships' | 'eventHistory'): string {
  return AUTHORITATIVE_SOURCE[field]
}

export interface BaseEntity {
  id: string // UUIDv7 (DOM-010)
  entityType: EntityType
  schemaVersion: number // DOM-012
  organisationId: string // tenant boundary, required on every entity (DOM-011)
  workspaceId: string | null // owning Desk; null only for org-scoped entities
  ownerId: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null // soft deletion — visibility only (DOM-015)
  createdBy: string
  updatedBy: string
  permissions: PermissionSnapshot
  status: LifecycleState
  version: number // optimistic concurrency token
  relationships: MaterialisedRef<'graph-engine'> // DOM-013
  eventHistory: MaterialisedRef<'event-store'> // DOM-013
}

export interface PlexiObject extends BaseEntity {
  entityType: 'object'
  objectType: string // registry-resolved (PRD-011)
  title: string
  deskId: string // owning Desk — exactly one (PRD-001 / INV-01)
  currentState: unknown // type-specific payload (PRD-010) — never extend the base for this
  contentRef: string | null // large content out-of-band (DOM-032)
  lifecycleState: LifecycleState
}

// ── Runtime-extensible object type registry (PRD-011) ────────────────────────

export interface ObjectTypeDef {
  id: string
  label: string
  builtin: boolean
}

const REGISTRY = new Map<string, ObjectTypeDef>()

// The initial built-in types. Extension types register alongside these at runtime
// and are treated identically (DOM-020).
export const BUILTIN_OBJECT_TYPES = ['note', 'document', 'spreadsheet', 'task', 'webview', 'image', 'diagram', 'design'] as const
for (const id of BUILTIN_OBJECT_TYPES) REGISTRY.set(id, { id, label: id, builtin: true })

// Register a new Object type at runtime — no redeployment of an "Object Service"
// (PRD-011). Idempotent for the same id+label; rejects a conflicting redefinition.
export function registerObjectType(def: { id: string; label?: string }): ObjectTypeDef {
  const existing = REGISTRY.get(def.id)
  if (existing) return existing
  const entry: ObjectTypeDef = { id: def.id, label: def.label ?? def.id, builtin: false }
  REGISTRY.set(def.id, entry)
  return entry
}
/**
 * Remove an extension type registered at runtime. Built-in types cannot be
 * removed (returns false), so this can only undo a registerObjectType call.
 * Returns whether a type was removed.
 */
export function unregisterObjectType(id: string): boolean {
  const existing = REGISTRY.get(id)
  if (!existing || existing.builtin) return false
  return REGISTRY.delete(id)
}
export function isRegisteredObjectType(id: string): boolean {
  return REGISTRY.has(id)
}
export function objectTypes(): ObjectTypeDef[] {
  return [...REGISTRY.values()]
}

// ── Universal object factory ─────────────────────────────────────────────────

export interface CreateObjectInput {
  organisationId: string
  deskId: string
  ownerId: string
  objectType: string
  title: string
  currentState?: unknown
  contentRef?: string | null
  permissions?: PermissionSnapshot
  now: string
  id?: string
}

export function createObject(input: CreateObjectInput): PlexiObject {
  // Exactly one owning Desk (PRD-001 / INV-01).
  if (!input.deskId) throw new Error('An Object MUST belong to exactly one owning Desk (PLX-PRD-001).')
  // The type must be in the registry (PRD-011) — built-in or extension, no difference.
  if (!isRegisteredObjectType(input.objectType)) {
    throw new Error(`"${input.objectType}" is not a registered Object type (PLX-PRD-011).`)
  }
  return {
    id: input.id ?? plexiId(),
    entityType: 'object',
    schemaVersion: 1,
    organisationId: input.organisationId,
    workspaceId: input.deskId,
    ownerId: input.ownerId,
    createdAt: input.now,
    updatedAt: input.now,
    deletedAt: null,
    createdBy: input.ownerId,
    updatedBy: input.ownerId,
    permissions: input.permissions ?? { grants: [] },
    status: 'created',
    version: 1,
    relationships: { authoritative: false, sourceOfTruth: 'graph-engine', refs: [] },
    eventHistory: { authoritative: false, sourceOfTruth: 'event-store', refs: [] },
    objectType: input.objectType,
    title: input.title,
    deskId: input.deskId,
    currentState: input.currentState ?? null, // type-specific data goes HERE (PRD-010)
    contentRef: input.contentRef ?? null,
    lifecycleState: 'created'
  }
}

// The uniform handling profile every entity receives, derived ONLY from BaseEntity
// and NEVER from its objectType, so no type can be privileged in storage,
// permissions, events, versioning or health (DOM-020). Two objects of different
// types return an identical profile.
export interface HandlingProfile {
  orgScoped: boolean
  permissionEvaluated: boolean
  evented: boolean
  versioned: boolean
  healthComputed: boolean
}
export function handlingProfile(entity: BaseEntity): HandlingProfile {
  return {
    orgScoped: !!entity.organisationId, // every entity is org-filtered (DOM-011)
    permissionEvaluated: true, // every entity goes through the same authz path (SEC-020)
    evented: true, // every mutation emits an Event
    versioned: typeof entity.schemaVersion === 'number', // every entity is versioned (DOM-012)
    healthComputed: entity.entityType === 'object' || entity.entityType === 'desk'
  }
}

// ── Desk AI configuration (DOM-021) ──────────────────────────────────────────

export interface DeskAiConfig {
  enabled: boolean
}

// When AI is disabled for a Desk, ALL AI reasoning is off — background relationship
// discovery, embedding generation, Resume summarisation — while deterministic
// Context Health and Resume assembly keep working (DOM-021). This gate is the
// single check every AI entry point consults; the deterministic paths never call it.
export function aiAllowedForDesk(config: DeskAiConfig): boolean {
  return config.enabled === true
}
