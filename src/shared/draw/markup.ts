// The three primitives every PlexiiDraw serializer writes markup with. Shared
// by the v1 serializer (draw.ts) and the v2 one (svg.ts) so the two cannot
// drift: every value that reaches markup is escaped, formatted from a finite
// number, or checked against a closed set.

/** Escape a string for use as XML text or a double- or single-quoted attribute. */
export function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** A number as markup: finite values verbatim, anything else as 0. */
export function num(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '0'
}

/** A number to fixed places: finite values only, anything else as 0. */
export function fixed(v: number, places: number): string {
  return (Number.isFinite(v) ? v : 0).toFixed(places)
}

/** A finite number. JSON cannot carry NaN or Infinity, but a structured clone can. */
export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
