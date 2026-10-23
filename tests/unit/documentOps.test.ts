// createDocumentOps binds an office editor's File-menu actions to the document
// the HOST shows, by id. The bug it replaces: menus acted on the documents
// store's `active`, so a desk widget trashed, copied, renamed or held a meeting
// on whatever Documents last had open. Every case here runs with a DIFFERENT
// document active in the store, which is exactly the shipped failure.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  confirm: true as boolean,
  prompt: 'Renamed' as string | null,
  launch: vi.fn(),
  history: vi.fn()
}))
vi.mock('../../src/renderer/src/components/plexi/PromptDialog', () => ({
  confirmDialog: async () => h.confirm,
  promptText: async () => h.prompt
}))
vi.mock('../../src/renderer/src/lib/startMeeting', () => ({ launchMeeting: h.launch }))
vi.mock('../../src/renderer/src/components/documents/DocHistoryPanel', () => ({ openDocHistory: h.history }))

import { createDocumentOps } from '../../src/renderer/src/components/documents/editor/documentOps'
import { useDocumentsStore } from '../../src/renderer/src/stores/documents'

const A = { id: 'doc-A', docType: 'slides', title: 'Widget deck', body: { slides: ['A-body'] } }
const B = { id: 'doc-B', docType: 'slides', title: 'Open in Documents', body: { slides: ['B-body'] } }

let api: {
  get: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}
const remove = vi.fn(async () => {})
const renameById = vi.fn(async () => {})
const createBlank = vi.fn(async () => ({ id: 'doc-new' }))
const refresh = vi.fn(async () => {})

beforeEach(() => {
  h.confirm = true
  h.prompt = 'Renamed'
  h.launch.mockReset()
  h.history.mockReset()
  remove.mockClear()
  renameById.mockClear()
  createBlank.mockClear()
  api = {
    get: vi.fn(async (id: string) => (id === A.id ? A : id === B.id ? B : null)),
    create: vi.fn(async () => ({ id: 'doc-copy' })),
    update: vi.fn(),
    delete: vi.fn()
  }
  ;(window as unknown as { api: unknown }).api = { documents: api }
  // B is what Documents last opened: the store's `active`.
  useDocumentsStore.setState({ active: B as never, remove, renameById, createBlank, refresh } as never)
})

const opsFor = (extra: Partial<Parameters<typeof createDocumentOps>[0]> = {}) => {
  const onOpen = vi.fn()
  const onTrashed = vi.fn()
  const onRenamed = vi.fn()
  const ops = createDocumentOps({ id: A.id, docType: 'slides', title: () => A.title, onOpen, onTrashed, onRenamed, ...extra })
  return { ops, onOpen, onTrashed, onRenamed }
}

describe('createDocumentOps acts on the bound document, never the store’s active one', () => {
  it('Move to trash trashes A (not B) and then tells the host', async () => {
    const { ops, onTrashed } = opsFor()
    await ops.moveToTrash()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith(A.id)
    expect(onTrashed).toHaveBeenCalledTimes(1)
  })

  it('a cancelled trash trashes nothing and does not tell the host it was trashed', async () => {
    h.confirm = false
    const { ops, onTrashed } = opsFor()
    await ops.moveToTrash()
    expect(remove).not.toHaveBeenCalled()
    expect(onTrashed).not.toHaveBeenCalled()
  })

  it('Make a copy copies A’s stored body under A’s name, and opens the copy', async () => {
    const { ops, onOpen } = opsFor()
    await ops.makeCopy()
    expect(api.get).toHaveBeenCalledWith(A.id)
    const draft = api.create.mock.calls[0]![0] as { title: string; body: unknown; docType: string }
    expect(draft.body).toEqual(A.body)
    expect(draft.title).toBe('Copy of Widget deck')
    expect(draft.docType).toBe('slides')
    expect(onOpen).toHaveBeenCalledWith('doc-copy')
  })

  it('Rename renames A by id (the store’s rename(title) would rename B)', async () => {
    const { ops, onRenamed } = opsFor()
    await ops.rename()
    expect(renameById).toHaveBeenCalledWith(A.id, 'Renamed')
    expect(onRenamed).toHaveBeenCalledWith('Renamed')
  })

  it('a cancelled or blank rename changes nothing', async () => {
    h.prompt = null
    const { ops } = opsFor()
    await ops.rename()
    h.prompt = '   '
    await ops.rename()
    expect(renameById).not.toHaveBeenCalled()
  })

  it('Version history opens A’s history', () => {
    opsFor().ops.openHistory()
    expect(h.history).toHaveBeenCalledWith(A.id)
  })

  it('Start a meeting is about A (it reaches other people), with the right kind per app', () => {
    opsFor().ops.startMeeting()
    expect(h.launch).toHaveBeenCalledWith({ kind: 'slides', id: A.id, title: 'Widget deck' })
    h.launch.mockReset()
    createDocumentOps({ id: 'm1', docType: 'map', title: () => '', onOpen: vi.fn(), onTrashed: vi.fn() }).startMeeting()
    expect(h.launch).toHaveBeenCalledWith({ kind: 'draw', id: 'm1', title: 'Untitled diagram' })
  })

  it('New creates a document of the same type and opens it', async () => {
    const { ops, onOpen } = opsFor()
    await ops.newDocument()
    expect(createBlank).toHaveBeenCalledWith('slides')
    expect(onOpen).toHaveBeenCalledWith('doc-new')
  })
})
