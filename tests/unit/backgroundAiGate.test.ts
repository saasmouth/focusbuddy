// @vitest-environment node
// "Background AI tasks" (Settings > Data > Privacy), off by default. Two jobs used
// to send the person's content to a cloud AI with no click: the title backfill
// (Anthropic, at launch) and embeddings (OpenAI, on save, on opening Documents /
// PlexiiBrain, on a 5-minute sweep, and for search questions). Neither may reach
// a cloud provider unless the switch is on; a local model is not gated.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  background: false,
  cloudCalls: [] as string[][],
  local: null as null | { model: string; vectors: number[][] }
}))

vi.mock('../../src/main/privacyPrefs', () => ({ backgroundAiEnabled: () => state.background }))
vi.mock('../../src/main/ai/embeddings', () => ({
  embedTexts: vi.fn(async (texts: string[]) => {
    state.cloudCalls.push(texts)
    return { ok: true, vectors: texts.map(() => [1, 2, 3]), model: 'text-embedding-3-small' }
  })
}))
vi.mock('../../src/main/ai/localModel', () => ({
  localEmbed: vi.fn(async (texts: string[]) =>
    state.local ? { model: state.local.model, vectors: texts.map(() => [9]) } : null
  )
}))

import {
  BACKGROUND_AI_OFF,
  backgroundModelAllowed,
  gatedEmbedQueryTagged,
  gatedEmbedTexts,
  setLocalRouting
} from '../../src/main/backgroundAiGate'

const root = join(__dirname, '..', '..', 'src', 'main')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

beforeEach(() => {
  state.background = false
  state.cloudCalls = []
  state.local = null
  setLocalRouting(() => false)
})

describe('embeddings', () => {
  it('off, no local model: nothing is sent and the reason says so', async () => {
    const r = await gatedEmbedTexts(['secret plan'])
    expect(r).toEqual({ ok: false, reason: BACKGROUND_AI_OFF })
    expect(state.cloudCalls).toEqual([])
    expect(await gatedEmbedQueryTagged('a question')).toBeNull()
    expect(state.cloudCalls).toEqual([])
  })

  it('off, local Ollama model: embeds locally with the same model tag the store expects', async () => {
    state.local = { model: 'nomic-embed-text', vectors: [] }
    const r = await gatedEmbedTexts(['a', 'b'])
    expect(r).toMatchObject({ ok: true, model: 'ollama:nomic-embed-text' })
    expect(state.cloudCalls).toEqual([])
  })

  it('off, bundled local model tag passes through unchanged', async () => {
    state.local = { model: 'local:nomic', vectors: [] }
    expect(await gatedEmbedTexts(['a'])).toMatchObject({ ok: true, model: 'local:nomic' })
  })

  it('on: the normal route (which may be OpenAI with the person’s key)', async () => {
    state.background = true
    const r = await gatedEmbedTexts(['doc text'])
    expect(r.ok).toBe(true)
    expect(state.cloudCalls).toEqual([['doc text']])
  })

  it('AI set to run on this device counts as allowed (nothing leaves)', async () => {
    setLocalRouting(() => true)
    expect(backgroundModelAllowed()).toBe(true)
  })
})

describe('every embedding path in main goes through the gate', () => {
  it('the retrieval modules import the gated functions, not ai/embeddings', () => {
    for (const f of ['documentRetrieval.ts', 'semanticRetrieval.ts']) {
      const src = read(f)
      expect(src).toContain("from './backgroundAiGate'")
      expect(src).not.toMatch(/from '\.\/ai\/embeddings'/)
    }
  })

  it('nothing outside src/main/ai and the gate imports embedTexts / embedQuery directly', () => {
    const ipc = read('ipc/index.ts')
    expect(ipc).not.toMatch(/import \{[^}]*\bembed(Texts|Query|QueryTagged)\b[^}]*\} from '\.\.\/ai\/embeddings'/)
    expect(ipc).toContain('gatedEmbedQueryTagged(query)')
  })
})

describe('title backfill', () => {
  it('the launch call site passes the gate’s answer', () => {
    const idx = read('index.ts')
    expect(idx).toContain('runTitleBackfill({ allowModel: backgroundModelAllowed() })')
    expect(idx).not.toMatch(/runTitleBackfill\(\)/)
  })

  it('with allowModel false the model pass returns before any key or client is touched', () => {
    const src = read('titleBackfill.ts')
    const gate = src.indexOf('if (opts.allowModel === false)')
    const key = src.indexOf('resolveAnthropicKey()', src.indexOf('// ── Pass 2'))
    const client = src.indexOf('getModelClient(key)')
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(key)
    expect(gate).toBeLessThan(client)
  })
})
