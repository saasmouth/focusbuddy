// WP-CLIPBOARD: Cut, Copy, the Paste family and Alt-drag duplicate, driven
// through the real editor, commands and keymap with a fake system clipboard.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assetIdFor } from '../../../src/shared/draw/assets'
import type { DrawDoc, DrawGroupNode, DrawImageNode, DrawNode, DrawPathNode, DrawTextNode } from '../../../src/shared/draw/model'
import { nodeBounds, nodesBounds } from '../../../src/shared/draw/ops'
import { allNodes } from '../../../src/shared/draw/tree'
import { buildMenu } from '../../../src/renderer/src/components/documents/editor/DrawStudioMenuBar'
import {
  SVG_PASTE_UNAVAILABLE,
  buildClipboard,
  centreDelta,
  landPayload,
  looksLikeSvg,
  parseClipboardPayload,
  registerSvgPasteImporter,
  setDrawClipboardBackend,
  type ClipboardReadResult,
  type ClipboardWriteInput,
  type DrawClipboardBackend
} from '../../../src/renderer/src/components/documents/draw/editor/clipboard'
import { blank, harness, rect, type Harness } from './harness'

// A 1x1 PNG and a tiny JPEG header (only the bytes' identity matters here).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='

/** The fake system clipboard: what was last written, and what a read returns. */
class FakeClipboard implements DrawClipboardBackend {
  written: ClipboardWriteInput[] = []
  next: ClipboardReadResult | null = null
  failWrite: string | null = null
  rasterized = 0
  async write(input: ClipboardWriteInput): Promise<{ ok: boolean; error?: string }> {
    if (this.failWrite) return { ok: false, error: this.failWrite }
    this.written.push(input)
    this.next = { native: input.json, svg: input.svg, text: input.svg, image: input.png ? { dataUrl: input.png, w: 1, h: 1 } : undefined }
    return { ok: true }
  }
  async read(): Promise<ClipboardReadResult> {
    return this.next ?? {}
  }
  async rasterize(): Promise<string | null> {
    this.rasterized += 1
    return PNG
  }
}

let cb: FakeClipboard
beforeEach(() => {
  cb = new FakeClipboard()
  setDrawClipboardBackend(cb)
  // WP-IMPORT registers the real SVG importer when the command registry loads;
  // tests that need it register it themselves (see "SVG paste, with WP-IMPORT").
  registerSvgPasteImporter(null)
})
afterEach(() => {
  setDrawClipboardBackend(null)
  registerSvgPasteImporter(null)
})

/** Let a command's clipboard round trip finish. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

async function run(h: Harness, id: string, args?: unknown): Promise<void> {
  h.run(id, args)
  await settle()
}

const pathOf = (h: Harness, id: string): DrawPathNode => h.objects().find((o) => o.id === id) as DrawPathNode
const ids = (h: Harness): string[] => h.objects().map((o) => o.id)
const boxOf = (n: DrawNode): { x: number; y: number; w: number; h: number } => nodeBounds(n)

/** A v2 drawing (so groups, swatches and several artboards are allowed). */
function v2(objects: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'ab1', name: 'Artboard 1', x: 0, y: 0, w: 400, h: 300, background: { type: 'solid', color: '#ffffff' } }],
    activeLayerId: 'L1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    assets: {},
    swatches: [],
    guides: [],
    settings: {},
    ...extra
  }
}

describe('Copy', () => {
  it('writes native JSON, SVG cropped to the art, and a PNG -- and touches neither the document nor undo', async () => {
    const h = harness(blank([rect('a', 10, 20, 40, 30, { stroke: { paint: { type: 'solid', color: '#000000' }, width: 4 } }), rect('b', 200, 200, 10, 10)]))
    h.ed.ctx.select(['a'])
    const before = h.doc()
    await run(h, 'edit.copy')
    expect(h.doc()).toBe(before)
    expect(h.state().past).toHaveLength(0)
    expect(cb.written).toHaveLength(1)
    const w = cb.written[0]
    const payload = JSON.parse(w.json)
    expect(payload.kind).toBe('plexiidraw/clipboard')
    expect(payload.nodes.map((n: DrawNode) => n.id)).toEqual(['a'])
    // Cropped to the art, padded by half the stroke.
    expect(w.svg).toContain('viewBox="8 18 44 34"')
    expect(w.svg).toContain('<path')
    expect(w.svg).not.toContain('#ffffff') // no artboard background in a copy
    expect(w.png).toBe(PNG)
    expect(w.pngScale).toBe(2)
  })

  it('is disabled with nothing copyable, and its key then falls through', async () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10, { locked: true })]))
    const copy = buildMenu(h.ed.ctx, 'edit').find((i) => i.kind === 'item' && i.label === 'Copy')
    expect(copy && copy.kind === 'item' && copy.disabled).toBe(true)
    h.ed.ctx.select(['a']) // a stale selection of a locked object copies nothing
    expect(h.key('c', { meta: true }).prevented).toBe(false)
    await settle()
    expect(cb.written).toHaveLength(0)
  })

  it('⌘C copies and is swallowed; a failed write says so', async () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    expect(h.key('c', { meta: true }).prevented).toBe(true)
    await settle()
    expect(cb.written).toHaveLength(1)
    cb.failWrite = 'denied'
    await run(h, 'edit.copy')
    expect(h.state().status).toBe("Couldn't copy: denied")
  })

  it('copies from a read-only drawing (copying never edits); pasting there is off', async () => {
    const h = harness({ ...blank([rect('a', 0, 0, 10, 10)]), schemaVersion: 3 })
    h.ed.ctx.select(['a'])
    await run(h, 'edit.copy')
    expect(cb.written).toHaveLength(1)
    const menu = buildMenu(h.ed.ctx, 'edit')
    for (const label of ['Paste', 'Paste in Front', 'Paste in Back', 'Paste in Place', 'Cut']) {
      const it = menu.find((i) => i.kind === 'item' && i.label === label)
      expect(it && it.kind === 'item' && it.disabled, label).toBe(true)
    }
  })
})

describe('Paste', () => {
  it('duplicates with the same geometry and a new id, centred in the window, one "Paste" step, selected', async () => {
    const h = harness(blank([rect('a', 10, 20, 40, 30)]))
    h.ed.ctx.viewport.visibleRect = () => ({ x: 100, y: 100, w: 200, h: 100 })
    h.ed.ctx.select(['a'])
    await run(h, 'edit.copy')
    await run(h, 'edit.paste')
    expect(h.objects()).toHaveLength(2)
    const copy = h.objects()[1] as DrawPathNode
    expect(copy.id).not.toBe('a')
    const a = boxOf(pathOf(h, 'a'))
    const b = boxOf(copy)
    expect([b.w, b.h]).toEqual([a.w, a.h])
    expect([b.x + b.w / 2, b.y + b.h / 2]).toEqual([200, 150])
    expect(h.state().selection).toEqual([copy.id])
    expect(h.state().past.map((p) => p.label)).toEqual(['Paste'])
    h.ed.history.undo()
    expect(ids(h)).toEqual(['a'])
  })

  it('without a window size it centres on the artboard', async () => {
    const h = harness(blank([rect('a', 0, 0, 20, 20)]))
    h.ed.ctx.select(['a'])
    await run(h, 'edit.copy')
    await run(h, 'edit.paste')
    const b = boxOf(h.objects()[1])
    expect([b.x + b.w / 2, b.y + b.h / 2]).toEqual([200, 150])
  })

  it('⌘V pastes and ⌘X cuts', async () => {
    const h = harness(blank([rect('a', 0, 0, 20, 20)]))
    h.ed.ctx.select(['a'])
    expect(h.key('x', { meta: true }).prevented).toBe(true)
    await settle()
    expect(ids(h)).toEqual([])
    expect(h.state().past.map((p) => p.label)).toEqual(['Cut'])
    expect(h.key('v', { meta: true }).prevented).toBe(true)
    await settle()
    expect(h.objects()).toHaveLength(1)
  })

  it('Cut deletes only once the clipboard has the art; a refused write leaves the drawing alone', async () => {
    const h = harness(blank([rect('a', 0, 0, 20, 20)]))
    h.ed.ctx.select(['a'])
    cb.failWrite = 'busy'
    await run(h, 'edit.cut')
    expect(ids(h)).toEqual(['a'])
    expect(h.state().past).toHaveLength(0)
    expect(h.state().status).toBe("Couldn't copy: busy")
  })

  it('Paste in Place keeps the coordinates exactly', async () => {
    const h = harness(blank([rect('a', 13, 27, 40, 30)]))
    h.ed.ctx.viewport.visibleRect = () => ({ x: 300, y: 300, w: 50, h: 50 })
    h.ed.ctx.select(['a'])
    await run(h, 'edit.copy')
    await run(h, 'edit.pasteInPlace')
    expect(boxOf(h.objects()[1])).toEqual(boxOf(pathOf(h, 'a')))
    expect(h.state().past.map((p) => p.label)).toEqual(['Paste in Place'])
  })

  it('Paste in Front goes directly above the frontmost selected object, Paste in Back below the backmost, at the same position', async () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10), rect('c', 40, 0, 10, 10), rect('d', 60, 0, 10, 10)]))
    h.ed.ctx.select(['d'])
    await run(h, 'edit.copy')
    h.ed.ctx.select(['b', 'a'])
    await run(h, 'edit.pasteInFront')
    const front = h.state().selection[0]
    expect(ids(h)).toEqual(['a', 'b', front, 'c', 'd'])
    expect(boxOf(h.objects()[2]).x).toBe(60)
    h.ed.ctx.select(['c', 'b'])
    await run(h, 'edit.pasteInBack')
    const back = h.state().selection[0]
    expect(ids(h)).toEqual(['a', back, 'b', front, 'c', 'd'])
    expect(h.state().past.map((p) => p.label)).toEqual(['Paste in Front', 'Paste in Back'])
  })

  it('with nothing selected, Paste in Front / Back go to the top / bottom of the active layer', async () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    await run(h, 'edit.copy')
    h.ed.ctx.select([])
    await run(h, 'edit.pasteInBack')
    expect(ids(h)[0]).toBe(h.state().selection[0])
    h.ed.ctx.select([])
    await run(h, 'edit.pasteInFront')
    expect(ids(h)[3]).toBe(h.state().selection[0])
  })

  it('Paste in Front inside a group lands inside that group', async () => {
    const g = { id: 'g', type: 'group', children: [rect('m1', 0, 0, 10, 10), rect('m2', 20, 0, 10, 10)] }
    const h = harness(v2([g, rect('x', 100, 100, 10, 10)]))
    h.ed.ctx.select(['x'])
    await run(h, 'edit.copy')
    h.ed.ctx.select(['m1'])
    await run(h, 'edit.pasteInFront')
    const grp = h.objects()[0] as DrawGroupNode
    expect(grp.children.map((c) => c.id)).toEqual(['m1', h.state().selection[0], 'm2'])
  })

  it('refuses a hidden target layer honestly', async () => {
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    h.ed.ctx.select(['a'])
    await run(h, 'edit.copy')
    h.ed.ctx.set({ doc: { ...h.doc(), layers: h.doc().layers.map((l) => ({ ...l, visible: false })) } })
    await run(h, 'edit.paste')
    expect(h.state().status).toBe('Can\'t paste into "Layer 1": the layer is hidden.')
    expect(h.state().past).toHaveLength(0)
  })

  it('pasting several times gives fresh ids every time, groups included', async () => {
    const g = { id: 'g', type: 'group', children: [rect('m1', 0, 0, 10, 10), { id: 'g2', type: 'group', children: [rect('m2', 20, 0, 10, 10)] }] }
    const h = harness(v2([g]))
    h.ed.ctx.select(['g'])
    await run(h, 'edit.copy')
    await run(h, 'edit.pasteInPlace')
    await run(h, 'edit.pasteInPlace')
    const all = allNodes(h.doc()).map((n) => n.node.id)
    expect(new Set(all).size).toBe(all.length)
    expect(all).toHaveLength(12)
  })
})

describe('Paste on All Artboards', () => {
  const boards = [
    { id: 'ab1', name: 'A', x: 0, y: 0, w: 400, h: 300, background: { type: 'none' } },
    { id: 'ab2', name: 'B', x: 500, y: 0, w: 400, h: 300, background: { type: 'none' } },
    { id: 'ab3', name: 'C', x: 0, y: 400, w: 400, h: 300, background: { type: 'none' } }
  ]

  it('with one artboard it is Paste in Place on that artboard, as in Illustrator (menu and ⌥⇧⌘V)', async () => {
    const h = harness(blank([rect('a', 10, 10, 10, 10)]))
    const item = buildMenu(h.ed.ctx, 'edit').find((i) => i.kind === 'item' && i.label === 'Paste on All Artboards')
    expect(item && item.kind === 'item' && item.disabled).toBe(false)
    h.ed.ctx.select(['a'])
    await run(h, 'edit.copy')
    expect(h.key('V', { meta: true, shift: true, alt: true }).prevented).toBe(true)
    await settle()
    expect(boxOf(h.objects()[1])).toEqual(boxOf(pathOf(h, 'a')))
    expect(h.state().past.map((p) => p.label)).toEqual(['Paste in Place'])
  })

  it('⌥⇧⌘V on a real Mac keyboard, where Option makes the V key type "◊", still pastes on all artboards (physical key)', async () => {
    const h = harness(v2([rect('a', 10, 20, 10, 10)], { artboards: boards }))
    h.ed.ctx.select(['a'])
    await run(h, 'edit.copy')
    // macOS reports e.key '◊' for Option+Shift+V (US layout); e.code stays 'KeyV'.
    expect(h.key('◊', { meta: true, shift: true, alt: true, code: 'KeyV' }).prevented).toBe(true)
    await settle()
    expect(h.objects()).toHaveLength(1 + boards.length)
    expect(h.state().past.map((p) => p.label)).toEqual(['Paste on All Artboards'])
    // And ⇧⌘V without Option stays Paste in Place (one copy).
    h.key('V', { meta: true, shift: true, code: 'KeyV' })
    await settle()
    expect(h.objects()).toHaveLength(2 + boards.length)
    expect(h.state().past.map((p) => p.label)).toEqual(['Paste on All Artboards', 'Paste in Place'])
  })

  it('with only some anchors of a path selected (Direct Selection), Copy and Cut take the whole path, as Illustrator does', async () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40), rect('b', 100, 100, 10, 10)]))
    h.ed.ctx.select(['a'])
    h.ed.ctx.set({ anchors: { a: [[0, 0]] } })
    await run(h, 'edit.copy')
    const parsed = parseClipboardPayload(cb.written.at(-1)!.json)!
    expect(parsed.nodes).toHaveLength(1)
    expect((parsed.nodes[0] as DrawPathNode).path.subpaths[0].nodes).toHaveLength(pathOf(h, 'a').path.subpaths[0].nodes.length)
    h.ed.ctx.select(['a'])
    h.ed.ctx.set({ anchors: { a: [[0, 0]] } })
    await run(h, 'edit.cut')
    expect(h.objects().map((o) => o.id)).toEqual(['b'])
  })

  it('pastes one copy per artboard at the same place on each, one step', async () => {
    const h = harness(v2([rect('a', 10, 20, 10, 10)], { artboards: boards }))
    h.ed.ctx.select(['a'])
    await run(h, 'edit.copy')
    const item = buildMenu(h.ed.ctx, 'edit').find((i) => i.kind === 'item' && i.label === 'Paste on All Artboards')
    expect(item && item.kind === 'item' && item.disabled).toBe(false)
    h.key('V', { meta: true, shift: true, alt: true })
    await settle()
    const placed = h.objects().slice(1).map((o) => [boxOf(o).x, boxOf(o).y])
    expect(placed).toEqual([
      [10, 20],
      [510, 20],
      [10, 420]
    ])
    expect(new Set(h.state().selection).size).toBe(3)
    expect(h.state().past.map((p) => p.label)).toEqual(['Paste on All Artboards'])
  })
})

describe('between drawings', () => {
  const swatchDoc = (): Record<string, unknown> => {
    const img = { id: 'img', type: 'image', x: 50, y: 50, w: 20, h: 10, assetId: assetIdFor(PNG) }
    const g = {
      id: 'g',
      type: 'group',
      clip: false,
      children: [rect('r', 0, 0, 30, 30, { fill: { type: 'swatch', id: 'sw1' }, stroke: { paint: { type: 'swatch', id: 'sw1', tint: 0.5 }, width: 2 } }), img]
    }
    return v2([g, rect('other', 300, 0, 10, 10)], {
      assets: { [assetIdFor(PNG)]: { mime: 'image/png', dataUrl: PNG, w: 1, h: 1 } },
      swatches: [
        { id: 'sw1', name: 'Brand', color: '#ff0000', global: true },
        { id: 'unused', name: 'Unused', color: '#00ff00' }
      ]
    })
  }

  it('keep groups, styles, swatches and images (only what the art uses travels)', async () => {
    const src = harness(swatchDoc())
    src.ed.ctx.select(['g'])
    await run(src, 'edit.copy')
    const payload = JSON.parse(cb.written[0].json)
    expect(payload.swatches.map((s: { id: string }) => s.id)).toEqual(['sw1'])
    expect(Object.keys(payload.assets)).toEqual([assetIdFor(PNG)])

    const dst = harness(v2([]))
    await run(dst, 'edit.pasteInPlace')
    const g = dst.objects()[0] as DrawGroupNode
    expect(g.type).toBe('group')
    expect(g.children.map((c) => c.type)).toEqual(['path', 'image'])
    expect(g.children.map((c) => c.id)).not.toContain('r')
    const r = g.children[0] as DrawPathNode
    expect(r.fill).toEqual({ type: 'swatch', id: 'sw1' })
    expect(r.stroke).toEqual({ paint: { type: 'swatch', id: 'sw1', tint: 0.5 }, width: 2 })
    expect(dst.doc().swatches).toEqual([{ id: 'sw1', name: 'Brand', color: '#ff0000', global: true }])
    expect(dst.doc().assets[assetIdFor(PNG)].dataUrl).toBe(PNG)
    expect((g.children[1] as DrawImageNode).assetId).toBe(assetIdFor(PNG))
  })

  it('a swatch whose id is taken by a different colour comes in under a new id; a same-name same-colour one is reused', () => {
    const src = harness(swatchDoc())
    const built = buildClipboard(src.doc(), ['g'])!
    const clash = harness(v2([], { swatches: [{ id: 'sw1', name: 'Other', color: '#0000ff' }] })).doc()
    const landed = landPayload(clash, parseClipboardPayload(built.json)!)
    expect(landed.doc.swatches).toHaveLength(2)
    const added = landed.doc.swatches[1]
    expect(added.id).not.toBe('sw1')
    expect(added.color).toBe('#ff0000')
    expect(((landed.nodes[0] as DrawGroupNode).children[0] as DrawPathNode).fill).toEqual({ type: 'swatch', id: added.id })

    const twin = harness(v2([], { swatches: [{ id: 'mine', name: 'Brand', color: '#FF0000' }] })).doc()
    const reused = landPayload(twin, parseClipboardPayload(built.json)!)
    expect(reused.doc.swatches.map((s) => s.id)).toEqual(['mine'])
    expect(((reused.nodes[0] as DrawGroupNode).children[0] as DrawPathNode).fill).toEqual({ type: 'swatch', id: 'mine' })
  })

  it('into a drawing still stored as v1 (v2 writes off), content only v2 can hold is refused with the reason', async () => {
    const src = harness(swatchDoc())
    src.ed.ctx.select(['g'])
    await run(src, 'edit.copy')
    const dst = harness(blank([]))
    await run(dst, 'edit.paste')
    expect(dst.objects()).toHaveLength(0)
    expect(dst.state().past).toHaveLength(0)
    expect(dst.state().status).toMatch(/^Can't paste into this drawing yet: it is saved in the older format, which can't hold /)
    // Plain v1 art pastes into it fine and it stays a v1 drawing.
    src.ed.ctx.select(['other'])
    await run(src, 'edit.copy')
    await run(dst, 'edit.paste')
    expect(dst.objects()).toHaveLength(1)
    expect((dst.emitted.at(-1) as { schemaVersion: number }).schemaVersion).toBe(1)
  })

  it('a member copied out of a transformed group keeps where it was seen', () => {
    const g = { id: 'g', type: 'group', transform: [1, 0, 0, 1, 100, 50], children: [rect('m', 0, 0, 10, 10)] }
    const doc = harness(v2([g])).doc()
    const built = buildClipboard(doc, ['m'])!
    expect(built.payload.bounds).toEqual({ x: 100, y: 50, w: 10, h: 10 })
  })
})

describe('untrusted clipboard JSON', () => {
  it('is normalised, re-keys assets whose id does not match their bytes, and drops what a newer PlexiiDraw made', async () => {
    const evil = {
      kind: 'plexiidraw/clipboard',
      version: 9,
      bounds: { x: 0, y: 0, w: 10, h: 10 },
      artboard: { x: 0, y: 0, w: 400, h: 300 },
      nodes: [
        rect('a', 0, 0, 10, 10, { fill: { type: 'solid', color: 'red;background:url(javascript:alert(1))' } }),
        { id: 'z', type: 'hologram', depth: 3 },
        { id: 'i', type: 'image', x: 0, y: 0, w: 5, h: 5, assetId: 'asset-00000000000000000000000000000000' }
      ],
      assets: { 'asset-00000000000000000000000000000000': { mime: 'image/png', dataUrl: PNG } },
      swatches: []
    }
    cb.next = { native: JSON.stringify(evil) }
    const h = harness(v2([]))
    await run(h, 'edit.pasteInPlace')
    const [a, img] = h.objects()
    expect(a.type).toBe('path')
    expect(JSON.stringify((a as DrawPathNode).fill)).not.toContain('javascript')
    expect((img as DrawImageNode).assetId).toBe(assetIdFor(PNG))
    expect(Object.keys(h.doc().assets)).toEqual([assetIdFor(PNG)])
    expect(h.state().status).toBe('1 object made in a newer PlexiiDraw was left out.')
  })

  it('anything that is not a PlexiiDraw payload is not one', () => {
    expect(parseClipboardPayload('nope')).toBeNull()
    expect(parseClipboardPayload('{"kind":"other","nodes":[]}')).toBeNull()
  })
})

describe('from other apps', () => {
  it('a PNG becomes an image object through the asset store, at its size, centred', async () => {
    cb.next = { image: { dataUrl: PNG, w: 120, h: 80 } }
    const h = harness(blank([]))
    await run(h, 'edit.paste')
    const img = h.objects()[0] as DrawImageNode
    expect(img.type).toBe('image')
    expect([img.x, img.y, img.w, img.h]).toEqual([140, 110, 120, 80])
    expect(h.doc().assets[img.assetId]).toMatchObject({ mime: 'image/png', dataUrl: PNG, w: 120, h: 80 })
    expect(h.state().past.map((p) => p.label)).toEqual(['Paste'])
    // A v1 drawing can hold a picture, so this stays a v1 save.
    expect((h.emitted.at(-1) as { schemaVersion: number }).schemaVersion).toBe(1)
  })

  it('a JPEG keeps its own bytes, and a picture larger than the window is scaled to fit it', async () => {
    cb.next = { image: { dataUrl: JPEG, w: 2000, h: 1000 } }
    const h = harness(blank([]))
    h.ed.ctx.viewport.visibleRect = () => ({ x: 0, y: 0, w: 400, h: 300 })
    await run(h, 'edit.paste')
    const img = h.objects()[0] as DrawImageNode
    expect([img.w, img.h]).toEqual([400, 200])
    expect(h.doc().assets[img.assetId].mime).toBe('image/jpeg')
  })

  it('with no SVG importer registered, SVG alone says so honestly and changes nothing', async () => {
    cb.next = { svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>' }
    const h = harness(blank([]))
    await run(h, 'edit.paste')
    expect(h.state().status).toBe(SVG_PASTE_UNAVAILABLE)
    expect(h.objects()).toHaveLength(0)
    // SVG markup in plain text (Figma's Copy as SVG) is recognised as SVG too.
    cb.next = { text: '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"></svg>' }
    await run(h, 'edit.paste')
    expect(h.state().status).toBe(SVG_PASTE_UNAVAILABLE)
  })

  it('SVG with a picture alongside pastes the picture and says why', async () => {
    cb.next = { svg: '<svg/>', image: { dataUrl: PNG, w: 10, h: 10 } }
    const h = harness(blank([]))
    await run(h, 'edit.paste')
    expect(h.objects()[0].type).toBe('image')
    expect(h.state().status).toBe(`Pasted as a picture. ${SVG_PASTE_UNAVAILABLE}`)
  })

  it('a registered SVG importer turns SVG into vectors, with fresh ids and its report', async () => {
    registerSvgPasteImporter(() => ({ nodes: [rect('s', 0, 0, 10, 10) as unknown as DrawNode], assets: {}, report: '1 filter was not imported.' }))
    cb.next = { svg: '<svg/>', image: { dataUrl: PNG, w: 10, h: 10 } }
    const h = harness(blank([]))
    await run(h, 'edit.paste')
    expect(h.objects().map((o) => o.type)).toEqual(['path'])
    expect(h.objects()[0].id).not.toBe('s')
    expect(h.state().status).toBe('1 filter was not imported.')
  })

  it('plain text becomes a text object', async () => {
    cb.next = { text: 'Hello\nworld' }
    const h = harness(blank([]))
    await run(h, 'edit.paste')
    const t = h.objects()[0] as DrawTextNode
    expect(t.type).toBe('text')
    expect(t.text).toBe('Hello\nworld')
    expect(t.lines?.length).toBeGreaterThan(0)
  })

  it('an empty or unreadable clipboard says so', async () => {
    const h = harness(blank([]))
    cb.next = {}
    await run(h, 'edit.paste')
    expect(h.state().status).toBe('Nothing on the clipboard can be pasted into a drawing.')
    cb.next = { error: 'locked' }
    await run(h, 'edit.paste')
    expect(h.state().status).toBe("Couldn't read the clipboard: locked")
    expect(h.state().past).toHaveLength(0)
  })

  it('recognises SVG text', () => {
    expect(looksLikeSvg('  <svg width="1"/>')).toBe(true)
    expect(looksLikeSvg('<?xml version="1.0"?><!-- x --><!DOCTYPE svg><svg>')).toBe(true)
    expect(looksLikeSvg('svg is a format')).toBe(false)
    expect(looksLikeSvg('<svgfoo>')).toBe(false)
  })
})

describe('Alt-drag duplicate', () => {
  it('leaves the original and drops a copy above it where the drag ended; one "Duplicate" step', () => {
    const h = harness(blank([rect('a', 10, 10, 20, 20), rect('b', 100, 100, 10, 10)]))
    h.drag([20, 20], [70, 40], { alt: true })
    expect(boxOf(pathOf(h, 'a'))).toEqual({ x: 10, y: 10, w: 20, h: 20 })
    const copyId = h.state().selection[0]
    expect(ids(h)).toEqual(['a', copyId, 'b'])
    expect(boxOf(pathOf(h, copyId))).toMatchObject({ x: 60, y: 30 })
    expect(h.state().past.map((p) => p.label)).toEqual(['Duplicate'])
    h.ed.history.undo()
    expect(ids(h)).toEqual(['a', 'b'])
  })

  it('puts the original back exactly, even after a fractional drag (screen pixels at any zoom)', () => {
    const h = harness(blank([rect('a', 100, 100, 100, 100)]), { zoom: 0.37 })
    h.drag([150.1234, 150.987], [449.333, 349.71], { alt: true }, 7)
    expect(pathOf(h, 'a')).toEqual(rect('a', 100, 100, 100, 100))
  })

  it('Alt let go before the drop is a plain move, labelled Move', () => {
    const h = harness(blank([rect('a', 10, 10, 20, 20)]))
    h.down(20, 20, { alt: true })
    h.move(40, 20, { alt: true })
    h.move(60, 20)
    h.up(60, 20)
    expect(ids(h)).toEqual(['a'])
    expect(boxOf(pathOf(h, 'a')).x).toBe(50)
    expect(h.state().past.map((p) => p.label)).toEqual(['Move'])
  })

  it('a multi-selection duplicates every member, each above its own original', () => {
    const h = harness(blank([rect('a', 0, 0, 40, 40), rect('b', 50, 0, 40, 40), rect('c', 200, 200, 10, 10)]))
    h.ed.ctx.select(['a', 'b'])
    h.drag([20, 20], [20, 120], { alt: true })
    const [ca, cb2] = h.state().selection
    expect(ids(h)).toEqual(['a', ca, 'b', cb2, 'c'])
    expect(nodesBounds([pathOf(h, ca), pathOf(h, cb2)])).toEqual({ x: 0, y: 100, w: 90, h: 40 })
  })
})

/** True when some object is reachable twice: the save IPC guard refuses that as "cyclic". */
function sharesObjects(v: unknown, seen = new Set<unknown>()): boolean {
  if (!v || typeof v !== 'object') return false
  if (seen.has(v)) return true
  seen.add(v)
  return Object.values(v as object).some((x) => sharesObjects(x, seen))
}

describe('what is saved after a paste or an Alt-drag', () => {
  it('shares no object between a copy and its original (the save path rejects that as cyclic)', async () => {
    const h = harness(blank([rect('a', 10, 10, 40, 40, { stroke: { paint: { type: 'solid', color: '#000000' }, width: 2, dash: [2, 2] } })]))
    h.drag([30, 30], [130, 30], { alt: true })
    expect(sharesObjects(h.emitted.at(-1))).toBe(false)
    h.ed.ctx.select(['a'])
    await run(h, 'edit.copy')
    await run(h, 'edit.pasteInPlace')
    await run(h, 'edit.paste')
    expect(sharesObjects(h.emitted.at(-1))).toBe(false)
    const v = harness(v2([rect('a', 10, 10, 10, 10)], { artboards: [
      { id: 'ab1', name: 'A', x: 0, y: 0, w: 400, h: 300, background: { type: 'none' } },
      { id: 'ab2', name: 'B', x: 500, y: 0, w: 400, h: 300, background: { type: 'none' } }
    ] }))
    v.ed.ctx.select(['a'])
    await run(v, 'edit.copy')
    await run(v, 'edit.pasteOnAllArtboards')
    expect(sharesObjects(v.emitted.at(-1))).toBe(false)
  })
})

describe('helpers', () => {
  it('centreDelta lands on whole pixels', () => {
    expect(centreDelta({ x: 0, y: 0, w: 11, h: 11 }, { x: 100, y: 100 })).toEqual({ dx: 95, dy: 95 })
  })

  it('a copy never carries opaque nodes', () => {
    const doc = harness(v2([{ id: 'o', type: 'hologram' }, rect('a', 0, 0, 1, 1)])).doc() as DrawDoc
    expect(buildClipboard(doc, ['o'])).toBeNull()
    expect(buildClipboard(doc, ['o', 'a'])!.payload.nodes.map((n) => n.id)).toEqual(['a'])
  })
})
