import { describe, it, expect, vi, beforeEach } from 'vitest'
import { bringWidgetToDesk } from '../../src/renderer/src/lib/bringWidgetToDesk'
import type { Widget } from '@shared/types'

// Bring-a-widget-onto-a-desk (assemble-a-desk). Synced brings a live-linked copy
// (shared syncGroupId); disconnected brings an independent copy (no group).

function w(over: Partial<Widget> = {}): Widget {
  return {
    id: 'src', taskId: 'deskA', kind: 'sticky', title: 'Note', content: 'hello',
    x: 10, y: 20, width: 200, height: 150, zIndex: 1, color: null,
    pinned: false, pinnedScreenX: null, pinnedScreenY: null, pinnedZone: null,
    parentSectionId: null, layout: null, sourceAppId: null, mode: null,
    livingQuery: null, livingGeneratedAt: null, livingPaused: false,
    createdAt: 0, updatedAt: 0, archived: false, syncGroupId: null,
    ...over
  } as Widget
}

describe('assemble — bring a widget onto a desk', () => {
  const update = vi.fn(async () => ({}))
  const create = vi.fn(async (d: { syncGroupId?: string }) => ({ id: 'new', ...d }))

  beforeEach(() => {
    update.mockClear()
    create.mockClear()
    ;(window as unknown as { api: unknown }).api = { widgets: { update, create } }
  })

  it('a widget nobody sized takes the standard size when it moves to another desk', async () => {
    await bringWidgetToDesk(w({ kind: 'doc', width: 860, height: 760 }), 'deskB', { synced: false })
    expect(create.mock.calls[0][0]).toMatchObject({ width: 960, height: 660 })
  })

  it('a widget somebody sized keeps that size when it moves', async () => {
    await bringWidgetToDesk(w({ kind: 'doc', width: 700, height: 500 }), 'deskB', { synced: false })
    expect(create.mock.calls[0][0]).toMatchObject({ width: 700, height: 500 })
  })

  it('test_synced_copy_shares_a_new_group_and_stamps_the_source', async () => {
    await bringWidgetToDesk(w({ syncGroupId: null }), 'deskB', { synced: true, x: 40, y: 40 })
    // Source gets a fresh group, and the copy is created into deskB sharing it.
    expect(update).toHaveBeenCalledTimes(1)
    const groupId = (update.mock.calls[0][1] as { syncGroupId: string }).syncGroupId
    expect(groupId).toBeTruthy()
    const draft = create.mock.calls[0][0] as { taskId: string; syncGroupId?: string; content: string; x: number }
    expect(draft.taskId).toBe('deskB')
    expect(draft.syncGroupId).toBe(groupId)
    expect(draft.content).toBe('hello')
    expect(draft.x).toBe(40)
  })

  it('test_synced_copy_reuses_an_existing_group', async () => {
    await bringWidgetToDesk(w({ syncGroupId: 'grp-1' }), 'deskB', { synced: true })
    expect(update).not.toHaveBeenCalled() // already grouped, do not re-stamp
    expect((create.mock.calls[0][0] as { syncGroupId?: string }).syncGroupId).toBe('grp-1')
  })

  it('test_disconnected_copy_has_no_group_and_never_touches_the_source', async () => {
    await bringWidgetToDesk(w({ syncGroupId: null }), 'deskB', { synced: false })
    expect(update).not.toHaveBeenCalled()
    expect((create.mock.calls[0][0] as { syncGroupId?: string }).syncGroupId).toBeUndefined()
  })
})
