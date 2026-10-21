// CSS colours as SVG files write them, reduced to what the drawing model
// stores: a lowercase #rrggbb plus an opacity. Every colour that reaches the
// model is that shape, so nothing a file says can travel into markup.

export interface ParsedColor {
  hex: string
  /** 0..1, from an alpha channel (#rgba, rgba(), hsla(), transparent). */
  alpha: number
}

/** The CSS named colours (CSS Color 4). */
const NAMED: Record<string, string> = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff', beige: 'f5f5dc', bisque: 'ffe4c4',
  black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff', blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887', cadetblue: '5f9ea0',
  chartreuse: '7fff00', chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c', cyan: '00ffff',
  darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9', darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b',
  darkmagenta: '8b008b', darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a',
  darkseagreen: '8fbc8f', darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3',
  deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff', firebrick: 'b22222', floralwhite: 'fffaf0',
  forestgreen: '228b22', fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080',
  green: '008000', greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c', indigo: '4b0082',
  ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5', lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6',
  lightcoral: 'f08080', lightcyan: 'e0ffff', lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3', lightgreen: '90ee90', lightgrey: 'd3d3d3',
  lightpink: 'ffb6c1', lightsalmon: 'ffa07a', lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899',
  lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000',
  mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db', mediumseagreen: '3cb371',
  mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc', mediumvioletred: 'c71585', midnightblue: '191970',
  mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000',
  olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98',
  paleturquoise: 'afeeee', palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd',
  powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399', red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513',
  salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb',
  slateblue: '6a5acd', slategray: '708090', slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c',
  teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff',
  whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32'
}

function hex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}

function channel(v: string): number | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(v.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return m[2] ? (n / 100) * 255 : n
}

function alphaOf(v: string | undefined): number | null {
  if (v === undefined) return 1
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%?)$/i.exec(v.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(1, m[2] ? n / 100 : n))
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360
  const f = (n: number): number => {
    const k = (n + hue * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

/** Arguments of a colour function, comma- or space-separated, with an optional "/ alpha". */
function args(inner: string): string[] | null {
  const slash = inner.split('/')
  if (slash.length > 2) return null
  const main = slash[0].trim().split(/\s*,\s*|\s+/).filter(Boolean)
  if (slash.length === 2) main.push(slash[1].trim())
  return main
}

/**
 * A colour, or null when `v` is not one this importer understands (including
 * `none`, `currentColor` and paint-server references, which the caller
 * resolves itself). `transparent` is black at zero alpha.
 */
export function parseColor(v: string | null | undefined): ParsedColor | null {
  if (v == null) return null
  const s = v.trim().toLowerCase()
  if (!s) return null
  if (s === 'transparent') return { hex: '#000000', alpha: 0 }
  if (s[0] === '#') {
    const h = s.slice(1)
    if (!/^[0-9a-f]+$/.test(h)) return null
    if (h.length === 3 || h.length === 4) {
      const e = h.split('').map((c) => c + c).join('')
      return { hex: `#${e.slice(0, 6)}`, alpha: h.length === 4 ? parseInt(e.slice(6, 8), 16) / 255 : 1 }
    }
    if (h.length === 6 || h.length === 8) return { hex: `#${h.slice(0, 6)}`, alpha: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }
    return null
  }
  if (NAMED[s]) return { hex: `#${NAMED[s]}`, alpha: 1 }
  const fn = /^(rgba?|hsla?)\(\s*([^()]*)\)$/.exec(s)
  if (!fn) return null
  const a = args(fn[2])
  if (!a || a.length < 3 || a.length > 4) return null
  const alpha = alphaOf(a[3])
  if (alpha === null) return null
  if (fn[1].startsWith('rgb')) {
    const r = channel(a[0])
    const g = channel(a[1])
    const b = channel(a[2])
    if (r === null || g === null || b === null) return null
    return { hex: rgbHex(r, g, b), alpha }
  }
  const h = Number(a[0].replace(/deg$/, ''))
  const sat = /%$/.test(a[1]) ? Number(a[1].slice(0, -1)) / 100 : Number(a[1]) / 100
  const lig = /%$/.test(a[2]) ? Number(a[2].slice(0, -1)) / 100 : Number(a[2]) / 100
  if (![h, sat, lig].every(Number.isFinite)) return null
  const [r, g, b] = hslToRgb(h, Math.max(0, Math.min(1, sat)), Math.max(0, Math.min(1, lig)))
  return { hex: rgbHex(r, g, b), alpha }
}

/** Mix two #rrggbb colours: t = 0 gives a, 1 gives b. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
  return rgbHex(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t)
}
