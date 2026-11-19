import { describe, it, expect, vi, beforeEach } from 'vitest'

// Restores emit a CRDT event (4.3.51). Undo of a delete, redo of a create-undo and
// the Trash view bring the SAME id back out of the trash. Up to 4.3.50 none of them
// emitted anything, so the change log still ended "delete", and every sign-in
// replay deleted the desk or widget again for every device (reproduced live,
// 2026-11-19). The undo of a create also deleted without emitting, which left the
// log saying "created" for a desk that was gone. Each direction now tells the
// other devices.
//
// Plus the two pure rules the engine applies to incoming events.

// Every window.api method a store touches resolves undefined unless a test says
// otherwise, so the stores run their real paths.
const overrides: Record<string, (...a: unknown[]) => unknown> = {}
function anyApi(path: string[] = []): unknown {
  return new Proxy(() => undefined, {
    get: (_t, k: string) => anyApi([...path, k]),
    apply: (_t, _this, args) => {
      const key = path.join('.')
      return Promise.resolve(overrides[key] ? overrides[key](...args) : undefined)
    }
  })
}
;(window as unknown as { api: unknown }).api = anyApi()

const { registerCrdtEmit } = await import('../../src/renderer/src/lib/crdtBridge')
const { useNodeStore } = await import('../../src/renderer/src/stores/nodes')
const { useWidgetStore } = await import('../../src/renderer/src/stores/widgets')
const { useActionHistory } = await import('../../src/renderer/src/stores/actionHistory')
const { joinBacklogApplies, remoteDeleteIsStale } = await import('../../src/renderer/src/lib/syncFlags')

const emitted: Array<[string, unknown]> = []
const rec = (name: string) => (arg: unknown) => void emitted.push([name, arg])
registerCrdtEmit(
  new Proxy({} as never, {
    get: (_t, k: string) => rec(k)
  })
)
const lifecycle = (): Array<[string, unknown]> =>
  emitted.filter(([n]) => ['nodeDelete', 'nodeRestore', 'widgetDelete', 'widgetRestore'].includes(n))

beforeEach(() => {
  emitted.length = 0
  for (const k of Object.keys(overrides)) delete overrides[k]
  useActionHistory.setState({ past: [], future: [], toast: null } as never)
})

describe('undo and redo tell the other devices', () => {
  it('deleting a desk, then Undo, emits delete then restore for the same ids', async () => {
    overrides['nodes.delete'] = () => ['d1', 'child']
    overrides['nodes.list'] = () => []
    useNodeStore.setState({ nodes: [{ id: 'd1', parentId: null, kind: 'task', title: 'Desk' }] as never })
    await useNodeStore.getState().remove('d1')
    await useActionHistory.getState().undo()
    expect(lifecycle()).toEqual([
      ['nodeDelete', ['d1', 'child']],
      ['nodeRestore', ['d1', 'child']]
    ])
  })

  it('deleting a widget, then Undo, emits delete then restore', async () => {
    useWidgetStore.setState({ widgets: [{ id: 'w1', taskId: 't1', kind: 'sticky', title: '' }] as never })
    await useWidgetStore.getState().remove('w1')
    await useActionHistory.getState().undo()
    expect(lifecycle()).toEqual([
      ['widgetDelete', 'w1'],
      ['widgetRestore', 'w1']
    ])
  })

  it('creating a desk, Undo, then Redo emits create, delete, restore', async () => {
    overrides['nodes.create'] = (d) => ({ ...(d as object), id: 'new1', parentId: null, kind: 'task', title: 'N' })
    overrides['nodes.delete'] = () => ['new1']
    overrides['nodes.list'] = () => []
    useNodeStore.setState({ nodes: [] as never })
    await useNodeStore.getState().create({ parentId: null, kind: 'folder', title: 'N' } as never)
    await useActionHistory.getState().undo()
    await useActionHistory.getState().redo()
    expect(lifecycle()).toEqual([
      ['nodeDelete', ['new1']],
      ['nodeRestore', ['new1']]
    ])
    expect(emitted.some(([n]) => n === 'nodeCreate')).toBe(true)
  })
})

describe('what the engine applies from other devices', () => {
  it('a join backlog applies only for links and live-folder entries', () => {
    for (const pk of ['l:acct:a', 'l:org:o', 'l:desk:r', 'lfe:folder:f']) expect(joinBacklogApplies(pk), pk).toBe(true)
    for (const pk of ['w:acct:a', 'n:acct:a', 'r:org:o', 't:acct:a', 'f:acct:a', 'd:acct:a', 'w:desk:r', 'n:desk:r', ''])
      expect(joinBacklogApplies(pk), pk).toBe(false)
  })

  it('a delete older than the local row is stale; a newer one, or no local time, is not', () => {
    expect(remoteDeleteIsStale(5000, 1000)).toBe(true) // restored at 5000, deleted at 1000
    expect(remoteDeleteIsStale(1000, 5000)).toBe(false)
    expect(remoteDeleteIsStale(1000, 1000)).toBe(false)
    expect(remoteDeleteIsStale(undefined, 1000)).toBe(false)
    expect(remoteDeleteIsStale(5000, Number.NaN)).toBe(false)
  })
})
