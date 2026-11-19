// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { advanceBaseRevCore } from '../../src/main/db/workspaceSync'

// The shared-desk 409 loop (production, found 2026-11-19 from the v169/v170 logs):
// four rows of one shared desk were PUT every ~20 s and refused with 409 every
// time — 34 refusals each in ten minutes, the server answering the same rev each
// time (1, 2, 5, 7) because nothing on it had changed since September.
//
// The device held each row at a rev from ANOTHER scope (49 and 68 from the
// owner's personal workspace, 9 and 10 from a team the desk later moved to),
// all ABOVE the shared rev. After a 409 the client applies the server copy and
// then "floors" sync_rev to the server's rev. Here both were no-ops: the apply is
// skipped because the incoming rev is not newer than the local one, and a floor
// never lowers 49 to 1. So needs_sync stayed 1 and the next cycle sent baseRev 49
// again, forever.
//
// After a 409 the server's rev IS the rev of that row in that scope, so the
// conflict settles sync_rev to it exactly. A local edit then goes up once and
// wins (the F010 contract); a row with nothing to push is already clean.

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec(`
    CREATE TABLE fb_rows (id TEXT PRIMARY KEY, cells TEXT, sync_rev INTEGER DEFAULT 0, needs_sync INTEGER DEFAULT 1);
    -- verbatim from the live database
    CREATE TRIGGER fb_rows_mark_dirty AFTER UPDATE ON fb_rows
      WHEN NEW.needs_sync = OLD.needs_sync AND NEW.sync_rev = OLD.sync_rev AND OLD.needs_sync = 0
      BEGIN UPDATE fb_rows SET needs_sync = 1 WHERE id = NEW.id; END;
  `)
  return d
}
const row = (d: DatabaseSync, id: string): { sync_rev: number; needs_sync: number } =>
  d.prepare('SELECT sync_rev, needs_sync FROM fb_rows WHERE id = ?').get(id) as never

// The server's upsert rule (focusbuddy-signal orgWorkspaceSync / workspaceSync):
// a baseRev that is not the current rev is a conflict answered with the current
// row; a matching one is accepted at rev + 1.
function serverPut(server: { rev: number }, baseRev: number): { ok: true; rev: number } | { ok: false; rev: number } {
  if (baseRev !== server.rev) return { ok: false, rev: server.rev }
  server.rev += 1
  return { ok: true, rev: server.rev }
}

// One client push cycle for a dirty row, exactly as the renderer runs it: PUT with
// baseRev = sync_rev; on success mark it pushed; on 409 the server-wins apply (a
// no-op here: incoming is not newer) and then the conflict settle.
function pushCycle(d: DatabaseSync, id: string, server: { rev: number }): 'pushed' | 'conflict' | 'clean' {
  const r = row(d, id)
  if (r.needs_sync !== 1) return 'clean'
  const res = serverPut(server, r.sync_rev)
  if (res.ok) {
    d.prepare('UPDATE fb_rows SET sync_rev = ?, needs_sync = 0 WHERE id = ?').run(res.rev, id)
    return 'pushed'
  }
  advanceBaseRevCore(d, 'fb_rows', id, res.rev)
  return 'conflict'
}

describe('a 409 settles the row to the server rev, so a conflict can never loop', () => {
  it('a row holding a rev from another scope (49) above the shared rev (1) pushes on the next cycle', () => {
    const d = db()
    d.prepare('INSERT INTO fb_rows (id, cells, sync_rev, needs_sync) VALUES (?, ?, ?, 1)').run('r1', '{}', 49)
    const server = { rev: 1 }
    const outcomes: string[] = []
    for (let cycle = 0; cycle < 5; cycle++) outcomes.push(pushCycle(d, 'r1', server))
    // One refusal, then the push lands and the row is clean: no fourth, fifth… 409.
    expect(outcomes).toEqual(['conflict', 'pushed', 'clean', 'clean', 'clean'])
    expect(row(d, 'r1')).toEqual({ sync_rev: 2, needs_sync: 0 })
    expect(server.rev).toBe(2)
    d.close()
  })

  it('all four production shapes (49/1, 68/2, 9/5, 10/7) end after one conflict', () => {
    for (const [local, shared] of [[49, 1], [68, 2], [9, 5], [10, 7]]) {
      const d = db()
      d.prepare('INSERT INTO fb_rows (id, cells, sync_rev, needs_sync) VALUES (?, ?, ?, 1)').run('r', '{}', local)
      const server = { rev: shared }
      const conflicts = Array.from({ length: 10 }, () => pushCycle(d, 'r', server)).filter((o) => o === 'conflict')
      expect(conflicts.length, `local ${local} vs shared ${shared}`).toBe(1)
      d.close()
    }
  })

  it('the ordinary F010 case still floors up (local 3 behind server 7)', () => {
    const d = db()
    d.prepare('INSERT INTO fb_rows (id, cells, sync_rev, needs_sync) VALUES (?, ?, ?, 1)').run('r1', '{}', 3)
    advanceBaseRevCore(d, 'fb_rows', 'r1', 7)
    expect(row(d, 'r1')).toEqual({ sync_rev: 7, needs_sync: 1 })
    d.close()
  })

  it('settling the rev never marks a clean row dirty (the trigger ignores a sync_rev write)', () => {
    const d = db()
    d.prepare('INSERT INTO fb_rows (id, cells, sync_rev, needs_sync) VALUES (?, ?, ?, 0)').run('r1', '{}', 49)
    advanceBaseRevCore(d, 'fb_rows', 'r1', 1)
    expect(row(d, 'r1')).toEqual({ sync_rev: 1, needs_sync: 0 })
    d.close()
  })
})
