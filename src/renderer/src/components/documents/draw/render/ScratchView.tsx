import { useEffect, useRef } from 'react'

/**
 * Shows the live, uncommitted brush stroke. The scratch canvas element is
 * adopted directly rather than copied, so what you see mid-stroke is exactly
 * the pixels that will be composited when you lift the pointer.
 */
export default function ScratchView({ canvas, stageW, stageH, opacity, blend }: { canvas: HTMLCanvasElement; stageW: number; stageH: number; opacity: number; blend: string }): JSX.Element {
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
