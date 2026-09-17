import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { readFileSync, existsSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// PlexiDraw export runs in the main process (SVG straight from the shared
// serializer; PNG/PDF through an offscreen window) behind a native save dialog.
// The dialog is mocked to a temp path and the real api.draw.export IPC is driven,
// then the written file is read back — so this proves the pipeline produces valid
// files rather than merely returning ok.

let launched: LaunchedApp | null = null
const written: string[] = []
test.afterEach(async () => {
  for (const p of written) if (existsSync(p)) rmSync(p)
  written.length = 0
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

// A document exercising both halves of the studio: a gradient-filled vector
// shape, a stroked path, type, and a raster layer with real pixels.
const ONE_PX_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const DRAW = {
  schemaVersion: 1,
  width: 400,
  height: 300,
  background: { type: 'solid', color: '#ffffff' },
  activeLayerId: 'l1',
  layers: [
    {
      id: 'l1',
      kind: 'vector',
      name: 'Shapes',
      visible: true,
      locked: false,
      opacity: 1,
      blend: 'normal',
      objects: [
        {
          id: 'grad',
          type: 'path',
          shapeKind: 'rect',
          path: { subpaths: [{ closed: true, nodes: [{ x: 20, y: 20 }, { x: 180, y: 20 }, { x: 180, y: 120 }, { x: 20, y: 120 }] }] },
          fill: { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#6d5dfc' }, { offset: 1, color: '#ec4899' }] }
        },
        {
          id: 'stroked',
          type: 'path',
          shapeKind: 'line',
          path: { subpaths: [{ closed: false, nodes: [{ x: 220, y: 40 }, { x: 370, y: 140 }] }] },
          fill: { type: 'none' },
          stroke: { paint: { type: 'solid', color: '#16a34a' }, width: 6, cap: 'round', dash: [12, 8] }
        },
        { id: 'type', type: 'text', x: 20, y: 200, w: 360, text: 'Vector & paint', fontSize: 32, fill: { type: 'solid', color: '#1c1917' } }
      ]
    },
    { id: 'l2', kind: 'raster', name: 'Paint', visible: true, locked: false, opacity: 0.8, blend: 'multiply', src: ONE_PX_PNG }
  ]
}

async function exportTo(
  app: LaunchedApp['app'],
  window: LaunchedApp['window'],
  format: string,
  path: string,
  draw: unknown = DRAW
): Promise<{ ok: boolean; path?: string; error?: string }> {
  await app.evaluate(async ({ dialog }, filePath) => {
    // @ts-expect-error test override
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, path)
  return window.evaluate(
    async ({ d, fmt }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.draw.export({ draw: d as never, title: 'artwork', format: fmt as never })
    },
    { d: draw, fmt: format }
  )
}

test('DEX-1 — SVG export writes real vector data, gradients, strokes and text included', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)
  const path = join(tmpdir(), `plexi-draw-test-${process.pid}.svg`)
  written.push(path)

  const res = await exportTo(launched.app, launched.window, 'svg', path)
  expect(res.ok).toBe(true)
  expect(existsSync(path)).toBe(true)

  const svg = readFileSync(path, 'utf-8')
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg).toContain('viewBox="0 0 400 300"')
  // A real path, not a rasterised picture of one.
  expect(svg).toContain('<path')
  expect(svg).toContain('M 20 20')
  // The gradient is a definition plus a reference, so it stays editable.
  expect(svg).toContain('<linearGradient id="grad-grad"')
  expect(svg).toContain('fill="url(#grad-grad)"')
  // Stroke styling survives.
  expect(svg).toContain('stroke-width="6"')
  expect(svg).toContain('stroke-dasharray="12 8"')
  expect(svg).toContain('stroke-linecap="round"')
  // Type stays as type.
  expect(svg).toContain('Vector')
  // The painted layer rides along with its compositing intact.
  expect(svg).toContain('mix-blend-mode:multiply')
  expect(svg).toContain('data:image/png;base64')
})

test('DEX-2 — PNG export writes a real raster image at the artboard size', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)
  const path = join(tmpdir(), `plexi-draw-test-${process.pid}.png`)
  written.push(path)

  const res = await exportTo(launched.app, launched.window, 'png', path)
  expect(res.ok).toBe(true)
  expect(existsSync(path)).toBe(true)

  const buf = readFileSync(path)
  // PNG magic number, then the IHDR width/height read straight from the header.
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(buf.readUInt32BE(16)).toBe(400)
  expect(buf.readUInt32BE(20)).toBe(300)
  expect(statSync(path).size).toBeGreaterThan(1000)
})

test('DEX-3 — a transparent artboard exports PNG with real alpha, not a white rectangle', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)
  const path = join(tmpdir(), `plexi-draw-alpha-${process.pid}.png`)
  written.push(path)

  const transparent = { ...DRAW, background: { type: 'none' } }
  const res = await exportTo(launched.app, launched.window, 'png', path, transparent)
  expect(res.ok).toBe(true)

  // PNG colour type 6 is truecolour WITH an alpha channel. A baked-in white
  // background would come back as colour type 2.
  const buf = readFileSync(path)
  expect(buf.readUInt8(25)).toBe(6)

  // And the SVG for the same document draws no background rectangle at all.
  const svgPath = join(tmpdir(), `plexi-draw-alpha-${process.pid}.svg`)
  written.push(svgPath)
  await exportTo(launched.app, launched.window, 'svg', svgPath, transparent)
  expect(readFileSync(svgPath, 'utf-8')).not.toContain('<rect x="0" y="0" width="400"')
})

test('DEX-4 — PDF export writes a real PDF', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)
  const path = join(tmpdir(), `plexi-draw-test-${process.pid}.pdf`)
  written.push(path)

  const res = await exportTo(launched.app, launched.window, 'pdf', path)
  expect(res.ok).toBe(true)
  expect(existsSync(path)).toBe(true)
  expect(readFileSync(path).subarray(0, 5).toString()).toBe('%PDF-')
  expect(statSync(path).size).toBeGreaterThan(1000)
})

test('DEX-5 — a cancelled save dialog writes nothing and reports no error', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)
  await launched.app.evaluate(async ({ dialog }) => {
    // @ts-expect-error test override
    dialog.showSaveDialog = async () => ({ canceled: true })
  })
  const res = await launched.window.evaluate(async (d) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return api.draw.export({ draw: d as never, title: 'artwork', format: 'png' })
  }, DRAW)
  expect(res.ok).toBe(false)
  expect(res.error).toBeUndefined()
})
