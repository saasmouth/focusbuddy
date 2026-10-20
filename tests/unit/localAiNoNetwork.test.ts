// @vitest-environment node
//
// THE local-mode guarantee: with the AI source set to "Local on this device",
// running the app's AI features opens no connection to anything but localhost.
//
// This drives the REAL feature functions (PlexiiAssist chat, streaming chat,
// Build with AI, writing, PlexiiBrain answers, document descriptions, titles,
// embeddings, voice-note processing, mind maps, custom work widgets) with:
//   - an Anthropic key AND an OpenAI key present in the environment,
//   - a signed-in Plexii session (so the credits proxy is reachable in policy),
// and spies on every way the main process can reach a network: fetch,
// http/https request+get, net/tls connect and dns lookup. The egress guard is
// deliberately NOT installed here: this proves the router keeps the traffic
// local by itself. The guard has its own test (localAiEgressGuard.test.ts).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'

const USERDATA = mkdtempSync(join(tmpdir(), 'plexii-nonet-'))
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, getName: () => 'plexii', getVersion: () => '0.0.0-test', isPackaged: false, on: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: { openExternal: async () => undefined },
  net: {},
  default: {}
}))
let db: import('../../src/web/worker/sqlite').SqliteDb
vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
// Signed in: the credits proxy would be chosen by policy if anything let it.
vi.mock('../../src/main/db/account', () => ({
  accountEmail: () => 'nonet@test.local',
  loadAccountState: () => ({ sessionToken: 'session-token-for-test', skippedAt: null, cachedEmail: 'nonet@test.local' }),
  markUiVisible: () => {}
}))

const remote: string[] = []
const restores: Array<() => void> = []
function isLocal(host: string | undefined): boolean {
  return !host || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)
}
function spy<T extends object>(obj: T, key: keyof T, hostOf: (args: unknown[]) => string | undefined): void {
  const orig = obj[key] as unknown as (...a: unknown[]) => unknown
  ;(obj as Record<string, unknown>)[key as string] = (...args: unknown[]) => {
    const h = hostOf(args)
    if (!isLocal(h)) remote.push(`${String(key)} ${h}`)
    // Never actually connect anywhere from a unit test.
    if (!isLocal(h)) throw new Error(`test blocked network to ${h}`)
    return orig.apply(obj, args)
  }
  restores.push(() => {
    ;(obj as Record<string, unknown>)[key as string] = orig
  })
}
const hostFromUrlish = (a: unknown): string | undefined => {
  try {
    if (typeof a === 'string') return new URL(a).hostname
    if (a instanceof URL) return a.hostname
    if (a && typeof a === 'object') {
      const o = a as { url?: string; hostname?: string; host?: string }
      if (o.url) return new URL(o.url).hostname
      return o.hostname ?? (o.host ? String(o.host).split(':')[0] : undefined)
    }
  } catch {
    return String(a)
  }
  return undefined
}

// A stand-in engine that answers each product prompt in its contract's shape.
const engineCalls: string[] = []
const fakeEngine = {
  async generate(req: { system: string; messages: Array<{ content: string }> }, opts?: { onText?: (d: string) => void }) {
    const sys = req.system
    let text = 'A short, plain answer.'
    if (/"reply"/.test(sys)) text = '{"reply":"Here is what I found.","actions":[]}'
    else if (/workspace builder/.test(sys)) text = '{"intent":"x","suggestions":[{"id":"s1","kind":"sticky","title":"Note","content":"Hello"}]}'
    else if (/name documents from their content/.test(sys)) text = '{"titles":[{"i":0,"title":"Kitchen tap repair"}]}'
    else if (/document indexer/.test(sys)) text = '{"summary":"A supplier agreement with Northwind.","category":"contract","entities":["Northwind Traders"],"dates":[],"keywords":["supplier","contract","pricing"],"language":"en"}'
    else if (/"answer"/.test(sys)) text = '{"answer":"Net 45 days [1].","sources":[1]}'
    engineCalls.push(sys.slice(0, 40))
    opts?.onText?.(text)
    return { text, inputTokens: 100, outputTokens: 20, stopReason: 'end_turn' as const, ttftMs: 1, totalMs: 2 }
  }
}

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real'
  process.env.OPENAI_API_KEY = 'sk-openai-test-not-real'
  const { initSqlite, openMemoryDatabase } = await import('../../src/web/worker/sqlite')
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  const { seedWorkspace } = await import('../../tools/local-ai-eval/fixtures')
  await seedWorkspace()

  const router = await import('../../src/main/ai/local/providerRouter')
  const { setLocalRouteResolver } = await import('../../src/main/ai/modelRouting')
  router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}) })
  router.setLocalRuntime({ engine: async () => fakeEngine as never, modelLabel: () => 'test', installed: () => true })
  setLocalRouteResolver((p) => router.routeForPurpose(p) === 'local')
  // Measure the routing, not the gates: every purpose served locally.
  router.setGateResolver(() => ({ gate: 'ok', localPassRate: null, cloudPassRate: null, family: null }))
  const { setBundledEmbedder } = await import('../../src/main/ai/localModel')
  setBundledEmbedder({ installed: () => true, label: () => 'nomic-test', embed: async (t) => t.map(() => [0.1, 0.2, 0.3]) })

  const f = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const h = hostFromUrlish(input)
    if (!isLocal(h)) {
      remote.push(`fetch ${h}`)
      return Promise.reject(new Error(`test blocked network to ${h}`))
    }
    return (f as (a: unknown, b?: unknown) => Promise<Response>)(input, init)
  }) as typeof fetch
  restores.push(() => {
    globalThis.fetch = f
  })
  for (const mod of [http, https]) {
    spy(mod, 'request', (a) => hostFromUrlish(a[0]))
    spy(mod, 'get', (a) => hostFromUrlish(a[0]))
  }
  spy(net, 'connect', (a) => hostFromUrlish(a[0]) ?? (typeof a[1] === 'string' ? a[1] : undefined))
  spy(net, 'createConnection', (a) => hostFromUrlish(a[0]) ?? (typeof a[1] === 'string' ? a[1] : undefined))
  spy(tls, 'connect', (a) => hostFromUrlish(a[0]) ?? (typeof a[1] === 'string' ? a[1] : undefined))
  spy(dns, 'lookup', (a) => String(a[0]))
}, 180_000)

afterAll(() => {
  for (const r of restores.reverse()) r()
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
})

describe('Local on this device: no AI request leaves the machine', () => {
  it('runs every AI feature on the device and opens no remote connection', { timeout: 180_000 }, async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const { DESK, DOCS } = await import('../../tools/local-ai-eval/fixtures')
    const msg = (content: string) => [{ role: 'user' as const, content, ts: Date.now() }]
    const results: Record<string, unknown> = {}

    // A question that the retrieval gate would send to web search on cloud.
    results.chat = await ai.sendChat({ taskId: DESK, messages: msg('What is the latest news about the Stripe tax rules in Australia this week?'), supportsQuestions: true, includeMemory: true } as never)
    await new Promise<void>((resolve) => {
      void ai.sendChatStream({ taskId: DESK, messages: msg('Summarise the launch risks and search the web for App Store review times.') } as never, {
        onMentions: () => undefined,
        onSources: () => undefined,
        onReply: () => undefined,
        onTool: () => undefined,
        onQuestion: () => undefined,
        onError: (e) => {
          results.streamError = e
          resolve()
        },
        onComplete: (r) => {
          results.stream = r
          resolve()
        }
      })
    })
    results.build = await ai.buildFromPrompt({ prompt: 'A desk for my reading list', taskId: null })
    results.transform = await ai.transformText({ text: 'Some text to tidy up.', instruction: 'Make it formal' })
    results.draft = await ai.suggestDocContent({ prompt: 'Draft a kickoff email' })
    results.rewrite = await ai.rewriteSelection({ text: 'rough text here', instruction: 'Make it concise' })
    results.ask = await ai.askWorkspace('What are the payment terms?', [{ docId: DOCS.contract, title: 'Contract', docType: 'doc', text: 'Payment terms are net 45 days.' }])
    results.askStream = await ai.askWorkspaceStream('What are the payment terms?', [{ docId: DOCS.contract, title: 'Contract', docType: 'doc', text: 'Payment terms are net 45 days.' }], [], () => undefined)

    const { enrichDocument } = await import('../../src/main/ai/enrichDocuments')
    results.enrich = await enrichDocument(DOCS.contract)
    const { embedTexts, embedQueryTagged } = await import('../../src/main/ai/embeddings')
    results.embed = await embedTexts(['a passage'])
    results.embedQuery = await embedQueryTagged('a question')

    const { getModelClient } = await import('../../src/main/ai/modelClient')
    const { clientForKey } = await import('../../src/main/ai/local/providerRouter')
    const { TITLE_BACKFILL_SYSTEM } = await import('../../src/main/titleBackfill')
    const { resolveModel, MODEL_HAIKU } = await import('../../src/main/ai/modelRouting')
    const keyed = clientForKey(process.env.ANTHROPIC_API_KEY ?? null, getModelClient)!
    results.titles = await keyed.messages.create({ model: resolveModel('title_backfill'), max_tokens: 100, system: TITLE_BACKFILL_SYSTEM, messages: [{ role: 'user', content: '{"items":[]}' }] })
    // A call site that hard-codes a cloud model id: still served on the device.
    results.hardcoded = await keyed.messages.create({ model: MODEL_HAIKU, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })

    const { processTranscript } = await import('../../src/main/ai/voiceNote')
    results.voice = await processTranscript('um so we we agreed to move the launch to november', 'cleaned')
    const { expandMindMapNode } = await import('../../src/main/ai/mindMap')
    results.mind = await expandMindMapNode({ rootPath: ['Launch'], nodeLabel: 'Marketing', siblings: [] } as never)
    const { generateCustomWidget } = await import('../../src/main/ai/customWidget')
    results.widget = await generateCustomWidget({ spec: 'A tip calculator' } as never)

    expect(remote).toEqual([])
    // And the work really ran on the device, not merely failed before sending.
    expect(engineCalls.length).toBeGreaterThanOrEqual(14)
    expect(results.chat).toMatchObject({ ok: true })
    expect(results.stream).toMatchObject({ ok: true })
    expect(results.build).toMatchObject({ ok: true })
    expect(results.transform).toMatchObject({ ok: true })
    expect(results.ask).toMatchObject({ ok: true })
    expect(results.enrich).toMatchObject({ ok: true })
    expect(results.embed).toMatchObject({ ok: true, model: 'local:nomic-test' })
    expect((results.hardcoded as { model: string }).model).toBe('local:test')
  })

  it('does not fall back to OpenAI for vectors when no local embedder is installed', async () => {
    const { setBundledEmbedder } = await import('../../src/main/ai/localModel')
    setBundledEmbedder(null)
    const { embedTexts } = await import('../../src/main/ai/embeddings')
    const r = await embedTexts(['a passage'])
    // Either the honest fallback (keyword search), or an Ollama server on THIS
    // machine answered (the advanced option; localhost) — never OpenAI.
    if (r.ok) expect(r.model.startsWith('ollama:')).toBe(true)
    else expect(r.reason).toBe('no_key')
    expect(remote).toEqual([])
  })

  it('control: the spies do see traffic — with "Your own API key" the same call reaches Anthropic', async () => {
    const router = await import('../../src/main/ai/local/providerRouter')
    router.setRouterSettings({ aiMode: () => 'byok', featureRoutes: () => ({}) })
    const ai = await import('../../src/main/ai/anthropic')
    ai.invalidateAnthropicClient()
    const before = remote.length
    await ai.transformText({ text: 'Some text.', instruction: 'Make it formal' })
    expect(remote.slice(before).some((r) => r.includes('api.anthropic.com'))).toBe(true)
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}) })
    remote.length = before
  })
})
