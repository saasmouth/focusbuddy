// "It says it created a table but doesn't give indication where, or link to it."
//
// Delivery showed the model's one-line prose and stopped. The prose says what
// was MADE; it cannot say where it landed, because it is written before
// anything is applied. And the desk used is whichever was last ACTIVE — from a
// desk-less Office browser, one the user was not looking at.
//
// Driven through the run store rather than a live agent: no key, no open web,
// but the real dock rendering real state, and a real navigation at the end.

import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

test.setTimeout(180_000)
let launched: LaunchedApp | null = null
test.afterEach(async () => { if (launched) { await launched.dispose(); launched = null } })

test('a delivered result names its destination and opens it', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const w = window as any
    const desk = await w.__fbNodes.getState().create({
      kind: 'task',
      title: 'Dinner planning',
      parentId: null
    })
    await w.__fbNodes.getState().refresh()
    return desk.id as string
  })

  // Open the Office browser, so the dock is on screen and there is no desk in
  // view — the exact situation where "where did it go" is unanswerable.
  await window.evaluate(() => (window as any).__fbView.getState().goOffice('browser'))
  await expect(window.locator('[data-testid="office-browser"]')).toBeVisible()

  // A finished run whose findings have been delivered onto that desk.
  await window.evaluate((deskId) => {
    const w = window as any
    const store = w.__fbBrowserAgent
    store.setState({
      runs: {
        r1: {
          runId: 'r1',
          task: 'find chicken soup recipes',
          outcome: 'done',
          summary: 'Found 12 recipes.',
          pendingConsentHost: null,
          events: [],
          cost: null,
          findings: { fields: ['name'], records: [{ name: 'Soup' }], answer: '' },
          delivery: {
            state: 'done',
            message:
              'Created a ranked table of chicken soup recipes ordered by rating — on Dinner planning.',
            destination: {
              label: 'Dinner planning',
              icon: 'desk',
              view: { kind: 'task', taskId: deskId }
            }
          }
        }
      }
    })
    w.__fbWebPanel.getState().setActiveRun('r1')
  }, deskId)

  const delivery = window.locator('[data-testid="agent-run-delivery"]')
  await expect(delivery).toBeVisible()
  // The sentence now carries the half the model could not know.
  await expect(delivery).toContainText('Dinner planning')

  const open = window.locator('[data-testid="agent-run-open-destination"]')
  await expect(open, 'there should be a way to go and look at it').toBeVisible()
  await expect(open).toContainText('Dinner planning')

  await open.click()
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const v = (window as any).__fbView.getState().view
          return v.kind === 'task' ? v.taskId : null
        }),
      { timeout: 10_000, message: 'Open should land on the desk the results went to' }
    )
    .toBe(deskId)
})

test('no destination means no button, rather than one that goes nowhere', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.evaluate(() => (window as any).__fbView.getState().goOffice('browser'))
  await expect(window.locator('[data-testid="office-browser"]')).toBeVisible()

  await window.evaluate(() => {
    const w = window as any
    w.__fbBrowserAgent.setState({
      runs: {
        r2: {
          runId: 'r2',
          task: 'research something',
          outcome: 'done',
          summary: '',
          pendingConsentHost: null,
          events: [],
          cost: null,
          findings: { fields: [], records: [], answer: 'An answer.' },
          delivery: { state: 'done', message: 'Wrote it up.', destination: null }
        }
      }
    })
    w.__fbWebPanel.getState().setActiveRun('r2')
  })

  await expect(window.locator('[data-testid="agent-run-delivery"]')).toBeVisible()
  await expect(window.locator('[data-testid="agent-run-open-destination"]')).toHaveCount(0)
})
