// Structured local output: does the on-device model return the shape each call
// needs? Drives the REAL product functions that expect JSON (in-table AI rows
// and columns, Build with AI suggestion cards, chat proposals, workspace
// actions, work-widget setup, agent profiles, sheet columns / fill) through
// the real router and local client on the bundled model, with varied briefs,
// and records for every call:
//   - each raw engine output (first attempt, retry),
//   - how it failed, classified (prose around JSON, code fence, wrong top-level
//     key, bare array, single object, truncated, trailing comma, empty list…),
//   - the product function's own result (ok, how many rows / cards / items),
//   - length.
// No judge: this measures SHAPE. Quality is tools/local-ai-eval/run.eval.ts.
//
//   EVAL_MODEL=<gguf> EVAL_LABEL=<name> [EVAL_SCHEMA=0|1] [EVAL_SAMPLES=n] [EVAL_ONLY=entry,…]
//   npx vitest run --config tools/local-ai-eval/vitest.structured.config.ts
import { describe, it, beforeAll, vi, expect } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const USERDATA = mkdtempSync(join(tmpdir(), 'plexii-structured-'))
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, getName: () => 'plexii', getVersion: () => '0.0.0-eval', isPackaged: false, on: () => undefined, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  ipcMain: { handle: () => undefined, on: () => undefined },
  shell: { openExternal: async () => undefined },
  net: {},
  utilityProcess: {},
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

const MODEL = process.env.EVAL_MODEL || ''
const LABEL = process.env.EVAL_LABEL || 'structured'
const SCHEMA = process.env.EVAL_SCHEMA === '1'
const SAMPLES = Number(process.env.EVAL_SAMPLES || 1)
const ONLY = (process.env.EVAL_ONLY || '').split(',').filter(Boolean)
const OUT = join(__dirname, 'results', `structured-${LABEL}.json`)

type Raw = { text: string; stop: string; outputTokens: number }
let calls: Raw[] = []

export function classify(text: string, stop: string): string[] {
  const t = text.trim()
  const out: string[] = []
  if (stop !== 'end_turn') out.push('truncated')
  if (/```/.test(t)) out.push('code-fence')
  const first = t.search(/[[{]/)
  if (first > 0) out.push('prose-before')
  const lastClose = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (lastClose >= 0 && lastClose < t.length - 1 && !/^```\s*$/.test(t.slice(lastClose + 1).trim())) out.push('prose-after')
  if (/,\s*[}\]]/.test(t)) out.push('trailing-comma')
  if (t.startsWith('[')) out.push('bare-array')
  return out
}

interface Entry {
  id: string
  briefs: string[]
  run: (brief: string, i: number) => Promise<{ ok: boolean; n: number; chars: number; error?: string; detail?: unknown }>
}

let entries: Entry[] = []

beforeAll(async () => {
  if (!MODEL || !existsSync(MODEL)) throw new Error(`EVAL_MODEL must point at a GGUF (got "${MODEL}")`)
  const { initSqlite, openMemoryDatabase } = await import('../../src/web/worker/sqlite')
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
  applySchemaAndMigrations(db as never)
  const { seedWorkspace, DESK, TABLE } = await import('./fixtures')
  await seedWorkspace()
  const router = await import('../../src/main/ai/local/providerRouter')
  const { setModelTagger } = await import('../../src/main/ai/modelRouting')
  const { EngineCore } = await import('../../src/main/ai/local/engineCore')
  const { setLocalClientOptions } = await import('../../src/main/ai/local/localClient')
  setLocalClientOptions({ schemaDecoding: SCHEMA, promptVariants: false, smallGroundingRule: true, groundingCheck: true })
  const core = new EngineCore()
  await core.load({ modelPath: MODEL, contextSize: 16384, kvCache: 'q8_0' })
  router.setLocalRuntime({
    installed: () => true,
    modelLabel: () => 'qwen3-4b',
    engine: async () =>
      ({
        generate: async (...a: Parameters<typeof core.generate>) => {
          const r = await core.generate(...a)
          calls.push({ text: r.text, stop: r.stopReason, outputTokens: r.outputTokens })
          return r
        }
      }) as never
  })
  // Everything on the device; no cloud offer (declined) so failures stay visible.
  router.setRouterSettings({ aiMode: () => 'local', featureRoutes: () => ({}), policy: () => 'local-first', contentWriting: () => 'local' })
  router.setGateResolver(() => ({ gate: 'ok', localPassRate: null, cloudPassRate: null, family: null }))
  router.setConsentAsker(async () => false)
  setModelTagger(router.tagModel)

  const ai = await import('../../src/main/ai/anthropic')
  const { createTable } = await import('../../src/main/db/tables')
  const { createWidget } = await import('../../src/main/db/widgets')
  let tableN = 0
  // A fresh table the way the table work widget provisions one: the Name/Done scaffold.
  const freshTable = (): string => {
    const id = `tbl-fresh-${++tableN}`
    createTable({
      id,
      taskId: DESK,
      title: 'Untitled table',
      schema: {
        columns: [
          { id: `${id}-name`, type: 'text-short', label: 'Name', config: {} },
          { id: `${id}-done`, type: 'checkbox', label: 'Done', config: {} }
        ]
      }
    } as never)
    return id
  }
  entries = [
    {
      id: 'tableRows:fresh',
      briefs: [
        'podcast episodes',
        'contacts for my wedding vendors',
        'my weekly workouts',
        'expenses for a trip to Japan',
        'job applications I have sent',
        'books to read this year',
        'client invoices for October',
        'bugs to fix before launch',
        'recipes to try',
        'what to plant in the vegetable garden and when'
      ],
      run: async (brief) => {
        const r = await ai.suggestTableRows(freshTable(), brief, 0)
        const rows = r.ok ? (r.rows?.length ?? 0) : 0
        return { ok: r.ok && rows > 0, n: rows, chars: JSON.stringify(r.rows ?? []).length, error: r.error, detail: { columnsToAdd: r.columnsToAdd?.map((c) => c.label) } }
      }
    },
    {
      id: 'tableRows:existing',
      briefs: ['add the remaining launch tasks', 'five QA tasks for the release', 'tasks for the marketing push'],
      run: async (brief) => {
        const r = await ai.suggestTableRows(TABLE, brief, 0)
        const rows = r.ok ? (r.rows?.length ?? 0) : 0
        return { ok: r.ok && rows > 0, n: rows, chars: JSON.stringify(r.rows ?? []).length, error: r.error }
      }
    },
    {
      id: 'buildFromPrompt',
      briefs: [
        'A desk for my reading list',
        'Plan a birthday party for 20 people',
        'Track my job search',
        'A content calendar for my bakery’s Instagram',
        'Organise a two-week trip to Japan',
        'Weekly meal planning for a family of four',
        'Onboard a new hire to my design team',
        'A home renovation budget and schedule'
      ],
      run: async (brief) => {
        const r = (await ai.buildFromPrompt({ prompt: brief, taskId: null })) as { ok: boolean; suggestions?: unknown[]; error?: string }
        const n = r.ok ? (r.suggestions?.length ?? 0) : 0
        return { ok: r.ok && n > 0, n, chars: JSON.stringify(r.suggestions ?? []).length, error: r.error }
      }
    },
    {
      id: 'designAgentProfile',
      briefs: ['An agent that triages my inbox every morning', 'Someone to keep my reading notes tidy', 'A researcher for competitor pricing'],
      run: async (brief) => {
        const r = (await ai.designAgentProfile(brief)) as { ok: boolean; name?: string; systemPrompt?: string; error?: string }
        return { ok: r.ok && !!r.name, n: r.ok ? 1 : 0, chars: (r.systemPrompt ?? '').length, error: r.error }
      }
    },
    {
      id: 'widgetSetup:note',
      briefs: ['Plan my week', 'Ideas for the launch party', 'Things to ask the landlord'],
      run: async (brief, i) => {
        const w = createWidget({ taskId: DESK, kind: 'note', title: `note ${i}`, content: '', x: 0, y: 0, w: 4, h: 4 } as never) as { id: string }
        const r = (await ai.suggestWidgetSetup({ widgetId: w.id, prompt: brief })) as { ok: boolean; items?: unknown[]; error?: string }
        const n = r.ok ? (Array.isArray(r.items) ? r.items.length : 1) : 0
        return { ok: r.ok, n, chars: JSON.stringify(r).length, error: r.error }
      }
    },
    {
      id: 'widgetSetup:table',
      briefs: ['Show the launch tasks', 'Point this at the task list'],
      run: async (brief, i) => {
        const w = createWidget({ taskId: DESK, kind: 'table', title: `table ${i}`, content: '', x: 0, y: 0, w: 4, h: 4 } as never) as { id: string }
        const r = (await ai.suggestWidgetSetup({ widgetId: w.id, prompt: brief })) as { ok: boolean; error?: string }
        return { ok: r.ok, n: r.ok ? 1 : 0, chars: JSON.stringify(r).length, error: r.error }
      }
    },
    {
      id: 'workspaceActions',
      briefs: ['What is due this week?', 'What should I do about the budget?', 'Who owns the launch email?'],
      run: async (brief) => {
        const r = await ai.suggestWorkspaceActions(brief, 'The launch checklist is due Friday and the budget sheet has no owner yet.', [{ title: 'Launch', docType: 'doc' }], Date.now())
        return { ok: r.ok, n: r.proposals?.length ?? 0, chars: JSON.stringify(r.proposals ?? []).length, error: r.error }
      }
    },
    {
      id: 'chatProposals',
      briefs: ['Add a task to email the venue tomorrow at 10', 'Make a checklist for the launch', 'Schedule two hours on Friday for the budget'],
      run: async (brief) => {
        const r = (await ai.sendChat({ taskId: DESK, messages: [{ role: 'user', content: brief, ts: Date.now() }] } as never)) as { ok: boolean; proposals?: unknown[]; error?: string; message?: { content: string } }
        return { ok: r.ok && (r.proposals?.length ?? 0) > 0, n: r.proposals?.length ?? 0, chars: (r.message?.content ?? '').length, error: r.error }
      }
    },
    {
      id: 'sheetColumns',
      briefs: ['Track my job applications', 'A household budget', 'Plan a conference'],
      run: async (brief) => {
        const r = (await ai.suggestSheetColumns({ prompt: brief })) as { ok: boolean; columns?: unknown[]; error?: string }
        return { ok: r.ok && (r.columns?.length ?? 0) > 0, n: r.columns?.length ?? 0, chars: JSON.stringify(r.columns ?? []).length, error: r.error }
      }
    },
    {
      id: 'sheetFill',
      briefs: ['The five largest countries by land area', 'The planets of the solar system', 'Six common houseplants and how often to water them'],
      run: async (brief) => {
        const r = (await ai.fillSheetRange({ prompt: brief, headers: ['Name', 'Detail'], rangeRows: 0, auto: true })) as { ok: boolean; rows?: unknown[]; values?: unknown[]; error?: string }
        const n = (r.rows ?? r.values ?? []).length
        return { ok: r.ok && n > 0, n, chars: JSON.stringify(r.rows ?? r.values ?? []).length, error: r.error }
      }
    }
  ].filter((e) => ONLY.length === 0 || ONLY.some((o) => e.id.startsWith(o)))
}, 15 * 60 * 1000)

describe('structured local output', () => {
  it('records shape validity per entry point', async () => {
    const results: Array<Record<string, unknown>> = []
    const save = (): void => {
      mkdirSync(join(__dirname, 'results'), { recursive: true })
      writeFileSync(OUT, JSON.stringify({ label: LABEL, schemaDecoding: SCHEMA, samples: SAMPLES, at: new Date().toISOString(), results }, null, 2))
    }
    for (const e of entries) {
      for (let s = 0; s < SAMPLES; s++) {
        for (const [i, brief] of e.briefs.entries()) {
          calls = []
          const t0 = Date.now()
          let r: Awaited<ReturnType<Entry['run']>>
          try {
            r = await e.run(brief, i * 100 + s)
          } catch (err) {
            r = { ok: false, n: 0, chars: 0, error: `threw: ${(err as Error).message}` }
          }
          results.push({
            entry: e.id,
            brief,
            sample: s + 1,
            ok: r.ok,
            n: r.n,
            chars: r.chars,
            error: r.error ?? null,
            detail: r.detail ?? null,
            engineCalls: calls.length,
            raws: calls.map((c) => ({ stop: c.stop, outputTokens: c.outputTokens, failure: classify(c.text, c.stop), text: c.text.slice(0, 20000) })),
            ms: Date.now() - t0
          })
          // eslint-disable-next-line no-console
          console.log(`[structured ${LABEL}] ${e.id} #${s + 1} "${brief}" ok=${r.ok} n=${r.n} calls=${calls.length} ${r.error ?? ''}`)
          save()
        }
      }
    }
    save()
    expect(results.length).toBeGreaterThan(0)
  })
})
