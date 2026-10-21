// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Owner report (4.3.40): "I can't seem to assign a task." Found end to end
// (tests/e2e/focusTeamTasksLive.spec.ts, the picker test): the owner picked a
// member and saved, the save held on the owner's device, and the task never
// reached the member's Focus. The editor hands assigneeIds over as an array;
// the live path emitted it as one; the receiver bound it into SQL, and
// better-sqlite3 spreads an array argument into separate parameters. One
// assignee was stored as the bare id (not JSON, so json_each never matched
// it); two failed the write.

const emitted: Array<{ id: string; attrs: Record<string, unknown> }> = []
vi.mock('../../src/renderer/src/lib/crdtBridge', () => ({
  crdtEmitNodeCreate: vi.fn(),
  crdtEmitNodeTitle: vi.fn(),
  crdtEmitNodeAttrs: (id: string, attrs: Record<string, unknown>) => emitted.push({ id, attrs })
}))
vi.mock('../../src/renderer/src/lib/syncNudge', () => ({ nudgeSync: vi.fn() }))

import { normalizeAssigneeIds, parseAssigneeIds } from '../../src/shared/workItems'
import { ensureWorkItemSchema, mineClause, wireColumnValue } from '../../src/main/db/workItems'
import { useWorkItemStore } from '../../src/renderer/src/stores/workItems'
import type { LifecycleDb } from '../../src/main/db/nodeLifecycle'

type Db = LifecycleDb & { exec(sql: string): void }
function freshDb(): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY, parent_id TEXT,
    kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', priority INTEGER, interest INTEGER, importance INTEGER, sort_order INTEGER,
    created_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0, org_id TEXT NOT NULL DEFAULT 'personal',
    due_date INTEGER, archived INTEGER NOT NULL DEFAULT 0, trashed_at INTEGER)`)
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
  return { raw, db }
}

describe('an assignment travels in the form its column stores', () => {
  beforeEach(() => {
    emitted.length = 0
  })

  it('the editor\'s array is emitted as the normalised JSON string', async () => {
    const item = { id: 't1', kind: 'work_item', assigneeIds: '["acc_a","acc_b"]' }
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { workItems: { updateFields: vi.fn(async () => item) } },
      dispatchEvent: vi.fn()
    }
    ;(globalThis as unknown as { CustomEvent: unknown }).CustomEvent ??= class { constructor(public type: string) {} }
    useWorkItemStore.setState({ items: [item as never] })
    await useWorkItemStore.getState().updateFields('t1', { assigneeIds: ['acc_b', 'acc_a'] })
    expect(emitted).toEqual([{ id: 't1', attrs: { assigneeIds: '["acc_a","acc_b"]' } }])
    emitted.length = 0
    await useWorkItemStore.getState().updateFields('t1', { assigneeIds: [] })
    expect(emitted).toEqual([{ id: 't1', attrs: { assigneeIds: null } }])
  })

  it('a receiver stores whatever form arrives as that string, never an array or junk', () => {
    // 4.3.40 senders still emit the array.
    expect(wireColumnValue('assignee_ids', ['acc_m'])).toBe('["acc_m"]')
    expect(wireColumnValue('assignee_ids', ['acc_m', 'acc_g'])).toBe('["acc_g","acc_m"]')
    expect(wireColumnValue('assignee_ids', '["acc_m"]')).toBe('["acc_m"]')
    // What the bug left on the server.
    expect(wireColumnValue('assignee_ids', 'acc_m')).toBe('["acc_m"]')
    expect(wireColumnValue('assignee_ids', 'not a list')).toBeNull()
    expect(wireColumnValue('assignee_ids', [])).toBeNull()
    // Other columns pass through untouched.
    expect(wireColumnValue('intent_class', 'to_do')).toBe('to_do')
  })

  it('both inbound apply paths go through it', () => {
    const src = readFileSync(join(__dirname, '../../src/main/db/workItems.ts'), 'utf8')
    const attr = src.slice(src.indexOf('export function applyRemoteWorkItemAttr'))
    expect(attr.slice(0, 600)).toContain('wireColumnValue(def.column, value)')
    expect(src.match(/wireColumnValue\(def\.column, snapshot\[def\.attr\]\)/g)).toHaveLength(2)
  })
})

describe('an assignment stored bare by 4.3.40 still counts, and is repaired', () => {
  it('reads as that one person', () => {
    expect(normalizeAssigneeIds('acc_8adbb33cf1caccef1c324513')).toBe('["acc_8adbb33cf1caccef1c324513"]')
    expect(parseAssigneeIds('acc_m')).toEqual(['acc_m'])
    // Only an account id qualifies; other junk is still junk.
    expect(normalizeAssigneeIds('not json')).toBeUndefined()
  })

  it('the assignee sees it in their Focus', () => {
    const { raw } = freshDb()
    raw.prepare("INSERT INTO nodes (id, kind, title, org_id, assignee_ids, originator_id) VALUES ('bare', 'work_item', 'x', 'org_1', 'acc_m', 'acc_owner')").run()
    const m = mineClause('acc_m')
    const rows = raw.prepare(`SELECT n.id FROM nodes n WHERE 1 = 1${m.sql}`).all(...m.args) as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual(['bare'])
    const other = mineClause('acc_someone_else')
    expect(raw.prepare(`SELECT n.id FROM nodes n WHERE 1 = 1${other.sql}`).all(...other.args)).toEqual([])
  })

  it('start-up turns it into the JSON array, once', () => {
    const { raw, db } = freshDb()
    raw.prepare("INSERT INTO nodes (id, kind, title, org_id, assignee_ids) VALUES ('bare', 'work_item', 'x', 'org_1', 'acc_m')").run()
    raw.prepare("INSERT INTO nodes (id, kind, title, org_id, assignee_ids) VALUES ('ok', 'work_item', 'y', 'org_1', '[\"acc_a\"]')").run()
    ensureWorkItemSchema(db)
    ensureWorkItemSchema(db)
    const got = raw.prepare('SELECT id, assignee_ids FROM nodes ORDER BY id').all()
    expect(got).toEqual([
      { id: 'bare', assignee_ids: '["acc_m"]' },
      { id: 'ok', assignee_ids: '["acc_a"]' }
    ])
  })
})
