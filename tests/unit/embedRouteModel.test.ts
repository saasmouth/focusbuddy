// @vitest-environment node
// Which embedder a backfill or a coverage figure is measured against. The
// reindexers re-embed any vector whose model tag differs from this answer, so it
// must name exactly the tag embedTexts would write — and, at the call sites, the
// tag the Background AI tasks gate would let through. Get it wrong and a sweep
// with the switch off would call every local vector stale while refusing the
// cloud route that would replace them.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  background: false,
  localOnly: false,
  openaiKey: null as string | null,
  embedModel: null as string | null,
  probeThrows: false
}))

vi.mock('../../src/main/privacyPrefs', () => ({ backgroundAiEnabled: () => state.background }))
vi.mock('../../src/main/settingsStore', () => ({ resolveOpenAIKey: () => state.openaiKey }))
vi.mock('../../src/main/ai/local/providerRouter', () => ({ localOnlyActive: () => state.localOnly }))
vi.mock('../../src/main/ai/localModel', () => ({
  localEmbed: async () => null,
  localModelStatus: async () => {
    if (state.probeThrows) throw new Error('probe failed')
    return { available: state.embedModel !== null, baseUrl: '', chatModel: null, embedModel: state.embedModel }
  }
}))

import { activeEmbedModel, EMBED_MODEL } from '../../src/main/ai/embeddings'
import { gatedActiveEmbedModel, setLocalRouting } from '../../src/main/backgroundAiGate'

beforeEach(() => {
  state.background = false
  state.localOnly = false
  state.openaiKey = null
  state.embedModel = null
  state.probeThrows = false
  setLocalRouting(() => false)
})

describe('activeEmbedModel (the ungated route)', () => {
  it('the bundled embedder keeps its own local: tag', async () => {
    state.embedModel = 'local:nomic-embed-text-v1.5'
    expect(await activeEmbedModel()).toBe('local:nomic-embed-text-v1.5')
  })
  it('an Ollama model is tagged ollama:, as embedTexts stores it', async () => {
    state.embedModel = 'nomic-embed-text'
    expect(await activeEmbedModel()).toBe('ollama:nomic-embed-text')
  })
  it('no local model: OpenAI when a key is saved, else none', async () => {
    expect(await activeEmbedModel()).toBeNull()
    state.openaiKey = 'sk-test'
    expect(await activeEmbedModel()).toBe(EMBED_MODEL)
  })
  it('AI set to run on this device never names the cloud model', async () => {
    state.openaiKey = 'sk-test'
    state.localOnly = true
    expect(await activeEmbedModel()).toBeNull()
  })
  it('a failed local probe falls through to the cloud route, never throws', async () => {
    state.probeThrows = true
    state.openaiKey = 'sk-test'
    expect(await activeEmbedModel()).toBe(EMBED_MODEL)
  })
})

describe('gatedActiveEmbedModel (what backfills and coverage use)', () => {
  it('Background AI off: a saved OpenAI key does not count', async () => {
    state.openaiKey = 'sk-test'
    expect(await gatedActiveEmbedModel()).toBeNull()
  })
  it('Background AI off: the local model still counts', async () => {
    state.openaiKey = 'sk-test'
    state.embedModel = 'nomic-embed-text'
    expect(await gatedActiveEmbedModel()).toBe('ollama:nomic-embed-text')
  })
  it('Background AI on: the live route, cloud included', async () => {
    state.background = true
    state.openaiKey = 'sk-test'
    expect(await gatedActiveEmbedModel()).toBe(EMBED_MODEL)
  })
  it('never throws', async () => {
    state.probeThrows = true
    expect(await gatedActiveEmbedModel()).toBeNull()
  })
})
