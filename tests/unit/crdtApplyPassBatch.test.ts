import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChangeEvent } from '../../src/shared/crdtWidgetMerge'

// Two rules about what the CRDT engine applies, both pinned here.
//
// 1. A JOIN BACKLOG (the crdtSync frame a crdtJoin answers with) is applied only for
//    the kinds nothing else delivers: widget links (`l:`) and live-folder entries
//    (`lfe:`). For every poll-backed kind (`w:`, `n:`, `r:`, `t:`, `f:`, `d:`) the
//    backlog is ignored and its events are only marked synced (4.3.51). Replaying
//    those logs over current rows destroyed data on every sign-in up to 4.3.50:
//    old creates force-written over live rows, tombstones brought back, desks
//    restored with Undo deleted again for everyone (2026-11-19).
//
// 2. A backlog that IS applied commits as ONE store update (reload-storm regression,
//    ryan-command-center): every applier used to reflect its event the moment its IPC
//    settled, one setState per event, and a large burst tripped React's nested-update
//    guard ("Maximum update depth exceeded"). The engine coalesces a pass's store
//    commits into one flush, while every event still runs its own per-id IPC. Live
//    single events (a plain crdtEvent frame) keep committing directly.

interface SocketMock {
  sendSocketMessage: ReturnType<typeof vi.fn>
  setCrdtSocketHandler: (cb: ((e: unknown) => void) | null) => void
  setCrdtOpenHandler: ReturnType<typeof vi.fn>
  __crdtHandler: () => ((e: unknown) => void) | null
}

vi.mock('../../src/renderer/src/lib/messagingSocket', () => {
  let handler: ((e: unknown) => void) | null = null
  return {
    sendSocketMessage: vi.fn(),
    setCrdtSocketHandler: (cb: ((e: unknown) => void) | null): void => {
      handler = cb
    },
    setCrdtOpenHandler: vi.fn(),
    __crdtHandler: (): ((e: unknown) => void) | null => handler
  }
})

// window.api must exist before the engine + store modules load.
const nodesDelete = vi.fn(async (id: string): Promise<string[]> => [id])
const nodesUpdate = vi.fn(async (): Promise<void> => undefined)
const nodesRestore = vi.fn(async (): Promise<boolean> => true)
const nodesList = vi.fn(async (): Promise<unknown[]> => [])
const nodesCreate = vi.fn(async (d: unknown): Promise<unknown> => d)
const widgetsCreate = vi.fn(async (d: unknown): Promise<unknown> => d)
const widgetsUpdate = vi.fn(async (): Promise<void> => undefined)
const widgetsDelete = vi.fn(async (): Promise<boolean> => true)
const widgetsGet = vi.fn(async (): Promise<unknown> => null)
const linksDelete = vi.fn(async (): Promise<boolean> => true)
const markSynced = vi.fn(async () => undefined)
const workItemKindOf = vi.fn(async (): Promise<string | null> => null)
const workItemApplySyncEvent = vi.fn(async (): Promise<void> => undefined)
;(window as unknown as { api: unknown }).api = {
  crdt: {
    record: vi.fn(async () => undefined),
    markSynced,
    unsynced: vi.fn(async () => [])
  },
  nodes: { delete: nodesDelete, update: nodesUpdate, restore: nodesRestore, list: nodesList, create: nodesCreate },
  widgets: { create: widgetsCreate, update: widgetsUpdate, delete: widgetsDelete, get: widgetsGet },
  widgetLinks: { delete: linksDelete },
  workItems: { kindOf: workItemKindOf, applySyncEvent: workItemApplySyncEvent }
}

const socket = (await import('../../src/renderer/src/lib/messagingSocket')) as unknown as SocketMock
const { initCrdtSync, stopCrdtSync } = await import('../../src/renderer/src/lib/crdtSync')
const { useNodeStore } = await import('../../src/renderer/src/stores/nodes')
const { useWidgetStore } = await import('../../src/renderer/src/stores/widgets')
const { useLinksStore } = await import('../../src/renderer/src/stores/links')
const { useAccountStore } = await import('../../src/renderer/src/stores/account')

function node(id: string, updatedAt = 0): { id: string; parentId: string | null; kind: string; title: string; updatedAt: number } {
  return { id, parentId: null, kind: 'folder', title: id, updatedAt }
}
function link(id: string): Record<string, unknown> {
  return { id, sourceWidgetId: 'a', targetWidgetId: 'b', taskId: 't1', type: 'note' }
}

let seq = 0
function ev(objectType: string, objectId: string, field: string, payload: Record<string, unknown>): ChangeEvent {
  return {
    id: `ev-${seq++}`,
    ts: new Date(1000).toISOString(),
    partitionKey: `${objectType[0]}:acct:acct1`,
    objectType,
    objectId,
    field,
    dataClass: field === 'delete' || field === 'restore' || field === 'create' ? 'set' : 'register',
    actor: 'other:dev2',
    payload
  } as ChangeEvent
}
const nodeDelete = (id: string, at = 1000): ChangeEvent => ev('node', id, 'delete', { at })
const nodeRestore = (id: string): ChangeEvent => ev('node', id, 'restore', { at: 3000 })
const nodeCreate = (id: string): ChangeEvent => ev('node', id, 'create', { snapshot: node(id) })
const widgetCreate = (id: string): ChangeEvent =>
  ev('widget', id, 'create', { snapshot: { id, taskId: 't1', kind: 'note', title: id, content: '', x: 0, y: 0, width: 10, height: 10 } })
const linkDelete = (id: string): ChangeEvent => ev('link', id, 'delete', { at: 1000 })

function fire(e: unknown): void {
  const handler = socket.__crdtHandler()
  if (!handler) throw new Error('crdt socket handler was not registered')
  handler(e)
}
const backlog = (partitionKey: string, events: ChangeEvent[]): unknown => ({ type: 'crdtSync', payload: { partitionKey, events } })
async function settled(): Promise<void> {
  // The apply path is a chain of microtasks (store-backed isWorkItemId, the stubbed
  // IPC, the flush's Promise.allSettled) — a few macrotask turns drain all of it.
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('crdt sync — what a join backlog applies, and how', () => {
  let nodeCommits: number
  let linkCommits: number
  let unsub: Array<() => void>

  beforeEach(() => {
    vi.clearAllMocks()
    nodesDelete.mockImplementation(async (id: string) => [id])
    workItemKindOf.mockResolvedValue(null)
    useAccountStore.setState({ account: { id: 'acct1' } as never })
    useNodeStore.setState({ nodes: [], loaded: true, error: null, loading: false })
    useWidgetStore.setState({ widgets: [] as never })
    useLinksStore.setState({ links: [] as never })
    initCrdtSync()
    nodeCommits = 0
    linkCommits = 0
    unsub = [
      useNodeStore.subscribe((s, p) => {
        if (s.nodes !== p.nodes) nodeCommits++
      }),
      useLinksStore.subscribe((s, p) => {
        if (s.links !== p.links) linkCommits++
      })
    ]
  })
  afterEach(() => {
    for (const u of unsub) u()
    stopCrdtSync()
  })

  it('a poll-backed backlog (desks, widgets) applies nothing and only marks its events synced', async () => {
    useNodeStore.setState({ nodes: [node('restored'), node('live')] as never })
    nodeCommits = 0
    // The shape that deleted desks for everyone: an old delete for a desk restored
    // since, an old create for a desk deleted outside CRDT, old widget creates.
    const nodeEvents = [nodeDelete('restored'), nodeCreate('zombie')]
    const widgetEvents = [widgetCreate('w-old')]
    fire(backlog('n:acct:acct1', nodeEvents))
    fire(backlog('w:acct:acct1', widgetEvents))
    await settled()

    expect(nodesDelete).not.toHaveBeenCalled()
    expect(nodesCreate).not.toHaveBeenCalled()
    expect(widgetsCreate).not.toHaveBeenCalled()
    expect(useNodeStore.getState().nodes.map((n) => n.id)).toEqual(['restored', 'live'])
    expect(nodeCommits).toBe(0)
    expect(markSynced.mock.calls.flatMap((c) => (c[0] as Array<{ id: string }>).map((e) => e.id))).toEqual(
      [...nodeEvents, ...widgetEvents].map((e) => e.id)
    )
  })

  it('every poll-backed prefix is ignored and the two CRDT-only prefixes are applied', async () => {
    for (const pk of ['w:acct:acct1', 'n:org:o1', 'r:acct:acct1', 't:acct:acct1', 'f:acct:acct1', 'd:acct:acct1', 'w:desk:root1']) {
      fire(backlog(pk, [nodeDelete(`x-${pk}`)]))
    }
    await settled()
    expect(nodesDelete).not.toHaveBeenCalled()
    fire(backlog('l:acct:acct1', [linkDelete('l1')]))
    await settled()
    expect(linksDelete).toHaveBeenCalledWith('l1')
  })

  it('a 60-delete link backlog lands as ONE setState, per-id IPC preserved', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `l${i}`)
    useLinksStore.setState({ links: [...ids.map(link), link('keep')] as never })
    linkCommits = 0

    fire(backlog('l:acct:acct1', ids.map(linkDelete)))
    await settled()

    expect(useLinksStore.getState().links.map((l) => l.id)).toEqual(['keep'])
    // ONE commit for the whole burst — what keeps React's nested-update guard
    // (limit 50) out of reach on reload.
    expect(linkCommits).toBe(1)
    // Batching the COMMIT must not batch the writes: every id gets its own IPC.
    expect(linksDelete.mock.calls.map((c) => c[0]).sort()).toEqual([...ids].sort())
  })

  it('a second link frame arriving mid-pass joins it instead of committing separately', async () => {
    useLinksStore.setState({ links: [link('x'), link('y'), link('keep')] as never })
    linkCommits = 0

    fire(backlog('l:acct:acct1', [linkDelete('x')]))
    fire(backlog('l:acct:acct1', [linkDelete('y')])) // same tick, pass still open
    await settled()

    expect(useLinksStore.getState().links.map((l) => l.id)).toEqual(['keep'])
    expect(linkCommits).toBe(1)
  })

  it('two successive link passes each commit — the coalescer never swallows the second', async () => {
    useLinksStore.setState({ links: [link('a'), link('b'), link('keep')] as never })
    linkCommits = 0

    fire(backlog('l:acct:acct1', [linkDelete('a')]))
    await settled()
    fire(backlog('l:acct:acct1', [linkDelete('b')]))
    await settled()

    expect(useLinksStore.getState().links.map((l) => l.id)).toEqual(['keep'])
    expect(linkCommits).toBe(2)
  })

  it('a live single delete still applies and commits directly (no pass open)', async () => {
    useNodeStore.setState({ nodes: [node('a'), node('b')] as never })
    nodeCommits = 0

    fire({ type: 'crdtEvent', payload: { event: nodeDelete('a') } })
    await settled()

    expect(nodesDelete).toHaveBeenCalledWith('a', 'sync')
    expect(useNodeStore.getState().nodes.map((n) => n.id)).toEqual(['b'])
    expect(nodeCommits).toBe(1)
  })

  it('a live delete OLDER than the local row (restored or edited since) is not applied', async () => {
    // The desk was restored at 5000; the delete was made at 1000.
    useNodeStore.setState({ nodes: [node('restored', 5000), node('other', 500)] as never })
    fire({ type: 'crdtEvent', payload: { event: nodeDelete('restored', 1000) } })
    fire({ type: 'crdtEvent', payload: { event: nodeDelete('other', 1000) } })
    await settled()
    expect(nodesDelete.mock.calls.map((c) => c[0])).toEqual(['other'])
    expect(useNodeStore.getState().nodes.map((n) => n.id)).toEqual(['restored'])
  })

  it('a live restore brings the desk back here, as a sync write that never re-pushes', async () => {
    nodesList.mockResolvedValue([node('back')])
    fire({ type: 'crdtEvent', payload: { event: nodeRestore('back') } })
    await settled()
    expect(nodesRestore).toHaveBeenCalledWith(['back'], 'sync')
    await settled()
    expect(useNodeStore.getState().nodes.map((n) => n.id)).toEqual(['back'])
  })

  it('a live work_item delete routes to the trash sweep, not the node store', async () => {
    useNodeStore.setState({ nodes: [node('plain')] as never })
    workItemKindOf.mockResolvedValue('work_item') // 'wi1' is not in the node store

    fire({ type: 'crdtEvent', payload: { event: nodeDelete('wi1') } })
    await settled()

    expect(workItemApplySyncEvent).toHaveBeenCalledWith({ type: 'trash', id: 'wi1', trashed: true })
    expect(nodesDelete).not.toHaveBeenCalled()
  })
})
