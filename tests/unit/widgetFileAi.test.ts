import { describe, it, expect } from 'vitest'
import { parseChatJson } from '../../src/main/ai/anthropic'
import { WORKSPACE_TOOLS } from '../../src/main/mcpServer'
import type { WorkspaceDeps } from '../../src/main/mcpServer'
import type { WidgetFile, WidgetFileDraft } from '../../src/shared/types'
import { ownTaskItems } from '../../src/shared/widgetFiles'

// "These widgets … should be interrogatable by any AI assistant or AI build
// functions" — and the assistant's tools can create and update them where the
// tool patterns already allow document create/update. docs/widget-files.md.

describe('the in-app assistant can propose widget files (review-and-apply)', () => {
  it('reads a create-widget-file action as a proposal card, with only the fields its kind uses', () => {
    const raw = JSON.stringify({
      reply: 'Here is a list you can put on any desk.',
      actions: [
        {
          kind: 'create-widget-file',
          widgetKind: 'task-list',
          title: 'Move house',
          items: ['Book van', { title: 'Redirect mail', dueAt: 1790000000000 }, { nope: 1 }],
          reason: 'the move has several steps'
        }
      ]
    })
    const out = parseChatJson(raw)!
    expect(out.proposals).toHaveLength(1)
    const p = out.proposals[0]
    expect(p.kind).toBe('create-widget-file')
    if (p.kind !== 'create-widget-file') return
    expect(p.widgetKind).toBe('task-list')
    expect(p.items).toEqual([
      { title: 'Book van' },
      { title: 'Redirect mail', dueAt: 1790000000000 }
    ])
  })

  it('refuses a kind it cannot author honestly, and a file with no title', () => {
    const raw = JSON.stringify({
      reply: 'x',
      actions: [
        { kind: 'create-widget-file', widgetKind: 'chart', title: 'Revenue' },
        { kind: 'create-widget-file', widgetKind: 'sticky', title: '' }
      ]
    })
    expect(parseChatJson(raw)!.proposals).toHaveLength(0)
  })

  it('reads update-widget-file, defaulting to append', () => {
    const raw = JSON.stringify({
      reply: 'Added.',
      actions: [{ kind: 'update-widget-file', fileId: 'f1', label: 'the move list', items: ['Cancel gym'] }]
    })
    const p = parseChatJson(raw)!.proposals[0]
    expect(p.kind).toBe('update-widget-file')
    if (p.kind !== 'update-widget-file') return
    expect(p.fileId).toBe('f1')
    expect(p.items).toEqual([{ title: 'Cancel gym' }])
    expect(p.operation).toBeUndefined()
  })
})

describe('MCP tools create and update widget files (write scope only)', () => {
  const tool = (name: string) => WORKSPACE_TOOLS.find((t) => t.name === name)!

  function fakeDeps(): { deps: WorkspaceDeps; files: Map<string, WidgetFile>; rows: Array<Record<string, unknown>> } {
    const files = new Map<string, WidgetFile>()
    const rows: Array<Record<string, unknown>> = []
    let n = 0
    const deps = {
      listNodes: () => [],
      getNode: () => null,
      createTable: (d: { title: string; schema: { columns: Array<{ id: string; label: string }> } }) => ({
        id: 'tbl1',
        taskId: null,
        title: d.title,
        schema: d.schema,
        createdAt: 0,
        updatedAt: 0
      }),
      getTable: () => ({ id: 'tbl1', taskId: null, title: 'Q', schema: { columns: [{ id: 'c1', label: 'Supplier' }] }, createdAt: 0, updatedAt: 0 }),
      createRow: (d: { cells: Record<string, unknown> }) => {
        rows.push(d.cells)
        return { id: `r${rows.length}`, tableId: 'tbl1', cells: d.cells }
      },
      createWidgetFile: (d: WidgetFileDraft) => {
        const f: WidgetFile = { id: `f${++n}`, kind: d.kind, title: d.title ?? '', titleSource: 'user', content: d.content ?? '', color: null, createdAt: 0, updatedAt: 0, orgId: null }
        files.set(f.id, f)
        return f
      },
      getWidgetFile: (id: string) => files.get(id) ?? null,
      updateWidgetFile: (id: string, patch: { content?: string; title?: string }) => {
        const f = files.get(id)
        if (!f) return null
        const next = { ...f, ...(patch.content !== undefined ? { content: patch.content } : {}), ...(patch.title ? { title: patch.title } : {}) }
        files.set(id, next)
        return next
      }
    } as unknown as WorkspaceDeps
    return { deps, files, rows }
  }

  it('both tools exist and need a write token', () => {
    expect(tool('plexii_create_widget_file').scope).toBe('write')
    expect(tool('plexii_update_widget_file').scope).toBe('write')
  })

  it('creates a task-list file whose content is a real own-items list', async () => {
    const { deps, files } = fakeDeps()
    const res = await tool('plexii_create_widget_file').run({ kind: 'task-list', title: 'Move', items: ['Book van'] }, deps)
    expect(res.isError).toBeFalsy()
    const f = [...files.values()][0]
    expect(ownTaskItems(f.content)!.map((i) => i.title)).toEqual(['Book van'])
  })

  it('creates a table file with its rows in a real table', async () => {
    const { deps, files, rows } = fakeDeps()
    await tool('plexii_create_widget_file').run({ kind: 'table', title: 'Quotes', columns: ['Supplier'], rows: [['Acme']] }, deps)
    expect([...files.values()][0].content).toBe('tbl1')
    expect(rows).toHaveLength(1)
    expect(Object.values(rows[0])).toEqual(['Acme'])
  })

  it('updates: appends text, adds tasks, refuses fields the kind does not have', async () => {
    const { deps, files } = fakeDeps()
    await tool('plexii_create_widget_file').run({ kind: 'sticky', title: 'Keys', text: 'hook' }, deps)
    const id = [...files.keys()][0]
    await tool('plexii_update_widget_file').run({ id, text: 'spare in drawer' }, deps)
    expect(files.get(id)!.content).toBe('hook\nspare in drawer')
    const bad = await tool('plexii_update_widget_file').run({ id, items: ['x'] }, deps)
    expect(bad.isError).toBe(true)
  })

  it('refuses an unknown kind plainly', async () => {
    const { deps } = fakeDeps()
    const res = await tool('plexii_create_widget_file').run({ kind: 'section', title: 'x' }, deps)
    expect(res.isError).toBe(true)
  })
})
