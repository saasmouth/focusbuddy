import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Card widget rich body acceptance suite.
// Tests A–E from the launch-blocking checklist:
//   A  Rendered view contains <strong> + correct <a> hrefs
//   B  Clicking a link calls openExternal, does NOT enter edit mode
//   C  Click-to-edit: textarea appears, receives focus, blur returns rendered, new text persists
//   D  Persistence: edited body survives a reload
//   E  typecheck + full unit suite pass count (checked inline via the outer run)

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// Seed a card widget with the canonical acceptance-body and navigate to its canvas.
// Returns { taskId, widgetId }.
async function seedCardWidget(
  l: LaunchedApp,
  body: string
): Promise<{ taskId: string; widgetId: string }> {
  const { window } = l
  await waitForReady(window)

  const content = JSON.stringify({
    title: 'T',
    body,
    accent: '#6366f1'
  })

  const seeded = await window.evaluate(
    async ({ content }: { content: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'CardRichTest' })
      const w = await api.widgets.create({
        taskId: t.id,
        kind: 'card' as never,
        title: '',
        content,
        x: 120,
        y: 120,
        width: 340,
        height: 280
      })
      return { taskId: t.id, widgetId: w.id }
    },
    { content }
  )

  // Reload so the DB row is flushed before we navigate.
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /CardRichTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.widgetId}"]`, { timeout: 6_000 })

  return seeded
}

// Read the raw JSON content for a widget directly from the IPC layer.
async function readContent(
  l: LaunchedApp,
  taskId: string,
  widgetId: string
): Promise<string> {
  return l.window.evaluate(
    async ({ tid, wid }: { tid: string; wid: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const all = await api.widgets.listByTask(tid)
      return all.find((w) => w.id === wid)?.content ?? '__NOT_FOUND__'
    },
    { tid: taskId, wid: widgetId }
  )
}

// A — Rendered view: <strong> + correct link hrefs
test('A — rendered body: <strong> for bold, <a> hrefs for bare URL and markdown link', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const body = '**Important** see https://example.org and [docs](https://example.com/d)'
  const { widgetId } = await seedCardWidget(launched, body)

  const rendered = window.locator(`[data-widget-id="${widgetId}"] [data-testid="card-body-rendered"]`)
  await expect(rendered).toBeVisible({ timeout: 5_000 })

  // <strong> must exist and contain "Important".
  const strongEl = rendered.locator('strong').first()
  await expect(strongEl).toBeVisible({ timeout: 4_000 })
  const strongText = await strongEl.textContent()
  console.log('[A] <strong> textContent:', JSON.stringify(strongText))
  expect(strongText).toBe('Important')

  // Collect all <a> hrefs inside the rendered body.
  const hrefs: string[] = await window.evaluate(
    (wid: string) =>
      Array.from(
        document.querySelectorAll(`[data-widget-id="${wid}"] [data-testid="card-body-rendered"] a`)
      ).map((a) => (a as HTMLAnchorElement).href),
    widgetId
  )
  console.log('[A] observed hrefs:', JSON.stringify(hrefs))

  expect(hrefs).toContain('https://example.org/')   // browser normalises with trailing slash
  // Fallback: check for exact href in case no normalisation
  const hasExampleOrg = hrefs.some(
    (h) => h === 'https://example.org' || h === 'https://example.org/'
  )
  expect(hasExampleOrg).toBe(true)

  const hasDocsLink = hrefs.some(
    (h) => h === 'https://example.com/d' || h === 'https://example.com/d/'
  )
  expect(hasDocsLink).toBe(true)

  // Confirm the "docs" link text.
  const docsAnchor = rendered.locator('a', { hasText: 'docs' })
  await expect(docsAnchor).toBeVisible({ timeout: 3_000 })
  const docsHref = await docsAnchor.getAttribute('href')
  console.log('[A] docs link href attribute:', JSON.stringify(docsHref))
  expect(docsHref).toBe('https://example.com/d')
})

// B — Click a link: does NOT enter edit mode; openExternal IPC verified at main-process level
test('B — link click does not enter edit mode; openExternal IPC fires at main-process level', async () => {
  launched = await launchApp()
  const { app, window } = launched

  const body = '**Important** see https://example.org and [docs](https://example.com/d)'
  const { widgetId } = await seedCardWidget(launched, body)

  const rendered = window.locator(`[data-widget-id="${widgetId}"] [data-testid="card-body-rendered"]`)
  await expect(rendered).toBeVisible({ timeout: 5_000 })

  // The contextBridge object is frozen and cannot be monkey-patched from the
  // renderer. Instead, intercept at the main-process level by replacing
  // electron's shell.openExternal with a tracker before the click fires.
  await app.evaluate(({ shell }) => {
    const origOpen = shell.openExternal.bind(shell)
    ;(global as unknown as Record<string, unknown>)._openExternalCalls = []
    shell.openExternal = async (url: string, opts?: Electron.OpenExternalOptions) => {
      ;(global as unknown as { _openExternalCalls: string[] })._openExternalCalls.push(url)
      return origOpen(url, opts)
    }
  })

  // Click the "docs" link.
  const docsLink = rendered.locator('a', { hasText: 'docs' })
  await expect(docsLink).toBeVisible({ timeout: 3_000 })
  await docsLink.click()

  // Give a tick for the IPC round-trip to complete.
  await window.waitForTimeout(400)

  // Verify openExternal was called with the correct URL at the main-process level.
  const captured: string[] = await app.evaluate(
    () => (global as unknown as { _openExternalCalls: string[] })._openExternalCalls ?? []
  )
  console.log('[B] openExternal calls captured (main process):', JSON.stringify(captured))
  expect(captured.some((u) => u === 'https://example.com/d')).toBe(true)

  // The body must still show the rendered view — no textarea.
  const textarea = window.locator(`[data-widget-id="${widgetId}"] textarea`)
  const textareaVisible = await textarea.isVisible().catch(() => false)
  console.log('[B] textarea visible after link click (must be false):', textareaVisible)
  expect(textareaVisible).toBe(false)

  // The rendered div is still present.
  await expect(rendered).toBeVisible({ timeout: 2_000 })
})

// C — Click-to-edit: textarea appears, is focused, blur returns rendered, new text persists
test('C — click body text enters edit mode; blur returns rendered; typed text persists into card JSON', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const body = '**Initial** body text'
  const { taskId, widgetId } = await seedCardWidget(launched, body)

  const rendered = window.locator(`[data-widget-id="${widgetId}"] [data-testid="card-body-rendered"]`)
  await expect(rendered).toBeVisible({ timeout: 5_000 })

  // Click somewhere in the rendered body that is NOT a link.
  const strongEl = rendered.locator('strong').first()
  await expect(strongEl).toBeVisible({ timeout: 3_000 })
  await strongEl.click()

  // A textarea should appear.
  const textarea = window.locator(`[data-widget-id="${widgetId}"] textarea`)
  await expect(textarea).toBeVisible({ timeout: 4_000 })
  console.log('[C] textarea visible after click: true')

  // Verify focus landed in the textarea.
  const isFocused = await window.evaluate(
    (wid: string) => {
      const ta = document.querySelector(`[data-widget-id="${wid}"] textarea`)
      return document.activeElement === ta
    },
    widgetId
  )
  console.log('[C] textarea is focused:', isFocused)
  expect(isFocused).toBe(true)

  // Type new content.
  await textarea.fill('Edited body content')
  await window.waitForTimeout(400)

  // Blur to return to rendered view.
  await textarea.blur()
  await expect(rendered).toBeVisible({ timeout: 4_000 })
  await expect(textarea).not.toBeVisible({ timeout: 3_000 })
  console.log('[C] rendered view restored after blur: true')

  // Wait for the 300 ms debounced save to flush.
  await window.waitForTimeout(600)

  // Read back the persisted JSON.
  const stored = await readContent(launched, taskId, widgetId)
  console.log('[C] stored content after edit:', JSON.stringify(stored))
  const parsed = JSON.parse(stored) as { body?: string }
  expect(parsed.body).toBe('Edited body content')
})

// D — Persistence: edited body survives a full reload
test('D — edited body persists through app reload', async () => {
  launched = await launchApp()
  const { window } = launched

  await waitForReady(window)
  const body = '**Initial** body text'
  const { taskId, widgetId } = await seedCardWidget(launched, body)

  const rendered = window.locator(`[data-widget-id="${widgetId}"] [data-testid="card-body-rendered"]`)
  await expect(rendered).toBeVisible({ timeout: 5_000 })

  // Enter edit mode.
  const strongEl = rendered.locator('strong').first()
  await strongEl.click()
  const textarea = window.locator(`[data-widget-id="${widgetId}"] textarea`)
  await expect(textarea).toBeVisible({ timeout: 4_000 })
  await textarea.fill('Persisted after reload')
  await window.waitForTimeout(400)
  await textarea.blur()
  await window.waitForTimeout(600)

  // Snapshot before reload.
  const before = await readContent(launched, taskId, widgetId)
  console.log('[D] content before reload:', JSON.stringify(before))
  const parsedBefore = JSON.parse(before) as { body?: string }
  expect(parsedBefore.body).toBe('Persisted after reload')

  // Reload the app and re-navigate to the task canvas.
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /CardRichTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForSelector(`[data-widget-id="${widgetId}"]`, { timeout: 6_000 })

  // Snapshot after reload.
  const after = await readContent(launched, taskId, widgetId)
  console.log('[D] content after reload:', JSON.stringify(after))
  const parsedAfter = JSON.parse(after) as { body?: string }
  expect(parsedAfter.body).toBe('Persisted after reload')

  // The rendered view should show the new text (not the original markdown).
  const renderedAfter = window.locator(`[data-widget-id="${widgetId}"] [data-testid="card-body-rendered"]`)
  await expect(renderedAfter).toBeVisible({ timeout: 5_000 })
  const renderedText = await renderedAfter.textContent()
  console.log('[D] rendered textContent after reload:', JSON.stringify(renderedText))
  expect(renderedText).toContain('Persisted after reload')
})
