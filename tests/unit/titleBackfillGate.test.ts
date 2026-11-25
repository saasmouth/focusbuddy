// @vitest-environment node
//
// The title backfill asks the Background AI gate about ITS purpose (4.3.55).
//
// index.ts used to ask backgroundModelAllowed(), which says yes whenever the
// AI source is Local. But the backfill's one model call runs at the
// `title_backfill` purpose (feature "Background tidying"), and with the source
// Local a person can route Background tidying to a cloud provider in
// Settings › AI. Then, with Background AI tasks off, untitled items' text went
// to that provider at launch, unasked.
//
// These drive the real runTitleBackfill, the real gate and the real provider
// router, with counting fakes for each cloud client and the on-device engine.
// The gate is asked with the purpose index.ts's launch call ACTUALLY passes,
// read from its source, so a purpose-less call or a wrong purpose there turns
// these red, not only a string check.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AIPurpose } from '../../src/shared/types'

const USERDATA = mkdtempSync(join(tmpdir(), 'plexii-title-gate-'))
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
  calls: [] as Array<{ to: 'anthropic' | 'openai' | 'credits' | 'device'; model: string; text: string }>
}))

const REPLY = JSON.stringify({ titles: [{ i: 0, title: 'Quarterly figures' }] })
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
          content: [{ type: 'text', text: REPLY }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      }
    }
  }
}
const ANTHROPIC = fakeCloud('anthropic')

vi.mock('../../src/main/privacyPrefs', async (orig) => ({
  ...(await orig<typeof import('../../src/main/privacyPrefs')>()),
  backgroundAiEnabled: () => state.background
}))
vi.mock('../../src/main/settingsStore', async (orig) => ({
  ...(await orig<typeof import('../../src/main/settingsStore')>()),
  resolveAnthropicKey: () => 'sk-ant-test-not-a-key'
}))
vi.mock('../../src/main/ai/modelClient', async (orig) => ({
  ...(await orig<typeof import('../../src/main/ai/modelClient')>()),
  getModelClient: () => ANTHROPIC
}))

// Content the free pass cannot name (no line with a letter in it), long enough
// to be worth a model call: a note of figures.
const FIGURES = '1200 340 56 78\n9.5 2.25 17 4\n2026 11 25'
const ITEM = 'title-gate-item'

let tb: typeof import('../../src/main/titleBackfill')
let bg: typeof import('../../src/main/backgroundAiGate')
let router: typeof import('../../src/main/ai/local/providerRouter')

type Settings = Parameters<typeof import('../../src/main/ai/local/providerRouter').setRouterSettings>[0]
const LOCAL_TIDYING_ROUTED_TO_ANTHROPIC: Settings = {
  aiMode: () => 'local',
  featureRoutes: () => ({ background: 'anthropic' }),
  policy: () => 'local-first',
  contentWriting: () => 'local'
}
const LOCAL_ON_DEVICE: Settings = {
  aiMode: () => 'local',
  featureRoutes: () => ({}),
  policy: () => 'local-first',
  contentWriting: () => 'local'
}

/**
 * The purpose index.ts's launch call asks the gate about, read from its source:
 * the shared constant, a literal, or nothing at all (the old source-wide call).
 * Whatever it is, the tests ask the gate exactly that, so they behave as the
 * launch does.
 */
function purposeTheLaunchCallAsksAbout(): AIPurpose | undefined {
  const main = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf8')
  const call = main.match(/void runTitleBackfill\(\{ allowModel: backgroundModelAllowed\(([^)]*)\) \}\)/)
  expect(call, 'the launch call site asks backgroundModelAllowed(…)').not.toBeNull()
  const arg = (call as RegExpMatchArray)[1].trim()
  if (arg === '') return undefined
  if (arg === 'TITLE_BACKFILL_PURPOSE') return tb.TITLE_BACKFILL_PURPOSE
  const literal = arg.match(/^'([a-z_]+)'$/)
  expect(literal, `the launch call's argument is a purpose (got "${arg}")`).not.toBeNull()
  return (literal as RegExpMatchArray)[1] as AIPurpose
}
/** runTitleBackfill exactly as index.ts calls it at launch. */
const launchBackfill = (): ReturnType<typeof tb.runTitleBackfill> =>
  tb.runTitleBackfill({ allowModel: bg.backgroundModelAllowed(purposeTheLaunchCallAsksAbout()) })

beforeAll(async () => {
  const { initSqlite, openMemoryDatabase } = await import('../../src/web/worker/sqlite')
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  const { createNode } = await import('../../src/main/db/nodes')
  const n = createNode({ kind: 'task', title: 'Untitled', description: FIGURES } as never) as { id: string }
  db.prepare('UPDATE nodes SET id = ? WHERE id = ?').run(ITEM, n.id)

  router = await import('../../src/main/ai/local/providerRouter')
  const { setModelTagger } = await import('../../src/main/ai/modelRouting')
  setModelTagger(router.tagModel) // as initLocalAi wires it
  router.setCloudProviders({ anthropic: () => ANTHROPIC as never, openai: () => null, credits: () => null })
  router.setGateResolver(() => ({ gate: 'ok', localPassRate: null, cloudPassRate: null, family: null }))
  router.setConsentAsker(async () => false)
  router.setLocalRuntime({
    installed: () => true,
    modelLabel: () => 'test',
    engine: async () =>
      ({
        generate: async (req: { messages: Array<{ role: string; content: string }> }) => {
          state.calls.push({ to: 'device', model: 'local', text: req.messages.map((m) => m.content).join('\n') })
          return { text: REPLY, inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', ttftMs: 1, totalMs: 1 }
        }
      }) as never
  })
  bg = await import('../../src/main/backgroundAiGate')
  bg.setLocalRouting(() => router.localOnlyActive()) // as index.ts wires it
  tb = await import('../../src/main/titleBackfill')
})

beforeEach(() => {
  state.background = false
  state.calls = []
  db.prepare("UPDATE nodes SET title = 'Untitled' WHERE id = ?").run(ITEM)
  try {
    db.prepare('DELETE FROM title_backfill_log').run()
  } catch {
    /* created on the first run */
  }
})

const titleOf = (): string => (db.prepare('SELECT title FROM nodes WHERE id = ?').get(ITEM) as { title: string }).title

describe('the backfill’s model call and the gate’s question share one purpose', () => {
  it('the call is made at TITLE_BACKFILL_PURPOSE, which is Background tidying', async () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'titleBackfill.ts'), 'utf8')
    expect(src.match(/resolveModel\(([^)]*)\)/g)).toEqual(['resolveModel(TITLE_BACKFILL_PURPOSE)'])
    const { featureForPurpose } = await import('../../src/shared/localAi')
    expect(featureForPurpose(tb.TITLE_BACKFILL_PURPOSE)).toBe('background')
    expect(purposeTheLaunchCallAsksAbout()).toBe(tb.TITLE_BACKFILL_PURPOSE)
  })
})

describe('Local, Background tidying routed to Anthropic, Background AI tasks off', () => {
  it('nothing reaches Anthropic; the item waits, unlogged, for a launch that may ask', async () => {
    router.setRouterSettings(LOCAL_TIDYING_ROUTED_TO_ANTHROPIC)
    // The source-wide answer says yes: that was the hole.
    expect(bg.backgroundModelAllowed()).toBe(true)
    const s = await launchBackfill()
    expect(state.calls).toEqual([])
    expect(s).toMatchObject({ usedModel: false, byModel: 0 })
    expect(titleOf()).toBe('Untitled')
    // Not a vacuous setup: let through, this exact pass goes to Anthropic with
    // the item's text.
    const leaked = await tb.runTitleBackfill({ allowModel: true })
    expect(leaked.usedModel).toBe(true)
    expect(state.calls.map((c) => c.to)).toEqual(['anthropic'])
    expect(state.calls[0].text).toContain('1200 340 56 78')
  })

  it('with the switch on, one request goes to the provider the person routed it to', async () => {
    router.setRouterSettings(LOCAL_TIDYING_ROUTED_TO_ANTHROPIC)
    state.background = true
    const s = await launchBackfill()
    expect(state.calls.map((c) => c.to)).toEqual(['anthropic'])
    expect(s.byModel).toBe(1)
    expect(titleOf()).toBe('Quarterly figures')
  })
})

describe('on this computer', () => {
  it('Local with no cloud route: allowed with the switch off, served on the device, nothing sent', async () => {
    router.setRouterSettings(LOCAL_ON_DEVICE)
    const s = await launchBackfill()
    expect(state.calls.map((c) => c.to)).toEqual(['device'])
    expect(s.byModel).toBe(1)
    expect(titleOf()).toBe('Quarterly figures')
  })

  it('a cloud source with Background tidying routed to the device: allowed too (it was refused before)', async () => {
    router.setRouterSettings({ aiMode: () => 'byok', featureRoutes: () => ({ background: 'local' }), policy: () => 'local-first' })
    expect(bg.backgroundModelAllowed()).toBe(false)
    const s = await launchBackfill()
    expect(state.calls.map((c) => c.to)).toEqual(['device'])
    expect(s.byModel).toBe(1)
  })
})
