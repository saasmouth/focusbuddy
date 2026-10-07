import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Coverage for the shared plexi/Modal.tsx wrapper migration (commit f7de78d):
// NewNodeDialog, MakeTaskDialog, AISetupDialog, UpgradePromptModal, TrialBadge's
// tier picker, ShareDialog, ComposeDialog, MeetingLaunchDialog, SettingsPanel and
// MeetingOverlay all either adopted <Modal> or gained dialog semantics in place.
// This spec exercises everything reachable without a signed-in account /
// live mail / meeting room, and notes explicitly where a claim rests on code
// trace instead of a live run.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ── 1. NewNodeDialog — dialog semantics + Escape (no shared Modal wrapper;
//    it gained role/aria-modal/Escape in place, per the diff) ───────────────
test('NewNodeDialog: role=dialog + aria-modal, fields render, Escape closes, focus lands sanely', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const projAddBtn = window.getByTitle('New top-level project').first()
  await expect(projAddBtn).toBeVisible({ timeout: 5_000 })
  await projAddBtn.click()

  const dialog = window.locator('[role="dialog"][aria-modal="true"]').filter({
    has: window.locator('[data-testid="newnode-name"]')
  })
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog).toHaveAttribute('aria-label', /new project/i)

  // Fields still render.
  await expect(dialog.locator('[data-testid="newnode-name"]')).toBeVisible()
  await expect(dialog.getByPlaceholder(/e\.g\. client|marketing/i)).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^Create$/i })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^Cancel$/i })).toBeVisible()

  // Escape closes it.
  await window.locator('[data-testid="newnode-name"]').press('Escape')
  await expect(dialog).toBeHidden({ timeout: 5_000 })

  // Focus lands somewhere sane — NewNodeDialog was NOT wrapped in the shared
  // Modal (only gained role/aria/Escape in place per the diff), so it has no
  // restore-to-opener effect. Assert focus didn't get stranded on a removed
  // node: it must be a live element still attached to the document.
  const activeIsLive = await window.evaluate(() => document.body.contains(document.activeElement))
  expect(activeIsLive).toBe(true)

  // Also close via its own Cancel button (not just Escape) to prove the
  // migration didn't break the primary dismiss path either.
  await projAddBtn.click()
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.getByRole('button', { name: /^Cancel$/i }).click()
  await expect(dialog).toBeHidden({ timeout: 5_000 })
})

// ── 2. MakeTaskDialog (shared Modal, reachable via widget right-click,
//    no sign-in needed) — dialog semantics, Tab trap, Escape, fields, close
//    button ─────────────────────────────────────────────────────────────────
async function seedStickyAndOpen(l: LaunchedApp): Promise<{ taskId: string; widgetId: string }> {
  const { window } = l
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    // Seed a folder too so MakeTaskDialog's folder picker defaults to the
    // "search existing folders" view rather than the "create new folder" view
    // (its default order is: prop parent -> active task's folder parent ->
    // first existing folder -> create-new).
    await api.nodes.create({ parentId: null, kind: 'folder', title: 'Modal a11y folder' })
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Modal a11y test' })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'original',
      content: 'v1',
      x: 240,
      y: 180,
      width: 240,
      height: 180
    })
    return { taskId: task.id, widgetId: w.id }
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Modal a11y test/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.widgetId}"]`, { timeout: 5_000 })
  await window.waitForTimeout(250)
  return seeded
}

async function openMakeTaskDialog(l: LaunchedApp, widgetId: string): Promise<void> {
  const { window } = l
  await window.locator(`[data-widget-id="${widgetId}"] .widget-handle`).click({ button: 'right' })
  await window.waitForTimeout(250)
  // "Make this a task..." lives under the "Advanced" submenu (buildAdvanced()
  // pushes it into MenuSection.Advanced). Open that submenu first.
  const advancedOpened = await window.evaluate(() => {
    const menu = document.querySelector('[data-canvas-ctx-menu]')
    if (!menu) return false
    const btn = Array.from(menu.querySelectorAll('button[role="menuitem"]')).find((b) =>
      (b.textContent ?? '').includes('Advanced')
    )
    if (!btn) return false
    ;(btn as HTMLButtonElement).click()
    return true
  })
  expect(advancedOpened, 'context menu must expose "Advanced"').toBe(true)
  await window.waitForTimeout(250)
  const clicked = await window.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('[data-canvas-ctx-menu] button[role="menuitem"]')).find((b) =>
      (b.textContent ?? '').includes('Make this a task')
    )
    if (!btn) return false
    ;(btn as HTMLButtonElement).click()
    return true
  })
  expect(clicked, 'Advanced submenu must expose "Make this a task..."').toBe(true)
  await window.waitForTimeout(300)
}

test('MakeTaskDialog: dialog semantics, Tab trap, fields intact, Escape + Cancel both close', async () => {
  launched = await launchApp()
  const { window } = launched
  const { widgetId } = await seedStickyAndOpen(launched)

  await openMakeTaskDialog(launched, widgetId)

  const dialog = window.locator('[role="dialog"][aria-label="Make this a task"]')
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog).toHaveAttribute('aria-modal', 'true')

  // Original fields survived the wrap.
  await expect(dialog.getByPlaceholder('What is the task?')).toBeVisible()
  await expect(dialog.getByPlaceholder(/Search folders/i)).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^Cancel$/i })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^Create task$/i })).toBeVisible()

  // Tab several times — focus must stay inside the panel (focus trap).
  for (let i = 0; i < 12; i++) {
    await window.keyboard.press('Tab')
    const insideDialog = await window.evaluate(() => {
      const panel = document.querySelector('[role="dialog"][aria-label="Make this a task"]')
      return !!panel && panel.contains(document.activeElement)
    })
    expect(insideDialog, `focus escaped the panel after ${i + 1} Tab presses`).toBe(true)
  }

  // Shift+Tab from the first element wraps to the last (reverse trap).
  await window.keyboard.press('Shift+Tab')
  const stillInside = await window.evaluate(() => {
    const panel = document.querySelector('[role="dialog"][aria-label="Make this a task"]')
    return !!panel && panel.contains(document.activeElement)
  })
  expect(stillInside).toBe(true)

  // Escape closes it.
  await window.keyboard.press('Escape')
  await expect(dialog).toBeHidden({ timeout: 5_000 })

  // Focus was NOT stranded on a removed node (the opener — a context-menu
  // button — unmounts itself before Modal's restore effect runs, since the
  // menu closes on selection; so we cannot assert strict "return to the
  // exact opener" here, only that focus landed on a live element).
  const activeIsLive = await window.evaluate(() => document.body.contains(document.activeElement))
  expect(activeIsLive).toBe(true)

  // Reopen and close via its own Cancel button, not only Escape.
  await openMakeTaskDialog(launched, widgetId)
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.getByRole('button', { name: /^Cancel$/i }).click()
  await expect(dialog).toBeHidden({ timeout: 5_000 })
})

// ── 3. UpgradePromptModal (shared Modal) — reachable signed-out via the
//    "AI task setup is a Pro feature" gate inside NewNodeDialog. Also proves
//    strict focus-restore-to-opener since the opener button stays mounted
//    (NewNodeDialog remains open underneath the upgrade modal). ─────────────
test('UpgradePromptModal: dialog semantics, Escape closes, focus restores to the exact opener', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.nodes.create({ parentId: null, kind: 'folder', title: 'Upgrade Modal Desk' })
  })
  await window.reload()
  await waitForReady(window)

  const row = window.getByText('Upgrade Modal Desk', { exact: true }).first()
  await expect(row).toBeVisible({ timeout: 8_000 })
  await row.hover()
  await window.getByRole('button', { name: 'Add task' }).first().click()

  const newTaskDialog = window.locator('[role="dialog"][aria-modal="true"]').filter({
    has: window.locator('[data-testid="newnode-name"]')
  })
  await expect(newTaskDialog).toBeVisible({ timeout: 5_000 })

  const opener = newTaskDialog.locator('[data-testid="ai-setup-locked"]')
  await expect(opener).toBeVisible({ timeout: 5_000 })
  await opener.focus()
  await opener.click()

  const upgradeDialog = window.locator('[data-testid="upgrade-prompt-modal"]')
  await expect(upgradeDialog).toBeVisible({ timeout: 5_000 })
  await expect(upgradeDialog).toHaveAttribute('role', 'dialog')
  await expect(upgradeDialog).toHaveAttribute('aria-modal', 'true')
  await expect(upgradeDialog).toHaveAttribute('aria-label', /Pro feature/i)

  // Original content survived the wrap.
  await expect(upgradeDialog.locator('[data-testid="upgrade-reason"]')).toHaveText(
    'AI task setup is a Pro feature.'
  )
  await expect(upgradeDialog.locator('[data-testid="upgrade-later"]')).toBeVisible()
  await expect(upgradeDialog.locator('[data-testid="upgrade-start-checkout"]')).toBeVisible()

  await window.keyboard.press('Escape')
  await expect(upgradeDialog).toBeHidden({ timeout: 5_000 })

  // The opener button is still mounted (NewNodeDialog stayed open underneath)
  // so this is a strict check: focus must have returned to it exactly.
  const restoredToOpener = await window.evaluate(() => {
    const el = document.querySelector('[data-testid="ai-setup-locked"]')
    return !!el && el === document.activeElement
  })
  expect(restoredToOpener, 'focus must restore to the exact opener element').toBe(true)

  // Reopen and close via the modal's own "Maybe later" button, not only Escape.
  await opener.click()
  await expect(upgradeDialog).toBeVisible({ timeout: 5_000 })
  await upgradeDialog.locator('[data-testid="upgrade-later"]').click()
  await expect(upgradeDialog).toBeHidden({ timeout: 5_000 })
})

// ── 4. Code-trace-only surfaces: ShareDialog, ComposeDialog, AISetupDialog,
//    MeetingLaunchDialog, TrialBadge tier picker, MeetingOverlay, SettingsPanel.
//    These require a signed-in account, a live mailbox, an active trial, or a
//    joined meeting room, none of which the isolated e2e harness provisions.
//    Verified instead by reading the committed diff (see report) that each
//    renders its full original inner markup unchanged inside <Modal>, with
//    the same data-testid values preserved (share-dialog content, compose
//    fields, ai-setup content, meeting-launch-dialog, tier-picker-modal). ──
test.skip('code-trace only: ShareDialog / ComposeDialog / AISetupDialog / MeetingLaunchDialog / TrialBadge tier picker require a live account, mailbox, trial or meeting room — see report for the diff-based verification', () => {})
