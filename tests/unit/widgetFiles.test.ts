import { describe, it, expect } from 'vitest'
import type { Widget, WidgetKind } from '../../src/shared/types'
import { isUntitled } from '../../src/shared/titles'
import {
  WIDGET_FILE_TYPES,
  appendTaskItems,
  buildWidgetFileExport,
  cardContent,
  defaultWidgetFileContent,
  deriveWidgetFileTitle,
  isStandaloneWidgetKind,
  isWidgetFileName,
  kindForWidgetFileType,
  mergeText,
  mindmapContent,
  ownTaskItems,
  parseWidgetFileBody,
  parseWidgetFileExport,
  placeholderWidgetFileTitle,
  taskListContent,
  widgetFileExportName,
  widgetFileGroupId,
  widgetFileIdFromGroup,
  widgetFromFile
} from '../../src/shared/widgetFiles'
import { docBodyToText, widgetFileBodyToText, widgetToText, type ResolvedTable } from '../../src/shared/widgetText'
import { WIDGET_CATALOG, catalogFor } from '../../src/renderer/src/lib/widgetCatalog'
import {
  fileTypeIcon,
  fileTypeKey,
  fileTypeLabel,
  matchesTypeFilter,
  plural,
  typeFilterOptions
} from '../../src/renderer/src/lib/fileEntryType'
import type { FileEntry } from '../../src/shared/fields'

// Widget files (4.3.32) — the pure half: file types, naming per kind, the text
// every AI surface reads, and the content the assistant may write. See
// docs/widget-files.md.

const supplierTable: ResolvedTable = {
  title: '',
  columns: [
    { id: 'c1', label: 'Supplier' },
    { id: 'c2', label: 'Quote', type: 'number' }
  ],
  rows: [
    { c1: 'Acme', c2: 4200 },
    { c1: 'Glo|bex', c2: 3900 }
  ]
}
const resolvers = { table: (id: string) => (id === 't1' ? supplierTable : null) }
const w = (kind: WidgetKind, content: string, extra: Partial<Widget> = {}): Widget =>
  ({ id: 'w', taskId: 'd', kind, title: '', content, ...extra }) as Widget

describe('file types: one per kind, stable', () => {
  const types = Object.entries(WIDGET_FILE_TYPES)

  it('every standalone kind is a real catalogue kind, with the catalogue’s icon', () => {
    for (const [kind, t] of types) {
      const entry = catalogFor(kind as WidgetKind)
      expect(entry, kind).not.toBeNull()
      expect(t!.icon, `${kind} icon`).toBe(entry!.icon)
    }
  })

  it('type ids and extensions are unique and namespaced', () => {
    const ids = types.map(([, t]) => t!.typeId)
    const exts = types.map(([, t]) => t!.ext)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(exts).size).toBe(exts.length)
    for (const id of ids) expect(id).toMatch(/^plexii\.widget\.[a-z-]+$/)
    for (const e of exts) expect(e).toMatch(/^\.plexii-[a-z-]+$/)
  })

  it('names the owner’s examples as asked', () => {
    expect(WIDGET_FILE_TYPES.table!.label).toBe('Table')
    expect(WIDGET_FILE_TYPES['task-list']!.label).toBe('Task list')
    expect(WIDGET_FILE_TYPES.mindmap!.label).toBe('Mind map')
    expect(WIDGET_FILE_TYPES.sticky!.label).toBe('Sticky')
    expect(WIDGET_FILE_TYPES.table!.ext).toBe('.plexii-table')
  })

  it('desk-only kinds and documents are not file types', () => {
    for (const k of ['section', 'portal', 'task-link', 'agent', 'webhook', 'inbound-hook', 'living-doc', 'minimap', 'contacts', 'attention', 'doc', 'sheet', 'webview'] as WidgetKind[]) {
      expect(isStandaloneWidgetKind(k), k).toBe(false)
    }
  })

  it('resolves a kind from its extension or type id, and recognises exported names', () => {
    expect(kindForWidgetFileType('.plexii-tasks')).toBe('task-list')
    expect(kindForWidgetFileType('plexii-table')).toBe('table')
    expect(kindForWidgetFileType('plexii.widget.mindmap')).toBe('mindmap')
    expect(kindForWidgetFileType('.docx')).toBeNull()
    expect(isWidgetFileName('Quotes.plexii-table')).toBe(true)
    expect(isWidgetFileName('Quotes.plexii-nonsense')).toBe(false)
    expect(isWidgetFileName('Quotes.xlsx')).toBe(false)
  })
})

describe('Files maps each widget file to its own type', () => {
  const entry = (p: Partial<FileEntry>): FileEntry => ({ id: 'e', parentId: null, kind: 'doc', name: 'n', createdAt: 0, updatedAt: 0, ...p }) as FileEntry
  const table = entry({ docType: 'widget', widgetKind: 'table' })
  const tasks = entry({ docType: 'widget', widgetKind: 'task-list' })
  const doc = entry({ docType: 'doc' })

  it('label, icon and sort key per kind', () => {
    expect(fileTypeLabel(table)).toBe('Table')
    expect(fileTypeLabel(tasks)).toBe('Task list')
    expect(fileTypeIcon(table)).toBe('table_chart')
    expect(fileTypeKey(table)).toBe('widget:table')
    // Diagram / design / artwork no longer read as "Document".
    expect(fileTypeLabel(entry({ docType: 'map' }))).toBe('Diagram')
    expect(fileTypeLabel(entry({ docType: 'draw' }))).toBe('Artwork')
  })

  it('filters by family and by one widget type', () => {
    expect(matchesTypeFilter(table, 'widgets')).toBe(true)
    expect(matchesTypeFilter(table, 'widget:table')).toBe(true)
    expect(matchesTypeFilter(tasks, 'widget:table')).toBe(false)
    expect(matchesTypeFilter(table, 'documents')).toBe(false)
    expect(matchesTypeFilter(doc, 'documents')).toBe(true)
  })

  it('offers a filter per widget type present, plural', () => {
    const opts = typeFilterOptions([table, tasks, doc]).map((o) => o.label)
    expect(opts).toContain('Tables')
    expect(opts).toContain('Task lists')
    expect(plural('Sticky')).toBe('Stickies')
    expect(plural('Colour swatch')).toBe('Colour swatches')
  })
})

describe('naming from content, per kind — never Untitled', () => {
  it('a placeholder is dated and is not "Untitled"', () => {
    const t = placeholderWidgetFileTitle('table', new Date('2026-10-17T15:40:00'))
    expect(t).toMatch(/^Table · Oct 17, 3:40/)
    expect(isUntitled(t)).toBe(false)
  })

  const cases: Array<[WidgetKind, string, string | null]> = [
    ['sticky', '# Offsite plan\nBook venue', 'Offsite plan'],
    ['note', 'Quarterly review notes for the board', 'Quarterly review notes for the board'],
    ['markdown', '## Launch checklist\n- one', 'Launch checklist'],
    ['page', JSON.stringify({ type: 'doc', content: [{ type: 'heading', content: [{ type: 'text', text: 'Hiring plan' }] }] }), 'Hiring plan'],
    ['card', cardContent('Brand voice', 'We write plainly'), 'Brand voice'],
    ['table', 't1', 'Supplier · 2 rows'],
    ['task-list', taskListContent([{ title: 'Call Sam about the lease' }, { title: 'Book venue' }]), 'Call Sam about the lease + 1 more'],
    ['mindmap', mindmapContent('Grow revenue', [{ label: 'Upsell' }]), 'Grow revenue'],
    ['chart', JSON.stringify({ type: 'bar', tableId: 't1', series: [] }), null],
    ['chart', JSON.stringify({ type: 'bar', title: 'Quotes by supplier', tableId: 't1', series: [] }), 'Quotes by supplier'],
    ['stat-card', JSON.stringify({ title: 'Monthly revenue', series: [] }), 'Monthly revenue'],
    ['metrics', JSON.stringify({ cells: [{ label: 'Churn rate' }] }), 'Churn rate'],
    ['field', JSON.stringify({ def: { label: 'Budget cap' }, value: 1200 }), 'Budget cap'],
    ['field', JSON.stringify({ def: { label: 'Field' } }), null],
    ['timer', JSON.stringify({ targetSec: 1500 }), 'Timer · 25 min'],
    ['calculator', '12*4', 'Calc · 12*4'],
    ['color', '#FBBF24', 'Colour #fbbf24'],
    ['voice-recorder', JSON.stringify({ transcript: 'Remember to email the landlord tomorrow' }), 'Remember to email the landlord tomorrow'],
    ['image-gen', JSON.stringify({ prompt: 'A desk at golden hour' }), 'A desk at golden hour'],
    ['diagram', JSON.stringify({ nodes: [{ data: { label: 'Checkout flow' } }] }), 'Checkout flow'],
    ['location-map', JSON.stringify({ label: 'Sydney Opera House, Bennelong Point' }), 'Sydney Opera House'],
    ['gallery', JSON.stringify({ fileIds: ['a', 'b', 'c'] }), 'Gallery · 3 images'],
    ['scratchpad', JSON.stringify({ strokes: [1, 2] }), null],
    ['sticky', '', null]
  ]
  for (const [kind, content, expected] of cases) {
    it(`${kind}: ${expected ?? '(nothing to name it from)'}`, () => {
      expect(deriveWidgetFileTitle(kind, content, resolvers)).toBe(expected)
    })
  }

  it('an empty table is not named after its template columns', () => {
    const empty = { table: () => ({ title: '', columns: [{ id: 'c', label: 'Name' }], rows: [] }) }
    expect(deriveWidgetFileTitle('table', 't', empty)).toBeNull()
  })

  it('a table’s own (real) name beats the header rule', () => {
    const named = { table: () => ({ ...supplierTable, title: 'Supplier quotes' }) }
    expect(deriveWidgetFileTitle('table', 't1', named)).toBe('Supplier quotes')
  })
})

describe('the text every AI surface reads', () => {
  it('a table is a markdown table with its headers', () => {
    const t = widgetToText(w('table', 't1'), resolvers).text
    expect(t).toContain('| Supplier | Quote |')
    expect(t).toContain('| --- | --- |')
    expect(t).toContain('| Acme | 4200 |')
    // A pipe inside a cell cannot break the row.
    expect(t).toContain('Glo\\|bex')
    expect(t).toContain('2 rows')
  })

  it('a task list is a checklist with due dates, open first', () => {
    const due = Date.UTC(2026, 9, 20)
    const content = JSON.stringify({
      scope: 'own',
      items: [
        { id: '1', title: 'Pay invoice', done: true },
        { id: '2', title: 'Call Sam', done: false, dueAt: due }
      ]
    })
    const t = widgetToText(w('task-list', content)).text
    expect(t).toContain('1 open, 1 done')
    expect(t.indexOf('- [ ] Call Sam (due 2026-10-20)')).toBeLessThan(t.indexOf('- [x] Pay invoice'))
  })

  it('a desk task list reads its real tasks when the caller can resolve them', () => {
    const t = widgetToText(w('task-list', '{"scope":"desk"}'), {
      tasks: () => [{ title: 'Ship it', done: false, status: 'in_progress', dueAt: null }]
    }).text
    expect(t).toContain('- [ ] Ship it (in_progress)')
  })

  it('a mind map is an indented outline', () => {
    const content = mindmapContent('Grow revenue', [{ label: 'Upsell', children: [{ label: 'Annual plans' }] }, { label: 'New markets' }])
    const t = widgetToText(w('mindmap', content)).text
    expect(t).toContain('- Grow revenue\n  - Upsell\n    - Annual plans\n  - New markets')
  })

  it('a chart carries its title and the values it draws', () => {
    const content = JSON.stringify({ type: 'bar', title: 'Quotes', tableId: 't1', xColumnId: 'c1', series: [{ columnId: 'c2', agg: 'sum' }] })
    const t = widgetToText(w('chart', content), resolvers).text
    expect(t).toContain('bar chart "Quotes"')
    expect(t).toContain('Acme: Quote (Sum) 4200')
  })

  it('a timer, a field and a calculator read as their values', () => {
    expect(widgetToText(w('timer', '{"targetSec":600,"state":"running"}')).text).toBe('Timer 600s (running)')
    expect(widgetToText(w('field', '{"def":{"label":"Budget"},"value":1200}')).text).toBe('Budget: 1200')
    expect(widgetToText(w('calculator', '2+2')).text).toBe('Calculator: 2+2')
  })

  it('a widget file body reads the same way, through the document path', () => {
    const body = { v: 1, kind: 'table', content: 't1', color: null, titleSource: 'derived' }
    expect(widgetFileBodyToText(body, '', resolvers)).toContain('| Supplier | Quote |')
    expect(docBodyToText('widget', body, resolvers)).toContain('| Acme | 4200 |')
  })
})

describe('bodies, linking and the full-pane widget', () => {
  it('parses a body defensively, treating a sourceless title as the user’s', () => {
    expect(parseWidgetFileBody('{"kind":"sticky","content":"x"}')).toMatchObject({ kind: 'sticky', titleSource: 'user' })
    expect(parseWidgetFileBody('{"content":"x"}')).toBeNull()
    expect(parseWidgetFileBody('nope')).toBeNull()
  })

  it('links by the wf: sync group, and only that prefix', () => {
    expect(widgetFileGroupId('abc')).toBe('wf:abc')
    expect(widgetFileIdFromGroup('wf:abc')).toBe('abc')
    expect(widgetFileIdFromGroup('some-ordinary-group')).toBeNull()
    expect(widgetFileIdFromGroup(null)).toBeNull()
  })

  it('the full-pane widget is the file, deskless, in its own group', () => {
    const pane = widgetFromFile({ id: 'f1', kind: 'sticky', title: 'T', titleSource: 'user', content: 'c', color: null, createdAt: 1, updatedAt: 2, orgId: null })
    expect(pane.id).toBe('wf:f1')
    expect(pane.syncGroupId).toBe('wf:f1')
    expect(pane.taskId).toBe('')
  })

  it('a task-list FILE keeps its own items; a desk task list does not change', () => {
    expect(ownTaskItems(defaultWidgetFileContent('task-list', '{"scope":"desk"}'))).toEqual([])
    expect(defaultWidgetFileContent('sticky', '')).toBe('')
  })
})

describe('content the assistant may write', () => {
  it('appends tasks to its own list, refuses a desk lens', () => {
    const next = appendTaskItems(taskListContent([{ title: 'One' }]), [{ title: 'Two', dueAt: 5 }])!
    expect(ownTaskItems(next)!.map((i) => i.title)).toEqual(['One', 'Two'])
    expect(appendTaskItems('{"scope":"desk"}', [{ title: 'x' }])).toBeNull()
  })

  it('merges text into text kinds only', () => {
    expect(mergeText('sticky', 'a', 'b', 'append')).toBe('a\nb')
    expect(mergeText('note', 'a', 'b', 'replace')).toBe('b')
    expect(JSON.parse(mergeText('card', cardContent('T', 'one'), 'two', 'append')!).body).toBe('one\ntwo')
    expect(mergeText('table', 't1', 'x', 'append')).toBeNull()
  })
})

describe('export / import', () => {
  it('round-trips through the .plexii-* envelope', () => {
    const env = buildWidgetFileExport({ kind: 'sticky', title: 'Keys', content: 'hook by door', color: '#fef08a' })
    expect(env.type).toBe('plexii.widget.sticky')
    expect(widgetFileExportName({ kind: 'sticky', title: 'Keys/Spare' })).toBe('Keys Spare.plexii-sticky')
    const back = parseWidgetFileExport(JSON.stringify(env))
    expect(back).toMatchObject({ kind: 'sticky', title: 'Keys', content: 'hook by door', color: '#fef08a' })
  })

  it('refuses what it cannot honestly import', () => {
    expect('error' in parseWidgetFileExport('not json')).toBe(true)
    expect('error' in parseWidgetFileExport('{"type":"plexii.widget.section","kind":"section"}')).toBe(true)
  })
})

describe('the catalogue and the file types agree', () => {
  it('every picker kind is either a file type, desk-only, or an app', () => {
    // Nothing falls through the cracks: a kind added to the catalogue must be
    // classified, or this fails and says which one.
    const deskOnly = new Set(['section', 'portal', 'task-link', 'agent', 'webhook', 'inbound-hook', 'living-doc', 'contacts', 'attention', 'local-app-launcher'])
    const apps = new Set(['doc', 'sheet', 'slides', 'map', 'design', 'draw', 'diagram', 'file', 'drive', 'webview', 'inbox', 'calendar', 'chat-thread'])
    for (const e of WIDGET_CATALOG.filter((x) => !x.hideFromPicker)) {
      const classified = isStandaloneWidgetKind(e.kind) || deskOnly.has(e.kind) || apps.has(e.kind)
      expect(classified, `${e.kind} is unclassified`).toBe(true)
    }
  })
})
