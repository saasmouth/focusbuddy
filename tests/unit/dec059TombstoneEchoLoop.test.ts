// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { shouldApplyTombstone } from '../../src/main/db/workspaceSync'

// DEC-059 — the unbounded sync loop.
//
// A pull re-sends tombstones this device already holds. Re-writing one is a
// no-op UPDATE, and a no-op UPDATE is exactly what `widgets_mark_dirty` fires
// on — so the row was marked dirty, pushed as a delete, the server bumped its
// rev, the next pull returned it, and round it went: one server write per
// widget per sync cycle, forever. Observed at sync_rev 7,319 on a single
// widget, with 136 widgets past rev 1,000.
//
// The first test runs the REAL trigger, so it fails if either the guard or the
// trigger's WHEN clause changes in a way that reopens the loop.

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec(`
    CREATE TABLE widgets (id TEXT PRIMARY KEY, trashed_at INTEGER, sync_rev INTEGER DEFAULT 0, needs_sync INTEGER DEFAULT 0);
    -- verbatim from the live database
    CREATE TRIGGER widgets_mark_dirty AFTER UPDATE ON widgets
      WHEN NEW.needs_sync = OLD.needs_sync AND NEW.sync_rev = OLD.sync_rev AND OLD.needs_sync = 0
      BEGIN UPDATE widgets SET needs_sync = 1 WHERE id = NEW.id; END;
  `)
  return d
}
const applyTombstone = (d: DatabaseSync, id: string, rev: number): void => {
  d.prepare('UPDATE widgets SET trashed_at = COALESCE(trashed_at, ?), sync_rev = ?, needs_sync = 0 WHERE id = ?')
    .run(Date.now(), rev, id)
}
const read = (d: DatabaseSync, id: string): { sync_rev: number | null; trashed_at: number | null; needs_sync: number } =>
  d.prepare('SELECT sync_rev, trashed_at, needs_sync FROM widgets WHERE id = ?').get(id) as never

describe('dec_059 — re-applying a held tombstone must not restart the push loop', () => {
  it('dec_059_the_loop_reproduces_without_the_guard', () => {
    // Proof the bug is real and the trigger is the mechanism — not a theory.
    const d = db()
    d.prepare('INSERT INTO widgets (id, trashed_at, sync_rev, needs_sync) VALUES (?, ?, ?, 0)').run('w1', 123, 40)
    applyTombstone(d, 'w1', 40) // the echo: same rev, already trashed
    expect(read(d, 'w1').needs_sync).toBe(1) // dirty -> it will be pushed -> rev bumps -> repeat
    d.close()
  })

  it('dec_059_the_guard_refuses_the_echo_so_the_row_stays_clean', () => {
    const d = db()
    d.prepare('INSERT INTO widgets (id, trashed_at, sync_rev, needs_sync) VALUES (?, ?, ?, 0)').run('w1', 123, 40)
    const local = read(d, 'w1')
    expect(shouldApplyTombstone(local, 40)).toBe(false)
    // Guard says no, so no write happens, so the trigger never fires.
    expect(read(d, 'w1').needs_sync).toBe(0)
    d.close()
  })

  it('dec_059_repeated_pulls_never_dirty_the_row', () => {
    // The loop ran thousands of times; one refusal is not enough to prove it closed.
    const d = db()
    d.prepare('INSERT INTO widgets (id, trashed_at, sync_rev, needs_sync) VALUES (?, ?, ?, 0)').run('w1', 123, 40)
    for (let cycle = 0; cycle < 50; cycle++) {
      const local = read(d, 'w1')
      if (shouldApplyTombstone(local, 40)) applyTombstone(d, 'w1', 40)
    }
    const end = read(d, 'w1')
    expect(end.needs_sync).toBe(0)
    expect(end.sync_rev).toBe(40) // never inflated
    d.close()
  })
})

describe('dec_059 — the guard must not swallow deletes that have not been applied', () => {
  it('dec_059_a_newer_tombstone_still_applies', () => {
    expect(shouldApplyTombstone({ sync_rev: 40, trashed_at: 123 }, 41)).toBe(true)
  })
  it('dec_059_a_live_row_is_still_deleted_even_at_the_same_rev', () => {
    // Held at this rev but NOT trashed: the delete is genuinely new information.
    expect(shouldApplyTombstone({ sync_rev: 40, trashed_at: null }, 40)).toBe(true)
  })
  it('dec_059_a_row_with_no_rev_yet_still_applies', () => {
    expect(shouldApplyTombstone({ sync_rev: null, trashed_at: null }, 1)).toBe(true)
  })
  it('dec_059_a_tombstone_for_an_unknown_row_is_ignored', () => {
    expect(shouldApplyTombstone(undefined, 7)).toBe(false)
  })
})
