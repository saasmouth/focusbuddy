// The "Background AI tasks" gate (Settings > Data > Privacy, privacyPrefs.ts).
//
// Two jobs send the person's own content to an AI provider with no click:
//
//   - title backfill (titleBackfill.ts), 12 s after every launch: up to 40
//     untitled items, 400 characters of each, in one request to Anthropic with
//     the person's own key;
//   - embeddings (documentRetrieval.ts, semanticRetrieval.ts): every saved
//     document and knowledge entry, and a sweep 45 s after launch then every
//     5 minutes, sent to OpenAI's embeddings API with the person's own key, so
//     search can match meaning rather than words. Search questions are embedded
//     the same way.
//
// Neither may reach a cloud provider unless the person turned Background AI
// tasks on. Work that stays on this computer is not gated: titles derived from
// an item's own text, and embeddings from a local model (Ollama today; the
// the bundled model, see `setLocalRouting`).
//
// The gate sits at the call sites (index.ts and the two retrieval modules), not
// inside src/main/ai/*, which the local-ai branch owns.

import { backgroundAiEnabled } from './privacyPrefs'
import { embedTexts, type EmbedResult } from './ai/embeddings'
import { localEmbed } from './ai/localModel'

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
 */
export function backgroundModelAllowed(): boolean {
  return backgroundAiEnabled() || localRouting()
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
