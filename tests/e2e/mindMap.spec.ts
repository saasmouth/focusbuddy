import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp } from './_helpers'

// MindMapWidget E2E.
//
// We can't drive real Claude calls here (no API key in CI; would burn
// tokens anyway). Coverage is the structural / persistence path:
//
//   1. The 'mindmap' kind is wired through Canvas + WidgetFocusMode and
//      the catalog. A freshly-created mindmap widget renders the root
//      node and a side panel.
//   2. Editing the root node's label persists to widget.content.
//   3. Pre-seeding a widget.content with a multi-level tree renders
//      every node + edge in the SVG.
//   4. Clicking a non-root node selects it (highlight + side-panel
//      breadcrumb).
//   5. "Convert to task" on a node creates a real task node in the DB.
//
// AI expand + agent suggestion are exercised at the IPC contract level
// only — the actual Claude responses are out of scope for E2E. The
// widget's defensive "If you just shipped new code, quit PlexiDesk (⌘Q)"
// branch ensures a missing-IPC failure mode is at least surfaced.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedMindMap(
  launched: LaunchedApp,
  content: string = ''
): Promise<{ taskId: string; widgetId: string }> {
  const { window } = launched
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  const seeded = await window.evaluate(
    async (initialContent: string) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({
        parentId: null,
        kind: 'task',
        title: 'Mindmap test'
      })
      const w = await api.widgets.create({
        taskId: task.id,
        kind: 'mindmap',
        title: '',
        content: initialContent,
        x: 200,
        y: 200,
        width: 720,
        height: 480
      })
      return { taskId: task.id, widgetId: w.id }
    },
    content
  )

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})
  await window.getByRole('button', { name: 'Mindmap test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  return seeded
}

test('Empty mindmap renders root node + side panel with default label', async () => {
  launched = await launchApp()
  await seedMindMap(launched, '')

  // SVG container exists and contains the root node element.
  await expect(launched.window.locator('[data-testid="mindmap-svg"]').first()).toBeVisible({
    timeout: 5_000
  })
  await expect(
    launched.window.locator('[data-testid="mindmap-node-root"]').first()
  ).toBeVisible()
  // Side panel rendered (root is the default selection).
  await expect(
    launched.window.locator('[data-testid="mindmap-node-label-input"]').first()
  ).toBeVisible()
})

test('Editing the root label persists the new label to widget.content', async () => {
  launched = await launchApp()
  const seeded = await seedMindMap(launched, '')

  const input = launched.window.locator('[data-testid="mindmap-node-label-input"]').first()
  await input.fill('Build the launch plan')
  await launched.window.waitForTimeout(500) // give persist() a tick

  const content = await launched.window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      return widgets.find((w) => w.id === wid)?.content ?? null
    },
    { tid: seeded.taskId, wid: seeded.widgetId }
  )
  expect(content).not.toBeNull()
  expect(content!).toContain('Build the launch plan')
})

test('Pre-seeded multi-level tree renders all nodes', async () => {
  launched = await launchApp()
  const seededState = {
    root: {
      id: 'root',
      label: 'Launch plan',
      kind: 'idea',
      children: [
        {
          id: 'b1',
          label: 'Positioning',
          kind: 'task',
          children: [
            { id: 'b1a', label: 'Pick wedge ICP', kind: 'task', children: [] },
            { id: 'b1b', label: 'Write 1-line value prop', kind: 'task', children: [] }
          ]
        },
        {
          id: 'b2',
          label: 'Distribution',
          kind: 'idea',
          children: [
            { id: 'b2a', label: 'Find 5 design partners', kind: 'task', children: [] }
          ]
        }
      ]
    },
    selectedId: 'root',
    agents: {}
  }
  await seedMindMap(launched, JSON.stringify(seededState))

  for (const id of ['root', 'b1', 'b1a', 'b1b', 'b2', 'b2a']) {
    await expect(
      launched.window.locator(`[data-testid="mindmap-node-${id}"]`).first()
    ).toBeVisible({ timeout: 5_000 })
  }
})

test('Clicking a non-root node selects it (breadcrumb appears in side panel)', async () => {
  launched = await launchApp()
  const seededState = {
    root: {
      id: 'root',
      label: 'Launch plan',
      kind: 'idea',
      children: [
        { id: 'b1', label: 'Positioning', kind: 'task', children: [] }
      ]
    },
    selectedId: 'root',
    agents: {}
  }
  await seedMindMap(launched, JSON.stringify(seededState))

  // Click the child node.
  await launched.window.evaluate(() => {
    const el = document.querySelector<SVGGElement>('[data-testid="mindmap-node-b1"]')
    if (!el) throw new Error('mindmap-node-b1 not found')
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await launched.window.waitForTimeout(200)
  // Side panel input now shows the child's label.
  await expect(
    launched.window.locator('[data-testid="mindmap-node-label-input"]').first()
  ).toHaveValue('Positioning')
})

test('Tool picker attaches a sticky widget to the selected node + persists the link', async () => {
  launched = await launchApp()
  const seededState = {
    root: {
      id: 'root',
      label: 'Plan',
      kind: 'idea',
      children: [],
      attachedWidgetIds: [],
      assignedAgentSlugs: []
    },
    selectedId: 'root',
    agentSuggestions: {},
    agentInvocations: {}
  }
  const seeded = await seedMindMap(launched, JSON.stringify(seededState))

  // Open the tool picker, pick Sticky.
  await launched.window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      '[data-testid="mindmap-open-tool-picker"]'
    )
    if (!btn) throw new Error('tool picker button missing')
    btn.click()
  })
  await launched.window.waitForTimeout(150)
  await launched.window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      '[data-testid="mindmap-tool-sticky"]'
    )
    if (!btn) throw new Error('sticky tool button missing')
    btn.click()
  })
  await launched.window.waitForTimeout(500)

  // Verify: (a) a sticky widget now exists on the active task, and
  // (b) the mindmap widget's persisted state has the new widget id in
  // root.attachedWidgetIds.
  const stickies = await launched.window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const widgets = await api.widgets.listByTask(tid)
    return widgets.filter((w) => w.kind === 'sticky').map((w) => w.id)
  }, seeded.taskId)
  expect(stickies.length).toBe(1)

  const mindmapContent = await launched.window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      return widgets.find((w) => w.id === wid)?.content ?? null
    },
    { tid: seeded.taskId, wid: seeded.widgetId }
  )
  expect(mindmapContent).not.toBeNull()
  const parsed = JSON.parse(mindmapContent!)
  expect(parsed.root.attachedWidgetIds).toContain(stickies[0])
})

test('Phase 2 UX: pre-seeded pending children render with accept/reject controls; bulk Accept all moves them to children', async () => {
  launched = await launchApp()
  const seededState = {
    root: {
      id: 'root',
      label: 'Launch plan',
      kind: 'idea',
      children: [],
      attachedWidgetIds: [],
      assignedAgentSlugs: [],
      pendingChildren: [
        {
          id: 'pend-1',
          label: 'Wedge ICP profile',
          kind: 'task',
          rationale: 'You need a specific user before anything else.',
          children: [],
          attachedWidgetIds: [],
          assignedAgentSlugs: [],
          pendingChildren: []
        },
        {
          id: 'pend-2',
          label: 'Pricing experiments',
          kind: 'task',
          children: [],
          attachedWidgetIds: [],
          assignedAgentSlugs: [],
          pendingChildren: []
        }
      ]
    },
    selectedId: 'root',
    viewRootId: 'root',
    agentSuggestions: {},
    agentConversations: {},
    agentStats: {}
  }
  const seeded = await seedMindMap(launched, JSON.stringify(seededState))

  // Both pending nodes render with their accept/reject controls.
  await expect(
    launched.window.locator('[data-testid="mindmap-accept-pending-pend-1"]').first()
  ).toBeVisible({ timeout: 5_000 })
  await expect(
    launched.window.locator('[data-testid="mindmap-reject-pending-pend-1"]').first()
  ).toBeVisible()
  // Bulk controls visible on the side panel.
  await expect(
    launched.window.locator('[data-testid="mindmap-accept-all-pending"]').first()
  ).toBeVisible()

  // Bulk-accept and verify both moved into root.children in the
  // persisted widget.content.
  await launched.window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      '[data-testid="mindmap-accept-all-pending"]'
    )
    if (!btn) throw new Error('accept-all button missing')
    btn.click()
  })
  await launched.window.waitForTimeout(400)

  const persistedContent = await launched.window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      return widgets.find((w) => w.id === wid)?.content ?? null
    },
    { tid: seeded.taskId, wid: seeded.widgetId }
  )
  expect(persistedContent).not.toBeNull()
  const parsed = JSON.parse(persistedContent!)
  // Both pending should now be in children, none in pendingChildren.
  expect(parsed.root.children.length).toBe(2)
  expect(parsed.root.pendingChildren.length).toBe(0)
  const childIds = parsed.root.children.map((c: { id: string }) => c.id)
  expect(childIds).toContain('pend-1')
  expect(childIds).toContain('pend-2')
})

test('Phase 2 UX: Add child button creates a new committed child node', async () => {
  launched = await launchApp()
  const seededState = {
    root: {
      id: 'root',
      label: 'Plan',
      kind: 'idea',
      children: [],
      attachedWidgetIds: [],
      assignedAgentSlugs: [],
      pendingChildren: []
    },
    selectedId: 'root',
    viewRootId: 'root',
    agentSuggestions: {},
    agentConversations: {},
    agentStats: {}
  }
  const seeded = await seedMindMap(launched, JSON.stringify(seededState))

  await launched.window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      '[data-testid="mindmap-add-child"]'
    )
    if (!btn) throw new Error('add-child button missing')
    btn.click()
  })
  await launched.window.waitForTimeout(400)

  const parsed = await launched.window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = await api.widgets.listByTask(tid)
      const c = widgets.find((w) => w.id === wid)?.content
      return c ? JSON.parse(c) : null
    },
    { tid: seeded.taskId, wid: seeded.widgetId }
  )
  expect(parsed.root.children.length).toBe(1)
  expect(parsed.root.children[0].label).toBe('New idea')
})

test('Phase 2 UX: double-clicking a node drills in; breadcrumb renders with the path', async () => {
  launched = await launchApp()
  const seededState = {
    root: {
      id: 'root',
      label: 'Launch',
      kind: 'idea',
      children: [
        {
          id: 'b1',
          label: 'Positioning',
          kind: 'task',
          children: [
            { id: 'b1a', label: 'Wedge ICP', kind: 'task', children: [], pendingChildren: [] }
          ],
          attachedWidgetIds: [],
          assignedAgentSlugs: [],
          pendingChildren: []
        }
      ],
      attachedWidgetIds: [],
      assignedAgentSlugs: [],
      pendingChildren: []
    },
    selectedId: 'root',
    viewRootId: 'root',
    agentSuggestions: {},
    agentConversations: {},
    agentStats: {}
  }
  await seedMindMap(launched, JSON.stringify(seededState))

  // No breadcrumb at root.
  await expect(
    launched.window.locator('[data-testid="mindmap-breadcrumb"]').first()
  ).not.toBeVisible({ timeout: 1500 })

  // Double-click the b1 node → drill in.
  await launched.window.evaluate(() => {
    const el = document.querySelector<SVGGElement>('[data-testid="mindmap-node-b1"]')
    if (!el) throw new Error('b1 node missing')
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  })
  await launched.window.waitForTimeout(300)

  await expect(
    launched.window.locator('[data-testid="mindmap-breadcrumb"]').first()
  ).toBeVisible({ timeout: 3_000 })
  // Breadcrumb shows "Launch › Positioning" with two segments.
  await expect(
    launched.window.locator('[data-testid="mindmap-breadcrumb-0"]').first()
  ).toBeVisible()
  await expect(
    launched.window.locator('[data-testid="mindmap-breadcrumb-1"]').first()
  ).toBeVisible()
})

test('Pre-seeded conversation renders multi-turn transcript with apply/dismiss/undo buttons + stats badge', async () => {
  launched = await launchApp()
  const seededState = {
    root: {
      id: 'root',
      label: 'Launch plan',
      kind: 'idea',
      children: [],
      attachedWidgetIds: [],
      assignedAgentSlugs: []
    },
    selectedId: 'root',
    agentSuggestions: {
      root: [
        {
          slug: 'positioning-and-gtm-brief-builder',
          name: 'positioning-and-gtm-brief-builder',
          rationale: 'Positioning brief is exactly this node\'s purpose.',
          path: '/Applications/agentic-starter-kit-main/.claude/agents/positioning-and-gtm-brief-builder.md'
        }
      ]
    },
    agentConversations: {
      'root:positioning-and-gtm-brief-builder': {
        agentName: 'positioning-and-gtm-brief-builder',
        agentSlug: 'positioning-and-gtm-brief-builder',
        capped: false,
        userReplies: [{ content: 'Add a second tier with mid-market positioning.', at: Date.now() - 1000 }],
        turns: [
          {
            rawReply: '{"reply":"Here is a starting frame...","proposals":[]}',
            reply: 'Here is a starting frame for the positioning brief.',
            proposalStates: [
              {
                proposal: {
                  id: 'p-1',
                  kind: 'create-task',
                  title: 'Draft the wedge ICP description',
                  reason: 'You need a sharp ICP before anything else.'
                },
                state: 'pending'
              }
            ],
            invocationId: 'inv-1',
            conversationTurn: 1,
            at: Date.now() - 2000
          },
          {
            rawReply: '{"reply":"Mid-market tier added...","proposals":[]}',
            reply: 'Mid-market tier added with three proposed features.',
            proposalStates: [
              {
                proposal: {
                  id: 'p-2',
                  kind: 'create-task',
                  title: 'Validate mid-tier pricing with 3 customers',
                  reason: 'Mid-market pricing needs validation.'
                },
                state: 'pending'
              }
            ],
            invocationId: 'inv-2',
            conversationTurn: 3,
            at: Date.now() - 500
          }
        ]
      }
    },
    agentStats: {
      'positioning-and-gtm-brief-builder': {
        slug: 'positioning-and-gtm-brief-builder',
        invocations: 2,
        totalProposals: 2,
        applied: 1,
        dismissed: 0,
        undone: 0,
        applyRate: 1
      }
    }
  }
  await seedMindMap(launched, JSON.stringify(seededState))

  // Stats badge renders.
  await expect(
    launched.window
      .locator('[data-testid="mindmap-agent-stats-positioning-and-gtm-brief-builder"]')
      .first()
  ).toBeVisible({ timeout: 5_000 })

  // Both turn replies render in the transcript.
  await expect(
    launched.window.getByText('Here is a starting frame for the positioning brief.')
  ).toBeVisible()
  await expect(
    launched.window.getByText('Mid-market tier added with three proposed features.')
  ).toBeVisible()

  // The user reply between them renders.
  await expect(
    launched.window.getByText('You: Add a second tier with mid-market positioning.')
  ).toBeVisible()

  // Both proposals' Apply buttons render.
  await expect(
    launched.window.locator('[data-testid="mindmap-apply-p-1"]').first()
  ).toBeVisible()
  await expect(
    launched.window.locator('[data-testid="mindmap-apply-p-2"]').first()
  ).toBeVisible()

  // Reply input + Send render (conversation not capped).
  await expect(
    launched.window
      .locator('[data-testid="mindmap-reply-input-positioning-and-gtm-brief-builder"]')
      .first()
  ).toBeVisible()
  await expect(
    launched.window
      .locator('[data-testid="mindmap-reply-send-positioning-and-gtm-brief-builder"]')
      .first()
  ).toBeVisible()

  // Undo-last-apply button renders since conversations exist.
  await expect(
    launched.window.locator('[data-testid="mindmap-undo-last-apply"]').first()
  ).toBeVisible()
})

test('Capped conversation hides reply input + Send button', async () => {
  launched = await launchApp()
  const seededState = {
    root: {
      id: 'root',
      label: 'Plan',
      kind: 'idea',
      children: [],
      attachedWidgetIds: [],
      assignedAgentSlugs: []
    },
    selectedId: 'root',
    agentSuggestions: {
      root: [
        {
          slug: 'positioning-and-gtm-brief-builder',
          name: 'positioning-and-gtm-brief-builder',
          rationale: 'fit',
          path: '/Applications/agentic-starter-kit-main/.claude/agents/positioning-and-gtm-brief-builder.md'
        }
      ]
    },
    agentConversations: {
      'root:positioning-and-gtm-brief-builder': {
        agentName: 'positioning-and-gtm-brief-builder',
        agentSlug: 'positioning-and-gtm-brief-builder',
        capped: true,
        userReplies: [],
        turns: [
          {
            rawReply: '',
            reply: 'Capped conversation example.',
            proposalStates: [],
            invocationId: 'inv-cap',
            conversationTurn: 5,
            at: Date.now()
          }
        ]
      }
    },
    agentStats: {}
  }
  await seedMindMap(launched, JSON.stringify(seededState))

  // Reply input should NOT be present when capped.
  await expect(
    launched.window
      .locator('[data-testid="mindmap-reply-input-positioning-and-gtm-brief-builder"]')
      .first()
  ).not.toBeVisible({ timeout: 1500 })
  // The cap notice should be visible.
  await expect(
    launched.window.getByText(/Conversation full \(5 turns\)/i)
  ).toBeVisible({ timeout: 5_000 })
})

test('Agent creation wizard opens with prefilled slug from the node label', async () => {
  launched = await launchApp()
  const seededState = {
    root: {
      id: 'root',
      label: 'Press release writer',
      kind: 'agent',
      children: [],
      attachedWidgetIds: [],
      assignedAgentSlugs: []
    },
    selectedId: 'root',
    agentSuggestions: {},
    agentInvocations: {}
  }
  await seedMindMap(launched, JSON.stringify(seededState))

  await launched.window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      '[data-testid="mindmap-create-agent"]'
    )
    if (!btn) throw new Error('create-agent button missing')
    btn.click()
  })
  await launched.window.waitForTimeout(150)

  // Slug should be slugified from the node label.
  const slug = await launched.window.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="agent-wizard-slug"]'
    )
    return input?.value ?? null
  })
  expect(slug).toBe('press-release-writer')
})

test('Convert-to-task creates a child task on the active task', async () => {
  launched = await launchApp()
  const seededState = {
    root: {
      id: 'root',
      label: 'Launch plan',
      kind: 'idea',
      children: [
        { id: 'b1', label: 'Find 5 design partners', kind: 'task', children: [] }
      ]
    },
    selectedId: 'b1',
    agents: {}
  }
  const seeded = await seedMindMap(launched, JSON.stringify(seededState))

  // The node id must be selected before Convert can find it. The
  // seeded selectedId is 'b1', but the reload sequence may re-init —
  // explicitly click it.
  await launched.window.evaluate(() => {
    const el = document.querySelector<SVGGElement>('[data-testid="mindmap-node-b1"]')
    if (!el) throw new Error('mindmap-node-b1 not found')
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await launched.window.waitForTimeout(200)
  await launched.window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      '[data-testid="mindmap-convert-task"]'
    )
    if (!btn) throw new Error('convert button not found')
    btn.click()
  })
  await launched.window.waitForTimeout(500)

  const childTitles = await launched.window.evaluate(async (parentId: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const nodes = await api.nodes.list()
    return nodes
      .filter((n) => n.parentId === parentId && n.kind === 'task')
      .map((n) => n.title)
  }, seeded.taskId)
  expect(childTitles).toContain('Find 5 design partners')
})
