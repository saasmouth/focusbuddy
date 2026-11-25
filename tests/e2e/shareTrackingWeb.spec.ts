// The desk share tracker on the share page (src/web/api/shareTracking.ts).
//
// Owner, 2026-11-19: "add a tracker to shared decks so we can see who downloads
// and signs up from desk sharing, and who shared it, and which desk was shared."
//
// What the page must do, first party only, to api.plexiidesk.com:
//   ST-1  a view, once per tab session: a reload is the same visitor;
//   ST-2  a download click each time the installer starts ("Download again"
//         too), with the platform;
//   ST-3  the download starts even when the tracker fails (an error, or no
//         answer at all), and the page shows no error;
//   ST-4  on a phone: the view and the press of "Send me the download link"
//         say 'phone', and the gate offers the website's sign-up carrying
//         this link (?share=<token>), which only ever starts the free trial.
// And nothing else leaves: every other request is refused and recorded
// (_shareWebHarness.ts), Google included.
//
// The share page is the real web build: VITE_WEB_BASE=/share/ npm run web:build
import { test, expect } from '@playwright/test'
import { assertWebBuild, openShareWeb, openTheDesk, MAC_INSTALLER, TOKEN, type ShareWeb } from './_shareWebHarness'

let web: ShareWeb | null = null
test.beforeAll(() => assertWebBuild())
test.afterEach(async () => {
  if (web) await web.close()
  web = null
})

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const gate = (w: ShareWeb) => w.page.locator('[data-testid="share-gate"]')
const of = (w: ShareWeb, event: string) => w.beacons.filter((b) => b.body.event === event)

test('ST-1 opening a shared desk sends one view per tab session, and nothing else leaves', async () => {
  test.setTimeout(180_000)
  web = await openShareWeb()
  await openTheDesk(web)
  await expect.poll(() => of(web!, 'view').length).toBe(1)
  const [view] = of(web, 'view')
  expect(view.token).toBe(TOKEN)
  // A string body, which a beacon sends as text/plain: no preflight.
  expect(view.contentType).toMatch(/^text\/plain/)
  // Exactly the three fields the server takes, and an id that says nothing.
  expect(Object.keys(view.body).sort()).toEqual(['event', 'platform', 'visitorId'])
  expect(view.body.platform).toBe('mac')
  expect(view.body.visitorId).toMatch(/^[0-9a-f]{32}$/)

  // The same tab, reloaded: the same visitor, already counted.
  await web.page.reload()
  await web.page.locator('[data-testid="share-take-desk"]').waitFor({ timeout: 90_000 })
  await web.page.waitForTimeout(1500)
  expect(of(web, 'view')).toHaveLength(1)
  expect(of(web, 'download_click')).toHaveLength(0)
  expect(web.escaped, 'something reached the real world').toEqual([])
  expect(web.errors).toEqual([])
})

test('ST-2 every installer start is a download click, with the platform', async () => {
  test.setTimeout(180_000)
  web = await openShareWeb()
  await openTheDesk(web)
  const { page } = web
  await page.locator('[data-testid="share-take-desk"]').click()
  await expect(gate(web)).toBeVisible()
  await expect.poll(() => web!.downloads).toEqual([MAC_INSTALLER])
  await expect.poll(() => of(web!, 'download_click').length).toBe(1)
  expect(of(web, 'download_click')[0].body).toMatchObject({ event: 'download_click', platform: 'mac' })

  // "Download again" is another download, and another click.
  await page.locator('[data-testid="share-gate-download"]').getByRole('button', { name: 'Download again' }).click()
  await expect.poll(() => web!.downloads.length).toBe(2)
  await expect.poll(() => of(web!, 'download_click').length).toBe(2)

  // Closing and reopening the gate starts nothing new, so counts nothing new.
  await page.locator('[data-testid="share-gate-close"]').click()
  await page.locator('[data-testid="share-take-desk"]').click()
  await expect(gate(web)).toBeVisible()
  await page.waitForTimeout(800)
  expect(web.downloads).toHaveLength(2)
  expect(of(web, 'download_click')).toHaveLength(2)
  // One visitor throughout.
  expect(new Set(web.beacons.map((b) => b.body.visitorId)).size).toBe(1)
  expect(web.escaped).toEqual([])
  expect(web.errors).toEqual([])
})

for (const fails of ['error', 'abort'] as const) {
  test(`ST-3 the download starts when the tracker ${fails === 'error' ? 'answers with an error' : 'cannot be reached'}`, async () => {
    test.setTimeout(180_000)
    web = await openShareWeb({ trackFails: fails })
    await openTheDesk(web)
    const { page } = web
    await page.locator('[data-testid="share-take-desk"]').click()
    await expect(gate(web)).toBeVisible()
    await expect.poll(() => web!.downloads).toEqual([MAC_INSTALLER])
    await expect(page.locator('[data-testid="share-gate-download"]')).toContainText('is downloading.')
    // It was tried (and failed) after the download started, never before it.
    await expect.poll(() => of(web!, 'download_click').length).toBeGreaterThanOrEqual(1)
    expect(web.errors).toEqual([])
    expect(web.escaped).toEqual([])
  })
}

test('ST-4 on a phone: the view and the download link say phone, and sign-up carries this link', async () => {
  test.setTimeout(180_000)
  web = await openShareWeb({ userAgent: IPHONE })
  await openTheDesk(web)
  const { page } = web
  await expect.poll(() => of(web!, 'view').length).toBe(1)
  expect(of(web, 'view')[0].body.platform).toBe('phone')

  await page.locator('[data-testid="share-take-desk"]').click()
  await expect(page.locator('[data-testid="share-gate-phone"]')).toBeVisible()
  expect(of(web, 'download_click')).toHaveLength(0)

  // The website's sign-up, carrying this link, in a new tab.
  const signup = page.locator('[data-testid="share-gate-signup"]')
  await expect(signup).toHaveText('Or create your account now')
  await expect(signup).toHaveAttribute('href', `https://plexiidesk.com/account/signup?share=${TOKEN}`)
  await expect(signup).toHaveAttribute('target', '_blank')

  // Pressing "Send me the download link" counts (the new tab it opens is held
  // here, so nothing leaves; the press itself is what is counted).
  await page.evaluate(() => {
    window.addEventListener('click', (e) => {
      if ((e.target as Element | null)?.closest?.('[data-testid="share-gate-phone"]')) e.preventDefault()
    }, true)
  })
  await page.locator('[data-testid="share-gate-phone"]').click()
  await expect.poll(() => of(web!, 'download_click').length).toBe(1)
  expect(of(web, 'download_click')[0].body.platform).toBe('phone')
  expect(web.downloads).toEqual([])
  expect(web.escaped).toEqual([])
  expect(web.errors).toEqual([])
})
