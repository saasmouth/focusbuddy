// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { memSqlDb } from './_memdb'
import { createRelationshipStore, type ProposeInput } from '../../src/main/db/relationshipStore'
import {
  contextSurvivesAppRemoval,
  contextIsAppIndependent,
  exportPortable,
  isPortableExport,
  contextReadableWithoutAI
} from '../../src/shared/principles'
import { assertMeetingConsent, meetingConsentEvent, extractMeetingItem, edgeDisplay } from '../../src/main/apps/appContracts'
import {
  changeAllowedByPhilosophy1,
  featureDone,
  milestoneReady,
  unresolvedForeclosing,
  registerServiceContract,
  serviceContractComplete,
  assertRegulatoryRecord
} from '../../src/main/meta/governance'
import { statesDistinguishableWithoutColour, healthPresentation, HEALTH_PRESENTATION } from '../../src/shared/healthPresentation'
import { presenceWithinRetention, presenceExpired, PRESENCE_KEPT_IN_EVENT_STORE } from '../../src/shared/permissionPropagation'
import { CAPTURE_MODE } from '../../src/main/context/workspaceMemory'
import { assertRecommendationValid } from '../../src/main/ai/orchestrator'
import { evidenceFor } from '../../src/shared/resumeCard'
import type { Principal } from '../../src/shared/permission'

// Design principles, native-app contracts, governance, accessibility, presence.

// DEC-144: Attention was renamed Focus and its items are "tasks"; these pins follow the new words.
describe('plx_prin_001 — no manual action to preserve one own context', () => {
  it('test_plx_prin_001_automatic_capture', () => {
    expect(CAPTURE_MODE).toBe('automatic')
  })
})

describe('plx_prin_002 — context preserved independently of the producing app', () => {
  it('test_plx_prin_002_survives_app_removal', () => {
    const events = [{ id: 'e1', source: 'app-A' }, { id: 'e2', source: 'app-B' }]
    expect(contextSurvivesAppRemoval(events, 'app-A')).toHaveLength(2) // nothing lost
    expect(contextIsAppIndependent()).toBe(true)
  })
})

describe('plx_prin_004 — vendor-neutral, self-describing export', () => {
  it('test_plx_prin_004_portable_export', () => {
    const exp = exportPortable({ objects: [{ id: 'o' }], events: [{ id: 'e' }] }, '2026-07-30T00:00:00Z')
    expect(isPortableExport(exp)).toBe(true)
    expect(exp.format).toBe('plexi-portable-export')
    expect(exp.version).toBeGreaterThan(0) // versioned + self-describing
    expect(exp.entities.objects).toHaveLength(1)
  })
})

describe('plx_prin_005 — durability not contingent on any AI model', () => {
  it('test_plx_prin_005_readable_without_ai', () => {
    expect(contextReadableWithoutAI()).toBe(true)
  })
})

describe('plx_prin_007 / plx_prin_008 — evidence + traceability', () => {
  it('test_plx_prin_007_ai_rec_has_evidence', () => {
    expect(() => assertRecommendationValid({ text: 'x', evidenceEventIds: [], confidence: 0.9 })).toThrow(/PLX-AI-040/)
  })
  it('test_plx_prin_008_inference_traceable_to_events', () => {
    expect(evidenceFor({ assertion: 'inferred link', evidenceEventIds: ['e1'] })).toEqual(['e1'])
    expect(() => evidenceFor({ assertion: 'ungrounded', evidenceEventIds: [] })).toThrow(/PLX-UX-015/)
  })
})

describe('plx_app_030 / plx_app_031 — meeting consent and provisional extraction', () => {
  it('test_plx_app_030_consent_required', () => {
    const ps = [{ id: 'a', consented: true }, { id: 'b', consented: false }]
    expect(() => assertMeetingConsent(ps)).toThrow(/PLX-APP-030/)
    const ok = [{ id: 'a', consented: true }, { id: 'b', consented: true }]
    expect(meetingConsentEvent('org', 'u', 'm1', ok).eventType).toBe('MeetingConsentRecorded')
  })
  it('test_plx_app_031_extraction_provisional', () => {
    const item = extractMeetingItem('decision', 'Ship Friday')
    expect(item.state).toBe('provisional')
    expect(item.requiresConfirmation).toBe(true)
  })
})

describe('plx_app_040 / plx_app_041 — Relationship Explorer', () => {
  const principal: Principal = { id: 'u', organisationId: 'org' }
  it('test_plx_app_040_permission_filtered_traversal', () => {
    const rs = createRelationshipStore(memSqlDb(), 'org')
    const mk = (t: string, ref: string): ProposeInput => ({ organisationId: 'org', sourceEntityId: 'A', targetEntityId: t, relationshipType: 'RelatedTo', confidence: 1, evidence: [{ kind: 'event', ref, excerpt: null, weight: 1 }], discoveryMethod: 'user', correlationId: 'c', confirmedBy: 'u' })
    for (const [t, ref] of [['B', 'e1'], ['SECRET', 'e2']] as const) rs.confirm(rs.propose(mk(t, ref)).id, 'u')
    const visible = rs.activeForPrincipal('A', principal, (id) => id !== 'SECRET')
    expect(visible.map((r) => r.targetEntityId)).toEqual(['B']) // SECRET omitted, no leak
  })
  it('test_plx_app_041_edge_display_fields', () => {
    const d = edgeDisplay({ evidence: [{ kind: 'event', ref: 'e1' }], confidence: 0.8, discoveryMethod: 'ai', state: 'provisional' })
    expect(d).toMatchObject({ confidence: 0.8, discoveryMethod: 'ai', state: 'provisional' })
    expect(() => edgeDisplay({ evidence: [], confidence: 0.8, discoveryMethod: 'ai', state: 'provisional' })).toThrow(/PLX-APP-041/)
  })
})

describe('plx_eng_010 / plx_eng_020 / plx_eng_030 — governance gates', () => {
  it('test_plx_eng_010_philosophy1', () => {
    expect(changeAllowedByPhilosophy1({ functionalityDelta: 1, contextAccuracyDelta: 0 })).toBe(true)
    expect(changeAllowedByPhilosophy1({ functionalityDelta: 1, contextAccuracyDelta: -0.2 })).toBe(false) // more features, worse context
  })
  it('test_plx_eng_020_dod_gate', () => {
    expect(featureDone([{ name: 'tests', met: true }, { name: 'a11y', met: true }])).toBe(true)
    expect(featureDone([{ name: 'tests', met: true }, { name: 'a11y', met: false }])).toBe(false)
    expect(featureDone([{ name: 'a11y', met: false }], [{ gate: 'a11y', owner: 'u', remediationDate: '2026-08-30' }])).toBe(true) // accepted risk
  })
  it('test_plx_eng_030_milestone_needs_adrs', () => {
    expect(milestoneReady([{ id: 'RSK-01', resolvedByAdr: 'ADR-0003' }])).toBe(true)
    expect(milestoneReady([{ id: 'RSK-08', resolvedByAdr: null }])).toBe(false)
    expect(unresolvedForeclosing([{ id: 'RSK-08', resolvedByAdr: null }])).toEqual(['RSK-08'])
  })
})

describe('plx_arc_020 — services publish API + Event contracts', () => {
  it('test_plx_arc_020_contract_complete', () => {
    registerServiceContract({ service: 'event-service', apiContract: 'openapi:events', eventContract: 'asyncapi:events', version: '1.0' })
    expect(serviceContractComplete('event-service')).toBe(true)
    registerServiceContract({ service: 'half', apiContract: 'openapi:half', eventContract: null, version: '1.0' })
    expect(serviceContractComplete('half')).toBe(false) // missing Event contract
  })
})

describe('plx_ai_045 — per-capability regulatory record', () => {
  it('test_plx_ai_045_record_required_fields', () => {
    expect(() => assertRegulatoryRecord({ capability: 'resume-summary', jurisdiction: 'AU', modelIdentity: 'sonnet-5', purpose: 'summarise', humanOversight: 'user-reviewed' })).not.toThrow()
    expect(() => assertRegulatoryRecord({ capability: 'x' })).toThrow(/PLX-AI-045/)
  })
})

describe('plx_a11y_004 — health states distinguishable without colour', () => {
  it('test_plx_a11y_004_shape_and_text', () => {
    expect(statesDistinguishableWithoutColour()).toBe(true) // distinct icon + label per state
    expect(healthPresentation('attention-required').icon).toBe('priority_high')
    expect(healthPresentation('attention-required').label).toBe('Needs attention') // DEC-144: 'Attention' now names the Focus page's old name; the health state says what it means
    // no two states share an icon or a label
    const icons = Object.values(HEALTH_PRESENTATION).map((p) => p.icon)
    expect(new Set(icons).size).toBe(icons.length)
  })
})

describe('plx_ux_072 — presence is personal data with bounded retention', () => {
  it('test_plx_ux_072_retention_and_not_permanent', () => {
    expect(PRESENCE_KEPT_IN_EVENT_STORE).toBe(false) // not permanent Event-Store memory
    expect(presenceWithinRetention(10, 30)).toBe(true)
    expect(presenceExpired(45, 30)).toBe(true)
  })
})
