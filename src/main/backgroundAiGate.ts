// The "Background AI tasks" gate (Settings > Data > Privacy, privacyPrefs.ts).
//
// Three jobs send the person's own content to an AI provider with no click:
//
//   - title backfill (titleBackfill.ts), 12 s after every launch: up to 40
//     untitled items, 400 characters of each, in one request to Anthropic with
//     the person's own key;
//   - embeddings (documentRetrieval.ts, semanticRetrieval.ts): every saved
//     document and knowledge entry, and a sweep 45 s after launch then every
//     5 minutes, sent to OpenAI's embeddings API with the person's own key, so
//     search can match meaning rather than words. Search questions are embedded
//     the same way;
//   - the desk hello (deskWelcomeGate.ts): the first time each session a desk
//     is open while in progress, its name and what is on it (deskBlockForCall)
//     go to wherever PlexiiAssist goes (Anthropic on the person's key or on
//     Plexii AI credits, or OpenAI) for a one- or two-sentence hello and first
//     step. The same request from a click ("Have AI suggest the first step" in
//     the Pre-Task Bridge) is the person asking, and is not gated.
//
// None may reach a cloud provider unless the person turned Background AI tasks
// on. Work that stays on this computer is not gated: titles derived from an
// item's own text, embeddings from a local model (Ollama today; the bundled
// model, see `setLocalRouting`), and a desk hello the on-device model writes.
//
// The gate sits at the call sites (index.ts, ipc/index.ts through
// deskWelcomeGate.ts, and the two retrieval modules), not inside
// src/main/ai/*, which the local-ai branch owns.

import type { AIPurpose } from '@shared/types'
import { backgroundAiEnabled } from './privacyPrefs'
import { embedTexts, activeEmbedModel, type EmbedResult } from './ai/embeddings'
import { localEmbed, localModelStatus } from './ai/localModel'
import { resolveModel } from './ai/modelRouting'

/**
 * How many texts one backfill request carries. localEmbed sends the whole
 * array in ONE call on a 60 s timeout, so an unbounded backlog times out, the
 * request returns null and every item in it is lost — the backfill silently
 * achieves nothing at exactly the scale it exists for. Batching also makes
 * progress durable: a later failure keeps the batches already written.
 */
export const EMBED_BATCH = 16

/** Why a background job did not use a model. Shown in Settings next to search coverage. */
export const BACKGROUND_AI_OFF = 'background_ai_off' as const

export type GatedEmbedResult =
  | EmbedResult
  | { ok: false; reason: typeof BACKGROUND_AI_OFF }

// ── Local routing seam ──────────────────────────────────────────────────────
// True when AI is set to run on this device, so a "model call" never leaves the
// computer. index.ts wires it to the provider router right after initLocalAi():
// `setLocalRouting(() => localOnlyActive())`.
let localRouting: () => boolean = () => false

export function setLocalRouting(fn: () => boolean): void {
  localRouting = fn
}

/**
 * May a background job ask a model to do this? Yes when the person allowed
 * background AI, or when AI runs on this device (nothing is sent anywhere).
 *
 * Pass the job's `purpose` whenever the call goes through the routed client
 * with that purpose. "The AI source is Local" is not enough for such a call:
 * PlexiiAssist (and so the desk hello) still goes to the cloud while the source
 * is Local when it has a route of its own in Settings › AI, or when it uses a
 * saved key under content writing's 'cloud-if-key' (the default; see
 * providerRouter.contentKeyFor). So with a purpose, the model id that purpose
 * resolves to right now decides: `local:` runs here, anything else would leave.
 * If routing was never set up, nothing resolves to `local:` and the answer is
 * no, which is the safe way round.
 */
export function backgroundModelAllowed(purpose?: AIPurpose): boolean {
  if (backgroundAiEnabled()) return true
  return purpose === undefined ? localRouting() : resolveModel(purpose).startsWith('local:')
}

/** Local-only embedding: the vectors a local model gives, or a plain "off". */
async function embedLocally(texts: string[], kind: 'document' | 'query'): Promise<GatedEmbedResult> {
  try {
    const local = await localEmbed(texts, kind)
    if (local && local.vectors.length === texts.length) {
      // Same tags embeddings.ts writes, so stored vectors compare correctly.
      const model = local.model.startsWith('local:') ? local.model : `ollama:${local.model}`
      return { ok: true, vectors: local.vectors, model }
    }
  } catch {
    /* no local model: fall through to the honest "off" */
  }
  return { ok: false, reason: BACKGROUND_AI_OFF }
}

/**
 * Embed text for search. Every embedding the app makes is background work: on
 * save, on opening Documents or PlexiiBrain (which reindex), on the 5-minute
 * sweep, and for a search question. So it goes to a cloud provider only while
 * Background AI tasks is on; otherwise only a local model is asked.
 */
export async function gatedEmbedTexts(
  texts: string[],
  kind: 'document' | 'query' = 'document'
): Promise<GatedEmbedResult> {
  if (texts.length === 0) return embedTexts(texts, kind)
  if (backgroundModelAllowed()) return embedTexts(texts, kind)
  return embedLocally(texts, kind)
}

/** A search question's vector with its model tag, under the same rule. */
export async function gatedEmbedQueryTagged(
  text: string
): Promise<{ vector: number[]; model: string } | null> {
  const r = await gatedEmbedTexts([text], 'query')
  return r.ok && r.vectors[0] ? { vector: r.vectors[0], model: r.model } : null
}

/**
 * The model tag the GATED route would write right now, without embedding
 * anything: the live route when background AI is allowed, otherwise the local
 * embedder only (or null when there is none). Reindexers compare stored vectors
 * against this to find stale ones, and coverage counts what this route can
 * actually compare. It must agree with gatedEmbedTexts, or a backfill with
 * Background AI tasks off would treat local vectors as stale while the gate
 * refuses the cloud route that would replace them. Never throws.
 */
export async function gatedActiveEmbedModel(): Promise<string | null> {
  if (backgroundModelAllowed()) return activeEmbedModel().catch(() => null)
  try {
    const m = (await localModelStatus()).embedModel
    return m ? (m.startsWith('local:') ? m : `ollama:${m}`) : null
  } catch {
    return null
  }
}
