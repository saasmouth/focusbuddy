// A PDF work widget showing a file from this computer really loads it (4.3.50).
//
// THE BUG (d0, capturing 4.3.48 screens, 2026-11-17). A pdf widget holding a
// local file resolves to fb-file://<id> (pdfWidgetNoSearchLeak.spec.ts), but the
// <webview> showing it sat on persist:webview-default, and fb-file:// was handled
// only on the default session. The webview could not load its own src.
//
// THE FIX. Local files get a partition of their own (LOCAL_FILE_PARTITION). It
// handles fb-file:// and refuses web traffic. fb-file:// is NOT handled on
// persist:webview-default, where any website runs: a page there must not be
// able to read local files by id.
//
//   PDF-LOCAL-1  the webview showing a local PDF is on the local-file partition
//                and its document is the PDF (application/pdf), loaded.
//   PDF-LOCAL-2  the shared web partition does not handle fb-file://.
//   PDF-LOCAL-3  the local-file partition refuses https in-process.
import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// A minimal, valid one-page PDF.
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 40 100 Td (Local PDF) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`

test('PDF-LOCAL-1/2/3 a pdf widget loads a file from this computer, on a partition of its own', async () => {
  test.setTimeout(150_000)
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)

  const { taskId, fileId } = await window.evaluate(async (pdf) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const buf = new TextEncoder().encode(pdf).buffer
    const file = await api.files.ingestBuffer({ buffer: buf, originalName: 'local.pdf', mimeType: 'application/pdf', parentId: null })
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Local PDF' })
    await api.widgets.create({ taskId: task.id, kind: 'pdf', title: 'Local PDF', content: file.id, x: 60, y: 60, width: 520, height: 420 } as never)
    return { taskId: task.id as string, fileId: file.id as string }
  }, PDF)

  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })
  // Positive control: the widget is on the desk.
  await expect(window.locator('[data-widget-kind="pdf"]').first()).toBeVisible({ timeout: 10_000 })

  // The guest WebContents for this file, read in the main process: its session
  // and what it loaded. Polled, because the PDF viewer attaches asynchronously.
  type Guest = { found: boolean; onLocalPartition: boolean; url: string; contentType: string; fetchStatus: number }
  const read = (): Promise<Guest> =>
    app.evaluate(async ({ webContents, session }, id) => {
      const guest = webContents.getAllWebContents().find((w) => w.getType() === 'webview' && w.getURL().startsWith(`fb-file://${id}`))
      if (!guest) return { found: false, onLocalPartition: false, url: '', contentType: '', fetchStatus: 0 }
      let contentType = ''
      try { contentType = String(await guest.executeJavaScript('document.contentType')) } catch { contentType = 'error' }
      let fetchStatus = 0
      try { fetchStatus = (await guest.session.fetch(`fb-file://${id}/`)).status } catch { fetchStatus = -1 }
      return {
        found: true,
        onLocalPartition: guest.session === session.fromPartition('fb-local-files'),
        url: guest.getURL(),
        contentType,
        fetchStatus
      }
    }, fileId)

  let guest: Guest = { found: false, onLocalPartition: false, url: '', contentType: '', fetchStatus: 0 }
  await expect.poll(async () => (guest = await read()).found && guest.fetchStatus === 200 && guest.contentType === 'application/pdf', { timeout: 20_000 }).toBe(true).catch(() => {})
  console.log('[PDF-LOCAL-1]', JSON.stringify(guest))
  expect(guest.found, 'a webview is showing the local file').toBe(true)
  expect(guest.fetchStatus, 'its session can read fb-file://').toBe(200)
  expect(guest.contentType, 'its document is the PDF').toBe('application/pdf')
  expect(guest.onLocalPartition, 'it is on the local-file partition').toBe(true)

  // PDF-LOCAL-2: the shared web partition, where any website runs, cannot read local files.
  const sharedHandles = await app.evaluate(({ session }) =>
    session.fromPartition('persist:webview-default').protocol.isProtocolHandled('fb-file')
  )
  expect(sharedHandles, 'persist:webview-default must not handle fb-file://').toBe(false)

  // PDF-LOCAL-3: the local-file session runs no website. Its http(s) is answered
  // in-process with a refusal (nothing goes out, so the net guard sees nothing).
  const web = await app.evaluate(async ({ session }) => {
    const r = await session.fromPartition('fb-local-files').fetch('https://example.com/')
    return { status: r.status, handled: session.fromPartition('fb-local-files').protocol.isProtocolHandled('https') }
  })
  expect(web, 'the local-file session refuses https without going out').toEqual({ status: 403, handled: true })
})
