// ToolHarness: drives the PlexiiDraw editor -- every tool, the keymap, the
// commands, undo -- with no Electron, no React and no canvas.
//
// It builds the real editor (createDrawEditor) with three fakes:
//   - FakeRaster keeps each paint layer as a plain RGBA buffer and stamps
//     brush strokes with the real brush engine's stamp geometry (brushes.ts),
//     flood-fills with the real scanline fill (raster.floodFillPixels), and
//     "encodes" a layer as a data URL of its raw bytes. That encoding is a
//     TEST STAND-IN, not a PNG; it only has to be deterministic and distinct.
//   - text measuring uses the exporter's width estimate (estimateWrap);
//   - the viewport is two numbers.
// Pointer events are given in ARTBOARD coordinates, as tools receive them.

import { estimateWrap, solid } from '../../../src/shared/draw'
import type { Pt } from '../../../src/shared/drawGeometry'
import type { DrawDoc, DrawNode } from '../../../src/shared/draw/model'
import { vectorLayersOf } from '../../../src/shared/draw/tree'
import { rasterFrame, rasterLayerFrame } from '../../../src/shared/draw/ops'
import { stampsForDot, stampsForSegment, type BrushSettings, type StrokePoint } from '../../../src/renderer/src/components/documents/draw/brushes'
import { floodFillPixels, parseHex, toHex } from '../../../src/renderer/src/components/documents/draw/raster'
import { createDrawEditor, type DrawEditor } from '../../../src/renderer/src/components/documents/draw/editor/editor'
import type { EditorState, RasterService, ToolPointer } from '../../../src/renderer/src/components/documents/draw/editor/types'
import type { LiveUndo } from '../../../src/renderer/src/lib/yjsKeyedJson'
import type { DocumentOps } from '../../../src/renderer/src/components/documents/editor/documentOps'
import { LIVE_V1_PEER_REASON } from '../../../src/renderer/src/components/documents/draw/editor/v2gate'

export class FakeRaster implements RasterService {
  buffers = new Map<string, Uint8ClampedArray>()
  scratch: Uint8ClampedArray | null = null
  /** The frame of the stroke in progress (its layer's). */
  strokeFrame = { x: 0, y: 0, w: 0, h: 0 }
  /** Layers whose surface is "not mounted yet". */
  unmounted = new Set<string>()
  invalidations = 0
  /** Every reframe asked for, in order. */
  reframes: Array<{ src: string; from: { w: number; h: number }; to: { w: number; h: number }; dx: number; dy: number }> = []
  /** Sources the fake "cannot decode" (reframe hands them back untouched). */
  undecodable = new Set<string>()
  /**
   * `frame` is a paint layer's frame in document space (its pixel size and
   * where it lies); without an id, the default frame. Points reach the fake
   * in document space, as they reach the real service.
   */
  constructor(private frame: (layerId?: string) => { x: number; y: number; w: number; h: number }) {}

  private size(layerId?: string): { w: number; h: number } {
    const f = this.frame(layerId)
    return { w: f.w, h: f.h }
  }

  buffer(layerId: string): Uint8ClampedArray {
    let b = this.buffers.get(layerId)
    const { w, h } = this.size(layerId)
    if (!b || b.length !== w * h * 4) {
      b = new Uint8ClampedArray(w * h * 4)
      this.buffers.set(layerId, b)
    }
    return b
  }

  /** Count of pixels with any alpha on a layer. */
  painted(layerId: string): number {
    const b = this.buffer(layerId)
    let n = 0
    for (let i = 3; i < b.length; i += 4) if (b[i] > 0) n++
    return n
  }

  /** Set a pixel by its position in the LAYER's own pixels. */
  setPixel(layerId: string, x: number, y: number, rgba: [number, number, number, number]): void {
    const { w } = this.size(layerId)
    const b = this.buffer(layerId)
    b.set(rgba, (y * w + x) * 4)
  }

  private stamp(target: Uint8ClampedArray, s: { x: number; y: number; rx: number; ry: number; alpha: number }, color: string): void {
    const { w, h } = this.strokeFrame
    const rgb = parseHex(color) ?? { r: 0, g: 0, b: 0 }
    const r = Math.max(s.rx, s.ry)
    const cx = s.x - this.strokeFrame.x
    const cy = s.y - this.strokeFrame.y
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue
        const i = (y * w + x) * 4
        target[i] = rgb.r
        target[i + 1] = rgb.g
        target[i + 2] = rgb.b
        target[i + 3] = Math.max(target[i + 3], Math.round(255 * s.alpha))
      }
    }
  }

  hasSurface(layerId: string): boolean {
    return !this.unmounted.has(layerId)
  }
  floodFill(layerId: string, p: Pt, color: string, tolerance: number): boolean {
    const rgb = parseHex(color)
    if (!rgb) return false
    const f = this.frame(layerId)
    return floodFillPixels(this.buffer(layerId), f.w, f.h, Math.floor(p.x - f.x), Math.floor(p.y - f.y), [rgb.r, rgb.g, rgb.b, 255], tolerance)
  }
  beginStroke(p: StrokePoint, brush: BrushSettings, layerId?: string): void {
    this.strokeFrame = { ...this.frame(layerId) }
    this.scratch = new Uint8ClampedArray(this.strokeFrame.w * this.strokeFrame.h * 4)
    for (const s of stampsForDot(p, brush)) this.stamp(this.scratch, s, brush.color)
  }
  strokeTo(from: StrokePoint, to: StrokePoint, brush: BrushSettings): void {
    if (!this.scratch) return
    for (const s of stampsForSegment(from, to, brush)) this.stamp(this.scratch, s, brush.color)
  }
  endStroke(layerId: string, brush: BrushSettings, erase: boolean): boolean {
    const sc = this.scratch
    if (!sc || !this.hasSurface(layerId)) return false
    const b = this.buffer(layerId)
    if (b.length !== sc.length) return false
    const k = Math.max(0, Math.min(1, brush.opacity))
    for (let i = 0; i < sc.length; i += 4) {
      const a = (sc[i + 3] / 255) * k
      if (a <= 0) continue
      if (erase) b[i + 3] = Math.round(b[i + 3] * (1 - a))
      else {
        b[i] = sc[i]
        b[i + 1] = sc[i + 1]
        b[i + 2] = sc[i + 2]
        b[i + 3] = Math.max(b[i + 3], Math.round(255 * a))
      }
    }
    this.scratch = null
    return true
  }
  sample(layerId: string, p: Pt): string | null {
    const f = this.frame(layerId)
    const x = Math.floor(p.x - f.x)
    const y = Math.floor(p.y - f.y)
    if (x < 0 || y < 0 || x >= f.w || y >= f.h) return null
    const b = this.buffer(layerId)
    const i = (y * f.w + x) * 4
    return b[i + 3] === 0 ? null : toHex(b[i], b[i + 1], b[i + 2])
  }
  snapshot(layerId: string): string {
    return `data:image/png;base64,${Buffer.from(this.buffer(layerId)).toString('base64')}`
  }
  invalidate(): void {
    this.invalidations += 1
  }
  /** A stand-in re-lay: a distinct, valid data URL naming what was asked for (the fake decodes nothing). */
  async reframe(src: string, from: { w: number; h: number }, to: { w: number; h: number }, dx: number, dy: number): Promise<string> {
    this.reframes.push({ src, from, to, dx, dy })
    if (this.undecodable.has(src)) return src
    return `data:image/png;base64,${Buffer.from(`relaid:${to.w}x${to.h}@${dx},${dy}:${src.length}`).toString('base64')}`
  }
}

export interface Mods {
  shift?: boolean
  alt?: boolean
  meta?: boolean
  ctrl?: boolean
  button?: number
  pressure?: number
  detail?: number
}

/** A blank v1 drawing of `w` x `h` with one vector layer holding `objects`. */
export function blank(objects: unknown[] = [], extra: Record<string, unknown> = {}, w = 400, h = 300): Record<string, unknown> {
  return {
    schemaVersion: 1,
    width: w,
    height: h,
    background: { type: 'solid', color: '#ffffff' },
    activeLayerId: 'L1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    ...extra
  }
}

export function rect(id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'path',
    shapeKind: 'rect',
    path: { subpaths: [{ closed: true, nodes: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }] },
    fill: solid('#6d5dfc'),
    ...extra
  }
}

export interface Harness {
  ed: DrawEditor
  raster: FakeRaster
  emitted: unknown[]
  scroll: { left: number; top: number }
  state(): EditorState
  doc(): DrawDoc
  objects(): DrawNode[]
  tool(id: string): void
  down(x: number, y: number, m?: Mods): void
  move(x: number, y: number, m?: Mods): void
  up(x: number, y: number, m?: Mods): void
  click(x: number, y: number, m?: Mods): void
  drag(from: [number, number], to: [number, number], m?: Mods, steps?: number): void
  key(key: string, m?: Mods & { code?: string; inField?: boolean; inStudioField?: boolean }): { prevented: boolean }
  keyUp(code: string): void
  dblclick(): void
  run(commandId: string, args?: unknown): void
}

export function harness(
  content: unknown = blank(),
  opts: {
    liveUndo?: LiveUndo
    zoom?: number
    /** Give the viewport a fitBox (absent by default, as in the oldest headless runs); called with what was asked for. */
    fitBox?: (box: { x: number; y: number; w: number; h: number }, o?: { pad?: number; maxZoom?: number }) => void
  } = {}
): Harness {
  const emitted: unknown[] = []
  const scroll = { left: 0, top: 0 }
  // The fake raster needs the artboard size; the editor exists by the time it asks.
  const holder: { ed?: DrawEditor } = {}
  const raster = new FakeRaster((layerId) => {
    const d = holder.ed!.store.getState().doc
    const l = layerId ? d.layers.find((x) => x.id === layerId) : undefined
    return l ? rasterLayerFrame(d, l) : rasterFrame(d)
  })
  const ed = createDrawEditor(content, {
    raster,
    text: { measure: (o) => ({ ...o, lines: estimateWrap(o.text, o.w, o.fontSize, o.letterSpacing ?? 0) }) },
    viewport: {
      getScroll: () => ({ ...scroll }),
      setScroll: (l, t) => {
        scroll.left = l
        scroll.top = t
      },
      fit: () => ed.store.setState({ zoom: 1 }),
      ...(opts.fitBox ? { fitBox: opts.fitBox } : {})
    },
    host: { emit: (s) => emitted.push(s), liveUndo: () => opts.liveUndo, exportAs: async () => {} }
  })
  holder.ed = ed
  ed.store.setState({ zoom: opts.zoom ?? 1 })

  const ev = (x: number, y: number, m: Mods = {}): ToolPointer => ({
    p: { x, y },
    clientX: x * ed.store.getState().zoom,
    clientY: y * ed.store.getState().zoom,
    button: m.button ?? 0,
    shiftKey: !!m.shift,
    altKey: !!m.alt,
    metaKey: !!m.meta,
    ctrlKey: !!m.ctrl,
    pressure: m.pressure ?? 0,
    detail: m.detail ?? 1
  })

  const h: Harness = {
    ed,
    raster,
    emitted,
    scroll,
    state: () => ed.store.getState(),
    doc: () => ed.store.getState().doc,
    objects: () => vectorLayersOf(ed.store.getState().doc).flatMap((l) => l.objects),
    tool: (id) => ed.ctx.setTool(id),
    down: (x, y, m) => ed.pointerDown(ev(x, y, m)),
    move: (x, y, m) => ed.pointerMove(ev(x, y, m)),
    up: (x, y, m) => ed.pointerUp(ev(x, y, m)),
    click(x, y, m) {
      h.down(x, y, m)
      h.up(x, y, m)
    },
    drag(from, to, m, steps = 2) {
      h.down(from[0], from[1], m)
      for (let i = 1; i <= steps; i++) h.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, m)
      h.up(to[0], to[1], m)
    },
    key(key, m = {}) {
      let prevented = false
      ed.keyDown({
        key,
        code: m.code ?? (key === ' ' ? 'Space' : key),
        metaKey: !!m.meta,
        ctrlKey: !!m.ctrl,
        shiftKey: !!m.shift,
        altKey: !!m.alt,
        inField: !!m.inField || !!m.inStudioField,
        inStudioField: !!m.inStudioField,
        preventDefault: () => {
          prevented = true
        }
      })
      return { prevented }
    },
    keyUp: (code) => ed.keyUp({ code }),
    dblclick: () => ed.doubleClick(),
    run: (id, args) => ed.ctx.run(id, args)
  }
  return h
}

/**
 * The editor as a live co-editing session with someone on an older version of
 * PlexiiDesk sees it: v2 writes are off, so a v1 drawing must stay v1 (see
 * editor/v2gate.ts). Everywhere else v2 writes are on (DRAW_V2_WRITES).
 */
export function withOlderPeer<H extends Harness>(h: H): H {
  h.ed.ctx.set({ v2Writes: false, v2Blocked: LIVE_V1_PEER_REASON })
  return h
}

/**
 * The editor as a document host mounts it (DocumentEditorView, a desk widget):
 * the host binds the drawing on screen (DrawStudio's `documentOps`), so the
 * document commands -- New, Open SVG, Make a copy, Rename, Version history,
 * Move to trash, Meeting -- are on. Without it they are off with a reason, as
 * in a live drawing (editor/session.ts). Every call is recorded in `calls`;
 * `ops` overrides members.
 */
export function withDocument<H extends Harness>(
  h: H,
  ops: Partial<DocumentOps> = {},
  calls: Array<{ op: string; args: unknown[] }> = []
): H {
  const rec =
    (op: string) =>
    async (...args: unknown[]): Promise<void> => {
      calls.push({ op, args })
    }
  const bound: DocumentOps = {
    id: 'doc-on-screen',
    title: () => 'On screen',
    newDocument: rec('newDocument'),
    makeCopy: rec('makeCopy'),
    rename: rec('rename'),
    openHistory: () => void calls.push({ op: 'openHistory', args: [] }),
    startMeeting: () => void calls.push({ op: 'startMeeting', args: [] }),
    moveToTrash: rec('moveToTrash'),
    ...ops
  }
  h.ed.ctx.host.docOps = () => bound
  return h
}
