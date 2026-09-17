// Block-level ephemeral prompt-cache helpers.
//
// Prompt caching is GA on the /v1/messages endpoint. SDK 0.32.1 only types
// `cache_control` under its beta namespace, but the stable client forwards the
// field on the request body and the endpoint honours it — verified live: a
// repeated prefix reports cache_read_input_tokens > 0 with no beta header. We
// build the blocks here (typed locally) and cast once at each call site, so the
// rest of the code stays clean.
//
// The rule these helpers encode: put the large, stable content first as a
// cacheable prefix and the varying content (the user's question, per-turn
// retrieval, timestamps) last as plain blocks. Anthropic caches everything up to
// and including the cacheable block; a later request with an identical prefix
// reads it at ~10% of the input price. Content below the model's token minimum
// simply isn't cached (no error, no cost).

import { MODEL_HAIKU, MODEL_OPUS, MODEL_SONNET } from './modelRouting'

// The minimum prefix each model will cache at all, in tokens.
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching —
// checked 2026-09-15.
//
// This lives in production code, not in a test, because the trap is that it is
// NOT monotonic across generations: Haiku 4.5 needs 4096 tokens while the newer
// Opus 5 needs only 512. Anyone reasoning "the newer model is cheaper and
// smaller-minimum" gets it backwards. A prefix under the minimum is not an
// error and costs nothing — it simply never caches, so a cost estimate that
// assumes caching can be wrong with nothing on screen to show for it.
//
// Keyed off the router's own constants rather than literal model ids, so that
// migrating a model updates this table for free instead of leaving a stale
// minimum keyed to an id nothing uses any more — and so the "no model id
// outside modelRouting" guard stays honest.
export const CACHE_MINIMUM: Record<string, number> = {
  [MODEL_OPUS]: 512,
  [MODEL_SONNET]: 1024,
  [MODEL_HAIKU]: 4096
}

/** The cache minimum for a model, defaulting to the largest known minimum when
 *  the model is unrecognised — the conservative direction, since it means
 *  "assume this will not cache" rather than promising a saving that may not
 *  arrive. */
export function cacheMinimumFor(model: string): number {
  return CACHE_MINIMUM[model] ?? Math.max(...Object.values(CACHE_MINIMUM))
}

export interface CacheTextBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

const EPHEMERAL = { type: 'ephemeral' as const }

// A cacheable text block: marks the end of a reusable prefix.
export function cacheable(text: string): CacheTextBlock {
  return { type: 'text', text, cache_control: EPHEMERAL }
}

// A plain (uncached) text block: the varying suffix.
export function plain(text: string): CacheTextBlock {
  return { type: 'text', text }
}

// Build a system value with a cached stable prefix and an uncached dynamic
// suffix. An empty suffix yields a single cached block; an empty prefix yields a
// single plain block. Returns [] for all-empty so the caller can fall back.
export function cachedSystem(stablePrefix: string, dynamicSuffix = ''): CacheTextBlock[] {
  const blocks: CacheTextBlock[] = []
  if (stablePrefix) blocks.push(cacheable(stablePrefix))
  if (dynamicSuffix) blocks.push(plain(dynamicSuffix))
  return blocks
}

// Build a user message content array whose large context is cached and whose
// varying tail (question, conversation) is not. If the context is empty, returns
// a single plain block so short prompts behave exactly as before.
export function cachedUserContent(context: string, tail: string): CacheTextBlock[] {
  if (!context.trim()) return [plain(tail)]
  return [cacheable(context), plain(tail)]
}

// Read the cache token fields off a response usage object. SDK 0.32.1's stable
// Usage type doesn't declare them, but the endpoint returns them, so we read them
// defensively rather than fight the types. Returns zeros when absent.
export function cacheTokens(usage: unknown): { read: number; write: number } {
  const u = usage as
    | { cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
    | null
    | undefined
  return { read: u?.cache_read_input_tokens ?? 0, write: u?.cache_creation_input_tokens ?? 0 }
}

// Mark the end of a conversation's stable prefix so the API can serve it from
// cache on the next round.
//
// `cachedSystem` above caches a system prompt, which is stable by nature. This
// handles the harder case: a MESSAGE list that grows a round at a time, where
// everything up to some index is guaranteed identical to last round's request.
// Marking that index means the next round reads the whole prefix at ~10% of
// the input price and pays full price only for what is new.
//
// The caller owns the guarantee — pass the index of the last message that will
// never change again, or -1 to mark nothing. Marking a message that later
// differs is not an error, it simply misses.
export function withCacheBreakpoint<M extends { role: string; content: unknown }>(
  messages: M[],
  index: number
): M[] {
  if (index < 0 || index >= messages.length) return messages
  return messages.map((m, i) => {
    if (i !== index) return m
    // A plain-string message becomes a single cacheable text block.
    if (typeof m.content === 'string') {
      if (!m.content) return m
      return { ...m, content: [cacheable(m.content)] }
    }
    // A block list gets the marker on its LAST block: the cache covers
    // everything up to and including the marked block.
    if (Array.isArray(m.content) && m.content.length > 0) {
      const blocks = [...(m.content as Array<Record<string, unknown>>)]
      const last = blocks[blocks.length - 1]
      // Only text blocks take a breakpoint cleanly; an image tail is left
      // alone rather than risking a malformed request to save a few tokens.
      if (last && last.type === 'text') {
        blocks[blocks.length - 1] = { ...last, cache_control: EPHEMERAL }
        return { ...m, content: blocks }
      }
    }
    return m
  })
}
