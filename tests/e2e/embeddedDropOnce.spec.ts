// A drop into an editor embedded on a desk must land ONCE.
//
// PlexiiWrite takes a dragged work widget file with its own native `drop`
// listener on the ProseMirror DOM: it inserts the embed and calls
// preventDefault. The desk canvas sits underneath it, and its React onDrop
// used to run regardless (it never looked at defaultPrevented), so the same
// drop ALSO placed a linked instance of the work widget on the desk: one drag,
// two effects. Files beside makes this gesture common (drag from the flyout
// into a document on a desk), so it is pinned here.
//
// The drop is synthetic (one shared DataTransfer, dispatched on the editor's
// own DOM), the pattern docWidgetDrop.spec.ts uses: Playwright's dragTo cannot
// reach a ProseMirror view inside a transformed desk layer reliably.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seed(window: Page): Promise<{ taskId: string; docWidgetId: string; fileId: string }> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Embedded drop desk' })
    const doc = (await api.documents.create({
      docType: 'doc',
      title: 'Embedded plan',
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Drop here' }] }] }
    } as never)) as { id: string }
    const w = (await api.widgets.create({ taskId: task.id, kind: 'doc', content: doc.id, x: 60, y: 60, width: 620, height: 460 } as never)) as { id: string }
    // A work widget file that is in Files but on no desk.
    const file = await api.widgetFiles.create({ kind: 'sticky', title: 'Loose sticky', content: 'Call the bank' })
    return { taskId: task.id, docWidgetId: w.id, fileId: file.id }
  })
}

test('a work widget file dropped into a Write document on a desk lands once (embed, no new desk widget)', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const s = await seed(window)
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }).__fbView?.getState().goTask(id), s.taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
  const editor = window.locator('[data-canvas-surface="true"] .ProseMirror').first()
  await expect(editor).toBeVisible({ timeout: 20_000 })
  await window.waitForTimeout(800)

  const state = (): Promise<{ widgets: number; embeds: number; instances: number }> =>
    window.evaluate(async ({ taskId, fileId }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const widgets = (await api.widgets.listByTask(taskId)).filter((w: { archived?: boolean }) => !w.archived).length
      const instances = (await api.widgetFiles.instances(fileId)).length
      const embeds = document.querySelector('[data-canvas-surface="true"] .ProseMirror')?.querySelectorAll('[data-testid^="widget-embed"]').length ?? 0
      return { widgets, embeds, instances }
    }, { taskId: s.taskId, fileId: s.fileId })

  const before = await state()
  expect(before.instances).toBe(0)

  await window.evaluate((fileId: string) => {
    const dom = document.querySelector('[data-canvas-surface="true"] .ProseMirror') as HTMLElement
    const r = dom.getBoundingClientRect()
    const dt = new DataTransfer()
    // Exactly what Files writes for a work widget file (writeWidgetFileDrag).
    dt.setData('application/x-plexii-widget-file', fileId)
    dt.setData('text/plain', 'Loose sticky')
    const at = { clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 20), dataTransfer: dt, bubbles: true, cancelable: true }
    dom.dispatchEvent(new DragEvent('dragover', at))
    dom.dispatchEvent(new DragEvent('drop', at))
  }, s.fileId)
  await window.waitForTimeout(2000)

  const after = await state()
  expect(after.embeds, 'the document did not take the drop').toBe(before.embeds + 1)
  expect(after.widgets, 'the desk ALSO placed a widget for the same drop (double handling)').toBe(before.widgets)
  expect(after.instances, 'a linked desk instance of the dropped file was created').toBe(0)
})
