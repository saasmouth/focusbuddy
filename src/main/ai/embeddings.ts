// Text embeddings via OpenAI, the model side of the semantic-retrieval
// foundation. Key-gated exactly like Whisper transcription: with an OpenAI key
// configured, text becomes vectors; without one, the caller falls back to
// keyword search and nothing is faked. The model is small and cheap
// (text-embedding-3-small, 1536 dims). A local embedding model can replace this
// later without changing callers, the contract is just "texts in, vectors out".

import { resolveOpenAIKey } from '../settingsStore'
import { localEmbed, localModelStatus } from './localModel'
import { localOnlyActive } from './local/providerRouter'

export const EMBED_MODEL = 'text-embedding-3-small'

export type EmbedResult =
  | { ok: true; vectors: number[][]; model: string }
  | { ok: false; reason: 'no_key' | 'api' | 'network'; error?: string }

// `kind` matters only to the bundled embedder (nomic-embed), which is trained
// with different prefixes for passages and for search queries.
export async function embedTexts(texts: string[], kind: 'document' | 'query' = 'document'): Promise<EmbedResult> {
  if (texts.length === 0) return { ok: true, vectors: [], model: EMBED_MODEL }
  // Prefer the LOCAL embedder (Ollama): free, private, no key. This lights up
  // semantic search the moment a local embedding model is installed, with no
  // cloud key at all. The model name is tagged so a later dimension guard can
  // tell local vectors from cloud ones and skip mismatches. Falls through to
  // OpenAI, then to the honest no_key fallback (keyword search) when neither is
  // available — nothing is faked.
  const local = await localEmbed(texts, kind)
  if (local && local.vectors.length === texts.length) {
    // The bundled embedder already names itself `local:<model>`; an Ollama
    // model is tagged so the two never compare vectors with each other.
    const model = local.model.startsWith('local:') ? local.model : `ollama:${local.model}`
    return { ok: true, vectors: local.vectors, model }
  }
  // AI set to run on this device: text never goes to OpenAI for vectors. With
  // no local embedder, retrieval stays keyword search, which is honest and
  // already disclosed in the coverage panel.
  if (localOnlyActive()) return { ok: false, reason: 'no_key' }
  const key = resolveOpenAIKey()
  if (!key) return { ok: false, reason: 'no_key' }
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts })
    })
    if (!res.ok) return { ok: false, reason: 'api', error: `HTTP ${res.status}` }
    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] }
    // The API may return out of order; restore the input order by index.
    const vectors = [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding)
    return { ok: true, vectors, model: EMBED_MODEL }
  } catch (e) {
    return { ok: false, reason: 'network', error: String(e) }
  }
}

export async function embedQuery(text: string): Promise<number[] | null> {
  const r = await embedTexts([text], 'query')
  return r.ok && r.vectors[0] ? r.vectors[0] : null
}

// The query vector WITH its model tag, for retrieval routes that must never
// compare vectors across embedding models (384-dim local and 1536-dim OpenAI
// never mix; the stored row's model tag is the guard, not just the dimension —
// two different 384-dim local models would otherwise collide silently).
export async function embedQueryTagged(
  text: string
): Promise<{ vector: number[]; model: string } | null> {
  const r = await embedTexts([text], 'query')
  return r.ok && r.vectors[0] ? { vector: r.vectors[0], model: r.model } : null
}

// Whether ANY embedding route is configured — a local embed model, or an
// OpenAI key. An availability probe for honest disclosure (defect #15: with
// neither, retrieval is literal keyword matching and nothing ever said so).
// Probes only; never embeds anything. Never throws.
export async function embeddingConfigured(): Promise<boolean> {
  if (resolveOpenAIKey() && !localOnlyActive()) return true
  try {
    return (await localModelStatus()).embedModel !== null
  } catch {
    return false
  }
}
