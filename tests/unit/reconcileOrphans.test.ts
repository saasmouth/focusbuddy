// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { reconcileNodeOrphans } from '../../src/main/db/reconcileOrphans'

// Found by running PRAGMA foreign_key_check against the real preview database:
// one canvas_snapshots row pointed at a node that no longer existed. Foreign
// keys ARE on at runtime, so ordinary deletes cascade — but the nodes table
// REBUILD turns them off to swap the table, and performs no cascades while it
// runs. This sweeps what that leaves behind.

function db(): { raw: DatabaseSync; api: Parameters<typeof reconcileNodeOrphans>[0] } {
  const raw = new DatabaseSync(':memory:')
  raw.exec(`
    CREATE TABLE nodes (id TEXT PRIMARY KEY);
    CREATE TABLE canvas_snapshots (id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
    CREATE TABLE widgets (id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
    CREATE TABLE time_blocks (id TEXT PRIMARY KEY, task_id TEXT);
    CREATE TABLE contact_links (contact_id TEXT, node_id TEXT);
    INSERT INTO nodes (id) VALUES ('live');
  `)
  const api = {
    prepare: (sql: string) => {
      const s = raw.prepare(sql)
      return {
        run: (...a: unknown[]) => s.run(...(a as never[])) as { changes?: number },
        all: (...a: unknown[]) => s.all(...(a as never[])) as unknown[]
      }
    }
  }
  return { raw, api }
}

const count = (raw: DatabaseSync, t: string): number =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n

describe('reconcileNodeOrphans', () => {
  it('removes rows whose node is gone', () => {
    const { raw, api } = db()
    raw.exec("INSERT INTO canvas_snapshots VALUES ('s1','ghost'), ('s2','live')")
    const out = reconcileNodeOrphans(api)
    expect(out.canvas_snapshots).toBe(1)
    expect(count(raw, 'canvas_snapshots')).toBe(1)
  })

  it('leaves healthy rows alone, and reports nothing', () => {
    const { raw, api } = db()
    raw.exec("INSERT INTO widgets VALUES ('w1','live')")
    expect(reconcileNodeOrphans(api)).toEqual({})
    expect(count(raw, 'widgets')).toBe(1)
  })

  it('NEVER sweeps a time block with no task', () => {
    // A generic focus block belongs to no task by design. Treating NULL as an
    // orphan would silently delete somebody's calendar.
    const { raw, api } = db()
    raw.exec("INSERT INTO time_blocks VALUES ('b1', NULL), ('b2','ghost'), ('b3','live')")
    reconcileNodeOrphans(api)
    const ids = (raw.prepare('SELECT id FROM time_blocks ORDER BY id').all() as Array<{ id: string }>)
      .map((r) => r.id)
    expect(ids).toEqual(['b1', 'b3'])
  })

  it('sweeps every table it covers in one pass', () => {
    const { raw, api } = db()
    raw.exec(`
      INSERT INTO canvas_snapshots VALUES ('s','ghost');
      INSERT INTO widgets VALUES ('w','ghost');
      INSERT INTO time_blocks VALUES ('b','ghost');
      INSERT INTO contact_links VALUES ('c','ghost');
    `)
    const out = reconcileNodeOrphans(api)
    expect(Object.keys(out).sort()).toEqual([
      'canvas_snapshots',
      'contact_links',
      'time_blocks',
      'widgets'
    ])
  })

  it('is idempotent', () => {
    const { raw, api } = db()
    raw.exec("INSERT INTO canvas_snapshots VALUES ('s1','ghost')")
    reconcileNodeOrphans(api)
    expect(reconcileNodeOrphans(api)).toEqual({})
  })

  it('does not throw when a table does not exist yet', () => {
    const raw = new DatabaseSync(':memory:')
    raw.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY)')
    const api = {
      prepare: (sql: string) => {
        const s = raw.prepare(sql)
        return {
          run: (...a: unknown[]) => s.run(...(a as never[])) as { changes?: number },
          all: (...a: unknown[]) => s.all(...(a as never[])) as unknown[]
        }
      }
    }
    // Best-effort: a sweep must never block startup.
    expect(() => reconcileNodeOrphans(api)).not.toThrow()
  })
})
