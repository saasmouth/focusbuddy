// What the Design toolbar's "Start from" menu offers: every template and every
// page size, grouped, each with the size it produces.
//
// It replaces a grid of chips that sat ON the canvas — the owner's words were
// "please find a solution to this wasted real estate" — so the list has to
// carry everything that grid did plus the sizes that used to be a second
// panel, in something that opens and closes.
//
// Two kinds of entry, deliberately distinguishable:
//   template  applies a composed layout AND its size ("Quote post · 1080×1080")
//   size      changes the page only, keeping the artwork ("A4 portrait · 794×1123")
//
// Both appear even at the same dimensions, because they do different things.
//
// No empty groups. The chip grid rendered a PUBLICATION heading with nothing
// under it, because it drew one heading per category and there has never been
// a publication TEMPLATE — only publication sizes. Building the groups from
// their real contents is what fixes that, rather than special-casing the one
// category that showed it.

import { DESIGN_SIZES, DESIGN_TEMPLATES, findDesignSize, type DesignCategory, type DesignSize } from './design'

export interface StartMenuEntry {
  kind: 'template' | 'size'
  /** Template id or size id, which is what the editor acts on. */
  id: string
  label: string
  /** The page size this entry produces, in px. */
  w: number
  h: number
}

export interface StartMenuGroup {
  id: DesignCategory
  label: string
  entries: StartMenuEntry[]
}

const GROUP_LABELS: Array<{ id: DesignCategory; label: string }> = [
  { id: 'publication', label: 'Publication' },
  { id: 'social', label: 'Social' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'presentation', label: 'Presentation' },
  { id: 'logo', label: 'Logo & brand' }
]

/**
 * The menu, grouped by category: each group's templates first, then its sizes.
 *
 * A size is NOT dropped because a template in the group happens to produce the
 * same dimensions. I tried that first, on the reasoning that "Event flyer" and
 * "Poster (A4)" at 794×1123 were the same choice twice — they are not. One
 * brings a layout, the other gives an empty page, and suppressing the size
 * left no way to ask for a blank A4 poster from the group it belongs to. Every
 * size stays reachable under its own name; the icon and the order say which
 * kind each entry is.
 */
export function startMenuGroups(): StartMenuGroup[] {
  const out: StartMenuGroup[] = []
  for (const g of GROUP_LABELS) {
    const templates: StartMenuEntry[] = DESIGN_TEMPLATES.filter((t) => t.category === g.id).map((t) => {
      const s = findDesignSize(t.sizeId)
      return { kind: 'template', id: t.id, label: t.label, w: s?.w ?? 0, h: s?.h ?? 0 }
    })
    const sizes: StartMenuEntry[] = DESIGN_SIZES.filter((s) => s.category === g.id).map((s) => ({
      kind: 'size',
      id: s.id,
      label: s.label,
      w: s.w,
      h: s.h
    }))
    const entries = [...templates, ...sizes]
    // The only reason a group is dropped: it has nothing in it.
    if (entries.length) out.push({ id: g.id, label: g.label, entries })
  }
  return out
}

/** "1080 × 1920", for the entry's secondary line. */
export function describeSize(w: number, h: number): string {
  return `${Math.round(w)} × ${Math.round(h)}`
}

export type SizeUnit = 'px' | 'mm' | 'in'

export interface CustomSizeInput {
  w: number
  h: number
  unit: SizeUnit
  orientation?: 'portrait' | 'landscape'
}

/** CSS pixels per inch — the same 96 the rest of the suite measures print in. */
const PX_PER_IN = 96
const MM_PER_IN = 25.4

/** One dimension in CSS pixels. */
export function toPx(value: number, unit: SizeUnit): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (unit === 'px') return Math.round(value)
  if (unit === 'in') return Math.round(value * PX_PER_IN)
  return Math.round((value / MM_PER_IN) * PX_PER_IN)
}

/** A dimension in px, shown back in the chosen unit (2dp for mm and inches). */
export function fromPx(px: number, unit: SizeUnit): number {
  if (unit === 'px') return Math.round(px)
  const inches = px / PX_PER_IN
  const v = unit === 'in' ? inches : inches * MM_PER_IN
  return Math.round(v * 100) / 100
}

/**
 * A custom size as a DesignSize the editor can apply.
 *
 * Clamped to something a canvas can actually be: under 16px there is nothing
 * to lay out, and past 20000px the renderer is laying out a page no printer
 * will take. Returns null when the numbers are not usable, so the form can say
 * so instead of silently making a 1×1 page.
 */
export function customDesignSize(input: CustomSizeInput): DesignSize | null {
  let w = toPx(input.w, input.unit)
  let h = toPx(input.h, input.unit)
  if (w < 16 || h < 16 || w > 20000 || h > 20000) return null
  if (input.orientation === 'landscape' && h > w) [w, h] = [h, w]
  if (input.orientation === 'portrait' && w > h) [w, h] = [h, w]
  return {
    id: `custom-${w}x${h}`,
    category: 'publication',
    label: `Custom ${describeSize(w, h)}`,
    w,
    h
  }
}
