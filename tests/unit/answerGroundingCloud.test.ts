// @vitest-environment node
//
// Answers are grounded on the CLOUD path too (4.3.41). A cloud model is never
// rewritten: an invented specific is highlighted for the person to check.
// The model is a stub that answers with an invented specific; every chat and
// Brain entry point must carry the full answer rule and mark the specific.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const USERDATA = mkdtempSync(join(tmpdir(), 'plexii-answer-grounding-cloud-'))
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

// The stub cloud model: records each request, answers with `reply`.
const bodies: Array<{ system: string }> = []
let reply = ''
const flatSystem = (s: unknown): string =>
  typeof s === 'string' ? s : Array.isArray(s) ? (s as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n') : ''
const message = (): Record<string, unknown> => ({
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  model: 'claude-stub',
  content: [{ type: 'text', text: reply }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 }
})
const stub = {
  baseURL: 'https://api.anthropic.com',
  messages: {
    create: async (body: { system: unknown }) => {
      bodies.push({ system: flatSystem(body.system) })
      return message()
    },
    stream: (body: { system: unknown }) => {
      bodies.push({ system: flatSystem(body.system) })
      const listeners: Array<(d: string) => void> = []
      return {
        on(ev: string, fn: (d: string) => void) {
          if (ev === 'text') listeners.push(fn)
          return this
        },
        abort() {},
        async finalMessage() {
          for (const fn of listeners) fn(reply)
          return message()
        }
      }
    }
  }
}
vi.mock('../../src/main/ai/local/providerRouter', async (orig) => ({
  ...(await orig<typeof import('../../src/main/ai/local/providerRouter')>()),
  routedClient: () => stub,
  localContextTokens: () => null,
  localOnlyActive: () => false
}))

const REFUND = 'After 30 days we offer store credit only. Refunds go back to the original payment method within 5 business days.'
const SOURCES = [{ docId: 'k1', title: 'Refund policy', docType: 'knowledge', text: REFUND }]
const QUESTION = 'What is our refund policy after 30 days, and when is support open?'

beforeAll(async () => {
  const { initSqlite, openMemoryDatabase } = await import('../../src/web/worker/sqlite')
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  const { createKnowledge } = await import('../../src/main/db/knowledge')
  createKnowledge({ title: 'Refund policy', body: REFUND, tags: [] } as never)
}, 120_000)

beforeEach(() => {
  bodies.length = 0
})

describe('cloud answers: invented specifics are highlighted, never rewritten', () => {
  it('PlexiiAssist (streamed)', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    reply = JSON.stringify({ reply: 'Store credit only after 30 days [1]. Support costs $15 an hour and is open 24/7.', actions: [] })
    let done: { content?: string; grounding?: import('@shared/types').AnswerGrounding } = {}
    await ai.sendChatStream({ taskId: null, messages: [{ role: 'user', content: QUESTION, ts: Date.now() }] } as never, {
      onMentions: () => undefined,
      onSources: () => undefined,
      onReply: () => undefined,
      onReplyDelta: () => undefined,
      onTool: () => undefined,
      onActivity: () => undefined,
      onQuestion: () => undefined,
      onError: () => undefined,
      onComplete: (r: { message?: { content: string }; grounding?: import('@shared/types').AnswerGrounding }) => (done = { content: r.message?.content, grounding: r.grounding })
    } as never)
    expect(done.content).toBe('Store credit only after 30 days [1]. Support costs $15 an hour and is open 24/7.')
    expect(done.grounding?.path).toBe('cloud')
    expect(done.grounding?.repaired).toEqual([])
    expect(done.grounding?.flagged.map((f) => f.span).sort()).toEqual(['$15', '24/7'])
  })

  it('PlexiiAssist (not streamed), PlexiSearch Ask and Ask your workspace', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    reply = JSON.stringify({ reply: 'Support is open 24/7.', actions: [] })
    const chat = await ai.sendChat({ taskId: null, messages: [{ role: 'user', content: QUESTION, ts: Date.now() }] } as never)
    expect(chat.message?.content).toBe('Support is open 24/7.')
    expect(chat.grounding?.flagged.map((f) => f.span)).toEqual(['24/7'])

    reply = '{"answer":"Support is open 24/7 [1].","sources":[1]}'
    const a = await ai.askWorkspace(QUESTION, SOURCES)
    expect(a.answer).toBe('Support is open 24/7 [1].')
    expect(a.grounding).toMatchObject({ path: 'cloud', repaired: [], flagged: [{ span: '24/7', kind: 'time' }] })

    reply = 'Support is open 24/7 [1].'
    const s = await ai.askWorkspaceStream(QUESTION, SOURCES, [], () => undefined)
    expect(s.answer).toBe('Support is open 24/7 [1].')
    expect(s.grounding?.flagged.map((f) => f.span)).toEqual(['24/7'])
  })

  it('every entry point carries the full answer rule on cloud AI', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const { GROUNDING_RULE_ANSWER } = await import('../../src/main/ai/groundingRules')
    reply = '{"reply":"ok","actions":[],"answer":"ok","sources":[]}'
    await ai.sendChat({ taskId: null, messages: [{ role: 'user', content: QUESTION, ts: Date.now() }] } as never)
    await ai.askWorkspace(QUESTION, SOURCES)
    await ai.askWorkspaceStream(QUESTION, SOURCES, [], () => undefined)
    expect(bodies).toHaveLength(3)
    for (const b of bodies) expect(b.system).toContain(GROUNDING_RULE_ANSWER.trim())
  })

  it('a well-supported cloud answer is not marked', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    reply = '{"answer":"After 30 days we offer store credit only [1]; refunds take 5 business days [1].","sources":[1]}'
    const a = await ai.askWorkspace('What happens after 30 days?', SOURCES)
    expect(a.grounding).toBeUndefined()
  })
})
