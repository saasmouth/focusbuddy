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

    // The rest of the suite's AI entry points (PlexiiWrite/Cells/Deck, design,
    // dashboards, mail, meetings, capture, field AI, plans, wires, briefs).
    const settle = async (name: string, p: Promise<unknown>): Promise<void> => {
      try {
        results[name] = await p
      } catch (e) {
        results[name] = { threw: (e as Error).message }
      }
    }
    await settle('docGen', ai.generateDocument({ docType: 'doc', prompt: 'A short project brief' }))
    await settle('sheetGen', ai.generateDocument({ docType: 'sheet', prompt: 'A budget' }))
    await settle('deck', ai.generateSlideElements({ mode: 'deck', prompt: 'A 3-slide update' }))
    await settle('design', ai.generateDesignContent({ prompt: 'Plant sale', designKind: 'Instagram post' }))
    await settle('cellsCols', ai.suggestSheetColumns({ prompt: 'Track job applications' }))
    await settle('cellsFill', ai.fillSheetRange({ prompt: 'Five fruit', headers: ['Fruit'], rangeRows: 5, auto: false }))
    await settle('cellsFormula', ai.suggestFormula({ prompt: 'Sum of B', headers: ['A', 'B'], activeRef: 'C1' }))
    await settle('mailDraft', ai.draftReply({ subject: 'Lunch?', from: 'sam@example.com', body: 'Free on Friday?' }, null))
    await settle('meetingEnd', ai.processMeetingEnd({ transcript: 'We agreed to ship on Friday. Priya owns the demo.' } as never))
    await settle('trail', ai.summarizeRecentTrail(DESK, Date.now() - 3_600_000))
    await settle('stacks', ai.proposeSmartStacks(DESK))
    await settle('brief', ai.generateDailyBrief())
    await settle('standup', ai.generateStandupNarrative({ promptContext: 'Did X, Y', fallbackNarrative: 'fallback' }))
    await settle('wire', ai.runTransformWire({ sourceContent: 'Notes about the launch', verb: 'summarize', targetCurrentContent: '' }))
    await settle('command', ai.routeCommandBar({ system: 'Classify. Reply with JSON only: {"intent":"..."}', prompt: 'add a todo' } as never))
    const { proposeCleanup } = await import('../../src/main/ai/cleanupRewrite')
    await settle('cleanup', proposeCleanup('um so like call bob about the thing tmrw maybe'))
    const { classifyCapture } = await import('../../src/main/ai/intentClassify')
    await settle('intent', classifyCapture('maybe look into whether we should switch the newsletter tool at some point'))
    const { extractCommitments } = await import('../../src/main/ai/extractCommitments')
    await settle('commitments', extractCommitments({ text: 'I will send the deck by Friday.' } as never))
    const { enhanceRecord } = await import('../../src/main/ai/enhanceRecord')
    await settle('field', enhanceRecord({ text: 'Lunch with Sam on Friday at noon' } as never))
    const { selectItemsForPlan } = await import('../../src/main/ai/planSelect')
    await settle('plan', selectItemsForPlan('plan my week', [{ id: 'a', title: 'Write the brief' }] as never))
    const { triageInbox } = await import('../../src/main/ai/mailTriage')
    const { liveTriageDeps } = await import('../../src/main/ai/mailTriage')
    await settle(
      'triage',
      triageInbox(
        [{ uid: 1, from: 'news@shop.example', subject: 'Sale!', date: Date.now(), seen: false } as never],
        ['Receipts'],
        liveTriageDeps(() => clientForKey(process.env.ANTHROPIC_API_KEY ?? null, getModelClient) as never)
      )
    )
    const { runTitleBackfill } = await import('../../src/main/titleBackfill')
    await settle('titleBackfill', runTitleBackfill())

    expect(remote).toEqual([])
    // And the work really ran on the device, not merely failed before sending.
    expect(engineCalls.length).toBeGreaterThanOrEqual(28)
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

  it('with the real quality gates under the "measured" policy and the person declining cloud: cloud-only features send nothing and say why', { timeout: 180_000 }, async () => {
    const router = await import('../../src/main/ai/local/providerRouter')
    const { localGateFor } = await import('../../src/shared/localAiGates')
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}), policy: () => 'measured' })
    router.setGateResolver(localGateFor)
    let asked = 0
    router.setConsentAsker(async () => {
      asked++
      return false
    })
    const ai = await import('../../src/main/ai/anthropic')
    const build = await ai.buildFromPrompt({ prompt: 'A desk for my reading list', taskId: null })
    expect(build.ok).toBe(false)
    expect(build.error).toMatch(/Nothing was sent anywhere/)
    const agent = await ai.runDeskAgent({ instruction: 'Summarise the inputs', inputs: [{ kind: 'note', title: 'n', content: 'hello' }] } as never)
    expect(JSON.stringify(agent)).toMatch(/not run on the on-device model|Nothing was sent/)
    const { generateImage } = await import('../../src/main/imageGen')
    const img = await generateImage({ prompt: 'a red bicycle' })
    expect(img.ok).toBe(false)
    expect(img.error).toMatch(/no on-device model/)
    const { removeBackground } = await import('../../src/main/stockMedia')
    process.env.REMOVEBG_API_KEY = 'rb-test-not-real'
    const rb = await removeBackground({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' })
    delete process.env.REMOVEBG_API_KEY
    expect(rb.ok).toBe(false)
    expect(asked).toBeGreaterThanOrEqual(3)
    expect(remote).toEqual([])
    router.setGateResolver(() => ({ gate: 'ok', localPassRate: null, cloudPassRate: null, family: null }))
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}) })
  })

  it('the shipped default ("local-first") runs weak features on the device with a note, and still sends nothing', { timeout: 180_000 }, async () => {
    const router = await import('../../src/main/ai/local/providerRouter')
    const { localGateFor } = await import('../../src/shared/localAiGates')
    const { DEFAULT_LOCAL_POLICY } = await import('../../src/shared/localAi')
    expect(DEFAULT_LOCAL_POLICY).toBe('local-first')
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}) })
    router.setGateResolver(localGateFor)
    const notices: string[] = []
    router.setNoticeSink((_f, m) => notices.push(m))
    let asked = 0
    router.setConsentAsker(async () => {
      asked++
      return false
    })
    const ai = await import('../../src/main/ai/anthropic')
    const before = engineCalls.length
    const build = await ai.buildFromPrompt({ prompt: 'A desk for my reading list', taskId: null })
    expect(build.ok, JSON.stringify(build).slice(0, 400)).toBe(true)
    expect(engineCalls.length).toBeGreaterThan(before)
    expect(notices.some((n) => /Build with AI/i.test(n))).toBe(true)
    // Media has no on-device model at all: still asks, and declining sends nothing.
    const { generateImage } = await import('../../src/main/imageGen')
    const img = await generateImage({ prompt: 'a red bicycle' })
    expect(img.ok).toBe(false)
    expect(asked).toBeGreaterThanOrEqual(1)
    expect(remote).toEqual([])
    router.setGateResolver(() => ({ gate: 'ok', localPassRate: null, cloudPassRate: null, family: null }))
  })

  it('a feature upgraded to "Your OpenAI key" while the source is Local reaches OpenAI only, and only for that feature', async () => {
    const router = await import('../../src/main/ai/local/providerRouter')
    const { createOpenAIClient } = await import('../../src/main/ai/local/openaiClient')
    const { setModelTagger } = await import('../../src/main/ai/modelRouting')
    const { setLocalRouteResolver } = await import('../../src/main/ai/modelRouting')
    const openai = createOpenAIClient({ key: () => process.env.OPENAI_API_KEY ?? null, models: () => ({ fast: 'gpt-x-mini', standard: 'gpt-x', best: 'gpt-x' }) })
    router.setCloudProviders({ anthropic: () => null, credits: () => null, openai: () => openai })
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({ writing: 'openai' }) })
    setModelTagger(router.tagModel)
    const ai = await import('../../src/main/ai/anthropic')
    ai.invalidateAnthropicClient()
    const before = remote.length
    await ai.transformText({ text: 'Some text.', instruction: 'Make it formal' }).catch(() => undefined)
    const hit = remote.slice(before)
    expect(hit.some((r) => r.includes('api.openai.com'))).toBe(true)
    expect(hit.some((r) => r.includes('api.anthropic.com'))).toBe(false)
    remote.length = before
    // Every other feature is still on the device.
    const n = engineCalls.length
    const { DESK } = await import('../../tools/local-ai-eval/fixtures')
    await ai.sendChat({ taskId: DESK, messages: [{ role: 'user', content: 'What is due this week?', ts: Date.now() }] } as never).catch(() => undefined)
    expect(engineCalls.length).toBeGreaterThan(n)
    expect(remote).toEqual([])
    router.setCloudProviders({ anthropic: () => null, credits: () => null, openai: () => null })
    router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}) })
    setLocalRouteResolver((p) => router.routeForPurpose(p) === 'local')
  })
})
