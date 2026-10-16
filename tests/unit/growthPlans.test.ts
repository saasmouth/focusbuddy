import { describe, it, expect } from 'vitest'
import { PLANS, planInfo, planIdOf, tierForPlan, priceLabel, aiAllowanceLabel } from '../../src/renderer/src/lib/plans'
import { planLabel, fundedPlanLabel, showsProUpsell } from '../../src/renderer/src/lib/planDisplay'
import { eligiblePlans } from '../../src/renderer/src/components/UpgradePromptModal'
import { planModelNote } from '../../src/renderer/src/components/assistant/ModelPickerChip'

// GROWTH-IMPLEMENTATION.md section 1, the plan table, verbatim. If a price or
// allowance changes, it changes in the spec first and then here.
describe('the plan table matches the growth spec', () => {
  const SPEC = [
    { id: 'free', name: 'Free', monthly: 0, yearly: 0, unit: 'user', aiCreditsMonthly: 100 },
    { id: 'pro', name: 'Pro', monthly: 12, yearly: 120, unit: 'user', aiCreditsMonthly: 800 },
    { id: 'proplus', name: 'Pro+', monthly: 25, yearly: 250, unit: 'user', aiCreditsMonthly: 2500 },
    { id: 'team', name: 'Team', monthly: 15, yearly: 150, unit: 'seat', aiCreditsMonthly: 800 }
  ]
  for (const want of SPEC) {
    it(`${want.name}`, () => {
      const p = planInfo(want.id as never)
      expect({ id: p.id, name: p.name, monthly: p.monthly, yearly: p.yearly, unit: p.unit, aiCreditsMonthly: p.aiCreditsMonthly }).toEqual(want)
    })
  }
  it('yearly is two months free on every paid plan', () => {
    for (const p of PLANS.filter((x) => x.id !== 'free')) expect(p.yearly).toBe(p.monthly * 10)
  })
  it('names managed-AI models per plan', () => {
    expect(planInfo('free').aiModels).toBe('Haiku')
    expect(planInfo('proplus').aiModels).toMatch(/Opus/)
    expect(planInfo('pro').aiModels).not.toMatch(/Opus/)
    expect(planInfo('team').aiModels).not.toMatch(/Opus/)
  })
  it('formats prices and allowances', () => {
    expect(priceLabel(planInfo('pro'), 'month')).toBe('US$12/month')
    expect(priceLabel(planInfo('team'), 'year')).toBe('US$150/year per seat')
    expect(aiAllowanceLabel(planInfo('proplus'))).toBe('2,500 AI credits a month on Haiku, Sonnet and Opus')
    expect(aiAllowanceLabel(planInfo('team'))).toBe('800 AI credits a month per seat, pooled on Haiku and Sonnet')
  })
})

describe('plans and capability tiers', () => {
  it('reads Pro+ as its own plan with Pro\'s feature column', () => {
    expect(planIdOf('proplus')).toBe('proplus')
    expect(tierForPlan('proplus')).toBe('pro')
    expect(tierForPlan('team')).toBe('team')
  })
  it('reads anything unknown as Free', () => {
    expect(planIdOf('enterprise-ish')).toBe('free')
    expect(planIdOf(undefined)).toBe('free')
  })
})

describe('plan labels', () => {
  it('calls Pro+ "Pro+", not "Pro"', () => {
    expect(planLabel('proplus')).toBe('Pro+')
  })
  it('says when the credit bank pays for the plan, and until when', () => {
    const until = new Date(2027, 1, 3).getTime()
    const now = new Date(2026, 9, 16).getTime()
    expect(fundedPlanLabel('pro', until, now)).toMatch(/^Pro \(paid with credit until .*2027\)$/)
    expect(fundedPlanLabel('pro', null, now)).toBe('Pro')
    expect(fundedPlanLabel('pro', now - 1, now)).toBe('Pro')
    expect(fundedPlanLabel('free', until, now)).toBe('Free')
  })
  it('never upsells a Pro+ subscriber', () => {
    expect(showsProUpsell('proplus')).toBe(false)
  })
})

describe('upgrade modal plan choices', () => {
  it('offers every plan that includes Pro, minus the current one', () => {
    expect(eligiblePlans('pro', 'free')).toEqual(['pro', 'proplus', 'team'])
    expect(eligiblePlans('pro', 'pro')).toEqual(['proplus', 'team'])
  })
  it('offers only Pro+ for Opus and only Team for team features', () => {
    expect(eligiblePlans('proplus', 'pro')).toEqual(['proplus'])
    expect(eligiblePlans('team', 'free')).toEqual(['team'])
  })
})

describe('composer model note', () => {
  it('names what managed AI runs on the plan', () => {
    expect(planModelNote('free', 'auto')).toMatch(/Free runs Haiku/)
    expect(planModelNote('pro', 'credits')).toMatch(/Opus is on Pro\+/)
    expect(planModelNote('proplus', 'auto')).toBeNull()
    expect(planModelNote('free', 'byok')).toBeNull()
  })
})
