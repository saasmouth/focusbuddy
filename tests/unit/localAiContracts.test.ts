// @vitest-environment node
//
// Every structured local output is validated against THE CALL'S contract,
// never against another call that happens to share its purpose. The owner's
// bug (4.3.39-local.3): the in-table AI (suggestTableRows) shares the 'setup'
// purpose with Build with AI, so a correct { columnsToAdd, rows } reply was
// rejected for lacking Build's "suggestions" array, the retry pushed the
// model toward the wrong contract, and the person got "AI returned no rows".
//
// This drives each real call site through the real router and local client
// with an engine that answers in the call's own contract, and asserts:
//   - the contract the local path recognised is that call's contract;
//   - a correct reply is accepted first time (one engine call, no retry);
//   - the product function returns a usable result.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const USERDATA = mkdtempSync(join(tmpdir(), 'plexii-contracts-'))
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

export type Seen = { system: string; user: string; reply: string }
const seen: Seen[] = []
let responder: (system: string, user: string) => string = () => '{}'

beforeAll(async () => {
  const { initSqlite, openMemoryDatabase } = await import('../../src/web/worker/sqlite')
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  const { seedWorkspace } = await import('../../tools/local-ai-eval/fixtures')
  await seedWorkspace()
  const router = await import('../../src/main/ai/local/providerRouter')
  const { setModelTagger } = await import('../../src/main/ai/modelRouting')
  router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}), policy: () => 'local-first', contentWriting: () => 'local' })
  router.setGateResolver(() => ({ gate: 'ok', localPassRate: null, cloudPassRate: null, family: null }))
  router.setConsentAsker(async () => false)
  router.setLocalRuntime({
    installed: () => true,
    modelLabel: () => 'test',
    engine: async () =>
      ({
        generate: async (req: { system: string; messages: Array<{ role: string; content: string }> }) => {
          const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
          const reply = responder(req.system, user)
          seen.push({ system: req.system, user, reply })
          return { text: reply, inputTokens: 1, outputTokens: 1, stopReason: 'end_turn', ttftMs: 1, totalMs: 1 }
        }
      }) as never
  })
  setModelTagger(router.tagModel)
  if (process.env.CAPTURE_PROMPTS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).__capture = true
  }
}, 120_000)

async function capture(name: string, fn: () => Promise<unknown>): Promise<Seen[]> {
  const from = seen.length
  const r = await fn().catch((e) => ({ thrown: (e as Error).message }))
  const got = seen.slice(from)
  if (process.env.CAPTURE_PROMPTS) {
    const fs = await import('node:fs')
    fs.appendFileSync(process.env.CAPTURE_PROMPTS, JSON.stringify({ name, result: r, calls: got }) + '\n')
  }
  return got
}

describe('capture', () => {
  it.runIf(!!process.env.CAPTURE_PROMPTS)('records the prompts of every shared-purpose JSON call site', { timeout: 120_000 }, async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const { DESK, TABLE } = await import('../../tools/local-ai-eval/fixtures')
    const { createWidget } = await import('../../src/main/db/widgets')
    await capture('suggestTableRows', () => ai.suggestTableRows(TABLE, 'podcast episodes', 0))
    await capture('buildFromPrompt', () => ai.buildFromPrompt({ prompt: 'A desk for my reading list', taskId: null }))
    await capture('designAgentProfile', () => ai.designAgentProfile('An agent that triages my inbox every morning'))
    for (const kind of ['checklist', 'kanban', 'table', 'calendar', 'note']) {
      const w = createWidget({ taskId: DESK, kind, title: `${kind} test`, content: '', x: 0, y: 0, w: 4, h: 4 } as never) as { id: string }
      await capture(`suggestWidgetSetup:${kind}`, () => ai.suggestWidgetSetup({ widgetId: w.id, prompt: 'Plan my week' }))
    }
    await capture('generateProactiveWelcome', () => ai.generateProactiveWelcome(DESK))
    await capture('generateDailyBrief', () => ai.generateDailyBrief())
    await capture('suggestWorkspaceActions', () => ai.suggestWorkspaceActions('What is due?', 'The launch checklist is due Friday.', [{ title: 'Launch', docType: 'doc' }], Date.now()))
    expect(seen.length).toBeGreaterThan(0)
  })
})

// A correct reply in each call's OWN contract, recognised from its prompt.
function correctReply(system: string): string {
  if (/"columnsToAdd"/.test(system))
    return JSON.stringify({
      columnsToAdd: [{ label: 'Host', type: 'text-short' }, { label: 'Status', type: 'single-select', options: ['Planned', 'Published'] }],
      rows: [
        { Name: 'Episode 1', Done: false, Host: 'Alex', Status: 'Planned' },
        { Name: 'Episode 2', Done: false, Host: 'Sam', Status: 'Published' }
      ]
    })
  if (/"suggestions"/.test(system))
    return JSON.stringify({ intent: 'reading', suggestions: [{ id: 's1', kind: 'sticky', title: 'To read', content: 'The Overstory' }] })
  if (/"systemPrompt"/.test(system)) return JSON.stringify({ name: 'Inbox Triager', blurb: 'Sorts mail each morning.', systemPrompt: 'You triage email. Be brief.' })
  if (/"refId"/.test(system)) return JSON.stringify({ summary: 'Show the launch tasks.', refId: 'tbl-launch' })
  if (/\{\s*"items"\s*:\s*\[/.test(system)) return JSON.stringify({ items: ['Monday: plan', 'Tuesday: write'] })
  if (/\{\s*"actions"\s*:\s*\[/.test(system) && !/"reply"/.test(system))
    return JSON.stringify({ actions: [{ kind: 'create-task', title: 'Budget', reason: 'it has its own deadline' }] })
  if (/"reply"/.test(system)) return JSON.stringify({ reply: 'Done.', actions: [] })
  return 'A plain answer.'
}

describe('every call is validated against its own contract', () => {
  const engineCallsFor = async (fn: () => Promise<unknown>): Promise<{ result: unknown; calls: number }> => {
    responder = (system) => correctReply(system)
    const from = seen.length
    const result = await fn()
    return { result, calls: seen.length - from }
  }

  it('the in-table AI (rows and columns) — the 4.3.39-local.3 bug: accepted first time, rows returned', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const { TABLE } = await import('../../tools/local-ai-eval/fixtures')
    const { result, calls } = await engineCallsFor(() => ai.suggestTableRows(TABLE, 'podcast episodes', 0))
    expect(calls).toBe(1)
    expect(result).toMatchObject({ ok: true, rows: [{ Name: 'Episode 1' }, { Name: 'Episode 2' }] })
    expect((result as { columnsToAdd: unknown[] }).columnsToAdd).toHaveLength(2)
  })

  it('Build with AI: suggestion cards', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const { result, calls } = await engineCallsFor(() => ai.buildFromPrompt({ prompt: 'A desk for my reading list', taskId: null }))
    expect(calls).toBe(1)
    expect(result).toMatchObject({ ok: true })
    expect((result as { suggestions: unknown[] }).suggestions.length).toBeGreaterThan(0)
  })

  it('agent profile', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const { result, calls } = await engineCallsFor(() => ai.designAgentProfile('An agent that triages my inbox'))
    expect(calls).toBe(1)
    expect(result).toMatchObject({ ok: true, name: 'Inbox Triager' })
  })

  it('work-widget setup: table reference and note items', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const { DESK } = await import('../../tools/local-ai-eval/fixtures')
    const { createWidget } = await import('../../src/main/db/widgets')
    for (const kind of ['table', 'note']) {
      const w = createWidget({ taskId: DESK, kind, title: `${kind} w`, content: '', x: 0, y: 0, w: 4, h: 4 } as never) as { id: string }
      const { result, calls } = await engineCallsFor(() => ai.suggestWidgetSetup({ widgetId: w.id, prompt: 'Plan my week' }))
      expect(calls, kind).toBe(1)
      expect(result, kind).toMatchObject({ ok: true })
    }
  })

  it('workspace actions (shares the chat purpose, not the chat envelope)', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const { result, calls } = await engineCallsFor(() =>
      ai.suggestWorkspaceActions('What is due?', 'The budget is due Friday.', [{ title: 'Launch', docType: 'doc' }], Date.now())
    )
    expect(calls).toBe(1)
    expect((result as { proposals: unknown[] }).proposals.length).toBe(1)
  })

  it('PlexiiAssist chat envelope', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const { DESK } = await import('../../tools/local-ai-eval/fixtures')
    const { result } = await engineCallsFor(() => ai.sendChat({ taskId: DESK, messages: [{ role: 'user', content: 'hi', ts: Date.now() }] } as never))
    expect(result).toMatchObject({ ok: true })
  })

  it('a table reply with no rows is never an empty success: retried, then a plain failure', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const { TABLE } = await import('../../tools/local-ai-eval/fixtures')
    responder = () => JSON.stringify({ columnsToAdd: [], rows: [] })
    const from = seen.length
    const r = (await ai.suggestTableRows(TABLE, 'podcast episodes', 0)) as { ok: boolean; error?: string }
    expect(seen.length - from).toBe(2) // first + one retry
    expect(seen.at(-1)!.user).toMatch(/"rows" is empty/)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/could not produce rows.*Nothing was sent anywhere/)
  })

  it('the retry names the CALL\'s contract, never another call\'s', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const { TABLE } = await import('../../tools/local-ai-eval/fixtures')
    let n = 0
    responder = (system) => (n++ === 0 ? 'Sure! Here are some rows.' : correctReply(system))
    const from = seen.length
    const r = await ai.suggestTableRows(TABLE, 'podcast episodes', 0)
    expect(seen.length - from).toBe(2)
    expect(seen.at(-1)!.user).not.toMatch(/suggestions/)
    expect(r).toMatchObject({ ok: true })
  })
})
