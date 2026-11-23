// The CRDT channel half of "deleted on another device" (4.3.55): a live delete
// event from another device that takes something off the open desk is announced
// once (lib/deletedElsewhere.ts), a burst of them as one line, and a delete on a
// desk that is not open says nothing. The poll half is in deletedElsewhereNotice.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChangeEvent } from '../../src/shared/crdtWidgetMerge'

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

;(window as unknown as { api: unknown }).api = {
  crdt: { record: vi.fn(async () => undefined), markSynced: vi.fn(async () => undefined), unsynced: vi.fn(async () => []) },
  nodes: {
    delete: vi.fn(async (id: string) => [id]),
    update: vi.fn(async () => undefined),
    restore: vi.fn(async () => true),
    list: vi.fn(async () => []),
    create: vi.fn(async (d: unknown) => d)
  },
  widgets: {
    create: vi.fn(async (d: unknown) => d),
    update: vi.fn(async () => undefined),
    delete: vi.fn(async () => true),
    get: vi.fn(async () => null)
  },
  widgetLinks: { delete: vi.fn(async () => true) },
  workItems: { kindOf: vi.fn(async () => null), applySyncEvent: vi.fn(async () => undefined) },
  trash: { restoreDeletedElsewhere: vi.fn(async () => ({ restored: true, ids: [] })) }
}

const socket = (await import('../../src/renderer/src/lib/messagingSocket')) as unknown as {
  __crdtHandler: () => ((e: unknown) => void) | null
}
const { initCrdtSync, stopCrdtSync } = await import('../../src/renderer/src/lib/crdtSync')
const { useNodeStore } = await import('../../src/renderer/src/stores/nodes')
const { useWidgetStore } = await import('../../src/renderer/src/stores/widgets')
const { useViewStore } = await import('../../src/renderer/src/stores/view')
const { useNoticeStore } = await import('../../src/renderer/src/stores/notice')
const { useAccountStore } = await import('../../src/renderer/src/stores/account')
const { clearTrashDot, useTrashDot } = await import('../../src/renderer/src/lib/deletedElsewhere')

let seq = 0
const ev = (objectType: string, objectId: string): ChangeEvent =>
  ({
    id: `ev-${seq++}`,
    ts: new Date(5000).toISOString(),
    partitionKey: `${objectType[0]}:acct:acct1`,
    objectType,
    objectId,
    field: 'delete',
    dataClass: 'set',
    actor: 'other:dev2',
    payload: { at: 5000 }
  }) as ChangeEvent
function fire(e: ChangeEvent): void {
  const h = socket.__crdtHandler()
  if (!h) throw new Error('crdt socket handler was not registered')
  h({ type: 'crdtEvent', payload: { event: e } })
}
async function settled(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}
const widget = (id: string, taskId: string, title: string): Record<string, unknown> => ({
  id, taskId, kind: 'sticky', title, content: '', updatedAt: 0
})

describe('a live delete from another device, on the desk you have open', () => {
  beforeEach(() => {
    localStorage.clear()
    useAccountStore.setState({ account: { id: 'acct1' } as never })
    useViewStore.setState({ view: { kind: 'task', taskId: 'd1' } } as never)
    useNodeStore.setState({ nodes: [{ id: 'd1', parentId: null, kind: 'task', title: 'Launch plan', updatedAt: 0 }], loaded: true, error: null, loading: false } as never)
    useWidgetStore.setState({ widgets: [widget('w1', 'd1', 'Budget'), widget('w2', 'd1', 'Plan'), widget('w9', 'd2', 'Not here')] } as never)
    useNoticeStore.getState().clear()
    clearTrashDot()
    initCrdtSync()
  })
  afterEach(() => stopCrdtSync())

  it('one widget: the notice names it, and the Trash gets its dot', async () => {
    fire(ev('widget', 'w1'))
    await settled()
    expect(useNoticeStore.getState().notice?.text).toBe('“Budget” was deleted on another device.')
    expect(useTrashDot.getState().on).toBe(true)
  })

  it('a burst is one line', async () => {
    fire(ev('widget', 'w1'))
    fire(ev('widget', 'w2'))
    await settled()
    expect(useNoticeStore.getState().notice?.text).toBe('2 things on this desk were deleted on another device.')
  })

  it('a widget on another desk: nothing said', async () => {
    fire(ev('widget', 'w9'))
    await settled()
    expect(useNoticeStore.getState().notice).toBeNull()
    expect(useTrashDot.getState().on).toBe(false)
  })

  it('the open desk itself', async () => {
    fire(ev('node', 'd1'))
    await settled()
    expect(useNoticeStore.getState().notice?.text).toBe('“Launch plan” was deleted on another device.')
  })
})
