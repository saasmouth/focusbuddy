import type { TierId } from './capabilityDefaults'
import { planInfo, type PlanId } from './plans'

// What plan a user is ON versus what they can currently DO.
//
// These are two different questions and the app answered them with the same
// value, which produced two bugs at once:
//
//   The settings panel labelled the plan from effectiveTier. An ACTIVE TRIAL
//   lifts effectiveTier to 'team' for everyone (see resolveForAccount on the
//   server), so a paying Pro subscriber was told they were on Team, and a free
//   trialist was told the same.
//
//   The upgrade card checked nothing at all. It is rendered unconditionally by
//   the sidebar, the PlexiOffice shell and every segment shell, so paying Pro
//   and Team subscribers were asked to upgrade to Pro on every screen, forever.
//
// The rule, in one place so it stops being re-derived at each call site:
//
//   storedTier     what the account is on. Labels, and whether to upsell.
//   effectiveTier  what the account may do right now, trial included. Gates.
//
// Keeping the upsell on storedTier is deliberate: hiding it during a trial
// would remove it from precisely the people it exists to convert.

export interface TrialView {
  active: boolean
  daysLeft: number
}

/**
 * The plan name to show a user. Never the trial's borrowed tier.
 *
 * Takes the PLAN, not just the capability tier, because Pro+ reads Pro's
 * feature column: labelling from the tier alone called a Pro+ subscriber "Pro".
 */
export function planLabel(plan: PlanId | TierId): string {
  return planInfo(plan).name
}

/**
 * A plan paid for from the referral credit bank (GROWTH-IMPLEMENTATION.md
 * section 4b) says so, with the date the bank covers it until, so nobody is
 * surprised when it returns to Free: "Pro (paid with credit until 3 Feb 2027)".
 */
export function fundedPlanLabel(plan: PlanId, creditPaidUntil: number | null, nowMs: number = Date.now()): string {
  const name = planLabel(plan)
  if (plan === 'free' || creditPaidUntil === null || creditPaidUntil <= nowMs) return name
  const date = new Date(creditPaidUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  return `${name} (paid with credit until ${date})`
}

/**
 * The suffix that says a trial is running, so the label states the plan and
 * the trial separately instead of letting one stand in for the other.
 */
export function trialSuffix(trial: TrialView): string {
  return trial.active ? ` · trial, ${trial.daysLeft}d left` : ''
}

/**
 * Should a Pro upsell be shown?
 *
 * False for anyone already paying, at any paid tier — a Team subscriber being
 * sold Pro is the same defect as a Pro subscriber being sold Pro.
 */
export function showsProUpsell(storedTier: PlanId | TierId): boolean {
  return storedTier === 'free'
}
