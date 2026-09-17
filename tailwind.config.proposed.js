import typography from '@tailwindcss/typography'

/**
 * Plexii Tailwind config.
 *
 * The theme below is the *executable* half of DESIGN_SYSTEM.md. Everything is
 * an alias onto a token in tokens.css — nothing here invents a value — so the
 * four themes (light / .dark / .futuristic / .atelier) keep working untouched.
 *
 * Two things changed from the previous config and both are deliberate:
 *
 * 1. `borderRadius` is now mapped onto the ratified three-step scale. Tailwind's
 *    defaults were never overridden, so `rounded-md` has been painting 6px and
 *    `rounded-xl` 12px — neither value exists in the scale, against a law that
 *    reads "never invent a fourth value in a component". 382 call sites correct
 *    themselves with this block and no component edits.
 *      rounded-sm  2px -> 8px   (11 sites shift)
 *      rounded-md  6px -> 10px  (295 sites shift)  <- the big one
 *      rounded-lg  8px -> 8px   (308 sites, no visual change)
 *      rounded-xl  12px -> 16px (76 sites shift)
 *      rounded-2xl 16px -> 16px (36 sites, no visual change)
 *    `rounded-full` and `rounded-none` are untouched.
 *
 * 2. The ink / surface / edge ramps are first-class colours, so a call site
 *    writes `text-ink-70` instead of `text-[var(--ink-70)]`. Same output, and
 *    it makes the 397 hardcoded hex values obvious by contrast.
 */

/** Ramp -> Tailwind colour map. Plain var() (not rgb()) because the tokens are
 *  oklch() and cannot take Tailwind's <alpha-value> channel. Use the /NN opacity
 *  modifier only on `accent`, which is stored as an R G B triple for exactly that. */
const ramp = (name, steps) =>
  Object.fromEntries(steps.map((s) => [s, `var(--${name}-${s})`]))

export default {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Existing, unchanged ──────────────────────────────────────────
        desk: {
          50: '#fbf7ee', 100: '#f4ebd3', 200: '#e8d6a8', 300: '#d9bb78', 400: '#caa052',
          500: '#b8893f', 600: '#9c6e33', 700: '#7c552c', 800: '#5f4127', 900: '#4a3422'
        },
        sticky: {
          yellow: '#fef08a', pink: '#fbcfe8', blue: '#bae6fd',
          green: '#bbf7d0', orange: '#fed7aa'
        },
        accent: 'rgb(var(--accent) / <alpha-value>)',
        'accent-hover': 'rgb(var(--accent-hover) / <alpha-value>)',

        // ── The ramps, as colours ────────────────────────────────────────
        ink: ramp('ink', [100, 90, 80, 70, 60, 55, 50, 45, 40, 35, 30, 25, 10]),
        surface: {
          base: 'var(--surface-base)',
          raised: 'var(--surface-raised)',
          sunken: 'var(--surface-sunken)',
          veil: 'var(--surface-veil)'
        },
        edge: {
          soft: 'var(--edge-soft)',
          firm: 'var(--edge-firm)',
          glow: 'var(--edge-glow)',
          hairline: 'var(--edge-hairline)'
        }
      },

      // ── Corners rhyme. Three steps, plus semantic names for new code. ──
      borderRadius: {
        sm: 'var(--radius-chip)',
        DEFAULT: 'var(--radius-chip)',
        md: 'var(--radius-row)',
        lg: 'var(--radius-chip)',
        xl: 'var(--radius-card)',
        '2xl': 'var(--radius-card)',
        chip: 'var(--radius-chip)',
        row: 'var(--radius-row)',
        field: 'var(--radius-field)',
        card: 'var(--radius-card)'
      },

      // ── Depth comes from light. These are the shadow tokens verbatim. ──
      boxShadow: {
        hairline: '0 0 0 1px var(--edge-hairline)',
        soft: 'var(--shadow-soft)',
        cast: 'var(--shadow-cast)',
        deep: 'var(--shadow-deep)',
        // The three composites every material surface actually uses, so a
        // component writes one class instead of stacking three.
        card: '0 0 0 1px var(--edge-hairline), var(--shadow-soft), var(--shadow-inset-highlight)',
        'card-hover': '0 0 0 1px var(--edge-hairline), var(--shadow-cast), var(--shadow-inset-highlight)',
        'card-lifted': '0 0 0 1px var(--edge-firm), var(--shadow-deep), var(--shadow-inset-highlight)',
        inset: 'var(--shadow-inset-highlight)',
        none: 'none'
      },

      // ── Motion: the four ratified curves and five durations. ───────────
      transitionTimingFunction: {
        snap: 'var(--ease-spring-snap)',
        soft: 'var(--ease-spring-soft)',
        glide: 'var(--ease-spring-glide)',
        crisp: 'var(--ease-spring-crisp)'
      },
      transitionDuration: {
        instant: 'var(--dur-instant)',
        quick: 'var(--dur-quick)',
        base: 'var(--dur-base)',
        slow: 'var(--dur-slow)',
        cinematic: 'var(--dur-cinematic)'
      },

      fontFamily: {
        sans: 'var(--font-sans)',
        display: 'var(--font-display)',
        mono: 'var(--font-mono)',
        hand: 'var(--font-hand)',
        ui: ['system-ui', '-apple-system', 'sans-serif']
      },

      // Canvas widgets are resized by the user, so they size to their own
      // container and never to the viewport. Named so `@w-sm:` reads clearly.
      containers: { widget: '18rem', 'widget-lg': '26rem' },

      backdropBlur: { chrome: '24px', panel: '28px', pillow: '40px' },

      keyframes: {
        'plx-in': {
          from: { opacity: '0', transform: 'translateY(4px) scale(0.985)' },
          to: { opacity: '1', transform: 'none' }
        },
        'plx-shimmer': { '100%': { transform: 'translateX(100%)' } }
      },
      animation: {
        'plx-in': 'plx-in var(--dur-base) var(--ease-spring-glide) both',
        'plx-shimmer': 'plx-shimmer 1.6s var(--ease-spring-glide) infinite'
      }
    }
  },
  plugins: [typography]
}
