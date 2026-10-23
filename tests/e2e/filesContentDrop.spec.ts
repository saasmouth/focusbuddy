// Phase 3 of Files beside your work: content drops into the six office apps
// and the work widgets that take content (plan §4.3, §4.4).
//
// Every drag starts from a REAL row of the Files panel (a synthetic dragstart
// fills the DataTransfer through the app's own writer), and is dropped on the
// target's own surface. Assertions read what was SAVED (the document body, the
// work widget's content), plus the one notice line verbatim, the read-only
// refusal, and one undo for a drop.
//
//   CD-1  PlexiiWrite: a .csv becomes a table at the drop point, one ⌘Z takes
//         it back; a document becomes its live card; a folder a link that
//         opens Files at it; ⌥ on a picture makes a link; a document into
//         itself is refused with its line
//   CD-2  PlexiiCells: a .csv lands at the cell under the pointer; a picture
//         is refused with its line
//   CD-3  PlexiiDeck: a picture lands on the slide; a PDF as its first page,
//         said so; a video is refused with where it can go
//   CD-4  PlexiiDesign: a .md file lands as text on the page
//   CD-5  PlexiiDiagrams: a .csv lands as a table shape
//   CD-6  PlexiiDraw: a picture is Placed; a .txt becomes a text object; a
//         read-only drawing refuses with its line
//   CD-7  work widgets: page (.md), markdown (.csv), sticky (.txt, a picture
//         refused), note (.txt), table (.csv rows), image (the same file row)
//   CD-8  PlexiiDraw: a Cells document and a .csv land as a picture of their
//         table (computed values, the sheet's column width), said so

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, addWidgetToDesk, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 99, 162, 74, 174, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]

// A one-page PDF (a 200 × 100 pt page with a filled box), with a correct xref.
function onePagePdf(): string {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << >> >>',
    '<< /Length 35 >>\nstream\n0.2 0.4 0.8 rg 20 20 160 60 re f\nendstream'
  ]
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return out
}

type Seed = {
  taskId: string
  f: { png: string; csv: string; md: string; txt: string; pdf: string; mp4: string; folder: string; docB: string; selfEntry: string; budget: string }
  d: { write: string; writeB: string; sheet: string; slides: string; design: string; map: string; draw: string; drawRo: string; budget: string }
}

async function boot(): Promise<{ window: Page; seed: Seed }> {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const seed = (await window.evaluate(
    async ({ png, pdf }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const enc = (s: string) => new TextEncoder().encode(s).buffer
      const ing = (name: string, mime: string, buf: ArrayBuffer) => api.files.ingestBuffer({ buffer: buf, originalName: name, mimeType: mime, parentId: null })
      const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Content desk' })
      const f = {
        png: (await ing('dot.png', 'image/png', new Uint8Array(png).buffer)).id,
        csv: (await ing('scores.csv', 'text/csv', enc('name,score\nAda,9\nGrace,8\n'))).id,
        md: (await ing('notes.md', 'text/markdown', enc('# Launch notes\n\nShip on **Friday**.\n'))).id,
        txt: (await ing('todo.txt', 'text/plain', enc('Buy milk\nCall Ada'))).id,
        pdf: (await ing('brief.pdf', 'application/pdf', enc(pdf))).id,
        mp4: (await ing('demo.mp4', 'video/mp4', new Uint8Array(64).buffer)).id,
        folder: (await api.fileManager.createFolder(null, 'Brand assets')).id,
        docB: '',
        selfEntry: '',
        budget: ''
      }
      const mk = async (docType: string, title: string, body?: unknown) => ((await api.documents.create({ docType, title, ...(body ? { body } : {}) } as never)) as { id: string }).id
      const d = {
        write: await mk('doc', 'Target doc', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Start here.' }] }] }),
        writeB: await mk('doc', 'Source doc', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quarterly plan body.' }] }] }),
        sheet: await mk('sheet', 'Target sheet'),
        slides: await mk('slides', 'Target deck', { slides: [{ id: 's1', elements: [], notes: '' }] }),
        design: await mk('design', 'Target design'),
        map: await mk('map', 'Target diagram'),
        draw: await mk('draw', 'Target art'),
        // A drawing written by a newer PlexiiDraw opens read-only.
        drawRo: await mk('draw', 'Newer art', { schemaVersion: 2, minWriterVersion: 999, layers: [{ id: 'l1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, objects: [] }], artboards: [{ id: 'a1', name: 'Artboard 1', x: 0, y: 0, w: 800, h: 600 }], assets: {}, swatches: [] }),
        // A spreadsheet with a formula and a column the owner widened.
        budget: await mk('sheet', 'Budget', {
          version: 2,
          sheets: [
            {
              id: 't1',
              name: 'Sheet1',
              columns: ['A', 'B', 'C', 'D'],
              rows: [
                ['Item', 'Qty', 'Price', 'Total'],
                ['Pens & markers', '2', '3', '=B2*C2'],
                ['Pads', '4', '5', '=B3*C3'],
                ['Sum', '', '', '=SUM(D2:D3)']
              ],
              colWidths: { 0: 170 }
            }
          ]
        })
      }
      await api.fileManager.fileDocument(d.budget, null)
      await api.fileManager.fileDocument(d.writeB, null)
      await api.fileManager.fileDocument(d.write, null)
      const root = await api.fileManager.list(null)
      f.docB = root.find((e) => e.kind === 'doc' && e.docId === d.writeB)!.id
      f.selfEntry = root.find((e) => e.kind === 'doc' && e.docId === d.write)!.id
      f.budget = root.find((e) => e.kind === 'doc' && e.docId === d.budget)!.id
      return { taskId: task.id, f, d }
    },
    { png: PNG, pdf: onePagePdf() }
  )) as Seed
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await chooseCloudAiSource(window)
  return { window, seed }
}

/** Open the panel, pinned (the content starts right of it, nothing is under it). */
async function panel(window: Page): Promise<void> {
  if (!(await window.locator('[data-testid="files-flyout"]').isVisible().catch(() => false))) await window.locator('[data-testid="files-panel-toggle"]').click()
  const pin = window.locator('[data-testid="files-panel-pin"]')
  if ((await pin.getAttribute('aria-pressed')) !== 'true') await pin.click()
  await expect(window.locator('[data-testid="files-flyout"]')).toHaveAttribute('data-pinned', 'true')
}

async function openDoc(window: Page, id: string, ready: string): Promise<void> {
  await window.evaluate((i: string) => (window as unknown as { __fbView: { getState: () => { goDocument: (x: string) => void } } }).__fbView.getState().goDocument(i), id)
  await window.waitForSelector(ready, { timeout: 20_000 })
  await panel(window)
  await window.waitForTimeout(600)
}

/** Drag a panel row and drop it on `selector` (at dx/dy inside it, default its centre). */
async function dropRow(window: Page, entryId: string, selector: string, o: { dx?: number; dy?: number; alt?: boolean } = {}): Promise<void> {
  await expect(window.locator(`[data-testid="files-panel-entry-${entryId}"]`)).toBeVisible()
  await window.evaluate(
    ({ entryId, selector, dx, dy, alt }) => {
      const row = document.querySelector(`[data-testid="files-panel-entry-${entryId}"]`) as HTMLElement
      const dt = new DataTransfer()
      row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
      const host = document.querySelector(selector) as HTMLElement
      const r = host.getBoundingClientRect()
      const x = r.left + (dx ?? r.width / 2)
      const y = r.top + (dy ?? r.height / 2)
      const target = document.elementFromPoint(x, y) as HTMLElement
      const init = { clientX: x, clientY: y, dataTransfer: dt, bubbles: true, cancelable: true, altKey: !!alt }
      target.dispatchEvent(new DragEvent('dragenter', init))
      target.dispatchEvent(new DragEvent('dragover', init))
      target.dispatchEvent(new DragEvent('drop', init))
      row.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
    },
    { entryId, selector, dx: o.dx, dy: o.dy, alt: !!o.alt }
  )
}

const saved = (window: Page, id: string): Promise<string> =>
  window.evaluate(async (i: string) => JSON.stringify((await (window as unknown as { api: typeof window.api }).api.documents.get(i))?.body ?? null), id)

const notice = (window: Page) => window.locator('[data-testid="notice-toast"]')

test('CD-1 PlexiiWrite: table at the drop point (one undo), a live document card, a folder link that opens Files, ⌥ link, into itself refused', async () => {
  test.setTimeout(150_000)
  const { window, seed } = await boot()
  await openDoc(window, seed.d.write, '.ProseMirror')
  const pm = '[data-testid="doc-editor-surface"]'

  const live = (): Promise<string> => window.evaluate(() => JSON.stringify((document.querySelector('.ProseMirror') as unknown as { editor: { getJSON: () => unknown } }).editor.getJSON()))
  const depth = (): Promise<number> =>
    window.evaluate(() => {
      const e = (document.querySelector('.ProseMirror') as unknown as { editor: { state: { plugins: Array<{ key: string; getState: (s: unknown) => { done?: { eventCount: number } } }> } } }).editor
      return e.state.plugins.find((p) => /history/.test(p.key))?.getState(e.state)?.done?.eventCount ?? -1
    })
  const d0 = await depth()
  await dropRow(window, seed.f.csv, pm, { dx: 40, dy: 12 })
  await expect.poll(live, { timeout: 5_000 }).toContain('"Grace"')
  // ONE history event for the whole drop, and one ⌘Z takes it back. Done at
  // once: PlexiiWrite currently drops its whole undo history about a second
  // after any edit (typing too, at the integration tip; reported to 3e).
  expect(await depth()).toBe(d0 + 1)
  await window.keyboard.press('Meta+z')
  await expect.poll(live, { timeout: 3_000 }).not.toContain('"Grace"')
  await expect.poll(() => saved(window, seed.d.write), { timeout: 8_000 }).not.toContain('"Grace"')
  // No names typed in as text by ProseMirror's own drop.
  expect(await live()).not.toContain('scores.csv')

  // A document: its live card (DocEmbed), not a copy of its text.
  await dropRow(window, seed.f.docB, pm, { dx: 40, dy: 12 })
  await expect.poll(() => saved(window, seed.d.write), { timeout: 8_000 }).toContain(`"documentId":"${seed.d.writeB}"`)
  expect(await saved(window, seed.d.write)).not.toContain('Quarterly plan body')

  // ⌥ on a picture: a link to the file, not its bytes.
  await dropRow(window, seed.f.png, pm, { dx: 40, dy: 12, alt: true })
  await expect.poll(() => saved(window, seed.d.write), { timeout: 8_000 }).toContain(`plexii://file/${seed.f.png}`)

  // A document into itself.
  await dropRow(window, seed.f.selfEntry, pm, { dx: 40, dy: 12 })
  await expect(notice(window)).toContainText('A document cannot go inside itself.')

  // A folder: a link that opens Files at that folder.
  await dropRow(window, seed.f.folder, pm, { dx: 40, dy: 12 })
  await expect.poll(() => saved(window, seed.d.write), { timeout: 8_000 }).toContain(`plexii://folder/${seed.f.folder}`)
  await window.locator(`${pm} a[href="plexii://folder/${seed.f.folder}"]`).first().click()
  await expect(window.locator('[data-testid="files-view"]')).toBeVisible({ timeout: 8_000 })
  await expect(window.locator('[data-testid="files-view"]')).toContainText('Brand assets')
})

test('CD-2 PlexiiCells: a .csv lands at the cell under the pointer; a picture is refused', async () => {
  test.setTimeout(120_000)
  const { window, seed } = await boot()
  await openDoc(window, seed.d.sheet, '[data-testid="sheet-grid-wrap"]')
  const cell = await window.evaluate(() => {
    const wrap = document.querySelector('[data-testid="sheet-grid-wrap"]')!.getBoundingClientRect()
    const c = document.querySelector('[data-testid="sheet-grid-wrap"] [data-cell="2,1"], [data-testid="sheet-grid-wrap"] [data-r="2"][data-c="1"]') as HTMLElement | null
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { dx: r.left - wrap.left + r.width / 2, dy: r.top - wrap.top + r.height / 2 }
  })
  await dropRow(window, seed.f.csv, '[data-testid="sheet-grid-wrap"]', cell ?? { dx: 160, dy: 90 })
  await expect.poll(() => saved(window, seed.d.sheet), { timeout: 8_000 }).toContain('"Grace"')
  const rows = JSON.parse(await saved(window, seed.d.sheet)).sheets[0].rows as string[][]
  const at = rows.findIndex((r) => r.includes('name'))
  expect(at, 'the block landed below the top row (at the drop cell, not A1)').toBeGreaterThan(0)
  await dropRow(window, seed.f.png, '[data-testid="sheet-grid-wrap"]', { dx: 160, dy: 140 })
  await expect(notice(window)).toContainText('PlexiiCells holds values, not pictures.')
})

test('CD-3 PlexiiDeck: a picture lands on the slide; a PDF as its first page, said so; a video is refused', async () => {
  test.setTimeout(150_000)
  const { window, seed } = await boot()
  await openDoc(window, seed.d.slides, '[data-testid="slide-canvas"]')
  const els = async (): Promise<number> => JSON.parse(await saved(window, seed.d.slides)).slides[0].elements.length
  const n0 = await els()
  await dropRow(window, seed.f.png, '[data-testid="slide-canvas"]')
  await expect.poll(() => saved(window, seed.d.slides), { timeout: 8_000 }).toContain('data:image/png;base64')
  expect(await els()).toBe(n0 + 1)
  await dropRow(window, seed.f.pdf, '[data-testid="slide-canvas"]', { dx: 60, dy: 60 })
  await expect(notice(window)).toContainText('Only the first page comes in, as a picture.', { timeout: 15_000 })
  await expect.poll(els, { timeout: 8_000 }).toBe(n0 + 2)
  await dropRow(window, seed.f.mp4, '[data-testid="slide-canvas"]')
  await expect(notice(window)).toContainText('PlexiiDeck cannot hold a video file. Drop it on a desk, or into PlexiiWrite as a link.')
})

test('CD-4 PlexiiDesign: a .md file lands as text on the page', async () => {
  test.setTimeout(120_000)
  const { window, seed } = await boot()
  await openDoc(window, seed.d.design, '[data-testid="slide-canvas"]')
  await dropRow(window, seed.f.md, '[data-testid="slide-canvas"]')
  await expect.poll(() => saved(window, seed.d.design), { timeout: 8_000 }).toContain('Launch notes')
})

test('CD-5 PlexiiDiagrams: a .csv lands as a table shape', async () => {
  test.setTimeout(120_000)
  const { window, seed } = await boot()
  await openDoc(window, seed.d.map, '.react-flow')
  await dropRow(window, seed.f.csv, '[data-testid="diagram-canvas"]')
  await expect.poll(() => saved(window, seed.d.map), { timeout: 8_000 }).toContain('Grace')
})

test('CD-6 PlexiiDraw: a picture is Placed, a .txt is a text object, a read-only drawing refuses', async () => {
  test.setTimeout(150_000)
  const { window, seed } = await boot()
  await openDoc(window, seed.d.draw, '[data-testid="draw-canvas-scroll"]')
  await dropRow(window, seed.f.png, '[data-testid="draw-canvas-scroll"]')
  await expect.poll(() => saved(window, seed.d.draw), { timeout: 10_000 }).toContain('"type":"image"')
  await dropRow(window, seed.f.txt, '[data-testid="draw-canvas-scroll"]', { dx: 80, dy: 80 })
  await expect.poll(() => saved(window, seed.d.draw), { timeout: 10_000 }).toContain('Buy milk')

  await openDoc(window, seed.d.drawRo, '[data-testid="draw-canvas-scroll"]')
  const before = await saved(window, seed.d.drawRo)
  await dropRow(window, seed.f.txt, '[data-testid="draw-canvas-scroll"]')
  await expect(notice(window)).toContainText('This document is read-only, so nothing can be added to it.')
  expect(await saved(window, seed.d.drawRo)).toBe(before)
})

test('CD-7 work widgets take content through their own drop: page, markdown, sticky, note, table, image', async () => {
  test.setTimeout(180_000)
  const { window, seed } = await boot()
  await window.evaluate((id: string) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), seed.taskId)
  await window.waitForSelector('[data-canvas-surface="true"]')
  // The table the way a person adds one (it gets its real backing table); the rest through the store.
  await addWidgetToDesk(window, 'table')
  await window.evaluate(async (t: string) => {
    const s = (window as unknown as { __fbWidgets: { getState: () => { create: (d: Record<string, unknown>) => Promise<unknown> } } }).__fbWidgets.getState()
    let x = 40
    for (const kind of ['page', 'markdown', 'sticky', 'note', 'image']) {
      await s.create({ taskId: t, kind, title: '', content: '', x, y: 420, width: 300, height: 260, color: null })
      x += 320
    }
  }, seed.taskId)
  await panel(window)
  await window.waitForTimeout(800)
  const ids = await window.evaluate(async (t: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const ws = await api.widgets.listByTask(t)
    return Object.fromEntries(ws.map((w) => [w.kind, w.id])) as Record<string, string>
  }, seed.taskId)
  // Lay the six out in view, right of the pinned panel, so each drop point is on its widget.
  await window.evaluate(async (byKind: Record<string, string>) => {
    const s = (window as unknown as { __fbWidgets: { getState: () => { update: (id: string, p: Record<string, number>) => Promise<unknown> } } }).__fbWidgets.getState()
    const order = ['page', 'markdown', 'sticky', 'note', 'table', 'image']
    for (let i = 0; i < order.length; i++) await s.update(byKind[order[i]!]!, { x: 40 + (i % 3) * 330, y: 40 + Math.floor(i / 3) * 300, width: 300, height: 260 })
  }, ids)
  await window.waitForTimeout(600)
  const content = (id: string): Promise<string> => window.evaluate(async (i: string) => (await (window as unknown as { api: typeof window.api }).api.widgets.get(i))?.content ?? '', id)
  const body = (id: string) => `[data-widget-id="${id}"]`
  const countWidgets = (): Promise<number> => window.evaluate(async (t: string) => (await (window as unknown as { api: typeof window.api }).api.widgets.listByTask(t)).filter((w) => !w.archived).length, seed.taskId)
  const n0 = await countWidgets()

  await dropRow(window, seed.f.md, body(ids.page!), { dy: 80 })
  await expect.poll(() => content(ids.page!), { timeout: 8_000 }).toContain('Launch notes')
  await dropRow(window, seed.f.csv, body(ids.markdown!), { dy: 80 })
  await expect.poll(() => content(ids.markdown!), { timeout: 8_000 }).toContain('| Grace | 8 |')
  await dropRow(window, seed.f.txt, body(ids.sticky!), { dy: 80 })
  await expect.poll(() => content(ids.sticky!), { timeout: 8_000 }).toContain('Call Ada')
  await dropRow(window, seed.f.png, body(ids.sticky!), { dy: 80 })
  await expect(notice(window)).toContainText('Stickies hold text.')
  await dropRow(window, seed.f.txt, body(ids.note!), { dy: 80 })
  await expect.poll(() => content(ids.note!), { timeout: 8_000 }).toContain('Buy milk')
  await dropRow(window, seed.f.png, body(ids.image!), { dy: 80 })
  await expect.poll(() => content(ids.image!), { timeout: 8_000 }).toContain(`fb-file://${seed.f.png}`)
  await dropRow(window, seed.f.csv, body(ids.table!), { dy: 80 })
  // The table's cells are inputs: read their values (text plus input values).
  const tableText = (): Promise<string> =>
    window.evaluate((sel: string) => {
      const root = document.querySelector(sel)
      if (!root) return ''
      const vals = Array.from(root.querySelectorAll('input, textarea')).map((i) => (i as HTMLInputElement).value)
      return `${root.textContent ?? ''} ${vals.join(' ')}`
    }, `${body(ids.table!)} [data-testid="table-body"]`)
  await expect.poll(tableText, { timeout: 8_000 }).toContain('Grace')
  // Every drop landed IN its widget: the desk placed nothing beside them.
  expect(await countWidgets()).toBe(n0)
})

/** The SVG text of every picture asset in a saved drawing. */
const drawingPictures = (window: Page, id: string): Promise<string[]> =>
  window.evaluate(async (i: string) => {
    const body = (await (window as unknown as { api: typeof window.api }).api.documents.get(i))?.body as { assets?: Record<string, { dataUrl?: string }> } | null
    return Object.values(body?.assets ?? {})
      .map((a) => a.dataUrl ?? '')
      .filter((u) => u.startsWith('data:image/svg+xml;base64,'))
      .map((u) => new TextDecoder().decode(Uint8Array.from(atob(u.split(',')[1]!), (c) => c.charCodeAt(0))))
  }, id)

test('CD-8 PlexiiDraw: a Cells document and a .csv land as a picture of their table, said so', async () => {
  test.setTimeout(150_000)
  const { window, seed } = await boot()
  await openDoc(window, seed.d.draw, '[data-testid="draw-canvas-scroll"]')

  await dropRow(window, seed.f.budget, '[data-testid="draw-canvas-scroll"]')
  await expect(notice(window)).toContainText('It becomes a picture: edit it in PlexiiCells.')
  await expect(notice(window)).toContainText('Formulas become their values.')
  await expect.poll(async () => (await drawingPictures(window, seed.d.draw)).length, { timeout: 10_000 }).toBe(1)
  const [sheet] = await drawingPictures(window, seed.d.draw)
  // What the cells SHOW: computed values, escaped text, the widened column.
  expect(sheet).toContain('>26</text>')
  expect(sheet).toContain('>Pens &amp; markers</text>')
  expect(sheet).not.toContain('SUM(')
  expect(sheet).toContain('<rect x="0" y="0" width="170" height="24"')

  await dropRow(window, seed.f.csv, '[data-testid="draw-canvas-scroll"]', { dx: 80, dy: 80 })
  await expect.poll(async () => (await drawingPictures(window, seed.d.draw)).length, { timeout: 10_000 }).toBe(2)
  const csv = (await drawingPictures(window, seed.d.draw)).find((s) => s.includes('>Grace</text>'))
  expect(csv, 'the .csv is a picture of its table, not a line of commas').toBeTruthy()
  expect(await saved(window, seed.d.draw)).not.toContain('name,score')
})
