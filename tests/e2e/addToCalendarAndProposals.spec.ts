/**
 * Tester-authored E2E for two changes on Plexi3.0:
 *
 * 1. "Add to calendar" for received meeting invites (WeekTimeGrid.tsx +
 *    calendar:addMeetingIcs IPC + src/shared/ics.ts).
 * 2. Workspace brain "offer to create anything" — WorkspaceAsk.tsx renders
 *    approvable proposal cards from the workspace:askStream `proposals` field.
 *
 * Both real IPC handlers that shell out (calendar:addMeetingIcs opens an .ics
 * with the OS default app; files:openExternal opens a browser) are stubbed at
 * the ipcMain level so the test stays hermetic and doesn't pop OS UI.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, gotoView, type LaunchedApp, switchArea } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

/** Stub the two IPC handlers that shell out, so clicking the menu items in the
 * test doesn't pop OS Calendar / a browser. Records what was called so the
 * test can assert the handler wiring without observing OS side effects. */
async function stubCalendarHandlers(app: LaunchedApp['app']): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('calendar:addMeetingIcs')
    ipcMain.handle('calendar:addMeetingIcs', async (_e, ev: unknown) => {
      ;(globalThis as unknown as { __lastIcsCall?: unknown }).__lastIcsCall = ev
      return { ok: true }
    })
    ipcMain.removeHandler('files:openExternal')
    ipcMain.handle('files:openExternal', async (_e, url: string) => {
      ;(globalThis as unknown as { __lastOpenExternal?: string }).__lastOpenExternal = url
      return { ok: true }
    })
  })
}

async function stubWorkspaceAskWithProposals(app: LaunchedApp['app']): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('workspace:askStream')
    ipcMain.handle(
      'workspace:askStream',
      async (e, _q: string, _h: unknown, requestId: string) => {
        const answer = 'Your Q3 launch plan has three open action items.'
        e.sender.send(`workspace:askStream:${requestId}`, { type: 'delta', payload: answer })
        return {
          ok: true,
          answer,
          citedDocIds: [],
          sources: [],
          proposals: [
            {
              id: 'prop-task-1',
              kind: 'create-task',
              title: 'Follow up on Q3 launch blockers',
              notes: 'Derived from workspace ask answer',
              reason: 'You mentioned three open action items'
            }
          ]
        }
      }
    )
  })
}

async function stubWorkspaceAskEmpty(app: LaunchedApp['app']): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('workspace:askStream')
    ipcMain.handle(
      'workspace:askStream',
      async (e, _q: string, _h: unknown, requestId: string) => {
        const answer = 'Nothing concrete to propose here.'
        e.sender.send(`workspace:askStream:${requestId}`, { type: 'delta', payload: answer })
        return { ok: true, answer, citedDocIds: [], sources: [], proposals: [] }
      }
    )
  })
}

async function openOfficeDoc(window: Page): Promise<void> {
  await switchArea(window, 'office')
  await expect(window.locator('[data-testid="office-sidebar"]')).toBeVisible({ timeout: 8_000 })
  await window.locator('[data-testid="office-app-docs"]').click()
  await expect(window.locator('[data-testid="doc-editor-surface"]')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-testid="doc-side-panel"]')).toBeVisible({ timeout: 8_000 })
}

// ─── Change 1: Add to calendar ───────────────────────────────────────────────

test('ATC-1 — a meeting block shows an add-to-calendar button that opens a two-option menu', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await stubCalendarHandlers(app)

  await gotoView(window, 'goCalendar')
  await window.locator('[data-testid="calendar-mode-week"]').click()
  await expect(window.locator('[data-testid="week-time-grid"]')).toBeVisible({ timeout: 6000 })

  // Open the composer and create a meeting block.
  await window.locator('[data-testid="day-col-2"]').click({ position: { x: 20, y: 180 } })
  await expect(window.locator('[data-testid="block-composer"]')).toBeVisible({ timeout: 4000 })
  await window.locator('[data-testid="composer-meeting-toggle"]').check()
  await expect(window.locator('[data-testid="composer-invitees"]')).toBeVisible({ timeout: 2000 })
  await window.locator('[data-testid="composer-create"]').click()
  await expect(window.locator('[data-testid="time-block"]')).toHaveCount(1, { timeout: 4000 })

  const block = window.locator('[data-testid="time-block"]')
  await block.hover()

  // Both hover buttons render on a meeting block.
  await expect(block.locator('[data-testid="block-join-meeting"]')).toBeVisible({ timeout: 2000 })
  const addToCal = block.locator('[data-testid="block-add-to-calendar"]')
  await expect(addToCal).toBeVisible({ timeout: 2000 })

  // Click it — the popover with both options appears.
  await addToCal.click()
  const menu = window.locator('[data-testid="add-to-calendar-menu"]')
  await expect(menu).toBeVisible({ timeout: 2000 })
  await expect(menu).toContainText('Apple Calendar / Outlook')
  await expect(menu).toContainText('Google Calendar')

  // Apple/Outlook option calls the ics IPC with the meeting's room id.
  await menu.getByText('Apple Calendar / Outlook').click()
  await window.waitForTimeout(200)
  const icsCall = await app.evaluate(
    () => (globalThis as unknown as { __lastIcsCall?: { roomId?: string; title?: string } }).__lastIcsCall
  )
  expect(icsCall).toBeTruthy()
  expect(icsCall?.roomId).toBeTruthy()

  // Menu closes after the click.
  await expect(menu).not.toBeVisible({ timeout: 2000 })
})

test('ATC-2 — Google Calendar option opens a calendar.google.com TEMPLATE url via files.openExternal', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await stubCalendarHandlers(app)

  await gotoView(window, 'goCalendar')
  await window.locator('[data-testid="calendar-mode-week"]').click()
  await expect(window.locator('[data-testid="week-time-grid"]')).toBeVisible({ timeout: 6000 })

  await window.locator('[data-testid="day-col-3"]').click({ position: { x: 20, y: 220 } })
  await expect(window.locator('[data-testid="block-composer"]')).toBeVisible({ timeout: 4000 })
  await window.locator('[data-testid="composer-meeting-toggle"]').check()
  await window.locator('[data-testid="composer-create"]').click()
  await expect(window.locator('[data-testid="time-block"]')).toHaveCount(1, { timeout: 4000 })

  const block = window.locator('[data-testid="time-block"]')
  await block.hover()
  await block.locator('[data-testid="block-add-to-calendar"]').click()
  const menu = window.locator('[data-testid="add-to-calendar-menu"]')
  await expect(menu).toBeVisible({ timeout: 2000 })

  await menu.getByText('Google Calendar').click()
  await window.waitForTimeout(200)
  const url = await app.evaluate(
    () => (globalThis as unknown as { __lastOpenExternal?: string }).__lastOpenExternal
  )
  expect(url).toContain('calendar.google.com/calendar/render')
  expect(url).toContain('action=TEMPLATE')
})

test('ATC-3 — a non-meeting block has no add-to-calendar button', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await gotoView(window, 'goCalendar')
  await window.locator('[data-testid="calendar-mode-week"]').click()
  await expect(window.locator('[data-testid="week-time-grid"]')).toBeVisible({ timeout: 6000 })

  await window.locator('[data-testid="day-col-1"]').click({ position: { x: 20, y: 150 } })
  await expect(window.locator('[data-testid="block-composer"]')).toBeVisible({ timeout: 4000 })
  // Meeting toggle left OFF.
  await window.locator('[data-testid="composer-create"]').click()
  await expect(window.locator('[data-testid="time-block"]')).toHaveCount(1, { timeout: 4000 })

  const block = window.locator('[data-testid="time-block"]')
  await block.hover()
  await expect(block.locator('[data-testid="block-join-meeting"]')).toHaveCount(0)
  await expect(block.locator('[data-testid="block-add-to-calendar"]')).toHaveCount(0)
})

// ─── Change 2: Workspace brain proposal cards ────────────────────────────────

test('WAP-1 — workspace ask renders an approvable proposal card and Create applies it', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await stubWorkspaceAskWithProposals(app)
  await openOfficeDoc(window)

  await window.locator('[data-testid="doc-tab-ai"]').click()
  await expect(window.locator('[data-testid="workspace-ask"]')).toBeVisible()

  await window.locator('[data-testid="workspace-ask-input"]').fill('What should I do next on Q3 launch?')
  await window.locator('[data-testid="workspace-ask-go"]').click()

  const answer = window.locator('[data-testid="workspace-ask-answer"]')
  await expect(answer).toBeVisible({ timeout: 8000 })
  await expect(answer).toContainText('three open action items')

  const proposals = answer.locator('[data-testid="workspace-ask-proposals"]')
  await expect(proposals).toBeVisible({ timeout: 4000 })
  const card = proposals.locator('[data-testid="workspace-ask-proposal"]')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Follow up on Q3 launch blockers')

  // Consume any console errors emitted so far before the Create click.
  const applyBtn = card.locator('[data-testid="workspace-ask-proposal-apply"]')
  await expect(applyBtn).toBeVisible()
  await applyBtn.click()

  // The apply path creates a real task node via applyProposal → the card
  // flips to a "Created" state (no dismiss/apply buttons left).
  await expect(card).toContainText('Created', { timeout: 4000 })
  await expect(card.locator('[data-testid="workspace-ask-proposal-apply"]')).toHaveCount(0)

  // Confirm the task was actually created (no-fakery: verify the real side
  // effect, not just the UI label).
  const created = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const nodes = await api.nodes.list()
    return nodes.some((n) => n.kind === 'task' && n.title === 'Follow up on Q3 launch blockers')
  })
  expect(created).toBe(true)
})

test('WAP-2 — dismiss removes a proposal card without applying it', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await stubWorkspaceAskWithProposals(app)
  await openOfficeDoc(window)

  await window.locator('[data-testid="doc-tab-ai"]').click()
  await window.locator('[data-testid="workspace-ask-input"]').fill('What should I do next?')
  await window.locator('[data-testid="workspace-ask-go"]').click()

  const answer = window.locator('[data-testid="workspace-ask-answer"]')
  await expect(answer).toBeVisible({ timeout: 8000 })
  const card = answer.locator('[data-testid="workspace-ask-proposal"]')
  await expect(card).toBeVisible({ timeout: 4000 })

  await card.locator('[data-testid="workspace-ask-proposal-dismiss"]').click()
  await expect(answer.locator('[data-testid="workspace-ask-proposals"]')).toHaveCount(0)

  const created = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const nodes = await api.nodes.list()
    return nodes.some((n) => n.kind === 'task' && n.title === 'Follow up on Q3 launch blockers')
  })
  expect(created).toBe(false)
})

test('WAP-3 — no proposals (no-key / weak-suggestion path) renders the panel cleanly with no proposals block', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await stubWorkspaceAskEmpty(app)
  await openOfficeDoc(window)

  await window.locator('[data-testid="doc-tab-ai"]').click()
  await window.locator('[data-testid="workspace-ask-input"]').fill('Anything to propose?')
  await window.locator('[data-testid="workspace-ask-go"]').click()

  const answer = window.locator('[data-testid="workspace-ask-answer"]')
  await expect(answer).toBeVisible({ timeout: 8000 })
  await expect(answer).toContainText('Nothing concrete to propose here.')
  await expect(answer.locator('[data-testid="workspace-ask-proposals"]')).toHaveCount(0)
  // Panel itself is still intact and usable.
  await expect(window.locator('[data-testid="workspace-ask"]')).toBeVisible()
  await expect(window.locator('[data-testid="workspace-ask-input"]')).toBeEnabled()
})
