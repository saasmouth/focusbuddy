// brainIngest e2e ("exactly one note-sourced entry after re-ingest": 2) at
// integration-l8 f47378c9: every work widget is a file (0f182f40), so a note on
// a desk is ALSO a widget-file document holding the same text, and ingest put
// both into PlexiiBrain. The file's entry is kept, with the desk's tag.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Draft = { title: string; body: string; tags: string[] }
const upserts = new Map<string, Draft>()
let pruneLive: Set<string> = new Set()

const NOTE_TEXT = 'brain note body alpha'
const desk = { id: 'desk1', kind: 'task', title: 'Brain Ingest Test Desk', description: '', status: null }
const fileDoc = { id: 'file1', title: 'Note', docType: 'widget', widgetKind: 'note' }
let widgets: Array<Record<string, unknown>> = []

vi.mock('../../src/main/db/nodes', () => ({ listNodes: () => [desk] }))
vi.mock('../../src/main/db/documents', () => ({
  listDocuments: () => [fileDoc],
  getDocument: () => ({ id: 'file1', docType: 'widget', body: {} })
}))
vi.mock('../../src/main/workspaceRank', () => ({ extractDocText: () => NOTE_TEXT }))
vi.mock('../../src/main/db/widgets', () => ({ listWidgetsByTask: () => widgets }))
vi.mock('../../src/main/db/files', () => ({ listEntries: () => [], hasFileBytes: () => false }))
vi.mock('../../src/main/fileText', () => ({ extractFileText: async () => '' }))
vi.mock('../../src/main/db/knowledge', () => ({
  upsertKnowledgeBySource: (kind: string, id: string, d: Draft) => {
    const key = `${kind}:${id}`
    const created = !upserts.has(key)
    upserts.set(key, d)
    return { created }
  },
  hasKnowledgeSource: () => false,
  pruneKnowledgeSources: (live: Set<string>) => {
    pruneLive = live
    return 0
  }
}))

import { ingestWorkspaceIntoBrain } from '../../src/main/brainIngest'

const noteWidget = (syncGroupId: string | null) => ({
  id: 'w1',
  taskId: 'desk1',
  kind: 'note',
  title: '',
  content: NOTE_TEXT,
  archived: false,
  syncGroupId
})
const holding = (text: string): string[] => [...upserts].filter(([, d]) => d.body.includes(text)).map(([k]) => k)

beforeEach(() => {
  upserts.clear()
  pruneLive = new Set()
})

describe('a note that is a widget file reaches PlexiiBrain once', () => {
  it('the file is kept, the desk instance is not copied, and the desk tag rides on the file', async () => {
    widgets = [noteWidget('wf:file1')]
    const stats = await ingestWorkspaceIntoBrain()
    expect(holding(NOTE_TEXT)).toEqual(['document:file1'])
    expect(upserts.get('document:file1')!.tags).toContain('brain-ingest-test-desk')
    // Still counted as an ingested widget, and an old instance entry is pruned.
    expect(stats.widgets).toBe(1)
    expect(pruneLive.has('widget:w1')).toBe(false)
  })
  it('re-ingest is idempotent: still one entry, no new rows', async () => {
    widgets = [noteWidget('wf:file1')]
    await ingestWorkspaceIntoBrain()
    const second = await ingestWorkspaceIntoBrain()
    expect(second.created).toBe(0)
    expect(holding(NOTE_TEXT)).toEqual(['document:file1'])
  })
  it('a note that is not a file (or whose file is gone) is still ingested as a widget', async () => {
    widgets = [noteWidget(null), { ...noteWidget('wf:missing'), id: 'w2' }]
    await ingestWorkspaceIntoBrain()
    expect(holding(NOTE_TEXT).sort()).toEqual(['document:file1', 'widget:w1', 'widget:w2'])
  })
})
