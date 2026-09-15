// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ensureWorkItemSchema, setWorkItemStateCore } from '../../src/main/db/workItems'
import { statusForWorkItemState } from '../../src/shared/workItems'
import type { LifecycleDb } from '../../src/main/db/nodeLifecycle'

// One record, not two.
//
// A task on a desk is an item in Attention, and closing it from either side
// writes the SAME row. These lock the boundary that makes that safe: a desk is
// itself kind='task', and a desk is not an item to be done, so the write path
// must accept a task filed on a desk and refuse the desk above it. Read and
// write apply the identical rule -- if they ever diverge, an item Attention
// cannot show could still be closed through it.

type Db = LifecycleDb & { exec(sql: string): void }

function freshDb(): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('folder', 'task', 'task-item', 'work_item')),
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
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
  raw.exec("INSERT INTO nodes (id, parent_id, kind, title) VALUES ('sub', 'task', 'task', 'A step')")
  return { raw, db }
}

const statusOf = (raw: DatabaseSync, id: string): string =>
  (raw.prepare('SELECT status FROM nodes WHERE id = ?').get(id) as { status: string }).status
const wiStateOf = (raw: DatabaseSync, id: string): string | null =>
  (raw.prepare('SELECT work_item_state FROM nodes WHERE id = ?').get(id) as {
    work_item_state: string | null
  }).work_item_state

describe('closing a desk task from Attention', () => {
  it('writes the task status on the same row', () => {
    const { raw, db } = freshDb()
    expect(setWorkItemStateCore(db, 'task', 'completed')).toBe(true)
    expect(statusOf(raw, 'task')).toBe('done')
  })

  it('writes the state AND its status projection, which are one fact', () => {
    // This test used to assert the opposite -- that a task carried no
    // work_item_state -- on the reasoning that a second column meant a second
    // truth. That reasoning was wrong, and it caused a real bug: `status` is a
    // four-value coarsening, so waiting / blocked / delegated all collapsed
    // into 'open' and the inline status control silently did not stick.
    //
    // There is only one fact as long as nothing sets status independently:
    // the state, and status as its projection. updateNode enforces the other
    // half by clearing a state a direct status write has contradicted.
    const { raw, db } = freshDb()
    setWorkItemStateCore(db, 'task', 'waiting')
    expect(wiStateOf(raw, 'task')).toBe('waiting')
    expect(statusOf(raw, 'task')).toBe(statusForWorkItemState('waiting'))
  })

  it('keeps states that coarsen to the same status distinguishable', () => {
    const { raw, db } = freshDb()
    setWorkItemStateCore(db, 'task', 'waiting')
    expect(statusOf(raw, 'task')).toBe('open')
    setWorkItemStateCore(db, 'task', 'blocked')
    expect(statusOf(raw, 'task')).toBe('open')
    // Same coarse status, different fact — which is the whole point.
    expect(wiStateOf(raw, 'task')).toBe('blocked')
  })

  it('works on a subtask, which is still work on a desk', () => {
    const { raw, db } = freshDb()
    expect(setWorkItemStateCore(db, 'sub', 'completed')).toBe(true)
    expect(statusOf(raw, 'sub')).toBe('done')
  })

  it('maps a dismissal to parked rather than done', () => {
    const { raw, db } = freshDb()
    setWorkItemStateCore(db, 'task', 'dismissed')
    expect(statusOf(raw, 'task')).toBe('parked')
  })

  it('refuses the desk itself', () => {
    // 'desk' is kind='task' with a folder parent. A desk is not an item to do,
    // and Attention never lists it, so it must not be closable through it.
    const { raw, db } = freshDb()
    expect(setWorkItemStateCore(db, 'desk', 'completed')).toBe(false)
    expect(statusOf(raw, 'desk')).toBe('open')
  })

  it('refuses a task with no parent at all', () => {
    const { raw, db } = freshDb()
    raw.exec("INSERT INTO nodes (id, parent_id, kind, title) VALUES ('loose', NULL, 'task', 'Loose')")
    expect(setWorkItemStateCore(db, 'loose', 'completed')).toBe(false)
  })

  it('still refuses an unknown state', () => {
    const { db } = freshDb()
    expect(setWorkItemStateCore(db, 'task', 'bogus' as never)).toBe(false)
  })

  it('leaves work_items on their own state machine, untouched', () => {
    const { raw, db } = freshDb()
    raw.exec(
      "INSERT INTO nodes (id, kind, title, work_item_state) VALUES ('wi', 'work_item', 'Call Bob', 'open')"
    )
    expect(setWorkItemStateCore(db, 'wi', 'needs_review')).toBe(true)
    expect(wiStateOf(raw, 'wi')).toBe('needs_review')
    expect(statusOf(raw, 'wi')).toBe('in_progress')
  })
})
