// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ensureWorkItemSchema, setWorkItemStateCore } from '../../src/main/db/workItems'
import { asAttentionItem } from '../../src/shared/attentionProjection'
import { statusForWorkItemState } from '../../src/shared/workItems'
import type { LifecycleDb } from '../../src/main/db/nodeLifecycle'
import type { FbNode } from '../../src/shared/types'

// The inline status control has to STICK.
//
// It did not: writing only `status` for a task looked like the careful choice
// (one truth per row) but status is a four-value coarsening, so "waiting",
// "blocked" and "delegated" all collapsed to 'open' and read back as "Not
// started". The state is the fact; status is its projection; both are written.

type Db = LifecycleDb & { exec(sql: string): void }

function freshDb(): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY, parent_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', trashed_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0);`)
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => {
      const st = raw.prepare(sql)
      return {
        run: (...a: unknown[]) => st.run(...(a as never[])),
        get: (...a: unknown[]) => st.get(...(a as never[])),
        all: (...a: unknown[]) => st.all(...(a as never[])) as unknown[]
      }
    }
  } as Db
  ensureWorkItemSchema(db)
  raw.exec("INSERT INTO nodes (id,parent_id,kind,title) VALUES ('desk',NULL,'task','Desk')")
  raw.exec("INSERT INTO nodes (id,parent_id,kind,title) VALUES ('t','desk','task','Task')")
  return { raw, db }
}

const rowOf = (raw: DatabaseSync, id: string) =>
  raw.prepare('SELECT status, work_item_state FROM nodes WHERE id = ?').get(id) as {
    status: string
    work_item_state: string | null
  }

const asShown = (raw: DatabaseSync, id: string): string | null | undefined => {
  const r = rowOf(raw, id)
  return asAttentionItem({
    id,
    kind: 'task',
    parentId: 'desk',
    title: 'Task',
    status: r.status,
    workItemState: r.work_item_state
  } as unknown as FbNode).workItemState
}

describe('every state the inline control offers survives a round trip', () => {
  // These are the states OPEN_STATUS_CHOICES offers. Three of them coarsen to
  // 'open', which is exactly why storing only the status lost them.
  it.each(['open', 'in_progress', 'waiting', 'blocked', 'delegated'])('%s sticks', (state) => {
    const { raw, db } = freshDb()
    expect(setWorkItemStateCore(db, 't', state as never)).toBe(true)
    expect(asShown(raw, 't')).toBe(state)
  })

  it('keeps status as a faithful projection of the state', () => {
    const { raw, db } = freshDb()
    for (const state of ['waiting', 'blocked', 'delegated', 'completed']) {
      setWorkItemStateCore(db, 't', state as never)
      const r = rowOf(raw, 't')
      expect(r.work_item_state).toBe(state)
      expect(r.status).toBe(statusForWorkItemState(state))
    }
  })

  it('distinguishes waiting from blocked, which both coarsen to open', () => {
    const { raw, db } = freshDb()
    setWorkItemStateCore(db, 't', 'waiting' as never)
    expect(rowOf(raw, 't').status).toBe('open')
    expect(asShown(raw, 't')).toBe('waiting')
    setWorkItemStateCore(db, 't', 'blocked' as never)
    expect(asShown(raw, 't')).toBe('blocked')
  })

  it('still refuses a desk', () => {
    const { db } = freshDb()
    expect(setWorkItemStateCore(db, 'desk', 'waiting' as never)).toBe(false)
  })
})
