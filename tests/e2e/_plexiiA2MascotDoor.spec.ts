import { test, expect } from '@playwright/test'
import { launchApp, suppressFeatureSpotlights, waitForReady } from './_helpers'

// A2 mascot door (AI-01, R11): the assistant panel's composer is the third
// door. A bare URL diverts Enter to the in-app browser with a visible
// preview; take-me-to navigates to a real desk; a question grows no chrome
// and stays pure chat. Throwaway; delete when A2 closes.
const OUT = process.env.SHOT_DIR ?? '/tmp'

// The bottom-right feature-spotlight card ("New: Rooms, Desks and Plans")
// docks exactly over the assistant pill and the docked composer, and is
// offered on the first boot after core onboarding, which for these tests is
// the boot after the reload. Since 5ef579b2 it waits for a 750ms quiet window
// (useInterruptionClear) before mounting, so it now arrives after
// waitForReady's one-shot dismiss and intercepted the pill and composer
// clicks (call log: feature-spotlight-popup "subtree intercepts pointer
// events"). Marking the tours seen before the reload keeps it away, as the
// app does once a person has seen them.

test('plexii A2 mascot door: the composer previews, diverts, and stays chat-first', async () => {
  const launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.setViewportSize({ width: 1440, height: 900 })
  await window.evaluate((t) => localStorage.setItem('fb.theme.mode', t), process.env.SHOT_THEME ?? 'dark')
  // Seed BEFORE the reload so the renderer's node store boots with the desk.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: { nodes: { create: (d: unknown) => Promise<unknown> } } }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Wedding desk' })
  })
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)

  // In through the mascot: the pill opens the panel, the chat tab holds the
  // composer.
  await window.locator('[data-testid="assistant-pill"]').click()
  await window.locator('[data-testid="assistant-tab-chat"]').click()
  const composer = window.locator('[data-testid="chat-composer"]')
  await expect(composer).toBeVisible()

  // A bare URL: the strip previews "Open plexi.so" as what Enter does (R11),
  // and Enter opens the in-app panel — no message is sent.
  await composer.click()
  await window.keyboard.type('plexi.so', { delay: 5 })
  const urlChip = window.locator('[data-testid="composer-intent-url"]')
  await expect(urlChip).toContainText('Open plexi.so')
  await window.screenshot({ path: `${OUT}/door-1-url-preview.png` })
  await window.keyboard.press('Enter')
  const panel = window.locator('[data-testid="web-panel"]')
  await expect(panel).toBeVisible()
  await expect(composer).toHaveText('') // the box cleared; nothing was sent
  await window.screenshot({ path: `${OUT}/door-2-url-opened.png` })
  await window.locator('[data-testid="web-panel-close"]').click()

  // Take-me-to naming a real desk: the strip previews Go to, Enter navigates.
  await composer.click()
  await window.keyboard.type('take me to the wedding desk', { delay: 5 })
  const gotoChip = window.locator('[data-testid="composer-intent-goto"]').first()
  await expect(gotoChip).toContainText('Go to Wedding desk')
  await window.screenshot({ path: `${OUT}/door-3-goto-preview.png` })
  await window.keyboard.press('Enter')
  await expect(window.locator('text=Wedding desk').first()).toBeVisible({ timeout: 5000 })
  await window.screenshot({ path: `${OUT}/door-4-desk-opened.png` })

  // A question grows no chrome: no intent strip, Enter would simply chat.
  await composer.click()
  await window.keyboard.type('what should our launch plan cover?', { delay: 5 })
  await expect(window.locator('[data-testid="composer-intent-row"]')).toHaveCount(0)
  await window.screenshot({ path: `${OUT}/door-5-question-quiet.png` })

  await launched.dispose()
})

test('plexii A2 pills: Home bar and composer modes act and stick', async () => {
  const launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.setViewportSize({ width: 1440, height: 900 })
  await window.evaluate((t) => localStorage.setItem('fb.theme.mode', t), process.env.SHOT_THEME ?? 'dark')
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)

  // The Home bar: trinity placeholder, cmdK chip, mode pills.
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goHome: () => void } } }
    w.__fbView?.getState().goHome()
  })
  const bar = window.locator('[data-testid="start-or-ask-input"]')
  await expect(bar).toBeVisible()
  await expect(bar).toHaveAttribute('placeholder', /search the web, or open anything/i)
  await expect(window.locator('[data-testid="start-or-ask-cmdk"]')).toBeVisible()
  await window.screenshot({ path: `${OUT}/pills-1-home-bar.png` })

  // Both semantics: typing then tapping Search acts immediately AND locks.
  await bar.fill('best sit stand desk 2026')
  await window.locator('[data-testid="start-or-ask-mode-search"]').click()
  const panel = window.locator('[data-testid="web-panel"]')
  await expect(panel).toBeVisible()
  // A search opens FULL SCREEN by default (Caleb's ruling).
  await expect(panel).toHaveAttribute('data-expanded', 'true')
  await window.screenshot({ path: `${OUT}/pills-2-home-search.png` })
  await window.locator('[data-testid="web-panel-close"]').click()
  // The lock survives: the bar is now a search bar with the engine choice
  // right beside the pills, and Enter searches.
  await expect(bar).toHaveAttribute('placeholder', /Search the web/)
  const homeEngineToggle = window.locator('[data-testid="web-panel-engine-toggle"]')
  await expect(homeEngineToggle).toBeVisible()
  // The menu must rise ABOVE the Home cards (it was buried under the standup
  // card before the portal): every engine row visible and clickable.
  await homeEngineToggle.click()
  const homeMenu = window.locator('[data-testid="web-panel-engine-menu"]')
  await expect(homeMenu).toBeVisible()
  for (const label of ['DuckDuckGo', 'Google', 'Bing', 'Brave Search', 'Perplexity']) {
    await expect(homeMenu).toContainText(label)
  }
  const box = await homeMenu.boundingBox()
  expect(box && box.height > 150).toBeTruthy() // not clipped to a sliver
  await window.waitForTimeout(400)
  await window.screenshot({ path: `${OUT}/pills-4-home-engine-menu.png` })
  await homeMenu.locator('[data-testid="web-panel-engine-duckduckgo"]').click()
  await expect(homeMenu).toHaveCount(0)
  await bar.fill('standing desk mats')
  await window.keyboard.press('Enter')
  await expect(panel).toBeVisible()
  await window.locator('[data-testid="web-panel-close"]').click()

  // Back to Ask: the instant rule still opens a bare URL without the model.
  await window.locator('[data-testid="start-or-ask-mode-ask"]').click()
  await bar.fill('plexi.so')
  await window.keyboard.press('Enter')
  await expect(panel).toBeVisible()
  await window.locator('[data-testid="web-panel-close"]').click()

  // The composer's pills: Search locks the chat box into a literal search bar.
  await window.locator('[data-testid="assistant-pill"]').click()
  await window.locator('[data-testid="assistant-tab-chat"]').click()
  const composer = window.locator('[data-testid="chat-composer"]')
  await expect(composer).toBeVisible()
  await window.locator('[data-testid="composer-mode-search"]').click()
  await composer.click()
  await window.keyboard.type('wedding venues austin', { delay: 5 })
  await window.screenshot({ path: `${OUT}/pills-3-composer-search.png` })
  await window.keyboard.press('Enter')
  await expect(panel).toBeVisible()
  await expect(composer).toHaveText('')
  await window.locator('[data-testid="web-panel-close"]').click()
  // Back to Auto for the next person in this profile.
  await window.locator('[data-testid="composer-mode-auto"]').click()

  await launched.dispose()
})

test('plexii A2 @ mentions: the bar jumps straight to desks, rooms, and widgets', async () => {
  const launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.setViewportSize({ width: 1440, height: 900 })
  await window.evaluate((t) => localStorage.setItem('fb.theme.mode', t), process.env.SHOT_THEME ?? 'dark')
  await window.evaluate(async () => {
    const api = (
      window as unknown as {
        api: {
          nodes: { create: (d: unknown) => Promise<{ id: string }> }
          widgets: { create: (d: unknown) => Promise<unknown> }
        }
      }
    ).api
    const room = await api.nodes.create({ parentId: null, kind: 'folder', title: 'Client work' })
    const desk = await api.nodes.create({ parentId: room.id, kind: 'task', title: 'Flamelit HQ' })
    await api.widgets.create({
      taskId: desk.id,
      kind: 'sticky',
      title: 'Budget tracker',
      content: 'Q3 budget: 4,200 for the hydrofoil.'
    })
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goHome: () => void } } }
    w.__fbView?.getState().goHome()
  })

  const bar = window.locator('[data-testid="start-or-ask-input"]')
  await expect(bar).toBeVisible()

  // "@flame" surfaces the desk instantly; Enter lands on it.
  await bar.click()
  await window.keyboard.type('@flame', { delay: 8 })
  const menu = window.locator('[data-testid="start-or-ask-mentions"]')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-testid="start-or-ask-mention-row"]').first()).toContainText(
    'Flamelit HQ'
  )
  await window.waitForTimeout(400)
  await window.screenshot({ path: `${OUT}/mention-1-desk.png` })
  await window.keyboard.press('Enter')
  // Landed on the desk (the Home bar unmounts with the navigation).
  await expect(window.locator('text=Flamelit HQ').first()).toBeVisible({ timeout: 5000 })
  await expect(bar).toHaveCount(0)

  // A widget mention (via the search backend) lands on its desk, selected.
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goHome: () => void } } }
    w.__fbView?.getState().goHome()
  })
  await bar.click()
  await window.keyboard.type('@budget tracker', { delay: 8 })
  const widgetRow = window
    .locator('[data-testid="start-or-ask-mention-row"]')
    .filter({ hasText: 'Budget tracker' })
    .first()
  await expect(widgetRow).toBeVisible({ timeout: 5000 })
  await expect(widgetRow).toContainText('Work widget')
  await window.screenshot({ path: `${OUT}/mention-2-widget.png` })
  await widgetRow.click()
  await expect(window.locator('text=Budget tracker').first()).toBeVisible({ timeout: 5000 })

  await launched.dispose()
})
