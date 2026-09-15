// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ensureTaskPlanningSchema } from '../../src/main/db/taskPlanningSchema'
import { TASK_PLANNING_COLUMNS } from '../../src/shared/taskPlanning'

// The DEC-064 failure mode, guarded: a column can have DDL and a writer and
// still be unreadable. These drive real SQLite, so "it stored fine" and "it
// comes back" are checked separately.

function dbWithNodes(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      due_date INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
  return d
}

const adapt = (d: DatabaseSync) => ({
  prepare: (sql: string) => ({ all: () => d.prepare(sql).all() as unknown[] }),
  exec: (sql: string) => d.exec(sql)
})

const columnsOf = (d: DatabaseSync): Set<string> =>
  new Set((d.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((c) => c.name))

describe('ensureTaskPlanningSchema', () => {
  it('adds every manifest column to a database that predates them', () => {
    const d = dbWithNodes()
    for (const c of TASK_PLANNING_COLUMNS) expect(columnsOf(d).has(c.column)).toBe(false)
    ensureTaskPlanningSchema(adapt(d))
    for (const c of TASK_PLANNING_COLUMNS) expect(columnsOf(d).has(c.column)).toBe(true)
  })

  it('is idempotent — a second run is not an error', () => {
    const d = dbWithNodes()
    ensureTaskPlanningSchema(adapt(d))
    expect(() => ensureTaskPlanningSchema(adapt(d))).not.toThrow()
    expect(() => ensureTaskPlanningSchema(adapt(d))).not.toThrow()
  })

  it('leaves existing rows meaning exactly what they meant', () => {
    const d = dbWithNodes()
    d.prepare(
      `INSERT INTO nodes (id, parent_id, kind, title, created_at, updated_at)
       VALUES ('t1', null, 'task', 'Existing work', 1, 1)`
    ).run()
    ensureTaskPlanningSchema(adapt(d))
    const row = d.prepare('SELECT * FROM nodes WHERE id = ?').get('t1') as Record<string, unknown>
    // No invented start date, no invented assignee: an untouched task is
    // unplanned, not planned-for-now.
    for (const c of TASK_PLANNING_COLUMNS) expect(row[c.column]).toBeNull()
    expect(row.title).toBe('Existing work')
  })

  it('round-trips every planning value through real SQLite', () => {
    const d = dbWithNodes()
    ensureTaskPlanningSchema(adapt(d))
    d.prepare(
      `INSERT INTO nodes (id, parent_id, kind, title, created_at, updated_at)
       VALUES ('t1', null, 'task', 'Plan me', 1, 1)`
    ).run()
    const attachments = JSON.stringify([{ id: 'f1', name: 'contract.pdf' }])
    d.prepare(
      `UPDATE nodes SET planned_start_at = ?, assignee = ?, depends_on = ?,
        lag_days = ?, attachments_json = ? WHERE id = 't1'`
    ).run(1700000000000, 'Sarah Whitfield', 't0', -2, attachments)

    const row = d.prepare('SELECT * FROM nodes WHERE id = ?').get('t1') as Record<string, unknown>
    expect(row.planned_start_at).toBe(1700000000000)
    expect(row.assignee).toBe('Sarah Whitfield')
    expect(row.depends_on).toBe('t0')
    expect(row.lag_days).toBe(-2) // negative lag must survive, it means overlap
    expect(row.attachments_json).toBe(attachments)
  })
})
