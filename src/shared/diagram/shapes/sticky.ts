// Sticky notes: square notes with a folded bottom-right corner. Each colour is
// its own palette entry (fill + darker accent stroke) so brainstorming boards
// can be built straight from the palette. Ids are saved in documents — never
// rename.

import { type ShapeDef, line, r } from './types'
import { P, fill, pad, shade, stroke } from './kit'

const S = 'Sticky notes' as const

export function stickyBody(w: number, h: number): { body: string; fold: string; k: number } {
  const k = Math.min(w, h) * 0.14
  return {
    body: `M0,0 H${r(w)} V${r(h - k)} L${P(w - k, h)} H0 Z`,
    fold: `M${P(w - k, h)} V${r(h - k)} H${r(w)} Z`,
    k
  }
}

function sticky(id: string, label: string, fillColor: string, accent: string, keywords: string[], w = 140, h = 140): ShapeDef {
  return {
    id,
    label,
    category: S,
    keywords: ['sticky', 'note', 'post-it', 'brainstorm', 'idea', 'memo', ...keywords],
    w,
    h,
    minW: 24,
    minH: 24,
    special: 'sticky',
    defaultLabel: 'Note',
    defaultStyle: { fill: fillColor, stroke: accent, textAlign: 'left', vAlign: 'top' },
    color: accent,
    draw: (W, H) => {
      const s = stickyBody(W, H)
      return { parts: [fill(s.body), shade(s.fold)], text: pad(W, H, 10, 10, 10, s.k + 4) }
    }
  }
}

export const STICKY_SHAPES: ShapeDef[] = [
  sticky('sticky-yellow', 'Yellow sticky', '#FEF08A', '#CA8A04', ['yellow']),
  sticky('sticky-pink', 'Pink sticky', '#FBCFE8', '#DB2777', ['pink']),
  sticky('sticky-green', 'Green sticky', '#BBF7D0', '#16A34A', ['green']),
  sticky('sticky-blue', 'Blue sticky', '#BFDBFE', '#2563EB', ['blue']),
  sticky('sticky-orange', 'Orange sticky', '#FED7AA', '#EA580C', ['orange']),
  sticky('sticky-purple', 'Purple sticky', '#E9D5FF', '#9333EA', ['purple', 'violet']),
  sticky('sticky-grey', 'Grey sticky', '#E5E7EB', '#6B7280', ['grey', 'gray', 'neutral']),
  sticky('sticky-wide', 'Wide sticky', '#FEF08A', '#CA8A04', ['wide', 'rectangle', 'long'], 240, 120),
  sticky('sticky-small', 'Small sticky', '#FEF08A', '#CA8A04', ['small', 'mini', 'tag'], 80, 80),
  {
    id: 'sticky-lined',
    label: 'Lined note',
    category: S,
    keywords: ['lined', 'notepad', 'paper', 'ruled', 'note', 'memo', 'sticky'],
    w: 160,
    h: 180,
    minW: 30,
    minH: 30,
    special: 'sticky',
    defaultLabel: 'Notes',
    defaultStyle: { fill: '#FEF9C3', stroke: '#CA8A04', textAlign: 'left', vAlign: 'top' },
    color: '#CA8A04',
    draw: (w, h) => {
      const s = stickyBody(w, h)
      const top = Math.min(h * 0.2, 28)
      const gap = Math.max(h * 0.1, 4)
      const lines: string[] = [line(Math.min(w * 0.14, 18), 0, Math.min(w * 0.14, 18), h)]
      for (let y = top; y < h - s.k - 2; y += gap) lines.push(line(0, y, w - (y > h - s.k ? s.k : 0), y))
      return { parts: [fill(s.body), stroke(lines.join(' ')), shade(s.fold)], text: pad(w, h, Math.min(w * 0.14, 18) + 6, 6, 8, s.k + 4) }
    }
  }
]
