// OpenAI as a bring-your-own-key AI provider, behind the same interface every
// AI call site already uses (the Anthropic Messages shape: messages.create and
// messages.stream), exactly as the on-device model is. Call sites, prompts and
// parsers are unchanged; this translates at the edge:
//
//   system + messages  → Chat Completions messages (system first)
//   text / image blocks → text / image_url content parts
//   tools (input_schema) → function tools; tool_calls → tool_use blocks;
//   tool_result blocks  → role:"tool" messages
//   JSON-demanding prompts → response_format json_object
//   finish_reason       → stop_reason (stop→end_turn, length→max_tokens,
//                          tool_calls→tool_use, content_filter→refusal)
//   streaming           → SSE deltas, delivered through the same
//                          on('text') / finalMessage() / abort() surface
//
// Model choice: the app's purposes resolve to a Claude tier (haiku / sonnet /
// opus); each maps to the OpenAI model the person picked for that tier.

import type Anthropic from '@anthropic-ai/sdk'
import { jsonIntent } from './localClient'

export const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'

export interface OpenAIModels {
  fast: string
  standard: string
  best: string
}

/** Defaults: chat-capable models on the account at the time of writing; the person can change them in Settings. */
export const DEFAULT_OPENAI_MODELS: OpenAIModels = { fast: 'gpt-5.4-mini', standard: 'gpt-5.5', best: 'gpt-5.5' }

/** The OpenAI model for a Claude model id, by tier. */
export function openaiModelFor(claudeModel: string, models: OpenAIModels): string {
  if (/haiku/i.test(claudeModel)) return models.fast
  if (/opus|fable|mythos/i.test(claudeModel)) return models.best
  return models.standard
}

type Block = { type?: string; text?: string; source?: { type?: string; media_type?: string; data?: string; url?: string }; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }
type OAIMessage = Record<string, unknown>

function textOfSystem(system: unknown): string {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return (system as Block[]).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
  return ''
}

/** Anthropic Messages request → Chat Completions request. Exported for tests. */
export function toOpenAIRequest(body: Record<string, unknown>, model: string, stream: boolean): Record<string, unknown> {
  const system = textOfSystem(body.system)
  const out: OAIMessage[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of (body.messages as Array<{ role: string; content: unknown }>) ?? []) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    const blocks = (m.content as Block[]) ?? []
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }))
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) })
      continue
    }
    // user: tool results become tool messages; text and images a content array
    for (const b of blocks.filter((x) => x.type === 'tool_result')) {
      const c = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map((x) => x.text ?? '').join('\n') : JSON.stringify(b.content ?? '')
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: c })
    }
    const parts: Array<Record<string, unknown>> = []
    for (const b of blocks) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text ?? '' })
      else if (b.type === 'image' && b.source) {
        const url = b.source.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : b.source.url
        parts.push({ type: 'image_url', image_url: { url } })
      }
    }
    if (parts.length) out.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts })
  }
  const req: Record<string, unknown> = {
    model,
    messages: out,
    max_completion_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 4096,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
  }
  const tools = body.tools as Array<{ name: string; description?: string; input_schema?: unknown }> | undefined
  if (Array.isArray(tools) && tools.length) {
    req.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object' } } }))
  } else {
    const lastUser = [...out].reverse().find((m) => m.role === 'user')
    const lastText = typeof lastUser?.content === 'string' ? lastUser.content : ''
    if (jsonIntent(system, lastText) === 'object') req.response_format = { type: 'json_object' }
  }
  return req
}

const STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' }

interface OAIChoice {
  message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; refusal?: string | null }
  finish_reason?: string
}

/** Chat Completions response → Anthropic Message. Exported for tests. */
export function fromOpenAIResponse(json: { id?: string; model?: string; choices?: OAIChoice[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }): Anthropic.Message {
  const choice = json.choices?.[0] ?? {}
  const content: Array<Record<string, unknown>> = []
  const text = choice.message?.content ?? choice.message?.refusal ?? ''
  if (text) content.push({ type: 'text', text, citations: null })
  for (const tc of choice.message?.tool_calls ?? []) {
    let input: unknown = {}
    try {
      input = JSON.parse(tc.function.arguments || '{}')
    } catch {
      input = {}
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
  }
  return {
    id: json.id ?? 'openai',
    type: 'message',
    role: 'assistant',
    model: json.model ?? 'openai',
    content,
    stop_reason: choice.message?.refusal ? 'refusal' : STOP[choice.finish_reason ?? 'stop'] ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: json.usage?.prompt_tokens ?? 0, output_tokens: json.usage?.completion_tokens ?? 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  } as unknown as Anthropic.Message
}

async function failure(res: Response): Promise<Error> {
  const t = await res.text().catch(() => '')
  let msg = t.slice(0, 300)
  try {
    msg = (JSON.parse(t) as { error?: { message?: string } }).error?.message ?? msg
  } catch {
    /* keep raw */
  }
  return new Error(`OpenAI (${res.status}): ${msg}`)
}

export interface OpenAIClientDeps {
  key: () => string | null
  models: () => OpenAIModels
  fetch?: typeof fetch
}

type Listener = (d: string) => void

/** The Anthropic-shaped client over OpenAI Chat Completions. */
export function createOpenAIClient(deps: OpenAIClientDeps): Anthropic {
  const doFetch = deps.fetch ?? ((i: RequestInfo | URL, n?: RequestInit) => globalThis.fetch(i, n))
  const modelFor = (body: Record<string, unknown>): string => {
    const m = typeof body.model === 'string' ? body.model : ''
    // An explicit OpenAI model id passes through; a Claude id maps by tier.
    return /^(gpt|o\d|chatgpt)/.test(m) ? m : openaiModelFor(m, deps.models())
  }
  const headers = (): Record<string, string> => {
    const key = deps.key()
    if (!key) throw new Error('No OpenAI API key set. Add one in Settings → AI · API keys.')
    return { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
  }
  const create = async (body: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<Anthropic.Message> => {
    const res = await doFetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(toOpenAIRequest(body, modelFor(body), false)),
      signal: options?.signal
    })
    if (!res.ok) throw await failure(res)
    return fromOpenAIResponse(await res.json())
  }
  const stream = (body: Record<string, unknown>) => {
    const listeners: Listener[] = []
    const ctrl = new AbortController()
    const done = (async (): Promise<Anthropic.Message> => {
      await Promise.resolve()
      const res = await doFetch(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(toOpenAIRequest(body, modelFor(body), true)),
        signal: ctrl.signal
      })
      if (!res.ok || !res.body) throw await failure(res)
      let text = ''
      let finish = 'stop'
      let usage = { prompt_tokens: 0, completion_tokens: 0 }
      let model = ''
      const calls = new Map<number, { id: string; name: string; args: string }>()
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      try {
        for (;;) {
          const { value, done: end } = await reader.read()
          if (end) break
          buf += dec.decode(value, { stream: true })
          let nl: number
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') continue
            let ev: { model?: string; choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>; usage?: typeof usage }
            try {
              ev = JSON.parse(data)
            } catch {
              continue
            }
            if (ev.model) model = ev.model
            if (ev.usage) usage = ev.usage
            const ch = ev.choices?.[0]
            const d = ch?.delta?.content
            if (d) {
              text += d
              for (const fn of listeners) fn(d)
            }
            for (const tc of ch?.delta?.tool_calls ?? []) {
              const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' }
              if (tc.id) cur.id = tc.id
              if (tc.function?.name) cur.name += tc.function.name
              if (tc.function?.arguments) cur.args += tc.function.arguments
              calls.set(tc.index, cur)
            }
            if (ch?.finish_reason) finish = ch.finish_reason
          }
        }
      } catch (e) {
        if (!ctrl.signal.aborted) throw e
      }
      return fromOpenAIResponse({
        model,
        choices: [
          {
            message: {
              content: text,
              tool_calls: [...calls.values()].map((c) => ({ id: c.id, function: { name: c.name, arguments: c.args } }))
            },
            finish_reason: finish
          }
        ],
        usage
      })
    })()
    done.catch(() => undefined)
    return {
      on(event: string, fn: Listener) {
        if (event === 'text') listeners.push(fn)
        return this
      },
      abort: () => ctrl.abort(),
      finalMessage: () => done
    }
  }
  return { baseURL: 'https://api.openai.com/v1', messages: { create, stream } } as unknown as Anthropic
}
