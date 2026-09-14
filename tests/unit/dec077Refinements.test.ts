// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')
const att = read('src/renderer/src/components/views/AttentionView.tsx')
const cal = read('src/renderer/src/components/views/CalendarView.tsx')
const grid = read('src/renderer/src/components/views/WeekTimeGrid.tsx')
const frame = read('src/renderer/src/components/widgets/WidgetFrame.tsx')
const bell = read('src/renderer/src/components/attention/BellIcon.tsx')
const circle = read('src/renderer/src/components/attention/CompleteCircle.tsx')

// DEC-077 — the operator's refinement round on DEC-073…076: one completion
// circle everywhere, a bell that actually fills, both beside the title; the
// six-dot handle retired from both queues with whole-row drag kept; nesting
// feedback lights the whole target row.

describe('dec_077 — ONE completion circle, adopted everywhere', () => {
  it('dec_077_the_circle_is_a_single_definition', () => {
    // The queue's DEC-050 form factor, extracted — every surface renders THIS.
    expect(circle).toContain('rounded-full border-[1.5px] border-[var(--ink-30)]')
    expect(circle).toContain('hover:border-emerald-500 hover:text-emerald-500 hover:bg-emerald-500/10')
    for (const src of [att, cal, grid, frame]) {
      expect(src).toContain("from '../attention/CompleteCircle'")
      expect(src).toContain('<CompleteCircle')
    }
    // No surface keeps a private circle: the old inline recipe appears only
    // in the component itself.
    for (const src of [att, cal, grid, frame]) {
      expect(src).not.toContain('rounded-full border-[1.5px] border-[var(--ink-30)]')
    }
  })

  it('dec_077_it_swallows_the_host_gestures', () => {
    // Every host is a drag surface (rnd header, grid block, draggable rows)
    // and two hosts open editors on double-click — a completion click must do
    // exactly one thing.
    expect(circle).toContain('onMouseDown={(e) => e.stopPropagation()}')
    expect(circle).toContain('onPointerDown={(e) => e.stopPropagation()}')
    expect(circle).toContain('onDoubleClick={(e) => e.stopPropagation()}')
    expect(circle).toContain('data-row-action')
  })

  it('dec_077_grid_blocks_carry_the_visible_circle_and_the_cluster_narrows', () => {
    // An active work-item block completes via the circle (visible, not
    // hover-revealed); the hover cluster's check then only serves plain
    // blocks and done-undo.
    expect(grid).toContain('block-complete-circle')
    expect(grid).toContain('const itemCompletable =')
    expect(grid).toContain('{!itemCompletable && (')
  })
})

describe('dec_077 — the handle is gone, the row still drags', () => {
  it('dec_077_no_six_dot_handle_in_either_queue', () => {
    expect(att).not.toContain('drag_indicator')
    expect(cal).not.toContain('drag_indicator')
  })

  it('dec_077_the_attention_row_is_the_drag_surface', () => {
    expect(att).toContain('draggable={canDrag && !isOpen}')
    // The payload contract is unchanged — the calendar still reads it.
    expect(att).toContain("e.dataTransfer.setData('text/fb-workitem', i.id)")
  })

  it('dec_077_expanded_rows_keep_text_selection_over_drag', () => {
    // DEC-030's read/copy: selectable notes must select, so an OPEN row does
    // not drag — collapse to move it.
    expect(att).toMatch(/draggable=\{canDrag && !isOpen\}/)
  })
})

describe('dec_077 — nesting lights the whole row', () => {
  it('dec_077_into_state_is_a_row_tint_plus_ring', () => {
    expect(att).toContain(
      // GAP-018 (DEC-086): converted to forms that actually paint.
      "'bg-accent/[0.14] shadow-[inset_0_0_0_2px_rgb(var(--accent)/0.55)]'"
    )
  })

  it('dec_077_one_bg_class_per_state_no_stylesheet_order_roulette', () => {
    // 'into' owns the bg when active; select/hover backgrounds sit in the
    // SAME ternary chain so two bg-* utilities never land on one element.
    const chain = att.slice(
      att.indexOf("isOver && over?.pos === 'into'"),
      att.indexOf('dragId === i.id ||')
    )
    expect(chain).toContain("selected.has(i.id) && selectMode")
    expect(chain).toContain("'hover:bg-accent/5'")
  })
})

describe('dec_077 — the bell fills and sits by the title', () => {
  it('dec_077_active_bell_is_solid_not_just_recoloured', () => {
    // DEC-125: the bell is one shared definition (attention/BellIcon.tsx),
    // rendered by the frame and by the message row — the fill rule is pinned
    // where it now lives; the frame is pinned to render THAT bell.
    expect(bell).toContain("fill={active ? 'currentColor' : 'none'}")
    expect(frame).toContain("import BellIcon from '../attention/BellIcon'")
    expect(frame).toContain('<BellIcon size={13} active={!!attentionItem} />')
  })

  it('dec_077_bell_and_circle_precede_the_right_side_control_array', () => {
    const bellAt = frame.indexOf('widget-bell-')
    // Anchored on the cluster's own class rather than on an exact Tailwind
    // string: the utility list is edited whenever the header is restyled, and
    // an ordering test should not fail for a class being added beside it.
    const rightClusterAt = frame.indexOf('fb-widget-actions')
    expect(bellAt).toBeGreaterThan(0)
    expect(rightClusterAt).toBeGreaterThan(0)
    expect(bellAt).toBeLessThan(rightClusterAt)
  })
})
