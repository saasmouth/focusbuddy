// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { changeEventsFor } from '../../src/main/db/workspaceSync'

// DEC-056 — the remote-change emitter is the source of Event-table growth, and
// Events can never be pruned after the fact (PLX-EVT-030), so the bound has to
// hold here or nowhere.
const node = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, itemType: 'node', deskId: 'desk-1', deleted: false, ...extra }) as never
const widget = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, itemType: 'widget', deskId: 'desk-1', deleted: false, ...extra }) as never

describe('dec_056 — remote change events are bounded at the source', () => {
  it('dec_056_deletions_emit_nothing', () => {
    // A cascade delete arrives as the desk plus every descendant widget. None
    // of them can light a "changed on another device" frame, because there is
    // no longer a row to look at — this whole batch is zero Events, not 4.
    const cascade = [
      node('desk-1', { deleted: true }),
      widget('w1', { deleted: true }),
      widget('w2', { deleted: true }),
      widget('w3', { deleted: true })
    ]
    expect(changeEventsFor(cascade)).toEqual([])
  })

  it('dec_056_updates_emit_once_per_object', () => {
    const out = changeEventsFor([widget('w1'), widget('w1'), node('desk-1'), widget('w2')])
    expect(out).toEqual([
      { eventType: 'WidgetUpdated', objectId: 'w1', deskId: 'desk-1' },
      { eventType: 'DeskUpdated', objectId: 'desk-1', deskId: 'desk-1' },
      { eventType: 'WidgetUpdated', objectId: 'w2', deskId: 'desk-1' }
    ])
  })

  it('dec_056_a_delete_does_not_suppress_a_real_update_to_another_object', () => {
    // The dedupe must not swallow live changes riding in the same pass.
    const out = changeEventsFor([widget('w1', { deleted: true }), widget('w2')])
    expect(out).toEqual([{ eventType: 'WidgetUpdated', objectId: 'w2', deskId: 'desk-1' }])
  })

  it('dec_056_non_object_rows_are_ignored', () => {
    expect(changeEventsFor([{ id: 'x', itemType: 'layout', deskId: null, deleted: false } as never])).toEqual([])
  })
})
