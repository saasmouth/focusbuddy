// Pure renderer for a single slide element, positioned in 1280x720 logical
// units. It is wrapped by SlideFace inside a stage that is CSS-scaled, so this
// component always works in logical pixels and renders identically at thumbnail,
// editor, present and export sizes.

import type { SlideElement, SlideTextElement } from '@shared/types'
import { fillToCss } from '@shared/fills'
import { cropStyle } from './slideOps'
import WidgetEmbed from '../embed/WidgetEmbed'
import PlexiChart from '../../charts/PlexiChart'

// Drop-shadow presets, soft enough to read as depth rather than a hard edge.
const SHADOW: Record<NonNullable<SlideElement['shadow']>, string> = {
  sm: '0 1px 3px rgba(0,0,0,0.18)',
  md: '0 6px 16px rgba(0,0,0,0.22)',
  lg: '0 14px 38px rgba(0,0,0,0.28)'
}

// The shared frame (rounded corners + drop shadow) any element can carry.
function frame(el: SlideElement): React.CSSProperties {
  return {
    borderRadius: el.cornerRadius ? el.cornerRadius : undefined,
    boxShadow: el.shadow ? SHADOW[el.shadow] : undefined
  }
}

function borderCss(b?: { width: number; style?: string; color: string }): string | undefined {
  return b ? `${b.width}px ${b.style ?? 'solid'} ${b.color}` : undefined
}

function TextContent({ el }: { el: SlideTextElement }): JSX.Element {
  // A PlexiDesign threaded frame shows the lines the flow engine measured and
  // placed for it. Rendering the engine's own output — rather than re-wrapping
  // here — is what guarantees the exported page breaks exactly where the screen
  // did. An unthreaded text element takes the paragraph path below, unchanged.
  if (el.flowLines && el.flowLines.length) {
    return (
      <div style={{ position: 'relative', height: '100%' }}>
        {el.flowLines.map((ln, i) => {
          const justified = ln.align === 'justify' && !ln.lastOfPara
          return (
            <div key={i}>
              {ln.rule && (
                <div
                  style={{
                    position: 'absolute',
                    left: ln.x,
                    top: ln.y - ln.size * 0.55,
                    width: ln.w * ln.rule.width,
                    height: ln.rule.thickness,
                    background: ln.rule.color
                  }}
                />
              )}
              {ln.bullet && (
                <div
                  style={{
                    position: 'absolute',
                    left: ln.x - ln.size * 1.4,
                    top: ln.y,
                    width: ln.size * 1.15,
                    textAlign: 'right',
                    lineHeight: `${ln.lh}px`,
                    fontSize: ln.size,
                    fontFamily: ln.family,
                    color: ln.color
                  }}
                >
                  {ln.bullet}
                </div>
              )}
              {ln.dropCap && (
                <div
                  style={{
                    position: 'absolute',
                    left: ln.x - ln.dropCap.width - ln.size * 0.12,
                    top: ln.y,
                    fontSize: ln.dropCap.size,
                    lineHeight: `${ln.dropCap.size}px`,
                    fontFamily: ln.family,
                    fontWeight: 700,
                    color: ln.color
                  }}
                >
                  {ln.dropCap.text}
                </div>
              )}
              <div
                style={{
                  position: 'absolute',
                  left: ln.x,
                  top: ln.y,
                  width: ln.w,
                  lineHeight: `${ln.lh}px`,
                  fontSize: ln.size,
                  fontFamily: ln.family,
                  fontWeight: ln.bold ? 700 : undefined,
                  fontStyle: ln.italic ? 'italic' : undefined,
                  color: ln.color,
                  letterSpacing: ln.letterSpacing,
                  whiteSpace: 'pre',
                  textAlign: justified ? 'justify' : ln.align === 'justify' ? 'left' : ln.align,
                  textAlignLast: justified ? 'justify' : undefined
                }}
              >
                {ln.text || '\u200b'}
              </div>
            </div>
          )
        })}
      </div>
    )
  }
  const justify = el.vAlign === 'middle' ? 'center' : el.vAlign === 'bottom' ? 'flex-end' : 'flex-start'
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', justifyContent: justify, height: '100%', fontFamily: el.fontFamily }}
    >
      {el.paragraphs.map((p, i) => (
        <div
          key={i}
          style={{
            textAlign: p.align ?? 'left',
            display: 'flex',
            gap: 8,
            justifyContent: p.align === 'center' ? 'center' : p.align === 'right' ? 'flex-end' : 'flex-start'
          }}
        >
          {p.listStyle === 'bullet' && <span style={{ opacity: 0.7 }}>•</span>}
          {p.listStyle === 'number' && <span style={{ opacity: 0.7 }}>{i + 1}.</span>}
          <span>
            {p.runs.map((r, j) => (
              <span
                key={j}
                style={{
                  fontWeight: r.bold ? 700 : undefined,
                  fontStyle: r.italic ? 'italic' : undefined,
                  textDecoration: r.underline ? 'underline' : undefined,
                  color: r.color,
                  fontSize: r.fontSize
                }}
              >
                {r.text || '​'}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function SlideElementView({ el, transitionMs }: { el: SlideElement; transitionMs?: number }): JSX.Element {
  const base: React.CSSProperties = {
    position: 'absolute',
    left: el.x,
    top: el.y,
    width: el.w,
    height: el.h,
    transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
    opacity: el.opacity != null ? el.opacity : undefined,
    overflow: 'hidden',
    // Morph tween: animate geometry/opacity changes between two slides.
    ...(transitionMs ? { transition: `left ${transitionMs}ms, top ${transitionMs}ms, width ${transitionMs}ms, height ${transitionMs}ms, opacity ${transitionMs}ms, transform ${transitionMs}ms` } : {})
  }

  if (el.type === 'text') {
    return (
      <div
        style={{
          ...base,
          ...frame(el),
          background: fillToCss(el.fill),
          border: borderCss(el.border)
        }}
      >
        <TextContent el={el} />
      </div>
    )
  }
  if (el.type === 'image') {
    const c = el.crop
    // A cropped image is drawn as a background so the chosen window fills the
    // frame; an uncropped one keeps the plain <img> with its object-fit.
    if (c && (c.l > 0 || c.t > 0 || c.r > 0 || c.b > 0)) {
      const cs = cropStyle(c)
      return (
        <div
          data-cropped="1"
          style={{
            ...base,
            ...frame(el),
            border: borderCss(el.border),
            backgroundImage: `url(${el.src})`,
            backgroundRepeat: 'no-repeat',
            backgroundSize: cs.size,
            backgroundPosition: cs.position
          }}
        />
      )
    }
    return (
      <div style={{ ...base, ...frame(el), border: borderCss(el.border) }}>
        <img src={el.src} alt="" style={{ width: '100%', height: '100%', objectFit: el.fit ?? 'contain' }} />
      </div>
    )
  }
  if (el.type === 'shape') {
    // An explicit cornerRadius overrides the shape's default rounding.
    const radius = el.shape === 'ellipse' ? '50%' : el.cornerRadius ?? (el.shape === 'roundRect' ? 16 : 0)
    if (el.shape === 'triangle') {
      return (
        <div style={{ ...base, filter: el.shadow ? `drop-shadow(${SHADOW[el.shadow]})` : undefined }}>
          <div
            style={{
              width: '100%',
              height: '100%',
              clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)',
              background: fillToCss(el.fill) ?? 'transparent'
            }}
          />
        </div>
      )
    }
    return (
      <div
        style={{
          ...base,
          background: fillToCss(el.fill) ?? 'transparent',
          borderRadius: radius,
          boxShadow: el.shadow ? SHADOW[el.shadow] : undefined,
          border: borderCss(el.border)
        }}
      />
    )
  }
  if (el.type === 'widget') {
    // A live desk-widget embed. WidgetEmbed resolves the widget itself and
    // renders honest loading / missing states, so nothing is faked here.
    return (
      <div style={{ ...base, ...frame(el) }}>
        <WidgetEmbed widgetId={el.widgetId} />
      </div>
    )
  }
  if (el.type === 'table') {
    const fs = el.fontSize ?? 16
    const accent = el.accent ?? '#e2e8f0'
    return (
      <div style={{ ...base, ...frame(el) }}>
        <table style={{ width: '100%', height: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: fs }}>
          <tbody>
            {el.cells.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => {
                  const isHeader = el.headerRow && r === 0
                  return (
                    <td
                      key={c}
                      style={{
                        border: `1px solid ${accent}`,
                        padding: '4px 8px',
                        fontWeight: isHeader ? 700 : 400,
                        background: isHeader ? accent : 'transparent',
                        verticalAlign: 'middle',
                        overflow: 'hidden'
                      }}
                    >
                      {cell}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  if (el.type === 'chart') {
    // Rendered through the shared chart core from the element's data snapshot.
    return (
      <div style={{ ...base, ...frame(el), background: '#fff', padding: 8 }}>
        {el.chart.title && (
          <div style={{ fontSize: 15, fontWeight: 600, color: '#1c1917', marginBottom: 4, textAlign: 'center' }}>
            {el.chart.title}
          </div>
        )}
        <div style={{ width: '100%', height: el.chart.title ? el.h - 40 : el.h - 16 }}>
          <PlexiChart chart={el.chart} height={(el.chart.title ? el.h - 40 : el.h - 16)} />
        </div>
      </div>
    )
  }
  // line: drawn as the diagonal of its box (top-left to bottom-right)
  return (
    <div style={base}>
      <svg width="100%" height="100%" viewBox={`0 0 ${el.w} ${el.h}`} preserveAspectRatio="none">
        {el.arrowEnd && (
          <defs>
            <marker id={`arrow-${el.id}`} markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
              <path d="M0,0 L0,6 L9,3 z" fill={el.stroke} />
            </marker>
          </defs>
        )}
        <line
          x1={0}
          y1={0}
          x2={el.w}
          y2={el.h}
          stroke={el.stroke}
          strokeWidth={el.strokeWidth}
          markerEnd={el.arrowEnd ? `url(#arrow-${el.id})` : undefined}
        />
      </svg>
    </div>
  )
}
