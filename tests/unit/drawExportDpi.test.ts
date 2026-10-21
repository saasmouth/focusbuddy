import { describe, it, expect, vi, beforeEach } from 'vitest'

// Bug 8 (GAP-MATRIX): a document's `dpi` was stored but never read by export.
// A 1240 x 1754 artboard made from the "A4 at 150dpi" preset exported as a
// 12.9 x 18.3 inch PDF page (every pixel taken as a 96dpi CSS pixel) and as a
// PNG that declared no resolution at all. The exporter is driven here with
// Electron mocked, and what it hands Chromium and the file system is asserted.

const calls: { printToPDF: unknown[]; written: Array<{ path: string; data: unknown }>; html: string[]; contentSize: number[][] } = {
  printToPDF: [],
  written: [],
  html: [],
  contentSize: []
}

// A real 1x1 PNG, so the pHYs insertion has a genuine chunk stream to walk.
const ONE_PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

vi.mock('electron', () => {
  class BrowserWindow {
    static getFocusedWindow(): unknown {
      return {}
    }
    static getAllWindows(): unknown[] {
      return [{}]
    }
    webContents = {
      capturePage: async () => ({
        getSize: () => ({ width: 1240, height: 1754 }),
        resize: () => this.webContents.capturePage(),
        toPNG: () => ONE_PX
      }),
      printToPDF: async (opts: unknown) => {
        calls.printToPDF.push(opts)
        return Buffer.from('%PDF-1.4')
      }
    }
    setContentSize(w: number, h: number): void {
      calls.contentSize.push([w, h])
    }
    async loadURL(url: string): Promise<void> {
      calls.html.push(decodeURIComponent(url.replace(/^data:text\/html;charset=utf-8,/, '')))
    }
    destroy(): void {}
  }
  return {
    BrowserWindow,
    dialog: { showSaveDialog: async () => ({ canceled: false, filePath: '/tmp/out.file' }) }
  }
})

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const writeFile = async (path: string, data: unknown): Promise<void> => {
    calls.written.push({ path, data })
  }
  return { ...actual, default: { ...actual, writeFile }, writeFile }
})

const { exportDraw, pdfPageInches, pngWithDpi } = await import('../../src/main/drawExport')

function a4(dpi?: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    width: 1240,
    height: 1754,
    background: { type: 'solid', color: '#ffffff' },
    layers: [{ id: 'l', kind: 'vector', name: 'L', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [] }],
    ...(dpi ? { dpi } : {})
  }
}

beforeEach(() => {
  calls.printToPDF.length = 0
  calls.written.length = 0
  calls.html.length = 0
  calls.contentSize.length = 0
})

describe('export honours the document dpi', () => {
  it('a 150dpi A4 artboard prints on an A4 page', async () => {
    const res = await exportDraw({ draw: a4(150) as never, title: 'a4', format: 'pdf' })
    expect(res.ok).toBe(true)
    const opts = calls.printToPDF[0] as { pageSize: { width: number; height: number } }
    // 1240 px / 150 dpi = 8.267 in (210 mm) by 11.693 in (297 mm): A4. Inches,
    // because Electron 44's printToPDF fails on microns.
    expect(opts.pageSize.width).toBeCloseTo(1240 / 150, 6)
    expect(opts.pageSize.height).toBeCloseTo(1754 / 150, 6)
    expect(opts.pageSize.width * 25.4).toBeCloseTo(210, 0)
    // The vectors are laid out at the CSS size that fills that page.
    expect(calls.html[0]).toContain('svg{display:block;width:793.6px;height:1122.56px}')
  })

  it('a document with no stored dpi prints exactly as before (96 per inch)', async () => {
    await exportDraw({ draw: a4() as never, title: 'a4', format: 'pdf' })
    const opts = calls.printToPDF[0] as { pageSize: { width: number; height: number } }
    expect(opts.pageSize).toEqual(pdfPageInches({ width: 1240, height: 1754 }))
    expect(opts.pageSize.width).toBe(1240 / 96)
    expect(calls.html[0]).not.toContain('svg{display:block')
  })

  it('a PNG export declares its dpi in a pHYs chunk, pixels untouched', async () => {
    await exportDraw({ draw: a4(150) as never, title: 'a4', format: 'png' })
    const png = calls.written[0].data as Buffer
    const at = png.indexOf(Buffer.from('pHYs', 'latin1'))
    expect(at).toBeGreaterThan(0)
    // 150 dpi = 5906 pixels per metre, unit 1 (metre).
    expect(png.readUInt32BE(at + 4)).toBe(5906)
    expect(png.readUInt32BE(at + 8)).toBe(5906)
    expect(png.readUInt8(at + 12)).toBe(1)
    // The image data chunk is the original one.
    const idat = ONE_PX.indexOf(Buffer.from('IDAT', 'latin1'))
    const len = ONE_PX.readUInt32BE(idat - 4)
    expect(png.includes(ONE_PX.subarray(idat - 4, idat + 8 + len))).toBe(true)
  })

  it('a PNG of a document with no stored dpi carries no resolution claim', async () => {
    await exportDraw({ draw: a4() as never, title: 'a4', format: 'png' })
    expect((calls.written[0].data as Buffer).equals(ONE_PX)).toBe(true)
  })
})

describe('pngWithDpi', () => {
  it('replaces an existing pHYs chunk rather than adding a second', () => {
    const once = pngWithDpi(ONE_PX, 72)
    const twice = pngWithDpi(once, 300)
    const count = (b: Buffer): number => b.toString('latin1').split('pHYs').length - 1
    expect(count(twice)).toBe(1)
    expect(twice.readUInt32BE(twice.indexOf(Buffer.from('pHYs', 'latin1')) + 4)).toBe(Math.round(300 / 0.0254))
  })

  it('writes a valid CRC (zlib agrees)', async () => {
    const { crc32 } = await import('zlib')
    if (typeof crc32 !== 'function') return
    const out = pngWithDpi(ONE_PX, 150)
    const at = out.indexOf(Buffer.from('pHYs', 'latin1'))
    const crc = out.readUInt32BE(at + 4 + 9)
    expect(crc).toBe(crc32(out.subarray(at, at + 4 + 9)))
  })

  it('leaves anything that is not a PNG alone', () => {
    const junk = Buffer.from('not a png at all, not even close')
    expect(pngWithDpi(junk, 150)).toBe(junk)
  })
})
