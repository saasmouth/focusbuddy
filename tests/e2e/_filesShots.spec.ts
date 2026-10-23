// Screenshot sweep for the Files flyout decision (not part of the suite):
// desk and office app (PlexiiWrite, PlexiiDraw), pinned and unpinned, light and dark.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights } from './_helpers'

const OUT = process.env.FILES_SHOTS ?? '/private/tmp/claude-501/files-flyout-logs/shots'

for (const theme of ['light', 'dark'] as const) {
  test(`files flyout shots (${theme})`, async () => {
    test.setTimeout(180_000)
    const { app, window, dispose } = await launchApp()
    try {
      await waitForReady(window)
      const seed = await window.evaluate(async () => {
        const api = (window as unknown as { api: typeof window.api }).api
        const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Launch plan' })
        await api.widgets.create({ taskId: task.id, kind: 'sticky', content: 'Call the printer', x: 60, y: 60, width: 220, height: 160 } as never)
        await api.widgets.create({ taskId: task.id, kind: 'markdown', content: '# Notes\n\nAgenda for Friday.', x: 320, y: 60, width: 300, height: 200 } as never)
        const f = await api.fileManager.createFolder(null, 'Brand assets')
        await api.fileManager.createFolder(null, 'Contracts')
        for (const [n, m] of [['Q3 report.pdf', 'application/pdf'], ['budget.csv', 'text/csv'], ['team photo.png', 'image/png'], ['notes.txt', 'text/plain']])
          await api.files.ingestBuffer({ buffer: new TextEncoder().encode('x').buffer, originalName: n, mimeType: m, parentId: null })
        await api.files.ingestBuffer({ buffer: new TextEncoder().encode('x').buffer, originalName: 'logo.svg', mimeType: 'image/svg+xml', parentId: f.id })
        const doc = (await api.documents.create({ docType: 'doc', title: 'Proposal', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Drag files in from the panel on the left.' }] }] } } as never)) as { id: string }
        const draw = (await api.documents.create({ docType: 'draw', title: 'Poster' } as never)) as { id: string }
        return { taskId: task.id, doc: doc.id, draw: draw.id }
      })
      await window.evaluate((t) => localStorage.setItem('fb.theme.mode', t), theme)
      await suppressFeatureSpotlights(window)
      await window.reload()
      await waitForReady(window)
      await chooseCloudAiSource(window)
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900))
      await window.waitForTimeout(500)
      const go = async (fn: string, a?: string, b?: string): Promise<void> => {
        await window.evaluate(({ fn, a, b }) => (window as unknown as { __fbView: { getState: () => Record<string, (x?: string, y?: string) => void> } }).__fbView.getState()[fn]!(a, b), { fn, a, b })
        await window.waitForTimeout(1500)
      }
      const pinned = async (want: boolean): Promise<void> => {
        const pin = window.locator('[data-testid="files-panel-pin"]')
        if (((await pin.getAttribute('aria-pressed')) === 'true') !== want) await pin.click()
        await window.waitForTimeout(600)
      }
      await go('goTask', seed.taskId)
      await window.locator('[data-testid="files-panel-toggle"]').click()
      await expect(window.locator('[data-testid="files-flyout"]')).toBeVisible()
      for (const [name, fn, a, b] of [
        ['desk', 'goTask', seed.taskId, undefined],
        ['write', 'goOffice', undefined, seed.doc],
        ['draw', 'goOffice', undefined, seed.draw]
      ] as const) {
        await go(fn, a, b)
        await pinned(false)
        await window.screenshot({ path: `${OUT}/${name}-unpinned-${theme}.png` })
        await pinned(true)
        await window.screenshot({ path: `${OUT}/${name}-pinned-${theme}.png` })
      }
      await pinned(false)
    } finally {
      await dispose()
    }
  })
}
