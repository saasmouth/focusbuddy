import { chromium } from 'playwright'
const APP = 'https://plexii-cloud.vercel.app'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1300, height: 880 } })).newPage()
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errs.push('[c] ' + m.text().slice(0, 160)) })
await page.goto(APP, { waitUntil: 'domcontentloaded' }); await wait(3500)
await page.click('text=Create an account instead')
await page.fill('input[type=email]', `click2-${Date.now()}@example.com`)
await page.fill('input[type=password]', 'correct-horse-battery-staple')
await page.click('button[type=submit]'); await wait(16000)
let s = page.locator('text=Skip for now'); if (await s.count()) { await s.click(); await wait(2500) }
await page.click('text=New Desk'); await wait(4000)
await page.click('text=Create Desk'); await wait(7000)
// Leave the desk, then try to get back into it.
await page.click('text=All desks'); await wait(3000)

const where = () => page.evaluate(() => {
  const h = document.querySelector('h1,h2')?.textContent ?? ''
  const canvas = !!document.querySelector('[class*="fb-app-shell"]') && /Drag an object|Free canvas|Add to room/.test(document.body.innerText)
  return { heading: h.trim().slice(0, 30), onDesk: canvas }
})
console.log(`  before: ${JSON.stringify(await where())}`)

const card = page.locator('text=Empty desk').first()
console.log(`  card found: ${await card.count() > 0}`)
await card.click(); await wait(2500)
console.log(`  after single click: ${JSON.stringify(await where())}`)
await card.dblclick().catch((e) => console.log('    dblclick threw:', e.message.slice(0, 60))); await wait(4000)
console.log(`  after double click: ${JSON.stringify(await where())}`)
await page.screenshot({ path: process.argv[2] + '/23-after-dblclick.png' })

// Right-click for a context menu.
await card.click({ button: 'right' }).catch(() => {}); await wait(1500)
const menu = await page.evaluate(() => {
  const els = [...document.querySelectorAll('[role="menu"],[class*="context"],[data-testid*="menu"]')]
  return { count: els.length, text: els.map((e) => e.textContent?.trim().slice(0, 60)).slice(0, 2) }
})
console.log(`  right-click menus in DOM: ${JSON.stringify(menu)}`)
await page.screenshot({ path: process.argv[2] + '/24-right-click.png' })
console.log(`  page errors: ${errs.length}`)
for (const e of [...new Set(errs)].slice(0, 5)) console.log(`      ${e}`)
await browser.close()
