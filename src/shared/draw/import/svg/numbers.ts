// Numbers, lists of numbers and lengths, exactly as SVG writes them.
//
// SVG's number grammar is looser than JSON's, and real exporters lean on every
// corner of it: "1.5.5" is two numbers, "-1-2" is two, "1e-3" is one, and an
// arc's flags may be squashed together ("a1 1 0 01 1 1"). Everything here is
// also the first line of defence against hostile input: a value that is not a
// finite number, or whose size is beyond anything a drawing could mean, is
// refused rather than carried into geometry.

/** The largest coordinate magnitude the importer accepts; larger values make the element inert. */
export const MAX_COORD = 1e7

/** A scanner over one attribute's text. */
export class NumberScanner {
  i = 0
  constructor(readonly s: string) {}

  skipSeparators(): void {
    const s = this.s
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i)
      // space, tab, LF, CR, FF, comma
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44) this.i++
      else break
    }
  }

  done(): boolean {
    this.skipSeparators()
    return this.i >= this.s.length
  }

  /** The next number, or null when the next token is not one. */
  number(): number | null {
    this.skipSeparators()
    const s = this.s
    const start = this.i
    let j = this.i
    if (s[j] === '+' || s[j] === '-') j++
    let digits = 0
    while (j < s.length && s[j] >= '0' && s[j] <= '9') {
      j++
      digits++
    }
    if (s[j] === '.') {
      j++
      while (j < s.length && s[j] >= '0' && s[j] <= '9') {
        j++
        digits++
      }
    }
    if (digits === 0) return null
    if (s[j] === 'e' || s[j] === 'E') {
      let k = j + 1
      if (s[k] === '+' || s[k] === '-') k++
      let ed = 0
      while (k < s.length && s[k] >= '0' && s[k] <= '9') {
        k++
        ed++
      }
      // "1em" is a number and a unit, not a broken exponent.
      if (ed > 0) j = k
    }
    const v = Number(s.slice(start, j))
    if (!Number.isFinite(v)) return null
    this.i = j
    return v
  }

  /** An arc flag: a single 0 or 1, which may be followed directly by the next value. */
  flag(): 0 | 1 | null {
    this.skipSeparators()
    const c = this.s[this.i]
    if (c === '0' || c === '1') {
      this.i++
      return c === '1' ? 1 : 0
    }
    return null
  }
}

/** Every number in a list ("1 2,3 -4"); stops at the first token that is not a number. */
export function numberList(v: string | null | undefined): number[] {
  if (!v) return []
  const sc = new NumberScanner(v)
  const out: number[] = []
  for (;;) {
    const n = sc.number()
    if (n === null) break
    out.push(n)
    if (out.length > 100000) break
  }
  return out
}

/** True when every value is finite and within MAX_COORD. */
export function inRange(...vs: number[]): boolean {
  for (const v of vs) if (!Number.isFinite(v) || Math.abs(v) > MAX_COORD) return false
  return true
}

// ── Lengths ──────────────────────────────────────────────────────────────────

/** CSS pixels per unit. SVG's user unit is the CSS pixel, 96 to the inch. */
const UNIT_PX: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  q: 96 / 101.6,
  in: 96
}

export interface LengthContext {
  /** The viewport a percentage refers to. */
  vw: number
  vh: number
  /** The element's font size, for em and ex. */
  fontSize: number
}

export type Axis = 'x' | 'y' | 'other'

/**
 * A length in user units, or null when `v` is not one. Percentages resolve
 * against the viewport: width for x, height for y, and the normalised diagonal
 * (sqrt((w^2 + h^2) / 2)) for anything else, as the SVG spec says.
 */
export function parseLength(v: string | null | undefined, axis: Axis, ctx: LengthContext): number | null {
  if (v == null) return null
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|q|in|em|ex|rem|%)?\s*$/i.exec(v)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  const unit = (m[2] ?? '').toLowerCase()
  let out: number
  if (unit === '%') {
    const ref = axis === 'x' ? ctx.vw : axis === 'y' ? ctx.vh : Math.sqrt((ctx.vw * ctx.vw + ctx.vh * ctx.vh) / 2)
    out = (n / 100) * ref
  } else if (unit === 'em') out = n * ctx.fontSize
  else if (unit === 'rem') out = n * 16
  else if (unit === 'ex') out = n * ctx.fontSize * 0.5
  else out = n * UNIT_PX[unit]
  return Number.isFinite(out) && Math.abs(out) <= MAX_COORD ? out : null
}

/** A plain number (opacity, offsets): accepts a trailing % as a fraction. */
export function parseNumberOrPercent(v: string | null | undefined): number | null {
  if (v == null) return null
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(%)?\s*$/.exec(v)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return m[2] ? n / 100 : n
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}
