// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ensureWorkItemSchema, createWorkItemCore, updateWorkItemFieldsCore, mineClause } from '../../src/main/db/workItems'
import { normalizeAssigneeIds, parseAssigneeIds, MAX_ASSIGNEES, WORK_ITEM_COLUMNS } from '../../src/shared/workItems'
import { taskAttrsForItemPatch } from '../../src/shared/attentionProjection'
import { orgOfPartition } from '../../src/renderer/src/lib/syncFlags'
import type { LifecycleDb } from '../../src/main/db/nodeLifecycle'

// DEC-144 — Focus tasks in a team workspace, assigned to several people.

type Db = LifecycleDb & { exec(sql: string): void }

function freshDb(): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('folder', 'task', 'task-item', 'work_item')),
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER, interest INTEGER, importance INTEGER, sort_order INTEGER,
      created_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 0,
      org_id TEXT NOT NULL DEFAULT 'personal',
      due_date INTEGER, archived INTEGER NOT NULL DEFAULT 0, trashed_at INTEGER
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
  return { raw, db }
}

describe('the assignee list has one serialization', () => {
  it('dedupes, trims and sorts; empty is null', () => {
    expect(normalizeAssigneeIds(['b', ' a ', 'b'])).toBe('["a","b"]')
    expect(normalizeAssigneeIds('["z","y"]')).toBe('["y","z"]')
    expect(normalizeAssigneeIds([])).toBeNull()
    expect(normalizeAssigneeIds(null)).toBeNull()
    expect(normalizeAssigneeIds('')).toBeNull()
  })
  it('refuses what is not a list of ids', () => {
    expect(normalizeAssigneeIds('not json')).toBeUndefined()
    expect(normalizeAssigneeIds({ a: 1 })).toBeUndefined()
    expect(normalizeAssigneeIds(['a', 3])).toBeUndefined()
    expect(normalizeAssigneeIds(Array.from({ length: MAX_ASSIGNEES + 1 }, (_, i) => `p${i}`))).toBeUndefined()
  })
  it('parses back to ids, [] for junk', () => {
    expect(parseAssigneeIds('["a","b"]')).toEqual(['a', 'b'])
    expect(parseAssigneeIds('junk')).toEqual([])
  })
  it('is a manifest column, so it syncs, emits and patches like the rest', () => {
    expect(WORK_ITEM_COLUMNS.find((c) => c.column === 'assignee_ids')).toMatchObject({ attr: 'assigneeIds', rendererEmitted: true })
  })
})

describe('a team workspace holds Focus tasks', () => {
  it('creates a task in an org with its assignees, no longer refused as personal-only', () => {
    const { raw, db } = freshDb()
    const { id } = createWorkItemCore(db, { title: 'Book the venue', assigneeIds: ['acct_b', 'acct_a'], originatorId: 'acct_me' }, 'org_1')
    const row = raw.prepare('SELECT org_id, assignee_ids, originator_id FROM nodes WHERE id = ?').get(id) as Record<string, unknown>
    expect(row).toEqual({ org_id: 'org_1', assignee_ids: '["acct_a","acct_b"]', originator_id: 'acct_me' })
  })
  it('refuses a malformed assignee list at create and at edit', () => {
    const { db } = freshDb()
    expect(() => createWorkItemCore(db, { title: 'x', assigneeIds: 'nope' }, 'org_1')).toThrow(/list of people/)
    const { id } = createWorkItemCore(db, { title: 'x' }, 'org_1')
    expect(updateWorkItemFieldsCore(db, id, { assigneeIds: 'nope' })).toBe(false)
    expect(updateWorkItemFieldsCore(db, id, { assigneeIds: ['acct_z', 'acct_y'] })).toBe(true)
  })
  it('a desk task takes assignees in its own column', () => {
    expect(taskAttrsForItemPatch({ assigneeIds: ['b', 'a'] })).toEqual({ assigneeIds: '["a","b"]' })
    expect(taskAttrsForItemPatch({ assigneeIds: 'junk' })).toBeNull()
  })
})

describe('your Focus in a team workspace is the tasks that are yours', () => {
  const seed = (raw: DatabaseSync): void => {
    const ins = raw.prepare(
      "INSERT INTO nodes (id, parent_id, kind, title, org_id, assignee_ids, originator_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    ins.run('assigned-me', null, 'work_item', 'a', 'org_1', '["me","you"]', 'you')
    ins.run('assigned-you', null, 'work_item', 'b', 'org_1', '["you"]', 'me')
    ins.run('unassigned-mine', null, 'work_item', 'c', 'org_1', null, 'me')
    ins.run('unassigned-yours', null, 'work_item', 'd', 'org_1', '[]', 'you')
    ins.run('legacy', null, 'work_item', 'e', 'org_1', null, null)
    ins.run('personal', null, 'work_item', 'f', 'personal', '["you"]', 'you')
    ins.run('junk', null, 'work_item', 'g', 'org_1', 'not json', 'you')
  }
  const ids = (raw: DatabaseSync, self: string | null): string[] => {
    const m = mineClause(self)
    return (raw.prepare(`SELECT n.id FROM nodes n WHERE 1 = 1${m.sql} ORDER BY n.id`).all(...m.args) as Array<{ id: string }>).map(
      (r) => r.id
    )
  }
  it('assigned to me, or unassigned and raised by me (or by nobody recorded)', () => {
    const { raw } = freshDb()
    seed(raw)
    expect(ids(raw, 'me')).toEqual(['assigned-me', 'legacy', 'personal', 'unassigned-mine'])
    expect(ids(raw, 'you')).toEqual(['assigned-me', 'assigned-you', 'legacy', 'personal', 'unassigned-yours'])
  })
  it('signed out applies no filter', () => {
    const { raw } = freshDb()
    seed(raw)
    expect(ids(raw, null)).toHaveLength(7)
  })
})

describe('a task arriving live lands in its team', () => {
  it('reads the org off the partition key', () => {
    expect(orgOfPartition('n:org:org_123')).toBe('org_123')
    expect(orgOfPartition('n:acct:acct_1')).toBeNull()
    expect(orgOfPartition('n:desk:root_1')).toBeNull()
    expect(orgOfPartition(undefined)).toBeNull()
  })
  it('the snapshot apply stamps the org it was given', () => {
    const src = readFileSync(join(__dirname, '../../src/main/db/workItems.ts'), 'utf-8')
    expect(src).toContain('org_id: orgId || PERSONAL_ORG_ID')
    expect(src).not.toContain("'WORK_ITEMS_PERSONAL_ONLY'")
  })
  it('a desk moved into a team carries its tasks instead of parking them', () => {
    const nodes = readFileSync(join(__dirname, '../../src/main/db/nodes.ts'), 'utf-8')
    expect(nodes).not.toContain('detachAndReviveWorkItemDescendants(db, [rootId]')
    expect(nodes).toContain('const ids = collectActiveSubtree(db, rootId)')
  })
})

describe('the per-org attestation gate is gone (DEC-145 superseded it)', () => {
  const root = join(__dirname, '../..')
  const read = (p: string): string => readFileSync(join(root, p), 'utf-8')
  const channels = ['workItems:orgEnabled', 'workItems:orgAttestation', 'workItems:attestOrgMigrated', 'workItems:revokeOrgAttestation']

  it('no channel, handler, bridge or contract survives', () => {
    for (const file of ['src/main/ipc/index.ts', 'src/preload/index.ts', 'src/main/ipc/ipcContracts.generated.ts', 'src/web/api/channelMap.generated.ts']) {
      const src = read(file)
      for (const ch of channels) expect(src, `${ch} in ${file}`).not.toContain(`'${ch}'`)
    }
  })
  it('the pref module and its browser stub are deleted, and nothing aliases them', () => {
    expect(() => read('src/main/workItemsPref.ts')).toThrow()
    expect(() => read('src/web/worker/main/workItemsPref.ts')).toThrow()
    expect(read('vite.web.config.ts')).not.toContain('workItemsPref')
  })
  it('creation is refused only for an unmigrated table', () => {
    const nodes = read('src/main/db/nodes.ts')
    expect(nodes).toContain("readonly code: 'WORK_ITEMS_NOT_MIGRATED'")
    expect(nodes).not.toContain('WORK_ITEMS_PERSONAL_ONLY')
  })
})
