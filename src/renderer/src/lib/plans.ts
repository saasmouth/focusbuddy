// The plans, as the app shows them. GROWTH-IMPLEMENTATION.md section 1 is the
// contract; haptyx-shared/src/plans.ts is the canonical catalogue the website
// and server read, and these figures must match it (tests/unit/plans.test.ts
// pins them to the spec table).
//
// A PLAN is what someone buys. A TIER (capabilityDefaults TierId) is the column
// of the capability matrix it reads. Pro+ is its own plan with Pro's feature
// column, so it lives here and not in the matrix.

import type { TierId } from './capabilityDefaults'

export type PlanId = 'free' | 'pro' | 'proplus' | 'team'
export type PaidPlanId = Exclude<PlanId, 'free'>

export interface PlanInfo {
  id: PlanId
  name: string
  /** US$ per user (Team: per seat) per month, billed monthly. */
  monthly: number
  /** US$ per user (Team: per seat) per year, billed yearly (two months free). */
  yearly: number
  unit: 'user' | 'seat'
  /** Managed-AI credits per month (Team: per seat, pooled per organisation). */
  aiCreditsMonthly: number
  /** Models Plexii's managed AI runs on this plan. Your own key runs any. */
  aiModels: string
  tagline: string
}

export const PLANS: readonly PlanInfo[] = [
  {
    id: 'free',
    name: 'Free',
    monthly: 0,
    yearly: 0,
    unit: 'user',
    aiCreditsMonthly: 100,
    aiModels: 'Haiku',
    tagline: 'The complete personal workspace.'
  },
  {
    id: 'pro',
    name: 'Pro',
    monthly: 12,
    yearly: 120,
    unit: 'user',
    aiCreditsMonthly: 800,
    aiModels: 'Haiku and Sonnet',
    tagline: 'Managed AI, backups and every device.'
  },
  {
    id: 'proplus',
    name: 'Pro+',
    monthly: 25,
    yearly: 250,
    unit: 'user',
    aiCreditsMonthly: 2500,
    aiModels: 'Haiku, Sonnet and Opus',
    tagline: 'Pro with more AI, and Opus.'
  },
  {
    id: 'team',
    name: 'Team',
    monthly: 15,
    yearly: 150,
    unit: 'seat',
    aiCreditsMonthly: 800,
    aiModels: 'Haiku and Sonnet',
    tagline: 'Your whole team, together.'
  }
]

export const PAID_PLANS: readonly PlanInfo[] = PLANS.filter((p) => p.id !== 'free')

export function planInfo(id: PlanId): PlanInfo {
  return PLANS.find((p) => p.id === id) ?? PLANS[0]
}

/** Read a plan id from the server; anything unknown is Free. */
export function planIdOf(raw: unknown): PlanId {
  return raw === 'pro' || raw === 'proplus' || raw === 'team' ? raw : 'free'
}

/** The capability-matrix column a plan reads its features from. */
export function tierForPlan(plan: PlanId): TierId {
  return plan === 'proplus' ? 'pro' : plan
}

/** "$12/month", "$150/year per seat". Whole dollars, no cents. */
export function priceLabel(p: PlanInfo, interval: 'month' | 'year'): string {
  const n = interval === 'month' ? p.monthly : p.yearly
  const per = p.unit === 'seat' ? ' per seat' : ''
  return `US$${n}/${interval}${per}`
}

/** "800 AI credits a month on Haiku and Sonnet" (Team says per seat). */
export function aiAllowanceLabel(p: PlanInfo): string {
  const per = p.unit === 'seat' ? ' per seat, pooled' : ''
  return `${p.aiCreditsMonthly.toLocaleString('en-US')} AI credits a month${per} on ${p.aiModels}`
}
