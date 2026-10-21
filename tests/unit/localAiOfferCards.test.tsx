// The two fixed local-AI cards, for people who UPDATE to 4.3.40.
//
// Before: the migration put every 'auto'/unset profile on Local whether or not
// a model was here, so an update-zip or Windows user got a banner with no way
// to dismiss it ("Until it is, AI features cannot answer") and an AI that
// could not answer, while their own key or credits sat unused. Now:
//   - the one-time card OFFERS Local as a download (size, Download, Not now)
//     and says the current source has not changed; it is hidden while a
//     bundled model is still being checked and on a low-memory computer;
//   - the "needs a one-time download" banner appears only when a feature
//     really routes to the device, says which, and can be dismissed;
//   - the AI source chooser's Local card says "Included" only when the model is
//     here, and MemoryPanel no longer tells anyone to "Start Ollama".
import { act } from 'react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_FEATURES, type AiFeature, type LocalAiStatus } from '../../src/shared/localAi'
import { introView, missingBanner, localSourceSub, noLocalModelNote, type IntroInfo } from '../../src/renderer/src/lib/localAiOffer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TIER = {
  id: 'compact' as const,
  bundleId: 'qwen3-4b-instruct-2507',
  name: 'Qwen3 4B Instruct',
  file: 'q.gguf',
  version: '1',
  sizeBytes: 2_497_281_120,
  sha256: 'x'.repeat(64),
  license: 'Apache-2.0',
  licenseUrl: '',
  sourceUrl: '',
  contextSize: 16384,
  kvCache: 'q8_0' as const,
  minRamGB: 8,
  recommendedRamGB: 8
}

function status(provider: LocalAiStatus['provider'], opts: { installed?: boolean; ram?: number; routes?: Partial<Record<AiFeature, LocalAiStatus['effectiveRoutes'][AiFeature]>> } = {}): LocalAiStatus {
  const route = provider === 'local' ? 'local' : provider === 'openai' ? 'openai' : provider === 'byok' ? 'anthropic' : 'credits'
  const ram = opts.ram ?? 16
  const offered = ram >= TIER.minRamGB
  return {
    provider,
    featureRoutes: {},
    cloudProviders: { anthropic: false, openai: false, credits: false },
    effectiveRoutes: { ...(Object.fromEntries(AI_FEATURES.map((f) => [f, route])) as LocalAiStatus['effectiveRoutes']), ...(opts.routes ?? {}) },
    contentWriting: 'cloud-if-key',
    preferredKey: 'anthropic',
    openaiModels: { fast: 'a', standard: 'b', best: 'c' },
    ramGB: ram,
    freeDiskBytes: 100e9,
    recommendedTier: offered ? 'compact' : null,
    tiers: [{ ...TIER, installed: opts.installed ?? false, offered, source: opts.installed ? 'userData' : null }],
    activeTier: offered ? 'compact' : null,
    engine: { state: 'idle', error: null, gpu: null },
    download: null,
    gates: Object.fromEntries(AI_FEATURES.map((f) => [f, { gate: 'ok', localPassRate: null, cloudPassRate: null }])) as LocalAiStatus['gates'],
    policy: 'local-first',
    embeddings: { installed: false, name: 'e' },
    hardware: 'metal'
  }
}

const intro = (over: Partial<IntroInfo>): IntroInfo => ({
  pending: true,
  from: 'auto',
  mode: 'auto',
  contentKey: null,
  model: { state: 'absent', tierId: 'compact', bytes: 2_643_427_552 },
  ...over
})

describe('which one-time card', () => {
  it('no model, on another engine: the download offer', () => {
    expect(introView(intro({}))).toBe('offer')
    expect(introView(intro({ mode: 'byok', from: 'byok' }))).toBe('offer')
  })
  it('a verified model: the "now built in" card', () => {
    expect(introView(intro({ mode: 'local', model: { state: 'ready', tierId: 'compact', bytes: 0 } }))).toBe('built-in')
  })
  it('nothing while the bundled model is being checked, on a low-memory computer, or once dismissed', () => {
    expect(introView(intro({ model: { state: 'checking', tierId: 'compact', bytes: 1 } }))).toBe('none')
    expect(introView(intro({ model: { state: 'unsupported', tierId: null, bytes: 0 } }))).toBe('none')
    expect(introView(intro({ pending: false }))).toBe('none')
  })
  it('already on Local without a model: the banner covers it, not a second card', () => {
    expect(introView(intro({ mode: 'local' }))).toBe('none')
  })
})

describe('the "needs a one-time download" banner', () => {
  it('never while AI works on another engine', () => {
    for (const p of ['credits', 'byok', 'openai'] as const) expect(missingBanner(status(p))).toBeNull()
  })
  it('the source is Local and the model is missing: all of AI', () => {
    const b = missingBanner(status('local'))!
    expect(b.all).toBe(true)
    expect(b.bytes).toBeGreaterThan(TIER.sizeBytes)
  })
  it('only some features route to the device: names them, and ignores Images (never on the device)', () => {
    const b = missingBanner(status('credits', { routes: { summaries: 'local', media: 'local' } }))!
    expect(b.all).toBe(false)
    expect(b.features).toEqual(['Summaries'])
  })
  it('not when the model is here, nor on a low-memory computer (a download cannot fix that)', () => {
    expect(missingBanner(status('local', { installed: true }))).toBeNull()
    expect(missingBanner(status('local', { ram: 4 }))).toBeNull()
  })
})

describe('copy that is true for the bundled engine', () => {
  it('the Local source card says "Included" only when the model is here', () => {
    expect(localSourceSub({ installed: true, bytes: 1, offered: true })).toMatch(/^Included with PlexiiDesk/)
    expect(localSourceSub({ installed: false, bytes: 2_497_281_120, offered: true })).toBe('One-time download (2.5 GB); requests stay on this computer')
    expect(localSourceSub({ installed: false, bytes: 1, offered: false })).toMatch(/more memory/)
  })

  it('MemoryPanel: no model means "download it", with Ollama only as the advanced option where nothing else can work', () => {
    const notDownloaded = noLocalModelNote(status('auto'))
    expect(notDownloaded).toMatch(/not downloaded yet/)
    expect(notDownloaded).toContain('Settings › AI › Local on this device')
    expect(notDownloaded).toContain('2.5 GB')
    expect(notDownloaded).not.toMatch(/Ollama/)
    const lowMem = noLocalModelNote(status('auto', { ram: 4 }))
    expect(lowMem).toMatch(/4 GB of memory/)
    expect(lowMem).toMatch(/Advanced: an Ollama server/)
    const src = readFileSync(join(__dirname, '../../src/renderer/src/components/brain/MemoryPanel.tsx'), 'utf8')
    expect(src).not.toMatch(/Start Ollama/)
    expect(src).toContain('noLocalModelNote(')
  })
})

describe('LocalAiPrompts as rendered', () => {
  let root: Root | null = null
  let host: HTMLElement | null = null
  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
    root = null
    vi.resetModules()
  })

  async function mount(st: LocalAiStatus, info: IntroInfo) {
    const calls: string[] = []
    let changed: (() => void) | null = null
    let current = { st, info }
    ;(window as unknown as { api: unknown }).api = {
      localAi: {
        getStatus: async () => current.st,
        getIntro: async () => current.info,
        dismissIntro: async () => {
          calls.push('dismissIntro')
          return { ok: true }
        },
        download: async (t: string) => {
          calls.push(`download:${t}`)
          return { ok: false, error: 'The download server does not have this model (it answered 404), so nothing was downloaded.' }
        },
        cancelDownload: async () => ({ ok: true }),
        onChanged: (f: () => void) => {
          changed = f
          return () => undefined
        },
        onProgress: () => () => undefined,
        onConsentRequest: () => () => undefined,
        onNotice: () => () => undefined,
        onGrounding: () => () => undefined,
        onAnswered: () => () => undefined,
        onEngine: () => () => undefined,
        getEngine: async () => ({ state: 'idle', waiting: 0, lastLoadMs: null, error: null, preload: null })
      },
      ai: { setMode: async () => ({}), getStatus: async () => null, onCreditEvent: () => () => undefined }
    }
    const { default: LocalAiPrompts } = await import('../../src/renderer/src/components/LocalAiPrompts')
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(<LocalAiPrompts />)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    return {
      calls,
      q: (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null,
      fire: async (next: { st?: LocalAiStatus; info?: IntroInfo }) => {
        current = { st: next.st ?? current.st, info: next.info ?? current.info }
        await act(async () => {
          changed?.()
          await new Promise((r) => setTimeout(r, 0))
        })
      }
    }
  }

  it('an updated user with no model on credits: the offer with size and Download, no blocking banner', async () => {
    const v = await mount(status('credits'), intro({}))
    const card = v.q('local-ai-intro')
    expect(card).not.toBeNull()
    expect(card!.getAttribute('data-variant')).toBe('offer')
    expect(card!.textContent).toContain('one-time download of 2.6 GB')
    expect(v.q('local-ai-intro-unchanged')!.textContent).toContain('You are using Plexii AI credits; that has not changed')
    expect(v.q('local-ai-missing')).toBeNull()
    // Download says what the server said, and the card stays to retry.
    await act(async () => {
      v.q('local-ai-intro-download')!.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(v.calls).toContain('download:compact')
    expect(v.q('local-ai-intro-error')!.textContent).toContain('answered 404')
    // Not now: dismissed, and recorded.
    await act(async () => {
      v.q('local-ai-intro-dismiss')!.click()
    })
    expect(v.q('local-ai-intro')).toBeNull()
    expect(v.calls).toContain('dismissIntro')
  })

  it('after the download completes, the switch to Local shows the "now built in" card even though the offer was dismissed', async () => {
    const v = await mount(status('credits'), intro({}))
    await act(async () => {
      v.q('local-ai-intro-dismiss')!.click()
    })
    expect(v.q('local-ai-intro')).toBeNull()
    await v.fire({ st: status('local', { installed: true }), info: intro({ mode: 'local', model: { state: 'ready', tierId: 'compact', bytes: 0 } }) })
    const card = v.q('local-ai-intro')
    expect(card).not.toBeNull()
    expect(card!.getAttribute('data-variant')).toBeNull()
    expect(card!.textContent).toContain('Local AI is now built in')
    expect(v.q('local-ai-intro-switch-back')!.textContent).toContain('Switch back to Plexii AI credits')
  })

  it('AI set to Local with no model: the banner shows, and can be dismissed', async () => {
    const v = await mount(status('local'), intro({ pending: false, mode: 'local' }))
    const banner = v.q('local-ai-missing')
    expect(banner).not.toBeNull()
    expect(v.q('local-ai-missing-scope')!.textContent).toContain('choose another AI source')
    await act(async () => {
      v.q('local-ai-missing-dismiss')!.click()
    })
    expect(v.q('local-ai-missing')).toBeNull()
  })

  it('a low-memory computer on its own key: neither card', async () => {
    const v = await mount(status('byok', { ram: 4 }), intro({ mode: 'byok', from: 'byok', model: { state: 'unsupported', tierId: null, bytes: 0 } }))
    expect(v.q('local-ai-intro')).toBeNull()
    expect(v.q('local-ai-missing')).toBeNull()
  })
})
