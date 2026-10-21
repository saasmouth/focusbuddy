// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  ensureWorkItemSchema,
  updateWorkItemFieldsCore,
  reclassifyWorkItemCore,
  snoozeWorkItemCore,
  markWorkItemReadCore,
  workItemCountsCore,
  setWorkItemStateCore
} from '../../src/main/db/workItems'
import type { LifecycleDb } from '../../src/main/db/nodeLifecycle'

// S3 (§4) — the workItems:* verb set over the S2 db module, plus the
// namespace-parity locks: every verb wired IPC→preload→store, work items
// never travel nodes:*, and state/status stay un-patchable outside setState.

type Db = LifecycleDb & { exec(sql: string): void }

function freshDb(): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      trashed_at INTEGER,
      org_id TEXT NOT NULL DEFAULT 'personal',
      updated_at INTEGER NOT NULL DEFAULT 0,
      -- Real nodes columns the DEC-144 Focus counts read.
      archived INTEGER NOT NULL DEFAULT 0,
      due_date INTEGER
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

const wi = (raw: DatabaseSync, id: string, state = 'open'): void => {
  raw
    .prepare(
      "INSERT INTO nodes (id, kind, title, work_item_state, status) VALUES (?, 'work_item', ?, ?, ?)"
    )
    .run(id, `Item ${id}`, state, 'open')
}

describe('archive (DEC-024)', () => {
  it('archive projects to parked (never done); unarchive round-trips to open', () => {
    const { raw, db } = freshDb()
    wi(raw, 'a')
    expect(setWorkItemStateCore(db, 'a', 'archived')).toBe(true)
    let row = raw.prepare('SELECT work_item_state AS s, status FROM nodes WHERE id = ?').get('a') as {
      s: string
      status: string
    }
    expect(row).toEqual({ s: 'archived', status: 'parked' })
    expect(setWorkItemStateCore(db, 'a', 'open')).toBe(true)
    row = raw.prepare('SELECT work_item_state AS s, status FROM nodes WHERE id = ?').get('a') as {
      s: string
      status: string
    }
    expect(row).toEqual({ s: 'open', status: 'open' })
  })

  it('archive is QUIET: never in the closure-notification state set (source lock)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'db', 'workItems.ts'), 'utf-8')
    const terminalBlock = src.slice(src.indexOf('const TERMINAL_STATES'), src.indexOf('const CLOSURE_VERB'))
    expect(terminalBlock).not.toContain("'archived'")
  })
})

describe('updateFields / reclassify', () => {
  it('patches the patchable set, refuses non-work_items, and cannot touch state or status', () => {
    const { raw, db } = freshDb()
    wi(raw, 'a')
    raw.exec("INSERT INTO nodes (id, kind, title) VALUES ('desk', 'task', 'D')")
    expect(
      updateWorkItemFieldsCore(db, 'a', {
        title: 'Renamed',
        notes: 'details',
        dueAt: '2026-09-01T12:00:00Z',
        wiUrgency: 'high',
        // hostile keys — must be ignored, not written
        status: 'done',
        workItemState: 'completed',
        work_item_state: 'completed'
      })
    ).toBe(true)
    const row = raw
      .prepare('SELECT title, description, due_at, wi_urgency, status, work_item_state FROM nodes WHERE id = ?')
      .get('a') as Record<string, string>
    expect(row.title).toBe('Renamed')
    expect(row.description).toBe('details')
    expect(row.due_at).toBe('2026-09-01T12:00:00Z')
    expect(row.wi_urgency).toBe('high')
    expect(row.status).toBe('open') // untouched — derived only
    expect(row.work_item_state).toBe('open') // untouched — setState only
    expect(updateWorkItemFieldsCore(db, 'desk', { title: 'X' })).toBe(false)
  })

  it('reclassify re-bins intent and leaves the item active', () => {
    const { raw, db } = freshDb()
    wi(raw, 'a')
    expect(reclassifyWorkItemCore(db, 'a', 'to_review')).toBe(true)
    const row = raw.prepare('SELECT intent_class, work_item_state FROM nodes WHERE id = ?').get('a') as {
      intent_class: string
      work_item_state: string
    }
    expect(row).toEqual({ intent_class: 'to_review', work_item_state: 'open' })
  })

  it('reclassify maps legacy values forward and refuses garbage (alignment)', () => {
    const { raw, db } = freshDb()
    wi(raw, 'a')
    // A legacy class (saved Flow, stale prompt cache) canonicalizes on write.
    expect(reclassifyWorkItemCore(db, 'a', 'acknowledgment')).toBe(true)
    let row = raw.prepare('SELECT intent_class FROM nodes WHERE id = ?').get('a') as {
      intent_class: string
    }
    expect(row.intent_class).toBe('to_respond')
    // Garbage is refused — never the silent store it used to be.
    expect(reclassifyWorkItemCore(db, 'a', 'nonsense')).toBe(false)
    row = raw.prepare('SELECT intent_class FROM nodes WHERE id = ?').get('a') as {
      intent_class: string
    }
    expect(row.intent_class).toBe('to_respond')
  })
})

describe('DEC-039 — creation carries the chosen context (file-level pins)', () => {
  // createWorkItemCore is guarded by the capability pref + the CHECK-clause
  // probe, so it is pinned at the source: the INSERT must carry tags and
  // mentions, and the draft must map them — a capture-time tag that silently
  // vanished at create would otherwise look like a UI bug.
  it('the INSERT and the draft both know tags + mentions', () => {
    const src = readFileSync(join(process.cwd(), 'src/main/db/workItems.ts'), 'utf8')
    expect(src).toContain('due_at, wi_urgency, tags, mentions, source_ref')
    expect(src).toContain('draft.tags ?? null')
    expect(src).toContain('draft.mentions ?? null')
    // …and both stay patchable after creation. DEC-064 derives PATCHABLE from
    // the manifest instead of hand-listing it, so the pin is now on the RULE —
    // a manifest column is patchable unless explicitly refused — rather than on
    // a literal that a derivation legitimately removes.
    expect(src).toContain('WORK_ITEM_COLUMNS.filter((c) => !(c.column in NOT_PATCHABLE))')
    const refusals = src.slice(src.indexOf('const NOT_PATCHABLE'), src.indexOf('const PATCHABLE'))
    expect(refusals).not.toContain('tags:')
    expect(refusals).not.toContain('mentions:')
  })

  it('DEC-064 — every manifest column is readable and writable unless refused', () => {
    // The bug this pins: PATCHABLE and rowToNode both hand-listed the manifest,
    // so a new column got DDL, sync and emit but no way in or out. `source_url`
    // sat write-only from DEC-052 until DEC-064 — stored fine, read as
    // undefined, unnoticed only because nothing had written one yet.
    const nodes = readFileSync(join(process.cwd(), 'src/main/db/nodes.ts'), 'utf8')
    expect(nodes).toContain('for (const def of WORK_ITEM_COLUMNS) out[def.attr]')
    // Refusals must say WHY, so an omission can never masquerade as a decision.
    const src2 = readFileSync(join(process.cwd(), 'src/main/db/workItems.ts'), 'utf8')
    const refusals = src2.slice(src2.indexOf('const NOT_PATCHABLE'), src2.indexOf('const PATCHABLE'))
    const entries = refusals.match(/^\s{2}\w+:/gm) ?? []
    expect(entries.length).toBeGreaterThan(0)
    // Either quote style — one reason contains an apostrophe and is written
    // with double quotes, which is the correct way to write it.
    for (const e of entries) {
      expect(refusals).toMatch(new RegExp(e.trim() + ` ('[^']{10,}'|"[^"]{10,}")`))
    }
  })
})

describe('DEC-048 — grouping nests to MAX depth 3, enforced at the db', () => {
  const gid = (raw: ReturnType<typeof freshDb>['raw'], id: string): string | null =>
    (raw.prepare('SELECT group_id FROM nodes WHERE id = ?').get(id) as { group_id: string | null })
      .group_id

  it('builds a 3-level chain and REFUSES the 4th level', () => {
    const { raw, db } = freshDb()
    wi(raw, 'root')
    wi(raw, 'kid')
    wi(raw, 'grandkid')
    wi(raw, 'toodeep')
    expect(updateWorkItemFieldsCore(db, 'kid', { groupId: 'root' })).toBe(true)
    // Grouping under a CHILD now genuinely nests (supersedes DEC-035's flatten).
    expect(updateWorkItemFieldsCore(db, 'grandkid', { groupId: 'kid' })).toBe(true)
    expect(gid(raw, 'grandkid')).toBe('kid')
    // Level 4 hits the wall.
    expect(updateWorkItemFieldsCore(db, 'toodeep', { groupId: 'grandkid' })).toBe(false)
    expect(gid(raw, 'toodeep')).toBeNull()
  })

  it('counts the SUBTREE the item brings with it', () => {
    const { raw, db } = freshDb()
    wi(raw, 'a1')
    wi(raw, 'a2')
    wi(raw, 'b1')
    wi(raw, 'b2')
    updateWorkItemFieldsCore(db, 'a2', { groupId: 'a1' }) // a1 is 2 tall
    updateWorkItemFieldsCore(db, 'b2', { groupId: 'b1' }) // b1 is 2 tall
    // 2-tall subtree under a level-2 item → level 4: refused.
    expect(updateWorkItemFieldsCore(db, 'b1', { groupId: 'a2' })).toBe(false)
    // Under a ROOT it fits exactly (1 + 2 = 3).
    expect(updateWorkItemFieldsCore(db, 'b1', { groupId: 'a1' })).toBe(true)
    expect(gid(raw, 'b1')).toBe('a1')
    expect(gid(raw, 'b2')).toBe('b1') // internal structure untouched
  })

  it('refuses self-grouping, a non-item parent, a missing parent, and a CYCLE', () => {
    const { raw, db } = freshDb()
    wi(raw, 'lead')
    wi(raw, 'kid')
    raw.prepare("INSERT INTO nodes (id, kind, title) VALUES ('desk', 'task', 'D')").run()
    expect(updateWorkItemFieldsCore(db, 'lead', { groupId: 'lead' })).toBe(false)
    expect(updateWorkItemFieldsCore(db, 'lead', { groupId: 'desk' })).toBe(false)
    expect(updateWorkItemFieldsCore(db, 'lead', { groupId: 'missing' })).toBe(false)
    expect(updateWorkItemFieldsCore(db, 'kid', { groupId: 'lead' })).toBe(true)
    // Grouping the parent under its own child would close a cycle — refused.
    expect(updateWorkItemFieldsCore(db, 'lead', { groupId: 'kid' })).toBe(false)
    expect(gid(raw, 'lead')).toBeNull()
  })

  it('ungroup clears the reference', () => {
    const { raw, db } = freshDb()
    wi(raw, 'lead')
    wi(raw, 'kid')
    updateWorkItemFieldsCore(db, 'kid', { groupId: 'lead' })
    expect(updateWorkItemFieldsCore(db, 'kid', { groupId: null })).toBe(true)
    expect(
      (raw.prepare('SELECT group_id FROM nodes WHERE id = ?').get('kid') as { group_id: string | null })
        .group_id
    ).toBeNull()
  })
})

describe('snooze / markRead (wi_local, device-local)', () => {
  it('upserts satellite state without touching the node row', () => {
    const { raw, db } = freshDb()
    wi(raw, 'a')
    snoozeWorkItemCore(db, 'a', 12345)
    markWorkItemReadCore(db, 'a')
    snoozeWorkItemCore(db, 'a', null) // un-snooze keeps read_at
    const local = raw.prepare('SELECT snooze_until, read_at FROM wi_local WHERE item_id = ?').get('a') as {
      snooze_until: number | null
      read_at: number
    }
    expect(local.snooze_until).toBeNull()
    expect(local.read_at).toBeGreaterThan(0)
  })
})

describe('counts', () => {
  it('groups by work_item_state, excludes trashed, scopes by org', () => {
    const { raw, db } = freshDb()
    wi(raw, 'a', 'open')
    wi(raw, 'b', 'open')
    wi(raw, 'c', 'completed')
    setWorkItemStateCore(db, 'c', 'completed')
    wi(raw, 'trash', 'open')
    raw.exec("UPDATE nodes SET trashed_at = 1 WHERE id = 'trash'")
    raw.exec("INSERT INTO nodes (id, kind, title, work_item_state, org_id) VALUES ('org', 'work_item', 'O', 'open', 'some-org')")
    expect(workItemCountsCore(db, 'personal')).toEqual({ open: 2, completed: 1 })
  })

  it('DEC-144: counts tasks filed on desks by their effective state, never the desk itself', () => {
    const { raw, db } = freshDb()
    wi(raw, 'a', 'open')
    raw.exec("INSERT INTO nodes (id, kind, title) VALUES ('desk', 'task', 'A desk')")
    raw.exec("INSERT INTO nodes (id, parent_id, kind, title, status) VALUES ('t1', 'desk', 'task', 'Open task', 'open')")
    raw.exec("INSERT INTO nodes (id, parent_id, kind, title, status) VALUES ('t2', 'desk', 'task', 'Done task', 'done')")
    raw.exec("INSERT INTO nodes (id, parent_id, kind, title, status, work_item_state) VALUES ('t3', 'desk', 'task', 'Waiting', 'open', 'waiting')")
    raw.exec("INSERT INTO nodes (id, parent_id, kind, title, archived) VALUES ('t4', 'desk', 'task', 'Archived', 1)")
    expect(workItemCountsCore(db, 'personal')).toEqual({ open: 2, completed: 1, waiting: 1 })
  })
})

describe('namespace parity locks (§4)', () => {
  const ROOT = join(__dirname, '..', '..')
  const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')
  const VERBS = ['list', 'get', 'create', 'updateFields', 'setState', 'reclassify', 'snooze', 'markRead', 'counts']

  it('every verb is wired IPC → preload', () => {
    const ipc = read('src/main/ipc/index.ts')
    const preload = read('src/preload/index.ts')
    for (const v of VERBS) {
      expect(ipc, `ipc workItems:${v}`).toContain(`'workItems:${v}'`)
      expect(preload, `preload workItems:${v}`).toContain(`'workItems:${v}'`)
    }
  })

  it('the store is the live-path producer and never touches nodes:*', () => {
    const store = read('src/renderer/src/stores/workItems.ts')
    expect(store).toContain('crdtEmitNodeCreate(item)')
    expect(store).toContain("crdtEmitNodeAttrs(id, { workItemState: state })")
    expect(store).not.toContain('api.nodes.')
    // status is never emitted — receivers derive their own projection.
    expect(store).not.toMatch(/crdtEmitNodeAttrs\([^)]*status:/)
  })

  it('the creation seam listens beside fb:command-new-task', () => {
    const sidebar = read('src/renderer/src/components/Sidebar.tsx')
    expect(sidebar).toContain("'fb:command-new-work-item'")
  })

  it('the sync loop refreshes the work-item store after pulls', () => {
    const sync = read('src/renderer/src/lib/workspaceSync.ts')
    expect(sync).toContain('useWorkItemStore.getState().refresh()')
  })
})
