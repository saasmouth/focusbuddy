import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Handle, NodeResizer, Position, useStore, type NodeProps } from '@xyflow/react'
import { getShape, shapePorts } from '@shared/diagram/shapes'
import { nodeSize, portId, sideOf } from '@shared/diagram/geom'
import { resolveNodeStyle } from '@shared/diagram/style'
import { boundView } from '@shared/diagram/data'
import type { MapNode } from '@shared/types'
import { ShapeSvg } from './ShapeSvg'
import { useDiagramCtx, type QuickDir } from './DiagramContext'
import WidgetEmbed from '../embed/WidgetEmbed'
import Icon from '../../Icon'

// One diagram shape on the canvas. Geometry comes from the shape registry and
// style from the resolver, so canvas and export agree. Selection is made
// unmistakable: a bold accent frame with a soft halo, square resize handles, a
// rotation knob and quick-add arrows; hover shows a faint outline; locked
// shapes show a grey frame and a lock badge instead of handles.

export const SELECT_COLOR = '#2563eb'

const SIDE_POS: Record<string, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left }

export interface ShapeNodeData extends Record<string, unknown> {
  nodeId: string
  locked?: boolean
}

function ShapeNodeImpl({ id, selected, dragging }: NodeProps): JSX.Element | null {
  const ctx = useDiagramCtx()
  const node = ctx.nodesById.get(id)
  if (!node) return null
  return <ShapeBody node={node} selected={!!selected} dragging={!!dragging} />
}

function ShapeBody({ node, selected, dragging }: { node: MapNode; selected: boolean; dragging: boolean }): JSX.Element {
  const ctx = useDiagramCtx()
  const def = getShape(node.shape)
  const { w, h } = nodeSize(node)
  const geometry = useMemo(() => def.draw(w, h), [def, w, h])
  const editing = ctx.editingId === node.id

  const bound = useMemo(() => {
    if (!node.binding || node.binding.source.kind !== 'table') return null
    const tid = node.binding.source.tableId
    return boundView(node.binding, ctx.tables[tid], ctx.rows[tid], node.label)
  }, [node.binding, node.label, ctx.tables, ctx.rows])
  const style = useMemo(() => resolveNodeStyle(node, ctx.themeId, bound?.rule), [node, ctx.themeId, bound?.rule])
  const label = bound ? bound.label : node.label
  const icon = bound?.rule?.icon || node.icon || (def.special === 'icon' ? def.icon : undefined)
  const locked = !!node.locked

  const ports = shapePorts(node.shape)
  const showPorts = !locked && def.special !== 'lane' && !ctx.readOnly
  const rot = node.rotation ?? 0

  const startEdit = (): void => {
    if (locked || ctx.readOnly || def.special === 'widget') return
    ctx.setEditingId(node.id)
  }

  // Canvas zoom, read only while selected so unselected nodes never re-render on zoom.
  const zoom = useStore((st) => (selected ? st.transform[2] : 1))
  const k = 1 / Math.max(zoom, 0.05)
  return (
    <div
      className="pd-node group"
      style={{ width: w, height: h, position: 'relative' }}
      data-shape={node.shape}
      data-selected={selected ? 'true' : undefined}
      onDoubleClick={(e) => {
        e.stopPropagation()
        startEdit()
      }}
    >
      {/* Resize: square handles on the unrotated box; aspect kept for circles/icons (Shift toggles in React Flow). */}
      <NodeResizer
        isVisible={selected && !locked && !ctx.readOnly && ctx.selectedNodeCount === 1}
        minWidth={def.minW ?? 24}
        minHeight={def.minH ?? 16}
        keepAspectRatio={!!def.aspectLocked}
        color={SELECT_COLOR}
        handleStyle={{ width: 9, height: 9, borderRadius: 2, background: '#ffffff', border: `1.5px solid ${SELECT_COLOR}` }}
        onResizeStart={() => ctx.checkpoint()}
        lineStyle={{ borderColor: 'transparent' }}
      />

      <div
        className="absolute inset-0"
        style={{ transform: rot ? `rotate(${rot}deg)` : undefined, transformOrigin: '50% 50%' }}
      >
        {def.special !== 'widget' && (
          <ShapeSvg shape={node.shape} w={w} h={h} style={style} geometry={geometry} flipX={node.flipX} flipY={node.flipY} />
        )}

        {def.special === 'widget' && (
          <div className="absolute inset-0 overflow-hidden rounded-lg border" style={{ borderColor: style.stroke }}>
            <WidgetEmbed widgetId={node.widgetId ?? ''} />
          </div>
        )}

        {def.special === 'image' && <ImageBody node={node} w={w} h={h} />}

        {def.special === 'table' && <TableBody node={node} style={style} />}

        {(def.special === 'umlClass' || def.special === 'erdEntity') && !editing && (
          <CompartmentBody label={label} style={style} />
        )}

        {icon && (
          <span
            className="material-symbols-outlined absolute select-none pointer-events-none"
            style={iconPlacement(def.special === 'icon', w, h, geometry.text, style.stroke === 'none' ? style.textColor : style.stroke)}
          >
            {icon}
          </span>
        )}

        {def.special !== 'table' && def.special !== 'widget' && def.special !== 'umlClass' && def.special !== 'erdEntity' && (
          <TextBlock
            node={node}
            label={label}
            rect={icon && def.special !== 'icon' ? { ...geometry.text, y: geometry.text.y + Math.min(26, geometry.text.h * 0.4), h: Math.max(10, geometry.text.h - Math.min(26, geometry.text.h * 0.4)) } : geometry.text}
            style={style}
            vertical={def.special === 'lane'}
            editing={editing}
            fields={bound?.fields}
          />
        )}
        {(def.special === 'umlClass' || def.special === 'erdEntity') && editing && (
          <TextBlock node={node} label={label} rect={{ x: 0, y: 0, w, h }} style={{ ...style, vAlign: 'top', textAlign: 'left' }} editing />
        )}
        {bound?.missing && (
          <span
            className="absolute -top-2 -right-2 rounded-full bg-amber-500 text-white text-[9px] px-1.5 py-0.5 shadow"
            title={bound.missing === 'table' ? 'The linked table no longer exists' : 'The linked row was deleted'}
          >
            unlinked
          </span>
        )}
        {node.link && !selected && (
          <span className="absolute -bottom-2 -right-2 rounded-full bg-white shadow p-0.5 text-[var(--ink-60)]" title={node.link}>
            <Icon name="link" size={11} />
          </span>
        )}
      </div>

      {/* Hover outline (only when not selected). */}
      {!selected && (
        <div
          className="pointer-events-none absolute -inset-[3px] rounded-[4px] border border-dashed opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ borderColor: `${SELECT_COLOR}99` }}
        />
      )}

      {/* Selection frame: bold, haloed, impossible to miss. Sized in screen
          pixels (k = 1/zoom) so it stays a solid 2px line zoomed in or out. */}
      {selected && (
        <div
          className="pointer-events-none absolute"
          data-testid="diagram-selection-frame"
          data-screen-px={2}
          style={{
            inset: -5 * k,
            borderRadius: 5 * k,
            border: `${2 * k}px solid ${locked ? '#94a3b8' : SELECT_COLOR}`,
            boxShadow: locked
              ? `0 0 0 ${3 * k}px rgba(148,163,184,0.25)`
              : `0 0 0 ${4 * k}px ${SELECT_COLOR}2e, 0 ${6 * k}px ${18 * k}px ${SELECT_COLOR}26`,
            transform: rot ? `rotate(${rot}deg)` : undefined
          }}
        />
      )}
      {selected && locked && (
        <span className="absolute -top-3 -left-3 rounded-full bg-white shadow p-0.5 text-[var(--ink-60)]" title="Locked">
          <Icon name="lock" size={12} />
        </span>
      )}

      {/* Rotation knob. */}
      {selected && !locked && !ctx.readOnly && ctx.selectedNodeCount === 1 && !dragging && def.special !== 'lane' && (
        <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center" style={{ top: -34 }}>
          <div
            className="nodrag h-3.5 w-3.5 rounded-full bg-white cursor-grab shadow-sm"
            style={{ border: `1.5px solid ${SELECT_COLOR}` }}
            title="Rotate (Shift snaps to 15°)"
            data-testid="diagram-rotate-handle"
            onPointerDown={(e) => {
              e.stopPropagation()
              ctx.beginRotate(node.id, e)
            }}
          />
          <div className="w-px h-4" style={{ background: SELECT_COLOR }} />
        </div>
      )}

      {/* Quick-add: click an arrow to add a connected copy in that direction. */}
      {selected && !locked && !ctx.readOnly && ctx.selectedNodeCount === 1 && !dragging && !editing && !def.container && (
        <>
          {(['up', 'right', 'down', 'left'] as QuickDir[]).map((d) => (
            <button
              key={d}
              className="nodrag nopan absolute h-5 w-5 rounded-full bg-white shadow-sm flex items-center justify-center hover:scale-110 transition-transform"
              style={{ ...quickPos(d), border: `1.5px solid ${SELECT_COLOR}`, color: SELECT_COLOR }}
              title={`Add a connected shape ${d === 'up' ? 'above' : d === 'down' ? 'below' : `to the ${d}`}`}
              data-testid={`diagram-quick-${d}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                ctx.quickAdd(node.id, d)
              }}
            >
              <Icon name={d === 'up' ? 'arrow_upward' : d === 'down' ? 'arrow_downward' : d === 'left' ? 'arrow_back' : 'arrow_forward'} size={12} />
            </button>
          ))}
        </>
      )}

      {/* Connection points. Side midpoints keep the standard ids/classes. */}
      {showPorts &&
        ports.map(([fx, fy]) => {
          const pid = portId(fx, fy)
          const side = sideOf(fx, fy)
          const isMid = pid === side
          return (
            <Handle
              key={pid}
              id={pid}
              type="source"
              position={SIDE_POS[side]!}
              className={`pd-port ${selected || ctx.connecting ? 'pd-port-on' : ''}`}
              style={
                isMid
                  ? undefined
                  : { left: `${fx * 100}%`, top: `${fy * 100}%`, right: 'auto', bottom: 'auto', transform: 'translate(-50%, -50%)' }
              }
            />
          )
        })}
    </div>
  )
}

function quickPos(d: QuickDir): React.CSSProperties {
  switch (d) {
    case 'up':
      return { left: '50%', top: -58, transform: 'translateX(-50%)' }
    case 'down':
      return { left: '50%', bottom: -30, transform: 'translateX(-50%)' }
    case 'left':
      return { top: '50%', left: -32, transform: 'translateY(-50%)' }
    case 'right':
      return { top: '50%', right: -32, transform: 'translateY(-50%)' }
  }
}

function iconPlacement(isIconShape: boolean, w: number, h: number, text: { x: number; y: number; w: number; h: number }, color: string): React.CSSProperties {
  if (isIconShape) {
    const top = 4
    const avail = Math.max(12, (text.y > h * 0.4 ? text.y : h) - top - 4)
    const size = Math.max(14, Math.min(w * 0.7, avail))
    return { left: '50%', top, transform: 'translateX(-50%)', fontSize: size, lineHeight: 1, color }
  }
  const size = Math.max(12, Math.min(22, text.h * 0.5))
  return { left: text.x + text.w / 2, top: text.y + 2, transform: 'translateX(-50%)', fontSize: size, lineHeight: 1, color }
}

function TextBlock({
  node,
  label,
  rect,
  style,
  vertical,
  editing,
  fields
}: {
  node: MapNode
  label: string
  rect: { x: number; y: number; w: number; h: number }
  style: ReturnType<typeof resolveNodeStyle>
  vertical?: boolean
  editing: boolean
  fields?: { name: string; value: string }[]
}): JSX.Element {
  const ctx = useDiagramCtx()
  const [draft, setDraft] = useState(node.label)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (editing) {
      setDraft(node.label)
      window.requestAnimationFrame(() => {
        ref.current?.focus()
        ref.current?.select()
      })
    }
  }, [editing, node.label])
  const textStyle: React.CSSProperties = {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.bold ? 700 : 500,
    fontStyle: style.italic ? 'italic' : undefined,
    textDecoration: [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined,
    color: style.textColor,
    textAlign: style.textAlign,
    lineHeight: 1.25
  }
  const box: React.CSSProperties = {
    position: 'absolute',
    left: rect.x,
    top: rect.y,
    width: rect.w,
    height: rect.h,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: style.vAlign === 'top' ? 'flex-start' : style.vAlign === 'bottom' ? 'flex-end' : 'center',
    alignItems: style.textAlign === 'left' ? 'flex-start' : style.textAlign === 'right' ? 'flex-end' : 'center',
    overflow: 'hidden'
  }
  if (editing) {
    const commit = (): void => {
      ctx.commitLabel(node.id, draft)
      ctx.setEditingId(null)
    }
    return (
      <div style={{ ...box, overflow: 'visible' }} className="nodrag nopan nowheel">
        <textarea
          ref={ref}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commit()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              ctx.setEditingId(null)
            }
          }}
          onPointerDown={(e) => e.stopPropagation()}
          data-testid="diagram-label-editor"
          rows={Math.max(1, draft.split('\n').length)}
          className="w-full resize-none bg-white/95 rounded outline-none px-1"
          style={{ ...textStyle, color: '#1c1917', border: `1.5px solid ${SELECT_COLOR}`, minHeight: '1.6em', maxHeight: '100%' }}
        />
      </div>
    )
  }
  return (
    <div style={box} className="pointer-events-none select-none px-0.5">
      <span
        className="whitespace-pre-wrap break-words"
        style={vertical ? { ...textStyle, writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontWeight: 600 } : textStyle}
      >
        {label}
      </span>
      {fields?.length ? (
        <div className="mt-0.5 w-full" style={{ fontSize: Math.max(9, style.fontSize - 2), color: style.textColor, opacity: 0.8, textAlign: style.textAlign }}>
          {fields.map((f) => (
            <div key={f.name} className="truncate">
              <span className="opacity-70">{f.name}:</span> {f.value}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// UML class / ERD entity: first line is the name in a header band; '--' lines
// split compartments (UML) or each line is an attribute row (ERD).
function CompartmentBody({ label, style }: { label: string; style: ReturnType<typeof resolveNodeStyle> }): JSX.Element {
  const lines = label.split('\n')
  const name = lines[0] ?? ''
  const rest = lines.slice(1)
  const sections: string[][] = [[]]
  for (const l of rest) {
    if (/^\s*-{2,}\s*$/.test(l)) sections.push([])
    else sections[sections.length - 1]!.push(l)
  }
  const fs = style.fontSize
  return (
    <div className="absolute inset-0 flex flex-col pointer-events-none select-none overflow-hidden" style={{ fontFamily: style.fontFamily, color: style.textColor }}>
      <div className="shrink-0 text-center px-1 py-1 truncate" style={{ fontSize: fs, fontWeight: 700, borderBottom: `1px solid ${style.stroke}`, fontStyle: style.italic ? 'italic' : undefined }}>
        {name}
      </div>
      {sections.map((sec, i) => (
        <div key={i} className="px-1.5 py-0.5" style={{ fontSize: Math.max(9, fs - 1), borderTop: i ? `1px solid ${style.stroke}` : undefined, minHeight: 8, textAlign: 'left' }}>
          {sec.map((l, j) => (
            <div key={j} className="truncate whitespace-pre" style={/^\s*(PK|#|\*)/.test(l) ? { fontWeight: 600, textDecoration: 'underline' } : undefined}>
              {l}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function tableDims(node: MapNode): { rows: number; cols: number } {
  if (node.cells?.length) return { rows: node.cells.length, cols: Math.max(1, ...node.cells.map((r) => r.length)) }
  const m = /(\d+)x(\d+)/.exec(node.shape)
  if (m) return { cols: Number(m[1]), rows: Number(m[2]) }
  return { rows: 3, cols: 3 }
}

function TableBody({ node, style }: { node: MapNode; style: ReturnType<typeof resolveNodeStyle> }): JSX.Element {
  const ctx = useDiagramCtx()
  const { rows, cols } = tableDims(node)
  const [edit, setEdit] = useState<{ r: number; c: number } | null>(null)
  const header = /header/.test(node.shape) || !!node.style?.bold
  return (
    <div
      className="absolute inset-0 grid"
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, fontFamily: style.fontFamily, fontSize: style.fontSize, color: style.textColor }}
    >
      {Array.from({ length: rows * cols }, (_, i) => {
        const r = Math.floor(i / cols)
        const c = i % cols
        const text = node.cells?.[r]?.[c] ?? ''
        const isEdit = edit?.r === r && edit?.c === c
        return (
          <div
            key={i}
            className="relative overflow-hidden px-1 flex items-center"
            style={{
              borderRight: c < cols - 1 ? `1px solid ${style.stroke}` : undefined,
              borderBottom: r < rows - 1 ? `1px solid ${style.stroke}` : undefined,
              background: header && r === 0 ? `${style.stroke}22` : undefined,
              fontWeight: header && r === 0 ? 700 : 500,
              justifyContent: style.textAlign === 'left' ? 'flex-start' : style.textAlign === 'right' ? 'flex-end' : 'center'
            }}
            onDoubleClick={(e) => {
              if (node.locked || ctx.readOnly) return
              e.stopPropagation()
              setEdit({ r, c })
            }}
          >
            {isEdit ? (
              <input
                autoFocus
                defaultValue={text}
                className="nodrag w-full bg-white rounded px-0.5 outline-none"
                style={{ border: `1.5px solid ${SELECT_COLOR}`, fontSize: style.fontSize }}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    ctx.commitCell(node.id, r, c, (e.target as HTMLInputElement).value)
                    e.preventDefault()
                    if (e.key === 'Tab') setEdit({ r: c + 1 < cols ? r : r + 1 < rows ? r + 1 : 0, c: (c + 1) % cols })
                    else setEdit(null)
                  }
                  if (e.key === 'Escape') setEdit(null)
                }}
                onBlur={(e) => {
                  ctx.commitCell(node.id, r, c, e.target.value)
                  setEdit((cur) => (cur?.r === r && cur?.c === c ? null : cur))
                }}
              />
            ) : (
              <span className="truncate">{text}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ImageBody({ node, w, h }: { node: MapNode; w: number; h: number }): JSX.Element {
  if (!node.image) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center text-[10px] text-[var(--ink-50)] pointer-events-none">
        <Icon name="image" size={Math.min(28, h * 0.4)} />
        <span>Add an image in the inspector</span>
      </div>
    )
  }
  return (
    <img
      src={node.image}
      alt={node.label || 'Image'}
      draggable={false}
      className="absolute inset-0 pointer-events-none select-none"
      style={{ width: w, height: h, objectFit: 'contain' }}
    />
  )
}

export const ShapeNode = memo(ShapeNodeImpl)
