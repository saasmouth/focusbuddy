import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp } from './_helpers'

// Right-click "Create + connect" — the menu we wired into Sticky / Note /
// Markdown / Page / Field. Picking a kind from the menu must:
//   1. Spawn a new widget of that kind on the canvas
//   2. Persist a widget_link from the source → new widget
//   3. Both must be present in the DB on next list (round-trip via IPC)
//
// This test exercises the Sticky path. The other surfaces share the
// same helper (createConnectedTool), so green here means the contract
// is solid; per-surface UI tweaks can be added incrementally.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('right-click on a sticky → Create + Connect → new tool and persisted link', async () => {
  launched = await launchApp()
  const { window } = launched

  // Wait for app boot. We can't gate on the "PlexiDesk" heading
  // because the launch sign-in modal also shows one and strict mode
  // trips. Wait for window.api to be exposed by the preload bridge —
  // that's the readiness signal we actually need.
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  // Dismiss the launch sign-in modal if it's open. The test only needs
  // the canvas, not a signed-in account.
  const skipBtn = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click().catch(() => {})
  }

  // Seed: a task to activate the canvas + a sticky widget to right-click on.
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Right-click test'
    })
    const sticky = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: '',
      content: 'source sticky',
      x: 200,
      y: 200,
      width: 240,
      height: 200
    })
    return { taskId: task.id, stickyId: sticky.id }
  })

  await window.reload()
  // Same readiness check after reload.
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skipBtn2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skipBtn2.isVisible().catch(() => false)) {
    await skipBtn2.click().catch(() => {})
  }
  // Activate the task so the canvas mounts.
  await window.getByRole('button', { name: 'Right-click test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })

  // Enter edit mode (the sticky's context menu lives on the textarea), then
  // right-click it to open the unified menu.
  const sourceFrame = window.locator(`[data-widget-id="${seeded.stickyId}"]`)
  await expect(sourceFrame).toBeVisible({ timeout: 5_000 })
  await sourceFrame.locator('.fb-sticky-rendered').click()
  const textarea = sourceFrame.locator('textarea').first()
  await expect(textarea).toBeVisible({ timeout: 4_000 })
  await textarea.click({ button: 'right' })

  // The unified menu nests the spawn offerings under Create. Hover it, then
  // click "Note" (a different kind from the source so the spawn is verifiable).
  await window.locator('[data-canvas-ctx-menu]').getByText('Create', { exact: true }).hover()
  const noteItem = window.locator('[data-canvas-ctx-menu]').getByText('Note', { exact: true }).first()
  await expect(noteItem).toBeVisible({ timeout: 4_000 })
  await noteItem.click()

  // Give the IPC round-trip + store update a moment.
  await window.waitForTimeout(500)

  // Verify via IPC: there should now be exactly one note widget on the
  // task, and one widget_link from the source sticky to the new note.
  const verified = await window.evaluate(async ({ taskId, stickyId }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const widgets = await api.widgets.listByTask(taskId)
    const notes = widgets.filter((w) => w.kind === 'note')
    const links = await api.widgetLinks.listByTask(taskId)
    const linksFromSource = links.filter((l) => l.sourceWidgetId === stickyId)
    return {
      notesCount: notes.length,
      noteId: notes[0]?.id ?? null,
      linksFromSourceCount: linksFromSource.length,
      linkTargetId: linksFromSource[0]?.targetWidgetId ?? null
    }
  }, seeded)

  expect(verified.notesCount).toBe(1)
  expect(verified.linksFromSourceCount).toBe(1)
  expect(verified.linkTargetId).toBe(verified.noteId)
})
