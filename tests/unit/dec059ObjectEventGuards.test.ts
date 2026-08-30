// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { isRealCreate, isRealDelete, stateChanged } from '../../src/main/context/objectEventGuards'

// DEC-059 — Events are permanent (PLX-EVT-030 forbids deleting one, PLX-EVT-031
// requires the store stay replayable), so an Event minted for a change that did
// not happen can never be taken back. These pin the rule that decides.

describe('dec_059 — a create Event requires that something was created', () => {
  it('dec_059_replayed_create_of_an_existing_row_is_not_a_create', () => {
    // The measured failure: crdtSync replays a desk-create for a desk that has
    // existed since June. createNode returns the existing row untouched, so the
    // only correct number of Events is zero — it emitted 20.
    const existing = { id: 'desk-1', title: 'Lake dash', kind: 'task' }
    expect(isRealCreate(existing)).toBe(false)
  })
  it('dec_059_a_genuinely_new_id_still_creates', () => {
    expect(isRealCreate(null)).toBe(true)
    expect(isRealCreate(undefined)).toBe(true)
  })
})

describe('dec_059 — a delete Event requires that something was deleted', () => {
  it('dec_059_deleting_what_is_already_gone_is_not_a_transition', () => {
    expect(isRealDelete(null)).toBe(false)
    expect(isRealDelete(undefined)).toBe(false)
  })
  it('dec_059_deleting_a_present_row_is', () => {
    expect(isRealDelete({ id: 'w1' })).toBe(true)
  })
})

describe('dec_059 — an update Event requires that a field actually moved', () => {
  it('dec_059_identical_rewrite_is_not_an_update', () => {
    // Six of these landed for one sticky inside 2ms, every one byte-identical.
    const row = { id: 'w1', kind: 'sticky', title: '', content: 'hello' }
    expect(stateChanged({ ...row }, { ...row })).toBe(false)
  })

  it('dec_059_updated_at_alone_never_counts_as_a_change', () => {
    // The load-bearing exclusion. A no-op re-apply still bumps updatedAt, so
    // leaving it in the comparison would wave through every replayed write and
    // defeat the whole guard.
    const before = { id: 'w1', content: 'same', updatedAt: 1, syncRev: 4, needsSync: 0 }
    const after = { id: 'w1', content: 'same', updatedAt: 999, syncRev: 9, needsSync: 1 }
    expect(stateChanged(before, after)).toBe(false)
  })

  it('dec_059_a_real_edit_still_emits', () => {
    // The guard must not buy quiet by dropping genuine edits.
    expect(stateChanged({ id: 'w1', content: 'a' }, { id: 'w1', content: 'b' })).toBe(true)
    expect(stateChanged({ id: 'n1', title: 'Old' }, { id: 'n1', title: 'New' })).toBe(true)
    expect(stateChanged({ id: 'n1', status: 'open' }, { id: 'n1', status: 'done' })).toBe(true)
  })

  it('dec_059_an_edit_to_a_field_the_event_does_not_report_still_emits', () => {
    // nodes:update reports title/status/importance but the row carries more.
    // Comparing only the reported fields would silently swallow a description
    // edit, so the comparison spans the whole row.
    expect(stateChanged({ id: 'n1', title: 'T', description: 'a' }, { id: 'n1', title: 'T', description: 'b' })).toBe(true)
  })

  it('dec_059_rebuilt_but_identical_objects_compare_structurally', () => {
    // layout/tags arrive as fresh object identities every apply; by reference
    // they always differ, which would make every replay look like an edit.
    expect(stateChanged({ id: 'w1', layout: { x: 1, y: 2 } }, { id: 'w1', layout: { x: 1, y: 2 } })).toBe(false)
    expect(stateChanged({ id: 'w1', tags: ['a', 'b'] }, { id: 'w1', tags: ['a', 'b'] })).toBe(false)
    expect(stateChanged({ id: 'w1', tags: ['a'] }, { id: 'w1', tags: ['a', 'b'] })).toBe(true)
  })

  it('dec_059_appearing_or_vanishing_counts_as_change', () => {
    expect(stateChanged(null, { id: 'w1' })).toBe(true)
    expect(stateChanged({ id: 'w1' }, null)).toBe(true)
    expect(stateChanged(null, null)).toBe(false)
  })

  it('dec_059_a_field_added_or_removed_counts', () => {
    expect(stateChanged({ id: 'n1' }, { id: 'n1', dueAt: 5 })).toBe(true)
    expect(stateChanged({ id: 'n1', dueAt: 5 }, { id: 'n1' })).toBe(true)
  })

  it('dec_059_null_and_undefined_are_distinguished_from_a_value', () => {
    expect(stateChanged({ id: 'n1', dueAt: null }, { id: 'n1', dueAt: 5 })).toBe(true)
    expect(stateChanged({ id: 'n1', dueAt: null }, { id: 'n1', dueAt: null })).toBe(false)
  })
})

// DEC-059 — the origin marker, pinned structurally.
describe('dec_059 — replayed writes declare themselves as sync', () => {
  it('dec_059_every_crdtsync_write_passes_the_sync_origin', async () => {
    // crdtSync deliberately reuses the user-facing IPC so the main-side
    // cascades and hooks fire identically. That is exactly why each call has to
    // say it is a replay: without the marker main cannot tell, and mints a
    // permanent Event for a change the user did not make. A new applier added
    // without the marker silently reopens the churn, so assert on the calls.
    const fs = await import('node:fs/promises')
    const src = await fs.readFile(
      new URL('../../src/renderer/src/lib/crdtSync.ts', import.meta.url),
      'utf8'
    )
    const calls = src.match(/window\.api\.(?:nodes|widgets)\.(?:create|update|delete)\([^\n]*/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    const unmarked = calls.filter((c) => !c.includes("'sync'"))
    expect(unmarked).toEqual([])
  })
})
