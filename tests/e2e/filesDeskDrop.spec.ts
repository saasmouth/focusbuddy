// Phase 2 of Files beside your work: drops onto the desk, the Workcentre,
// folders and Drive work widgets.
//
// Every drag here starts from a REAL row of the Files panel: a synthetic
// dragstart is dispatched on the row with a fresh DataTransfer, so the app's
// own writer fills it (the Files MIME, markers, compatibility payloads), and
// the same DataTransfer is then dropped on the target. This is the pattern
// widgetFiles.spec.ts and docWidgetDrop.spec.ts use; the real OS gesture is
// proven separately with CGEvents (scripts in the handover).
//
//   FD-1  each source kind onto the canvas: the right work widget, content =
//         the SAME fb_files id, and no new fb_files row
//   FD-2  a folder becomes a Drive work widget bound to it
//   FD-3  several pictures ask "Individual images / One gallery"; the gallery
//         holds the same ids; Cancel places nothing
//   FD-4  one ⌘Z removes a whole multi-item drop
//   FD-5  Workcentre: a drop at a cell puts the new tile at that cell
//   FD-6  Workcentre: a drop onto a tile's Write body goes into the document
//         and makes no tile
//   FD-7  a Drive work widget takes a drop by MOVING the items into its folder
//   FD-8  a panel folder takes a drop (move, one undo); a folder into itself is refused

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

type Seed = {
  taskId: string
  ids: { png: string; png2: string; pdf: string; csv: string; zip: string; mp4: string; folder: string; inner: string; docEntry: string; doc: string; wfEntry: string; wf: string }
}

// 1×1 PNG.
const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 99, 162, 74, 174, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]

async function boot(): Promise<{ window: Page; seed: Seed }> {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const seed = (await window.evaluate(async (png: number[]) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Drop desk' })
    const ing = (name: string, mime: string, bytes: ArrayBuffer) => api.files.ingestBuffer({ buffer: bytes, originalName: name, mimeType: mime, parentId: null })
    const pngBuf = new Uint8Array(png).buffer
    const png1 = await ing('one.png', 'image/png', pngBuf)
    const png2 = await ing('two.png', 'image/png', new Uint8Array(png).buffer)
    const pdf = await ing('brief.pdf', 'application/pdf', new TextEncoder().encode('%PDF-1.4\n%%EOF').buffer)
    const csv = await ing('rows.csv', 'text/csv', new TextEncoder().encode('a,b\n1,2\n').buffer)
    const zip = await ing('bundle.zip', 'application/zip', new Uint8Array([80, 75, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer)
    const mp4 = await ing('clip.mp4', 'video/mp4', new Uint8Array(64).buffer)
    const folder = await api.fileManager.createFolder(null, 'Plans folder')
    const inner = await api.fileManager.createFolder(folder.id, 'Inner')
    const doc = (await api.documents.create({ docType: 'doc', title: 'Filed doc', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] } } as never)) as { id: string }
    await api.fileManager.fileDocument(doc.id, null)
    const wf = await api.widgetFiles.create({ kind: 'sticky', title: 'Loose sticky', content: 'Call the bank' })
    const root = await api.fileManager.list(null)
    const docEntry = root.find((e) => e.kind === 'doc' && e.docId === doc.id)!
    const wfEntry = root.find((e) => e.kind === 'doc' && e.docId === wf.id)!
    return {
      taskId: task.id,
      ids: { png: png1.id, png2: png2.id, pdf: pdf.id, csv: csv.id, zip: zip.id, mp4: mp4.id, folder: folder.id, inner: inner.id, docEntry: docEntry.id, doc: doc.id, wfEntry: wfEntry.id, wf: wf.id }
    }
  }, PNG)) as Seed
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await chooseCloudAiSource(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), seed.taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
  await window.locator('[data-testid="files-panel-toggle"]').click()
  await expect(window.locator('[data-testid="files-flyout"]')).toBeVisible()
  await expect(window.locator(`[data-testid="files-panel-entry-${seed.ids.png}"]`)).toBeVisible()
  return { window, seed }
}

/**
 * Drag the given panel rows (selected together) and drop at a point. The
 * target is whatever element is at that point, as for a real drop.
 */
async function dragRows(window: Page, ids: string[], at: { x: number; y: number } | { selector: string; dx?: number; dy?: number }, opts: { alt?: boolean } = {}): Promise<void> {
  if (ids.length > 1) {
    await window.locator(`[data-testid="files-panel-entry-${ids[0]}"]`).click()
    for (const id of ids.slice(1)) await window.locator(`[data-testid="files-panel-entry-${id}"]`).click({ modifiers: ['Meta'] })
  }
  await window.evaluate(
    ({ ids, at, alt }) => {
      const row = document.querySelector(`[data-testid="files-panel-entry-${ids[0]}"]`) as HTMLElement
      const dt = new DataTransfer()
      row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
      let x: number
      let y: number
      if ('selector' in at) {
        const r = (document.querySelector(at.selector) as HTMLElement).getBoundingClientRect()
        x = r.left + (at.dx ?? r.width / 2)
        y = r.top + (at.dy ?? r.height / 2)
      } else {
        x = at.x
        y = at.y
      }
      const target = document.elementFromPoint(x, y) as HTMLElement
      const init = { clientX: x, clientY: y, dataTransfer: dt, bubbles: true, cancelable: true, altKey: !!alt }
      target.dispatchEvent(new DragEvent('dragenter', init))
      target.dispatchEvent(new DragEvent('dragover', init))
      target.dispatchEvent(new DragEvent('drop', init))
      row.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
    },
    { ids, at, alt: !!opts.alt }
  )
}

const deskWidgets = (window: Page, taskId: string): Promise<Array<{ id: string; kind: string; content: string }>> =>
  window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgets.listByTask(t)).filter((w) => !w.archived).map((w) => ({ id: w.id, kind: w.kind, content: w.content }))
  }, taskId)

/** Every fb_files row the Files manager can list, recursively (a re-ingest would add one). */
const fileRowCount = (window: Page): Promise<number> =>
  window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    let n = 0
    const walk = async (p: string | null): Promise<void> => {
      for (const e of await api.fileManager.list(p)) {
        n++
        if (e.kind === 'folder') await walk(e.id)
      }
    }
    await walk(null)
    return n
  })

// A point on the canvas to the right of the flyout.
const CANVAS_AT = { x: 1000, y: 420 }

test('FD-1 each kind onto the canvas: the right work widget, the same file row, nothing re-ingested', async () => {
  test.setTimeout(120_000)
  const { window, seed } = await boot()
  const rows = await fileRowCount(window)
  const cases: Array<{ id: string; kind: string; content: string }> = [
    { id: seed.ids.png, kind: 'file', content: seed.ids.png },
    { id: seed.ids.pdf, kind: 'file', content: seed.ids.pdf },
    { id: seed.ids.csv, kind: 'file', content: seed.ids.csv },
    { id: seed.ids.zip, kind: 'file', content: seed.ids.zip },
    { id: seed.ids.mp4, kind: 'file', content: seed.ids.mp4 },
    { id: seed.ids.docEntry, kind: 'doc', content: seed.ids.doc }
  ]
  for (const c of cases) {
    const before = await deskWidgets(window, seed.taskId)
    await dragRows(window, [c.id], CANVAS_AT)
    await expect.poll(async () => (await deskWidgets(window, seed.taskId)).length, { timeout: 5_000 }).toBe(before.length + 1)
    const added = (await deskWidgets(window, seed.taskId)).find((w) => !before.some((b) => b.id === w.id))!
    expect(added.kind, c.id).toBe(c.kind)
    expect(added.content, c.id).toBe(c.content)
  }
  // A work widget file: a LINKED instance of the same file.
  const before = (await deskWidgets(window, seed.taskId)).length
  await dragRows(window, [seed.ids.wfEntry], CANVAS_AT)
  await expect.poll(async () => (await deskWidgets(window, seed.taskId)).length, { timeout: 5_000 }).toBe(before + 1)
  const instances = await window.evaluate(async (id: string) => (await (window as unknown as { api: typeof window.api }).api.widgetFiles.instances(id)).length, seed.ids.wf)
  expect(instances).toBe(1)
  expect(await fileRowCount(window), 'a drop re-ingested a file').toBe(rows)
})

test('FD-2 a folder becomes a Drive work widget bound to it', async () => {
  test.setTimeout(90_000)
  const { window, seed } = await boot()
  await dragRows(window, [seed.ids.folder], CANVAS_AT)
  await expect.poll(async () => (await deskWidgets(window, seed.taskId)).find((w) => w.kind === 'drive')?.content, { timeout: 5_000 }).toBe(seed.ids.folder)
  await expect(window.locator(`[data-testid="drive-entry-${seed.ids.inner}"]`)).toBeVisible({ timeout: 8_000 })
})

test('FD-3 several pictures ask: individual or one gallery; Cancel places nothing', async () => {
  test.setTimeout(90_000)
  const { window, seed } = await boot()
  const before = (await deskWidgets(window, seed.taskId)).length
  await dragRows(window, [seed.ids.png, seed.ids.png2], CANVAS_AT)
  await expect(window.locator('[data-testid="prompt-dialog"]')).toContainText('Add 2 pictures')
  await window.locator('[data-testid="prompt-dialog-cancel"]').click()
  await window.waitForTimeout(400)
  expect((await deskWidgets(window, seed.taskId)).length).toBe(before)

  await dragRows(window, [seed.ids.png, seed.ids.png2], CANVAS_AT)
  await window.locator('[data-testid="prompt-choice-gallery"]').click()
  await expect.poll(async () => (await deskWidgets(window, seed.taskId)).filter((w) => w.kind === 'gallery').length, { timeout: 5_000 }).toBe(1)
  const g = (await deskWidgets(window, seed.taskId)).find((w) => w.kind === 'gallery')!
  expect(JSON.parse(g.content).fileIds.sort()).toEqual([seed.ids.png, seed.ids.png2].sort())

  await dragRows(window, [seed.ids.png, seed.ids.png2], CANVAS_AT)
  await window.locator('[data-testid="prompt-choice-individual"]').click()
  await expect.poll(async () => (await deskWidgets(window, seed.taskId)).filter((w) => w.kind === 'file').length, { timeout: 5_000 }).toBe(2)
})

test('FD-4 one ⌘Z removes a whole multi-item drop', async () => {
  test.setTimeout(90_000)
  const { window, seed } = await boot()
  const before = (await deskWidgets(window, seed.taskId)).length
  await dragRows(window, [seed.ids.pdf, seed.ids.csv, seed.ids.folder], CANVAS_AT)
  await expect.poll(async () => (await deskWidgets(window, seed.taskId)).length, { timeout: 5_000 }).toBe(before + 3)
  await window.locator('[data-canvas-surface="true"]').click({ position: { x: 1200, y: 700 } })
  await window.keyboard.press('Meta+z')
  await expect.poll(async () => (await deskWidgets(window, seed.taskId)).length, { timeout: 5_000 }).toBe(before)
})

async function toWorkcentre(window: Page): Promise<void> {
  // Pinned, so the Workcentre starts right of the panel and no tile is under it.
  const pin = window.locator('[data-testid="files-panel-pin"]')
  if ((await pin.getAttribute('aria-pressed')) !== 'true') await pin.click()
  await window.locator('[data-testid="view-selector-btn"]').first().click()
  await window.locator('[data-testid="view-opt-workcentre"]').click()
  await expect(window.locator('[data-testid="workcentre-view"]')).toBeVisible({ timeout: 10_000 })
}

test('FD-5 Workcentre: a drop at a cell puts the new tile at that cell', async () => {
  test.setTimeout(90_000)
  const { window, seed } = await boot()
  // Something on the desk so the grid exists.
  await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.widgets.create({ taskId: t, kind: 'sticky', content: 'First', x: 40, y: 40, width: 220, height: 160 } as never)
  }, seed.taskId)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), seed.taskId)
  await window.waitForSelector('[data-canvas-surface="true"]')
  await toWorkcentre(window)
  await expect(window.locator('[data-testid="workcentre-grid"]')).toBeVisible()
  await expect(window.locator('[data-testid="files-flyout"]')).toBeVisible() // remembered open
  const target = await window.evaluate(() => {
    const g = document.querySelector('[data-testid="workcentre-grid"]') as HTMLElement
    const r = g.getBoundingClientRect()
    const cols = Number(g.dataset.cols)
    const colPx = (r.width - (cols - 1) * 12) / cols
    // Column cols-3, row 2: away from where first fit would put it.
    const cx = cols - 3
    return { x: r.left + cx * (colPx + 12) + colPx / 2, y: r.top + 2 * 36 + 10, cx }
  })
  const before = await deskWidgets(window, seed.taskId)
  await dragRows(window, [seed.ids.pdf], { x: target.x, y: target.y })
  await expect.poll(async () => (await deskWidgets(window, seed.taskId)).length, { timeout: 5_000 }).toBe(before.length + 1)
  const added = (await deskWidgets(window, seed.taskId)).find((w) => !before.some((b) => b.id === w.id))!
  expect(added.content).toBe(seed.ids.pdf)
  const tile = window.locator(`[data-testid="workcentre-tile-${added.id}"]`)
  await expect(tile).toBeVisible()
  // The tile's left column is the drop column (clamped so it fits the grid).
  const cols = Number(await window.locator('[data-testid="workcentre-grid"]').getAttribute('data-cols'))
  const w = Number(await tile.getAttribute('data-w'))
  expect(Number(await tile.getAttribute('data-x'))).toBe(Math.min(target.cx, cols - w))
  // Only ONE widget: the canvas underneath did not place a second.
  expect((await deskWidgets(window, seed.taskId)).filter((x) => x.content === seed.ids.pdf)).toHaveLength(1)
})

test('FD-6 Workcentre: a drop onto a tile’s Write body goes into the document, no new tile', async () => {
  test.setTimeout(120_000)
  const { window, seed } = await boot()
  await window.evaluate(async ({ t, d }) => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.widgets.create({ taskId: t, kind: 'doc', content: d, x: 40, y: 40, width: 620, height: 460 } as never)
  }, { t: seed.taskId, d: seed.ids.doc })
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), seed.taskId)
  await window.waitForSelector('[data-canvas-surface="true"]')
  await toWorkcentre(window)
  const body = window.locator('[data-testid^="workcentre-body-"] .ProseMirror').first()
  await expect(body).toBeVisible({ timeout: 20_000 })
  const before = await deskWidgets(window, seed.taskId)
  await dragRows(window, [seed.ids.wfEntry], { selector: '[data-testid^="workcentre-body-"] .ProseMirror', dx: 30, dy: 14 })
  await window.waitForTimeout(1500)
  const embeds = await window.evaluate(() => document.querySelector('[data-testid^="workcentre-body-"] .ProseMirror')?.querySelectorAll('[data-testid^="widget-embed"]').length ?? 0)
  expect(embeds, 'the document did not take the drop').toBe(1)
  expect((await deskWidgets(window, seed.taskId)).length, 'a tile was ALSO made').toBe(before.length)
})

test('FD-7 a Drive work widget moves dropped items into its folder', async () => {
  test.setTimeout(90_000)
  const { window, seed } = await boot()
  await dragRows(window, [seed.ids.folder], CANVAS_AT)
  const drive = window.locator('[data-testid="drive-body"]').first()
  await expect(drive).toBeVisible({ timeout: 8_000 })
  const before = (await deskWidgets(window, seed.taskId)).length
  await dragRows(window, [seed.ids.pdf, seed.ids.zip], { selector: '[data-testid="drive-body"]' })
  await expect(window.locator(`[data-testid="drive-entry-${seed.ids.pdf}"]`)).toBeVisible({ timeout: 8_000 })
  await expect(window.locator(`[data-testid="drive-entry-${seed.ids.zip}"]`)).toBeVisible()
  const parents = await window.evaluate(async (ids: string[]) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return Promise.all(ids.map(async (i) => (await api.fileManager.get(i))?.parentId))
  }, [seed.ids.pdf, seed.ids.zip])
  expect(parents).toEqual([seed.ids.folder, seed.ids.folder])
  // Moved, not placed: no new desk widget for them.
  expect((await deskWidgets(window, seed.taskId)).length).toBe(before)
})

test('FD-8 a panel folder takes a drop (one undo); a folder into itself is refused', async () => {
  test.setTimeout(90_000)
  const { window, seed } = await boot()
  await dragRows(window, [seed.ids.csv, seed.ids.zip], { selector: `[data-testid="files-panel-entry-${seed.ids.folder}"]` })
  await expect(window.locator(`[data-testid="files-panel-entry-${seed.ids.csv}"]`)).toHaveCount(0, { timeout: 5_000 })
  const parent = (id: string): Promise<string | null | undefined> =>
    window.evaluate(async (i: string) => (await (window as unknown as { api: typeof window.api }).api.fileManager.get(i))?.parentId, id)
  expect(await parent(seed.ids.csv)).toBe(seed.ids.folder)
  // One undo step for both (focus in the panel: its ⌘Z is scoped to it).
  await window.locator('[data-testid="files-panel-undo"]').click()
  await expect.poll(() => parent(seed.ids.zip), { timeout: 5_000 }).toBeNull()
  expect(await parent(seed.ids.csv)).toBeNull()
  // A folder onto itself.
  await dragRows(window, [seed.ids.folder], { selector: `[data-testid="files-panel-entry-${seed.ids.folder}"]` })
  await expect(window.getByText('A folder cannot go inside itself.')).toBeVisible({ timeout: 5_000 })
})
