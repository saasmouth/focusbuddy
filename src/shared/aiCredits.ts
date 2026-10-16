// AI credits: the wire contract with the signal server and the pure rules the
// app applies to it. GROWTH-IMPLEMENTATION.md section 2.
//
//   1 credit = US$0.01 of billed usage.
//   GET /ai/credits → { balance, buckets: [{ kind, credits, expiresAt }],
//                       allowance, resetsAt, tier }
//   402 on POST /ai/anthropic/v1/messages →
//                     { error: 'out_of_credits' | 'model_not_in_plan',
//                       next: 'upgrade' | 'topup', allowedModel? }
//
// Shared by main (which talks to the server) and the renderer (which shows the
// meter and the prompts), and pure so the parsing is unit-tested. Older servers
// answered GET /ai/credits with { balanceUsd } and a 402 shaped like an
// Anthropic error; both still parse, so the app works against either until the
// new server is deployed. Nothing here invents a number: a field the server did
// not send stays null and the UI says it does not know.

export type CreditBucketKind = 'allowance' | 'bonus' | 'purchased'

export interface CreditBucket {
  kind: CreditBucketKind
  credits: number
  /** Epoch ms, or null when the bucket does not expire. */
  expiresAt: number | null
}

export type CreditPlan = 'free' | 'pro' | 'proplus' | 'team' | 'enterprise'

export interface CreditsSnapshot {
  /** Spendable credits now, across every bucket. */
  balance: number
  buckets: CreditBucket[]
  /** The plan's monthly allowance in credits, when the server sent it. */
  allowance: number | null
  /** When the monthly allowance next resets (epoch ms), when known. */
  resetsAt: number | null
  /** The plan the server bills managed AI against (effective tier). */
  tier: CreditPlan | null
  /** Whether the server has its Anthropic key configured (older servers). */
  proxyAvailable: boolean | null
}

/** Top-up packs (section 2). Minimum $10: card fees make smaller packs uneconomic. */
export const TOP_UP_PACKS: ReadonlyArray<{ usd: number; credits: number }> = [
  { usd: 10, credits: 1000 },
  { usd: 25, credits: 2600 },
  { usd: 50, credits: 5500 }
]

/** Trial bonus granted on email verification (section 2). */
export const TRIAL_BONUS_CREDITS = 300
/** Referral reward to both sides on the referred account's verification (section 4). */
export const REFERRAL_BONUS_CREDITS = 500

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Epoch ms from a number (ms or s) or an ISO string. */
export function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Seconds-since-epoch values are ten digits; anything that small is seconds.
    return v < 1e11 ? Math.round(v * 1000) : Math.round(v)
  }
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

function planOf(v: unknown): CreditPlan | null {
  return v === 'free' || v === 'pro' || v === 'proplus' || v === 'team' || v === 'enterprise' ? v : null
}

function bucketOf(v: unknown): CreditBucket | null {
  if (!v || typeof v !== 'object') return null
  const b = v as Record<string, unknown>
  const kind = b.kind
  if (kind !== 'allowance' && kind !== 'bonus' && kind !== 'purchased') return null
  const credits = num(b.credits)
  if (credits === null) return null
  return { kind, credits: Math.max(0, credits), expiresAt: toEpochMs(b.expiresAt) }
}

/** Parse a GET /ai/credits body, new shape or legacy. Null when it is neither. */
export function parseCreditsResponse(body: unknown): CreditsSnapshot | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const proxyAvailable = typeof b.proxyAvailable === 'boolean' ? b.proxyAvailable : null
  const balance = num(b.balance)
  if (balance !== null) {
    const buckets = Array.isArray(b.buckets)
      ? b.buckets.map(bucketOf).filter((x): x is CreditBucket => x !== null)
      : []
    return {
      balance: Math.max(0, balance),
      buckets,
      allowance: num(b.allowance),
      resetsAt: toEpochMs(b.resetsAt),
      tier: planOf(b.tier),
      proxyAvailable
    }
  }
  // Legacy: a dollar balance and nothing else.
  const usd = num(b.balanceUsd)
  if (usd !== null) {
    return {
      balance: Math.max(0, Math.round(usd * 100)),
      buckets: [],
      allowance: null,
      resetsAt: null,
      tier: null,
      proxyAvailable
    }
  }
  return null
}

export type CreditErrorCode = 'out_of_credits' | 'model_not_in_plan' | 'email_not_verified'

export interface CreditError {
  error: CreditErrorCode
  /** What the person can do about it: buy a plan or buy credits. */
  next: 'upgrade' | 'topup' | null
  /** For model_not_in_plan: the cheapest model the plan allows. */
  allowedModel: string | null
}

/**
 * Read a refusal from the credits proxy. Accepts the spec's 402 body, the older
 * Anthropic-shaped `{ error: { type: 'out_of_credits' } }`, and a 403
 * `email_not_verified` (the server's refusal of managed AI before verification;
 * section 3). Anything else is not a credit refusal and returns null.
 */
export function parseCreditError(status: number, bodyText: string): CreditError | null {
  if (status !== 402 && status !== 403) return null
  let body: unknown = null
  try {
    body = JSON.parse(bodyText)
  } catch {
    body = null
  }
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  let code: unknown = b.error
  if (code && typeof code === 'object') code = (code as Record<string, unknown>).type
  if (typeof code !== 'string') code = b.code
  const next = b.next === 'upgrade' || b.next === 'topup' ? b.next : null
  const allowedModel = typeof b.allowedModel === 'string' && b.allowedModel ? b.allowedModel : null
  if (code === 'out_of_credits' || code === 'model_not_in_plan' || code === 'email_not_verified') {
    return { error: code, next, allowedModel }
  }
  // A bare 402 from an older server still means the balance is spent.
  if (status === 402) return { error: 'out_of_credits', next, allowedModel }
  return null
}

/** The words shown for a credit refusal, wherever it surfaces. */
export function creditErrorMessage(e: CreditError): string {
  switch (e.error) {
    case 'email_not_verified':
      return 'Verify your email to use Plexii AI credits. Check your inbox for the 6-digit code, or add your own Anthropic key in Settings.'
    case 'model_not_in_plan':
      return 'That AI model is not included in your plan. Upgrade, or add your own Anthropic key in Settings to use any model.'
    case 'out_of_credits':
    default:
      return e.next === 'upgrade'
        ? 'Your AI credits are used up. Upgrade for a monthly allowance, add credits, or add your own Anthropic key in Settings.'
        : 'Your AI credits are used up. Add credits, or add your own Anthropic key in Settings.'
  }
}

/** Format a credit count for display: 1,234 credits. */
export function formatCredits(n: number): string {
  return `${Math.max(0, Math.floor(n)).toLocaleString('en-US')} credit${Math.floor(n) === 1 ? '' : 's'}`
}

/** True when the trial's bonus credits are what ran out (drives "Trial credits used"). */
export function isTrialCreditsExhausted(input: {
  trialActive: boolean
  storedPlan: CreditPlan | null
  error: CreditError | null
  balance: number | null
}): boolean {
  if (!input.trialActive) return false
  if (input.storedPlan && input.storedPlan !== 'free') return false
  if (input.error?.error === 'out_of_credits') return true
  return input.balance !== null && input.balance <= 0
}

/** The credit state main reports to the renderer (creditMode.getAiStatus). */
export interface AiCreditStatus {
  mode: 'auto' | 'credits' | 'byok'
  signedIn: boolean
  hasOwnKey: boolean
  balance: number | null
  balanceUsd: number | null
  buckets: CreditBucket[]
  allowance: number | null
  resetsAt: number | null
  plan: CreditPlan | null
  outOfCredits: boolean
  proxyAvailable: boolean
  verificationRequired: boolean
  lastError: CreditError | null
}

/** A refusal from the credits proxy, forwarded to the renderer. */
export type AiCreditEvent = CreditError & { status: AiCreditStatus }
