import { test, expect } from '@playwright/test'
import { launchApp, waitForReady } from './_helpers'

// Verifies the rename regression fix restored after the Rooms/Desks
// restructure: desk-header inline rename, Rooms-index rename, Desks-index
// rename, and (no-regression check) widget-title rename.

test('desk header title is inline-editable and the rename persists across navigation', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const desk = (await window.evaluate(
      () => window.api.nodes.create({ parentId: null, kind: 'task', title: 'Original Desk Name' }),
      undefined
    )) as { id: string }

    await window.reload()
    await waitForReady(window)
    await window.getByRole('button', { name: /Original Desk Name/ }).first().click()
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

    // The header title and its pencil became the desk context menu's Rename row
    // in 4148318a (the trail, presence and desk actions are one menu now); the
    // trigger names the desk, and the rename is still in place.
    const title = window.locator('[data-testid="desk-context-trigger"]')
    await expect(title).toContainText('Original Desk Name')

    const renameTo = async (name: string): Promise<void> => {
      await title.click()
      await window.locator('[data-testid="desk-context-rename"]').click()
      const input = window.locator('[data-testid="desk-context-rename-input"]')
      await expect(input).toBeVisible()
      await expect(input).toHaveValue(await window.evaluate((id: string) => window.api.nodes.get(id).then((n) => n?.title ?? ''), desk.id))
      await input.fill(name)
      await input.press('Enter')
      await expect(title).toContainText(name)
      await window.keyboard.press('Escape')
      await expect(window.locator('[data-testid="desk-context-menu"]')).toHaveCount(0)
    }
    await renameTo('Renamed Via Header')
    // A second rename from the renamed state (the old pencil path).
    await renameTo('Renamed Via Pencil')

    // Navigate away (to the Desks index) and back via a fresh reload — the
    // rename must persist both in the store and in the underlying record.
    await window.getByRole('button', { name: 'Rooms', exact: true }).click()
    await expect(window.locator('[data-testid="rooms-index-view"]')).toBeVisible({ timeout: 8_000 })
    await window.getByRole('button', { name: 'All desks', exact: true }).click()
    await expect(window.locator('[data-testid="desks-index-view"]')).toBeVisible({ timeout: 8_000 })
    await expect(window.locator(`[data-testid="index-card-${desk.id}"]`).getByText('Renamed Via Pencil')).toBeVisible()

    await window.reload()
    await waitForReady(window)
    await expect(window.locator('[data-testid="desks-index-view"]')).toBeVisible({ timeout: 8_000 })
    await window.locator(`[data-testid="index-card-${desk.id}"]`).getByRole('button').first().click()
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
    await expect(window.locator('[data-testid="desk-context-trigger"]')).toContainText('Renamed Via Pencil')

    // Confirm the DB-level record actually changed, not just local UI state.
    const persisted = (await window.evaluate(
      (id: string) => window.api.nodes.get(id),
      desk.id
    )) as { title: string } | null
    expect(persisted?.title).toBe('Renamed Via Pencil')
  } finally {
    await dispose()
  }
})

test('Rooms index: the Rename room pencil opens a prompt and updates the title', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const room = (await window.evaluate(
      () => window.api.nodes.create({ parentId: null, kind: 'folder', title: 'Original Room Name' }),
      undefined
    )) as { id: string }

    await window.reload()
    await waitForReady(window)
    await window.getByRole('button', { name: 'Rooms', exact: true }).click()
    await expect(window.locator('[data-testid="rooms-index-view"]')).toBeVisible({ timeout: 8_000 })

    const card = window.locator(`[data-testid="index-card-${room.id}"]`)
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: 'Rename room' }).click()

    const dialog = window.locator('[data-testid="prompt-dialog"]')
    await expect(dialog).toBeVisible()
    const promptInput = window.locator('[data-testid="prompt-dialog-input"]')
    await expect(promptInput).toHaveValue('Original Room Name')
    await promptInput.fill('Renamed Room')
    await window.locator('[data-testid="prompt-dialog-confirm"]').click()
    await expect(dialog).toHaveCount(0)

    await expect(card.getByText('Renamed Room')).toBeVisible()

    const persisted = (await window.evaluate(
      (id: string) => window.api.nodes.get(id),
      room.id
    )) as { title: string } | null
    expect(persisted?.title).toBe('Renamed Room')
  } finally {
    await dispose()
  }
})

test('Desks index: the Rename desk pencil opens a prompt and updates the title', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const desk = (await window.evaluate(
      () => window.api.nodes.create({ parentId: null, kind: 'task', title: 'Original Desk From Index' }),
      undefined
    )) as { id: string }

    await window.reload()
    await waitForReady(window)
    await window.getByRole('button', { name: 'Rooms', exact: true }).click()
    await expect(window.locator('[data-testid="rooms-index-view"]')).toBeVisible({ timeout: 8_000 })
    await window.getByRole('button', { name: 'All desks', exact: true }).click()
    await expect(window.locator('[data-testid="desks-index-view"]')).toBeVisible({ timeout: 8_000 })

    const card = window.locator(`[data-testid="index-card-${desk.id}"]`)
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: 'Rename desk' }).click()

    const dialog = window.locator('[data-testid="prompt-dialog"]')
    await expect(dialog).toBeVisible()
    const promptInput = window.locator('[data-testid="prompt-dialog-input"]')
    await expect(promptInput).toHaveValue('Original Desk From Index')
    await promptInput.fill('Renamed Desk From Index')
    await window.locator('[data-testid="prompt-dialog-confirm"]').click()
    await expect(dialog).toHaveCount(0)

    await expect(card.getByText('Renamed Desk From Index')).toBeVisible()

    const persisted = (await window.evaluate(
      (id: string) => window.api.nodes.get(id),
      desk.id
    )) as { title: string } | null
    expect(persisted?.title).toBe('Renamed Desk From Index')
  } finally {
    await dispose()
  }
})

test('regression check: a widget title can still be renamed via double-click and pencil', async () => {
  const { window, dispose } = await launchApp()
  try {
    await waitForReady(window)

    const ids = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Widget Rename Regression' })
      const s = await api.widgets.create({
        taskId: task.id,
        kind: 'sticky',
        title: '',
        content: 'First line here',
        x: 140,
        y: 140,
        width: 220,
        height: 160
      })
      return { taskId: task.id, widgetId: s.id }
    })

    await window.reload()
    await waitForReady(window)
    await window.getByRole('button', { name: /Widget Rename Regression/ }).first().click()
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

    const label = window.locator(`[data-testid="widget-title-${ids.widgetId}"]`)
    await expect(label).toHaveText('First line here')

    await label.dblclick()
    const input = window.locator('input[aria-label="Work widget name"]')
    await expect(input).toBeVisible()
    await input.fill('Renamed Widget')
    await input.press('Enter')
    await expect(label).toHaveText('Renamed Widget')
  } finally {
    await dispose()
  }
})
