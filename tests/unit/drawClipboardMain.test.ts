/**
 * @vitest-environment node
 */
// WP-CLIPBOARD, the main-process half: what one copy puts on the system
// clipboard per platform, and how a paste reads it back -- against a fake
// Electron clipboard. (The real macOS clipboard is exercised end to end by
// tests/e2e/drawClipboard.spec.ts.)
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  written: [] as Array<Record<string, unknown>>,
  items: [] as Array<{ types: string[]; data: Record<string, Buffer> }>,
  asked: [] as string[]
}))

vi.mock('electron', () => {
  class ClipboardItem {
    constructor(public entry: Record<string, unknown>) {}
  }
  const nativeImage = {
    createFromBuffer: (b: Buffer) => {
      const ok = b.length > 4 && (b.subarray(0, 4).toString('hex') === '89504e47' || b.subarray(0, 3).toString('hex') === 'ffd8ff')
      return {
        isEmpty: () => !ok,
        getSize: () => ({ width: 64, height: 32 }),
        resize: ({ width, height }: { width: number; height: number }) => ({ isEmpty: () => false, getSize: () => ({ width, height }), toPNG: () => Buffer.from(`png ${width}x${height}`) }),
        toPNG: () => b
      }
    }
  }
  const clipboard = {
    write: async (items: Array<{ entry: Record<string, unknown> }>) => {
      state.written.push(items[0].entry)
    },
    read: async () =>
      state.items.map((it) => ({
        types: it.types,
        getType: async (t: string) => {
          state.asked.push(t)
          if (t === 'image/svg+xml') return new Promise(() => {}) // never settles, as on macOS
          const b = it.data[t]
          if (!b) throw new Error(`The type '${t}' was not found in the ClipboardItem`)
          return new Blob([new Uint8Array(b)])
        }
      }))
  }
  return { clipboard, ClipboardItem, nativeImage, BrowserWindow: class {}, dialog: {} }
})

import { DRAW_CLIPBOARD_NATIVE, clipboardEntry, filePathsFromFilenamesPlist, filePathsFromUriList, jpegTypeIn, readDrawClipboard, setClipboardFileReader, svgFlavour, svgTypeIn, writeDrawClipboard } from '../../src/main/drawClipboard'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG = `data:image/png;base64,${PNG_B64}`
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>'
const raw = (f: string): string => `electron application/osclipboard;format="${f}"`

async function text(v: unknown): Promise<string> {
  return typeof v === 'string' ? v : await (v as Blob).text()
}
async function bytes(v: unknown): Promise<Buffer> {
  return Buffer.from(await (v as Blob).arrayBuffer())
}

beforeEach(() => {
  state.written = []
  state.items = []
  state.asked = []
})

describe('the clipboard entry a copy writes', () => {
  it('on macOS: native JSON, SVG as public.svg-image, and the PNG as raw public.png with its real size declared -- no SVG source as text', async () => {
    const e = clipboardEntry({ json: '{"k":1}', svg: SVG, png: PNG, pngScale: 2 }, 'darwin')
    expect(Object.keys(e).sort()).toEqual([raw('public.png'), raw('public.svg-image'), DRAW_CLIPBOARD_NATIVE].sort())
    expect(await text(e[DRAW_CLIPBOARD_NATIVE])).toBe('{"k":1}')
    // An app that takes text before pictures (Pages, a web editor) pasted the
    // SVG source instead of the picture while the markup was text/plain.
    expect(e['text/plain']).toBeUndefined()
    expect(await text(e[raw('public.svg-image')])).toBe(SVG)
    const png = await bytes(e[raw('public.png')])
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    // pHYs: 144 dpi = 5669 px per metre, so a 2x picture pastes at the art's size.
    const at = png.indexOf('pHYs')
    expect(at).toBeGreaterThan(0)
    expect(png.readUInt32BE(at + 4)).toBe(Math.round(144 / 0.0254))
  })

  it('elsewhere: the registered image/svg+xml flavour, and the PNG scaled back to 1x', async () => {
    const e = clipboardEntry({ json: '{}', svg: SVG, png: PNG, pngScale: 2 }, 'win32')
    expect(Object.keys(e)).toContain(raw('image/svg+xml'))
    expect((await bytes(e['image/png'])).toString()).toBe('png 32x16')
    expect(svgFlavour('linux')).toBe('image/svg+xml')
  })

  it('a missing or non-PNG picture is left out rather than written wrong', () => {
    expect(Object.keys(clipboardEntry({ json: '{}', svg: SVG, pngScale: 2 }, 'darwin'))).not.toContain(raw('public.png'))
    expect(Object.keys(clipboardEntry({ json: '{}', svg: SVG, png: 'data:image/png;base64,AAAA', pngScale: 2 }, 'darwin'))).not.toContain(raw('public.png'))
    expect(Object.keys(clipboardEntry({ json: '{}', svg: SVG, png: 'javascript:alert(1)', pngScale: 2 }, 'darwin'))).toHaveLength(2)
  })

  it('Copy As › SVG Code writes the markup as text and nothing else', () => {
    expect(clipboardEntry({ json: '{}', svg: SVG, png: PNG, pngScale: 2, svgAsText: true }, 'darwin')).toEqual({ 'text/plain': SVG })
  })

  it('writes everything in ONE clipboard item (separate writes would replace each other)', async () => {
    expect(await writeDrawClipboard({ json: '{}', svg: SVG, png: PNG, pngScale: 2 })).toEqual({ ok: true })
    expect(state.written).toHaveLength(1)
    expect(Object.keys(state.written[0]).length).toBeGreaterThanOrEqual(3)
    expect(await writeDrawClipboard({ json: 1, svg: SVG } as never)).toEqual({ ok: false, error: 'Nothing to copy.' })
  })
})

describe('reading the clipboard', () => {
  it('finds the SVG flavour by its raw name on every platform', () => {
    expect(svgTypeIn(['text/plain', raw('CorePasteboardFlavorType 0x73766720')])).toBe(raw('CorePasteboardFlavorType 0x73766720'))
    expect(svgTypeIn([raw('public.svg-image')])).toBe(raw('public.svg-image'))
    expect(svgTypeIn([raw('image/svg+xml')])).toBe(raw('image/svg+xml'))
    expect(svgTypeIn(['image/svg+xml'])).toBeUndefined()
    expect(jpegTypeIn([raw('public.jpeg')])).toBe(raw('public.jpeg'))
  })

  it('reads native JSON, SVG, text and a PNG -- and never asks for image/svg+xml, which hangs on macOS', async () => {
    state.items = [
      {
        types: [DRAW_CLIPBOARD_NATIVE, 'text/plain', 'image/svg+xml', 'image/png', raw('CorePasteboardFlavorType 0x73766720')],
        data: {
          [DRAW_CLIPBOARD_NATIVE]: Buffer.from('{"kind":"x"}'),
          'text/plain': Buffer.from(SVG),
          'image/png': Buffer.from(PNG_B64, 'base64'),
          [raw('CorePasteboardFlavorType 0x73766720')]: Buffer.from(SVG)
        }
      }
    ]
    const r = await readDrawClipboard()
    expect(r.native).toBe('{"kind":"x"}')
    expect(r.svg).toBe(SVG)
    expect(r.text).toBe(SVG)
    expect(r.image).toEqual({ dataUrl: PNG, w: 64, h: 32 })
    expect(state.asked).not.toContain('image/svg+xml')
  })

  it('prefers a photo\'s own JPEG bytes over the PNG conversion', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    state.items = [{ types: ['image/png', raw('public.jpeg')], data: { 'image/png': Buffer.from(PNG_B64, 'base64'), [raw('public.jpeg')]: jpeg } }]
    const r = await readDrawClipboard()
    expect(r.image?.dataUrl).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
  })

  it('bytes that do not decode as a picture are not offered as one; one unreadable flavour does not spoil the rest', async () => {
    state.items = [{ types: ['image/png'], data: { 'image/png': Buffer.from('not a png') } }]
    expect((await readDrawClipboard()).image).toBeUndefined()
    state.items = [{ types: ['text/plain', DRAW_CLIPBOARD_NATIVE], data: { [DRAW_CLIPBOARD_NATIVE]: Buffer.from('{}') } }]
    expect(await readDrawClipboard()).toEqual({ native: '{}' })
  })
})

describe('files copied in Finder', () => {
  const NAMES = raw('NSFilenamesPboardType')
  const plist = (paths: string[]): string =>
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><array>${paths.map((p) => `<string>${p.replace(/&/g, '&amp;')}</string>`).join('')}</array></plist>`

  it('reads file URLs and the filenames list', () => {
    expect(filePathsFromUriList('# comment\r\nfile:///Users/me/A%20B.pdf\r\nhttps://example.com/x.png\nfile:///tmp/c.svg')).toEqual(['/Users/me/A B.pdf', '/tmp/c.svg'])
    expect(filePathsFromFilenamesPlist(plist(['/Users/me/R&D.png', '/tmp/x.pdf']))).toEqual(['/Users/me/R&D.png', '/tmp/x.pdf'])
  })

  it('pastes the FILES, not their names or icons, every file of a multi-file copy once', async () => {
    const read: string[][] = []
    setClipboardFileReader(async (paths) => {
      read.push(paths)
      return { files: paths.map((p) => ({ name: p.split('/').pop()!, bytes: new Uint8Array([1, 2, 3]) })), skipped: [] }
    })
    // What Finder writes for two files: per item a file URL; the name as text; the icon as a picture.
    state.items = [
      { types: ['text/uri-list', 'text/plain', 'image/png', NAMES], data: { 'text/uri-list': Buffer.from('file:///tmp/a.pdf'), 'text/plain': Buffer.from('a.pdf'), 'image/png': Buffer.from(PNG_B64, 'base64'), [NAMES]: Buffer.from(plist(['/tmp/a.pdf', '/tmp/b.png'])) } },
      { types: ['text/uri-list'], data: { 'text/uri-list': Buffer.from('file:///tmp/b.png') } }
    ]
    const r = await readDrawClipboard()
    expect(read).toEqual([['/tmp/a.pdf', '/tmp/b.png']])
    expect(r.files?.map((f) => f.name)).toEqual(['a.pdf', 'b.png'])
    expect(r.text).toBeUndefined()
    expect(r.image).toBeUndefined()
  })

  it('says which copied files could not be read', async () => {
    setClipboardFileReader(async () => ({ files: [], skipped: [{ name: 'huge.pdf', reason: 'larger than 64 MB' }] }))
    state.items = [{ types: ['text/uri-list'], data: { 'text/uri-list': Buffer.from('file:///tmp/huge.pdf') } }]
    expect(await readDrawClipboard()).toEqual({ skippedFiles: [{ name: 'huge.pdf', reason: 'larger than 64 MB' }] })
  })
})
