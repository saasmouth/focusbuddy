import type { AIPurpose, ModelMode } from '@shared/types'

// Model IDs — kept in main process so renderer never sees raw IDs.
//
// These are THE place model versions are named. Call sites import the constant
// or, better, call resolveModel(purpose); a hardcoded id elsewhere silently
// escapes both this table and the user's model-mode override, and is how the
// app ended up a generation behind on two of the three tiers.
//
// Current as of 2026-10-16, verified against the Anthropic model table:
//   Haiku 5.5   $0.10 / $0.50  — a tenth of Haiku 4.5's price. Prompts over
//                                100K tokens bill at $0.50 / $2.50.
//   Sonnet 5.5  $2 / $10       — same price as Sonnet 5.
//   Opus 5.5    $4 / $20       — cheaper than Opus 5 ($5 / $25).
// Behaviour that changed with this generation and is handled below, in
// withModelDefaults: Haiku 5.5 thinks by default where Haiku 4.5 did not, so
// the cheap classify/summarise paths turn it off to keep the old cost and
// their small max_tokens budgets. Sonnet 5.5 and Opus 5.5 kept adaptive
// thinking on by default, as Sonnet 5 and Opus 5 already did. All three reject
// assistant prefill and non-default sampling; no call site uses either.
// Every 5.5 model caches a prefix from 512 tokens (cacheControl.ts).
//
// History: 2026-09-15 moved Sonnet 4.6 → Sonnet 5 and Opus 4.8 → Opus 5, with
// Haiku left on 4.5 because it was then still the current Haiku.
export const MODEL_HAIKU = 'claude-haiku-5-5'
export const MODEL_SONNET = 'claude-sonnet-5-5'
export const MODEL_OPUS = 'claude-opus-5-5'

const HAIKU = MODEL_HAIKU
const SONNET = MODEL_SONNET
const OPUS = MODEL_OPUS

// Auto-mode routing table. Each purpose gets the cheapest model that meets the
// quality bar for that task. Override these with caution — tighter routing
// directly affects user cost without much quality gain in most cases.
const AUTO_ROUTING: Record<AIPurpose, string> = {
  chat: SONNET, // conversational reasoning is the workhorse use case
  welcome: SONNET, // a sharp opening matters; runs once per task activation
  setup: SONNET, // widget suggestions need good judgement
  resume: SONNET, // resume drafting is quality-sensitive (user reads it back)
  trail_summary: HAIKU, // pure summarization — Haiku is plenty
  body_double: HAIKU, // tiny presence messages every ~10 min — Haiku is right
  smart_stack: SONNET, // semantic grouping needs reasoning about relationships
  // Living pages: cheap synthesis that re-runs on every meaningful canvas
  // change. Haiku is right unless the user explicitly opts into a stronger
  // model via global model-mode override.
  living_page: HAIKU,
  // Transform wires fire reactively whenever a wired source changes, so they
  // must be cheap by default. Haiku handles "summarize / extract / rewrite"
  // verbs well; the global model-mode override still applies.
  wire_transform: HAIKU,
  // Desk agents reason over MULTIPLE wired inputs against a standing
  // instruction — that judgement benefits from Sonnet. Runs are user-triggered
  // or interval-throttled (min 30s), not per-keystroke, so the cost is bounded.
  desk_agent: SONNET,
  // The command bar's intent router — a tight classify into one of four shapes,
  // returning a small JSON object. Haiku is fast and plenty for classification,
  // and this fires on every command-bar submit, so cheap matters.
  command_route: HAIKU,
  // Titles for items that arrived without one. Deterministic derivation from
  // the item's own content handles the large majority for free; this routes
  // only the remainder, batched into one call with a hard item cap. Haiku is
  // the right tier and the cost ceiling is the point.
  title_backfill: HAIKU,
  // The capture console's intent classifier (Attention S5) — same shape as
  // command_route: tiny classify, fires per capture, deterministic hard
  // triggers run FIRST so most captures never reach the model at all.
  intent_classify: HAIKU,
  // DEC-026 (Δ6): the opt-in capture tidy — clean title + gist from a messy
  // brain-dump. Fires only behind the deterministic messiness gate, async
  // after the confirm screen is already up (never on the latency path), and
  // the user approves before anything replaces anything.
  capture_cleanup: HAIKU,
  // Writing a complete, working mini-app from one sentence of description. This
  // is real code generation -- the output either runs or it visibly does not, in
  // front of the user, on their desk. It fires once per widget created (not per
  // keystroke, not per render), so the quality is worth far more than the saving:
  // Opus.
  custom_widget: OPUS,
  // Office-document generation (the "Create with AI" flow for docs, sheets and
  // slides). The user reads and then edits the result, so quality matters;
  // Sonnet is the right default, with the global model-mode override available.
  document: SONNET,
  // In-editor doc AI: drafting formatted content and rewriting a selection. The
  // user reads a preview and then commits it into a document they care about, so
  // quality matters; Sonnet is the right default.
  doc_rewrite: SONNET,
  // Building a writing-style profile from the user's Sent folder is pure pattern
  // extraction from text — Haiku is purpose-built for it and runs once per
  // session, cached thereafter.
  tone_profile: HAIKU,
  // Drafting an email reply in the user's voice has to hold two constraints at
  // once: match the voice faithfully AND never fabricate facts, dates or
  // commitments. That instruction-following discipline wants Sonnet.
  email_reply_draft: SONNET,
  // Sorting an inbox: read a batch of headers and put each one somewhere. It is
  // classification against a clear rubric, which Haiku does well, and it runs
  // over a whole inbox at once — so the per-message rate is what decides
  // whether anyone can afford to use it at all.
  mail_triage: HAIKU,
  // Auto-filing tag suggestions: a cheap, frequent classification returning a
  // small JSON list of tags. Haiku is fast and plenty, and this can fire as
  // files arrive, so cheap matters.
  file_tag: HAIKU,
  // End-of-meeting wrap-up: summarise a whole conversation AND propose the
  // deliverables that came out of it. Both halves are quality-sensitive and the
  // user reads them back, so Sonnet is the right default. Runs once per meeting.
  meeting_end: SONNET,
  // One step of the multi-round agentic loop: read the goal + prior-round
  // observations, propose the next actions, decide whether the goal is done. This
  // is planning + tool selection under real results, so Sonnet is the right
  // default; kept as its own purpose (not reused 'chat') so per-round cost rolls
  // up separately in telemetry and can be tuned independently later.
  agent_step: SONNET,
  // Settle-time memory extraction (A5, R22): a small grounded distillation
  // that fires in the background after conversational answers — cheap matters
  // and Haiku's extraction discipline is plenty.
  memory_extract: HAIKU,
  // One round of the agentic-browsing loop (A6): read the page observation,
  // pick ONE bridge action or finish. Planning under real page state wants
  // Sonnet; kept as its own purpose (not reused agent_step) so per-round
  // browsing cost rolls up separately for the B4 cost surface.
  // Each round is a narrow job: read the page in front of you, pick ONE action
  // from a short whitelist, and copy what you read into a fixed JSON shape.
  // Haiku handles that well, and a browse is the longest-running loop in the
  // app — 20+ model rounds — so the per-round rate dominates what a research
  // task costs more than any other purpose here. Someone who wants sharper
  // judgement on hard sites raises it globally with the model-mode override.
  //
  // Under Haiku 4.5 this loop could not cache (a 4096-token minimum its prefix
  // never reached) and was still the cheapest option. Haiku 5.5 caches from 512
  // tokens and lists at a tenth of Haiku 4.5's price, so it is cheaper again; the
  // three-to-four-cent browse measured on Haiku 4.5 is now an upper bound, not a
  // current figure.
  browser_agent: HAIKU
}

let currentMode: ModelMode = 'auto'

export function setModelMode(mode: ModelMode): void {
  currentMode = mode
}

export function getModelMode(): ModelMode {
  return currentMode
}

// Local AI (providerRouter.ts) registers here which purposes run on the
// on-device model. Injected rather than imported so this table stays a pure
// module with no settings or Electron dependency.
// Local AI and the BYOK providers (providerRouter.ts) register here how a
// purpose's model id is tagged for routing. Injected rather than imported so
// this table stays a pure module with no settings or Electron dependency.
let tagger: (purpose: string, cloudModel: string) => string = (_p, m) => m
export function setModelTagger(fn: (purpose: string, cloudModel: string) => string): void {
  tagger = fn
}
/** Back-compat: route purposes local / cloud-from-local (tests and older wiring). */
export function setLocalRouteResolver(
  fn: (purpose: string) => boolean,
  cloudFromLocal: (purpose: string) => boolean = () => false
): void {
  tagger = (p, m) => (fn(p) ? `local:${p}` : cloudFromLocal(p) ? `cloudroute:${p}:${m}` : m)
}

/** `cloudroute:<purpose>:<model>` → the model id, or the input unchanged. */
export function stripCloudRoute(model: string): string {
  const m = /^cloudroute:[^:]+:(.+)$/.exec(model)
  return m ? m[1] : model
}

/**
 * The model a purpose runs on. A purpose routed to the on-device model gets
 * `local:<purpose>`, which the routed client serves locally; that id names the
 * purpose so the local side knows which output contract and quality gate apply.
 */
export function resolveModel(purpose: AIPurpose): string {
  return tagger(purpose, resolveCloudModel(purpose))
}

/**
 * For call sites that name their cloud model directly: the same model when the
 * purpose runs on cloud, `local:<purpose>` when it is routed to the device. The
 * cloud choice is left exactly as the call site had it.
 */
export function routeModel(purpose: AIPurpose, cloudModel: string): string {
  return tagger(purpose, cloudModel)
}

/** The cloud model for a purpose, ignoring local routing. */
export function resolveCloudModel(purpose: AIPurpose): string {
  switch (currentMode) {
    case 'haiku':
      return HAIKU
    case 'sonnet':
      return SONNET
    case 'opus':
      return OPUS
    case 'auto':
    default:
      return AUTO_ROUTING[purpose]
  }
}


// ── Plans and managed-AI models (GROWTH-IMPLEMENTATION.md sections 1-2) ─────
//
// Plexii's own key runs a different set of models per plan: Free is Haiku only,
// Pro and Team add Sonnet, Pro+ adds Opus. Bring-your-own-key is not limited by
// this at all. The server enforces the allowlist (402 model_not_in_plan); the
// app applies the same rule BEFORE sending, so a Free user's chat goes to Haiku
// on the first try instead of failing and retrying, and the server's 402 stays a
// backstop for a stale client.

export type ModelFamily = 'haiku' | 'sonnet' | 'opus'
export type ManagedPlan = 'free' | 'pro' | 'proplus' | 'team' | 'enterprise'

const FAMILY_ORDER: ModelFamily[] = ['haiku', 'sonnet', 'opus']
const FAMILY_MODEL: Record<ModelFamily, string> = { haiku: HAIKU, sonnet: SONNET, opus: OPUS }

export const PLAN_MODELS: Record<ManagedPlan, ModelFamily[]> = {
  free: ['haiku'],
  pro: ['haiku', 'sonnet'],
  proplus: ['haiku', 'sonnet', 'opus'],
  team: ['haiku', 'sonnet'],
  enterprise: ['haiku', 'sonnet', 'opus']
}

/** The family a model id belongs to, or null for anything else. */
export function modelFamily(model: string): ModelFamily | null {
  const m = /claude-(haiku|sonnet|opus)/i.exec(model)
  return m ? (m[1].toLowerCase() as ModelFamily) : null
}

/** Normalise a plan string from the server; unknown values read as Free. */
export function managedPlanOf(raw: string | null | undefined): ManagedPlan {
  return raw === 'pro' || raw === 'proplus' || raw === 'team' || raw === 'enterprise' ? raw : 'free'
}

/**
 * The model to send on managed credits for this plan: the requested one when
 * the plan allows its family, otherwise the most capable family the plan does
 * allow that is not above the request. An unknown id passes through untouched
 * (the server refuses unknown ids; guessing a substitute would hide that).
 */
export function modelForPlan(requested: string, plan: ManagedPlan): string {
  const fam = modelFamily(requested)
  if (!fam) return requested
  const allowed = PLAN_MODELS[plan]
  if (allowed.includes(fam)) return requested
  const ceiling = FAMILY_ORDER.indexOf(fam)
  for (let i = ceiling; i >= 0; i--) {
    if (allowed.includes(FAMILY_ORDER[i])) return FAMILY_MODEL[FAMILY_ORDER[i]]
  }
  return FAMILY_MODEL[allowed[0]]
}

/**
 * Like modelForPlan, against the exact families the server says this account
 * may use now (GET /ai/credits `models`; a 402's `allowedModelFamilies`).
 */
export function modelForFamilies(requested: string, allowed: readonly ModelFamily[]): string {
  const fam = modelFamily(requested)
  if (!fam || allowed.length === 0 || allowed.includes(fam)) return requested
  const ceiling = FAMILY_ORDER.indexOf(fam)
  for (let i = ceiling; i >= 0; i--) {
    if (allowed.includes(FAMILY_ORDER[i])) return FAMILY_MODEL[FAMILY_ORDER[i]]
  }
  const lowest = FAMILY_ORDER.find((f) => allowed.includes(f))
  return lowest ? FAMILY_MODEL[lowest] : requested
}

/**
 * Per-model request defaults, applied to the JSON body of every Messages call
 * (BYOK and credits) by the client seam in modelClient.ts.
 *
 * Haiku 5.5 runs adaptive thinking when `thinking` is omitted; Haiku 4.5 did
 * not think at all. The Haiku call sites are the cheap, frequent ones (intent
 * classify, command routing, titles, triage) with max_tokens sized for the
 * answer alone, so silent thinking would both multiply their cost and eat the
 * budget meant for the answer. They get thinking off, which Haiku 5.5 accepts
 * at its default effort. A call that sets `thinking` itself is left alone.
 */
export function withModelDefaults<T extends { model?: unknown; thinking?: unknown }>(body: T): T {
  if (typeof body.model !== 'string') return body
  if (modelFamily(body.model) === 'haiku' && /haiku-5/i.test(body.model) && body.thinking === undefined) {
    return { ...body, thinking: { type: 'disabled' } }
  }
  return body
}
