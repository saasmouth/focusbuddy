// The plan a user is ON versus what they can currently DO.
//
// Conflating the two produced both of the reported bugs. An active trial lifts
// effectiveTier to 'team' for EVERY account, so:
//
//   labelling from effectiveTier told a paying Pro subscriber they were on
//   Team, and told a free trialist exactly the same thing;
//
//   the upgrade card checked no tier at all, and is rendered unconditionally by
//   the sidebar, the PlexiOffice shell and every segment shell, so paying
//   subscribers were asked to upgrade to Pro on every screen, forever.
import { describe, expect, it } from 'vitest'
import { planLabel, showsProUpsell, trialSuffix } from '../../src/renderer/src/lib/planDisplay'

const on = (daysLeft: number): { active: boolean; daysLeft: number } => ({ active: true, daysLeft })
const off = { active: false, daysLeft: 0 }

describe('planLabel', () => {
  it('names the plan the account is on', () => {
    expect(planLabel('free')).toBe('Free')
    expect(planLabel('pro')).toBe('Pro')
    expect(planLabel('team')).toBe('Team')
  })

  it('does not take its name from the trial', () => {
    // The reported bug: a Pro subscriber mid-trial saw "Team plan". The label
    // takes storedTier, so a trial cannot rename the plan whatever it grants.
    expect(planLabel('pro')).toBe('Pro')
    expect(planLabel('free')).toBe('Free')
  })
})

describe('trialSuffix', () => {
  it('states the trial alongside the plan rather than instead of it', () => {
    expect(`${planLabel('pro')} plan${trialSuffix(on(12))}`).toBe('Pro plan · trial, 12d left')
    expect(`${planLabel('free')} plan${trialSuffix(on(1))}`).toBe('Free plan · trial, 1d left')
  })

  it('says nothing when no trial is running', () => {
    expect(trialSuffix(off)).toBe('')
    expect(`${planLabel('team')} plan${trialSuffix(off)}`).toBe('Team plan')
  })
})

describe('showsProUpsell', () => {
  it('is hidden from anyone already paying', () => {
    expect(showsProUpsell('pro')).toBe(false)
    // A Team subscriber being sold Pro is the same defect as a Pro subscriber
    // being sold Pro.
    expect(showsProUpsell('team')).toBe(false)
  })

  it('is shown to free accounts', () => {
    expect(showsProUpsell('free')).toBe(true)
  })

  it('still reaches someone on a trial, who is exactly the audience for it', () => {
    // A trial lifts effectiveTier to 'team'. Deciding from that would hide the
    // upsell from every trialist — the people it exists to convert. storedTier
    // is still 'free' for them, so they still see it.
    const storedTierWhileTrialling = 'free'
    expect(showsProUpsell(storedTierWhileTrialling)).toBe(true)
  })

  it('never depends on the trial state, only on what was bought', () => {
    for (const trial of [on(30), on(1), off]) {
      expect(showsProUpsell('pro'), JSON.stringify(trial)).toBe(false)
      expect(showsProUpsell('free'), JSON.stringify(trial)).toBe(true)
    }
  })
})
