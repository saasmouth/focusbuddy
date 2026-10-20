// @vitest-environment node
// The provider router: which requests run on the device, which reach cloud,
// and the measured quality gates with the "use cloud for this request" consent.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import {
  setRouterSettings,
  setLocalRuntime,
  setConsentAsker,
  setNoticeSink,
  setGateResolver,
  setCloudModelResolver,
  routedClient,
  routeForPurpose,
  cloudRoutedFromLocal,
  providerChoice,
  currentCloudGrant,
  LocalUnavailableError,
  LocalModelMissingError,
  resetNotices
} from '../../src/main/ai/local/providerRouter'
import { resolveModel, setLocalRouteResolver, routeModel, MODEL_HAIKU } from '../../src/main/ai/modelRouting'
import type { LocalGateInfo } from '../../src/shared/localAi'

const localReply = { text: '{"reply":"local","actions":[]}', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' as const, ttftMs: 0, totalMs: 0 }
let engineCalls = 0
const engine = { generate: async () => (engineCalls++, localReply) }

function cloudClient(): Anthropic & { calls: Array<{ body: Record<string, unknown>; grant: unknown }> } {
  const calls: Array<{ body: Record<string, unknown>; grant: unknown }> = []
  return {
    calls,
    baseURL: 'https://api.anthropic.com',
    messages: {
      create: async (body: Record<string, unknown>) => {
        calls.push({ body, grant: currentCloudGrant() })
        return { content: [{ type: 'text', text: 'cloud' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, model: body.model }
      }
    }
  } as never
}

const gate = (g: LocalGateInfo['gate']): LocalGateInfo => ({ gate: g, localPassRate: 0.2, cloudPassRate: 0.95, family: 'build' })
const text = (m: Anthropic.Message): string => (m.content[0] as { text: string }).text

function setMode(
  mode: 'local' | 'byok' | 'auto',
  routes: Record<string, 'local' | 'cloud'> = {},
  policy: 'measured' | 'local-first' = 'measured'
): void {
  setRouterSettings({ aiMode: () => mode, featureRoutes: () => routes, policy: () => policy })
}

beforeEach(() => {
  engineCalls = 0
  resetNotices()
  setMode('auto')
  setLocalRuntime({ engine: async () => engine as never, modelLabel: () => 'test', installed: () => true })
  setLocalRouteResolver((p) => routeForPurpose(p) === 'local', cloudRoutedFromLocal)
  setGateResolver(() => gate('ok'))
  setConsentAsker(async () => false)
  setNoticeSink(() => undefined)
  setCloudModelResolver(() => 'claude-sonnet-5-5')
})

describe('choice and routing', () => {
  it('maps the settings mode to the three user-facing sources', () => {
    setMode('local')
    expect(providerChoice()).toBe('local')
    setMode('byok')
    expect(providerChoice()).toBe('byok')
    setMode('auto')
    expect(providerChoice()).toBe('credits')
  })

  it('names local purposes in the model id, and leaves cloud model choice untouched', () => {
    setMode('local')
    expect(resolveModel('chat')).toBe('local:chat')
    expect(routeModel('meeting_end', MODEL_HAIKU)).toBe('local:meeting_end')
    setMode('byok')
    expect(resolveModel('chat')).toMatch(/^claude-/)
    expect(routeModel('meeting_end', MODEL_HAIKU)).toBe(MODEL_HAIKU)
  })

  it('honours per-feature routes in both directions', () => {
    setMode('local', { build: 'cloud' })
    // Tagged, so the routed client sends it to cloud on purpose (not as a stray id).
    expect(resolveModel('setup')).toMatch(/^cloudroute:setup:claude-/)
    expect(resolveModel('chat')).toBe('local:chat')
    setMode('byok', { background: 'local' })
    expect(resolveModel('title_backfill')).toBe('local:title_backfill')
    expect(resolveModel('chat')).toMatch(/^claude-/)
  })

  it('passes requests to the cloud client unchanged when nothing routes locally', async () => {
    setMode('byok')
    const c = cloudClient()
    const r = routedClient(c)!
    expect((r as unknown as { baseURL: string }).baseURL).toBe('https://api.anthropic.com')
    const body = { model: 'claude-sonnet-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }
    await r.messages.create(body as never)
    expect(c.calls[0].body).toBe(body)
    expect(engineCalls).toBe(0)
    expect(routedClient(null)).toBeNull()
  })
})

describe('the routed client', () => {
  it('serves local requests on the device even with no cloud client at all', async () => {
    setMode('local')
    const c = routedClient(null)!
    const m = await c.messages.create({ model: resolveModel('chat'), max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    expect(text(m)).toContain('local')
    expect(engineCalls).toBe(1)
  })

  it('runs a hard-coded cloud model id on the device while the source is Local', async () => {
    setMode('local')
    const cloud = cloudClient()
    const m = await routedClient(cloud)!.messages.create({ model: MODEL_HAIKU, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    expect(text(m)).toContain('local')
    expect(cloud.calls).toHaveLength(0)
  })

  it('sends a feature routed to cloud to cloud, under a grant', async () => {
    setMode('local', { build: 'cloud' })
    const cloud = cloudClient()
    await routedClient(cloud)!.messages.create({ model: resolveModel('setup'), max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    expect(cloud.calls).toHaveLength(1)
    expect(cloud.calls[0].grant).toMatchObject({ reason: 'feature-route' })
    expect(engineCalls).toBe(0)
  })

  it('says plainly when the model is not downloaded', async () => {
    setMode('local')
    setLocalRuntime({ engine: async () => { throw new LocalModelMissingError() }, modelLabel: () => 'none', installed: () => false })
    await expect(routedClient(null)!.messages.create({ model: 'local:chat', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/not downloaded/)
  })
})

describe('quality gates', () => {
  it('cloud-only + the user declines: nothing is sent anywhere and the error says why', async () => {
    setMode('local')
    setGateResolver(() => gate('cloud-only'))
    const ask = vi.fn(async () => false)
    setConsentAsker(ask)
    const cloud = cloudClient()
    const p = routedClient(cloud)!.messages.create({ model: 'local:setup', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    await expect(p).rejects.toBeInstanceOf(LocalUnavailableError)
    await expect(p).rejects.toThrow(/20%.*95%.*Nothing was sent/)
    expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0][0]).toMatchObject({ feature: 'build', cloudAvailable: true })
    expect(cloud.calls).toHaveLength(0)
    expect(engineCalls).toBe(0)
  })

  it('cloud-only + the user agrees: exactly this request goes to cloud, with the cloud model', async () => {
    setMode('local')
    setGateResolver(() => gate('cloud-only'))
    setConsentAsker(async () => true)
    const cloud = cloudClient()
    const m = await routedClient(cloud)!.messages.create({ model: 'local:setup', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    expect(text(m)).toBe('cloud')
    expect(cloud.calls).toHaveLength(1)
    expect(cloud.calls[0].body.model).toBe('claude-sonnet-5-5')
    expect(cloud.calls[0].grant).toMatchObject({ reason: 'consent', feature: 'build' })
    expect(currentCloudGrant()).toBeUndefined()
  })

  it('cloud-only + yes but no cloud configured: an honest setup error, still nothing sent', async () => {
    setMode('local')
    setGateResolver(() => gate('cloud-only'))
    const ask = vi.fn(async () => true)
    setConsentAsker(ask)
    await expect(routedClient(null)!.messages.create({ model: 'local:setup', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/not set up/)
    expect(ask.mock.calls[0][0]).toMatchObject({ cloudAvailable: false })
  })

  it('labelled: runs on the device and tells the user once per feature', async () => {
    setMode('local')
    setGateResolver(() => gate('labelled'))
    const notices: string[] = []
    setNoticeSink((_f, m) => notices.push(m))
    const c = routedClient(null)!
    await c.messages.create({ model: 'local:setup', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] })
    await c.messages.create({ model: 'local:setup', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] })
    expect(engineCalls).toBe(2)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/Works best with cloud AI; local results may be incomplete/)
  })

  it('a hard-coded call site that needs cloud keeps its own model id when the user agrees', async () => {
    setMode('local')
    setGateResolver(() => gate('cloud-only'))
    setConsentAsker(async () => true)
    setCloudModelResolver(() => undefined as unknown as string)
    const cloud = cloudClient()
    await routedClient(cloud)!.messages.create({ model: MODEL_HAIKU, max_tokens: 1, messages: [{ role: 'user', content: 'x' }] })
    expect(cloud.calls[0].body.model).toBe(MODEL_HAIKU)
    await routedClient(cloud)!.messages.create({ model: 'local:enrichment', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] })
    expect(cloud.calls[1].body.model).toBeTruthy()
  })

})

describe('routing policy', () => {
  it('local-first runs a cloud-only feature on the device, with the label; media still asks', async () => {
    const { effectiveGate } = await import('../../src/main/ai/local/providerRouter')
    setMode('local', {}, 'local-first')
    setGateResolver(() => gate('cloud-only'))
    expect(effectiveGate('setup').gate).toBe('labelled')
    expect(effectiveGate('media').gate).toBe('cloud-only')
    const ask = vi.fn(async () => false)
    setConsentAsker(ask)
    const m = await routedClient(cloudClient())!.messages.create({ model: 'local:setup', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] })
    expect(text(m)).toContain('local')
    expect(ask).not.toHaveBeenCalled()
    setMode('local', {}, 'measured')
    expect(effectiveGate('setup').gate).toBe('cloud-only')
  })

  it('local-first offers cloud when the local answer is unusable; measured does not', async () => {
    setGateResolver(() => gate('ok'))
    const bad = { generate: async () => ({ text: '{"nope":1}', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' as const, ttftMs: 0, totalMs: 0 }) }
    setLocalRuntime({ engine: async () => bad as never, modelLabel: () => 'test', installed: () => true })
    const body = { model: 'local:chat', max_tokens: 5, system: 'MUST be a single valid JSON object {"reply": ""}', messages: [{ role: 'user', content: 'x' }] }
    const ask = vi.fn(async () => true)
    setConsentAsker(ask)
    setMode('local', {}, 'measured')
    const cloud1 = cloudClient()
    // A known contract that cannot be met fails plainly; it is never passed off as the answer.
    await expect(routedClient(cloud1)!.messages.create(body)).rejects.toThrow(/could not produce a reply.*Nothing was sent anywhere/)
    expect(ask).not.toHaveBeenCalled()
    expect(cloud1.calls).toHaveLength(0)
    setMode('local', {}, 'local-first')
    const cloud2 = cloudClient()
    const m = await routedClient(cloud2)!.messages.create(body)
    expect(ask).toHaveBeenCalledOnce()
    expect(text(m)).toBe('cloud')
    expect(cloud2.calls[0].grant).toMatchObject({ reason: 'consent' })
  })

  it('a request needing tool use asks first under either policy, and sends nothing on no', async () => {
    setGateResolver(() => gate('ok'))
    const ask = vi.fn(async () => false)
    setConsentAsker(ask)
    for (const policy of ['measured', 'local-first'] as const) {
      setMode('local', {}, policy)
      const cloud = cloudClient()
      await expect(
        routedClient(cloud)!.messages.create({ model: 'local:desk_agent', max_tokens: 5, tools: [{ name: 't' }], messages: [{ role: 'user', content: 'x' }] } as never)
      ).rejects.toThrow(/Nothing was sent anywhere/)
      expect(cloud.calls).toHaveLength(0)
    }
    expect(ask).toHaveBeenCalledTimes(2)
  })
})

describe('content-writing switch (one flag)', () => {
  it("'local' runs measured-weak content writing on the device with a note; 'ask' makes it ask; nothing else changes", async () => {
    const router = await import('../../src/main/ai/local/providerRouter')
    const { DEFAULT_CONTENT_WRITING } = await import('../../src/shared/localAi')
    expect(DEFAULT_CONTENT_WRITING).toBe('cloud-if-key')
    const cloudOnly = () => ({ gate: 'cloud-only' as const, localPassRate: 0.2, cloudPassRate: 0.55, family: null })
    router.setGateResolver(cloudOnly)
    let flag: 'local' | 'ask' = 'local'
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}), policy: () => 'local-first', contentWriting: () => flag })
    expect(router.effectiveGate('document').gate).toBe('labelled')
    expect(router.effectiveGate('doc_rewrite').gate).toBe('labelled')
    expect(router.effectiveGate('setup').gate).toBe('labelled')
    flag = 'ask'
    expect(router.effectiveGate('document').gate).toBe('cloud-only')
    expect(router.effectiveGate('doc_rewrite').gate).toBe('cloud-only')
    expect(router.effectiveGate('setup').gate).toBe('cloud-only')
    // Not content writing: unaffected by the switch.
    expect(router.effectiveGate('trail_summary').gate).toBe('labelled')
    expect(router.effectiveGate('chat').gate).toBe('labelled')
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}) })
    router.setGateResolver(() => ({ gate: 'ok', localPassRate: null, cloudPassRate: null, family: null }))
  })
})
