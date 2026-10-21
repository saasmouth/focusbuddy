// An Anthropic-Messages-shaped client over the on-device model.
//
// Every AI feature in the app talks to one shape — `client.messages.create(…)`
// and `client.messages.stream(…)` from the Anthropic SDK — obtained from one
// seam (getClient in anthropic.ts, getModelClient in modelClient.ts). This
// module implements exactly the subset of that shape the app uses, on top of
// the local engine, so the ~70 call sites run locally without each learning a
// second API. Their own parsers and honest-failure messages then apply to local
// output unchanged, which is also what makes the eval harness meaningful: it
// measures the product's real prompt → parse path, not a reimplementation.
//
// What is deliberately NOT emulated:
//   - tools / tool_use: the one call site that uses native tools (the desk
//     agent's browser tools) is an agent feature the local model fails; it is
//     refused here with a LocalUnsupportedError rather than half-run.
//   - images and documents in content: the shipped models are text-only. A
//     request carrying one is refused, never answered as if it had been seen.
//
// Structured output: when the prompt demands JSON, generation is constrained to
// valid JSON by a llama.cpp grammar, then validated (per purpose where the
// contract is known) and retried ONCE with the validation error. If the retry
// still fails, the text is returned as-is and the call site's own parser fails
// honestly ("came back in a shape I could not read") — nothing is invented.

import type Anthropic from '@anthropic-ai/sdk'
import type { EngineGenerateResult, EngineMessage, LocalEngine } from './engineCore'
import { isContentWriting, withSmallRule, suppliedText, reviewOutput, type ReviewResult } from './groundingCheck'
import { parseStructured, contractFor } from './structuredOutput'

export class LocalUnsupportedError extends Error {
  constructor(
    public readonly what: 'tools' | 'images' | 'documents',
    message?: string
  ) {
    super(
      message ??
        (what === 'tools'
          ? 'This needs tool use, which the on-device model does not support. Use cloud AI for it.'
          : what === 'images'
            ? 'The on-device model cannot read images. Use cloud AI to include an image.'
            : 'The on-device model cannot read attached files directly. Use cloud AI for this.')
    )
    this.name = 'LocalUnsupportedError'
  }
}

/** The purpose a `local:<purpose>` model id names, or 'generic'. */
export function purposeOfModel(model: unknown): string {
  if (typeof model === 'string' && model.startsWith('local:')) return model.slice(6) || 'generic'
  return 'generic'
}

// ── JSON intent ─────────────────────────────────────────────────────────────

const JSON_NEGATIVE = /\b(no|not|never|without)\s+(a\s+)?JSON\b/i
const JSON_POSITIVE =
  /\b(return|respond|reply|output|answer)\b[^.\n]{0,60}\bJSON\b|\bJSON only\b|\bvalid JSON\b|\bstrict JSON\b|\bsingle (valid )?JSON\b|\bJSON object\b|\bJSON array\b/i

/**
 * What output shape the prompt demands: 'object', 'array' or null for prose.
 * A prompt that says "no JSON" anywhere wants prose, whatever else it says.
 * Exported for tests.
 */
export function jsonIntent(system: string, lastUser: string): 'object' | 'array' | null {
  const text = `${system}\n${lastUser}`
  if (JSON_NEGATIVE.test(text)) return null
  if (!JSON_POSITIVE.test(text)) return null
  const saysArray = /\bJSON array\b|start with \[/i.test(text)
  const saysObject = /\bJSON object\b|first character (must be|of your reply is) \{|"\w+"\s*:/i.test(text)
  return saysArray && !saysObject ? 'array' : 'object'
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate model text against the demanded JSON shape and the CALL's contract
 * (structuredOutput.ts). Returns an error or null. Exported for tests; `system`
 * identifies the contract (without it only the shape is checked).
 */
export function validateJsonOutput(text: string, shape: 'object' | 'array', purpose: string, system = ''): string | null {
  const r = parseStructured(text, shape, purpose, system)
  return r.ok ? null : r.problem
}

// ── Schema-constrained decoding ─────────────────────────────────────────────
//
// For the contracts whose shape is fixed, the output is constrained by a JSON
// schema (compiled to a llama.cpp grammar), not just "some JSON": field names,
// their order, and — for the chat envelope — the action kinds themselves. The
// allowed kinds are read from the system prompt the call site sent (the catalog
// of `"kind":"…"` examples the model is shown), so this never keeps its own copy
// of the prompt's vocabulary. Unknown contracts keep the generic JSON grammar.

const ANY = { type: 'object', additionalProperties: true } as const

/** The kinds a prompt's catalog demonstrates, e.g. "kind":"create-table". */
export function kindsFromPrompt(system: string): string[] {
  return [...new Set([...system.matchAll(/"kind"\s*:\s*"([a-z][a-z0-9-]*)"/g)].map((m) => m[1]))]
}

/** The JSON schema to constrain a purpose's output to, or null for generic JSON. Exported for tests. */
export function schemaFor(purpose: string, system: string): Record<string, unknown> | null {
  if (purpose === 'chat' || purpose === 'welcome') {
    // PlexiiBrain's grounded answer shares the chat purpose.
    if (/"answer"\s*:/.test(system) && /"sources"\s*:/.test(system)) {
      return {
        type: 'object',
        properties: { answer: { type: 'string' }, sources: { type: 'array', items: { type: 'integer' } } }
      }
    }
    if (!/"reply"/.test(system)) return null
    const kinds = kindsFromPrompt(system)
    const action =
      kinds.length > 0
        ? { type: 'object', properties: { kind: { enum: kinds } }, additionalProperties: true }
        : ANY
    // reply first, then actions (the stream consumer relies on that order);
    // the optional question / blocks protocols may follow.
    return {
      type: 'object',
      properties: { reply: { type: 'string' }, actions: { type: 'array', items: action } },
      additionalProperties: true
    }
  }
  // Every other recognised contract carries its own structure-only schema.
  return (contractFor(purpose, system)?.schema as Record<string, unknown> | undefined) ?? null
}

// ── Small-model prompt variants ─────────────────────────────────────────────
//
// Additions the local path makes to a request for the on-device model only. A
// variant may ADD context a small model needs spelled out; it never rewrites or
// drops the call site's instructions (those belong to the prompt owners in
// anthropic.ts). Each is measured by tools/local-ai-eval before it is on.

export interface PromptVariant {
  id: string
  /** Applies to these purposes. */
  purposes: string[]
  /** Text appended to the system prompt. */
  addendum: (now: Date) => string
}

const DAY = 86_400_000
const isoDay = (d: Date): string => d.toISOString().slice(0, 10)

export const PROMPT_VARIANTS: PromptVariant[] = [
  {
    // Measured: the 4B model put "tomorrow at 3pm" in 2024. The clock line is
    // there; small models do not reliably do the date arithmetic from it.
    id: 'explicit-dates',
    purposes: ['chat', 'welcome', 'agent_step'],
    addendum: (now) =>
      `Dates, already worked out (UTC): today is ${isoDay(now)}, tomorrow is ${isoDay(new Date(now.getTime() + DAY))}. ` +
      `The current year is ${now.getUTCFullYear()}. Use these for any startMs, dueDate or relative date.`
  }
]

export interface LocalClientOptions {
  schemaDecoding: boolean
  promptVariants: boolean
  /** Content-writing prompts carry GROUNDING_RULE_SMALL instead of the full rule. */
  smallGroundingRule: boolean
  /** Review content-writing output; repair high-confidence invented specifics. */
  groundingCheck: boolean
  /**
   * Review without changing anything (the eval's evidence mode): what the
   * check WOULD repair and flag is reported, the output is left as written.
   */
  groundingObserve?: boolean
}

// Shipping defaults, from the eval. Schema-constrained decoding stays OFF, and
// the reason is now known (structured-after-schema.json, 4.3.39-local.4):
// node-llama-cpp's JSON-schema grammar does not honour additionalProperties —
// anything not named in the schema is squeezed into nonsense ("][": 1 keys,
// "columns": 1), so Build with AI's cards lost their content (0/15 valid) and
// table rows came back thinner (5.6 vs 6.8 cells per row, 3.7 vs 5.3 proposed
// columns). The generic JSON grammar plus tolerant parsing and the call's own
// contract (structuredOutput.ts) gives 100% valid shape for tables (39/39) and
// 23/24 for Build. Earlier measurement (tools/local-ai-eval/results, v2-base
// vs v2-tuned, v3-*): schema-constrained decoding halved Build with AI's output
// (3515 → 1427 characters, 1/6 → 0/6) and lifted no family; the prompt
// variants lifted none either. Both stay available (setLocalClientOptions, the
// eval's EVAL_SCHEMA / EVAL_VARIANTS) but are off. The small grounding rule and
// the invented-specifics check are on: neither changed pass rates measurably,
// and the check keeps invented specifics from being presented as fact.
let clientOptions: LocalClientOptions = {
  schemaDecoding: false,
  promptVariants: false,
  smallGroundingRule: true,
  // On (d2's review of 141 real repairs, ed662ea0): the local path repairs
  // high-confidence invented specifics into [placeholders]; HTML attributes are
  // no longer read as quotations. Cloud replies are highlighted, never changed.
  groundingCheck: true
}

/** Where grounding findings go (the app shows them; tests and the eval read them). */
/** original/supplied/applied: for the eval's evidence record; the app never sends them anywhere. */
export type GroundingReportFull = ReviewResult & { path: 'local' | 'cloud'; original?: string; supplied?: string; applied?: boolean }
export type GroundingSink = (r: GroundingReportFull) => void
let groundingSink: GroundingSink = () => undefined
export function setGroundingSink(fn: GroundingSink): void {
  groundingSink = fn
}
export function emitGrounding(r: GroundingReportFull): void {
  if (r.repaired.length || r.flagged.length) groundingSink(r)
}

/** For the eval's A/B runs and tests. */
export function setLocalClientOptions(o: Partial<LocalClientOptions>): void {
  clientOptions = { ...clientOptions, ...o }
}
export function getLocalClientOptions(): LocalClientOptions {
  return { ...clientOptions }
}

/** The system prompt with this purpose's variants applied. Exported for tests. */
export function applyVariants(purpose: string, system: string, now = new Date()): string {
  if (!clientOptions.promptVariants) return system
  const add = PROMPT_VARIANTS.filter((v) => v.purposes.includes(purpose)).map((v) => v.addendum(now))
  return add.length ? `${system}\n\n${add.join('\n')}` : system
}

// ── Request flattening ──────────────────────────────────────────────────────

type AnyBlock = { type?: string; text?: string }

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content as AnyBlock[]) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b?.type === 'image') throw new LocalUnsupportedError('images')
    else if (b?.type === 'document') throw new LocalUnsupportedError('documents')
    else if (b?.type === 'tool_use' || b?.type === 'tool_result') throw new LocalUnsupportedError('tools')
  }
  return parts.join('\n')
}

export interface FlatRequest {
  system: string
  messages: EngineMessage[]
  maxTokens: number
}

/** Flatten an Anthropic Messages body into the engine's shape. Exported for tests. */
export function flattenRequest(body: Record<string, unknown>): FlatRequest {
  if (Array.isArray(body.tools) && body.tools.length > 0) throw new LocalUnsupportedError('tools')
  const system = typeof body.system === 'string' ? body.system : textOf(body.system)
  const msgs = Array.isArray(body.messages) ? (body.messages as Array<{ role: string; content: unknown }>) : []
  const messages: EngineMessage[] = msgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: textOf(m.content) }))
  const maxTokens = typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : 1024
  return { system, messages, maxTokens }
}

// ── The client ──────────────────────────────────────────────────────────────

export interface LocalClientDeps {
  /** Resolve (lazily loading, if needed) the engine. */
  engine: () => Promise<LocalEngine>
  /** Model id reported back in responses, e.g. the tier's model name. */
  modelLabel: () => string
}

let msgSeq = 0

function toMessage(model: string, r: EngineGenerateResult): Anthropic.Message {
  return {
    id: `local_msg_${Date.now().toString(36)}_${++msgSeq}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: r.text, citations: null }],
    stop_reason: r.stopReason === 'aborted' ? 'end_turn' : (r.stopReason as Anthropic.Message['stop_reason']),
    stop_sequence: null,
    usage: {
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
  } as unknown as Anthropic.Message
}

/** Run one request against the engine: JSON-constrain, validate, retry once. Exported for the router. */
export async function runLocal(
  deps: LocalClientDeps,
  body: Record<string, unknown>,
  opts: { signal?: AbortSignal; onText?: (delta: string) => void } = {}
): Promise<Anthropic.Message> {
  const purpose = purposeOfModel(body.model)
  const flat = flattenRequest(body)
  const lastUser = [...flat.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const shape = jsonIntent(flat.system, lastUser)
  const jsonSchema = shape === 'object' && clientOptions.schemaDecoding ? (schemaFor(purpose, flat.system) ?? undefined) : undefined
  const content = isContentWriting(flat.system)
  const varied = applyVariants(purpose, flat.system)
  const system = content && clientOptions.smallGroundingRule ? withSmallRule(varied) : varied
  const engine = await deps.engine()
  const model = `local:${deps.modelLabel()}`
  const first = await engine.generate(
    { system, messages: flat.messages, maxTokens: flat.maxTokens, json: shape ?? false, jsonSchema, temperature: shape ? 0.1 : 0.3 },
    opts
  )
  // Content-writing output: review for specifics the request never supplied,
  // repairing the high-confidence ones into [placeholders].
  const reviewing = content && (clientOptions.groundingCheck || clientOptions.groundingObserve === true)
  const supplied = reviewing ? suppliedText(flat.system, flat.messages) : ''
  const grounded = (m: Anthropic.Message): Anthropic.Message => {
    if (!reviewing) return m
    const block = m.content[0] as { type: string; text?: string } | undefined
    if (!block || block.type !== 'text' || !block.text) return m
    const r = reviewOutput(block.text, supplied, true)
    const applied = clientOptions.groundingCheck
    emitGrounding({ ...r, path: 'local', original: block.text, supplied, applied })
    if (applied) block.text = r.text
    return m
  }
  if (!shape) return grounded(toMessage(model, first))
  // Structured: tolerant parse → the call's contract → strict validation
  // (structuredOutput.ts). A reply cut off at max tokens is a failure to
  // retry, not something to hand the call site half of.
  const firstParsed = parseStructured(first.text, shape, purpose, flat.system)
  const accept = (r: EngineGenerateResult, text: string): Anthropic.Message => grounded(toMessage(model, { ...r, text, stopReason: 'end_turn' }))
  // A JSON value that closed is complete, even when generation then hit its limit.
  if (firstParsed.ok) return accept(first, firstParsed.text)
  const problem = firstParsed.problem

  // One retry, telling the model exactly what was wrong. Streaming listeners
  // already saw the first attempt; the retry is not streamed (the consumer
  // reads the final text), so nothing is shown twice.
  const retry = await engine.generate(
    {
      system,
      messages: [
        ...flat.messages,
        // A cut-off or runaway first attempt can be thousands of tokens; the
        // retry needs to see what went wrong, not all of it (a 14,000-token
        // loop replayed here overflowed the context window).
        { role: 'assistant', content: first.text.length > 2000 ? `${first.text.slice(0, 2000)}…` : first.text },
        {
          role: 'user',
          content: `That reply was not usable: ${problem}. Reply again with ONLY the corrected JSON ${shape}, following the format in the instructions exactly.`
        }
      ],
      maxTokens: flat.maxTokens,
      json: shape,
      jsonSchema,
      temperature: 0.1
    },
    { signal: opts.signal }
  )
  const retryParsed = parseStructured(retry.text, shape, purpose, flat.system)
  const retryProblem = retryParsed.ok ? null : retryParsed.problem
  const totals = {
    inputTokens: first.inputTokens + retry.inputTokens,
    outputTokens: first.outputTokens + retry.outputTokens,
    totalMs: first.totalMs + retry.totalMs
  }
  if (!retryProblem && retryParsed.ok) return accept({ ...retry, ...totals }, retryParsed.text)
  const msg = toMessage(model, { ...first, ...totals })
  // Both attempts failed. The router may offer cloud for this one request;
  // when the call's contract is known and that is declined, the request
  // fails plainly (never "ok" with nothing in it).
  Object.defineProperty(msg, LOCAL_UNUSABLE, { value: retryProblem ?? problem, enumerable: false })
  const contract = contractFor(purpose, flat.system)
  if (contract) Object.defineProperty(msg, LOCAL_CONTRACT, { value: contract.describe, enumerable: false })
  return msg
}

/** Set (non-enumerable) on an unusable local reply whose call has a known contract: what was promised. */
export const LOCAL_CONTRACT = Symbol.for('plexii.localContract')
export function localContractOf(m: unknown): string | null {
  if (!m || typeof m !== 'object') return null
  const v = (m as Record<symbol, unknown>)[LOCAL_CONTRACT]
  return typeof v === 'string' ? v : null
}

/** Set (non-enumerable) on a local reply whose structured output failed validation twice. */
export const LOCAL_UNUSABLE = Symbol.for('plexii.localUnusable')
export function localUnusableReason(m: unknown): string | null {
  if (!m || typeof m !== 'object') return null
  const v = (m as Record<symbol, unknown>)[LOCAL_UNUSABLE]
  return typeof v === 'string' ? v : null
}

type Listener = (delta: string) => void

/** The subset of the SDK's MessageStream the app uses: on('text'), finalMessage(), abort(). */
export class LocalMessageStream {
  private readonly textListeners: Listener[] = []
  private readonly ctrl = new AbortController()
  private readonly done: Promise<Anthropic.Message>

  constructor(run: (signal: AbortSignal, onText: Listener) => Promise<Anthropic.Message>) {
    // Start on the next tick so listeners attached synchronously see every delta.
    this.done = Promise.resolve().then(() =>
      run(this.ctrl.signal, (d) => {
        for (const fn of this.textListeners) fn(d)
      })
    )
    this.done.catch(() => undefined)
  }

  on(event: string, fn: Listener): this {
    if (event === 'text') this.textListeners.push(fn)
    return this
  }

  abort(): void {
    this.ctrl.abort()
  }

  finalMessage(): Promise<Anthropic.Message> {
    return this.done
  }
}

/** The client object handed to call sites. Cast to the SDK type at the seam. */
export function createLocalClient(deps: LocalClientDeps): {
  messages: {
    create: (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<Anthropic.Message>
    stream: (body: Record<string, unknown>) => LocalMessageStream
  }
  baseURL: string
} {
  return {
    // Not a URL anything can reach: isCreditClient() reads baseURL, and this
    // must never be mistaken for the credits proxy.
    baseURL: 'local://device',
    messages: {
      create: (body, options) => runLocal(deps, body, { signal: options?.signal }),
      stream: (body) => new LocalMessageStream((signal, onText) => runLocal(deps, body, { signal, onText }))
    }
  }
}
