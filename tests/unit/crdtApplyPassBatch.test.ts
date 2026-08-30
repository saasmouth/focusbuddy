import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChangeEvent } from '../../src/shared/crdtWidgetMerge'

// Reload-storm regression (ryan-command-center): a crdtJoin replays the partition's
// whole log in ONE crdtSync frame, and every applier used to reflect its event into
// the renderer stores the moment its IPC settled — one setState per event, spread
// across the replay's IPC responses. Each landed as its own React update and a large
// enough burst tripped React's nested-update guard on every app reload ("Maximum
// update depth exceeded" via forceStoreRerender ← zustand setState ← the crdtSync
// apply path). The engine now coalesces a sync pass's store commits into a single
// synchronous flush, while every event still runs its full per-id path: the
// work_item trash router, and each window.api write whose main-side cascade + detach
// hooks (workItemDetachHook / normalizeAppliedWorkItem) are per call. Live single
// events (a plain crdtEvent frame) keep committing directly.

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
const widgetsUpdate = vi.fn(async (): Promise<void> => undefined)
const workItemKindOf = vi.fn(async (): Promise<string | null> => null)
const workItemApplySyncEvent = vi.fn(async (): Promise<void> => undefined)
;(window as unknown as { api: unknown }).api = {
  crdt: {
    record: vi.fn(async () => undefined),
    markSynced: vi.fn(async () => undefined),
    unsynced: vi.fn(async () => [])
  },
  nodes: { delete: nodesDelete, update: nodesUpdate },
  widgets: { update: widgetsUpdate },
  workItems: { kindOf: workItemKindOf, applySyncEvent: workItemApplySyncEvent }
}

const socket = (await import('../../src/renderer/src/lib/messagingSocket')) as unknown as SocketMock
const { initCrdtSync, stopCrdtSync } = await import('../../src/renderer/src/lib/crdtSync')
const { useNodeStore } = await import('../../src/renderer/src/stores/nodes')
const { useWidgetStore } = await import('../../src/renderer/src/stores/widgets')
const { useAccountStore } = await import('../../src/renderer/src/stores/account')

function node(id: string): { id: string; parentId: string | null; kind: string; title: string } {
  return { id, parentId: null, kind: 'folder', title: id }
}
function widget(id: string): Record<string, unknown> {
  return { id, taskId: 't1', kind: 'note', title: id, content: '', x: 0, y: 0, width: 10, height: 10, pinned: false }
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
    dataClass: field === 'delete' ? 'set' : 'register',
    actor: 'other:dev2',
    payload
  } as ChangeEvent
}
const nodeDelete = (id: string): ChangeEvent => ev('node', id, 'delete', { at: 1000 })
const nodeTitle = (id: string, title: string): ChangeEvent =>
  ev('node', id, 'title', { value: title, at: 2000 })
const widgetTitle = (id: string, title: string): ChangeEvent =>
  ev('widget', id, 'title', { value: title, at: 2000 })

function fire(e: unknown): void {
  const handler = socket.__crdtHandler()
  if (!handler) throw new Error('crdt socket handler was not registered')
  handler(e)
}
async function settled(): Promise<void> {
  // The apply path is a chain of microtasks (store-backed isWorkItemId, the stubbed
  // IPC, the flush's Promise.allSettled) — a few macrotask turns drain all of it.
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('crdt sync — a replay pass commits as one store update', () => {
  let nodeCommits: number
  let widgetCommits: number
  let unsub: Array<() => void>

  beforeEach(() => {
    vi.clearAllMocks()
    nodesDelete.mockImplementation(async (id: string) => [id])
    workItemKindOf.mockResolvedValue(null)
    useAccountStore.setState({ account: { id: 'acct1' } as never })
    useNodeStore.setState({ nodes: [], loaded: true, error: null, loading: false })
    useWidgetStore.setState({ widgets: [] as never })
    initCrdtSync()
    nodeCommits = 0
    widgetCommits = 0
    unsub = [
      useNodeStore.subscribe((s, p) => {
        if (s.nodes !== p.nodes) nodeCommits++
      }),
      useWidgetStore.subscribe((s, p) => {
        if (s.widgets !== p.widgets) widgetCommits++
      })
    ]
  })
  afterEach(() => {
    for (const u of unsub) u()
    stopCrdtSync()
  })

  it('a 60-delete replay burst lands as ONE setState, per-id IPC preserved', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `n${i}`)
    useNodeStore.setState({ nodes: [...ids.map(node), node('keep')] as never })
    nodeCommits = 0

    fire({ type: 'crdtSync', payload: { events: ids.map(nodeDelete) } })
    await settled()

    expect(useNodeStore.getState().nodes.map((n) => n.id)).toEqual(['keep'])
    // ONE commit for the whole burst — this is what keeps React's nested-update
    // guard (limit 50) out of reach on reload.
    expect(nodeCommits).toBe(1)
    // Batching the COMMIT must not batch the writes: every id still gets its own
    // nodes.delete IPC, so the main-side cascade + detach hooks run per call.
    expect(nodesDelete.mock.calls.map((c) => c[0]).sort()).toEqual([...ids].sort())
  })

  it('a mixed replay (deletes + node fields + widget fields) commits once per store', async () => {
    useNodeStore.setState({ nodes: [node('a'), node('b'), node('gone1'), node('gone2')] as never })
    useWidgetStore.setState({ widgets: [widget('w1'), widget('w2')] as never })
    nodeCommits = 0
    widgetCommits = 0

    fire({
      type: 'crdtSync',
      payload: {
        events: [
          nodeDelete('gone1'),
          nodeTitle('a', 'A renamed'),
          widgetTitle('w1', 'W1 renamed'),
          nodeDelete('gone2'),
          nodeTitle('b', 'B renamed'),
          widgetTitle('w2', 'W2 renamed')
        ]
      }
    })
    await settled()

    const nodes = useNodeStore.getState().nodes
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(nodes.map((n) => n.title)).toEqual(['A renamed', 'B renamed'])
    expect(useWidgetStore.getState().widgets.map((w) => w.title)).toEqual(['W1 renamed', 'W2 renamed'])
    // Two node writes (the delete Set + the two renames) collapse into the single
    // flush; same for the widget store.
    expect(nodeCommits).toBe(1)
    expect(widgetCommits).toBe(1)
  })

  it('a cascade returned by one delete joins the same single commit', async () => {
    useNodeStore.setState({ nodes: [node('root'), node('child'), node('other'), node('keep')] as never })
    nodeCommits = 0
    nodesDelete.mockImplementation(async (id: string) => (id === 'root' ? ['root', 'child'] : [id]))

    fire({ type: 'crdtSync', payload: { events: [nodeDelete('root'), nodeDelete('other')] } })
    await settled()

    expect(useNodeStore.getState().nodes.map((n) => n.id)).toEqual(['keep'])
    expect(nodeCommits).toBe(1)
  })

  it('a second frame arriving mid-pass joins it instead of committing separately', async () => {
    useNodeStore.setState({ nodes: [node('x'), node('y'), node('keep')] as never })
    nodeCommits = 0

    fire({ type: 'crdtSync', payload: { events: [nodeDelete('x')] } })
    fire({ type: 'crdtSync', payload: { events: [nodeDelete('y')] } }) // same tick, pass still open
    await settled()

    expect(useNodeStore.getState().nodes.map((n) => n.id)).toEqual(['keep'])
    expect(nodeCommits).toBe(1)
  })

  it('a work_item delete in the replay routes to the trash sweep, not the node store', async () => {
    useNodeStore.setState({ nodes: [node('plain')] as never })
    nodeCommits = 0
    workItemKindOf.mockResolvedValue('work_item') // 'wi1' is not in the node store

    fire({ type: 'crdtSync', payload: { events: [nodeDelete('wi1'), nodeDelete('plain')] } })
    await settled()

    expect(workItemApplySyncEvent).toHaveBeenCalledWith({ type: 'trash', id: 'wi1', trashed: true })
    expect(nodesDelete.mock.calls.map((c) => c[0])).toEqual(['plain'])
    expect(useNodeStore.getState().nodes).toEqual([])
    expect(nodeCommits).toBe(1)
  })

  it('a live single delete still commits directly (no pass open)', async () => {
    useNodeStore.setState({ nodes: [node('a'), node('b')] as never })
    nodeCommits = 0

    fire({ type: 'crdtEvent', payload: { event: nodeDelete('a') } })
    await settled()

    expect(useNodeStore.getState().nodes.map((n) => n.id)).toEqual(['b'])
    expect(nodeCommits).toBe(1)
  })

  it('two successive passes each commit — the coalescer never swallows the second', async () => {
    useNodeStore.setState({ nodes: [node('a'), node('b'), node('keep')] as never })
    nodeCommits = 0

    fire({ type: 'crdtSync', payload: { events: [nodeDelete('a')] } })
    await settled()
    fire({ type: 'crdtSync', payload: { events: [nodeDelete('b')] } })
    await settled()

    expect(useNodeStore.getState().nodes.map((n) => n.id)).toEqual(['keep'])
    expect(nodeCommits).toBe(2)
  })

  it('deferred reflects read flush-time state, not their own stale snapshot', async () => {
    useNodeStore.setState({ nodes: [node('a')] as never })
    nodeCommits = 0

    // A rename and a delete for DIFFERENT nodes in one pass: 'late' is added to the
    // store after the pass opens but before it flushes. The rename thunk must see
    // the store as of flush time, so 'late' survives the commit.
    fire({ type: 'crdtSync', payload: { events: [nodeTitle('a', 'renamed')] } })
    useNodeStore.setState((s) => ({ nodes: [...s.nodes, node('late')] as never }))
    await settled()

    const nodes = useNodeStore.getState().nodes
    expect(nodes.map((n) => n.id).sort()).toEqual(['a', 'late'])
    expect(nodes.find((n) => n.id === 'a')!.title).toBe('renamed')
  })
})
