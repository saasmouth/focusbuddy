// @vitest-environment node
// .plexii-* files: one example per work widget type and per Office document
// type, kept word for word in focusbuddy and PlexiiLite (F1, 2026-11-20;
// docs/plans/widget-files.md in plexii-lite). Each example imports and exports
// back to itself through the app's own store, on the web build's SQLite with
// the real schema: the runtime PlexiiLite's widget host uses.
//
// The examples are made BY the store, never by hand, so they are always in the
// shape Plexii writes. To remake them after a deliberate format change:
//   WRITE_WIDGET_FILE_FIXTURES=1 npx vitest run tests/unit/widgetFileFixtures.test.ts
// then tell PlexiiLite (its copy has a drift test).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'

let db: SqliteDb
vi.mock('../../src/main/db/database', () => ({
  getDb: () => db,
  databaseFilePath: () => ':memory:',
  closeDb: () => {},
  nodesKindMigrationStatus: () => null
}))
vi.mock('../../src/main/db/activeOrg', () => ({ getActiveOrgId: () => 'personal', setActiveOrgId: () => {}, PERSONAL_ORG_ID: 'personal' }))
vi.mock('../../src/main/documentEvents', () => ({ notifyDocumentChanged: () => {} }))
vi.mock('../../src/main/db/brandKit', () => ({ getBrandKit: () => null, hasBrandKit: () => false }))
vi.mock('../../src/main/db/embeddings', () => ({ deleteEmbedding: () => {} }))
vi.mock('../../src/main/tableEvents', () => ({ notifyRowsChanged: () => {} }))
vi.mock('../../src/main/db/automationEvents', () => ({ emitAutomationEvent: () => {} }))
vi.mock('../../src/main/chunkIndex', () => ({ reindexWidgetChunks: () => {}, reindexDocumentChunks: () => {} }))
vi.mock('../../src/main/documentRetrieval', () => ({ embedDocument: async () => {} }))

const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
const wf = await import('../../src/main/db/widgetFiles')
const docs = await import('../../src/main/db/documents')
const tables = await import('../../src/main/db/tables')
const files = await import('../../src/main/db/files')
const shared = await import('../../src/shared/widgetFiles')
const { catalogFor } = await import('../../src/renderer/src/lib/widgetCatalog')

const DIR = resolve(__dirname, '../fixtures/widget-files')
const STAMP = '2026-11-20T00:00:00.000Z'
const WRITE = process.env.WRITE_WIDGET_FILE_FIXTURES === '1'

beforeAll(async () => {
  await initSqlite()
})
beforeEach(() => {
  db = openMemoryDatabase()
  applySchemaAndMigrations(db as never)
})

/** The text with its exportedAt pinned, so a fixture never changes by itself. */
const pinned = (text: string): string => {
  const o = JSON.parse(text) as Record<string, unknown>
  o.exportedAt = STAMP
  return `${JSON.stringify(o, null, 2)}\n`
}
const withoutStamp = (text: string): unknown => {
  const o = JSON.parse(text) as Record<string, unknown>
  delete o.exportedAt
  return o
}

// ── What each example holds ─────────────────────────────────────────────────

type Kind = keyof typeof shared.WIDGET_FILE_TYPES
function exampleWidget(kind: Kind): { title: string; content: string; color?: string | null } {
  const catalog = catalogFor(kind as never)?.defaultContent ?? ''
  switch (kind) {
    case 'sticky':
      return { title: 'Call the venue', content: 'Call the venue about Thursday: two more chairs.', color: '#fef08a' }
    case 'task-list':
      return {
        title: 'Before the launch',
        content: shared.taskListContent([{ title: 'Check the price page' }, { title: 'Post the release notes' }])
      }
    case 'mindmap':
      return {
        title: 'Launch plan',
        content: shared.mindmapContent('Launch plan', [
          { label: 'Site', children: [{ label: 'Price page' }] },
          { label: 'App', children: [{ label: 'Release notes' }] }
        ] as never)
      }
    case 'card':
      return { title: 'Weekly review', content: shared.cardContent('Weekly review', 'Wins, misses and the next three things.') }
    default:
      return { title: shared.WIDGET_FILE_TYPES[kind]!.label, content: catalog }
  }
}

const P = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
function exampleDocument(docType: import('../../src/shared/widgetFiles').OfficeDocType): { title: string; body: unknown } {
  switch (docType) {
    case 'doc':
      return {
        title: 'Launch plan',
        body: {
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Launch plan' }] },
            P('Ship the widget files in PlexiiLite 0.8.0.'),
            P('Then bring rooms into Plexii with them.')
          ]
        }
      }
    case 'sheet':
      return {
        title: 'Supplies',
        body: {
          columns: ['A', 'B', 'C'],
          rows: [
            ['Item', 'Qty', 'Price'],
            ['Pens', '2', '1.50'],
            ['Paper', '1', '4.00']
          ]
        }
      }
    default:
      return { title: shared.DOCUMENT_FILE_TYPES[docType].label, body: docs.emptyBody(docType) }
  }
}

function makeWidgetFixture(kind: Kind): string {
  const ex = exampleWidget(kind)
  let content = ex.content
  if (kind === 'table') {
    const t = tables.createTable({
      taskId: null,
      title: 'Guests',
      schema: {
        columns: [
          { id: 'c-name', type: 'text-short', label: 'Name', config: {} },
          { id: 'c-rsvp', type: 'text-short', label: 'RSVP', config: {} }
        ] as never
      }
    })
    tables.createRow({ tableId: t.id, cells: { 'c-name': 'Ann', 'c-rsvp': 'Yes' } as never })
    tables.createRow({ tableId: t.id, cells: { 'c-name': 'Bob', 'c-rsvp': 'Maybe' } as never })
    content = t.id
  }
  const file = wf.createWidgetFile({ kind: kind as never, title: kind === 'table' ? 'Guests' : ex.title, content, color: ex.color ?? null })
  const out = wf.exportPlexiiFileText({ fileId: file.id })
  if (!out.ok) throw new Error(out.error)
  return pinned(out.text)
}

function makeDocumentFixture(docType: import('../../src/shared/widgetFiles').OfficeDocType): string {
  const ex = exampleDocument(docType)
  const doc = docs.createDocument({ docType, title: ex.title, body: ex.body as never })
  const out = wf.exportPlexiiFileText({ documentId: doc.id })
  if (!out.ok) throw new Error(out.error)
  return pinned(out.text)
}

const widgetKinds = Object.keys(shared.WIDGET_FILE_TYPES) as Kind[]
const docTypes = Object.keys(shared.DOCUMENT_FILE_TYPES) as Array<import('../../src/shared/widgetFiles').OfficeDocType>
const nameFor = (ext: string): string => `example${ext}`

if (WRITE) {
  describe('writing the examples', () => {
    it('writes one per type', () => {
      mkdirSync(DIR, { recursive: true })
      for (const kind of widgetKinds) writeFileSync(join(DIR, nameFor(shared.WIDGET_FILE_TYPES[kind]!.ext)), makeWidgetFixture(kind))
      for (const t of docTypes) writeFileSync(join(DIR, nameFor(shared.DOCUMENT_FILE_TYPES[t].ext)), makeDocumentFixture(t))
    })
  })
}

// ── The examples ────────────────────────────────────────────────────────────

const present = (): string[] => {
  try {
    return readdirSync(DIR).filter((n) => n.startsWith('example.plexii-')).sort()
  } catch {
    return []
  }
}

describe('the example files', () => {
  it('one per work widget type and per document type, and nothing else', () => {
    const want = [...widgetKinds.map((k) => shared.WIDGET_FILE_TYPES[k]!.ext), ...docTypes.map((t) => shared.DOCUMENT_FILE_TYPES[t].ext)]
      .map(nameFor)
      .sort()
    expect(present()).toEqual(want)
  })

  it.each(present())('%s: Plexii reads it as the type its name says', (name) => {
    const text = readFileSync(join(DIR, name), 'utf8')
    const ext = name.slice('example'.length)
    const parsed = shared.parsePlexiiFile(text)
    expect('error' in parsed ? parsed.error : '').toBe('')
    if ('error' in parsed) return
    if (parsed.family === 'document') expect(shared.DOCUMENT_FILE_TYPES[parsed.file.docType].ext).toBe(ext)
    else expect(shared.WIDGET_FILE_TYPES[parsed.file.kind as Kind]?.ext).toBe(ext)
    expect(shared.isPlexiiFileName(name)).toBe(true)
  })

  it.each(present())('%s: imports, and exports back to the same file', (name) => {
    const text = readFileSync(join(DIR, name), 'utf8')
    const r = wf.importPlexiiFileText(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const back = wf.exportPlexiiFileText(r.kind === 'document' ? { documentId: r.document.id } : { fileId: r.file.id })
    expect(back.ok).toBe(true)
    if (!back.ok) return
    if (r.kind === 'widget' && r.file.kind === 'table') {
      // A table's content is only the id of its rows, and an import makes its own
      // table (rows recreated, never shared): every other field comes back, and
      // the rows are the file's rows.
      const a = withoutStamp(back.text) as Record<string, unknown>
      const b = withoutStamp(text) as Record<string, unknown>
      expect(a.content).not.toBe(b.content)
      expect(tables.getTable(String(a.content))).not.toBeNull()
      delete a.content
      delete b.content
      expect(a).toEqual(b)
      return
    }
    expect(withoutStamp(back.text)).toEqual(withoutStamp(text))
  })
})

describe('what an import refuses, creating nothing', () => {
  const count = (): number => (db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n
  it.each([
    ['not JSON', 'not json at all'],
    ['an unknown type', JSON.stringify({ type: 'plexii.document.spreadsheet3d', version: 1, title: 'x', body: {} })],
    ['a sheet whose body is not a sheet', JSON.stringify({ type: 'plexii.document.sheet', version: 1, title: 'x', docType: 'sheet', body: { foo: 1 } })],
    ['a doc whose body is not a document', JSON.stringify({ type: 'plexii.document.doc', version: 1, title: 'x', docType: 'doc', body: [] })],
    ['a design without its size', JSON.stringify({ type: 'plexii.document.design', version: 1, title: 'x', docType: 'design', body: { elements: [] } })],
    ['a widget envelope for a desk-only kind', JSON.stringify({ type: 'plexii.widget.section', version: 1, kind: 'section', title: 'x', content: '' })],
    // a0, 2026-11-20: columns that are not FieldDefinitions crash TableWidget while drawing.
    ['a table whose columns are not Plexii table columns', JSON.stringify({ type: 'plexii.widget.table', version: 1, kind: 'table', title: 'x', content: 't1', color: null,
      table: { title: 'x', columns: [{ name: 'Name', type: 'text' }], rows: [{ Name: 'Ann' }] } })],
    ['a table whose rows are not rows', JSON.stringify({ type: 'plexii.widget.table', version: 1, kind: 'table', title: 'x', content: 't1', color: null,
      table: { title: 'x', columns: [{ id: 'c1', type: 'text-short', label: 'Name', config: {} }], rows: ['Ann'] } })]
  ])('%s', (_label, text) => {
    const before = count()
    const r = wf.importPlexiiFileText(text)
    expect(r.ok).toBe(false)
    expect(count()).toBe(before)
  })
})

describe('where an imported document goes', () => {
  const sheet = (): string => readFileSync(join(DIR, 'example.plexii-sheet'), 'utf8')
  it('into Files at the root, as an imported work widget file does', () => {
    const r = wf.importPlexiiFileText(sheet())
    expect(r.ok && r.kind).toBe('document')
    if (!r.ok || r.kind !== 'document') return
    expect(files.listEntries(null).some((e) => e.docId === r.document.id)).toBe(true)
  })
  it('into the folder named', () => {
    const folder = files.createFolder(null, 'Imports')
    const r = wf.importPlexiiFileText(sheet(), folder.id)
    if (!r.ok || r.kind !== 'document') throw new Error('not imported')
    expect(files.listEntries(folder.id).some((e) => e.docId === r.document.id)).toBe(true)
    expect(files.listEntries(null).some((e) => e.docId === r.document.id)).toBe(false)
  })
})

describe('names', () => {
  it('tells the two families apart by extension, and offers a clean filename', () => {
    expect(shared.isDocumentFileName('Q4 plan.plexii-sheet')).toBe(true)
    expect(shared.isWidgetFileName('Q4 plan.plexii-sheet')).toBe(false)
    expect(shared.isPlexiiFileName('Guests.plexii-table')).toBe(true)
    expect(shared.isPlexiiFileName('Guests.plexii-nope')).toBe(false)
    expect(shared.documentFileExportName({ docType: 'slides', title: 'Q4: review/notes' })).toBe('Q4  review notes.plexii-slides')
    expect(shared.documentFileExportName({ docType: 'map', title: '' })).toBe('Diagram.plexii-map')
  })
})
