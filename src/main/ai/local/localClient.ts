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

/** Pull the outermost JSON value out of model text (fences and stray prose tolerated). */
export function extractJsonText(text: string): string | null {
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const firstObj = s.indexOf('{')
  const firstArr = s.indexOf('[')
  const start = firstObj < 0 ? firstArr : firstArr < 0 ? firstObj : Math.min(firstObj, firstArr)
  if (start < 0) return null
  const close = s[start] === '{' ? '}' : ']'
  const end = s.lastIndexOf(close)
  if (end <= start) return null
  return s.slice(start, end + 1)
}

type Validator = (v: unknown) => string | null

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// The contracts whose shape is fixed. Anything else is checked for being
// parseable JSON of the demanded kind, and the call site validates the rest.
const VALIDATORS: Record<string, Validator> = {
  chat: (v) => {
    if (!isObj(v)) return 'the reply must be a JSON object'
    if (typeof v.reply === 'string') {
      if (v.actions !== undefined && !Array.isArray(v.actions)) return '"actions" must be an array'
      return null
    }
    // askWorkspace's grounded-answer contract shares the chat purpose.
    if (typeof v.answer === 'string') return null
    return 'the object must have a string "reply" field and an "actions" array'
  },
  welcome: (v) => (isObj(v) && typeof v.reply === 'string' ? null : 'the object must have a string "reply" field'),
  setup: (v) => {
    if (!isObj(v) || !Array.isArray(v.suggestions)) return 'the object must have a "suggestions" array'
    if (v.suggestions.length === 0) return '"suggestions" must not be empty'
    for (const s of v.suggestions) {
      if (!isObj(s) || typeof s.kind !== 'string') return 'every suggestion needs a "kind"'
      if (s.kind === 'table') {
        const cols = isObj(s.tableSchema) ? s.tableSchema.columns : undefined
        if (!Array.isArray(cols) || cols.length === 0) return `table "${String(s.title ?? '')}" has no tableSchema.columns`
      }
      if (s.kind === 'page' && !(isObj(s.pageContent) && Array.isArray(s.pageContent.content))) {
        return `page "${String(s.title ?? '')}" has no pageContent document`
      }
    }
    return null
  },
  title_backfill: (v) => (isObj(v) && Array.isArray(v.titles) ? null : 'the object must have a "titles" array'),
  enrichment: (v) => (isObj(v) && typeof v.summary === 'string' ? null : 'the object must have a string "summary"')
}

/** Validate model text against the demanded JSON shape. Returns an error or null. Exported for tests. */
export function validateJsonOutput(text: string, shape: 'object' | 'array', purpose: string): string | null {
  const raw = extractJsonText(text)
  if (!raw) return `no JSON ${shape} was found`
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch (e) {
    return `the JSON did not parse (${(e as Error).message})`
  }
  if (shape === 'array' ? !Array.isArray(v) : !isObj(v)) return `the output must be a JSON ${shape}`
  return VALIDATORS[purpose]?.(v) ?? null
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
  if (purpose === 'setup' && /"suggestions"/.test(system)) {
    return {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        suggestions: {
          type: 'array',
          minItems: 1,
          items: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string' } }, additionalProperties: true }
        }
      }
    }
  }
  if (purpose === 'title_backfill') {
    return {
      type: 'object',
      properties: {
        titles: { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' }, title: { type: 'string' } } } }
      }
    }
  }
  if (purpose === 'enrichment') {
    const strs = { type: 'array', items: { type: 'string' } }
    return {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        category: { type: 'string' },
        entities: strs,
        dates: strs,
        keywords: strs,
        language: { type: 'string' }
      }
    }
  }
  return null
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
}

// Defaults set to the configuration that is actually intended to ship, so a
// test build exercises the real product rather than an experimental one.
//
//  schemaDecoding / promptVariants: measured no better than the base config,
//    and schema decoding is what halved the build family. Off.
//  smallGroundingRule: kept. Its +1/34 is noise, but it is strictly shorter
//    than the full rule and a 4B has limited instruction-following budget.
//  groundingCheck: OFF pending review. It repaired 18 spans and flagged 94
//    while changing no verdict, and nobody has yet looked at whether those
//    repairs were correct. Two reasons not to have it on here: unreviewed code
//    silently rewriting someone's draft is not a thing to default to, and it
//    would contaminate the very measurement this build exists for — with it on,
//    "did the local model invent facts" actually measures model plus repair.
let clientOptions: LocalClientOptions = {
  schemaDecoding: false,
  promptVariants: false,
  smallGroundingRule: true,
  groundingCheck: false
}

/** Where grounding findings go (the app shows them; tests and the eval read them). */
export type GroundingSink = (r: ReviewResult & { path: 'local' | 'cloud' }) => void
let groundingSink: GroundingSink = () => undefined
export function setGroundingSink(fn: GroundingSink): void {
  groundingSink = fn
}
export function emitGrounding(r: ReviewResult & { path: 'local' | 'cloud' }): void {
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
  const supplied = content && clientOptions.groundingCheck ? suppliedText(flat.system, flat.messages) : ''
  const grounded = (m: Anthropic.Message): Anthropic.Message => {
    if (!content || !clientOptions.groundingCheck) return m
    const block = m.content[0] as { type: string; text?: string } | undefined
    if (!block || block.type !== 'text' || !block.text) return m
    const r = reviewOutput(block.text, supplied, true)
    emitGrounding({ ...r, path: 'local' })
    block.text = r.text
    return m
  }
  if (!shape || first.stopReason !== 'end_turn') return grounded(toMessage(model, first))
  const problem = validateJsonOutput(first.text, shape, purpose)
  if (!problem) return grounded(toMessage(model, first))

  // One retry, telling the model exactly what was wrong. Streaming listeners
  // already saw the first attempt; the retry is not streamed (the consumer
  // reads the final text), so nothing is shown twice.
  const retry = await engine.generate(
    {
      system,
      messages: [
        ...flat.messages,
        { role: 'assistant', content: first.text },
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
  const retryProblem = retry.stopReason === 'end_turn' ? validateJsonOutput(retry.text, shape, purpose) : 'cut off'
  const chosen = retryProblem ? first : retry
  const msg = toMessage(model, {
    ...chosen,
    inputTokens: first.inputTokens + retry.inputTokens,
    outputTokens: first.outputTokens + retry.outputTokens,
    totalMs: first.totalMs + retry.totalMs
  })
  // Both attempts failed the contract. The call site will fail honestly on
  // this text; the router may first offer cloud for this one request.
  if (retryProblem) Object.defineProperty(msg, LOCAL_UNUSABLE, { value: retryProblem, enumerable: false })
  return retryProblem ? msg : grounded(msg)
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
