import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  ViewportPortal,
  ConnectionMode,
  ConnectionLineType,
  SelectionMode,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type OnConnectStartParams,
  type FinalConnectionState
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { MapBody, MapEdge, MapNode, MapNodeStyle, MapSettings } from '@shared/types'
import type { LiveUndo } from '../../../lib/yjsKeyedJson'
import { normalizeMapBody } from '@shared/mapGraph'
import { getShape, shapePorts } from '@shared/diagram/shapes'
import { nodeBox, nodeSize, portId, type Box } from '@shared/diagram/geom'
import { routeAll } from '@shared/diagram/routing'
import { snapToGrid, snapToGuides, type GuideLine } from '@shared/diagram/guides'
import { History } from '@shared/diagram/history'
import { getTheme } from '@shared/diagram/style'
import * as ops from '@shared/diagram/ops'
import { getPage, withPage, pageList } from '@shared/diagram/pages'
import { useTablesStore } from '../../../stores/tables'
import { acceptsWidgetDrag, widgetIdFromDrop } from '../../../lib/widgetDropInsert'
import { DiagramCtx, type DiagramCtxValue, type QuickDir } from './DiagramContext'
import { ShapeNode, SELECT_COLOR } from './ShapeNode'
import { DiagramEdge } from './DiagramEdge'
import { useDiagramCommands, type Commands } from './commands'
import { DiagramChrome } from './DiagramChrome'
import { QuickShapeMenu } from './QuickShapeMenu'
import { ContextMenu, type ContextTarget } from './ContextMenu'
import './diagram.css'

// PlexiDiagrams — a Lucidchart-class diagram editor on React Flow. The saved
// MapBody is the single source of truth; React Flow is only the interaction
// layer, fed derived nodes and edges. Every edit goes through `update`, which
// records undo history and writes the current page back into the body.

export interface DiagramEditorProps {
  body: MapBody
  title?: string
  onChange: (body: MapBody) => void
  // Live co-editing: a change in the body prop's identity is a peer's merge.
  foldExternal?: boolean
  readOnly?: boolean
  // Live co-editing: undo/redo reverse only YOUR changes in the shared document
  // (a Y.UndoManager on the local origin). Without it, undo restored a whole
  // local snapshot, which reconciled over the shared doc and reverted whatever
  // a collaborator had done since.
  liveUndo?: LiveUndo
}

const NO_SETTINGS: MapSettings = {}
const nodeTypes = { shape: ShapeNode }
const edgeTypes = { diagram: DiagramEdge }

export type Tool = 'select' | 'pan' | 'text'

export default function DiagramEditor({ body: bodyProp, title, onChange, foldExternal = false, readOnly = false, liveUndo }: DiagramEditorProps): JSX.Element {
  const rf = useReactFlow()
  const { zoom } = useViewport()
  const [body, setBodyState] = useState<MapBody>(() => normalizeMapBody(bodyProp))
  const bodyRef = useRef(body)
  const [pageIdx, setPageIdxState] = useState(0)
  const pageIdxRef = useRef(0)
  const history = useRef(new History<MapBody>())
  const styleClip = useRef<Partial<MapNodeStyle> | null>(null)
  const pasteOffset = useRef(0)
  const [, setHistoryTick] = useState(0)
  const [sel, setSelState] = useState<ops.Sel>(ops.emptySel)
  const selRef = useRef(sel)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [connecting, setConnecting] = useState(false)
  const [guides, setGuides] = useState<GuideLine[]>([])
  const [quickMenu, setQuickMenu] = useState<{ screen: { x: number; y: number }; flow: { x: number; y: number }; sourceId: string; sourceHandle: string | null } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: ContextTarget } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const connectFrom = useRef<{ nodeId: string; handleId: string | null } | null>(null)

  const setSel = useCallback((s: ops.Sel) => {
    selRef.current = s
    setSelState(s)
  }, [])

  const setBody = useCallback((b: MapBody) => {
    bodyRef.current = b
    setBodyState(b)
  }, [])

  // ── live undo plumbing ──────────────────────────────────────────────────
  // Local edits reach the shared document on a debounce (see "emit changes"),
  // so an undo step's boundary is marked when it is FLUSHED: the previous
  // step's pending body is written first, then the Y undo stack stops
  // capturing, and everything written after belongs to the new step.
  const liveUndoRef = useRef(liveUndo)
  liveUndoRef.current = liveUndo
  const flushRef = useRef<() => void>(() => undefined)
  const stepBoundary = (): void => {
    const live = liveUndoRef.current
    if (!live) return
    flushRef.current()
    live.checkpoint()
  }
  useEffect(() => (liveUndo ? liveUndo.subscribe(() => setHistoryTick((t) => t + 1)) : undefined), [liveUndo])

  // ── the one write path ──────────────────────────────────────────────────
  // key: undefined = new undo step; string = coalesce with same-key edits;
  // false = no history (live drag frames after a checkpoint).
  const update = useCallback(
    (fn: (g: ops.Graph) => ops.Graph, key?: string | false) => {
      const b = bodyRef.current
      const idx = pageIdxRef.current
      const next = fn(getPage(b, idx))
      if (key !== false && history.current.record(b, key)) stepBoundary()
      setBody(withPage(b, idx, { ...getPage(b, idx), ...next }))
      if (key !== false) setHistoryTick((t) => t + 1)
    },
    [setBody]
  )
  const updateBody = useCallback(
    (fn: (b: MapBody) => MapBody, key?: string | false) => {
      const b = bodyRef.current
      if (key !== false && history.current.record(b, key)) stepBoundary()
      setBody(fn(b))
      if (key !== false) setHistoryTick((t) => t + 1)
    },
    [setBody]
  )
  const checkpoint = useCallback(() => {
    if (history.current.record(bodyRef.current)) stepBoundary()
    setHistoryTick((t) => t + 1)
  }, [])

  const setPageIdx = useCallback(
    (i: number) => {
      // Remember where this page was looking before leaving it.
      const vp = rf.getViewport()
      const b = bodyRef.current
      setBody(withPage(b, pageIdxRef.current, { ...getPage(b, pageIdxRef.current), viewport: vp }))
      pageIdxRef.current = i
      setPageIdxState(i)
      setSel(ops.emptySel())
      const target = getPage(bodyRef.current, i)
      window.setTimeout(() => {
        if (target.viewport) rf.setViewport(target.viewport)
        else rf.fitView({ padding: 0.2 })
      }, 30)
    },
    [rf, setBody, setSel]
  )

  // ── emit changes (debounced) ────────────────────────────────────────────
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const lastEmitted = useRef(JSON.stringify(normalizeMapBody(bodyProp)))
  useEffect(() => {
    const json = JSON.stringify(body)
    if (json === lastEmitted.current) return
    const t = window.setTimeout(() => {
      lastEmitted.current = json
      onChangeRef.current(body)
    }, 350)
    return () => window.clearTimeout(t)
  }, [body])

  // Write any pending local edit now (live undo boundaries, and before undo).
  flushRef.current = () => {
    const json = JSON.stringify(bodyRef.current)
    if (json === lastEmitted.current) return
    lastEmitted.current = json
    onChangeRef.current(bodyRef.current)
  }

  // ── fold live co-editing merges ─────────────────────────────────────────
  const foldKey = useMemo(() => (foldExternal ? JSON.stringify(normalizeMapBody(bodyProp)) : ''), [bodyProp, foldExternal])
  const firstFold = useRef(true)
  useEffect(() => {
    if (!foldExternal) return
    if (firstFold.current) {
      firstFold.current = false
      return
    }
    const incoming = normalizeMapBody(bodyProp)
    // Keep our own viewport: a peer's pan should never move our view.
    const merged = { ...incoming, viewport: bodyRef.current.viewport }
    lastEmitted.current = JSON.stringify(merged)
    setBody(merged)
    const g = getPage(merged, pageIdxRef.current)
    const ids = new Set(g.nodes.map((n) => n.id))
    const eids = new Set(g.edges.map((e) => e.id))
    setSel({ nodes: new Set([...selRef.current.nodes].filter((i) => ids.has(i))), edges: new Set([...selRef.current.edges].filter((i) => eids.has(i))) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldKey])

  // ── derived page state ──────────────────────────────────────────────────
  const page = getPage(body, pageIdx)
  // Stable when the body has no settings: a fresh {} each render rebuilt the
  // command object every render (losing its state and re-rendering every node).
  const settings: MapSettings = body.settings ?? NO_SETTINGS
  const themeId = settings.theme ?? 'plexii'
  const theme = getTheme(themeId)
  const hiddenLayers = useMemo(() => ops.hiddenLayerIds(page), [page])
  const lockedLayers = useMemo(() => ops.lockedLayerIds(page), [page])
  const visibleNodes = useMemo(() => page.nodes.filter((n) => !n.hidden && !hiddenLayers.has(ops.layerOf(n))), [page.nodes, hiddenLayers])
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes])
  const visibleEdges = useMemo(
    () => page.edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target) && !hiddenLayers.has(ops.layerOf(e))),
    [page.edges, visibleIds, hiddenLayers]
  )
  const nodesById = useMemo(() => new Map(page.nodes.map((n) => [n.id, n])), [page.nodes])
  const edgesById = useMemo(() => new Map(page.edges.map((e) => [e.id, e])), [page.edges])

  const routes = useMemo(
    () => routeAll(visibleNodes, visibleEdges, { lineJumps: !!settings.lineJumps, defaultRouting: settings.defaultRouting ?? 'orthogonal' }),
    [visibleNodes, visibleEdges, settings.lineJumps, settings.defaultRouting]
  )

  const isLockedNode = useCallback((n: MapNode) => !!n.locked || lockedLayers.has(ops.layerOf(n)), [lockedLayers])

  const rfNodes = useMemo<Node[]>(
    () =>
      visibleNodes.map((n) => {
        const { w, h } = nodeSize(n)
        const locked = isLockedNode(n)
        return {
          id: n.id,
          type: 'shape',
          position: { x: n.x, y: n.y },
          width: w,
          height: h,
          selected: sel.nodes.has(n.id),
          draggable: !locked && !readOnly && editingId !== n.id,
          deletable: false, // deletion is ours (locks, containers, history)
          connectable: !locked && !readOnly,
          data: { nodeId: n.id, locked }
        }
      }),
    [visibleNodes, sel.nodes, isLockedNode, readOnly, editingId]
  )

  const portIdsOf = useCallback((n: MapNode | undefined) => new Set(n ? shapePorts(n.shape).map(([fx, fy]) => portId(fx, fy)) : []), [])
  const rfEdges = useMemo<Edge[]>(
    () =>
      visibleEdges.map((e) => {
        const r = routes.get(e.id)
        const sp = r?.sourcePort ?? e.sourceHandle ?? null
        const tp = r?.targetPort ?? e.targetHandle ?? null
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'diagram',
          sourceHandle: sp && portIdsOf(nodesById.get(e.source)).has(sp) ? sp : null,
          targetHandle: tp && portIdsOf(nodesById.get(e.target)).has(tp) ? tp : null,
          selected: sel.edges.has(e.id),
          deletable: false,
          reconnectable: !e.locked && !readOnly,
          className: 'map-connector'
        }
      }),
    [visibleEdges, routes, sel.edges, readOnly, nodesById, portIdsOf]
  )

  // ── live table data for bound shapes ────────────────────────────────────
  const tables = useTablesStore((s) => s.tables)
  const rows = useTablesStore((s) => s.rows)
  const boundTableIds = useMemo(() => {
    const ids = new Set<string>()
    for (const n of page.nodes) if (n.binding?.source.kind === 'table') ids.add(n.binding.source.tableId)
    return [...ids]
  }, [page.nodes])
  useEffect(() => {
    const store = useTablesStore.getState()
    for (const id of boundTableIds) {
      void store.ensureTableLoaded(id).catch(() => {})
      void store.ensureRowsLoaded(id).catch(() => {})
    }
  }, [boundTableIds])

  // ── node changes: select, drag (with snapping + guides), resize ─────────
  const drag = useRef<{ primary: string; start: Map<string, { x: number; y: number }> } | null>(null)

  const onNodeDragStart = useCallback(
    (_e: unknown, node: Node) => {
      const g = getPage(bodyRef.current, pageIdxRef.current)
      // Everything that moves together: selection (+ groups), plus container children.
      const base = selRef.current.nodes.has(node.id) ? new Set(selRef.current.nodes) : new Set([node.id])
      const moving = ops.expandGroups(g, base)
      for (const d of ops.descendants(g, moving)) moving.add(d)
      const start = new Map<string, { x: number; y: number }>()
      for (const n of g.nodes) if (moving.has(n.id) && !isLockedNode(n)) start.set(n.id, { x: n.x, y: n.y })
      drag.current = { primary: node.id, start }
      checkpoint()
    },
    [checkpoint, isLockedNode]
  )

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      let selChanged = false
      const nextSel = new Set(selRef.current.nodes)
      let dragTo: { x: number; y: number } | null = null
      const resized = new Map<string, { w?: number; h?: number; x?: number; y?: number }>()
      for (const c of changes) {
        if (c.type === 'select') {
          selChanged = true
          if (c.selected) nextSel.add(c.id)
          else nextSel.delete(c.id)
        } else if (c.type === 'position' && c.position) {
          if (c.dragging && drag.current && c.id === drag.current.primary) dragTo = c.position
          else if (!c.dragging && !drag.current) resized.set(c.id, { ...resized.get(c.id), x: c.position.x, y: c.position.y })
        } else if (c.type === 'dimensions' && c.resizing && c.dimensions) {
          resized.set(c.id, { ...resized.get(c.id), w: c.dimensions.width, h: c.dimensions.height })
        }
      }
      if (selChanged) {
        const g = getPage(bodyRef.current, pageIdxRef.current)
        setSel({ nodes: ops.expandGroups(g, nextSel), edges: selRef.current.edges })
      }
      if (dragTo && drag.current) {
        const d = drag.current
        const s0 = d.start.get(d.primary)
        if (!s0) return
        let dx = dragTo.x - s0.x
        let dy = dragTo.y - s0.y
        const g = getPage(bodyRef.current, pageIdxRef.current)
        const grid = settings.gridSize ?? 16
        let shown: GuideLine[] = []
        // Moving box = union of moving nodes at the proposed delta.
        const movingBoxes = g.nodes.filter((n) => d.start.has(n.id)).map((n) => {
          const s = d.start.get(n.id)!
          return { ...nodeBox(n), x: s.x + dx, y: s.y + dy }
        })
        if (movingBoxes.length && settings.guides !== false) {
          const mb = movingBoxes.reduce((a, b) => ({
            id: 'm',
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
            h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y)
          }))
          const others: Box[] = visibleNodes.filter((n) => !d.start.has(n.id) && !getShape(n.shape).container).map(nodeBox)
          const snap = snapToGuides(mb, others, 6 / Math.max(0.2, rf.getZoom()))
          if (snap.guides.length) {
            dx += snap.dx
            dy += snap.dy
            shown = snap.guides
          }
          if (!snap.guides.some((x) => x.axis === 'x') && settings.snap !== false) dx = snapToGrid(s0.x + dx, grid) - s0.x
          if (!snap.guides.some((x) => x.axis === 'y') && settings.snap !== false) dy = snapToGrid(s0.y + dy, grid) - s0.y
        } else if (settings.snap !== false) {
          dx = snapToGrid(s0.x + dx, grid) - s0.x
          dy = snapToGrid(s0.y + dy, grid) - s0.y
        }
        setGuides(shown)
        update(
          (pg) => ({
            ...pg,
            nodes: pg.nodes.map((n) => {
              const s = d.start.get(n.id)
              return s ? { ...n, x: Math.round(s.x + dx), y: Math.round(s.y + dy) } : n
            })
          }),
          false
        )
      }
      if (resized.size) {
        update(
          (pg) => ({
            ...pg,
            nodes: pg.nodes.map((n) => {
              const r = resized.get(n.id)
              if (!r) return n
              return {
                ...n,
                ...(r.x !== undefined ? { x: Math.round(r.x) } : {}),
                ...(r.y !== undefined ? { y: Math.round(r.y) } : {}),
                ...(r.w !== undefined ? { width: Math.max(8, Math.round(r.w)) } : {}),
                ...(r.h !== undefined ? { height: Math.max(8, Math.round(r.h)) } : {})
              }
            })
          }),
          false
        )
      }
    },
    [settings.gridSize, settings.guides, settings.snap, visibleNodes, rf, update, setSel]
  )

  const onNodeDragStop = useCallback(() => {
    const d = drag.current
    drag.current = null
    setGuides([])
    if (d) update((g) => ops.assignContainers(g, d.start.keys()), false)
  }, [update])

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      let changed = false
      const next = new Set(selRef.current.edges)
      for (const c of changes) {
        if (c.type === 'select') {
          changed = true
          if (c.selected) next.add(c.id)
          else next.delete(c.id)
        }
      }
      if (changed) setSel({ nodes: selRef.current.nodes, edges: next })
    },
    [setSel]
  )

  // ── connecting ──────────────────────────────────────────────────────────
  const newEdge = useCallback(
    (source: string, target: string, sourceHandle: string | null, targetHandle: string | null): MapEdge => ({
      id: ops.uid('e'),
      source,
      target,
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(targetHandle ? { targetHandle } : {}),
      routing: settings.defaultRouting ?? 'orthogonal',
      ...(settings.defaultEndArrow && settings.defaultEndArrow !== 'arrow' ? { endArrow: settings.defaultEndArrow } : {})
    }),
    [settings.defaultRouting, settings.defaultEndArrow]
  )

  const onConnect = useCallback(
    (c: Connection) => {
      connectFrom.current = null
      if (!c.source || !c.target) return
      update((g) => ({ ...g, edges: [...g.edges, newEdge(c.source, c.target, c.sourceHandle ?? null, c.source === c.target ? c.targetHandle ?? null : c.targetHandle ?? null)] }))
    },
    [update, newEdge]
  )
  const onConnectStart = useCallback((_e: unknown, p: OnConnectStartParams) => {
    setConnecting(true)
    connectFrom.current = p.nodeId ? { nodeId: p.nodeId, handleId: p.handleId ?? null } : null
  }, [])
  const onConnectEnd = useCallback(
    (e: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      setConnecting(false)
      const from = connectFrom.current
      connectFrom.current = null
      if (state.isValid || !from || readOnly) return
      // Dropped on empty canvas: offer shapes to create-and-connect (Lucid style).
      const pt = 'changedTouches' in e ? e.changedTouches[0]! : (e as MouseEvent)
      const flow = rf.screenToFlowPosition({ x: pt.clientX, y: pt.clientY })
      const rect = wrapRef.current?.getBoundingClientRect()
      setQuickMenu({ screen: { x: pt.clientX - (rect?.left ?? 0), y: pt.clientY - (rect?.top ?? 0) }, flow, sourceId: from.nodeId, sourceHandle: from.handleId })
    },
    [rf, readOnly]
  )
  const onReconnect = useCallback(
    (old: Edge, c: Connection) => {
      if (!c.source || !c.target) return
      update((g) => ops.patchEdges(g, new Set([old.id]), () => ({ source: c.source, target: c.target, sourceHandle: c.sourceHandle ?? undefined, targetHandle: c.targetHandle ?? undefined, waypoints: undefined })))
    },
    [update]
  )

  // ── commands (menus, toolbar, shortcuts and inspector all call these) ───
  const cmd: Commands = useDiagramCommands({
    rf,
    liveUndo: liveUndoRef,
    flush: () => flushRef.current(),
    styleClip,
    pasteOffset,
    bodyRef,
    pageIdxRef,
    selRef,
    setSel,
    update,
    updateBody,
    setBody,
    history,
    setHistoryTick,
    setEditingId,
    setPageIdx,
    newEdge,
    theme,
    settings,
    title: title ?? 'diagram',
    wrapRef
  })

  // ── rotation ────────────────────────────────────────────────────────────
  const beginRotate = useCallback(
    (id: string, e: React.PointerEvent) => {
      const n = getPage(bodyRef.current, pageIdxRef.current).nodes.find((x) => x.id === id)
      if (!n) return
      checkpoint()
      const b = nodeBox(n)
      const c = rf.flowToScreenPosition({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
      const move = (ev: PointerEvent): void => {
        let deg = (Math.atan2(ev.clientY - c.y, ev.clientX - c.x) * 180) / Math.PI + 90
        deg = ((deg % 360) + 360) % 360
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15
        else if (Math.abs(deg % 90) < 4 || Math.abs((deg % 90) - 90) < 4) deg = Math.round(deg / 90) * 90 // gentle detent at right angles
        const r = Math.round(deg) % 360
        update((g) => ops.patchNodes(g, new Set([id]), () => ({ rotation: r || undefined })), false)
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      e.preventDefault()
    },
    [rf, update, checkpoint]
  )

  // ── context for nodes and edges ─────────────────────────────────────────
  const ctxValue: DiagramCtxValue = useMemo(
    () => ({
      themeId,
      settings: { ...settings, background: settings.background ?? theme.background },
      zoom,
      routes,
      nodesById,
      edgesById,
      selectedNodeCount: sel.nodes.size,
      connecting,
      editingId,
      setEditingId,
      commitLabel: cmd.commitLabel,
      commitCell: cmd.commitCell,
      quickAdd: (id: string, dir: QuickDir) => cmd.quickAdd(id, dir),
      beginRotate,
      checkpoint,
      setWaypoints: (id, pts) => update((g) => ops.patchEdges(g, new Set([id]), () => ({ waypoints: pts && pts.length ? pts : undefined })), false),
      setLabelPos: (id, t) => update((g) => ops.patchEdges(g, new Set([id]), () => ({ labelPos: Math.round(t * 1000) / 1000 })), false),
      editEdgeLabel: (id) => setEditingId(`edge:${id}`),
      tables,
      rows,
      readOnly
    }),
    [themeId, settings, theme.background, zoom, routes, nodesById, edgesById, sel.nodes.size, connecting, editingId, cmd, beginRotate, checkpoint, update, tables, rows, readOnly]
  )

  // ── keyboard, clipboard, drag-and-drop ──────────────────────────────────
  const isTyping = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
  }
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const inEditor = (): boolean => wrap.contains(document.activeElement) || document.activeElement === document.body
    const onKey = (e: KeyboardEvent): void => {
      if (!inEditor() || isTyping(e.target) || editingId) return
      if (cmd.handleKey(e, { setTool })) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    const onCopy = (e: ClipboardEvent): void => {
      if (!inEditor() || isTyping(e.target) || editingId) return
      if (cmd.copy(e.clipboardData)) e.preventDefault()
    }
    const onCut = (e: ClipboardEvent): void => {
      if (!inEditor() || isTyping(e.target) || editingId) return
      if (cmd.copy(e.clipboardData)) {
        cmd.deleteSelection()
        e.preventDefault()
      }
    }
    const onPaste = (e: ClipboardEvent): void => {
      if (!inEditor() || isTyping(e.target) || editingId || readOnly) return
      e.preventDefault()
      void cmd.paste(e.clipboardData)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('copy', onCopy)
    window.addEventListener('cut', onCut)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('cut', onCut)
      window.removeEventListener('paste', onPaste)
    }
  }, [cmd, editingId, readOnly])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (readOnly) return
      e.preventDefault()
      const flow = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      // A work widget dragged in from the side menu becomes a live widget shape.
      if (acceptsWidgetDrag(e.dataTransfer)) {
        void widgetIdFromDrop(e.dataTransfer).then((id) => {
          if (id) cmd.addWidget(id, flow)
        })
        return
      }
      const shape = e.dataTransfer.getData('application/x-plexii-shape')
      const icon = e.dataTransfer.getData('application/x-plexii-icon')
      if (shape) cmd.addShape(shape, { center: flow })
      else if (icon) cmd.addIcon(icon, flow)
      else if (e.dataTransfer.files.length) void cmd.addImageFiles([...e.dataTransfer.files], flow)
    },
    [rf, cmd, readOnly]
  )

  const onPaneClick = useCallback(
    (e: React.MouseEvent) => {
      setCtxMenu(null)
      if (tool === 'text' && !readOnly) {
        const flow = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
        cmd.addShape('note', { center: flow, edit: true })
        setTool('select')
      }
    },
    [tool, rf, cmd, readOnly]
  )

  const openContext = (e: React.MouseEvent | MouseEvent, target: ContextTarget): void => {
    e.preventDefault()
    const rect = wrapRef.current?.getBoundingClientRect()
    setCtxMenu({ x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0), target })
  }

  // Selection bounding box for multi-select (drawn in flow coordinates).
  const selBounds = useMemo(() => (sel.nodes.size > 1 ? ops.selectionBounds(page, sel.nodes) : null), [sel.nodes, page])
  const pages = pageList(body)

  return (
    <DiagramCtx.Provider value={ctxValue}>
      <DiagramChrome
        cmd={cmd}
        body={body}
        page={page}
        pageIdx={pageIdx}
        pages={pages}
        sel={sel}
        tool={tool}
        setTool={setTool}
        zoom={zoom}
        canUndo={liveUndo ? liveUndo.canUndo() : history.current.canUndo}
        canRedo={liveUndo ? liveUndo.canRedo() : history.current.canRedo}
        readOnly={readOnly}
      >
        <div
          ref={wrapRef}
          className={`pd-canvas relative h-full w-full outline-none ${tool === 'pan' ? 'pd-tool-pan' : ''} ${tool === 'text' ? 'pd-tool-text' : ''}`}
          tabIndex={0}
          onPointerDown={(e) => {
            if (!isTyping(e.target)) wrapRef.current?.focus({ preventScroll: true })
          }}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={onDrop}
          style={{ background: settings.background ?? theme.background }}
          data-testid="diagram-canvas"
        >
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onReconnect={onReconnect}
            onPaneClick={onPaneClick}
            onNodeContextMenu={(e, n) => {
              if (!selRef.current.nodes.has(n.id)) setSel({ nodes: ops.expandGroups(page, [n.id]), edges: new Set() })
              openContext(e, { kind: 'node', id: n.id })
            }}
            onEdgeContextMenu={(e, ed) => {
              if (!selRef.current.edges.has(ed.id)) setSel({ nodes: new Set(), edges: new Set([ed.id]) })
              openContext(e, { kind: 'edge', id: ed.id })
            }}
            onPaneContextMenu={(e) => openContext(e, { kind: 'pane', flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }) })}
            onEdgeDoubleClick={(_e, ed) => !readOnly && setEditingId(`edge:${ed.id}`)}
            onMoveEnd={(_e, vp) => {
              const b = bodyRef.current
              setBody(withPage(b, pageIdxRef.current, { ...getPage(b, pageIdxRef.current), viewport: vp }))
            }}
            connectionMode={ConnectionMode.Loose}
            connectionLineType={ConnectionLineType.SmoothStep}
            connectionLineStyle={{ stroke: SELECT_COLOR, strokeWidth: 2, strokeDasharray: '5 4' }}
            connectionRadius={28}
            defaultViewport={page.viewport}
            fitView={!page.viewport}
            minZoom={0.05}
            maxZoom={8}
            proOptions={{ hideAttribution: true }}
            panOnDrag={tool === 'pan' ? true : [1, 2]}
            selectionOnDrag={tool === 'select'}
            selectionMode={SelectionMode.Partial}
            panOnScroll
            zoomOnScroll={false}
            zoomOnPinch
            zoomActivationKeyCode={['Meta', 'Control']}
            multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
            elevateNodesOnSelect={false}
            elevateEdgesOnSelect
            deleteKeyCode={null}
            selectionKeyCode={null}
            nodesDraggable={!readOnly && tool === 'select'}
            nodesConnectable={!readOnly}
            elementsSelectable={tool !== 'pan'}
            snapToGrid={false}
            onlyRenderVisibleElements={visibleNodes.length > 400}
          >
            {settings.grid !== false && (
              <Background variant={BackgroundVariant.Dots} gap={settings.gridSize ?? 16} size={1.4} color={theme.grid} />
            )}
            {settings.minimap !== false && (
              <MiniMap pannable zoomable className="!bg-[var(--surface-sunken)] !rounded-md" nodeColor={(n) => (nodesById.get(n.id)?.color ?? '#94a3b8')} maskColor="rgba(120,120,140,0.12)" />
            )}
            <ViewportPortal>
              {guides.map((g, i) =>
                g.axis === 'x' ? (
                  <div key={i} className="pd-guide" style={{ left: g.pos, top: g.from, width: 0, height: g.to - g.from, borderLeft: `1px ${g.kind === 'gap' ? 'dashed' : 'solid'} #ec4899` }} />
                ) : (
                  <div key={i} className="pd-guide" style={{ left: g.from, top: g.pos, height: 0, width: g.to - g.from, borderTop: `1px ${g.kind === 'gap' ? 'dashed' : 'solid'} #ec4899` }} />
                )
              )}
              {selBounds && (
                <div
                  className="pointer-events-none absolute"
                  data-testid="diagram-selection-bounds"
                  style={{ left: selBounds.x - 10, top: selBounds.y - 10, width: selBounds.w + 20, height: selBounds.h + 20, border: `1.5px dashed ${SELECT_COLOR}`, borderRadius: 6, background: `${SELECT_COLOR}08` }}
                />
              )}
            </ViewportPortal>
          </ReactFlow>

          {page.nodes.length === 0 && (
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <span className="text-[12px] text-[var(--ink-40)] text-center leading-relaxed">
                Drag a shape from the library, pick a template, paste Mermaid,
                <br />
                generate a diagram from a Plexii table, or ask AI to draw one.
              </span>
            </div>
          )}

          {quickMenu && (
            <QuickShapeMenu
              x={quickMenu.screen.x}
              y={quickMenu.screen.y}
              onPick={(shape) => {
                cmd.addConnected(quickMenu.sourceId, quickMenu.sourceHandle, shape, quickMenu.flow)
                setQuickMenu(null)
              }}
              onClose={() => setQuickMenu(null)}
            />
          )}
          {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} target={ctxMenu.target} cmd={cmd} sel={sel} page={page} onClose={() => setCtxMenu(null)} />}
        </div>
      </DiagramChrome>
    </DiagramCtx.Provider>
  )
}
