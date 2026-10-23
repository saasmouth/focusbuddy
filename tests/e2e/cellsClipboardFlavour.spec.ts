/**
 * PlexiiCells' own clipboard flavour, end to end in the real app, through the
 * machine's real clipboard (shared/cellsClipboardFormat.ts).
 *
 * CF-1 ⌘C on a Cells range writes ONE clipboard entry holding the TSV as plain
 *      text (exactly as before) and the PlexiiCells flavour beside it: the
 *      range as a saved snippet of it, its column widths, and what its cells
 *      displayed (C2 =B2*$E$1 reads E1, outside the range, and shows 6).
 * CF-2 pasted with ⌘V into PlexiiDraw after the renderer has RELOADED (so the
 *      copy exists only on the system clipboard, as after a restart or from
 *      another window), it lands as ONE picture of the table: the value 6,
 *      the cell's fill and the sheet's 180px column, not a text object of tabs.
 * CF-3 pasted with ⌘V into PlexiiWrite, it lands as a TABLE of what the cells
 *      displayed (6), not a paragraph of tab-separated input.
 * CF-4 Edit › Copy in Cells' own menu bar, and the app menu's Edit › Cut
 *      (webContents.cut, what main/index.ts editAction runs), write the same
 *      flavour; the cut clears the range.
 *
 * Every result is read back from the stored document. Every item and type on
 * the pasteboard is saved before and put back after (tests/e2e/_macPasteboard.ts).
 * Screenshots of the two pastes go to $CELLS_CLIP_SHOTS when it is set.
 */
import { test, expect, type Page } from '@playwright/test'
import { join } from 'path'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'
import { keepNoticesOutOfTheWay, openDocument, readStored, rectObject, seedDrawDoc, stagePoint, v1Body } from './_drawHelpers'
import { restorePasteboard, savePasteboard, type SavedPasteboard } from './_macPasteboard'

const MIME = 'application/x-plexii-cells'
const TSV = 'Item\tQty\tTotal\nPens\t2\t=B2*$E$1'
const SHOTS = process.env.CELLS_CLIP_SHOTS

let app: LaunchedApp
let window: Page
let savedPasteboard: SavedPasteboard | null = null

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'uses the macOS pasteboard save/restore')

test.beforeAll(async () => {
  if (process.platform === 'darwin') savedPasteboard = savePasteboard()
  app = await launchApp()
  window = app.window
  await waitForReady(window)
  await chooseCloudAiSource(window)
  await suppressFeatureSpotlights(window)
  await keepNoticesOutOfTheWay(window)
})

test.afterAll(async () => {
  await app?.dispose()
  if (savedPasteboard) restorePasteboard(savedPasteboard)
})

// ── Shared ───────────────────────────────────────────────────────────────────

/** A workbook whose A1:C2 is a small table, C2 reading E1 (outside it). */
async function seedSheet(title: string): Promise<string> {
  return window.evaluate(async (t) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const rows = Array.from({ length: 12 }, () => new Array(8).fill(''))
    rows[0] = ['Item', 'Qty', 'Total', '', '3', '', '', '']
    rows[1] = ['Pens', '2', '=B2*$E$1', '', '', '', '', '']
    const body = {
      version: 2,
      activeSheet: 0,
      sheets: [
        {
          id: 's1',
          name: 'Sheet 1',
          columns: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
          rows,
          formats: { '0,0': { bold: true }, '1,2': { bg: '#fde68a' } },
          colWidths: { 0: 180 }
        }
      ]
    }
    const doc = await api.documents.create({ docType: 'sheet', title: t, body: body as never })
    return doc.id
  }, title)
}

async function openSheet(id: string): Promise<void> {
  await window.evaluate((docId) => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocument: (id: string) => void } } }
    w.__fbView?.getState().goDocument(docId)
  }, id)
  await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 10_000 })
}

const cell = (r: number, c: number) => window.locator(`[data-testid="cell-${r}-${c}"]`)

async function selectA1C2(): Promise<void> {
  await expect.poll(async () => ((await cell(1, 2).textContent()) ?? '').trim(), { timeout: 8_000 }).toBe('6')
  await cell(0, 0).click()
  await cell(1, 2).click({ modifiers: ['Shift'] })
}

/** What a paste in any of our apps reads: the main process's view of the clipboard. */
async function appClipboard(): Promise<{ text?: string; custom?: Record<string, string> }> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: { snippets: { readClipboard: () => Promise<{ text?: string; custom?: Record<string, string> }> } } }).api
    return api.snippets.readClipboard()
  })
}

async function waitForFlavour(): Promise<{ text?: string; custom?: Record<string, string> }> {
  let read: { text?: string; custom?: Record<string, string> } = {}
  await expect
    .poll(
      async () => {
        read = await appClipboard()
        return !!read.custom?.[MIME]
      },
      { timeout: 5_000 }
    )
    .toBe(true)
  return read
}

/** Put plain words on the clipboard, so a later read cannot see a stale copy. */
async function clearClipboard(): Promise<void> {
  await app.app.evaluate(({ clipboard }) => clipboard.writeText('cells-clipboard spec: cleared'))
}

// ── Copy ─────────────────────────────────────────────────────────────────────

test('CF-1 ⌘C writes the TSV and the PlexiiCells flavour in one clipboard entry', async () => {
  test.setTimeout(90_000)
  await clearClipboard()
  await openSheet(await seedSheet('CF-1 workbook'))
  await selectA1C2()
  await window.keyboard.press('Meta+c')

  const read = await waitForFlavour()
  // The plain text every other app gets: exactly the TSV Cells always wrote.
  expect(read.text).toBe(TSV)
  expect(await app.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(TSV)
  const env = JSON.parse(read.custom![MIME])
  expect(env.kind).toBe('plexiicells/clipboard')
  expect(env.version).toBe(1)
  expect(env.body).toMatchObject({
    kind: 'sheet',
    rows: [
      ['Item', 'Qty', 'Total'],
      ['Pens', '2', '=B2*$E$1']
    ],
    origin: { r: 0, c: 0 },
    formats: { '0,0': { bold: true }, '1,2': { bg: '#fde68a' } },
    colWidths: { 0: 180 }
  })
  expect(env.values).toEqual([
    ['Item', 'Qty', 'Total'],
    ['Pens', '2', '6']
  ])
})

// ── Paste into PlexiiDraw, from a fresh renderer ─────────────────────────────

type DrawNode = { id: string; type: string; assetId?: string; w?: number }
type DrawBody = { layers?: Array<{ kind: string; objects?: DrawNode[] }>; assets?: Record<string, { dataUrl?: string }> }

test('CF-2 ⌘V into PlexiiDraw after a reload: one picture of the table, its values, fill and widths', async () => {
  test.setTimeout(120_000)
  // The renderer that copied is gone: only the system clipboard holds the copy.
  await window.reload()
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
  expect((await appClipboard()).custom?.[MIME]).toBeTruthy()

  const id = await seedDrawDoc(window, v1Body([rectObject('existing', 20, 20, 40, 40)]), 'CF-2 drawing')
  await openDocument(window, id)
  const p = await stagePoint(window, 800, { x: 600, y: 450 })
  await window.mouse.click(p.x, p.y)
  await window.keyboard.press('Meta+v')

  let added: DrawNode[] = []
  let raw: DrawBody = {}
  await expect
    .poll(
      async () => {
        raw = (await readStored(window, id)).raw as DrawBody
        added = (raw.layers ?? []).filter((l) => l.kind === 'vector').flatMap((l) => l.objects ?? []).filter((o) => o.id !== 'existing')
        return added.length
      },
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0)
  // One picture, not a text object holding tabs.
  expect(added.map((o) => o.type)).toEqual(['image'])
  const url = raw.assets?.[added[0].assetId!]?.dataUrl ?? ''
  expect(url).toMatch(/^data:image\/svg\+xml;base64,/)
  const svg = Buffer.from(url.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8')
  expect(svg).toContain('>Pens<')
  expect(svg).toContain('>6<')
  expect(svg).not.toContain('#REF!')
  expect(svg).not.toContain('=B2')
  expect(svg).toContain('fill="#fde68a"')
  expect(svg).toMatch(/<rect x="0" y="0" width="180"/)
  if (SHOTS) await window.screenshot({ path: join(SHOTS, 'cf2-draw-paste.png') })
})

// ── Paste into PlexiiWrite ───────────────────────────────────────────────────

async function newestDocBody(): Promise<string> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const docs = (await api.documents.list()).filter((d) => d.docType === 'doc')
    docs.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const doc = docs[0] ? await api.documents.get(docs[0].id) : null
    return JSON.stringify(doc?.body ?? null)
  })
}

test('CF-3 ⌘V into PlexiiWrite: a table of what the cells displayed', async () => {
  test.setTimeout(90_000)
  await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocuments: () => void } } }
    w.__fbView?.getState().goDocuments()
  })
  await expect(window.getByRole('heading', { name: 'Documents', level: 1 })).toBeVisible({ timeout: 8_000 })
  const blankRow = window.locator('text=Or start blank:').locator('..')
  await blankRow.locator('button', { hasText: 'Document' }).first().click()
  const surface = window.locator('[data-testid="doc-editor-surface"]')
  await expect(surface).toBeVisible({ timeout: 8_000 })
  await surface.click()
  await surface.type('CF-3 above.')
  await window.keyboard.press('Enter')
  await window.keyboard.press('Meta+v')

  const table = surface.locator('table').first()
  await expect(table).toBeVisible({ timeout: 8_000 })
  await expect(table).toContainText('Pens')
  await expect(table.locator('td, th').filter({ hasText: /^6$/ })).toHaveCount(1)
  await expect
    .poll(async () => {
      const b = await newestDocBody()
      return b.includes('CF-3 above.') && b.includes('"type":"table"') && /"text":"6"/.test(b)
    }, { timeout: 10_000 })
    .toBe(true)
  expect(await newestDocBody()).not.toContain('=B2*$E$1')
  if (SHOTS) await window.screenshot({ path: join(SHOTS, 'cf3-write-paste.png') })
})

// ── The menu paths ───────────────────────────────────────────────────────────

test('CF-4 Edit › Copy in Cells’ menu bar and the app menu’s Edit › Cut write the flavour too', async () => {
  test.setTimeout(90_000)
  await clearClipboard()
  await openSheet(await seedSheet('CF-4 workbook'))
  await selectA1C2()
  await window.locator('[data-testid="sheet-menubar-edit"]').click()
  await window.locator('[data-testid="sheet-menubar-edit-list"]').getByRole('button', { name: /^Copy/ }).click()
  const copied = await waitForFlavour()
  expect(copied.text).toBe(TSV)
  expect(JSON.parse(copied.custom![MIME]).values[1][2]).toBe('6')

  await clearClipboard()
  await selectA1C2()
  // What the app menu's Edit › Cut runs (main/index.ts editAction).
  await app.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().length > 0)
    win?.webContents.cut()
  })
  const cut = await waitForFlavour()
  expect(cut.text).toBe(TSV)
  // The cut range is cleared; E1 outside it is kept.
  await expect.poll(async () => ((await cell(0, 0).textContent()) ?? '').trim(), { timeout: 5_000 }).toBe('')
  expect(((await cell(0, 4).textContent()) ?? '').trim()).toBe('3')
})
