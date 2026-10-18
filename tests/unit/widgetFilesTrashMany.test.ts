// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The renderer's "Delete N work widgets" (useWidgetFilesStore.trashMany) —
// docs/widget-files.md, "Remove or delete". A multi-selection's Delete, from
// the Delete key, the selection bar, the context menu or the assistant, must
// trash every file through main, say so in ONE notice with ONE Undo, and leave
// one undo step that restores them all. Stores and IPC are stubbed; the logic
// under test is the store's own.

const notices: Array<{ text: string; action?: { label: string; run: () => void } }> = []
let openView: { kind: string; documentId?: string } = { kind: 'task' }
const backSpy = vi.fn()

vi.mock('../../src/renderer/src/stores/widgets', () => ({
  useWidgetStore: Object.assign(
    { getState: () => ({ widgets: [], bumpLayoutVersion: () => {}, loadForTask: async () => {} }) },
    { setState: () => {} }
  )
}))
vi.mock('../../src/renderer/src/stores/view', () => ({
  useViewStore: { getState: () => ({ view: openView, back: backSpy, goDocument: () => {} }) }
}))
vi.mock('../../src/renderer/src/stores/nodes', () => ({ useNodeStore: { getState: () => ({ activeTaskId: null }) } }))
vi.mock('../../src/renderer/src/stores/documents', () => ({
  useDocumentsStore: Object.assign({ getState: () => ({ list: [] }) }, { setState: () => {} })
}))
vi.mock('../../src/renderer/src/stores/notice', () => ({
  useNoticeStore: { getState: () => ({ show: (n: (typeof notices)[number]) => notices.push(n) }) }
}))
vi.mock('../../src/renderer/src/lib/syncNudge', () => ({ nudgeSync: () => {} }))
vi.mock('../../src/renderer/src/lib/fitDroppedWidget', () => ({ fitNewWidgetToView: (d: unknown) => d }))

const trashed = new Set<string>()
const restored: string[] = []
const instancesOf: Record<string, Array<{ taskId: string }>> = {}
;(globalThis as unknown as { window: unknown }).window = {
  api: {
    widgetFiles: {
      get: async (id: string) => ({ id, title: `File ${id}`, kind: 'sticky', trashed: trashed.has(id) }),
      instances: async (id: string) => instancesOf[id] ?? [],
      trash: async (id: string) => {
        if (id === 'missing' || trashed.has(id)) return false
        trashed.add(id)
        return true
      }
    },
    documents: {
      restore: async (id: string) => {
        trashed.delete(id)
        restored.push(id)
        return true
      }
    }
  }
}

const { useWidgetFilesStore } = await import('../../src/renderer/src/stores/widgetFiles')
const { useActionHistory } = await import('../../src/renderer/src/stores/actionHistory')

beforeEach(() => {
  notices.length = 0
  restored.length = 0
  trashed.clear()
  openView = { kind: 'task' }
  backSpy.mockClear()
  useActionHistory.getState().clear()
  for (const k of Object.keys(instancesOf)) delete instancesOf[k]
})

describe('trashMany: several work widgets to Trash as one action', () => {
  it('trashes each file once, and one notice names how many and how many desks', async () => {
    instancesOf.f1 = [{ taskId: 'deskA' }, { taskId: 'deskB' }]
    instancesOf.f2 = [{ taskId: 'deskA' }]
    const n = await useWidgetFilesStore.getState().trashMany(['f1', 'f2', 'f1'])
    expect(n).toBe(2)
    expect([...trashed].sort()).toEqual(['f1', 'f2'])
    expect(notices).toHaveLength(1)
    expect(notices[0].text).toBe('2 work widgets moved to Trash and removed from 2 desks')
    expect(notices[0].action?.label).toBe('Undo')
  })

  it('one Undo restores every file (and so every instance main restores with it)', async () => {
    await useWidgetFilesStore.getState().trashMany(['f1', 'f2'])
    notices[0].action!.run()
    await vi.waitFor(() => expect(restored.sort()).toEqual(['f1', 'f2']))
  })

  it('is one ⌘Z step too', async () => {
    await useWidgetFilesStore.getState().trashMany(['f1', 'f2'])
    expect(useActionHistory.getState().past).toHaveLength(1)
    await useActionHistory.getState().undo()
    expect(restored.sort()).toEqual(['f1', 'f2'])
  })

  it('reports only what really went to Trash; nothing trashed means no notice and no undo step', async () => {
    instancesOf.missing = [{ taskId: 'deskZ' }]
    expect(await useWidgetFilesStore.getState().trashMany(['missing'])).toBe(0)
    expect(notices).toHaveLength(0)
    expect(useActionHistory.getState().past).toHaveLength(0)
    instancesOf.f1 = [{ taskId: 'deskA' }]
    expect(await useWidgetFilesStore.getState().trashMany(['f1', 'missing'])).toBe(1)
    // The desk of the file that did not go is not counted.
    expect(notices[0].text).toBe('“File f1” moved to Trash and removed from 1 desk')
  })

  it('a single file keeps its own words, and trash(id) is trashMany([id])', async () => {
    expect(await useWidgetFilesStore.getState().trash('solo')).toBe(true)
    expect(notices[0].text).toBe('“File solo” moved to Trash')
  })

  it('leaves the full-pane view of a file it trashed', async () => {
    openView = { kind: 'document', documentId: 'f2' }
    await useWidgetFilesStore.getState().trashMany(['f1', 'f2'])
    expect(backSpy).toHaveBeenCalledTimes(1)
  })
})
