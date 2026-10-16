import { describe, it, expect } from 'vitest'
import type { FbNode } from '../../src/shared/types'
import {
  groupIntoQueues,
  groupByDue,
  groupByOrigin,
  recentlyClosed,
  archivedItems,
  detachedItems,
  itemReason,
  itemFullText,
  isTerminalState,
  rankScore,
  scopeItemsForDesk,
  clusterByDesk,
  PRIMARY_ACTION,
  QUEUE_ORDER
} from '../../src/renderer/src/lib/attentionQueues'

// S6 — the Attention surface's pure semantics: F013 (queues derive from
// work_item_state, never the status projection), snooze-hiding, the Detached
// shelf, class-appropriate closing verbs, and one-reason-per-item.

const NOW = Date.parse('2026-08-25T10:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function wi(over: Partial<FbNode>): FbNode {
  return {
    id: Math.random().toString(36).slice(2),
    parentId: null,
    kind: 'work_item',
    title: 'Item',
    description: '',
    status: 'open',
    priority: 3,
    interest: 3,
    importance: 3,
    sortOrder: 0,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    startedAt: null,
    completedAt: null,
    estimateMinutes: null,
    extensionsMinutes: 0,
    resumeMarkdown: null,
    resumeUpdatedAt: null,
    dueDate: null,
    archived: false,
    isPlan: false,
    sharedFromHandle: null,
    sharedRootId: null,
    workItemState: 'open',
    intentClass: 'to_do',
    ...over
  } as FbNode
}

describe('groupIntoQueues', () => {
  it('groups by intent class in the fixed order, hides terminal/snoozed/detached', () => {
    const items = [
      wi({ id: 'a', intentClass: 'to_do' }),
      wi({ id: 'r', intentClass: 'to_review' }),
      wi({ id: 'done', intentClass: 'to_do', workItemState: 'completed' }),
      // F013: a hostile status can NEVER surface a terminal item.
      wi({ id: 'hostile', intentClass: 'to_do', workItemState: 'dismissed', status: 'open' }),
      wi({ id: 'snoozed', intentClass: 'to_do', snoozeUntil: NOW + DAY }),
      wi({ id: 'wake', intentClass: 'to_do', snoozeUntil: NOW - 1000 }), // passed → visible
      wi({ id: 'det', intentClass: 'to_do', detachedFromId: 'gone-desk' })
    ]
    const qs = groupIntoQueues(items, NOW)
    const todo = qs.find((q) => q.queue === 'to_do')!
    expect(todo.items.map((i) => i.id).sort()).toEqual(['a', 'wake'])
    expect(qs.find((q) => q.queue === 'to_review')!.items).toHaveLength(1)
    expect(qs.map((q) => q.queue)).toEqual(
      QUEUE_ORDER.filter((q) => ['to_do', 'to_review'].includes(q))
    )
  })

  it('legacy classes canonicalize at the grouping boundary (alignment)', () => {
    // A straggler row an un-updated peer pushed between migrations still
    // lands in the right queue — never a raw legacy bucket.
    const items = [
      wi({ id: 'l1', intentClass: 'action' }),
      wi({ id: 'l2', intentClass: 'acknowledgment' }),
      wi({ id: 'l3', intentClass: 'direct' }),
      wi({ id: 'l4', intentClass: 'loose_thought' })
    ]
    const qs = groupIntoQueues(items, NOW)
    expect(qs.map((q) => q.queue)).toEqual(['to_do', 'to_respond', 'to_remember'])
    expect(qs.find((q) => q.queue === 'to_respond')!.items.map((i) => i.id).sort()).toEqual(['l2', 'l3'])
  })

  it('orders within a queue by rank: due proximity dominates, then staleness', () => {
    const items = [
      wi({ id: 'later', dueAt: new Date(NOW + 5 * DAY).toISOString(), updatedAt: NOW }),
      wi({ id: 'stale-undated', updatedAt: NOW - 9 * DAY }),
      wi({ id: 'soon', dueAt: new Date(NOW + DAY).toISOString(), updatedAt: NOW }),
      wi({ id: 'fresh-undated', updatedAt: NOW })
    ]
    const todo = groupIntoQueues(items, NOW).find((q) => q.queue === 'to_do')!
    // Ranker v1 (SPEC-019): due-soon beats due-later; among undated, the item
    // that has waited longest for the eye ranks HIGHER (staleness signal).
    expect(todo.items.map((i) => i.id)).toEqual(['soon', 'later', 'stale-undated', 'fresh-undated'])
  })

  it('rankScore: past due dominates; explicit human actionable gets the light thumb', () => {
    const pastDue = wi({ dueAt: new Date(NOW - DAY).toISOString(), updatedAt: NOW })
    const aiUndated = wi({ wiOrigin: 'ai', updatedAt: NOW })
    const humanUndated = wi({ wiOrigin: 'human', updatedAt: NOW })
    expect(rankScore(pastDue, NOW)).toBeGreaterThan(100 - 1)
    expect(rankScore(humanUndated, NOW)).toBeGreaterThan(rankScore(aiUndated, NOW))
  })
})

describe('lenses (SPEC-017 v1)', () => {
  it('groupByDue buckets in urgency order with the same visibility rules', () => {
    const items = [
      wi({ id: 'od', dueAt: new Date(NOW - DAY).toISOString() }),
      wi({ id: 'today', dueAt: new Date(NOW + 60 * 60 * 1000).toISOString() }),
      wi({ id: 'none' }),
      wi({ id: 'snoozed', snoozeUntil: NOW + DAY }),
      wi({ id: 'week', dueAt: new Date(NOW + 4 * DAY).toISOString() })
    ]
    const groups = groupByDue(items, NOW)
    expect(groups.map((g) => g.queue)).toEqual(['overdue', 'today', 'week', 'none'])
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).not.toContain('snoozed')
  })

  it('groupByOrigin splits You / Plexii / System', () => {
    const items = [wi({ id: 'h' }), wi({ id: 'a', wiOrigin: 'ai' }), wi({ id: 's', wiOrigin: 'system' })]
    expect(groupByOrigin(items, NOW).map((g) => g.label)).toEqual(['You', 'Plexii', 'System'])
  })

  it('recentlyClosed keeps finished loops, excludes dismissals, archived and old items', () => {
    const items = [
      wi({ id: 'done', workItemState: 'completed', updatedAt: NOW - DAY }),
      wi({ id: 'dismissed', workItemState: 'dismissed', updatedAt: NOW - DAY }),
      wi({ id: 'shelved', workItemState: 'archived', updatedAt: NOW - DAY }),
      wi({ id: 'old', workItemState: 'completed', updatedAt: NOW - 10 * DAY }),
      wi({ id: 'open' })
    ]
    expect(recentlyClosed(items, NOW).map((i) => i.id)).toEqual(['done'])
  })

  it('DEC-024 — the Archived shelf: archived only, out of queues, newest first', () => {
    const items = [
      wi({ id: 'a1', workItemState: 'archived', updatedAt: NOW - DAY }),
      wi({ id: 'a2', workItemState: 'archived', updatedAt: NOW - 2 * DAY }),
      wi({ id: 'open' }),
      wi({ id: 'done', workItemState: 'completed' })
    ]
    expect(archivedItems(items).map((i) => i.id)).toEqual(['a1', 'a2'])
    // Archived is terminal for visibility: never in the queues…
    expect(
      groupIntoQueues(items, NOW)
        .flatMap((q) => q.items)
        .map((i) => i.id)
    ).toEqual(['open'])
    // …and never on the Detached shelf either.
    expect(detachedItems([wi({ id: 'ad', detachedFromId: 'x', workItemState: 'archived' })])).toEqual([])
  })
})

describe('the Detached shelf', () => {
  it('collects non-terminal detached items only', () => {
    const items = [
      wi({ id: 'd1', detachedFromId: 'x' }),
      wi({ id: 'd2', detachedFromId: 'x', workItemState: 'dismissed' }),
      wi({ id: 'normal' })
    ]
    expect(detachedItems(items).map((i) => i.id)).toEqual(['d1'])
  })
})

describe('closing verbs + reasons', () => {
  it('every ordered queue has a class-appropriate primary action', () => {
    for (const q of QUEUE_ORDER) {
      expect(PRIMARY_ACTION[q], q).toBeTruthy()
      expect(isTerminalState(PRIMARY_ACTION[q].state), q).toBe(true)
    }
    expect(PRIMARY_ACTION.to_do.label).toBe('Done')
    expect(PRIMARY_ACTION.to_respond.label).toBe('Responded')
    expect(PRIMARY_ACTION.to_decide).toEqual({ state: 'decided', label: 'Decided' })
  })

  it('one reason per item: due proximity beats origin; decay is named', () => {
    expect(itemReason(wi({ dueAt: new Date(NOW - DAY).toISOString() }), NOW)).toBe('Past due')
    // Rewritten 2026-10-16 (help audit, "due labels a day off"): this pin used
    // NOW + 20 hours and expected "Due today", which is the bug itself whenever
    // those 20 hours cross local midnight. Labels now count calendar days, so the
    // pin uses a time later on NOW's own local day, and the next day.
    const laterToday = new Date(NOW)
    laterToday.setHours(23, 30, 0, 0)
    expect(itemReason(wi({ dueAt: laterToday.toISOString() }), Math.min(NOW, laterToday.getTime() - 60_000))).toBe(
      'Due today'
    )
    const tomorrowMorning = new Date(NOW)
    tomorrowMorning.setDate(tomorrowMorning.getDate() + 1)
    tomorrowMorning.setHours(9, 0, 0, 0)
    expect(itemReason(wi({ dueAt: tomorrowMorning.toISOString() }), NOW)).toBe('Due tomorrow')
    expect(itemReason(wi({ wiOrigin: 'ai' }), NOW)).toBe('Suggested by Plexii')
    expect(
      itemReason(wi({ wiOrigin: 'ai', dueAt: new Date(NOW + DAY).toISOString() }), NOW)
    ).toContain('Due')
    expect(itemReason(wi({ reasonCode: 'decayed' }), NOW)).toBe('Faded out quietly')
    expect(itemReason(wi({}), NOW)).toBeNull()
  })
})

describe('itemFullText — the whole capture, for reading and copying', () => {
  it('joins title and notes verbatim, with a blank line between', () => {
    expect(itemFullText({ title: 'Short title', description: 'The long note.' })).toBe(
      'Short title\n\nThe long note.'
    )
  })

  it('omits an empty half rather than leaving stray blank lines', () => {
    expect(itemFullText({ title: 'Only a title', description: '' })).toBe('Only a title')
    expect(itemFullText({ title: 'Only a title', description: '   ' })).toBe('Only a title')
    expect(itemFullText({ title: '', description: 'Only notes' })).toBe('Only notes')
  })

  it('does NOT truncate — the point is the unedited text', () => {
    const long = 'x'.repeat(500)
    expect(itemFullText({ title: long, description: long })).toHaveLength(1002)
  })
})

describe('DEC-045 — the desk-widget scope', () => {
  const deskItem = (id: string, parentId: string | null, state = 'open'): FbNode =>
    wi({ id, parentId, workItemState: state })

  it('scopes to the desk when it holds active items', () => {
    const items = [deskItem('a', 'd1'), deskItem('b', 'd2'), deskItem('c', null)]
    const r = scopeItemsForDesk(items, 'd1')
    expect(r.fellBack).toBe(false)
    expect(r.scoped.map((i) => i.id)).toEqual(['a'])
  })

  it('falls back to ALL when the desk holds nothing active — and says so', () => {
    const items = [deskItem('done', 'd1', 'completed'), deskItem('b', 'd2')]
    const r = scopeItemsForDesk(items, 'd1')
    expect(r.fellBack).toBe(true)
    expect(r.scoped).toHaveLength(2) // everything, terminal rows included for the shelves
  })

  it('a detached item does not keep an empty desk from falling back', () => {
    const items = [wi({ id: 'det', parentId: 'd1', detachedFromId: 'gone' }), deskItem('b', 'd2')]
    expect(scopeItemsForDesk(items, 'd1').fellBack).toBe(true)
  })
})

describe('DEC-047 (D-1) — desk clusters, derived from parentId', () => {
  const row = (id: string, parentId: string | null) => ({ item: wi({ id, parentId }) })

  it('a desk with 2+ rows in the section clusters; order of appearance holds', () => {
    const rows = [row('a', 'd1'), row('b', 'd2'), row('c', 'd1'), row('d', null)]
    const cs = clusterByDesk(rows)
    expect(cs.map((c) => c.deskId)).toEqual(['d1', null])
    expect(cs[0].rows.map((r) => r.item.id)).toEqual(['a', 'c'])
    // d2 (single) and the standalone flow together, flat, in order.
    expect(cs[1].rows.map((r) => r.item.id)).toEqual(['b', 'd'])
  })

  it('a single-item desk renders FLAT — its chips already name the desk', () => {
    const cs = clusterByDesk([row('a', 'd1'), row('b', null)])
    expect(cs).toHaveLength(1)
    expect(cs[0].deskId).toBeNull()
    expect(cs[0].rows.map((r) => r.item.id)).toEqual(['a', 'b'])
  })

  it('the ranker still leads: the first-ranked row decides cluster position', () => {
    const cs = clusterByDesk([row('top', null), row('a', 'd1'), row('b', 'd1')])
    expect(cs.map((c) => c.deskId)).toEqual([null, 'd1'])
  })

  it('empty in, empty out', () => {
    expect(clusterByDesk([])).toEqual([])
  })
})
