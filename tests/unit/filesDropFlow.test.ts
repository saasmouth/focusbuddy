import { describe, it, expect, beforeEach, vi } from 'vitest'

// placeFilesOnDesk end to end against mocked stores: the Q2 and Q3 questions,
// what each answer places, one undo step per drop, and references (never
// re-ingested) for everything except an explicit "Give them a copy".

const created: Array<Record<string, unknown>> = []
let promptAnswer: string | null = null
const prompts: Array<{ title: string; choices: Array<{ value: string; disabled?: boolean; hint?: string }> }> = []
const history = { begin: 0, end: [] as string[], record: [] as string[] }
let activeOrgId = 'personal'
let nodes: Array<{ id: string; sharedRootId?: string | null }> = []

vi.mock('../../src/renderer/src/components/plexi/PromptDialog', () => ({
  promptChoice: vi.fn(async (req: { title: string; choices: Array<{ value: string; disabled?: boolean }> }) => {
    prompts.push(req)
    return promptAnswer
  })
}))
vi.mock('../../src/renderer/src/stores/widgets', () => ({
  useWidgetStore: Object.assign(() => undefined, {
    getState: () => ({
      create: async (d: Record<string, unknown>) => {
        const w = { id: `w${created.length + 1}`, ...d }
        created.push(w)
        return w
      },
      widgets: []
    }),
    setState: () => undefined
  })
}))
vi.mock('../../src/renderer/src/stores/widgetFiles', () => ({
  useWidgetFilesStore: { getState: () => ({ load: async () => ({ kind: 'table' }), place: async (id: string, taskId: string) => { const w = { id: `inst-${id}`, kind: 'table', taskId, x: 0, y: 0 }; created.push(w); return w } }) }
}))
vi.mock('../../src/renderer/src/stores/actionHistory', () => ({
  useActionHistory: { getState: () => ({ beginBatch: () => { history.begin++ }, endBatch: (l: string) => history.end.push(l), record: (e: { label: string }) => history.record.push(e.label) }) }
}))
vi.mock('../../src/renderer/src/stores/notice', () => ({ useNoticeStore: { getState: () => ({ show: vi.fn() }) } }))
vi.mock('../../src/renderer/src/stores/nodes', () => ({ useNodeStore: { getState: () => ({ nodes }) } }))
vi.mock('../../src/renderer/src/stores/org', () => ({ PERSONAL_ORG_ID: 'personal', useOrgStore: { getState: () => ({ activeOrgId }) } }))
vi.mock('../../src/renderer/src/stores/fileManager', () => ({ useFileManagerStore: { getState: () => ({ refresh: async () => undefined, moveMany: async (ids: string[]) => ids.length }) } }))
vi.mock('../../src/renderer/src/lib/addWidget', () => ({ ensureCanAdd: () => true }))
vi.mock('../../src/renderer/src/lib/syncNudge', () => ({ nudgeSync: () => undefined }))

const api = {
  files: {
    read: vi.fn(async () => ({ mimeType: 'application/pdf', buffer: new ArrayBuffer(4) })),
    ingestBuffer: vi.fn(async (i: { originalName: string }) => ({ id: `copy-of-${i.originalName}`, mimeType: 'application/pdf', sizeBytes: 4 }))
  },
  fileManager: { path: vi.fn(async () => []) }
}
;(window as unknown as { api: unknown }).api = api

const pdf = { entryId: 'pdf-1', kind: 'file' as const, name: 'brief.pdf', mimeType: 'application/pdf', ext: 'pdf', sizeBytes: 100, orgId: 'personal' }
const img = (n: number) => ({ entryId: `img-${n}`, kind: 'file' as const, name: `p${n}.png`, mimeType: 'image/png', ext: 'png', sizeBytes: 100, orgId: 'personal' })
const folder = { entryId: 'dir-1', kind: 'folder' as const, name: 'Plans', orgId: 'personal' }

beforeEach(() => {
  created.length = 0
  prompts.length = 0
  promptAnswer = null
  history.begin = 0
  history.end = []
  history.record = []
  activeOrgId = 'personal'
  nodes = [{ id: 'desk', sharedRootId: null }]
  api.files.read.mockClear()
  api.files.ingestBuffer.mockClear()
})

const load = () => import('../../src/renderer/src/lib/filesDrop')

describe('placeFilesOnDesk', () => {
  it('a personal desk: no questions, references placed, one undo step', async () => {
    const { placeFilesOnDesk } = await load()
    const r = await placeFilesOnDesk([pdf, folder], { taskId: 'desk', at: { x: 400, y: 300 } })
    expect(prompts).toHaveLength(0)
    expect(created.map((w) => [w.kind, w.content])).toEqual([['file', 'pdf-1'], ['drive', 'dir-1']])
    expect(api.files.ingestBuffer).not.toHaveBeenCalled() // never re-ingested
    expect(history.begin).toBe(1)
    expect(history.end).toEqual(['Add 2 items from Files'])
    // Cascaded 24px.
    const centre = (w: Record<string, unknown>): number => (w.x as number) + (w.width as number) / 2
    expect(Math.abs(centre(created[1]!) - centre(created[0]!) - 24)).toBeLessThanOrEqual(1)
    expect(r.cancelled).toBe(false)
  })

  it('Q3 gallery: one gallery work widget with the same ids, the rest one by one', async () => {
    promptAnswer = 'gallery'
    const { placeFilesOnDesk } = await load()
    await placeFilesOnDesk([img(1), img(2), img(3), pdf], { taskId: 'desk', at: { x: 0, y: 0 } })
    expect(prompts[0]!.title).toBe('Add 3 pictures')
    expect(prompts[0]!.choices.map((c) => c.value)).toEqual(['individual', 'gallery'])
    expect(created.map((w) => w.kind)).toEqual(['gallery', 'file'])
    expect(JSON.parse(created[0]!.content as string)).toEqual({ fileIds: ['img-1', 'img-2', 'img-3'] })
    expect(history.end).toHaveLength(1)
  })

  it('Q3 individual: one picture work widget each; cancel places nothing', async () => {
    promptAnswer = 'individual'
    const { placeFilesOnDesk } = await load()
    await placeFilesOnDesk([img(1), img(2)], { taskId: 'desk', at: { x: 0, y: 0 } })
    expect(created.map((w) => w.content)).toEqual(['img-1', 'img-2'])
    created.length = 0
    promptAnswer = null
    const r = await placeFilesOnDesk([img(1), img(2)], { taskId: 'desk', at: { x: 0, y: 0 } })
    expect(r.cancelled).toBe(true)
    expect(created).toHaveLength(0)
  })

  it('Q2 on a team desk: Share is disabled with the reason, Give them a copy places a COPY in the desk’s workspace', async () => {
    activeOrgId = 'org-team'
    promptAnswer = 'copy'
    const { placeFilesOnDesk } = await load()
    await placeFilesOnDesk([pdf], { taskId: 'desk', at: { x: 0, y: 0 } })
    const q = prompts[0]!
    expect(q.choices.find((c) => c.value === 'share-view')).toMatchObject({ disabled: true, hint: "Sharing a file from your Personal drive isn't available yet. You can give them a copy." })
    expect(q.choices.find((c) => c.value === 'share-edit')!.disabled).toBe(true)
    expect(q.choices.find((c) => c.value === 'copy')!.disabled).toBeFalsy()
    expect(api.files.read).toHaveBeenCalledWith('pdf-1')
    expect(api.files.ingestBuffer).toHaveBeenCalledWith(expect.objectContaining({ originalName: 'brief.pdf', parentId: null }))
    expect(created.map((w) => w.content)).toEqual(['copy-of-brief.pdf'])
  })

  it('Q2 on a live-shared desk: copy is disabled too; "place it for me only" places the reference; cancel places nothing', async () => {
    nodes = [{ id: 'desk', sharedRootId: 'root-1' }]
    promptAnswer = 'place'
    const { placeFilesOnDesk } = await load()
    await placeFilesOnDesk([pdf], { taskId: 'desk', at: { x: 0, y: 0 } })
    expect(prompts[0]!.choices.find((c) => c.value === 'copy')).toMatchObject({ disabled: true })
    expect(created.map((w) => w.content)).toEqual(['pdf-1'])
    expect(api.files.ingestBuffer).not.toHaveBeenCalled()
    created.length = 0
    promptAnswer = null
    expect((await placeFilesOnDesk([pdf], { taskId: 'desk', at: { x: 0, y: 0 } })).cancelled).toBe(true)
    expect(created).toHaveLength(0)
  })

  it('a forged answer for a disabled option does nothing', async () => {
    nodes = [{ id: 'desk', sharedRootId: 'root-1' }]
    promptAnswer = 'share-edit'
    const { placeFilesOnDesk } = await load()
    const r = await placeFilesOnDesk([pdf], { taskId: 'desk', at: { x: 0, y: 0 } })
    expect(r.cancelled).toBe(true)
    expect(created).toHaveLength(0)
  })

  it('a work widget file becomes a linked instance, recorded in the same undo step', async () => {
    const { placeFilesOnDesk } = await load()
    await placeFilesOnDesk([{ entryId: 'e', kind: 'doc', name: 'Budget', docId: 'wf-9', docType: 'widget' }], { taskId: 'desk', at: { x: 0, y: 0 } })
    expect(created.map((w) => w.id)).toEqual(['inst-wf-9'])
    expect(history.record).toEqual(['Place a work widget'])
    expect(history.end).toEqual(['Add from Files'])
  })

  it('the one notice line', async () => {
    const { composeDropNotice } = await load()
    expect(composeDropNotice(3, [], [])).toBeNull()
    expect(composeDropNotice(3, [{ name: 'a', reason: 'A folder cannot go inside itself.' }, { name: 'b', reason: 'A folder cannot go inside itself.' }], [])).toBe('3 added. 2 could not go in: A folder cannot go inside itself.')
    expect(composeDropNotice(0, [{ name: 'a', reason: 'Nope.' }], ['Warn.'])).toBe('Nope. Warn.')
  })
})
