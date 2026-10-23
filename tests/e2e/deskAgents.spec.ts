import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Desk agents: a standing AI worker placed on the canvas. Its inputs are the
// widgets wired INTO it. These tests prove config persistence, that inputs
// reflect the wires, that a manual run logs an outcome, and that the onChange
// trigger fires a run when a wired input changes — all without depending on a
// usable API key (a no-key run still logs an error outcome, which is what we
// assert on).

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function agentContent(
  window: LaunchedApp['window'],
  taskId: string
): Promise<{
  instruction: string
  trigger: string
  lastRunAt: number | null
  history: unknown[]
} | null> {
  return window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const ws = await api.widgets.listByTask(tid)
    const agent = ws.find((w) => w.kind === 'agent')
    if (!agent) return null
    try {
      return JSON.parse(agent.content || '{}')
    } catch {
      return {}
    }
  }, taskId)
}

// The right-hand assistant panel overlays the right of the canvas and would
// intercept clicks on a widget placed there. Collapse it before interacting.
async function hideAssistant(window: LaunchedApp['window']): Promise<void> {
  const btn = window.getByRole('button', { name: 'Hide assistant panel' })
  if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {})
  await window.waitForTimeout(150)
}

async function seed(
  window: LaunchedApp['window'],
  agentContentJson = ''
): Promise<{ taskId: string; agentId: string; stickyId: string }> {
  return window.evaluate(async (content: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Agent task' })
    const sticky = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'notes',
      content: 'Buy milk. Email Dana. Ship the build.',
      x: 120,
      y: 200,
      width: 220,
      height: 180
    })
    const agent = await api.widgets.create({
      taskId: task.id,
      kind: 'agent',
      title: 'Agent',
      content,
      x: 480,
      y: 200,
      width: 340,
      height: 320
    })
    // Wire the sticky INTO the agent (sticky → agent = an input).
    await api.widgetLinks.create(sticky.id, agent.id, task.id)
    return { taskId: task.id, agentId: agent.id, stickyId: sticky.id }
  }, agentContentJson)
}

test('agent reflects its wired inputs and persists instruction + trigger', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await seed(window)

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Agent task/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)
  await hideAssistant(window)

  // The wired sticky shows up as an input.
  await expect(window.locator('[data-testid="agent-input-count"]')).toContainText(/1 input/i)

  // Set an instruction and the on-change trigger; both persist.
  await window.locator('[data-testid="agent-instruction"]').fill('summarize the notes')
  await window.locator('[data-testid="agent-trigger-onChange"]').click()
  await window.waitForTimeout(600)

  const cfg = await agentContent(window, ids.taskId)
  expect(cfg?.instruction).toBe('summarize the notes')
  expect(cfg?.trigger).toBe('onChange')
})

test('a manual run logs an outcome and settles without crashing', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await seed(window)

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Agent task/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)
  await hideAssistant(window)

  await window.locator('[data-testid="agent-instruction"]').fill('summarize the notes in one line')
  await window.locator('[data-testid="agent-run"]').click()

  // Whatever the key state, a run is attempted and logged (success output or a
  // no-key/error outcome). lastRunAt becomes set.
  await expect
    .poll(async () => (await agentContent(window, ids.taskId))?.lastRunAt, {
      timeout: 20_000,
      intervals: [300, 600, 1000]
    })
    .not.toBeNull()
  // Widget is still mounted — no crash.
  await expect(window.locator('[data-testid="agent-widget"]')).toBeVisible()
})

test('the onChange trigger fires a run when a wired input changes', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  // Seed the agent pre-configured: an instruction, onChange trigger, enabled.
  const ids = await seed(
    window,
    JSON.stringify({ instruction: 'summarize the notes', trigger: 'onChange', enabled: true })
  )

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Agent task/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)
  await hideAssistant(window)

  // No run yet.
  expect((await agentContent(window, ids.taskId))?.lastRunAt ?? null).toBeNull()

  // Edit the wired sticky → the agent should run on the change.
  // A sticky with text shows a rendered view and a click flips it to the
  // textarea (70574c927), so click in first, as a person would.
  await window.locator(`[data-widget-id="${ids.stickyId}"] .fb-sticky-rendered`).click()
  const srcArea = window.locator(`[data-widget-id="${ids.stickyId}"] textarea`)
  await srcArea.click()
  await srcArea.fill('New plan: call the supplier and update the deck.')
  await srcArea.blur()

  await expect
    .poll(async () => (await agentContent(window, ids.taskId))?.lastRunAt, {
      timeout: 20_000,
      intervals: [500, 800, 1200]
    })
    .not.toBeNull()
})

test('an agent feeds its output into a note via a mirror wire', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Agent feed' })
    const note = await api.widgets.create({
      taskId: task.id,
      kind: 'note',
      title: 'out',
      content: '',
      x: 480,
      y: 200,
      width: 240,
      height: 180
    })
    const agent = await api.widgets.create({
      taskId: task.id,
      kind: 'agent',
      title: 'Agent',
      content: JSON.stringify({
        instruction: 'summarize',
        trigger: 'manual',
        enabled: true,
        lastOutput: 'AGENT-OUTPUT-FEED'
      }),
      x: 120,
      y: 200,
      width: 340,
      height: 320
    })
    // Mirror wire FROM the agent INTO the note — delivers the agent's output.
    await api.widgetLinks.create(agent.id, note.id, task.id, 'mirror')
    return { taskId: task.id, agentId: agent.id, noteId: note.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Agent feed/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)
  await hideAssistant(window)

  // The agent shows it feeds a downstream widget.
  await expect(window.locator('[data-testid="agent-output-count"]')).toContainText(/feeds 1/i)

  // Touch the agent (edit its instruction) so its content change fires the
  // mirror wire; the note receives the agent's latest OUTPUT (not its JSON).
  await window.locator('[data-testid="agent-instruction"]').fill('summarize the inputs briefly')

  await expect
    .poll(
      async () =>
        window.evaluate(
          async ({ taskId, noteId }: { taskId: string; noteId: string }) => {
            const api = (window as unknown as { api: typeof window.api }).api
            const ws = await api.widgets.listByTask(taskId)
            return ws.find((w) => w.id === noteId)?.content
          },
          { taskId: ids.taskId, noteId: ids.noteId }
        ),
      { timeout: 8_000, intervals: [400, 700, 1000] }
    )
    .toBe('AGENT-OUTPUT-FEED')
})

test('a plain (default) wire out of an agent also feeds the target', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Agent default feed' })
    const note = await api.widgets.create({
      taskId: task.id,
      kind: 'note',
      title: 'out',
      content: '',
      x: 480,
      y: 200,
      width: 240,
      height: 180
    })
    const agent = await api.widgets.create({
      taskId: task.id,
      kind: 'agent',
      title: 'Agent',
      content: JSON.stringify({
        instruction: 'summarize',
        trigger: 'manual',
        enabled: true,
        lastOutput: 'DEFAULT-WIRE-OUTPUT'
      }),
      x: 120,
      y: 200,
      width: 340,
      height: 320
    })
    // NOTE: no wire type passed — defaults to 'context'. Because the source is
    // an agent, it should still deliver the agent's output to the note.
    await api.widgetLinks.create(agent.id, note.id, task.id)
    return { taskId: task.id, agentId: agent.id, noteId: note.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Agent default feed/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)
  await hideAssistant(window)

  await window.locator('[data-testid="agent-instruction"]').fill('summarize briefly')

  await expect
    .poll(
      async () =>
        window.evaluate(
          async ({ taskId, noteId }: { taskId: string; noteId: string }) => {
            const api = (window as unknown as { api: typeof window.api }).api
            const ws = await api.widgets.listByTask(taskId)
            return ws.find((w) => w.id === noteId)?.content
          },
          { taskId: ids.taskId, noteId: ids.noteId }
        ),
      { timeout: 8_000, intervals: [400, 700, 1000] }
    )
    .toBe('DEFAULT-WIRE-OUTPUT')
})
