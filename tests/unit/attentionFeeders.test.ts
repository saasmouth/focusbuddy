// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { FbNode } from '../../src/shared/types'
import {
  deskDueSignals,
  deskStaleSignals,
  feederSignals,
  mutedCountOfKind
} from '../../src/renderer/src/lib/attentionFeeders'
import {
  ensureWorkItemSchema,
  postDeadlineNudgesCore,
  sourceTypeSuppressedCore,
  SOURCE_SUPPRESS_THRESHOLD
} from '../../src/main/db/workItems'
import { ensureNotificationSchema, sweepDeliveries } from '../../src/main/notifications/substrate'
import type { LifecycleDb } from '../../src/main/db/nodeLifecycle'

// S7 — the feeders (one-directional desk→attention signals), the single
// proactive nudge trigger (deadline proximity, once per item per due-day),
// and Δ10's source-type suppression.

const NOW = Date.parse('2026-08-25T10:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function desk(over: Partial<FbNode>): FbNode {
  return {
    id: Math.random().toString(36).slice(2),
    parentId: null,
    kind: 'task',
    title: 'Desk',
    description: '',
    status: 'open',
    priority: 3,
    interest: 3,
    importance: 3,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
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
    ...over
  } as FbNode
}

describe('feeders — desks surface AS attention, computed and one-directional', () => {
  it('due signals: open desks due within 7 days, urgency-ordered; done/archived/far excluded', () => {
    const nodes = [
      desk({ id: 'overdue', dueDate: NOW - DAY }),
      desk({ id: 'soon', dueDate: NOW + DAY }),
      desk({ id: 'far', dueDate: NOW + 20 * DAY }),
      desk({ id: 'done', dueDate: NOW + DAY, status: 'done' }),
      desk({ id: 'archived', dueDate: NOW + DAY, archived: true }),
      desk({ id: 'undated' })
    ]
    const s = deskDueSignals(nodes, NOW)
    expect(s.map((x) => x.id)).toEqual(['overdue', 'soon'])
    expect(s[0].line).toBe('Past due')
    expect(s[1].line).toBe('Due tomorrow')
  })

  it('DEC-020 — plan due dates join the feeders: roots and plan items, distinct kind', () => {
    const nodes = [
      desk({ id: 'plan', kind: 'folder', isPlan: true, title: 'Launch', dueDate: NOW + DAY }),
      desk({ id: 'sub', kind: 'folder', parentId: 'plan', title: 'Phase 2' }),
      desk({ id: 'inPlan', parentId: 'sub', title: 'Ship it', dueDate: NOW + 2 * DAY }),
      desk({ id: 'plain', title: 'Solo desk', dueDate: NOW + 3 * DAY }),
      desk({ id: 'planFar', kind: 'folder', isPlan: true, dueDate: NOW + 20 * DAY }),
      desk({ id: 'planDone', kind: 'folder', isPlan: true, dueDate: NOW + DAY, status: 'done' }),
      desk({ id: 'plainFolder', kind: 'folder', dueDate: NOW + DAY }) // non-plan folder: no signal
    ]
    const s = deskDueSignals(nodes, NOW)
    expect(s.map((x) => `${x.kind}:${x.id}`)).toEqual(['plan-due:plan', 'plan-due:inPlan', 'desk-due:plain'])
    const root = s[0]
    expect(root.line).toBe('Plan due tomorrow')
    expect(root.target).toBe('plan')
    const item = s[1]
    expect(item.line).toBe('Due in 2 days · Launch') // plan name resolved through the nested folder
    expect(item.target).toBe('desk')
    // Whole-kind mutes stay independent: plan-due silenced, desk-due untouched.
    const muted = feederSignals(nodes, [], NOW, new Set(['kind:plan-due']))
    expect(muted.map((x) => x.id)).toEqual(['plain'])
  })

  it('mutes silence one signal or a whole kind; counts drive the Δ10 offer', () => {
    const nodes = [desk({ id: 'a', dueDate: NOW + DAY }), desk({ id: 'b', dueDate: NOW + 2 * DAY })]
    const stale = [{ id: 's1', title: 'Quiet', daysQuiet: 9 }]
    const none = feederSignals(nodes, stale, NOW, new Set())
    expect(none).toHaveLength(3)
    const oneMuted = feederSignals(nodes, stale, NOW, new Set(['desk-due:a']))
    expect(oneMuted.map((x) => x.id).sort()).toEqual(['b', 's1'])
    const kindMuted = feederSignals(nodes, stale, NOW, new Set(['kind:desk-due']))
    expect(kindMuted.map((x) => x.id)).toEqual(['s1'])
    expect(mutedCountOfKind(new Set(['desk-due:a', 'desk-due:b', 'desk-stale:x']), 'desk-due')).toBe(2)
    expect(deskStaleSignals(stale)[0].line).toBe('Quiet for 9 days')
  })
})

type Db = LifecycleDb & { exec(sql: string): void }
function freshDb(): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      -- parent_id, due_date, archived: the real nodes columns the DEC-144
      -- desk-task arm of the deadline sweep reads.
      parent_id TEXT, due_date INTEGER, archived INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open', trashed_at INTEGER,
      org_id TEXT NOT NULL DEFAULT 'personal', updated_at INTEGER NOT NULL DEFAULT 0
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
  ensureNotificationSchema(db)
  return { raw, db }
}

describe('the deadline nudge — once per item per due-day, capped substrate', () => {
  it('posts for actionable items due within 24h; dedupes on re-sweep; skips terminal/far/fyi', () => {
    const { raw, db } = freshDb()
    const dueSoon = new Date(NOW + 6 * 60 * 60 * 1000).toISOString()
    const ins = raw.prepare(
      "INSERT INTO nodes (id, kind, title, work_item_state, intent_class, due_at) VALUES (?, 'work_item', ?, ?, ?, ?)"
    )
    ins.run('a', 'Call Bob', 'open', 'to_do', dueSoon)
    ins.run('fyi', 'Note', 'open', 'to_know', dueSoon)
    ins.run('done', 'Done one', 'completed', 'to_do', dueSoon)
    ins.run('far', 'Later', 'open', 'to_do', new Date(NOW + 5 * DAY).toISOString())
    expect(postDeadlineNudgesCore(db, NOW)).toBe(1)
    expect(postDeadlineNudgesCore(db, NOW + 60_000)).toBe(0) // once EVER per due-day
    const out = sweepDeliveries(db, NOW + 120_000)
    expect(out.filter((d) => d.queue === 'to_do')).toHaveLength(1)
  })
})

describe('DEC-144 — desk tasks are in Focus, so they nudge and never double-list', () => {
  it('a task filed on a desk, due within 24h, gets the same deadline nudge', () => {
    const { raw, db } = freshDb()
    raw.exec("INSERT INTO nodes (id, kind, title) VALUES ('desk', 'task', 'A desk')")
    const ins = raw.prepare("INSERT INTO nodes (id, parent_id, kind, title, status, due_date) VALUES (?, ?, 'task', ?, ?, ?)")
    ins.run('soon', 'desk', 'Send the deck', 'open', NOW + 6 * 60 * 60 * 1000)
    ins.run('closed', 'desk', 'Already done', 'done', NOW + 6 * 60 * 60 * 1000)
    ins.run('far', 'desk', 'Next week', 'open', NOW + 5 * DAY)
    // The desk itself is not an item, even with a due date.
    raw.exec(`UPDATE nodes SET due_date = ${NOW + 60 * 60 * 1000} WHERE id = 'desk'`)
    expect(postDeadlineNudgesCore(db, NOW)).toBe(1)
    expect(postDeadlineNudgesCore(db, NOW + 60_000)).toBe(0)
  })

  it('deskDueSignals skips a task filed on a desk (it is already listed as itself)', () => {
    const desk = { id: 'd', kind: 'task', title: 'Desk', status: 'open', parentId: null, dueDate: NOW + DAY } as FbNode
    const task = { id: 't', kind: 'task', title: 'Task', status: 'open', parentId: 'd', dueDate: NOW + DAY } as FbNode
    expect(deskDueSignals([desk, task], NOW).map((s) => s.id)).toEqual(['d'])
  })
})

describe('DEC-024 — the FYI deadline backstop', () => {
  it('a dated FYI nudges ONCE when its date arrives — not before, not for ancient dates', () => {
    const { raw, db } = freshDb()
    const ins = raw.prepare(
      "INSERT INTO nodes (id, kind, title, work_item_state, intent_class, due_at) VALUES (?, 'work_item', ?, 'open', 'to_know', ?)"
    )
    ins.run('arrived', 'Policy changes today', new Date(NOW - 2 * 60 * 60 * 1000).toISOString())
    ins.run('future', 'Later note', new Date(NOW + 3 * DAY).toISOString())
    ins.run('ancient', 'Pre-feature note', new Date(NOW - 10 * DAY).toISOString())
    // Only the arrived one posts; the future FYI is never "due soon".
    expect(postDeadlineNudgesCore(db, NOW)).toBe(1)
    // Once EVER per due-day: a re-sweep is silent.
    expect(postDeadlineNudgesCore(db, NOW + 60_000)).toBe(0)
    const out = sweepDeliveries(db, NOW + 120_000)
    const fyi = out.filter((d) => d.queue === 'to_know')
    expect(fyi).toHaveLength(1)
    expect(fyi[0].body).toContain('date arrived')
  })

  it('archived and terminal FYIs never backstop-nudge', () => {
    const { raw, db } = freshDb()
    const due = new Date(NOW - 60 * 60 * 1000).toISOString()
    const ins = raw.prepare(
      "INSERT INTO nodes (id, kind, title, work_item_state, intent_class, due_at) VALUES (?, 'work_item', 'x', ?, 'to_know', ?)"
    )
    ins.run('shelved', 'archived', due)
    ins.run('acked', 'acknowledged', due)
    expect(postDeadlineNudgesCore(db, NOW)).toBe(0)
  })
})

describe('Δ10 — source-type suppression (main half)', () => {
  it('suppresses only after the last N AI-suggested items of a source were ALL dismissed', () => {
    const { raw, db } = freshDb()
    const ins = raw.prepare(
      "INSERT INTO nodes (id, kind, title, work_item_state, source_type, wi_origin, approval_state, updated_at) VALUES (?, 'work_item', 'x', ?, ?, 'ai', 'suggested', ?)"
    )
    // Two dismissals — below threshold.
    ins.run('m1', 'dismissed', 'mail', 1)
    ins.run('m2', 'dismissed', 'mail', 2)
    expect(sourceTypeSuppressedCore(db, 'mail', 'personal')).toBe(false)
    // Third dismissal → suppressed.
    ins.run('m3', 'dismissed', 'mail', 3)
    expect(sourceTypeSuppressedCore(db, 'mail', 'personal')).toBe(true)
    // An acceptance among the recent set breaks the streak.
    ins.run('m4', 'completed', 'mail', 4)
    expect(sourceTypeSuppressedCore(db, 'mail', 'personal')).toBe(false)
    // Other sources unaffected.
    expect(sourceTypeSuppressedCore(db, 'browser', 'personal')).toBe(false)
  })
})
