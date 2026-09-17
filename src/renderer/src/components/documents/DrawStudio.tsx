import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../Icon'
import DrawStudioMenuBar from './editor/DrawStudioMenuBar'
import DrawLayersPanel from './draw/DrawLayersPanel'
import DrawInspector from './draw/DrawInspector'
import * as raster from './draw/raster'
import { fontShorthand, layoutText } from './draw/textMeasure'
import { loadGoogleFont, familyLabel } from '../../lib/googleFonts'
import {
  drawId,
  drawToSvg,
  normalizeDrawBody,
  objectBounds,
  objectsBounds,
  paintToCss,
  rasterLayer,
  shapePath,
  solid,
  vectorLayer,
  type DrawBlend,
  type DrawBody,
  type DrawObject,
  type DrawPaint,
  type DrawPathObject,
  type DrawShapeKind,
  type DrawStroke,
  type DrawTextObject,
  type DrawVectorLayer
} from '@shared/draw'
import {
  addLayer,
  addObject,
  alignObjects,
  arrange,
  booleanObjects,
  deleteObjects,
  distributeObjects,
  duplicateLayer,
  duplicateObjects,
  editableIds,
  getObject,
  getObjects,
  joinPaths,
  mapObject,
  mapObjects,
  mergeVectorLayerDown,
  moveLayer,
  moveObjects,
  patchLayer,
  removeLayer,
  reshape,
  reversePath,
  scaleObjects,
  setPathClosed,
  targetLayerId,
  type AlignEdge,
  type ArrangeDir
} from '@shared/drawOps'
import {
  fitPathToBox,
  hitPath,
  pathToSvgD,
  rotateAbout,
  simplifyPolyline,
  smoothPathFromPoints,
  transformPath,
  type BooleanOp,
  type Box,
  type DrawNode,
  type Pt
} from '@shared/drawGeometry'

// PlexiDraw — the vector + painting studio.
//
// One document, one layer stack, two halves. Vector layers carry editable bezier
// objects (pen, shapes, type) with fills, strokes, gradients and pathfinder
// booleans; raster layers carry pixels a brush, eraser and paint bucket work on
// directly. Both obey the same visibility, lock, opacity and blend controls, and
// both export together.
//
// The interaction model is a single pointer state machine (`dragRef`) rather than
// a tool-per-handler tangle: every gesture starts in onPointerDown, is advanced
// by onPointerMove and is committed once in onPointerUp. That is what makes
// undo exactly one entry per gesture rather than one per mouse movement.

interface Props {
  content: unknown
  title: string
  onChange: (body: unknown) => void
  /** Live co-editing only: fold a peer's merged body back in. */
  foldExternal?: boolean
}

type Tool =
  | 'select'
  | 'node'
  | 'pen'
  | 'pencil'
  | 'rect'
  | 'roundRect'
  | 'ellipse'
  | 'polygon'
  | 'star'
  | 'line'
  | 'text'
  | 'brush'
  | 'eraser'
  | 'bucket'
  | 'eyedropper'
  | 'hand'

const TOOLS: Array<{ id: Tool; icon: string; label: string; key: string; group: number }> = [
  { id: 'select', icon: 'arrow_selector_tool', label: 'Select', key: 'V', group: 0 },
  { id: 'node', icon: 'polyline', label: 'Edit points', key: 'A', group: 0 },
  { id: 'pen', icon: 'draw', label: 'Pen', key: 'P', group: 1 },
  { id: 'pencil', icon: 'gesture', label: 'Pencil', key: 'N', group: 1 },
  { id: 'rect', icon: 'crop_square', label: 'Rectangle', key: 'R', group: 2 },
  { id: 'roundRect', icon: 'rounded_corner', label: 'Rounded rectangle', key: 'D', group: 2 },
  { id: 'ellipse', icon: 'circle', label: 'Ellipse', key: 'O', group: 2 },
  { id: 'polygon', icon: 'hexagon', label: 'Polygon', key: 'U', group: 2 },
  { id: 'star', icon: 'star', label: 'Star', key: 'S', group: 2 },
  { id: 'line', icon: 'horizontal_rule', label: 'Line', key: 'L', group: 2 },
  { id: 'text', icon: 'title', label: 'Type', key: 'T', group: 3 },
  { id: 'brush', icon: 'brush', label: 'Brush', key: 'B', group: 4 },
  { id: 'eraser', icon: 'ink_eraser', label: 'Eraser', key: 'E', group: 4 },
  { id: 'bucket', icon: 'format_color_fill', label: 'Paint bucket', key: 'G', group: 4 },
  { id: 'eyedropper', icon: 'colorize', label: 'Eyedropper', key: 'I', group: 4 },
  { id: 'hand', icon: 'pan_tool', label: 'Pan', key: 'H', group: 5 }
]

const SHAPE_TOOLS: Record<string, DrawShapeKind> = {
  rect: 'rect',
  roundRect: 'roundRect',
  ellipse: 'ellipse',
  polygon: 'polygon',
  star: 'star',
  line: 'line'
}

const PAINT_TOOLS = new Set<Tool>(['brush', 'eraser', 'bucket'])

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLES: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

type Drag =
  | null
  | { kind: 'marquee'; from: Pt; to: Pt; additive: boolean }
  | { kind: 'move'; start: Pt; last: Pt; ids: string[]; moved: boolean }
  | { kind: 'scale'; handle: HandleId; startBox: Box; curBox: Box; ids: string[] }
  | { kind: 'rotate'; center: Pt; last: number; ids: string[] }
  | { kind: 'shape'; shapeKind: DrawShapeKind; from: Pt; to: Pt }
  | { kind: 'textBox'; from: Pt; to: Pt }
  | { kind: 'pencil'; points: Pt[] }
  | { kind: 'paint'; layerId: string; last: { x: number; y: number; pressure: number }; erase: boolean }
  | { kind: 'node'; id: string; si: number; ni: number; part: 'anchor' | 'in' | 'out' }
  | { kind: 'penDrag'; index: number }
  | { kind: 'pan'; fromClient: Pt; scroll: { l: number; t: number } }

interface Guide {
  axis: 'x' | 'y'
  at: number
}

export default function DrawStudio({ content, title, onChange, foldExternal = false }: Props): JSX.Element {
  const [body, setBody] = useState<DrawBody>(() => normalizeDrawBody(content))
  const bodyRef = useRef(body)
  bodyRef.current = body
  const [past, setPast] = useState<DrawBody[]>([])
  const [future, setFuture] = useState<DrawBody[]>([])
  const pastRef = useRef(past)
  pastRef.current = past
  const futureRef = useRef(future)
  futureRef.current = future

  const [tool, setTool] = useState<Tool>('select')
  const toolRef = useRef(tool)
  toolRef.current = tool
  const [selection, setSelection] = useState<string[]>([])
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  const [fill, setFill] = useState<DrawPaint>(solid('#6d5dfc'))
  const [stroke, setStroke] = useState<DrawStroke | undefined>(undefined)
  const [brush, setBrush] = useState<raster.BrushSettings>(raster.DEFAULT_BRUSH)
  const brushRef = useRef(brush)
  brushRef.current = brush
  const fillRef = useRef(fill)
  fillRef.current = fill
  const strokeRef = useRef(stroke)
  strokeRef.current = stroke

  const [drag, setDrag] = useState<Drag>(null)
  const dragRef = useRef<Drag>(null)
  const [penNodes, setPenNodes] = useState<DrawNode[] | null>(null)
  const penRef = useRef<DrawNode[] | null>(null)
  penRef.current = penNodes
  const [cursorPt, setCursorPt] = useState<Pt | null>(null)
  const [editingText, setEditingText] = useState<string | null>(null)
  const [guides, setGuides] = useState<Guide[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [showGrid, setShowGrid] = useState(false)
  const [snapOn, setSnapOn] = useState(true)
  const snapRef = useRef(snapOn)
  snapRef.current = snapOn
  const [spaceDown, setSpaceDown] = useState(false)
  const spaceRef = useRef(false)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const rasterRefs = useRef<Map<string, HTMLCanvasElement>>(new Map())
  const loadedRaster = useRef<Map<string, string>>(new Map())
  // The in-progress stroke lives here until pointer-up, then composites onto its
  // layer in one pass at the stroke's own opacity.
  const scratchRef = useRef<HTMLCanvasElement | null>(null)
  const [scratchVisible, setScratchVisible] = useState(false)

  // ── History ────────────────────────────────────────────────────────────────

  const commit = useCallback(
    (next: DrawBody) => {
      const prev = bodyRef.current
      if (next === prev) return
      // `prev` is captured BEFORE the ref moves on. Reading bodyRef.current
      // inside the updater would run after the reassignment below and push the
      // NEW body onto the undo stack, which makes undo a no-op — the exact bug
      // the e2e pathfinder test caught.
      setPast((p) => [...p.slice(-79), prev])
      setFuture([])
      bodyRef.current = next
      setBody(next)
      onChange(next)
    },
    [onChange]
  )

  // A change that should NOT create an undo entry (a live drag preview committed
  // on pointer-up already recorded its own "before").
  const replace = useCallback(
    (next: DrawBody) => {
      bodyRef.current = next
      setBody(next)
      onChange(next)
    },
    [onChange]
  )

  /**
   * Record the current body as an undo point without changing it. Used at the
   * START of a gesture that will then stream its changes through `replace`, so
   * the whole drag collapses into one undo entry.
   */
  const pushHistory = useCallback(() => {
    const prev = bodyRef.current
    setPast((p) => [...p.slice(-79), prev])
    setFuture([])
  }, [])

  const undo = useCallback(() => {
    const p = pastRef.current
    if (!p.length) return
    const prev = p[p.length - 1]
    setPast(p.slice(0, -1))
    setFuture([bodyRef.current, ...futureRef.current.slice(0, 79)])
    bodyRef.current = prev
    setBody(prev)
    onChange(prev)
    // The raster canvases must be repainted from the restored document, or the
    // pixels on screen would still show the undone stroke.
    loadedRaster.current.clear()
  }, [onChange])

  const redo = useCallback(() => {
    const f = futureRef.current
    if (!f.length) return
    const next = f[0]
    setFuture(f.slice(1))
    setPast([...pastRef.current.slice(-79), bodyRef.current])
    bodyRef.current = next
    setBody(next)
    onChange(next)
    loadedRaster.current.clear()
  }, [onChange])

  // Fold a peer's merge in live co-editing. Never pushed onto undo — another
  // person's edit is not ours to take back.
  const firstFold = useRef(true)
  useEffect(() => {
    if (!foldExternal) return
    if (firstFold.current) {
      firstFold.current = false
      return
    }
    const next = normalizeDrawBody(content)
    bodyRef.current = next
    setBody(next)
    loadedRaster.current.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, foldExternal])

  // ── Raster layer canvases ──────────────────────────────────────────────────

  /**
   * A STABLE ref callback per layer id.
   *
   * An inline `ref={(el) => register(l.id, el)}` looks equivalent but is not:
   * its identity changes every render, so React detaches (calling it with null)
   * and reattaches on every single render. That left two real defects — a stroke
   * started in that window found no canvas and silently did nothing, and the
   * detach dropped the "these pixels are already loaded" marker, so the next
   * render re-loaded the layer, clearing the canvas and racing an async image
   * decode against the live stroke. Caching one callback per id means React
   * attaches once, on mount, and detaches only on a real unmount.
   */
  const rasterRefCallbacks = useRef<Map<string, (el: HTMLCanvasElement | null) => void>>(new Map())
  const rasterRefFor = useCallback((id: string) => {
    const cache = rasterRefCallbacks.current
    let fn = cache.get(id)
    if (!fn) {
      fn = (el: HTMLCanvasElement | null): void => {
        if (el) {
          rasterRefs.current.set(id, el)
        } else {
          rasterRefs.current.delete(id)
          // A genuinely unmounted canvas comes back blank, so the layer must be
          // re-loaded from its stored pixels when it remounts.
          loadedRaster.current.delete(id)
          cache.delete(id)
        }
      }
      cache.set(id, fn)
    }
    return fn
  }, [])

  // Paint each raster layer's stored PNG into its canvas whenever the stored
  // pixels change identity. The loadedRaster map is the guard that stops a
  // re-render mid-stroke from wiping the live, uncommitted brush work.
  useEffect(() => {
    for (const layer of body.layers) {
      if (layer.kind !== 'raster') continue
      const canvas = rasterRefs.current.get(layer.id)
      if (!canvas) continue
      if (loadedRaster.current.get(layer.id) === layer.src) continue
      loadedRaster.current.set(layer.id, layer.src)
      void raster.loadIntoCanvas(canvas, layer.src)
    }
  }, [body])

  /** Read a raster canvas back into the document — one undo entry per stroke. */
  const commitRaster = useCallback(
    (layerId: string) => {
      const canvas = rasterRefs.current.get(layerId)
      if (!canvas) return
      const src = raster.canvasToDataUrl(canvas)
      loadedRaster.current.set(layerId, src)
      commit(patchLayer(bodyRef.current, layerId, { src } as never))
    },
    [commit]
  )

  // ── Fonts ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    for (const l of body.layers) {
      if (l.kind !== 'vector') continue
      for (const o of l.objects) if (o.type === 'text' && o.fontFamily) loadGoogleFont(familyLabel(o.fontFamily))
    }
  }, [body.layers])

  /** Re-measure a text object's line breaks with the real font engine. */
  const measureText = useCallback((o: DrawTextObject): DrawTextObject => {
    const { lines } = layoutText({
      text: o.text,
      width: o.w,
      font: fontShorthand(o),
      letterSpacing: o.letterSpacing,
      fontSize: o.fontSize,
      lineHeight: o.lineHeight
    })
    return { ...o, lines }
  }, [])

  // ── Geometry helpers ───────────────────────────────────────────────────────

  const docPt = useCallback((e: { clientX: number; clientY: number }): Pt => {
    const r = stageRef.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return { x: (e.clientX - r.left) / zoomRef.current, y: (e.clientY - r.top) / zoomRef.current }
  }, [])

  const selectedObjects = useMemo(() => getObjects(body, selection), [body, selection])
  const selBox: Box | null = selectedObjects.length ? objectsBounds(selectedObjects) : null

  /**
   * Snap a moving box's edges to the artboard's edges and centre and to the
   * other objects' edges, returning the corrected delta plus the guides to draw.
   */
  const snapDelta = useCallback(
    (box: Box, dx: number, dy: number, ignore: string[]): { dx: number; dy: number; guides: Guide[] } => {
      if (!snapRef.current) return { dx, dy, guides: [] }
      const b = bodyRef.current
      const tol = 6 / zoomRef.current
      const xs: number[] = [0, b.width / 2, b.width]
      const ys: number[] = [0, b.height / 2, b.height]
      for (const l of b.layers) {
        if (l.kind !== 'vector' || !l.visible) continue
        for (const o of l.objects) {
          if (ignore.includes(o.id) || o.hidden) continue
          const ob = objectBounds(o)
          xs.push(ob.x, ob.x + ob.w / 2, ob.x + ob.w)
          ys.push(ob.y, ob.y + ob.h / 2, ob.y + ob.h)
        }
      }
      const g: Guide[] = []
      let bestDx = dx
      let bestDistX = tol
      for (const edge of [box.x + dx, box.x + box.w / 2 + dx, box.x + box.w + dx]) {
        for (const candidate of xs) {
          const d = Math.abs(candidate - edge)
          if (d < bestDistX) {
            bestDistX = d
            bestDx = dx + (candidate - edge)
            g.push({ axis: 'x', at: candidate })
          }
        }
      }
      let bestDy = dy
      let bestDistY = tol
      for (const edge of [box.y + dy, box.y + box.h / 2 + dy, box.y + box.h + dy]) {
        for (const candidate of ys) {
          const d = Math.abs(candidate - edge)
          if (d < bestDistY) {
            bestDistY = d
            bestDy = dy + (candidate - edge)
            g.push({ axis: 'y', at: candidate })
          }
        }
      }
      return {
        dx: bestDx,
        dy: bestDy,
        guides: g.filter((x) => (x.axis === 'x' ? bestDistX < tol : bestDistY < tol))
      }
    },
    []
  )

  /** Topmost object under a point, honouring layer order and lock/visibility. */
  const hitTest = useCallback((p: Pt): DrawObject | null => {
    const b = bodyRef.current
    for (let li = b.layers.length - 1; li >= 0; li--) {
      const l = b.layers[li]
      if (l.kind !== 'vector' || !l.visible || l.locked) continue
      for (let oi = l.objects.length - 1; oi >= 0; oi--) {
        const o = l.objects[oi]
        if (o.hidden || o.locked) continue
        if (o.type === 'path') {
          if (hitPath(o.path, p, { filled: o.fill.type !== 'none', strokeWidth: o.stroke?.width, slop: 4 / zoomRef.current })) return o
        } else {
          const ob = objectBounds(o)
          if (p.x >= ob.x && p.x <= ob.x + ob.w && p.y >= ob.y && p.y <= ob.y + ob.h) return o
        }
      }
    }
    return null
  }, [])

  /** The scratch surface, sized to the artboard. Created once, reused per stroke. */
  const ensureScratch = useCallback((): HTMLCanvasElement => {
    const b = bodyRef.current
    let c = scratchRef.current
    if (!c || c.width !== b.width || c.height !== b.height) {
      c = raster.createCanvas(b.width, b.height)
      scratchRef.current = c
    }
    return c
  }, [])

  /**
   * The paint layer to draw on, creating one if the document has none the tools
   * can use. Returns null only when the active layer is a LOCKED paint layer,
   * where silently making a second one would be the wrong answer.
   */
  const ensurePaintLayer = useCallback((): string | null => {
    const b = bodyRef.current
    const active = b.layers.find((l) => l.id === b.activeLayerId)
    if (active && active.kind === 'raster') {
      if (active.locked) {
        setStatus('That paint layer is locked — unlock it to paint on it.')
        return null
      }
      return active.id
    }
    // Prefer an unlocked paint layer that already exists over making another.
    const existing = [...b.layers].reverse().find((l) => l.kind === 'raster' && !l.locked)
    if (existing) {
      replace({ ...b, activeLayerId: existing.id })
      return existing.id
    }
    const layer = rasterLayer(`Paint ${b.layers.filter((l) => l.kind === 'raster').length + 1}`)
    commit(addLayer(b, layer, b.activeLayerId))
    return layer.id
  }, [commit, replace])

  const activeRasterLayerId = useCallback((): string | null => {
    const b = bodyRef.current
    const l = b.layers.find((x) => x.id === b.activeLayerId)
    if (l && l.kind === 'raster' && !l.locked) return l.id
    return null
  }, [])

  // ── Commands ───────────────────────────────────────────────────────────────

  const deleteSelection = useCallback(() => {
    const ids = editableIds(bodyRef.current, selectionRef.current)
    if (!ids.length) return
    commit(deleteObjects(bodyRef.current, ids))
    setSelection([])
  }, [commit])

  const duplicateSelection = useCallback(() => {
    const ids = editableIds(bodyRef.current, selectionRef.current)
    if (!ids.length) return
    const { body: next, newIds } = duplicateObjects(bodyRef.current, ids)
    commit(next)
    setSelection(newIds)
  }, [commit])

  const runBoolean = useCallback(
    (op: BooleanOp) => {
      const ids = editableIds(bodyRef.current, selectionRef.current)
      const { body: next, newId } = booleanObjects(bodyRef.current, ids, op)
      if (next === bodyRef.current) return
      commit(next)
      setSelection(newId ? [newId] : [])
      if (!newId) setStatus('The subtraction removed the shape entirely.')
    },
    [commit]
  )

  const patchSelected = useCallback(
    (fn: (o: DrawObject) => DrawObject) => {
      const ids = editableIds(bodyRef.current, selectionRef.current)
      if (!ids.length) return
      commit(mapObjects(bodyRef.current, ids, fn))
    },
    [commit]
  )

  const applyFill = useCallback(
    (paint: DrawPaint) => {
      setFill(paint)
      patchSelected((o) => (o.type === 'path' || o.type === 'text' ? { ...o, fill: paint } : o))
    },
    [patchSelected]
  )

  const applyStroke = useCallback(
    (s: DrawStroke | undefined) => {
      setStroke(s)
      patchSelected((o) => (o.type === 'path' || o.type === 'text' ? (s ? { ...o, stroke: s } : { ...o, stroke: undefined }) : o))
    },
    [patchSelected]
  )

  const addLayerOfKind = useCallback(
    (kind: 'vector' | 'raster') => {
      const b = bodyRef.current
      const layer = kind === 'vector' ? vectorLayer(`Layer ${b.layers.length + 1}`) : rasterLayer(`Paint ${b.layers.filter((l) => l.kind === 'raster').length + 1}`)
      commit(addLayer(b, layer, b.activeLayerId))
    },
    [commit]
  )

  /** Turn a vector layer's shapes into pixels, so paint tools can work on them. */
  const rasterizeLayer = useCallback(
    async (layerId: string) => {
      const b = bodyRef.current
      const layer = b.layers.find((l) => l.id === layerId)
      if (!layer || layer.kind !== 'vector') return
      setBusy('Rasterizing…')
      try {
        const isolated: DrawBody = { ...b, background: { type: 'none' }, layers: [{ ...layer, opacity: 1, blend: 'normal' }] }
        const canvas = await raster.svgToCanvas(drawToSvg(isolated), b.width, b.height)
        const next = rasterLayer(layer.name)
        next.src = raster.canvasToDataUrl(canvas)
        next.opacity = layer.opacity
        next.blend = layer.blend
        next.visible = layer.visible
        const withNew = addLayer(bodyRef.current, next, layerId)
        commit(removeLayer(withNew, layerId))
      } finally {
        setBusy(null)
      }
    },
    [commit]
  )

  /** Merge down: vectors fold directly; a raster pair is composited on a canvas. */
  const mergeDown = useCallback(
    async (layerId: string) => {
      const b = bodyRef.current
      const i = b.layers.findIndex((l) => l.id === layerId)
      if (i <= 0) {
        setStatus('The bottom layer has nothing below it to merge into.')
        return
      }
      const upper = b.layers[i]
      const lower = b.layers[i - 1]
      if (upper.kind === 'vector' && lower.kind === 'vector') {
        commit(mergeVectorLayerDown(b, layerId))
        return
      }
      setBusy('Merging…')
      try {
        const render = async (layer: typeof upper): Promise<HTMLCanvasElement> => {
          if (layer.kind === 'raster') {
            const c = raster.createCanvas(b.width, b.height)
            await raster.loadIntoCanvas(c, layer.src)
            return c
          }
          return raster.svgToCanvas(drawToSvg({ ...b, background: { type: 'none' }, layers: [{ ...layer, opacity: 1, blend: 'normal' }] }), b.width, b.height)
        }
        const lowerCanvas = await render(lower)
        const upperCanvas = await render(upper)
        // The lower layer's own opacity/blend stay with the merged layer, so the
        // picture is unchanged; only the upper layer is baked in.
        raster.compositeOnto(lowerCanvas, upperCanvas, upper.opacity, upper.blend)
        const merged = rasterLayer(lower.name)
        merged.src = raster.canvasToDataUrl(lowerCanvas)
        merged.opacity = lower.opacity
        merged.blend = lower.blend
        let next = addLayer(bodyRef.current, merged, lower.id)
        next = removeLayer(next, upper.id)
        next = removeLayer(next, lower.id)
        commit(next)
      } finally {
        setBusy(null)
      }
    },
    [commit]
  )

  // ── Pointer state machine ──────────────────────────────────────────────────

  const setDragBoth = useCallback((d: Drag) => {
    dragRef.current = d
    setDrag(d)
  }, [])

  const finishPen = useCallback(
    (close: boolean) => {
      const nodes = penRef.current
      setPenNodes(null)
      if (!nodes || nodes.length < 2) return
      const obj: DrawPathObject = {
        id: drawId('obj'),
        type: 'path',
        shapeKind: 'pen',
        path: { subpaths: [{ closed: close, nodes }] },
        fill: close ? fillRef.current : { type: 'none' },
        stroke: strokeRef.current ?? { paint: solid('#1c1917'), width: 2, cap: 'round', join: 'round' }
      }
      commit(addObject(bodyRef.current, obj, targetLayerId(bodyRef.current)))
      setSelection([obj.id])
    },
    [commit]
  )

  function onPointerDown(e: React.PointerEvent): void {
    if (e.button === 2) return
    // The text box is a child of the stage, so its own clicks bubble here. They
    // belong to the textarea: letting them through captured the pointer and
    // started dragging the object, which made the box impossible to type in.
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'TEXTAREA' || target.closest('[data-text-editing="1"]'))) return
    const p = docPt(e)
    const t = toolRef.current
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)

    // Pan wins over every tool while space is held or the middle button is used.
    if (t === 'hand' || spaceRef.current || e.button === 1) {
      const sc = scrollRef.current
      setDragBoth({ kind: 'pan', fromClient: { x: e.clientX, y: e.clientY }, scroll: { l: sc?.scrollLeft ?? 0, t: sc?.scrollTop ?? 0 } })
      return
    }

    if (t === 'eyedropper') {
      pickColorAt(p)
      return
    }

    if (PAINT_TOOLS.has(t)) {
      // A paint tool with nowhere to paint used to do nothing but flash a status
      // line that was easy to miss — which read, correctly, as "the brush is
      // broken". It now creates the paint layer it needs and carries on.
      let layerId = activeRasterLayerId()
      if (!layerId) {
        layerId = ensurePaintLayer()
        if (!layerId) return
        // The canvas for a layer created this instant has not mounted yet, so
        // the stroke starts on the next gesture rather than being swallowed.
        setStatus('Added a paint layer for you — draw away.')
        return
      }
      const canvas = rasterRefs.current.get(layerId)
      if (!canvas) {
        setStatus('That paint layer is not ready yet — try the stroke again.')
        return
      }
      if (t === 'bucket') {
        if (raster.floodFill(canvas, p.x, p.y, currentSolidColor(), 0.12)) commitRaster(layerId)
        else setStatus('That area is already this colour.')
        return
      }
      // Strokes are built at full strength on a scratch canvas and composited
      // once on pointer-up, so a half-opacity stroke is even rather than blotchy
      // where its own stamps overlap.
      const scratch = ensureScratch()
      raster.clearCanvas(scratch)
      const pressure = e.pressure > 0 ? e.pressure : 0.5
      raster.paintDot(raster.context(scratch), { x: p.x, y: p.y, pressure }, brushRef.current)
      setScratchVisible(true)
      dragRef.current = { kind: 'paint', layerId, last: { x: p.x, y: p.y, pressure }, erase: t === 'eraser' }
      return
    }

    if (t === 'pen') {
      const nodes = penRef.current ?? []
      // Clicking the first node closes the path.
      if (nodes.length >= 2 && Math.hypot(nodes[0].x - p.x, nodes[0].y - p.y) < 8 / zoomRef.current) {
        finishPen(true)
        return
      }
      const next = [...nodes, { x: p.x, y: p.y }]
      penRef.current = next
      setPenNodes(next)
      setDragBoth({ kind: 'penDrag', index: next.length - 1 })
      return
    }

    if (t === 'pencil') {
      setDragBoth({ kind: 'pencil', points: [p] })
      return
    }

    if (t === 'text') {
      // A click drops a default box; a drag sizes one. Both are what a type tool
      // is expected to do.
      setDragBoth({ kind: 'textBox', from: p, to: p })
      return
    }

    const shapeKind = SHAPE_TOOLS[t]
    if (shapeKind) {
      setDragBoth({ kind: 'shape', shapeKind, from: p, to: p })
      return
    }

    if (t === 'node') {
      const hitNode = hitNodeAt(p)
      if (hitNode) {
        setDragBoth({ kind: 'node', ...hitNode })
        return
      }
      const obj = hitTest(p)
      setSelection(obj ? [obj.id] : [])
      return
    }

    // Select tool.
    const handle = selBox ? handleAt(p, selBox) : null
    if (handle === 'rot' && selBox) {
      setDragBoth({ kind: 'rotate', center: { x: selBox.x + selBox.w / 2, y: selBox.y + selBox.h / 2 }, last: angleTo({ x: selBox.x + selBox.w / 2, y: selBox.y + selBox.h / 2 }, p), ids: [...selectionRef.current] })
      pushHistory()
      return
    }
    if (handle && selBox) {
      setDragBoth({ kind: 'scale', handle: handle as HandleId, startBox: selBox, curBox: selBox, ids: [...selectionRef.current] })
      pushHistory()
      return
    }

    const hit = hitTest(p)
    if (hit) {
      const additive = e.shiftKey
      const ids = additive
        ? selectionRef.current.includes(hit.id)
          ? selectionRef.current.filter((i) => i !== hit.id)
          : [...selectionRef.current, hit.id]
        : selectionRef.current.includes(hit.id)
          ? selectionRef.current
          : [hit.id]
      setSelection(ids)
      selectionRef.current = ids
      pushHistory()
      setDragBoth({ kind: 'move', start: p, last: p, ids: editableIds(bodyRef.current, ids), moved: false })
      return
    }

    if (!e.shiftKey) setSelection([])
    setDragBoth({ kind: 'marquee', from: p, to: p, additive: e.shiftKey })
  }

  function onPointerMove(e: React.PointerEvent): void {
    const p = docPt(e)
    setCursorPt(p)
    const d = dragRef.current
    if (!d) return

    if (d.kind === 'pan') {
      const sc = scrollRef.current
      if (sc) {
        sc.scrollLeft = d.scroll.l - (e.clientX - d.fromClient.x)
        sc.scrollTop = d.scroll.t - (e.clientY - d.fromClient.y)
      }
      return
    }

    if (d.kind === 'paint') {
      const scratch = scratchRef.current
      if (!scratch) return
      const pressure = e.pressure > 0 ? e.pressure : 0.5
      raster.paintSegment(raster.context(scratch), d.last, { x: p.x, y: p.y, pressure }, brushRef.current)
      d.last = { x: p.x, y: p.y, pressure }
      return
    }

    if (d.kind === 'marquee') {
      setDragBoth({ ...d, to: p })
      return
    }

    if (d.kind === 'shape') {
      setDragBoth({ ...d, to: e.shiftKey ? squareOff(d.from, p) : p })
      return
    }

    if (d.kind === 'textBox') {
      setDragBoth({ ...d, to: p })
      return
    }

    if (d.kind === 'pencil') {
      setDragBoth({ ...d, points: [...d.points, p] })
      return
    }

    if (d.kind === 'penDrag') {
      const nodes = penRef.current
      if (!nodes) return
      const n = nodes[d.index]
      // Dragging after placing a node pulls a symmetric pair of handles out of
      // it, which is exactly how a bezier pen behaves everywhere.
      const next = nodes.slice()
      next[d.index] = { ...n, outX: p.x, outY: p.y, inX: 2 * n.x - p.x, inY: 2 * n.y - p.y }
      penRef.current = next
      setPenNodes(next)
      return
    }

    if (d.kind === 'move') {
      const objs = getObjects(bodyRef.current, d.ids)
      if (!objs.length) return
      const box = objectsBounds(objs)
      let dx = p.x - d.last.x
      let dy = p.y - d.last.y
      if (e.shiftKey) {
        // Constrain to the dominant axis, measured from the gesture's origin.
        if (Math.abs(p.x - d.start.x) > Math.abs(p.y - d.start.y)) dy = d.start.y - d.last.y
        else dx = d.start.x - d.last.x
      }
      const snapped = snapDelta(box, dx, dy, d.ids)
      setGuides(snapped.guides)
      replace(moveObjects(bodyRef.current, d.ids, snapped.dx, snapped.dy))
      dragRef.current = { ...d, last: { x: d.last.x + snapped.dx, y: d.last.y + snapped.dy }, moved: true }
      return
    }

    if (d.kind === 'scale') {
      const next = resizeBox(d.startBox, d.handle, p, e.shiftKey, e.altKey)
      replace(scaleObjects(bodyRef.current, d.ids, d.curBox, next))
      dragRef.current = { ...d, curBox: next }
      setDrag({ ...d, curBox: next })
      return
    }

    if (d.kind === 'rotate') {
      const a = angleTo(d.center, p)
      let delta = a - d.last
      if (e.shiftKey) delta = Math.round(delta / 15) * 15
      if (Math.abs(delta) < 0.01) return
      const m = rotateAbout(d.center.x, d.center.y, delta)
      replace(
        mapObjects(bodyRef.current, d.ids, (o) => {
          if (o.type === 'path') return { ...o, path: transformPath(o.path, m) }
          return { ...o, rotation: (o.rotation ?? 0) + delta }
        })
      )
      dragRef.current = { ...d, last: d.last + delta }
      return
    }

    if (d.kind === 'node') {
      replace(
        mapObject(bodyRef.current, d.id, (o) => {
          if (o.type !== 'path') return o
          const subpaths = o.path.subpaths.map((sp, si) => {
            if (si !== d.si) return sp
            return {
              ...sp,
              nodes: sp.nodes.map((n, ni) => {
                if (ni !== d.ni) return n
                if (d.part === 'anchor') {
                  const dx = p.x - n.x
                  const dy = p.y - n.y
                  return {
                    x: p.x,
                    y: p.y,
                    ...(n.inX != null ? { inX: n.inX + dx, inY: (n.inY ?? 0) + dy } : {}),
                    ...(n.outX != null ? { outX: n.outX + dx, outY: (n.outY ?? 0) + dy } : {})
                  }
                }
                if (d.part === 'out') {
                  // Alt breaks the handle pair, otherwise they stay mirrored.
                  return e.altKey ? { ...n, outX: p.x, outY: p.y } : { ...n, outX: p.x, outY: p.y, inX: 2 * n.x - p.x, inY: 2 * n.y - p.y }
                }
                return e.altKey ? { ...n, inX: p.x, inY: p.y } : { ...n, inX: p.x, inY: p.y, outX: 2 * n.x - p.x, outY: 2 * n.y - p.y }
              })
            }
          })
          return { ...o, path: { ...o.path, subpaths } }
        })
      )
    }
  }

  function onPointerUp(e: React.PointerEvent): void {
    const d = dragRef.current
    setGuides([])
    if (!d) return
    const p = docPt(e)

    if (d.kind === 'paint') {
      const scratch = scratchRef.current
      const canvas = rasterRefs.current.get(d.layerId)
      if (scratch && canvas) {
        raster.compositeStroke(canvas, scratch, brushRef.current.opacity, brushRef.current.blend, d.erase)
        raster.clearCanvas(scratch)
        commitRaster(d.layerId)
      }
      setScratchVisible(false)
    } else if (d.kind === 'marquee') {
      const box = normBox(d.from, d.to)
      if (box.w > 2 / zoom || box.h > 2 / zoom) {
        const hits: string[] = []
        for (const l of bodyRef.current.layers) {
          if (l.kind !== 'vector' || !l.visible || l.locked) continue
          for (const o of l.objects) {
            if (o.hidden || o.locked) continue
            const ob = objectBounds(o)
            if (ob.x < box.x + box.w && ob.x + ob.w > box.x && ob.y < box.y + box.h && ob.y + ob.h > box.y) hits.push(o.id)
          }
        }
        setSelection(d.additive ? [...new Set([...selectionRef.current, ...hits])] : hits)
      }
    } else if (d.kind === 'shape') {
      const box = normBox(d.from, d.to)
      const isLine = d.shapeKind === 'line'
      if (box.w > 1 || box.h > 1) {
        const path = isLine ? shapePath('line', { x: d.from.x, y: d.from.y, w: d.to.x - d.from.x, h: d.to.y - d.from.y }) : fitPathToBox(shapePath(d.shapeKind, box), box)
        const obj: DrawPathObject = {
          id: drawId('obj'),
          type: 'path',
          shapeKind: d.shapeKind,
          path,
          fill: isLine ? { type: 'none' } : fillRef.current,
          stroke: isLine ? strokeRef.current ?? { paint: solid('#1c1917'), width: 2, cap: 'round' } : strokeRef.current,
          ...(d.shapeKind === 'roundRect' ? { cornerRadius: Math.min(box.w, box.h) * 0.15 } : {}),
          ...(d.shapeKind === 'polygon' ? { sides: 6 } : {}),
          ...(d.shapeKind === 'star' ? { sides: 5, innerRatio: 0.5 } : {})
        }
        commit(addObject(bodyRef.current, obj, targetLayerId(bodyRef.current)))
        setSelection([obj.id])
        setTool('select')
      }
    } else if (d.kind === 'textBox') {
      const box = normBox(d.from, d.to)
      const wide = box.w > 8
      const size = wide ? Math.max(8, Math.min(200, box.h > 12 ? box.h * 0.5 : 48)) : 48
      const obj = measureText({
        id: drawId('obj'),
        type: 'text',
        x: wide ? box.x : d.from.x,
        y: wide ? box.y : d.from.y,
        w: wide ? box.w : Math.min(320, Math.max(80, bodyRef.current.width - d.from.x - 8)),
        text: '',
        fontSize: size,
        fill: fillRef.current.type === 'none' ? solid('#1c1917') : fillRef.current
      })
      commit(addObject(bodyRef.current, obj, targetLayerId(bodyRef.current)))
      setSelection([obj.id])
      setEditingText(obj.id)
      setTool('select')
    } else if (d.kind === 'pencil') {
      const pts = simplifyPolyline(d.points, 1.6 / zoom)
      if (pts.length >= 2) {
        const obj: DrawPathObject = {
          id: drawId('obj'),
          type: 'path',
          shapeKind: 'pencil',
          path: smoothPathFromPoints(pts, false),
          fill: { type: 'none' },
          stroke: strokeRef.current ?? { paint: solid(currentSolidColor()), width: 2, cap: 'round', join: 'round' }
        }
        commit(addObject(bodyRef.current, obj, targetLayerId(bodyRef.current)))
        setSelection([obj.id])
      }
    } else if (d.kind === 'penDrag') {
      // Nothing to commit: the node is already in the draft path.
    } else if (d.kind === 'move' && !d.moved) {
      // The gesture recorded an undo point on pointer-down but changed nothing,
      // so drop it rather than leaving a no-op step in the history.
      setPast((prev) => prev.slice(0, -1))
      // A click with no movement collapses a multi-selection to the item clicked.
      const hit = hitTest(p)
      if (hit && !e.shiftKey && selectionRef.current.length > 1) setSelection([hit.id])
      if (hit && hit.type === 'text' && e.detail >= 2) setEditingText(hit.id)
    }

    setDragBoth(null)
  }

  function pickColorAt(p: Pt): void {
    const b = bodyRef.current
    // Prefer a vector object under the cursor; fall back to the painted pixels.
    const obj = hitTest(p)
    if (obj && (obj.type === 'path' || obj.type === 'text') && obj.fill.type === 'solid') {
      setFill(solid(obj.fill.color))
      setBrush((s) => ({ ...s, color: obj.fill.type === 'solid' ? obj.fill.color : s.color }))
      setStatus(`Picked ${obj.fill.color}`)
      return
    }
    for (let i = b.layers.length - 1; i >= 0; i--) {
      const l = b.layers[i]
      if (l.kind !== 'raster' || !l.visible) continue
      const canvas = rasterRefs.current.get(l.id)
      if (!canvas) continue
      const hex = raster.samplePixel(canvas, p.x, p.y)
      if (hex) {
        setFill(solid(hex))
        setBrush((s) => ({ ...s, color: hex }))
        setStatus(`Picked ${hex}`)
        return
      }
    }
    setStatus('Nothing to pick there — that spot is empty.')
  }

  function currentSolidColor(): string {
    const f = fillRef.current
    if (f.type === 'solid') return f.color
    if (f.type === 'linear' || f.type === 'radial') return f.stops[0].color
    return brushRef.current.color
  }

  /** Which selection handle, if any, is under a point. */
  function handleAt(p: Pt, box: Box): HandleId | 'rot' | null {
    const r = 7 / zoom
    const rotY = box.y - 22 / zoom
    if (Math.hypot(p.x - (box.x + box.w / 2), p.y - rotY) <= r) return 'rot'
    for (const h of HANDLES) {
      const hp = handlePoint(box, h)
      if (Math.abs(p.x - hp.x) <= r && Math.abs(p.y - hp.y) <= r) return h
    }
    return null
  }

  /** Which path node or bezier handle, if any, is under a point. */
  function hitNodeAt(p: Pt): { id: string; si: number; ni: number; part: 'anchor' | 'in' | 'out' } | null {
    const r = 7 / zoom
    for (const id of selectionRef.current) {
      const o = getObject(bodyRef.current, id)
      if (!o || o.type !== 'path') continue
      for (let si = 0; si < o.path.subpaths.length; si++) {
        const sp = o.path.subpaths[si]
        for (let ni = 0; ni < sp.nodes.length; ni++) {
          const n = sp.nodes[ni]
          if (n.outX != null && Math.hypot(p.x - n.outX, p.y - (n.outY ?? 0)) <= r) return { id, si, ni, part: 'out' }
          if (n.inX != null && Math.hypot(p.x - n.inX, p.y - (n.inY ?? 0)) <= r) return { id, si, ni, part: 'in' }
          if (Math.hypot(p.x - n.x, p.y - n.y) <= r) return { id, si, ni, part: 'anchor' }
        }
      }
    }
    return null
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  useEffect(() => {
    function editingField(t: EventTarget | null): boolean {
      const el = t as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    }
    function onKeyDown(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey
      if (e.code === 'Space' && !editingField(e.target)) {
        spaceRef.current = true
        setSpaceDown(true)
        e.preventDefault()
        return
      }
      if (editingField(e.target)) {
        if (e.key === 'Escape') (e.target as HTMLElement).blur()
        return
      }
      const key = e.key.toLowerCase()
      if (mod && key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && key === 'y') {
        e.preventDefault()
        redo()
        return
      }
      if (mod && key === 'd') {
        e.preventDefault()
        duplicateSelection()
        return
      }
      if (mod && key === 'a') {
        e.preventDefault()
        const all: string[] = []
        for (const l of bodyRef.current.layers) {
          if (l.kind !== 'vector' || !l.visible || l.locked) continue
          for (const o of l.objects) if (!o.hidden && !o.locked) all.push(o.id)
        }
        setSelection(all)
        return
      }
      if (mod) return
      if (e.key === 'Escape') {
        if (penRef.current) finishPen(false)
        else setSelection([])
        return
      }
      if (e.key === 'Enter' && penRef.current) {
        finishPen(false)
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelection()
        return
      }
      if (e.key === '[' || e.key === ']') {
        setBrush((b) => ({ ...b, size: Math.max(1, Math.min(400, b.size + (e.key === ']' ? Math.max(1, b.size * 0.15) : -Math.max(1, b.size * 0.15)))) }))
        return
      }
      if (e.key.startsWith('Arrow') && selectionRef.current.length) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        commit(moveObjects(bodyRef.current, editableIds(bodyRef.current, selectionRef.current), dx, dy))
        return
      }
      const match = TOOLS.find((t) => t.key.toLowerCase() === key)
      if (match) setTool(match.id)
    }
    function onKeyUp(e: KeyboardEvent): void {
      if (e.code === 'Space') {
        spaceRef.current = false
        setSpaceDown(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [undo, redo, duplicateSelection, deleteSelection, finishPen, commit])

  // Cmd/Ctrl + wheel zooms about the pointer, like every canvas app.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    function onWheel(e: WheelEvent): void {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom((z) => Math.max(0.05, Math.min(16, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Fit the artboard on first paint so a 4K canvas is not opened at 1:1.
  const fitted = useRef(false)
  const fitToWindow = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const z = Math.min((el.clientWidth - 48) / bodyRef.current.width, (el.clientHeight - 48) / bodyRef.current.height)
    setZoom(Math.max(0.05, Math.min(4, z)))
  }, [])
  useEffect(() => {
    if (fitted.current) return
    fitted.current = true
    fitToWindow()
  }, [fitToWindow])

  // ── Export ─────────────────────────────────────────────────────────────────

  const exportAs = useCallback(
    async (format: 'png' | 'svg' | 'pdf') => {
      setBusy(`Exporting ${format.toUpperCase()}…`)
      try {
        const res = await window.api.draw.export({ draw: bodyRef.current, title: title || 'drawing', format })
        if (res.ok && res.path) setStatus(`Saved to ${res.path}`)
        else if (res.error) setStatus(res.error)
      } finally {
        setBusy(null)
      }
    },
    [title]
  )

  // ── Render ─────────────────────────────────────────────────────────────────

  const W = body.width
  const H = body.height
  const stageW = W * zoom
  const stageH = H * zoom
  const editing = editingText ? getObject(body, editingText) : null
  const editingObj = editing && editing.type === 'text' ? editing : null

  const cursor =
    tool === 'hand' || spaceDown
      ? 'grab'
      : tool === 'text'
        ? 'text'
        : tool === 'eyedropper'
          ? 'crosshair'
          : PAINT_TOOLS.has(tool) || tool === 'pen' || tool === 'pencil' || SHAPE_TOOLS[tool]
            ? 'crosshair'
            : 'default'

  return (
    <div className="h-full flex flex-col text-[13px]" data-testid="draw-studio">
      <DrawStudioMenuBar
        actions={{
          undo,
          redo,
          canUndo: past.length > 0,
          canRedo: future.length > 0,
          exportAs,
          selectAll: () => {
            const all: string[] = []
            for (const l of bodyRef.current.layers) {
              if (l.kind !== 'vector') continue
              for (const o of l.objects) all.push(o.id)
            }
            setSelection(all)
          },
          deleteSelection,
          duplicateSelection,
          boolean: runBoolean,
          arrange: (d: ArrangeDir) => commit(arrange(bodyRef.current, selectionRef.current, d)),
          align: (edge: AlignEdge) => commit(alignObjects(bodyRef.current, selectionRef.current, edge)),
          addLayer: addLayerOfKind,
          fitToWindow,
          setZoom,
          zoom,
          showGrid,
          setShowGrid,
          snapOn,
          setSnapOn,
          resize: (w: number, h: number) => commit({ ...bodyRef.current, width: w, height: h }),
          setBackground: (p: DrawPaint) => commit({ ...bodyRef.current, background: p }),
          background: body.background,
          width: W,
          height: H,
          hasSelection: selection.length > 0
        }}
      />

      {/* Tool options strip */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_50%,transparent)]">
        <span className="text-[11px] text-[var(--ink-50)] w-24 truncate">{TOOLS.find((t) => t.id === tool)?.label}</span>
        <button onClick={() => setZoom((z) => Math.max(0.05, z / 1.25))} title="Zoom out" className="icon-btn !h-6 !w-6">
          <Icon name="zoom_out" size={15} />
        </button>
        <span className="fb-tabular text-[11px] w-12 text-center text-[var(--ink-60)]" data-testid="draw-zoom">
          {Math.round(zoom * 100)}%
        </span>
        <button onClick={() => setZoom((z) => Math.min(16, z * 1.25))} title="Zoom in" className="icon-btn !h-6 !w-6">
          <Icon name="zoom_in" size={15} />
        </button>
        <button onClick={fitToWindow} title="Fit to window" className="icon-btn !h-6 !w-6">
          <Icon name="fit_screen" size={15} />
        </button>
        <div className="w-px h-4 bg-[var(--edge-soft)]" />
        <button
          onClick={() => setShowGrid((v) => !v)}
          title="Show grid"
          className={`icon-btn !h-6 !w-6 ${showGrid ? 'bg-accent/15 text-accent' : ''}`}
        >
          <Icon name="grid_4x4" size={15} />
        </button>
        <button
          onClick={() => setSnapOn((v) => !v)}
          title="Snap to edges and centres"
          data-testid="draw-snap-toggle"
          className={`icon-btn !h-6 !w-6 ${snapOn ? 'bg-accent/15 text-accent' : ''}`}
        >
          <Icon name="straighten" size={15} />
        </button>
        <div className="flex-1" />
        <span className="fb-tabular text-[11px] text-[var(--ink-40)]">
          {W} × {H}
        </span>
        {(busy || status) && (
          <span className="text-[11px] text-[var(--ink-50)] inline-flex items-center gap-1 max-w-[320px] truncate" data-testid="draw-status">
            {busy && <Icon name="autorenew" size={12} className="animate-spin" />}
            {busy ?? status}
            {status && !busy && (
              <button onClick={() => setStatus(null)} className="text-[var(--ink-40)] hover:text-[var(--ink-70)]">
                <Icon name="close" size={11} />
              </button>
            )}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Tool box */}
        <div className="shrink-0 w-10 border-r border-[var(--edge-soft)] py-1 overflow-y-auto" data-testid="draw-toolbox">
          {TOOLS.map((t, i) => (
            <div key={t.id}>
              {i > 0 && TOOLS[i - 1].group !== t.group && <div className="my-1 mx-2 h-px bg-[var(--edge-soft)]" />}
              <button
                onClick={() => setTool(t.id)}
                title={`${t.label} (${t.key})`}
                aria-label={t.label}
                aria-pressed={tool === t.id}
                data-testid={`draw-tool-${t.id}`}
                className={`w-8 h-8 mx-1 rounded flex items-center justify-center ${
                  tool === t.id ? 'bg-accent/15 text-accent' : 'text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                <Icon name={t.icon} size={17} />
              </button>
            </div>
          ))}
          <div className="my-1 mx-2 h-px bg-[var(--edge-soft)]" />
          <div className="mx-1 mt-1 flex flex-col items-center gap-1">
            <div
              className="w-6 h-6 rounded border border-[var(--edge-firm)]"
              style={{ background: paintToCss(fill) }}
              title="Current fill"
              data-testid="draw-current-fill"
            />
            <div
              className="w-6 h-6 rounded border-2"
              style={{ borderColor: stroke ? paintToCss(stroke.paint) : 'var(--edge-firm)' }}
              title="Current stroke"
              data-testid="draw-current-stroke"
            />
          </div>
        </div>

        {/* Canvas */}
        <div ref={scrollRef} className="flex-1 min-w-0 overflow-auto bg-stone-200/60 dark:bg-black/40 p-6" data-testid="draw-canvas-scroll">
          <div
            ref={stageRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => setCursorPt(null)}
            onDoubleClick={() => {
              if (penRef.current) finishPen(false)
            }}
            onContextMenu={(e) => e.stopPropagation()}
            data-testid="draw-stage"
            className="relative mx-auto touch-none select-none shadow-lg"
            style={{
              width: stageW,
              height: stageH,
              cursor,
              // A checkerboard shows through a transparent artboard, so "no
              // background" reads as genuinely transparent rather than white.
              backgroundImage:
                body.background.type === 'none'
                  ? 'linear-gradient(45deg,#d6d3d1 25%,transparent 25%),linear-gradient(-45deg,#d6d3d1 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d6d3d1 75%),linear-gradient(-45deg,transparent 75%,#d6d3d1 75%)'
                  : undefined,
              backgroundSize: body.background.type === 'none' ? '16px 16px' : undefined,
              backgroundPosition: body.background.type === 'none' ? '0 0,0 8px,8px -8px,-8px 0' : undefined,
              background: body.background.type === 'none' ? undefined : paintToCss(body.background)
            }}
          >
            {body.layers.map((l) =>
              !l.visible ? null : l.kind === 'raster' ? (
                <canvas
                  key={l.id}
                  ref={rasterRefFor(l.id)}
                  width={W}
                  height={H}
                  data-testid={`draw-raster-${l.id}`}
                  className="absolute left-0 top-0 pointer-events-none"
                  style={{ width: stageW, height: stageH, opacity: l.opacity, mixBlendMode: l.blend as never }}
                />
              ) : (
                <VectorLayerView key={l.id} layer={l} width={W} height={H} stageW={stageW} stageH={stageH} hiddenId={editingText} />
              )
            )}

            {scratchVisible && scratchRef.current && (
              <ScratchView
                canvas={scratchRef.current}
                stageW={stageW}
                stageH={stageH}
                opacity={brush.opacity}
                blend={tool === 'eraser' ? 'normal' : brush.blend}
              />
            )}

            <Overlay
              body={body}
              zoom={zoom}
              stageW={stageW}
              stageH={stageH}
              tool={tool}
              selection={selection}
              selBox={selBox}
              drag={drag}
              penNodes={penNodes}
              cursorPt={cursorPt}
              guides={guides}
              showGrid={showGrid}
              fill={fill}
              stroke={stroke}
            />

            {editingObj && (
              <textarea
                autoFocus
                data-text-editing="1"
                value={editingObj.text}
                data-testid="draw-text-editor"
                onChange={(e) => {
                  const next = measureText({ ...editingObj, text: e.target.value })
                  replace(mapObject(bodyRef.current, editingObj.id, () => next))
                }}
                onBlur={() => {
                  // An empty box the user walked away from is removed rather
                  // than left as an invisible, unselectable object. A box with
                  // words in it needs no commit here: creating it already pushed
                  // an undo entry, and the keystrokes since then went through
                  // `replace`, so one undo takes the whole box away.
                  if (!editingObj.text.trim()) {
                    commit(deleteObjects(bodyRef.current, [editingObj.id]))
                    setSelection([])
                  }
                  setEditingText(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
                  e.stopPropagation()
                }}
                className="absolute bg-transparent outline outline-1 outline-[var(--accent)] resize-none overflow-hidden"
                style={{
                  left: editingObj.x * zoom,
                  top: editingObj.y * zoom,
                  width: editingObj.w * zoom,
                  height: Math.max(objectBounds(editingObj).h, editingObj.fontSize) * zoom,
                  font: fontShorthand({ ...editingObj, fontSize: editingObj.fontSize * zoom }),
                  lineHeight: String(editingObj.lineHeight ?? 1.2),
                  letterSpacing: `${(editingObj.letterSpacing ?? 0) * zoom}px`,
                  textAlign: editingObj.align ?? 'left',
                  color: editingObj.fill.type === 'solid' ? editingObj.fill.color : '#1c1917'
                }}
              />
            )}
          </div>
        </div>

        {/* Right column: inspector over layers */}
        <div className="shrink-0 flex flex-col border-l border-[var(--edge-soft)]" style={{ width: 240 }}>
          <div className="flex-1 min-h-0 overflow-auto">
            <DrawInspector
              selected={selectedObjects}
              fill={selectedObjects.length === 1 && (selectedObjects[0].type === 'path' || selectedObjects[0].type === 'text') ? selectedObjects[0].fill : fill}
              stroke={
                selectedObjects.length === 1 && (selectedObjects[0].type === 'path' || selectedObjects[0].type === 'text') ? selectedObjects[0].stroke : stroke
              }
              onFill={applyFill}
              onStroke={applyStroke}
              onOpacity={(v) => patchSelected((o) => ({ ...o, opacity: v }))}
              onBlend={(b: DrawBlend) => patchSelected((o) => ({ ...o, blend: b }))}
              onReshape={(patch) => {
                const id = selection[0]
                if (id) commit(reshape(bodyRef.current, id, patch))
              }}
              onBoolean={runBoolean}
              onAlign={(edge) => commit(alignObjects(bodyRef.current, selection, edge))}
              onDistribute={(axis) => commit(distributeObjects(bodyRef.current, selection, axis))}
              onArrange={(dir) => commit(arrange(bodyRef.current, selection, dir))}
              onReverse={() => {
                let next = bodyRef.current
                for (const id of selection) next = reversePath(next, id)
                commit(next)
              }}
              onSetClosed={(closed) => {
                let next = bodyRef.current
                for (const id of selection) next = setPathClosed(next, id, closed)
                commit(next)
              }}
              onJoin={() => {
                const { body: next, newId } = joinPaths(bodyRef.current, selection)
                if (next === bodyRef.current) return
                commit(next)
                setSelection(newId ? [newId] : [])
              }}
              onTextPatch={(patch) => patchSelected((o) => (o.type === 'text' ? measureText({ ...o, ...patch }) : o))}
              brush={brush}
              onBrush={(patch) => setBrush((b) => ({ ...b, ...patch }))}
              showBrush={PAINT_TOOLS.has(tool) || tool === 'eyedropper'}
            />
          </div>
          <div className="shrink-0 border-t border-[var(--edge-soft)]" style={{ height: 260 }}>
            <DrawLayersPanel
              layers={body.layers}
              activeLayerId={body.activeLayerId}
              onSelect={(id) => replace({ ...bodyRef.current, activeLayerId: id })}
              onPatch={(id, patch) => commit(patchLayer(bodyRef.current, id, patch as never))}
              onAdd={addLayerOfKind}
              onDuplicate={(id) => commit(duplicateLayer(bodyRef.current, id))}
              onDelete={(id) => commit(removeLayer(bodyRef.current, id))}
              onMove={(id, delta) => commit(moveLayer(bodyRef.current, id, delta))}
              onMergeDown={(id) => void mergeDown(id)}
              onRasterize={(id) => void rasterizeLayer(id)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Layer & overlay rendering ────────────────────────────────────────────────

/**
 * Shows the live, uncommitted stroke. The scratch canvas element is adopted
 * directly rather than copied, so what you see mid-stroke is exactly the pixels
 * that will be composited when you lift the pointer.
 */
function ScratchView({
  canvas,
  stageW,
  stageH,
  opacity,
  blend
}: {
  canvas: HTMLCanvasElement
  stageW: number
  stageH: number
  opacity: number
  blend: string
}): JSX.Element {
  const host = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = host.current
    if (!el) return
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    el.appendChild(canvas)
    return () => {
      if (canvas.parentNode === el) el.removeChild(canvas)
    }
  }, [canvas])
  return (
    <div
      ref={host}
      data-testid="draw-scratch"
      className="absolute left-0 top-0 pointer-events-none"
      style={{ width: stageW, height: stageH, opacity, mixBlendMode: (blend === 'source-over' ? 'normal' : blend) as never }}
    />
  )
}

function VectorLayerView({
  layer,
  width,
  height,
  stageW,
  stageH,
  hiddenId
}: {
  layer: DrawVectorLayer
  width: number
  height: number
  stageW: number
  stageH: number
  /** The object currently being typed into, hidden so its text is not drawn twice. */
  hiddenId?: string | null
}): JSX.Element {
  // Gradients are collected as SVG markup by the same serializer the exporter
  // uses, so a gradient can never look different on screen than in the file.
  const defs: string[] = []
  const nodes = layer.objects.filter((o) => o.id !== hiddenId).map((o) => <ObjectView key={o.id} o={o} defs={defs} />)
  return (
    <svg
      width={stageW}
      height={stageH}
      viewBox={`0 0 ${width} ${height}`}
      data-testid={`draw-vector-${layer.id}`}
      className="absolute left-0 top-0 pointer-events-none"
      style={{ opacity: layer.opacity, mixBlendMode: layer.blend as never }}
    >
      <defs dangerouslySetInnerHTML={{ __html: defs.join('') }} />
      {nodes}
    </svg>
  )
}

function ObjectView({ o, defs }: { o: DrawObject; defs: string[] }): JSX.Element | null {
  if (o.hidden) return null
  const style: React.CSSProperties = {}
  if (o.opacity != null && o.opacity < 1) style.opacity = o.opacity
  if (o.blend && o.blend !== 'normal') style.mixBlendMode = o.blend as never

  if (o.type === 'path') {
    const f = paintRef(o.fill, defs, o.id)
    const s = o.stroke ? paintRef(o.stroke.paint, defs, `${o.id}-s`) : null
    return (
      <path
        d={pathToSvgD(o.path)}
        fill={f.value}
        fillOpacity={f.opacity}
        fillRule={o.path.fillRule === 'evenodd' ? 'evenodd' : undefined}
        stroke={s?.value}
        strokeWidth={o.stroke?.width}
        strokeOpacity={s?.opacity}
        strokeLinecap={o.stroke?.cap}
        strokeLinejoin={o.stroke?.join}
        strokeDasharray={o.stroke?.dash && o.stroke.dash.length ? o.stroke.dash.join(' ') : undefined}
        style={style}
      />
    )
  }
  if (o.type === 'image') {
    return (
      <image
        href={o.src}
        x={o.x}
        y={o.y}
        width={o.w}
        height={o.h}
        preserveAspectRatio="none"
        transform={o.rotation ? `rotate(${o.rotation} ${o.x + o.w / 2} ${o.y + o.h / 2})` : undefined}
        style={style}
      />
    )
  }
  const f = paintRef(o.fill, defs, o.id)
  const s = o.stroke ? paintRef(o.stroke.paint, defs, `${o.id}-s`) : null
  const lh = (o.lineHeight ?? 1.2) * o.fontSize
  const lines = o.lines && o.lines.length ? o.lines : o.text.split('\n')
  const anchor = o.align === 'center' ? 'middle' : o.align === 'right' ? 'end' : 'start'
  const ax = o.align === 'center' ? o.x + o.w / 2 : o.align === 'right' ? o.x + o.w : o.x
  return (
    <text
      fontFamily={o.fontFamily ?? 'Inter, system-ui, sans-serif'}
      fontSize={o.fontSize}
      fontWeight={o.fontWeight}
      fontStyle={o.italic ? 'italic' : undefined}
      letterSpacing={o.letterSpacing || undefined}
      textAnchor={anchor}
      fill={f.value}
      fillOpacity={f.opacity}
      stroke={s?.value}
      strokeWidth={o.stroke?.width}
      transform={o.rotation ? `rotate(${o.rotation} ${o.x + o.w / 2} ${o.y})` : undefined}
      style={style}
    >
      {lines.map((l, i) => (
        <tspan key={i} x={ax} y={o.y + o.fontSize + i * lh}>
          {l || ' '}
        </tspan>
      ))}
    </text>
  )
}

function paintRef(paint: DrawPaint, defs: string[], idHint: string): { value: string; opacity?: number } {
  if (paint.type === 'none') return { value: 'none' }
  if (paint.type === 'solid') return { value: paint.color, opacity: paint.opacity }
  const id = `grad-${idHint}`
  const stops = paint.stops
    .map((st) => `<stop offset="${(st.offset * 100).toFixed(2)}%" stop-color="${escapeAttr(st.color)}"${st.opacity != null ? ` stop-opacity="${st.opacity}"` : ''}/>`)
    .join('')
  if (paint.type === 'linear') {
    const rad = ((paint.angle ?? 0) * Math.PI) / 180
    const dx = Math.cos(rad) / 2
    const dy = Math.sin(rad) / 2
    defs.push(`<linearGradient id="${id}" x1="${(0.5 - dx).toFixed(4)}" y1="${(0.5 - dy).toFixed(4)}" x2="${(0.5 + dx).toFixed(4)}" y2="${(0.5 + dy).toFixed(4)}">${stops}</linearGradient>`)
  } else {
    defs.push(`<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`)
  }
  return { value: `url(#${id})` }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function Overlay(props: {
  body: DrawBody
  zoom: number
  stageW: number
  stageH: number
  tool: Tool
  selection: string[]
  selBox: Box | null
  drag: Drag
  penNodes: DrawNode[] | null
  cursorPt: Pt | null
  guides: Guide[]
  showGrid: boolean
  fill: DrawPaint
  stroke: DrawStroke | undefined
}): JSX.Element {
  const { body, zoom, stageW, stageH, selBox, drag, penNodes, cursorPt, guides, showGrid } = props
  const k = 1 / zoom // keep overlay strokes and handles a constant on-screen size
  const grid = 50

  return (
    <svg
      width={stageW}
      height={stageH}
      viewBox={`0 0 ${body.width} ${body.height}`}
      className="absolute left-0 top-0 pointer-events-none"
      data-testid="draw-overlay"
    >
      {showGrid && (
        <g opacity={0.25}>
          {Array.from({ length: Math.floor(body.width / grid) }, (_, i) => (
            <line key={`gx${i}`} x1={(i + 1) * grid} y1={0} x2={(i + 1) * grid} y2={body.height} stroke="#0ea5e9" strokeWidth={k} />
          ))}
          {Array.from({ length: Math.floor(body.height / grid) }, (_, i) => (
            <line key={`gy${i}`} x1={0} y1={(i + 1) * grid} x2={body.width} y2={(i + 1) * grid} stroke="#0ea5e9" strokeWidth={k} />
          ))}
        </g>
      )}

      {guides.map((g, i) =>
        g.axis === 'x' ? (
          <line key={i} x1={g.at} y1={0} x2={g.at} y2={body.height} stroke="#ec4899" strokeWidth={k} />
        ) : (
          <line key={i} x1={0} y1={g.at} x2={body.width} y2={g.at} stroke="#ec4899" strokeWidth={k} />
        )
      )}

      {/* Live previews */}
      {drag?.kind === 'marquee' && (
        <rect
          {...rectProps(normBox(drag.from, drag.to))}
          fill="rgba(109,93,252,0.12)"
          stroke="#6d5dfc"
          strokeWidth={k}
          strokeDasharray={`${3 * k} ${3 * k}`}
        />
      )}
      {drag?.kind === 'shape' && (
        <path
          d={pathToSvgD(
            drag.shapeKind === 'line'
              ? shapePath('line', { x: drag.from.x, y: drag.from.y, w: drag.to.x - drag.from.x, h: drag.to.y - drag.from.y })
              : fitPathToBox(shapePath(drag.shapeKind, normBox(drag.from, drag.to)), normBox(drag.from, drag.to))
          )}
          fill={drag.shapeKind === 'line' ? 'none' : paintToCss(props.fill)}
          stroke="#6d5dfc"
          strokeWidth={k}
        />
      )}
      {drag?.kind === 'pencil' && (
        <polyline points={drag.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={props.stroke ? paintToCss(props.stroke.paint) : '#1c1917'} strokeWidth={(props.stroke?.width ?? 2)} />
      )}

      {/* Pen draft */}
      {penNodes && penNodes.length > 0 && (
        <g>
          <path d={pathToSvgD({ subpaths: [{ closed: false, nodes: penNodes }] })} fill="none" stroke="#6d5dfc" strokeWidth={1.5 * k} />
          {cursorPt && (
            <line
              x1={penNodes[penNodes.length - 1].x}
              y1={penNodes[penNodes.length - 1].y}
              x2={cursorPt.x}
              y2={cursorPt.y}
              stroke="#6d5dfc"
              strokeWidth={k}
              strokeDasharray={`${3 * k} ${3 * k}`}
            />
          )}
          {penNodes.map((n, i) => (
            <rect key={i} x={n.x - 3 * k} y={n.y - 3 * k} width={6 * k} height={6 * k} fill="#ffffff" stroke="#6d5dfc" strokeWidth={k} />
          ))}
        </g>
      )}

      {/* Node editing */}
      {props.tool === 'node' &&
        props.selection.map((id) => {
          const o = getObject(body, id)
          if (!o || o.type !== 'path') return null
          return (
            <g key={id}>
              <path d={pathToSvgD(o.path)} fill="none" stroke="#6d5dfc" strokeWidth={k} />
              {o.path.subpaths.flatMap((sp, si) =>
                sp.nodes.map((n, ni) => (
                  <g key={`${si}-${ni}`}>
                    {n.inX != null && (
                      <>
                        <line x1={n.x} y1={n.y} x2={n.inX} y2={n.inY} stroke="#6d5dfc" strokeWidth={k} opacity={0.6} />
                        <circle cx={n.inX} cy={n.inY} r={3 * k} fill="#6d5dfc" />
                      </>
                    )}
                    {n.outX != null && (
                      <>
                        <line x1={n.x} y1={n.y} x2={n.outX} y2={n.outY} stroke="#6d5dfc" strokeWidth={k} opacity={0.6} />
                        <circle cx={n.outX} cy={n.outY} r={3 * k} fill="#6d5dfc" />
                      </>
                    )}
                    <rect x={n.x - 3.5 * k} y={n.y - 3.5 * k} width={7 * k} height={7 * k} fill="#ffffff" stroke="#6d5dfc" strokeWidth={1.5 * k} />
                  </g>
                ))
              )}
            </g>
          )
        })}

      {/* Selection frame */}
      {selBox && props.tool !== 'node' && (
        <g data-testid="draw-selection">
          <rect {...rectProps(selBox)} fill="none" stroke="#6d5dfc" strokeWidth={k} />
          <line x1={selBox.x + selBox.w / 2} y1={selBox.y} x2={selBox.x + selBox.w / 2} y2={selBox.y - 22 * k} stroke="#6d5dfc" strokeWidth={k} />
          <circle cx={selBox.x + selBox.w / 2} cy={selBox.y - 22 * k} r={4 * k} fill="#ffffff" stroke="#6d5dfc" strokeWidth={1.5 * k} />
          {HANDLES.map((h) => {
            const p = handlePoint(selBox, h)
            return <rect key={h} x={p.x - 4 * k} y={p.y - 4 * k} width={8 * k} height={8 * k} fill="#ffffff" stroke="#6d5dfc" strokeWidth={1.5 * k} />
          })}
        </g>
      )}
    </svg>
  )
}

// ── Small geometry utilities used by the interaction layer ───────────────────

function rectProps(b: Box): { x: number; y: number; width: number; height: number } {
  return { x: b.x, y: b.y, width: b.w, height: b.h }
}

function normBox(a: Pt, b: Pt): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

/** Shift-drag: force the gesture into a square, keeping the dominant extent. */
function squareOff(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const s = Math.max(Math.abs(dx), Math.abs(dy))
  return { x: from.x + Math.sign(dx || 1) * s, y: from.y + Math.sign(dy || 1) * s }
}

function handlePoint(b: Box, h: HandleId): Pt {
  const midX = b.x + b.w / 2
  const midY = b.y + b.h / 2
  const right = b.x + b.w
  const bottom = b.y + b.h
  switch (h) {
    case 'nw':
      return { x: b.x, y: b.y }
    case 'n':
      return { x: midX, y: b.y }
    case 'ne':
      return { x: right, y: b.y }
    case 'e':
      return { x: right, y: midY }
    case 'se':
      return { x: right, y: bottom }
    case 's':
      return { x: midX, y: bottom }
    case 'sw':
      return { x: b.x, y: bottom }
    default:
      return { x: b.x, y: midY }
  }
}

function angleTo(center: Pt, p: Pt): number {
  return (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI
}

/**
 * The new box for a handle drag. Shift keeps the aspect ratio; Alt resizes about
 * the centre. A box is never allowed to collapse past 1px, which is what stops a
 * shape from inverting into nothing and becoming unselectable.
 */
export function resizeBox(start: Box, handle: HandleId, p: Pt, keepAspect: boolean, fromCenter: boolean): Box {
  const left = handle.includes('w')
  const right = handle.includes('e')
  const top = handle.startsWith('n')
  const bottom = handle.startsWith('s')
  let x = start.x
  let y = start.y
  let w = start.w
  let h = start.h

  if (right) w = p.x - start.x
  if (left) {
    w = start.x + start.w - p.x
    x = p.x
  }
  if (bottom) h = p.y - start.y
  if (top) {
    h = start.y + start.h - p.y
    y = p.y
  }

  if (keepAspect && start.w > 0 && start.h > 0 && (left || right) && (top || bottom)) {
    const ratio = start.w / start.h
    if (Math.abs(w / ratio) > Math.abs(h)) h = w / ratio
    else w = h * ratio
    if (top) y = start.y + start.h - h
    if (left) x = start.x + start.w - w
  }

  if (fromCenter) {
    const cx = start.x + start.w / 2
    const cy = start.y + start.h / 2
    if (left || right) {
      w = Math.abs(w) * (left ? 1 : 1)
      const halfW = Math.abs(right ? p.x - cx : cx - p.x)
      w = halfW * 2
      x = cx - halfW
    }
    if (top || bottom) {
      const halfH = Math.abs(bottom ? p.y - cy : cy - p.y)
      h = halfH * 2
      y = cy - halfH
    }
  }

  if (w < 0) {
    x += w
    w = -w
  }
  if (h < 0) {
    y += h
    h = -h
  }
  return { x, y, w: Math.max(1, w), h: Math.max(1, h) }
}
