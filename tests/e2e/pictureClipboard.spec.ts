// Pictures in and out of work widgets (owner, 2026-11-19: "check for similar
// issues with all other widgets and fix").
//
//   PC-1  Click an Image work widget and press ⌘C: the picture itself goes on
//         the clipboard, as PNG (it used to copy nothing).
//   PC-2  Click a Gallery and paste a picture (a screenshot): it joins the
//         gallery, and no separate image widget appears on the desk. One ⌘Z
//         takes it back out.
//
// The clipboard is the test's own (_clipboardStub.ts), never the system one.
// A pasted file is what the OS hands the page on ⌘V, so PC-2 hands the gallery
// a paste event carrying a PNG file, as the platform would.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { installClipboardStub, stubClipboard, MOD, installMainClipboardStub } from './_clipboardStub'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

// A 2x2 red PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANBAEB/1vLnwAAAABJRU5ErkJggg=='

async function deskWith(l: LaunchedApp, widgets: Array<{ kind: string; content: string }>): Promise<{ deskId: string; ids: string[] }> {
  const { window } = l
  await waitForReady(window)
  const r = await window.evaluate(async (ws) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'PictureDesk' })
    const ids: string[] = []
    let x = 80
    for (const w of ws) {
      const made = await api.widgets.create({ taskId: desk.id, kind: w.kind, title: '', content: w.content, x, y: 80, width: 320, height: 260 } as never)
      ids.push(made.id)
      x += 380
    }
    return { deskId: desk.id, ids }
  }, widgets)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /PictureDesk/ }).first().click()
  await window.waitForSelector(`[data-widget-id="${r.ids[0]}"]`, { timeout: 15_000 })
  await installClipboardStub(window)
  return r
}

test('PC-1 ⌘C on an Image work widget copies the picture as PNG', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { ids } = await deskWith(launched, [{ kind: 'image', content: `data:image/png;base64,${PNG_B64}` }])
  await launched.window.locator(`[data-widget-id="${ids[0]}"] [data-testid="image-widget-body"]`).click({ position: { x: 20, y: 200 } })
  await launched.window.keyboard.press(`${MOD}+c`)
  await expect.poll(async () => Object.keys((await stubClipboard(launched!.window)).data)).toContain('image/png')
})

test('PC-2 a picture pasted into a Gallery joins it, not the desk; one ⌘Z takes it out', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { deskId, ids } = await deskWith(launched, [{ kind: 'gallery', content: '' }])
  const gallery = (): Promise<string[]> =>
    launched!.window.evaluate(async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const w = await api.widgets.get(id)
      try {
        return (JSON.parse(w?.content || '{}').fileIds ?? []) as string[]
      } catch {
        return []
      }
    }, ids[0])
  const onDesk = (): Promise<number> =>
    launched!.window.evaluate(async (id) => (await (window as unknown as { api: typeof window.api }).api.widgets.listByTask(id)).length, deskId)
  await launched.window.locator(`[data-widget-id="${ids[0]}"] [data-testid="gallery-body"]`).click()
  await launched.window.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'Screenshot.png', { type: 'image/png' }))
    ;(document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, PNG_B64)
  await expect.poll(async () => (await gallery()).length).toBe(1)
  await launched.window.waitForTimeout(500)
  expect(await onDesk()).toBe(1)
  await launched.window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await launched.window.keyboard.press(`${MOD}+z`)
  await expect.poll(async () => (await gallery()).length).toBe(0)
})
