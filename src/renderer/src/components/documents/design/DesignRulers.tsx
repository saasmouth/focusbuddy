import { useRef } from 'react'

// Rulers down the top and left edge of the page, in logical px, with the one
// interaction that matters: drag off a ruler to pull out a guide, exactly as in
// Publisher and InDesign. Ticks thin out automatically as you zoom out so the
// ruler never turns into a solid bar.

interface Props {
  width: number
  height: number
  /** On-screen px per logical px. */
  scale: number
  /** Ruler thickness in screen px. */
  size?: number
  onAddGuide: (axis: 'v' | 'h', at: number) => void
  children: React.ReactNode
}

/** A tick spacing that stays roughly 60–120 screen px apart at any zoom. */
function tickStep(scale: number): number {
  const target = 80 / Math.max(scale, 0.001)
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]
  return steps.find((s) => s >= target) ?? steps[steps.length - 1]
}

export default function DesignRulers({ width, height, scale, size = 18, onAddGuide, children }: Props): JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const step = tickStep(scale)
  const minor = step / (step % 2 === 0 ? 2 : 5)

  function beginDrag(axis: 'v' | 'h'): (e: React.MouseEvent) => void {
    return (e) => {
      e.preventDefault()
      const wrap = wrapRef.current
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      function commit(ev: MouseEvent): void {
        const at = axis === 'v' ? (ev.clientX - rect.left - size) / scale : (ev.clientY - rect.top - size) / scale
        const clamped = Math.round(Math.max(0, Math.min(axis === 'v' ? width : height, at)))
        onAddGuide(axis, clamped)
      }
      function onUp(ev: MouseEvent): void {
        commit(ev)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mouseup', onUp)
    }
  }

  const ticks = (axis: 'v' | 'h'): JSX.Element[] => {
    const span = axis === 'v' ? width : height
    const out: JSX.Element[] = []
    for (let at = 0; at <= span; at += minor) {
      const major = Math.abs(at % step) < 0.001
      const px = at * scale
      out.push(
        <div
          key={at}
          style={{
            position: 'absolute',
            background: 'var(--ink-30)',
            ...(axis === 'v'
              ? { left: px, top: major ? size * 0.35 : size * 0.6, width: 1, bottom: 0 }
              : { top: px, left: major ? size * 0.35 : size * 0.6, height: 1, right: 0 })
          }}
        />
      )
      if (major && at > 0) {
        out.push(
          <div
            key={`l${at}`}
            style={{
              position: 'absolute',
              fontSize: 8,
              lineHeight: '8px',
              color: 'var(--ink-40)',
              ...(axis === 'v' ? { left: px + 2, top: 2 } : { top: px + 2, left: 1, width: size - 2, textAlign: 'center' })
            }}
          >
            {at}
          </div>
        )
      }
    }
    return out
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', paddingLeft: size, paddingTop: size }} data-testid="design-rulers">
      {/* Corner */}
      <div
        style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, background: 'var(--surface-sunken)', borderRight: '1px solid var(--edge-soft)', borderBottom: '1px solid var(--edge-soft)' }}
        title="Drag from a ruler to add a guide"
      />
      {/* Horizontal ruler */}
      <div
        onMouseDown={beginDrag('v')}
        data-testid="design-ruler-top"
        title="Drag down to add a vertical guide"
        style={{
          position: 'absolute',
          left: size,
          top: 0,
          height: size,
          width: width * scale,
          background: 'var(--surface-sunken)',
          borderBottom: '1px solid var(--edge-soft)',
          cursor: 'col-resize',
          overflow: 'hidden'
        }}
      >
        {ticks('v')}
      </div>
      {/* Vertical ruler */}
      <div
        onMouseDown={beginDrag('h')}
        data-testid="design-ruler-left"
        title="Drag right to add a horizontal guide"
        style={{
          position: 'absolute',
          left: 0,
          top: size,
          width: size,
          height: height * scale,
          background: 'var(--surface-sunken)',
          borderRight: '1px solid var(--edge-soft)',
          cursor: 'row-resize',
          overflow: 'hidden'
        }}
      >
        {ticks('h')}
      </div>
      {children}
    </div>
  )
}
