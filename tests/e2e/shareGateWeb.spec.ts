// A public share link, opened by a visitor (owner, 2026-11-07):
//
//   "make the shared rooms and desk features work just like plexii local, with
//   menus, ai etc, however if someone goes to create a desk, or room, use ai
//   assist, or do anything other than drag apps, widgets, files and tools to
//   the desk, it says download this desk on plexii and initiates the download.
//   From there they will need to sign up for the trial to use the desk locally."
//
// The share page is the real web build, opened in headless Chromium at its real
// address with Signal and the download host answered locally
// (_shareWebHarness.ts). Build it first:  VITE_WEB_BASE=/share/ npm run web:build
import { test, expect } from '@playwright/test'
import {
  assertWebBuild, openShareWeb, openTheDesk, DESK_ID, LIVE_TOKEN, MAC_INSTALLER, ROOM_TOKEN, STICKY_ID, TOKEN, type ShareWeb
} from './_shareWebHarness'

let web: ShareWeb | null = null
test.beforeAll(() => assertWebBuild())
test.afterEach(async () => {
  if (web) await web.close()
  web = null
})

const gate = (w: ShareWeb) => w.page.locator('[data-testid="share-gate"]')
/** Every page error. The gate's own refusals are absorbed by the page (boot.tsx), so none are expected. */
const realErrors = (w: ShareWeb) => w.errors
const widgetCount = (w: ShareWeb) => w.page.locator('[data-canvas-surface] [data-widget-id]').count()

test('SG-1 the whole app is there, and looking around never opens the gate', async () => {
  test.setTimeout(180_000)
  web = await openShareWeb()
  await openTheDesk(web)
  const { page } = web

  // Plexii, as it is on the desktop: the titlebar, the side menu, Files, the
  // assistant, the footer.
  for (const id of ['desk-sidebar', 'topbar-search', 'files-panel-toggle', 'assistant-pill', 'sync-indicator', 'sidemenu-widgets']) {
    await expect(page.locator(`[data-testid="${id}"]`).first(), id).toBeVisible()
  }
  // ...without the build tag and update check, which mean nothing here.
  await expect(page.locator('footer').getByText(/^v\d+\.\d+/)).toHaveCount(0)

  // Looking around: pan and zoom the canvas, open and close Files, search,
  // move a note, step into the rooms view and back.
  const canvas = page.locator('[data-canvas-surface]').first()
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 240)
  await page.mouse.click(box.x + box.width - 120, box.y + box.height - 160)
  await page.locator('[data-testid="files-panel-toggle"]').click()
  await page.waitForTimeout(400)
  await page.locator('[data-testid="files-panel-toggle"]').click()
  await page.locator('[data-testid="topbar-search"]').click()
  await page.keyboard.type('trading')
  await page.keyboard.press('Escape')
  const grab = page.locator(`[data-widget-id="${STICKY_ID}"] [data-testid="widget-grab"]`).first()
  if (await grab.count()) {
    const g = (await grab.boundingBox())!
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
    await page.mouse.down()
    await page.mouse.move(g.x + 140, g.y + 90, { steps: 8 })
    await page.mouse.up()
  }
  await page.getByText('All desks', { exact: true }).first().click()
  await page.waitForTimeout(500)
  await page.locator('[data-testid="history-back"]').click()
  await page.waitForTimeout(800)

  expect(await web.gates(), 'looking around opened the download gate').toEqual([])
  expect(await gate(web).count()).toBe(0)
  expect(web.downloads).toEqual([])
  expect(web.handoffs).toEqual([])
  expect(realErrors(web), 'the page threw').toEqual([])
  expect(web.escaped, 'something reached the real world').toEqual([])
})

test('SG-2 dragging a widget onto the desk is free, and it lands', async () => {
  test.setTimeout(180_000)
  web = await openShareWeb()
  await openTheDesk(web)
  const { page } = web
  const before = await widgetCount(web)
  const canvas = page.locator('[data-canvas-surface]').first()
  await page.locator('[data-testid="sidemenu-widget-timer"]').dragTo(canvas, { targetPosition: { x: 700, y: 420 } })
  await expect.poll(() => widgetCount(web!), { timeout: 15_000 }).toBe(before + 1)
  await page.waitForTimeout(800)
  expect(await web.gates(), 'a drag onto the desk opened the gate').toEqual([])
  expect(web.downloads).toEqual([])
})

test('SG-3 creating a desk says "Download this desk on Plexii", starts the download once, and carries the copy', async () => {
  test.setTimeout(180_000)
  web = await openShareWeb()
  await openTheDesk(web)
  const { page } = web

  // Something of the visitor's own first: a widget dragged on.
  const canvas = page.locator('[data-canvas-surface]').first()
  await page.locator('[data-testid="sidemenu-widget-timer"]').dragTo(canvas, { targetPosition: { x: 700, y: 420 } })
  await expect.poll(() => widgetCount(web!), { timeout: 15_000 }).toBe(3)

  // The New Desk dialog opens as it does in Plexii; making the desk is the gate.
  await page.getByRole('button', { name: 'New desk' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Desk' })
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await dialog.getByRole('textbox', { name: 'What needs to happen?' }).fill('My own desk')
  await dialog.getByRole('button', { name: 'Create Desk' }).click()
  await expect(gate(web)).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-testid="share-gate-lead"]')).toContainText('Creating a desk is part of the Plexii app.')
  await expect(page.locator('#share-gate-title')).toHaveText('Download this desk on Plexii')

  // The installer for this computer started, once.
  await expect.poll(() => web!.downloads).toEqual([MAC_INSTALLER])
  await expect(page.locator('[data-testid="share-gate-download"]')).toContainText('Plexii 4.3.46 for Mac is downloading.')

  // The visitor's copy, with the widget they dropped, went to Signal...
  await expect(page.locator('[data-testid="share-gate-open-in-plexii"]')).toBeVisible({ timeout: 20_000 })
  const post = web.handoffs.find((h) => h.method === 'POST')!
  expect(post.body).toMatchObject({ shareToken: TOKEN, kind: 'use', title: 'Day trading desk' })
  const sent = JSON.parse(post.body.bundle!) as { desk: { id: string }; tables: { widgets: Array<{ kind: string }> } }
  expect(sent.desk.id).toBe(DESK_ID)
  expect(sent.tables.widgets.map((w) => w.kind).sort()).toEqual(['sticky', 'sticky', 'timer'])
  // ...and the link that opens it in Plexii says which.
  await expect(page.locator('[data-testid="share-gate-open-in-plexii"]')).toHaveAttribute('href', 'plexii://desk?handoff=HandoffForTest_00000001')

  // No desk was made here.
  await page.locator('[data-testid="share-gate-close"]').click()
  await expect(gate(web)).toHaveCount(0)
  expect(await page.getByText('My own desk').count()).toBe(0)

  // Another door: the gate again, and no second download.
  await page.locator('button[aria-label="Appearance settings"]').click()
  await expect(gate(web)).toBeVisible()
  await expect(page.locator('[data-testid="share-gate-lead"]')).toContainText('Settings is part of the Plexii app.')
  await page.waitForTimeout(500)
  expect(web.downloads).toEqual([MAC_INSTALLER])
  expect(realErrors(web)).toEqual([])
})

test('SG-4 typing into the desk is the gate before a character lands', async () => {
  test.setTimeout(180_000)
  web = await openShareWeb()
  await openTheDesk(web)
  const { page } = web
  // A sticky shows its words until clicked, then becomes a text box.
  await page.locator(`[data-widget-id="${STICKY_ID}"] .fb-sticky-rendered`).first().click()
  const text = page.locator(`[data-widget-id="${STICKY_ID}"] textarea`).first()
  await expect(text).toBeVisible({ timeout: 10_000 })
  await text.focus()
  await page.keyboard.type('x')
  await expect(gate(web)).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-testid="share-gate-lead"]')).toContainText('Editing this desk is part of the Plexii app.')
  // Not a character landed: not in what the desk holds, not on screen (the
  // note leaves edit mode when the gate takes the focus).
  const stored = await page.evaluate(async (id: string) => {
    const api = (window as unknown as { api: { widgets: { get: (i: string) => Promise<{ content: string } | null> } } }).api
    return (await api.widgets.get(id))?.content ?? null
  }, STICKY_ID)
  expect(stored).toBe('Watch AAPL at the open')
  if (await text.count()) await expect(text).toHaveValue('Watch AAPL at the open')
  else await expect(page.locator(`[data-widget-id="${STICKY_ID}"] .fb-sticky-rendered`).first()).toHaveText('Watch AAPL at the open')
})

test('SG-5 the assistant opens and takes typing; asking it is the gate', async () => {
  test.setTimeout(180_000)
  web = await openShareWeb()
  await openTheDesk(web)
  const { page } = web
  await page.locator('[data-testid="assistant-pill"]').click()
  const box = page.locator('[data-testid="assistant-overlay"] .ProseMirror').first()
  await expect(box).toBeVisible({ timeout: 10_000 })
  await box.click()
  await page.keyboard.type('Summarise this desk')
  await page.waitForTimeout(400)
  expect(await web.gates(), 'typing a question opened the gate').toEqual([])
  await page.keyboard.press('Enter')
  await expect(gate(web)).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-testid="share-gate-lead"]')).toContainText('AI is part of the Plexii app.')
})

test('SG-6 what was added after the copy was sent goes too, on the way to Plexii', async () => {
  test.setTimeout(180_000)
  web = await openShareWeb()
  await openTheDesk(web)
  const { page } = web
  await page.locator('[data-testid="share-take-desk"]').click()
  await expect(page.locator('[data-testid="share-gate-open-in-plexii"]')).toBeVisible({ timeout: 20_000 })
  // Asked for from the bar: nothing to explain, just the offer.
  await expect(page.locator('[data-testid="share-gate-lead"]')).toHaveText('Take this desk with you — everything you added comes too.')
  await page.locator('[data-testid="share-gate-close"]').click()

  const canvas = page.locator('[data-canvas-surface]').first()
  await page.locator('[data-testid="sidemenu-widget-note"]').dragTo(canvas, { targetPosition: { x: 760, y: 480 } })
  await expect.poll(() => widgetCount(web!), { timeout: 15_000 }).toBe(3)

  await page.locator('[data-testid="share-take-desk"]').click()
  await page.locator('[data-testid="share-gate-open-in-plexii"]').click()
  await expect.poll(() => web!.handoffs.filter((h) => h.method === 'PUT').length, { timeout: 15_000 }).toBe(1)
  const put = web.handoffs.find((h) => h.method === 'PUT')!
  expect(put.secret).toBe('test-secret')
  const sent = JSON.parse(put.body.bundle!) as { tables: { widgets: Array<{ kind: string }> } }
  expect(sent.tables.widgets.map((w) => w.kind).sort()).toEqual(['note', 'sticky', 'sticky'])
})

test('SG-7 no promise to carry the desk when the released app cannot take it', async () => {
  test.setTimeout(180_000)
  web = await openShareWeb({ deskHandoff: false })
  await openTheDesk(web)
  const { page } = web
  await page.locator('[data-testid="share-take-desk"]').click()
  await expect(gate(web)).toBeVisible()
  await expect(page.locator('[data-testid="share-gate-lead"]')).toHaveText('Take this desk with you.')
  await expect(gate(web)).toContainText('Build your own desks.')
  await expect(page.locator('[data-testid="share-gate-open-in-plexii"]')).toHaveCount(0)
  await page.waitForTimeout(800)
  expect(web.handoffs).toEqual([])
  expect(web.downloads).toEqual([MAC_INSTALLER])
})

test('SG-8 on a phone, nothing is downloaded: the link goes to the computer', async () => {
  test.setTimeout(180_000)
  web = await openShareWeb({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  })
  await openTheDesk(web)
  const { page } = web
  await page.locator('[data-testid="share-take-desk"]').click()
  await expect(page.locator('[data-testid="share-gate-phone"]')).toBeVisible()
  await page.waitForTimeout(800)
  expect(web.downloads).toEqual([])
})

// ── Every link is the full app; only what the visitor may do changes ────────
// Owner, 2026-11-07: "they all should be the same, just the interactivity that
// changes. Should be full web version of the local app." A Live web view link
// (view.plexiidesk.com/share/dsk_…, which the viewer now sends to
// /share/l/<token>) opens the same app, to look at: arranging is the
// visitor's own business, adding to the sender's desk is not.

test('SG-9 a live web view link opens the full app, to look at', async () => {
  test.setTimeout(180_000)
  web = await openShareWeb()
  await openTheDesk(web, `/share/l/${LIVE_TOKEN}`)
  const { page } = web
  for (const id of ['desk-sidebar', 'topbar-search', 'assistant-pill', 'files-panel-toggle']) {
    await expect(page.locator(`[data-testid="${id}"]`).first(), id).toBeVisible()
  }
  await expect(page.locator('[data-testid="share-take-desk"]')).toHaveText('Get Plexii')
  await expect(page.getByText(' — live: it changes as it is worked on')).toBeVisible()
  await expect(page.getByText('Save desk file')).toHaveCount(0)

  // Arranging it: theirs to do.
  const grab = page.locator(`[data-widget-id="${STICKY_ID}"] [data-testid="widget-grab"]`).first()
  const g = (await grab.boundingBox())!
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await page.mouse.down()
  await page.mouse.move(g.x + 160, g.y + 100, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(600)
  expect(await web.gates(), 'arranging a live desk opened the gate').toEqual([])

  // Adding to the sender's desk: not on a link to look at.
  const canvas = page.locator('[data-canvas-surface]').first()
  await page.locator('[data-testid="sidemenu-widget-timer"]').dragTo(canvas, { targetPosition: { x: 700, y: 420 } })
  await expect(gate(web)).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('#share-gate-title')).toHaveText('Get Plexii')
  await expect(page.locator('[data-testid="share-gate-lead"]')).toHaveText('Adding things to this desk is part of the Plexii app. Plexii is free to start.')
  await expect(page.locator('[data-testid="share-gate-open-in-plexii"]')).toHaveCount(0)
  await expect.poll(() => web!.downloads).toEqual([MAC_INSTALLER])
  expect(await widgetCount(web)).toBe(2)
  expect(web.handoffs).toEqual([])
  expect(realErrors(web)).toEqual([])
  expect(web.escaped).toEqual([])
})

test('SG-10 a live desk follows the person who shared it', async () => {
  test.setTimeout(240_000)
  web = await openShareWeb()
  await openTheDesk(web, `/share/l/${LIVE_TOKEN}`)
  const { page } = web
  expect(await widgetCount(web)).toBe(2)

  // Left alone, the desk simply becomes the newer one when the visitor comes back.
  web.bumpLive('Close the AAPL position by 3pm')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByText('Close the AAPL position by 3pm').first()).toBeVisible({ timeout: 90_000 })
  expect(await widgetCount(web)).toBe(3)

  // Busy with it (a click just now), it is offered instead of pulled out from under them.
  const canvas = page.locator('[data-canvas-surface]').first()
  const box = (await canvas.boundingBox())!
  web.bumpLive('Trail the stop to break-even')
  await page.mouse.click(box.x + box.width - 140, box.y + box.height - 180)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('[data-testid="share-live-updated"]')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Show the latest' }).click()
  await expect(page.getByText('Trail the stop to break-even').first()).toBeVisible({ timeout: 90_000 })
})

test('SG-11 a live link whose desk has not been sent yet points at the viewer, without a loop', async () => {
  test.setTimeout(120_000)
  web = await openShareWeb({ liveBundle: false })
  const { page } = web
  await page.goto(`https://plexiidesk.com/share/l/${LIVE_TOKEN}`)
  await expect(page.locator('[data-testid="share-refusal"]')).toContainText('not ready to open in the full app yet', { timeout: 60_000 })
  await expect(page.locator('[data-testid="share-read-instead"]')).toHaveAttribute('href', `https://view.plexiidesk.com/share/${LIVE_TOKEN}?classic=1`)
})

test('SG-12 a desk from a team workspace opens on the desk, by either kind of link', async () => {
  // The owner's live "Lesson Planning" link (2026-11-07) carried its team's
  // org id: unpacked in full, then filtered out of sight -- the page showed
  // the app's Home with no desk. (openTheDesk waits for the desk's own note.)
  test.setTimeout(240_000)
  web = await openShareWeb({ orgId: 'org_777a2068e04f4d2c06' })
  await openTheDesk(web)
  expect(await widgetCount(web)).toBe(2)
  await web.close()
  web = await openShareWeb({ orgId: 'org_777a2068e04f4d2c06' })
  await openTheDesk(web, `/share/l/${LIVE_TOKEN}`)
  expect(await widgetCount(web)).toBe(2)
})

test('SG-13 a room link opens the full app on the room, its desks one click away', async () => {
  // A room shared by "Create public link" used to stay in the old viewer
  // (owner, 2026-11-07: every share link opens the full web app).
  test.setTimeout(180_000)
  web = await openShareWeb()
  const { page } = web
  await page.goto(`https://plexiidesk.com/share/c/${ROOM_TOKEN}`)
  await page.getByRole('button', { name: 'Open the desk' }).click({ timeout: 60_000 })
  await page.locator('[data-testid="desk-sidebar"]').first().waitFor({ timeout: 90_000 })
  await expect(page.locator('[data-testid="share-take-desk"]')).toHaveText('Get Plexii')
  await expect(page.getByText('Math lessons').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('ELA lessons').first()).toBeVisible()
  // Into a desk: looking around, so no gate.
  await page.getByText('Math lessons').first().click()
  await expect(page.locator('[data-widget-id="room-desk-math-note"]').first()).toBeVisible({ timeout: 30_000 })
  expect(await web.gates()).toEqual([])
  expect(realErrors(web)).toEqual([])
  expect(web.escaped).toEqual([])
})
