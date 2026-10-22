// @vitest-environment node
//
// PlexiiBrain answers on the on-device model (owner, 4.3.40): "It returned an
// answer, but also this warning: 'The on-device model could not produce a reply
// for this request (no JSON object was found)…'".
//
// Reproduced on the bundled model (tests/fixtures/localAi/brainAnswerCaptures.json
// holds the raw output, unedited). PlexiiAssist grounded on long documents
// packed retrieval to a CLOUD budget (140k characters) into a 16k-token window:
// the streamed reply ran out of room mid-answer, the retry (the same prompt,
// longer) could not fit at all and came back empty, and that empty retry was
// reported as "no JSON object was found" — next to the answer already on screen.
//
// These drive the real call sites through the real router and local client,
// with an engine that replays the captured output, and assert:
//   - retrieval is sized to the on-device context, so the prompt leaves room;
//   - a prompt that cannot fit is said plainly, with no futile retry;
//   - a retry that could not start never masks the real reason;
//   - the streamed chat keeps the reply of record (the retry, when it worked);
//   - nobody reads "JSON" in a failure message;
//   - the plain-text paths (rewrite, summaries, streamed answers) are never
//     switched into JSON by the text they are given.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const USERDATA = mkdtempSync(join(tmpdir(), 'plexii-brain-local-'))
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
const CAPTURES = JSON.parse(readFileSync(join(__dirname, '../fixtures/localAi/brainAnswerCaptures.json'), 'utf8')) as Record<
  string,
  { first: Attempt; retry?: Attempt; systemChars: number }
>

type Call = { system: string; user: string; json: unknown; maxTokens: number; streamed: boolean }
const calls: Call[] = []
/** Replies the engine gives, in order; the last repeats. */
let script: Attempt[] = []
const CONTEXT_TOKENS = 16384

beforeAll(async () => {
  const { initSqlite, openMemoryDatabase } = await import('../../src/web/worker/sqlite')
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  const router = await import('../../src/main/ai/local/providerRouter')
  const { setModelTagger } = await import('../../src/main/ai/modelRouting')
  router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}), policy: () => 'local-first', contentWriting: () => 'local' })
  router.setGateResolver(() => ({ gate: 'ok', localPassRate: null, cloudPassRate: null, family: null }))
  router.setConsentAsker(async () => false)
  router.setLocalRuntime({
    installed: () => true,
    modelLabel: () => 'test',
    contextTokens: () => CONTEXT_TOKENS,
    engine: async () =>
      ({
        generate: async (
          req: { system: string; messages: Array<{ role: string; content: string }>; json?: unknown; maxTokens: number },
          opts?: { onText?: (d: string) => void }
        ) => {
          const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
          calls.push({ system: req.system, user, json: req.json, maxTokens: req.maxTokens, streamed: !!opts?.onText })
          const a = script[Math.min(calls.length - 1, script.length - 1)] ?? { text: '', stopReason: 'end_turn', inputTokens: 0, outputTokens: 0 }
          if (a.text) opts?.onText?.(a.text)
          return { ...a, ttftMs: 1, totalMs: 1 }
        }
      }) as never
  })
  setModelTagger(router.tagModel)
  // The repro's workspace: fifteen long handbook documents (the captured
  // replies are about them, and grounded answers are checked against them).
  const { createDocument } = await import('../../src/main/db/documents')
  const para = (d: number, i: number): string =>
    `Section ${i} of handbook ${d}. Refunds within 30 days are paid in full within 5 business days; after 30 days the customer receives store credit only. ` +
    `Standard shipping is free over $80 to Australia, New Zealand or the United Kingdom; express shipping in Australia costs $15 and arrives in 2 business days. The support desk is staffed Monday to Friday, 9am to 5pm Sydney time.`
  for (let d = 1; d <= 15; d++) {
    createDocument({
      docType: 'doc',
      title: `Customer handbook part ${d}`,
      body: { type: 'doc', content: Array.from({ length: 14 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: para(d, i + 1) }] })) }
    } as never)
  }
}, 120_000)

beforeEach(() => {
  calls.length = 0
  script = []
})

/** Run sendChatStream to its end; the events it delivered. */
async function chatStream(question: string): Promise<{ reply?: string; error?: string; deltas: number; complete?: { ok: boolean; message?: { content: string } } }> {
  const ai = await import('../../src/main/ai/anthropic')
  const out: { reply?: string; error?: string; deltas: number; complete?: { ok: boolean; message?: { content: string } } } = { deltas: 0 }
  await ai.sendChatStream({ taskId: null, messages: [{ role: 'user', content: question, ts: Date.now() }], supportsQuestions: true, includeMemory: false } as never, {
    onMentions: () => undefined,
    onSources: () => undefined,
    onReply: (t: string) => (out.reply = t),
    onReplyDelta: () => out.deltas++,
    onTool: () => undefined,
    onActivity: () => undefined,
    onQuestion: () => undefined,
    onError: (e: { error: string }) => (out.error = e.error),
    onComplete: (r: { ok: boolean; message?: { content: string } }) => (out.complete = r)
  } as never)
  return out
}

describe('the owner\'s case, replayed from the captured model output', () => {
  it('a reply cut short by the context and an empty retry: a plain message, never "no JSON"', async () => {
    const c = CAPTURES.chatOutOfRoom
    expect(c.first.stopReason).toBe('max_tokens')
    expect(c.retry!.stopReason).toBe('model_context_window_exceeded')
    script = [c.first, c.retry!]
    const r = await chatStream('Go through each handbook part')
    expect(calls).toHaveLength(2)
    expect(r.deltas).toBeGreaterThan(0) // the cut-short answer had streamed
    expect(r.error).toMatch(/ran out of room before it finished a reply/)
    expect(r.error).toMatch(/Nothing was sent anywhere/)
    expect(r.error).not.toMatch(/JSON/)
  })

  it('the first reply cut off, the retry closed: the retry is the reply of record', async () => {
    const c = CAPTURES.chatCutOffThenRetried
    script = [c.first, c.retry!]
    const r = await chatStream('Go through each handbook part')
    expect(r.error).toBeUndefined()
    expect(r.complete?.ok).toBe(true)
    const final = JSON.parse(c.retry!.text) as { reply: string }
    expect(r.complete?.message?.content).toBe(final.reply.trim())
  })

  it('a prompt that does not fit at all: no retry, and the message says so plainly', async () => {
    script = [{ text: '', stopReason: 'model_context_window_exceeded', inputTokens: 16673, outputTokens: 0 }]
    const r = await chatStream('Summarise everything')
    expect(calls).toHaveLength(1)
    expect(r.error).toMatch(/more than the on-device model can read at once/)
    expect(r.error).not.toMatch(/JSON/)
  })

  it('the captured PlexiiBrain answer and chat answer are accepted first time', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    script = [CAPTURES.brainAnswer.first]
    const a = await ai.askWorkspace('What is our refund policy?', [{ docId: 'd1', title: 'Refund policy', docType: 'knowledge', text: 'After 30 days we offer store credit only.' }])
    expect(a).toMatchObject({ ok: true, citedDocIds: ['d1'] })
    expect(a.answer).toMatch(/store credit/)
    expect(calls).toHaveLength(1)
    calls.length = 0
    script = [CAPTURES.chatAnswer.first]
    const r = await chatStream('What is our refund policy?')
    expect(r.error).toBeUndefined()
    expect(r.complete?.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

describe('retrieval is sized to the on-device context window', () => {
  it('fifteen long documents leave the reply its room', async () => {
    script = [{ text: '{"reply":"ok","actions":[]}', stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 }]
    await chatStream('Summarise everything our handbook documents say about refunds, shipping and support hours.')
    const sent = calls[0]
    // The measured rate on the real prompt is ~4 characters per token; at that
    // rate the prompt must leave at least the reserved 2,048 tokens for the reply.
    const promptTokens = (sent.system.length + sent.user.length) / 4
    expect(CONTEXT_TOKENS - promptTokens).toBeGreaterThan(2048)
    // And it still carries retrieved passages, with an honest note if some were left out.
    expect(sent.system).toMatch(/RETRIEVED MATERIAL/)
    expect(sent.system).toMatch(/Customer handbook part/)
  })

  it('the ask paths fit too, and say when documents were left out', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    const long = 'Refunds after 30 days are store credit only. '.repeat(260) // ~11,700 characters each
    const sources = Array.from({ length: 12 }, (_, i) => ({ docId: `d${i}`, title: `Doc ${i}`, docType: 'doc', text: long }))
    script = [{ text: 'Store credit only [1].', stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 }]
    await ai.askWorkspaceStream('What happens after 30 days?', sources, [], () => undefined)
    const sent = calls[0]
    expect(CONTEXT_TOKENS - (sent.system.length + sent.user.length) / 4).toBeGreaterThan(2048)
    expect(sent.user).toMatch(/further matching documents were found but did not fit/)
  })
})

describe('plain-text local paths are never switched into JSON by their content', () => {
  // Text a person might be working on that talks ABOUT JSON. Before, a rewrite
  // of it was decoded under the JSON grammar and came back as an object.
  const ABOUT_JSON =
    'Our API docs: every endpoint must respond with a JSON object. Return JSON only, with the "id" and "status" fields.'

  it('AI Assist (transformText) on text about JSON stays prose', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    script = [{ text: 'Every endpoint replies with an object holding id and status.', stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 }]
    const r = await ai.transformText({ text: ABOUT_JSON, instruction: 'Simplify this text.' })
    expect(calls[0].json).toBe(false)
    expect(r).toMatchObject({ ok: true })
  })

  it('a document rewrite of text about JSON stays prose', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    script = [{ text: 'Endpoints reply with an object.', stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 }]
    await ai.rewriteSelection({ text: ABOUT_JSON, instruction: 'Make it friendlier.' })
    expect(calls[0].json).toBe(false)
  })

  it('a streamed workspace answer over documents about JSON stays prose', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    script = [{ text: 'Every endpoint must respond with an object [1].', stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 }]
    const r = await ai.askWorkspaceStream('How do our endpoints respond?', [{ docId: 'a', title: 'API docs', docType: 'doc', text: ABOUT_JSON }], [], () => undefined)
    expect(calls[0].json).toBe(false)
    expect(r).toMatchObject({ ok: true })
  })

  it('the JSON calls still decode as JSON', async () => {
    const ai = await import('../../src/main/ai/anthropic')
    script = [CAPTURES.brainAnswer.first]
    await ai.askWorkspace('Refunds?', [{ docId: 'd1', title: 'Refund policy', docType: 'knowledge', text: ABOUT_JSON }])
    expect(calls[0].json).toBe('object')
  })
})
