import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Live wires: a link is now a typed, optionally-reactive pipe.
//  - default type is 'context' (passive)
//  - the wire editor changes type + verb and persists them
//  - a 'mirror' wire copies source content into the target on change (proves
//    the reactive engine end to end, no API key needed)
//  - a 'transform' wire with no API key fails gracefully and visibly

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seed(window: LaunchedApp['window']): Promise<{
  taskId: string
  srcId: string
  tgtId: string
  linkId: string
}> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Wire task' })
    const src = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'src',
      content: 'ALPHA',
      x: 120,
      y: 180,
      width: 220,
      height: 180
    })
    const tgt = await api.widgets.create({
      taskId: task.id,
      kind: 'sticky',
      title: 'tgt',
      content: '',
      x: 520,
      y: 180,
      width: 220,
      height: 180
    })
    const link = await api.widgetLinks.create(src.id, tgt.id, task.id)
    return { taskId: task.id, srcId: src.id, tgtId: tgt.id, linkId: link!.id }
  })
}

test('a new wire defaults to context and the editor changes + persists its type/verb', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await seed(window)

  // Default type is context.
  const initial = await window.evaluate(async (taskId: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const links = await api.widgetLinks.listByTask(taskId)
    return links[0]?.type
  }, ids.taskId)
  expect(initial).toBe('context')

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Wire task/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)

  // Open the wire editor from its badge, switch to transform, set a verb.
  await window.locator(`[data-testid="wire-badge-${ids.linkId}"]`).click()
  await expect(window.locator('[data-testid="wire-editor"]')).toBeVisible()
  await window.locator('[data-testid="wire-type-transform"]').click()
  await window.locator('[data-testid="wire-verb-input"]').fill('extract action items')
  await window.locator('[data-testid="wire-verb-input"]').blur()
  await window.waitForTimeout(300)

  const after = await window.evaluate(async (taskId: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const links = await api.widgetLinks.listByTask(taskId)
    return { type: links[0]?.type, verb: links[0]?.verb }
  }, ids.taskId)
  expect(after.type).toBe('transform')
  expect(after.verb).toBe('extract action items')
})

test('a mirror wire copies source content into the target on change', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await seed(window)

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Wire task/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)

  // Set the wire to mirror.
  await window.locator(`[data-testid="wire-badge-${ids.linkId}"]`).click()
  await window.locator('[data-testid="wire-type-mirror"]').click()
  await window.waitForTimeout(200)

  // Edit the SOURCE sticky, then blur so the store update fires the engine.
  // A sticky with content renders until clicked (70574c92); the click opens the
  // textarea, which takes focus.
  await window.locator(`[data-widget-id="${ids.srcId}"] .fb-sticky-rendered`).click()
  const srcArea = window.locator(`[data-widget-id="${ids.srcId}"] textarea`)
  await expect(srcArea).toBeFocused()
  await srcArea.fill('MIRRORED-PAYLOAD')
  await srcArea.blur()

  // The wire visibly "fires" (electric pulse) when it delivers — the firing
  // group carries data-firing while the spark animates.
  await expect
    .poll(() => window.locator('[data-link-line][data-firing]').count(), {
      timeout: 6_000,
      intervals: [150, 250, 400]
    })
    .toBeGreaterThan(0)

  // Engine debounce (900ms) + write. Poll the target content via the API.
  await expect
    .poll(
      async () =>
        window.evaluate(
          async ({ taskId, tgtId }: { taskId: string; tgtId: string }) => {
            const api = (window as unknown as { api: typeof window.api }).api
            const ws = await api.widgets.listByTask(taskId)
            return ws.find((w) => w.id === tgtId)?.content
          },
          { taskId: ids.taskId, tgtId: ids.tgtId }
        ),
      { timeout: 6_000, intervals: [300, 500, 800] }
    )
    .toBe('MIRRORED-PAYLOAD')
})

test('a transform wire runs on demand and settles without crashing (key-agnostic)', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const ids = await seed(window)

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Wire task/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  await window.waitForTimeout(400)

  await window.locator(`[data-testid="wire-badge-${ids.linkId}"]`).click()
  await window.locator('[data-testid="wire-type-transform"]').click()
  await window.locator('[data-testid="wire-verb-input"]').fill('summarize the source in one short line')
  // Record every text the button shows from here on. Without a key (or behind the
  // e2e net guard) the call fails in milliseconds, so "Running…" can come and go
  // between two polls; a poll for it was a race, the observer is not.
  await window.evaluate(() => {
    const btn = document.querySelector('[data-testid="wire-run-now"]')!
    const w = window as unknown as { __wireRunTexts: string[] }
    w.__wireRunTexts = []
    new MutationObserver(() => w.__wireRunTexts.push(btn.textContent ?? '')).observe(btn, {
      subtree: true,
      childList: true,
      characterData: true
    })
  })
  await window.locator('[data-testid="wire-run-now"]').click()

  // The path fires: the button enters its running state. (Whether the call then
  // succeeds or returns a no-key/network error depends on the environment — both
  // are graceful and the test must not depend on key presence.)
  await expect
    .poll(() => window.evaluate(() => (window as unknown as { __wireRunTexts: string[] }).__wireRunTexts.some((t) => /Running/i.test(t))), {
      timeout: 4_000
    })
    .toBe(true)

  // It settles back out of running within a reasonable window, and crucially the
  // editor is still mounted afterwards — no crash, no closed page.
  await expect(window.locator('[data-testid="wire-run-now"]')).toContainText(/Run now/i, {
    timeout: 25_000
  })
  await expect(window.locator('[data-testid="wire-editor"]')).toBeVisible()

  // Whatever happened, the target content is a well-formed string (a real
  // transform writes a summary; a no-key/error run leaves it untouched).
  const tgt = await window.evaluate(
    async ({ taskId, tgtId }: { taskId: string; tgtId: string }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const ws = await api.widgets.listByTask(taskId)
      return ws.find((w) => w.id === tgtId)?.content
    },
    { taskId: ids.taskId, tgtId: ids.tgtId }
  )
  expect(typeof tgt).toBe('string')
})
