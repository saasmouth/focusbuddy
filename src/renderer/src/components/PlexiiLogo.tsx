// The Plexii brand wordmark (Brand Motion mission, 2026-08-23). Formerly two
// fixed-colour PNGs; now the kit's vector wordmark via PlexiiMark, so it takes
// the approved purple ii and theme-aware letterforms (navy on light, white on
// dark), blinks once on mount, and winks on hover — never looping at rest.
// The old `variant` API survives for fixed-background surfaces: 'navy' pins
// the light-surface letterforms, 'white' the reversed (dark-surface) ones;
// 'auto' follows the theme.
import PlexiiMark from './brand/PlexiiMark'

// The approved purple logo (Brand/Plexii-Purple-Logo): the ii is always its
// purple gradient; only the letterforms change with the background.
const FIXED = {
  navy: { letterColor: '#061C46' },
  white: { letterColor: '#FFFFFF' }
} as const

export default function PlexiiLogo({
  height = 20,
  className = '',
  variant = 'auto'
}: {
  // Rendered height in px; width scales to the wordmark's aspect ratio.
  height?: number
  className?: string
  variant?: 'auto' | 'navy' | 'white'
}): JSX.Element {
  const fixed = variant === 'auto' ? undefined : FIXED[variant]
  return (
    <PlexiiMark
      wordmark
      height={height}
      className={className}
      motion="once+hover"
      {...(fixed ?? {})}
    />
  )
}
