// Manual end-to-end verification of the cloud runtime.
//
// Signs up a NEW account on the configured Signal server, drives the browser
// build through its real sign-in screen, creates a desk and two widgets through
// window.api, waits for the app's own sync loop to push them, and prints what
// the server then holds. The recorded payload is what tests/fixtures/
// cloudRoundTripItems.json came from, and tests/unit/cloudDesktopRoundTrip.test.ts
// replays it through the desktop's applyRemote to close the loop.
//
// This is a manual tool, not part of the suite: it needs a running preview
// server and it creates a real account on whichever Signal it is pointed at.
//
//   npx vite build --config vite.web.config.ts
//   npx vite preview --config vite.web.config.ts --port 5180 &
//   TEST_EMAIL=... TEST_PASSWORD=... node scripts/verify-cloud-roundtrip.mjs <out-dir>
import { chromium } from 'playwright'
import { writeFileSync } from 'fs'

const OUT = process.argv[2]
const EMAIL = process.env.TEST_EMAIL
const PASSWORD = process.env.TEST_PASSWORD
const SIGNAL = 'https://focusbuddy-signal.fly.dev'

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

await page.goto('http://localhost:5180/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)
await page.click('text=Create an account instead')
await page.fill('input[type=email]', EMAIL)
await page.fill('input[type=password]', PASSWORD)
await page.click('button[type=submit]')
await page.waitForTimeout(12000)

// Dismiss onboarding so the desk surface is what gets photographed.
const skip = page.locator('text=Skip for now')
if (await skip.count()) { await skip.click(); await page.waitForTimeout(2500) }

// Create a desk and two widgets through the same api the UI uses.
const created = await page.evaluate(async () => {
  const api = window.api
  const desk = await api.nodes.create({ parentId: null, kind: 'folder', title: 'Cloud round-trip desk' })
  const note = await api.widgets.create({
    taskId: desk.id, kind: 'sticky', title: 'Written in the browser',
    content: 'This widget was created in a browser tab and must arrive on the desktop.',
    x: 120, y: 140, width: 320, height: 220
  })
  const second = await api.widgets.create({
    taskId: desk.id, kind: 'markdown', title: 'Second widget',
    content: '# Round trip\n\nCreated by the cloud runtime.', x: 480, y: 140, width: 360, height: 260
  })
  return { deskId: desk.id, deskTitle: desk.title, noteId: note.id, secondId: second.id }
})
console.log(`  created in browser: desk ${created.deskId} + 2 widgets`)

// Let the app's own sync loop push it (nudge is debounced; interval is 20s).
await page.waitForTimeout(26000)
await page.screenshot({ path: `${OUT}/04-desk-in-browser.png` })

const token = await page.evaluate(() => localStorage.getItem('plexii.session.token'))
const pushed = await page.evaluate(async () => {
  const p = await window.api.workspaceSync.pending()
  return { stillPending: p.upserts.length + p.deletes.length, cursor: await window.api.workspaceSync.getCursor() }
})
console.log(`  after sync: ${pushed.stillPending} items still pending, local cursor ${pushed.cursor}`)

writeFileSync(`${OUT}/console2.log`, logs.join('\n'))
await browser.close()

// What the server actually holds for this account.
const res = await fetch(`${SIGNAL}/workspace/sync?since=0`, { headers: { authorization: `Bearer ${token}` } })
const body = await res.json()
const items = body.items ?? []
console.log(`  server /workspace/sync -> ${res.status}, ${items.length} items`)
for (const it of items) {
  console.log(`      ${it.itemType.padEnd(8)} ${it.id}  rev ${it.rev}  ${JSON.stringify(it.body?.title ?? '').slice(0, 46)}`)
}
writeFileSync(`${OUT}/server-items.json`, JSON.stringify({ created, items }, null, 2))
