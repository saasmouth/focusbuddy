// Local model client. Two engines, in this order:
//
//   1. The BUNDLED engine — the on-device model the app downloads and runs
//      itself (Settings → AI → Local on this device; src/main/ai/local/). This
//      is the default and needs nothing installed.
//   2. Ollama, as an advanced fallback — for anyone who already runs a local
//      Ollama server and has no bundled model downloaded. It is reached only on
//      localhost (or wherever FB_OLLAMA_URL points), never a cloud service.
//
// These power the jobs that were always meant to be private and free:
// document enrichment (descriptions for retrieval), memory sweeps, and — when
// an embedding model is present — semantic search vectors.
//
// Everything degrades honestly: with neither engine available, callers get
// null / an "unavailable" result and NOTHING is faked.

import { getLocalRuntime } from './local/providerRouter'
import { runLocal } from './local/localClient'

const BASE = (process.env.FB_OLLAMA_URL ?? 'http://localhost:11434').replace(/\/$/, '')

interface OllamaModel {
  name: string
  capabilities?: string[]
}

// Short cache so a burst of enrichments doesn't re-hit /api/tags each time.
let modelCache: { at: number; models: OllamaModel[] } | null = null
const CACHE_MS = 30_000

async function fetchJson(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<unknown | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function listModels(): Promise<OllamaModel[]> {
  const now = Date.now()
  if (modelCache && now - modelCache.at < CACHE_MS) return modelCache.models
  const json = (await fetchJson('/api/tags', undefined, 3_000)) as
    | { models?: Array<{ name?: string; model?: string; capabilities?: string[] }> }
    | null
  const models: OllamaModel[] = (json?.models ?? [])
    .map((m) => ({ name: m.name ?? m.model ?? '', capabilities: m.capabilities }))
    .filter((m) => m.name.length > 0)
  modelCache = { at: now, models }
  return models
}

const EMBED_HINT = /embed|nomic|bge|minilm|gte|mxbai|e5\b/i
const CHAT_HINT = /qwen|llama|mistral|mixtral|phi|gemma|sparky|deepseek|command/i

function isEmbedModel(m: OllamaModel): boolean {
  if (m.capabilities?.includes('embedding')) return true
  return EMBED_HINT.test(m.name)
}

function pickChatModel(models: OllamaModel[]): string | null {
  if (process.env.FB_OLLAMA_CHAT_MODEL) return process.env.FB_OLLAMA_CHAT_MODEL
  const chatable = models.filter((m) => !isEmbedModel(m))
  if (chatable.length === 0) return null
  // Prefer a known chat family; otherwise take the first non-embedding model.
  return (chatable.find((m) => CHAT_HINT.test(m.name)) ?? chatable[0]).name
}

function pickEmbedModel(models: OllamaModel[]): string | null {
  if (process.env.FB_OLLAMA_EMBED_MODEL) return process.env.FB_OLLAMA_EMBED_MODEL
  const embed = models.filter(isEmbedModel)
  return embed[0]?.name ?? null
}

export interface LocalModelStatus {
  available: boolean
  baseUrl: string
  chatModel: string | null
  embedModel: string | null
}

// Snapshot of what's usable right now — drives honest UI ("local AI not running")
// and lets callers skip work when nothing is installed.
export async function localModelStatus(): Promise<LocalModelStatus> {
  const bundled = getLocalRuntime()
  const bundledChat = bundled.installed() ? `local:${bundled.modelLabel()}` : null
  const bundledEmbed = bundledEmbedder?.installed() ? `local:${bundledEmbedder.label()}` : null
  // Only ask Ollama when the bundled engine leaves a gap; a closed port costs a
  // 3 s timeout otherwise.
  const models = bundledChat && bundledEmbed ? [] : await listModels()
  return {
    available: bundledChat !== null || models.length > 0,
    baseUrl: bundledChat ? 'on this device' : BASE,
    chatModel: bundledChat ?? pickChatModel(models),
    embedModel: bundledEmbed ?? pickEmbedModel(models)
  }
}

// The bundled embedder (an embedding GGUF run by the same engine). Registered
// by the app at start-up; absent in tests unless a test registers one.
export interface BundledEmbedder {
  installed: () => boolean
  label: () => string
  embed: (texts: string[], kind?: 'document' | 'query') => Promise<number[][]>
}
let bundledEmbedder: BundledEmbedder | null = null
export function setBundledEmbedder(e: BundledEmbedder | null): void {
  bundledEmbedder = e
}

// One chat turn. `format: 'json'` asks Ollama to constrain output to valid JSON,
// which is what the enrichment prompt relies on. Returns the assistant text, or
// null if the server is down / has no chat model / times out. Never throws.
export async function localChat(input: {
  system?: string
  prompt: string
  json?: boolean
  timeoutMs?: number
  /** Which job this is, for the bundled engine's output contract and gate. */
  purpose?: string
}): Promise<string | null> {
  const bundled = getLocalRuntime()
  if (bundled.installed()) {
    try {
      const msg = await runLocal(bundled, {
        model: `local:${input.purpose ?? 'enrichment'}`,
        max_tokens: 2048,
        system: input.system ?? '',
        messages: [{ role: 'user', content: input.prompt }]
      })
      const text = msg.content.map((b) => ('text' in b ? b.text : '')).join('')
      return msg.stop_reason === 'end_turn' && text.trim() ? text : null
    } catch {
      return null
    }
  }
  const model = pickChatModel(await listModels())
  if (!model) return null
  const messages: Array<{ role: string; content: string }> = []
  if (input.system) messages.push({ role: 'system', content: input.system })
  messages.push({ role: 'user', content: input.prompt })
  const json = (await fetchJson(
    '/api/chat',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        ...(input.json ? { format: 'json' } : {}),
        options: { temperature: 0.1 }
      })
    },
    input.timeoutMs ?? 180_000
  )) as { message?: { content?: string } } | null
  const content = json?.message?.content
  return typeof content === 'string' && content.trim().length > 0 ? content : null
}

// Embed one or more texts locally. Returns the vectors plus the model that made
// them (so callers can keep the vector store dimension-consistent), or null when
// no embedding model is available / the server is down. Never throws.
export async function localEmbed(
  texts: string[],
  kind: 'document' | 'query' = 'document'
): Promise<{ model: string; vectors: number[][] } | null> {
  if (texts.length === 0) return { model: '', vectors: [] }
  if (bundledEmbedder?.installed()) {
    try {
      const vectors = await bundledEmbedder.embed(texts, kind)
      if (vectors.length === texts.length) return { model: `local:${bundledEmbedder.label()}`, vectors }
    } catch {
      /* fall through to Ollama, then to the caller's honest fallback */
    }
  }
  const model = pickEmbedModel(await listModels())
  if (!model) return null
  const json = (await fetchJson(
    '/api/embed',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts })
    },
    60_000
  )) as { embeddings?: number[][] } | null
  const vectors = json?.embeddings
  if (!Array.isArray(vectors) || vectors.length !== texts.length) return null
  return { model, vectors }
}
