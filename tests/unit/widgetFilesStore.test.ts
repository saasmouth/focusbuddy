// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memSqlDb } from './_memdb'

// The widget-file store (src/main/db/widgetFiles.ts) driven against a real
// SQLite schema in memory — the parts that are only true if the SQL is right:
// a file is a documents row, filed in Files; its desk instances are widgets in
// the `wf:` sync group; an edit on either side reaches the other; names are
// derived once and never overwrite a user's. See docs/widget-files.md.

let db = memSqlDb()

vi.mock('../../src/main/db/database', () => ({ getDb: () => db }))
vi.mock('../../src/main/db/activeOrg', () => ({ getActiveOrgId: () => 'personal' }))
vi.mock('../../src/main/db/embeddings', () => ({ deleteEmbedding: () => {} }))
vi.mock('../../src/main/db/brandKit', () => ({ getBrandKit: () => null, hasBrandKit: () => false }))
vi.mock('../../src/main/db/fileBlobs', () => ({ fileBlobs: {} }))
vi.mock('../../src/main/db/imageDownsample', () => ({ downsampleImage: async () => null }))
vi.mock('../../src/main/tableEvents', () => ({ notifyRowsChanged: () => {} }))
vi.mock('../../src/main/db/automationEvents', () => ({ emitAutomationEvent: () => {} }))
vi.mock('../../src/main/chunkIndex', () => ({ reindexWidgetChunks: () => {}, reindexDocumentChunks: () => {} }))
vi.mock('../../src/main/documentRetrieval', () => ({ embedDocument: async () => {} }))

const wf = await import('../../src/main/db/widgetFiles')
const widgets = await import('../../src/main/db/widgets')
const tables = await import('../../src/main/db/tables')
const files = await import('../../src/main/db/files')

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
      living_query TEXT, living_generated_at INTEGER, living_paused INTEGER DEFAULT 0, sync_group_id TEXT
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
    INSERT INTO nodes (id, title, org_id) VALUES ('deskA', 'Desk A', 'personal'), ('deskB', 'Desk B', 'personal');
  `)
}

beforeEach(() => {
  db = memSqlDb()
  schema()
})

describe('a widget file is a document, filed in Files', () => {
  it('creates a documents row of type widget, with its kind and content in the body', () => {
    const f = wf.createWidgetFile({ kind: 'sticky', content: 'Pick up the keys' })
    const row = db.prepare('SELECT doc_type, title, body FROM documents WHERE id = ?').get(f.id) as {
      doc_type: string
      title: string
      body: string
    }
    expect(row.doc_type).toBe('widget')
    const body = JSON.parse(row.body)
    expect(body).toMatchObject({ v: 1, kind: 'sticky', content: 'Pick up the keys', titleSource: 'derived' })
    expect(row.title).toBe('Pick up the keys')
  })

  it('is listed in Files at the root with its widget kind', () => {
    const f = wf.createWidgetFile({ kind: 'table' })
    const root = files.listEntries(null)
    const entry = root.find((e) => e.docId === f.id)
    expect(entry).toBeTruthy()
    expect(entry!.docType).toBe('widget')
    expect(entry!.widgetKind).toBe('table')
  })

  it('a file that arrived unfiled (synced from another device) is filed by the root listing', () => {
    const f = wf.createWidgetFile({ kind: 'note', content: 'x' })
    db.prepare("DELETE FROM fb_files WHERE doc_id = ?").run(f.id)
    expect(files.listEntries(null).some((e) => e.docId === f.id)).toBe(true)
  })

  it('refuses a desk-only kind', () => {
    expect(() => wf.createWidgetFile({ kind: 'section' })).toThrow(/only works on a desk/)
  })
})

describe('naming: never Untitled, derived once, never over a user name', () => {
  it('an empty file gets a dated placeholder, marked as such', () => {
    const f = wf.createWidgetFile({ kind: 'mindmap' })
    expect(f.title).toMatch(/^Mind map · /)
    expect(f.titleSource).toBe('placeholder')
  })

  it('the first content worth naming it from replaces the placeholder', () => {
    const f = wf.createWidgetFile({ kind: 'sticky' })
    const after = wf.updateWidgetFile(f.id, { content: '# Offsite plan\nvenue' })!
    expect(after.title).toBe('Offsite plan')
    expect(after.titleSource).toBe('derived')
    // …and is then left alone.
    const later = wf.updateWidgetFile(f.id, { content: '# Something else entirely' })!
    expect(later.title).toBe('Offsite plan')
  })

  it('a rename is the user’s, and the naming pass cannot touch it', () => {
    const f = wf.createWidgetFile({ kind: 'sticky' })
    wf.updateWidgetFile(f.id, { title: 'My keys' })
    expect(wf.getWidgetFile(f.id)!.titleSource).toBe('user')
    expect(wf.setWidgetFileTitle(f.id, 'Model name', 'model')).toBe(false)
    expect(wf.getWidgetFile(f.id)!.title).toBe('My keys')
  })

  it('a table file names itself from its first column and row count as rows arrive', () => {
    const t = tables.createTable({ taskId: null, title: '', schema: { columns: [{ id: 'c1', label: 'Supplier', type: 'text-short' }] } as never })
    const f = wf.createWidgetFile({ kind: 'table', content: t.id })
    // Empty: nothing to name it after yet, so the dated placeholder.
    expect(f.title).toMatch(/^Table · /)
    expect(f.titleSource).toBe('placeholder')
    tables.createRow({ tableId: t.id, cells: { c1: 'Acme' } })
    tables.createRow({ tableId: t.id, cells: { c1: 'Globex' } })
    wf.refreshTableFiles(t.id)
    expect(wf.getWidgetFile(f.id)!.title).toBe('Supplier · 2 rows')
    // The count follows the rows while the name is ours…
    tables.createRow({ tableId: t.id, cells: { c1: 'Initech' } })
    wf.refreshTableFiles(t.id)
    expect(wf.getWidgetFile(f.id)!.title).toBe('Supplier · 3 rows')
    // …and stops the moment the user names it.
    wf.updateWidgetFile(f.id, { title: 'Suppliers we trust' })
    tables.createRow({ tableId: t.id, cells: { c1: 'Hooli' } })
    wf.refreshTableFiles(t.id)
    expect(wf.getWidgetFile(f.id)!.title).toBe('Suppliers we trust')
  })
})

describe('linked instances: one file, edits flow both ways', () => {
  it('places a linked instance on a desk in the file’s sync group', () => {
    const f = wf.createWidgetFile({ kind: 'sticky', content: 'Shared' })
    const w = wf.placeWidgetFile(f.id, { taskId: 'deskA' })!
    expect(w.syncGroupId).toBe(`wf:${f.id}`)
    expect(w.content).toBe('Shared')
    expect(w.title).toBe(f.title)
  })

  it('an edit on one desk reaches the file and the other desk', () => {
    const f = wf.createWidgetFile({ kind: 'sticky', content: 'Shared' })
    const a = wf.placeWidgetFile(f.id, { taskId: 'deskA' })!
    const b = wf.placeWidgetFile(f.id, { taskId: 'deskB' })!
    widgets.updateWidget(a.id, { content: 'Shared\n- milk' })
    expect(widgets.getWidget(b.id)!.content).toBe('Shared\n- milk')
    expect(wf.getWidgetFile(f.id)!.content).toBe('Shared\n- milk')
  })

  it('an edit to the file reaches every instance', () => {
    const f = wf.createWidgetFile({ kind: 'sticky', content: 'Shared' })
    const a = wf.placeWidgetFile(f.id, { taskId: 'deskA' })!
    const b = wf.placeWidgetFile(f.id, { taskId: 'deskB' })!
    wf.updateWidgetFile(f.id, { content: 'From the file', color: '#a7f3d0' })
    for (const id of [a.id, b.id]) {
      expect(widgets.getWidget(id)!.content).toBe('From the file')
      expect(widgets.getWidget(id)!.color).toBe('#a7f3d0')
    }
  })

  it('a title the file derives from an instance edit reaches every instance, the editing one included', () => {
    const f = wf.createWidgetFile({ kind: 'sticky' })
    const a = wf.placeWidgetFile(f.id, { taskId: 'deskA' })!
    const b = wf.placeWidgetFile(f.id, { taskId: 'deskB' })!
    widgets.updateWidget(a.id, { content: 'Budget review notes' })
    expect(wf.getWidgetFile(f.id)!.title).toBe('Budget review notes')
    expect(widgets.getWidget(a.id)!.title).toBe('Budget review notes')
    expect(widgets.getWidget(b.id)!.title).toBe('Budget review notes')
  })

  it('a desk-only kind stays a plain desk row', () => {
    const w = widgets.createWidget({ taskId: 'deskA', kind: 'section', content: '' })
    widgets.updateWidget(w.id, { content: '{}' })
    expect(w.syncGroupId).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 0 })
  })

  it('"Save as file" promotes a legacy desk widget, and its synced copies come along', () => {
    // Rows from before the rule: inserted with their own ids, as a replay is,
    // so createWidget leaves them plain.
    const w1 = widgets.createWidget({ id: 'legacy-1', taskId: 'deskA', kind: 'note', content: 'Thursday notes', syncGroupId: 'g1' })
    const w2 = widgets.createWidget({ id: 'legacy-2', taskId: 'deskB', kind: 'note', content: 'Thursday notes', syncGroupId: 'g1' })
    expect(w1.syncGroupId).toBe('g1')
    const f = wf.promoteWidgetToFile(w1.id)!
    expect(f.kind).toBe('note')
    expect(widgets.getWidget(w1.id)!.syncGroupId).toBe(`wf:${f.id}`)
    expect(widgets.getWidget(w2.id)!.syncGroupId).toBe(`wf:${f.id}`)
    // Idempotent.
    expect(wf.promoteWidgetToFile(w1.id)!.id).toBe(f.id)
  })
})

describe('export / import', () => {
  it('a table travels with its rows and comes back as a new, independent file', () => {
    const t = tables.createTable({ taskId: null, title: 'Quotes', schema: { columns: [{ id: 'c1', label: 'Supplier', type: 'text-short' }] } as never })
    tables.createRow({ tableId: t.id, cells: { c1: 'Acme' } })
    const f = wf.createWidgetFile({ kind: 'table', content: t.id, title: 'Quotes' })
    const env = wf.exportWidgetFile(f.id)!
    expect(env.type).toBe('plexii.widget.table')
    expect(env.table?.rows).toEqual([{ c1: 'Acme' }])
    const back = wf.importWidgetFile(env)
    expect(back.id).not.toBe(f.id)
    expect(back.content).not.toBe(t.id)
    expect(tables.listRows(back.content).map((r) => r.cells)).toEqual([{ c1: 'Acme' }])
  })
})
