// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { WORK_ITEM_COLUMNS } from '../../src/shared/workItems'
import { advanceBaseRevCore } from '../../src/main/db/workspaceSync'
import { ensureWorkItemSchema } from '../../src/main/db/workItems'

// GAP-015 + guess-list #9 — the allowlist-parity CI lock. The column manifest
// (shared/workItems.ts) is THE single source; this test fails the build if the
// CRDT allowlist, the emit snapshot, the arrival router, the poll-arm
// normalization, or the 409 fix ever stop consuming it.

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

const crdt = read('src/renderer/src/lib/crdtSync.ts')
const syncMain = read('src/main/db/workspaceSync.ts')
const syncRenderer = read('src/renderer/src/lib/workspaceSync.ts')
const preload = read('src/preload/index.ts')
const ipc = read('src/main/ipc/index.ts')

describe('allowlist parity (manifest ↔ transports)', () => {
  it('NODE_ATTR_KEYS derives its work_item attrs from the manifest spread', () => {
    expect(crdt).toContain(
      "...WORK_ITEM_COLUMNS.filter((c) => c.rendererEmitted).map((c) => c.attr)"
    )
    // No manifest attr may ALSO appear as a literal (double-listing masks drift).
    const literalBlock = crdt.slice(crdt.indexOf('const NODE_ATTR_KEYS'), crdt.indexOf('] as const'))
    for (const def of WORK_ITEM_COLUMNS) {
      expect(literalBlock).not.toContain(`'${def.attr}'`)
    }
  })

  it('the emit snapshot spreads the renderer-emitted manifest for work_items', () => {
    const emitBlock = crdt.slice(crdt.indexOf('function emitNodeCreate'), crdt.indexOf('function emitNodeDelete'))
    expect(emitBlock).toContain("if (node.kind === 'work_item')")
    expect(emitBlock).toContain('for (const def of WORK_ITEM_COLUMNS)')
    expect(emitBlock).toContain('def.rendererEmitted')
  })

  it('schema_epoch is main-process-written: never renderer-emitted (F-m2″)', () => {
    const def = WORK_ITEM_COLUMNS.find((c) => c.column === 'schema_epoch')
    expect(def?.rendererEmitted).toBe(false)
  })

  it('every manifest column lands in the DB via ensureWorkItemSchema', () => {
    // Executed (not grepped): a fresh table + the real ensure function.
    const raw = new DatabaseSync(':memory:')
    raw.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '')")
    const db = {
      exec: (sql: string) => raw.exec(sql),
      prepare: (sql: string) => {
        const s = raw.prepare(sql)
        return {
          run: (...a: unknown[]) => s.run(...(a as never[])),
          get: (...a: unknown[]) => s.get(...(a as never[])),
          all: (...a: unknown[]) => s.all(...(a as never[])) as unknown[]
        }
      }
    }
    ensureWorkItemSchema(db as never)
    const cols = new Set(
      (raw.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((c) => c.name)
    )
    for (const def of WORK_ITEM_COLUMNS) expect(cols.has(def.column), def.column).toBe(true)
  })
})

describe('the arrival router (§3 D1) is wired at every seam', () => {
  it('crdtSync branches all three apply paths to the workItems channel', () => {
    expect(crdt).toContain("if (snapshot.kind === 'work_item')")
    // DEC-144: the create carries the team it arrived on (orgOfPartition).
    expect(crdt).toContain("applySyncEvent({ type: 'create', snapshot, orgId })")
    expect(crdt).toContain("applySyncEvent({ type: 'attr', id, attr, value })")
    expect(crdt).toContain("applySyncEvent({ type: 'trash', id, trashed: true })")
  })

  it('the poll arms normalize applied work_items at all three appliers', () => {
    const calls = syncMain.match(/normalizeIfWorkItem\(db, table, item\)/g) ?? []
    expect(calls.length).toBe(3)
  })

  it('the internal IPC pair exists end-to-end', () => {
    expect(ipc).toContain("'workItems:applySyncEvent'")
    expect(ipc).toContain("ipcMain.handle('workItems:kindOf'")
    expect(preload).toContain("ipcRenderer.invoke('workItems:applySyncEvent'")
    expect(preload).toContain("ipcRenderer.invoke('workItems:kindOf'")
  })
})

describe('the 409 baseRev fix (F010)', () => {
  it('advanceBaseRevCore floors sync_rev and never rewinds it', () => {
    const raw = new DatabaseSync(':memory:')
    raw.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, sync_rev INTEGER)')
    raw.exec("INSERT INTO nodes (id, sync_rev) VALUES ('low', 3), ('high', 10), ('nul', NULL)")
    const db = {
      prepare: (sql: string) => {
        const s = raw.prepare(sql)
        return { run: (...a: unknown[]) => s.run(...(a as never[])) }
      }
    }
    advanceBaseRevCore(db, 'nodes', 'low', 7)
    advanceBaseRevCore(db, 'nodes', 'high', 7)
    advanceBaseRevCore(db, 'nodes', 'nul', 7)
    const revs = raw.prepare('SELECT id, sync_rev FROM nodes ORDER BY id').all()
    expect(revs).toEqual([
      { id: 'high', sync_rev: 10 }, // never rewound
      { id: 'low', sync_rev: 7 }, // floored up
      { id: 'nul', sync_rev: 7 } // NULL treated as behind
    ])
  })

  it('all three renderer conflict arms call advanceBaseRev after the apply', () => {
    const calls = syncRenderer.match(/workspaceSync\.advanceBaseRev\(/g) ?? []
    expect(calls.length).toBe(3)
  })
})
