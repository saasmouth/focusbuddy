import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// URL-drop E2E: dragging a browser tab / link onto the canvas creates a webview widget.
//
// Playwright's native mouse-drag does not populate dataTransfer.getData() in
// the Electron renderer — the same limitation documented in dragDrop.spec.ts.
// We dispatch synthetic DragEvents from within window.evaluate(), building the
// DataTransfer entirely inside the page context, and pass any dynamic values
// (URL strings, MIME types) as serialisable parameters. The approach follows
// exactly what dragDrop.spec.ts does for Connected-App drags.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ─── seed helper ──────────────────────────────────────────────────────────────

/** Creates a task, reloads, opens it so the canvas mounts, and returns its id. */
async function seedAndOpenTask(window: import('@playwright/test').Page): Promise<string> {
  const taskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'URL Drop Test Task' })
    return task.id
  })

  // Reload so the node store hydrates from the freshly-written DB row.
  await window.reload()
  await waitForReady(window)

  await expect(
    window.getByRole('button', { name: 'URL Drop Test Task' }).first()
  ).toBeVisible({ timeout: 6_000 })
  await window.getByRole('button', { name: 'URL Drop Test Task' }).first().click()

  // Canvas only mounts once activeTaskId is set (clicking the task routes to it).
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 6_000 })
  return taskId
}

// ─── drop dispatcher ──────────────────────────────────────────────────────────

/**
 * Dispatches dragover + drop on the canvas surface carrying the given MIME
 * entries. All values are plain strings so they cross the evaluate boundary
 * without issue. Returns the dispatch outcome for assertions in the caller.
 */
async function dispatchUrlDrop(
  window: import('@playwright/test').Page,
  mimeEntries: Array<{ type: string; data: string }>
): Promise<{ found: boolean; message: string }> {
  return window.evaluate((entries) => {
    const dropTarget = document.querySelector('[data-canvas-surface="true"]')
    if (!dropTarget) return { found: false, message: 'no [data-canvas-surface] element' }

    const rect = dropTarget.getBoundingClientRect()
    const clientX = rect.left + rect.width / 2
    const clientY = rect.top + rect.height / 2

    const dt = new DataTransfer()
    for (const { type, data } of entries) {
      dt.setData(type, data)
    }
    dt.effectAllowed = 'copy'

    dropTarget.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY })
    )
    dropTarget.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX, clientY })
    )

    return { found: true, message: 'drop dispatched' }
  }, mimeEntries)
}

// ─── tests ────────────────────────────────────────────────────────────────────

test('dropping a text/uri-list URL creates a webview widget with that URL', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const taskId = await seedAndOpenTask(window)
  const dropUrl = 'https://example.com/article'

  const result = await dispatchUrlDrop(window, [
    { type: 'text/uri-list', data: dropUrl },
    { type: 'text/plain', data: dropUrl }
  ])
  expect(result.found, result.message).toBe(true)

  // Give the async createWidget IPC call time to round-trip.
  await window.waitForTimeout(1000)

  const widgets = await window.evaluate(async ({ tid }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.widgets.listByTask(tid)
  }, { tid: taskId })

  const webviews = widgets.filter((w) => w.kind === 'webview')
  expect(
    webviews.length,
    `expected >= 1 webview; widget kinds: ${JSON.stringify(widgets.map((w) => w.kind))}`
  ).toBeGreaterThanOrEqual(1)

  const created = webviews.find((w) => w.content === dropUrl)
  expect(
    created,
    `expected webview with content="${dropUrl}"; got: ${JSON.stringify(webviews.map((w) => ({ kind: w.kind, content: w.content })))}`
  ).toBeDefined()

  // Size: the Browser's catalogue default, fitted to the view.
  //
  // Two deliberate changes since this spec asserted 560 x 400:
  //   - c4fed905 (2.5.32) then b245754a: Browser opens at Desktop size,
  //     1920 x 1080 (widgetCatalog.ts, "Open at Desktop size").
  //   - 364e801d "Cap EVERY new widget to the view, in one place": an untouched
  //     default is scaled (aspect kept, never enlarged) to at most 3/4 of the
  //     visible canvas, measured in canvas units at the current zoom
  //     (lib/fitDroppedWidget.ts: DROP_VIEW_FRACTION 0.75, floor 240 x 160).
  // So the exact size is derived from the canvas the drop landed on.
  const view = await window.evaluate(() => {
    const surface = document.querySelector('[data-canvas-surface="true"]') as HTMLElement
    const r = surface.getBoundingClientRect()
    const pct = document.querySelector('[data-testid="zoom-controls"]')?.textContent?.match(/(\d+)%/)
    return { w: r.width, h: r.height, zoom: pct ? Number(pct[1]) / 100 : NaN }
  })
  expect(view.zoom, 'zoom read from the zoom pill').toBeGreaterThan(0)
  const DEFAULT_W = 1920
  const DEFAULT_H = 1080
  const scale = Math.min(1, ((view.w / view.zoom) * 0.75) / DEFAULT_W, ((view.h / view.zoom) * 0.75) / DEFAULT_H)
  const expectedW = scale >= 1 ? DEFAULT_W : Math.max(240, Math.round(DEFAULT_W * scale))
  const expectedH = scale >= 1 ? DEFAULT_H : Math.max(160, Math.round(DEFAULT_H * scale))
  expect(created!.width, `view ${JSON.stringify(view)}`).toBe(expectedW)
  expect(created!.height, `view ${JSON.stringify(view)}`).toBe(expectedH)

  // Position must be plausibly on-canvas, not wildly off-screen.
  expect(created!.x).toBeGreaterThan(-5000)
  expect(created!.y).toBeGreaterThan(-5000)

  console.log(
    `[urlDrop step1] PASS kind=${created!.kind} content=${created!.content} x=${created!.x} y=${created!.y} w=${created!.width} h=${created!.height}`
  )
})

test('multi-line uri-list with a leading comment line picks the first real URL', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const taskId = await seedAndOpenTask(window)
  // URLs already in the form the browser reports after loading them. The drop
  // stores the raw line it picked (lib/dropUrl.ts), but the browser widget then
  // persists the LIVE url back into widget.content on every navigation
  // (WebViewWidget persistNavUrl, there since the initial commit), and Chromium
  // canonicalises a bare origin to a trailing slash. With a bare
  // "https://news.ycombinator.com" the stored value therefore depended on
  // whether the page had loaded inside the wait: the red run read back
  // "https://news.ycombinator.com/". A path URL is its own canonical form, so
  // the value read back is the one the drop picked, loaded or not.
  const expectedUrl = 'https://example.com/first-real-url'

  const result = await dispatchUrlDrop(window, [
    {
      type: 'text/uri-list',
      // RFC 2483 uri-list: comment line first, then two URLs — only the first
      // non-comment URL should be selected.
      data: '# comment line\r\nhttps://example.com/first-real-url\r\nhttps://example.org/second-url'
    }
  ])
  expect(result.found, result.message).toBe(true)
  await window.waitForTimeout(1000)

  const widgets = await window.evaluate(async ({ tid }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.widgets.listByTask(tid)
  }, { tid: taskId })

  const match = widgets.find((w) => w.kind === 'webview' && w.content === expectedUrl)
  expect(
    match,
    `expected webview with content="${expectedUrl}"; got: ${JSON.stringify(widgets.map((w) => ({ kind: w.kind, content: w.content })))}`
  ).toBeDefined()

  // Exactly one browser, and never one for the second URL in the list.
  const webviews = widgets.filter((w) => w.kind === 'webview')
  expect(webviews.map((w) => w.content)).toEqual([expectedUrl])

  console.log(`[urlDrop step4] PASS multi-line uri-list selected URL="${match!.content}"`)
})

test('plain text that is not a URL creates no new widget (negative case)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const taskId = await seedAndOpenTask(window)

  // Snapshot widget count before the drop.
  const before = await window.evaluate(async ({ tid }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgets.listByTask(tid)).length
  }, { tid: taskId })

  const result = await dispatchUrlDrop(window, [
    { type: 'text/plain', data: 'hello world' }
  ])
  expect(result.found, result.message).toBe(true)
  await window.waitForTimeout(500)

  const after = await window.evaluate(async ({ tid }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgets.listByTask(tid)).length
  }, { tid: taskId })

  expect(
    after,
    `non-URL text drop must not create a widget; before=${before} after=${after}`
  ).toBe(before)

  console.log(`[urlDrop step5] PASS non-URL text drop widget count before=${before} after=${after}`)
})

test('app window does not navigate away after a URL drop', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  await seedAndOpenTask(window)

  const urlBefore = window.url()
  const titleBefore = await window.title()

  const result = await dispatchUrlDrop(window, [
    { type: 'text/uri-list', data: 'https://example.com/replace-app' },
    { type: 'text/plain', data: 'https://example.com/replace-app' }
  ])
  expect(result.found, result.message).toBe(true)
  await window.waitForTimeout(600)

  const urlAfter = window.url()
  const titleAfter = await window.title()

  expect(urlAfter).not.toContain('example.com')
  expect(titleAfter).toBe(titleBefore)

  console.log(
    `[urlDrop step6] PASS url unchanged="${urlAfter === urlBefore}" title unchanged="${titleAfter === titleBefore}"`
  )
})
