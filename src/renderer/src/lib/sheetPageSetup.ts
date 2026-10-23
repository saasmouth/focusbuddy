// PlexiiCells page setup: the two settings Print… and Download ▸ PDF read
// (SheetTab.showGridlines / SheetTab.printArea, shared/types.ts).
//
// Pure body mutators for the page setup UI (Cells registry: print area from
// the selection, a gridlines toggle). Each returns a NEW body and leaves the
// rest of the workbook untouched; clearing a setting deletes the field, so a
// sheet back on its defaults is byte-for-byte what it was before page setup
// existed.

import type { SheetBodyV2, SheetTab } from '@shared/types'
import { colLabel } from './sheetBody'
import { parseA1Range } from './sheetCond'

function patchTab(body: SheetBodyV2, tabIndex: number, patch: (t: SheetTab) => SheetTab): SheetBodyV2 {
  if (!Number.isInteger(tabIndex) || tabIndex < 0 || tabIndex >= body.sheets.length) return body
  const sheets = body.sheets.slice()
  sheets[tabIndex] = patch(body.sheets[tabIndex])
  return { ...body, sheets }
}

/** A1 text for a range: {r1:0,c1:0,r2:9,c2:3} → "A1:D10" (one cell → "A1"). */
export function rangeToA1(r: { r1: number; c1: number; r2: number; c2: number }): string {
  const a = `${colLabel(Math.min(r.c1, r.c2))}${Math.min(r.r1, r.r2) + 1}`
  const b = `${colLabel(Math.max(r.c1, r.c2))}${Math.max(r.r1, r.r2) + 1}`
  return a === b ? a : `${a}:${b}`
}

/**
 * Set or clear a tab's print area. `area` is an A1 range ("A1:H40") or a
 * zero-based box (the selection); null clears it (print the used range).
 * An unparseable range is refused: the body comes back unchanged.
 */
export function setPrintArea(
  body: SheetBodyV2,
  tabIndex: number,
  area: string | { r1: number; c1: number; r2: number; c2: number } | null
): SheetBodyV2 {
  if (area === null) {
    return patchTab(body, tabIndex, (t) => {
      const { printArea: _drop, ...rest } = t
      return rest
    })
  }
  const text = typeof area === 'string' ? area.trim().toUpperCase().replace(/\$/g, '') : rangeToA1(area)
  const parsed = parseA1Range(text)
  if (!parsed) return body
  return patchTab(body, tabIndex, (t) => ({ ...t, printArea: rangeToA1(parsed) }))
}

/** Show or hide a tab's gridlines on paper. true is the default, so it clears the field. */
export function setShowGridlines(body: SheetBodyV2, tabIndex: number, show: boolean): SheetBodyV2 {
  return patchTab(body, tabIndex, (t) => {
    const { showGridlines: _drop, ...rest } = t
    return show ? rest : { ...rest, showGridlines: false }
  })
}

/** A tab's page setup as the UI shows it (defaults filled in). */
export function pageSetupOf(tab: SheetTab): { showGridlines: boolean; printArea: string | null } {
  return { showGridlines: tab.showGridlines !== false, printArea: tab.printArea ?? null }
}

type IndexMap = (i: number) => number | null

/**
 * A print area after a structural edit (insert, delete or move rows/columns),
 * through the SAME old→new index maps fixFormulas gives remapFormulaRefs, so
 * the print area keeps covering the same data the formulas keep pointing at.
 *
 * Every row and column of the area goes through its map; the area becomes the
 * box around the lines that survive. When none of its rows, or none of its
 * columns, survive, the area is cleared (undefined: print the used range), never
 * quietly repointed at cells nobody chose: the #REF! rule, applied to page setup.
 * An absent or unparseable area stays as it is.
 */
export function remapPrintArea(area: string | undefined, mapRow: IndexMap, mapCol: IndexMap): string | undefined {
  if (!area) return area
  const box = parseA1Range(area)
  if (!box) return area
  const span = (a: number, b: number, map: IndexMap): { lo: number; hi: number } | null => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = a; i <= b; i++) {
      const j = map(i)
      if (j === null || j < 0) continue
      lo = Math.min(lo, j)
      hi = Math.max(hi, j)
    }
    return Number.isFinite(lo) ? { lo, hi } : null
  }
  const rows = span(box.r1, box.r2, mapRow)
  const cols = span(box.c1, box.c2, mapCol)
  if (!rows || !cols) return undefined
  return rangeToA1({ r1: rows.lo, c1: cols.lo, r2: rows.hi, c2: cols.hi })
}

/**
 * A tab with its print area remapped (see remapPrintArea): for the structural
 * wrappers beside fixFormulas. A cleared area deletes the field; a tab with no
 * print area is returned as it is.
 */
export function remapTabPrintArea(t: SheetTab, mapRow: IndexMap, mapCol: IndexMap): SheetTab {
  if (!t.printArea) return t
  const next = remapPrintArea(t.printArea, mapRow, mapCol)
  if (next === t.printArea) return t
  const { printArea: _drop, ...rest } = t
  return next === undefined ? rest : { ...rest, printArea: next }
}
