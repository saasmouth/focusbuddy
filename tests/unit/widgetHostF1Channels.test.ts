// The two channels the widget host reads and writes files through, with F1's
// contract (9e, 2026-11-20). Until F1 lands they are served by the interim
// handlers in src/web/worker/widgetHostInterim.ts; F1's own handlers are
// looked up first and replace them, and these tests must then pass against
// F1's (point the import at src/web/worker/handlers.ts and delete the interim).
//
//   'widgetFiles:import'     { text, parentId? } -> { ok: true, kind: 'widget', file }
//                                                  | { ok: true, kind: 'document', document } | { ok: false, error }
//   'widgetFiles:exportText' { fileId } | { documentId } -> { ok: true, name, text } | { ok: false, error }
//
// The text is the exact file (JSON, 2-space indent), so the host never builds
// the envelope itself, and a table's rows travel with it.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { initSqlite, openMemoryDatabase, type SqliteDb } from '../../src/web/worker/sqlite'

let db: SqliteDb
vi.mock('../../src/main/db/database', () => ({ getDb: () => db, databaseFilePath: () => ':memory:', closeDb: () => {}, nodesKindMigrationStatus: () => null }))
vi.mock('../../src/main/db/activeOrg', () => ({ getActiveOrgId: () => 'personal', setActiveOrgId: () => {}, PERSONAL_ORG_ID: 'personal' }))
vi.mock('../../src/main/documentEvents', () => ({ notifyDocumentChanged: () => {} }))
vi.mock('../../src/main/tableEvents', () => ({ notifyTableChanged: () => {}, notifyRowsChanged: () => {}, emitTableEvent: () => {} }))

const { applySchemaAndMigrations } = await import('../../src/main/db/migrations')
const { INTERIM_F1_HANDLERS: H } = await import('../../src/web/worker/widgetHostInterim')
const { updateWidgetFile } = await import('../../src/main/db/widgetFiles')
const { listRows, updateRow } = await import('../../src/main/db/tables')
const { updateDocumentBody } = await import('../../src/main/db/documents')

const call = async (channel: string, arg: unknown): Promise<any> => (H as Record<string, (a: unknown) => unknown>)[channel](arg)
const stickyText = JSON.stringify({ type: 'plexii.widget.sticky', version: 1, title: 'Shopping', kind: 'sticky', content: 'milk', color: '#ffd', exportedAt: '2026-11-20T00:00:00.000Z' })

beforeAll(async () => { await initSqlite() })
beforeEach(() => { db = openMemoryDatabase(); applySchemaAndMigrations(db as never) })

describe('widgetFiles:import', () => {
  it('a widget file becomes a widget file row', async () => {
    const r = await call('widgetFiles:import', { text: stickyText })
    expect(r).toMatchObject({ ok: true, kind: 'widget', file: { kind: 'sticky', title: 'Shopping', content: 'milk', color: '#ffd' } })
    expect(typeof r.file.id).toBe('string')
  })

  it('a table brings its columns and rows', async () => {
    const text = JSON.stringify({ type: 'plexii.widget.table', version: 1, title: 'Prices', kind: 'table', content: 'old-id', color: null,
      table: { title: 'Prices', columns: [{ id: 'c1', type: 'text-short', label: 'Item', config: {} }], rows: [{ c1: 'tea' }, { c1: 'milk' }] }, exportedAt: '' })
    const r = await call('widgetFiles:import', { text })
    expect(r).toMatchObject({ ok: true, kind: 'widget', file: { kind: 'table' } })
    expect(listRows(r.file.content).map((x) => x.cells)).toEqual([{ c1: 'tea' }, { c1: 'milk' }])
  })

  it('a table whose columns or rows are not a Plexii table is refused as damaged, and makes nothing (as F1 refuses it)', async () => {
    const DAMAGED = 'This table file is damaged: its columns or rows are not a Plexii table.'
    const table = (t: unknown): string => JSON.stringify({ type: 'plexii.widget.table', version: 1, title: 'T', kind: 'table', content: '', color: null, table: t, exportedAt: '' })
    for (const t of [
      { title: 'T', columns: [{ id: 'c1', name: 'Item', type: 'text' }], rows: [] },
      { title: 'T', columns: [{ id: 'c1', type: 'no-such-type', label: 'Item', config: {} }], rows: [] },
      { title: 'T', columns: [{ id: 'c1', type: 'text-short', label: 'Item', config: {} }], rows: ['not a row'] },
      { title: 'T', columns: 'nope', rows: [] }
    ]) {
      expect(await call('widgetFiles:import', { text: table(t) })).toEqual({ ok: false, error: DAMAGED })
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n).toBe(0)
  })

  it('an Office document becomes a documents row with its body unchanged', async () => {
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }], text: 'Hello' }
    const r = await call('widgetFiles:import', { text: JSON.stringify({ type: 'plexii.document.doc', version: 1, title: 'Letter', docType: 'doc', body, exportedAt: '' }) })
    expect(r).toMatchObject({ ok: true, kind: 'document', document: { docType: 'doc', title: 'Letter', body } })
  })

  it('refuses what it cannot read, saying why, and makes nothing', async () => {
    for (const text of ['not json', '{}', JSON.stringify({ type: 'plexii.widget.nonsense', kind: 'nonsense', version: 1 }),
      JSON.stringify({ type: 'plexii.document.doc', version: 1, title: 'x', docType: 'doc' }),
      JSON.stringify({ type: 'plexii.document.poem', version: 1, title: 'x', docType: 'poem', body: {} })]) {
      const r = await call('widgetFiles:import', { text })
      expect(r.ok).toBe(false)
      expect(typeof r.error).toBe('string')
    }
    expect((await call('widgetFiles:import', {})).ok).toBe(false)
    expect((db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n).toBe(0)
  })
})

describe('widgetFiles:exportText', () => {
  it('a widget file comes back as its exact file text, with its name', async () => {
    const { file } = await call('widgetFiles:import', { text: stickyText })
    updateWidgetFile(file.id, { content: 'milk, eggs' } as never)
    const r = await call('widgetFiles:exportText', { fileId: file.id })
    expect(r.ok).toBe(true)
    expect(r.name).toBe('Shopping.plexii-sticky')
    expect(r.text).toBe(JSON.stringify(JSON.parse(r.text), null, 2))
    expect(JSON.parse(r.text)).toMatchObject({ type: 'plexii.widget.sticky', version: 1, title: 'Shopping', kind: 'sticky', content: 'milk, eggs', color: '#ffd' })
  })

  it('a table\'s rows travel with it, edits included', async () => {
    const text = JSON.stringify({ type: 'plexii.widget.table', version: 1, title: 'Prices', kind: 'table', content: '', color: null,
      table: { title: 'Prices', columns: [{ id: 'c1', type: 'text-short', label: 'Item', config: {} }], rows: [{ c1: 'tea' }] }, exportedAt: '' })
    const { file } = await call('widgetFiles:import', { text })
    const [row] = listRows(file.content)
    updateRow(row.id, { cells: { c1: 'coffee' } } as never)
    const out = JSON.parse((await call('widgetFiles:exportText', { fileId: file.id })).text)
    expect(out.table).toMatchObject({ title: 'Prices', columns: [{ id: 'c1', type: 'text-short', label: 'Item' }], rows: [{ c1: 'coffee' }] })
  })

  it('a document comes back with its current body', async () => {
    const body = { type: 'doc', content: [], text: '' }
    const { document } = await call('widgetFiles:import', { text: JSON.stringify({ type: 'plexii.document.doc', version: 1, title: 'Letter', docType: 'doc', body, exportedAt: '' }) })
    const next = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }], text: 'Hi' }
    expect(updateDocumentBody(document.id, next as never, document.bodyRev)).toMatchObject({ ok: true })
    const r = await call('widgetFiles:exportText', { documentId: document.id })
    expect(r.name).toBe('Letter.plexii-doc')
    expect(JSON.parse(r.text)).toMatchObject({ type: 'plexii.document.doc', version: 1, title: 'Letter', docType: 'doc', body: next })
  })

  it('an unknown id is a refusal, not an empty file', async () => {
    expect(await call('widgetFiles:exportText', { fileId: 'nope' })).toMatchObject({ ok: false })
    expect(await call('widgetFiles:exportText', { documentId: 'nope' })).toMatchObject({ ok: false })
    expect(await call('widgetFiles:exportText', {})).toMatchObject({ ok: false })
  })
})
