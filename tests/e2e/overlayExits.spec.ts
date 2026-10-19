import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// The exit law: every surface that takes over the screen offers an obvious way
// out — Escape at minimum. These specs cover the three offenders the exit
// audit found could genuinely trap someone: the Pre-Task Bridge (auto-fires on
// "avoidance" tasks with no Esc/X/backdrop), first-run onboarding (no Esc, and
// step 3 had no skip path if seeding failed), and the end-of-focus-session
// choice modal (a forced four-way choice).

const OUT = process.env.SHOT_DIR ?? '/tmp'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('first-run onboarding dismisses on Escape', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window, { dismissModals: false })

  const onb = window.locator('[role="dialog"][aria-label="Welcome to PlexiiDesk"]')
  await expect(onb).toBeVisible({ timeout: 10_000 })
  await window.keyboard.press('Escape')
  await expect(onb).toBeHidden()
})

test('the Pre-Task Bridge exits via Escape, and shows a close button', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // An "avoidance" task (low interest) so activating it fires the bridge.
  const { taskId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Dreaded chore' })
    await api.nodes.update(task.id, { interest: 1 })
    return { taskId: task.id }
  })
  await window.evaluate(() => localStorage.setItem('fb.theme.mode', 'dark'))
  await window.reload()
  await waitForReady(window)
  await window.setViewportSize({ width: 1440, height: 900 })

  const activate = async (): Promise<void> => {
    await window.evaluate((id) => {
      const w = window as unknown as {
        __fbNodes?: { getState: () => { setActive: (id: string | null) => void } }
      }
      w.__fbNodes?.getState().setActive(id)
    }, taskId)
  }

  await activate()
  const bridge = window.getByText('What would make this 10% easier right now?')
  await expect(bridge).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-testid="pre-task-bridge-close"]')).toBeVisible()
  await window.screenshot({ path: `${OUT}/exit-bridge-dark.png` })
  await window.keyboard.press('Escape')
  await expect(bridge).toBeHidden()

  // Atelier: the bridge repaints from tokens and the exit chrome holds.
  await window.evaluate(() => localStorage.setItem('fb.theme.mode', 'atelier'))
  await window.reload()
  await waitForReady(window)
  await activate()
  await expect(bridge).toBeVisible({ timeout: 5_000 })
  await window.screenshot({ path: `${OUT}/exit-bridge-atelier.png` })
  await window.keyboard.press('Escape')
  await expect(bridge).toBeHidden()
})

test('the end-of-session choice modal dismisses on Escape as "done"', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { taskId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Timed task' })
    return { taskId: task.id }
  })
  await window.reload()
  await waitForReady(window)

  // A 1-second session: the tick takes it to zero and the choice modal opens.
  // The ticker only counts down while the task's canvas is the active view
  // (isEngagedWith), so navigate onto the task first.
  await window.evaluate(async (id) => {
    const w = window as unknown as {
      __fbFocusSession?: {
        getState: () => { start: (taskId: string, s: number, k?: string) => Promise<void> }
      }
      __fbNodes?: { getState: () => { setActive: (id: string | null) => void } }
      __fbView?: { getState: () => { goTask: (id: string) => void } }
    }
    w.__fbNodes?.getState().setActive(id)
    w.__fbView?.getState().goTask(id)
    await w.__fbFocusSession?.getState().start(id, 1, '5min')
  }, taskId)

  const modal = window.getByText('No streak to break. Both choices count as a win.')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await window.keyboard.press('Escape')
  await expect(modal).toBeHidden({ timeout: 5_000 })
})
