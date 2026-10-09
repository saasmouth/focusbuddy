// A colour that arrived inside content -- a shared desk, a peer's edit, an
// imported document -- and is about to be written into markup or a style sheet.
//
// Colours look harmless, and that is exactly why they end up interpolated
// unescaped: `fill="${color}"` in an SVG serializer, `color:${color}` in an
// injected <style>. A "colour" of `red"/><script>…` or
// `red}*{background:url(https://tracker.example/x)}` is then markup or CSS of
// the sender's choosing, rendered on the recipient's screen -- and on the
// public share page that recipient is a stranger opening a marketing link.
//
// So a colour has to be ONLY a colour. This is an allowlist of the shapes the
// editors actually produce, not a blocklist of known-bad characters:
//
//   #rgb #rgba #rrggbb #rrggbbaa      the colour pickers and the eyedropper
//   red, transparent, currentColor     a bare keyword, letters only
//   rgb() rgba() hsl() hsla() hwb()    a colour function from a fixed list, whose
//   lab() lch() oklab() oklch() color()  arguments are numbers, units, keywords,
//                                       commas, slashes and spaces -- and never a
//                                       parenthesis, so nothing can nest inside one
//                                       (no url(), no var(), no image-set())
//
// Anything else is not a colour this app made, and callers fall back to their
// default rather than rendering it.

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const KEYWORD = /^[a-z]{3,32}$/i
const FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([-+.,%/\s0-9a-z]{1,96}\)$/i

/** The longest colour string accepted -- far beyond any real colour value. */
export const MAX_CSS_COLOR_LENGTH = 128

/** True when `v` is a CSS colour and nothing else (see the allowlist above). */
export function isSafeCssColor(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_CSS_COLOR_LENGTH) return false
  return HEX.test(v) || KEYWORD.test(v) || FUNCTION.test(v)
}

/** `v` trimmed when it is a safe colour, otherwise `fallback`. */
export function safeCssColor(v: unknown, fallback: string): string
export function safeCssColor(v: unknown, fallback: undefined): string | undefined
export function safeCssColor(v: unknown, fallback: string | undefined): string | undefined {
  if (typeof v !== 'string') return fallback
  const t = v.trim()
  return isSafeCssColor(t) ? t : fallback
}
