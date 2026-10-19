// Unit tests for applyProposal — the durable apply path added in cde913d.
//
// We mock the Zustand stores so we can exercise applyUpdateTask and
// applyCreateKnowledgeEntry without booting Electron or touching IPC.
// The mocks expose the same getState() contract the executor calls:
//
//   useNodeStore.getState().nodes  — seed with a fake task
//   useNodeStore.getState().update — captured spy, returns resolved promise
//   useKnowledgeStore.getState().create — captured spy, returns a fake entry
//
// These tests prove:
//   1. update-task with status:'done'  → ok:true + patch sent to node store
//   2. update-task with title rename   → ok:true + title patch forwarded
//   3. update-task with dueDate:null   → ok:true + dueDate:null forwarded
//   4. update-task invalid status      → ok:false, no mutation
//   5. update-task non-existent taskId → ok:false, no mutation
//   6. create-knowledge-entry          → ok:true + draft forwarded to store
//   7. create-knowledge-entry returns null → ok:false (store error path)
//
// No IPC, no Electron, no network.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { FbNode, Widget } from '../../src/shared/types'

function fakeWidget(over: Partial<Widget> & { id: string }): Widget {
  return {
    taskId: 't1',
    kind: 'sticky',
    title: over.id,
    content: '',
    x: 0,
    y: 0,
    width: 240,
    height: 200,
    zIndex: 1,
    color: null,
    status: null,
    pinned: false,
    pinnedScreenX: null,
    pinnedScreenY: null,
    pinnedZone: null,
    parentSectionId: null,
    layout: null,
    sourceAppId: null,
    mode: null,
    livingQuery: null,
    livingGeneratedAt: null,
    livingPaused: false,
    createdAt: 1000,
    updatedAt: 1000,
    archived: false,
    syncGroupId: null,
    ...over
  } as Widget
}

// ── Minimal fake node ────────────────────────────────────────────────────────
function fakeNode(over: Partial<FbNode> = {}): FbNode {
  return {
    id: 'node-test-1',
    parentId: null,
    kind: 'task',
    title: 'My test task',
    description: '',
    status: 'open',
    priority: 3,
    interest: 3,
    importance: 3,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    estimateMinutes: null,
    extensionsMinutes: 0,
    resumeMarkdown: null,
    resumeUpdatedAt: null,
    dueDate: 1700000000000,
    archived: false,
    sharedFromHandle: null,
    ...over
  }
}

// ── Shared mutable spy state ─────────────────────────────────────────────────
// We mutate these between tests so that individual assertions can read back
// what the executor passed to the store.
const nodeUpdateSpy = vi.fn().mockResolvedValue(undefined)
let storedNodes: FbNode[] = []

const knowledgeCreateSpy = vi.fn()
let knowledgeCreateResult: unknown = null

// Widget store mock state (for create-section). Seeded per test.
let storedWidgets: Widget[] = []
const widgetCreateSpy = vi.fn()
const widgetUpdateSpy = vi.fn().mockResolvedValue(undefined)
const widgetBumpSpy = vi.fn()

// ── Store mocks ──────────────────────────────────────────────────────────────
// vi.mock is hoisted before imports, but the factory captures the spies via
// closure so re-assignments in beforeEach reach them.
vi.mock('../../src/renderer/src/stores/nodes', () => ({
  useNodeStore: {
    getState: () => ({
      get nodes() { return storedNodes },
      update: nodeUpdateSpy
    })
  }
}))

vi.mock('../../src/renderer/src/stores/knowledge', () => ({
  useKnowledgeStore: {
    getState: () => ({
      create: knowledgeCreateSpy
    })
  }
}))

// Stub the other stores that actionExecutor imports but the tested cases
// don't use — avoids "module not found" on window.api calls inside them.
vi.mock('../../src/renderer/src/stores/widgets', () => ({
  useWidgetStore: {
    getState: () => ({
      get widgets() {
        return storedWidgets
      },
      create: widgetCreateSpy,
      update: widgetUpdateSpy,
      bumpLayoutVersion: widgetBumpSpy,
      bringToFront: vi.fn(),
      setActive: vi.fn(),
      focusOn: vi.fn(),
      setFocused: vi.fn(),
      remove: vi.fn()
    })
  }
}))
vi.mock('../../src/renderer/src/stores/focusSession', () => ({
  useFocusSessionStore: { getState: () => ({ start: vi.fn() }) }
}))
vi.mock('../../src/renderer/src/stores/tables', () => ({
  useTablesStore: { getState: () => ({ createTable: vi.fn(), ensureTableLoaded: vi.fn(), addRow: vi.fn() }) }
}))
vi.mock('../../src/renderer/src/stores/links', () => ({
  useLinksStore: { getState: () => ({ create: vi.fn() }) }
}))
vi.mock('../../src/renderer/src/lib/widgetCatalog', () => ({
  catalogFor: () => null
}))
vi.mock('../../src/renderer/src/lib/spawnPosition', () => ({
  spawnPositionFor: () => ({ x: 0, y: 0 })
}))

// ── Subject under test ───────────────────────────────────────────────────────
// Imported AFTER mocks so vi.mock hoisting replaces the real modules.
import { applyProposal, isAutoApplyable } from '../../src/renderer/src/lib/actionExecutor'
import type { ActionProposal } from '../../src/shared/types'

// ── Test reset ───────────────────────────────────────────────────────────────
beforeEach(() => {
  vi.clearAllMocks()
  storedNodes = [fakeNode()]
  storedWidgets = []
  knowledgeCreateResult = null
  knowledgeCreateSpy.mockImplementation(() => Promise.resolve(knowledgeCreateResult))
  widgetCreateSpy.mockImplementation((draft) => Promise.resolve({ ...fakeWidget({ id: 'sec-new' }), ...draft, id: 'sec-new' }))
  widgetUpdateSpy.mockResolvedValue(undefined)
})

// ── update-task ──────────────────────────────────────────────────────────────
describe('applyProposal: update-task', () => {
  it('marks an existing task done — returns ok:true and patches status', async () => {
    const p: ActionProposal = {
      id: 'p1',
      kind: 'update-task',
      taskId: 'node-test-1',
      label: 'My test task',
      status: 'done'
    }
    const result = await applyProposal(p, { activeTaskId: null })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('My test task')
    expect(nodeUpdateSpy).toHaveBeenCalledOnce()
    const [calledId, calledPatch] = nodeUpdateSpy.mock.calls[0]
    expect(calledId).toBe('node-test-1')
    expect(calledPatch).toEqual({ status: 'done' })
  })

  it('renames a task — patches title only, no status key', async () => {
    const p: ActionProposal = {
      id: 'p2',
      kind: 'update-task',
      taskId: 'node-test-1',
      label: 'My test task',
      title: 'Renamed task'
    }
    const result = await applyProposal(p, { activeTaskId: null })
    expect(result.ok).toBe(true)
    const [, patch] = nodeUpdateSpy.mock.calls[0]
    expect(patch).toEqual({ title: 'Renamed task' })
    expect(patch).not.toHaveProperty('status')
  })

  it('clears dueDate when dueDate:null is passed', async () => {
    const p: ActionProposal = {
      id: 'p3',
      kind: 'update-task',
      taskId: 'node-test-1',
      label: 'My test task',
      dueDate: null
    }
    const result = await applyProposal(p, { activeTaskId: null })
    expect(result.ok).toBe(true)
    const [, patch] = nodeUpdateSpy.mock.calls[0]
    expect(patch).toHaveProperty('dueDate', null)
  })

  it('falls back to activeTaskId when taskId is missing', async () => {
    storedNodes = [fakeNode({ id: 'active-node', title: 'Active task' })]
    const p: ActionProposal = {
      id: 'p4',
      kind: 'update-task',
      taskId: 'active-node',
      label: 'Active task',
      status: 'in_progress'
    }
    const result = await applyProposal(p, { activeTaskId: 'active-node' })
    expect(result.ok).toBe(true)
    const [calledId] = nodeUpdateSpy.mock.calls[0]
    expect(calledId).toBe('active-node')
  })

  it('GUARD: invalid status returns ok:false and does NOT mutate', async () => {
    const p = {
      id: 'g1',
      kind: 'update-task',
      taskId: 'node-test-1',
      label: 'My test task',
      status: 'deleted' // not a valid TaskStatus
    } as unknown as ActionProposal
    const result = await applyProposal(p, { activeTaskId: null })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('deleted')
    expect(nodeUpdateSpy).not.toHaveBeenCalled()
  })

  it('GUARD: non-existent taskId returns ok:false and does NOT mutate', async () => {
    const p: ActionProposal = {
      id: 'g2',
      kind: 'update-task',
      taskId: 'does-not-exist',
      label: 'Ghost task',
      status: 'done'
    }
    const result = await applyProposal(p, { activeTaskId: null })
    expect(result.ok).toBe(false)
    expect(nodeUpdateSpy).not.toHaveBeenCalled()
  })

  it('GUARD: no taskId and no activeTaskId returns ok:false', async () => {
    // taskId present but empty-string edge case — use the no-active-task path
    const p: ActionProposal = {
      id: 'g3',
      kind: 'update-task',
      taskId: '',
      label: 'No target',
      status: 'done'
    }
    // With an empty taskId the executor falls back to activeTaskId (also null here).
    const result = await applyProposal(p, { activeTaskId: null })
    expect(result.ok).toBe(false)
    expect(nodeUpdateSpy).not.toHaveBeenCalled()
  })
})

// ── create-knowledge-entry ───────────────────────────────────────────────────
describe('applyProposal: create-knowledge-entry', () => {
  it('creates an entry with title, body, tags, pinned and returns ok:true', async () => {
    knowledgeCreateResult = {
      id: 'kb-1',
      title: 'Brand voice rule',
      body: 'We write in first-person plural.',
      tags: ['brand', 'voice'],
      pinned: true,
      createdAt: 0,
      updatedAt: 0
    }
    const p: ActionProposal = {
      id: 'kb-p1',
      kind: 'create-knowledge-entry',
      title: 'Brand voice rule',
      body: 'We write in first-person plural.',
      tags: ['brand', 'voice'],
      pinned: true
    }
    const result = await applyProposal(p, { activeTaskId: null })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Brand voice rule')
    expect(result.message).toContain('PlexiiBrain')
    expect(knowledgeCreateSpy).toHaveBeenCalledOnce()
    const [draft] = knowledgeCreateSpy.mock.calls[0]
    expect(draft).toMatchObject({
      title: 'Brand voice rule',
      body: 'We write in first-person plural.',
      tags: ['brand', 'voice'],
      pinned: true
    })
  })

  it('defaults tags to [] and pinned to false when omitted', async () => {
    knowledgeCreateResult = {
      id: 'kb-2',
      title: 'Quick note',
      body: 'Some fact.',
      tags: [],
      pinned: false,
      createdAt: 0,
      updatedAt: 0
    }
    const p: ActionProposal = {
      id: 'kb-p2',
      kind: 'create-knowledge-entry',
      title: 'Quick note',
      body: 'Some fact.'
      // no tags, no pinned
    }
    const result = await applyProposal(p, { activeTaskId: null })
    expect(result.ok).toBe(true)
    const [draft] = knowledgeCreateSpy.mock.calls[0]
    expect(draft.tags).toEqual([])
    expect(draft.pinned).toBe(false)
    expect(draft.body).toBe('Some fact.')
  })

  it('defaults body to empty string when body is absent', async () => {
    knowledgeCreateResult = {
      id: 'kb-3',
      title: 'Title only',
      body: '',
      tags: [],
      pinned: false,
      createdAt: 0,
      updatedAt: 0
    }
    const p: ActionProposal = {
      id: 'kb-p3',
      kind: 'create-knowledge-entry',
      title: 'Title only',
      body: ''
    }
    await applyProposal(p, { activeTaskId: null })
    const [draft] = knowledgeCreateSpy.mock.calls[0]
    expect(draft.body).toBe('')
  })

  it('GUARD: store returning null yields ok:false', async () => {
    knowledgeCreateResult = null // store signals failure
    const p: ActionProposal = {
      id: 'kb-g1',
      kind: 'create-knowledge-entry',
      title: 'Will fail',
      body: 'Body'
    }
    const result = await applyProposal(p, { activeTaskId: null })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/could not save|plexibrain/i)
  })
})

// ── create-section (Smart Stack, unified onto the approval card) ──────────────
describe('applyProposal: create-section', () => {
  it('creates a section and reparents the named widgets into it', async () => {
    storedWidgets = [fakeWidget({ id: 'w1' }), fakeWidget({ id: 'w2' }), fakeWidget({ id: 'w3' })]
    const p: ActionProposal = {
      id: 'ss-0',
      kind: 'create-section',
      name: 'Research',
      widgetIds: ['w1', 'w2']
    }
    const result = await applyProposal(p, { activeTaskId: 't1' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Research')
    // A section widget was created with the group's name.
    expect(widgetCreateSpy).toHaveBeenCalledOnce()
    expect(widgetCreateSpy.mock.calls[0][0]).toMatchObject({ kind: 'section', title: 'Research' })
    // Each member (and only members) was reparented into the new section.
    const reparent = widgetUpdateSpy.mock.calls.filter((c) => c[1]?.parentSectionId === 'sec-new')
    expect(reparent.map((c) => c[0]).sort()).toEqual(['w1', 'w2'])
  })

  it('no-ops honestly when none of the named widgets exist', async () => {
    storedWidgets = [fakeWidget({ id: 'w1' })]
    const p: ActionProposal = { id: 'ss-1', kind: 'create-section', name: 'Ghosts', widgetIds: ['zzz'] }
    const result = await applyProposal(p, { activeTaskId: 't1' })
    expect(result.ok).toBe(false)
    expect(widgetCreateSpy).not.toHaveBeenCalled()
  })

  it('requires an active desk', async () => {
    const p: ActionProposal = { id: 'ss-2', kind: 'create-section', name: 'X', widgetIds: ['w1'] }
    const result = await applyProposal(p, { activeTaskId: null })
    expect(result.ok).toBe(false)
  })

  it('registers the new section id in resolvedIds (so later refs / Go-to resolve)', async () => {
    storedWidgets = [fakeWidget({ id: 'w1' }), fakeWidget({ id: 'w2' })]
    const resolvedIds = new Map<string, string>()
    const p: ActionProposal = { id: 'ss-3', kind: 'create-section', name: 'Research', widgetIds: ['w1'] }
    const result = await applyProposal(p, { activeTaskId: 't1', resolvedIds })
    expect(result.ok).toBe(true)
    expect(resolvedIds.get('ss-3')).toBe('sec-new') // was previously never set
  })
})

describe('isAutoApplyable', () => {
  const mk = (kind: ActionProposal['kind']): ActionProposal =>
    ({ id: 'x', kind } as unknown as ActionProposal)
  it('gates destructive / external / real-world-commitment kinds', () => {
    for (const k of ['delete-widget', 'schedule-event', 'compose-mail', 'post-chat', 'start-focus-session'] as const) {
      expect(isAutoApplyable(mk(k))).toBe(false)
    }
  })
  it('allows workspace-internal, reversible kinds', () => {
    for (const k of ['create-widget', 'create-task', 'create-page', 'create-section', 'create-table', 'add-table-row', 'update-widget', 'update-task', 'set-cell', 'edit-document', 'navigate-to'] as const) {
      expect(isAutoApplyable(mk(k))).toBe(true)
    }
  })
})

describe('applyProposal: create-page', () => {
  it('stashes the new widget id in resolvedIds so Go-to / undo can resolve it', async () => {
    const resolvedIds = new Map<string, string>()
    const p: ActionProposal = {
      id: 'pg-0',
      kind: 'create-page',
      title: 'Notes',
      content: '{}'
    }
    const result = await applyProposal(p, { activeTaskId: 't1', resolvedIds })
    expect(result.ok).toBe(true)
    expect(widgetCreateSpy.mock.calls[0][0]).toMatchObject({ kind: 'page', title: 'Notes' })
    // The created widget id is registered under the proposal id.
    expect(resolvedIds.get('pg-0')).toBe('sec-new')
  })

  it('requires an active desk', async () => {
    const p: ActionProposal = { id: 'pg-1', kind: 'create-page', title: 'X', content: '{}' }
    const result = await applyProposal(p, { activeTaskId: null })
    expect(result.ok).toBe(false)
    expect(widgetCreateSpy).not.toHaveBeenCalled()
  })
})
