// "Something broke in the UI — Minified React error #185" on EVERY launch
// (owner, 2026-11-03): the Day Trading desk's "Opening range timer (15 min)"
// came back "running" with its time long up (a synced copy of the run), and
// TimerWidget finished the same run ~100 times in a second until React's
// nested-update limit. Opening a desk whose
// timer ran out while the app was away must keep the app up and finish the run
// exactly once.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('TIMER-1 — a desk whose timer ran out while the app was away opens without crashing, and the run finishes once', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Expired timer desk' })
    // A 15-minute run started 20 minutes ago: past zero the moment it renders.
    const content = JSON.stringify({ targetSec: 900, elapsedSec: 0, state: 'running', startedAt: Date.now() - 20 * 60_000 })
    const w = (await api.widgets.create({ taskId: task.id, kind: 'timer', title: 'Opening range timer', content, x: 60, y: 60, width: 224, height: 224 } as never)) as { id: string }
    await api.widgets.create({ taskId: task.id, kind: 'sticky', content: 'Hard rules', x: 320, y: 60, width: 240, height: 200 } as never)
    return { taskId: task.id, timerId: w.id }
  })
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }).__fbView?.getState().goTask(id), ids.taskId)
  // The desk, or the error screen (old code: the owner's exact crash, same
  // component stack — gLe › aside › RXe › fhn).
  await expect(window.locator('[data-canvas-surface="true"]').or(window.getByText('Something broke in the UI')).first()).toBeVisible({ timeout: 15_000 })
  await window.waitForTimeout(3_000)
  await expect(window.getByText('Something broke in the UI'), 'the error screen').toHaveCount(0)
  expect(errors.filter((e) => /#185|Maximum update depth/.test(e))).toEqual([])
  // The run is finished — once — and stored as done.
  const stored = await window.evaluate(async (id: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgets.get(id))?.content ?? null
  }, ids.timerId)
  expect(stored, 'the timer row').not.toBeNull()
  expect(JSON.parse(stored as string)).toMatchObject({ state: 'done', elapsedSec: 900, startedAt: null })
  await expect(window.getByText("Time's up").first()).toBeVisible()
})

// The same loop without any sync: the owner's first crash (13:19:44) came 39 s
// after their 15-minute run (started 13:04:05) ran out ON SCREEN. Any timer
// reaching zero while its desk was open tripped it.
test('TIMER-2 — a timer that runs out while its desk is open sounds once and keeps the app up', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Timer ends on screen' })
    // A 15-minute run that ends 20 s from now.
    const endsAt = Date.now() + 20_000
    const content = JSON.stringify({ targetSec: 900, elapsedSec: 0, state: 'running', startedAt: endsAt - 900_000 })
    const w = (await api.widgets.create({ taskId: task.id, kind: 'timer', title: 'Opening range timer', content, x: 60, y: 60, width: 224, height: 224 } as never)) as { id: string }
    return { taskId: task.id, timerId: w.id, endsAt }
  })
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }).__fbView?.getState().goTask(id), ids.taskId)
  await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible({ timeout: 15_000 })
  // Still counting down when the desk is showing: this is the on-screen case.
  expect(await window.evaluate(() => Date.now()), 'the desk opened before the run ended').toBeLessThan(ids.endsAt - 2_000)
  await expect(window.getByText("Time's up").first()).toHaveCount(0)
  await expect(window.getByText("Time's up").first().or(window.getByText('Something broke in the UI'))).toBeVisible({ timeout: 30_000 })
  await window.waitForTimeout(1_500)
  await expect(window.getByText('Something broke in the UI'), 'the error screen').toHaveCount(0)
  expect(errors.filter((e) => /#185|Maximum update depth/.test(e))).toEqual([])
  const stored = await window.evaluate(async (id: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgets.get(id))?.content ?? null
  }, ids.timerId)
  expect(stored, 'the timer row').not.toBeNull()
  expect(JSON.parse(stored as string)).toMatchObject({ state: 'done', elapsedSec: 900, startedAt: null })
})
