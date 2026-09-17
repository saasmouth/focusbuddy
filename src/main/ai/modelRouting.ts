import type { AIPurpose, ModelMode } from '@shared/types'

// Model IDs — kept in main process so renderer never sees raw IDs.
//
// These are THE place model versions are named. Call sites import the constant
// or, better, call resolveModel(purpose); a hardcoded id elsewhere silently
// escapes both this table and the user's model-mode override, and is how the
// app ended up a generation behind on two of the three tiers.
//
// Current as of 2026-09-15, verified against platform.claude.com pricing:
//   Haiku 4.5   $1 / $5    — cheapest; still the current Haiku
//   Sonnet 5    $2 / $10   — was Sonnet 4.6 at $3/$15. Cheaper AND better:
//                            near-Opus quality on coding and agentic work.
//                            Its newer tokenizer produces ~30% more tokens for
//                            the same text, so the real saving is nearer 13%
//                            than the 33% the headline rates suggest — still a
//                            saving, and the quality gain comes free.
//   Opus 5      $5 / $25   — was Opus 4.8 at the SAME price. A strict upgrade
//                            for nothing: identical rates, better model.
export const MODEL_HAIKU = 'claude-haiku-4-5-20251001'
export const MODEL_SONNET = 'claude-sonnet-5'
export const MODEL_OPUS = 'claude-opus-5'

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
  // Measured, not assumed: Haiku cannot use prompt caching here (its 4096-token
  // minimum is never reached by this loop's prefix), so every round pays full
  // price — and it is STILL the cheapest option, because its base rate is low
  // and the transcript compaction already removed the bulk of the tokens. A
  // typical six-to-eight round browse lands around three to four cents; Sonnet
  // 5, which does cache, costs about two cents more for the same run.
  browser_agent: HAIKU
}

let currentMode: ModelMode = 'auto'

export function setModelMode(mode: ModelMode): void {
  currentMode = mode
}

export function getModelMode(): ModelMode {
  return currentMode
}

export function resolveModel(purpose: AIPurpose): string {
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
