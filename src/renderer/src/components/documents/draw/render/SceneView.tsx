// The artwork on screen: one <svg> per vector layer, one element per node.
//
// MEMOISED BY IDENTITY. Documents are immutable and every edit shares the
// nodes it did not touch, so a node whose object is the same object as last
// render is skipped entirely -- its path string is not even recomputed. A drag
// that moves one shape out of thousands re-renders one shape.
//
// Paints and gradients come from the same descriptions the exporter
// serializes (svgDocPaint), so a gradient or a swatch can never look different
// on screen than in the file; they are drawn as React elements, so nothing a
// document holds is ever injected as markup.

import { memo } from 'react'
import { isDrawImageSrc, type DrawGradientDef } from '@shared/draw'
import { pathToSvgD } from '@shared/drawGeometry'
import { assetSrc } from '@shared/draw/assets'
import type { DrawArtboard, DrawAsset, DrawDocVectorLayer, DrawNode, DrawSwatch, Matrix } from '@shared/draw/model'
import { clipId, svgDocPaint } from '@shared/draw/svg'
import { clipGroupParts, clipSilhouette } from '@shared/draw/ops/masks'
import PlacedWidgetEmbed from '../../embed/PlacedWidgetEmbed'

type Swatches = { swatches: DrawSwatch[] }

/** Every gradient a node's paints need (fill first, then stroke; appearance stack; group members). */
export function nodeGradients(o: DrawNode, sw: Swatches): DrawGradientDef[] {
  if (o.hidden || o.type === 'image' || o.type === 'widget' || o.type === 'opaque') return []
  if (o.type === 'group') return o.children.flatMap((c) => nodeGradients(c, sw))
  const out: DrawGradientDef[] = []
  if (o.appearance) {
    o.appearance.fills.forEach((f, i) => {
      const g = svgDocPaint(sw, f.paint, `${o.id}-f${i}`).gradient
      if (g && f.enabled !== false) out.push(g)
    })
    o.appearance.strokes.forEach((s, i) => {
      const g = svgDocPaint(sw, s.stroke.paint, `${o.id}-k${i}-s`).gradient
      if (g && s.enabled !== false) out.push(g)
    })
    return out
  }
  const f = svgDocPaint(sw, o.fill, o.id).gradient
  if (f) out.push(f)
  if (o.stroke) {
    const s = svgDocPaint(sw, o.stroke.paint, `${o.id}-s`).gradient
    if (s) out.push(s)
  }
  return out
}

function matrixAttr(m: Matrix | undefined): string | undefined {
  return m && m.length === 6 && m.every((v) => Number.isFinite(v)) ? `matrix(${m.join(' ')})` : undefined
}

/** A frame's transform: the extra matrix outside, the rotation about the pivot inside -- the exporter's exact order. */
function frameTransform(m: Matrix | undefined, rotation: number | undefined, px: number, py: number): string | undefined {
  const rot = rotation ? `rotate(${rotation} ${px} ${py})` : undefined
  const mat = matrixAttr(m)
  if (mat && rot) return `${mat} ${rot}`
  return mat ?? rot
}

export const GradientView = memo(function GradientView({ g }: { g: DrawGradientDef }): JSX.Element {
  const stops = g.stops.map((s, i) => <stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />)
  if (g.kind === 'linear') {
    return (
      <linearGradient id={g.id} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2}>
        {stops}
      </linearGradient>
    )
  }
  return (
    <radialGradient id={g.id} cx={g.cx ?? '0.5'} cy={g.cy ?? '0.5'} r={g.r ?? '0.5'} fx={g.fx} fy={g.fy}>
      {stops}
    </radialGradient>
  )
})

interface NodeProps {
  o: DrawNode
  assets: Record<string, DrawAsset>
  swatches: DrawSwatch[]
}

/** Whether a node reads the asset store (an image, or a group that may hold one). */
function readsAssets(o: DrawNode): boolean {
  return o.type === 'image' || o.type === 'group'
}

/** Whether any paint on the node refers to a swatch. */
function readsSwatches(o: DrawNode): boolean {
  if (o.type === 'group') return o.children.some(readsSwatches)
  if (o.type !== 'path' && o.type !== 'text') return false
  if (o.fill.type === 'swatch' || o.stroke?.paint.type === 'swatch') return true
  const a = o.appearance
  return !!a && (a.fills.some((f) => f.paint.type === 'swatch') || a.strokes.some((k) => k.stroke.paint.type === 'swatch'))
}

/**
 * Skip a node unless something it draws from changed: the node object itself,
 * the asset store when it shows an image, the swatches when a paint names one.
 * A new paint layer committed to the asset store re-renders no shapes.
 */
function sameNode(a: NodeProps, b: NodeProps): boolean {
  return a.o === b.o && (a.assets === b.assets || !readsAssets(b.o)) && (a.swatches === b.swatches || !readsSwatches(b.o))
}

/** One node. Memoised: an unchanged node (same object) does no work at all. */
export const NodeView = memo(function NodeView({ o, assets, swatches }: NodeProps): JSX.Element | null {
  // Hidden, or something a newer PlexiiDraw made that this build cannot draw.
  if (o.hidden || o.type === 'opaque') return null
  const sw = { swatches }
  const style: React.CSSProperties = {}
  if (o.opacity != null && o.opacity < 1) style.opacity = o.opacity
  if (o.blend && o.blend !== 'normal') style.mixBlendMode = o.blend as never

  if (o.type === 'group') {
    // The same parts the exporter writes (ops/masks clipGroupParts): the clip
    // path defines the mask, its own fill (if any) goes under the contents and
    // its own stroke (if any) over them, unclipped.
    const parts = clipGroupParts(o)
    const cid = clipId(o.id)
    const clipD = parts.clip && parts.clip.type === 'path' ? pathToSvgD(parts.clip.path) : ''
    const clip = !parts.clip ? null : parts.clip.type === 'path' ? (
      clipD ? (
        <clipPath id={cid}>
          <path d={clipD} clipRule={parts.clip.path.fillRule === 'evenodd' ? 'evenodd' : undefined} />
        </clipPath>
      ) : null
    ) : (
      <clipPath id={cid}>
        <NodeView o={clipSilhouette(parts.clip)} assets={assets} swatches={swatches} />
      </clipPath>
    )
    const shown = clip ? [...(parts.under ? [parts.under] : []), ...parts.contents] : o.children
    const inner = shown.map((c) => <NodeView key={c === parts.under ? `${c.id}:under` : c.id} o={c} assets={assets} swatches={swatches} />)
    if (clip && parts.over) {
      return (
        <>
          {clip}
          <g transform={matrixAttr(o.transform)} style={style}>
            <g clipPath={`url(#${cid})`}>{inner}</g>
            <NodeView key={`${parts.over.id}:over`} o={parts.over} assets={assets} swatches={swatches} />
          </g>
        </>
      )
    }
    return (
      <>
        {clip}
        <g transform={matrixAttr(o.transform)} clipPath={clip ? `url(#${cid})` : undefined} style={style}>
          {inner}
        </g>
      </>
    )
  }

  if (o.type === 'path') {
    const d = pathToSvgD(o.path)
    const rule = o.path.fillRule === 'evenodd' ? 'evenodd' : undefined
    if (o.appearance) {
      return (
        <g style={style}>
          {o.appearance.fills.map((f, i) => {
            if (f.enabled === false) return null
            const p = svgDocPaint(sw, f.paint, `${o.id}-f${i}`)
            return <path key={`f${i}`} d={d} fill={p.value} fillOpacity={p.opacity} fillRule={rule} style={f.opacity != null && f.opacity < 1 ? { opacity: f.opacity } : undefined} />
          })}
          {o.appearance.strokes.map((s, i) => {
            if (s.enabled === false) return null
            const p = svgDocPaint(sw, s.stroke.paint, `${o.id}-k${i}-s`)
            return (
              <path
                key={`k${i}`}
                d={d}
                fill="none"
                stroke={p.value}
                strokeWidth={s.stroke.width}
                strokeOpacity={p.opacity}
                strokeLinecap={s.stroke.cap}
                strokeLinejoin={s.stroke.join}
                strokeDasharray={s.stroke.dash && s.stroke.dash.length ? s.stroke.dash.join(' ') : undefined}
                strokeMiterlimit={s.stroke.miterLimit}
                style={s.opacity != null && s.opacity < 1 ? { opacity: s.opacity } : undefined}
              />
            )
          })}
        </g>
      )
    }
    const f = svgDocPaint(sw, o.fill, o.id)
    const s = o.stroke ? svgDocPaint(sw, o.stroke.paint, `${o.id}-s`) : null
    return (
      <path
        d={d}
        fill={f.value}
        fillOpacity={f.opacity}
        fillRule={rule}
        stroke={s?.value}
        strokeWidth={o.stroke?.width}
        strokeOpacity={s?.opacity}
        strokeLinecap={o.stroke?.cap}
        strokeLinejoin={o.stroke?.join}
        strokeDasharray={o.stroke?.dash && o.stroke.dash.length ? o.stroke.dash.join(' ') : undefined}
        // The exporter writes stroke-miterlimit; the screen draws the same corners.
        strokeMiterlimit={o.stroke?.miterLimit}
        style={style}
      />
    )
  }

  if (o.type === 'image') {
    // Embedded image bytes only -- a body that skipped normalisation still
    // never makes the viewer fetch a remote address.
    const src = assetSrc(assets, o.assetId)
    if (!src || !isDrawImageSrc(src)) return null
    return (
      <image
        href={src}
        x={o.x}
        y={o.y}
        width={o.w}
        height={o.h}
        preserveAspectRatio="none"
        transform={frameTransform(o.transform, o.rotation, o.x + o.w / 2, o.y + o.h / 2)}
        style={style}
      />
    )
  }

  if (o.type === 'widget') {
    // A live work widget: the real component in a foreignObject, resolved
    // from its id every render, so it never holds a stale copy.
    return (
      <foreignObject x={o.x} y={o.y} width={o.w} height={o.h} transform={frameTransform(o.transform, o.rotation, o.x + o.w / 2, o.y + o.h / 2)} style={style}>
        {/* The vector layer ignores the pointer (the stage hit-tests by
            position), which left an embedded widget unusable: a stroke on an
            embedded scratchpad selected and moved the object. Its content
            takes the pointer; the stage moves it from its grip. */}
        <div style={{ width: '100%', height: '100%', pointerEvents: 'auto' }}>
          <PlacedWidgetEmbed placementId={o.id} widgetId={o.widgetId} display={o.embedDisplay} />
        </div>
      </foreignObject>
    )
  }

  // text
  const f = svgDocPaint(sw, o.fill, o.id)
  const s = o.stroke ? svgDocPaint(sw, o.stroke.paint, `${o.id}-s`) : null
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
      strokeOpacity={s?.opacity}
      // Text strokes carry the same styling the exporter writes for them.
      strokeLinecap={o.stroke?.cap}
      strokeLinejoin={o.stroke?.join}
      strokeDasharray={o.stroke?.dash && o.stroke.dash.length ? o.stroke.dash.join(' ') : undefined}
      strokeMiterlimit={o.stroke?.miterLimit}
      transform={frameTransform(o.transform, o.rotation, o.x + o.w / 2, o.y)}
      style={style}
    >
      {lines.map((l, i) => (
        <tspan key={i} x={ax} y={o.y + o.fontSize + i * lh}>
          {l || ' '}
        </tspan>
      ))}
    </text>
  )
}, sameNode)

interface LayerProps {
  layer: DrawDocVectorLayer
  /** The document rectangle this layer's SVG shows (the pasteboard window the canvas draws, 4.3.41). */
  board: Pick<DrawArtboard, 'x' | 'y' | 'w' | 'h'>
  stageW: number
  stageH: number
  assets: Record<string, DrawAsset>
  swatches: DrawSwatch[]
  /** The object currently being typed into, hidden so its text is not drawn twice. */
  hiddenId?: string | null
  /** Where the SVG sits on the stage, in screen px (absent: the stage's top-left). */
  at?: { left: number; top: number }
}

/**
 * One vector layer. Gradients are collected HERE, before any shape renders,
 * and drawn as React elements (an earlier version pushed markup into a shared
 * array from the children, which render after their parent returns, so the
 * defs were always empty). Memoised on the layer's identity.
 */
export const VectorLayerView = memo(function VectorLayerView({ layer, board, stageW, stageH, assets, swatches, hiddenId, at }: LayerProps): JSX.Element {
  const visible = layer.objects.filter((o) => o.id !== hiddenId)
  const sw = { swatches }
  const gradients = visible.flatMap((o) => nodeGradients(o, sw))
  return (
    <svg
      width={stageW}
      height={stageH}
      viewBox={`${board.x} ${board.y} ${board.w} ${board.h}`}
      data-testid={`draw-vector-${layer.id}`}
      className="absolute left-0 top-0 pointer-events-none"
      style={{ ...(at ? { left: at.left, top: at.top } : {}), opacity: layer.template ? 0.5 * layer.opacity : layer.opacity, mixBlendMode: layer.blend as never }}
    >
      <defs>
        {gradients.map((g, i) => (
          // Index as well as id: a duplicate id in a document from elsewhere
          // must not make React drop or reorder a definition.
          <GradientView key={`${i}:${g.id}`} g={g} />
        ))}
      </defs>
      {visible.map((o) => (
        <NodeView key={o.id} o={o} assets={assets} swatches={swatches} />
      ))}
    </svg>
  )
})
