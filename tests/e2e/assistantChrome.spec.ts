// DEC-144: Attention is Focus, the widget's "Focus mode" is "Full view", the Desks app is "All desks".
/**
 * The assistant's Notion-mirror chrome: a pill on EVERY screen, opening into
 * Sidebar / Floating / Fullscreen over one conversation.
 *
 * AC-1  The pill exists on the desk shell AND on a segment takeover (Office) —
 *       the exact screens the old desk-PanelGroup assistant vanished from.
 * AC-2  Default mode is floating; the ⌄ menu switches modes; sidebar mode
 *       reserves content width; the conversation AND the half-typed composer
 *       draft survive every switch (one panel instance, re-dressed).
 * AC-3  Minimize collapses to the pill; reopening restores the last mode; the
 *       mode and open state survive a reload (localStorage).
 * AC-4  The fb:open-assistant window event still opens the assistant — the
 *       entry point every other surface and spec already uses.
 * AC-5  Focus mode suppresses the assistant entirely — no pill, no panel —
 *       because the AI Chat tab IS the assistant there; exiting restores the
 *       chrome exactly as it was (Phase 3a.2, P4).
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { composerText, launchApp, type LaunchedApp, typeInComposer, waitForReady } from './_helpers'

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// Minimal far-end stub (same philosophy as the trace/question suites): the
// real handler is replaced; everything renderer-side is shipping code.
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

const pill = (window: Page) => window.locator('[data-testid="assistant-pill"]')
const overlay = (window: Page) => window.locator('[data-testid="assistant-overlay"]')
const panel = (window: Page) => window.locator('[data-testid="assistant-panel"]')

async function openViaPill(window: Page): Promise<void> {
  await pill(window).click()
  // The assistant opens on the Today tab; the Chat panel (assistant-panel) is
  // mounted but hidden until the Chat tab is selected. Switch to Chat so tests
  // that assert on the conversation panel see it.
  await window.locator('[data-testid="assistant-tab-chat"]').click()
  await panel(window).waitFor({ state: 'visible', timeout: 8000 })
}

async function switchMode(window: Page, mode: 'sidebar' | 'floating' | 'fullscreen'): Promise<void> {
  await window.locator('[data-testid="assistant-mode-toggle"]').click()
  await window.locator(`[data-testid="assistant-mode-${mode}"]`).click()
  await expect(overlay(window)).toHaveAttribute('data-mode', mode)
}

test('AC-1 — the pill is on every screen, including a segment takeover', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Home (the desk shell): pill present, panel closed by default.
  await expect(pill(window)).toBeVisible({ timeout: 8000 })
  await expect(panel(window)).toHaveCount(0)

  // Office is a segment takeover that replaces the whole <main> — the screen
  // the old desk-panel assistant simply did not exist on.
  await window.getByRole('button', { name: /Office/ }).first().click()
  await expect(pill(window)).toBeVisible({ timeout: 8000 })

  // And it is not just present there — it works there.
  await openViaPill(window)
  await expect(overlay(window)).toBeVisible()

  // Back home, still present (now as the open panel).
  await window.getByRole('button', { name: /Home/ }).first().click()
  await expect(overlay(window)).toBeVisible({ timeout: 8000 })
})

test('AC-2 — modes switch over one conversation; draft and thread survive', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)

  await openViaPill(window)
  // Floating is the reference default.
  await expect(overlay(window)).toHaveAttribute('data-mode', 'floating')

  // Put a real turn in the thread through the real path.
  await stubStream(app, 'The answer you asked for.')
  await typeInComposer(window, 'a question')
  await window.locator('button[aria-label="Send"]').click()
  await expect(window.getByText('The answer you asked for.')).toBeVisible({ timeout: 8000 })

  // Leave a half-typed draft in the composer, then re-dress the panel. Phase
  // 4.3 made the composer a TipTap editor, so the draft lives in a document
  // rather than a value — the survival claim is unchanged, and is now read
  // through the editor's own text.
  await typeInComposer(window, 'half-typed thought')

  await switchMode(window, 'sidebar')
  // Sidebar mode reserves real content width on <main>.
  const padRight = await window.evaluate(
    () => getComputedStyle(document.querySelector('main')!).paddingRight
  )
  expect(padRight).toBe('400px')
  // Same conversation, same draft — nothing remounted.
  await expect(window.getByText('The answer you asked for.')).toBeVisible()
  expect(await composerText(window)).toBe('half-typed thought')

  await switchMode(window, 'fullscreen')
  await expect(window.getByText('The answer you asked for.')).toBeVisible()
  expect(await composerText(window)).toBe('half-typed thought')

  await switchMode(window, 'floating')
  expect(await composerText(window)).toBe('half-typed thought')
  // Floating reserves nothing.
  const padAfter = await window.evaluate(
    () => getComputedStyle(document.querySelector('main')!).paddingRight
  )
  expect(padAfter).toBe('0px')
})

test('AC-3 — minimize returns the pill; reopen and reload both restore the last mode', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await openViaPill(window)
  await switchMode(window, 'sidebar')

  // Minimize → pill, no overlay.
  await window.locator('[data-testid="assistant-minimize"]').click()
  await expect(overlay(window)).toHaveCount(0)
  await expect(pill(window)).toBeVisible()

  // Reopen → the mode you left, not the default.
  await openViaPill(window)
  await expect(overlay(window)).toHaveAttribute('data-mode', 'sidebar')

  // Reload with it open → comes back open, in sidebar, without a click.
  await window.reload()
  await waitForReady(window)
  await expect(overlay(window)).toHaveAttribute('data-mode', 'sidebar', { timeout: 8000 })
  await expect(panel(window)).toBeVisible()
})

test('AC-4 — fb:open-assistant still summons the assistant, into the Notion-shaped empty state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await expect(panel(window)).toHaveCount(0)
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:open-assistant')))
  // Opens on Today; select Chat to reach the conversation's empty state.
  await window.locator('[data-testid="assistant-tab-chat"]').click()
  await expect(panel(window)).toBeVisible({ timeout: 8000 })

  // Fresh thread → the mirror empty state: avatar block with the greeting,
  // per-screen suggestion rows, and the composer's context chip naming the
  // surface the conversation is scoped to.
  const empty = window.locator('[data-testid="assistant-empty-state"]')
  await expect(empty).toBeVisible()
  await expect(empty).toContainText('How can I help you today?')
  await expect(window.locator('[data-testid="chat-suggestion"]').first()).toBeVisible()
  await expect(window.locator('[data-testid="composer-context-chip"]')).toBeVisible()

  // A suggestion row fills the composer rather than sending — an offer, not a
  // command. The row's textContent also carries the icon's Material Symbols
  // ligature name, so assert containment of the real value instead of
  // equality against the raw row text.
  const row = window.locator('[data-testid="chat-suggestion"]').first()
  const rowText = (await row.textContent()) ?? ''
  await row.click()
  const composerValue = await composerText(window)
  expect(composerValue.length).toBeGreaterThan(0)
  expect(rowText).toContain(composerValue)
})

test('AC-5 — focus mode suppresses the assistant entirely; exit restores it as it was', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const { aId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'Focus suppress desk'
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
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: 'Focus suppress desk' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8000 })

  // Open the panel first, so suppression has real chrome state to preserve.
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:open-assistant')))
  // Select Chat so the conversation panel is shown (the assistant opens on Today);
  // the tab is chrome state, preserved across focus-mode suppress/restore.
  await window.locator('[data-testid="assistant-tab-chat"]').click()
  await expect(panel(window)).toBeVisible({ timeout: 8000 })

  // Enter focus mode through the widget's real entry point.
  const widgetEl = window.locator(`[data-widget-id="${aId}"]`).first()
  await widgetEl.hover()
  await widgetEl.locator('button[aria-label="Expand options"]').click({ force: true })
  await window.getByText('Full view', { exact: true }).click({ force: true })
  await expect(window.locator('[data-testid="widget-focus-mode"]')).toBeVisible({ timeout: 5000 })

  // The assistant is GONE — no open panel and no pill either. The AI Chat tab
  // is the assistant in focus mode.
  await expect(overlay(window)).toHaveCount(0)
  await expect(pill(window)).toHaveCount(0)

  // Exit focus mode → the assistant returns exactly as it was: open, same mode.
  await window.keyboard.press('Escape')
  await expect(window.locator('[data-testid="widget-focus-mode"]')).toHaveCount(0, { timeout: 5000 })
  await expect(overlay(window)).toBeVisible({ timeout: 5000 })
  await expect(panel(window)).toBeVisible()
})
