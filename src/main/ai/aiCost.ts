// Model pricing, used to turn REAL token counts (from the API's usage field)
// into a dollar figure for the usage view. Token totals are exact; only the
// dollar figure depends on these rates. Rates are USD per million tokens and
// track Anthropic's published list prices — update them if you are on
// negotiated rates.
//
// Verified against https://platform.claude.com/docs/en/about-claude/pricing
// on 2026-09-15. tests/unit/aiCost.test.ts pins every rate below to that table,
// so a stale rate fails the suite rather than quietly misreporting spend.
//
// Note on how these go stale: the values this table held before 2026-09-15
// ($15/$75 for opus, $0.80/$4 for haiku) were not invented — they were the
// Claude Opus 4.1 and Claude Haiku 3.5 list prices. The table had simply been
// left on a previous model generation while the routing moved on, which is the
// failure mode to watch for here.

export interface Rate {
  inPerM: number
  outPerM: number
}

// Matched against the resolved model id (e.g. claude-sonnet-4-6) by family AND
// version — pricing is NOT stable across versions within a family (Sonnet 5 is
// $2/$10 while Sonnet 4.6 is $3/$15), so the version-specific patterns must be
// listed before the bare family fallback.
export const PRICING: Array<{ match: RegExp; rate: Rate }> = [
  // The on-device model (Settings → AI → Local on this device). It runs on the
  // user's own hardware, so it costs nothing per token. Listed first so no
  // family pattern below can match a local id; without it the unknown id would
  // fall to DEFAULT_RATE and the usage view would invent a cloud bill.
  { match: /^local:/, rate: { inPerM: 0, outPerM: 0 } },
  // Fable 5 — the premium tier.
  { match: /fable/i, rate: { inPerM: 10, outPerM: 50 } },
  // Opus 5.5 dropped below Opus 5 — match it before bare opus.
  { match: /opus-5-5/i, rate: { inPerM: 4, outPerM: 20 } },
  // Opus 5 / 4.8 / 4.7 / 4.6 all share one price.
  { match: /opus/i, rate: { inPerM: 5, outPerM: 25 } },
  // Sonnet 5.5 and Sonnet 5 share a price, below the 4.x line — before bare sonnet.
  { match: /sonnet-5/i, rate: { inPerM: 2, outPerM: 10 } },
  { match: /sonnet/i, rate: { inPerM: 3, outPerM: 15 } },
  // Haiku 5.5 is a tenth of Haiku 4.5 (up to 100K-token prompts; this local
  // estimate does not model the long-prompt rate).
  { match: /haiku-5/i, rate: { inPerM: 0.1, outPerM: 0.5 } },
  // Haiku 4.5.
  { match: /haiku/i, rate: { inPerM: 1, outPerM: 5 } }
]

// A safe middle-tier default when the model family is unrecognised.
export const DEFAULT_RATE: Rate = { inPerM: 3, outPerM: 15 }

export function rateFor(model: string): Rate {
  return PRICING.find((p) => p.match.test(model))?.rate ?? DEFAULT_RATE
}

// Prompt-cache multipliers, relative to the model's base input rate.
//
// A 5-minute (ephemeral) write costs 1.25x base and a 1-hour write 2x, on every
// model. Reads are 0.1x base — except on Fable 5.1 and Mythos 5.1, where a hit
// is 0.025x, and Opus 5.5, where it is 0.05x. Charging those two at 0.1x would overstate their cache reads
// fourfold, so the read multiplier is resolved per model rather than fixed.
export const CACHE_WRITE_5M = 1.25
export const CACHE_WRITE_1H = 2

export function cacheReadMultiplier(model: string): number {
  if (/(fable|mythos)-5-1/i.test(model)) return 0.025
  // Opus 5.5: $0.20 reads against a $4 base.
  if (/opus-5-5/i.test(model)) return 0.05
  return 0.1
}

// Cost of cache traffic in micro-dollars. `readTokens` are cache hits and
// `writeTokens` are 5-minute writes, which is the only TTL this app asks for.
export function cacheCostMicros(model: string, readTokens: number, writeTokens: number): number {
  const base = rateFor(model).inPerM
  const reads = (Math.max(0, readTokens) / 1e6) * base * cacheReadMultiplier(model)
  const writes = (Math.max(0, writeTokens) / 1e6) * base * CACHE_WRITE_5M
  return Math.round((reads + writes) * 1e6)
}

// Estimated cost in micro-dollars (1e-6 USD) so it can be summed as an integer
// counter without floating-point drift. Divide by 1e6 for dollars.
export function estimateCostMicros(model: string, inputTokens: number, outputTokens: number): number {
  const r = rateFor(model)
  const usd = (Math.max(0, inputTokens) / 1e6) * r.inPerM + (Math.max(0, outputTokens) / 1e6) * r.outPerM
  return Math.round(usd * 1e6)
}
