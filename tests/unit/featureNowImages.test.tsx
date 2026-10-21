// Settings › AI › Local on this device › Feature by feature showed the Images
// row as "Now: On this device". Images are never made on the device: there is
// no on-device image model (NOT_TECHNICALLY_LOCAL), and while the source is
// Local each image or background-removal request asks before it goes to OpenAI
// or remove.bg (askCloudForNonLocalFeature). The row printed the raw
// effectiveRoutes value, which for media is the 'local' route it starts on.
//
// The same was true of any feature whose effective gate is 'cloud-only' while
// its route is local (agents and content writing under the "Ask before using
// cloud AI" policy): the router asks before each request, the row said "On this
// device". The row now says what the router does, from the same gate the row's
// own "you are asked before each request" note already reads.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AI_FEATURES,
  featureNowLabel,
  type AiFeature,
  type LocalAiStatus
} from '../../src/shared/localAi'
import LocalAiSection from '../../src/renderer/src/components/settings/LocalAiSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Gate = LocalAiStatus['gates'][AiFeature]
const gate = (g: Gate['gate']): Gate => ({ gate: g, localPassRate: null, cloudPassRate: null })

function status(provider: LocalAiStatus['provider'], over: Partial<Record<AiFeature, Gate['gate']>> = {}): LocalAiStatus {
  const route = provider === 'local' ? 'local' : provider === 'openai' ? 'openai' : provider === 'byok' ? 'anthropic' : 'credits'
  return {
    provider,
    featureRoutes: {},
    cloudProviders: { anthropic: false, openai: false, credits: false },
    effectiveRoutes: Object.fromEntries(AI_FEATURES.map((f) => [f, route])) as LocalAiStatus['effectiveRoutes'],
    contentWriting: 'cloud-if-key',
    preferredKey: 'anthropic',
    openaiModels: { fast: 'a', standard: 'b', best: 'c' },
    ramGB: 16,
    freeDiskBytes: null,
    recommendedTier: null,
    tiers: [],
    activeTier: null,
    engine: { state: 'idle', error: null, gpu: null },
    download: null,
    // Shapes as main reports them under 'local-first': media is always
    // cloud-only, agents' measured cloud-only is relaxed to labelled.
    gates: Object.fromEntries(
      AI_FEATURES.map((f) => [f, gate(over[f] ?? (f === 'media' ? 'cloud-only' : f === 'agents' ? 'labelled' : 'ok'))])
    ) as LocalAiStatus['gates'],
    policy: 'local-first',
    embeddings: { installed: false, name: 'e' },
    hardware: 'metal'
  }
}

describe('featureNowLabel', () => {
  it('Images with the source Local: asks first, never on this device', () => {
    const label = featureNowLabel('media', status('local'))
    expect(label).not.toBe('On this device')
    expect(label).toMatch(/^Asks before each request/)
    expect(label).toContain('Never on this device')
    expect(label).not.toContain('—')
  })

  it('Images with a cloud source: names the services that really get the request', () => {
    expect(featureNowLabel('media', status('byok'))).toBe('OpenAI (images) and remove.bg (backgrounds), with your keys')
  })

  it('a language feature gated cloud-only on the local route says it asks, like the row note', () => {
    expect(featureNowLabel('agents', status('local', { agents: 'cloud-only' }))).toBe('Asks before each request to use cloud AI')
    expect(featureNowLabel('writing', status('local', { writing: 'cloud-only' }))).toBe('Asks before each request to use cloud AI')
  })

  it('features that really run on the device, or on a cloud engine, keep their label', () => {
    expect(featureNowLabel('assistant', status('local'))).toBe('On this device')
    expect(featureNowLabel('agents', status('local'))).toBe('On this device')
    expect(featureNowLabel('assistant', status('openai'))).toBe('OpenAI (your key)')
  })
})

describe('the Feature by feature row as rendered', () => {
  let root: Root | null = null
  let host: HTMLElement | null = null
  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
    root = null
  })

  it('shows the Images row as asking first, not "Now: On this device"', async () => {
    const st = status('local')
    ;(window as unknown as { api: unknown }).api = {
      localAi: {
        getStatus: async () => st,
        coverage: async () => {
          throw new Error('not needed')
        },
        onProgress: () => () => undefined,
        onChanged: () => () => undefined,
        listOpenAIModels: async () => ({ ok: true, models: [] })
      },
      documents: {}
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<LocalAiSection />)
    })
    const media = host.querySelector('[data-testid="local-ai-now-media"]')
    expect(media).not.toBeNull()
    expect(media!.textContent).not.toContain('On this device')
    expect(media!.textContent).toContain('Asks before each request')
    // The assistant really runs on the device, and still says so.
    expect(host.querySelector('[data-testid="local-ai-now-assistant"]')!.textContent).toBe('Now: On this device')
  })
})
