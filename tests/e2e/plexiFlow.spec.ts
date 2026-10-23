import { test, expect } from '@playwright/test'
import { gotoView, launchApp, openProduct, waitForReady } from './_helpers'

// PlexiFlow verification.
// IPC APIs used for seeding: window.api.flows.{list,create,update,run,get}
//   window.api.nodes.list to confirm real task creation.
//   window.api.knowledge.list to confirm real knowledge entry creation.

test('1. empty state: no flows shows flows-empty (no fake flow)', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await openProduct(window, 'flow')
    await expect(window.locator('[data-testid="plexiflow-view"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator('[data-testid="flows-empty"]')).toBeVisible({ timeout: 5_000 })

    const list = await window.evaluate(async () => window.api.flows.list())
    expect((list as unknown[]).length).toBe(0)
  } finally {
    await dispose()
  }
})

test('2. create flow: card appears and editor opens', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    await openProduct(window, 'flow')
    await expect(window.locator('[data-testid="plexiflow-view"]')).toBeVisible({ timeout: 8_000 })

    await window.locator('[data-testid="flow-new"]').click()
    await window.waitForTimeout(400)

    const flows = await window.evaluate(async () => window.api.flows.list())
    const flowList = flows as Array<{ id: string }>
    expect(flowList.length).toBe(1)
    const flowId = flowList[0].id

    await expect(window.locator(`[data-testid="flow-card-${flowId}"]`)).toBeVisible({ timeout: 5_000 })
    // Editor opens: flow-title input, flow-run button, flow-add-actions visible
    await expect(window.locator('[data-testid="flow-title"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="flow-add-actions"]')).toBeVisible({ timeout: 5_000 })
  } finally {
    await dispose()
  }
})

test('3. create-task action: run produces real task node, log shows success', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // Create flow via IPC
    const flow = await window.evaluate(async () =>
      window.api.flows.create({ title: 'Task Flow' })
    )
    const flowId: string = (flow as { id: string }).id

    // Add create-task action via IPC with a distinctive title
    const actionId = 'a-test-create-task'
    await window.evaluate(
      async ([id, aid]) =>
        window.api.flows.update(id, {
          actions: [{ id: aid, type: 'create-task', title: 'Zirconia Flow Task' }]
        }),
      [flowId, actionId] as [string, string]
    )

    // Open flow editor via UI
    await openProduct(window, 'flow')
    await expect(window.locator(`[data-testid="flow-card-${flowId}"]`)).toBeVisible({ timeout: 8_000 })
    await window.locator(`[data-testid="flow-card-${flowId}"]`).click()
    await expect(window.locator('[data-testid="flow-action-0"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="flow-run"]')).toBeVisible()

    // Click Run now
    await window.locator('[data-testid="flow-run"]').click()

    // flow-log must appear with a success entry
    const logLocator = window.locator('[data-testid="flow-log"]')
    await expect(logLocator).toBeVisible({ timeout: 10_000 })
    const logText = await logLocator.innerText()
    expect(logText).toContain('Zirconia Flow Task')

    // Confirm the log shows success (check_circle icon is present = ok step)
    // The icon renders as a Material Symbol text character or svg; we verify via IPC
    const runResult = await window.evaluate(async (id) => window.api.flows.run(id), flowId)
    const result = runResult as { ok: boolean; steps: Array<{ ok: boolean; message: string }> }
    expect(result.steps[0].ok).toBe(true)
    expect(result.steps[0].message).toContain('Zirconia Flow Task')

    // REAL task must now exist in nodes
    const nodes = await window.evaluate(async () => window.api.nodes.list())
    const nodeList = nodes as Array<{ title: string; kind: string }>
    const created = nodeList.find((n) => n.title === 'Zirconia Flow Task' && n.kind === 'task')
    expect(created).toBeDefined()
  } finally {
    await dispose()
  }
})

test('4. send-email with no account: log shows honest failed step, not fake success', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const flow = await window.evaluate(async () =>
      window.api.flows.create({ title: 'Email Flow' })
    )
    const flowId: string = (flow as { id: string }).id

    await window.evaluate(
      async (id) =>
        window.api.flows.update(id, {
          actions: [{
            id: 'a-email-1',
            type: 'send-email',
            to: 'nobody@example.com',
            subject: 'Test',
            body: 'Hello'
          }]
        }),
      flowId
    )

    // Run via IPC (no need for UI click to verify the core contract)
    const runResult = await window.evaluate(async (id) => window.api.flows.run(id), flowId)
    const result = runResult as { ok: boolean; steps: Array<{ ok: boolean; message: string; type: string }> }

    // Flow overall must NOT be ok
    expect(result.ok).toBe(false)

    // send-email step must be explicitly failed with honest message
    const emailStep = result.steps.find((s) => s.type === 'send-email')
    expect(emailStep).toBeDefined()
    expect(emailStep!.ok).toBe(false)
    expect(emailStep!.message).toContain('No mail account connected')

    // Open UI and confirm log shows the error (not fake success)
    await openProduct(window, 'flow')
    await expect(window.locator(`[data-testid="flow-card-${flowId}"]`)).toBeVisible({ timeout: 8_000 })
    await window.locator(`[data-testid="flow-card-${flowId}"]`).click()

    const logLocator = window.locator('[data-testid="flow-log"]')
    await expect(logLocator).toBeVisible({ timeout: 5_000 })
    const logText = await logLocator.innerText()
    expect(logText).toContain('No mail account connected')
    // Must NOT show success text
    expect(logText).not.toContain('Emailed')
  } finally {
    await dispose()
  }
})

test('5. AI step + {{ai}} chaining: real substitution or honest no-key fail', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const flow = await window.evaluate(async () =>
      window.api.flows.create({ title: 'AI Chain Flow' })
    )
    const flowId: string = (flow as { id: string }).id

    // ai-step prompt, then create-knowledge whose body uses {{ai}}
    await window.evaluate(
      async (id) =>
        window.api.flows.update(id, {
          actions: [
            { id: 'a-ai-1', type: 'ai-step', prompt: 'In one sentence, what is the capital of France?' },
            { id: 'a-know-1', type: 'create-knowledge', title: 'AI Chain Result', body: '{{ai}}' }
          ]
        }),
      flowId
    )

    const runResult = await window.evaluate(async (id) => window.api.flows.run(id), flowId)
    const result = runResult as { ok: boolean; steps: Array<{ ok: boolean; message: string; type: string }> }

    const aiStep = result.steps.find((s) => s.type === 'ai-step')
    const knowStep = result.steps.find((s) => s.type === 'create-knowledge')
    expect(aiStep).toBeDefined()
    expect(knowStep).toBeDefined()

    if (aiStep!.ok) {
      // Key available: ai-step succeeded, knowledge entry should have real content
      expect(knowStep!.ok).toBe(true)

      // The knowledge entry must exist with non-empty body ({{ai}} substituted)
      const entries = await window.evaluate(async () => window.api.knowledge.list())
      const entryList = entries as Array<{ title: string; body: string }>
      const entry = entryList.find((e) => e.title === 'AI Chain Result')
      expect(entry).toBeDefined()
      // Body must not be the literal "{{ai}}" — substitution must have happened
      expect(entry!.body).not.toBe('{{ai}}')
      expect(entry!.body.length).toBeGreaterThan(0)
    } else {
      // No key: ai-step must say so honestly, NOT fabricate output
      expect(aiStep!.message).toContain('No Anthropic key')
      // create-knowledge step still ran (engine does not stop on failure)
      // but body will be empty string ({{ai}} substituted with empty ctx.ai)
      expect(knowStep!.ok).toBe(true)
      const entries = await window.evaluate(async () => window.api.knowledge.list())
      const entryList = entries as Array<{ title: string; body: string }>
      const entry = entryList.find((e) => e.title === 'AI Chain Result')
      expect(entry).toBeDefined()
      // Body is empty ({{ai}} = '' because ai-step failed) — honest, not fabricated
      expect(entry!.body).toBe('')
    }
  } finally {
    await dispose()
  }
})

test('6. trigger persists: set to weekly, reload via IPC, confirm trigger.kind=schedule, every=weekly', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const flow = await window.evaluate(async () =>
      window.api.flows.create({ title: 'Scheduled Flow' })
    )
    const flowId: string = (flow as { id: string }).id

    // Open editor in UI and select "Every week" via the trigger select
    await openProduct(window, 'flow')
    await expect(window.locator(`[data-testid="flow-card-${flowId}"]`)).toBeVisible({ timeout: 8_000 })
    await window.locator(`[data-testid="flow-card-${flowId}"]`).click()
    await expect(window.locator('[data-testid="flow-trigger"]')).toBeVisible({ timeout: 5_000 })

    await window.locator('[data-testid="flow-trigger"]').selectOption('weekly')
    await window.waitForTimeout(400)

    // Reload via IPC and confirm persisted
    const reloaded = await window.evaluate(async (id) => window.api.flows.get(id), flowId)
    const reloadedTyped = reloaded as { trigger: { kind: string; every?: string } }
    expect(reloadedTyped.trigger.kind).toBe('schedule')
    expect(reloadedTyped.trigger.every).toBe('weekly')
  } finally {
    await dispose()
  }
})

test('7. suite launcher: PlexiFlow tile opens the flow view', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    // STALE: there is no "PlexiiSuite" button to click — the object-based IA
    // dropped the literal sidebar entries, so this waited out the full 30s
    // timeout. goSuite ({ kind: 'suite' }) is the view store's own route to it.
    await gotoView(window, 'goSuite')
    await expect(window.locator('[data-testid="plexisuite-home"]')).toBeVisible({ timeout: 8_000 })

    await window.locator('[data-testid="product-tile-plexiflow"]').click()
    await expect(window.locator('[data-testid="product-home-plexiflow"]')).toBeVisible({ timeout: 8_000 })

    await window.locator('[data-testid="open-plexiflow"]').click()
    await expect(window.locator('[data-testid="plexiflow-view"]')).toBeVisible({ timeout: 8_000 })
  } finally {
    await dispose()
  }
})
