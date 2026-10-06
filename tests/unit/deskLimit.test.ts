// @vitest-environment node
//
// The free tier's desk allowance.
//
// This was configured as 'Unlimited' on every tier while the creation path
// carried a working limit check and a comment saying it "prevents a 4th free
// desk" — so the intent was three, the code could enforce three, and the
// configuration said unlimited. Nothing failed; the limit simply never fired.
// A number in a config file that contradicts the comment next to the code
// enforcing it is invisible until someone counts desks.

import { describe, expect, it } from 'vitest'
import { canCreateMore, limitFor, limitLabel } from '../../src/renderer/src/lib/gating'
import { CAPABILITY_DEFAULTS } from '../../src/renderer/src/lib/capabilityDefaults'

type Tier = 'free' | 'pro' | 'team'
const capsFor = (tier: Tier): never => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(CAPABILITY_DEFAULTS as Record<string, Record<string, unknown>>)) {
    out[k] = v[tier]
  }
  return out as never
}

describe('desk allowance', () => {
  it('gives the free tier exactly three desks', () => {
    expect(limitFor(capsFor('free'), 'multiple_desks')).toBe(3)
    expect(limitLabel(capsFor('free'), 'multiple_desks')).toBe('3')
  })

  it('allows the first three and refuses the fourth', () => {
    const caps = capsFor('free')
    // Counted as "can I create one more, having N already".
    expect(canCreateMore(caps, 'multiple_desks', 0)).toBe(true)
    expect(canCreateMore(caps, 'multiple_desks', 1)).toBe(true)
    expect(canCreateMore(caps, 'multiple_desks', 2)).toBe(true)
    expect(canCreateMore(caps, 'multiple_desks', 3)).toBe(false)
    expect(canCreateMore(caps, 'multiple_desks', 9)).toBe(false)
  })

  it('leaves paid tiers unlimited', () => {
    for (const tier of ['pro', 'team'] as const) {
      expect(limitFor(capsFor(tier), 'multiple_desks'), tier).toBeNull()
      expect(canCreateMore(capsFor(tier), 'multiple_desks', 500), tier).toBe(true)
    }
  })

  it('still refuses when a server sends a smaller limit', () => {
    // The shipped defaults are a fallback; the entitlement server can override.
    expect(canCreateMore({ multiple_desks: 1 } as never, 'multiple_desks', 1)).toBe(false)
  })
})

describe('the refusal the user actually sees', () => {
  it('names the limit and offers the upgrade', () => {
    // The copy interpolates limitFor(), so a wrong limit would have produced
    // "your Unlimited-desk limit" — which is how you discover the config was
    // never enforcing anything.
    const src = readFileSync(
      join(__dirname, '..', '..', 'src/renderer/src/stores/nodes.ts'),
      'utf8'
    )
    expect(src).toContain('promptUpgrade')
    expect(src).toMatch(/limit on the Free plan\. Upgrade for unlimited desks\./)
    expect(src).toContain('DESK_LIMIT_ERROR')
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
