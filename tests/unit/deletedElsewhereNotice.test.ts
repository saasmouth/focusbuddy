// "Deleted on another device": the notice and the Trash dot (4.3.55).
//
// Owner's rule via d0, 24 Nov 2026: subtle, house style, and only for things on
// the desk you have open. When a delete made elsewhere (another device, or a
// collaborator on a shared desk) takes something off the desk on screen, the house
// notice says so once, with Restore when it is one thing (Open Trash when it is
// several), and the Trash gets a dot until it is opened. A delete of something
// that is not on screen says nothing: it is in the Trash, labelled.
//
// Both ways a delete arrives are covered: the poll (a pulled tombstone) and the
// CRDT channel (crdtSync's appliers call the same function before the stores drop
// the item). The decision is made from the stores BEFORE they drop it, which is
// also what keeps it to the open desk.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useViewStore } from '@renderer/stores/view'
import { useWidgetStore } from '@renderer/stores/widgets'
import { useTablesStore } from '@renderer/stores/tables'
import { useNodeStore } from '@renderer/stores/nodes'
import { useNoticeStore } from '@renderer/stores/notice'
import { useAccountStore } from '@renderer/stores/account'
import { useOrgStore } from '@renderer/stores/org'
import { onOpenDesk, announceDeletedElsewhere, useTrashDot, clearTrashDot } from '@renderer/lib/deletedElsewhere'
import { syncWorkspaceOnce } from '@renderer/lib/workspaceSync'

const widget = (id: string, taskId: string, title = ''): Record<string, unknown> => ({ id, taskId, kind: 'sticky', title, content: '' })
let trashApi: Record<string, ReturnType<typeof vi.fn>>
let reloadDesk: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  useViewStore.setState({ view: { kind: 'task', taskId: 'd1' } } as never)
  useNodeStore.setState({ nodes: [{ id: 'd1', kind: 'task', title: 'Launch plan', sharedRootId: null }] } as never)
  reloadDesk = vi.fn(async () => undefined)
  useWidgetStore.setState({ widgets: [widget('w1', 'd1', 'Budget'), widget('w2', 'd1', ''), widget('w9', 'd2', 'Elsewhere')], loadForTask: reloadDesk } as never)
  useTablesStore.setState({
    tables: { t1: { id: 't1', taskId: 'd1', title: 'Suppliers' }, t9: { id: 't9', taskId: 'd2', title: 'Other' } },
    rows: { t1: [{ id: 'r1', tableId: 't1', cells: { a: 'Acme' } }] }
  } as never)
  useNoticeStore.getState().clear()
  clearTrashDot()
  trashApi = {
    restoreDeletedElsewhere: vi.fn(async () => ({ restored: true, ids: ['w1'] })),
    listDeletedElsewhere: vi.fn(async () => [])
  }
  ;(window as unknown as { api: unknown }).api = { trash: trashApi }
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('only what is on the desk you have open', () => {
  it('widgets, tables and rows on the open desk; not another desk\'s, not unknown ids', () => {
    const hits = onOpenDesk([
      { itemType: 'widget', id: 'w1' },
      { itemType: 'widget', id: 'w9' },
      { itemType: 'widget', id: 'nope' },
      { itemType: 'table', id: 't1' },
      { itemType: 'table', id: 't9' },
      { itemType: 'row', id: 'r1' }
    ])
    expect(hits).toEqual([
      { kind: 'widget', id: 'w1', title: 'Budget' },
      { kind: 'table', id: 't1', title: 'Suppliers' },
      { kind: 'row', id: 'r1', title: 'Acme' }
    ])
  })

  it('the open desk itself', () => {
    expect(onOpenDesk([{ itemType: 'node', id: 'd1' }])).toEqual([{ kind: 'node', id: 'd1', title: 'Launch plan' }])
  })

  it('nothing when no desk is open', () => {
    useViewStore.setState({ view: { kind: 'trash' } } as never)
    expect(onOpenDesk([{ itemType: 'widget', id: 'w1' }])).toEqual([])
  })

  it('an untitled widget is named as its frame names it (widgetDisplayName)', () => {
    expect(onOpenDesk([{ itemType: 'widget', id: 'w2' }])).toEqual([{ kind: 'widget', id: 'w2', title: 'Sticky' }])
  })
})

describe('the notice and the dot', () => {
  it('one thing: says what and where it went, offers Restore, and lights the dot', async () => {
    announceDeletedElsewhere([{ kind: 'widget', id: 'w1', title: 'Budget' }])
    const n = useNoticeStore.getState().notice
    expect(n?.text).toBe('“Budget” was deleted on another device.')
    expect(n?.action?.label).toBe('Restore')
    expect(useTrashDot.getState().on).toBe(true)
    n!.action!.run()
    await vi.waitFor(() => expect(trashApi.restoreDeletedElsewhere).toHaveBeenCalledWith('widget', 'w1'))
    // ...and it is back on the desk on screen at once.
    await vi.waitFor(() => expect(reloadDesk).toHaveBeenCalledWith('d1', { refresh: true }))
  })

  it('several things: one line, and the way to the Trash', () => {
    announceDeletedElsewhere([
      { kind: 'widget', id: 'w1', title: 'Budget' },
      { kind: 'table', id: 't1', title: 'Suppliers' }
    ])
    const n = useNoticeStore.getState().notice
    expect(n?.text).toBe('2 things on this desk were deleted on another device.')
    expect(n?.action?.label).toBe('Open Trash')
    n!.action!.run()
    expect(useViewStore.getState().view).toEqual({ kind: 'trash' })
  })

  it('on a shared desk, or in an org workspace, it may have been someone else: the notice says so', () => {
    useNodeStore.setState({ nodes: [{ id: 'd1', kind: 'task', title: 'Launch plan', sharedRootId: 'd1' }] } as never)
    announceDeletedElsewhere([{ kind: 'widget', id: 'w1', title: 'Budget' }])
    expect(useNoticeStore.getState().notice?.text).toBe('“Budget” was deleted on another device or by someone you work with.')
    useNodeStore.setState({ nodes: [{ id: 'd1', kind: 'task', title: 'Launch plan', sharedRootId: null }] } as never)
    useOrgStore.setState({ activeOrgId: 'org_team', orgs: [{ id: 'org_team', name: 'Team' }] } as never)
    announceDeletedElsewhere([{ kind: 'widget', id: 'w1', title: 'Budget' }])
    expect(useNoticeStore.getState().notice?.text).toBe('“Budget” was deleted on another device or by someone you work with.')
    useOrgStore.setState({ activeOrgId: null, orgs: [] } as never)
  })

  it('when the org pull says who, the notice says who', () => {
    announceDeletedElsewhere([{ kind: 'widget', id: 'w1', title: 'Budget', by: 'Sam Lee' }])
    expect(useNoticeStore.getState().notice?.text).toBe('“Budget” was deleted by Sam Lee.')
    announceDeletedElsewhere([
      { kind: 'widget', id: 'w1', title: 'Budget', by: 'Sam Lee' },
      { kind: 'table', id: 't1', title: 'Suppliers', by: 'Sam Lee' }
    ])
    expect(useNoticeStore.getState().notice?.text).toBe('2 things on this desk were deleted by Sam Lee.')
    // Two different people, or one unknown: no name rather than half of one.
    announceDeletedElsewhere([
      { kind: 'widget', id: 'w1', title: 'Budget', by: 'Sam Lee' },
      { kind: 'table', id: 't1', title: 'Suppliers' }
    ])
    expect(useNoticeStore.getState().notice?.text).toBe('2 things on this desk were deleted on another device.')
  })

  it('onOpenDesk carries the name a pulled tombstone brings', () => {
    expect(onOpenDesk([{ itemType: 'widget', id: 'w1', deletedByName: 'Sam Lee' }])).toEqual([{ kind: 'widget', id: 'w1', title: 'Budget', by: 'Sam Lee' }])
  })

  it('nothing to say, nothing shown', () => {
    announceDeletedElsewhere([])
    expect(useNoticeStore.getState().notice).toBeNull()
    expect(useTrashDot.getState().on).toBe(false)
  })

  it('the dot survives a restart until the Trash is opened', async () => {
    announceDeletedElsewhere([{ kind: 'widget', id: 'w1', title: 'Budget' }])
    expect(localStorage.getItem('fb.trash.deletedElsewhereDot')).toBe('1')
    clearTrashDot()
    expect(useTrashDot.getState().on).toBe(false)
    expect(localStorage.getItem('fb.trash.deletedElsewhereDot')).toBeNull()
  })
})

describe('a pulled tombstone for something on the open desk is announced', () => {
  it('the poll path', async () => {
    const json = (b: Record<string, unknown>): Response => new Response(JSON.stringify(b), { status: 200 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/workspace/sync?')
          ? json({ ok: true, items: [{ id: 'w1', itemType: 'widget', rev: 9, deleted: true, body: { id: 'w1' } }], now: 2 })
          : json({ ok: true, items: [], now: 1, roots: [], owned: [] })
      )
    )
    const none = async (): Promise<{ upserts: never[]; deletes: never[] }> => ({ upserts: [], deletes: [] })
    const ws = {
      pending: vi.fn(none),
      pendingShared: vi.fn(none),
      pendingOrg: vi.fn(none),
      getCursor: vi.fn(async () => 0),
      getCursorShared: vi.fn(async () => 0),
      setCursor: vi.fn(async () => undefined),
      setCursorShared: vi.fn(async () => undefined),
      markPushed: vi.fn(async () => undefined),
      advanceBaseRev: vi.fn(async () => undefined),
      applyRemote: vi.fn(async () => ({ applied: 1, failed: 0 })),
      applyRemoteShared: vi.fn(async () => ({ applied: 0 })),
      localSharedRoots: vi.fn(async () => []),
      pruneSharedDesk: vi.fn(async () => 0),
      adoptSharedDesk: vi.fn(),
      filesMissingBytes: vi.fn(async () => [])
    }
    ;(window as unknown as { api: unknown }).api = { trash: trashApi, workspaceSync: ws }
    localStorage.setItem('fb.sync.repull.4351', '1')
    useAccountStore.setState({ sessionToken: 'tok' })
    useOrgStore.setState({ activeOrgId: null, orgs: [] } as never)
    await syncWorkspaceOnce()
    useAccountStore.setState({ sessionToken: null })
    expect(useNoticeStore.getState().notice?.text).toBe('“Budget” was deleted on another device.')
  })
})

describe('an org pull that says who deleted it names them in the notice', () => {
  it('the org poll path', async () => {
    const json = (b: Record<string, unknown>): Response => new Response(JSON.stringify(b), { status: 200 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/workspace/org/sync')
          ? json({ ok: true, items: [{ id: 'w1', itemType: 'widget', rev: 9, deleted: true, body: { id: 'w1' }, deletedByName: 'Sam Lee' }], now: 2 })
          : json({ ok: true, items: [], now: 1, roots: [], owned: [] })
      )
    )
    const none = async (): Promise<{ upserts: never[]; deletes: never[] }> => ({ upserts: [], deletes: [] })
    const ws = {
      pending: vi.fn(none), pendingShared: vi.fn(none), pendingOrg: vi.fn(none),
      getCursor: vi.fn(async () => 0), getCursorShared: vi.fn(async () => 0), getCursorOrg: vi.fn(async () => 0),
      setCursor: vi.fn(async () => undefined), setCursorShared: vi.fn(async () => undefined), setCursorOrg: vi.fn(async () => undefined),
      markPushed: vi.fn(async () => undefined), advanceBaseRev: vi.fn(async () => undefined),
      applyRemote: vi.fn(async () => ({ applied: 0, failed: 0 })), applyRemoteShared: vi.fn(async () => ({ applied: 0 })),
      // 0 applied: the store refresh after an apply is not what this is about.
      applyRemoteOrg: vi.fn(async () => ({ applied: 0 })),
      localSharedRoots: vi.fn(async () => []), pruneSharedDesk: vi.fn(async () => 0), adoptSharedDesk: vi.fn(),
      filesMissingBytes: vi.fn(async () => []), hasLocalFileBytes: vi.fn(async () => true)
    }
    ;(window as unknown as { api: unknown }).api = { trash: trashApi, workspaceSync: ws }
    localStorage.setItem('fb.sync.repull.4351', '1')
    useAccountStore.setState({ sessionToken: 'tok' })
    useOrgStore.setState({ activeOrgId: 'org_team', orgs: [{ id: 'org_team', name: 'Team' }] } as never)
    await syncWorkspaceOnce()
    useAccountStore.setState({ sessionToken: null })
    useOrgStore.setState({ activeOrgId: null, orgs: [] } as never)
    expect(useNoticeStore.getState().notice?.text).toBe('“Budget” was deleted by Sam Lee.')
    // ...and main was handed the name to keep.
    expect(ws.applyRemoteOrg.mock.calls[0][0]).toEqual([expect.objectContaining({ id: 'w1', deletedByName: 'Sam Lee' })])
  })
})
