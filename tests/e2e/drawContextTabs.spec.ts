/**
 * The contextual top-bar tabs DO things (4.3.41): every control below is
 * pressed as a person presses it, and the stored drawing is read back to
 * prove the document changed -- not just that the tab appeared.
 *
 *   - Group: Group, Isolate then exit, Ungroup, Make and Release Clipping
 *     Mask, and (from the Path tab beside it) Make and Release Compound Path.
 *   - Image: Replace image… (a real PNG fixture and the native Open dialog
 *     replaced in the main process) and Place as template….
 *   - Artboard: rename, W and H, a preset, portrait/landscape, Artboards….
 *
 * Throwaway profile (launchApp), PLEXI_APP=preview3. No system clipboard.
 */

import { test, expect, type Page } from '@playwright/test'
import { deflateSync } from 'zlib'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { barTab, keepNoticesOutOfTheWay, openDocument, readStored, seedDrawDoc, stagePoint } from './_drawHelpers'

let app: LaunchedApp
let window: Page
let dir: string

test.beforeAll(async () => {
  app = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
  dir = mkdtempSync(join(tmpdir(), 'plexii-draw-ctxtabs-'))
})

test.afterAll(async () => {
  await app.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const t = (id: string) => window.locator(`[data-testid="${id}"]`)
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

/** A real, valid PNG: w x h of one colour. */
function makePng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.alloc(1 + w * 3)
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const pngDataUrl = (w: number, h: number, rgb: [number, number, number]): string => `data:image/png;base64,${makePng(w, h, rgb).toString('base64')}`

function rectNode(id: string, x: number, y: number, w: number, h: number, color: string): Record<string, unknown> {
  return { id, type: 'path', shapeKind: 'rect', path: { subpaths: [{ closed: true, nodes: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }] }, fill: { type: 'solid', color } }
}

function v2Body(objects: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'artboard-1', name: 'Artboard 1', x: 0, y: 0, w: 800, h: 600, background: { type: 'solid', color: '#ffffff' } }],
    activeArtboardId: 'artboard-1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    activeLayerId: 'L1',
    assets: {},
    swatches: [],
    guides: [],
    settings: {},
    ...extra
  }
}

type Node = { id: string; type: string; clip?: boolean; children?: Node[]; path?: { subpaths: unknown[] }; assetId?: string; x?: number; y?: number; w?: number; h?: number }
type Stored = { artboards: Array<{ id: string; name: string; w: number; h: number; presetId?: string }>; layers: Array<{ id: string; kind: string; template?: boolean; objects?: Node[] }>; assets: Record<string, { w?: number; h?: number; dataUrl: string }> }

async function stored(id: string): Promise<Stored> {
  return (await readStored(window, id)).raw as Stored
}
async function top(id: string): Promise<Node[]> {
  return (await stored(id)).layers.filter((l) => l.kind === 'vector').flatMap((l) => l.objects ?? [])
}
async function clickAt(p: { x: number; y: number }, opts: { shift?: boolean } = {}): Promise<void> {
  const s = await stagePoint(window, 800, p)
  if (opts.shift) await window.keyboard.down('Shift')
  await window.mouse.click(s.x, s.y)
  if (opts.shift) await window.keyboard.up('Shift')
}
async function selectAll(): Promise<void> {
  await t('draw-canvas-scroll').focus()
  await window.keyboard.press(`${mod}+A`)
}

// ── Group / isolation ────────────────────────────────────────────────────────

test('CT-1 Group tab: Group, Isolate and exit, Ungroup, Make and Release Clipping Mask, and Compound Path, each changing the drawing', async () => {
  const id = await seedDrawDoc(window, v2Body([rectNode('a', 100, 100, 200, 150, '#e64980'), rectNode('b', 150, 150, 100, 80, '#228be6')]), 'Group tab')
  await openDocument(window, id)

  // Two objects selected: the Group tab is offered.
  await clickAt({ x: 110, y: 110 })
  await clickAt({ x: 200, y: 190 }, { shift: true })
  await barTab(window, 'group')

  // Group.
  await t('draw-group').click()
  await expect.poll(async () => (await top(id)).map((n) => n.type)).toEqual(['group'])
  const g = (await top(id))[0]
  expect(g.children!.map((c) => c.id)).toEqual(['a', 'b'])

  // Isolate it, then exit: the breadcrumb comes and goes; the drawing keeps the group.
  await t('draw-isolate').click()
  await expect(t('draw-isolation-bar')).toBeVisible()
  await expect(t('draw-exit-isolation')).toBeEnabled()
  // Inside, a click picks a member, not the group.
  await clickAt({ x: 110, y: 110 })
  await t('draw-exit-isolation').click()
  await expect(t('draw-isolation-bar')).toHaveCount(0)
  expect((await top(id)).map((n) => n.type)).toEqual(['group'])

  // Ungroup.
  await clickAt({ x: 110, y: 110 })
  await barTab(window, 'group')
  await expect(t('draw-ungroup')).toBeEnabled()
  await t('draw-ungroup').click()
  await expect.poll(async () => (await top(id)).map((n) => n.id)).toEqual(['a', 'b'])

  // Make Clipping Mask: the topmost (b) clips a.
  await selectAll()
  await barTab(window, 'group')
  await t('draw-clip-make').click()
  await expect.poll(async () => (await top(id)).map((n) => `${n.type}:${n.clip ?? false}`)).toEqual(['group:true'])
  expect((await top(id))[0].children!.map((c) => c.id)).toEqual(['a', 'b'])
  // Release it.
  await clickAt({ x: 200, y: 190 })
  await barTab(window, 'group')
  await expect(t('draw-clip-release')).toBeEnabled()
  await t('draw-clip-release').click()
  // As in Illustrator, Release stops the clipping and leaves a plain group.
  await expect.poll(async () => (await top(id)).map((n) => `${n.type}:${n.clip ?? false}`)).toEqual(['group:false'])
  expect((await top(id))[0].children!.map((c) => c.id)).toEqual(['a', 'b'])
  await t('draw-ungroup').click()
  await expect.poll(async () => (await top(id)).map((n) => n.type)).toEqual(['path', 'path'])

  // Compound Path: Make (from the Path tab beside it), then Release.
  await selectAll()
  await barTab(window, 'path')
  await t('draw-compound-make').click()
  await expect.poll(async () => (await top(id)).map((n) => `${n.type}:${n.path?.subpaths.length ?? 0}`)).toEqual(['path:2'])
  await barTab(window, 'path')
  await expect(t('draw-compound-release')).toBeEnabled()
  await t('draw-compound-release').click()
  await expect.poll(async () => (await top(id)).map((n) => `${n.type}:${n.path?.subpaths.length ?? 0}`)).toEqual(['path:1', 'path:1'])

  // Each was one undo step: undo the release and the compound path is back.
  await t('draw-undo').click()
  await expect.poll(async () => (await top(id)).length).toBe(1)
})

// ── Image ────────────────────────────────────────────────────────────────────

async function mockOpenDialog(paths: string[]): Promise<void> {
  await app.app.evaluate(async ({ dialog }, filePaths) => {
    // @ts-expect-error test override of the native Open dialog
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths })
  }, paths)
}

test('CT-2 Image tab: Replace image… swaps the picture keeping its scale and corner; Place as template… adds a template layer', async () => {
  const asset = 'asset-red'
  const body = v2Body([{ id: 'img', type: 'image', x: 100, y: 120, w: 80, h: 40, assetId: asset }], {
    assets: { [asset]: { mime: 'image/png', dataUrl: pngDataUrl(40, 20, [230, 73, 128]), w: 40, h: 20 } }
  })
  const id = await seedDrawDoc(window, body, 'Image tab')
  await openDocument(window, id)
  await clickAt({ x: 140, y: 140 })
  await barTab(window, 'image')
  await expect(t('draw-image-info')).toContainText('PNG, 40 × 20 px, placed at 80 × 40')

  // Replace image…: a 60 × 30 blue PNG, through the native Open dialog (stubbed).
  const blue = join(dir, 'blue.png')
  writeFileSync(blue, makePng(60, 30, [34, 139, 230]))
  await mockOpenDialog([blue])
  await t('draw-image-replace').click()
  await expect
    .poll(async () => {
      const n = (await top(id))[0]
      return n.assetId !== asset ? [n.x, n.y, n.w, n.h] : null
    })
    .toEqual([100, 120, 120, 60])
  const s = await stored(id)
  const now = (await top(id))[0]
  expect([s.assets[now.assetId!].w, s.assets[now.assetId!].h]).toEqual([60, 30])
  await expect(t('draw-image-info')).toContainText('PNG, 60 × 30 px, placed at 120 × 60')

  // Place as template…: the loaded cursor, a click, and a new template layer holding the picture.
  const tpl = join(dir, 'trace.png')
  writeFileSync(tpl, makePng(50, 50, [64, 192, 87]))
  await mockOpenDialog([tpl])
  await clickAt({ x: 140, y: 140 })
  await barTab(window, 'image')
  await t('draw-image-template').click()
  const at = await stagePoint(window, 800, { x: 500, y: 300 })
  await window.mouse.move(at.x, at.y)
  await expect(t('draw-place-preview')).toBeVisible()
  await window.mouse.click(at.x, at.y)
  await expect
    .poll(async () => (await stored(id)).layers.filter((l) => l.template).map((l) => (l.objects ?? []).map((o) => o.type)))
    .toEqual([['image']])
  // The original picture is untouched.
  expect((await top(id)).filter((n) => n.id === 'img')).toHaveLength(1)
})

// ── Artboard ─────────────────────────────────────────────────────────────────

test('CT-3 Artboard tab: rename, W and H, a preset, portrait and landscape, and Artboards… each change the drawing', async () => {
  const id = await seedDrawDoc(window, v2Body([rectNode('r', 100, 100, 50, 50, '#e64980')]), 'Artboard tab')
  await openDocument(window, id)
  await t('draw-canvas-scroll').focus()
  await window.keyboard.press('Shift+O')
  await barTab(window, 'artboard')
  const board = async () => (await stored(id)).artboards[0]

  // Rename (Enter commits).
  await t('draw-artboard-name').fill('Cover')
  await t('draw-artboard-name').press('Enter')
  await expect.poll(async () => (await board()).name).toBe('Cover')

  // W, then H.
  await t('draw-artboard-w').fill('640')
  await t('draw-artboard-w').press('Enter')
  await expect.poll(async () => (await board()).w).toBe(640)
  await t('draw-artboard-h').fill('480')
  await t('draw-artboard-h').press('Enter')
  await expect.poll(async () => [(await board()).w, (await board()).h]).toEqual([640, 480])
  await expect(t('draw-artboard-size')).toHaveText('640 × 480')

  // A preset.
  await t('draw-artboard-preset').selectOption('social-post')
  await expect.poll(async () => [(await board()).w, (await board()).h, (await board()).presetId]).toEqual([1080, 1080, 'social-post'])
  await t('draw-artboard-preset').selectOption('web-banner')
  await expect.poll(async () => [(await board()).w, (await board()).h]).toEqual([1600, 500])

  // Orientation: landscape is already pressed; Portrait swaps the sides, Landscape swaps them back.
  await expect(t('draw-artboard-landscape')).toBeDisabled()
  await t('draw-artboard-portrait').click()
  await expect.poll(async () => [(await board()).w, (await board()).h]).toEqual([500, 1600])
  await t('draw-artboard-landscape').click()
  await expect.poll(async () => [(await board()).w, (await board()).h]).toEqual([1600, 500])

  // Each change was its own undo step: undo the last and portrait is back.
  await t('draw-undo').click()
  await expect.poll(async () => [(await board()).w, (await board()).h]).toEqual([500, 1600])

  // Artboards…: the panel opens and lists the renamed artboard.
  await t('draw-artboard-panel-open').click()
  await expect(t('draw-artboards-panel')).toBeVisible()
  await expect(t('draw-artboards-list')).toContainText('Cover')
  await window.keyboard.press('Escape')
  // The art never moved or scaled.
  const r = (await top(id))[0] as Node & { path: { subpaths: Array<{ nodes: Array<{ x: number; y: number }> }> } }
  expect(r.path.subpaths[0].nodes[0]).toEqual({ x: 100, y: 100 })
})
