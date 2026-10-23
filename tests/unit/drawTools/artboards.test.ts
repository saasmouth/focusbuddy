// WP-ARTBOARD in the editor: the Artboard tool (⇧O), Object › Artboards, the
// Artboards panel's commands, navigation, new art on the active artboard,
// Paste on All Artboards, export scope, and the v1 / read-only gates.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DrawArtboard, DrawNode } from '../../../src/shared/draw/model'
import { nodeBounds, primaryArtboard } from '../../../src/shared/draw/ops'
import { setKeyPlatform } from '../../../src/renderer/src/components/documents/draw/commands/keys'
import { commandById } from '../../../src/renderer/src/components/documents/draw/commands/registry'
import { canvasMenuEntries } from '../../../src/renderer/src/components/documents/draw/render/CanvasContextMenu'
import {
  setDrawClipboardBackend,
  type ClipboardReadResult,
  type ClipboardWriteInput,
  type DrawClipboardBackend
} from '../../../src/renderer/src/components/documents/draw/editor/clipboard'
import { blank, harness, rect, withOlderPeer, type Harness } from './harness'

function v2(artboards: Array<Partial<DrawArtboard> & { id: string }>, objects: unknown[] = [], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: artboards.map((a, i) => ({ name: `Artboard ${i + 1}`, x: 0, y: 0, w: 100, h: 100, background: { type: 'solid', color: '#ffffff' }, ...a })),
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    assets: {},
    swatches: [],
    guides: [],
    settings: {},
    ...extra
  }
}

const ids = (h: Harness): string[] => h.doc().artboards.map((a) => a.id)
const bounds = (h: Harness, id: string) => nodeBounds(h.objects().find((o) => o.id === id) as DrawNode)
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('the Artboard tool (⇧O)', () => {
  it('⇧O picks it; dragging on the pasteboard draws a new artboard, one undo step, and makes it active', () => {
    const h = harness(blank([], {}, 400, 300))
    h.key('O', { shift: true, code: 'KeyO' })
    expect(h.state().tool).toBe('artboard')
    h.drag([500, 50], [700, 250])
    expect(h.doc().artboards).toHaveLength(2)
    expect(h.doc().artboards[1]).toMatchObject({ name: 'Artboard 2', x: 500, y: 50, w: 200, h: 200 })
    expect(primaryArtboard(h.doc()).id).toBe(h.doc().artboards[1].id)
    expect(h.state().past.map((p) => p.label)).toEqual(['New Artboard'])
    h.ed.ctx.history.undo()
    expect(h.doc().artboards).toHaveLength(1)
  })

  it('a click (no drag) on the pasteboard makes nothing; Shift-drag inside an artboard draws one there', () => {
    const h = harness(blank([], {}, 400, 300))
    h.tool('artboard')
    h.click(600, 50)
    expect(h.doc().artboards).toHaveLength(1)
    h.drag([20, 20], [120, 60], { shift: true })
    expect(h.doc().artboards[1]).toMatchObject({ x: 20, y: 20, w: 100, h: 100 })
  })

  it('dragging an artboard moves it with the art on it; Alt-drag duplicates it with its art', () => {
    const h = harness(v2([{ id: 'a' }, { id: 'b', x: 200 }], [rect('in', 210, 10, 20, 20), rect('out', 10, 10, 20, 20)]))
    h.tool('artboard')
    h.drag([250, 80], [250, 380])
    expect(h.doc().artboards[1]).toMatchObject({ x: 200, y: 300 })
    expect(bounds(h, 'in')).toMatchObject({ x: 210, y: 310 })
    expect(bounds(h, 'out')).toMatchObject({ x: 10, y: 10 })
    expect(h.state().past.at(-1)?.label).toBe('Move Artboard')
    h.drag([250, 380], [450, 380], { alt: true })
    expect(h.doc().artboards.map((a) => [a.name, a.x, a.y])).toEqual([
      ['Artboard 1', 0, 0],
      ['Artboard 2', 200, 300],
      ['Artboard 2 copy', 400, 300]
    ])
    expect(h.objects()).toHaveLength(3)
    expect(h.state().past.at(-1)?.label).toBe('Duplicate Artboard')
  })

  it('dragging a handle of the active artboard resizes it without touching the art', () => {
    const h = harness(v2([{ id: 'a', w: 100, h: 100 }, { id: 'b', x: 200 }], [rect('in', 10, 10, 20, 20)], { activeArtboardId: 'a' }))
    h.tool('artboard')
    h.drag([100, 100], [150, 120])
    expect(h.doc().artboards[0]).toMatchObject({ x: 0, y: 0, w: 150, h: 120 })
    expect(bounds(h, 'in')).toMatchObject({ x: 10, y: 10, w: 20, h: 20 })
    expect(h.state().past.at(-1)?.label).toBe('Resize Artboard')
  })

  it('clicking any artboard with any tool makes it the active one -- without an undo step or a save', () => {
    const h = harness(v2([{ id: 'a' }, { id: 'b', x: 200 }]))
    h.click(250, 50)
    expect(primaryArtboard(h.doc()).id).toBe('b')
    expect(h.state().past).toHaveLength(0)
    expect(h.emitted).toHaveLength(0)
  })

  it('a v1 drawing in a live session with an older peer refuses, and says why', () => {
    const h = withOlderPeer(harness(blank([], {}, 400, 300)))
    h.tool('artboard')
    h.drag([500, 50], [700, 250])
    expect(h.doc().artboards).toHaveLength(1)
    expect(h.state().status).toMatch(/Artboards can't be added or changed in this drawing yet: someone in this live session/)
    expect(commandById('artboard.new')!.enabled!(h.ed.ctx)).toBe(false)
  })

  it('read-only: the tool and the commands change nothing', () => {
    const h = harness(v2([{ id: 'a' }, { id: 'b', x: 200 }], [], { minWriterVersion: 99 }))
    expect(h.state().readOnly).toBe(true)
    h.tool('artboard')
    h.drag([500, 50], [700, 250])
    h.run('artboard.new')
    h.run('artboard.delete')
    expect(ids(h)).toEqual(['a', 'b'])
    // Looking is fine: going to an artboard works on a read-only drawing.
    h.run('artboard.activate', 'b')
    expect(primaryArtboard(h.doc()).id).toBe('b')
  })
})

describe('Object › Artboards and the panel', () => {
  it('New Artboard adds one to the right of all of them, at the active one\'s size; Delete is off with one left', () => {
    const h = harness(blank([], {}, 400, 300))
    expect(commandById('artboard.delete')!.enabled!(h.ed.ctx)).toBe(false)
    h.run('artboard.new')
    expect(h.doc().artboards[1]).toMatchObject({ x: 420, y: 0, w: 400, h: 300 })
    expect(commandById('artboard.delete')!.enabled!(h.ed.ctx)).toBe(true)
    h.run('artboard.delete')
    expect(h.doc().artboards).toHaveLength(1)
    expect(h.state().past.map((p) => p.label)).toEqual(['New Artboard', 'Delete Artboard'])
  })

  it('rename, reorder, size and preset are each one labelled undo step', () => {
    const h = harness(v2([{ id: 'a' }, { id: 'b', x: 200 }, { id: 'c', x: 400 }]))
    h.run('artboard.rename', { id: 'b', name: 'Cover' })
    h.run('artboard.reorder', { id: 'c', index: 0 })
    h.run('artboard.patch', { id: 'a', patch: { w: 1080, h: 1080, presetId: 'social-post' }, label: 'Artboard preset' })
    expect(h.doc().artboards.map((a) => [a.id, a.name])).toEqual([
      ['c', 'Artboard 3'],
      ['a', 'Artboard 1'],
      ['b', 'Cover']
    ])
    expect(h.doc().artboards[1]).toMatchObject({ w: 1080, h: 1080, presetId: 'social-post' })
    expect(h.state().past.map((p) => p.label)).toEqual(['Rename Artboard', 'Reorder Artboards', 'Artboard preset'])
  })

  it('Fit to Artwork Bounds and Fit to Selected Art', () => {
    const h = harness(v2([{ id: 'a' }], [rect('r', 30, 40, 50, 60), rect('s', 200, 200, 10, 10)]))
    h.run('artboard.fitToArtwork')
    expect(h.doc().artboards[0]).toMatchObject({ x: 30, y: 40, w: 180, h: 170 })
    h.ed.ctx.select(['r'])
    h.run('artboard.fitToSelection')
    expect(h.doc().artboards[0]).toMatchObject({ x: 30, y: 40, w: 50, h: 60 })
  })

  it('Rearrange All lays three artboards out in two columns, art along', () => {
    const h = harness(v2([{ id: 'a' }, { id: 'b', x: 500, y: 500 }, { id: 'c', x: 1000 }], [rect('onC', 1010, 10, 10, 10)]))
    h.run('artboard.rearrange', { layout: 'grid-by-row', count: 2, spacing: 20, withArt: true })
    expect(h.doc().artboards.map((a) => [a.x, a.y])).toEqual([
      [0, 0],
      [120, 0],
      [0, 120]
    ])
    expect(bounds(h, 'onC')).toMatchObject({ x: 10, y: 130 })
    // With no args it opens the dialog.
    h.run('artboard.rearrange')
    expect(h.state().dialog?.id).toBe('artboard-rearrange')
  })

  it('Next / Previous Artboard step through the panel order, wrapping', () => {
    const h = harness(v2([{ id: 'a' }, { id: 'b', x: 200 }, { id: 'c', x: 400 }], [], { activeArtboardId: 'c' }))
    h.run('view.nextArtboard')
    expect(primaryArtboard(h.doc()).id).toBe('a')
    h.run('view.previousArtboard')
    expect(primaryArtboard(h.doc()).id).toBe('c')
    expect(h.state().status).toBe('Artboard 3 of 3: Artboard 3')
  })

  it('⌥⌘A selects what is on the active artboard', () => {
    const h = harness(v2([{ id: 'a' }, { id: 'b', x: 200 }], [rect('r1', 10, 10, 5, 5), rect('r2', 210, 10, 5, 5)], { activeArtboardId: 'b' }))
    h.key('a', { meta: true, alt: true, code: 'KeyA' })
    expect(h.state().selection).toEqual(['r2'])
  })
})

describe('new art and pastes land on the active artboard', () => {
  class Clip implements DrawClipboardBackend {
    last: ClipboardWriteInput | null = null
    async write(i: ClipboardWriteInput): Promise<{ ok: boolean }> {
      this.last = i
      return { ok: true }
    }
    async read(): Promise<ClipboardReadResult> {
      return this.last ? { native: this.last.json } : {}
    }
    async rasterize(): Promise<string | null> {
      return null
    }
  }
  let clip: Clip
  beforeEach(() => {
    clip = new Clip()
    setDrawClipboardBackend(clip)
  })
  afterEach(() => setDrawClipboardBackend(null))

  it('Paste on All Artboards puts one copy at the same place on every artboard', async () => {
    const h = harness(v2([{ id: 'a' }, { id: 'b', x: 200 }, { id: 'c', x: 0, y: 300 }], [rect('r', 10, 20, 30, 30)], { activeArtboardId: 'a' }))
    h.ed.ctx.select(['r'])
    h.key('c', { meta: true, code: 'KeyC' })
    await settle()
    h.key('v', { meta: true, alt: true, shift: true, code: 'KeyV' })
    await settle()
    const copies = h.objects().filter((o) => o.id !== 'r').map((o) => nodeBounds(o))
    expect(copies.map((b) => [b.x, b.y])).toEqual([
      [10, 20],
      [210, 20],
      [10, 320]
    ])
    expect(h.state().past.at(-1)?.label).toBe('Paste on All Artboards')
  })

  it('Paste in Place puts the art at its spot on the ACTIVE artboard', async () => {
    const h = harness(v2([{ id: 'a' }, { id: 'b', x: 200 }], [rect('r', 10, 20, 30, 30)], { activeArtboardId: 'a' }))
    h.ed.ctx.select(['r'])
    h.key('c', { meta: true, code: 'KeyC' })
    await settle()
    h.click(250, 90) // activates artboard b
    h.key('v', { meta: true, shift: true, code: 'KeyV' })
    await settle()
    const pasted = h.objects().find((o) => o.id !== 'r')!
    expect(nodeBounds(pasted)).toMatchObject({ x: 210, y: 20 })
  })

  it('a new text box keeps within the artboard it starts on', () => {
    const h = harness(v2([{ id: 'a', w: 1000 }, { id: 'b', x: 1200, w: 300 }]))
    h.tool('text')
    h.click(1250, 50)
    const t = h.objects().find((o) => o.type === 'text')
    expect(t?.type).toBe('text')
    if (t && t.type === 'text') expect(t.x + t.w).toBeLessThanOrEqual(1200 + 300)
  })
})

describe('export and the context menu', () => {
  it('with several artboards, Export asks what to cover; with one it exports straight away', () => {
    const one = harness(blank())
    const calls: unknown[] = []
    one.ed.ctx.host.exportAs = async (f, o) => void calls.push([f, o])
    one.run('file.exportPdf')
    expect(calls).toEqual([['pdf', undefined]])
    const h = harness(v2([{ id: 'a' }, { id: 'b', x: 200 }]))
    h.run('file.exportPng')
    expect(h.state().dialog).toEqual({ id: 'export-artboards', props: { format: 'png' } })
    const got: unknown[] = []
    h.ed.ctx.host.exportAs = async (f, o) => void got.push([f, o])
    h.run('file.exportSvg', { scope: 'each' })
    expect(got).toEqual([['svg', { scope: 'each' }]])
  })

  it('the canvas context menu runs the same Copy command as ⌘C and the Edit menu, enabled the same way', () => {
    setKeyPlatform('mac')
    const h = harness(blank([rect('a', 0, 0, 10, 10)]))
    const copy = () => canvasMenuEntries(h.ed.ctx).find((e) => e !== 'sep' && e.id === 'edit.copy')
    expect(copy()).toMatchObject({ label: 'Copy', shortcut: '⌘C', enabled: false, reason: 'Select something to copy.' })
    h.ed.ctx.select(['a'])
    expect(copy()).toMatchObject({ enabled: true })
    expect(copy()!).not.toHaveProperty('reason')
    // Every greyed row says why, as the menu bar does (SPEC §9.5).
    h.ed.ctx.select([])
    const silent = canvasMenuEntries(h.ed.ctx).filter((e) => e !== 'sep' && !e.enabled && !e.reason)
    expect(silent).toEqual([])
    expect(canvasMenuEntries(h.ed.ctx).filter((e) => e !== 'sep').map((e) => (e as { id: string }).id)).toContain('artboard.new')
  })
})
