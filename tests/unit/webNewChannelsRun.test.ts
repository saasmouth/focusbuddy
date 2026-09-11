// The channels added to the browser runtime are not merely wired -- they run.
//
// Wiring a channel proves only that a name maps to a function. It does not
// prove the function works here, and the difference has bitten this project
// before: the browser database was first built from SCHEMA alone, so every
// column added by a later migration was missing, and handlers that looked
// correctly wired failed the moment they touched one.
//
// So this calls each newly served channel against a real browser database --
// SQLite-WASM, migrated the same way the Worker migrates it -- and asserts the
// call returns rather than throwing. A namespace whose tables or columns did
// not survive into this runtime fails here instead of in front of a user.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'
import { INVOKE_CHANNELS } from '../../src/web/api/channelMap.generated'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

let db: SqliteDb

vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
vi.mock('../../src/main/db/account', () => ({
  accountEmail: () => 'channels@test.local',
  loadAccountState: () => ({ sessionToken: null, skippedAt: null, cachedEmail: null }),
  markUiVisible: () => {}
}))

let HANDLERS: Record<string, (...a: never[]) => unknown>

beforeAll(async () => {
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  // The Worker's own init, not a re-creation of it: if openWorkspaceDatabase
  // ever stops building a table these channels need, this test is what notices.
  const { applyBrowserSchema } = await import('../../src/web/worker/schemaInit')
  applyBrowserSchema(db)
  ;({ HANDLERS } = (await import('../../src/web/worker/handlers')) as never)
})

/**
 * A read-only call per newly served namespace, with arguments the desktop would
 * send. Reads are used deliberately: they touch the same tables and columns a
 * write would, but leave nothing behind to order the tests against each other.
 */
const READS: ReadonlyArray<[string, unknown[]]> = [
  ['aiChat:listConversations', []],
  ['apps:list', []],
  ['dashboard:getLayout', ['home']],
  ['energy:current', []],
  ['energy:recent', [24]],
  ['focus:recent', [10]],
  ['knowledge:list', []],
  ['memory:list', []],
  ['projects:list', []],
  ['signals:list', [0]],
  ['people:setDirectory', [[]]],
  ['onboarding:record', [{ coreCompleted: true, modulesCompleted: 2 }]],
  ['timeblocks:list', [0, Date.now() + 86_400_000]]
]

describe('the channels the browser runtime newly serves', () => {
  it.each(READS)('%s runs against a migrated browser database', async (channel, args) => {
    const fn = HANDLERS[channel]
    expect(fn, `${channel} is not served`).toBeTypeOf('function')
    await expect(
      (async () => fn(...(args as never[])))()
    ).resolves.not.toThrow()
  })

  it('writes and reads back, so the tables are real and not just present', async () => {
    const created = (await HANDLERS['apps:create'](
      { name: 'Test App', url: 'https://example.invalid' } as never
    )) as { id?: string } | null
    expect(created?.id, 'apps:create returned no row').toBeTruthy()
    const listed = (await HANDLERS['apps:list']()) as Array<{ id: string }>
    expect(listed.map((a) => a.id)).toContain(created!.id)
  })

  it('creates an AI chat conversation, the entry point to the rest of aiChat', async () => {
    const convo = (await HANDLERS['aiChat:createConversation']({ taskId: null, title: 'Cloud' } as never)) as
      | { id?: string }
      | null
    expect(convo?.id).toBeTruthy()
    const list = (await HANDLERS['aiChat:listConversations']()) as Array<{ id: string }>
    expect(list.map((c) => c.id)).toContain(convo!.id)
  })

  it('records onboarding progress durably, so it does not reappear on reload', async () => {
    await HANDLERS['onboarding:record']({ coreCompleted: true, modulesCompleted: 3 } as never)
    const row = db
      .prepare("SELECT value FROM usage_counters WHERE key = 'onboarding_modules'")
      .get() as { value: number } | undefined
    expect(row?.value).toBe(3)
  })

  it('serves no channel that reaches a local model or a third-party API', () => {
    // knowledge:search, knowledge:reindex, knowledge:semanticActive and
    // memory:extractDocuments all route through ai/embeddings or ai/localModel,
    // which try http://localhost:11434 and then api.openai.com directly. From a
    // browser the first is the VIEWER's machine and the second needs a key the
    // browser must never hold, so they are deliberately not served.
    for (const channel of [
      'knowledge:search',
      'knowledge:reindex',
      'knowledge:semanticActive',
      'memory:extractDocuments'
    ]) {
      expect(HANDLERS[channel], `${channel} must not be served here`).toBeUndefined()
    }
  })

  // A namespace served in part is worse than one not served at all: the feature
  // appears to work and fails at whichever button reaches the missing call.
  // timeblocks shipped that way for a moment here -- create, update and delete
  // were served while `list`, the one the calendar opens with, was not, because
  // it was the only one written as a block body.
  //
  // So each namespace is all-or-declared: every channel is served, or it is
  // named below with the reason it cannot be.
  describe('namespace completeness', () => {
    const DELIBERATELY_UNSERVED: Readonly<Record<string, string>> = {
      // ai/embeddings and ai/localModel: these try http://localhost:11434 --
      // from a tab that is the VIEWER's machine -- and then api.openai.com with
      // a key the browser must never hold. Knowledge entries still save and
      // sync; the desktop's knowledge:reindex backfills their vectors.
      'knowledge:search': 'embeds through a local model or OpenAI directly',
      'knowledge:reindex': 'embeds through a local model or OpenAI directly',
      'knowledge:semanticActive': 'probes the local model endpoint',
      'memory:extractDocuments': 'summarises through the local model',
      // Opens a native save dialog through BrowserWindow.
      'projects:exportXml': 'needs a native save dialog'
    }

    const SERVED_NAMESPACES = [
      'aiChat', 'apps', 'dashboard', 'energy', 'focus', 'knowledge', 'memory',
      'projects', 'timeblocks', 'signals', 'notifications', 'people', 'onboarding'
    ]

    it.each(SERVED_NAMESPACES)('%s serves every channel it does not explain', (ns) => {
      const all = [...new Set(Object.values(INVOKE_CHANNELS) as string[])].filter(
        (c) => c.split(':')[0] === ns
      )
      expect(all.length, `${ns} has no channels -- renamed?`).toBeGreaterThan(0)
      const unexplained = all.filter((c) => !(c in HANDLERS) && !(c in DELIBERATELY_UNSERVED))
      expect(unexplained).toEqual([])
    })

    it('explains nothing it actually serves, and nothing that no longer exists', () => {
      const real = new Set(Object.values(INVOKE_CHANNELS) as string[])
      for (const channel of Object.keys(DELIBERATELY_UNSERVED)) {
        expect(real.has(channel), `${channel} is not a real channel any more`).toBe(true)
        expect(HANDLERS[channel], `${channel} is served -- drop its excuse`).toBeUndefined()
      }
    })
  })

  // The ✅ rows in docs/DESKTOP-VS-CLOUD.md are a claim about components, not
  // about channels: a feature works in the cloud only if everything its
  // component calls is served. Checking this caught a wrong row while the page
  // was being written -- "AI chat threads" was marked ✅ because aiChat:* is
  // served, but the assistant sends through chat:sendStream, which is not.
  describe('features the comparison page marks as working', () => {
    const FEATURES: ReadonlyArray<[string, string[]]> = [
      ['Focus sessions, energy log, habit garden', [
        'stores/focusSession.ts', 'stores/energy.ts', 'components/HabitGarden.tsx'
      ]],
      ['Time blocks / calendar', ['stores/timeBlocks.ts']],
      ['Dashboard layouts', ['stores/dashboardLayouts.ts']],
      ['Connected apps', ['stores/apps.ts']],
      ['Signals', ['stores/completionOffer.ts']]
    ]

    it.each(FEATURES)('%s calls nothing the browser does not serve', (_label, files) => {
      const byPath = INVOKE_CHANNELS as unknown as Record<string, string>
      const unserved = new Set<string>()
      for (const rel of files) {
        const full = resolve(__dirname, '../../src/renderer/src', rel)
        expect(existsSync(full), `${rel} has moved -- update this test`).toBe(true)
        for (const m of readFileSync(full, 'utf8').matchAll(/api\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g)) {
          const channel = byPath[`${m[1]}.${m[2]}`]
          if (channel && !(channel in HANDLERS)) unserved.add(channel)
        }
      }
      expect([...unserved]).toEqual([])
    })
  })
})
