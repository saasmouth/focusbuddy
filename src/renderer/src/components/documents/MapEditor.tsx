import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { promptText } from '../plexi/PromptDialog'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  NodeResizer,
  Position,
  ConnectionMode,
  MarkerType,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { MapBody, MapEdge, MapShape } from '@shared/types'
import { normalizeMapBody, autoLayout } from '@shared/mapGraph'
import { mapTemplate, type MapTemplateId } from './map/mapTemplates'
import Icon from '../Icon'
import DrawMenuBar from './editor/DrawMenuBar'
import { alignBoxes, distributeBoxes, type AlignEdge } from './map/mapAlign'
import { polygonClipPath } from '@shared/mapExport'
import WidgetEmbed from './embed/WidgetEmbed'
import WidgetPickerDialog from './embed/WidgetPickerDialog'

// PlexiDiagrams editor — a Draw.io / Lucidchart-style diagram and workflow map. Built
// on React Flow but persists a clean, tool-agnostic MapBody (nodes carry their
// own position/shape/colour; edges carry an optional label + line style) so the
// graph syncs to the cloud and stays portable. Used standalone in PlexiOffice,
// embedded on the PlexiDesk canvas, and openable from the Documents hub.

const NODE_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#475569']

type StencilCategory = 'Flowchart' | 'Basic shapes' | 'Arrows' | 'Containers'

const SHAPE_TOOLS: { shape: MapShape; icon: string; label: string; category: StencilCategory }[] = [
  // Flowchart — the classic process-diagram set.
  { shape: 'process', icon: 'crop_square', label: 'Process', category: 'Flowchart' },
  { shape: 'decision', icon: 'change_history', label: 'Decision', category: 'Flowchart' },
  { shape: 'terminator', icon: 'pill', label: 'Start / End', category: 'Flowchart' },
  { shape: 'data', icon: 'note', label: 'Data', category: 'Flowchart' },
  { shape: 'database', icon: 'database', label: 'Store', category: 'Flowchart' },
  { shape: 'hexagon', icon: 'hexagon', label: 'Prep', category: 'Flowchart' },
  { shape: 'trapezoid', icon: 'signal_cellular_null', label: 'Manual', category: 'Flowchart' },
  { shape: 'note', icon: 'title', label: 'Text', category: 'Flowchart' },
  // Basic shapes — general-purpose geometry.
  { shape: 'circle', icon: 'circle', label: 'Circle', category: 'Basic shapes' },
  { shape: 'triangle', icon: 'change_history', label: 'Triangle', category: 'Basic shapes' },
  { shape: 'pentagon', icon: 'pentagon', label: 'Pentagon', category: 'Basic shapes' },
  { shape: 'star', icon: 'star', label: 'Star', category: 'Basic shapes' },
  { shape: 'cross', icon: 'add', label: 'Cross', category: 'Basic shapes' },
  { shape: 'callout', icon: 'chat_bubble', label: 'Callout', category: 'Basic shapes' },
  // Arrows — directional flow markers.
  { shape: 'chevron', icon: 'chevron_right', label: 'Stage', category: 'Arrows' },
  { shape: 'arrow', icon: 'arrow_forward', label: 'Arrow', category: 'Arrows' },
  // Containers — group other shapes.
  { shape: 'lane', icon: 'view_column', label: 'Lane', category: 'Containers' }
]

const STENCIL_CATEGORIES: StencilCategory[] = ['Flowchart', 'Basic shapes', 'Arrows', 'Containers']

// ── Custom node ─────────────────────────────────────────────────────────────
interface ShapeData extends Record<string, unknown> {
  label: string
  shape: MapShape
  color: string
  // Set only for shape === 'widget': the desk widget this node embeds.
  widgetId?: string
  // Explicit size once the user has dragged a resize handle; absent falls back to
  // the per-shape default.
  width?: number
  height?: number
}

// Default on-screen size per shape, used until the user resizes.
function defaultShapeSize(shape: MapShape): { w: number; h: number } {
  switch (shape) {
    case 'widget':
      return { w: WIDGET_NODE_W, h: WIDGET_NODE_H }
    case 'decision':
      return { w: 130, h: 92 }
    case 'data':
      return { w: 132, h: 52 }
    case 'database':
      return { w: 104, h: 64 }
    case 'circle':
      return { w: 86, h: 86 }
    case 'hexagon':
      return { w: 130, h: 70 }
    case 'trapezoid':
      return { w: 140, h: 60 }
    case 'chevron':
      return { w: 150, h: 52 }
    case 'triangle':
      return { w: 96, h: 84 }
    case 'pentagon':
      return { w: 100, h: 92 }
    case 'star':
      return { w: 96, h: 96 }
    case 'cross':
      return { w: 90, h: 90 }
    case 'arrow':
      return { w: 130, h: 70 }
    case 'callout':
      return { w: 140, h: 84 }
    case 'lane':
      return { w: 680, h: 200 }
    case 'note':
      return { w: 90, h: 40 }
    case 'terminator':
      return { w: 110, h: 46 }
    default:
      return { w: 120, h: 48 }
  }
}


// The on-canvas size of a widget-embed node. Fixed rather than resizable so it
// behaves like the other draw shapes (which size to their content).
const WIDGET_NODE_W = 280
const WIDGET_NODE_H = 190

const HANDLE_STYLE = { width: 9, height: 9, background: '#94a3b8', border: '2px solid #fff' }
const SIDES: { id: string; position: Position }[] = [
  { id: 'top', position: Position.Top },
  { id: 'right', position: Position.Right },
  { id: 'bottom', position: Position.Bottom },
  { id: 'left', position: Position.Left }
]

function ShapeNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as ShapeData
  const [editing, setEditing] = useState(false)
  const rf = useReactFlow()
  const ring = selected ? 'outline outline-2 outline-offset-2 outline-accent' : ''
  const label = (
    <NodeLabel nodeId={id} value={d.label} editing={editing} setEditing={setEditing} />
  )

  // Size is data-driven (default until the user drags a handle), so a resize both
  // renders live and persists into the MapNode.
  const def = defaultShapeSize(d.shape)
  const w = d.width ?? def.w
  const h = d.height ?? def.h
  const box = (extra: React.CSSProperties): React.CSSProperties => ({ width: w, height: h, ...extra })

  // Each shape is a positioned box; non-rectangular shapes use clip-path or SVG.
  const baseText =
    'flex items-center justify-center text-center text-[12px] font-medium px-3 py-2 select-none text-[var(--ink-100)] overflow-hidden'
  let inner: JSX.Element

  if (d.shape === 'widget') {
    inner = (
      <div className={ring} style={box({})}>
        <WidgetEmbed widgetId={d.widgetId ?? ''} />
      </div>
    )
  } else if (d.shape === 'decision') {
    inner = (
      <div
        className={`${baseText} ${ring}`}
        style={box({ background: `${d.color}1f`, border: `2px solid ${d.color}`, clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' })}
        onDoubleClick={() => setEditing(true)}
      >
        {label}
      </div>
    )
  } else if (d.shape === 'data') {
    inner = (
      <div
        className={`${baseText} ${ring}`}
        style={box({ background: `${d.color}1f`, border: `2px solid ${d.color}`, clipPath: 'polygon(16% 0, 100% 0, 84% 100%, 0% 100%)' })}
        onDoubleClick={() => setEditing(true)}
      >
        {label}
      </div>
    )
  } else if (d.shape === 'terminator') {
    inner = (
      <div
        className={`${baseText} rounded-full ${ring}`}
        style={box({ background: `${d.color}1f`, border: `2px solid ${d.color}` })}
        onDoubleClick={() => setEditing(true)}
      >
        {label}
      </div>
    )
  } else if (d.shape === 'database') {
    inner = (
      <div
        className={`${baseText} ${ring}`}
        style={box({ background: `${d.color}1f`, border: `2px solid ${d.color}`, borderRadius: '50% / 18%' })}
        onDoubleClick={() => setEditing(true)}
      >
        {label}
      </div>
    )
  } else if (d.shape === 'circle') {
    inner = (
      <div
        className={`${baseText} rounded-full ${ring}`}
        style={box({ background: `${d.color}1f`, border: `2px solid ${d.color}` })}
        onDoubleClick={() => setEditing(true)}
      >
        {label}
      </div>
    )
  } else if (polygonClipPath(d.shape)) {
    // Polygon stencil shapes (hexagon / trapezoid / chevron) share one outline.
    inner = (
      <div
        className={`${baseText} ${ring}`}
        style={box({ background: `${d.color}1f`, border: `2px solid ${d.color}`, clipPath: polygonClipPath(d.shape)! })}
        onDoubleClick={() => setEditing(true)}
      >
        {label}
      </div>
    )
  } else if (d.shape === 'note') {
    inner = (
      <div
        className={`${baseText} ${ring} bg-transparent`}
        style={box({ color: d.color })}
        onDoubleClick={() => setEditing(true)}
      >
        {label}
      </div>
    )
  } else if (d.shape === 'lane') {
    // A container band: a titled header strip down the left, a faint fill, and no
    // connection handles. Shapes dropped on top read as members of the lane.
    inner = (
      <div
        className={`${ring} rounded-md overflow-hidden flex`}
        style={box({ background: `${d.color}0d`, border: `2px solid ${d.color}66` })}
        onDoubleClick={() => setEditing(true)}
      >
        <div
          className="shrink-0 flex items-center justify-center text-[11px] font-semibold text-[var(--ink-90)] px-1"
          style={{ width: 26, background: `${d.color}26`, writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          {label}
        </div>
      </div>
    )
  } else {
    // process (rectangle)
    inner = (
      <div
        className={`${baseText} rounded-md bg-[var(--surface-raised)] ${ring}`}
        style={box({ border: `2px solid ${d.color}` })}
        onDoubleClick={() => setEditing(true)}
      >
        {label}
      </div>
    )
  }

  return (
    <div className="relative" style={{ width: w, height: h }}>
      {/* Drag a corner/edge to resize; the new size persists onto the node. */}
      <NodeResizer
        isVisible={selected}
        minWidth={40}
        minHeight={24}
        onResize={(_e, p) => rf.updateNodeData(id, { width: Math.round(p.width), height: Math.round(p.height) })}
      />
      {inner}
      {d.shape !== 'lane' &&
        SIDES.map((s) => (
          <Handle key={s.id} id={s.id} type="source" position={s.position} style={HANDLE_STYLE} />
        ))}
    </div>
  )
}

// Inline label editor — commits via a window CustomEvent the editor listens for,
// so the node stays free of store wiring (matches the DiagramWidget pattern).
function NodeLabel({
  nodeId,
  value,
  editing,
  setEditing
}: {
  nodeId: string
  value: string
  editing: boolean
  setEditing: (v: boolean) => void
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  function commit(): void {
    setEditing(false)
    window.dispatchEvent(new CustomEvent('fb-map-label', { detail: { nodeId, label: draft } }))
  }
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setDraft(value)
            setEditing(false)
          }
          e.stopPropagation()
        }}
        className="bg-white text-[var(--ink-100)] text-[12px] text-center rounded px-1 border border-accent w-[90%]"
        onClick={(e) => e.stopPropagation()}
      />
    )
  }
  return <span className="whitespace-pre-wrap break-words leading-tight">{value || '…'}</span>
}

const nodeTypes = { shape: ShapeNode }

// ── MapBody <-> React Flow conversion ───────────────────────────────────────
function toFlowNodes(body: MapBody): Node<ShapeData>[] {
  return body.nodes.map((n) => ({
    id: n.id,
    type: 'shape',
    position: { x: n.x, y: n.y },
    // Lanes are containers, so they sit behind the shapes placed on top of them.
    ...(n.shape === 'lane' ? { zIndex: -1 } : {}),
    data: {
      label: n.label,
      shape: n.shape,
      color: n.color,
      ...(n.widgetId ? { widgetId: n.widgetId } : {}),
      ...(typeof n.width === 'number' ? { width: n.width } : {}),
      ...(typeof n.height === 'number' ? { height: n.height } : {})
    }
  }))
}
function edgeStyle(e: MapEdge): React.CSSProperties {
  return e.style === 'dashed' ? { strokeDasharray: '6 4', stroke: '#64748b' } : { stroke: '#64748b' }
}
function toFlowEdges(body: MapBody): Edge[] {
  return body.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
    label: e.label,
    animated: !!e.animated,
    markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b' },
    style: edgeStyle(e),
    labelStyle: { fontSize: 11, fill: '#334155' },
    labelBgStyle: { fill: '#ffffff', fillOpacity: 0.85 }
  }))
}
function fromFlow(
  nodes: Node<ShapeData>[],
  edges: Edge[],
  viewport: { x: number; y: number; zoom: number }
): MapBody {
  return {
    version: 1,
    nodes: nodes.map((n) => ({
      id: n.id,
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      label: n.data.label,
      shape: n.data.shape,
      color: n.data.color,
      ...(n.data.widgetId ? { widgetId: n.data.widgetId } : {}),
      ...(typeof n.data.width === 'number' ? { width: n.data.width } : {}),
      ...(typeof n.data.height === 'number' ? { height: n.data.height } : {})
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      ...(typeof e.label === 'string' && e.label ? { label: e.label } : {}),
      style: (e.style as React.CSSProperties)?.strokeDasharray ? 'dashed' : 'solid',
      ...(e.animated ? { animated: true } : {})
    })),
    viewport
  }
}

interface Props {
  body: MapBody
  title?: string
  onChange: (body: MapBody) => void
  // Live co-editing only. When true, a change in the body prop's identity is
  // treated as a peer's merge and folded into the graph. Left off (the default)
  // for the normal single-user editor, where the parent feeds our own saves back
  // as a new body identity and folding them would fight the live editing state.
  foldExternal?: boolean
}

function MapInner({ body, title, onChange, foldExternal = false }: Props): JSX.Element {
  const initial = useMemo(() => normalizeMapBody(body), [])
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ShapeData>>(toFlowNodes(initial))
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toFlowEdges(initial))
  const [color, setColor] = useState(NODE_COLORS[0])
  const [dashed, setDashed] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const [widgetPickerOpen, setWidgetPickerOpen] = useState(false)
  const [stencilCat, setStencilCat] = useState<StencilCategory>('Flowchart')
  const seq = useRef(initial.nodes.length)
  const viewportRef = useRef(initial.viewport ?? { x: 0, y: 0, zoom: 1 })
  const rf = useReactFlow()

  // Emit MapBody out (debounced) on any change. The parent store debounces too,
  // so this just coalesces React Flow's chatty change stream.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const lastEmitted = useRef('')
  useEffect(() => {
    const next = fromFlow(nodes, edges, viewportRef.current)
    const json = JSON.stringify(next)
    if (json === lastEmitted.current) return
    const t = window.setTimeout(() => {
      lastEmitted.current = json
      onChangeRef.current(next)
    }, 350)
    return () => window.clearTimeout(t)
  }, [nodes, edges])

  // Fold live co-editing merges. When the body prop changes identity (a peer's
  // edit arrived through the CRDT, never our own echo — the parent reconciles our
  // edits under a private origin that does not refresh the prop), reconcile the
  // shared nodes and edges into the graph. We deliberately leave the viewport
  // alone so a peer's pan or zoom never yanks our view; the shared viewport field
  // is then just last-writer noise that no live client applies. The first run is
  // skipped because the initial state already reflects the first body.
  const foldKey = useMemo(() => (foldExternal ? JSON.stringify(normalizeMapBody(body)) : ''), [body, foldExternal])
  const firstFold = useRef(true)
  useEffect(() => {
    if (!foldExternal) return
    if (firstFold.current) {
      firstFold.current = false
      return
    }
    const norm = normalizeMapBody(body)
    setNodes(toFlowNodes(norm))
    setEdges(toFlowEdges(norm))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [foldKey])

  // Label commits from a node's inline editor.
  useEffect(() => {
    function onLabel(e: Event): void {
      const { nodeId, label } = (e as CustomEvent).detail as { nodeId: string; label: string }
      setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, label } } : n)))
    }
    window.addEventListener('fb-map-label', onLabel as EventListener)
    return () => window.removeEventListener('fb-map-label', onLabel as EventListener)
  }, [setNodes])

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((es) =>
        addEdge(
          {
            ...c,
            markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b' },
            style: dashed ? { strokeDasharray: '6 4', stroke: '#64748b' } : { stroke: '#64748b' },
            labelStyle: { fontSize: 11, fill: '#334155' },
            labelBgStyle: { fill: '#ffffff', fillOpacity: 0.85 }
          },
          es
        )
      ),
    [setEdges, dashed]
  )

  function newId(prefix: string): string {
    seq.current += 1
    return `${prefix}${Date.now().toString(36)}-${seq.current}`
  }

  function addNode(shape: MapShape): void {
    const id = newId('n')
    // Drop new nodes near the centre of the current viewport.
    const center = rf.screenToFlowPosition
      ? rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      : { x: 120 + (seq.current % 5) * 40, y: 100 + (seq.current % 7) * 30 }
    const label =
      shape === 'note'
        ? 'Text'
        : shape === 'decision'
          ? 'Decision?'
          : shape === 'terminator'
            ? 'Start'
            : shape === 'database'
              ? 'Store'
              : 'Step'
    setNodes((ns) => [
      ...ns,
      { id, type: 'shape', position: { x: center.x, y: center.y }, data: { label, shape, color } }
    ])
  }

  // Drop a live desk-widget embed near the viewport centre. The node stores
  // only the widget id; WidgetEmbed resolves the current content at render.
  function addWidgetNode(widgetId: string): void {
    const id = newId('n')
    const center = rf.screenToFlowPosition
      ? rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      : { x: 160, y: 120 }
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: 'shape',
        position: { x: center.x - WIDGET_NODE_W / 2, y: center.y - WIDGET_NODE_H / 2 },
        data: { label: '', shape: 'widget', color, widgetId }
      }
    ])
  }

  // Edge label edit on double-click.
  const onEdgeDoubleClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      void promptText({
        title: 'Edge label',
        initial: typeof edge.label === 'string' ? edge.label : '',
        confirmLabel: 'Set label'
      }).then((next) => {
        if (next === null) return
        setEdges((es) => es.map((e) => (e.id === edge.id ? { ...e, label: next } : e)))
      })
    },
    [setEdges]
  )

  function applyTemplate(id: MapTemplateId): void {
    const tpl = normalizeMapBody(mapTemplate(id))
    setNodes(toFlowNodes(tpl))
    setEdges(toFlowEdges(tpl))
    seq.current = tpl.nodes.length
    window.setTimeout(() => rf.fitView({ padding: 0.2, duration: 300 }), 50)
  }

  function loadBody(b: MapBody): void {
    const norm = normalizeMapBody(b)
    setNodes(toFlowNodes(norm))
    setEdges(toFlowEdges(norm))
    seq.current = norm.nodes.length
    window.setTimeout(() => rf.fitView({ padding: 0.2, duration: 300 }), 50)
  }

  // Re-run the layered auto-layout on the current graph (the engine that lays out
  // AI-generated maps), then fit the result. Gives a one-click tidy-up.
  function arrangeMap(): void {
    const body = fromFlow(nodes, edges, viewportRef.current)
    const laid = autoLayout(body.nodes, body.edges)
    const posById = new Map(laid.map((n) => [n.id, { x: n.x, y: n.y }]))
    setNodes((ns) => ns.map((n) => (posById.has(n.id) ? { ...n, position: posById.get(n.id)! } : n)))
    window.setTimeout(() => rf.fitView({ padding: 0.2, duration: 300 }), 60)
  }

  // Boxes for the currently-selected shape nodes, for align/distribute.
  function selectedBoxes(ns: Node<ShapeData>[]): { id: string; x: number; y: number; w: number; h: number }[] {
    return ns
      .filter((n) => n.selected)
      .map((n) => {
        const def = defaultShapeSize(n.data.shape)
        return { id: n.id, x: n.position.x, y: n.position.y, w: n.data.width ?? def.w, h: n.data.height ?? def.h }
      })
  }
  function applyAlign(edge: AlignEdge): void {
    setNodes((ns) => {
      const moves = alignBoxes(selectedBoxes(ns), edge)
      return ns.map((n) => (moves.has(n.id) ? { ...n, position: moves.get(n.id)! } : n))
    })
  }
  function applyDistribute(axis: 'h' | 'v'): void {
    setNodes((ns) => {
      const moves = distributeBoxes(selectedBoxes(ns), axis)
      return ns.map((n) => (moves.has(n.id) ? { ...n, position: moves.get(n.id)! } : n))
    })
  }
  const selectedCount = nodes.filter((n) => n.selected).length

  async function exportMapAs(format: 'svg' | 'png' | 'jpg' | 'pdf'): Promise<void> {
    const map = fromFlow(nodes, edges, viewportRef.current)
    setExportStatus(`Exporting ${format.toUpperCase()}…`)
    try {
      const res = await window.api.map.export({ map, title: title || 'diagram', format })
      if (res.ok && res.path) setExportStatus(`Saved ${res.path}`)
      else if (res.error) setExportStatus(res.error)
      else setExportStatus(null)
    } catch (e) {
      setExportStatus(`Could not export: ${(e as Error).message}`)
    }
    window.setTimeout(() => setExportStatus(null), 4000)
  }

  const interactive = true

  return (
    <div className="h-full w-full flex flex-col bg-[var(--surface-raised)]">
      {/* Menu bar — real diagram actions (add shapes, fit view). */}
      <div className="shrink-0 px-2 pt-1.5 pb-1 border-b border-[var(--edge-soft)]">
        <DrawMenuBar
          actions={{
            shapes: SHAPE_TOOLS.map((t) => ({ shape: t.shape, label: t.label })),
            addNode,
            insertWidget: () => setWidgetPickerOpen(true),
            fitView: () => rf.fitView({ padding: 0.2, duration: 300 })
          }}
        />
      </div>
      {/* Stencil category picker — groups the shape library so the palette stays
          scannable as it grows. */}
      <div className="shrink-0 flex items-center gap-1 px-2 pt-1 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)]">
        {STENCIL_CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setStencilCat(cat)}
            data-testid={`map-stencil-cat-${cat.replace(/\s+/g, '-').toLowerCase()}`}
            className={`text-[11px] px-2 py-1 rounded-t ${
              stencilCat === cat
                ? 'text-[var(--ink-90)] font-semibold border-b-2 border-accent'
                : 'text-[var(--ink-50)] hover:text-[var(--ink-80)]'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>
      {/* Toolbar — the shapes of the active stencil category. */}
      <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_80%,transparent)] flex-wrap">
        {SHAPE_TOOLS.filter((t) => t.category === stencilCat).map((t) => (
          <button
            key={t.shape}
            onClick={() => addNode(t.shape)}
            data-testid={`map-add-${t.shape}`}
            className="inline-flex items-center gap-1 text-[11px] px-1.5 py-1 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
            title={`Add ${t.label}`}
          >
            <Icon name={t.icon} size={14} />
            {t.label}
          </button>
        ))}
        <div className="w-px h-4 bg-[var(--edge-firm)] mx-0.5" />
        {NODE_COLORS.map((c) => (
          // Swatch containment: a literal hairline holds arbitrary colours, including white-on-white.
          <button
            key={c}
            onClick={() => setColor(c)}
            className={`h-4 w-4 rounded-full border ${color === c ? 'ring-2 ring-offset-1 ring-stone-400' : 'border-black/10'}`}
            style={{ backgroundColor: c }}
            title="Colour for new nodes"
            aria-label={`Colour ${c}`}
          />
        ))}
        <button
          onClick={() => setDashed((v) => !v)}
          className={`ml-1 inline-flex items-center gap-1 text-[11px] px-1.5 py-1 rounded ${dashed ? 'bg-[var(--surface-sunken)] text-[var(--ink-90)]' : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'}`}
          title="Draw new connectors dashed"
        >
          <Icon name="more_horiz" size={14} />
          Dashed
        </button>
        <div className="w-px h-4 bg-[var(--edge-firm)] mx-0.5" />
        <TemplateMenu onPick={applyTemplate} />
        <button
          onClick={() => setAiOpen(true)}
          data-testid="map-ai"
          className="inline-flex items-center gap-1 text-[11px] px-1.5 py-1 rounded text-accent hover:bg-accent/[0.08]"
          title="Generate a map from a description"
        >
          <Icon name="auto_awesome" size={14} />
          AI map
        </button>
        <div className="flex-1" />
        {selectedCount >= 2 && (
          <div className="inline-flex items-center gap-0.5 mr-1" data-testid="map-align-tools">
            {(
              [
                { edge: 'left', icon: 'align_horizontal_left' },
                { edge: 'hcenter', icon: 'align_horizontal_center' },
                { edge: 'right', icon: 'align_horizontal_right' },
                { edge: 'top', icon: 'align_vertical_top' },
                { edge: 'vcenter', icon: 'align_vertical_center' },
                { edge: 'bottom', icon: 'align_vertical_bottom' }
              ] as const
            ).map((a) => (
              <button
                key={a.edge}
                onClick={() => applyAlign(a.edge)}
                data-testid={`map-align-${a.edge}`}
                className="h-6 w-6 inline-flex items-center justify-center rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                title={`Align ${a.edge}`}
              >
                <Icon name={a.icon} size={14} />
              </button>
            ))}
            {selectedCount >= 3 && (
              <>
                <button
                  onClick={() => applyDistribute('h')}
                  data-testid="map-distribute-h"
                  className="h-6 w-6 inline-flex items-center justify-center rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                  title="Distribute horizontally"
                >
                  <Icon name="horizontal_distribute" size={14} />
                </button>
                <button
                  onClick={() => applyDistribute('v')}
                  data-testid="map-distribute-v"
                  className="h-6 w-6 inline-flex items-center justify-center rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                  title="Distribute vertically"
                >
                  <Icon name="vertical_distribute" size={14} />
                </button>
              </>
            )}
            <div className="w-px h-4 bg-[var(--edge-firm)] mx-0.5" />
          </div>
        )}
        <button
          onClick={arrangeMap}
          data-testid="map-arrange"
          className="inline-flex items-center gap-1 text-[11px] px-1.5 py-1 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
          title="Auto-arrange the diagram into a clean layered layout"
        >
          <Icon name="account_tree" size={14} />
          Arrange
        </button>
        <ExportMenu onExport={exportMapAs} />
        <button
          onClick={() => rf.fitView({ padding: 0.2, duration: 300 })}
          className="inline-flex items-center gap-1 text-[11px] px-1.5 py-1 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
          title="Fit the whole map in view"
        >
          <Icon name="fit_screen" size={14} />
          Fit
        </button>
        {exportStatus ? (
          <span className="text-[10px] text-[var(--ink-60)] ml-1 max-w-[280px] truncate" data-testid="map-export-status" title={exportStatus}>
            {exportStatus}
          </span>
        ) : (
          <span className="text-[10px] text-[var(--ink-40)] ml-1">
            double-click a node to rename · drag a dot to connect · double-click a line to label · ⌫ deletes
          </span>
        )}
      </div>

      {/* Canvas */}
      <div className="flex-1 min-h-0 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgeDoubleClick={onEdgeDoubleClick}
          onMoveEnd={(_, vp) => (viewportRef.current = vp)}
          nodeTypes={nodeTypes}
          connectionMode={ConnectionMode.Loose}
          defaultViewport={initial.viewport}
          fitView={!initial.viewport}
          proOptions={{ hideAttribution: true }}
          panOnDrag={interactive}
          zoomOnScroll={interactive}
          nodesDraggable={interactive}
          nodesConnectable={interactive}
          elementsSelectable={interactive}
          deleteKeyCode={['Backspace', 'Delete']}
        >
          <Background gap={16} color="#e7e5e4" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="!bg-[var(--surface-sunken)]" />
        </ReactFlow>
        {nodes.length === 0 && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <span className="text-[12px] text-[var(--ink-40)]">
              Add a shape from the toolbar, pick a template, or generate a map with AI
            </span>
          </div>
        )}
      </div>

      {aiOpen && <AiMapPanel onClose={() => setAiOpen(false)} onApply={loadBody} />}

      {widgetPickerOpen && (
        <WidgetPickerDialog
          onPick={(widgetId) => {
            setWidgetPickerOpen(false)
            addWidgetNode(widgetId)
          }}
          onClose={() => setWidgetPickerOpen(false)}
        />
      )}
    </div>
  )
}

function TemplateMenu({ onPick }: { onPick: (id: MapTemplateId) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const items: { id: MapTemplateId; label: string }[] = [
    { id: 'flowchart', label: 'Flowchart' },
    { id: 'orgchart', label: 'Org chart' },
    { id: 'mindmap', label: 'Mind map' },
    { id: 'swimlane', label: 'Approval flow' }
  ]
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] px-1.5 py-1 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
        title="Start from a template"
      >
        <Icon name="dashboard" size={14} />
        Templates
        <Icon name="expand_more" size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute z-20 mt-1 w-40 py-1">
            {items.map((it) => (
              <button
                key={it.id}
                onClick={() => {
                  onPick(it.id)
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--surface-sunken)]"
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ExportMenu({ onExport }: { onExport: (f: 'svg' | 'png' | 'jpg' | 'pdf') => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const items: { id: 'svg' | 'png' | 'jpg' | 'pdf'; label: string }[] = [
    { id: 'png', label: 'PNG image' },
    { id: 'svg', label: 'SVG (vector)' },
    { id: 'jpg', label: 'JPG image' },
    { id: 'pdf', label: 'PDF' }
  ]
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        data-testid="map-export-btn"
        className="inline-flex items-center gap-1 text-[11px] px-1.5 py-1 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
        title="Export this diagram"
      >
        <Icon name="download" size={14} />
        Export
        <Icon name="expand_more" size={12} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute right-0 z-20 mt-1 w-40 py-1">
            {items.map((it) => (
              <button
                key={it.id}
                data-testid={`map-export-${it.id}`}
                onClick={() => {
                  onExport(it.id)
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--surface-sunken)]"
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function AiMapPanel({
  onClose,
  onApply
}: {
  onClose: () => void
  onApply: (body: MapBody) => void
}): JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(): Promise<void> {
    const p = prompt.trim()
    if (!p || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.documents.generate({ docType: 'map', prompt: p })
      if (!r.ok || !r.body) {
        setError(r.error || 'Could not generate a map.')
        return
      }
      // Lay it out before applying so AI nodes (no coordinates) read well.
      const norm = normalizeMapBody(r.body)
      onApply({ ...norm, nodes: autoLayout(norm.nodes, norm.edges) })
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fb-scrim absolute inset-0 z-30 flex items-center justify-center" onClick={onClose}>
      <div
        className="fb-card fb-press w-[440px] max-w-[90%] p-4 space-y-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <Icon name="auto_awesome" size={15} className="text-accent" />
          Generate a map with AI
        </div>
        <p className="text-[11px] text-[var(--ink-50)]">
          Describe a process, decision flow, or structure. The model returns the steps and
          connections; PlexiDiagrams lays them out for you.
        </p>
        <textarea
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run()
          }}
          rows={4}
          placeholder="e.g. The customer onboarding process from signup to first value, with an approval step"
          className="fb-field w-full px-2 py-1.5 text-[12px]"
        />
        {error && <div className="text-[11px] text-red-600 dark:text-red-400">{error}</div>}
        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-[12px] px-3 py-1.5 text-[var(--ink-50)] hover:text-[var(--ink-70)]">
            Cancel
          </button>
          <button
            onClick={() => void run()}
            disabled={busy || !prompt.trim()}
            data-testid="map-ai-run"
            className="btn-primary text-[12px] px-3 py-1.5 disabled:opacity-50"
          >
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </div>
        <p className="text-[10px] text-[var(--ink-40)]">This replaces the current map. Cmd/Ctrl+Enter to run.</p>
      </div>
    </div>
  )
}

export default function MapEditor(props: Props): JSX.Element {
  return (
    <ReactFlowProvider>
      <MapInner {...props} />
    </ReactFlowProvider>
  )
}
