import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// DEC-052 Track A — the calendar tells the truth. These pins hold the
// rewiring facts that made the old surface unused (GAP-007/A-006): a calendar
// that could not see Attention work, ranked by a second scorer, with a drop
// receiver nothing could reach.

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

describe('CalendarView — rewired to the Attention layer', () => {
  const view = read('src/renderer/src/components/views/CalendarView.tsx')

  it('reads work items and ranks with the SAME ranker as the queues', () => {
    expect(view).toContain('useWorkItemStore')
    expect(view).toContain('rankScore')
    // The second-ranker drift risk named in Analysis 24 §4, closed — no
    // import and no call (the word may appear in prose comments):
    expect(view).not.toContain('priorityScore(')
    expect(view).not.toContain("from '../../lib/dashboardScope'")
  })

  it('offers day / 3-day / week / month, persisted', () => {
    expect(view).toContain("{ day: 1, '3day': 3, week: 7 }")
    expect(view).toContain("localStorage.getItem('calendar.mode')")
  })

  it('the queue rail drags with the shared payload; scheduled items sink, never hide', () => {
    expect(view).toContain("e.dataTransfer.setData('text/fb-workitem', i.id)")
    // A future-planned block marks the item placed…
    expect(view).toContain("b.status === 'planned' && b.startMs + b.durationMin * 60000 > nowMs")
    // …which SORTS it down rather than filtering it out.
    expect(view).toContain('if (as !== bs) return as - bs')
  })

  it('a month-cell drop sets the DUE date (month is the deadlines lens)', () => {
    expect(view).toContain('void updateFields(id, { dueAt: iso })')
  })
})

describe('WeekTimeGrid — one grid, parameterised', () => {
  const grid = read('src/renderer/src/components/views/WeekTimeGrid.tsx')

  it('renders 1/3/7 days and a compact rail mode from the same component', () => {
    expect(grid).toContain('days = 7')
    expect(grid).toContain('compact = false')
    expect(grid).toContain('repeat(${days}, minmax(0, 1fr))')
    expect(grid).toContain("const hourPx = compact ? 30 : HOUR_PX")
  })

  it('resolves a block to a WORK ITEM through its own store, not listNodes', () => {
    // listNodes filters work items out by design (S1 pin) — the grid must not
    // route around that by widening it.
    expect(grid).toContain('useWorkItemStore')
    expect(grid).toContain('nodesById.get(block.taskId) ?? itemsById.get(block.taskId)')
  })

  it('dropping an Attention item books it immediately — no composer stop', () => {
    expect(grid).toContain("e.dataTransfer.getData('text/fb-workitem')")
    expect(grid).toContain("void createBlock({ taskId: itemId, title: '', startMs, durationMin: 30 })")
  })

  it('deadlines render as a band ABOVE the grid, distinct from blocks', () => {
    expect(grid).toContain('data-testid="deadline-band"')
    // Active items only — a closed item leaves the band.
    expect(grid).toContain('isTerminalState(i.workItemState)')
  })
})

describe('the surfaces share the one grid (DEC-052 §0)', () => {
  it('the Attention rail embeds the SAME component narrow', () => {
    const blocks = read('src/renderer/src/components/attention/attentionBlocks.tsx')
    expect(blocks).toContain("import WeekTimeGrid from '../views/WeekTimeGrid'")
    expect(blocks).toContain('days={1}')
    expect(blocks).toContain('data-testid="rail-day-grid"')
  })

  it('queue rows publish the payload the grids accept', () => {
    const att = read('src/renderer/src/components/views/AttentionView.tsx')
    expect(att).toContain("e.dataTransfer.setData('text/fb-workitem', i.id)")
  })

  it('Calendar returned to the rail — both states, capability-gated', () => {
    const sidebar = read('src/renderer/src/components/Sidebar.tsx')
    const rows = sidebar.match(/label="Calendar"/g) ?? []
    expect(rows.length).toBe(2)
    expect(sidebar.match(/viewEnabled\('calendar'\)/g)?.length).toBe(2)
  })
})

describe('DEC-052 foundation — the columns the planner and connector need', () => {
  // The schema and its migrations moved out of database.ts when the cloud
  // runtime needed to run them too (src/main/db/migrations.ts, ./schema.ts).
  // Reading all three keeps this pinned to the content, not to a filename.
  const db =
    read('src/main/db/database.ts') + read('src/main/db/migrations.ts') + read('src/main/db/schema.ts')
  const tb = read('src/main/db/timeBlocks.ts')

  it('time_blocks carries origin/locked/push_policy and the external round-trip set', () => {
    for (const col of [
      "'origin', \"TEXT NOT NULL DEFAULT 'manual'\"",
      "'locked', 'INTEGER NOT NULL DEFAULT 0'",
      "'push_policy', \"TEXT NOT NULL DEFAULT 'local'\"",
      "'external_event_id', 'TEXT'",
      "'external_etag', 'TEXT'",
      "'sync_state', 'TEXT'"
    ])
      expect(db).toContain(col)
  })

  it('the status CHECK is dropped by a DYNAMIC rebuild that keeps live columns + the FK', () => {
    expect(db).toContain('function migrateTimeBlocksStatusCheck')
    expect(db).toContain("PRAGMA table_info(time_blocks)")
    expect(db).toContain("if (c.name === 'task_id') return 'task_id TEXT REFERENCES nodes(id) ON DELETE CASCADE'")
  })

  it('origin is a birth fact; locked and pushPolicy are patchable', () => {
    expect(tb).toContain("origin: draft.origin === 'auto' ? 'auto' : 'manual'")
    expect(tb).toContain("['locked', 'locked'")
    expect(tb).toContain("['pushPolicy', 'push_policy'")
    // origin is deliberately absent from the patch column table.
    expect(tb).not.toContain("['origin'")
  })
})

describe('DEC-052 B3/B4 — the planner is preview-first, always', () => {
  const view = read('src/renderer/src/components/views/CalendarView.tsx')
  const grid = read('src/renderer/src/components/views/WeekTimeGrid.tsx')

  it('proposals render as dashed GHOSTS; nothing books without Accept', () => {
    expect(grid).toContain('data-testid="plan-ghost"')
    expect(grid).toContain('border-dashed')
    expect(view).toContain('Nothing is booked until you accept')
    // The write happens only in acceptPlan, with the auto origin.
    expect(view).toContain("origin: 'auto'")
  })

  it('an accepted plan reverses as ONE undo unit', () => {
    expect(view).toContain('beginBatch()')
    // DEC-071 renamed the variable only: acceptPlan now takes an optional
    // SUBSET so the review can drop a block, and the batch counts what was
    // actually taken. The property pinned here is unchanged — one accepted
    // plan is one undo unit.
    // DEC-092: accept can also be a MOVE (reschedule replaces source blocks
    // in the same batch), so the label is conditional. One batch either way.
    expect(view).toContain('pendingMove ? `Moved ${take.length} blocks` : `Planned ${take.length} blocks`')
    expect(view).toContain('async function acceptPlan(only?: PlannedProposal[])')
  })

  it('replan-undone marks missed (the record stays) and re-proposes — never moves', () => {
    expect(view).toContain("await updateBlock(b.id, { status: 'missed' })")
    // No startMs patch anywhere in the replan path: blocks are never moved.
    expect(view).not.toContain('updateBlock(b.id, { startMs')
  })

  it('the intent mode selects via IPC with a keyword floor; empty selection is honest', () => {
    // DEC-090: runPlan gained forceFull ("plan the rest of the day instead"),
    // so the selection reads askText (the intent, or '' when forced full).
    // The pin's point is unchanged: selection goes through the IPC.
    expect(view).toContain('window.api.workItems.planSelect(askText, candidates)')
    const sel = read('src/main/ai/planSelect.ts')
    expect(sel).toContain('return fallback()')
    // DEC-090 sharpened the prompt: empty is not merely "valid" — it is the
    // REQUIRED answer when nothing relates, and time words are excluded
    // from selection. Same doctrine, stronger wording.
    expect(sel).toContain('return {"ids":[]} with a note')
    expect(sel).toContain('Time or day words')
  })
})

describe('DEC-053 — the calendar QA round (operator live QA)', () => {
  const grid = read('src/renderer/src/components/views/WeekTimeGrid.tsx')
  const view = read('src/renderer/src/components/views/CalendarView.tsx')

  it('the clock is a 12-hour cycle, never military', () => {
    expect(grid).toContain("const mer = h < 12 ? 'AM' : 'PM'")
    expect(grid).not.toContain('`${START_HOUR + i}:00`')
  })

  it('drag-to-create selects a span at the 15-minute snap; a still press stays a click', () => {
    expect(grid).toContain('data-testid="drag-select"')
    expect(grid).toContain("if (!cur.moved || at === cur.anchorMs) {")
    expect(grid).toContain('initialDurationMin: durationMin')
    // The dialog opens at exactly the dragged length (the seed moved into
    // BookTimeDialog with the spec-pass-1 rebuild; the pin moved with it).
    const bookTime = read('src/renderer/src/components/BookTimeDialog.tsx')
    expect(bookTime).toContain('useState(initialDurationMin ?? 60)')
  })

  it('DEC-078 — every day is the same raised surface; today is an outline ALONE', () => {
    // History: DEC-053 made today a raised column with a 0.45 ring while the
    // other six days sat on a sunken wash — which read as six-sevenths
    // disabled. DEC-078 (operator QA): uniform raised columns, and today's
    // only differentiator is a LIGHTER accent outline.
    // The ring uses the CONFIGURED accent (slash-opacity). The old
    // ring-[rgba(var(--accent),0.45)] form substituted to an invalid color
    // (space-separated RGB + comma alpha), so DEC-053's ring NEVER painted —
    // box-shadow computed to none. Found by measurement (DEC-078); the
    // repo-wide census of that broken pattern is GAP-018.
    expect(grid).toContain("'border-transparent bg-[var(--surface-raised)] ring-2 ring-accent/35'")
    expect(grid).not.toContain('rgba(var(--accent)')
    expect(grid).toContain("'border-[var(--edge-soft)] bg-[var(--surface-raised)]'")
    // The sunken canvas is gone from the day columns entirely.
    expect(grid).not.toContain("bg-[var(--surface-sunken)]'")
  })

  it('DEC-078 — the hours scroll in their own window; headers stay pinned', () => {
    // Hover the grid and the wheel moves through the day, never the page:
    // the time area is its own scroll container with overscroll contained
    // (Google-style), bounded to the viewport, opening near the current hour.
    // The pinned band above it holds the day headers + deadline chips — which
    // also fixes the old layout where a tall chip stack pushed its own
    // column's canvas out of line with the others.
    expect(grid).toContain("className={`flex overflow-y-auto overscroll-contain pt-2 ${fill ? 'flex-1 min-h-0' : ''}`}" /* DEC-131: `fill` lets a host own the window's height */)
    expect(grid).toContain('el.scrollTop = Math.max(0, (h - START_HOUR - 1) * hourPx)')
    // Taller hours — 44px showed all seventeen rows cramped; the window owns
    // how many are visible now.
    expect(grid).toContain('const HOUR_PX = 56')
    // DEC-079 superseded DEC-078's rail exemption: midnight-to-midnight made
    // full-height a 720px column of mostly night, so the rail windows TWELVE
    // hours and scrolls for the rest — and it opens at the current hour like
    // the big grid (the compact guard left the autoscroll effect).
    expect(grid).toContain("maxHeight: compact ? 12 * hourPx : 'max(280px, calc(100vh - 380px))'")
    expect(grid).not.toContain('if (compact) return')
    // The 12 AM fix: the first gutter label translates 6px up to sit ON its
    // line; pt-2 is the headroom that stops the scroll edge clipping it.
    expect(grid).toContain('overflow-y-auto overscroll-contain pt-2')
    // Follow-up ruling: the day runs MIDNIGHT TO MIDNIGHT. The old 6am–10pm
    // window silently hid anything booked outside it; the scroll window is
    // what decides how many of the 24 hours are visible.
    expect(grid).toContain('const START_HOUR = 0')
    expect(grid).toContain('const END_HOUR = 24')
  })

  it('DEC-079 — a horizontal trackpad swipe pages the range, once per gesture', () => {
    const cal = read('src/renderer/src/components/views/CalendarView.tsx')
    // Horizontal-DOMINANT only (vertical belongs to the time window)…
    expect(cal).toContain('if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return')
    // …accumulated to a threshold, fired ONCE through the same shift() the
    // chevrons use (so day/3-day/week/month all page by their own span)…
    expect(cal).toContain("shift(swipeAcc.current > 0 ? 1 : -1)")
    expect(cal).toContain('swipeLocked.current = true')
    // …and the momentum tail is swallowed until the stream goes quiet.
    expect(cal).toContain('}, 250)')
    expect(cal).toContain('onWheel={onRangeWheel}')
  })

  it('a block dragged onto the rail unschedules — locked blocks refuse', () => {
    expect(grid).toContain('onBlockDragOut(block, d.lastClientX, d.lastClientY)')
    expect(view).toContain('if (block.locked) return false')
    expect(view).toContain('Drop here to unschedule')
  })

  it('the class dropdown filters rail + deadlines + month; New opens capture', () => {
    expect(view).toContain('data-testid="calendar-class-filter"')
    expect(view).toContain("classFilter === 'all' || queueOf(i) === classFilter")
    expect(view).toContain("filterQueue={classFilter === 'all' ? undefined : classFilter}")
    expect(view).toContain('openConsole()')
  })

  it('the planner settings editor writes what the engine reads', () => {
    expect(view).toContain('data-testid="planner-settings"')
    expect(view).toContain('savePlannerSettings(next)')
    // runPlan re-reads persisted settings each run, so edits apply next plan.
    expect(view).toContain('const settings = loadPlannerSettings()')
  })
})

describe('DEC-054 — one visual system across Home, Attention and Calendar', () => {
  const css = read('src/renderer/src/styles/globals.css')
  const att = read('src/renderer/src/components/views/AttentionView.tsx')
  const cal = read('src/renderer/src/components/views/CalendarView.tsx')
  const blocks = read('src/renderer/src/components/attention/attentionBlocks.tsx')

  it('both pages sit on the home page\'s dotted paper', () => {
    expect(att).toContain('paper-texture')
    expect(cal).toContain('paper-texture')
  })

  it('the glass card is the SAME material as the home tile, minus its child-layout rules', () => {
    // The tile forces its children into a column (for widget interiors); a
    // page card owns its own layout, so it gets the material only.
    expect(css).toContain('.fb-glass-card {')
    expect(css).toContain('--glass-pillow-fill')
    expect(css).toContain('var(--shadow-inset-highlight)')
    expect(css).toContain('html.dark .fb-glass-card {')
    // Widgets/cards/rows all read the same tokens — no forked palettes.
    expect(css).toContain('.fb-glass-row {')
  })

  it('blocks, rows and shells adopt it', () => {
    expect(blocks).toContain('fb-glass-card rounded-[var(--radius-card)]')
    expect(att).toContain('fb-glass-row')
    expect(cal).toContain('fb-glass-card')
    expect(cal).toContain('fb-glass-row')
  })

  it('layout responds to the CONTAINER, so the left panel opening cannot squeeze it', () => {
    // The sidebar reserves width via padding on <main>; the window width is
    // unchanged, so viewport breakpoints were blind to it.
    expect(css).toContain('container-type: inline-size')
    expect(css).toContain('@container (min-width: 1040px)')
    expect(att).toContain('fb-cq-att')
    expect(cal).toContain('fb-cq-cal')
    expect(att).toContain('fb-cq ')
    expect(cal).toContain('fb-cq ')
    // The old viewport-based two-column rules are gone from both pages.
    expect(att).not.toContain('xl:grid-cols-[minmax(0,1fr)_340px]')
    expect(cal).not.toContain('xl:grid-cols-[300px_minmax(0,1fr)]')
  })

  it('the calendar toolbar keeps its shape: two rows, mode buttons that cannot compress', () => {
    expect(cal).toContain('min-w-[62px] px-3 h-8')
    expect(cal).toContain('whitespace-nowrap')
    expect(cal).toContain('min-w-[124px]')
  })

  it('grid text is given room instead of being clipped', () => {
    const grid = read('src/renderer/src/components/views/WeekTimeGrid.tsx')
    // Short blocks truncate one line; taller blocks get two and the time.
    expect(grid).toContain("height < 34 ? 'truncate' : 'line-clamp-2'")
    expect(grid).toContain('{height >= 34 && (')
    // The gutter widened so "12 PM" cannot clip.
    expect(grid).toContain("compact ? 'w-8' : 'w-14'")
  })
})

describe('DEC-055 — the queue box, the tight left edge, the rail panel', () => {
  const att = read('src/renderer/src/components/views/AttentionView.tsx')
  const cal = read('src/renderer/src/components/views/CalendarView.tsx')
  const css = read('src/renderer/src/styles/globals.css')

  it('DEC-077 — the six-dot handle is gone; the WHOLE row is the drag surface', () => {
    // History: DEC-055 floated the handle out of the flex flow, DEC-062 gave
    // it a z-order, DEC-070 aligned it to its own depth — and DEC-077 removed
    // it. The row itself is draggable now, so there is no handle to misalign,
    // and no gutter control for the chevron to fight.
    expect(att).not.toContain('drag_indicator')
    expect(att).toContain('draggable={canDrag && !isOpen}')
    // An EXPANDED row opts out so its selectable notes (DEC-030 read/copy)
    // still select text instead of starting a drag.
    expect(att).toContain('cursor-grab active:cursor-grabbing')
  })

  it('DEC-070 — one dashed connector per group, and no per-row segments at all', () => {
    // The reset. Four rounds (DEC-062 → 069) tried to draw the hierarchy as
    // per-row line segments — an elbow here, a trunk there — and every round
    // produced a new seam, because segments drawn by different rows can never
    // be guaranteed to join. The re-baseline (operator ruling, from the
    // inspiration component): the subtree is ONE animated group holding ONE
    // dashed connector. A single element has no joins to misalign, so the
    // whole category of bug is gone — pinned by the ABSENCE of the machinery.
    expect(att).not.toContain('borderBottomLeftRadius')
    expect(att).not.toContain('ELBOW_RISE_PX')
    expect(att).not.toContain('isFirstOfSiblings')
    expect(att).not.toContain('isFirstChild')
    // The connector: dashed, one per group, in the group's queue colour, and
    // positioned off the PARENT's content edge inside the animated wrapper —
    // so it grows and shrinks with the expansion.
    expect(att).toContain('border-l-2 border-dashed')
    expect(att).toContain('CONNECTOR_INSET_PX')
    expect(att).toContain('nestRows(cluster.rows)')
    // The motion: framer, height 0 ↔ auto with staggered children, exits kept
    // alive by AnimatePresence so a collapse animates rather than snaps, and
    // reduced-motion honoured.
    expect(att).toContain('AnimatePresence')
    expect(att).toContain('useReducedMotion')
    expect(att).toContain("height: 'auto'")
    expect(att).toContain('staggerChildren')
  })

  it('DEC-070 — sub-items carry no chrome of their own', () => {
    // The solid queue spine is a TOP-LEVEL cue; an indented row's colour cue
    // is its group's connector. Both at once put two vertical lines beside
    // every sub-item — the clutter the reset was for. The inset-surface and
    // gutter-paint hacks (DEC-062b/066) die with the segments they patched.
    expect(att).toContain('{indentLevel === 0 && (')
    expect(att).not.toContain('!border-t-0')
    expect(att).not.toContain('bg-[var(--surface-base)]')
  })

  it('DEC-077 — no handle geometry remains to misalign', () => {
    // DEC-070's fix pinned the handle 22px off its own row's content. With
    // the handle removed (DEC-077) that geometry must not linger: the only
    // per-row left-offset is the row's own indent padding.
    expect(att).not.toContain('Math.max(2, 8 + indentLevel * INDENT_PX - 22)')
    expect(att).toContain('paddingLeft: `${8 + indentLevel * INDENT_PX}px`')
  })

  it('DEC-062 — the desk header is tinted by its QUEUE, and folds its cluster', () => {
    // The tint is the cue for what kind of work sits under the header (to-do
    // blue, meet green), so it must read the queue — not the generic accent.
    expect(att).toContain('QUEUE_COLOR[q.queue]')
    // Scoped to the header: the generic accent wash is still right elsewhere,
    // it was only wrong as the cue for which QUEUE a cluster holds.
    const header = att.slice(att.indexOf('onClick={() => toggleDeskFold'))
    expect(header.slice(0, 1400)).not.toContain('bg-[rgba(var(--accent),0.06)]')
    // Clicking the header folds; opening the desk moved to the icon so the
    // fold could own the click without losing the capability.
    expect(att).toContain('toggleDeskFold')
    // DEC-070 — the fold renders (or exits) the animated wrapper; the rows are
    // no longer swapped for an empty array, which is what lets the collapse
    // animate instead of snapping.
    expect(att).toContain('{!folded && (')
    expect(att).not.toContain('deskFolded.has(desk.id) ? [] : cluster.rows')
    expect(att).toContain('Open this desk')
  })

  it('DEC-062 — the chevron outranks the handle they share a gutter with', () => {
    // A positioned element paints above a static one whatever the DOM order,
    // so without this the hover-only handle ate every click meant for the
    // persistent expander and subtasks could not be folded.
    expect(att).toContain('relative z-10 shrink-0 w-3.5')
  })

  it('the rail is a solid panel with a CLASS dropdown — the text filter is gone', () => {
    expect(css).toContain('.fb-glass-panel {')
    expect(cal).toContain('fb-glass-panel')
    expect(cal).toContain('data-testid="rail-class-filter"')
    expect(cal).toContain('All open items')
    // The free-text box and its state are retired.
    expect(cal).not.toContain("placeholder=\"Filter items…\"")
    expect(cal).not.toContain('const [query, setQuery]')
  })

  it('both filter controls write ONE truth, so they can never disagree', () => {
    expect(cal.match(/pickClass\(e\.target\.value\)/g)?.length).toBe(2)
    expect(cal.match(/const \[classFilter, setClassFilter\]/g)?.length).toBe(1)
  })
})
