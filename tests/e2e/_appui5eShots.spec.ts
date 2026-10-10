import { test, expect } from '@playwright/test'
import { gotoView, launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Visual-review shots for App-UI phase 5e: Calendar (month + week) aligned to
// the design system. Throwaway; delete when the phase closes.

const OUT = process.env.SHOT_DIR ?? '/tmp'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seed(window: import('@playwright/test').Page): Promise<void> {
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const t1 = await api.nodes.create({ parentId: null, kind: 'task', title: 'Write the runsheet' })
    await api.nodes.update(t1.id, { dueDate: Date.now() - 86_400_000 })
    const t2 = await api.nodes.create({ parentId: null, kind: 'task', title: 'Book the venue' })
    await api.nodes.update(t2.id, { dueDate: Date.now() + 86_400_000, status: 'in_progress' })
    const t3 = await api.nodes.create({ parentId: null, kind: 'task', title: 'Send invites' })
    await api.nodes.update(t3.id, { dueDate: Date.now(), status: 'done' })
  })
}

for (const theme of ['dark', 'atelier'] as const) {
  test(`calendar month, ${theme}`, async () => {
    launched = await launchApp()
    const { window } = launched
    await waitForReady(window)
    await window.setViewportSize({ width: 1440, height: 900 })
    await seed(window)
    await window.evaluate((t) => localStorage.setItem('fb.theme.mode', t), theme)
    await window.reload()
    await waitForReady(window)
    await gotoView(window, 'goCalendar')
    await window.waitForTimeout(700)
    await expect(window.getByRole('heading', { name: 'Calendar' })).toBeVisible()
    await window.screenshot({ path: `${OUT}/5e-calendar-month-${theme}.png` })
  })
}

test('calendar week + composer, dark', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.setViewportSize({ width: 1440, height: 900 })
  await window.evaluate(() => localStorage.setItem('fb.theme.mode', 'dark'))
  await window.reload()
  await waitForReady(window)
  await gotoView(window, 'goCalendar')
  await window.waitForTimeout(500)
  await window.locator('[data-testid="calendar-mode-week"]').click()
  await window.waitForTimeout(600)
  await window.screenshot({ path: `${OUT}/5e-calendar-week-dark.png` })

  // Click a mid-morning slot in the first day column to open the composer.
  const col = window.locator('[data-testid="time-block"]').first()
  const grid = window.locator('div.relative.rounded-\\[var\\(--radius-row\\)\\]').first()
  void col
  const box = await grid.boundingBox()
  if (box) {
    await window.mouse.click(box.x + box.width / 2, box.y + 200)
    await window.waitForTimeout(400)
    const composer = window.locator('[data-testid="book-time-dialog"]')
    if (await composer.isVisible().catch(() => false)) {
      await window.screenshot({ path: `${OUT}/5e-calendar-composer-dark.png` })
      await window.keyboard.press('Escape')
    }
  }
})
