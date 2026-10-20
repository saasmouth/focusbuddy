// @vitest-environment node
// Content writing = "cloud when a key exists" (owner decision, 2026-10-21):
// writing, office and build use the person's own Anthropic or OpenAI key when
// one is saved and the source is Local; with no key they run on the device with
// the quality note; a key that fails answers that request on the device with a
// note; an explicit per-feature choice always wins; everything else stays
// local-first. Every case, through the real router.
import { describe, it, expect, beforeEach } from 'vitest'
import * as router from '../../src/main/ai/local/providerRouter'

type Call = { who: string; model: string; grant: unknown }
let calls: Call[]
let notices: Array<{ feature: string; message: string; action?: string }>
let answers: Array<{ feature: string; engine: string }>
let localCalls: number
let fail: Partial<Record<'anthropic' | 'openai', Error>>

function provider(who: 'anthropic' | 'openai') {
  return {
    baseURL: who === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1',
    messages: {
      create: async (body: { model: string }) => {
        calls.push({ who, model: body.model, grant: router.currentCloudGrant() })
        if (fail[who]) throw fail[who]
        return { content: [{ type: 'text', text: `from ${who}` }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
      },
      stream: (body: { model: string }) => {
        calls.push({ who: `${who}-stream`, model: body.model, grant: router.currentCloudGrant() })
        const listeners: Array<(d: string) => void> = []
        const err = fail[who]
        return {
          on: (_e: string, fn: (d: string) => void) => listeners.push(fn),
          abort: () => undefined,
          finalMessage: async () => {
            await Promise.resolve()
            if (err) throw err
            for (const l of listeners) l(`streamed from ${who}`)
            return { content: [{ type: 'text', text: `streamed from ${who}` }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
          }
        }
      }
    }
  } as never
}

let keys: { anthropic: boolean; openai: boolean }
let routes: Record<string, string>
let mode: 'local' | 'byok' | 'auto' | 'openai' | 'credits'
let preferred: 'anthropic' | 'openai' | undefined
let installed: boolean

beforeEach(() => {
  calls = []
  notices = []
  answers = []
  localCalls = 0
  fail = {}
  keys = { anthropic: true, openai: true }
  routes = {}
  mode = 'local'
  preferred = undefined
  installed = true
  const a = provider('anthropic')
  const o = provider('openai')
  router.setCloudProviders({ anthropic: () => (keys.anthropic ? a : null), openai: () => (keys.openai ? o : null), credits: () => null })
  router.setRouterSettings({
    aiMode: () => mode,
    featureRoutes: () => routes as never,
    policy: () => 'local-first',
    preferredKey: () => preferred ?? 'anthropic'
  })
  router.setGateResolver((p) =>
    ['document', 'doc_rewrite', 'setup'].includes(p)
      ? { gate: 'cloud-only', localPassRate: 0.2, cloudPassRate: 0.58, family: null }
      : { gate: 'ok', localPassRate: 0.8, cloudPassRate: 0.9, family: null }
  )
  router.setLocalRuntime({
    installed: () => installed,
    modelLabel: () => 'qwen3-4b',
    engine: async () =>
      ({
        generate: async (_r: unknown, o?: { onText?: (d: string) => void }) => {
          localCalls++
          o?.onText?.('local text')
          return { text: 'local text', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', ttftMs: 1, totalMs: 1 }
        }
      }) as never
  })
  router.setNoticeSink((feature, message, action) => notices.push({ feature, message, action }))
  router.setAnsweredSink((x) => answers.push({ feature: x.feature, engine: x.engine }))
  router.setCreditFallback({ isCredits: () => false, refusal: () => null })
})

const ask = (purpose: string, cloudModel = 'claude-sonnet-5-5') =>
  router.routedClient(null)!.messages.create({ model: router.tagModel(purpose, cloudModel), max_tokens: 10, messages: [{ role: 'user', content: 'x' }] } as never)

describe('content writing: cloud when a key exists', () => {
  it('is the default', async () => {
    const { DEFAULT_CONTENT_WRITING } = await import('../../src/shared/localAi')
    expect(DEFAULT_CONTENT_WRITING).toBe('cloud-if-key')
    expect(router.currentContentWriting()).toBe('cloud-if-key')
  })

  it('both keys: writing, office and build go to Anthropic (the default preference), under a grant', async () => {
    for (const p of ['doc_rewrite', 'document', 'setup']) {
      expect(router.tagModel(p, 'm')).toBe(`route:key-anthropic:${p}:m`)
      await ask(p)
    }
    expect(calls.map((c) => c.who)).toEqual(['anthropic', 'anthropic', 'anthropic'])
    expect(calls.every((c) => c.model === 'claude-sonnet-5-5')).toBe(true)
    expect(calls.every((c) => (c.grant as { reason?: string })?.reason === 'feature-route')).toBe(true)
    expect(answers.map((a) => a.engine)).toEqual(['anthropic', 'anthropic', 'anthropic'])
    expect(router.effectiveRouteFor('office')).toBe('anthropic')
  })

  it('both keys, OpenAI marked preferred: OpenAI', async () => {
    preferred = 'openai'
    await ask('document')
    expect(calls[0].who).toBe('openai')
    expect(router.effectiveRouteFor('writing')).toBe('openai')
  })

  it('only one key: that key, whichever is preferred', async () => {
    keys = { anthropic: false, openai: true }
    await ask('doc_rewrite')
    expect(calls[0].who).toBe('openai')
    keys = { anthropic: true, openai: false }
    preferred = 'openai'
    await ask('doc_rewrite')
    expect(calls[1].who).toBe('anthropic')
  })

  it('no key: on the device, with the quality note, nothing sent', async () => {
    keys = { anthropic: false, openai: false }
    expect(router.tagModel('document', 'm')).toBe('local:document')
    const m = await ask('document')
    expect((m.content[0] as { text: string }).text).toBe('local text')
    expect(calls).toEqual([])
    expect(localCalls).toBe(1)
    expect(notices[0].message).toMatch(/Works best with cloud AI/)
    expect(answers).toEqual([{ feature: 'office', engine: 'local' }])
    expect(router.effectiveRouteFor('office')).toBe('local')
  })

  it('assistant, background and summaries stay on the device even with keys', async () => {
    for (const p of ['chat', 'title_backfill', 'trail_summary']) expect(router.tagModel(p, 'm')).toBe(`local:${p}`)
    await ask('chat')
    expect(calls).toEqual([])
    expect(router.effectiveRouteFor('assistant')).toBe('local')
    expect(router.effectiveRouteFor('summaries')).toBe('local')
  })

  it('an explicit per-feature choice always wins', async () => {
    routes = { writing: 'local', office: 'openai' }
    expect(router.tagModel('doc_rewrite', 'm')).toBe('local:doc_rewrite')
    expect(router.tagModel('document', 'm')).toBe('route:openai:document:m')
    expect(router.tagModel('setup', 'm')).toBe('route:key-anthropic:setup:m')
  })

  it('only while the source is Local: a cloud source routes as before', () => {
    mode = 'byok'
    expect(router.tagModel('document', 'm')).toBe('route:cloud:document:m')
    expect(router.contentKeyFor('document')).toBeNull()
  })

  it("the 'local' and 'ask' settings keep content writing off the keys", () => {
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}), policy: () => 'local-first', contentWriting: () => 'local' })
    expect(router.tagModel('document', 'm')).toBe('local:document')
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}), policy: () => 'local-first', contentWriting: () => 'ask' })
    expect(router.tagModel('document', 'm')).toBe('local:document')
    expect(router.effectiveGate('document').gate).toBe('cloud-only')
  })

  it('a key that is refused (401) answers on the device for that request, with a note', async () => {
    fail.anthropic = Object.assign(new Error('401 invalid x-api-key'), { status: 401 })
    const m = await ask('document')
    expect((m.content[0] as { text: string }).text).toBe('local text')
    expect(notices.at(-1)).toMatchObject({ feature: 'office', action: 'keys' })
    expect(notices.at(-1)!.message).toMatch(/Your Anthropic key was refused, so this was answered by the on-device AI/)
    expect(answers.at(-1)).toEqual({ feature: 'office', engine: 'local' })
  })

  it('a key out of credit (OpenAI 429) answers on the device too', async () => {
    keys = { anthropic: false, openai: true }
    fail.openai = new Error('OpenAI (429): You exceeded your current quota.')
    const m = await ask('doc_rewrite')
    expect((m.content[0] as { text: string }).text).toBe('local text')
    expect(notices.at(-1)!.message).toMatch(/Your OpenAI key is out of credit or rate-limited/)
  })

  it('other failures, or no device model, are not hidden', async () => {
    fail.anthropic = Object.assign(new Error('500 overloaded'), { status: 500 })
    await expect(ask('document')).rejects.toThrow(/overloaded/)
    fail.anthropic = Object.assign(new Error('401 invalid'), { status: 401 })
    installed = false
    await expect(ask('document')).rejects.toThrow(/401/)
    expect(localCalls).toBe(0)
  })

  it('streaming: the key streams; refused before any text → the device streams instead', async () => {
    const s1 = router.routedClient(null)!.messages.stream({ model: router.tagModel('document', 'm'), max_tokens: 5, messages: [] } as never)
    const got: string[] = []
    s1.on('text', (d: string) => got.push(d))
    await s1.finalMessage()
    expect(got).toEqual(['streamed from anthropic'])
    fail.anthropic = Object.assign(new Error('401'), { status: 401 })
    const s2 = router.routedClient(null)!.messages.stream({ model: router.tagModel('document', 'm'), max_tokens: 5, messages: [] } as never)
    const got2: string[] = []
    s2.on('text', (d: string) => got2.push(d))
    await s2.finalMessage()
    expect(got2).toEqual(['local text'])
    expect(notices.at(-1)!.action).toBe('keys')
  })
})
