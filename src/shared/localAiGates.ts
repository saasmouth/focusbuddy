// Measured local-model quality gates, per app feature, copied from
// tools/local-ai-eval/results/gates.json — which tools/local-ai-eval/report.mjs
// computes from the raw run files in the same directory. The numbers are the
// share of eval tasks that passed (deterministic checks AND a judge score of
// 4-5/5) on the chosen on-device model and on the cloud reference.
//
// tests/unit/localAiGates.test.ts fails if this table and gates.json disagree,
// so the gates the app enforces are always the gates that were measured.
//
// Rule (report.mjs): ok if local >= 0.85 x cloud; labelled if >= 0.50 x cloud;
// otherwise, or when not measured, cloud-only.

import type { AiFeature, LocalGate, LocalGateInfo } from './localAi'
import { featureForPurpose } from './localAi'

/** The run these numbers come from (a label in tools/local-ai-eval/results). */
export const GATES_SOURCE: { chosen: string; reference: string } = { chosen: 'qwen3-4b-2507-q4km-shipped', reference: 'cloud-claude' }

export const MEASURED: Record<AiFeature, { local: number | null; cloud: number | null; gate: LocalGate }> = {
  assistant: { local: 0.792, cloud: 0.917, gate: 'ok' },
  build: { local: 0.333, cloud: 1, gate: 'cloud-only' },
  office: { local: 0.667, cloud: 0.444, gate: 'ok' },
  writing: { local: 0.375, cloud: 0.625, gate: 'labelled' },
  summaries: { local: 0.5, cloud: 1, gate: 'labelled' },
  background: { local: 1, cloud: 1, gate: 'ok' },
  agents: { local: null, cloud: null, gate: 'cloud-only' },
  media: { local: null, cloud: null, gate: 'cloud-only' }
}

export function localGateFor(purpose: string): LocalGateInfo {
  const feature = featureForPurpose(purpose)
  const m = MEASURED[feature]
  return { gate: m.gate, localPassRate: m.local, cloudPassRate: m.cloud, family: feature }
}
