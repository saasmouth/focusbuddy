// Credit mode — routing AI calls through the PlexiDesk signal server on our
// Anthropic key, billed against the account's prepaid balance, with automatic
// fall-back to the user's own key (BYOK) when credits run out.
//
// This is the desktop half of the metered proxy. The backend half lives in
// focusbuddy-signal (src/aiCredits.ts + the /ai/anthropic proxy route). The
// design goal here is zero churn at the ~20 AI call sites: getClient() in
// anthropic.ts decides credits-vs-BYOK once per call, and the metered fetch
// installed on the credit client transparently handles the out-of-credits
// hand-off, so no call site needs to know which path it took.

import type Anthropic from '@anthropic-ai/sdk'
import { createAnthropic, rewriteJsonBody } from './modelClient'
import { modelForPlan, managedPlanOf, withModelDefaults } from './modelRouting'
import { rateFor } from './aiCost'
import {
  parseCreditsResponse,
  parseCreditError,
  creditErrorMessage,
  TOP_UP_PACKS,
  type CreditBucket,
  type CreditError,
  type CreditPlan,
  type CreditsSnapshot,
  type AiCreditStatus
} from '@shared/aiCredits'
import { loadAccountState } from '../db/account'
import { getAiMode, resolveAnthropicKey, hasOwnAnthropicKey } from '../settingsStore'

// The signal server base. Defaults to production; overridable for local
// testing against a dev server (the env var the test harness sets).
export const SIGNAL_BASE =
  process.env.FB_SIGNAL_URL ?? process.env.SIGNAL_HTTP_URL ?? 'https://focusbuddy-signal.fly.dev'

const REAL_ANTHROPIC = 'https://api.anthropic.com/v1/messages'

// Cached view of the account's credit state, in CREDITS (1 credit = US$0.01 of
// billed usage; GROWTH-IMPLEMENTATION.md section 2). balance is null until the
// first successful fetch or metered call — "unknown", which getClient treats
// optimistically so a signed-in user's very first call still tries credits.
interface CreditCache {
  balance: number | null
  buckets: CreditBucket[]
  allowance: number | null
  resetsAt: number | null
  plan: CreditPlan | null
  outOfCredits: boolean
  proxyAvailable: boolean
  /** The server refused managed AI because the email is not verified yet. */
  verificationRequired: boolean
  /** The last refusal the proxy gave, for the renderer's prompts. */
  lastError: CreditError | null
}
const creditCache: CreditCache = {
  balance: null,
  buckets: [],
  allowance: null,
  resetsAt: null,
  plan: null,
  outOfCredits: false,
  proxyAvailable: true,
  verificationRequired: false,
  lastError: null
}

function sessionToken(): string | null {
  return loadAccountState().sessionToken
}

// ── Credit events → renderer ────────────────────────────────────────────────
// A refusal from the proxy happens deep inside some AI call; the prompt that
// explains it ("Trial credits used", "Verify your email") lives in the
// renderer. ipc/index.ts subscribes once and forwards these to every window.
type CreditListener = (e: CreditError & { status: AiStatus }) => void
const creditListeners = new Set<CreditListener>()
export function onCreditEvent(fn: CreditListener): () => void {
  creditListeners.add(fn)
  return () => creditListeners.delete(fn)
}
function emitCreditEvent(e: CreditError): void {
  creditCache.lastError = e
  const status = getAiStatus()
  for (const fn of creditListeners) {
    try {
      fn({ ...e, status })
    } catch {
      /* a listener failing must not break the AI call that triggered it */
    }
  }
}

/** Reset all cached state (sign-out, tests). */
export function resetCreditCache(): void {
  creditCache.balance = null
  creditCache.buckets = []
  creditCache.allowance = null
  creditCache.resetsAt = null
  creditCache.plan = null
  creditCache.outOfCredits = false
  creditCache.proxyAvailable = true
  creditCache.verificationRequired = false
  creditCache.lastError = null
}

function applySnapshot(snap: CreditsSnapshot): void {
  creditCache.balance = snap.balance
  creditCache.buckets = snap.buckets
  creditCache.allowance = snap.allowance
  creditCache.resetsAt = snap.resetsAt
  if (snap.tier) creditCache.plan = snap.tier
  creditCache.outOfCredits = snap.balance <= 0
  if (snap.proxyAvailable !== null) creditCache.proxyAvailable = snap.proxyAvailable
  if (snap.balance > 0 && creditCache.lastError?.error === 'out_of_credits') creditCache.lastError = null
}

/**
 * Decide whether the next call should go through credits. Pure policy, no
 * network. 'byok' never uses credits; 'credits' always does (when signed in);
 * 'auto' uses credits unless we know they cannot serve this account and the
 * user has their own key to fall back to.
 */
export function shouldUseCredits(): boolean {
  const token = sessionToken()
  if (!token) return false
  const mode = getAiMode()
  if (mode === 'byok') return false
  if (mode === 'credits') return true
  // auto
  // If we've learned the server proxy is unavailable (no proxy key configured
  // server-side, i.e. credit mode isn't activated yet), don't bounce off it.
  // Behave exactly like BYOK so a personal-key user is unaffected and a no-key
  // user gets the normal "add a key" prompt instead of a 503. This is what lets
  // the feature ship dormant and light up the moment the server key is set.
  if (creditCache.proxyAvailable === false) return false
  if (hasOwnAnthropicKey()) {
    if (creditCache.balance !== null && creditCache.balance <= 0) return false
    if (creditCache.verificationRequired) return false
  }
  return true
}

/**
 * The least a request can possibly cost, in credits: its input alone, at list
 * price with no markup, counting generously few tokens per character. The real
 * charge is always at least this, so refusing when this exceeds the balance
 * never refuses a request that could have been afforded (section 2: "a request
 * that would cost more than what remains is not attempted").
 */
export function minimumCostCredits(body: Record<string, unknown>): number {
  const model = typeof body.model === 'string' ? body.model : ''
  const chars =
    JSON.stringify(body.system ?? '').length + JSON.stringify(body.messages ?? []).length
  const tokensLowerBound = chars / 6
  const usd = (tokensLowerBound / 1e6) * rateFor(model).inPerM
  return usd * 100
}

/** The next action to name when credits are gone and the server did not say. */
function defaultNext(): 'upgrade' | 'topup' {
  return !creditCache.plan || creditCache.plan === 'free' ? 'upgrade' : 'topup'
}

// A refusal turned into the Anthropic error shape, so the SDK raises an
// APIError whose message is a sentence a person can act on rather than the raw
// JSON of the proxy's body.
function refusalResponse(e: CreditError, status: number): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: { type: e.error, message: creditErrorMessage(e) },
      next: e.next,
      allowedModel: e.allowedModel
    }),
    { status, headers: { 'content-type': 'application/json' } }
  )
}

export interface MeteredFetchDeps {
  fetch: typeof fetch
  mode: () => ReturnType<typeof getAiMode>
  ownKey: () => string | null
}

/**
 * The metered fetch handed to the credit-mode Anthropic client. Before sending
 * it fits the model to the plan (Free runs Haiku; section 1) and declines a
 * request the balance cannot cover. After, it reads the balance the server
 * echoes, and on a refusal either retries on the user's own key (auto mode),
 * retries on the plan's allowed model (model_not_in_plan), or surfaces a
 * readable error and tells the renderer so it can prompt.
 */
export function createMeteredFetch(deps: MeteredFetchDeps): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Transparently re-run the same request against Anthropic on the user's own
    // key — but only in 'auto' mode (in 'credits' mode they explicitly chose the
    // proxy, so we never spend their key without consent). Returns null when no
    // fall-back is possible. Sends the ORIGINAL body: on their own key the plan's
    // model allowlist does not apply.
    const originalInit = init
    const ownKeyRetry = (): Promise<Response> | null => {
      const ownKey = deps.ownKey()
      if (deps.mode() === 'auto' && ownKey && originalInit?.body) {
        const headers = new Headers(originalInit?.headers as HeadersInit | undefined)
        headers.delete('authorization')
        headers.set('x-api-key', ownKey)
        return deps.fetch(REAL_ANTHROPIC, { ...originalInit, headers })
      }
      return null
    }

    // 1. Fit the model to the plan, when the plan is known.
    let body: Record<string, unknown> | null = null
    let sendInit = init
    if (creditCache.plan) {
      const plan = managedPlanOf(creditCache.plan)
      sendInit = rewriteJsonBody(init, (b) => {
        if (typeof b.model !== 'string') return b
        const fitted = modelForPlan(b.model, plan)
        return fitted === b.model ? b : withModelDefaults({ ...b, model: fitted })
      })
    }
    if (sendInit && typeof sendInit.body === 'string') {
      try {
        body = JSON.parse(sendInit.body) as Record<string, unknown>
      } catch {
        body = null
      }
    }

    // 2. Do not attempt what the balance cannot cover.
    if (creditCache.balance !== null && body) {
      const floor = minimumCostCredits(body)
      if (creditCache.balance <= 0 || floor > creditCache.balance) {
        const fb = ownKeyRetry()
        if (fb) return fb
        const e: CreditError = { error: 'out_of_credits', next: defaultNext(), allowedModel: null }
        creditCache.outOfCredits = true
        emitCreditEvent(e)
        return refusalResponse(e, 402)
      }
    }

    let res: Response
    try {
      res = await deps.fetch(input, sendInit)
    } catch (err) {
      // The proxy is unreachable (network/DNS/TLS, or a misconfigured base URL).
      // A personal-key user must never be stranded behind a bare "Connection
      // error" — in auto mode, use their key directly; otherwise record the
      // outage so getClient prefers BYOK next time, and rethrow.
      creditCache.proxyAvailable = false
      const fb = ownKeyRetry()
      if (fb) return fb
      throw err
    }

    if (res.status === 402 || res.status === 403) {
      const text = await res.clone().text().catch(() => '')
      const e = parseCreditError(res.status, text)
      if (e) {
        if (e.error === 'model_not_in_plan') {
          // Their own key runs any model; prefer it in auto mode.
          const fb = ownKeyRetry()
          if (fb) return fb
          if (e.allowedModel && body && body.model !== e.allowedModel) {
            const retryInit = rewriteJsonBody(sendInit, (b) =>
              withModelDefaults({ ...b, model: e.allowedModel as string })
            )
            const retried = await deps.fetch(input, retryInit)
            if (retried.status !== 402 && retried.status !== 403) {
              readBalanceHeaders(retried)
              return retried
            }
            const e2 = parseCreditError(retried.status, await retried.clone().text().catch(() => ''))
            if (e2) {
              noteRefusal(e2)
              return refusalResponse(e2, retried.status)
            }
            return retried
          }
          noteRefusal(e)
          return refusalResponse(e, res.status)
        }
        noteRefusal(e)
        const fb = ownKeyRetry()
        return fb ?? refusalResponse(e, res.status)
      }
    }

    // 503 (no proxy key), 404 (endpoint missing), or any 5xx — the proxy cannot
    // serve this call. Prefer the personal key in auto mode; otherwise mark the
    // proxy unavailable and surface an actionable message rather than a raw error.
    if (res.status === 503 || res.status === 404 || res.status >= 500) {
      creditCache.proxyAvailable = false
      const fb = ownKeyRetry()
      if (fb) return fb
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'proxy_unavailable',
            message:
              'AI credits are temporarily unavailable. Add your own Anthropic API key in Settings → AI · API keys to keep using AI.'
          }
        }),
        { status: 503, headers: { 'content-type': 'application/json' } }
      )
    }

    readBalanceHeaders(res)
    return res
  }) as typeof fetch
}

function noteRefusal(e: CreditError): void {
  if (e.error === 'out_of_credits') {
    creditCache.outOfCredits = true
    creditCache.balance = 0
    if (!e.next) e.next = defaultNext()
  }
  if (e.error === 'email_not_verified') creditCache.verificationRequired = true
  emitCreditEvent(e)
}

// The server echoes the remaining balance on every billed response. The new
// server sends credits in x-pd-credits; older servers sent dollars in
// x-pd-credit-balance.
function readBalanceHeaders(res: Response): void {
  const credits = res.headers.get('x-pd-credits')
  const usd = res.headers.get('x-pd-credit-balance')
  let bal: number | null = null
  if (credits !== null && Number.isFinite(Number(credits))) bal = Number(credits)
  else if (usd !== null && Number.isFinite(Number(usd))) bal = Math.round(Number(usd) * 100)
  if (bal !== null) {
    creditCache.balance = bal
    creditCache.outOfCredits = bal <= 0
  }
}

function meteredFetch(): typeof fetch {
  return createMeteredFetch({
    fetch: (input, init) => fetch(input, init),
    mode: getAiMode,
    ownKey: resolveAnthropicKey
  })
}

// Cache the credit client by the session token it authenticates as, so a
// re-login swaps to a fresh client without an app restart.
let creditClient: { token: string; instance: Anthropic } | null = null

/** Build (or reuse) the Anthropic client that points at our metered proxy. */
export function getCreditClient(): Anthropic | null {
  const token = sessionToken()
  if (!token) return null
  if (!creditClient || creditClient.token !== token) {
    creditClient = {
      token,
      instance: createAnthropic({
        // The proxy authenticates via Authorization: Bearer <session token>,
        // not x-api-key, so the apiKey here is an ignored placeholder.
        apiKey: 'pd-proxy',
        baseURL: `${SIGNAL_BASE}/ai/anthropic`,
        defaultHeaders: { Authorization: `Bearer ${token}` },
        fetch: meteredFetch(),
        // The proxy gates and bills server-side; don't let the SDK retry a
        // 402/503 and double-spend or spin.
        maxRetries: 0
      })
    }
  }
  return creditClient.instance
}

/** Drop the cached credit client (called when the session or key changes). */
export function invalidateCreditClient(): void {
  creditClient = null
}

/**
 * DEC-051 — is THIS client the metered proxy?
 *
 * Streaming call sites must know whether the request will hit the proxy (which
 * rejects streaming outright, 400 "Streaming is not supported on PlexiDesk
 * credits"). Asking policy — `shouldUseCredits() && getCreditClient() === c` —
 * is a race: the client is resolved once at the top of a long turn, and by the
 * time the model call runs, retrieval's own AI calls may have moved the
 * balance (auto mode then prefers BYOK) or a settings change may have
 * invalidated the cached instance. Policy says "not credits", the client still
 * IS the proxy, and the stream 400s in the user's face.
 *
 * The client's own baseURL cannot drift out from under the request it is about
 * to make, so that is what we read.
 */
export function isCreditClient(c: { baseURL?: string } | null | undefined): boolean {
  const base = c?.baseURL
  return typeof base === 'string' && base.startsWith(SIGNAL_BASE)
}

/** The proxy's refusal, matched on the wire text rather than the status alone
 *  (a 400 has many causes; only this one is retryable non-streamed). */
export function isStreamingUnsupported(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : JSON.stringify(err ?? '')
  return /streaming is not supported/i.test(msg)
}

/** Fetch the live balance from the server and refresh the cache. */
export async function refreshCredits(): Promise<AiStatus> {
  const token = sessionToken()
  if (!token) {
    resetCreditCache()
    return getAiStatus()
  }
  try {
    const res = await fetch(`${SIGNAL_BASE}/ai/credits`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (res.ok) {
      const snap = parseCreditsResponse(await res.json())
      if (snap) applySnapshot(snap)
    } else if (res.status === 403) {
      const e = parseCreditError(403, await res.text().catch(() => ''))
      if (e?.error === 'email_not_verified') creditCache.verificationRequired = true
    }
  } catch {
    // Network blip — keep the last-known cache rather than inventing a number.
  }
  return getAiStatus()
}

/** The renderer verified the account's email: managed AI may serve it now. */
export function markEmailVerified(): void {
  creditCache.verificationRequired = false
  if (creditCache.lastError?.error === 'email_not_verified') creditCache.lastError = null
}

// The shape lives in @shared/aiCredits so the preload and renderer type the
// same object main builds here.
export type AiStatus = AiCreditStatus

/** Snapshot for the renderer's settings panel, meter and credit prompts. */
export function getAiStatus(): AiStatus {
  return {
    mode: getAiMode(),
    signedIn: Boolean(sessionToken()),
    hasOwnKey: hasOwnAnthropicKey(),
    balance: creditCache.balance,
    balanceUsd: creditCache.balance === null ? null : creditCache.balance / 100,
    buckets: creditCache.buckets.map((b) => ({ ...b })),
    allowance: creditCache.allowance,
    resetsAt: creditCache.resetsAt,
    plan: creditCache.plan,
    outOfCredits: creditCache.outOfCredits,
    proxyAvailable: creditCache.proxyAvailable,
    verificationRequired: creditCache.verificationRequired,
    lastError: creditCache.lastError
  }
}

export interface TopUpResult {
  ok: boolean
  action?: 'redirect' | 'pending'
  url?: string
  amountUsd?: number
  error?: string
}

/** Start a Stripe checkout to buy more credits; returns the URL to open. */
export async function startTopUp(amountUsd: number): Promise<TopUpResult> {
  const token = sessionToken()
  if (!token) return { ok: false, error: 'Sign in to add credits.' }
  // Only the published packs; the server refuses anything else anyway.
  if (!TOP_UP_PACKS.some((p) => p.usd === amountUsd)) {
    return { ok: false, error: 'Credits come in $10, $25 and $50 packs.' }
  }
  try {
    const res = await fetch(`${SIGNAL_BASE}/ai/credits/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ amountUsd })
    })
    if (!res.ok) return { ok: false, error: `Checkout failed (${res.status}).` }
    const body = (await res.json()) as {
      action?: 'redirect' | 'pending'
      url?: string
      amountUsd?: number
    }
    return { ok: true, action: body.action, url: body.url, amountUsd: body.amountUsd }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
