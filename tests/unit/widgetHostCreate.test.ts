// @vitest-environment node
// create {kind}: a new file made by Plexii's own code (1a's contract; PlexiiLite's
// New > Plexii widget / document). The same calls the app makes for a new file:
// widgetFiles.create with the kind's catalog default (a task list in its
// own-list mode, which createWidgetFile chooses for a file), a table with the
// starter columns the desk's table widget gives it, an Office document with the
// blank body Plexii gives a new one -- then the exporter's text.
import { describe, it, expect, vi } from 'vitest'
import { makeCreate } from '../../src/web/widgetHost/create'
import { starterTableColumns, UNTITLED_TABLE } from '../../src/renderer/src/lib/tableStarter'

function setup(over: { exportFails?: boolean; createThrows?: boolean } = {}) {
  const calls: Array<[string, unknown[]]> = []
  const rec = (name: string, value: unknown) => vi.fn(async (...args: unknown[]) => {
    calls.push([name, args])
    if (over.createThrows && name === 'widgetFiles.create') throw new Error('a sticky only works on a desk')
    return value
  })
  const api = {
    widgetFiles: { create: rec('widgetFiles.create', { id: 'f1' }), update: rec('widgetFiles.update', { id: 'f1' }) },
    tables: { create: rec('tables.create', { id: 't1' }) },
    documents: { create: rec('documents.create', { id: 'd1' }) }
  }
  const exportText = vi.fn(async (which: unknown) => (over.exportFails ? { ok: false, error: 'gone' } : { ok: true, name: 'n', text: JSON.stringify(which) }))
  const create = makeCreate({ api, exportText, defaultContent: async (kind) => `default for ${kind}` })
  return { create, calls, exportText }
}

describe('create', () => {
  it('a widget: the app\'s own create with the kind\'s catalog default, then its exported text', async () => {
    const s = setup()
    expect(await s.create('sticky')).toEqual({ ok: true, text: '{"fileId":"f1"}' })
    expect(s.calls).toEqual([['widgetFiles.create', [{ kind: 'sticky' }, { defaultContent: 'default for sticky' }]]])
  })

  it('a table gets its backing table with the starter columns, as the desk provisions one', async () => {
    const s = setup()
    await s.create('table')
    expect(s.calls).toEqual([
      ['widgetFiles.create', [{ kind: 'table' }, { defaultContent: 'default for table' }]],
      ['tables.create', [{ taskId: null, title: UNTITLED_TABLE, schema: { columns: starterTableColumns() } }]],
      ['widgetFiles.update', ['f1', { content: 't1' }]]
    ])
    expect(s.exportText).toHaveBeenCalledWith({ fileId: 'f1' })
  })

  it('an Office document: a new documents row (Plexii gives it the blank body), exported by document id', async () => {
    const s = setup()
    expect(await s.create('sheet')).toEqual({ ok: true, text: '{"documentId":"d1"}' })
    expect(s.calls).toEqual([['documents.create', [{ docType: 'sheet', title: '' }]]])
  })

  it('a failure says why, never an empty file', async () => {
    expect(await setup({ exportFails: true }).create('note')).toEqual({ ok: false, error: 'gone' })
    expect(await setup({ createThrows: true }).create('sticky')).toEqual({ ok: false, error: 'a sticky only works on a desk' })
  })
})
