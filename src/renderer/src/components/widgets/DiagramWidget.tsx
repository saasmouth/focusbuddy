import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import Icon from '../Icon'

// ── Diagram widget ──────────────────────────────────────────────────────────
// A React Flow node/edge canvas for structured diagrams: flowcharts, entity
// hierarchies, server/software design, mind-map-style trees, and basic Venn
// (overlapping translucent circle nodes). Nodes can be a box, circle, text
// label, or an uploaded image/icon; edges are connectors. The whole graph
// (nodes + edges) serialises to widget.content as JSON.

type ShapeKind = 'box' | 'circle' | 'text' | 'image'
interface ShapeData {
  label: string
  shape: ShapeKind
  color: string
  img?: string // data URL for image/icon nodes
  [key: string]: unknown
}

const NODE_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#475569']

// ── Custom node ─────────────────────────────────────────────────────────────
function ShapeNode({ id, data, selected }: NodeProps): JSX.Element {
  const d = data as ShapeData
  const [editing, setEditing] = useState(false)
  const ring = selected ? 'ring-2 ring-accent' : ''
  const handleStyle = { width: 8, height: 8, background: '#94a3b8' }

  const inner = (() => {
    if (d.shape === 'image') {
      return d.img ? (
        <img src={d.img} alt={d.label} className="max-w-full max-h-full object-contain pointer-events-none" />
      ) : (
        <span className="text-[10px] text-[var(--ink-40)]">image</span>
      )
    }
    return (
      <EditableLabel
        nodeId={id}
        value={d.label}
        editing={editing}
        setEditing={setEditing}
        textOnly={d.shape === 'text'}
      />
    )
  })()

  const base = 'flex items-center justify-center text-center text-[12px] font-medium p-2 select-none'
  let shapeCls = ''
  let style: React.CSSProperties = {}
  if (d.shape === 'box') {
    shapeCls = `${base} rounded-md border-2 bg-[var(--surface-raised)]`
    style = { borderColor: d.color, color: '#1c1917', minWidth: 90, minHeight: 44 }
  } else if (d.shape === 'circle') {
    // Translucent fill so overlapping circles read as a Venn diagram.
    shapeCls = `${base} rounded-full border-2`
    style = {
      borderColor: d.color,
      background: `${d.color}26`,
      color: '#1c1917',
      width: 110,
      height: 110
    }
  } else if (d.shape === 'text') {
    shapeCls = `${base} bg-transparent`
    style = { color: d.color, minWidth: 60 }
  } else {
    shapeCls = `${base} rounded-md bg-[color-mix(in_oklab,var(--surface-raised)_60%,transparent)] border border-dashed border-[var(--edge-firm)]`
    style = { minWidth: 60, minHeight: 60, padding: 4 }
  }

  return (
    <div
      className={`${shapeCls} ${ring}`}
      style={style}
      onDoubleClick={() => d.shape !== 'image' && setEditing(true)}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="target" position={Position.Left} style={handleStyle} />
      {inner}
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </div>
  )
}

// Inline label editor — commits the new label up through a custom DOM event the
// host listens for (keeps ShapeNode free of store wiring / re-render churn).
function EditableLabel({
  nodeId,
  value,
  editing,
  setEditing,
  textOnly
}: {
  nodeId: string
  value: string
  editing: boolean
  setEditing: (v: boolean) => void
  textOnly: boolean
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  function commit(): void {
    setEditing(false)
    window.dispatchEvent(
      new CustomEvent('fb-diagram-label', { detail: { nodeId, label: draft } })
    )
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
        className="bg-[var(--surface-raised)] text-[var(--ink-100)] text-[12px] text-center rounded px-1 border border-accent w-full"
        onClick={(e) => e.stopPropagation()}
      />
    )
  }
  return <span className={textOnly ? '' : 'whitespace-pre-wrap break-words'}>{value || '…'}</span>
}

const nodeTypes = { shape: ShapeNode }

interface GraphState {
  nodes: Node<ShapeData>[]
  edges: Edge[]
}
function parseState(content: string): GraphState {
  if (!content) return { nodes: [], edges: [] }
  try {
    const o = JSON.parse(content) as Partial<GraphState>
    return {
      nodes: Array.isArray(o.nodes) ? (o.nodes as Node<ShapeData>[]) : [],
      edges: Array.isArray(o.edges) ? (o.edges as Edge[]) : []
    }
  } catch {
    return { nodes: [], edges: [] }
  }
}

interface Props {
  widget: Widget
  inline?: boolean
}

function DiagramInner({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const isActive = useWidgetStore((s) => s.activeWidgetId === widget.id)
  const initial = useMemo(() => parseState(widget.content), [widget.id])
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<ShapeData>>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges)
  const [color, setColor] = useState(NODE_COLORS[0])
  const seq = useRef(initial.nodes.length)
  const lastSavedRef = useRef(widget.content)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const stateRef = useRef<GraphState>(initial)
  stateRef.current = { nodes, edges }

  const interactive = inline || isActive

  // Persist (debounced) whenever the graph changes.
  useEffect(() => {
    const json = JSON.stringify({ nodes, edges })
    if (json === lastSavedRef.current) return
    const t = window.setTimeout(() => {
      lastSavedRef.current = json
      void update(widget.id, { content: json })
    }, 500)
    return () => window.clearTimeout(t)
  }, [nodes, edges, update, widget.id])
  // Flush on unmount (layout remounts).
  useEffect(() => {
    return () => {
      const json = JSON.stringify(stateRef.current)
      if (json !== lastSavedRef.current) void update(widget.id, { content: json })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.id])

  // Reflect external content updates that arrive after mount, such as Build
  // with AI appending nodes from the context menu. parseState only runs once on
  // init, so without this a menu-driven update would not appear until remount.
  // The guard against lastSavedRef means a local edit (which writes the same
  // content) never triggers a reset mid-interaction.
  useEffect(() => {
    if (widget.content && widget.content !== lastSavedRef.current) {
      const next = parseState(widget.content)
      lastSavedRef.current = widget.content
      setNodes(next.nodes)
      setEdges(next.edges)
      seq.current = next.nodes.length
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.content])

  // Label edits dispatched from ShapeNode.
  useEffect(() => {
    function onLabel(e: Event): void {
      const { nodeId, label } = (e as CustomEvent).detail as { nodeId: string; label: string }
      setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, label } } : n)))
    }
    window.addEventListener('fb-diagram-label', onLabel as EventListener)
    return () => window.removeEventListener('fb-diagram-label', onLabel as EventListener)
  }, [setNodes])

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((es) =>
        addEdge({ ...c, markerEnd: { type: MarkerType.ArrowClosed }, animated: false }, es)
      ),
    [setEdges]
  )

  function addNode(shape: ShapeKind, img?: string): void {
    seq.current += 1
    const id = `n${Date.now().toString(36)}-${seq.current}`
    const label = shape === 'text' ? 'Label' : shape === 'image' ? '' : 'Node'
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: 'shape',
        position: { x: 60 + (seq.current % 5) * 40, y: 60 + (seq.current % 7) * 30 },
        data: { label, shape, color, img }
      }
    ])
  }

  function onPickImage(e: React.ChangeEvent<HTMLInputElement>): void {
    // Every picked image becomes a node, instead of only the first.
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (picked.length === 0) return

    // Keep the widget JSON sane — large images bloat persistence.
    const ok = picked.filter((f) => f.size <= 1_500_000)
    const tooBig = picked.filter((f) => f.size > 1_500_000)
    for (const f of ok) {
      const reader = new FileReader()
      reader.onload = () => addNode('image', String(reader.result))
      reader.readAsDataURL(f)
    }
    if (tooBig.length > 0) {
      // Say which ones were skipped and keep the rest. The old version refused
      // the whole pick on one oversized file, which with multi-select would
      // mean one 2MB photo silently costing you the other nine.
      // eslint-disable-next-line no-alert
      window.alert(
        tooBig.length === picked.length
          ? `Too large (over 1.5MB): ${tooBig.map((f) => f.name).join(', ')}. Nothing was added.`
          : `Added ${ok.length} of ${picked.length}. Too large (over 1.5MB): ${tooBig
              .map((f) => f.name)
              .join(', ')}.`
      )
    }
  }

  const tools: { shape: ShapeKind; icon: string; label: string }[] = [
    { shape: 'box', icon: 'crop_square', label: 'Box' },
    { shape: 'circle', icon: 'circle', label: 'Circle / Venn' },
    { shape: 'text', icon: 'title', label: 'Text' }
  ]

  const body = (
    <div className="h-full w-full flex flex-col bg-[var(--surface-raised)]">
      <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_80%,transparent)]">
        {tools.map((t) => (
          <button
            key={t.shape}
            onClick={() => addNode(t.shape)}
            className="inline-flex items-center gap-1 text-[11px] px-1.5 py-1 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
            title={`Add ${t.label}`}
          >
            <Icon name={t.icon} size={14} />
            {t.label}
          </button>
        ))}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-1 text-[11px] px-1.5 py-1 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
          title="Add an image / icon node (upload)"
        >
          <Icon name="add_photo_alternate" size={14} />
          Image
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={onPickImage} />
        <div className="w-px h-4 bg-[var(--surface-sunken)] mx-0.5" />
        {NODE_COLORS.map((c) => (
          // Swatch containment: a literal hairline holds arbitrary colours.
          <button
            key={c}
            onClick={() => setColor(c)}
            className={`h-4 w-4 rounded-full border ${color === c ? 'ring-2 ring-offset-1 ring-[var(--edge-firm)]' : 'border-black/10'}`}
            style={{ backgroundColor: c }}
            title={`Colour for new nodes`}
            aria-label={`Colour ${c}`}
          />
        ))}
        <div className="flex-1" />
        <span className="text-[10px] text-[var(--ink-40)]">double-click a node to rename · drag the dots to connect · ⌫ deletes</span>
      </div>
      <div className="flex-1 min-h-0 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
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
        </ReactFlow>
        {nodes.length === 0 && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <span className="text-[12px] text-[var(--ink-40)]">
              Add a Box, Circle, Text or Image from the toolbar to start your diagram
            </span>
          </div>
        )}
      </div>
    </div>
  )

  if (inline) return body
  return (
    <WidgetFrame widget={widget} headerLabel="Diagram" headerAccent="bg-sky-300/50 dark:bg-sky-400/20">
      {body}
    </WidgetFrame>
  )
}

export default function DiagramWidget(props: Props): JSX.Element {
  // ReactFlowProvider gives each widget its own isolated flow instance.
  return (
    <ReactFlowProvider>
      <DiagramInner {...props} />
    </ReactFlowProvider>
  )
}
