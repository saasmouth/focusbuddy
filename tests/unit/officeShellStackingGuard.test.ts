// Guard: sheets raise BEFORE paint (SPEC §2.6, "sheets stack by recency").
//
// ShellPanel and ShellSidePane tell OfficeShellLayout when they open, and the
// layout lifts the newer one above the other. Done in a passive useEffect, that
// raise runs after paint: for a frame (longer under load) a panel opened over
// the open side pane is drawn UNDER it, and a click there hits the pane. ec's
// long Cells run red-flagged four narrow rows on exactly that, while every
// isolated run was green. In a useLayoutEffect the z-order changes in the commit
// that shows the panel.
//
// A DOM test cannot tell the two apart: render() wraps in act(), which flushes
// passive effects too, so both versions look right afterwards. So this reads
// the source, which fails on the old code by construction.
//
// THIS file is the protection, not the e2e rows. officeShellLayout's "a panel
// opened over the side pane: its close is on top" is a low-yield detector for
// this defect (one red in three long runs, none in two more): a red there does
// not mean the regression is back, and a GREEN there is no evidence the raise is
// still synchronous. Only this guard says that.

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const shell = join(__dirname, '../../src/renderer/src/components/office/shell')
const src = (f: string): string => readFileSync(join(shell, f), 'utf8')

/** The hook whose body (up to its first closing brace) calls raise(<layer>). */
function hookRaising(code: string, layer: 'panels' | 'side'): string | null {
  const re = new RegExp(`(useLayoutEffect|useEffect)\\(\\(\\) => \\{[^}]*?raise\\('${layer}'\\)`, 's')
  return re.exec(code)?.[1] ?? null
}

describe('sheet stacking raises before paint', () => {
  it('ShellPanel raises the panels layer in a layout effect', () => {
    expect(hookRaising(src('ShellPanel.tsx'), 'panels')).toBe('useLayoutEffect')
  })
  it('ShellSidePane raises the side layer in a layout effect', () => {
    expect(hookRaising(src('ShellSidePane.tsx'), 'side')).toBe('useLayoutEffect')
  })
  it('the layout provides raise and applies it as the z-order of the panels column', () => {
    const layout = src('OfficeShellLayout.tsx')
    expect(layout).toMatch(/raise:\s*\(layer: 'panels' \| 'side'\) => void/)
    expect(layout).toMatch(/front === 'panels' \? 'z-50' : 'z-30'/)
  })
})
