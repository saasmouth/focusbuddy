import { test, expect } from '@playwright/test'
import { gotoView, launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Rooms must navigate, and they must navigate to their CONTENTS. Clicking a
// room anywhere on Home used to be a dead end (the folder branch of openDesk
// called goPlexiDesk() with no id — a no-op from inside the PlexiDesk shell).
// It was then pointed at the room's dashboard, which fixed the dead end but
// landed you on a single desk-shaped canvas instead of showing you what was in
// the room. Operator, 2026-10-08: "rooms shouldn't be desks. When someone
// clicks on a room it should show the desks in the room, not a desk." So a
// room click now lands on kind 'desks' scoped by roomId, via goRoom, the same
// path RoomsView uses for every non-plan room. In the Home navigator the first
// click selects the room (fills the desks column) and a second click opens it.

const OUT = process.env.SHOT_DIR ?? '/tmp'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedRoomWithDesk(window: import('@playwright/test').Page): Promise<{ roomId: string }> {
  return await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const room = await api.nodes.create({ parentId: null, kind: 'folder', title: 'Launch room' })
    await api.nodes.create({ parentId: room.id, kind: 'task', title: 'Runsheet desk' })
    return { roomId: room.id }
  })
}

async function currentView(window: import('@playwright/test').Page): Promise<Record<string, unknown>> {
  return await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { view: Record<string, unknown> } } }
    return w.__fbView!.getState().view
  })
}

test('a room in the Home navigator opens its desks on the second click', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.setViewportSize({ width: 1440, height: 900 })
  const { roomId } = await seedRoomWithDesk(window)
  await window.evaluate(() => localStorage.setItem('fb.theme.mode', 'dark'))
  await window.reload()
  await waitForReady(window)
  await gotoView(window, 'goHome')

  const roomRow = window.locator(`[data-testid="home-nav-room-${roomId}"]`)
  await roomRow.scrollIntoViewIfNeeded()
  await expect(roomRow).toBeVisible()

  // First click: selects — the desks column fills, no navigation.
  await roomRow.click()
  await window.waitForTimeout(200)
  expect((await currentView(window)).kind).not.toBe('desks')
  await expect(window.locator('[data-testid="home-desks"]')).toContainText('Runsheet desk')
  await window.screenshot({ path: `${OUT}/rooms-nav-selected-dark.png` })

  // Second click on the selected room: opens it for real.
  await roomRow.click()
  await window.waitForTimeout(400)
  const view = await currentView(window)
  expect(view.kind).toBe('desks')
  expect(view.roomId).toBe(roomId)
  // And it really is the room's contents on screen, not just the right route.
  await expect(window.locator('[data-testid="desks-view"], main')).toContainText('Runsheet desk')
  await window.screenshot({ path: `${OUT}/rooms-nav-opened-dark.png` })
})

test('atelier: the room open path holds and shoots clean', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.setViewportSize({ width: 1440, height: 900 })
  const { roomId } = await seedRoomWithDesk(window)
  await window.evaluate(() => localStorage.setItem('fb.theme.mode', 'atelier'))
  await window.reload()
  await waitForReady(window)
  await gotoView(window, 'goHome')

  const roomRow = window.locator(`[data-testid="home-nav-room-${roomId}"]`)
  await roomRow.scrollIntoViewIfNeeded()
  await roomRow.click()
  await window.waitForTimeout(200)
  await window.screenshot({ path: `${OUT}/rooms-nav-selected-atelier.png` })
  await roomRow.click()
  await window.waitForTimeout(400)
  const view = await currentView(window)
  expect(view.kind).toBe('desks')
  expect(view.roomId).toBe(roomId)
  await window.screenshot({ path: `${OUT}/rooms-nav-opened-atelier.png` })
})
