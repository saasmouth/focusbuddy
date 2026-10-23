// @vitest-environment node
//
// Answers are grounded on the CLOUD path too (4.3.41). A cloud model is never
// rewritten: an invented specific is highlighted for the person to check.
// The model is a stub that answers with an invented specific; every chat and
// Brain entry point must carry the full answer rule and mark the specific.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
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

// The stub cloud model: records each request, answers with `reply`. A stream
// sends `chunks` as its text deltas when set (the whole reply as one delta
// otherwise) and, with `stopAfterChunks`, ends as a user Stop does.
const bodies: Array<{ system: string }> = []
let reply = ''
let chunks: string[] | null = null
let stopAfterChunks = false
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
          for (const part of chunks ?? [reply]) for (const fn of listeners) fn(part)
          if (stopAfterChunks) throw Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })
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

// No network from a unit test. The chat turn runs a web search alongside
// retrieval (localOnlyActive is false above), and it used to go out for real:
// several seconds a turn waiting on DuckDuckGo, and whatever came back joined
// what the answer was checked against, so a live result page could ground
// "$15" or "24/7". The web pool answers empty, and any other request is
// refused and recorded so the test fails if one appears.
vi.mock('../../src/main/webSearch', async (orig) => ({
  ...(await orig<typeof import('../../src/main/webSearch')>()),
  searchWeb: async () => []
}))
// Nor anything from the machine the test runs on. Whether Ollama is listening
// on this Mac, or an OPENAI_API_KEY is exported in this shell, decided whether
// semantic retrieval was on (and cost a 3 s probe when the port was closed),
// and the memory extraction a chat turn starts in the background asked Ollama
// too, while the NEXT test was already running.
vi.mock('../../src/main/ai/localModel', async (orig) => ({
  ...(await orig<typeof import('../../src/main/ai/localModel')>()),
  localModelStatus: async () => ({ available: false, baseUrl: 'none (unit test)', chatModel: null, embedModel: null }),
  localChat: async () => null,
  localEmbed: async () => null
}))
vi.stubEnv('OPENAI_API_KEY', '')
vi.stubEnv('ANTHROPIC_API_KEY', '')
const netCalls: string[] = []
vi.stubGlobal('fetch', async (url: unknown) => {
  netCalls.push(String(url))
  throw new Error(`unit test tried the network: ${String(url)}`)
})

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

afterEach(() => {
  expect(netCalls).toEqual([])
})

beforeEach(() => {
  netCalls.length = 0
  bodies.length = 0
  chunks = null
  stopAfterChunks = false
  vi.useRealTimers()
})

type Done = { content?: string; grounding?: import('@shared/types').AnswerGrounding }
/** One PlexiiAssist turn through the streamed path, resolved with what onComplete was given. */
async function streamChat(): Promise<Done> {
  const ai = await import('../../src/main/ai/anthropic')
  let done: Done = {}
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
  return done
}

/** Every way to cut `text` into two deltas so that `inner` is split, plus its edges. */
function splitsAround(text: string, inner: string): Array<[string, string]> {
  const at = text.indexOf(inner)
  if (at < 0) throw new Error(`"${inner}" is not in the reply`)
  const out: Array<[string, string]> = []
  for (let cut = at; cut <= at + inner.length; cut++) out.push([text.slice(0, cut), text.slice(cut)])
  return out
}

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

  // The chat context carries the clock, and the checker once matched a span's
  // digits against every digit in it run together, so "$15" counted as
  // supplied at 15:xx, at hh:15, on the 15th and at 1:50-1:59, 11:50-11:59 and
  // 21:50-21:59. That made the test above fail by the time of day.
  it.each([
    '2026-10-23T15:15:00Z',
    '2026-10-23T21:53:00Z',
    '2026-10-23T01:50:00Z',
    '2026-10-15T02:02:00Z',
    '2026-10-23T02:02:00Z'
  ])('PlexiiAssist (streamed) marks the same specifics with the clock at %s', async (now) => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) })
    reply = JSON.stringify({ reply: 'Store credit only after 30 days [1]. Support costs $15 an hour and is open 24/7.', actions: [] })
    const done = await streamChat()
    expect(done.grounding?.flagged.map((f) => f.span).sort()).toEqual(['$15', '24/7'])
  })

  describe('a specific split across stream deltas is still marked, on the final text', () => {
    const ANSWER = 'Store credit only after 30 days [1]. Support costs $15 an hour, is open 24/7 and moved on March 14.'
    const ENVELOPE = JSON.stringify({ reply: ANSWER, actions: [] })
    const WANT = ['$15', '24/7', 'March 14']
    // The clock grounds today's date, so it must not be March 14 — and 15:15
    // is one of the minutes that used to ground "$15".
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-23T15:15:00Z') })
    })

    for (const inner of WANT) {
      it(`"${inner}" cut at every position (completed stream, and stopped)`, async () => {
        const cuts = splitsAround(ENVELOPE, inner)
        expect(cuts.length).toBe(inner.length + 1)
        for (const stop of [false, true]) {
          for (const [a, b] of cuts) {
            reply = ENVELOPE
            chunks = [a, b]
            stopAfterChunks = stop
            const done = await streamChat()
            const where = `${stop ? 'stopped' : 'completed'}, cut ${JSON.stringify(a.slice(-6))}|${JSON.stringify(b.slice(0, 6))}`
            expect(done.content, where).toBe(ANSWER)
            expect(done.grounding?.path, where).toBe('cloud')
            expect(done.grounding?.flagged.map((f) => f.span).sort(), where).toEqual(WANT)
          }
        }
      })
    }

    it('one character per delta', async () => {
      reply = ENVELOPE
      chunks = [...ENVELOPE]
      const done = await streamChat()
      expect(done.content).toBe(ANSWER)
      expect(done.grounding?.flagged.map((f) => f.span).sort()).toEqual(WANT)
    })

    it('Ask your workspace (streamed), cut at every position in each specific', async () => {
      const ai = await import('../../src/main/ai/anthropic')
      const answer = 'Support costs $15 an hour [1], is open 24/7 and moved on March 14.'
      for (const inner of WANT) {
        for (const [a, b] of splitsAround(answer, inner)) {
          reply = answer
          chunks = [a, b]
          const deltas: string[] = []
          const s = await ai.askWorkspaceStream(QUESTION, SOURCES, [], (d: string) => deltas.push(d))
          const where = `cut ${JSON.stringify(a.slice(-6))}|${JSON.stringify(b.slice(0, 6))}`
          expect(deltas, where).toEqual([a, b])
          expect(s.answer, where).toBe(answer)
          expect(s.grounding?.flagged.map((f) => f.span).sort(), where).toEqual(WANT)
        }
      }
    })
  })

  it('a reply written as plain prose, outside the envelope, is checked too', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    reply = 'Support costs $15 an hour and is open 24/7.'
    const streamed = await streamChat()
    expect(streamed.content).toBe(reply)
    expect(streamed.grounding?.flagged.map((f) => f.span).sort()).toEqual(['$15', '24/7'])
    const chat = await ai.sendChat({ taskId: null, messages: [{ role: 'user', content: QUESTION, ts: Date.now() }] } as never)
    expect(chat.message?.content).toBe(reply)
    expect(chat.grounding?.flagged.map((f) => f.span).sort()).toEqual(['$15', '24/7'])
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
