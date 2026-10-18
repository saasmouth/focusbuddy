// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memSqlDb } from './_memdb'

// Loose ends of "every work widget is a file" (4.3.32, docs/widget-files.md),
// against a real SQLite schema in memory (a fixture database, never a live
// profile):
//
//   - the task-list rule: placed onto a desk from any entry point it is that
//     desk's tasks; made with no desk it keeps its own list; placing an
//     own-list file keeps its own list;
//   - Files' "On <desk>" line: which desks each file sits on, in one query.

let db = memSqlDb()
let activeOrg = 'personal'

vi.mock('../../src/main/db/database', () => ({ getDb: () => db }))
vi.mock('../../src/main/db/activeOrg', () => ({ getActiveOrgId: () => activeOrg, PERSONAL_ORG_ID: 'personal' }))
vi.mock('../../src/main/db/embeddings', () => ({ deleteEmbedding: () => {} }))
vi.mock('../../src/main/db/brandKit', () => ({ getBrandKit: () => null, hasBrandKit: () => false }))
vi.mock('../../src/main/db/fileBlobs', () => ({ fileBlobs: {} }))
vi.mock('../../src/main/db/imageDownsample', () => ({ downsampleImage: async () => null }))
vi.mock('../../src/main/tableEvents', () => ({ notifyRowsChanged: () => {} }))
vi.mock('../../src/main/db/automationEvents', () => ({ emitAutomationEvent: () => {} }))
vi.mock('../../src/main/chunkIndex', () => ({ reindexWidgetChunks: () => {}, reindexDocumentChunks: () => {} }))
vi.mock('../../src/main/documentRetrieval', () => ({
  embedDocument: async () => {},
  reindexDocuments: async () => ({ embedded: 0 })
}))

const wf = await import('../../src/main/db/widgetFiles')
const widgets = await import('../../src/main/db/widgets')
const documents = await import('../../src/main/db/documents')
const tables = await import('../../src/main/db/tables')
const files = await import('../../src/main/db/files')
const snapshots = await import('../../src/main/db/canvasSnapshots')
const shared = await import('../../src/shared/widgetFiles')

function schema(): void {
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, title TEXT, org_id TEXT, shared_root_id TEXT, shared_from_handle TEXT, trashed_at INTEGER
    );
    CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, doc_type TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '{}',
      archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      org_id TEXT, trashed_at INTEGER
    );
    CREATE TABLE widgets (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES nodes(id), kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '', x INTEGER DEFAULT 50, y INTEGER DEFAULT 50, width INTEGER DEFAULT 320,
      height INTEGER DEFAULT 240, z_index INTEGER DEFAULT 1, color TEXT, created_at INTEGER, updated_at INTEGER,
      trashed_at INTEGER, status TEXT, pinned INTEGER DEFAULT 0, pinned_screen_x INTEGER, pinned_screen_y INTEGER,
      parent_section_id TEXT, layout TEXT, archived INTEGER DEFAULT 0, source_app_id TEXT, mode TEXT, pinned_zone TEXT,
      living_query TEXT, living_generated_at INTEGER, living_paused INTEGER DEFAULT 0, sync_group_id TEXT,
      shared_root_id TEXT
    );
    CREATE TABLE fb_files (
      id TEXT PRIMARY KEY, original_name TEXT, mime_type TEXT, size_bytes INTEGER, ext TEXT, created_at INTEGER,
      parent_id TEXT, kind TEXT, display_name TEXT, updated_at INTEGER, doc_id TEXT, doc_type TEXT, sort_order INTEGER,
      trashed_at INTEGER, org_id TEXT, stored_path TEXT
    );
    CREATE TABLE fb_tables (
      id TEXT PRIMARY KEY, task_id TEXT, title TEXT NOT NULL DEFAULT 'Untitled',
      schema_json TEXT NOT NULL DEFAULT '{"columns":[]}', created_at INTEGER, updated_at INTEGER, org_id TEXT, trashed_at INTEGER
    );
    CREATE TABLE fb_rows (
      id TEXT PRIMARY KEY, table_id TEXT NOT NULL, cells_json TEXT NOT NULL DEFAULT '{}', sort_order INTEGER DEFAULT 0,
      created_at INTEGER, updated_at INTEGER, trashed_at INTEGER
    );
    CREATE TABLE canvas_snapshots (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, at INTEGER NOT NULL, label TEXT NOT NULL DEFAULT '',
      widget_count INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL
    );
    INSERT INTO nodes (id, title, org_id) VALUES ('deskA', 'Desk A', 'personal'), ('deskB', 'Desk B', 'personal'),
      ('deskC', 'Desk C', 'personal');
  `)
}

beforeEach(() => {
  db = memSqlDb()
  activeOrg = 'personal'
  schema()
})


const taskListLens = JSON.stringify({ scope: 'desk', filter: 'open' })
const scopeOf = (content: string): string | undefined => (JSON.parse(content) as { scope?: string }).scope

describe('task lists: one rule for every entry point', () => {
  it('placed onto a desk as it is made (side-menu drag, Add to this desk, palette) it is the desk\'s tasks', () => {
    const { file, widget } = wf.createAndPlaceWidgetFile({ kind: 'task-list' }, { taskId: 'deskA', x: 10, y: 10 }, { defaultContent: taskListLens })
    expect(scopeOf(file.content)).toBe('desk')
    expect(widget).not.toBeNull()
    expect(scopeOf(widget!.content)).toBe('desk')
    // Still a file with an instance, like every work widget.
    expect(widget!.syncGroupId).toBe(shared.widgetFileGroupId(file.id))
  })

  it('added from the canvas (createWidget) is the desk\'s tasks too, as a file', () => {
    const w = widgets.createWidget({ taskId: 'deskA', kind: 'task-list', title: '', content: taskListLens, x: 0, y: 0 })
    const fileId = shared.widgetFileIdFromGroup(widgets.getWidget(w.id)!.syncGroupId)
    expect(fileId).toBeTruthy()
    expect(scopeOf(wf.getWidgetFile(fileId!)!.content)).toBe('desk')
  })

  it('made with no desk (a side-menu click, New … work widget) keeps a list of its own', () => {
    const file = wf.createWidgetFile({ kind: 'task-list' }, { defaultContent: taskListLens })
    expect(scopeOf(file.content)).toBe('own')
  })

  it('an own-list file placed onto a desk keeps its own list on every desk', () => {
    const file = wf.createWidgetFile({ kind: 'task-list' }, { defaultContent: taskListLens })
    const a = wf.placeWidgetFile(file.id, { taskId: 'deskA' })!
    const b = wf.placeWidgetFile(file.id, { taskId: 'deskB' })!
    expect(scopeOf(a.content)).toBe('own')
    expect(scopeOf(b.content)).toBe('own')
  })

  it('content given by the caller wins over either default (the assistant\'s items, an import)', () => {
    const own = shared.taskListContent([{ title: 'Call Sam' }])
    const { file } = wf.createAndPlaceWidgetFile({ kind: 'task-list', content: own }, { taskId: 'deskA' }, { defaultContent: taskListLens })
    expect(scopeOf(file.content)).toBe('own')
  })

  it('only the task list differs; every other kind starts from the desk default either way', () => {
    expect(shared.defaultWidgetFileContent('sticky', 'x', 'desk')).toBe('x')
    expect(shared.defaultWidgetFileContent('sticky', 'x', 'none')).toBe('x')
    expect(shared.defaultWidgetFileContent('task-list', taskListLens, 'desk')).toBe(taskListLens)
    expect(scopeOf(shared.defaultWidgetFileContent('task-list', taskListLens))).toBe('own')
  })
})

describe('Files: which desks each work widget file sits on', () => {
  it('lists every live desk once, sorted by name, in one call for many files', () => {
    const f1 = wf.createWidgetFile({ kind: 'sticky', title: 'One' })
    const f2 = wf.createWidgetFile({ kind: 'note', title: 'Two' })
    const f3 = wf.createWidgetFile({ kind: 'sticky', title: 'Three' })
    wf.placeWidgetFile(f1.id, { taskId: 'deskB' })
    wf.placeWidgetFile(f1.id, { taskId: 'deskA' })
    wf.placeWidgetFile(f1.id, { taskId: 'deskA' }) // two copies on one desk count once
    wf.placeWidgetFile(f2.id, { taskId: 'deskC' })
    const m = wf.listWidgetFilePlacements([f1.id, f2.id, f3.id])
    expect(m[f1.id].map((d) => d.deskTitle)).toEqual(['Desk A', 'Desk B'])
    expect(m[f2.id]).toEqual([{ deskId: 'deskC', deskTitle: 'Desk C' }])
    expect(m[f3.id]).toEqual([])
  })

  it('leaves out a copy removed from its desk and a desk in Trash', () => {
    const f = wf.createWidgetFile({ kind: 'sticky', title: 'Gone' })
    const a = wf.placeWidgetFile(f.id, { taskId: 'deskA' })!
    wf.placeWidgetFile(f.id, { taskId: 'deskB' })
    widgets.deleteWidget(a.id) // "Remove from this desk"
    db.prepare("UPDATE nodes SET trashed_at = 1 WHERE id = 'deskB'").run()
    expect(wf.listWidgetFilePlacements([f.id])[f.id]).toEqual([])
  })

  it('an empty or junk request is an empty answer, not an error', () => {
    expect(wf.listWidgetFilePlacements([])).toEqual({})
    expect(wf.listWidgetFilePlacements(['nope'])).toEqual({ nope: [] })
  })
})
