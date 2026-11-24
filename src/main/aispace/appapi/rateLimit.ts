// Per-operation rate limiting for direct app APIs (SPEC-CONNECTIONS.md §5:
// every operation has a rate limit).
//
// One token bucket per (connection, operation). The bucket holds up to
// `perMinute` tokens and refills continuously at perMinute / 60 s, so a burst
// of a full minute's allowance is possible and the long-run rate is the limit.
//
// FAIL-FAST, NOT WAIT. When the bucket is empty, `take` refuses at once and
// says how long until the next token (`retryAfterMs`). The caller (an agent
// run, a person pressing a button) decides whether to wait; nothing in the
// framework sleeps on a local limit, so a run never stalls invisibly and a
// cancel is never stuck behind a sleeping call.
//
// Arithmetic is in whole "credits" (one token = 60,000 credits; a bucket gains
// perMinute credits per millisecond), so with millisecond clocks there is no
// floating-point drift at the boundary: a token is back after exactly
// 60,000 / perMinute ms.

export type TakeResult = { ok: true } | { ok: false; retryAfterMs: number }

const CREDITS_PER_TOKEN = 60_000

interface Bucket {
  credits: number
  updatedAt: number
  perMinute: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  static key(connectionId: string, operationId: string): string {
    return `${connectionId}\u0000${operationId}`
  }

  take(connectionId: string, operationId: string, perMinute: number, now: number): TakeResult {
    if (!(Number.isFinite(perMinute) && perMinute > 0)) return { ok: false, retryAfterMs: 60_000 }
    const key = RateLimiter.key(connectionId, operationId)
    const capacity = perMinute * CREDITS_PER_TOKEN
    let b = this.buckets.get(key)
    if (!b || b.perMinute !== perMinute) {
      // A new bucket, or the limit changed with a new adapter version: start full.
      b = { credits: capacity, updatedAt: now, perMinute }
      this.buckets.set(key, b)
    } else if (now > b.updatedAt) {
      b.credits = Math.min(capacity, b.credits + (now - b.updatedAt) * perMinute)
      b.updatedAt = now
    }
    if (b.credits >= CREDITS_PER_TOKEN) {
      b.credits -= CREDITS_PER_TOKEN
      return { ok: true }
    }
    return { ok: false, retryAfterMs: Math.max(1, Math.ceil((CREDITS_PER_TOKEN - b.credits) / perMinute)) }
  }

  // Forget a connection's buckets (on disconnect or replace).
  forgetConnection(connectionId: string): void {
    const prefix = `${connectionId}\u0000`
    for (const k of [...this.buckets.keys()]) if (k.startsWith(prefix)) this.buckets.delete(k)
  }
}

// The process-wide limiter every invocation shares unless a test passes its own.
export const defaultRateLimiter = new RateLimiter()
