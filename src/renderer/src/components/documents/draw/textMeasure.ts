// Real glyph measurement for on-canvas text.
//
// Both PlexiDraw and PlexiDesign need to know exactly where a line of type
// breaks — not approximately, because the break decides what the user sees AND
// (once cached onto the object) what the exporter writes. A single offscreen
// 2D context does the measuring: it is the same font engine the screen uses, so
// the answer is the truth rather than an estimate.
//
// `measure` is injectable so the wrapping logic can be unit-tested with a
// deterministic fake instead of a browser font stack.

export type Measurer = (text: string, font: string) => number

let sharedCtx: CanvasRenderingContext2D | null = null

function ctx(): CanvasRenderingContext2D | null {
  if (sharedCtx) return sharedCtx
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  sharedCtx = c.getContext('2d')
  return sharedCtx
}

/** A CSS `font` shorthand, which is what measureText wants. */
export function fontShorthand(opts: { fontSize: number; fontFamily?: string; fontWeight?: number; italic?: boolean }): string {
  const style = opts.italic ? 'italic ' : ''
  const weight = opts.fontWeight ? `${opts.fontWeight} ` : ''
  return `${style}${weight}${opts.fontSize}px ${opts.fontFamily || 'Inter, system-ui, sans-serif'}`
}

/** Width of a string in px. Returns 0 with no DOM (tests, main process). */
export const domMeasurer: Measurer = (text, font) => {
  const c = ctx()
  if (!c) return 0
  c.font = font
  return c.measureText(text).width
}

export interface WrapOptions {
  text: string
  width: number
  font: string
  letterSpacing?: number
  measure?: Measurer
}

/**
 * Greedy word wrap, the algorithm every word processor uses: fill a line until
 * the next word would overflow, then break. Explicit newlines always break. A
 * single word wider than the column is kept whole on its own line rather than
 * silently truncated — an overflowing word is visible and fixable; a missing one
 * is neither.
 */
export function wrapText(opts: WrapOptions): string[] {
  const measure = opts.measure ?? domMeasurer
  const spacing = opts.letterSpacing ?? 0
  const widthOf = (s: string): number => measure(s, opts.font) + spacing * Math.max(0, s.length - 1)
  const out: string[] = []

  for (const para of opts.text.split('\n')) {
    if (para === '') {
      out.push('')
      continue
    }
    const words = para.split(/(\s+)/).filter((w) => w !== '')
    let line = ''
    for (const token of words) {
      const isSpace = /^\s+$/.test(token)
      // A run of spaces never starts a line — it is absorbed by the break.
      if (isSpace && line === '') continue
      const candidate = line + token
      if (line !== '' && !isSpace && widthOf(candidate) > opts.width) {
        out.push(line.trimEnd())
        line = token
      } else {
        line = candidate
      }
    }
    out.push(line.trimEnd())
  }
  return out
}

/**
 * The lines AND the block height for a wrapped run of type, which is what the
 * selection box and the text-flow engine both need.
 */
export function layoutText(opts: WrapOptions & { lineHeight?: number; fontSize: number }): { lines: string[]; height: number } {
  const lines = wrapText(opts)
  const lh = (opts.lineHeight ?? 1.2) * opts.fontSize
  return { lines, height: Math.max(lh, lines.length * lh) }
}
