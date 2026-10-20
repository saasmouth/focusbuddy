// @vitest-environment node
// "Your own OpenAI key" as an AI provider: the Anthropic-shaped client over
// OpenAI Chat Completions, and the per-feature routing that reaches it. The
// client is driven against a fake OpenAI endpoint (a fetch stand-in that
// records requests and answers in OpenAI's wire format, JSON and SSE).
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createOpenAIClient,
  toOpenAIRequest,
  fromOpenAIResponse,
  openaiModelFor,
  OPENAI_CHAT_URL,
  DEFAULT_OPENAI_MODELS
} from '../../src/main/ai/local/openaiClient'
import * as router from '../../src/main/ai/local/providerRouter'

const MODELS = { fast: 'gpt-fast', standard: 'gpt-standard', best: 'gpt-best' }

type Sent = { url: string; body: Record<string, unknown>; auth: string | null }
function fakeOpenAI(answer: (body: Record<string, unknown>) => Response): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = []
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    sent.push({ url: String(url), body, auth: new Headers(init?.headers).get('authorization') })
    return answer(body)
  }) as typeof fetch
  return { fetch: f, sent }
}
const json = (o: unknown, status = 200): Response => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
const sse = (events: unknown[]): Response =>
  new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' }
  })

describe('request and response translation', () => {
  it('maps Claude tiers to the chosen OpenAI models', () => {
    expect(openaiModelFor('claude-haiku-4-5', MODELS)).toBe('gpt-fast')
    expect(openaiModelFor('claude-sonnet-5-5', MODELS)).toBe('gpt-standard')
    expect(openaiModelFor('claude-opus-5-5', MODELS)).toBe('gpt-best')
    expect(DEFAULT_OPENAI_MODELS.fast).toBeTruthy()
  })

  it('puts the system prompt first, keeps turns, and turns images into image_url parts', () => {
    const req = toOpenAIRequest(
      {
        system: [{ type: 'text', text: 'You are helpful.' }],
        max_tokens: 300,
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
            ]
          }
        ]
      },
      'gpt-standard',
      false
    )
    expect(req.model).toBe('gpt-standard')
    expect(req.max_completion_tokens).toBe(300)
    const msgs = req.messages as Array<Record<string, unknown>>
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are helpful.' })
    expect(msgs[1]).toEqual({ role: 'user', content: 'Hi' })
    expect(msgs[2]).toEqual({ role: 'assistant', content: 'Hello.' })
    expect(msgs[3].content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ])
    expect(req.stream).toBeUndefined()
  })

  it('maps tools, tool calls and tool results both ways', () => {
    const req = toOpenAIRequest(
      {
        messages: [
          { role: 'user', content: 'Weather?' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Adelaide' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny, 24°' }] }
        ],
        tools: [{ name: 'weather', description: 'Look up weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }]
      },
      'gpt-standard',
      false
    )
    const msgs = req.messages as Array<Record<string, unknown>>
    expect(msgs[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Adelaide"}' } }] })
    expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'Sunny, 24°' })
    expect((req.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'function', function: { name: 'weather' } })

    const msg = fromOpenAIResponse({
      choices: [{ message: { content: null, tool_calls: [{ id: 'call_2', function: { name: 'weather', arguments: '{"city":"Perth"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 3 }
    })
    expect(msg.stop_reason).toBe('tool_use')
    expect(msg.content[0]).toMatchObject({ type: 'tool_use', id: 'call_2', name: 'weather', input: { city: 'Perth' } })
    expect(msg.usage.input_tokens).toBe(10)
  })

  it('asks for a JSON object when the prompt demands one (structured output)', () => {
    const req = toOpenAIRequest(
      { system: 'Reply with ONLY a JSON object: {"reply": string, "actions": []}', messages: [{ role: 'user', content: 'hi' }] },
      'gpt-standard',
      false
    )
    expect(req.response_format).toEqual({ type: 'json_object' })
  })

  it('maps finish reasons', () => {
    expect(fromOpenAIResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }).stop_reason).toBe('max_tokens')
    expect(fromOpenAIResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] }).stop_reason).toBe('end_turn')
    expect(fromOpenAIResponse({ choices: [{ message: { content: null, refusal: 'No.' }, finish_reason: 'stop' }] }).stop_reason).toBe('refusal')
  })
})

describe('the client against a fake OpenAI endpoint', () => {
  it('create(): sends the key and the tier model, returns an Anthropic-shaped message', async () => {
    const api = fakeOpenAI(() => json({ id: 'c1', model: 'gpt-fast', choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }))
    const client = createOpenAIClient({ key: () => 'sk-test', models: () => MODELS, fetch: api.fetch })
    const m = await client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] })
    expect(api.sent[0].url).toBe(OPENAI_CHAT_URL)
    expect(api.sent[0].auth).toBe('Bearer sk-test')
    expect(api.sent[0].body.model).toBe('gpt-fast')
    expect(m.content[0]).toMatchObject({ type: 'text', text: 'Done.' })
  })

  it('stream(): delivers text deltas as they arrive and a final message with tool calls assembled', async () => {
    const api = fakeOpenAI(() =>
      sse([
        { model: 'gpt-standard', choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'look', arguments: '{"q":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 4 } },
        '[DONE]'
      ])
    )
    const client = createOpenAIClient({ key: () => 'sk-test', models: () => MODELS, fetch: api.fetch })
    const deltas: string[] = []
    const s = client.messages.stream({ model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] } as never)
    s.on('text', (d: string) => deltas.push(d))
    const m = await s.finalMessage()
    expect(api.sent[0].body.stream).toBe(true)
    expect(deltas).toEqual(['Hel', 'lo'])
    expect(m.content[0]).toMatchObject({ type: 'text', text: 'Hello' })
    expect(m.content[1]).toMatchObject({ type: 'tool_use', id: 'call_9', name: 'look', input: { q: 'x' } })
    expect(m.stop_reason).toBe('tool_use')
    expect(m.usage.output_tokens).toBe(4)
  })

  it('an OpenAI error surfaces as a readable error (e.g. an account with no credit)', async () => {
    const api = fakeOpenAI(() => json({ error: { message: 'You exceeded your current quota.' } }, 429))
    const client = createOpenAIClient({ key: () => 'sk-test', models: () => MODELS, fetch: api.fetch })
    await expect(client.messages.create({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /OpenAI \(429\): You exceeded your current quota/
    )
  })

  it('no key: says so, sends nothing', async () => {
    const api = fakeOpenAI(() => json({}))
    const client = createOpenAIClient({ key: () => null, models: () => MODELS, fetch: api.fetch })
    await expect(client.messages.create({ model: 'x', max_tokens: 5, messages: [] })).rejects.toThrow(/No OpenAI API key/)
    expect(api.sent).toEqual([])
  })
})

describe('per-feature provider routing', () => {
  const fakeProvider = (name: string, log: string[]) =>
    ({
      messages: {
        create: async (body: { model: string }) => {
          log.push(`${name}:${body.model}`)
          return { content: [{ type: 'text', text: `from ${name}` }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
        },
        stream: (body: { model: string }) => {
          log.push(`${name}-stream:${body.model}`)
          return { on: () => undefined, finalMessage: async () => ({ content: [] }) }
        }
      }
    }) as never

  let log: string[]
  beforeEach(() => {
    log = []
    router.setCloudProviders({ anthropic: () => fakeProvider('anthropic', log), credits: () => fakeProvider('credits', log), openai: () => fakeProvider('openai', log) })
  })

  it('tags each purpose by its feature route', () => {
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({ writing: 'openai', office: 'anthropic', summaries: 'cloud' }) })
    expect(router.tagModel('chat', 'claude-sonnet-5-5')).toBe('local:chat')
    expect(router.tagModel('doc_rewrite', 'claude-sonnet-5-5')).toBe('route:openai:doc_rewrite:claude-sonnet-5-5')
    expect(router.tagModel('document', 'claude-sonnet-5-5')).toBe('route:anthropic:document:claude-sonnet-5-5')
    expect(router.tagModel('trail_summary', 'claude-haiku-4-5')).toBe('route:cloud:trail_summary:claude-haiku-4-5')
    router.setRouterSettings({ aiMode: () => 'byok', featureRoutes: () => ({ writing: 'openai' }) })
    // Always tagged now (so the router can say which engine answered which feature).
    expect(router.tagModel('chat', 'claude-sonnet-5-5')).toBe('route:cloud:chat:claude-sonnet-5-5')
    expect(router.tagModel('doc_rewrite', 'claude-sonnet-5-5')).toBe('route:openai:doc_rewrite:claude-sonnet-5-5')
  })

  it('dispatches a tagged request to that provider with the real model id', async () => {
    router.setRouterSettings({ aiMode: () => 'byok', featureRoutes: () => ({}) })
    const c = router.routedClient(fakeProvider('default', log))!
    await c.messages.create({ model: 'route:openai:doc_rewrite:claude-sonnet-5-5', max_tokens: 5, messages: [] } as never)
    await c.messages.create({ model: 'route:anthropic:document:claude-opus-5-5', max_tokens: 5, messages: [] } as never)
    await c.messages.create({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [] } as never)
    expect(log).toEqual(['openai:claude-sonnet-5-5', 'anthropic:claude-opus-5-5', 'default:claude-haiku-4-5'])
  })

  it('source "Your OpenAI key": untagged requests go to OpenAI, not the Anthropic client', async () => {
    router.setRouterSettings({ aiMode: () => 'openai', featureRoutes: () => ({}) })
    const c = router.routedClient(fakeProvider('default', log))!
    await c.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 5, messages: [] } as never)
    c.messages.stream({ model: 'claude-sonnet-5-5', max_tokens: 5, messages: [] } as never)
    expect(log).toEqual(['openai:claude-sonnet-5-5', 'openai-stream:claude-sonnet-5-5'])
  })

  it('a feature routed to credits streams through create (the proxy refuses streaming), text delivered once', async () => {
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({ writing: 'credits' }) })
    const c = router.routedClient(null)!
    const s = c.messages.stream({ model: 'route:credits:doc_rewrite:claude-haiku-4-5', max_tokens: 5, messages: [] } as never)
    const got: string[] = []
    s.on('text', (d: string) => got.push(d))
    await s.finalMessage()
    expect(log).toEqual(['credits:claude-haiku-4-5'])
    expect(got).toEqual(['from credits'])
  })

  it('a route to a provider with no key fails with a message naming what to add, and sends nothing', async () => {
    router.setCloudProviders({ anthropic: () => null, credits: () => null, openai: () => null })
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}) })
    const c = router.routedClient(null)
    expect(c).not.toBeNull() // local routing can still serve
    await expect(c!.messages.create({ model: 'route:openai:doc_rewrite:claude-sonnet-5-5', max_tokens: 5, messages: [] } as never)).rejects.toThrow(
      /OpenAI key, but none is saved/
    )
  })

  it('under source Local, a routed request runs with a grant (the egress guard lets only it through)', async () => {
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({ writing: 'openai' }) })
    let granted: unknown = 'unset'
    router.setCloudProviders({
      anthropic: () => null,
      credits: () => null,
      openai: () =>
        ({
          messages: {
            create: async () => {
              granted = router.currentCloudGrant()
              return { content: [], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }
            }
          }
        }) as never
    })
    const c = router.routedClient(null)!
    await c.messages.create({ model: 'route:openai:doc_rewrite:claude-sonnet-5-5', max_tokens: 5, messages: [] } as never)
    expect(granted).toMatchObject({ reason: 'feature-route', feature: 'writing' })
    expect(router.currentCloudGrant()).toBeUndefined()
  })
})
