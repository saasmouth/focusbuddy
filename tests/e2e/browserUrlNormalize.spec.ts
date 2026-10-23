import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Verifies the live wiring of normalizeUrl() through commitUrlBar().
// The <webview> element's loadURL() is intercepted via evaluate() so we can
// capture what URL string the component resolves to without needing real
// network access in the headless Electron runner.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedWebviewAndOpen(window: import('@playwright/test').Page): Promise<string> {
  // Mirror the pattern from browserResolutionPresets.spec.ts exactly:
  // evaluate once to create task+widget together, reload, open the task.
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({
      parentId: null,
      kind: 'task',
      title: 'URL Normalize Test'
    })
    const w = await api.widgets.create({
      taskId: task.id,
      kind: 'webview',
      title: 'test browser',
      content: 'https://example.com',
      x: 100,
      y: 100,
      width: 560,
      height: 400
    })
    return { taskId: task.id, widgetId: w.id }
  })

  await window.reload()
  await window.waitForFunction(
    () => typeof (window as unknown as { api?: unknown }).api === 'object',
    null,
    { timeout: 10_000 }
  )
  const skip = window.getByRole('button', { name: /Continue without account|Skip|Not now/i })
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {})

  await window.getByRole('button', { name: 'URL Normalize Test' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 6_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.widgetId}"]`, { timeout: 8_000 })

  return seeded.widgetId
}

// Helper: locate the address bar input for the given widget id, install a
// loadURL spy on the <webview> element inside that widget, type the query
// string, press Enter, and return whatever loadURL was called with.
// Returns null if loadURL was never called (e.g. normalizeUrl returned null).
async function typeInAddressBarAndCapture(
  window: import('@playwright/test').Page,
  widgetId: string,
  query: string
): Promise<string | null> {
  // Install the spy before we interact with the address bar. The <webview>
  // is a real HTMLElement in the renderer; we replace its loadURL method so
  // any call from commitUrlBar() writes into window.__lastLoad.
  await window.evaluate(({ wid }: { wid: string }) => {
    const frame = document.querySelector(`[data-widget-id="${wid}"]`)
    if (!frame) return
    const wv = frame.querySelector('webview') as HTMLElement & { loadURL?: (u: string) => void }
    if (!wv) return
    ;(window as unknown as Record<string, unknown>).__lastLoad = null
    wv.loadURL = (u: string) => {
      ;(window as unknown as Record<string, unknown>).__lastLoad = u
    }
  }, { wid: widgetId })

  // Find the address-bar input inside this widget's frame. It is a plain
  // text input in the toolbar chrome — not the full-form URL input (that
  // only appears in editing mode). We target it by its placeholder attribute.
  // Since 7ad571c0c the widget and the panel share BrowserSurface, whose
  // address bar is data-testid="browser-address".
  const toolbarInput = window.locator(
    `[data-widget-id="${widgetId}"] [data-testid="browser-address"]`
  ).first()

  await expect(toolbarInput).toBeVisible({ timeout: 5_000 })
  await toolbarInput.click()
  // Select-all then type so we replace any existing value cleanly.
  await toolbarInput.press('Control+a')
  await toolbarInput.fill(query)
  await toolbarInput.press('Enter')

  // Give React's event handler (which is synchronous) a tick to fire.
  await window.waitForTimeout(200)

  const captured = await window.evaluate(() => {
    return (window as unknown as Record<string, unknown>).__lastLoad as string | null
  })
  return captured
}

test('search text in address bar resolves to the pinned engine search URL', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const widgetId = await seedWebviewAndOpen(window)

  const result = await typeInAddressBarAndCapture(window, widgetId, 'best pizza recipes')

  console.log(`[browserUrlNormalize search] loadURL captured: ${result}`)

  // Searches run on the PINNED engine since 7ad571c0c (the widget used to
  // hard-code Google); a fresh profile pins DuckDuckGo (e021bec8).
  expect(result, 'loadURL must be called with the pinned engine search URL').not.toBeNull()
  expect(result).toContain('https://duckduckgo.com/?q=')
  expect(result).toContain('pizza')
})

test('real hostname in address bar resolves to https navigation, not a search', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const widgetId = await seedWebviewAndOpen(window)

  const result = await typeInAddressBarAndCapture(window, widgetId, 'github.com')

  console.log(`[browserUrlNormalize hostname] loadURL captured: ${result}`)

  expect(result, 'loadURL must be called with https://github.com/').not.toBeNull()
  expect(result).toBe('https://github.com/')
  expect(result).not.toContain('duckduckgo.com/?q=')
})
