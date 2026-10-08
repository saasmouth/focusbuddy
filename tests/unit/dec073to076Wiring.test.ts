// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8')
const sidebar = read('src/renderer/src/components/Sidebar.tsx')
const dialog = read('src/renderer/src/components/NewNodeDialog.tsx')
const cal = read('src/renderer/src/components/views/CalendarView.tsx')
const grid = read('src/renderer/src/components/views/WeekTimeGrid.tsx')
const app = read('src/renderer/src/App.tsx')
const frame = read('src/renderer/src/components/widgets/WidgetFrame.tsx')
const bell = read('src/renderer/src/components/attention/BellIcon.tsx')
const triage = read('src/renderer/src/components/MissedTriagePrompt.tsx')

// DEC-073…076 — the operator's build round, pinned as wiring. The pure logic
// is unit-tested in missedTriage.test.ts / widgetAttention.test.ts; these pin
// the surface contracts so a refactor cannot quietly disconnect them.

describe('dec_073 — New Desk: prefilled, focused, and it OPENS', () => {
  it('dec_073_the_button_says_what_it_makes', () => {
    // The point of DEC-073 is the NOUN: the button must say it makes a desk.
    // It asserted '<span>New Desk</span>' exactly, which also pinned the
    // capital D — and that capital was itself the inconsistency, since the
    // tooltip on the same button, and every other label in the app, say
    // "New desk". Matched case-insensitively so the decision this test exists
    // to protect survives without dictating house style.
    expect(sidebar).toMatch(/<span>New desk<\/span>/i)
    // The old tooltip said "New room" over a button that created a desk.
    expect(sidebar).not.toContain('title="New room"')
  })

  it('dec_073_title_prefills_with_the_moment_and_selects_on_focus', () => {
    expect(dialog).toContain('defaultDeskTitle()')
    expect(dialog).toContain('e.currentTarget.select()')
  })

  it('dec_073_creation_navigates_into_the_desk', () => {
    // Previously the desk was created and the user stayed put.
    expect(dialog).toContain("useViewStore.getState().goTask(created.id)")
  })
})

describe('dec_074 — calendar items open and complete in place', () => {
  it('dec_074_rail_rows_open_on_double_click_and_carry_a_checkbox', () => {
    expect(cal).toContain('setEditItem(i)')
    expect(cal).toContain('rail-complete-')
    expect(cal).toContain('<AttentionItemEditor')
  })

  it('dec_074_grid_blocks_open_on_double_click', () => {
    expect(grid).toContain('onDoubleClick')
    expect(grid).toContain('setEditItem(linked!)')
    expect(grid).toContain('<AttentionItemEditor')
  })

  it('dec_074_the_block_check_closes_the_ITEM_through_the_one_path', () => {
    expect(grid).toContain('completeItemAndBlock(block, linked!)')
    expect(grid).toContain('useCloseWorkItem')
    // …and only marks the block done if the close actually happened
    // (the subtask offer can be cancelled).
    expect(grid).toContain('isTerminalState(after.workItemState)')
  })

  it('dec_074_completion_uses_each_queues_own_verb_never_a_flat_done', () => {
    expect(cal).toContain('PRIMARY_ACTION[queueOf(i)]')
    expect(grid).toContain('PRIMARY_ACTION[queueOf(item)]')
  })
})

describe('dec_075 — missed items greet the launch, never silently drop', () => {
  it('dec_075_the_prompt_mounts_at_app_level', () => {
    expect(app).toContain('<MissedTriagePrompt />')
  })

  it('dec_075_once_per_session_and_later_costs_nothing', () => {
    expect(triage).toContain('promptedThisSession')
    expect(triage).toContain('Later')
  })

  it('dec_075_the_record_stays_a_move_books_fresh_time', () => {
    // DEC-052 B4 doctrine: the original flips to missed; a NEW block lands.
    expect(triage).toContain("updateBlock(b.id, { status: 'missed' })")
    expect(triage).toContain('createBlock({')
  })

  it('dec_075_bulk_actions_exist_and_add_all_is_one_undo_batch', () => {
    expect(triage).toContain('missed-add-all')
    expect(triage).toContain('missed-complete-selected')
    expect(triage).toContain('beginBatch()')
    expect(triage).toContain('endBatch(')
  })

  it('dec_075_completing_honours_the_one_close_path_and_cancel', () => {
    expect(triage).toContain('useCloseWorkItem')
    expect(triage).toContain('isTerminalState(after.workItemState)')
  })
})

describe('dec_076 — the widget bell', () => {
  it('dec_076_bell_state_is_derived_from_the_queue_rows', () => {
    expect(frame).toContain('liveItemForWidget(workItems, widget.id)')
    // DEC-077: the brand bell is a line SVG whose Icon `filled` prop is a
    // deliberate no-op — the active state fills the SAME path solid instead.
    expect(frame).toContain('<BellIcon size={13} active={!!attentionItem} />')
    // DEC-125: the bell's SVG moved out of the frame into the shared
    // attention/BellIcon.tsx (the message row wears the same bell now) —
    // the frame imports it; the fill rule lives in the one definition.
    expect(frame).toContain("import BellIcon from '../attention/BellIcon'")
    expect(bell).toContain("fill={active ? 'currentColor' : 'none'}")
    expect(bell).toContain("PLEXII_ICONS['notifications']")
  })

  it('dec_076_outlined_click_runs_the_same_flow_as_the_menu', () => {
    // The one capture seam — preset text into the confirm console; the item
    // POINTS at the widget. No parallel creation path.
    expect(frame).toContain("'fb:command-new-work-item'")
    expect(frame).toContain("sourceType: 'widget'")
    expect(frame).toContain('sourceRef: widget.id')
  })

  it('dec_076_the_check_appears_only_when_there_is_something_to_complete', () => {
    expect(frame).toContain('attentionOn && attentionItem && !titleEditing && (')
    expect(frame).toContain('closeWorkItem(')
    // DEC-077: it is the one shared completion circle, beside the title.
    expect(frame).toContain('<CompleteCircle')
  })

  it('dec_076_respects_the_workItems_flag_like_the_menu_does', () => {
    expect(frame).toContain('workItemsEnabled()')
  })
})
