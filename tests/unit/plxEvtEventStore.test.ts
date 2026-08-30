// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createEventStore, type SqlDb } from '../../src/main/db/eventStore'
import { isDigestRef } from '../../src/shared/events'

// Append-only Event Store (spec §35, §49). Production runs on better-sqlite3
// (Electron ABI); the test runner (Node) cannot load that native binding, so we
// drive the same store code through Node's built-in node:sqlite via a thin
// adapter that satisfies the store's minimal SqlDb interface.
function store() {
  const d = new DatabaseSync(':memory:')
  const adapter: SqlDb = {
    exec: (sql) => d.exec(sql),
    prepare: (sql) => {
      const s = d.prepare(sql)
      return {
        run: (...a) => s.run(...(a as never[])),
        get: (...a) => s.get(...(a as never[])),
        all: (...a) => s.all(...(a as never[])) as unknown[]
      }
    },
    transaction: (fn) => () => {
      d.exec('BEGIN')
      try {
        const r = fn()
        d.exec('COMMIT')
        return r
      } catch (e) {
        d.exec('ROLLBACK')
        throw e
      }
    }
  }
  return createEventStore(adapter)
}
const base = {
  eventType: 'ObjectUpdated' as const,
  category: 'user' as const,
  actor: 'user:abc',
  organisationId: 'org-1'
}

describe('plx_evt_010 / plx_evt_030 — immutable, append-only', () => {
  it('test_plx_evt_010_no_mutation_api: the store exposes no update or delete', () => {
    const es = store()
    expect((es as unknown as Record<string, unknown>).update).toBeUndefined()
    expect((es as unknown as Record<string, unknown>).delete).toBeUndefined()
    expect((es as unknown as Record<string, unknown>).remove).toBeUndefined()
  })
  it('test_plx_evt_030_db_trigger_blocks_update_and_delete', () => {
    const es = store()
    const e = es.append({ ...base, deskId: 'desk-1', currentState: { v: 1 } })
    // The DB triggers reject any mutation regardless of driver; message wording
    // varies, so assert the throw, then prove the row survived intact.
    expect(() => es.db.prepare('UPDATE events SET change_summary = ? WHERE id = ?').run('tampered', e.id)).toThrow()
    expect(() => es.db.prepare('DELETE FROM events WHERE id = ?').run(e.id)).toThrow()
    expect(es.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 })
  })
})

describe('plx_evt_022 / plx_evt_013 — per-partition monotonic sequence', () => {
  it('test_plx_evt_022_sequence_monotonic_per_partition', () => {
    const es = store()
    const a1 = es.append({ ...base, deskId: 'desk-A' })
    const a2 = es.append({ ...base, deskId: 'desk-A' })
    const b1 = es.append({ ...base, deskId: 'desk-B' })
    expect(a1.sequence).toBe(1)
    expect(a2.sequence).toBe(2)
    expect(b1.sequence).toBe(1) // independent partition
  })
  it('test_plx_evt_013_recorded_at_present_and_ordered_by_sequence', () => {
    const es = store()
    const e = es.append({ ...base, deskId: 'desk-A', timestamp: '2020-01-01T00:00:00.000Z' })
    // occurrence time honoured, ingestion time set to now (different)
    expect(e.timestamp).toBe('2020-01-01T00:00:00.000Z')
    expect(e.recordedAt).not.toBe(e.timestamp)
    // replay orders by sequence, not wall clock
    const seqs = es.replayDesk('desk-A').map((x) => x.sequence)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
  })
})

describe('plx_evt_031 — replay reconstructs a desk', () => {
  it('test_plx_evt_031_replay_in_order', () => {
    const es = store()
    es.append({ ...base, deskId: 'desk-A', currentState: { step: 1 } })
    es.append({ ...base, deskId: 'desk-A', currentState: { step: 2 } })
    es.append({ ...base, deskId: 'desk-B', currentState: { step: 99 } })
    const desk = es.replayDesk('desk-A')
    expect(desk.map((e) => (e.currentState as { step: number }).step)).toEqual([1, 2])
    expect(es.replayDesk('desk-A', { untilSequence: 1 })).toHaveLength(1)
  })
})

describe('plx_evt_014 — transactional outbox atomicity', () => {
  it('test_plx_evt_014_mutation_and_event_commit_together', () => {
    const es = store()
    es.db.exec('CREATE TABLE thing (id TEXT PRIMARY KEY, name TEXT)')
    const { event } = es.appendWithMutation({ ...base, deskId: 'desk-A', currentState: { name: 'x' } }, (db) => {
      db.prepare('INSERT INTO thing (id, name) VALUES (?, ?)').run('t1', 'x')
    })
    expect(es.db.prepare('SELECT name FROM thing WHERE id = ?').get('t1')).toEqual({ name: 'x' })
    expect(es.db.prepare('SELECT COUNT(*) AS n FROM event_outbox WHERE event_id = ?').get(event.id)).toEqual({ n: 1 })
  })
  it('test_plx_evt_014_rolls_back_both_on_failure', () => {
    const es = store()
    es.db.exec('CREATE TABLE thing (id TEXT PRIMARY KEY, name TEXT)')
    expect(() =>
      es.appendWithMutation({ ...base, deskId: 'desk-A' }, (db) => {
        db.prepare('INSERT INTO thing (id, name) VALUES (?, ?)').run('t1', 'x')
        throw new Error('mutation failed after write')
      })
    ).toThrow(/mutation failed/)
    // Neither the mutation nor any event survived.
    expect(es.db.prepare('SELECT COUNT(*) AS n FROM thing').get()).toEqual({ n: 0 })
    expect(es.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 })
  })
})

describe('plx_evt_015 — idempotent consumers', () => {
  it('test_plx_evt_015_process_once', () => {
    const es = store()
    const e = es.append({ ...base, deskId: 'desk-A' })
    let runs = 0
    expect(es.processOnce('projector', e.id, () => runs++)).toBe(true)
    expect(es.processOnce('projector', e.id, () => runs++)).toBe(false) // duplicate delivery
    expect(runs).toBe(1)
    // a different consumer still gets to process it
    expect(es.processOnce('search-index', e.id, () => runs++)).toBe(true)
    expect(runs).toBe(2)
  })
})

describe('plx_evt_042 — source + id uniqueness', () => {
  it('test_plx_evt_042_ids_unique', () => {
    const es = store()
    const ids = new Set<string>()
    for (let i = 0; i < 500; i++) ids.add(es.append({ ...base, deskId: 'desk-A' }).id)
    expect(ids.size).toBe(500)
  })
})

describe('plx_evt_045 — large state carried as a digest', () => {
  it('test_plx_evt_045_externalises_large_state', () => {
    const es = store()
    const big = { body: 'y'.repeat(20 * 1024) }
    const e = es.append({ ...base, deskId: 'desk-A', currentState: big })
    expect(isDigestRef(e.currentState)).toBe(true)
    // the digest resolves back to the original content
    expect(es.resolveState(e.currentState)).toEqual(big)
    // small state stays inline
    const small = es.append({ ...base, deskId: 'desk-A', currentState: { ok: true } })
    expect(isDigestRef(small.currentState)).toBe(false)
  })
})

// DEC-056 — retention exists for the delivery queue and NOWHERE else.
describe('dec_056 — outbox retention never reaches the Event log', () => {
  it('dec_056_prune_outbox_caps_queue_and_leaves_events_intact', () => {
    const es = store()
    const ids = Array.from({ length: 12 }, (_, i) =>
      es.append({ ...base, deskId: 'desk-1', currentState: { v: i } }).id
    )
    expect(es.db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get()).toEqual({ n: 12 })

    const removed = es.pruneOutbox(5)

    // The queue is capped...
    expect(removed).toBe(7)
    expect(es.db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get()).toEqual({ n: 5 })
    // ...and it kept the NEWEST five, not an arbitrary five.
    const kept = (es.db.prepare('SELECT event_id FROM event_outbox').all() as { event_id: string }[]).map(
      (r) => r.event_id
    )
    expect(kept.sort()).toEqual(ids.slice(-5).sort())

    // ...while every Event survives, because the queue is bookkeeping and the
    // log is history (PLX-EVT-030). This is the assertion that matters: the
    // count is unchanged AND the oldest Event — the one whose queue row was
    // just released — is still replayable (PLX-EVT-031).
    expect(es.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 12 })
    expect(es.replayDesk('desk-1').map((e) => e.id)).toEqual(ids)
  })

  it('dec_056_no_event_pruning_interface_exists', () => {
    const es = store()
    // PLX-EVT-030 forbids ANY interface that deletes a written Event, so the
    // absence of one is the requirement — not an oversight to be helpfully
    // filled in later. Retention is allowed to name the outbox and nothing else.
    const surface = Object.keys(es as unknown as Record<string, unknown>)
    expect(surface.filter((k) => /prune|purge|delete|truncate|compact/i.test(k))).toEqual(['pruneOutbox'])
  })

  it('dec_056_prune_is_a_noop_when_under_the_cap', () => {
    const es = store()
    es.append({ ...base, deskId: 'desk-1' })
    expect(es.pruneOutbox(5_000)).toBe(0)
    expect(es.db.prepare('SELECT COUNT(*) AS n FROM event_outbox').get()).toEqual({ n: 1 })
  })
})
