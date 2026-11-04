// A picture dragged from a browser onto a table's attachment field (owner,
// 2026-11-04): "I need to be able to drag images from a browser into a table
// attachment field, in all layouts and in focus mode and focus tiled mode."
//
// The drop carries what a browser drag carries (lib/attachmentDrop):
//   - an image address, on text/uri-list and as <img src> on text/html, the way
//     Chrome and a desk browser's <webview> describe an image drag: a data:image
//     address, or an http one served from 127.0.0.1 here (fetched by the main
//     process, which is where CORS cannot interfere);
//   - a File, the way a Finder drag (and often a Chromium page) hands it over.
// It is dispatched at the point under the cell (elementFromPoint), so whatever
// really paints there is what receives it, as a pointer would.
//
// For every place a table's cells are shown and editable, each drop must:
//   - add ONE attachment to that record's field, after the ones it had;
//   - make NO new object on the desk (the canvas's handleDrop makes a file or
//     browser work widget from such a drop, and the Workcentre claims it).
//   AD-1 free canvas           AD-2 Workcentre        AD-3 Columns
//   AD-4 Focus (full view)     AD-5 Focus tiled (split)
//   AD-6 the Field work widget's attachment editor
//   AD-7 the table's own List, Cards and Kanban views
//   AD-8 a link that is not a picture: a plain notice, nothing attached, nothing made.
// Screenshots of the drop highlight and the attached thumbnails go to AD_SHOTS.

import { test, expect, type Locator, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

// 48×48 PNGs that look different from each other in a screenshot.
const SKY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAdElEQVR42u3XQQ2AQBBD0cpBBCJQgibOnBGGg10FkOyQ2XTCTyrg3dpqv26rCBAgQIAAAZoIaufylNmgF8pHlvI0MZNSNQGTsjWjpsqgsGbIBAgQIECFQFRHxbZ33EOOi9FxU//pBq3HZhVAgAABAgSoOqgDcL4TnGpAG+YAAAAASUVORK5CYII='
const STRIPES_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAVUlEQVR42u3VsQkAIAwEQAdzRAdzCIewtrKPpaAQDlI+5Kr/0msLt8YM9zJTgIDSgf6+PzNAQPlAeggIyJYBAdkyxQgEZMuAgGyZYgSyZYoRCOgiswGps4QenHjPrwAAAABJRU5ErkJggg=='
const DATA_URL = `data:image/png;base64,${SKY_PNG}`

const SHOTS = process.env.AD_SHOTS ?? join(process.cwd(), 'test-results', 'attachment-drop')
mkdirSync(SHOTS, { recursive: true })

// ── A local web server: an image, and a page that is not one ─────────────────
let server: Server
let origin = ''
test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/img/stripes.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(Buffer.from(STRIPES_PNG, 'base64'))
    } else if (req.url?.startsWith('/article')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>An article</title><p>Words, not a picture.</p>')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// ── Seeding ──────────────────────────────────────────────────────────────────
interface Seed {
  taskId: string
  tableId: string
  rowId: string
  existing: string
  table: string
  field: string
  sticky: string
}

async function seedDesk(window: Page, opts: { kanban?: boolean } = {}): Promise<Seed> {
  return window.evaluate(
    async ({ png, kanban }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
      // The record already holds one attachment: a drop must keep it.
      const existing = await api.files.ingestBuffer({ buffer: bytes.buffer, originalName: 'already-here.png', mimeType: 'image/png' })
      const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Attachment drop desk' })
      const columns = kanban
        ? // Kanban shows each card's title column only: with no short-text column the first (here the
          // attachment) is the title, so the attachment field is on every card.
          [
            { id: 'photos', type: 'attachment', label: 'Photos', config: {} },
            { id: 'stage', type: 'single-select', label: 'Stage', config: { options: [{ id: 'todo', label: 'To do', color: '#3b82f6' }] } }
          ]
        : [
            { id: 'name', type: 'text-short', label: 'Name', config: {} },
            { id: 'photos', type: 'attachment', label: 'Photos', config: {} }
          ]
      const table = await api.tables.create({ taskId: task.id, title: 'Mood board', schema: { columns } as never })
      const row = await api.tables.createRow({ tableId: table.id, cells: kanban ? { photos: [existing.id], stage: 'todo' } : { name: 'Fox', photos: [existing.id] } })
      const mk = async (kind: string, content: string, x: number, y: number, width: number, height: number, title = ''): Promise<string> =>
        ((await api.widgets.create({ taskId: task.id, kind, title, content, x, y, width, height } as never)) as { id: string }).id
      const tableW = await mk('table', table.id, 60, 90, 560, 300, 'Mood board')
      const field = await mk(
        'field',
        JSON.stringify({ def: { id: 'f1', type: 'attachment', label: 'Receipts', config: {} }, value: [] }),
        660,
        90,
        320,
        220,
        'Receipts'
      )
      const sticky = await mk('sticky', 'Notes beside the table', 660, 340, 220, 160)
      return { taskId: task.id, tableId: table.id, rowId: row.id, existing: existing.id, table: tableW, field, sticky }
    },
    { png: SKY_PNG, kanban: !!opts.kanban }
  )
}

async function boot(opts: { kanban?: boolean } = {}): Promise<{ window: Page; seed: Seed; errors: string[] }> {
  launched = await launchApp()
  const { window } = launched
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const seed = await seedDesk(window, opts)
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }).__fbView?.getState().goTask(id), seed.taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
  return { window, seed, errors }
}

// ── Reading what happened ────────────────────────────────────────────────────
const attachments = (window: Page, seed: Seed): Promise<string[]> =>
  window.evaluate(
    async ({ t, r }) => {
      const rows = await (window as unknown as { api: typeof window.api }).api.tables.listRows(t)
      const v = rows.find((x) => x.id === r)?.cells.photos
      return Array.isArray(v) ? (v as string[]) : []
    },
    { t: seed.tableId, r: seed.rowId }
  )

const fieldValue = (window: Page, seed: Seed): Promise<string[]> =>
  window.evaluate(
    async ({ t, id }) => {
      const ws = await (window as unknown as { api: typeof window.api }).api.widgets.listByTask(t)
      const w = ws.find((x) => x.id === id)
      try {
        const v = JSON.parse(w?.content ?? '{}').value
        return Array.isArray(v) ? (v as string[]) : []
      } catch {
        return []
      }
    },
    { t: seed.taskId, id: seed.field }
  )

/** Every live object on the desk, by id and kind. */
const deskObjects = (window: Page, taskId: string): Promise<string[]> =>
  window.evaluate(
    async (t) =>
      ((await (window as unknown as { api: typeof window.api }).api.widgets.listByTask(t)) as Array<{ id: string; kind: string; archived?: boolean }>)
        .filter((w) => !w.archived)
        .map((w) => `${w.kind}:${w.id}`)
        .sort(),
    taskId
  )

// ── The drop ─────────────────────────────────────────────────────────────────
type Payload = { kind: 'url'; url: string } | { kind: 'file'; name: string; b64: string }

interface Held {
  /** The element under the point, inside the intended target. */
  onTarget: boolean
  hit: string
  /** The drop zone's own state while the drag is held. */
  zoneState: string | null
  ring: string
  dragoverClaimed: boolean
}

/**
 * Hold a drag carrying `payload` over `target`: dragenter and dragover at the
 * point under it, on whatever element is really there.
 */
async function hold(window: Page, target: Locator, payload: Payload): Promise<Held> {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  expect(box, 'drop target is on screen').not.toBeNull()
  await target.evaluate((el) => {
    document.querySelectorAll('[data-ad-target]').forEach((x) => x.removeAttribute('data-ad-target'))
    el.setAttribute('data-ad-target', '')
  })
  const at = { x: box!.x + Math.min(box!.width / 2, 120), y: box!.y + Math.min(box!.height / 2, 14) }
  return window.evaluate(
    async ({ at, payload }) => {
      const dt = new DataTransfer()
      if (payload.kind === 'url') {
        // As Chrome and a desk browser describe an image drag.
        dt.setData('text/uri-list', payload.url)
        dt.setData('text/html', `<meta charset="utf-8"><img src="${payload.url}" alt="">`)
        dt.setData('text/plain', payload.url)
      } else {
        dt.items.add(new File([Uint8Array.from(atob(payload.b64), (c) => c.charCodeAt(0))], payload.name, { type: 'image/png' }))
      }
      dt.effectAllowed = 'copyLink'
      ;(window as unknown as { __adDrag: { dt: DataTransfer; at: { x: number; y: number } } }).__adDrag = { dt, at }
      const el = document.elementFromPoint(at.x, at.y) as HTMLElement | null
      let claimed = false
      for (const type of ['dragenter', 'dragover', 'dragover']) {
        const ev = new DragEvent(type, { dataTransfer: dt, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true })
        el?.dispatchEvent(ev)
        if (type === 'dragover') claimed = ev.defaultPrevented
      }
      // dragover is a continuous event: React commits its state on a later frame.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      // The zone that owns the drop: a cell or field block around the editor, else the editor itself.
      const zone = el?.closest<HTMLElement>('[data-attachment-drop]') ?? el?.closest<HTMLElement>('[data-testid="attachment-field"]') ?? null
      const desc = (n: HTMLElement | null): string =>
        n ? `${n.tagName.toLowerCase()}${n.getAttribute('data-testid') ? `[${n.getAttribute('data-testid')}]` : ''}` : 'nothing'
      return {
        onTarget: !!el?.closest('[data-ad-target]'),
        hit: desc(el),
        zoneState: zone ? zone.getAttribute('data-attachment-drop') ?? (zone.getAttribute('data-drop-over') === 'true' ? 'over' : 'idle') : null,
        ring: zone ? (({ outlineStyle: s, outlineWidth: w, outlineOffset: o }) => `${s} ${w} offset ${o}`)(getComputedStyle(zone)) : '',
        dragoverClaimed: claimed
      }
    },
    { at, payload }
  )
}

/** Let go of the held drag: the drop, at the same point. Returns whether it was claimed. */
async function release(window: Page): Promise<boolean> {
  return window.evaluate(() => {
    const { dt, at } = (window as unknown as { __adDrag: { dt: DataTransfer; at: { x: number; y: number } } }).__adDrag
    const el = document.elementFromPoint(at.x, at.y)!
    const ev = new DragEvent('drop', { dataTransfer: dt, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true })
    el.dispatchEvent(ev)
    return ev.defaultPrevented
  })
}

/**
 * Drop `payload` on `target` and prove the outcome: exactly one attachment
 * more, after the ones already there, and no new object on the desk.
 */
async function dropAndProve(
  window: Page,
  seed: Seed,
  target: Locator,
  payload: Payload,
  read: () => Promise<string[]>,
  shot?: string
): Promise<void> {
  const before = await read()
  const objects = await deskObjects(window, seed.taskId)
  const held = await hold(window, target, payload)
  expect(held.onTarget, `the drop point lands on the target, not on ${held.hit}`).toBe(true)
  // The highlight checks are soft, so a run on a build without the feature
  // still goes on to the drop and reports what the drop DID (the outcome
  // checks below are the hard ones).
  expect.soft(held.dragoverClaimed, 'the field accepts the drag while it is held').toBe(true)
  expect.soft(held.zoneState, 'the field lights up while the drag is held').toBe('over')
  // The full 2px accent line inside the edge, at once (not easing in), drawn
  // above the chips so none of it is hidden. (The app is zoomed, so 2px
  // computes a little under 2.)
  const [style, width, , offset] = held.ring.split(' ')
  expect.soft(style, `the highlight outline is painted (${held.ring})`).toBe('solid')
  expect.soft(parseFloat(width ?? '0'), `a full-width line, not one easing in (${held.ring})`).toBeGreaterThan(1.5)
  expect.soft(parseFloat(offset ?? '0'), `inside the edge (${held.ring})`).toBeLessThan(-1.5)
  if (shot) await window.screenshot({ path: join(SHOTS, `${shot}-hover.png`) })
  expect.soft(await release(window), 'the drop is claimed').toBe(true)
  // The canvas and the Workcentre handle a drop asynchronously; give either time to make an object.
  await window.waitForTimeout(1_500)
  expect.soft(await deskObjects(window, seed.taskId), 'no new object on the desk').toEqual(objects)
  await expect.poll(read, { timeout: 15_000, message: 'one more attachment' }).toHaveLength(before.length + 1)
  const after = await read()
  expect(after.slice(0, before.length), 'appended after what was there, nothing replaced').toEqual(before)
  expect(await deskObjects(window, seed.taskId), 'still no new object on the desk').toEqual(objects)
  await expect(window.locator('[data-testid="workcentre-drop-well"]'), 'no Workcentre drop well left behind').toHaveCount(0)
  await expect(target.locator('[data-testid="attachment-chip"]')).toHaveCount(after.length)
  // The new attachment shows as a picture, and it really loaded.
  const thumb = target.locator(`[data-file-id="${after[after.length - 1]}"] [data-testid="attachment-thumb"]`)
  await expect(thumb).toBeVisible({ timeout: 5_000 })
  await expect.poll(() => thumb.evaluate((img) => (img as HTMLImageElement).naturalWidth), { timeout: 5_000 }).toBe(48)
  if (shot) await window.screenshot({ path: join(SHOTS, `${shot}-after.png`) })
}

/**
 * The attachment editor itself (its chips and "attach" button), found by what
 * every build renders -- the "attach" button (its icon may be the ligature
 * text "add") -- so the same spec runs on a build from before this feature.
 */
const editorIn = (scope: Locator): Locator => scope.locator('button', { hasText: /^\s*(add\s*)?attach\s*$/ }).first().locator('..')
const cellIn = (window: Page, scope: string): Locator => window.locator(`${scope} [data-testid="table-cell-0-1"]`).first()
const fileDrop = (name: string): Payload => ({ kind: 'file', name, b64: STRIPES_PNG })

async function pickView(window: Page, mode: 'workcentre' | 'columns' | 'canvas'): Promise<void> {
  await window.locator('[data-testid="view-selector-btn"]').first().click()
  await window.locator(`[data-testid="view-opt-${mode}"]`).click()
}

// ── The views and modes ──────────────────────────────────────────────────────

test('AD-1 — free canvas: a browser image and a file each attach to the cell; nothing lands on the desk', async () => {
  test.setTimeout(90_000)
  const { window, seed, errors } = await boot()
  const cell = cellIn(window, `[data-widget-id="${seed.table}"]`)
  await expect(cell).toBeVisible({ timeout: 10_000 })
  const read = (): Promise<string[]> => attachments(window, seed)
  expect(await read()).toEqual([seed.existing])
  await dropAndProve(window, seed, cell, fileDrop('from-finder.png'), read, 'AD-1-canvas-file')
  await dropAndProve(window, seed, cell, { kind: 'url', url: DATA_URL }, read, 'AD-1-canvas-url')
  await dropAndProve(window, seed, cell, { kind: 'url', url: `${origin}/img/stripes.png` }, read)
  const ids = await read()
  expect(ids[0]).toBe(seed.existing)
  // Stored under sensible names: the URL's own filename for the http one.
  const names = await window.evaluate(
    async (list) => Promise.all(list.map(async (id) => (await (window as unknown as { api: typeof window.api }).api.files.get(id))?.originalName ?? '?')),
    ids
  )
  expect(names[0]).toBe('already-here.png')
  expect(names[1]).toBe('from-finder.png')
  expect(names[2]).toMatch(/^image-\d+\.png$/)
  expect(names[3]).toBe('stripes.png')
  expect(errors).toEqual([])
})

test('AD-2 — Workcentre: drops on the table tile attach, and the Workcentre makes no tile of them', async () => {
  test.setTimeout(90_000)
  const { window, seed, errors } = await boot()
  await pickView(window, 'workcentre')
  await expect(window.locator('[data-testid="workcentre-grid"]')).toBeVisible({ timeout: 10_000 })
  const cell = cellIn(window, `[data-testid="workcentre-tile-${seed.table}"]`)
  await expect(cell).toBeVisible({ timeout: 10_000 })
  const read = (): Promise<string[]> => attachments(window, seed)
  await dropAndProve(window, seed, cell, { kind: 'url', url: `${origin}/img/stripes.png` }, read, 'AD-2-workcentre-url')
  await dropAndProve(window, seed, cell, fileDrop('tile.png'), read)
  await expect(window.locator('[data-testid^="workcentre-tile-"]')).toHaveCount(3)
  expect(errors).toEqual([])
})

test('AD-3 — Columns: drops on the table card attach', async () => {
  test.setTimeout(90_000)
  const { window, seed, errors } = await boot()
  await pickView(window, 'columns')
  await expect(window.locator('[data-testid="columns-view"]')).toBeVisible({ timeout: 10_000 })
  const cell = cellIn(window, `[data-testid="column-card-${seed.table}"]`)
  await expect(cell).toBeVisible({ timeout: 10_000 })
  const read = (): Promise<string[]> => attachments(window, seed)
  await dropAndProve(window, seed, cell, fileDrop('column.png'), read)
  await dropAndProve(window, seed, cell, { kind: 'url', url: DATA_URL }, read, 'AD-3-columns-url')
  expect(errors).toEqual([])
})

async function openFocus(window: Page, id: string): Promise<void> {
  await window.evaluate((w: string) => {
    ;(window as unknown as { __fbWidgets: { getState: () => { setFocused: (i: string) => void } } }).__fbWidgets.getState().setFocused(w)
  }, id)
  await expect(window.locator('[data-testid="widget-focus-mode"]')).toBeVisible({ timeout: 10_000 })
  await window.waitForTimeout(500)
}

test('AD-4 — Focus (full view): drops on the focused table attach', async () => {
  test.setTimeout(90_000)
  const { window, seed, errors } = await boot()
  await openFocus(window, seed.table)
  const cell = cellIn(window, '[data-testid="widget-focus-mode"]')
  await expect(cell).toBeVisible({ timeout: 10_000 })
  const read = (): Promise<string[]> => attachments(window, seed)
  await dropAndProve(window, seed, cell, { kind: 'url', url: `${origin}/img/stripes.png` }, read, 'AD-4-focus-url')
  await dropAndProve(window, seed, cell, fileDrop('focus.png'), read)
  expect(errors).toEqual([])
})

test('AD-5 — Focus tiled (split): drops on the table pane attach', async () => {
  test.setTimeout(120_000)
  const { window, seed, errors } = await boot()
  await openFocus(window, seed.table)
  // Tile the sticky beside it: its dock tile dragged into the body (the person's gesture).
  const tile = window.locator(`[data-testid="focus-dock-tile-${seed.sticky}"]`)
  await expect(tile).toBeVisible({ timeout: 5_000 })
  const t = (await tile.boundingBox())!
  const vp = window.viewportSize() ?? { width: 1440, height: 900 }
  const start = { x: t.x + t.width / 2, y: t.y + t.height / 2 }
  const end = { x: vp.width * 0.75, y: vp.height * 0.5 }
  await window.mouse.move(start.x, start.y)
  await window.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await window.mouse.move(start.x + ((end.x - start.x) * i) / 12, start.y + ((end.y - start.y) * i) / 12)
    await window.waitForTimeout(40)
  }
  await window.waitForTimeout(300)
  await window.mouse.up()
  const grid = window.locator('[data-testid="focus-split-grid"][data-previewing="false"]')
  await expect(grid).toBeVisible({ timeout: 8_000 })
  await expect(grid.locator('[data-split-cell]')).toHaveCount(2)
  await window.waitForTimeout(600)
  const cell = cellIn(window, '[data-testid="focus-split-grid"][data-previewing="false"]')
  await expect(cell).toBeVisible({ timeout: 10_000 })
  const read = (): Promise<string[]> => attachments(window, seed)
  await dropAndProve(window, seed, cell, { kind: 'url', url: DATA_URL }, read, 'AD-5-split-url')
  await dropAndProve(window, seed, cell, fileDrop('split.png'), read)
  // Still split, the sticky still beside it.
  await expect(grid.locator('[data-split-cell]')).toHaveCount(2)
  expect(errors).toEqual([])
})

test('AD-6 — the Field work widget: its attachment editor takes the drops and appends', async () => {
  test.setTimeout(90_000)
  const { window, seed, errors } = await boot()
  const field = editorIn(window.locator(`[data-widget-id="${seed.field}"]`))
  await expect(field).toBeVisible({ timeout: 10_000 })
  const read = (): Promise<string[]> => fieldValue(window, seed)
  expect(await read()).toEqual([])
  await dropAndProve(window, seed, field, { kind: 'url', url: `${origin}/img/stripes.png` }, read, 'AD-6-field-url')
  await dropAndProve(window, seed, field, fileDrop('receipt.png'), read, 'AD-6-field-file')
  expect(errors).toEqual([])
})

test('AD-7 — the table’s own List, Cards and Kanban views take the drop too', async () => {
  test.setTimeout(120_000)
  const { window, seed, errors } = await boot()
  const table = window.locator(`[data-widget-id="${seed.table}"]`)
  const read = (): Promise<string[]> => attachments(window, seed)
  for (const view of ['List', 'Cards'] as const) {
    await table.locator(`button[title="Switch to ${view} view"]`).click()
    // On the chips: the field's block around them owns the drop (and lights up).
    const block = editorIn(table)
    await expect(block).toBeVisible({ timeout: 5_000 })
    await dropAndProve(window, seed, block, view === 'List' ? { kind: 'url', url: DATA_URL } : fileDrop(`${view}.png`), read, `AD-7-${view.toLowerCase()}`)
  }
  expect(errors).toEqual([])
  await launched!.dispose()
  launched = null

  // Kanban shows the title column on each card: a table whose title is its attachment field.
  const k = await boot({ kanban: true })
  const kt = k.window.locator(`[data-widget-id="${k.seed.table}"]`)
  await kt.locator('button[title="Switch to Kanban view"]').click()
  const field = editorIn(kt)
  await expect(field).toBeVisible({ timeout: 5_000 })
  await dropAndProve(k.window, k.seed, field, { kind: 'url', url: `${origin}/img/stripes.png` }, () => attachments(k.window, k.seed), 'AD-7-kanban')
  expect(k.errors).toEqual([])
})

test('AD-8 — a link that is not a picture: a plain notice, nothing attached, nothing made on the desk', async () => {
  test.setTimeout(90_000)
  const { window, seed } = await boot()
  const cell = cellIn(window, `[data-widget-id="${seed.table}"]`)
  await expect(cell).toBeVisible({ timeout: 10_000 })
  const objects = await deskObjects(window, seed.taskId)
  const held = await hold(window, cell, { kind: 'url', url: `${origin}/article` })
  expect(held.onTarget).toBe(true)
  expect.soft(await release(window), 'the drop is claimed').toBe(true)
  await window.waitForTimeout(1_500)
  expect.soft(await deskObjects(window, seed.taskId), 'no new object on the desk (a browser work widget for the link)').toEqual(objects)
  const notice = window.locator('[data-testid="notice-toast"]')
  await expect(notice, 'a plain notice says why').toBeVisible({ timeout: 10_000 })
  await expect(notice).toContainText('Could not attach the image from 127.0.0.1. That address is a web page, not an image.')
  await window.screenshot({ path: join(SHOTS, 'AD-8-notice.png') })
  expect(await attachments(window, seed)).toEqual([seed.existing])
  expect(await deskObjects(window, seed.taskId)).toEqual(objects)
})
