/**
 * Fullscreen AI home (Phase 3a.4): fullscreen mode becomes Notion's AI page —
 * app nav stays visible and clickable beside/above it, the empty state is a
 * centered home (greeting, big composer, honest capability row, suggestion
 * cards), and the composer footer carries a real model picker (P7).
 *
 * AF-1  Non-takeover fullscreen insets beside the desk sidebar and below the
 *       header: the dock stays clickable (navigation re-threads the panel),
 *       the header stays reachable. (P6 + approved amendment: side nav + top
 *       header visible.)
 * AF-2  The fullscreen empty state is the home: greeting, capability row,
 *       suggestion cards that fill the composer; sending swaps to the
 *       conversation layout.
 * AF-3  The model picker is real: lists the real MODEL_OPTIONS, and picking
 *       one writes through to the shared preference (fb.model.mode).
 * AF-4  On a segment takeover, fullscreen stays full-bleed (its nav lives
 *       inside the takeover shell).
 * AF-5  Fullscreen is flat — the panel drops its floating-card chrome (no
 *       radius, no inset) and IS the screen; floating mode keeps the card.
 * AF-6  Capability chips are functional: a click sends a REAL starter request
 *       (captured at the far end, byte-equal to what the chip declares) and
 *       the flow begins as a genuine conversation turn.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import {
  composerText,
  launchApp,
  type LaunchedApp,
  typeInComposer,
  waitForReady,
  switchArea
} from './_helpers'

// Far-end stub, same philosophy as the sibling suites: only chat:sendStream is
// swapped, so the store, the persistence and the rail are all shipping code.
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

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

const overlay = (window: Page) => window.locator('[data-testid="assistant-overlay"]')
const panel = (window: Page) => window.locator('[data-testid="assistant-panel"]')

async function openAssistant(window: Page): Promise<void> {
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:open-assistant')))
  // The assistant is a TABBED shell and reopens on whichever tab was last used
  // (default: Today), where ChatPanel stays mounted but display:none. This spec
  // drives the conversation, so select the Chat tab before waiting on the panel
  // — without it the panel resolves as hidden and every case times out.
  await window.locator('[data-testid="assistant-tab-chat"]').click()
  await panel(window).waitFor({ state: 'visible', timeout: 8000 })
}

async function switchToFullscreen(window: Page): Promise<void> {
  await window.locator('[data-testid="assistant-mode-toggle"]').click()
  await window.locator('[data-testid="assistant-mode-fullscreen"]').click()
  await expect(overlay(window)).toHaveAttribute('data-mode', 'fullscreen')
}

test('AF-1 — fullscreen keeps the sidebar and header alive; a fresh chat follows the screen', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openAssistant(window)
  await switchToFullscreen(window)

  // The desk sidebar is beside the AI page, not buried under it: the overlay
  // starts where the dock ends.
  const dock = window.locator('[data-testid="sidebar-dock"]')
  await expect(dock).toBeVisible()
  const dockBox = (await dock.boundingBox())!
  const overlayBox = (await overlay(window).boundingBox())!
  expect(overlayBox.x).toBeGreaterThanOrEqual(dockBox.x + dockBox.width - 2)
  // And the header row is above it, still reachable.
  expect(overlayBox.y).toBeGreaterThanOrEqual(38)
  await expect(window.locator('[data-testid="topbar-search"]')).toBeVisible()

  // Navigation genuinely works from fullscreen. Phase 4.5 changed what it means
  // for the conversation, and this locks the half that survived: a chat nobody
  // has spoken in yet has committed to nothing, so it still takes its framing
  // from wherever you are. (AF-7 locks the other half — that a conversation
  // WITH turns keeps its own context and is never replaced by the screen.)
  await window.getByRole('button', { name: /Rooms/ }).first().click()
  await expect(window.locator('[data-testid="composer-context-chip"]')).toContainText(
    'your rooms',
    { timeout: 6000 }
  )
  await expect(overlay(window)).toHaveAttribute('data-mode', 'fullscreen')
})

test('AF-7 — a conversation keeps its own context and its turns as you walk around', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await openAssistant(window)
  await switchToFullscreen(window)

  // Fullscreen carries the conversation rail (plan D10).
  const rail = window.locator('[data-testid="conversation-rail"]')
  await expect(rail).toBeVisible()

  // Speak, so the conversation becomes real and records where it began.
  //
  // The message has to read as a message. Since the instant-web ruling
  // (2026-08-23, lib/omniIntent composerOmniIntents) a short bare phrase on a
  // FRESH conversation is searchy, so Enter/Send performs "Search the web" and
  // no chat turn is made — "a question from home" was exactly that, and the
  // answer this waits for could never arrive. A question is never diverted.
  await stubStream(app, 'A home answer.')
  await typeInComposer(window, 'what should I pick up from home?')
  await window.locator('button[aria-label="Send"]').click()
  await expect(window.getByText('A home answer.')).toBeVisible({ timeout: 8000 })
  await expect(rail.locator('[data-testid="conversation-row"]')).toHaveCount(1, { timeout: 8000 })

  // Now walk to another screen. This is the D4 reversal: the conversation is
  // NOT replaced by the destination's, and its context label does not drift to
  // wherever you happen to be standing.
  await window.getByRole('button', { name: /Rooms/ }).first().click()
  await expect(window.locator('[data-testid="assistant-turn"]')).toHaveCount(1, { timeout: 6000 })
  await expect(window.getByText('A home answer.')).toBeVisible()

  // ⌘O starts a fresh one — and the one you were in is still in the rail.
  await window.keyboard.press('ControlOrMeta+o')
  await expect(window.locator('[data-testid="assistant-turn"]')).toHaveCount(0, { timeout: 6000 })
  await expect(rail.locator('[data-testid="conversation-row"]')).toHaveCount(1)

  // Reopening it from the rail brings the turns back — they are on disk, not in
  // a variable that a New chat threw away.
  await rail.locator('[data-testid="conversation-row"]').first().click()
  await expect(window.getByText('A home answer.')).toBeVisible({ timeout: 8000 })
})

test('AF-2 — the fullscreen empty state is the Notion home; a card fills the composer; sending swaps to conversation', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await openAssistant(window)
  await switchToFullscreen(window)

  const home = window.locator('[data-testid="assistant-home"]')
  await expect(home).toBeVisible()
  await expect(home).toContainText('How can I help you today?')
  // The honest capability row — what the assistant can actually act on.
  await expect(window.locator('[data-testid="assistant-capability-row"]')).toBeVisible()
  // Suggestion cards live under the composer in home; clicking one is an
  // offer (fills the composer), not a command.
  const card = window.locator('[data-testid="home-suggestion-card"]').first()
  await expect(card).toBeVisible()
  const cardText = (await card.textContent()) ?? ''
  await card.click()
  const value = await composerText(window)
  expect(value.length).toBeGreaterThan(0)
  expect(cardText).toContain(value)

  // Sending swaps home → conversation layout, same panel.
  await app.evaluate(({ ipcMain }) => {
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
        await new Promise((r) => setTimeout(r, 20))
        send('sources', { sources: [], elapsedMs: 5 })
        send('reply', 'A fullscreen answer.')
        send('complete', {
          ok: true,
          message: { role: 'assistant', content: 'A fullscreen answer.', ts: Date.now() }
        })
        return { ok: true }
      }
    )
  })
  await window.locator('button[aria-label="Send"]').click()
  await expect(window.getByText('A fullscreen answer.')).toBeVisible({ timeout: 8000 })
  await expect(home).toHaveCount(0)
})

test('AF-3 — the model picker is real: MODEL_OPTIONS listed, choice written through', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openAssistant(window)
  await switchToFullscreen(window)

  await window.locator('[data-testid="composer-model-toggle"]').click()
  const menu = window.locator('[data-testid="composer-model-menu"]')
  await expect(menu).toBeVisible()
  // The four real options, by their real labels.
  await expect(menu).toContainText('Auto')
  await expect(menu).toContainText('Haiku 4.5')
  await expect(menu).toContainText('Sonnet 4.6')
  await expect(menu).toContainText('Opus 4.7')

  await window.locator('[data-testid="composer-model-haiku"]').click()
  await expect(menu).toHaveCount(0)
  // Written through to the one shared preference (Settings reads the same key).
  const stored = await window.evaluate(() => localStorage.getItem('fb.model.mode'))
  expect(stored).toBe('haiku')
  await expect(window.locator('[data-testid="composer-model-toggle"]')).toContainText('Haiku')
})

test('AF-5 — fullscreen is flat and full-bleed; floating keeps the card chrome', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await openAssistant(window)

  // Floating: the assistant is a card — rounded, and detached from the window
  // edge. Since A5.5 (AI-39, 2026-08-24) the card is the OVERLAY WRAPPER: tab
  // strip and panel are clipped inside one radius-card surface, and the panel
  // drops its own inner card so no outline sits inside the outer one. So the
  // radius lives on the wrapper now, and the panel inside it is square.
  await expect(overlay(window)).toHaveAttribute('data-mode', 'floating')
  const floating = await overlay(window).evaluate((el) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      radius: cs.borderRadius,
      clips: cs.overflow,
      gapRight: window.innerWidth - r.right,
      gapBottom: window.innerHeight - r.bottom
    }
  })
  expect(floating.radius).not.toBe('0px')
  expect(floating.clips, 'the card clips its tab strip and panel to its radius').toBe('hidden')
  expect(floating.gapRight, 'the card floats off the window edge').toBeGreaterThan(0)
  expect(floating.gapBottom).toBeGreaterThan(0)
  // One card, not a card inside a card.
  const radiusPanelFloating = await panel(window).evaluate((el) => getComputedStyle(el).borderRadius)
  expect(radiusPanelFloating).toBe('0px')

  await switchToFullscreen(window)
  // Fullscreen: no card. Flat surface, no radius on the wrapper or the panel,
  // and the panel spans the whole overlay — no 880px column, no inset gutter.
  const radiusFull = await panel(window).evaluate((el) => getComputedStyle(el).borderRadius)
  expect(radiusFull).toBe('0px')
  const radiusOverlayFull = await overlay(window).evaluate((el) => getComputedStyle(el).borderRadius)
  expect(radiusOverlayFull).toBe('0px')
  const overlayBox = (await overlay(window).boundingBox())!
  const panelBox = (await panel(window).boundingBox())!
  expect(Math.abs(panelBox.width - overlayBox.width)).toBeLessThanOrEqual(2)
  // Full-bleed now means "fills everything below the tab strip": the tabbed
  // shell puts a tab bar above the panel, so the panel is legitimately shorter
  // than the overlay by exactly that strip. Measured rather than hardcoded, so
  // the assertion still fails if the panel ever grows its own gutter.
  const tabsBox = (await window.locator('[data-testid="assistant-tabs"]').boundingBox())!
  // DEC-120 put the assistant header above the tab strip; the panel fills
  // everything below both.
  const headerBox = (await window.locator('[data-testid="assistant-header"]').boundingBox())!
  expect(Math.abs(panelBox.height + tabsBox.height + headerBox.height - overlayBox.height)).toBeLessThanOrEqual(2)
})

test('AF-6 — a capability chip click sends the real starter request it declares', async () => {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await openAssistant(window)
  await switchToFullscreen(window)

  await app.evaluate(({ ipcMain }) => {
    try {
      ipcMain.removeHandler('chat:sendStream')
    } catch {
      /* first install */
    }
    ipcMain.handle(
      'chat:sendStream',
      async (
        e: Electron.IpcMainInvokeEvent,
        input: { requestId: string; messages: Array<{ role: string; content: string }> }
      ) => {
        ;(globalThis as Record<string, unknown>).__afLastUserMessage =
          [...input.messages].reverse().find((m) => m.role === 'user')?.content ?? null
        const channel = `chat:stream:${input.requestId}`
        const send = (type: string, payload: unknown): void => {
          if (!e.sender.isDestroyed()) e.sender.send(channel, { type, payload })
        }
        await new Promise((r) => setTimeout(r, 20))
        send('sources', { sources: [], elapsedMs: 5 })
        send('reply', 'Starting that for you.')
        send('complete', {
          ok: true,
          message: { role: 'assistant', content: 'Starting that for you.', ts: Date.now() }
        })
        return { ok: true }
      }
    )
  })

  const chip = window.locator('[data-testid="capability-chip"]').first()
  await expect(chip).toBeVisible()
  const declaredStarter = await chip.getAttribute('data-starter')
  expect(declaredStarter && declaredStarter.length).toBeTruthy()

  await chip.click()
  // The starter became a real user turn…
  await expect(window.locator('[data-testid="user-turn"]').last()).toContainText(
    declaredStarter!,
    { timeout: 8000 }
  )
  await expect(window.getByText('Starting that for you.')).toBeVisible({ timeout: 8000 })
  // …and the far end received EXACTLY what the chip declared.
  const sent = await app.evaluate(
    () => (globalThis as Record<string, unknown>).__afLastUserMessage
  )
  expect(sent).toBe(declaredStarter)
})

test('AF-4 — on a segment takeover, fullscreen stays full-bleed', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Office is a segment takeover. It is reached through the one workspace/area
  // switcher at the top of the desk menu now (c581655d: "Workspace and area
  // become one control") — the old always-visible "Office" button is gone, and
  // getByRole(/Office/) waited out the whole test for it.
  await window.locator('[data-testid="workspace-switcher-trigger"]').click()
  await switchArea(window, 'office')
  await expect
    .poll(() =>
      window.evaluate(
        () =>
          (window as unknown as { __fbView?: { getState: () => { view: { kind: string } } } }).__fbView
            ?.getState().view.kind
      )
    )
    .toBe('office')
  await openAssistant(window)
  await switchToFullscreen(window)

  const overlayBox = (await overlay(window).boundingBox())!
  expect(Math.round(overlayBox.x)).toBe(0)
  expect(Math.round(overlayBox.y)).toBe(0)
})
