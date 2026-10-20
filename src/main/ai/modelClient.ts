// The single model-client seam (spec PLX-AI-001). This is the ONLY module that
// holds a runtime dependency on a provider SDK — it is the one place that imports
// the value `Anthropic` and calls `new Anthropic(...)`. Every other service obtains
// a client from here and may keep a TYPE-ONLY import of the SDK for message shapes
// (type imports are erased at compile time and are not a runtime dependency).
//
// Centralising instantiation is what makes provider substitution and accounting
// possible from one place (AI-001..AI-004), rather than scattered `new Anthropic()`
// calls no one can govern.

import Anthropic from '@anthropic-ai/sdk'
import { withModelDefaults } from './modelRouting'

// The client type, re-exported so callers annotate with `ModelClient` (or a
// type-only SDK import) instead of value-importing the SDK.
export type ModelClient = Anthropic

// A plain BYOK client, cached per key so a repeated call reuses the connection and
// a key change swaps cleanly.
const byKey = new Map<string, Anthropic>()
export function getModelClient(key: string): Anthropic {
  let c = byKey.get(key)
  if (!c) {
    c = new Anthropic({ apiKey: key, fetch: defaultsFetch(globalThis.fetch) })
    byKey.set(key, c)
  }
  return c
}

// Construct a client with explicit options (used by the credit-mode proxy path,
// which needs a custom baseURL, headers and fetch). Still instantiated HERE so the
// SDK dependency stays in one module.
export function createAnthropic(opts: ConstructorParameters<typeof Anthropic>[0]): Anthropic {
  const base = (opts?.fetch as typeof fetch | undefined) ?? globalThis.fetch
  return new Anthropic({ ...opts, fetch: defaultsFetch(base) })
}

/**
 * Rewrite a JSON request body before it leaves. Returns init unchanged for a
 * body that is not a JSON object string (streams, form data, nothing at all).
 * Exported for the credit path, which also rewrites the model per plan.
 */
export function rewriteJsonBody(
  init: RequestInit | undefined,
  fn: (body: Record<string, unknown>) => Record<string, unknown>
): RequestInit | undefined {
  if (!init || typeof init.body !== 'string') return init
  let parsed: unknown
  try {
    parsed = JSON.parse(init.body)
  } catch {
    return init
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return init
  const next = fn(parsed as Record<string, unknown>)
  if (next === parsed) return init
  // The SDK has already set content-length for the ORIGINAL body. Sending a
  // different body under that header makes undici refuse the request before
  // it leaves ("Connection error."), which is how every Haiku 5.5 call —
  // rewritten to add `thinking: disabled` — failed in 4.3.30–4.3.33. Drop the
  // stale length; fetch computes the right one for the new body.
  const headers = new Headers(init.headers as HeadersInit | undefined)
  headers.delete('content-length')
  return { ...init, headers, body: JSON.stringify(next) }
}

// Every Messages request goes through withModelDefaults (modelRouting.ts), so a
// per-model default (Haiku 5.5's thinking switch) is set in one place for both
// the BYOK and the credit clients instead of at ~20 call sites.
function defaultsFetch(base: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const next = /\/messages(\?|$)/.test(url) ? rewriteJsonBody(init, (b) => withModelDefaults(b)) : init
    return base(input, next)
  }) as typeof fetch
}

// Drop cached clients (called on a key or session change).
export function invalidateModelClients(): void {
  byKey.clear()
}
