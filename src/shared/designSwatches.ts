// Named colours — swatches, including spot inks for print.
//
// The same gap as paragraph styles, in colour: every fill carried a raw hex
// string, so "make the accent slightly warmer" meant finding every element
// that used it. A swatch is a colour with a name that many things point at,
// so changing it changes all of them, and so a print shop can be told which
// inks a job needs.
//
// HOW A REFERENCE IS STORED, because this is the decision everything else
// follows from. A fill keeps BOTH its resolved `color` and an optional
// `swatchId`:
//
//   { type: 'solid', color: '#2563eb', swatchId: 'brand' }
//
// The colour is not derived at render time. That means a reader that knows
// nothing about swatches — an older build, the exporter, any code written
// before today — draws exactly the right colour with no changes at all, and
// there is no migration. The cost is that the two can drift, so editing a
// swatch must rewrite every reference; applySwatchEdit is that operation and
// is the only supported way to change one.
//
// SPOT COLOURS are not a different kind of swatch, they are a swatch with an
// ink name. A spot ink prints from its own plate rather than being mixed from
// CMYK, which is why a logo colour stays identical across a print run. The
// renderer shows the process approximation — screens have no spot inks — and
// preflight is what tells you how many plates a job will need.

import { DEFAULT_BRAND_KIT, type OrgBrandKit } from './brandKit'
import type { DesignBody } from './design'
import type { SlideElement, SlideFill } from './types'

export interface DesignSwatch {
  id: string
  name: string
  /** The process (screen/CMYK) colour, always present, always a hex string. */
  color: string
  /**
   * Present when this is a SPOT ink. The name is what a printer is told —
   * "Pantone 286 C" — and `color` is only its on-screen approximation.
   */
  spot?: { inkName: string }
  /** Locked swatches cannot be edited or deleted; brand colours use this. */
  locked?: boolean
}

/** A fill that may point at a swatch. */
export interface SwatchRef {
  swatchId?: string
  /** Percentage of the swatch, 1-100. Absent means 100. Spot inks tint. */
  tint?: number
}

/** Shallow-equal for swatch fields, which are scalars or a one-key spot object. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a && b && typeof a === 'object' && typeof b === 'object')
    return JSON.stringify(a) === JSON.stringify(b)
  return false
}

export function findSwatch(body: DesignBody, id: string): DesignSwatch | null {
  return (body.swatches ?? []).find((s) => s.id === id) ?? null
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))

/**
 * A swatch at a tint, as a hex colour.
 *
 * Tint is mixed toward WHITE, which is what tinting an ink on white paper
 * does — a 20% tint of a dark blue is a pale blue, not a transparent one.
 * Mixing toward transparent would look similar on a white page and wrong on
 * every other background.
 */
export function tintedColor(hex: string, tint = 100): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const t = Math.max(0, Math.min(100, tint)) / 100
  const n = parseInt(m[1], 16)
  const r = clamp255(255 + ((n >> 16) & 255) * t - 255 * t)
  const g = clamp255(255 + ((n >> 8) & 255) * t - 255 * t)
  const b = clamp255(255 + (n & 255) * t - 255 * t)
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/**
 * The colour a fill should actually draw.
 *
 * Prefers the swatch when the reference resolves, so a stale cached `color`
 * never wins over the swatch it claims to come from. Falls back to the cached
 * value when the swatch is gone — a deleted swatch should leave the artwork
 * looking the same, not turn it black.
 */
export function resolveFillColor(body: DesignBody, fill: (SlideFill & SwatchRef) | undefined): string | undefined {
  if (!fill) return undefined
  if (fill.swatchId) {
    const s = findSwatch(body, fill.swatchId)
    if (s) return tintedColor(s.color, fill.tint)
  }
  return fill.color
}

/** Every element id whose fill or border points at this swatch. */
export function swatchUsage(body: DesignBody, swatchId: string): string[] {
  const out: string[] = []
  const pages = body.pages?.length ? body.pages : [{ elements: body.elements ?? [] }]
  for (const page of pages) {
    for (const e of page.elements ?? []) {
      const f = (e as { fill?: SwatchRef }).fill
      if (f?.swatchId === swatchId) out.push(e.id)
    }
  }
  return out
}

/**
 * Map every element on every page, returning a new body only if something
 * changed — and PRESERVING the active page's mirror.
 *
 * A design body deliberately stores the active page's elements twice: the
 * editor's syncActivePage assigns `pages[active].elements = body.elements`,
 * the same array, so single-page code paths and older readers keep working.
 *
 * The first version of this mapped both copies independently, which quietly
 * broke that: one array became two, and each element became two equal objects
 * where the editor expects one. The colours still looked right, because
 * syncActivePage overwrites the page from the top level on the next commit,
 * which is exactly why it would have gone unnoticed — while doubling the
 * objects, doing the work twice, and destroying the identity that undo
 * diffing and reference-based reconciliation rely on.
 *
 * So the active page reuses the SAME mapped array rather than mapping again.
 */
function mapElements(body: DesignBody, fn: (e: SlideElement) => SlideElement): DesignBody {
  // Returns the original array when nothing in it changed, so identity is a
  // reliable "did this change" signal for callers.
  const run = (els: SlideElement[]): SlideElement[] => {
    let touched = false
    const next = els.map((e) => {
      const r = fn(e)
      if (r !== e) touched = true
      return r
    })
    return touched ? next : els
  }

  const original = body.elements ?? []
  const elements = run(original)
  const active = body.activePage ?? 0
  let changed = elements !== original

  const pages = body.pages?.map((p, i) => {
    const own = p.elements ?? []
    // The mirrored page shares the top level's array; give it the same mapped
    // array back rather than a second copy of the same work.
    if (i === active && own === original) {
      if (elements === original) return p
      return { ...p, elements }
    }
    const mapped = run(own)
    if (mapped === own) return p
    changed = true
    return { ...p, elements: mapped }
  })

  if (!changed) return body
  return { ...body, ...(pages ? { pages } : {}), elements }
}

/**
 * Change a swatch and bring every reference with it.
 *
 * This is the whole point of a named colour, and it is also why the cached
 * `color` on each fill is safe: it is never left stale, because the only way
 * to change a swatch rewrites them all in the same operation.
 */
export function applySwatchEdit(body: DesignBody, swatchId: string, patch: Partial<Omit<DesignSwatch, 'id'>>): DesignBody {
  const swatches = body.swatches ?? []
  const existing = swatches.find((s) => s.id === swatchId)
  if (!existing || existing.locked) return body
  const updated: DesignSwatch = { ...existing, ...patch }
  // An edit that changes nothing returns the SAME body. The document is React
  // state, so a fresh object is a re-render of the whole canvas, and a colour
  // picker emits a change on every drag of its cursor.
  if ((Object.keys(patch) as Array<keyof DesignSwatch>).every((k) => sameValue(existing[k], updated[k])))
    return body
  const withSwatch: DesignBody = {
    ...body,
    swatches: swatches.map((s) => (s.id === swatchId ? updated : s))
  }
  return mapElements(withSwatch, (e) => {
    const f = (e as { fill?: SlideFill & SwatchRef }).fill
    if (!f || f.swatchId !== swatchId) return e
    const color = tintedColor(updated.color, f.tint)
    if (color === f.color) return e
    return { ...e, fill: { ...f, color } } as SlideElement
  })
}

/**
 * Point a fill at a swatch, caching the resolved colour alongside.
 *
 * No tint means FULL STRENGTH, so any tint the fill was carrying is cleared.
 * Keeping it left the fill self-contradictory — the cached colour at 100% and
 * a tint of 20 next to it — and nothing looked wrong until something resolved
 * the pair later (deleting the swatch, or re-opening the file), at which point
 * the artwork changed colour on its own. A fill must always draw what its own
 * (swatch, tint) pair resolves to.
 */
export function assignSwatch(
  fill: SlideFill & SwatchRef,
  swatch: DesignSwatch,
  tint?: number
): SlideFill & SwatchRef {
  const next: SlideFill & SwatchRef = { ...fill, swatchId: swatch.id, color: tintedColor(swatch.color, tint) }
  if (tint === undefined) delete next.tint
  else next.tint = tint
  return next
}

/** Drop the link but keep the colour, so detaching never changes the artwork. */
export function detachSwatch(body: DesignBody, fill: SlideFill & SwatchRef): SlideFill {
  const color = resolveFillColor(body, fill)
  const next = { ...fill, ...(color ? { color } : {}) }
  delete (next as SwatchRef).swatchId
  delete (next as SwatchRef).tint
  return next
}

/**
 * The swatches a new document starts with.
 *
 * Brand colours are locked: they come from the organisation's brand kit, and
 * a document quietly redefining "Brand primary" to something else is how a
 * brand stops being one. Editing the kit is the way to change them.
 */
export function defaultSwatches(brand: OrgBrandKit = DEFAULT_BRAND_KIT): DesignSwatch[] {
  const out: DesignSwatch[] = [
    { id: 'brand-primary', name: 'Brand primary', color: brand.colorPrimary, locked: true }
  ]
  if (brand.colorSecondary)
    out.push({ id: 'brand-secondary', name: 'Brand secondary', color: brand.colorSecondary, locked: true })
  if (brand.colorNeutral)
    out.push({ id: 'brand-neutral', name: 'Brand neutral', color: brand.colorNeutral, locked: true })
  out.push(
    { id: 'black', name: 'Black', color: '#000000' },
    { id: 'white', name: 'White', color: '#ffffff' },
    { id: 'paper', name: 'Paper', color: '#f5f5f4' },
    { id: 'ink', name: 'Ink', color: '#1c1917' }
  )
  return out
}

/** Spot inks used in this document, for preflight and the printer. */
export function spotInks(body: DesignBody): DesignSwatch[] {
  return (body.swatches ?? []).filter((s) => s.spot && swatchUsage(body, s.id).length > 0)
}

// ── Managing the palette ─────────────────────────────────────────────────────

/** A swatch id derived from its name: readable in a saved file, and unique. */
export function swatchId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'swatch'
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

/**
 * Add a swatch. Returns the new body and the id it was given.
 *
 * A document that has never had a palette gets the default one first, so the
 * list a person sees is Brand primary, Black, White, Paper, Ink and then their
 * new colour — not one lonely swatch.
 */
export function addSwatch(
  body: DesignBody,
  swatch: { name: string; color: string; spot?: { inkName: string } },
  brand?: OrgBrandKit
): { body: DesignBody; id: string } {
  const existing = body.swatches ?? defaultSwatches(brand)
  const id = swatchId(swatch.name, existing.map((s) => s.id))
  const next: DesignSwatch = {
    id,
    name: swatch.name.trim() || id,
    color: swatch.color,
    ...(swatch.spot?.inkName.trim() ? { spot: { inkName: swatch.spot.inkName.trim() } } : {})
  }
  return { body: { ...body, swatches: [...existing, next] }, id }
}

/**
 * Delete a swatch without changing the artwork.
 *
 * Every fill that pointed at it keeps the colour it was drawing and loses only
 * the link, which is what detaching means. A locked swatch (a brand colour) is
 * not deletable, and asking is a no-op rather than an error — a disabled
 * button is the UI's job.
 */
export function deleteSwatch(body: DesignBody, id: string): DesignBody {
  const existing = body.swatches ?? []
  const swatch = existing.find((s) => s.id === id)
  if (!swatch || swatch.locked) return body
  const detached = mapElements(body, (e) => {
    const f = (e as { fill?: SlideFill & SwatchRef }).fill
    if (!f || f.swatchId !== id) return e
    return { ...e, fill: detachSwatch(body, f) } as SlideElement
  })
  return { ...detached, swatches: existing.filter((s) => s.id !== id) }
}

/**
 * Point every one of these elements' fills at a swatch, at an optional tint.
 *
 * Elements with no fill are left alone: a text frame or a line has no fill to
 * colour, and inventing one would put a box behind the words.
 */
export function assignSwatchTo(
  body: DesignBody,
  elementIds: string[],
  swatchIdToUse: string,
  tint?: number
): DesignBody {
  const swatch = findSwatch(body, swatchIdToUse)
  if (!swatch || elementIds.length === 0) return body
  const ids = new Set(elementIds)
  return mapElements(body, (e) => {
    if (!ids.has(e.id)) return e
    const f = (e as { fill?: SlideFill & SwatchRef }).fill
    if (!f || f.type === 'none') return e
    const next = assignSwatch(f, swatch, tint)
    if (next.color === f.color && next.swatchId === f.swatchId && next.tint === f.tint) return e
    return { ...e, fill: next } as SlideElement
  })
}
