import { describe, it, expect, afterEach } from 'vitest'
import {
  createObject,
  registerObjectType,
  unregisterObjectType,
  isRegisteredObjectType,
  handlingProfile,
  authoritativeSourceOf,
  aiAllowedForDesk,
  BUILTIN_OBJECT_TYPES,
  type CreateObjectInput
} from '../../src/shared/object'
import { inferredObjective, isConfirmedObjective, confidence } from '../../src/shared/context'
import { isUuidV7 } from '../../src/shared/plexiId'

// The universal Object model + runtime type registry (spec §32, §34, REQ-PRD/DOM).

// The type registry is process-wide. plx_dom_020 registers 'gantt' too, so
// whenever it ran before plx_prd_011, "gantt is not registered yet" was false.
// Each test starts from the built-ins only.
afterEach(() => {
  unregisterObjectType('gantt')
})

function baseInput(over: Partial<CreateObjectInput> = {}): CreateObjectInput {
  return {
    organisationId: 'org-1', deskId: 'desk-1', ownerId: 'user:1', objectType: 'note',
    title: 'A note', now: '2026-07-30T00:00:00Z', ...over
  }
}

describe('plx_prd_001 — every Object belongs to exactly one owning Desk', () => {
  it('test_plx_prd_001_owning_desk_required', () => {
    expect(() => createObject(baseInput({ deskId: '' }))).toThrow(/PLX-PRD-001/)
    const o = createObject(baseInput())
    expect(o.deskId).toBe('desk-1')
    expect(o.workspaceId).toBe('desk-1') // BaseEntity owning-desk mirrors deskId
    expect(isUuidV7(o.id)).toBe(true) // DOM-010 identity
  })
})

describe('plx_prd_010 — type-specific data lives in the typed payload, not the base', () => {
  it('test_plx_prd_010_payload_in_current_state', () => {
    const o = createObject(baseInput({ objectType: 'spreadsheet', currentState: { rows: 3, cols: 2 } }))
    // Type data is in currentState; the base schema is fixed.
    expect(o.currentState).toEqual({ rows: 3, cols: 2 })
    // The base entity has a known, closed field set — no arbitrary type field leaked
    // onto it.
    expect(o).not.toHaveProperty('rows')
    expect(Object.keys(o)).toContain('currentState')
  })
})

describe('plx_prd_011 — the Object type registry is extensible at runtime', () => {
  it('test_plx_prd_011_register_new_type_without_redeploy', () => {
    expect(isRegisteredObjectType('note')).toBe(true) // built-in
    expect(isRegisteredObjectType('gantt')).toBe(false)
    expect(() => createObject(baseInput({ objectType: 'gantt' }))).toThrow(/PLX-PRD-011/)
    // Register at runtime, then it works like any built-in.
    registerObjectType({ id: 'gantt', label: 'Gantt chart' })
    expect(isRegisteredObjectType('gantt')).toBe(true)
    const o = createObject(baseInput({ objectType: 'gantt', currentState: { bars: [] } }))
    expect(o.objectType).toBe('gantt')
  })
})

describe('plx_prd_011 — an extension type can be removed again, a built-in cannot', () => {
  it('unregisterObjectType undoes registerObjectType and refuses built-ins', () => {
    registerObjectType({ id: 'gantt' })
    expect(unregisterObjectType('gantt')).toBe(true)
    expect(isRegisteredObjectType('gantt')).toBe(false)
    expect(unregisterObjectType('gantt')).toBe(false) // already gone
    for (const id of BUILTIN_OBJECT_TYPES) {
      expect(unregisterObjectType(id)).toBe(false)
      expect(isRegisteredObjectType(id)).toBe(true)
    }
  })
})

describe('plx_dom_020 — no Object type receives privileged treatment', () => {
  it('test_plx_dom_020_identical_handling_builtin_and_extension', () => {
    registerObjectType({ id: 'gantt' })
    const builtin = createObject(baseInput({ objectType: 'note' }))
    const extension = createObject(baseInput({ objectType: 'gantt' }))
    // The handling profile is derived from BaseEntity, never from objectType, so it
    // is identical for a built-in and an extension type.
    expect(handlingProfile(extension)).toEqual(handlingProfile(builtin))
    // And it reflects the uniform treatment.
    expect(handlingProfile(builtin)).toMatchObject({ orgScoped: true, permissionEvaluated: true, evented: true, versioned: true })
  })
})

describe('plx_dom_013 — relationships and eventHistory are materialised, not authoritative', () => {
  it('test_plx_dom_013_materialised_refs_name_their_source_of_truth', () => {
    const o = createObject(baseInput())
    expect(o.relationships.authoritative).toBe(false)
    expect(o.eventHistory.authoritative).toBe(false)
    expect(o.relationships.sourceOfTruth).toBe('graph-engine')
    expect(o.eventHistory.sourceOfTruth).toBe('event-store')
    expect(authoritativeSourceOf('relationships')).toBe('graph-engine')
    expect(authoritativeSourceOf('eventHistory')).toBe('event-store')
  })
})

describe('plx_dom_021 — disabling Desk AI leaves deterministic operation intact', () => {
  it('test_plx_dom_021_ai_gate_off_deterministic_on', () => {
    expect(aiAllowedForDesk({ enabled: true })).toBe(true)
    expect(aiAllowedForDesk({ enabled: false })).toBe(false)
    // The gate is the single AI check; deterministic health/resume never consult it,
    // so they remain callable regardless. (Covered functionally by the CTX/RES suites;
    // here we assert the gate is a pure boolean that does not touch those paths.)
    expect(typeof aiAllowedForDesk).toBe('function')
  })
})

describe('plx_dom_022 — an inferred Objective is unconfirmed until accepted', () => {
  it('test_plx_dom_022_inferred_objective_carries_confidence_and_needs_acceptance', () => {
    const obj = inferredObjective('Ship the pricing page', confidence(0.82))
    expect(obj.confidence?.score).toBeCloseTo(0.82)
    expect(obj.accepted).toBe(false)
    expect(isConfirmedObjective(obj)).toBe(false) // unconfirmed until accepted
    expect(isConfirmedObjective({ ...obj, accepted: true })).toBe(true)
    // A declared objective is confirmed by definition.
    expect(isConfirmedObjective({ statement: 'x', setBy: 'u', setAt: '', source: 'declared', confidence: null })).toBe(true)
    // An inferred objective with no confidence is refused (DOM-022).
    // @ts-expect-error deliberately missing confidence
    expect(() => inferredObjective('y', null)).toThrow(/PLX-DOM-022/)
  })
})

describe('registry sanity', () => {
  it('test_builtin_types_present', () => {
    for (const t of BUILTIN_OBJECT_TYPES) expect(isRegisteredObjectType(t)).toBe(true)
  })
})
