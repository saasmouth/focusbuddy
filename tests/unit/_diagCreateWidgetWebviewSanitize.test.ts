// Throwaway diagnostic (tester agent) — verifies applyCreateWidget's kind:'webview'
// sanitization added for 3.8.4. Mirrors the mocking pattern in
// tests/unit/actionExecutorApply.test.ts so applyProposal runs for real with no
// Electron/IPC. Delete after triage.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const widgetCreateSpy = vi.fn().mockResolvedValue(undefined)

vi.mock('../../src/renderer/src/stores/nodes', () => ({
  useNodeStore: { getState: () => ({ nodes: [], update: vi.fn() }) }
}))
vi.mock('../../src/renderer/src/stores/knowledge', () => ({
  useKnowledgeStore: { getState: () => ({ create: vi.fn() }) }
}))
vi.mock('../../src/renderer/src/stores/widgets', () => ({
  useWidgetStore: {
    getState: () => ({
      widgets: [],
      create: widgetCreateSpy,
      update: vi.fn(),
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
  catalogFor: () => ({ defaultWidth: 360, defaultHeight: 280, defaultContent: '', label: 'Browser' })
}))
vi.mock('../../src/renderer/src/lib/spawnPosition', () => ({
  spawnPositionFor: () => ({ x: 0, y: 0 })
}))

import { applyProposal } from '../../src/renderer/src/lib/actionExecutor'
import type { ActionProposal } from '../../src/shared/types'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('diag: applyCreateWidget(kind=webview) sanitizes content (3.8.4 fix)', () => {
  it('free-text AI content (the observed corruption) is REFUSED, not turned into a search', async () => {
    const p: ActionProposal = {
      id: 'p1',
      kind: 'create-widget',
      widgetKind: 'webview',
      title: null,
      content:
        '**Origin of the Name Michael****Etymology:** Michael derives from Hebrew (Mikha\'el), meaning "who is like God?"'
    } as ActionProposal
    const res = await applyProposal(p, { activeTaskId: 'task-1' })
    expect(res.ok).toBe(true)
    expect(widgetCreateSpy).toHaveBeenCalledTimes(1)
    const created = widgetCreateSpy.mock.calls[0][0]
    console.log('[DIAG-APPLIER] stored content:', created.content)
    // This asserted the prose was stored as a Google search. That was the
    // safe answer while the alternative was a relative path resolving against
    // the bundle — and it stopped being safe once we noticed what ELSE lands
    // in sanitizeWebviewUrl: a pdf widget's bare file id, which went to
    // Google with it (d1, 2026-10-24). The sanitiser refuses what it cannot
    // vouch for now, and the widget shows an honest state.
    expect(created.content).toBe('')
    expect(created.content).not.toContain('Origin of the Name Michael')
    expect(created.content).not.toContain('google.com')
  })

  it('a relative asset path is refused, never stored verbatim', async () => {
    const p: ActionProposal = {
      id: 'p2',
      kind: 'create-widget',
      widgetKind: 'webview',
      title: null,
      content: 'assets/index-C0cjuBNQ.js'
    } as ActionProposal
    await applyProposal(p, { activeTaskId: 'task-1' })
    const created = widgetCreateSpy.mock.calls[0][0]
    console.log('[DIAG-APPLIER] stored content (relative asset input):', created.content)
    // Still never stored verbatim — that is the security property this test
    // was written for, and it holds. Refusing is now '' rather than a search.
    expect(created.content).not.toBe('assets/index-C0cjuBNQ.js')
    expect(created.content).toBe('')
  })

  it('regression: a real https URL passes through untouched', async () => {
    const p: ActionProposal = {
      id: 'p3',
      kind: 'create-widget',
      widgetKind: 'webview',
      title: null,
      content: 'https://example.com'
    } as ActionProposal
    await applyProposal(p, { activeTaskId: 'task-1' })
    const created = widgetCreateSpy.mock.calls[0][0]
    console.log('[DIAG-APPLIER] stored content (valid https input):', created.content)
    expect(created.content).toBe('https://example.com/')
  })
})
