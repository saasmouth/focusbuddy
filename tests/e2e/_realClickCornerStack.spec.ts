// REAL input proof for the bottom-right corner, with EVERYTHING in it at once.
//
// Six overlays dock there besides the desk's own controls: an incoming call,
// an active call, a meeting invite, the local-AI notice, the completion toast
// and the feature-spotlight card. Each used to be `fixed bottom-5 right-5`, so
// they landed on each other and on the controls underneath — and none of them
// is click-transparent, so whatever lost was simply dead.
//
// BY CGEvents THROUGH THE WINDOW SERVER, not CDP: a CDP click is dispatched at
// the element and lands whatever is on top of it, so it cannot tell a covered
// control from a reachable one, which is the whole question.
//
// Not part of the suite (underscore = sweep): it moves the real mouse.
// Run: npx playwright test _realClickCornerStack   Shots → CORNER_STACK_SHOTS

import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, waitForReady, chooseCloudAiSource, type LaunchedApp } from './_helpers'
import { cursorLocation, moveMouse, postMouse, pinWindowForRealInput, unpinWindow, type ScreenPoint } from './_macMouse'

const SHOTS = process.env.CORNER_STACK_SHOTS ?? '/private/tmp/claude-501/corner-stack-real-shots'

let launched: LaunchedApp | null = null
let window: Page
let app: ElectronApplication
let restore: ScreenPoint

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true })
  restore = cursorLocation()
  launched = await launchApp()
  window = launched.window
  app = launched.app
  await waitForReady(window)
  await chooseCloudAiSource(window)
  await pinWindowForRealInput(app, window)
})

test.afterAll(async () => {
  moveMouse(restore)
  if (launched) {
    await unpinWindow(app).catch(() => undefined)
    await launched.dispose()
  }
})

async function toScreen(x: number, y: number): Promise<ScreenPoint> {
  const cb = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds())
  const iw = await window.evaluate(() => window.innerWidth)
  const s = cb.width / iw
  return { x: Math.round(cb.x + x * s), y: Math.round(cb.y + y * s) }
}

/** The element's centre, and what a hand would actually hit there. */
async function target(sel: string): Promise<{ x: number; y: number; hit: string | null }> {
  return window.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null
    if (!el) return { x: 0, y: 0, hit: null }
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + r.height / 2
    const top = document.elementFromPoint(x, y)
    return {
      x,
      y,
      hit: (top as HTMLElement | null)?.closest('[data-testid],[data-minimap-fab],[data-automations-fab]')
        ?.getAttribute('data-testid') ?? (top?.closest('[data-minimap-fab]') ? 'minimap' : null)
    }
  }, sel)
}

/** Everything in the corner at once. */
async function fillTheCorner(): Promise<void> {
  await window.evaluate(() => {
    type S<T> = { setState: (s: T) => void }
    const w = window as unknown as {
      __fbCall?: S<object>
      __fbCompletionOffer?: S<object>
      __fbMeetingRoom?: S<object>
    }
    w.__fbCall?.setState({
      status: 'connected',
      peer: { accountId: 'acc_peer', handle: 'peer', firstName: 'Sam', lastName: 'Okafor' },
      media: 'audio'
    })
    w.__fbMeetingRoom?.setState({
      status: 'idle',
      incomingInvite: { roomId: 'r1', from: { accountId: 'acc_two', handle: 'two', firstName: 'Ada', lastName: 'Lovelace' } }
    })
    w.__fbCompletionOffer?.setState({ offer: { itemId: 'item-1', verbState: 'done', title: 'Finish the report' } })
  })
  // The local-AI notice arrives by IPC from main, so it is sent from main.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('localAi:notice', {
      feature: 'corner-stack',
      message: 'Local AI is warming up.',
      action: 'upgrade'
    })
  })
  await window.waitForTimeout(900)
}

test('with the whole corner full, every control underneath is still reachable', async () => {
  test.setTimeout(240_000)

  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'Corner stack' })
    await api.widgets.create({ taskId: t.id, kind: 'sticky', title: 'anchor', content: '', x: 120, y: 120, width: 240, height: 180 } as never)
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: 'Corner stack' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.locator('[data-testid="feature-spotlight-popup"]').waitFor({ state: 'visible', timeout: 20_000 })

  await fillTheCorner()

  // POSITIVE CONTROL: the corner really is full. A sweep over an empty corner
  // proves nothing, so this names what is up and fails if it is not.
  const up = await window.evaluate(() =>
    ['call-window', 'meeting-invite', 'local-ai-notice', 'completion-toast', 'feature-spotlight-popup'].filter(
      (id) => !!document.querySelector(`[data-testid="${id}"]`)
    )
  )
  expect(up, 'the corner must actually be full for this to mean anything').toContain('call-window')
  expect(up.length, `only ${up.join(', ')} were up`).toBeGreaterThanOrEqual(3)
  await window.screenshot({ path: join(SHOTS, '01-corner-full.png') })

  // NOTHING OVERLAPS ANYTHING. Every pair of stacked overlays, and every
  // overlay against every control.
  const overlaps = await window.evaluate(() => {
    const ids = ['call-window', 'call-incoming', 'meeting-invite', 'local-ai-notice', 'completion-toast', 'feature-spotlight-popup']
    const boxes: Array<{ id: string; r: DOMRect }> = []
    for (const id of ids) {
      const el = document.querySelector(`[data-testid="${id}"]`)
      if (el) boxes.push({ id, r: el.getBoundingClientRect() })
    }
    for (const sel of ['[data-testid="assistant-pill"]', '[data-minimap-fab]', '[data-automations-fab]', '[data-testid="floating-toolbar"]']) {
      const el = document.querySelector(sel)
      if (el) boxes.push({ id: sel, r: el.getBoundingClientRect() })
    }
    const bad: string[] = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!
        if (a.r.left < b.r.right && a.r.right > b.r.left && a.r.top < b.r.bottom && a.r.bottom > b.r.top) {
          bad.push(`${a.id} overlaps ${b.id}`)
        }
      }
    }
    return bad
  })
  expect(overlaps, 'the corner is a stack, not a pile').toEqual([])

  // WAIT FOR THE TOGGLE TO EXIST AND SETTLE FIRST. The minimap panel opens
  // itself on load and stands down a couple of seconds later, leaving the
  // toggle — they are mutually exclusive, so hit-testing straight away asks
  // about an element that is not there yet and reads `null`, which looks like
  // a covered control and is not one. MM-3 polls for the same reason.
  const toggleSel = '[data-testid="minimap-fab-toggle"]'
  await window.locator(toggleSel).waitFor({ state: 'visible', timeout: 15_000 })
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

  // EVERY EDGE-DOCKED CONTROL IS REACHABLE, not a list I remembered to write.
  //
  // 9d found the last one in a screenshot I had already looked at: the
  // floating toolbar, a 40x56 rail halfway up the right edge, with the call
  // window over it and a sliver showing. So this asks the DOM which controls
  // are docked at an edge and hit-tests every one of them, rather than naming
  // the three I happened to think of.
  const covered = await window.evaluate(() => {
    const SEL = '[data-floating-menu], [data-testid="assistant-pill"], [data-testid="floating-toolbar"]'
    const bad: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>(SEL)) {
      const r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) continue // not laid out
      const name =
        el.getAttribute('data-testid') ??
        (el.hasAttribute('data-minimap-fab') ? 'minimap' : el.hasAttribute('data-automations-fab') ? 'automations' : 'chrome')
      // Its own centre, and a point just inside each corner: a control can be
      // clear in the middle and covered at an edge.
      const pts: Array<[number, number]> = [
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.left + 3, r.top + 3],
        [r.right - 3, r.bottom - 3]
      ]
      for (const [x, y] of pts) {
        const top = document.elementFromPoint(x, y)
        if (!top) continue
        if (top === el || el.contains(top)) continue
        const by = (top as HTMLElement).closest('[data-testid]')?.getAttribute('data-testid') ?? top.tagName
        // Another piece of chrome overlapping is this corner's own business;
        // what must never happen is one of the STACK's overlays on top.
        if (!['call-window', 'call-incoming', 'meeting-invite', 'local-ai-notice', 'completion-toast', 'feature-spotlight-popup'].includes(by)) continue
        bad.push(`${name} covered by ${by} at ${Math.round(x)},${Math.round(y)}`)
      }
    }
    return bad
  })
  expect(covered, 'no stacked overlay may sit on an edge-docked control').toEqual([])

  // AND EVERY CONTROL TAKES A REAL PRESS. The minimap toggle is the one the
  // defect was reported on; the pill is the other live control down there.
  for (const [sel, expected] of [
    [toggleSel, 'minimap-fab-toggle'],
    ['[data-testid="assistant-pill"]', 'assistant-pill']
  ] as const) {
    const t = await target(sel)
    expect(t.hit, `${expected} must be what a hand hits at its own centre`).toBe(expected)
  }

  const t = await target(toggleSel)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus())
  const p = await toScreen(t.x, t.y)
  postMouse([{ kind: 'move', at: p }, { kind: 'down', at: p }, { kind: 'up', at: p }], 30)
  await window.waitForTimeout(600)
  await expect(window.locator('[data-testid="minimap-fab-panel"]'), 'a real press opened the minimap').toBeVisible({
    timeout: 5_000
  })
  // The call is still there: nothing was dismissed to make room.
  await expect(window.locator('[data-testid="call-window"]'), 'the call is never pushed off').toBeVisible()
  await window.screenshot({ path: join(SHOTS, '02-minimap-open-corner-still-full.png') })
})
