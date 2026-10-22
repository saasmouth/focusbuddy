// The one way to render the Plexii brand mark in the app (Brand Motion
// mission, 2026-08-23). Wraps the generated kit component (./PlexiLogo, the
// double-i mark and the plexii wordmark, animation as pure CSS inside the
// SVG) with two app-level laws:
//
//   Colour is the approved purple logo (owner's icon set, 2026-10-22,
//   marketing/brand-assets Brand/Plexii-Purple-Logo): the ii wears its purple
//   gradient everywhere, the letterforms wear --plexii-logo-ink, navy on light
//   and white on dark (the reversed logo). This replaces the earlier ruling
//   that the ii followed the theme accent. Explicit colour props still
//   override for fixed-background surfaces.
//
//   Motion is earned, never ambient: static at rest, one blink cycle on
//   mount, whole cycles while hovered, freeze only on a cycle boundary
//   (frame 0 and the final frame ARE the static logo, so the settle is
//   invisible). Policy lives in ./brandMotion as a pure machine; this file
//   only wires it to pointer events and one timer.
//
// The AI's thinking indicator (PlexiiThinking) is a different dialect of the
// same mark — breathe = thinking, blink = alive. Never run both on one
// surface at once: hosts that show PlexiiThinking render this mark with
// motion="off" while work is in flight.
import { useEffect, useRef, useState } from 'react'
import { PlexiMark, PlexiWordmark, PLEXII_II_GRADIENT } from './PlexiLogo'
import {
  type BrandMotionMode,
  type BrandMotionState,
  type Next,
  cycleEnd,
  initial,
  pointerEnter,
  pointerLeave
} from './brandMotion'

interface Props {
  /** Icon (the double-i) or the full plexii wordmark. */
  wordmark?: boolean
  /** Rendered height in px; width follows the artwork's aspect ratio. */
  height?: number
  /** See brandMotion. Default: one blink on mount, replay on hover. */
  motion?: BrandMotionMode
  /** A flat ii colour (fixed-background surfaces, e.g. white on a purple disc).
   *  Omitted: the approved logo's purple gradient. */
  color?: string
  /** The letterforms (wordmark only). Defaults to the approved logo's ink:
   *  navy on light, white (the reversed logo) on dark. */
  letterColor?: string
  /** Kept for callers; the approved purple gradient is now the default ii. */
  gradient?: boolean
  className?: string
  /** Accessible name; null marks the mark decorative. */
  title?: string | null
}

export default function PlexiiMark({
  wordmark = false,
  height = 20,
  motion = 'once+hover',
  color,
  letterColor = 'var(--plexii-logo-ink)',
  className = '',
  title = 'Plexii'
}: Props): JSX.Element {
  const [animating, setAnimating] = useState(() => initial(motion).state.animating)
  const machine = useRef<BrandMotionState>({ animating, hovered: false })
  const modeRef = useRef(motion)
  modeRef.current = motion
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const apply = (next: Next): void => {
    machine.current = next.state
    setAnimating(next.state.animating)
    if (next.timerMs !== null) {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => apply(cycleEnd(machine.current, modeRef.current)), next.timerMs)
    }
  }

  useEffect(() => {
    apply(initial(motion))
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply is stable in spirit; re-init only on mode change
  }, [motion])

  const hoverable = motion === 'hover' || motion === 'once+hover'
  const svgStyle = {
    height,
    width: 'auto' as const,
    aspectRatio: wordmark ? '1952.9 / 812' : '1 / 1'
  }

  return (
    // The mark carries the product name as its accessible name. Both the SVGs
    // below are pure artwork with no text node and no <title>, so without this
    // the wordmark standing in for a heading — which is what it does in the
    // assistant header and the desk sidebar — announced nothing at all, and
    // the name "Plexii" was absent from the accessibility tree on every
    // surface that wears it.
    <span
      role="img"
      aria-label="Plexii"
      className={`inline-flex items-center select-none ${className}`}
      onPointerEnter={hoverable ? () => apply(pointerEnter(machine.current, modeRef.current)) : undefined}
      onPointerLeave={hoverable ? () => apply(pointerLeave(machine.current, modeRef.current)) : undefined}
    >
      {wordmark ? (
        <PlexiWordmark
          animated={animating}
          variant="flat"
          color={color}
          iiGradient={color ? undefined : PLEXII_II_GRADIENT}
          letterColor={letterColor}
          title={title}
          style={svgStyle}
        />
      ) : (
        <PlexiMark animated={animating} color={color} iiGradient={color ? undefined : PLEXII_II_GRADIENT} title={title} style={svgStyle} />
      )}
    </span>
  )
}
