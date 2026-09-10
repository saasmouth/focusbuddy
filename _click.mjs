import { chromium } from 'playwright'
const APP = 'https://plexii-cloud.vercel.app'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1300, height: 880 } })).newPage()
const errs = [], warns = []
page.on('pageerror', (e) => errs.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errs.push('[c] ' + m.text().slice(0, 140)); if (m.type() === 'warning') warns.push(m.text().slice(0, 90)) })
await page.goto(APP, { waitUntil: 'domcontentloaded' }); await wait(3500)
await page.click('text=Create an account instead')
await page.fill('input[type=email]', `click-${Date.now()}@example.com`)
await page.fill('input[type=password]', 'correct-horse-battery-staple')
await page.click('button[type=submit]'); await wait(16000)
let s = page.locator('text=Skip for now'); if (await s.count()) { await s.click(); await wait(2500) }

// Create a desk through the UI, which should open it.
await page.click('text=New Desk'); await wait(4000)
const t = page.locator('input[type=text]').first(); if (await t.count()) await t.fill('Click test')
await page.click('text=Create Desk'); await wait(7000)
const openedTitle = await page.evaluate(() => document.body.innerText.slice(0, 120).replace(/\n+/g, ' | '))
console.log(`  after Create Desk: ${openedTitle}`)

// Go back to the desk list and try to reopen it the way a person would.
const rooms = page.locator('text=All desks').first()
if (await rooms.count()) { await rooms.click(); await wait(3000) }
const items = await page.evaluate(() => document.body.innerText.match(/(\d+) items?/)?.[0] ?? 'no count')
console.log(`  All desks shows: ${items}`)

const card = page.locator('text=Click test').first()
console.log(`  desk card present: ${await card.count() > 0}`)
if (await card.count()) {
  await card.click(); await wait(2500)
  const afterSingle = await page.evaluate(() => document.body.innerText.slice(0, 80).replace(/\n+/g, ' | '))
  console.log(`  after single click: ${afterSingle}`)
  await card.dblclick().catch(() => {}); await wait(3500)
  const afterDouble = await page.evaluate(() => document.body.innerText.slice(0, 80).replace(/\n+/g, ' | '))
  console.log(`  after double click: ${afterDouble}`)
  await card.click({ button: 'right' }).catch(() => {}); await wait(1500)
  const menu = await page.evaluate(() => {
    const txt = document.body.innerText
    return /Open|Rename|Delete|Duplicate/.test(txt.slice(0, 500)) ? 'menu-like text present' : 'no menu'
  })
  console.log(`  after right click: ${menu}`)
}
await page.screenshot({ path: process.argv[2] + '/22-click.png' })
console.log(`  page errors: ${errs.length}`)
for (const e of [...new Set(errs)].slice(0, 6)) console.log(`      ${e}`)
console.log(`  distinct warnings: ${[...new Set(warns)].length}`)
for (const w of [...new Set(warns)].slice(0, 3)) console.log(`      ${w}`)
await browser.close()
