import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { TIDY_MODES } from '../../src/renderer/src/lib/autoArrange'

// DEC-038 — Tidy has ONE home (the top pill) and its modes are offered as
// icons, not labels.

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

describe('the catalogue', () => {
  it('names every mode once, each with an icon', () => {
    const modes = TIDY_MODES.map((m) => m.opts.mode)
    expect(modes).toEqual(['square', 'vertical', 'horizontal', 'mosaic', 'flow'])
    expect(new Set(modes).size).toBe(modes.length)
    for (const m of TIDY_MODES) {
      expect(m.icon).toBeTruthy()
      // The label survives ONLY as a tooltip / accessible name.
      expect(m.label).toBeTruthy()
    }
  })
})

describe('one home', () => {
  it('the desk right-click menu no longer carries a Tidy submenu', () => {
    const canvas = read('src/renderer/src/components/Canvas.tsx')
    expect(canvas).not.toContain("label: 'Tidy'")
    expect(canvas).not.toContain("label: 'Square grid'")
    expect(canvas).not.toContain("label: 'Columns…'")
    // Auto-arrange itself stays — only Tidy moved.
    expect(canvas).toContain("label: 'Auto-arrange'")
    expect(canvas).toContain("label: 'Group by type'")
    expect(canvas).toContain("label: 'Stack by type'")
  })

  it('the pill owns Tidy, and passes the chosen mode through', () => {
    const canvas = read('src/renderer/src/components/Canvas.tsx')
    // The wiring is now a property on deskActionProps rather than a JSX prop,
    // because the same props feed the docked header row and the floating
    // fallback. What is asserted is unchanged: Canvas forwards the chosen mode
    // straight through to handleAutoArrange.
    expect(canvas).toContain('onTidy: (opts?: Parameters<typeof handleAutoArrange>[0]) => void handleAutoArrange(opts)')
    const pill = read('src/renderer/src/components/FloatingPill.tsx')
    expect(pill).toContain('function TidyControl')
    expect(pill).toContain("from '../lib/autoArrange'")
    // Every layout uses the SAME control — the old code had the button
    // duplicated, which is how a menu gets added to one and forgotten on the
    // other. There are two uses: the vertical rail, and the shared buttonRow
    // that serves BOTH the horizontal pill and the docked header bar.
    expect((pill.match(/<TidyControl/g) ?? []).length).toBe(2)
    expect(pill).toContain('const buttonRow = (')
    expect(pill).not.toContain('onClick={onTidy} disabled={tidyDisabled}')
  })

  it('the exact column/row count buttons are gone (DEC-040)', () => {
    // "I shouldn't need to select the amount" — square grid derives a balanced
    // shape from the item count instead.
    const pill = read('src/renderer/src/components/FloatingPill.tsx')
    expect(pill).not.toContain('TIDY_COUNTS')
    expect(pill).not.toContain('tidy-cols-')
    expect(pill).not.toContain('tidy-rows-')
  })

  it('the modes render as ICONS — labels only as tooltip/aria', () => {
    const pill = read('src/renderer/src/components/FloatingPill.tsx')
    // Driven from the catalogue, so a new mode cannot appear in one place only.
    expect(pill).toContain('TIDY_MODES.map')
    expect(pill).toContain('title={m.label}')
    expect(pill).toContain('aria-label={m.label}')
    expect(pill).toContain('<Icon name={m.icon}')
    // No visible mode text in the menu.
    expect(pill).not.toContain('{m.label}</')
  })

  it('hovering opens it, and leaving does not close it instantly', () => {
    const pill = read('src/renderer/src/components/FloatingPill.tsx')
    expect(pill).toContain('onMouseEnter')
    // The pointer must cross a gap to reach the menu; closing on the first
    // mouseleave would make it unreachable.
    expect(pill).toContain('scheduleClose')
    expect(pill).toContain('cancelClose')
  })
})
