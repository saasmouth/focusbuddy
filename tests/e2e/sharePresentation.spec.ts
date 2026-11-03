// The sender's half of "how a link presents the desk", in the real app:
// the share sheet's view choice and website list, and the bundle the main
// process packs from them (shared/sitePresentation.ts).
//
// The websites are a local server's pages with known framing headers, so the
// hidden-window visit (main/sitePreviewLoader.ts) runs for real without the
// internet: one page allows framing, one forbids it. Minting the link needs a
// signed-in account and Signal, so the packing is asked for directly through
// the same IPC channel the mint uses -- the bundle is what the link would carry.
import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'http'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { openDeskShareSheet } from './_liveShareHelpers'

let server: Server
let base = ''
let launched: LaunchedApp | null = null

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }
    if (path === '/deny') headers['x-frame-options'] = 'DENY'
    res.writeHead(path === '/allow' || path === '/deny' ? 200 : 404, headers)
    res.end(`<!doctype html><title>${path}</title><body style="background:#dfe9ff;font:28px sans-serif"><h1>Page ${path}</h1></body>`)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

test.afterAll(async () => {
  await launched?.dispose()
  await new Promise<void>((r) => server.close(() => r()))
})

test('the share sheet decides each website, and the bundle carries the view and the pictures', async () => {
  test.setTimeout(180_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async (b) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Presentation desk' } as never)) as unknown as { id: string }
    const make = async (content: string, y: number): Promise<string> =>
      (
        (await api.widgets.create({
          taskId: desk.id, kind: 'webview', title: '', content, x: 80, y, width: 900, height: 560, color: null
        } as never)) as unknown as { id: string }
      ).id
    return { desk: desk.id, allow: await make(`${b}/allow`, 80), deny: await make(`${b}/deny`, 700) }
  }, base)

  await window.reload()
  await waitForReady(window)
  await openDeskShareSheet(window, ids.desk)
  await window.locator('[data-testid="share-audience-link"]').click()

  // The view choice: Canvas, Workcentre, Columns; only that view unless allowed.
  const panel = window.locator('[data-testid="share-presentation"]')
  await expect(panel).toBeVisible()
  await expect(window.locator('[data-testid="share-view-canvas"]')).toHaveAttribute('aria-checked', 'true')
  await window.locator('[data-testid="share-view-workcentre"]').click()
  await expect(window.locator('[data-testid="share-view-workcentre"]')).toHaveAttribute('aria-checked', 'true')
  await expect(window.locator('[data-testid="share-view-switch"]')).not.toBeChecked()

  // Each website visited in a clean window: the framable one live, the other a picture.
  await expect(window.locator(`[data-testid="share-site-${ids.allow}"]`)).toHaveAttribute('data-site-shows', 'live', { timeout: 60_000 })
  await expect(window.locator(`[data-testid="share-site-${ids.deny}"]`)).toHaveAttribute('data-site-shows', 'picture', { timeout: 60_000 })
  await expect(window.locator(`[data-testid="share-site-${ids.deny}"] img`).first()).toHaveAttribute('src', /^data:image\/jpeg;base64,/)
  await expect(window.locator('[data-testid="share-sites-progress"]')).toHaveText('')
  await panel.screenshot({ path: test.info().outputPath('share-presentation-panel.png') })
  await window.screenshot({ path: test.info().outputPath('share-sheet-window.png') })
  // Nothing in the sheet is wider than the sheet: the site rows truncate.
  const overflow = await panel.evaluate((el) => {
    let n: HTMLElement | null = el as HTMLElement
    while (n && n.scrollWidth <= n.clientWidth + 1) n = n.parentElement
    return n ? { tag: n.tagName, cls: n.className.slice(0, 80), scroll: n.scrollWidth, client: n.clientWidth } : null
  })
  expect(overflow).toBeNull()

  // A choice sticks per desk.
  await window.locator(`[data-testid="share-site-choice-${ids.allow}"]`).selectOption('picture')
  await expect(window.locator(`[data-testid="share-site-${ids.allow}"]`)).toHaveAttribute('data-site-shows', 'picture')
  const remembered = await window.evaluate((d) => JSON.parse(localStorage.getItem(`fb.sharePresentation.v1.${d}`) ?? 'null'), ids.desk)
  expect(remembered).toEqual({ view: 'workcentre', lockView: true, sites: { [ids.allow]: 'picture' } })

  // What a link made now would carry, packed by the real main process.
  const packed = await window.evaluate(
    async ({ d, allow }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const t0 = Date.now()
      const res = await api.shares.buildDeskBundle(d, {
        view: 'workcentre',
        lockView: true,
        sites: { [allow]: 'auto' },
        embedderOrigin: 'https://plexiidesk.com',
        layoutUserId: 'local'
      })
      return { res, ms: Date.now() - t0 }
    },
    { d: ids.desk, allow: ids.allow }
  )
  expect(packed.res.ok).toBe(true)
  const bundle = JSON.parse((packed.res as { json: string }).json)
  expect(bundle.presentation.view).toBe('workcentre')
  expect(bundle.presentation.lockView).toBe(true)
  expect(bundle.presentation.layoutUserId).toBe('local')
  expect(bundle.presentation.sites[ids.allow]).toEqual({ url: `${base}/allow`, show: 'live' })
  const pic = bundle.presentation.sites[ids.deny]
  expect(pic.show).toBe('picture')
  expect(pic.picture.id).toBe(`sitepic-${ids.deny}`)
  expect(pic.picture.data.startsWith('/9j/')).toBe(true) // a JPEG
  expect(pic.picture.sizeBytes).toBeGreaterThan(1000)
  // Not a Drive file, and the visits were reused from the sheet's preview.
  expect(bundle.files).toEqual([])
  expect(packed.ms).toBeLessThan(5_000)
  expect((packed.res as { sitesOmitted: unknown[] }).sitesOmitted).toEqual([])
})
