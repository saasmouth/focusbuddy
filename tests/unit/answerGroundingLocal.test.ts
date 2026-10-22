// @vitest-environment node
//
// Answers are grounded (4.3.41). On the on-device model, PlexiiAssist was
// asked "What is our refund policy after 30 days, and when is support open?"
// with only the refund policy in the workspace, and answered:
//
//   "… Support is open 24/7, as stated in the policy [1]."
//
// a specific about the user's own business, from nothing, cited to a document
// that does not say it. This replays that captured output
// (tests/fixtures/localAi/brainAnswerCaptures.json, chatAnswer) through the
// real call sites, router and local client, and asserts:
//   - the invented "24/7" is taken out of the on-device answer, and marked;
//   - every chat and Brain entry point carries the answer grounding rule;
//   - a well-supported answer is left exactly as written.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const USERDATA = mkdtempSync(join(tmpdir(), 'plexii-answer-grounding-'))
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

type Attempt = { text: string; stopReason: string; inputTokens: number; outputTokens: number }
const CAPTURED = (JSON.parse(readFileSync(join(__dirname, '../fixtures/localAi/brainAnswerCaptures.json'), 'utf8')) as Record<string, { first: Attempt }>)
  .chatAnswer.first

// The knowledge entries of the repro (the one that was retrieved).
const REFUND =
  'Customers can return any product within 30 days of delivery for a full refund. After 30 days we offer store credit only. Refunds go back to the original payment method within 5 business days.'
const QUESTION = 'What is our refund policy after 30 days, and when is support open?'

const calls: Array<{ system: string; user: string }> = []
let script: Attempt[] = []

beforeAll(async () => {
  const { initSqlite, openMemoryDatabase } = await import('../../src/web/worker/sqlite')
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  const { createKnowledge } = await import('../../src/main/db/knowledge')
  createKnowledge({ title: 'Refund policy', body: REFUND, tags: ['support'] } as never)
  const router = await import('../../src/main/ai/local/providerRouter')
  const { setModelTagger } = await import('../../src/main/ai/modelRouting')
  router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}), policy: () => 'local-first', contentWriting: () => 'local' })
  router.setGateResolver(() => ({ gate: 'ok', localPassRate: null, cloudPassRate: null, family: null }))
  router.setConsentAsker(async () => false)
  router.setLocalRuntime({
    installed: () => true,
    modelLabel: () => 'test',
    contextTokens: () => 16384,
    engine: async () =>
      ({
        generate: async (req: { system: string; messages: Array<{ role: string; content: string }> }, opts?: { onText?: (d: string) => void }) => {
          const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
          calls.push({ system: req.system, user })
          const a = script[Math.min(calls.length - 1, script.length - 1)]
          if (a?.text) opts?.onText?.(a.text)
          return { ...a, ttftMs: 1, totalMs: 1 }
        }
      }) as never
  })
  setModelTagger(router.tagModel)
}, 120_000)

beforeEach(() => {
  calls.length = 0
  script = []
})

async function chatStream(question: string): Promise<{ ok?: boolean; content?: string; grounding?: import('@shared/types').AnswerGrounding; error?: string }> {
  const ai = await import('../../src/main/ai/anthropic')
  let out: { ok?: boolean; content?: string; grounding?: import('@shared/types').AnswerGrounding; error?: string } = {}
  await ai.sendChatStream({ taskId: null, messages: [{ role: 'user', content: question, ts: Date.now() }], supportsQuestions: true, includeMemory: false } as never, {
    onMentions: () => undefined,
    onSources: () => undefined,
    onReply: () => undefined,
    onReplyDelta: () => undefined,
    onTool: () => undefined,
    onActivity: () => undefined,
    onQuestion: () => undefined,
    onError: (e: { error: string }) => (out = { error: e.error }),
    onComplete: (r: { ok: boolean; message?: { content: string }; grounding?: import('@shared/types').AnswerGrounding }) =>
      (out = { ok: r.ok, content: r.message?.content, grounding: r.grounding })
  } as never)
  return out
}

describe('the captured "Support is open 24/7" answer, replayed on the device path', () => {
  it('the invented opening hours are taken out, said plainly, and marked', async () => {
    expect(CAPTURED.text).toContain('Support is open 24/7')
    script = [CAPTURED]
    const r = await chatStream(QUESTION)
    expect(r.ok).toBe(true)
    expect(r.content).not.toMatch(/24\/7/)
    expect(r.content).toContain('Support is open [not in your documents]')
    // What the documents DO say is untouched, citation and all.
    expect(r.content).toContain('After 30 days, customers receive store credit only')
    expect(r.content).toContain('within 5 business days')
    expect(r.grounding).toMatchObject({ path: 'local', repaired: [{ span: '24/7', kind: 'time', confidence: 'high' }] })
  })

  it('a well-supported answer is left exactly as written, with no marks', async () => {
    const reply = 'After 30 days we offer store credit only [1]. Refunds go back to the original payment method within 5 business days [1].'
    script = [{ text: JSON.stringify({ reply, actions: [] }), stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 }]
    const r = await chatStream('What is our refund policy after 30 days?')
    expect(r.content).toBe(reply)
    expect(r.grounding).toBeUndefined()
  })

  it('PlexiSearch Ask (the PlexiiBrain answer) gets the same check', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    script = [{ text: '{"answer":"Store credit only after 30 days [1]. Support is open 24/7 [1].","sources":[1]}', stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 }]
    const a = await ai.askWorkspace(QUESTION, [{ docId: 'k1', title: 'Refund policy', docType: 'knowledge', text: REFUND }])
    expect(a.answer).toBe('Store credit only after 30 days [1]. Support is open [not in your documents] [1].')
    expect(a.grounding?.repaired.map((f) => f.span)).toEqual(['24/7'])
  })

  it('Ask your workspace (streamed) gets the same check', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    script = [{ text: 'Support is open 9am to 5pm, Monday to Friday [1].', stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 }]
    const a = await ai.askWorkspaceStream(QUESTION, [{ docId: 'k1', title: 'Refund policy', docType: 'knowledge', text: REFUND }], [], () => undefined)
    expect(a.answer).not.toMatch(/9am|5pm|Monday to Friday/)
    expect(a.grounding?.repaired.map((f) => f.span).sort()).toEqual(['5pm', '9am', 'Monday to Friday'])
  })
})

describe('every chat and Brain entry point carries the answer grounding rule', () => {
  it('PlexiiAssist (streamed and not), PlexiSearch Ask and Ask your workspace, on the device', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const { hasAnswerRule } = await import('../../src/main/ai/answerGrounding')
    const { GROUNDING_RULE_ANSWER_SMALL } = await import('../../src/main/ai/inventedSpecifics')
    const ok: Attempt = { text: '{"reply":"ok","actions":[]}', stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 }
    const entryPoints: Record<string, () => Promise<unknown>> = {
      sendChatStream: () => chatStream(QUESTION),
      sendChat: () => ai.sendChat({ taskId: null, messages: [{ role: 'user', content: QUESTION, ts: Date.now() }] } as never),
      askWorkspace: () => ai.askWorkspace(QUESTION, [{ docId: 'k1', title: 'Refund policy', docType: 'knowledge', text: REFUND }]),
      askWorkspaceStream: () => ai.askWorkspaceStream(QUESTION, [{ docId: 'k1', title: 'Refund policy', docType: 'knowledge', text: REFUND }], [], () => undefined)
    }
    for (const [name, run] of Object.entries(entryPoints)) {
      calls.length = 0
      script = [name === 'askWorkspace' ? { ...ok, text: '{"answer":"x","sources":[]}' } : name === 'askWorkspaceStream' ? { ...ok, text: 'x' } : ok]
      await run()
      expect(calls.length, `${name} reached the model`).toBeGreaterThan(0)
      expect(hasAnswerRule(calls[0].system), `${name} carries the answer rule`).toBe(true)
      // The on-device model gets the blunt variant.
      expect(calls[0].system, name).toContain(GROUNDING_RULE_ANSWER_SMALL.trim())
    }
  })
})
