import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// In-app runtime proof that the capability matrix gates the desktop UI.
//
// A signed-out user resolves to the FREE tier (the capability store's
// offline fallback). On Free, widget_table is false, so the Table tile in
// the side menu's Widgets section must render LOCKED and open the upgrade
// prompt instead of creating a table — while an ungated tile (Sticky) stays a
// normal one. This exercises the real wiring: capability store → gating.ts →
// WidgetsSection → UpgradePromptModal. (It was the hover WidgetPalette until
// 4.3.32 removed it.)

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})


// THE THREE WIDGET-GATING TESTS THAT WERE HERE ARE GONE, on the owner's
// ruling (2026-10-24), because the thing they tested is gone.
//
// b6ad65646 (2026-07-07) applied "the land-grab tier mapping (free gets all
// apps + personal features)": every widget_* capability in capabilityDefaults
// is now { free: true, pro: true, team: true }. There is no widget locked on
// the Free tier, so "Table is locked in the side menu", "clicking a locked
// widget opens the upgrade prompt" and "Table is locked in the CommandCenter
// too" have no subject, and nothing in the capability table can stand in.
//
// The upgrade prompt itself is still covered — by the desk-limit test below,
// which is the one free gate that remains (multiple_desks, { free: 3 }).
test('Free tier: 4th top-level desk is blocked with an upgrade prompt', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  // Seed exactly 3 DESKS — top-level TASKS. This used to seed top-level
  // folders, which the Rooms/Desks rename turned into ROOMS, so it was filling
  // the workspace with the one object the cap does not count.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    for (let i = 1; i <= 3; i++) {
      await api.nodes.create({ parentId: null, kind: 'task', title: `Desk ${i}` })
    }
  })
  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip2 = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip2.isVisible().catch(() => false)) await skip2.click().catch(() => {})

  // ACTUALLY TRY TO CREATE THE FOURTH, rather than only pressing the button.
  //
  // This used to click the sidebar's create button and expect the prompt
  // there and then, on the strength of a comment in nodes.ts saying the
  // sidebar "additionally gates the trigger for nicer UX". It does not —
  // there is no multiple_desks check anywhere in Sidebar.tsx — so the button
  // opens the create dialog like any other time, and the cap is enforced
  // where the comment says it really is: in the store's create(), before the
  // IPC call, so nothing is persisted. Driving the whole gesture is also the
  // honest test of the owner's rule, which is about creating a desk and not
  // about which control is greyed.
  //
  // (Renamed by 4802064e4: the button is "New desk" now. Matched on the
  // accessible name, because its title attribute is a sentence of help text.)
  await window.getByRole('button', { name: /New desk/i }).first().click()
  const nameField = window.locator('[data-testid="newnode-name"]')
  await expect(nameField).toBeVisible({ timeout: 5_000 })
  await nameField.fill('Desk 4')
  // The submit reads `Create ${nounLabel}` (NewNodeDialog:310), so match the
  // verb rather than a noun the Rooms/Desks rename may move again.
  await window.getByRole('button', { name: /^Create / }).click()

  await expect(window.locator('[data-testid="upgrade-prompt-modal"]')).toBeVisible({ timeout: 8_000 })
  await expect(window.locator('[data-testid="upgrade-reason"]')).toContainText(/desk limit/i)

  // Hard backstop: the store refused to persist a 4th — still exactly 3.
  const deskCount = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.nodes.list()
    return all.filter((n: { parentId: string | null; kind: string }) => n.parentId === null && n.kind === 'task').length
  })
  expect(deskCount).toBe(3)
})

// ── The other two halves of the owner's ruling (2026-10-24) ───────────────
// "3 desks, keep existing": rooms are unlimited, and anyone already over the
// limit keeps what they have. Both are easy to get wrong in the direction
// that costs a person their work, so both are pinned.

test('Free tier: rooms are NOT capped — a 4th room is created', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object', null, {
    timeout: 10_000
  })

  const rooms = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    for (let i = 1; i <= 4; i++) {
      await api.nodes.create({ parentId: null, kind: 'folder', title: `Room ${i}` })
    }
    const all = await api.nodes.list()
    return all.filter((n: { parentId: string | null; kind: string }) => n.parentId === null && n.kind === 'folder').length
  })
  expect(rooms, 'the 4th room was created; only desks are capped').toBe(4)
  // And no upgrade prompt was raised on the way.
  await expect(window.locator('[data-testid="upgrade-prompt-modal"]')).toHaveCount(0)
})

test('Free tier: someone already over the limit keeps every desk and can open them', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object', null, {
    timeout: 10_000
  })

  // Five desks, as a long-standing account would have. Seeded through the IPC
  // directly, which is how they got there before the cap was pointed at the
  // right object — the store gate guards create() in the renderer.
  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const made: string[] = []
    for (let i = 1; i <= 5; i++) {
      const n = await api.nodes.create({ parentId: null, kind: 'task', title: `Legacy desk ${i}` })
      made.push((n as { id: string }).id)
    }
    return made
  })
  await window.reload()
  await waitForReady(window)

  // Nothing was deleted or hidden.
  const kept = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.nodes.list()
    return all.filter((n: { parentId: string | null; kind: string }) => n.parentId === null && n.kind === 'task').length
  })
  expect(kept, 'all five kept').toBe(5)

  // And every one of them still opens.
  for (const id of ids) {
    await window.evaluate((taskId) => {
      const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
      w.__fbView?.getState().goTask(taskId)
    }, id)
    await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible({ timeout: 8_000 })
  }
})

// ── CommandCenter spawn gate (second table-creation path) ──────────────

test('Free tier: desks INSIDE rooms count toward the three', async () => {
  // The owner's correction (2026-10-24): "3 desks" is every desk, not every
  // top-level one. Counting only top-level desks would have let someone make
  // desks inside rooms forever — the cap would have looked enforced and done
  // nothing for anybody who organises their work into rooms.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object', null, {
    timeout: 10_000
  })

  // One desk at the top level and two tucked inside rooms: three in total.
  await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const roomA = await api.nodes.create({ parentId: null, kind: 'folder', title: 'Room A' })
    const roomB = await api.nodes.create({ parentId: null, kind: 'folder', title: 'Room B' })
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Loose desk' })
    await api.nodes.create({ parentId: (roomA as { id: string }).id, kind: 'task', title: 'Desk in A' })
    await api.nodes.create({ parentId: (roomB as { id: string }).id, kind: 'task', title: 'Desk in B' })
  })
  await window.reload()
  await waitForReady(window)
  await window.waitForFunction(() => typeof (window as unknown as { api?: unknown }).api === 'object', null, {
    timeout: 10_000
  })

  await window.getByRole('button', { name: /New desk/i }).first().click()
  const nameField = window.locator('[data-testid="newnode-name"]')
  await expect(nameField).toBeVisible({ timeout: 5_000 })
  await nameField.fill('Desk 4')
  await window.getByRole('button', { name: /^Create / }).click()

  await expect(window.locator('[data-testid="upgrade-prompt-modal"]')).toBeVisible({ timeout: 8_000 })
  await expect(window.locator('[data-testid="upgrade-reason"]')).toContainText(/desk limit/i)

  // Nothing was persisted: still three desks, wherever they live.
  const desks = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.nodes.list()
    return all.filter((n: { kind: string; archived?: boolean }) => n.kind === 'task' && !n.archived).length
  })
  expect(desks).toBe(3)
})
