// DEC-144: Attention is Focus, the widget's "Focus mode" is "Full view", the Desks app is "All desks".
/**
 * ONE conversation system (Phase 4.5).
 *
 * Phase 3a.3 shipped a one-way bridge: the focus AI Chat could COPY the desk
 * panel's thread into a new persisted conversation, because the two surfaces
 * ran on two different engines and copying was the only honest thing available.
 * Unification removed both the second engine and the bridge — so this suite,
 * which locked the copy, now locks the thing that made the copy unnecessary.
 *
 * Only `chat:sendStream` is stubbed; the panel, the focus dock, the unified
 * store and the persisted aiChat storage are all shipping code.
 *
 * FC-1  A conversation started in the panel IS the conversation the focus chat
 *       shows — same turns, no import, nothing copied. It persists as ONE
 *       conversation, not two.
 * FC-2  It survives a reload with the turns intact — the panel's conversations
 *       are durable now, which they never were before unification.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { clickWidgetTool, launchApp, type LaunchedApp, typeInComposer, waitForReady } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function stubStream(app: ElectronApplication, reply: string): Promise<void> {
  await app.evaluate(({ ipcMain }, replyText: string) => {
    try {
      ipcMain.removeHandler('chat:sendStream')
    } catch {
      /* first install */
    }
    ipcMain.handle(
      'chat:sendStream',
      async (e: Electron.IpcMainInvokeEvent, input: { requestId: string }) => {
        const channel = `chat:stream:${input.requestId}`
        const send = (type: string, payload: unknown): void => {
          if (!e.sender.isDestroyed()) e.sender.send(channel, { type, payload })
        }
        const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
        await wait(20)
        send('sources', { sources: [], elapsedMs: 10 })
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

async function enterFocusMode(window: Page, widgetId: string): Promise<void> {
  const widgetEl = window.locator(`[data-widget-id="${widgetId}"]`).first()
  await widgetEl.hover()
  // Expand folds into the header's "…" menu on a narrow widget
  // (lib/widgetHeaderActions); clickWidgetTool presses it wherever it is.
  await clickWidgetTool(window, widgetId, 'Expand options')
  await window.getByText('Full view', { exact: true }).click({ force: true })
  await expect(window.locator('[data-testid="widget-focus-mode"]')).toBeVisible({ timeout: 5000 })
}

async function openFocusChatTab(window: Page): Promise<void> {
  await window.locator('[data-testid="focus-dock-chrome-chat"]').click()
  await expect(window.locator('[data-testid="focus-chat-surface"]')).toBeVisible({ timeout: 5000 })
}

test('FC-1 — the panel and the focus chat are the SAME conversation, not a copy', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)

  const { aId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Continuity desk'
    })
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
  await window.getByRole('button', { name: 'Continuity desk' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8000 })

  // Have a real exchange in the desk panel (far end stubbed, renderer real).
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:open-assistant')))
  await expect(window.locator('[data-testid="assistant-panel"]')).toBeVisible({ timeout: 8000 })
  await stubStream(app, 'The desk answer.')
  // A question, not a bare phrase: since 961e3436 (the instant-web ruling) a
  // short bare phrase on a fresh conversation searches the web in Auto mode
  // and never reaches the chat. No diversion offered = a chat turn.
  await typeInComposer(window, 'What is the desk question?')
  await expect(window.locator('[data-testid="composer-intent-row"]')).toHaveCount(0)
  await window.locator('button[aria-label="Send"]').click()
  await expect(window.getByText('The desk answer.')).toBeVisible({ timeout: 8000 })

  // Into focus mode: the SAME conversation is already there. No offer to
  // import, because there is nothing to import across — the bridge and the
  // second engine are both gone.
  await enterFocusMode(window, aId)
  await openFocusChatTab(window)
  const thread = window.locator('[data-testid="focus-chat-thread"]')
  await expect(thread).toContainText('What is the desk question?', { timeout: 8000 })
  await expect(thread).toContainText('The desk answer.')
  await expect(window.locator('[data-testid="focus-chat-continue-desk"]')).toHaveCount(0)
  // And nothing was announced as imported, because nothing was.
  await expect(thread).not.toContainText('Imported from your desk conversation')

  // ONE persisted conversation, not the two a copy would have left behind.
  const persisted = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const list = await api.aiChat.listConversations()
    return { count: list.length, title: list[0]?.title ?? '' }
  })
  expect(persisted.count).toBe(1)
  expect(persisted.title).toContain('What is the desk question?')
  expect(persisted.title).not.toContain('Imported')
})

test('FC-2 — a panel conversation survives a reload, which it never did before', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await suppressFeatureSpotlights(window)

  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:open-assistant')))
  await expect(window.locator('[data-testid="assistant-panel"]')).toBeVisible({ timeout: 8000 })
  await stubStream(app, 'A durable answer.')
  // A question, not a bare phrase: since 961e3436 (the instant-web ruling) a
  // short bare phrase on a fresh conversation searches the web in Auto mode
  // and never reaches the chat. No diversion offered = a chat turn.
  await typeInComposer(window, 'What is a durable question?')
  await expect(window.locator('[data-testid="composer-intent-row"]')).toHaveCount(0)
  await window.locator('button[aria-label="Send"]').click()
  await expect(window.getByText('A durable answer.')).toBeVisible({ timeout: 8000 })

  // Before unification the panel's threads were in-memory and died here.
  await window.reload()
  await waitForReady(window)
  const restored = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const list = await api.aiChat.listConversations()
    if (!list[0]) return null
    const conv = await api.aiChat.getConversation(list[0].id)
    return conv?.messages.map((m) => `${m.role}:${m.content}`) ?? null
  })
  expect(restored).not.toBeNull()
  expect(restored).toContain('user:What is a durable question?')
  expect(restored).toContain('assistant:A durable answer.')
})
