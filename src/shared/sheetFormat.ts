// Spreadsheet cell display formatting.
//
// The formula engine returns the TRUE value of a cell as a string. How that
// value is shown (a plain number, a currency amount, a percentage, a date) is a
// presentation concern that lives here, separate from evaluation, so the engine
// stays pure and reusable. The honesty rule carries over: if a value cannot be
// interpreted as the requested format expects (for example a non-numeric value
// under a currency format), we return the original text rather than invent a
// number.

import type { SheetNumberFormat } from './types'

// One source of truth for the format shape lives in shared/types as
// SheetNumberFormat; this alias keeps the existing local name.
export type NumberFormat = SheetNumberFormat

export const GENERAL: NumberFormat = { kind: 'general' }

// Group the integer part with thousands separators: 1234567 -> "1,234,567".
function groupThousands(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Format a finite number with fixed decimals and optional thousands grouping,
// preserving a leading minus sign.
function formatNumber(n: number, decimals: number, thousands: boolean): string {
  const neg = n < 0
  const fixed = Math.abs(n).toFixed(decimals)
  const [intPart, fracPart] = fixed.split('.')
  const grouped = thousands ? groupThousands(intPart) : intPart
  const body = fracPart ? `${grouped}.${fracPart}` : grouped
  return neg ? `-${body}` : body
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// Apply a small set of date tokens against a Date, in UTC so a stored timestamp
// formats identically regardless of the viewer's timezone.
function formatDate(d: Date, pattern: string): string {
  const tokens: Record<string, string> = {
    YYYY: String(d.getUTCFullYear()),
    YY: String(d.getUTCFullYear()).slice(-2),
    MMM: MONTHS_SHORT[d.getUTCMonth()],
    MM: pad2(d.getUTCMonth() + 1),
    M: String(d.getUTCMonth() + 1),
    DD: pad2(d.getUTCDate()),
    D: String(d.getUTCDate()),
    HH: pad2(d.getUTCHours()),
    mm: pad2(d.getUTCMinutes()),
    ss: pad2(d.getUTCSeconds())
  }
  // Replace longest tokens first so YYYY is matched before YY, MMM before MM.
  return pattern.replace(/YYYY|YY|MMM|MM|M|DD|D|HH|mm|ss/g, (t) => tokens[t] ?? t)
}

// Parse a cell's displayed value into a number, or null if it is not numeric.
// Tolerates a leading currency symbol, thousands commas, a percent sign, and
// surrounding whitespace so a re-formatted value still round-trips.
function toNumber(value: string): number | null {
  const cleaned = value.replace(/[\s,$%]/g, '').replace(/[^0-9.+-eE]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '+') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

// The display string for a computed/raw cell value under a number format. Honest
// by design: a value that does not fit the format (non-numeric for a numeric
// format, unparseable for a date) is returned unchanged rather than coerced into
// a misleading number.
export function formatValue(value: string, fmt: NumberFormat | undefined): string {
  if (value === '' || value == null) return ''
  if (!fmt || fmt.kind === 'general') return value

  if (fmt.kind === 'date') {
    const d = /^\d+$/.test(value.trim()) ? new Date(Number(value.trim())) : new Date(value.trim())
    if (Number.isNaN(d.getTime())) return value
    return formatDate(d, fmt.pattern)
  }

  const n = toNumber(value)
  if (n === null) return value

  switch (fmt.kind) {
    case 'number':
      return formatNumber(n, fmt.decimals, fmt.thousands ?? false)
    case 'currency': {
      const neg = n < 0
      const body = formatNumber(Math.abs(n), fmt.decimals, true)
      return neg ? `-${fmt.symbol}${body}` : `${fmt.symbol}${body}`
    }
    case 'percent':
      return `${formatNumber(n * 100, fmt.decimals, false)}%`
    default:
      return value
  }
}
