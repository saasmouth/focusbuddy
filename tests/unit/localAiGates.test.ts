// @vitest-environment node
// The quality gates the app enforces must be the ones the eval measured.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEASURED, GATES_SOURCE, localGateFor } from '../../src/shared/localAiGates'
import { AI_FEATURES, PURPOSE_FEATURE } from '../../src/shared/localAi'

const gates = JSON.parse(readFileSync(join(__dirname, '../../tools/local-ai-eval/results/gates.json'), 'utf8')) as {
  chosen: string
  reference: string
  features: Record<string, { local: number | null; cloud: number | null; gate: string }>
}

describe('local AI quality gates', () => {
  it('come from the chosen run in gates.json', () => {
    expect(GATES_SOURCE).toEqual({ chosen: gates.chosen, reference: gates.reference })
  })

  it('match gates.json feature by feature', () => {
    for (const f of AI_FEATURES) {
      expect(MEASURED[f], f).toEqual({ local: gates.features[f].local, cloud: gates.features[f].cloud, gate: gates.features[f].gate })
    }
  })

  it('follow the documented rule (ok >= 0.85x cloud, labelled >= 0.5x, else cloud-only)', () => {
    for (const f of AI_FEATURES) {
      const { local, cloud, gate } = MEASURED[f]
      const want = local === null || !cloud ? 'cloud-only' : local >= 0.85 * cloud ? 'ok' : local >= 0.5 * cloud ? 'labelled' : 'cloud-only'
      expect(gate, f).toBe(want)
    }
  })

  it('cover every AI purpose through its feature', () => {
    for (const purpose of Object.keys(PURPOSE_FEATURE)) {
      const g = localGateFor(purpose)
      expect(['ok', 'labelled', 'cloud-only']).toContain(g.gate)
      expect(g.family).toBe(PURPOSE_FEATURE[purpose as keyof typeof PURPOSE_FEATURE])
    }
  })
})
