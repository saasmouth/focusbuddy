import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Typing `@` offers what is nearby; picking one writes a link that survives a
// reload and goes where it says.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('typing @ in a sticky offers desks and inserts a working link', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const target = await api.nodes.create({ parentId: null, kind: 'task', title: 'Ridgeway Campaign' })
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Notes desk' })
    const w = await api.widgets.create({
      taskId: desk.id, kind: 'sticky' as never, title: '',
      content: '', x: 140, y: 140, width: 300, height: 220
    })
    return { deskId: desk.id, targetId: target.id, widgetId: w.id }
  })

  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, ids.deskId)

  const sticky = window.locator('[data-widget-kind="sticky"]').first()
  await expect(sticky).toBeVisible({ timeout: 10_000 })

  const box = sticky.locator('textarea').first()
  await box.click()
  await box.type('see @ridge')

  const picker = window.locator('[data-testid="mention-picker"]')
  await expect(picker).toBeVisible({ timeout: 5000 })
  await expect(picker).toContainText('Ridgeway Campaign')

  await picker.getByText('Ridgeway Campaign').click()

  // The textarea now holds a real token.
  await expect(box).toHaveValue(new RegExp(`plexii://desk/${ids.targetId}`))

  // Save it and confirm it renders as a chip rather than raw markup.
  await window.evaluate(async (v) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    await api.widgets.update(v.widgetId, { content: v.content })
  }, { widgetId: ids.widgetId, content: `see @[Ridgeway Campaign](plexii://desk/${ids.targetId}) ` })

  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, ids.deskId)

  const chip = window.locator('.mention-chip').first()
  await expect(chip).toBeVisible({ timeout: 10_000 })
  await expect(chip).toContainText('Ridgeway Campaign')
  // The raw token must not be showing in the note's body.
  await expect(window.locator('[data-fb-sticky-body]').first()).not.toContainText('plexii://')
  await expect(window.locator('[data-fb-sticky-body]').first()).toContainText('see Ridgeway Campaign')

  // Clicking it navigates to the desk it names.
  await chip.click()
  await window.waitForTimeout(600)
  const now = await window.evaluate(() => {
    const w = window as unknown as {
      __fbView?: { getState: () => { view: { kind: string; taskId?: string } } }
    }
    return w.__fbView?.getState().view
  })
  expect(now?.kind).toBe('task')
  expect(now?.taskId).toBe(ids.targetId)
})

test('an @ inside an email address does not open the picker', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Notes' })
    await api.widgets.create({
      taskId: desk.id, kind: 'sticky' as never, title: '',
      content: '', x: 140, y: 140, width: 300, height: 220
    })
    return desk.id
  })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)

  const box = window.locator('[data-widget-kind="sticky"] textarea').first()
  await box.click()
  await box.type('mail sarah@exa')
  await expect(window.locator('[data-testid="mention-picker"]')).toHaveCount(0)
})
