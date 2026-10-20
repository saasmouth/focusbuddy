// The on-device model engine: one GGUF model loaded through node-llama-cpp
// (llama.cpp — Metal on Apple Silicon, CPU on Intel Macs, CPU/Vulkan/CUDA on
// Windows). Pure Node, no Electron: it runs inside the local-AI utility process
// in the app (localWorker.ts), and in-process in the eval harness and tests, so
// the code that is measured is the code that ships.
//
// What it guarantees:
//   - Nothing leaves the machine. node-llama-cpp is created with
//     `build: 'never'` and `usePrebuiltBinaries: true`, so it never tries to
//     download or compile a binary at runtime; the model is a file on disk.
//   - One request at a time. A small model on a laptop has one GPU; running two
//     generations at once would halve both and double memory. Requests queue.
//   - Honest limits. A prompt that does not fit the context window is refused
//     with stopReason 'model_context_window_exceeded' (the same string the
//     cloud path reports, which every call site already explains), rather than
//     silently truncated. A cut-off answer reports 'max_tokens'.
//   - Cancel. An AbortSignal stops generation; whatever streamed is kept and
//     the result says 'aborted'.

import type {
  Llama,
  LlamaModel,
  LlamaContext,
  LlamaContextSequence,
  ChatHistoryItem,
  ChatWrapper,
  LlamaGrammar
} from 'node-llama-cpp'
import { JSON_OBJECT_GBNF, JSON_ARRAY_GBNF } from './jsonGrammars'

export interface EngineMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface EngineGenerateRequest {
  system: string
  messages: EngineMessage[]
  maxTokens: number
  /** Sampling temperature; defaults to 0.2 (small models drift when hot). */
  temperature?: number
  /** Constrain output to syntactically valid JSON of this shape (llama.cpp grammar). */
  json?: 'object' | 'array' | false
}

export type EngineStopReason = 'end_turn' | 'max_tokens' | 'aborted' | 'model_context_window_exceeded'

export interface EngineGenerateResult {
  text: string
  inputTokens: number
  outputTokens: number
  stopReason: EngineStopReason
  ttftMs: number | null
  totalMs: number
}

export interface EngineLoadOptions {
  modelPath: string
  /** Context window in tokens. Bounded by RAM; the catalog picks it per tier. */
  contextSize: number
  /** Force CPU (e.g. a Mac whose GPU cannot take the model). Default: auto. */
  gpu?: 'auto' | false
  /**
   * KV-cache precision. 'q8_0' halves the cache's memory (about 1.2 GB instead
   * of 2.4 GB for a 4B model at 16K tokens) at a negligible quality cost; it is
   * what the catalog ships and what the eval measured. Default 'f16'.
   */
  kvCache?: 'f16' | 'q8_0'
}

export interface EngineStatus {
  loaded: boolean
  modelPath: string | null
  contextSize: number | null
  gpu: string | false | null
  loadMs: number | null
  /** Where load time went: runtime start (incl. GPU backend), model read, context, grammars. */
  loadBreakdownMs?: { runtime: number; model: number; context: number; grammars: number } | null
}

/** The surface every consumer (adapter, worker, eval) depends on. */
export interface LocalEngine {
  generate(
    req: EngineGenerateRequest,
    opts?: { signal?: AbortSignal; onText?: (delta: string) => void }
  ): Promise<EngineGenerateResult>
}

type NlcModule = typeof import('node-llama-cpp')

// node-llama-cpp is ESM-only; a dynamic import works from the CJS main bundle
// and keeps the (large) native module off the startup path entirely — it is
// only touched the first time a local request arrives.
let nlcPromise: Promise<NlcModule> | null = null
function nlc(): Promise<NlcModule> {
  if (!nlcPromise) nlcPromise = import('node-llama-cpp')
  return nlcPromise
}

export class EngineCore implements LocalEngine {
  private llama: Llama | null = null
  private model: LlamaModel | null = null
  private context: LlamaContext | null = null
  private sequence: LlamaContextSequence | null = null
  private jsonGrammar: LlamaGrammar | null = null
  private jsonArrayGrammar: LlamaGrammar | null = null
  private chatWrapper: ChatWrapper | null = null
  private loadedPath: string | null = null
  private loadMs: number | null = null
  private loadBreakdown: EngineStatus['loadBreakdownMs'] = null
  private queue: Promise<unknown> = Promise.resolve()

  status(): EngineStatus {
    return {
      loaded: this.model !== null,
      modelPath: this.loadedPath,
      contextSize: this.context?.contextSize ?? null,
      gpu: this.llama ? this.llama.gpu : null,
      loadMs: this.loadMs,
      loadBreakdownMs: this.loadBreakdown
    }
  }

  async load(opts: EngineLoadOptions): Promise<EngineStatus> {
    if (this.model && this.loadedPath === opts.modelPath) return this.status()
    await this.unload()
    const t0 = Date.now()
    const { getLlama } = await nlc()
    this.llama = await getLlama({
      gpu: opts.gpu === false ? false : 'auto',
      build: 'never',
      usePrebuiltBinaries: true,
      progressLogs: false,
      logLevel: 'error' as never
    })
    const tRuntime = Date.now()
    this.model = await this.llama.loadModel({ modelPath: opts.modelPath })
    const tModel = Date.now()
    this.context = await this.model.createContext({
      contextSize: { max: opts.contextSize },
      flashAttention: true,
      ...(opts.kvCache === 'q8_0' ? { experimentalKvCacheKeyType: 'Q8_0', experimentalKvCacheValueType: 'Q8_0' } : {})
    })
    const tContext = Date.now()
    this.sequence = this.context.getSequence()
    // Thinking off IN THE TEMPLATE (Qwen's empty <think></think>, Gemma 4's
    // reasoning switch), not by a token budget. A budget of zero still lets the
    // model emit one token into the thought segment before it is closed, and
    // under a JSON grammar that token is the opening "{" — the visible output
    // then starts mid-structure (measured: an object whose key was the whole
    // escaped answer). The app's prompts ask for the answer itself.
    const { resolveChatWrapper } = await nlc()
    this.chatWrapper = resolveChatWrapper({
      fileInfo: this.model.fileInfo,
      tokenizer: this.model.tokenizer,
      customWrapperSettings: { qwen: { thoughts: 'discourage' }, gemma4: { reasoning: false } }
    })
    // From embedded text, not llama.getGrammarFor(): that reads node-llama-cpp's
    // grammars folder, which it cannot find from inside the packaged app's asar.
    // Same options getGrammarFor applies (see jsonGrammars.ts).
    this.jsonGrammar = await this.llama.createGrammar({
      grammar: JSON_OBJECT_GBNF,
      stopGenerationTriggers: ['\n\n\n\n'],
      trimWhitespaceSuffix: true
    })
    this.jsonArrayGrammar = await this.llama.createGrammar({
      grammar: JSON_ARRAY_GBNF,
      stopGenerationTriggers: ['\n\n\n\n'],
      trimWhitespaceSuffix: true
    })
    this.loadedPath = opts.modelPath
    const tEnd = Date.now()
    this.loadMs = tEnd - t0
    this.loadBreakdown = { runtime: tRuntime - t0, model: tModel - tRuntime, context: tContext - tModel, grammars: tEnd - tContext }
    return this.status()
  }

  async unload(): Promise<void> {
    const ctx = this.context
    const model = this.model
    const llama = this.llama
    this.sequence = null
    this.context = null
    this.model = null
    this.llama = null
    this.jsonGrammar = null
    this.jsonArrayGrammar = null
    this.chatWrapper = null
    this.loadedPath = null
    try {
      await ctx?.dispose()
      await model?.dispose()
      await llama?.dispose()
    } catch {
      /* disposal failures leave nothing for the caller to act on */
    }
  }

  countTokens(text: string): number {
    if (!this.model) throw new Error('No local model is loaded.')
    return this.model.tokenize(text).length
  }

  generate(
    req: EngineGenerateRequest,
    opts: { signal?: AbortSignal; onText?: (delta: string) => void } = {}
  ): Promise<EngineGenerateResult> {
    // Serialise: chain onto the queue, and never let one failure poison it.
    const run = this.queue.then(() => this.generateNow(req, opts))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async generateNow(
    req: EngineGenerateRequest,
    opts: { signal?: AbortSignal; onText?: (delta: string) => void }
  ): Promise<EngineGenerateResult> {
    const t0 = Date.now()
    if (!this.model || !this.context || !this.sequence) throw new Error('No local model is loaded.')
    if (opts.signal?.aborted) {
      return { text: '', inputTokens: 0, outputTokens: 0, stopReason: 'aborted', ttftMs: null, totalMs: 0 }
    }
    const { LlamaChatSession } = await nlc()

    const turns = normaliseTurns(req.messages)
    const last = turns[turns.length - 1]
    if (!last || last.role !== 'user') throw new Error('A local request must end with a user message.')
    const history: ChatHistoryItem[] = [{ type: 'system', text: req.system }]
    for (const t of turns.slice(0, -1)) {
      history.push(t.role === 'user' ? { type: 'user', text: t.content } : { type: 'model', response: [t.content] })
    }

    // Fit check. The chat template adds a little per turn; 64 tokens per turn
    // plus a fixed 32 is a deliberate over-estimate so the refusal errs early.
    const promptText = req.system + '\n' + turns.map((t) => t.content).join('\n')
    const inputTokens = this.model.tokenize(promptText).length + 32 + 64 * turns.length
    const ctxSize = this.context.contextSize
    const room = ctxSize - inputTokens
    if (room < 64) {
      return {
        text: '',
        inputTokens,
        outputTokens: 0,
        stopReason: 'model_context_window_exceeded',
        ttftMs: null,
        totalMs: Date.now() - t0
      }
    }
    const maxTokens = Math.max(1, Math.min(req.maxTokens, room))

    // A fresh session over the SAME sequence: llama.cpp keeps the evaluated
    // tokens of the sequence, and node-llama-cpp re-evaluates only what differs
    // from them, so a follow-up turn with the same long system prompt starts in
    // well under a second instead of re-reading the prompt.
    const session = new LlamaChatSession({
      contextSequence: this.sequence,
      autoDisposeSequence: false,
      ...(this.chatWrapper ? { chatWrapper: this.chatWrapper } : {})
    })
    session.setChatHistory(history)

    let text = ''
    let first = 0
    try {
      const res = await session.promptWithMeta(last.content, {
        maxTokens,
        temperature: req.temperature ?? 0.2,
        minP: 0.05,
        topP: 0.9,
        repeatPenalty: { penalty: 1.05, lastTokens: 128 },
        // Belt and braces for a model whose template ignores the switch above:
        // never spend the answer's budget on hidden reasoning.
        budgets: { thoughtTokens: 0 },
        ...(req.json === 'object' && this.jsonGrammar ? { grammar: this.jsonGrammar } : {}),
        ...(req.json === 'array' && this.jsonArrayGrammar ? { grammar: this.jsonArrayGrammar } : {}),
        signal: opts.signal,
        stopOnAbortSignal: true,
        onTextChunk: (chunk: string) => {
          if (!first) first = Date.now()
          text += chunk
          opts.onText?.(chunk)
        }
      })
      const finalText = res.response.filter((x): x is string => typeof x === 'string').join('')
      if (finalText.length >= text.length) text = finalText
      const outputTokens = this.model.tokenize(text).length
      const stopReason: EngineStopReason = opts.signal?.aborted
        ? 'aborted'
        : res.stopReason === 'maxTokens'
          ? 'max_tokens'
          : res.stopReason === 'abort'
            ? 'aborted'
            : 'end_turn'
      return { text, inputTokens, outputTokens, stopReason, ttftMs: first ? first - t0 : null, totalMs: Date.now() - t0 }
    } catch (e) {
      if (opts.signal?.aborted) {
        return {
          text,
          inputTokens,
          outputTokens: text ? this.model.tokenize(text).length : 0,
          stopReason: 'aborted',
          ttftMs: first ? first - t0 : null,
          totalMs: Date.now() - t0
        }
      }
      throw e
    } finally {
      session.dispose({ disposeSequence: false })
    }
  }
}

/**
 * Merge consecutive same-role turns (the chat template expects alternation) and
 * drop empty ones. Exported for tests.
 */
export function normaliseTurns(messages: EngineMessage[]): EngineMessage[] {
  const out: EngineMessage[] = []
  for (const m of messages) {
    const content = m.content
    if (!content.trim()) continue
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role) prev.content += '\n\n' + content
    else out.push({ role: m.role, content })
  }
  return out
}

// ── Embeddings ──────────────────────────────────────────────────────────────
//
// Text → vectors for PlexiiBrain's semantic search, on the device, with a small
// dedicated embedding model (nomic-embed-text-v1.5). It is a separate model
// from the chat model on purpose: an LLM's hidden states are poor retrieval
// vectors, and this one is 146 MB and fast on CPU.
//
// nomic-embed is trained with task prefixes; documents and queries get
// different ones, which is why embed() takes a kind.

export type EmbedKind = 'document' | 'query'

export class EmbedCore {
  private llama: Llama | null = null
  private model: LlamaModel | null = null
  private ctx: Awaited<ReturnType<LlamaModel['createEmbeddingContext']>> | null = null
  private loadedPath: string | null = null
  private queue: Promise<unknown> = Promise.resolve()

  async load(modelPath: string): Promise<void> {
    if (this.model && this.loadedPath === modelPath) return
    await this.unload()
    const { getLlama } = await nlc()
    this.llama = await getLlama({ gpu: 'auto', build: 'never', usePrebuiltBinaries: true, progressLogs: false, logLevel: 'error' as never })
    this.model = await this.llama.loadModel({ modelPath })
    this.ctx = await this.model.createEmbeddingContext({ contextSize: 2048 })
    this.loadedPath = modelPath
  }

  loaded(): boolean {
    return this.ctx !== null
  }

  async unload(): Promise<void> {
    const ctx = this.ctx
    const model = this.model
    this.ctx = null
    this.model = null
    this.llama = null
    this.loadedPath = null
    try {
      await ctx?.dispose()
      await model?.dispose()
    } catch {
      /* nothing for the caller to act on */
    }
  }

  embed(texts: string[], kind: EmbedKind = 'document'): Promise<number[][]> {
    const run = this.queue.then(async () => {
      if (!this.ctx || !this.model) throw new Error('No local embedding model is loaded.')
      const prefix = kind === 'query' ? 'search_query: ' : 'search_document: '
      const out: number[][] = []
      for (const t of texts) {
        // Keep well inside the 2048-token window; the head of a passage is
        // what retrieval ranks on anyway.
        const tokens = this.model.tokenize(prefix + t)
        const text = tokens.length > 2000 ? this.model.detokenize(tokens.slice(0, 2000)) : prefix + t
        const e = await this.ctx.getEmbeddingFor(text)
        out.push([...e.vector])
      }
      return out
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}
