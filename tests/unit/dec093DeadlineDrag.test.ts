import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── DEC-093 — the deadline band becomes draggable ───────────────────────────
// Operator: "the items that live above the time slots aren't able to be
// moved, but I should be able to drag those onto my calendar." The band
// chips were click/double-click only, while the day columns had accepted
// 'text/fb-workitem' drops from the queue rail since DEC-052. One payload,
// one drop handler, two sources.

const SRC = join(__dirname, '../..', 'src')
const grid = readFileSync(join(SRC, 'renderer/src/components/views/WeekTimeGrid.tsx'), 'utf-8')

// DEC-144: Attention was renamed Focus and its items are "tasks"; these pins follow the new words.
describe('DEC-093 — a deadline chip drags like a queue row', () => {
  it('the chip is a drag source carrying the SAME payload the grid already accepts', () => {
    expect(grid).toContain("e.dataTransfer.setData('text/fb-workitem', i.id)")
    // the receiving end, unchanged since DEC-052
    expect(grid).toContain("const itemId = e.dataTransfer.getData('text/fb-workitem')")
    expect(grid).toContain("e.dataTransfer.types.includes('text/fb-workitem')")
  })

  it('click and double-click survive the drag affordance', () => {
    const chip = grid.slice(grid.indexOf('data-testid="deadline-band"'))
    expect(chip).toContain('goAttention()')
    expect(chip).toContain('setEditItem(i)')
  })

  it('the title teaches all three gestures', () => {
    expect(grid).toContain('drag onto the grid to book time · click to open Focus')
  })

  it('dragging a chip does NOT ring the queue rail as an unschedule target', () => {
    // Scope to the BAND's own dragstart (the file has others — block moves).
    const band = grid.indexOf('data-testid="deadline-band"')
    const start = grid.indexOf('onDragStart={(e) => {', band)
    const end = grid.indexOf('onClick=', start)
    expect(start).toBeGreaterThan(band)
    // The CALL, not the word — the comment above it names the trap.
    expect(grid.slice(start, end)).not.toContain('onBlockDragActive?.(')
    expect(grid.slice(start, end)).toContain('NOT onBlockDragActive')
  })

  it('the hour scroller autoscrolls at its edges so any hour is reachable', () => {
    expect(grid).toContain('const EDGE = 56')
    expect(grid).toContain('el.scrollTop -= Math.max(6, (r.top + EDGE - y) / 2)')
    expect(grid).toContain('el.scrollTop += Math.max(6, (y - (r.bottom - EDGE)) / 2)')
  })
})
