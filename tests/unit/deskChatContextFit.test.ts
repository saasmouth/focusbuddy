// @vitest-environment node
//
// PlexiiAssist on a desk, on the on-device model (owner, 4.3.40):
//   "based on this desk, can you provide a research summary report on the
//    future of AI at work" → "Conversation hit the model context window.
//    Start a fresh session."
// on the FIRST message of a fresh conversation (ai_chat_messages: the error
// landed one second after the question — the engine's fit check refused the
// prompt before generating anything).
//
// Root cause: only the retrieved passages were ever sized to the on-device
// window. The instructions (~31k characters), the desk index (up to 40 work
// widgets at 600–1,800 characters each), the open pages (up to 24k
// characters) and @-references (up to 20k) were sent at their cloud caps, so
// a busy desk alone was more than a 16k-token window, and the stop reason was
// reported with advice that makes no sense on a first message.
//
// These drive the real sendChat / sendChatStream through the real router and
// local client against an engine that applies the same fit check as
// engineCore (refuse when the prompt leaves under 64 tokens), and assert:
//   - the owner's desk now fits, with room for the reply, on the first turn;
//   - every work widget is still listed by id (actions need them);
//   - what was cut is said in the prompt AND at the end of the answer;
//   - nothing is cut, and nothing is said, when everything fits;
//   - "Start a fresh session" is never the answer to a first message.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const USERDATA = mkdtempSync(join(tmpdir(), 'plexii-desk-fit-'))
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

// The shipped on-device tier's window (localModelCatalog: contextSize 16384).
const CONTEXT_TOKENS = 16384
// The window the engine reports; a test may shrink it to drive the cut path.
let windowTokens = CONTEXT_TOKENS
// engineCore's own estimate is a real tokenizer; measured on the shipped model
// the chat prompt runs ~4.0 characters per token. 3.5 here is STRICTER than
// the real engine, so a prompt that passes this check passes the real one.
const TEST_CHARS_PER_TOKEN = 3.5

type Call = { system: string; user: string; turns: number; promptTokens: number; refused: boolean }
const calls: Call[] = []
const REPLY = '{"reply":"## The future of AI at work\\n\\nA summary drawn from the desk.","actions":[]}'
let DESK = ''
let SMALL_DESK = ''
let MENTIONED_DOC = ''
const deskWidgetIds: string[] = []

beforeAll(async () => {
  const { initSqlite, openMemoryDatabase } = await import('../../src/web/worker/sqlite')
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  const router = await import('../../src/main/ai/local/providerRouter')
  const { setModelTagger } = await import('../../src/main/ai/modelRouting')
  // The owner's settings (secrets.json): AI source Local, PlexiiAssist routed Local.
  router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({ assistant: 'local' }), policy: () => 'local-first', contentWriting: () => 'local' })
  router.setGateResolver(() => ({ gate: 'ok', localPassRate: null, cloudPassRate: null, family: null }))
  router.setConsentAsker(async () => false)
  router.setLocalRuntime({
    installed: () => true,
    modelLabel: () => 'test',
    contextTokens: () => windowTokens,
    engine: async () =>
      ({
        generate: async (
          req: { system: string; messages: Array<{ role: string; content: string }> },
          opts?: { onText?: (d: string) => void }
        ) => {
          // engineCore's fit check: prompt + 32 + 64 per turn, refused with
          // under 64 tokens of room, before anything is generated.
          const chars = req.system.length + req.messages.reduce((n, m) => n + m.content.length + 1, 0)
          const promptTokens = Math.ceil(chars / TEST_CHARS_PER_TOKEN) + 32 + 64 * req.messages.length
          const refused = windowTokens - promptTokens < 64
          calls.push({ system: req.system, user: req.messages.map((m) => m.content).join('\n'), turns: req.messages.length, promptTokens, refused })
          if (refused) {
            return { text: '', inputTokens: promptTokens, outputTokens: 0, stopReason: 'model_context_window_exceeded', ttftMs: null, totalMs: 1 }
          }
          opts?.onText?.(REPLY)
          return { text: REPLY, inputTokens: promptTokens, outputTokens: 20, stopReason: 'end_turn', ttftMs: 1, totalMs: 1 }
        }
      }) as never
  })
  setModelTagger(router.tagModel)

  const { createNode } = await import('../../src/main/db/nodes')
  const { createWidget } = await import('../../src/main/db/widgets')
  const { createDocument: create } = await import('../../src/main/db/documents')
  const { reindexDocumentChunks } = await import('../../src/main/chunkIndex')
  // Indexed as the app indexes them: the desk's work widget files already put
  // the passage index in use, and retrieval then searches documents through it.
  const createDocument = (draft: never): string => {
    const id = (create(draft) as { id: string }).id
    reindexDocumentChunks(id)
    return id
  }

  // The owner's desk, "AI for Work Research": 19 work widgets — research
  // pages and notes with real paragraphs, a source log, stickies, fields.
  DESK = createNode({ parentId: null, kind: 'task', title: 'AI for Work Research' } as never).id
  const para = (topic: string, i: number): string =>
    `${topic}, part ${i}: generative AI moved from pilots to daily use in knowledge work between 2023 and 2026; ` +
    `drafting, summarising, coding and analysis saw the largest adoption, while regulated industries moved slower. `
  const kinds = ['markdown', 'sticky', 'note'] as const
  for (let i = 0; i < 19; i++) {
    const w = createWidget({
      taskId: DESK,
      kind: kinds[i % kinds.length],
      title: `Research note ${i + 1}`,
      content: Array.from({ length: 12 }, (_, k) => para(`Note ${i + 1}`, k + 1)).join('\n')
    } as never) as { id: string }
    deskWidgetIds.push(w.id)
  }
  MENTIONED_DOC = createDocument({
    docType: 'doc',
    title: 'Interview notes: AI adoption at Acme',
    body: {
      type: 'doc',
      content: Array.from({ length: 40 }, (_, i) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: `Interview ${i + 1}: the team uses an assistant daily for first drafts and meeting summaries; review time fell but did not disappear.` }]
      }))
    }
  } as never)
  SMALL_DESK = createNode({ parentId: null, kind: 'task', title: 'Quick errands' } as never).id
  createWidget({ taskId: SMALL_DESK, kind: 'sticky', title: 'Groceries', content: 'Milk, eggs, bread' } as never)

  // The workspace the question also searches: long documents about the topic,
  // among unrelated ones (as in any real workspace — and ranking needs them:
  // a term every document carries tells retrieval nothing).
  for (let d = 1; d <= 20; d++) {
    createDocument({
      docType: 'doc',
      title: `Recipe ${d}`,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Slow-cooked lentil soup number ${d}: onions, carrots, cumin and stock, simmered for forty minutes.` }] }] }
    } as never)
  }
  for (let d = 1; d <= 12; d++) {
    createDocument({
      docType: 'doc',
      title: `Future of AI at work, report ${d}`,
      body: {
        type: 'doc',
        content: Array.from({ length: 14 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: para(`Report ${d} on the future of AI at work`, i + 1) }] }))
      }
    } as never)
  }
}, 120_000)

beforeEach(() => {
  calls.length = 0
  windowTokens = CONTEXT_TOKENS
})

// Six web pages open on the canvas (the owner's desk had six browser widgets:
// Stanford AI Index, McKinsey, Microsoft Work Trend Index, …), each at the
// renderer's 8,000-character per-item cap.
const OPEN_PAGES = Array.from({ length: 6 }, (_, i) => ({
  widgetId: `wv-${i}`,
  kind: 'browser page',
  title: `Open page ${i + 1}`,
  source: `https://example.org/page-${i + 1}`,
  text: `Page ${i + 1} on AI in the workplace. `.repeat(400)
}))

const QUESTION = 'based on this desk, can you provide a research summary report on the future of AI at work'

async function chatStream(taskId: string, attachments: typeof OPEN_PAGES = []): Promise<{ error?: string; complete?: { ok: boolean; message?: { content: string } } }> {
  const ai = await import('../../src/main/ai/anthropic')
  const out: { error?: string; complete?: { ok: boolean; message?: { content: string } } } = {}
  await ai.sendChatStream(
    { taskId, messages: [{ role: 'user', content: QUESTION, ts: Date.now() }], attachments, supportsQuestions: true, includeMemory: true } as never,
    {
      onMentions: () => undefined,
      onSources: () => undefined,
      onReply: () => undefined,
      onReplyDelta: () => undefined,
      onTool: () => undefined,
      onActivity: () => undefined,
      onQuestion: () => undefined,
      onError: (e: { error: string }) => (out.error = e.error),
      onComplete: (r: { ok: boolean; message?: { content: string } }) => (out.complete = r)
    } as never
  )
  return out
}

describe("the owner's case: a first message about a busy desk on the on-device model", () => {
  it('fits the window with room for the reply, and answers', async () => {
    const r = await chatStream(DESK, OPEN_PAGES)
    expect(r.error).toBeUndefined()
    expect(r.complete?.ok).toBe(true)
    // One chat generation (a memory pass may follow it in the background).
    expect(calls[0].system).toMatch(/OUTPUT FORMAT/)
    expect(calls[0].refused).toBe(false)
    // The reply keeps the room the budget reserved for it (2,048 tokens).
    expect(CONTEXT_TOKENS - calls[0].promptTokens).toBeGreaterThanOrEqual(2048)
  })

  it('still lists every work widget by id, and carries desk, page and search material', async () => {
    await chatStream(DESK, OPEN_PAGES)
    const sys = calls[0].system
    for (const id of deskWidgetIds) expect(sys).toContain(`id=${id}`)
    expect(sys).toMatch(/Desk: AI for Work Research/)
    expect(sys).toMatch(/Content open on the user's canvas/)
    expect(sys).toMatch(/Open page 1/)
    expect(sys).toMatch(/RETRIEVED MATERIAL/)
  })

  it('tells the model what was cut, in the prompt', async () => {
    await chatStream(DESK, OPEN_PAGES)
    const sys = calls[0].system
    expect(sys).toMatch(/To fit what the model can read at once, the content of \d+ work widgets are cut short/)
    expect(sys).toMatch(/\[Truncated — the first \d+ characters are shown; the rest of this content was not read\.\]|more open items? (was|were) on the canvas but did not fit/)
    expect(sys).toMatch(/further match(es)? were found but did not fit/)
  })

  it('says what was cut at the end of the answer, in plain words and real counts', async () => {
    const r = await chatStream(DESK, OPEN_PAGES)
    const content = r.complete?.message?.content ?? ''
    expect(content).toMatch(/^## The future of AI at work/)
    expect(content).toMatch(/\*Not everything was read: the on-device model reads about 16k tokens at once/)
    expect(content).toMatch(/\d+ of 19 work widgets on this desk were shortened/)
    expect(content).toMatch(/of 6 open pages and documents (were|was) (shortened|not read)/)
    expect(content).toMatch(/This answer rests only on what was read\./)
    expect(content).not.toMatch(/fresh session/i)
  })

  it('a small desk with nothing open is sent whole, and the notice names only what was actually cut', async () => {
    const r = await chatStream(SMALL_DESK)
    expect(r.complete?.ok).toBe(true)
    expect(calls[0].system).toMatch(/Groceries.*Milk, eggs, bread/)
    expect(calls[0].system).not.toMatch(/To fit what the model can read at once/)
    // Nothing on the desk was cut, so the notice (if the search results had
    // to be trimmed) names only those.
    expect(r.complete?.message?.content).not.toMatch(/work widgets? on this desk|open pages/)
  })

  it('the non-streamed path fits and discloses the same way', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const r = await ai.sendChat({ taskId: DESK, messages: [{ role: 'user', content: QUESTION, ts: Date.now() }], attachments: OPEN_PAGES, supportsQuestions: true, includeMemory: true } as never)
    expect(r.ok).toBe(true)
    expect(calls[0].refused).toBe(false)
    expect(r.message?.content).toMatch(/Not everything was read/)
  })
})

describe('an @-referenced document on the busy desk', () => {
  it('is read first, its chip reports exactly what reached the prompt, and the request still fits', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const r = await ai.sendChat({
      taskId: DESK,
      messages: [{ role: 'user', content: 'Using the interview notes, what does this desk say about AI at work?', ts: Date.now() }],
      mentions: [{ kind: 'document', id: MENTIONED_DOC, title: 'Interview notes: AI adoption at Acme' }],
      attachments: OPEN_PAGES,
      supportsQuestions: true,
      includeMemory: false
    } as never)
    expect(r.ok).toBe(true)
    expect(calls[0].refused).toBe(false)
    const sys = calls[0].system
    const m = r.mentions?.[0]
    expect(m?.resolved).toBe(true)
    // The chip's count is the text that rode: it is in the prompt, whole.
    expect(m?.chars).toBeGreaterThan(1000)
    expect(sys).toMatch(/Items the user referenced with @/)
    expect(sys.indexOf('Items the user referenced with @')).toBeLessThan(sys.indexOf("Content open on the user's canvas"))
    // Over 5,000 characters of notes on a 16k-token window: said, not hidden.
    if (m?.truncated) expect(sys).toMatch(/\[Truncated/)
  })
})

describe('one-shot desk calls fit the window too', () => {
  it('the desk welcome and the handoff document cut the desk to fit, and say so in the prompt', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    // A smaller window than the owner's, so this desk's full index (about
    // 14k characters) is more than it holds.
    windowTokens = 6144
    const welcome = await ai.generateProactiveWelcome(DESK)
    expect(welcome.ok).toBe(true)
    const resume = await ai.generateResume(DESK)
    expect(resume.ok).toBe(true)
    expect(calls.map((c) => c.refused)).toEqual([false, false])
    for (const c of calls) {
      expect(c.user).toMatch(/Desk: AI for Work Research/)
      expect(c.user).toMatch(/To fit what the model can read at once, the content of \d+ work widgets are cut short/)
      for (const id of deskWidgetIds) expect(c.user).toContain(`id=${id}`)
    }
  })
})

describe('pure: sharing the window', () => {
  it('fairShares gives small parts all they need and shares the rest by weight', async () => {
    const { fairShares } = await import('../../src/main/ai/promptFit')
    // Everything fits: nothing is cut.
    expect(fairShares([{ size: 100, weight: 1 }, { size: 200, weight: 1 }], 1000)).toEqual([100, 200])
    // A small part is not starved by a huge one.
    expect(fairShares([{ size: 300, weight: 1 }, { size: 50_000, weight: 1 }], 1000)).toEqual([300, 700])
    // Weights: 2:1 between two parts that both overflow.
    expect(fairShares([{ size: 10_000, weight: 2 }, { size: 10_000, weight: 1 }], 900)).toEqual([600, 300])
    // Empty parts take nothing; the total never exceeds the budget.
    const s = fairShares([{ size: 0, weight: 3 }, { size: 5000, weight: 2 }, { size: 9000, weight: 1 }, { size: 400, weight: 1 }], 3000)
    expect(s[0]).toBe(0)
    expect(s[3]).toBe(400)
    expect(s.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3000)
    expect(fairShares([{ size: 10, weight: 1 }], -5)).toEqual([0])
  })

  it('localPromptCharBudget leaves the reply reserve and the template', async () => {
    const { localPromptCharBudget } = await import('../../src/main/ai/promptFit')
    // (16384 - 2048 - 256 - 64) * 3.5
    expect(localPromptCharBudget(16384, 1)).toBe(Math.floor((16384 - 2048 - 256 - 64) * 3.5))
    expect(localPromptCharBudget(16384, 3)).toBeLessThan(localPromptCharBudget(16384, 1))
    expect(localPromptCharBudget(1000)).toBe(0)
  })

  it('fitRetrievalSources never keeps past a hard budget; shortens the best match when only it can fit', async () => {
    const { fitRetrievalSources, MIN_FITTED_PASSAGE } = await import('../../src/main/ai/grounding')
    const src = (title: string, n: number): { title: string; text: string } => ({ title, text: 'x'.repeat(n) })
    const all = fitRetrievalSources([src('a', 1000), src('b', 1000), src('c', 1000)], 2200)
    expect(all.kept.map((k) => k.title)).toEqual(['a', 'b'])
    expect(all.dropped).toBe(1)
    const one = fitRetrievalSources([src('big', 6000), src('b', 100)], 1500)
    expect(one.kept).toHaveLength(1)
    expect(one.shortened).toBe(1)
    expect(one.kept[0].text).toMatch(/\[shortened to fit\]$/)
    expect(one.kept[0].text.length + 'big'.length + 24).toBeLessThanOrEqual(1500)
    // Too little room to say anything: nothing kept, all counted.
    const none = fitRetrievalSources([src('big', 6000)], MIN_FITTED_PASSAGE)
    expect(none).toEqual({ kept: [], dropped: 1, shortened: 0 })
  })

  it('renderAttachmentsFit counts and states what it shortened and what it left out', async () => {
    const { renderAttachmentsFit, renderAttachments } = await import('../../src/main/ai/chatAttachments')
    const r = renderAttachmentsFit(OPEN_PAGES, undefined, 9000)
    expect(r.total).toBe(6)
    // 8,000 of the first (the per-item cap), the last 1,000 of the budget to
    // the second, nothing left for the other four.
    expect(r.shortened).toBe(2)
    expect(r.omitted).toBe(4)
    expect(r.block).toMatch(/4 more open items were on the canvas but did not fit and were not read/)
    // Default budget: byte-for-byte what renderAttachments always produced.
    expect(renderAttachmentsFit(OPEN_PAGES).block).toBe(renderAttachments(OPEN_PAGES))
  })

  it('contextCutsNotice is null when nothing was cut, and names real counts when something was', async () => {
    const { contextCutsNotice } = await import('../../src/main/ai/promptFit')
    expect(contextCutsNotice({ contextTokens: 16384, desk: { total: 5, shortened: 0, omitted: 0 } })).toBeNull()
    const n = contextCutsNotice({
      contextTokens: 16384,
      desk: { total: 19, shortened: 19, omitted: 0 },
      pages: { total: 6, shortened: 1, omitted: 4 },
      retrieval: { total: 28, shortened: 0, omitted: 25 }
    })
    expect(n).toBe(
      '*Not everything was read: the on-device model reads about 16k tokens at once, so 19 of 19 work widgets on this desk were shortened; ' +
        '1 of 6 open pages and documents was shortened and 4 were not read; 25 of 28 matching workspace items were left out. ' +
        'This answer rests only on what was read. To have a particular work widget, page or document read first, @-mention it in your question.*'
    )
  })

  it('"Start a fresh session" is never the answer to a first message or a one-shot request', async () => {
    const { contextWindowError } = await import('../../src/main/ai/promptFit')
    expect(contextWindowError(1)).not.toMatch(/fresh|new conversation/i)
    expect(contextWindowError(1)).toMatch(/more than the AI model can read at once/)
    expect(contextWindowError(0)).not.toMatch(/fresh|conversation/i)
    expect(contextWindowError(4)).toMatch(/Start a new conversation/)
  })
})
