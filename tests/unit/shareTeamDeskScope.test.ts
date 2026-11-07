// A desk from a TEAM workspace, shared by link, opens on the desk (2026-11-07).
//
// Its rows carry the team's org id. The app lists only the active workspace's
// rows -- a visitor's is 'personal' -- so the owner's live "Lesson Planning"
// link (org_777a…) unpacked in full and then showed the app's Home with no desk
// at all. adoptVisitorScope makes the visitor's browser database theirs.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'

let db: SqliteDb
vi.mock('../../src/main/db/database', () => ({ getDb: () => db, databaseFilePath: () => ':memory:', closeDb: () => {}, nodesKindMigrationStatus: () => null }))
vi.mock('../../src/main/db/fileBlobs', () => ({ fileBlobs: { write: async () => {}, read: async () => null, exists: async () => false, remove: async () => {}, locate: () => '' } }))
vi.mock('../../src/web/worker/database', () => ({ storageMode: () => 'opfs' }))

const NOW = 1_700_000_000_000
const DESK = '70434a35-ce1f-4a76-b171-28389d1bdeb8'
const TEAM = 'org_777a2068e04f4d2c06'

function teamBundle(): unknown {
  return {
    format: 'plexii.desk', formatVersion: 1, exportedAt: new Date(NOW).toISOString(),
    desk: { id: DESK, title: 'Lesson Planning' }, counts: {},
    tables: {
      nodes: [{ id: DESK, parent_id: null, kind: 'task', title: 'Lesson Planning', description: '', status: 'open', priority: 3, interest: 3, importance: 3, sort_order: 0, created_at: NOW, updated_at: NOW, extensions_minutes: 0, org_id: TEAM, team_id: 'team_1' }],
      widgets: [{ id: 'w-1-aaaaaaaaaaaa', task_id: DESK, kind: 'sticky', title: '', content: 'Prep checklist', x: 0, y: 0, width: 200, height: 160, z_index: 1, created_at: NOW, updated_at: NOW }],
      fb_tables: [{ id: 't-1-aaaaaaaaaaaa', task_id: DESK, title: 'Lesson schedule', schema_json: '{"columns":[]}', created_at: NOW, updated_at: NOW, org_id: TEAM }],
      widget_links: [], fb_rows: [], documents: [], fb_files: [], desk_layouts: []
    },
    files: [], filesOmitted: []
  }
}

let shareCopy: typeof import('../../src/web/worker/shareCopy')
let nodes: typeof import('../../src/main/db/nodes')
beforeAll(async () => {
  await initSqlite()
  db = openMemoryDatabase()
  db.pragma('foreign_keys = ON')
  const { applyBrowserSchema } = await import('../../src/web/worker/schemaInit')
  applyBrowserSchema(db)
  shareCopy = await import('../../src/web/worker/shareCopy')
  nodes = await import('../../src/main/db/nodes')
})

describe('a team desk opened by link', () => {
  it('is hidden by the workspace filter as it arrives, and visible once re-homed', async () => {
    const res = await (shareCopy.SHARE_COPY_HANDLERS['shareCopy:importDesk'] as (b: unknown) => Promise<{ ok: boolean }>)(teamBundle())
    expect(res.ok).toBe(true)
    // As it arrives: in the database, out of sight (what the owner hit).
    expect((nodes.listNodes() as Array<{ id: string }>).map((n) => n.id)).not.toContain(DESK)
    const moved = await (shareCopy.SHARE_COPY_HANDLERS['shareCopy:adoptVisitorScope'] as () => Promise<number>)()
    expect(moved).toBe(2) // the desk and its table
    expect((nodes.listNodes() as Array<{ id: string }>).map((n) => n.id)).toContain(DESK)
    const row = db.prepare('SELECT org_id, team_id FROM nodes WHERE id = ?').get(DESK) as { org_id: string; team_id: string | null }
    expect(row).toEqual({ org_id: 'personal', team_id: null })
  })

  it('is idempotent: a second open moves nothing', async () => {
    expect(await (shareCopy.SHARE_COPY_HANDLERS['shareCopy:adoptVisitorScope'] as () => Promise<number>)()).toBe(0)
  })
})
