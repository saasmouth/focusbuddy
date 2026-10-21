// DEC-144: Attention is Focus, the widget's "Focus mode" is "Full view", the Desks app is "All desks".
/**
 * Focus AI Chat visual/behavioral parity with the assistant (Phase 3b, from
 * the operator's live-drive: "focus mode still doesn't look like the AI chat
 * we just created").
 *
 * The focus chat keeps its OWN persisted store and non-streaming transport
 * (engine unification is the dedicated session) — this suite locks that it now
 * speaks the same design language and composer behavior as the panel.
 *
 * FP-1  The focus empty state is the assistant's home: the greeting, a
 *       composer with the model picker, and suggestion cards.
 * FP-2  Enter sends (Shift+Enter for a newline) — the panel's convention,
 *       replacing the ⌘⏎-only composer.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// The focus chat sends through the NON-streaming chat:send — stub that.
async function stubSend(app: ElectronApplication, reply: string): Promise<void> {
  await app.evaluate(({ ipcMain }, replyText: string) => {
    try {
      ipcMain.removeHandler('chat:sendStream')
    } catch {
      /* first install */
    }
    // Phase 4.5 unified the engines: the focus chat now sends through the SAME
    // streaming transport as the panel, so this is the handler to stub. That it
    // is the same one is itself part of the unification claim.
    ipcMain.handle(
      'chat:sendStream',
      async (e: Electron.IpcMainInvokeEvent, input: { requestId: string }) => {
        const channel = `chat:stream:${input.requestId}`
        const send = (type: string, payload: unknown): void => {
          if (!e.sender.isDestroyed()) e.sender.send(channel, { type, payload })
        }
        const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
        await wait(20)
        send('sources', { sources: [], elapsedMs: 5 })
        await wait(20)
        send('reply', replyText)
        await wait(20)
        send('complete', {
          ok: true,
          message: { role: 'assistant', content: replyText, ts: Date.now() }
        })
        return { ok: true }
      }
    )
  }, reply)
}

async function suppressFeatureSpotlights(window: Page): Promise<void> {
  await window.evaluate(() => {
    let p: { completed?: Record<string, number>; skipped?: Record<string, number> } = {}
    try {
      p = JSON.parse(localStorage.getItem('fb.onboarding.v2') ?? '{}')
    } catch {
      /* fresh */
    }
    p.skipped = { ...(p.skipped ?? {}), 'rooms-desks': 999, 'office-connect': 999 }
    localStorage.setItem('fb.onboarding.v2', JSON.stringify(p))
  })
}

async function openFocusChat(window: Page, widgetId: string): Promise<void> {
  const widgetEl = window.locator(`[data-widget-id="${widgetId}"]`).first()
  await widgetEl.hover()
  await widgetEl.locator('button[aria-label="Expand options"]').click({ force: true })
  await window.getByText('Full view', { exact: true }).click({ force: true })
  await expect(window.locator('[data-testid="widget-focus-mode"]')).toBeVisible({ timeout: 5000 })
  await window.locator('[data-testid="focus-dock-chrome-chat"]').click()
  await expect(window.locator('[data-testid="focus-chat-surface"]')).toBeVisible({ timeout: 5000 })
}

async function seedAndOpenFocusChat(window: Page): Promise<void> {
  const { aId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Parity desk' })
    const a = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'Widget A',
      content: 'ALPHA',
      x: 160,
      y: 160,
      width: 220,
      height: 180
    })
    return { aId: a.id }
  })
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: 'Parity desk' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8000 })
  await openFocusChat(window, aId)
}

test('FP-1 — the focus chat empty state speaks the assistant language: greeting, picker, cards', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedAndOpenFocusChat(window)

  const surface = window.locator('[data-testid="focus-chat-surface"]')
  // The same greeting the assistant home uses — not the old bare intro line.
  await expect(surface).toContainText('How can I help you today?')
  // The real model picker, same shared preference as the panel and Settings.
  await expect(surface.locator('[data-testid="composer-model-toggle"]')).toBeVisible()
  // Suggestion cards in the shared card style.
  const cards = surface.locator('[data-testid="focus-chat-suggestion"]')
  expect(await cards.count()).toBeGreaterThan(0)
})

test('FP-2 — Enter sends in the focus composer, matching the panel convention', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await seedAndOpenFocusChat(window)
  await stubSend(app, 'Parity reply.')

  const input = window.locator('[data-testid="focus-chat-input"]')
  await input.fill('hello from focus')
  await input.press('Enter')
  await expect(window.getByText('Parity reply.')).toBeVisible({ timeout: 8000 })
})
