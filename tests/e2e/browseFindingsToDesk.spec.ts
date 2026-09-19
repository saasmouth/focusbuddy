// Research arriving on a desk in a form you can use.
//
// Delivery used to hand the findings BACK to a model and ask it to retype every
// record as a proposal. A long run's results did not fit in the reply, so they
// were truncated — and what landed looked like a complete table. Every cell
// also passed through a model that could round a price it had never seen.
//
// The widgets are planned from the data now. This drives the real dock, picks a
// real desk, and checks what actually landed in the database.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(240_000)
let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

const RECORDS = Array.from({ length: 30 }, (_, i) => ({
  name: `Supplier ${i + 1}`,
  rating: (5 - i * 0.05).toFixed(2),
  url: `https://example.test/s/${i + 1}`
}))

test('a finished run lands on the chosen desk as a full table', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { target, other } = await window.evaluate(async () => {
    const w = window as any
    const a = await w.__fbNodes.getState().create({ kind: 'task', title: 'Sourcing', parentId: null })
    const b = await w.__fbNodes.getState().create({ kind: 'task', title: 'Somewhere else', parentId: null })
    await w.__fbNodes.getState().refresh()
    return { target: a.id as string, other: b.id as string }
  })

  await window.evaluate(() => (window as any).__fbView.getState().goOffice('browser'))
  await expect(window.locator('[data-testid="office-browser"]')).toBeVisible()

  await window.evaluate((records) => {
    const w = window as any
    w.__fbBrowserAgent.setState({
      runs: {
        r1: {
          runId: 'r1',
          task: 'find soup suppliers and put them in a table',
          outcome: 'done',
          summary: 'Found 30 suppliers.',
          pendingConsentHost: null,
          events: [],
          cost: null,
          findings: {
            fields: ['name', 'rating', 'url'],
            records,
            answer: 'Supplier 1 has the best rating.'
          },
          delivery: { state: 'idle', message: '' }
        }
      }
    })
    w.__fbWebPanel.getState().setActiveRun('r1')
  }, RECORDS)

  // The desk is chosen, not assumed.
  await window.locator('[data-testid="agent-run-use-findings"]').click()
  await expect(window.locator('[data-testid="agent-run-desk-picker"]')).toBeVisible()
  await window.locator(`[data-testid="agent-run-desk-${target}"]`).click()

  await expect
    .poll(
      () => window.evaluate((id) => (window as any).api.widgets.listByTask(id).then((w: unknown[]) => w.length), target),
      { timeout: 30_000, message: 'the results should reach the desk' }
    )
    .toBeGreaterThan(0)

  const widgets = await window.evaluate((id) => (window as any).api.widgets.listByTask(id), target)
  const table = widgets.find((w: { kind: string }) => w.kind === 'table')
  const note = widgets.find((w: { kind: string }) => w.kind === 'markdown')

  expect(table, 'a list of things belongs in a table').toBeTruthy()
  expect(note, 'and the prose answer beside it').toBeTruthy()

  // EVERY row, not as many as fitted in a model's reply.
  const rows = await window.evaluate(
    (tid) => (window as any).api.tables.listRows(tid).then((r: unknown[]) => r.length),
    table.content
  )
  expect(rows, 'all 30 results should be there').toBe(30)

  // And nothing landed on the desk that was not chosen.
  const onOther = await window.evaluate((id) => (window as any).api.widgets.listByTask(id), other)
  expect(onOther).toHaveLength(0)
})
