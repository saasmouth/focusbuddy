// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  assertNotWorkItemRoot,
  assertParentAcceptsChildren,
  collectActiveSubtree,
  detachAndReviveWorkItemDescendants,
  listTrashedRoots,
  pruneSharedRows,
  purgeExpiredTrash,
  restoreTrashedTree,
  WorkItemDeleteRefusedError,
  WorkItemParentRefusedError,
  type LifecycleDb
} from '../../src/main/db/nodeLifecycle'

// ARCHITECTURE §2.5.4 — the five adversarial cases (a)–(e), run against the
// REAL lifecycle mechanics on a post-migration schema shape (4-kind CHECK,
// FK cascade ON). The cascade cannot be kind-filtered, so these tests are the
// proof that no delete path can destroy a work_item.

function freshDb(): { raw: DatabaseSync; db: LifecycleDb } {
  const raw = new DatabaseSync(':memory:')
  raw.exec('PRAGMA foreign_keys=on')
  raw.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('folder', 'task', 'task-item', 'work_item')),
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      trashed_at INTEGER,
      deleted_elsewhere_at INTEGER,
      deleted_by_name TEXT,
      shared_root_id TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE widgets (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      shared_root_id TEXT
    );
  `)
  const db: LifecycleDb = {
    prepare: (sql) => {
      const s = raw.prepare(sql)
      return {
        run: (...a: unknown[]) => s.run(...(a as never[])),
        get: (...a: unknown[]) => s.get(...(a as never[])),
        all: (...a: unknown[]) => s.all(...(a as never[])) as unknown[]
      }
    }
  }
  return { raw, db }
}

const node = (
  raw: DatabaseSync,
  id: string,
  kind: string,
  parentId: string | null = null,
  extra: Partial<{ trashed_at: number; shared_root_id: string }> = {}
): void => {
  raw
    .prepare(
      'INSERT INTO nodes (id, parent_id, kind, title, trashed_at, shared_root_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, parentId, kind, `${kind} ${id}`, extra.trashed_at ?? null, extra.shared_root_id ?? null)
}

const row = (raw: DatabaseSync, id: string): { parent_id: string | null; trashed_at: number | null } | undefined =>
  raw.prepare('SELECT parent_id, trashed_at FROM nodes WHERE id = ?').get(id) as never

describe('§2.5.4 case (a) — trash → undo is bit-lossless, device-scoped', () => {
  it('a trashed desk+work_item restores bit-identically, parent included', () => {
    const { raw, db } = freshDb()
    node(raw, 'desk', 'task')
    node(raw, 'wi', 'work_item', 'desk')
    // trash sweeps normally, work_item INCLUDED (§2.5.1)
    const ids = collectActiveSubtree(db, 'desk')
    expect(ids.sort()).toEqual(['desk', 'wi'])
    raw.exec("UPDATE nodes SET trashed_at = 1000 WHERE id IN ('desk','wi')")
    // undo restores exactly those ids
    for (const id of ids) raw.prepare('UPDATE nodes SET trashed_at = NULL WHERE id = ?').run(id)
    expect(row(raw, 'wi')).toEqual({ parent_id: 'desk', trashed_at: null })
  })

  it('device-B arm: purge on A then restore on B leaves the item detached, never re-attached', () => {
    const { raw, db } = freshDb()
    node(raw, 'desk', 'task')
    node(raw, 'wi', 'work_item', 'desk')
    raw.exec("UPDATE nodes SET trashed_at = 1000 WHERE id IN ('desk','wi')")
    // device A's purge fires: desk hard-deleted, work_item revived detached
    const res = purgeExpiredTrash(db, 2000)
    expect(res).toEqual({ purged: 1, revived: 1 })
    expect(row(raw, 'desk')).toBeUndefined()
    expect(row(raw, 'wi')).toEqual({ parent_id: null, trashed_at: null })
    // device B's undo (restoreNodes semantics: flip trashed_at by id) — the
    // work_item is no longer trashed and its parent is gone; restore must NOT
    // re-attach it. Simulate B's restore of its remembered undo set:
    raw.prepare('UPDATE nodes SET trashed_at = NULL WHERE id = ?').run('wi')
    expect(row(raw, 'wi')).toEqual({ parent_id: null, trashed_at: null })
  })
})

describe('§2.5.4 case (b) — purge never targets work_items (F-C1″)', () => {
  it('a 7-day purge deletes the desk subtree but revives the work_item, detached', () => {
    const { raw, db } = freshDb()
    node(raw, 'desk', 'task')
    node(raw, 'room', 'folder', 'desk')
    node(raw, 'wi', 'work_item', 'room') // nested under a trashed chain
    raw.prepare('INSERT INTO widgets (id, task_id) VALUES (?, ?)').run('w1', 'desk')
    raw.exec("UPDATE nodes SET trashed_at = 500 WHERE id IN ('desk','room','wi')")
    const res = purgeExpiredTrash(db, 1000)
    expect(res.revived).toBe(1)
    // desk + room hard-deleted, widget cascaded, work_item alive + detached
    expect(row(raw, 'desk')).toBeUndefined()
    expect(row(raw, 'room')).toBeUndefined()
    expect(raw.prepare("SELECT 1 FROM widgets WHERE id = 'w1'").get()).toBeUndefined()
    expect(row(raw, 'wi')).toEqual({ parent_id: null, trashed_at: null })
  })

  it('a directly-trashed work_item is NEVER selected as a purge target', () => {
    const { raw, db } = freshDb()
    node(raw, 'wi', 'work_item', null, { trashed_at: 100 })
    const res = purgeExpiredTrash(db, 99999)
    expect(res).toEqual({ purged: 0, revived: 0 })
    // still present (still trashed — revival is only for descendants of targets)
    expect(row(raw, 'wi')).toEqual({ parent_id: null, trashed_at: 100 })
  })
})

describe('§2.5.4 cases (c)+(d) — pruneSharedRows spares both exposure states', () => {
  it('(c) un-stamped work_item under a pruned shared desk survives, detached', () => {
    const { raw, db } = freshDb()
    node(raw, 'shared-desk', 'task', null, { shared_root_id: 'shared-desk' })
    node(raw, 'wi', 'work_item', 'shared-desk') // NOT stamped (§2.6 guard kept it personal)
    raw.prepare('INSERT INTO widgets (id, task_id, shared_root_id) VALUES (?, ?, ?)').run('w1', 'shared-desk', 'shared-desk')
    const removed = pruneSharedRows(db, 'shared-desk', ['widgets', 'nodes'])
    expect(removed).toBe(2) // the desk row + its widget
    expect(row(raw, 'shared-desk')).toBeUndefined()
    expect(row(raw, 'wi')).toEqual({ parent_id: null, trashed_at: null })
  })

  it('(d) STAMPED work_item (the P1 routed case) survives the prune outright', () => {
    const { raw, db } = freshDb()
    node(raw, 'shared-desk', 'task', null, { shared_root_id: 'shared-desk' })
    node(raw, 'wi', 'work_item', 'shared-desk', { shared_root_id: 'shared-desk' })
    pruneSharedRows(db, 'shared-desk', ['nodes'])
    expect(row(raw, 'shared-desk')).toBeUndefined()
    // matched shared_root_id directly, but the kind exclusion spared it
    expect(row(raw, 'wi')).toEqual({ parent_id: null, trashed_at: null })
  })
})

describe('§2.5.4 case (e) — direct delete of a work_item root refuses, typed', () => {
  it('assertNotWorkItemRoot throws the typed refusal on work_items only', () => {
    const { raw, db } = freshDb()
    node(raw, 'desk', 'task')
    node(raw, 'wi', 'work_item')
    expect(() => assertNotWorkItemRoot(db, 'wi')).toThrow(WorkItemDeleteRefusedError)
    try {
      assertNotWorkItemRoot(db, 'wi')
    } catch (e) {
      expect((e as WorkItemDeleteRefusedError).code).toBe('WORK_ITEM_DELETE_REFUSED')
    }
    expect(() => assertNotWorkItemRoot(db, 'desk')).not.toThrow()
    expect(() => assertNotWorkItemRoot(db, 'missing')).not.toThrow()
  })
})

describe('§2.5.5 — the leaf invariant at parent_id writers', () => {
  it('a work_item can never be a parent; desks and top level can', () => {
    const { raw, db } = freshDb()
    node(raw, 'desk', 'task')
    node(raw, 'wi', 'work_item')
    expect(() => assertParentAcceptsChildren(db, 'wi')).toThrow(WorkItemParentRefusedError)
    expect(() => assertParentAcceptsChildren(db, 'desk')).not.toThrow()
    expect(() => assertParentAcceptsChildren(db, null)).not.toThrow()
  })
})

describe('trash surfacing (lifecycle L1)', () => {
  it('lists trashed ROOTS only; children travel with their parent; work_items excluded', () => {
    const { raw, db } = freshDb()
    raw.exec("ALTER TABLE nodes ADD COLUMN org_id TEXT NOT NULL DEFAULT 'personal'")
    node(raw, 'room', 'folder', null, { trashed_at: 100 })
    node(raw, 'desk', 'task', 'room', { trashed_at: 100 }) // child — not a root
    node(raw, 'live-parent-desk', 'task')
    node(raw, 'orphan-child', 'task', 'live-parent-desk', { trashed_at: 200 }) // parent live → root
    node(raw, 'wi', 'work_item', 'room', { trashed_at: 100 }) // never listed
    const roots = listTrashedRoots(db, 'personal').map((r) => r.id)
    expect(roots.sort()).toEqual(['orphan-child', 'room'])
  })

  it('restoreTrashedTree restores the root and its whole trashed subtree, work_items included', () => {
    const { raw, db } = freshDb()
    node(raw, 'room', 'folder', null, { trashed_at: 100 })
    node(raw, 'desk', 'task', 'room', { trashed_at: 100 })
    node(raw, 'wi', 'work_item', 'desk', { trashed_at: 100 })
    node(raw, 'untouched', 'task', null, { trashed_at: 500 }) // different root — stays trashed
    const ids = restoreTrashedTree(db, 'room')
    expect(ids.sort()).toEqual(['desk', 'room', 'wi'])
    expect(row(raw, 'wi')).toEqual({ parent_id: 'desk', trashed_at: null }) // lossless, §2.5.1
    expect(row(raw, 'untouched')?.trashed_at).toBe(500)
    expect(restoreTrashedTree(db, 'room')).toEqual([]) // already live — no-op
  })
})

describe('detach hook seam (S2 wires wi_local.detached_from_id here)', () => {
  it('reports each detached item with its former parent', () => {
    const { raw, db } = freshDb()
    node(raw, 'desk', 'task')
    node(raw, 'wi', 'work_item', 'desk')
    const seen: Array<[string, string | null]> = []
    detachAndReviveWorkItemDescendants(db, ['desk'], {
      onDetached: (id, from) => seen.push([id, from])
    })
    expect(seen).toEqual([['wi', 'desk']])
  })
})
