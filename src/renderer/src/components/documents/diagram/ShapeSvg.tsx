import type { ShapeGeometry } from '@shared/diagram/shapes'
import { getShape } from '@shared/diagram/shapes'
import { dashArray, type ResolvedNodeStyle } from '@shared/diagram/style'

// Draws a registry shape's paths as SVG at a given size and resolved style. The
// canvas node, the palette thumbnails and the drag preview all use this, so a
// shape looks identical everywhere (the export draws the same geometry).

export function ShapePaths({
  geometry,
  style,
  w,
  h,
  flipX,
  flipY
}: {
  geometry: ShapeGeometry
  style: ResolvedNodeStyle
  w: number
  h: number
  flipX?: boolean
  flipY?: boolean
}): JSX.Element {
  const sw = style.strokeDash === 'none' ? 0 : style.strokeWidth
  const dash = dashArray(style.strokeDash, sw)
  const transform =
    flipX || flipY ? `translate(${flipX ? w : 0} ${flipY ? h : 0}) scale(${flipX ? -1 : 1} ${flipY ? -1 : 1})` : undefined
  const fill = style.fill === 'none' ? 'none' : style.fill
  const stroke = sw > 0 && style.stroke !== 'none' ? style.stroke : 'none'
  const ink = style.stroke === 'none' ? style.textColor : style.stroke
  return (
    <g transform={transform} filter={style.shadow ? 'drop-shadow(0 3px 4px rgba(0,0,0,0.22))' : undefined}>
      {geometry.parts.map((p, i) => {
        switch (p.paint) {
          case 'fill':
            return (
              <path
                key={i}
                d={p.d}
                fill={fill}
                fillOpacity={fill === 'none' ? undefined : style.fillOpacity}
                stroke={stroke}
                strokeWidth={sw}
                strokeDasharray={dash}
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )
          case 'stroke':
            return (
              <path
                key={i}
                d={p.d}
                fill="none"
                stroke={ink}
                strokeWidth={Math.max(1, sw * 0.75)}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )
          case 'shade':
            return <path key={i} d={p.d} fill={ink} fillOpacity={0.16} stroke="none" />
          case 'solid':
            return <path key={i} d={p.d} fill={ink} stroke="none" />
          default:
            return <path key={i} d={p.d} fill="transparent" stroke="none" />
        }
      })}
    </g>
  )
}

// Full-size shape positioned to cover its node box (strokes may overhang).
export function ShapeSvg({
  shape,
  w,
  h,
  style,
  geometry,
  flipX,
  flipY
}: {
  shape: string
  w: number
  h: number
  style: ResolvedNodeStyle
  geometry?: ShapeGeometry
  flipX?: boolean
  flipY?: boolean
}): JSX.Element {
  const g = geometry ?? getShape(shape).draw(w, h)
  const pad = Math.ceil((style.strokeWidth || 0) / 2) + 6
  return (
    <svg
      width={w + pad * 2}
      height={h + pad * 2}
      viewBox={`${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`}
      style={{ position: 'absolute', left: -pad, top: -pad, overflow: 'visible', opacity: style.opacity, pointerEvents: 'none' }}
      aria-hidden
    >
      <ShapePaths geometry={g} style={style} w={w} h={h} flipX={flipX} flipY={flipY} />
    </svg>
  )
}

// A small palette preview: the shape's default geometry scaled into a box.
export function ShapeThumb({ shape, size = 34, style }: { shape: string; size?: number; style: ResolvedNodeStyle }): JSX.Element {
  const def = getShape(shape)
  const k = Math.min(size / def.w, (size * 0.82) / def.h)
  const w = Math.max(10, def.w * k)
  const h = Math.max(10, def.h * k)
  const pad = 2
  return (
    <svg width={w + pad * 2} height={h + pad * 2} viewBox={`${-pad / k} ${-pad / k} ${def.w + (pad * 2) / k} ${def.h + (pad * 2) / k}`} aria-hidden>
      <ShapePaths geometry={def.draw(def.w, def.h)} style={{ ...style, strokeWidth: 1.4, shadow: false }} w={def.w} h={def.h} />
    </svg>
  )
}
