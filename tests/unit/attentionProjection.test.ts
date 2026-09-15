import { describe, it, expect } from 'vitest'
import {
  isDeskTask,
  stateForTaskStatus,
  taskStatusForState,
  asAttentionItem,
  attentionItemsFrom
} from '../../src/shared/attentionProjection'
import type { FbNode } from '../../src/shared/types'

const node = (over: Partial<FbNode> & { id: string }): FbNode =>
  ({
    parentId: null,
    kind: 'task',
    title: 'T',
    description: '',
    status: 'open',
    priority: 3,
    interest: 3,
    importance: 3,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    estimateMinutes: null,
    extensionsMinutes: 0,
    resumeMarkdown: null,
    resumeUpdatedAt: null,
    dueDate: null,
    ...over
  }) as FbNode

const index = (ns: FbNode[]) => (id: string): FbNode | undefined => ns.find((n) => n.id === id)

describe('isDeskTask', () => {
  const desk = node({ id: 'desk' })
  const task = node({ id: 't1', parentId: 'desk' })
  const sub = node({ id: 's1', parentId: 't1' })
  const room = node({ id: 'room', kind: 'folder' })
  const loose = node({ id: 'loose', parentId: 'room' })
  const all = [desk, task, sub, room, loose]

  it('counts a task filed under a desk', () => {
    expect(isDeskTask(task, index(all))).toBe(true)
  })
  it('counts a subtask too — it is still work', () => {
    expect(isDeskTask(sub, index(all))).toBe(true)
  })
  it('does NOT count the desk itself', () => {
    // A desk and a task are the same node kind; a desk is not an item to do.
    expect(isDeskTask(desk, index(all))).toBe(false)
  })
  it('does not count a task whose parent is a room rather than a desk', () => {
    expect(isDeskTask(loose, index(all))).toBe(false)
  })
  it('does not count an archived task', () => {
    expect(isDeskTask(node({ id: 'a', parentId: 'desk', archived: true }), index(all))).toBe(false)
  })
  it('does not count a work_item — that path is separate', () => {
    expect(isDeskTask(node({ id: 'w', kind: 'work_item', parentId: 'desk' }), index(all))).toBe(false)
  })
})

describe('status mapping', () => {
  it('maps every task status to a state', () => {
    expect(stateForTaskStatus('open')).toBe('open')
    expect(stateForTaskStatus('in_progress')).toBe('in_progress')
    expect(stateForTaskStatus('done')).toBe('completed')
    expect(stateForTaskStatus('parked')).toBe('dismissed')
  })

  it('round-trips through the existing work-item mapping', () => {
    // Closing a task from Attention writes a state; the task must land back on
    // the status it means. A mismatch here is how "I ticked it and it came back".
    for (const status of ['open', 'in_progress', 'done'] as const) {
      expect(taskStatusForState(stateForTaskStatus(status))).toBe(status)
    }
  })

  it('maps parked to a state that does not read as done', () => {
    expect(taskStatusForState(stateForTaskStatus('parked'))).not.toBe('done')
  })
})

describe('asAttentionItem', () => {
  it('gives a task the default queue so it lands in To Do', () => {
    expect(asAttentionItem(node({ id: 't' })).intentClass).toBe('to_do')
  })
  it('derives the state from the task status', () => {
    expect(asAttentionItem(node({ id: 't', status: 'done' })).workItemState).toBe('completed')
  })
  it('converts the numeric due date to the ISO field Attention sorts on', () => {
    const due = Date.UTC(2026, 8, 20)
    expect(asAttentionItem(node({ id: 't', dueDate: due })).dueAt).toBe(new Date(due).toISOString())
  })
  it('leaves a task with no due date undated rather than inventing one', () => {
    expect(asAttentionItem(node({ id: 't' })).dueAt).toBeNull()
  })
  it('never overwrites a value the node already carries', () => {
    const n = node({ id: 't', intentClass: 'to_review', workItemState: 'needs_review' })
    const p = asAttentionItem(n)
    expect(p.intentClass).toBe('to_review')
    expect(p.workItemState).toBe('needs_review')
  })
  it('passes a work_item through untouched', () => {
    const w = node({ id: 'w', kind: 'work_item', intentClass: 'to_decide', workItemState: 'open' })
    expect(asAttentionItem(w)).toBe(w)
  })
})

describe('attentionItemsFrom', () => {
  it('returns work items and desk tasks, and nothing else', () => {
    const nodes = [
      node({ id: 'room', kind: 'folder' }),
      node({ id: 'desk', parentId: 'room' }),
      node({ id: 'task', parentId: 'desk' }),
      node({ id: 'sub', parentId: 'task' }),
      node({ id: 'wi', kind: 'work_item' }),
      node({ id: 'archived', parentId: 'desk', archived: true })
    ]
    expect(attentionItemsFrom(nodes).map((n) => n.id).sort()).toEqual(['sub', 'task', 'wi'])
  })

  it('does not duplicate a record — each node appears at most once', () => {
    const nodes = [node({ id: 'desk' }), node({ id: 'task', parentId: 'desk' })]
    const out = attentionItemsFrom(nodes)
    expect(new Set(out.map((n) => n.id)).size).toBe(out.length)
  })

  it('keeps the same id as the task, so both lenses point at one row', () => {
    const nodes = [node({ id: 'desk' }), node({ id: 'task-42', parentId: 'desk' })]
    expect(attentionItemsFrom(nodes)[0].id).toBe('task-42')
  })

  it('is empty rather than throwing when given nothing', () => {
    expect(attentionItemsFrom([])).toEqual([])
  })
})
