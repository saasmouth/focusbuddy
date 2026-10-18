// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DELETE_HINT, otherDeskCount, removeHint, trashFileBody } from '../../src/renderer/src/lib/widgetRemovalCopy'
import { mentionCandidates } from '../../src/renderer/src/lib/mentionCandidates'
import { isPlaceholderWidgetFileTitle, meaningfulWidgetTitle, placeholderWidgetFileTitle, deriveWidgetFileTitle } from '../../src/shared/widgetFiles'
import type { Widget } from '../../src/shared/types'

// The × on a work widget asks "remove from this desk, or delete the work
// widget?" (docs/widget-files.md, "Remove or delete"). These are the words it
// says and the source-level wiring that every × reaches it; the behaviour
// behind both answers is tested against SQLite in widgetFilesEveryWidget.test.ts
// and end to end in tests/e2e/widgetRemoveOrDelete.spec.ts.

const ROOT = join(__dirname, '..', '..', 'src', 'renderer', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

describe('the words', () => {
  it('says where the work widget stays when it is removed from one desk', () => {
    expect(removeHint(0)).toBe('It stays in Files.')
    expect(removeHint(1)).toBe('It stays in Files and on 1 other desk.')
    expect(removeHint(3)).toBe('It stays in Files and on 3 other desks.')
  })

  it('says what delete does, and that it can be undone from Trash', () => {
    expect(DELETE_HINT).toBe('Removes it from every desk and from Files. You can restore it from Trash.')
    expect(trashFileBody(0)).toBeUndefined()
    expect(trashFileBody(2)).toMatch(/on 2 desks and will be removed from them too/)
  })

  it('counts other DESKS, not instances, and never this one', () => {
    const on = (taskId: string): Pick<Widget, 'taskId'> => ({ taskId })
    expect(otherDeskCount([on('a')], 'a')).toBe(0)
    expect(otherDeskCount([on('a'), on('b'), on('b'), on('c')], 'a')).toBe(2)
  })
})

describe('every × asks the same question', () => {
  it('the frame header, the dock chip and the context menu all go through removeWorkWidget', () => {
    expect(read('components/widgets/WidgetFrame.tsx')).toContain('void removeWorkWidget(widget)')
    expect(read('components/WidgetDock.tsx')).toContain('void removeWorkWidget(w)')
    const actions = read('lib/contextMenu/actions.ts')
    expect(actions).toContain('await removeWorkWidget(w)')
    expect(actions).toContain('removeWorkWidgets(ctx.object.widgets)')
    // The old one-button confirm is gone from both ×s.
    for (const f of ['components/widgets/WidgetFrame.tsx', 'components/WidgetDock.tsx']) {
      expect(read(f)).not.toContain("title: 'Remove from the desk?'")
    }
  })

  it('offers both choices, the delete one marked as dangerous, with Cancel from the dialog', () => {
    const src = read('lib/widgetRemoval.ts')
    expect(src).toContain("label: 'Remove from this desk'")
    expect(src).toContain("label: 'Delete work widget'")
    expect(src).toMatch(/value: 'delete'[^}]*danger: true/)
    // A kind with no file keeps the single confirm.
    expect(src).toContain("title: 'Delete this work widget?'")
    expect(read('components/plexi/PromptDialog.tsx')).toContain('c.danger')
  })

  it('the full-pane "Move to Trash" and Files both warn that instances go too', () => {
    expect(read('components/views/WidgetFileView.tsx')).toContain('confirmTrashWidgetFile(file.id)')
    expect(read('components/views/FilesView.tsx')).toContain('confirmTrashWidgetFile(docId)')
  })
})

describe('@-mention picker: a work widget file shows its type, not "Work widget"', () => {
  const docs = [{ id: 'f1', title: 'Clients', docType: 'widget', widgetKind: 'table' }]

  it('labels a table file "Table"', () => {
    const [c] = mentionCandidates({ nodes: [], widgets: [], documents: docs }, 'Cli')
    expect(c.detail).toBe('Table')
    expect(c.icon).toBe('table_chart')
  })

  it('the picker passes the kind through (it used to drop it, so every file read "Work widget")', () => {
    for (const f of ['lib/useMentionAutocomplete.ts', 'components/documents/editor/DocMentionPicker.tsx']) {
      expect(read(f), f).toContain('widgetKind: d.widgetKind')
    }
  })

  it('offers a placed work widget once, as the widget on the desk, not again as its file', () => {
    const w = { id: 'w1', taskId: 'd', kind: 'table', title: 'Clients', content: '', archived: false, syncGroupId: 'wf:f1' } as unknown as Widget
    const out = mentionCandidates({ nodes: [], widgets: [w], documents: docs }, 'Cli')
    expect(out.map((c) => c.kind)).toEqual(['widget'])
  })
})

describe('names', () => {
  it('recognises a placeholder in any file type, and nothing else', () => {
    expect(isPlaceholderWidgetFileTitle(placeholderWidgetFileTitle('table', new Date(2026, 9, 18, 15, 4)))).toBe(true)
    expect(isPlaceholderWidgetFileTitle(placeholderWidgetFileTitle('task-list'))).toBe(true)
    expect(isPlaceholderWidgetFileTitle('Client · 12 rows')).toBe(false)
    expect(isPlaceholderWidgetFileTitle('Board prep')).toBe(false)
  })

  it('keeps a real widget title, not the kind label or a placeholder', () => {
    expect(meaningfulWidgetTitle('note', 'Board prep')).toBe('Board prep')
    expect(meaningfulWidgetTitle('table', 'Table')).toBeNull()
    expect(meaningfulWidgetTitle('task-list', 'task list')).toBeNull()
    expect(meaningfulWidgetTitle('table', 'Untitled table')).toBeNull()
    expect(meaningfulWidgetTitle('sticky', placeholderWidgetFileTitle('sticky'))).toBeNull()
  })

  it('a table named after a placeholder or an old row count is named from its rows instead', () => {
    const table = (title: string) => () => ({
      title,
      columns: [{ id: 'c', label: 'Client' }],
      rows: [{ c: 'a' }, { c: 'b' }]
    })
    expect(deriveWidgetFileTitle('table', 't', { table: table(placeholderWidgetFileTitle('table')) })).toBe('Client · 2 rows')
    expect(deriveWidgetFileTitle('table', 't', { table: table('Client · 9 rows') })).toBe('Client · 2 rows')
    expect(deriveWidgetFileTitle('table', 't', { table: table('Suppliers') })).toBe('Suppliers')
  })
})
