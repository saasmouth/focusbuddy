/**
 * Plexii animated logo.
 *
 * Zero dependencies, zero client JS - the animation is pure CSS inside the SVG,
 * so these render fine as React Server Components. They also freeze on the
 * neutral logo automatically when the visitor has "reduce motion" enabled.
 *
 *   import { PlexiMark, PlexiWordmark } from "./PlexiLogo"
 *
 *   <PlexiWordmark style={{ width: 260 }} />
 *   <PlexiWordmark color="#FF6B35" letterColor="#111827" />
 *   <PlexiMark animated={false} />          // neutral, no motion
 *   <PlexiWordmark variant="gradient" />    // the approved purple gradient (animated only; prefer iiGradient)
 *
 * Colour: `color` drives the ii, `letterColor` drives the letterforms. Both are
 * plain CSS colours and are applied as custom properties on the root <svg>, so
 * each instance is independent. You can equally set them in your own stylesheet:
 *
 *   .logo { --plexi-mark: #FF6B35; --plexi-wordmark: #111827; }
 *
 * Sizing: the SVG carries a viewBox and no fixed size, so it scales to its
 * container. Give it a width (or a font-size and width: 1em) and the height
 * follows the aspect ratio.
 *
 * Note: each rendered instance carries its own copy of the (identical) keyframe
 * CSS. Harmless, and it keeps the component a single self-contained file.
 *
 * Generated from the source SVGs - edit those and regenerate, not this file.
 */
import { useId, type CSSProperties, type SVGProps } from "react"

type Vars = { "--plexi-mark"?: string; "--plexi-wordmark"?: string }

export type PlexiLogoProps = Omit<SVGProps<SVGSVGElement>, "color"> & {
  /** Colour of the ii. Any CSS colour. */
  color?: string
  /** Colour of the letterforms (wordmark only). */
  letterColor?: string
  /** Render the neutral, non-animating logo. Defaults to true (animated). */
  animated?: boolean
  /** Accessible name. Pass null when the logo is purely decorative. */
  title?: string | null
  /** Top and bottom colours of a vertical gradient across the whole ii (the
   *  approved purple logo). Overrides `color`. */
  iiGradient?: readonly [string, string]
}

/** The approved Plexii logo's ii gradient (Brand/Plexii-Purple-Logo, 2026-10-22). */
export const PLEXII_II_GRADIENT = ["#A38CF3", "#7C66E8"] as const

/** A per-instance gradient spanning the ii (y1..y2 in the artwork's user space). */
function useIiGradient(stops: readonly [string, string] | undefined, y1: number, y2: number) {
  const id = "plexii-ii-" + useId().replace(/[^a-zA-Z0-9_-]/g, "")
  if (!stops) return { fill: undefined, defs: null }
  return {
    fill: `url(#${id})`,
    defs: (
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1={y1} x2="0" y2={y2}>
          <stop offset="0" stopColor={stops[0]} />
          <stop offset="1" stopColor={stops[1]} />
        </linearGradient>
      </defs>
    )
  }
}

function vars(color?: string, letterColor?: string, style?: CSSProperties) {
  const v: Vars = {}
  if (color) v["--plexi-mark"] = color
  if (letterColor) v["--plexi-wordmark"] = letterColor
  return { ...style, ...v } as CSSProperties
}

function a11y(title: string | null | undefined, fallback: string) {
  return title === null
    ? { "aria-hidden": true as const, role: "presentation" }
    : { role: "img" as const, "aria-label": title ?? fallback }
}

const MARK_CSS = `
/* Plexii animated mark. 3.0s seamless loop; frame 0 and the final frame
       are the exact static logo. Geometry is only ever transformed, never
       redrawn. Recolour with --plexi-mark (works when the SVG is inlined in
       the page; when embedded as an image file, bake a colour instead:
       make_svg.py --color "#RRGGBB").
       NB: never put angle-bracket tags in this comment - an HTML parser ends
       the style element early and dumps the stylesheet as visible text. */
    .pm-mark { fill: var(--plexi-mark, #0B64E8); }
    @media (prefers-color-scheme: dark) {
      .pm-mark { fill: var(--plexi-mark, #1477FF); }
    }

    .pm-mark, .pm-eyes, .pm-eyeL, .pm-eyeR, .pm-stemR {
      transform-box: view-box;
      animation-duration: 3.0s;
      animation-iteration-count: infinite;
      animation-timing-function: linear;
    }
    .pm-mark  { transform-origin: 461.0px 882.0px;   animation-name: pmBody;   }
    .pm-stemR { transform-origin: 573.5px 882.0px; animation-name: pmStemR;  }
    .pm-eyes  { transform-origin: 461.0px 239.2368421052631px;    animation-name: pmEyes;   }
    .pm-eyeL  { transform-origin: 348.5px 239.2368421052631px;  animation-name: pmBlinkL; }
    .pm-eyeR  { transform-origin: 573.5px 239.2368421052631px;  animation-name: pmBlinkR; }

  @keyframes pmBody {
    0% { transform: translate(0,0.0px) scale(1.000,1.000); }
    8.8889% { transform: translate(0,0.0px) scale(0.998,1.015); }
    16.6667% { transform: translate(0,0.0px) scale(1.000,1.000); }
    24.4444% { transform: translate(0,0.0px) scale(1.000,1.000); }
    30% { transform: translate(0,0.0px) scale(1.020,0.970); }
    34.4444% { transform: translate(0,0.0px) scale(1.080,0.880); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    36.6667% { transform: translate(0,-30.000000000000004px) scale(0.940,1.120); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    41.1111% { transform: translate(0,-103.3335px) scale(0.970,1.060); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    45.5556% { transform: translate(0,-146.6665px) scale(1.000,1.000); }
    48.8889% { transform: translate(0,-150.0px) scale(1.000,1.000); animation-timing-function: cubic-bezier(0.55, 0.06, 0.86, 0.36); }
    53.3333% { transform: translate(0,-86.6665px) scale(0.970,1.060); animation-timing-function: cubic-bezier(0.55, 0.06, 0.86, 0.36); }
    57.7778% { transform: translate(0,0.0px) scale(1.120,0.840); animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }
    61.1111% { transform: translate(0,0.0px) scale(1.080,0.900); animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }
    64.4444% { transform: translate(0,-10.000000000000002px) scale(0.980,1.040); }
    66.6667% { transform: translate(0,0.0px) scale(1.010,0.990); }
    73.3333% { transform: translate(0,0.0px) scale(1.000,1.000); }
    76.6667% { transform: translate(0,0.0px) scale(1.050,0.930); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    78.8889% { transform: translate(0,-16.666500000000003px) scale(0.970,1.060); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    82.2222% { transform: translate(0,-60.00000000000001px) scale(1.000,1.000); animation-timing-function: cubic-bezier(0.55, 0.06, 0.86, 0.36); }
    85.5556% { transform: translate(0,-13.3335px) scale(0.980,1.040); animation-timing-function: cubic-bezier(0.55, 0.06, 0.86, 0.36); }
    86.6667% { transform: translate(0,0.0px) scale(1.070,0.900); animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }
    90% { transform: translate(0,0.0px) scale(1.020,0.980); }
    94.4444% { transform: translate(0,0.0px) scale(1.000,1.000); }
    100% { transform: translate(0,0.0px) scale(1.000,1.000); }
  }
  @keyframes pmEyes {
    0% { transform: translateY(0.0px); }
    16.6667% { transform: translateY(0.0px); }
    24.4444% { transform: translateY(-15.000000000000002px); }
    30% { transform: translateY(-10.000000000000002px); }
    34.4444% { transform: translateY(0.0px); }
    36.6667% { transform: translateY(20.000000000000004px); }
    42.2222% { transform: translateY(6.6665px); }
    45.5556% { transform: translateY(0.0px); }
    57.7778% { transform: translateY(0.0px); }
    60% { transform: translateY(23.333500000000004px); }
    63.3333% { transform: translateY(-8.3335px); }
    66.6667% { transform: translateY(5.000000000000001px); }
    70% { transform: translateY(0.0px); }
    86.6667% { transform: translateY(0.0px); }
    87.7778% { transform: translateY(11.666500000000001px); }
    91.1111% { transform: translateY(-3.3335000000000004px); }
    94.4444% { transform: translateY(0.0px); }
    100% { transform: translateY(0.0px); }
  }
  @keyframes pmBlinkL {
    0% { transform: scale(1.000,1.000); }
    16.6667% { transform: scale(1.000,1.000); }
    17.7778% { transform: scale(1.020,0.550); }
    18.8889% { transform: scale(1.120,0.120); }
    20% { transform: scale(1.120,0.120); }
    21.1111% { transform: scale(1.080,0.600); }
    22.2222% { transform: scale(0.980,1.060); }
    23.3333% { transform: scale(1.000,1.000); }
    86.6667% { transform: scale(1.000,1.000); }
    87.7778% { transform: scale(1.020,0.550); }
    88.8889% { transform: scale(1.120,0.120); }
    90% { transform: scale(1.120,0.120); }
    91.1111% { transform: scale(1.080,0.600); }
    92.2222% { transform: scale(0.980,1.060); }
    93.3333% { transform: scale(1.000,1.000); }
    100% { transform: scale(1.000,1.000); }
  }
  @keyframes pmBlinkR {
    0% { transform: scale(1.000,1.000); }
    17.7778% { transform: scale(1.000,1.000); }
    18.8889% { transform: scale(1.020,0.550); }
    20% { transform: scale(1.120,0.120); }
    21.1111% { transform: scale(1.120,0.120); }
    22.2222% { transform: scale(1.080,0.600); }
    23.3333% { transform: scale(0.980,1.060); }
    24.4444% { transform: scale(1.000,1.000); }
    87.7778% { transform: scale(1.000,1.000); }
    88.8889% { transform: scale(1.020,0.550); }
    90% { transform: scale(1.120,0.120); }
    91.1111% { transform: scale(1.120,0.120); }
    92.2222% { transform: scale(1.080,0.600); }
    93.3333% { transform: scale(0.980,1.060); }
    94.4444% { transform: scale(1.000,1.000); }
    100% { transform: scale(1.000,1.000); }
  }
  @keyframes pmStemR {
    0% { transform: scaleY(1.000); }
    57.7778% { transform: scaleY(1.000); }
    58.8889% { transform: scaleY(0.960); }
    61.1111% { transform: scaleY(1.020); }
    64.4444% { transform: scaleY(1.000); }
    86.6667% { transform: scaleY(1.000); }
    87.7778% { transform: scaleY(0.975); }
    90% { transform: scaleY(1.010); }
    92.2222% { transform: scaleY(1.000); }
    100% { transform: scaleY(1.000); }
  }

    /* Respect the viewer's motion preference: freeze on the exact logo. */
    @media (prefers-reduced-motion: reduce) {
      .pm-mark, .pm-eyes, .pm-eyeL, .pm-eyeR, .pm-stemR { animation: none; }
    }
`

const WORDMARK_CSS = `
/* Plexii wordmark. 'plex' is vector-traced from the master artwork; the 'ii'
       is the animated mark at the wordmark's own proportions. 3.0s seamless
       loop, opening and closing on the exact static logo.
       Recolour with --plexi-wordmark (letters) and --plexi-mark (the ii).
       NB: no angle-bracket tags in this comment - inlining would end the style
       element early and dump the stylesheet as text. */
    .pw-plex { fill: var(--plexi-wordmark, #08214F); }
    .pw-mark { fill: var(--plexi-mark, #0B64E8); }
    @media (prefers-color-scheme: dark) {
      .pw-mark { fill: var(--plexi-mark, #1477FF); }
    }

    .pw-mark, .pw-eyes, .pw-eyeL, .pw-eyeR, .pw-stemR {
      transform-box: view-box;
      animation-duration: 3.0s;
      animation-iteration-count: infinite;
      animation-timing-function: linear;
    }
    .pw-mark  { transform-origin: 1793.56px 652.11px;  animation-name: pwBody;   }
    .pw-stemR { transform-origin: 1879.06px 652.11px; animation-name: pwStemR;  }
    .pw-eyes  { transform-origin: 1793.56px 164.61px; animation-name: pwEyes;   }
    .pw-eyeL  { transform-origin: 1708.06px 164.61px; animation-name: pwBlinkL; }
    .pw-eyeR  { transform-origin: 1879.06px 164.61px; animation-name: pwBlinkR; }

  @keyframes pwBody {
    0% { transform: translate(0,0.00px) scale(1.0000,1.0000); }
    8.8889% { transform: translate(0,0.00px) scale(0.9984,1.0120); }
    16.6667% { transform: translate(0,0.00px) scale(1.0000,1.0000); }
    24.4444% { transform: translate(0,0.00px) scale(1.0000,1.0000); }
    30% { transform: translate(0,0.00px) scale(1.0160,0.9760); }
    34.4444% { transform: translate(0,0.00px) scale(1.0640,0.9040); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    36.6667% { transform: translate(0,-11.40px) scale(0.9520,1.0960); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    41.1111% { transform: translate(0,-39.27px) scale(0.9760,1.0480); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    45.5556% { transform: translate(0,-55.73px) scale(1.0000,1.0000); }
    48.8889% { transform: translate(0,-57.00px) scale(1.0000,1.0000); animation-timing-function: cubic-bezier(0.55, 0.06, 0.86, 0.36); }
    53.3333% { transform: translate(0,-32.93px) scale(0.9760,1.0480); animation-timing-function: cubic-bezier(0.55, 0.06, 0.86, 0.36); }
    57.7778% { transform: translate(0,0.00px) scale(1.0960,0.8720); animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }
    61.1111% { transform: translate(0,0.00px) scale(1.0640,0.9200); animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }
    64.4444% { transform: translate(0,-3.80px) scale(0.9840,1.0320); }
    66.6667% { transform: translate(0,0.00px) scale(1.0080,0.9920); }
    73.3333% { transform: translate(0,0.00px) scale(1.0000,1.0000); }
    76.6667% { transform: translate(0,0.00px) scale(1.0400,0.9440); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    78.8889% { transform: translate(0,-6.33px) scale(0.9760,1.0480); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    82.2222% { transform: translate(0,-22.80px) scale(1.0000,1.0000); animation-timing-function: cubic-bezier(0.55, 0.06, 0.86, 0.36); }
    85.5556% { transform: translate(0,-5.07px) scale(0.9840,1.0320); animation-timing-function: cubic-bezier(0.55, 0.06, 0.86, 0.36); }
    86.6667% { transform: translate(0,0.00px) scale(1.0560,0.9200); animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }
    90% { transform: translate(0,0.00px) scale(1.0160,0.9840); }
    94.4444% { transform: translate(0,0.00px) scale(1.0000,1.0000); }
    100% { transform: translate(0,0.00px) scale(1.0000,1.0000); }
  }
  @keyframes pwEyes {
    0% { transform: translateY(0.00px); }
    16.6667% { transform: translateY(0.00px); }
    24.4444% { transform: translateY(-11.40px); }
    30% { transform: translateY(-7.60px); }
    34.4444% { transform: translateY(0.00px); }
    36.6667% { transform: translateY(15.20px); }
    42.2222% { transform: translateY(5.07px); }
    45.5556% { transform: translateY(0.00px); }
    57.7778% { transform: translateY(0.00px); }
    60% { transform: translateY(17.73px); }
    63.3333% { transform: translateY(-6.33px); }
    66.6667% { transform: translateY(3.80px); }
    70% { transform: translateY(0.00px); }
    86.6667% { transform: translateY(0.00px); }
    87.7778% { transform: translateY(8.87px); }
    91.1111% { transform: translateY(-2.53px); }
    94.4444% { transform: translateY(0.00px); }
    100% { transform: translateY(0.00px); }
  }
  @keyframes pwBlinkL {
    0% { transform: scale(1.000,1.000); }
    16.6667% { transform: scale(1.000,1.000); }
    17.7778% { transform: scale(1.020,0.550); }
    18.8889% { transform: scale(1.120,0.120); }
    20% { transform: scale(1.120,0.120); }
    21.1111% { transform: scale(1.080,0.600); }
    22.2222% { transform: scale(0.980,1.060); }
    23.3333% { transform: scale(1.000,1.000); }
    86.6667% { transform: scale(1.000,1.000); }
    87.7778% { transform: scale(1.020,0.550); }
    88.8889% { transform: scale(1.120,0.120); }
    90% { transform: scale(1.120,0.120); }
    91.1111% { transform: scale(1.080,0.600); }
    92.2222% { transform: scale(0.980,1.060); }
    93.3333% { transform: scale(1.000,1.000); }
    100% { transform: scale(1.000,1.000); }
  }
  @keyframes pwBlinkR {
    0% { transform: scale(1.000,1.000); }
    17.7778% { transform: scale(1.000,1.000); }
    18.8889% { transform: scale(1.020,0.550); }
    20% { transform: scale(1.120,0.120); }
    21.1111% { transform: scale(1.120,0.120); }
    22.2222% { transform: scale(1.080,0.600); }
    23.3333% { transform: scale(0.980,1.060); }
    24.4444% { transform: scale(1.000,1.000); }
    87.7778% { transform: scale(1.000,1.000); }
    88.8889% { transform: scale(1.020,0.550); }
    90% { transform: scale(1.120,0.120); }
    91.1111% { transform: scale(1.120,0.120); }
    92.2222% { transform: scale(1.080,0.600); }
    93.3333% { transform: scale(0.980,1.060); }
    94.4444% { transform: scale(1.000,1.000); }
    100% { transform: scale(1.000,1.000); }
  }
  @keyframes pwStemR {
    0% { transform: scaleY(1.000); }
    57.7778% { transform: scaleY(1.000); }
    58.8889% { transform: scaleY(0.960); }
    61.1111% { transform: scaleY(1.020); }
    64.4444% { transform: scaleY(1.000); }
    86.6667% { transform: scaleY(1.000); }
    87.7778% { transform: scaleY(0.975); }
    90% { transform: scaleY(1.010); }
    92.2222% { transform: scaleY(1.000); }
    100% { transform: scaleY(1.000); }
  }

    @media (prefers-reduced-motion: reduce) {
      .pw-mark, .pw-eyes, .pw-eyeL, .pw-eyeR, .pw-stemR { animation: none; }
    }
`

const WORDMARK_GRADIENT_CSS = `
/* Plexii wordmark. 'plex' is vector-traced from the master artwork; the 'ii'
       is the animated mark at the wordmark's own proportions. 3.0s seamless
       loop, opening and closing on the exact static logo.
       Recolour with --plexi-wordmark (letters) and --plexi-mark (the ii).
       NB: no angle-bracket tags in this comment - inlining would end the style
       element early and dump the stylesheet as text. */
    .pwg-plex { fill: var(--plexi-wordmark, #08214F); }
    .pwg-mark { fill: url(#plexi-ii-grad-pwg); }

    .pwg-mark, .pwg-eyes, .pwg-eyeL, .pwg-eyeR, .pwg-stemR {
      transform-box: view-box;
      animation-duration: 3.0s;
      animation-iteration-count: infinite;
      animation-timing-function: linear;
    }
    .pwg-mark  { transform-origin: 1793.56px 652.11px;  animation-name: pwgBody;   }
    .pwg-stemR { transform-origin: 1879.06px 652.11px; animation-name: pwgStemR;  }
    .pwg-eyes  { transform-origin: 1793.56px 164.61px; animation-name: pwgEyes;   }
    .pwg-eyeL  { transform-origin: 1708.06px 164.61px; animation-name: pwgBlinkL; }
    .pwg-eyeR  { transform-origin: 1879.06px 164.61px; animation-name: pwgBlinkR; }

  @keyframes pwgBody {
    0% { transform: translate(0,0.00px) scale(1.0000,1.0000); }
    8.8889% { transform: translate(0,0.00px) scale(0.9984,1.0120); }
    16.6667% { transform: translate(0,0.00px) scale(1.0000,1.0000); }
    24.4444% { transform: translate(0,0.00px) scale(1.0000,1.0000); }
    30% { transform: translate(0,0.00px) scale(1.0160,0.9760); }
    34.4444% { transform: translate(0,0.00px) scale(1.0640,0.9040); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    36.6667% { transform: translate(0,-11.40px) scale(0.9520,1.0960); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    41.1111% { transform: translate(0,-39.27px) scale(0.9760,1.0480); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    45.5556% { transform: translate(0,-55.73px) scale(1.0000,1.0000); }
    48.8889% { transform: translate(0,-57.00px) scale(1.0000,1.0000); animation-timing-function: cubic-bezier(0.55, 0.06, 0.86, 0.36); }
    53.3333% { transform: translate(0,-32.93px) scale(0.9760,1.0480); animation-timing-function: cubic-bezier(0.55, 0.06, 0.86, 0.36); }
    57.7778% { transform: translate(0,0.00px) scale(1.0960,0.8720); animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }
    61.1111% { transform: translate(0,0.00px) scale(1.0640,0.9200); animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }
    64.4444% { transform: translate(0,-3.80px) scale(0.9840,1.0320); }
    66.6667% { transform: translate(0,0.00px) scale(1.0080,0.9920); }
    73.3333% { transform: translate(0,0.00px) scale(1.0000,1.0000); }
    76.6667% { transform: translate(0,0.00px) scale(1.0400,0.9440); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    78.8889% { transform: translate(0,-6.33px) scale(0.9760,1.0480); animation-timing-function: cubic-bezier(0.16, 0.84, 0.44, 1); }
    82.2222% { transform: translate(0,-22.80px) scale(1.0000,1.0000); animation-timing-function: cubic-bezier(0.55, 0.06, 0.86, 0.36); }
    85.5556% { transform: translate(0,-5.07px) scale(0.9840,1.0320); animation-timing-function: cubic-bezier(0.55, 0.06, 0.86, 0.36); }
    86.6667% { transform: translate(0,0.00px) scale(1.0560,0.9200); animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }
    90% { transform: translate(0,0.00px) scale(1.0160,0.9840); }
    94.4444% { transform: translate(0,0.00px) scale(1.0000,1.0000); }
    100% { transform: translate(0,0.00px) scale(1.0000,1.0000); }
  }
  @keyframes pwgEyes {
    0% { transform: translateY(0.00px); }
    16.6667% { transform: translateY(0.00px); }
    24.4444% { transform: translateY(-11.40px); }
    30% { transform: translateY(-7.60px); }
    34.4444% { transform: translateY(0.00px); }
    36.6667% { transform: translateY(15.20px); }
    42.2222% { transform: translateY(5.07px); }
    45.5556% { transform: translateY(0.00px); }
    57.7778% { transform: translateY(0.00px); }
    60% { transform: translateY(17.73px); }
    63.3333% { transform: translateY(-6.33px); }
    66.6667% { transform: translateY(3.80px); }
    70% { transform: translateY(0.00px); }
    86.6667% { transform: translateY(0.00px); }
    87.7778% { transform: translateY(8.87px); }
    91.1111% { transform: translateY(-2.53px); }
    94.4444% { transform: translateY(0.00px); }
    100% { transform: translateY(0.00px); }
  }
  @keyframes pwgBlinkL {
    0% { transform: scale(1.000,1.000); }
    16.6667% { transform: scale(1.000,1.000); }
    17.7778% { transform: scale(1.020,0.550); }
    18.8889% { transform: scale(1.120,0.120); }
    20% { transform: scale(1.120,0.120); }
    21.1111% { transform: scale(1.080,0.600); }
    22.2222% { transform: scale(0.980,1.060); }
    23.3333% { transform: scale(1.000,1.000); }
    86.6667% { transform: scale(1.000,1.000); }
    87.7778% { transform: scale(1.020,0.550); }
    88.8889% { transform: scale(1.120,0.120); }
    90% { transform: scale(1.120,0.120); }
    91.1111% { transform: scale(1.080,0.600); }
    92.2222% { transform: scale(0.980,1.060); }
    93.3333% { transform: scale(1.000,1.000); }
    100% { transform: scale(1.000,1.000); }
  }
  @keyframes pwgBlinkR {
    0% { transform: scale(1.000,1.000); }
    17.7778% { transform: scale(1.000,1.000); }
    18.8889% { transform: scale(1.020,0.550); }
    20% { transform: scale(1.120,0.120); }
    21.1111% { transform: scale(1.120,0.120); }
    22.2222% { transform: scale(1.080,0.600); }
    23.3333% { transform: scale(0.980,1.060); }
    24.4444% { transform: scale(1.000,1.000); }
    87.7778% { transform: scale(1.000,1.000); }
    88.8889% { transform: scale(1.020,0.550); }
    90% { transform: scale(1.120,0.120); }
    91.1111% { transform: scale(1.120,0.120); }
    92.2222% { transform: scale(1.080,0.600); }
    93.3333% { transform: scale(0.980,1.060); }
    94.4444% { transform: scale(1.000,1.000); }
    100% { transform: scale(1.000,1.000); }
  }
  @keyframes pwgStemR {
    0% { transform: scaleY(1.000); }
    57.7778% { transform: scaleY(1.000); }
    58.8889% { transform: scaleY(0.960); }
    61.1111% { transform: scaleY(1.020); }
    64.4444% { transform: scaleY(1.000); }
    86.6667% { transform: scaleY(1.000); }
    87.7778% { transform: scaleY(0.975); }
    90% { transform: scaleY(1.010); }
    92.2222% { transform: scaleY(1.000); }
    100% { transform: scaleY(1.000); }
  }

    @media (prefers-reduced-motion: reduce) {
      .pwg-mark, .pwg-eyes, .pwg-eyeL, .pwg-eyeR, .pwg-stemR { animation: none; }
    }
`

/** The standalone double-i mark. */
export function PlexiMark({
  color, letterColor, animated = true, title, style, iiGradient, ...rest
}: PlexiLogoProps) {
  // The ii spans y 189.9 (top of the dots) to 882.0 (foot of the stems).
  const grad = useIiGradient(iiGradient, 189.9, 882.0)
  return (
    <svg
      viewBox="0 0 922 922"
      xmlns="http://www.w3.org/2000/svg"
      style={vars(grad.fill ?? color, letterColor, style)}
      {...a11y(title, "Plexii")}
      {...rest}
    >
      {grad.defs}
      {animated ? (
        <>
          <style dangerouslySetInnerHTML={{ __html: MARK_CSS }} />
          <g className="pm-mark">
              <rect className="pm-stemL" x="298.5" y="381.99999999999994" width="100.0" height="500.00000000000006" rx="50.0"/>
              <rect className="pm-stemR" x="523.5" y="381.99999999999994" width="100.0" height="500.00000000000006" rx="50.0"/>
              <g className="pm-eyes">
                <rect className="pm-eyeL" x="298.5" y="189.8947368421052" width="100.0" height="98.6842105263158" rx="31.830000000000002"/>
                <rect className="pm-eyeR" x="523.5" y="189.8947368421052" width="100.0" height="98.6842105263158" rx="31.830000000000002"/>
              </g>
            </g>
        </>
      ) : (
        <>
        <g fill="var(--plexi-mark, #0B64E8)">
            <rect x="298.5" y="381.99999999999994" width="100.0" height="500.00000000000006" rx="50.0"/>
            <rect x="523.5" y="381.99999999999994" width="100.0" height="500.00000000000006" rx="50.0"/>
            <rect x="298.5" y="189.8947368421052" width="100.0" height="98.6842105263158" rx="31.830000000000002"/>
            <rect x="523.5" y="189.8947368421052" width="100.0" height="98.6842105263158" rx="31.830000000000002"/>
          </g>
        </>
      )}
    </svg>
  )
}

export type PlexiWordmarkProps = PlexiLogoProps & {
  /** "flat" takes `color`; "gradient" is the approved purple ii, animated frames only (iiGradient covers both). */
  variant?: "flat" | "gradient"
}

/** The full plexii wordmark: traced letterforms plus the animated ii. */
export function PlexiWordmark({
  color, letterColor, animated = true, variant = "flat", title, style, iiGradient, ...rest
}: PlexiWordmarkProps) {
  const gradient = variant === "gradient"
  // The ii spans y 127.1 (top of the dots) to 653.1 (foot of the stems).
  const grad = useIiGradient(iiGradient, 127.1, 653.1)
  return (
    <svg
      viewBox="0 0 1952.9 812.0"
      xmlns="http://www.w3.org/2000/svg"
      style={vars(grad.fill ?? color, letterColor, style)}
      {...a11y(title, "Plexii")}
      {...rest}
    >
      {grad.defs}
      {animated ? (
        gradient ? (
          <>
            <style dangerouslySetInnerHTML={{ __html: WORDMARK_GRADIENT_CSS }} />
            <defs>
                <linearGradient id="plexi-ii-grad-pwg" gradientUnits="userSpaceOnUse"
                                x1="0" y1="127.1" x2="0" y2="652.1">
                  <stop offset="0" stopColor="#A38CF3"/>
                  <stop offset="1" stopColor="#7C66E8"/>
                </linearGradient>
              </defs>
              <g className="pwg-plex" fillRule="evenodd">
                  <path d="M207.06,196.43C125.85,201.30,57.52,243.62,34.32,324.59C24.00,360.62,26.96,401.42,26.96,438.84C26.96,477.51,26.96,516.18,26.96,554.85C26.96,593.22,26.96,631.46,26.96,669.82C26.96,689.15,26.96,708.49,26.96,727.83C26.96,748.67,25.53,766.67,46.75,778.44C63.99,788.00,86.24,782.45,96.90,765.78C103.06,756.16,102.97,748.97,102.97,738.02C102.97,728.35,102.97,718.68,102.97,709.01C102.97,699.35,102.97,689.68,102.97,680.01C102.97,675.34,102.97,670.68,102.97,666.01C102.97,663.68,102.96,661.34,102.97,659.01C103.00,655.60,102.00,653.92,104.54,652.07C104.59,652.03,157.46,652.07,162.55,652.07C200.89,652.07,239.23,652.07,277.57,652.07C296.87,652.07,316.32,652.84,335.47,650.10C355.21,647.27,372.71,642.96,391.06,634.98C426.57,619.55,456.01,593.36,474.46,559.18C483.62,542.22,489.76,523.70,493.10,504.75C496.50,485.41,495.97,466.47,495.97,446.93C495.97,427.92,495.97,408.92,495.97,389.92C495.97,369.25,495.39,352.64,490.71,332.38C481.95,294.37,460.85,260.59,429.98,236.47C399.33,212.53,361.59,199.64,323.04,196.95C303.76,195.61,284.38,196.13,265.06,196.13C246.13,196.13,225.83,195.30,207.06,196.43ZM209.06,272.43C160.79,275.65,118.61,298.93,106.50,348.69C101.28,370.17,102.97,395.16,102.97,417.36C102.97,440.68,102.97,464.01,102.97,487.33C102.97,510.33,102.97,533.32,102.97,556.31C102.97,557.92,102.89,573.14,102.97,573.31C104.40,576.17,101.42,573.78,104.63,576.06C104.66,576.09,108.24,576.04,108.62,576.06C111.43,576.25,114.76,576.06,117.62,576.06C129.29,576.06,140.95,576.06,152.61,576.06C198.93,576.06,245.25,576.06,291.57,576.06C316.26,576.06,335.86,575.65,359.12,565.98C380.96,556.89,398.11,541.74,408.82,520.54C420.34,497.71,419.96,478.19,419.96,453.40C419.96,430.07,419.97,406.74,419.96,383.42C419.95,359.17,416.81,338.46,403.10,317.84C390.08,298.24,369.68,284.79,347.38,278.11C324.36,271.22,302.71,272.14,279.03,272.14C267.37,272.14,255.70,272.14,244.04,272.14C232.58,272.14,220.43,271.67,209.06,272.43Z"/>
                  <path d="M556.06,26.51C542.44,28.93,530.85,38.99,526.65,52.19C523.29,62.76,524.72,82.33,524.72,94.00C524.72,122.00,524.72,150.01,524.72,178.01C524.72,233.69,524.72,289.37,524.72,345.05C524.72,400.73,524.72,456.40,524.72,512.08C524.72,540.09,524.72,568.10,524.72,596.10C524.72,610.68,522.95,624.00,532.12,636.53C540.56,648.07,554.95,653.95,569.06,651.65C582.83,649.40,594.27,639.44,598.79,626.32C602.18,616.47,600.72,595.69,600.72,584.53C600.72,556.53,600.72,528.52,600.72,500.52C600.72,444.50,600.72,388.49,600.72,332.48C600.72,276.80,600.72,221.12,600.72,165.45C600.72,137.44,600.72,109.43,600.72,81.43C600.72,66.57,602.73,53.78,593.19,41.08C584.54,29.57,570.20,24.00,556.06,26.51Z"/>
                  <path d="M830.06,196.48C731.46,202.59,659.07,265.43,650.21,365.76C648.28,387.65,649.35,411.59,649.35,433.73C649.35,456.78,648.61,478.68,652.56,501.51C660.45,547.21,683.35,587.06,721.25,614.52C758.58,641.57,803.83,651.91,849.34,652.06C894.67,652.22,940.02,652.07,985.34,652.07C996.68,652.07,1008.01,652.07,1019.34,652.07C1028.78,652.07,1044.62,653.18,1053.23,650.91C1076.72,644.73,1088.31,618.49,1077.47,596.88C1065.06,572.16,1040.45,576.06,1017.48,576.06C994.81,576.06,972.15,576.06,949.48,576.06C926.81,576.06,904.14,576.06,881.48,576.06C859.21,576.06,835.54,577.30,813.71,572.86C791.61,568.36,770.03,559.16,753.99,542.82C745.97,534.64,739.76,525.27,735.20,514.80C734.19,512.48,729.56,500.63,729.64,498.81C729.69,497.54,728.46,496.14,729.23,495.18C729.58,494.74,732.58,495.11,733.20,494.97C734.58,494.66,740.37,494.97,742.20,494.97C787.53,494.97,832.87,494.97,878.20,494.97C900.87,494.97,923.54,494.97,946.20,494.97C967.73,494.97,993.11,496.47,1014.15,493.75C1060.66,487.75,1097.88,452.68,1106.00,406.47C1113.33,364.73,1099.63,311.91,1076.10,277.10C1049.91,238.34,1011.40,213.73,966.48,202.52C943.61,196.82,922.48,196.13,899.05,196.13C876.58,196.13,852.32,195.10,830.06,196.48ZM832.06,272.49C798.14,274.83,766.25,287.11,745.81,315.63C723.95,346.12,725.35,375.82,725.35,411.29C725.35,411.80,725.35,417.29,725.35,417.29C727.63,420.52,726.09,418.28,730.07,418.96C732.86,419.44,739.84,418.96,743.07,418.96C751.40,418.96,759.73,418.96,768.06,418.96C784.72,418.96,801.39,418.96,818.05,418.96C851.37,418.96,884.70,418.96,918.02,418.96C934.68,418.96,951.34,418.96,968.01,418.96C982.44,418.96,1004.66,421.13,1017.09,413.88C1033.57,404.27,1032.87,385.79,1030.71,369.22C1028.46,351.91,1024.18,337.41,1014.89,322.44C997.11,293.79,964.96,276.86,931.97,273.29C915.55,271.51,898.56,272.14,882.03,272.14C865.76,272.14,848.17,271.38,832.06,272.49Z"/>
                  <path d="M1322.23,424.01C1269.73,369.65,1217.23,315.28,1164.72,260.91C1150.14,245.82,1150.56,221.76,1165.66,207.18C1180.76,192.60,1204.81,193.02,1219.39,208.12C1271.28,261.85,1323.17,315.58,1375.06,369.31C1426.95,315.58,1478.83,261.85,1530.72,208.12C1545.30,193.02,1569.36,192.60,1584.45,207.18C1599.55,221.76,1599.97,245.82,1585.39,260.91C1532.89,315.28,1480.39,369.65,1427.88,424.01C1480.39,478.38,1532.89,532.75,1585.39,587.12C1599.97,602.21,1599.55,626.27,1584.45,640.85C1569.36,655.43,1545.30,655.01,1530.72,639.91C1478.83,586.18,1426.95,532.45,1375.06,478.72C1323.17,532.45,1271.28,586.18,1219.39,639.91C1204.81,655.01,1180.76,655.43,1165.66,640.85C1150.56,626.27,1150.14,602.21,1164.72,587.12C1217.23,532.75,1269.73,478.38,1322.23,424.01Z"/>
              </g>
              <g className="pwg-mark">
                <rect x="1670.06" y="273.11" width="76.00" height="380.00" rx="38.00"/>
                <rect className="pwg-stemR" x="1841.06" y="273.11" width="76.00" height="380.00" rx="38.00"/>
                <g className="pwg-eyes">
                  <rect className="pwg-eyeL" x="1670.06" y="127.11" width="76.00" height="75.00" rx="24.19"/>
                  <rect className="pwg-eyeR" x="1841.06" y="127.11" width="76.00" height="75.00" rx="24.19"/>
                </g>
              </g>
          </>
        ) : (
          <>
            <style dangerouslySetInnerHTML={{ __html: WORDMARK_CSS }} />
            <g className="pw-plex" fillRule="evenodd">
                  <path d="M207.06,196.43C125.85,201.30,57.52,243.62,34.32,324.59C24.00,360.62,26.96,401.42,26.96,438.84C26.96,477.51,26.96,516.18,26.96,554.85C26.96,593.22,26.96,631.46,26.96,669.82C26.96,689.15,26.96,708.49,26.96,727.83C26.96,748.67,25.53,766.67,46.75,778.44C63.99,788.00,86.24,782.45,96.90,765.78C103.06,756.16,102.97,748.97,102.97,738.02C102.97,728.35,102.97,718.68,102.97,709.01C102.97,699.35,102.97,689.68,102.97,680.01C102.97,675.34,102.97,670.68,102.97,666.01C102.97,663.68,102.96,661.34,102.97,659.01C103.00,655.60,102.00,653.92,104.54,652.07C104.59,652.03,157.46,652.07,162.55,652.07C200.89,652.07,239.23,652.07,277.57,652.07C296.87,652.07,316.32,652.84,335.47,650.10C355.21,647.27,372.71,642.96,391.06,634.98C426.57,619.55,456.01,593.36,474.46,559.18C483.62,542.22,489.76,523.70,493.10,504.75C496.50,485.41,495.97,466.47,495.97,446.93C495.97,427.92,495.97,408.92,495.97,389.92C495.97,369.25,495.39,352.64,490.71,332.38C481.95,294.37,460.85,260.59,429.98,236.47C399.33,212.53,361.59,199.64,323.04,196.95C303.76,195.61,284.38,196.13,265.06,196.13C246.13,196.13,225.83,195.30,207.06,196.43ZM209.06,272.43C160.79,275.65,118.61,298.93,106.50,348.69C101.28,370.17,102.97,395.16,102.97,417.36C102.97,440.68,102.97,464.01,102.97,487.33C102.97,510.33,102.97,533.32,102.97,556.31C102.97,557.92,102.89,573.14,102.97,573.31C104.40,576.17,101.42,573.78,104.63,576.06C104.66,576.09,108.24,576.04,108.62,576.06C111.43,576.25,114.76,576.06,117.62,576.06C129.29,576.06,140.95,576.06,152.61,576.06C198.93,576.06,245.25,576.06,291.57,576.06C316.26,576.06,335.86,575.65,359.12,565.98C380.96,556.89,398.11,541.74,408.82,520.54C420.34,497.71,419.96,478.19,419.96,453.40C419.96,430.07,419.97,406.74,419.96,383.42C419.95,359.17,416.81,338.46,403.10,317.84C390.08,298.24,369.68,284.79,347.38,278.11C324.36,271.22,302.71,272.14,279.03,272.14C267.37,272.14,255.70,272.14,244.04,272.14C232.58,272.14,220.43,271.67,209.06,272.43Z"/>
                  <path d="M556.06,26.51C542.44,28.93,530.85,38.99,526.65,52.19C523.29,62.76,524.72,82.33,524.72,94.00C524.72,122.00,524.72,150.01,524.72,178.01C524.72,233.69,524.72,289.37,524.72,345.05C524.72,400.73,524.72,456.40,524.72,512.08C524.72,540.09,524.72,568.10,524.72,596.10C524.72,610.68,522.95,624.00,532.12,636.53C540.56,648.07,554.95,653.95,569.06,651.65C582.83,649.40,594.27,639.44,598.79,626.32C602.18,616.47,600.72,595.69,600.72,584.53C600.72,556.53,600.72,528.52,600.72,500.52C600.72,444.50,600.72,388.49,600.72,332.48C600.72,276.80,600.72,221.12,600.72,165.45C600.72,137.44,600.72,109.43,600.72,81.43C600.72,66.57,602.73,53.78,593.19,41.08C584.54,29.57,570.20,24.00,556.06,26.51Z"/>
                  <path d="M830.06,196.48C731.46,202.59,659.07,265.43,650.21,365.76C648.28,387.65,649.35,411.59,649.35,433.73C649.35,456.78,648.61,478.68,652.56,501.51C660.45,547.21,683.35,587.06,721.25,614.52C758.58,641.57,803.83,651.91,849.34,652.06C894.67,652.22,940.02,652.07,985.34,652.07C996.68,652.07,1008.01,652.07,1019.34,652.07C1028.78,652.07,1044.62,653.18,1053.23,650.91C1076.72,644.73,1088.31,618.49,1077.47,596.88C1065.06,572.16,1040.45,576.06,1017.48,576.06C994.81,576.06,972.15,576.06,949.48,576.06C926.81,576.06,904.14,576.06,881.48,576.06C859.21,576.06,835.54,577.30,813.71,572.86C791.61,568.36,770.03,559.16,753.99,542.82C745.97,534.64,739.76,525.27,735.20,514.80C734.19,512.48,729.56,500.63,729.64,498.81C729.69,497.54,728.46,496.14,729.23,495.18C729.58,494.74,732.58,495.11,733.20,494.97C734.58,494.66,740.37,494.97,742.20,494.97C787.53,494.97,832.87,494.97,878.20,494.97C900.87,494.97,923.54,494.97,946.20,494.97C967.73,494.97,993.11,496.47,1014.15,493.75C1060.66,487.75,1097.88,452.68,1106.00,406.47C1113.33,364.73,1099.63,311.91,1076.10,277.10C1049.91,238.34,1011.40,213.73,966.48,202.52C943.61,196.82,922.48,196.13,899.05,196.13C876.58,196.13,852.32,195.10,830.06,196.48ZM832.06,272.49C798.14,274.83,766.25,287.11,745.81,315.63C723.95,346.12,725.35,375.82,725.35,411.29C725.35,411.80,725.35,417.29,725.35,417.29C727.63,420.52,726.09,418.28,730.07,418.96C732.86,419.44,739.84,418.96,743.07,418.96C751.40,418.96,759.73,418.96,768.06,418.96C784.72,418.96,801.39,418.96,818.05,418.96C851.37,418.96,884.70,418.96,918.02,418.96C934.68,418.96,951.34,418.96,968.01,418.96C982.44,418.96,1004.66,421.13,1017.09,413.88C1033.57,404.27,1032.87,385.79,1030.71,369.22C1028.46,351.91,1024.18,337.41,1014.89,322.44C997.11,293.79,964.96,276.86,931.97,273.29C915.55,271.51,898.56,272.14,882.03,272.14C865.76,272.14,848.17,271.38,832.06,272.49Z"/>
                  <path d="M1322.23,424.01C1269.73,369.65,1217.23,315.28,1164.72,260.91C1150.14,245.82,1150.56,221.76,1165.66,207.18C1180.76,192.60,1204.81,193.02,1219.39,208.12C1271.28,261.85,1323.17,315.58,1375.06,369.31C1426.95,315.58,1478.83,261.85,1530.72,208.12C1545.30,193.02,1569.36,192.60,1584.45,207.18C1599.55,221.76,1599.97,245.82,1585.39,260.91C1532.89,315.28,1480.39,369.65,1427.88,424.01C1480.39,478.38,1532.89,532.75,1585.39,587.12C1599.97,602.21,1599.55,626.27,1584.45,640.85C1569.36,655.43,1545.30,655.01,1530.72,639.91C1478.83,586.18,1426.95,532.45,1375.06,478.72C1323.17,532.45,1271.28,586.18,1219.39,639.91C1204.81,655.01,1180.76,655.43,1165.66,640.85C1150.56,626.27,1150.14,602.21,1164.72,587.12C1217.23,532.75,1269.73,478.38,1322.23,424.01Z"/>
              </g>
              <g className="pw-mark">
                <rect x="1670.06" y="273.11" width="76.00" height="380.00" rx="38.00"/>
                <rect className="pw-stemR" x="1841.06" y="273.11" width="76.00" height="380.00" rx="38.00"/>
                <g className="pw-eyes">
                  <rect className="pw-eyeL" x="1670.06" y="127.11" width="76.00" height="75.00" rx="24.19"/>
                  <rect className="pw-eyeR" x="1841.06" y="127.11" width="76.00" height="75.00" rx="24.19"/>
                </g>
              </g>
          </>
        )
      ) : (
        <>
        <g fill="var(--plexi-wordmark, #08214F)" fillRule="evenodd">
            <path d="M207.06,196.43C125.85,201.30,57.52,243.62,34.32,324.59C24.00,360.62,26.96,401.42,26.96,438.84C26.96,477.51,26.96,516.18,26.96,554.85C26.96,593.22,26.96,631.46,26.96,669.82C26.96,689.15,26.96,708.49,26.96,727.83C26.96,748.67,25.53,766.67,46.75,778.44C63.99,788.00,86.24,782.45,96.90,765.78C103.06,756.16,102.97,748.97,102.97,738.02C102.97,728.35,102.97,718.68,102.97,709.01C102.97,699.35,102.97,689.68,102.97,680.01C102.97,675.34,102.97,670.68,102.97,666.01C102.97,663.68,102.96,661.34,102.97,659.01C103.00,655.60,102.00,653.92,104.54,652.07C104.59,652.03,157.46,652.07,162.55,652.07C200.89,652.07,239.23,652.07,277.57,652.07C296.87,652.07,316.32,652.84,335.47,650.10C355.21,647.27,372.71,642.96,391.06,634.98C426.57,619.55,456.01,593.36,474.46,559.18C483.62,542.22,489.76,523.70,493.10,504.75C496.50,485.41,495.97,466.47,495.97,446.93C495.97,427.92,495.97,408.92,495.97,389.92C495.97,369.25,495.39,352.64,490.71,332.38C481.95,294.37,460.85,260.59,429.98,236.47C399.33,212.53,361.59,199.64,323.04,196.95C303.76,195.61,284.38,196.13,265.06,196.13C246.13,196.13,225.83,195.30,207.06,196.43ZM209.06,272.43C160.79,275.65,118.61,298.93,106.50,348.69C101.28,370.17,102.97,395.16,102.97,417.36C102.97,440.68,102.97,464.01,102.97,487.33C102.97,510.33,102.97,533.32,102.97,556.31C102.97,557.92,102.89,573.14,102.97,573.31C104.40,576.17,101.42,573.78,104.63,576.06C104.66,576.09,108.24,576.04,108.62,576.06C111.43,576.25,114.76,576.06,117.62,576.06C129.29,576.06,140.95,576.06,152.61,576.06C198.93,576.06,245.25,576.06,291.57,576.06C316.26,576.06,335.86,575.65,359.12,565.98C380.96,556.89,398.11,541.74,408.82,520.54C420.34,497.71,419.96,478.19,419.96,453.40C419.96,430.07,419.97,406.74,419.96,383.42C419.95,359.17,416.81,338.46,403.10,317.84C390.08,298.24,369.68,284.79,347.38,278.11C324.36,271.22,302.71,272.14,279.03,272.14C267.37,272.14,255.70,272.14,244.04,272.14C232.58,272.14,220.43,271.67,209.06,272.43Z"/>
            <path d="M556.06,26.51C542.44,28.93,530.85,38.99,526.65,52.19C523.29,62.76,524.72,82.33,524.72,94.00C524.72,122.00,524.72,150.01,524.72,178.01C524.72,233.69,524.72,289.37,524.72,345.05C524.72,400.73,524.72,456.40,524.72,512.08C524.72,540.09,524.72,568.10,524.72,596.10C524.72,610.68,522.95,624.00,532.12,636.53C540.56,648.07,554.95,653.95,569.06,651.65C582.83,649.40,594.27,639.44,598.79,626.32C602.18,616.47,600.72,595.69,600.72,584.53C600.72,556.53,600.72,528.52,600.72,500.52C600.72,444.50,600.72,388.49,600.72,332.48C600.72,276.80,600.72,221.12,600.72,165.45C600.72,137.44,600.72,109.43,600.72,81.43C600.72,66.57,602.73,53.78,593.19,41.08C584.54,29.57,570.20,24.00,556.06,26.51Z"/>
            <path d="M830.06,196.48C731.46,202.59,659.07,265.43,650.21,365.76C648.28,387.65,649.35,411.59,649.35,433.73C649.35,456.78,648.61,478.68,652.56,501.51C660.45,547.21,683.35,587.06,721.25,614.52C758.58,641.57,803.83,651.91,849.34,652.06C894.67,652.22,940.02,652.07,985.34,652.07C996.68,652.07,1008.01,652.07,1019.34,652.07C1028.78,652.07,1044.62,653.18,1053.23,650.91C1076.72,644.73,1088.31,618.49,1077.47,596.88C1065.06,572.16,1040.45,576.06,1017.48,576.06C994.81,576.06,972.15,576.06,949.48,576.06C926.81,576.06,904.14,576.06,881.48,576.06C859.21,576.06,835.54,577.30,813.71,572.86C791.61,568.36,770.03,559.16,753.99,542.82C745.97,534.64,739.76,525.27,735.20,514.80C734.19,512.48,729.56,500.63,729.64,498.81C729.69,497.54,728.46,496.14,729.23,495.18C729.58,494.74,732.58,495.11,733.20,494.97C734.58,494.66,740.37,494.97,742.20,494.97C787.53,494.97,832.87,494.97,878.20,494.97C900.87,494.97,923.54,494.97,946.20,494.97C967.73,494.97,993.11,496.47,1014.15,493.75C1060.66,487.75,1097.88,452.68,1106.00,406.47C1113.33,364.73,1099.63,311.91,1076.10,277.10C1049.91,238.34,1011.40,213.73,966.48,202.52C943.61,196.82,922.48,196.13,899.05,196.13C876.58,196.13,852.32,195.10,830.06,196.48ZM832.06,272.49C798.14,274.83,766.25,287.11,745.81,315.63C723.95,346.12,725.35,375.82,725.35,411.29C725.35,411.80,725.35,417.29,725.35,417.29C727.63,420.52,726.09,418.28,730.07,418.96C732.86,419.44,739.84,418.96,743.07,418.96C751.40,418.96,759.73,418.96,768.06,418.96C784.72,418.96,801.39,418.96,818.05,418.96C851.37,418.96,884.70,418.96,918.02,418.96C934.68,418.96,951.34,418.96,968.01,418.96C982.44,418.96,1004.66,421.13,1017.09,413.88C1033.57,404.27,1032.87,385.79,1030.71,369.22C1028.46,351.91,1024.18,337.41,1014.89,322.44C997.11,293.79,964.96,276.86,931.97,273.29C915.55,271.51,898.56,272.14,882.03,272.14C865.76,272.14,848.17,271.38,832.06,272.49Z"/>
            <path d="M1322.23,424.01C1269.73,369.65,1217.23,315.28,1164.72,260.91C1150.14,245.82,1150.56,221.76,1165.66,207.18C1180.76,192.60,1204.81,193.02,1219.39,208.12C1271.28,261.85,1323.17,315.58,1375.06,369.31C1426.95,315.58,1478.83,261.85,1530.72,208.12C1545.30,193.02,1569.36,192.60,1584.45,207.18C1599.55,221.76,1599.97,245.82,1585.39,260.91C1532.89,315.28,1480.39,369.65,1427.88,424.01C1480.39,478.38,1532.89,532.75,1585.39,587.12C1599.97,602.21,1599.55,626.27,1584.45,640.85C1569.36,655.43,1545.30,655.01,1530.72,639.91C1478.83,586.18,1426.95,532.45,1375.06,478.72C1323.17,532.45,1271.28,586.18,1219.39,639.91C1204.81,655.01,1180.76,655.43,1165.66,640.85C1150.56,626.27,1150.14,602.21,1164.72,587.12C1217.23,532.75,1269.73,478.38,1322.23,424.01Z"/>
          </g>
          <g fill="var(--plexi-mark, #0B64E8)">
            <rect x="1670.06" y="273.11" width="76.00" height="380.00" rx="38.00"/>
            <rect x="1841.06" y="273.11" width="76.00" height="380.00" rx="38.00"/>
            <rect x="1670.06" y="127.11" width="76.00" height="75.00" rx="24.19"/>
            <rect x="1841.06" y="127.11" width="76.00" height="75.00" rx="24.19"/>
          </g>
        </>
      )}
    </svg>
  )
}

export default PlexiWordmark
