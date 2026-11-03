// @vitest-environment node
//
// Build with AI (the desk builder) through the REAL buildFromPrompt and the
// real router, with a fake Anthropic client standing in for the person's key.
//
// Owner, 2026-11-03: "Don't cap the reply tokens so we can always create
// context rich and widget rich desk solutions for any requirements", and
// "as helpful as possible, without wasting effort and tokens". Pinned here:
//   - the request asks for the model's full output and is streamed (a long
//     desk is not cut off at 16,384 tokens, and does not time out);
//   - pages are asked for as markdown and arrive as page documents;
//   - a reply that still stops early keeps its complete widgets and says so,
//     instead of discarding the whole generation as "invalid JSON".
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const USERDATA = mkdtempSync(join(tmpdir(), 'plexii-deskbuild-'))
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

type Sent = { via: 'stream' | 'create'; body: { model: string; max_tokens: number; system: string } }
let sent: Sent[]
let reply: { text: string; stop_reason: string }

const fakeKey = {
  baseURL: 'https://api.anthropic.com',
  messages: {
    create: async (body: Sent['body']) => {
      sent.push({ via: 'create', body })
      return { content: [{ type: 'text', text: reply.text }], stop_reason: reply.stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }
    },
    stream: (body: Sent['body']) => {
      sent.push({ via: 'stream', body })
      const listeners: Array<(d: string) => void> = []
      return {
        on: (_e: string, fn: (d: string) => void) => listeners.push(fn),
        abort: () => undefined,
        finalMessage: async () => {
          for (const l of listeners) l(reply.text)
          return { content: [{ type: 'text', text: reply.text }], stop_reason: reply.stop_reason, usage: { input_tokens: 1, output_tokens: 1 } }
        }
      }
    }
  }
}

beforeAll(async () => {
  const { initSqlite, openMemoryDatabase } = await import('../../src/web/worker/sqlite')
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  const router = await import('../../src/main/ai/local/providerRouter')
  const { setModelTagger } = await import('../../src/main/ai/modelRouting')
  // The owner's setup: their own Anthropic key. Build is routed to it explicitly
  // here because the test has no saved key for the account-default route.
  router.setRouterSettings({ aiMode: () => 'byok', featureRoutes: () => ({ build: 'anthropic' }) })
  router.setCloudProviders({ anthropic: () => fakeKey as never, credits: () => null, openai: () => null })
  setModelTagger(router.tagModel)
}, 120_000)

beforeEach(() => {
  sent = []
})

const table = {
  id: 's1',
  kind: 'table',
  title: 'Suppliers',
  reason: 'Who supplies what',
  tableSchema: { columns: [{ id: 'c1', type: 'text-short', label: 'Name', config: {} }] }
}
const page = { id: 's2', kind: 'page', title: 'Launch plan', reason: 'The plan', pageMarkdown: '# Launch plan\n\n- [ ] Book venue' }
const sticky = { id: 's3', kind: 'sticky', title: 'Today', reason: 'Focus', content: 'Call the printer' }

describe('Build with AI asks for everything the model can write', () => {
  it("streams the request with the model's full output allowance", async () => {
    reply = { text: JSON.stringify({ intent: 'x', suggestions: [sticky] }), stop_reason: 'end_turn' }
    const { buildFromPrompt } = await import('../../src/main/ai/anthropic')
    const { MODEL_MAX_OUTPUT_TOKENS } = await import('../../src/main/ai/modelRouting')
    const r = await buildFromPrompt({ prompt: 'A desk for launching a bakery', taskId: null })
    expect(r.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].via).toBe('stream')
    expect(MODEL_MAX_OUTPUT_TOKENS).toBe(128_000)
    expect(sent[0].body.max_tokens).toBe(MODEL_MAX_OUTPUT_TOKENS)
    expect(sent[0].body.model).toBe('claude-sonnet-5-5')
  })

  it('asks for markdown pages and minified JSON, the cheap forms of the same desk', async () => {
    reply = { text: JSON.stringify({ suggestions: [sticky] }), stop_reason: 'end_turn' }
    const { buildFromPrompt } = await import('../../src/main/ai/anthropic')
    await buildFromPrompt({ prompt: 'A desk for launching a bakery', taskId: null })
    const system = sent[0].body.system
    expect(system).toContain('pageMarkdown is REQUIRED')
    expect(system).not.toContain('Provide pageContent as a Tiptap document')
    expect(system).toMatch(/MINIFIED/)
  })
})

describe('what comes back', () => {
  it('a markdown page arrives as a page document the canvas can open', async () => {
    reply = { text: JSON.stringify({ intent: 'A launch desk', suggestions: [table, page] }), stop_reason: 'end_turn' }
    const { buildFromPrompt } = await import('../../src/main/ai/anthropic')
    const r = await buildFromPrompt({ prompt: 'A desk for launching a bakery', taskId: null })
    expect(r.ok).toBe(true)
    expect(r.notice).toBeUndefined()
    const p = r.suggestions?.find((s) => s.kind === 'page') as unknown as Record<string, unknown>
    expect(p.pageMarkdown).toBeUndefined()
    expect((p.pageContent as { type: string }).type).toBe('doc')
  })

  it('a reply that reaches the output limit keeps its complete widgets and says it stopped', async () => {
    const whole = JSON.stringify({ intent: 'A launch desk', suggestions: [table, page, sticky] })
    reply = { text: whole.slice(0, whole.indexOf('Call the printer')), stop_reason: 'max_tokens' }
    const { buildFromPrompt } = await import('../../src/main/ai/anthropic')
    const r = await buildFromPrompt({ prompt: 'A desk for launching a bakery', taskId: null })
    expect(r.ok).toBe(true)
    expect(r.suggestions?.map((s) => s.title)).toEqual(['Suppliers', 'Launch plan'])
    expect(r.notice).toMatch(/limit/)
    expect(r.notice).toMatch(/2 work widgets/)
  })

  it('a code fence inside a widget no longer breaks the whole reply', async () => {
    const md = { id: 's1', kind: 'markdown', title: 'Runbook', reason: '', content: 'Deploy:\n```sh\nmake ship\n```' }
    reply = { text: JSON.stringify({ suggestions: [md, sticky] }), stop_reason: 'end_turn' }
    const { buildFromPrompt } = await import('../../src/main/ai/anthropic')
    const r = await buildFromPrompt({ prompt: 'A desk for releases', taskId: null })
    expect(r.ok).toBe(true)
    expect(r.suggestions?.map((s) => s.title)).toEqual(['Runbook', 'Today'])
  })

  it('a reply with no work widget in it fails plainly, naming the cut-off when there was one', async () => {
    const { buildFromPrompt } = await import('../../src/main/ai/anthropic')
    reply = { text: 'Sorry, I cannot do that.', stop_reason: 'end_turn' }
    expect(await buildFromPrompt({ prompt: 'x', taskId: null })).toMatchObject({ ok: false, error: 'AI did not return JSON' })
    reply = { text: '{"intent":"A desk","suggestions":[{"id":"s1","kind":"tab', stop_reason: 'max_tokens' }
    const cut = await buildFromPrompt({ prompt: 'x', taskId: null })
    expect(cut.ok).toBe(false)
    expect(cut.error).toMatch(/limit/)
  })
})
