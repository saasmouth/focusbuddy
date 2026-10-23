// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ensureWorkItemSchema, updateWorkItemFieldsCore } from '../../src/main/db/workItems'
import { taskAttrsForItemPatch, TASK_EDITABLE_ITEM_FIELDS } from '../../src/shared/attentionProjection'
import type { LifecycleDb } from '../../src/main/db/nodeLifecycle'

// DEC-144 — editing a desk task from Focus writes the task.
//
// Before this, the item editor saved title, notes and due date through
// updateFields, and for a desk task the write path stored ONLY the queue and
// returned success for nothing else; the store then re-read the item through a
// work-item-only lookup and got null. The edit looked saved and was gone.

type Db = LifecycleDb & { exec(sql: string): void }

function freshDb(): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('folder', 'task', 'task-item', 'work_item')),
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      due_date INTEGER,
      archived INTEGER NOT NULL DEFAULT 0,
      trashed_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
  `)
  const db: Db = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      const s = raw.prepare(sql)
      return {
        run: (...a: unknown[]) => s.run(...(a as never[])),
        get: (...a: unknown[]) => s.get(...(a as never[])),
        all: (...a: unknown[]) => s.all(...(a as never[])) as unknown[]
      }
    }
  }
  ensureWorkItemSchema(db)
  raw.exec("INSERT INTO nodes (id, parent_id, kind, title) VALUES ('room', NULL, 'folder', 'Room')")
  raw.exec("INSERT INTO nodes (id, parent_id, kind, title) VALUES ('desk', 'room', 'task', 'A desk')")
  raw.exec("INSERT INTO nodes (id, parent_id, kind, title) VALUES ('task', 'desk', 'task', 'Real work')")
  return { raw, db }
}

type Row = { title: string; description: string; due_date: number | null; intent_class: string | null }
const rowOf = (raw: DatabaseSync, id: string): Row =>
  raw.prepare('SELECT title, description, due_date, intent_class FROM nodes WHERE id = ?').get(id) as Row

describe('taskAttrsForItemPatch — the item edit in the task vocabulary', () => {
  it('maps the shared fields onto the task columns', () => {
    expect(
      taskAttrsForItemPatch({
        title: '  Call Bob  ',
        notes: 'about the lease',
        dueAt: '2026-11-03T06:30:00.000Z',
        intentClass: 'to_respond'
      })
    ).toEqual({
      title: 'Call Bob',
      description: 'about the lease',
      dueDate: Date.parse('2026-11-03T06:30:00.000Z'),
      intentClass: 'to_respond'
    })
  })

  it('clears the due date and the notes', () => {
    expect(taskAttrsForItemPatch({ dueAt: null, notes: null })).toEqual({ dueDate: null, description: '' })
  })

  it('refuses a field a task does not hold, rather than dropping it', () => {
    for (const key of ['wiUrgency', 'tags', 'mentions', 'meetStartAt', 'workItemState', 'groupId']) {
      expect(taskAttrsForItemPatch({ title: 'ok', [key]: 'x' })).toBeNull()
    }
  })

  it('refuses values that cannot be stored', () => {
    expect(taskAttrsForItemPatch({ title: '   ' })).toBeNull()
    expect(taskAttrsForItemPatch({ dueAt: 'not a date' })).toBeNull()
    expect(taskAttrsForItemPatch({ intentClass: 'nonsense' })).toBeNull()
  })

  it('names exactly the fields it accepts', () => {
    expect([...TASK_EDITABLE_ITEM_FIELDS].sort()).toEqual(['assigneeIds', 'dueAt', 'intentClass', 'notes', 'title'])
  })
})

describe('updateWorkItemFieldsCore on a desk task', () => {
  it('writes title, notes, due date and queue to the task row', () => {
    const { raw, db } = freshDb()
    const due = '2026-11-03T06:30:00.000Z'
    expect(
      updateWorkItemFieldsCore(db, 'task', {
        title: 'Renamed',
        notes: 'new notes',
        dueAt: due,
        intentClass: 'to_review'
      })
    ).toBe(true)
    expect(rowOf(raw, 'task')).toEqual({
      title: 'Renamed',
      description: 'new notes',
      due_date: Date.parse(due),
      intent_class: 'to_review'
    })
  })

  it('refuses the whole patch when any field is one a task cannot hold', () => {
    const { raw, db } = freshDb()
    expect(updateWorkItemFieldsCore(db, 'task', { title: 'Renamed', tags: 'x' })).toBe(false)
    expect(rowOf(raw, 'task').title).toBe('Real work')
  })

  it('still refuses the desk itself — a desk is not an item', () => {
    const { raw, db } = freshDb()
    expect(updateWorkItemFieldsCore(db, 'desk', { title: 'Nope' })).toBe(false)
    expect(rowOf(raw, 'desk').title).toBe('A desk')
  })
})

describe('the read side agrees with the write side', () => {
  const src = readFileSync(join(__dirname, '../../src/main/db/workItems.ts'), 'utf-8')
  it('getWorkItem reads desk tasks through the same lens as listWorkItems', () => {
    const fn = src.slice(src.indexOf('export function getWorkItem'), src.indexOf('export function updateWorkItemFields'))
    expect(fn).toContain("n.kind = 'task' AND COALESCE(n.archived, 0) = 0 AND p.kind = 'task'")
    expect(fn).toContain('asAttentionItem(')
  })

  it('the editor offers a desk task only the fields it can save, and says when a save is refused', () => {
    const editor = readFileSync(
      join(__dirname, '../../src/renderer/src/components/AttentionItemEditor.tsx'),
      'utf-8'
    )
    expect(editor).toContain("const isDeskTask = item.kind === 'task'")
    expect(editor).toContain("{!isDeskTask && <option value=\"\">No desk</option>}")
    expect(editor).toContain('That change could not be saved')
  })
})

import { subtreeIds, deskOf } from '../../src/renderer/src/lib/attentionGrouping'
import type { FbNode } from '../../src/shared/types'

describe('one nesting rule, one desk (DEC-144)', () => {
  const n = (id: string, kind: FbNode['kind'], parentId: string | null, extra: Partial<FbNode> = {}): FbNode =>
    ({ id, kind, parentId, title: id, status: 'open', ...extra }) as FbNode
  const desk = n('desk', 'task', 'room')
  const task = n('task', 'task', 'desk')
  const step = n('step', 'task', 'task')
  const item = n('item', 'work_item', 'desk')
  const sub = n('sub', 'work_item', 'desk', { groupId: 'item' })
  const nodes = [n('room', 'folder', null), desk, task, step]
  const items = [task, step, item, sub]

  it("a task's step nests under it, the same way an item's sub-item does", () => {
    expect([...subtreeIds('task', items)].sort()).toEqual(['step', 'task'])
    expect([...subtreeIds('item', items)].sort()).toEqual(['item', 'sub'])
  })

  it('the desk is the nearest ancestor that is not itself an item', () => {
    expect(deskOf(step, items, nodes)).toBe('desk')
    expect(deskOf(task, items, nodes)).toBe('desk')
    expect(deskOf(item, items, nodes)).toBe('desk')
  })

  it('the desk widget tick closes through the shared close path, not a bare status write', () => {
    const widget = readFileSync(
      join(__dirname, '../../src/renderer/src/components/widgets/TaskListWidget.tsx'),
      'utf-8'
    )
    expect(widget).toContain('closeWorkItem(item, (PRIMARY_ACTION[queueOf(item)] ?? PRIMARY_ACTION.to_do).state)')
    expect(widget).not.toContain("updateNode(n.id, { status: n.status === DONE ? 'open' : DONE })")
  })
})

import { workItemCatalogAddendum, ADD_SUBTASK_DEFINITION } from '../../src/main/ai/vocabulary'

describe('the AI has one routing rule and the new words (DEC-144)', () => {
  const rules = workItemCatalogAddendum()
  it('one rule picks add-subtask vs create-work-item by where the task belongs', () => {
    expect(rules).toContain('ONE ROUTING RULE')
    expect(rules).toContain('A DESK IS OPEN')
    expect(ADD_SUBTASK_DEFINITION).toContain('Focus list')
  })
  it('speaks "task" and "Focus", and knows @focus', () => {
    expect(rules).toContain('never say "work item"')
    expect(rules).toContain('"@focus"')
    expect(rules).not.toContain('Attention queues')
  })
})

describe('one concept, one set of words (DEC-144)', () => {
  const r = (p: string): string => readFileSync(join(__dirname, '../../src', p), 'utf-8')
  it('the page and every door to it say Focus', () => {
    expect(r('renderer/src/components/views/AttentionView.tsx')).toContain('>Focus</h1>')
    expect(r('renderer/src/components/Sidebar.tsx')).toContain('label="Focus"')
    expect(r('renderer/src/components/nav/AreaAccordion.tsx')).toContain("{ kind: 'attention', label: 'Focus',")
    // The work widget menu takes its label from the shared lexicon (SPEC §9.4).
    expect(r('shared/menus/lexicon.ts')).toContain("addToFocus: { label: 'Add to Focus…' }")
    expect(r('renderer/src/lib/contextMenu/universal.ts')).toContain('label: MENU.addToFocus.label,')
    expect(r('renderer/src/components/widgets/WidgetFrame.tsx')).toContain(": 'Add to Focus'")
  })
  it('the full-pane widget view is "Full view", so "Focus" means one thing', () => {
    const frame = r('renderer/src/components/widgets/WidgetFrame.tsx')
    expect(frame).toContain('>Full view</div>')
    expect(frame).not.toContain('>Focus mode</div>')
  })
  it('the Desks app lists desks; the home tiles read Focus', () => {
    const desks = r('renderer/src/components/views/AllTasksView.tsx')
    expect(desks).toContain('title="All desks"')
    expect(desks).toContain('!isDeskTask(n,')
    const home = r('renderer/src/components/views/homeWidgets.tsx')
    expect(home).toContain('function useOpenFocusTasks()')
    expect(home).toContain('rankScore(b, now) - rankScore(a, now)')
  })
  it('an email becomes a task in Focus, not a desk', () => {
    const dlg = r('renderer/src/components/mail/EmailTaskDialog.tsx')
    expect(dlg).toContain("sourceType: 'mail'")
    expect(dlg).not.toContain("kind: 'task'")
  })
})
