// A pdf widget must never send its file id to a search engine.
//
// THE BUG (d1, 2026-10-24). A pdf / gdoc / gslide / file widget stores a bare
// fb_files id in `content`, and renderWidget sends all of those kinds to
// WebViewWidget. WebViewWidget sanitised the value, and sanitizeWebviewUrl
// handed anything it could not parse to normalizeUrl — a GOOGLE SEARCH. So the
// widget loaded https://www.google.com/search?q=<file id>: the id went to a
// third party, and the person got search results where their PDF should be.
//
// Asserted on the webview's SRC, with a positive control that the widget is
// really on the desk first — "no search engine" is also true of a canvas that
// rendered nothing at all.

import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

const FILE_ID = '0f3b9a21-44d7-4c0e-9a11-2b6c5d8e7f90'

test('a pdf widget holding a bare file id asks no search engine for it', async () => {
  test.setTimeout(120_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const taskId = await window.evaluate(async (fileId) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'PDF leak check' })
    await api.widgets.create({
      taskId: task.id,
      kind: 'pdf',
      title: 'A PDF',
      content: fileId,
      x: 60,
      y: 60,
      width: 520,
      height: 420
    } as never)
    return task.id as string
  }, FILE_ID)

  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })

  // POSITIVE CONTROL: the widget really is on the desk. Without this, every
  // assertion below passes on an empty canvas.
  await expect(window.locator('[data-widget-kind="pdf"]').first()).toBeVisible({ timeout: 10_000 })
  await window.waitForTimeout(1500)

  // THE SRC IS THE ASSERTION, and deliberately so.
  //
  // My first version of this also collected window.on('request') and asserted
  // no google.com among them. That was VACUOUS: an Electron <webview> is a
  // separate WebContents, so the renderer page's request events never see its
  // traffic, and those checks passed just as happily on the broken build.
  // d1's net guard does not see it either. What decides where the widget goes
  // is the src it is handed, and on the unfixed build that src was
  // "https://www.google.com/sorry/index?continue=...search%3Fq%3D<file id>" —
  // Google's bot page, which is proof the request not only left but arrived.
  const src = await window.evaluate(() => {
    const el = document.querySelector('[data-widget-kind="pdf"] webview') as { src?: string } | null
    return el?.src ?? ''
  })
  expect(src, 'the pdf must not be handed to a search engine').not.toMatch(
    /google\.|bing\.|duckduckgo\.|search\.brave\.|[?&]q=/i
  )
  expect(src, 'the pdf resolves to the local file').toContain(FILE_ID)
  expect(src).toMatch(/^fb-file:\/\//)
})
