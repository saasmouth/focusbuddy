// E2E: the owner's 4.3.39-local.3 case, end to end on the on-device model.
//
// A fresh table (the Name/Done scaffold) on a desk, the in-table AI asked for
// "podcast episodes" (and two other briefs) with AI running on this computer.
// The reply used to be rejected for lacking Build with AI's "suggestions"
// array ("did not come out in a usable shape" and a cloud offer), and a retry
// could end in "AI returned no rows." Now the proposed columns and the rows
// must come back, stage, and land in the table — with no cloud offer and
// nothing sent anywhere.
//
// Needs the real model: LOCAL_AI_E2E_MODEL=<the catalog GGUF> (the dev tree's
// staged resources/models is used as the app bundle). Throwaway profile only.
import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

const MODEL = process.env.LOCAL_AI_E2E_MODEL
let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

async function seedScaffoldTable(window: LaunchedApp['window'], desk: string): Promise<{ widgetId: string; tableId: string }> {
  return window.evaluate(async (deskTitle) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: deskTitle })
    const table = await api.tables.create({
      title: 'Untitled table',
      schema: {
        columns: [
          { id: 'c-name', type: 'text-short', label: 'Name', config: {} },
          { id: 'c-done', type: 'checkbox', label: 'Done', config: {} }
        ]
      }
    })
    const widget = await api.widgets.create({ taskId: task.id, kind: 'table', title: 'Untitled table', content: table.id, x: 80, y: 80, width: 760, height: 460 })
    return { widgetId: widget.id, tableId: table.id }
  }, desk)
}

for (const brief of ['podcast episodes', 'expenses for a trip to Japan', 'my weekly workouts']) {
  test(`LTR — "${brief}": the on-device model proposes columns and rows, they stage and land in the table`, async () => {
    test.skip(!MODEL || !existsSync(MODEL), 'set LOCAL_AI_E2E_MODEL to the catalog GGUF to run on the real model')
    test.setTimeout(240_000)
    launched = await launchApp({ env: { PLEXI_APP: 'preview3', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } })
    const { window } = launched
    await waitForReady(window)
    const st = await window.evaluate(() => window.api.localAi.getStatus())
    test.skip(!st.tiers.some((t) => t.source !== null), 'the dev tree has no staged model (resources/models)')
    // A fresh profile moves to Local once the bundled model has passed its
    // checksum (4.3.40: never before), which runs in the background at start-up.
    await expect
      .poll(async () => (await window.evaluate(() => window.api.localAi.getStatus())).provider, { timeout: 90_000 })
      .toBe('local')

    const desk = `TableRows ${brief}`
    const { widgetId, tableId } = await seedScaffoldTable(window, desk)
    await window.reload()
    await waitForReady(window)
    await window.getByRole('button', { name: new RegExp(desk) }).first().click()
    await window.waitForSelector(`[data-widget-id="${widgetId}"] [data-testid="table-ai-rows"]`, { timeout: 15_000 })
    const widget = window.locator(`[data-widget-id="${widgetId}"]`)
    await widget.locator('[data-testid="table-ai-rows"]').click()
    await widget.getByPlaceholder(/fictional podcast episodes/).fill(brief)
    await widget.getByRole('button', { name: /^Draft$/ }).click()

    // Either step 1 (approve proposed columns) or straight to step 2 (rows).
    const step1 = widget.getByText(/Step 1 — Approve \d+ new column/)
    const step2 = widget.getByText(/Step 2 — Approve \d+ rows?/)
    await expect(step1.or(step2)).toBeVisible({ timeout: 200_000 })
    // Never the failures the owner saw, never a cloud offer.
    await expect(widget.getByText(/AI returned no rows|usable shape/)).toHaveCount(0)
    await expect(window.getByText(/Use cloud for this request/i)).toHaveCount(0)

    if (await step1.isVisible()) await widget.getByRole('button', { name: /^Add \d+ columns?$/ }).click()
    await expect(step2).toBeVisible({ timeout: 10_000 })
    const staged = Number(/Approve (\d+)/.exec((await step2.textContent()) ?? '')?.[1] ?? 0)
    expect(staged).toBeGreaterThan(0)
    await widget.getByRole('button', { name: /^Add \d+ rows?$/ }).click()

    const rows = await window.evaluate(async (id) => (await window.api.tables.listRows(id)).length, tableId)
    expect(rows).toBe(staged)
  })
}
