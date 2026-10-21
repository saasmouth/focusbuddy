import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import { readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// PlexiDraw export runs entirely in the main process (SVG generation +
// rasterise/print via an offscreen window), behind a native save dialog. We mock
// the dialog to a temp path and drive the real api.map.export IPC, then read the
// written file back — proving the whole pipeline produces valid files, not just
// that a function returned ok.

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

const MAP = {
  version: 1,
  nodes: [
    { id: 'a', x: 40, y: 40, label: 'Start', shape: 'terminator', color: '#2563eb' },
    { id: 'b', x: 40, y: 200, label: 'Do the thing', shape: 'process', color: '#16a34a' },
    { id: 'c', x: 300, y: 200, label: 'Done', shape: 'decision', color: '#db2777' }
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'b', style: 'solid' },
    { id: 'e2', source: 'b', target: 'c', label: 'ok', style: 'dashed' }
  ],
  viewport: { x: 0, y: 0, zoom: 1 }
}

async function exportTo(app: LaunchedApp['app'], window: LaunchedApp['window'], format: string, path: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  // Point the main-process save dialog at our temp file for this call.
  await app.evaluate(async ({ dialog }, filePath) => {
    // @ts-expect-error test override
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, path)
  return window.evaluate(
    async ({ map, fmt }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return api.map.export({ map: map as never, title: 'diagram', format: fmt as never })
    },
    { map: MAP, fmt: format }
  )
}

test('MEX-1 — SVG export writes a valid vector file with the node labels', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)
  const path = join(tmpdir(), `plexi-map-test-${process.pid}.svg`)
  written.push(path)

  const res = await exportTo(launched.app, launched.window, 'svg', path)
  expect(res.ok).toBe(true)
  expect(existsSync(path)).toBe(true)

  const svg = readFileSync(path, 'utf-8')
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg).toContain('Start')
  expect(svg).toContain('Do the thing')
  // Lines are drawn by the shared router with real arrowheads (as on the canvas).
  expect(svg).toContain('class="pd-edge"')
  expect(svg).toContain('class="pd-arrowhead"')
  expect(svg).toContain('stroke-dasharray="9 6"') // the dashed edge (6w 4w at the 1.5px theme line)
  expect(svg).toContain('>ok<') // its label
})

test('MEX-2 — PNG export writes a real raster image', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)
  const path = join(tmpdir(), `plexi-map-test-${process.pid}.png`)
  written.push(path)

  const res = await exportTo(launched.app, launched.window, 'png', path)
  expect(res.ok).toBe(true)
  expect(existsSync(path)).toBe(true)

  const buf = readFileSync(path)
  // PNG magic number.
  expect(buf.length).toBeGreaterThan(1000)
  expect(buf[0]).toBe(0x89)
  expect(buf[1]).toBe(0x50)
  expect(buf[2]).toBe(0x4e)
  expect(buf[3]).toBe(0x47)
})

test('MEX-3 — PDF export writes a real PDF', async () => {
  launched = await launchApp()
  await waitForReady(launched.window)
  const path = join(tmpdir(), `plexi-map-test-${process.pid}.pdf`)
  written.push(path)

  const res = await exportTo(launched.app, launched.window, 'pdf', path)
  expect(res.ok).toBe(true)
  expect(existsSync(path)).toBe(true)

  const buf = readFileSync(path)
  expect(buf.length).toBeGreaterThan(500)
  expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
})
