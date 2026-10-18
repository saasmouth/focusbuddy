// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { memSqlDb } from './_memdb'

// "Every work widget is a file" (4.3.32, docs/widget-files.md): the owner's rule
// that a work widget is a file in its own right and a desk only where it is
// placed. Driven against a real SQLite schema in memory — a fixture database,
// never a live profile — so the SQL is what is tested:
//
//   - central enforcement in db/widgets.createWidget, and what it leaves alone;
//   - linked duplicates (ordinary sync groups) becoming ONE file;
//   - the launch backfill: deterministic ids, idempotent, the same on two devices;
//   - remove-from-desk versus delete, and restore putting instances back;
//   - the table-name bug (a placeholder copied onto the backing table).

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

const docCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM documents WHERE doc_type = 'widget'").get() as { n: number }).n
const fileOf = (widgetId: string): string | null => shared.widgetFileIdFromGroup(widgets.getWidget(widgetId)!.syncGroupId)

/** A row as it was before the rule: written straight to the table, like an old profile. */
function legacy(
  id: string,
  task: string,
  kind: string,
  content: string,
  extra: { title?: string; group?: string | null; createdAt?: number; trashed?: boolean } = {}
): void {
  db.prepare(
    `INSERT INTO widgets (id, task_id, kind, title, content, created_at, updated_at, sync_group_id, trashed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    task,
    kind,
    extra.title ?? '',
    content,
    extra.createdAt ?? 1_700_000_000_000,
    extra.createdAt ?? 1_700_000_000_000,
    extra.group ?? null,
    extra.trashed ? 1_700_000_500_000 : null
  )
}

describe('central enforcement: every new standalone work widget is a file', () => {
  it('a canvas "Add object" style create becomes an instance of a new file, filed in Files', () => {
    const w = widgets.createWidget({ taskId: 'deskA', kind: 'task-list', content: '' })
    const fileId = fileOf(w.id)
    expect(fileId).toBe(wf.widgetFileIdForWidget(w.id))
    const file = wf.getWidgetFile(fileId!)!
    expect(file.kind).toBe('task-list')
    expect(files.listEntries(null).some((e) => e.docId === fileId)).toBe(true)
    // One file, one instance: exactly what the side menu makes.
    expect(wf.listWidgetFileInstances(fileId!).map((i) => i.id)).toEqual([w.id])
  })

  it('names the file from what it holds, and a new instance shows the file’s name like a side-menu one', () => {
    const named = widgets.createWidget({ taskId: 'deskA', kind: 'sticky', content: '# Offsite plan\nvenue' })
    expect(wf.getWidgetFile(fileOf(named.id)!)!.title).toBe('Offsite plan')
    expect(named.title).toBe('Offsite plan')
    const empty = widgets.createWidget({ taskId: 'deskA', kind: 'mindmap', content: '' })
    const f = wf.getWidgetFile(fileOf(empty.id)!)!
    expect(f.titleSource).toBe('placeholder')
    expect(f.title).toMatch(/^Mind map · /)
    expect(empty.title).toBe(f.title)
  })

  it('keeps a real title as the user’s, but not the kind’s own label a menu stamps on', () => {
    const titled = widgets.createWidget({ taskId: 'deskA', kind: 'note', title: 'Board prep', content: 'x' })
    expect(wf.getWidgetFile(fileOf(titled.id)!)!).toMatchObject({ title: 'Board prep', titleSource: 'user' })
    const stamped = widgets.createWidget({ taskId: 'deskA', kind: 'table', title: 'Table', content: '' })
    expect(wf.getWidgetFile(fileOf(stamped.id)!)!.titleSource).toBe('placeholder')
  })

  it('a task list added from the canvas menu is a file with an instance too, and keeps its desk lens', () => {
    const lensDefault = JSON.stringify({ scope: 'desk', filter: 'open' }) // the catalogue's desk default
    const fromCanvas = widgets.createWidget({ taskId: 'deskA', kind: 'task-list', content: lensDefault })
    const file = wf.getWidgetFile(fileOf(fromCanvas.id)!)!
    expect(file.kind).toBe('task-list')
    expect(wf.listWidgetFileInstances(file.id).map((i) => i.id)).toEqual([fromCanvas.id])
    // Still the desk's own tasks (the catalogue's "This desk's own tasks"), not emptied into a private list.
    expect(file.content).toBe(lensDefault)
    expect(widgets.getWidget(fromCanvas.id)!.content).toBe(lensDefault)
  })

  it('leaves desk-only kinds as plain desk rows', () => {
    for (const kind of ['section', 'portal', 'agent', 'minimap'] as const) {
      const w = widgets.createWidget({ taskId: 'deskA', kind, content: '' })
      expect(w.syncGroupId, kind).toBeNull()
    }
    expect(docCount()).toBe(0)
  })

  it('never files a replayed create (sync, restore): it carries its own id', () => {
    const w = widgets.createWidget({ id: 'from-other-device', taskId: 'deskA', kind: 'sticky', content: 'hi' })
    expect(w.syncGroupId).toBeNull()
    expect(docCount()).toBe(0)
  })

  it('never files a widget on a desk outside the user’s own workspace', () => {
    db.exec(`INSERT INTO nodes (id, title, org_id, shared_root_id) VALUES ('liveShared', 'Live', 'personal', 'liveShared');
             INSERT INTO nodes (id, title, org_id, shared_from_handle) VALUES ('fromSam', 'Sam''s', 'personal', 'sam')`)
    const a = widgets.createWidget({ taskId: 'liveShared', kind: 'sticky', content: 'a' })
    const b = widgets.createWidget({ taskId: 'fromSam', kind: 'sticky', content: 'b' })
    expect(a.syncGroupId).toBeNull()
    expect(b.syncGroupId).toBeNull()
    expect(docCount()).toBe(0)
  })

  it('placing an existing file adds an instance, never a second file', () => {
    const f = wf.createWidgetFile({ kind: 'sticky', content: 'Shared' })
    wf.placeWidgetFile(f.id, { taskId: 'deskA' })
    wf.placeWidgetFile(f.id, { taskId: 'deskB' })
    expect(docCount()).toBe(1)
    expect(wf.listWidgetFileInstances(f.id)).toHaveLength(2)
  })

  it('an independent duplicate is a new file; a linked duplicate is another instance of the same one', () => {
    const src = widgets.createWidget({ taskId: 'deskA', kind: 'note', content: 'Draft' })
    const independent = widgets.createWidget({ taskId: 'deskA', kind: 'note', content: 'Draft' })
    expect(fileOf(independent.id)).not.toBe(fileOf(src.id))
    const linked = widgets.createWidget({ taskId: 'deskB', kind: 'note', content: 'Draft', syncGroupId: src.syncGroupId })
    expect(fileOf(linked.id)).toBe(fileOf(src.id))
    expect(docCount()).toBe(2)
  })

  it('a widget restored from the desk trash that never became a file becomes one', () => {
    legacy('old', 'deskA', 'sticky', 'came back', { trashed: true })
    widgets.restoreWidget('old')
    expect(fileOf('old')).toBe(wf.widgetFileIdForWidget('old'))
  })
})

describe('linked duplicates: an ordinary sync group becomes ONE file shared by every member', () => {
  it('converts the whole group when a new member is added to it', () => {
    legacy('g-a', 'deskA', 'card', '{"title":"Pitch","body":""}', { group: 'g1' })
    legacy('g-b', 'deskB', 'card', '{"title":"Pitch","body":""}', { group: 'g1' })
    const c = widgets.createWidget({ taskId: 'deskC', kind: 'card', content: '{"title":"Pitch","body":""}', syncGroupId: 'g1' })
    const fileId = wf.widgetFileIdForGroup('g1')
    for (const id of ['g-a', 'g-b', c.id]) expect(fileOf(id), id).toBe(fileId)
    expect(docCount()).toBe(1)
    expect(wf.getWidgetFile(fileId)!.title).toBe('Pitch')
    // …and an edit on one member still reaches the others and the file.
    widgets.updateWidget('g-a', { content: '{"title":"Pitch v2","body":""}' })
    expect(widgets.getWidget('g-b')!.content).toContain('Pitch v2')
    expect(wf.getWidgetFile(fileId)!.content).toContain('Pitch v2')
  })
})

describe('launch backfill', () => {
  /** The same synced workspace as two devices would each hold it. */
  function fixture(): void {
    db.exec(`INSERT INTO nodes (id, title, org_id) VALUES ('deskOrg', 'Acme desk', 'acme');
             INSERT INTO nodes (id, title, org_id, trashed_at) VALUES ('deskGone', 'Binned', 'personal', 1);
             INSERT INTO nodes (id, title, org_id, shared_root_id) VALUES ('deskShared', 'Shared', 'personal', 'deskShared')`)
    legacy('lone-sticky', 'deskA', 'sticky', 'Pick up keys', { createdAt: 1_700_000_000_000 })
    legacy('lone-named', 'deskA', 'note', 'body', { title: 'Board prep' })
    legacy('lone-empty', 'deskA', 'mindmap', '', { createdAt: 1_700_000_000_000 })
    legacy('pair-1', 'deskA', 'note', 'Thursday', { group: 'grp' })
    legacy('pair-2', 'deskB', 'note', 'Thursday', { group: 'grp' })
    legacy('trashed', 'deskA', 'sticky', 'gone', { trashed: true })
    legacy('desk-only', 'deskA', 'section', '')
    legacy('on-binned-desk', 'deskGone', 'sticky', 'x')
    legacy('on-shared-desk', 'deskShared', 'sticky', 'x')
    legacy('in-other-org', 'deskOrg', 'sticky', 'Acme note')
    // Already an instance of a file this device has not received yet.
    legacy('awaiting-file', 'deskB', 'sticky', 'y', { group: 'wf:not-arrived-yet' })
  }

  const state = (): { docs: Array<{ id: string; title: string; org_id: string }>; groups: Record<string, string | null> } => ({
    docs: db
      .prepare("SELECT id, title, org_id FROM documents WHERE doc_type = 'widget' ORDER BY id")
      .all() as Array<{ id: string; title: string; org_id: string }>,
    groups: Object.fromEntries(
      (db.prepare('SELECT id, sync_group_id FROM widgets ORDER BY id').all() as Array<{ id: string; sync_group_id: string | null }>).map(
        (r) => [r.id, r.sync_group_id]
      )
    )
  })

  it('files every eligible desk widget, under ids derived from the widget or its group', async () => {
    fixture()
    const s = await wf.runWidgetFileBackfill()
    expect(s.orgs.sort()).toEqual(['acme', 'personal'])
    expect(s.widgets).toBe(6) // 3 lone + 2 group members + 1 in acme
    expect(s.files).toBe(5)
    expect(fileOf('lone-sticky')).toBe(wf.widgetFileIdForWidget('lone-sticky'))
    expect(fileOf('pair-1')).toBe(wf.widgetFileIdForGroup('grp'))
    expect(fileOf('pair-2')).toBe(wf.widgetFileIdForGroup('grp'))
    for (const id of ['trashed', 'desk-only', 'on-binned-desk', 'on-shared-desk']) expect(widgets.getWidget(id)!.syncGroupId, id).toBeNull()
    expect(widgets.getWidget('awaiting-file')!.syncGroupId).toBe('wf:not-arrived-yet')
    expect(wf.getWidgetFile('not-arrived-yet')).toBeNull()
  })

  it('keeps a real title as the user’s, names the rest from content or a placeholder dated by the widget', async () => {
    fixture()
    await wf.runWidgetFileBackfill()
    expect(wf.getWidgetFile(fileOf('lone-named')!)!).toMatchObject({ title: 'Board prep', titleSource: 'user' })
    expect(wf.getWidgetFile(fileOf('lone-sticky')!)!).toMatchObject({ title: 'Pick up keys', titleSource: 'derived' })
    const empty = wf.getWidgetFile(fileOf('lone-empty')!)!
    expect(empty.titleSource).toBe('placeholder')
    expect(empty.title).toBe(shared.placeholderWidgetFileTitle('mindmap', new Date(1_700_000_000_000)))
    // A real name reaches the untitled instance; a placeholder does not get stamped on the desk.
    expect(widgets.getWidget('lone-sticky')!.title).toBe('Pick up keys')
    expect(widgets.getWidget('lone-empty')!.title).toBe('')
  })

  it('files each workspace’s widgets in that workspace, and only the active one into Files now', async () => {
    fixture()
    await wf.runWidgetFileBackfill()
    const acmeFile = fileOf('in-other-org')!
    expect((db.prepare('SELECT org_id FROM documents WHERE id = ?').get(acmeFile) as { org_id: string }).org_id).toBe('acme')
    expect(db.prepare("SELECT 1 FROM fb_files WHERE doc_id = ?").get(acmeFile)).toBeUndefined()
    expect(db.prepare("SELECT 1 FROM fb_files WHERE doc_id = ?").get(fileOf('lone-sticky'))).toBeTruthy()
    // Switching to that workspace files it on the first root listing.
    activeOrg = 'acme'
    expect(files.listEntries(null).some((e) => e.docId === acmeFile)).toBe(true)
  })

  it('runs once per workspace, and a forced re-run changes nothing (idempotent)', async () => {
    fixture()
    await wf.runWidgetFileBackfill()
    const first = state()
    expect(wf.pendingBackfillOrgs()).toEqual([])
    const again = await wf.runWidgetFileBackfill()
    expect(again).toEqual({ orgs: [], widgets: 0, files: 0 })
    db.exec('DELETE FROM sync_meta')
    const forced = await wf.runWidgetFileBackfill()
    expect(forced.files).toBe(0)
    expect(forced.widgets).toBe(0)
    expect(state()).toEqual(first)
  })

  it('two devices converting the same synced desk mint the same file ids', async () => {
    fixture()
    await wf.runWidgetFileBackfill()
    const deviceOne = state()
    db = memSqlDb()
    schema()
    fixture()
    await wf.runWidgetFileBackfill()
    const deviceTwo = state()
    expect(deviceTwo.docs.map((d) => d.id)).toEqual(deviceOne.docs.map((d) => d.id))
    expect(deviceTwo.groups).toEqual(deviceOne.groups)
  })

  it('reuses a file that already arrived from the other device instead of minting another', async () => {
    fixture()
    const id = wf.widgetFileIdForWidget('lone-sticky')
    documents.createDocument({
      id,
      docType: 'widget',
      title: 'Named on the other Mac',
      body: shared.makeWidgetFileBody('sticky', 'Pick up keys', null, 'user')
    })
    await wf.runWidgetFileBackfill()
    expect(fileOf('lone-sticky')).toBe(id)
    expect(wf.getWidgetFile(id)!.title).toBe('Named on the other Mac')
    expect((db.prepare('SELECT COUNT(*) AS n FROM documents WHERE id = ?').get(id) as { n: number }).n).toBe(1)
  })
})

describe('remove from this desk versus delete the work widget', () => {
  it('remove takes only this desk’s instance; the file stays in Files and on the other desk', () => {
    const f = wf.createWidgetFile({ kind: 'sticky', content: 'Shared' })
    const a = wf.placeWidgetFile(f.id, { taskId: 'deskA' })!
    const b = wf.placeWidgetFile(f.id, { taskId: 'deskB' })!
    widgets.deleteWidget(a.id)
    expect(wf.listWidgetFileInstances(f.id).map((w) => w.id)).toEqual([b.id])
    expect(wf.listWidgetFiles().some((x) => x.id === f.id)).toBe(true)
    expect(files.listEntries(null).some((e) => e.docId === f.id)).toBe(true)
  })

  it('delete trashes the file and every instance; restoring the file puts back exactly those', () => {
    const f = wf.createWidgetFile({ kind: 'sticky', content: 'Shared' })
    const a = wf.placeWidgetFile(f.id, { taskId: 'deskA' })!
    const b = wf.placeWidgetFile(f.id, { taskId: 'deskB' })!
    const c = wf.placeWidgetFile(f.id, { taskId: 'deskC' })!
    // C was removed from its desk earlier, on its own — restoring the file must not bring it back.
    widgets.deleteWidget(c.id)
    db.prepare('UPDATE widgets SET trashed_at = trashed_at - 60000 WHERE id = ?').run(c.id)
    expect(wf.trashWidgetFile(f.id)).toBe(true)
    expect(wf.listWidgetFileInstances(f.id)).toHaveLength(0)
    expect(widgets.listWidgetsByTask('deskA')).toHaveLength(0)
    expect(files.listEntries(null).some((e) => e.docId === f.id)).toBe(false)
    expect(documents.restoreDocument(f.id)).toBe(true)
    expect(wf.listWidgetFileInstances(f.id).map((w) => w.id).sort()).toEqual([a.id, b.id].sort())
    expect(widgets.listWidgetsByTask('deskA').map((w) => w.id)).toEqual([a.id])
    expect(files.listEntries(null).some((e) => e.docId === f.id)).toBe(true)
  })

  it('the 7-day desk-trash purge keeps instances a trashed file still holds; purging the file takes them', () => {
    const f = wf.createWidgetFile({ kind: 'sticky', content: 'Shared' })
    const a = wf.placeWidgetFile(f.id, { taskId: 'deskA' })!
    wf.trashWidgetFile(f.id)
    widgets.purgeTrashedWidgets(-1) // everything trashed counts as old
    expect(widgets.getWidget(a.id)).not.toBeNull()
    documents.deleteDocument(f.id)
    expect(widgets.getWidget(a.id)).toBeNull()
  })

  it('a document trash from anywhere (Files, the pane) behaves the same: documents.trashDocument takes the instances', () => {
    const f = wf.createWidgetFile({ kind: 'note', content: 'n' })
    const a = wf.placeWidgetFile(f.id, { taskId: 'deskA' })!
    documents.trashDocument(f.id)
    expect(widgets.listWidgetsByTask('deskA').some((w) => w.id === a.id)).toBe(false)
  })
})

describe('desk snapshots keep the file link', () => {
  it('restoring a snapshot taken before a widget became a file does not unlink it', () => {
    legacy('snap-w', 'deskA', 'sticky', 'v1')
    snapshots.createSnapshot('deskA', widgets.listWidgetsByTask('deskA'), 'before')
    const snapId = (db.prepare('SELECT id FROM canvas_snapshots').get() as { id: string }).id
    wf.adoptWidgetAsFile('snap-w')
    const link = widgets.getWidget('snap-w')!.syncGroupId
    expect(link).toMatch(/^wf:/)
    snapshots.restoreSnapshot(snapId)
    expect(widgets.getWidget('snap-w')!.syncGroupId).toBe(link)
  })
})

describe('table files are named "Header · N rows", not after their own placeholder', () => {
  it('derives past a backing table that took the file’s dated placeholder as its name', () => {
    const f = wf.createWidgetFile({ kind: 'table' })
    expect(f.titleSource).toBe('placeholder')
    // What TableWidget's provisioning did: a table named after the widget's
    // placeholder title, then `{ content, title }` written back together.
    const t = tables.createTable({
      taskId: null,
      title: f.title,
      schema: { columns: [{ id: 'c1', label: 'Client', type: 'text-short' }] } as never
    })
    wf.updateWidgetFile(f.id, { content: t.id, title: f.title })
    expect(wf.getWidgetFile(f.id)!.titleSource).toBe('placeholder')
    tables.createRow({ tableId: t.id, cells: { c1: 'Acme' } })
    tables.createRow({ tableId: t.id, cells: { c1: 'Globex' } })
    wf.refreshTableFiles(t.id)
    expect(wf.getWidgetFile(f.id)!.title).toBe('Client · 2 rows')
    tables.createRow({ tableId: t.id, cells: { c1: 'Initech' } })
    wf.refreshTableFiles(t.id)
    expect(wf.getWidgetFile(f.id)!.title).toBe('Client · 3 rows')
  })

  it('an instance echoing its own name back is not a rename', () => {
    const f = wf.createWidgetFile({ kind: 'sticky' })
    const a = wf.placeWidgetFile(f.id, { taskId: 'deskA' })!
    widgets.updateWidget(a.id, { title: a.title, content: 'Quarterly goals' })
    const after = wf.getWidgetFile(f.id)!
    expect(after.titleSource).toBe('derived')
    expect(after.title).toBe('Quarterly goals')
  })
})

describe('deterministic ids', () => {
  it('are stable, UUID-shaped, and differ between a widget and a group of the same id', () => {
    const one = wf.widgetFileIdForWidget('abc')
    expect(one).toBe(wf.widgetFileIdForWidget('abc'))
    expect(one).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(wf.widgetFileIdForGroup('abc')).not.toBe(one)
  })
})
