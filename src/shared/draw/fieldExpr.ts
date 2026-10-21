// Numeric fields the way Illustrator's panels and dialogs read them: units
// from the document's settings, arithmetic in the field ("100+20", "2in-5mm",
// "(40+8)/2"), percentages of the current value ("50%"), and a leading
// multiply or divide applied to the current value ("*2", "/3").
//
// Pure: no DOM, no editor. Lengths come back in the document's own unit, px.

import type { DrawSettings, DrawUnits } from './model'

export const DRAW_UNITS: readonly DrawUnits[] = ['px', 'pt', 'pc', 'in', 'mm']

/** CSS reference pixels per inch -- a drawing with no stored dpi has always been exported at this. */
const DEFAULT_DPI = 96

/** The document's display unit (px when it names none). */
export function docUnits(settings: DrawSettings | undefined): DrawUnits {
  const u = settings?.units
  return u && (DRAW_UNITS as readonly string[]).includes(u) ? u : 'px'
}

export function docDpi(settings: DrawSettings | undefined): number {
  const d = settings?.dpi
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : DEFAULT_DPI
}

/** px in one of `unit`, at `dpi` logical px per inch. */
export function pxPerUnit(unit: DrawUnits, dpi: number): number {
  switch (unit) {
    case 'in':
      return dpi
    case 'mm':
      return dpi / 25.4
    case 'pt':
      return dpi / 72
    case 'pc':
      return dpi / 6
    default:
      return 1
  }
}

const UNIT_ALIASES: Record<string, DrawUnits> = {
  px: 'px',
  pt: 'pt',
  pc: 'pc',
  p: 'pc',
  in: 'in',
  inch: 'in',
  inches: 'in',
  '"': 'in',
  mm: 'mm',
  cm: 'mm'
}

export interface FieldContext {
  /** What a bare number means: px, pt, mm... ('deg' and '%' fields take no unit). */
  unit: DrawUnits | 'deg' | 'pct'
  dpi: number
  /** The value now shown, in the field's own unit -- for "50%" and "*2". */
  current?: number
}

/** Format a value for a field: up to `places` decimals, trailing zeros dropped, and the unit. */
export function formatField(v: number, unit: FieldContext['unit'], places = 3): string {
  if (!Number.isFinite(v)) return ''
  const r = Math.round(v * 10 ** places) / 10 ** places
  const s = (Object.is(r, -0) ? 0 : r).toString()
  if (unit === 'deg') return `${s}°`
  if (unit === 'pct') return `${s}%`
  return `${s} ${unit}`
}

/** A length in px shown in `unit`. */
export function pxToUnit(px: number, unit: DrawUnits, dpi: number): number {
  return px / pxPerUnit(unit, dpi)
}

export function unitToPx(v: number, unit: DrawUnits, dpi: number): number {
  return v * pxPerUnit(unit, dpi)
}

type Tok = { t: 'num'; v: number; unit?: string } | { t: 'op'; v: string }

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if ('+-*/()%'.includes(ch)) {
      out.push({ t: 'op', v: ch })
      i++
      continue
    }
    const m = /^(\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i))
    if (m) {
      const v = Number(m[0].replace(',', '.'))
      if (!Number.isFinite(v)) return null
      i += m[0].length
      // An optional unit straight after the number (spaces allowed): 2in, 5 mm, 3", 30°.
      const rest = src.slice(i)
      const um = /^\s*(px|pt|pc|in(?:ch(?:es)?)?|mm|cm|p(?![a-z])|"|°|deg)/i.exec(rest)
      if (um) {
        i += um[0].length
        out.push({ t: 'num', v, unit: um[1].toLowerCase() })
      } else out.push({ t: 'num', v })
      continue
    }
    return null
  }
  return out
}

/**
 * Evaluate what was typed into a field. Returns the value in the field's own
 * unit (px for lengths, degrees, percent), or null when it does not parse --
 * the field then keeps its old value, as Illustrator's do.
 */
export function evalField(text: string, ctx: FieldContext): number | null {
  const src = text.trim().replace(/×/g, '*').replace(/÷/g, '/')
  if (!src) return null
  const toks = tokenize(src)
  if (!toks || !toks.length) return null
  let pos = 0
  const cur = ctx.current
  const lengthField = ctx.unit !== 'deg' && ctx.unit !== 'pct'

  const peek = (): Tok | undefined => toks[pos]
  const isOp = (v: string): boolean => {
    const t = peek()
    return !!t && t.t === 'op' && t.v === v
  }

  // A number with its unit, converted to the field's unit.
  const literal = (tok: Extract<Tok, { t: 'num' }>): number | null => {
    if (!tok.unit || tok.unit === '°' || tok.unit === 'deg') {
      if ((tok.unit === '°' || tok.unit === 'deg') && lengthField) return null
      return tok.v
    }
    if (!lengthField) return null
    const u = tok.unit === 'cm' ? 'mm' : UNIT_ALIASES[tok.unit]
    if (!u) return null
    const px = unitToPx(tok.unit === 'cm' ? tok.v * 10 : tok.v, u, ctx.dpi)
    return pxToUnit(px, ctx.unit as DrawUnits, ctx.dpi)
  }

  function primary(): number | null {
    const t = peek()
    if (!t) return null
    if (t.t === 'op' && t.v === '(') {
      pos++
      const v = sum()
      if (v === null || !isOp(')')) return null
      pos++
      return v
    }
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) {
      pos++
      const v = primary()
      return v === null ? null : t.v === '-' ? -v : v
    }
    if (t.t !== 'num') return null
    pos++
    let v = literal(t)
    if (v === null) return null
    // "50%": a percentage of the current value (of 100 when there is none).
    if (isOp('%')) {
      pos++
      v = (v / 100) * (ctx.unit === 'pct' ? 100 : (cur ?? 0))
    }
    return v
  }

  function product(): number | null {
    let v = primary()
    while (v !== null && (isOp('*') || isOp('/'))) {
      const op = (peek() as { v: string }).v
      pos++
      const r = primary()
      if (r === null) return null
      if (op === '/' && r === 0) return null
      v = op === '*' ? v * r : v / r
    }
    return v
  }

  function sum(): number | null {
    let v = product()
    while (v !== null && (isOp('+') || isOp('-'))) {
      const op = (peek() as { v: string }).v
      pos++
      const r = product()
      if (r === null) return null
      v = op === '+' ? v + r : v - r
    }
    return v
  }

  // "*2" or "/4" on its own: applied to what the field shows now.
  let value: number | null
  if ((isOp('*') || isOp('/')) && cur !== undefined) {
    const op = (peek() as { v: string }).v
    pos++
    const r = sum()
    value = r === null || (op === '/' && r === 0) ? null : op === '*' ? cur * r : cur / r
  } else value = sum()
  if (value === null || pos !== toks.length || !Number.isFinite(value)) return null
  return value
}

/** Evaluate a LENGTH field typed in document units, returning px. */
export function evalLength(text: string, settings: DrawSettings | undefined, currentPx?: number): number | null {
  const unit = docUnits(settings)
  const dpi = docDpi(settings)
  const v = evalField(text, { unit, dpi, current: currentPx === undefined ? undefined : pxToUnit(currentPx, unit, dpi) })
  return v === null ? null : unitToPx(v, unit, dpi)
}

/** A length in px as its field text in document units. */
export function formatLength(px: number, settings: DrawSettings | undefined): string {
  const unit = docUnits(settings)
  return formatField(pxToUnit(px, unit, docDpi(settings)), unit, unit === 'px' ? 2 : 3)
}

/** The arrow-key nudge from the document's Keyboard Increment, in px (1 when unset). */
export function keyIncrementPx(settings: DrawSettings | undefined): number {
  const k = settings?.keyIncrement
  return typeof k === 'number' && Number.isFinite(k) && k > 0 ? k : 1
}
