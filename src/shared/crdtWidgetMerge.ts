// WS01 sync substrate — the widget data model expressed in CRDT terms.
//
// This is the pure, dependency-free core the client sync engine (lib/crdtSync.ts)
// and the convergence test both run, so what ships is exactly what is proven. Every
// mutation to a widget becomes a ChangeEvent in the append-only change log. Two
// field families are modelled here, matching the WS01 first slice:
//
//   - geometry (position + size) is a last-write-wins register. Two people dragging
//     the same widget converge on one place deterministically, and no other edit is
//     lost (SYN-003).
//   - section membership is an observed-remove set, so a concurrent "add to section"
//     and "remove from section" converge without a lost member (SYN-001).
//
// Folding a widget's whole event list is order-independent: the same events in any
// delivery order (or with duplicates, after an offline reconnect) yield the same
// state. That property is the convergence guarantee, and the test asserts it.

import { lwwMerge, type LWWRegister } from './crdt'

export interface WidgetGeom {
  x: number
  y: number
  width: number
  height: number
}

// Fields across all migrated types: widget geometry ('geom') + membership
// ('members'), node 'title' + 'parent', row 'cell', timeblock 'start'/'duration'/
// 'status' (+ shared 'title'), and file 'name' (+ shared 'parent'). New types add
// their fields here as they migrate, keeping ChangeEvent one shape on the wire.
export type CrdtField =
  | 'geom'
  | 'members'
  | 'title'
  | 'parent'
  | 'cell'
  | 'start'
  | 'duration'
  | 'status'
  | 'name'
  | 'content'
  | 'color'
  // Stacking / list order as an LWW-per-item register (widget zIndex). Node/row
  // ordering rides the generic 'attr' path as attr 'sortOrder'.
  | 'order'
  // A generic per-attribute LWW register: the attribute name lives in the payload
  // (like a row 'cell' carries its column), so a type's many scalar fields sync
  // without each needing its own field in this union. Used for node/timeblock/etc.
  // scalar attributes (status, priority, dueDate, …).
  | 'attr'
  // Object lifecycle: 'create' carries the full initial snapshot so the object can
  // be materialised on another device; 'delete' is a tombstone (a soft delete into
  // the trash); 'restore' brings that same id back out of the trash. A late create
  // never undoes a delete (ids are unique per creation), but Undo and the trash DO
  // bring a deleted id back, and until 4.3.51 that emitted nothing, so the log still
  // ended "delete" and replaying it re-deleted live desks (2026-11-19). Clients
  // before 4.3.51 ignore 'restore'; the poll still brings them the restored row.
  | 'create'
  | 'delete'
  | 'restore'
// 'register' is the LWW class used for geometry and node scalar fields; 'set' is the
// OR-Set class used for membership. Both are deterministic — neither ever surfaces a
// manual conflict.
export type CrdtDataClass = 'register' | 'set'

export interface ChangeEvent {
  id: string // client-generated UUIDv7, never renumbered (SYN-010)
  ts: string // ISO occurrence time, preserved on ingestion (SYN-011)
  partitionKey: string // the room this object syncs in, e.g. `w:acct:<accountId>`
  // 'folderentry' is a LIVE-folder tree entry (a shared folder/file/doc node),
  // synced in the live folder's own `lfe:folder:<folderId>` room. It reuses the
  // name/parent/create/delete fields exactly like a node, so no new algebra.
  // 'link' is a widget-to-widget connector (a wire): create carries its endpoints,
  // delete tombstones it, and type/verb/enabled ride the generic 'attr' register.
  // It routes with its task node's shared root, so a shared desk's wires converge.
  objectType: 'widget' | 'node' | 'row' | 'table' | 'timeblock' | 'file' | 'document' | 'folderentry' | 'link'
  objectId: string
  field: CrdtField
  dataClass: CrdtDataClass
  actor: string // device/account id — the LWW tiebreak, deterministic
  payload:
    | GeomPayload
    | MembersPayload
    | RegisterPayload
    | CellPayload
    | AttrPayload
    | CreatePayload
    | DeletePayload
  // Server-assigned authoritative sequence, present once the event is on the log.
  // Consumers order catch-up by this, never by wall-clock (SYN-011). Absent on a
  // freshly-minted local event before it has been appended.
  seq?: number
}

// A generic scalar LWW register payload (a node's title or parent). `value` carries
// the field value; `at` is the occurrence time in ms — the register timestamp.
export interface RegisterPayload {
  value: unknown
  at: number
}

// A single cell of a table row, an LWW register keyed by its column. Modelling the
// cell (not the whole row) as the register is what lets two people edit different
// cells of the same row without either edit being lost.
export interface CellPayload {
  column: string
  value: unknown
  at: number
}

// A generic per-attribute LWW register (an object's scalar field). `attr` is the
// field name, so one 'attr' field carries any number of a type's scalar attributes.
export interface AttrPayload {
  attr: string
  value: unknown
  at: number
}

// Fold an object's 'attr' events into one converged LWW register per attribute.
// Pure and order-independent; each attribute folds independently, so cross-field
// edits never contend. Mirrors foldRow for table cells.
export function foldAttrs(events: Iterable<ChangeEvent>): Map<string, LWWRegister<unknown>> {
  const attrs = new Map<string, LWWRegister<unknown>>()
  for (const ev of events) {
    if (ev.field !== 'attr') continue
    const p = ev.payload as AttrPayload
    if (p.at === undefined || typeof p.attr !== 'string') continue
    const reg = registerOf(ev)
    const prior = attrs.get(p.attr) ?? null
    attrs.set(p.attr, prior ? lwwMerge(prior, reg) : reg)
  }
  return attrs
}

// Object lifecycle payloads. `create` carries the full snapshot needed to
// materialise the object on another device (a draft plus its id); `delete` is a
// bare tombstone. `at` is the occurrence time.
export interface CreatePayload {
  snapshot: Record<string, unknown>
  at: number
}
export interface DeletePayload {
  at: number
  // Optional scope for types with a delete scope (e.g. timeblock 'one' | 'series').
  scope?: string
}

export interface LifecycleState {
  // The create snapshot if the object was created and not tombstoned, else null.
  created: Record<string, unknown> | null
  // True once any delete event has been seen (remove-wins, permanent tombstone).
  deleted: boolean
}

// Fold an object's lifecycle (create + delete) events. Remove-wins: any delete
// tombstones the object permanently, so a create can never resurrect it. Pure and
// order-independent — a delete seen before its create still tombstones.
export function foldLifecycle(events: Iterable<ChangeEvent>): LifecycleState {
  let created: Record<string, unknown> | null = null
  let deleted = false
  for (const ev of events) {
    if (ev.field === 'create') {
      const p = ev.payload as CreatePayload
      if (p.snapshot && created === null) created = p.snapshot
    } else if (ev.field === 'delete') {
      deleted = true
    }
  }
  if (deleted) created = null
  return { created, deleted }
}

export interface GeomPayload {
  geom: WidgetGeom
  at: number // occurrence time in ms — the LWW register timestamp
}

export interface MembersPayload {
  op: 'add' | 'remove'
  section: string
  // The OR-Set tags this delta touches. An add introduces one fresh tag; a remove
  // carries the exact tags it tombstones (known at emit time), so replay converges
  // regardless of whether the remove is delivered before or after its add.
  tags: string[]
}

export function isGeomPayload(p: ChangeEvent['payload']): p is GeomPayload {
  return (p as GeomPayload).geom !== undefined
}
export function isMembersPayload(p: ChangeEvent['payload']): p is MembersPayload {
  return (p as MembersPayload).op !== undefined
}
export function isRegisterPayload(p: ChangeEvent['payload']): p is RegisterPayload {
  return (p as RegisterPayload).at !== undefined && 'value' in (p as RegisterPayload)
}

// The LWW register a scalar (node title/parent) event represents.
export function registerOf(ev: ChangeEvent): LWWRegister<unknown> {
  const p = ev.payload as RegisterPayload
  return { value: p.value, timestamp: p.at, actor: ev.actor }
}

// Generic fold for a set of scalar LWW-register fields on one object. Returns the
// converged register per field that has at least one event. Nodes, timeblocks and
// files are all just named scalar registers, so they share this one fold; each
// passes the field names it cares about. Pure and order-independent (each field
// folds by lwwMerge independently).
export function foldRegisterFields(
  events: Iterable<ChangeEvent>,
  fields: ReadonlySet<string>
): Map<string, LWWRegister<unknown>> {
  const regs = new Map<string, LWWRegister<unknown>>()
  for (const ev of events) {
    if (!fields.has(ev.field)) continue
    const p = ev.payload as RegisterPayload
    if (p.at === undefined) continue
    const reg = registerOf(ev)
    const prior = regs.get(ev.field) ?? null
    regs.set(ev.field, prior ? lwwMerge(prior, reg) : reg)
  }
  return regs
}

// The LWW register a single geometry event represents.
export function geomRegisterOf(ev: ChangeEvent): LWWRegister<WidgetGeom> {
  if (!isGeomPayload(ev.payload)) throw new Error('geomRegisterOf: not a geometry event')
  return { value: ev.payload.geom, timestamp: ev.payload.at, actor: ev.actor }
}

export interface WidgetState {
  // The converged geometry register, or null if no geometry event has been seen.
  geom: LWWRegister<WidgetGeom> | null
  // The live section memberships (OR-Set values). Normally zero or one entry; more
  // than one only transiently while a concurrent move is converging.
  sections: string[]
}

// Fold one widget's events into its converged state. Pure and order-independent:
// geometry folds by lwwMerge (commutative up to the deterministic tiebreak), and
// membership folds by unioning add tags and remove tags then taking the live set —
// exactly an OR-Set merge, which is commutative, associative and idempotent.
export function foldWidget(events: Iterable<ChangeEvent>): WidgetState {
  let geom: LWWRegister<WidgetGeom> | null = null
  const adds = new Map<string, string>() // tag -> section
  const removes = new Set<string>()
  for (const ev of events) {
    if (ev.field === 'geom' && isGeomPayload(ev.payload)) {
      const reg = geomRegisterOf(ev)
      geom = geom ? lwwMerge(geom, reg) : reg
    } else if (ev.field === 'members' && isMembersPayload(ev.payload)) {
      const { op, section, tags } = ev.payload
      if (op === 'add') {
        for (const t of tags) adds.set(t, section)
      } else {
        for (const t of tags) removes.add(t)
      }
    }
  }
  const live = new Set<string>()
  for (const [tag, section] of adds) if (!removes.has(tag)) live.add(section)
  return { geom, sections: [...live] }
}

// The single live section for a widget (the app model allows one parent section),
// or null. When a concurrent move leaves two live memberships mid-convergence, the
// tiebreak is deterministic (lowest id) so every replica picks the same one until
// the losing remove propagates.
export function resolvedSection(state: WidgetState): string | null {
  if (state.sections.length === 0) return null
  if (state.sections.length === 1) return state.sections[0]
  return [...state.sections].sort()[0]
}
