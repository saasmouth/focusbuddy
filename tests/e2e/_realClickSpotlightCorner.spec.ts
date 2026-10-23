// REAL input proof that the feature-spotlight card does not eat the corner.
//
// The card ("New: <tour>") is non-modal first-run chrome that docks in the
// bottom-right at z-[230] — the same corner the desk keeps the Plexii pill, the
// minimap and the automations button in. It sat on top of them, so a first-run
// user who pressed the minimap got nothing at all: no panel, no feedback, and
// nothing on screen to say why. _helpers has carried the workaround for a while
// ("specs that drive the bottom-right corner should additionally call
// suppressFeatureSpotlights"), and 51 specs call it; this one deliberately does
// NOT, because the workaround is what hid the defect.
//
// BY CGEvents THROUGH THE WINDOW SERVER, not CDP. A CDP click is dispatched at
// the element and lands whatever is on top of it, so it cannot tell a covered
// control from a reachable one — which is the entire question here. Each press
// first checks that elementFromPoint at the target IS the control.
//
// Not part of the suite (underscore = sweep): it moves the real mouse and puts
// it back.
//
// Run: npx playwright test _realClickSpotlightCorner
//      Screenshots → SPOTLIGHT_REAL_SHOTS

import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, waitForReady, chooseCloudAiSource, type LaunchedApp } from './_helpers'
import { acquireRealInput, releaseRealInput } from './_realInputLock'
import { cursorLocation, moveMouse, postMouse, pinWindowForRealInput, unpinWindow, type ScreenPoint } from './_macMouse'

const SHOTS = process.env.SPOTLIGHT_REAL_SHOTS ?? '/private/tmp/claude-501/spotlight-corner-real-shots'

let launched: LaunchedApp | null = null
let window: Page
let app: ElectronApplication
let restore: ScreenPoint

test.beforeAll(async () => {
  // Real input is one spec at a time across workers (_realInputLock.ts).
  test.setTimeout(240_000)
  await acquireRealInput('_realClickSpotlightCorner')
  mkdirSync(SHOTS, { recursive: true })
  restore = cursorLocation()
  launched = await launchApp()
  window = launched.window
  app = launched.app
  await waitForReady(window)
  // The local-AI cards are bottom-CENTRE, not in this corner, but they are
  // modal enough to swallow a press on the way past. Cleared so the only thing
  // left in the way is the card under test.
  await chooseCloudAiSource(window)
  await pinWindowForRealInput(app, window)
})

test.afterAll(async () => {
  try {
    moveMouse(restore)
    if (launched) {
      await unpinWindow(app).catch(() => undefined)
      await launched.dispose()
    }
  } finally {
    releaseRealInput()
  }
})

async function toScreen(x: number, y: number): Promise<ScreenPoint> {
  const cb = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds())
  const iw = await window.evaluate(() => window.innerWidth)
  const s = cb.width / iw
  return { x: Math.round(cb.x + x * s), y: Math.round(cb.y + y * s) }
}

/** The element's centre, and what a hand would actually hit there. */
async function target(sel: string): Promise<{ x: number; y: number; onTop: boolean; hit: string | null }> {
  return window.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null
    if (!el) return { x: 0, y: 0, onTop: false, hit: null }
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const hit = document.elementFromPoint(x, y)
    return {
      x,
      y,
      onTop: !!hit && (hit === el || el.contains(hit)),
      hit: (hit as HTMLElement | null)?.closest('[data-testid]')?.getAttribute('data-testid') ?? null
    }
  }, sel)
}

test('a first-run user can press the minimap while the spotlight card shows', async () => {
  test.setTimeout(180_000)

  // A desk with something on it, then the reload that offers the card.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Spotlight corner' })
    await api.widgets.create({
      taskId: task.id, kind: 'sticky', title: 'anchor', content: '',
      x: 120, y: 120, width: 240, height: 180
    } as never)
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: 'Spotlight corner' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

  // THE POSITIVE CONTROL. If the card is not actually on screen this test
  // proves nothing at all, so it fails here rather than passing vacuously.
  // The card mounts ~750ms after boot (its init awaits two IPC calls).
  const card = window.locator('[data-testid="feature-spotlight-popup"]')
  await expect(card, 'the spotlight card must be showing, or this proves nothing').toBeVisible({ timeout: 20_000 })
  await window.screenshot({ path: join(SHOTS, '01-card-showing-over-the-corner.png') })

  // The toggle has to be SETTLED in its corner before the hit test means
  // anything: it animates in, and MM-3 used to pass by pressing it mid-flight.
  //
  // Settled is a question about POSITION, not about what is on top of it. My
  // first version of this polled `onTop` — the very thing under test — so it
  // timed out here instead of reaching the assertion below, and reported
  // "waiting for the toggle to settle" for a defect that has nothing to do with
  // settling. This is MM-5's measure: the toggle is home when its bottom edge
  // is within 16px of the canvas surface's.
  const toggle = '[data-testid="minimap-fab-toggle"]'
  await window.locator(toggle).waitFor({ state: 'visible', timeout: 15_000 })
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const t = document.querySelector('[data-testid="minimap-fab-toggle"]')?.getBoundingClientRect()
          const s = document.querySelector('[data-canvas-surface="true"]')?.getBoundingClientRect()
          return t && s ? Math.round(s.bottom - t.bottom) : Number.POSITIVE_INFINITY
        }),
      { timeout: 8_000, message: 'waiting for the toggle to reach its corner' }
    )
    .toBeLessThanOrEqual(16)

  // WHAT A HAND HITS THERE. Before the fix this is the spotlight card.
  const t = await target(toggle)
  expect(t.hit, 'the top element at the minimap toggle').toBe('minimap-fab-toggle')

  // And a real press reaches it: the panel opens, and the assistant — whose
  // pill shares this corner — does not.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus())
  const p = await toScreen(t.x, t.y)
  postMouse([{ kind: 'move', at: p }, { kind: 'down', at: p }, { kind: 'up', at: p }], 30)
  await window.waitForTimeout(600)

  await expect(window.locator('[data-testid="minimap-fab-panel"]'), 'a real press opened the minimap').toBeVisible({
    timeout: 5_000
  })
  expect(
    await window.evaluate(
      () => (window as unknown as { __fbAssistantChrome?: { getState: () => { open: boolean } } }).__fbAssistantChrome?.getState().open
    ),
    'the press must not have opened Plexii instead'
  ).toBe(false)
  // Still showing, so the card was never dismissed to make this work.
  await expect(card, 'the card was not dismissed to pass this test').toBeVisible()
  await window.screenshot({ path: join(SHOTS, '02-minimap-open-with-card-still-showing.png') })
})
