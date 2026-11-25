// @vitest-environment node
//
// The desk hello is background AI (4.3.55). Canvas.tsx asks for it with no
// click, the first time each session that a desk is open while in progress, and
// generateProactiveWelcome sends the desk's name and what is on it to the model
// PlexiiAssist uses. Before this gate it went out whatever Background AI tasks
// said, while Settings > Privacy promised background requests only with that
// switch on.
//
// These drive the real gate (deskWelcomeGate.ts → backgroundAiGate.ts), the
// real generateProactiveWelcome and the real provider router, with counting
// fakes for each cloud client and for the on-device engine, and assert:
//   - switch off: no client is called, on a key or on credits, and the answer
//     says why (reason background_ai_off);
//   - switch on: exactly one request;
//   - a click ({ asked: true }) is the person asking: one request, switch off;
//   - the hello written on this computer is allowed with the switch off;
//   - "the AI source is Local" is not enough: PlexiiAssist on a saved key
//     (cloud-if-key, the default) or routed to a cloud provider still leaves,
//     so it stays gated (each shown to really reach the cloud when ungated);
//   - the IPC handler and the renderer go through the gate.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const USERDATA = mkdtempSync(join(tmpdir(), 'plexii-desk-welcome-'))
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
vi.mock('../../src/main/db/account', () => ({
  accountEmail: () => null,
  loadAccountState: () => ({ sessionToken: null, skippedAt: null, cachedEmail: null }),
  markUiVisible: () => {}
}))

const state = vi.hoisted(() => ({
  background: false,
  credits: false,
  anthropicKey: true,
  openaiKey: false,
  calls: [] as Array<{ to: 'anthropic' | 'openai' | 'credits' | 'device'; model: string; text: string }>
}))

const HELLO = 'Open the launch checklist and tick off the first item.'
function fakeCloud(to: 'anthropic' | 'openai' | 'credits'): unknown {
  return {
    baseURL: `https://${to}.invalid`,
    messages: {
      create: async (body: { model: string; messages: Array<{ content: string }> }) => {
        state.calls.push({ to, model: body.model, text: body.messages.map((m) => m.content).join('\n') })
        return {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: HELLO }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      }
    }
  }
}
const ANTHROPIC = fakeCloud('anthropic')
const OPENAI = fakeCloud('openai')
const CREDITS = fakeCloud('credits')

vi.mock('../../src/main/privacyPrefs', async (orig) => ({
  ...(await orig<typeof import('../../src/main/privacyPrefs')>()),
  backgroundAiEnabled: () => state.background
}))
vi.mock('../../src/main/settingsStore', async (orig) => ({
  ...(await orig<typeof import('../../src/main/settingsStore')>()),
  resolveAnthropicKey: () => (state.anthropicKey ? 'sk-ant-test-not-a-key' : null)
}))
vi.mock('../../src/main/ai/modelClient', async (orig) => ({
  ...(await orig<typeof import('../../src/main/ai/modelClient')>()),
  getModelClient: () => ANTHROPIC
}))
vi.mock('../../src/main/ai/creditMode', async (orig) => ({
  ...(await orig<typeof import('../../src/main/ai/creditMode')>()),
  shouldUseCredits: () => state.credits,
  getCreditClient: () => (state.credits ? CREDITS : null)
}))

let DESK = ''
let gate: typeof import('../../src/main/deskWelcomeGate')
let ai: typeof import('../../src/main/ai/anthropic')
let bg: typeof import('../../src/main/backgroundAiGate')
let router: typeof import('../../src/main/ai/local/providerRouter')

type Settings = Parameters<typeof import('../../src/main/ai/local/providerRouter').setRouterSettings>[0]
const CLOUD_KEY: Settings = { aiMode: () => 'byok', featureRoutes: () => ({}) }
const ON_CREDITS: Settings = { aiMode: () => 'credits', featureRoutes: () => ({}) }
const LOCAL_ON_DEVICE: Settings = {
  aiMode: () => 'local',
  featureRoutes: () => ({}),
  policy: () => 'local-first',
  contentWriting: () => 'local'
}
// The defaults a person on Local gets with a key saved: content writing
// 'cloud-if-key' (DEFAULT_CONTENT_WRITING) and PlexiiAssist is key-first.
const LOCAL_WITH_SAVED_KEY: Settings = {
  aiMode: () => 'local',
  featureRoutes: () => ({}),
  policy: () => 'local-first',
  contentWriting: () => 'cloud-if-key'
}
const LOCAL_ASSIST_ROUTED_TO_ANTHROPIC: Settings = {
  aiMode: () => 'local',
  featureRoutes: () => ({ assistant: 'anthropic' }),
  policy: () => 'local-first',
  contentWriting: () => 'local'
}

beforeAll(async () => {
  const { initSqlite, openMemoryDatabase } = await import('../../src/web/worker/sqlite')
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  const fixtures = await import('../../tools/local-ai-eval/fixtures')
  await fixtures.seedWorkspace()
  DESK = fixtures.DESK
  router = await import('../../src/main/ai/local/providerRouter')
  const { setModelTagger } = await import('../../src/main/ai/modelRouting')
  // As initLocalAi wires it at start-up (localAiService.ts).
  setModelTagger(router.tagModel)
  router.setCloudProviders({
    anthropic: () => (state.anthropicKey ? (ANTHROPIC as never) : null),
    openai: () => (state.openaiKey ? (OPENAI as never) : null),
    credits: () => (state.credits ? (CREDITS as never) : null)
  })
  router.setGateResolver(() => ({ gate: 'ok', localPassRate: null, cloudPassRate: null, family: null }))
  // A consent prompt would be a click; none is expected, and none is granted.
  router.setConsentAsker(async () => false)
  router.setLocalRuntime({
    installed: () => true,
    modelLabel: () => 'test',
    engine: async () =>
      ({
        generate: async (req: { system: string; messages: Array<{ role: string; content: string }> }) => {
          state.calls.push({ to: 'device', model: 'local', text: req.messages.map((m) => m.content).join('\n') })
          return { text: HELLO, inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', ttftMs: 1, totalMs: 1 }
        }
      }) as never
  })
  bg = await import('../../src/main/backgroundAiGate')
  // As index.ts wires it at start-up.
  bg.setLocalRouting(() => router.localOnlyActive())
  ai = await import('../../src/main/ai/anthropic')
  gate = await import('../../src/main/deskWelcomeGate')
})

beforeEach(() => {
  state.background = false
  state.credits = false
  state.anthropicKey = true
  state.openaiKey = false
  state.calls = []
  router.setRouterSettings(CLOUD_KEY)
})

const OFF = { ok: false, reason: 'background_ai_off' }
const desksName = (): string => {
  const row = db.prepare('SELECT title FROM nodes WHERE id = ?').get(DESK) as { title: string }
  return row.title
}

describe('Background AI tasks off', () => {
  it('your own key: the hello reaches no client, and says why', async () => {
    expect(await gate.proactiveWelcome(DESK)).toEqual(OFF)
    expect(state.calls).toEqual([])
  })

  it('Plexii AI credits: nothing goes to the credits proxy either', async () => {
    state.credits = true
    router.setRouterSettings(ON_CREDITS)
    expect(await gate.proactiveWelcome(DESK)).toEqual(OFF)
    expect(state.calls).toEqual([])
    // Not a vacuous setup: ungated, this exact call does reach the proxy.
    expect((await ai.generateProactiveWelcome(DESK)).ok).toBe(true)
    expect(state.calls.map((c) => c.to)).toEqual(['credits'])
  })

  it('a click ("Have AI suggest the first step") is the person asking: one request', async () => {
    const r = await gate.proactiveWelcome(DESK, { asked: true })
    expect(r).toMatchObject({ ok: true, message: { role: 'assistant', content: HELLO } })
    expect(state.calls.map((c) => c.to)).toEqual(['anthropic'])
    // What leaves is the desk: its name rides in the request.
    expect(state.calls[0].text).toContain(desksName())
  })

  it('anything but a literal asked: true is gated', async () => {
    for (const opts of [undefined, {}, { asked: false }, { asked: 'yes' as unknown as boolean }]) {
      expect(await gate.proactiveWelcome(DESK, opts)).toEqual(OFF)
    }
    expect(state.calls).toEqual([])
  })
})

describe('Background AI tasks on', () => {
  it('one request, to the person’s cloud client', async () => {
    state.background = true
    const r = await gate.proactiveWelcome(DESK)
    expect(r).toMatchObject({ ok: true, message: { content: HELLO } })
    expect(state.calls.map((c) => c.to)).toEqual(['anthropic'])
  })
})

describe('the hello written on this computer', () => {
  it('is allowed with the switch off, and nothing reaches a cloud client', async () => {
    router.setRouterSettings(LOCAL_ON_DEVICE)
    expect(bg.backgroundModelAllowed('welcome')).toBe(true)
    const r = await gate.proactiveWelcome(DESK)
    expect(r).toMatchObject({ ok: true, message: { content: HELLO } })
    expect(state.calls.map((c) => c.to)).toEqual(['device'])
  })
})

describe('"the AI source is Local" is not enough', () => {
  it('PlexiiAssist on a saved key (cloud-if-key, the default) still leaves, so it is gated', async () => {
    router.setRouterSettings(LOCAL_WITH_SAVED_KEY)
    // The source-wide answer says yes (that is what the title backfill asks)…
    expect(bg.backgroundModelAllowed()).toBe(true)
    // …but this purpose resolves to the saved key, not the device.
    expect(bg.backgroundModelAllowed('welcome')).toBe(false)
    expect(await gate.proactiveWelcome(DESK)).toEqual(OFF)
    expect(state.calls).toEqual([])
    // Ungated, it really goes to Anthropic on that key.
    expect((await ai.generateProactiveWelcome(DESK)).ok).toBe(true)
    expect(state.calls.map((c) => c.to)).toEqual(['anthropic'])
  })

  it('…and on a saved OpenAI key it would go to OpenAI', async () => {
    state.anthropicKey = false
    state.openaiKey = true
    router.setRouterSettings(LOCAL_WITH_SAVED_KEY)
    expect(await gate.proactiveWelcome(DESK)).toEqual(OFF)
    expect(state.calls).toEqual([])
    expect((await ai.generateProactiveWelcome(DESK)).ok).toBe(true)
    expect(state.calls.map((c) => c.to)).toEqual(['openai'])
  })

  it('PlexiiAssist routed to Anthropic in Settings › AI is gated too', async () => {
    router.setRouterSettings(LOCAL_ASSIST_ROUTED_TO_ANTHROPIC)
    expect(bg.backgroundModelAllowed()).toBe(true)
    expect(bg.backgroundModelAllowed('welcome')).toBe(false)
    expect(await gate.proactiveWelcome(DESK)).toEqual(OFF)
    expect(state.calls).toEqual([])
    expect((await ai.generateProactiveWelcome(DESK)).ok).toBe(true)
    expect(state.calls.map((c) => c.to)).toEqual(['anthropic'])
  })
})

describe('every path to the hello goes through the gate', () => {
  const root = join(__dirname, '..', '..', 'src')
  const read = (p: string): string => readFileSync(join(root, p), 'utf8')
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const full = join(dir, n)
      return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(n) ? [full] : []
    })

  it('the IPC handler calls the gate, with the caller’s options', () => {
    const ipc = read('main/ipc/index.ts')
    const start = ipc.indexOf("ipcMain.handle('chat:proactiveWelcome'")
    expect(start).toBeGreaterThan(-1)
    const handler = ipc.slice(start, ipc.indexOf('\n  )', start))
    expect(handler).toContain('proactiveWelcome(taskId, opts)')
    expect(ipc).not.toContain('generateProactiveWelcome')
  })

  it('nothing in main calls generateProactiveWelcome except the gate', () => {
    const callers = walk(join(root, 'main'))
      .filter((f) => !f.endsWith(join('ai', 'anthropic.ts')))
      .filter((f) => readFileSync(f, 'utf8').includes('generateProactiveWelcome'))
      .map((f) => f.slice(root.length + 1))
    expect(callers).toEqual(['main/deskWelcomeGate.ts'])
  })

  it('in the renderer only the Pre-Task Bridge button says asked; the Canvas hello never does', () => {
    const calls = walk(join(root, 'renderer'))
      .flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/sendProactiveWelcome\(([^)]*)\)/g)].map((m) => ({ f: f.slice(root.length + 1), args: m[1] })))
      .filter((c) => !c.f.endsWith('stores/chat.ts'))
    expect(calls).toEqual([
      { f: 'renderer/src/components/Canvas.tsx', args: 'activeTask.id' },
      { f: 'renderer/src/components/PreTaskBridge.tsx', args: 'activeTask.id, { asked: true }' }
    ])
    const bridge = read('renderer/src/components/PreTaskBridge.tsx')
    const button = bridge.slice(bridge.indexOf('onClick={handleAIDraft}'))
    expect(button.slice(0, 600)).toContain('Have AI suggest the first step')
  })
})
