// @vitest-environment node
// The Anthropic-shaped client over the on-device engine: request flattening,
// JSON intent, schema validation, and the single retry.
import { describe, it, expect, vi } from 'vitest'
import {
  jsonIntent,
  validateJsonOutput,
  flattenRequest,
  runLocal,
  createLocalClient,
  LocalUnsupportedError
} from '../../src/main/ai/local/localClient'
import type { EngineGenerateRequest, EngineGenerateResult, LocalEngine } from '../../src/main/ai/local/engineCore'

function engineOf(replies: string[]): LocalEngine & { calls: EngineGenerateRequest[] } {
  const calls: EngineGenerateRequest[] = []
  return {
    calls,
    async generate(req, opts) {
      calls.push(req)
      const text = replies[Math.min(calls.length - 1, replies.length - 1)]
      opts?.onText?.(text)
      return { text, inputTokens: 10, outputTokens: 5, stopReason: 'end_turn', ttftMs: 1, totalMs: 2 } satisfies EngineGenerateResult
    }
  }
}
const deps = (e: LocalEngine) => ({ engine: async () => e, modelLabel: () => 'test', installed: () => true })

describe('jsonIntent', () => {
  it('reads the app prompts correctly', () => {
    expect(jsonIntent('OUTPUT FORMAT: every response you produce MUST be a single valid JSON object.', 'hi')).toBe('object')
    expect(jsonIntent('Respond with VALID JSON ONLY (no commentary, no markdown fence).', 'x')).toBe('object')
    expect(jsonIntent('Output ONLY a JSON array of column header name strings and nothing else. The value must start with [', 'x')).toBe('array')
    expect(jsonIntent('Be concise and direct. Write a plain-text answer only — no JSON, no markdown code fences.', 'x')).toBeNull()
    expect(jsonIntent('You are an inline writing assistant. Return ONLY the resulting text.', 'x')).toBeNull()
  })
})

describe('validateJsonOutput', () => {
  it('accepts the chat envelope and the grounded-answer shape', () => {
    expect(validateJsonOutput('{"reply":"ok","actions":[]}', 'object', 'chat')).toBeNull()
    expect(validateJsonOutput('{"answer":"x [1]","sources":[1]}', 'object', 'chat')).toBeNull()
    expect(validateJsonOutput('```json\n{"reply":"ok"}\n```', 'object', 'chat')).toBeNull()
  })
  it('names what is wrong', () => {
    expect(validateJsonOutput('{"text":"x"}', 'object', 'chat')).toMatch(/reply/)
    expect(validateJsonOutput('{"reply":"x","actions":{}}', 'object', 'chat')).toMatch(/actions/)
    expect(validateJsonOutput('{"reply": "unterminated', 'object', 'chat')).toMatch(/no JSON|did not parse/)
    expect(validateJsonOutput('{"suggestions":[{"kind":"table","title":"T"}]}', 'object', 'setup')).toMatch(/columns/)
    expect(validateJsonOutput('{"suggestions":[]}', 'object', 'setup')).toMatch(/empty/)
    expect(validateJsonOutput('{"a":1}', 'array', 'generic')).toMatch(/array/)
  })
})

describe('flattenRequest', () => {
  it('joins system blocks and text content', () => {
    const f = flattenRequest({
      system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      max_tokens: 99
    })
    expect(f).toEqual({ system: 'A\nB', messages: [{ role: 'user', content: 'q' }], maxTokens: 99 })
  })
  it('refuses what the on-device model cannot honestly do', () => {
    expect(() => flattenRequest({ tools: [{ name: 't' }], messages: [] })).toThrow(LocalUnsupportedError)
    expect(() => flattenRequest({ messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] })).toThrow(/images/)
  })
})

describe('runLocal', () => {
  const body = {
    model: 'local:chat',
    max_tokens: 500,
    system: 'Every response MUST be a single valid JSON object: {"reply": "...", "actions": []}',
    messages: [{ role: 'user', content: 'hello' }]
  }

  it('constrains JSON prompts and returns a valid first answer without retrying', async () => {
    const e = engineOf(['{"reply":"hi","actions":[]}'])
    const m = await runLocal(deps(e), body)
    expect(e.calls).toHaveLength(1)
    expect(e.calls[0].json).toBe('object')
    expect(m.content[0]).toMatchObject({ type: 'text', text: '{"reply":"hi","actions":[]}' })
    expect(m.model).toBe('local:test')
    expect(m.usage.input_tokens).toBe(10)
  })

  it('retries once with the validation error, and uses the retry when it is valid', async () => {
    const e = engineOf(['{"text":"wrong shape"}', '{"reply":"fixed","actions":[]}'])
    const m = await runLocal(deps(e), body)
    expect(e.calls).toHaveLength(2)
    expect(e.calls[1].messages.at(-1)?.content).toMatch(/not usable: .*reply/)
    expect((m.content[0] as { text: string }).text).toContain('fixed')
    expect(m.usage.output_tokens).toBe(10)
  })

  it('retries only once, then returns the first answer for the call site to reject honestly', async () => {
    const e = engineOf(['{"text":"bad"}', '{"also":"bad"}'])
    const m = await runLocal(deps(e), body)
    expect(e.calls).toHaveLength(2)
    expect((m.content[0] as { text: string }).text).toBe('{"text":"bad"}')
  })

  it('does not constrain or retry prose', async () => {
    const e = engineOf(['Just text.'])
    await runLocal(deps(e), { ...body, system: 'Return ONLY the resulting text. No JSON.' })
    expect(e.calls).toHaveLength(1)
    expect(e.calls[0].json).toBe(false)
  })

  it('streams through the SDK-shaped stream, and abort reaches the engine', async () => {
    let seenSignal: AbortSignal | undefined
    const e: LocalEngine = {
      async generate(_r, opts) {
        seenSignal = opts?.signal
        opts?.onText?.('a')
        opts?.onText?.('b')
        return { text: 'ab', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', ttftMs: 0, totalMs: 0 }
      }
    }
    const client = createLocalClient(deps(e))
    const stream = client.messages.stream({ ...body, system: 'plain' })
    const deltas: string[] = []
    stream.on('text', (d) => deltas.push(d))
    const final = await stream.finalMessage()
    expect(deltas).toEqual(['a', 'b'])
    expect((final.content[0] as { text: string }).text).toBe('ab')
    stream.abort()
    expect(seenSignal?.aborted).toBe(true)
  })

  it('reports a context-window refusal with the cloud path’s own stop reason', async () => {
    const e: LocalEngine = {
      generate: vi.fn(async () => ({ text: '', inputTokens: 99999, outputTokens: 0, stopReason: 'model_context_window_exceeded' as const, ttftMs: null, totalMs: 0 }))
    }
    const m = await runLocal(deps(e), body)
    expect(m.stop_reason).toBe('model_context_window_exceeded')
  })
})
