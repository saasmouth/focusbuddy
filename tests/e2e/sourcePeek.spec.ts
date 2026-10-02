import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Looking at a cited reference without leaving the conversation.
//
// The classification and the routing are unit-tested. What those cannot show is
// the thing that matters: that the viewer actually RENDERS the referenced object
// — the same inline renderer focus mode uses, with the real widget's content in
// it — and that the way back out to the thing itself still works.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seed(window: Page): Promise<{ deskId: string; widgetId: string }> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Peek desk' })
    const w = await api.widgets.create({
      taskId: desk.id,
      kind: 'markdown',
      title: 'Levy terms',
      content: 'The quarterly levy is due on the 14th.',
      x: 60,
      y: 60,
      width: 420,
      height: 320
    })
    return { deskId: desk.id as string, widgetId: w.id as string }
  })
}

test('a cited widget opens in place, and still has a way to itself', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { deskId, widgetId } = await seed(window)

  // Somewhere that is NOT the desk the widget lives on, so "did it navigate?"
  // has an unambiguous answer.
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goHome: () => void } } }
    w.__fbView?.getState().goHome()
  })
  await window.waitForTimeout(600)

  await window.evaluate((id) => {
    const s = (window as unknown as { __fbSourcePeek: { getState: () => Record<string, any> } })
      .__fbSourcePeek.getState()
    s.open({ kind: 'widget', widgetId: id }, 'Levy terms')
  }, widgetId)

  const peek = window.locator('[data-testid="source-peek"]')
  await expect(peek).toBeVisible({ timeout: 10_000 })

  // The real object, not a title card: the widget's own content is rendered.
  await expect(peek).toContainText('The quarterly levy is due on the 14th.', { timeout: 10_000 })
  await expect(peek).toContainText('Levy terms')

  // And we did NOT move: the desk is not open behind it.
  const movedEarly = await window.evaluate(
    (id) =>
      (window as unknown as { __fbView: { getState: () => { view: Record<string, any> } } })
        .__fbView.getState().view?.taskId === id,
    deskId
  )
  expect(movedEarly, 'opening a reference in place must not navigate').toBe(false)

  // Escape closes without going anywhere.
  await window.keyboard.press('Escape')
  await expect(peek).toHaveCount(0, { timeout: 5_000 })

  // Re-open, then take the way out: this one SHOULD navigate.
  await window.evaluate((id) => {
    const s = (window as unknown as { __fbSourcePeek: { getState: () => Record<string, any> } })
      .__fbSourcePeek.getState()
    s.open({ kind: 'widget', widgetId: id }, 'Levy terms')
  }, widgetId)
  await expect(peek).toBeVisible({ timeout: 10_000 })
  await window.locator('[data-testid="source-peek-go"]').click()

  await expect(peek).toHaveCount(0, { timeout: 5_000 })
  await window.waitForTimeout(900)
  const landed = await window.evaluate(
    (id) =>
      (window as unknown as { __fbView: { getState: () => { view: Record<string, any> } } })
        .__fbView.getState().view?.taskId === id,
    deskId
  )
  expect(landed, '"Open where it lives" should land on the desk the widget is on').toBe(true)
})
