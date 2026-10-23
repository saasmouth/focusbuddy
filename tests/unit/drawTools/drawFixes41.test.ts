// Fixes for problems found testing 4.3.40: copying to other apps, pasting a
// file copied in Finder, Place's status, and shortcuts pressed while one of
// the studio's own fields has focus.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bytesToBase64 } from '../../../src/shared/draw/import/imageInfo'
import type { DrawImageNode } from '../../../src/shared/draw/model'
import {
  setDrawClipboardBackend,
  type ClipboardReadResult,
  type ClipboardWriteInput,
  type DrawClipboardBackend
} from '../../../src/renderer/src/components/documents/draw/editor/clipboard'
import { setImportHost, type ImportHost } from '../../../src/renderer/src/components/documents/draw/commands/import.commands'
import { fieldKeepsKey } from '../../../src/renderer/src/components/documents/draw/commands/keys'
import type { ImportDeps } from '../../../src/renderer/src/components/documents/draw/editor/importFiles'
import { loadPlaceCursor, type PlaceItem } from '../../../src/renderer/src/components/documents/draw/editor/place'
import { blank, harness, rect, withDocument } from './harness'

function png(w: number, h: number): Uint8Array {
  const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const u32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
  const chunk = (type: string, data: number[]): void => {
    parts.push(...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0)
  }
  chunk('IHDR', [...u32(w), ...u32(h), 8, 6, 0, 0, 0])
  chunk('IEND', [])
  return new Uint8Array(parts)
}
const PNG_URL = `data:image/png;base64,${bytesToBase64(png(2, 2))}`
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

const deps: ImportDeps = {
  parseXml: () => {
    throw new Error('not used')
  },
  rasterize: async () => PNG_URL,
  pdfPage: async () => ({ ok: true, dataUrl: PNG_URL, w: 612, h: 792, pages: 1 }),
  gunzip: async () => {
    throw new Error('not used')
  }
}

class FakeClipboard implements DrawClipboardBackend {
  written: ClipboardWriteInput[] = []
  next: ClipboardReadResult = {}
  async write(input: ClipboardWriteInput): Promise<{ ok: boolean; error?: string }> {
    this.written.push(input)
    return { ok: true }
  }
  async read(): Promise<ClipboardReadResult> {
    return this.next
  }
  async rasterize(): Promise<string | null> {
    return PNG_URL
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0))
}

let cb: FakeClipboard
const picked: string[] = []
beforeEach(() => {
  cb = new FakeClipboard()
  setDrawClipboardBackend(cb)
  picked.length = 0
  const host: ImportHost = {
    deps: () => deps,
    pick: async (purpose) => {
      picked.push(purpose)
      return { ok: false, files: [], skipped: [] }
    }
  }
  setImportHost(host)
})
afterEach(() => {
  setDrawClipboardBackend(null)
  setImportHost(null)
})

describe('pasting files copied in Finder', () => {
  it('a copied PDF is placed as an image of its page, not pasted as its file name', async () => {
    const h = harness(blank())
    cb.next = { files: [{ name: 'flyer.pdf', bytes: enc('%PDF-1.7\n') }], text: 'flyer.pdf' }
    h.key('v', { meta: true, code: 'KeyV' })
    await settle()
    const objs = h.objects()
    expect(objs).toHaveLength(1)
    expect(objs[0].type).toBe('image')
    expect(objs.some((o) => o.type === 'text')).toBe(false)
    const img = objs[0] as DrawImageNode
    expect([img.w, img.h]).toEqual([612, 792])
    expect(h.doc().assets[img.assetId].dataUrl).toBe(PNG_URL)
    expect(h.state().past).toHaveLength(1)
    expect(h.state().selection).toEqual([img.id])
  })

  it('PNG, JPEG and SVG files paste the way Place places them; several sit side by side', async () => {
    const h = harness(blank([], {}, 2000, 1000))
    const svg = enc('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')
    // SVG needs the XML parser, which this test does not load: its failure is said, the images still land.
    cb.next = { files: [{ name: 'a.png', bytes: png(40, 30) }, { name: 'b.png', bytes: png(20, 10) }, { name: 'c.svg', bytes: svg }] }
    h.run('edit.paste')
    await settle()
    const imgs = h.objects().filter((o): o is DrawImageNode => o.type === 'image')
    expect(imgs.map((i) => [i.w, i.h])).toEqual([
      [40, 30],
      [20, 10]
    ])
    expect(imgs[1].x).toBeGreaterThan(imgs[0].x + imgs[0].w - 1)
    expect(h.state().status).toMatch(/c\.svg/)
  })

  it('files that cannot be read are said, never pasted as text', async () => {
    const h = harness(blank())
    cb.next = { skippedFiles: [{ name: 'huge.pdf', reason: 'larger than 64 MB' }], text: 'huge.pdf' }
    h.run('edit.paste')
    await settle()
    expect(h.objects()).toHaveLength(0)
    expect(h.state().status).toBe('huge.pdf was not read: larger than 64 MB.')
  })
})

describe('copying for other apps', () => {
  it('Copy says it copied; Copy As › SVG Code puts only the markup on the clipboard as text', async () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40)]))
    h.ed.ctx.select(['a'])
    h.key('c', { meta: true, code: 'KeyC' })
    await settle()
    expect(cb.written).toHaveLength(1)
    expect(cb.written[0].png).toBe(PNG_URL)
    expect(cb.written[0].svgAsText).toBeFalsy()
    expect(h.state().status).toBe('Copied 1 object.')
    expect(h.state().busy).toBeNull()
    h.run('edit.copySvgCode')
    await settle()
    expect(cb.written[1]).toMatchObject({ svgAsText: true })
    expect(cb.written[1].svg).toMatch(/^<svg /)
  })
})

describe('Place', () => {
  it('the "Click to place" prompt is gone once the file is placed, even when it has a report', () => {
    const h = harness(blank())
    const item: PlaceItem = {
      name: 'flyer.pdf',
      label: 'PDF page',
      size: { w: 100, h: 50 },
      report: ['flyer.pdf was placed as an image of page 1.'],
      make: (r) => ({ nodes: [{ id: 'img-1', type: 'image', x: r.x, y: r.y, w: r.w, h: r.h, assetId: 'asset-00000000000000000000000000000000' }], assets: { 'asset-00000000000000000000000000000000': { mime: 'image/png', dataUrl: PNG_URL } } })
    }
    loadPlaceCursor(h.ed.ctx, [item])
    expect(h.state().status).toMatch(/^Click to place flyer\.pdf/)
    h.click(10, 10)
    expect(h.state().status).toBe('Placed flyer.pdf.')
    expect(h.state().dialog?.id).toBe('import-report')
  })
})

describe('shortcuts pressed while a studio field has focus', () => {
  it('⇧⌘P still opens Place from a panel field (it did nothing before 4.3.41)', async () => {
    const h = harness(blank())
    h.key('p', { meta: true, shift: true, code: 'KeyP', inStudioField: true })
    await settle()
    expect(picked).toEqual(['place'])
  })

  it('⌘O and ⌘0 also run from a studio field', async () => {
    // Open SVG… acts for a drawing a host bound (editor/session.ts).
    const h = withDocument(harness(blank()))
    h.key('o', { meta: true, code: 'KeyO', inStudioField: true })
    await settle()
    expect(picked).toEqual(['open'])
    h.ed.ctx.set({ zoom: 3 })
    h.key('0', { meta: true, code: 'Digit0', inStudioField: true })
    expect(h.state().zoom).toBe(1)
  })

  it('the field keeps typing and its own text-editing chords; a field outside the studio keeps every key', async () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40)]))
    h.ed.ctx.select(['a'])
    for (const [key, code] of [
      ['c', 'KeyC'],
      ['v', 'KeyV'],
      ['a', 'KeyA'],
      ['z', 'KeyZ']
    ]) {
      expect(h.key(key, { meta: true, code, inStudioField: true }).prevented).toBe(false)
    }
    expect(h.key('Backspace', { code: 'Backspace', inStudioField: true }).prevented).toBe(false)
    h.key('m', { code: 'KeyM', inStudioField: true })
    expect(h.state().tool).toBe('select')
    h.key('p', { meta: true, shift: true, code: 'KeyP', inField: true })
    await settle()
    expect(picked).toEqual([])
    await settle()
    expect(cb.written).toHaveLength(0)
    expect(h.objects()).toHaveLength(1)
  })

  it('fieldKeepsKey: plain and Shift keys and the text-editing chords stay with the field', () => {
    const k = (key: string, m: { meta?: boolean; shift?: boolean; code?: string } = {}): boolean =>
      fieldKeepsKey({ key, code: m.code, metaKey: !!m.meta, ctrlKey: false, shiftKey: !!m.shift })
    expect(k('p', { shift: true })).toBe(true)
    expect(k('x', { meta: true })).toBe(true)
    expect(k('ArrowLeft', { meta: true })).toBe(true)
    expect(k('P', { meta: true, shift: true, code: 'KeyP' })).toBe(false)
    expect(k('g', { meta: true })).toBe(false)
  })
})
