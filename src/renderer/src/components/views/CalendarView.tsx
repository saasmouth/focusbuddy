import { Fragment, useEffect, useMemo, useState } from 'react'
import type { FbNode } from '@shared/types'
import { intentNamesTopic } from '@shared/planLanguage'
import { useNodeStore } from '../../stores/nodes'
import { useWorkItemStore } from '../../stores/workItems'
import { useTimeBlockStore } from '../../stores/timeBlocks'
import { useViewStore } from '../../stores/view'
import Icon from '../Icon'
import WeekTimeGrid, { type GridGhost } from './WeekTimeGrid'
import ExternalCalendarsPanel from '../calendar/ExternalCalendarsPanel'
import {
  loadPlannerSettings,
  planDay,
  schedulableItems,
  sweepMissed,
  type PlannedProposal,
  parsePlanDay,
  effectivePlanDay,
  reorderOverSlots,
  parsePlanWindow,
  parsePlanSpread,
  planSpread,
  parseReschedule,
  movableToday,
  planSplit
} from '../../lib/attentionPlanner'
import { parseTags } from '../../lib/itemTags'
import { parseMentions } from '../../lib/itemMentions'
import { useActionHistory } from '../../stores/actionHistory'
import { useRef } from 'react'
import {
  PRIMARY_ACTION,
  QUEUE_COLOR,
  QUEUE_LABEL,
  QUEUE_ORDER,
  queueOf,
  queueTint,
  rankScore,
  isTerminalState
} from '../../lib/attentionQueues'
import AttentionItemEditor from '../AttentionItemEditor'
import CompleteCircle from '../attention/CompleteCircle'
import { useCloseWorkItem } from '../attention/useCloseWorkItem'
import { useCaptureConsole } from '../../stores/captureConsole'
import {
  savePlannerSettings,
  type PlannerSettings
} from '../../lib/attentionPlanner'

// The Calendar destination (DEC-052, Analysis 24 §0) — the planning half of
// the Attention layer. The queue rides on the LEFT as a draggable list (the
// Akiflow adjacency: list and grid on screen together, drag between them),
// the grid on the right in Day / 3-Day / Week, plus a Month overview. One
// grid component serves this page wide and the Attention rail narrow.
//
// This view was previously wired to legacy desk tasks and a second ranker
// (priorityScore) — it could not see Attention work at all, which is why the
// tab went unused (GAP-007/A-006). It now reads work items and the SAME
// ranker the queues use, so the two surfaces can never disagree about what
// matters today.

type CalMode = 'day' | '3day' | '5day' | 'week' | 'month' | 'year'

// The spans that render as an hour grid. Month and year are overviews with no
// hour axis, so they are absent here rather than given a fake span.
const MODE_DAYS: Record<Exclude<CalMode, 'month' | 'year'>, number> = {
  day: 1,
  '3day': 3,
  '5day': 5,
  week: 7
}

const isGridMode = (m: CalMode): m is Exclude<CalMode, 'month' | 'year'> =>
  m !== 'month' && m !== 'year'

function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x
}

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function dayMs(d: Date): number {
  return dayStart(d).getTime()
}

/** DEC-094 — minutes as a person says them: 45m · 1h · 4h 45m. The review
 *  header used to read "285 min", which is a number you have to convert
 *  before it means anything. */
function fmtSpan(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

// 6 weeks × 7 days from the Monday on or before the 1st.
function monthGrid(viewMonth: Date): Date[] {
  const first = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1)
  const start = new Date(first)
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7))
  const days: Date[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    days.push(d)
  }
  return days
}

export default function CalendarView(): JSX.Element {
  const items = useWorkItemStore((s) => s.items)
  const wiLoaded = useWorkItemStore((s) => s.loaded)
  const refreshItems = useWorkItemStore((s) => s.refresh)
  const updateFields = useWorkItemStore((s) => s.updateFields)
  const blocks = useTimeBlockStore((s) => s.blocks)
  const createBlock = useTimeBlockStore((s) => s.create)
  const updateBlock = useTimeBlockStore((s) => s.update)
  const nodes = useNodeStore((s) => s.nodes)
  const goAttention = useViewStore((s) => s.goAttention)
  const openConsole = useCaptureConsole((s) => s.openConsole)
  // DEC-074 — item details + inline completion, without leaving the calendar.
  // Double-click (rail row or grid block) opens the same editor the Attention
  // page uses (DEC-036); the checkbox closes with the item's own queue verb
  // through the ONE close path (subtask + desk-complete offers included).
  const closeWorkItem = useCloseWorkItem()
  const [editItem, setEditItem] = useState<FbNode | null>(null)
  const deskChoices = useMemo(
    () => nodes.filter((n) => n.kind === 'task' && !n.archived && !n.sharedRootId),
    [nodes]
  )

  useEffect(() => {
    if (!wiLoaded) void refreshItems()
  }, [wiLoaded, refreshItems])

  const today = new Date()
  const [mode, setMode] = useState<CalMode>(
    () => (localStorage.getItem('calendar.mode') as CalMode) || 'week'
  )
  /**
   * Open one day in full.
   *
   * The month and year grids can only ever show the first few entries in a
   * cell, so a day with anything real on it has to be openable -- otherwise
   * the overview is a dead end and the "+3 more" is a taunt.
   */
  const openDay = (d: Date): void => {
    setAnchor(new Date(d.getFullYear(), d.getMonth(), d.getDate()))
    localStorage.setItem('calendar.mode', 'day')
    setMode('day')
  }

  // The subscriptions sheet. Kept out of global settings on purpose: adding a
  // calendar is something you do while looking at your calendar.
  const [showCalendars, setShowCalendars] = useState(false)

  const pickMode = (m: CalMode): void => {
    localStorage.setItem('calendar.mode', m)
    setMode(m)
  }
  const [anchor, setAnchor] = useState<Date>(() => dayStart(today))
  // DEC-053 — one classification at a time, or all. Persisted like the mode.
  const [classFilter, setClassFilter] = useState<string>(
    () => localStorage.getItem('calendar.classFilter') || 'all'
  )
  const pickClass = (c: string): void => {
    localStorage.setItem('calendar.classFilter', c)
    setClassFilter(c)
  }
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState<PlannerSettings>(() => loadPlannerSettings())
  const patchSettings = (patch: Partial<PlannerSettings>): void => {
    const next = { ...settings, ...patch }
    setSettings(next)
    savePlannerSettings(next)
  }
  // DEC-053 — dragging a block over the queue rail unschedules it.
  const railRef = useRef<HTMLElement | null>(null)
  const [blockDragging, setBlockDragging] = useState(false)

  const rangeStart = useMemo(() => {
    if (mode === 'week') return mondayOf(anchor)
    if (mode === 'month') return new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    if (mode === 'year') return new Date(anchor.getFullYear(), 0, 1)
    // Five days means the working week, so it starts on Monday rather than
    // five days from wherever the anchor happens to sit.
    if (mode === '5day') return mondayOf(anchor)
    return dayStart(anchor)
  }, [anchor, mode])

  function shift(dir: -1 | 1): void {
    const a = new Date(anchor)
    if (mode === 'month') a.setMonth(a.getMonth() + dir)
    else if (mode === 'year') a.setFullYear(a.getFullYear() + dir)
    else a.setDate(a.getDate() + dir * MODE_DAYS[mode])
    setAnchor(a)
  }

  // DEC-079 — trackpad horizontal swipe pages the range: one swipe, one
  // shift(), whatever the mode (day/3-day/week page by their span, month by
  // month — shift() already knows). A trackpad streams dozens of wheel
  // events per gesture, so: only horizontal-DOMINANT deltas count (vertical
  // belongs to the time window), they accumulate to a threshold, the shift
  // fires ONCE, and the rest of the gesture — including its momentum tail —
  // is swallowed until the stream goes quiet. Swipe left = forward in time
  // (natural scrolling's reading direction).
  const swipeAcc = useRef(0)
  const swipeLocked = useRef(false)
  const swipeQuiet = useRef<ReturnType<typeof setTimeout> | null>(null)
  function onRangeWheel(e: React.WheelEvent): void {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    if (swipeQuiet.current) clearTimeout(swipeQuiet.current)
    swipeQuiet.current = setTimeout(() => {
      swipeAcc.current = 0
      swipeLocked.current = false
    }, 250)
    if (swipeLocked.current) return
    swipeAcc.current += e.deltaX
    if (Math.abs(swipeAcc.current) >= 120) {
      shift(swipeAcc.current > 0 ? 1 : -1)
      swipeAcc.current = 0
      swipeLocked.current = true
    }
  }

  const nowMs = Date.now()

  // ── The queue rail: what could be scheduled ───────────────────────────────
  const active = useMemo(
    () =>
      items.filter(
        (i) =>
          !isTerminalState(i.workItemState) &&
          i.detachedFromId == null &&
          !(i.snoozeUntil != null && i.snoozeUntil > nowMs) &&
          (classFilter === 'all' || queueOf(i) === classFilter)
      ),
    [items, nowMs, classFilter]
  )
  // An item with a FUTURE block is already placed — it sinks below the rest
  // (never hidden: nothing leaves the queue without landing somewhere).
  const scheduledIds = useMemo(() => {
    const set = new Set<string>()
    for (const b of blocks) {
      if (b.taskId && b.status === 'planned' && b.startMs + b.durationMin * 60000 > nowMs)
        set.add(b.taskId)
    }
    return set
  }, [blocks, nowMs])
  const railItems = useMemo(() => {
    return [...active].sort((a, b) => {
      const as = scheduledIds.has(a.id) ? 1 : 0
      const bs = scheduledIds.has(b.id) ? 1 : 0
      if (as !== bs) return as - bs
      return rankScore(b, nowMs) - rankScore(a, nowMs)
    })
  }, [active, scheduledIds, nowMs])

  // ── DEC-052 B3/B4 — the planner: preview-first, always ──────────────────
  const [intent, setIntent] = useState('')
  const [proposals, setProposals] = useState<PlannedProposal[] | null>(null)
  const [planNote, setPlanNote] = useState<string | null>(null)
  // DEC-090 — set when an intent honestly matched NOTHING: the note offers
  // "plan the rest of the day instead", and this arms that one-click path.
  const [planOfferFull, setPlanOfferFull] = useState(false)
  // DEC-092 — a RESCHEDULE plan carries the blocks it replaces: accepting
  // books the new blocks AND removes these (same undo batch); a source block
  // whose item got NO proposal stays put — never silently unscheduled.
  const [pendingMove, setPendingMove] = useState<Array<{ blockId: string; itemId: string }> | null>(
    null
  )
  /** DEC-094 — how many days the proposal spans, for the header sentence. */
  const reviewDayCount = useMemo(
    () => new Set((proposals ?? []).map((p) => new Date(p.startMs).toDateString())).size,
    [proposals]
  )
  // DEC-071 — the proposal is REVIEWABLE before it is accepted. A summary line
  // that truncates ("3 blocks proposed · 82 min — Top creative items: Update
  // Chan…") is an assurance, not an explanation: it cannot say WHICH items,
  // WHEN each lands, or WHY it chose them, and the ghosts on the grid cannot be
  // clicked because nothing is booked yet. So the plan opens in a review pane.
  const [reviewOpen, setReviewOpen] = useState(false)
  // DEC-089 — review-sheet interactions: one inline editor at a time (when =
  // date+time, dur = minutes with a typing draft), and the drag in flight.
  const [rowEdit, setRowEdit] = useState<{ uid: string; field: 'when' | 'dur'; draft?: string } | null>(null)
  const [dragRowUid, setDragRowUid] = useState<string | null>(null)
  const [dragRowOver, setDragRowOver] = useState<{ uid: string; pos: 'before' | 'after' } | null>(null)
  // The prompt that produced the current proposal, echoed in the review so the
  // plan can be judged against what was actually asked for.
  const [planIntent, setPlanIntent] = useState('')
  const intentRef = useRef<HTMLTextAreaElement | null>(null)
  // Measure-then-set: collapse to auto first so the field can SHRINK when text
  // is deleted, not just grow. Capped to match the max-h so the scroll takes
  // over instead of the box running away.
  useEffect(() => {
    const el = intentRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 152)}px`
  }, [intent])
  const [planBusy, setPlanBusy] = useState(false)

  /** The day being planned: the visible day, or today when the week shows. */
  const planDayMs = useMemo(() => {
    // Any span wider than a day plans TODAY when today is inside it, and the
    // first day of the span otherwise — planning a day you cannot see is the
    // one behaviour that is never wanted.
    if (mode === 'week' || mode === 'month' || mode === '5day' || mode === 'year') {
      const t = dayMs(new Date())
      const end =
        mode === 'year'
          ? new Date(rangeStart.getFullYear() + 1, 0, 1).getTime()
          : rangeStart.getTime() + (mode === 'month' ? 31 : mode === 'week' ? 7 : 5) * 86_400_000
      return t >= rangeStart.getTime() && t < end ? t : rangeStart.getTime()
    }
    return rangeStart.getTime()
  }, [mode, rangeStart])

  const deskTitles = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of nodes) if (n.kind === 'task') m.set(n.id, n.title || 'Untitled desk')
    return m
  }, [nodes])

  async function runPlan(forceFull = false): Promise<void> {
    if (planBusy) return
    setPlanBusy(true)
    setPlanNote(null)
    setPlanOfferFull(false)
    setPendingMove(null)
    try {
      const opts = { placedIds: scheduledIds, deskTitles }
      const settings = loadPlannerSettings()
      const askText = forceFull ? '' : intent
      // DEC-087 — the demo's "nothing to place" at 6pm: (a) an intent that
      // names a day ("…before noon tomorrow") plans THAT day, not the viewed
      // one; (b) when today's working window has already closed, the plan
      // rolls to tomorrow and says so instead of reporting a full day.
      // DEC-090 — the intent's TIME language now lands too: a window
      // ("first half", "later in the day", "after 2pm") narrows the slots,
      // and "spread across the week" plans several workdays instead of one.
      const named = askText.trim() ? parsePlanDay(askText, nowMs) : null
      const win = askText.trim() ? parsePlanWindow(askText, settings) : null
      const spread = askText.trim() ? parsePlanSpread(askText) : false
      const planSettings = win
        ? { ...settings, dayStartMin: win.startMin, dayEndMin: win.endMin }
        : settings
      const eff = effectivePlanDay(named ?? planDayMs, blocks, planSettings, nowMs)
      const dayNote = eff.rolledToTomorrow
        ? 'Today’s working window has closed — this plans tomorrow instead.'
        : named && named !== planDayMs
          ? `Planning ${new Date(named).toLocaleDateString(undefined, { weekday: 'long' })}.`
          : null
      // DEC-092 — say the buffer out loud when it actually shaped the day.
      const dayHasMeetings = blocks.some(
        (b) =>
          b.status === 'planned' &&
          b.meeting &&
          b.startMs >= eff.dayMs &&
          b.startMs < eff.dayMs + 86_400_000
      )
      const targetDay = {
        dayMs: eff.dayMs,
        note:
          [
            dayNote,
            win ? `Keeping it to ${win.label}.` : null,
            spread ? 'Spreading across the week.' : null,
            dayHasMeetings && planSettings.meetingBufferMin > 0
              ? `Kept ${planSettings.meetingBufferMin} min clear around your meetings.`
              : null
          ]
            .filter(Boolean)
            .join(' ') || null
      }
      let out: PlannedProposal[]
      // DEC-092 — a RESCHEDULE intent ("taking the day off — reschedule the
      // rest of my day, split between tomorrow and wednesday") is a MOVE
      // command over today's remaining blocks, not a topic search. It must
      // never reach the selection model — which would honestly find no
      // "day off" items and answer nothing (the operator's live failure).
      const resched = askText.trim() ? parseReschedule(askText, nowMs) : null
      if (resched) {
        const movable = movableToday(blocks, nowMs)
        const dayName = (ms: number): string =>
          new Date(ms).toDateString() === new Date(nowMs + 86_400_000).toDateString()
            ? 'tomorrow'
            : new Date(ms).toLocaleDateString(undefined, { weekday: 'long' })
        const stayed = blocks.filter(
          (b) =>
            b.status === 'planned' && b.startMs > nowMs && b.startMs < planDayMs + 86_400_000 &&
            b.startMs >= planDayMs && (b.meeting || b.locked)
        ).length
        if (!movable.length) {
          setPlanNote(
            stayed
              ? 'Nothing left today that I can move — what remains is meetings or pinned blocks, and those need you.'
              : 'Nothing left on today to move.'
          )
          setProposals(null)
          return
        }
        const ids = [...new Set(movable.map((b) => b.taskId!))]
        // NOT opts: placedIds excludes already-scheduled items, and the items
        // being MOVED are scheduled today by definition — passing it made
        // every reschedule come back empty (live QA). onlyItemIds is the
        // whole filter here.
        out = planSplit(items, blocks, planSettings, resched.targetDays, nowMs, ids, {
          deskTitles
        })
        if (!out.length) {
          setPlanNote('Those days have no room in the working window — nothing moved.')
          setProposals(null)
          return
        }
        const placedIds = new Set(out.map((o) => o.itemId))
        setPendingMove(
          movable
            .filter((b) => placedIds.has(b.taskId!))
            .map((b) => ({ blockId: b.id, itemId: b.taskId! }))
        )
        const leftBehind = ids.filter((id) => !placedIds.has(id)).length
        setPlanNote(
          [
            `Moving ${placedIds.size} of today’s blocks — ${resched.targetDays.map(dayName).join(' + ')}. Accepting removes them from today.`,
            stayed ? 'Meetings and pinned blocks stay put — those need you.' : null,
            leftBehind ? `${leftBehind} didn’t fit and stays on today.` : null
          ]
            .filter(Boolean)
            .join(' ')
        )
      } else if (askText.trim() && intentNamesTopic(askText)) {
        // Intent mode: the model (or its keyword fallback) picks + orders;
        // placement stays deterministic and local.
        const candidates = schedulableItems(items, nowMs)
          .filter((i) => !scheduledIds.has(i.id))
          .map((i) => ({
            id: i.id,
            title: i.title || '',
            context: [
              ...parseTags(i.tags),
              ...parseMentions(i.mentions).map((mn) => mn.title),
              i.parentId ? deskTitles.get(i.parentId) ?? '' : ''
            ]
              .filter(Boolean)
              .join(', ')
          }))
        const sel = await window.api.workItems.planSelect(askText, candidates)
        if (!sel.ids.length) {
          // DEC-090 — the honest zero, said out loud (operator ruling). An
          // empty selection now SURVIVES from the model (it used to be
          // overridden by keyword noise — the "random items" hallucination),
          // and the answer offers the real alternative instead of guessing.
          setPlanNote(sel.note ?? 'No open items match that.')
          setPlanOfferFull(true)
          setProposals(null)
          return
        }
        out = spread
          ? planSpread(items, blocks, planSettings, targetDay.dayMs, nowMs, {
              ...opts,
              onlyItemIds: sel.ids,
              source: 'intent'
            })
          : planDay(items, blocks, planSettings, targetDay.dayMs, nowMs, {
              ...opts,
              onlyItemIds: sel.ids,
              source: 'intent'
            })
        setPlanNote([sel.note, targetDay.note].filter(Boolean).join(' — ') || null)
      } else {
        out = spread
          ? planSpread(items, blocks, planSettings, targetDay.dayMs, nowMs, opts)
          : planDay(items, blocks, planSettings, targetDay.dayMs, nowMs, opts)
        if (targetDay.note) setPlanNote(targetDay.note)
      }
      setProposals(out.length ? withUids(out) : null)
      // DEC-071 — a plan arrives for REVIEW, not as a fait accompli behind a
      // truncated line. Nothing is booked by opening it.
      if (out.length) {
        setPlanIntent(askText.trim())
        setReviewOpen(true)
      }
      if (!out.length)
        setPlanNote(
          targetDay.note
            ? `${targetDay.note} Still nothing fit — the queue may be empty or waiting on others.`
            : 'Nothing to place — the day is full, or everything left is waiting on someone else.'
        )
    } finally {
      setPlanBusy(false)
    }
  }

  /** B4 — replan undone: mark slipped blocks missed (the record stays; nothing
   *  moves) and re-propose their items into what's left of the day. */
  async function replanUndone(): Promise<void> {
    if (planBusy) return
    setPlanBusy(true)
    setPlanNote(null)
    try {
      const missed = sweepMissed(blocks, nowMs)
      if (!missed.length) {
        setPlanNote('Nothing slipped. Clean slate.')
        setProposals(null)
        return
      }
      for (const b of missed) await updateBlock(b.id, { status: 'missed' })
      const itemIds = [...new Set(missed.map((b) => b.taskId).filter((x): x is string => !!x))]
      const out = planDay(items, blocks, loadPlannerSettings(), planDayMs, nowMs, {
        onlyItemIds: itemIds,
        deskTitles,
        source: 'replan'
      })
      setProposals(out.length ? withUids(out) : null)
      // DEC-071 — a plan arrives for REVIEW, not as a fait accompli behind a
      // truncated line. Nothing is booked by opening it.
      if (out.length) {
        setPlanIntent(intent.trim())
        setReviewOpen(true)
      }
      setPlanNote(
        out.length
          ? `${missed.length} block${missed.length === 1 ? '' : 's'} slipped — marked missed (the record stays), fresh time proposed below.`
          : `${missed.length} slipped block${missed.length === 1 ? '' : 's'} marked missed — no room left today to re-propose.`
      )
    } finally {
      setPlanBusy(false)
    }
  }

  /** DEC-053 — a block released over the rail: delete it (undo-able); the
   *  item drops back into "To schedule" by construction. Locked blocks are
   *  the pin — a pin dropped on the rail stays put. */
  const removeBlock = useTimeBlockStore.getState().remove
  function handleBlockDragOut(
    block: import('@shared/types').TimeBlock,
    x: number,
    y: number
  ): boolean {
    const r = railRef.current?.getBoundingClientRect()
    if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) return false
    if (block.locked) return false
    void removeBlock(block.id)
    return true
  }

  // DEC-089 — review rows need identity that survives editing: itemId can
  // repeat (session splits) and startMs is now mutable. Stamped once per plan.
  const planUidSeq = useRef(0)
  const withUids = (ps: PlannedProposal[]): PlannedProposal[] =>
    ps.map((p) => (p.uid ? p : { ...p, uid: `pp-${++planUidSeq.current}` }))

  /** DEC-089 — drag a review row to a new position: slot ladder holds,
   *  items reassign over it (reorderOverSlots — pure, lib-tested). */
  function reorderProposal(fromUid: string, toUid: string, pos: 'before' | 'after'): void {
    setProposals((prev) => (prev ? reorderOverSlots(prev, fromUid, toUid, pos) : prev))
  }

  /** DEC-089 — inline edits commit straight onto the proposal; accept books
   *  whatever the rows say. Nothing is booked until accept, as ever. */
  function editProposal(uid: string, patch: Partial<Pick<PlannedProposal, 'startMs' | 'durationMin'>>): void {
    setProposals((prev) => (prev ? prev.map((s) => (s.uid === uid ? { ...s, ...patch } : s)) : prev))
  }

  async function acceptPlan(only?: PlannedProposal[]): Promise<void> {
    const take = only ?? proposals
    if (!take || take.length === 0) return
    // One gesture, one undo: the whole accepted plan reverses with a single
    // ⌘Z (the batch seam the AI "Apply all" uses).
    useActionHistory.getState().beginBatch()
    try {
      for (const p of take) {
        await createBlock({
          taskId: p.itemId,
          title: '',
          startMs: p.startMs,
          durationMin: p.durationMin,
          origin: 'auto'
        })
      }
      // DEC-092 — a reschedule REPLACES: the source blocks whose items were
      // actually re-placed leave today, inside the same batch (⌘Z restores
      // both directions). A dropped row keeps its old block where it was.
      if (pendingMove) {
        const accepted = new Set(take.map((p) => p.itemId))
        const rm = useTimeBlockStore.getState().remove
        for (const mv of pendingMove) {
          if (accepted.has(mv.itemId)) await rm(mv.blockId)
        }
      }
    } finally {
      useActionHistory.getState().endBatch(
        pendingMove ? `Moved ${take.length} blocks` : `Planned ${take.length} blocks`
      )
    }
    setPendingMove(null)
    setProposals(null)
    setPlanNote(null)
    setReviewOpen(false)
  }

  /** Drop one block from the proposal without touching the rest. */
  function dropProposal(uid: string): void {
    setProposals((prev) => {
      const next = (prev ?? []).filter((p) => p.uid !== uid)
      if (next.length > 0) return next
      // Emptying the set is the same as discarding it — leaving an empty
      // review open would be a dialog about nothing.
      setReviewOpen(false)
      setPlanNote(null)
      return null
    })
  }

  const ghosts: GridGhost[] = useMemo(
    () => (proposals ?? []).map((p) => ({ ...p })),
    [proposals]
  )

  // ── Month data: due work items (primary) + due desks (secondary) ──────────
  const monthDays = useMemo(() => monthGrid(rangeStart), [rangeStart])
  const dueItemsByDay = useMemo(() => {
    const m = new Map<number, FbNode[]>()
    for (const i of active) {
      if (!i.dueAt) continue
      const t = Date.parse(i.dueAt)
      if (Number.isNaN(t)) continue
      const key = dayMs(new Date(t))
      m.set(key, [...(m.get(key) ?? []), i])
    }
    for (const list of m.values()) list.sort((a, b) => rankScore(b, nowMs) - rankScore(a, nowMs))
    return m
  }, [active, nowMs])
  const dueDesksByDay = useMemo(() => {
    const m = new Map<number, FbNode[]>()
    for (const n of nodes) {
      if (n.kind !== 'task' || n.dueDate == null || n.status === 'done' || n.status === 'parked')
        continue
      const key = dayMs(new Date(n.dueDate))
      m.set(key, [...(m.get(key) ?? []), n])
    }
    return m
  }, [nodes])

  const rangeLabel = useMemo(() => {
    if (mode === 'month')
      return rangeStart.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    if (mode === 'year') return String(rangeStart.getFullYear())
    const end = new Date(rangeStart)
    end.setDate(rangeStart.getDate() + MODE_DAYS[mode] - 1)
    const s = rangeStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    if (mode === 'day') return s
    return `${s} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  }, [mode, rangeStart])

  function railRow(i: FbNode): JSX.Element {
    const hue = QUEUE_COLOR[queueOf(i)] ?? '#64748b'
    const placed = scheduledIds.has(i.id)
    const overdue = i.dueAt && Date.parse(i.dueAt) < nowMs
    return (
      <div
        key={i.id}
        draggable
        onDragStart={(e) => {
          // The grid (and the month cells) read this to book/date the item.
          e.dataTransfer.setData('text/fb-workitem', i.id)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        onDoubleClick={(e) => {
          // DEC-074 — the row opens for reading/editing, same as the queue page.
          e.preventDefault()
          e.stopPropagation()
          setEditItem(i)
        }}
        className={`group relative flex items-center gap-2 rounded-lg fb-glass-row pl-3 pr-2 py-1.5 cursor-grab active:cursor-grabbing hover:bg-accent/5 hover:-translate-y-px transition-all ${
          placed ? 'opacity-60' : ''
        }`}
        title={placed ? `${i.title} — already on the calendar` : `Drag onto the calendar to schedule: ${i.title} (double-click for details)`}
      >
        <span
          aria-hidden
          className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full"
          style={{ backgroundColor: queueTint(hue, 0.55) }}
        />
        {/* DEC-074/077 — the one completion circle; the six-dot handle is
            gone (the whole row drags, and always did). */}
        <CompleteCircle
          size={15}
          onClick={() =>
            void closeWorkItem(i, (PRIMARY_ACTION[queueOf(i)] ?? PRIMARY_ACTION.to_do).state)
          }
          title={`${(PRIMARY_ACTION[queueOf(i)] ?? PRIMARY_ACTION.to_do).label} — close this item`}
          dataTestId={`rail-complete-${i.id}`}
        />
        <span className="min-w-0 flex-1 text-[12px] text-[var(--ink-90)] truncate">{i.title}</span>
        {i.dueAt && (
          <span
            className={`shrink-0 text-[10px] fb-tabular ${overdue ? 'text-rose-500' : 'text-[var(--ink-40)]'}`}
          >
            {new Date(i.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
        {placed && (
          <Icon name="event_available" size={13} className="shrink-0 text-emerald-500" />
        )}
      </div>
    )
  }

  return (
    // DEC-134 — the page is a WINDOW, not a scroll: the header stays pinned,
    // and the rail and the grid take the rest of the height and scroll inside
    // themselves (the same rule DEC-132/133 gave the home tiles and the desk
    // widgets, and DEC-131 gave the assistant's Calendar tab). The hour grid
    // used to bound itself with `calc(100vh - 380px)` and the rail's list
    // with `calc(100vh - 268px)` — numbers that drifted from the real header
    // whenever it wrapped, so a full rail ran under the footer with no way to
    // reach its last rows, and a short window pushed the grid's bottom out of
    // sight. The root keeps `overflow-y-auto` as the safety valve for a window
    // too short to hold the floors below; at any real size nothing scrolls
    // but the regions.
    <div className="h-full flex flex-col overflow-y-auto paper-texture text-[var(--ink-100)]" data-testid="calendar-view">
      <div className="fb-cq w-full max-w-[1600px] mx-auto px-5 lg:px-8 xl:px-10 py-7 flex-1 min-h-0 flex flex-col">
        {/* DEC-054 — the header is TWO stable rows, not one that reflows: a
            title row, then a toolbar that keeps its shape whether the left
            panel is open or closed. The mode switcher never compresses (its
            buttons carry a min width) and the toolbar wraps as a whole
            instead of squeezing its members. */}
        <div className="mb-5 flex flex-col gap-3.5 shrink-0">
          <div className="flex items-end justify-between gap-6 flex-wrap">
            <div className="min-w-0">
              <h1 className="fb-t-title text-[var(--ink-90)]">Calendar</h1>
              <p className="fb-t-body text-[var(--ink-50)] mt-1 max-w-[62ch]">
                Your attention, on the clock. Drag work from the queue into your day — deadlines
                ride above the grid, blocks live in it.
              </p>
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
              <select
                value={classFilter}
                onChange={(e) => pickClass(e.target.value)}
                title="Show one classification"
                className="fb-field h-9 min-w-[124px] bg-[var(--surface-raised)] px-2.5 text-[12.5px] text-[var(--ink-80)] shadow-[0_0_0_1px_var(--edge-hairline)]"
                data-testid="calendar-class-filter"
              >
                <option value="all">All classes</option>
                {QUEUE_ORDER.map((q) => (
                  <option key={q} value={q}>
                    {QUEUE_LABEL[q]}
                  </option>
                ))}
              </select>
              <button
                onClick={() => openConsole()}
                title="Capture a new attention item"
                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-[var(--radius-field)] fb-glass-row fb-press fb-t-label text-[var(--ink-80)] hover:text-[var(--ink-100)] hover:bg-accent/[0.06] transition-colors"
              >
                <Icon name="add" size={15} /> New
              </button>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center rounded-[var(--radius-field)] fb-glass-row p-1 gap-0.5 shrink-0">
              {(
                [
                  ['day', 'Day'],
                  ['3day', '3-Day'],
                  ['5day', '5-Day'],
                  ['week', 'Week'],
                  ['month', 'Month'],
                  ['year', 'Year']
                ] as Array<[CalMode, string]>
              ).map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => pickMode(m)}
                  className={`min-w-[62px] px-3 h-8 fb-t-label fb-press rounded-[calc(var(--radius-field)-3px)] whitespace-nowrap transition-colors ${
                    mode === m
                      ? 'bg-accent/[0.14] text-[var(--ink-100)] shadow-[inset_0_0_0_1px_rgb(var(--accent)/0.3)]'
                      : 'text-[var(--ink-50)] hover:text-[var(--ink-100)] hover:bg-accent/[0.06]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setShowCalendars(true)}
              title="Add or manage subscribed calendars"
              className="h-8 px-2.5 shrink-0 rounded-[var(--radius-field)] fb-glass-row fb-t-label fb-press text-[var(--ink-50)] hover:text-[var(--ink-100)] inline-flex items-center gap-1"
            >
              <Icon name="event_available" size={14} />
              Calendars
            </button>

            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => shift(-1)} className="icon-btn !h-9 !w-9" title="Earlier">
                <Icon name="chevron_left" size={17} />
              </button>
              <button
                onClick={() => setAnchor(dayStart(new Date()))}
                className="h-9 px-3.5 rounded-[var(--radius-field)] fb-glass-row fb-press fb-t-label text-[var(--ink-80)] hover:bg-accent/[0.06] transition-colors"
              >
                Today
              </button>
              <button onClick={() => shift(1)} className="icon-btn !h-9 !w-9" title="Later">
                <Icon name="chevron_right" size={17} />
              </button>
            </div>

            <span className="fb-t-label text-[var(--ink-70)] fb-tabular whitespace-nowrap px-1">
              {rangeLabel}
            </span>
          </div>
        </div>

        <div className="fb-cq-cal flex-1 min-h-0">
          {/* The queue rail — the half you drag FROM. DEC-134: it hugs a short
              list and is capped at the window (max-h-full of its grid area),
              its list scrolling under the pinned title and filter; it no
              longer needs to stick, because the page no longer scrolls past
              it. */}
          <aside
            ref={railRef}
            className={`fb-cq-rail flex-col gap-2 max-h-full min-h-0 rounded-xl transition-shadow ${
              blockDragging ? 'ring-2 ring-accent/45 ring-offset-4 ring-offset-[var(--surface-base)]' : ''
            }`}
            data-testid="calendar-rail"
          >
            {/* DEC-055 — the panel is a SOLID glass surface, not a list lying
                on the dotted paper, and it filters by CLASSIFICATION (the
                free-text box is gone). The dropdown writes the same one
                filter the header shows, so there is a single truth with two
                places to reach it. */}
            <div className="rounded-[var(--radius-card)] fb-glass-panel p-3 flex flex-col gap-2.5 min-h-0">
              <div className="flex items-center gap-2 shrink-0">
                <Icon name="notifications" size={14} className="text-[var(--ink-40)]" />
                <span className="fb-t-label text-[var(--ink-70)] flex-1 min-w-0 truncate">
                  {blockDragging ? 'Drop here to unschedule' : 'To schedule'}
                </span>
                <button
                  onClick={goAttention}
                  className="fb-t-caption text-[var(--ink-40)] hover:text-[var(--ink-80)] fb-press shrink-0"
                >
                  Open Attention
                </button>
              </div>
              <select
                value={classFilter}
                onChange={(e) => pickClass(e.target.value)}
                title="Filter this list by classification"
                data-testid="rail-class-filter"
                className="fb-field w-full shrink-0 bg-[var(--surface-sunken)] px-2.5 py-1.5 text-[12.5px] text-[var(--ink-80)]"
              >
                <option value="all">All open items</option>
                {QUEUE_ORDER.map((q) => (
                  <option key={q} value={q}>
                    {QUEUE_LABEL[q]}
                  </option>
                ))}
              </select>
              <div className="flex flex-col gap-1.5 min-h-0 overflow-y-auto pr-0.5 -mr-0.5" data-testid="calendar-rail-list">
                {railItems.length === 0 ? (
                  <div className="text-[11.5px] text-[var(--ink-30)] py-6 text-center leading-relaxed">
                    {classFilter === 'all'
                      ? 'Nothing needs scheduling. Clear runway.'
                      : `Nothing open in ${QUEUE_LABEL[classFilter] ?? 'this class'}.`}
                  </div>
                ) : (
                  railItems.map(railRow)
                )}
              </div>
            </div>
          </aside>

          {/* DEC-134 — the grid column stretches to the window's floor (the
              rail's grid row is the window; `self-stretch` overrides the
              row's `align-items: start`, which the rail keeps so it can hug):
              the plan bar stays put, the grid or the month takes the rest. */}
          <div className="min-w-0 min-h-0 self-stretch flex flex-col" onWheel={onRangeWheel} data-testid="calendar-main">
            {mode !== 'month' && (
              <div className="mb-3 flex flex-col gap-2 shrink-0" data-testid="plan-bar">
                <div className="flex items-start gap-2 rounded-[var(--radius-card)] fb-glass-card pl-3.5 pr-2 py-2">
                  {/* DEC-092 — mt centres the ii mark on the FIRST line of the
                      growable textarea (items-start is deliberate, DEC-071;
                      without the offset the mark floats ~6px high). */}
                  <Icon name="auto_awesome" size={15} className="shrink-0 mt-[6px] text-[rgb(var(--accent))]" />
                  {/* DEC-071 — a textarea that grows with what you type. It
                      was a single-line input, so a real intent prompt ("I'm
                      feeling extra creative right now. Good ideas are flowing,
                      so review all of my rooms, desks, and…") scrolled out of
                      sight while being written. You cannot check the sentence
                      you are asking the planner to act on if you can only see
                      the last third of it. Enter still plans; Shift+Enter is a
                      newline. Capped at ~7 lines, then it scrolls — the field
                      must not push the calendar off the screen. */}
                  <textarea
                    ref={intentRef}
                    rows={1}
                    value={intent}
                    onChange={(e) => setIntent(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void runPlan()
                      }
                    }}
                    placeholder="What's this day about? (optional — leave empty and Plexii picks by priority)"
                    className="flex-1 min-w-0 resize-none bg-transparent outline-none text-[13px] leading-[1.45] py-1 max-h-[152px] text-[var(--ink-90)] placeholder:text-[var(--ink-30)]"
                  />
                  <button
                    onClick={() => void runPlan()}
                    disabled={planBusy}
                    className="h-8 px-3 fb-btn-surface fb-press fb-t-label text-[var(--ink-100)] disabled:opacity-50 shrink-0"
                  >
                    {planBusy ? 'Planning…' : 'Plan my day'}
                  </button>
                  <button
                    onClick={() => void replanUndone()}
                    disabled={planBusy}
                    title="Sweep blocks that slipped past (they stay on the record as missed) and propose fresh time for their items"
                    className="h-8 px-3 fb-btn-surface fb-press fb-t-label text-[var(--ink-70)] disabled:opacity-50 shrink-0"
                  >
                    Replan undone
                  </button>
                  <div className="relative shrink-0">
                    <button
                      onClick={() => setShowSettings((v) => !v)}
                      title="Planner settings — working hours, daily ceiling, session length"
                      className="icon-btn !h-8 !w-8"
                      data-testid="planner-settings"
                    >
                      <Icon name="tune" size={15} />
                    </button>
                    {showSettings && (
                      <div className="absolute right-0 top-10 z-30 w-[292px] rounded-[var(--radius-card)] fb-glass-card p-3.5 flex flex-col gap-2.5">
                        <div className="fb-t-label text-[var(--ink-70)]">Planner settings</div>
                        <label className="flex items-center justify-between gap-2 text-[12px] text-[var(--ink-60)]">
                          Day starts
                          <select
                            value={settings.dayStartMin}
                            onChange={(e) => patchSettings({ dayStartMin: Number(e.target.value) })}
                            className="fb-field bg-[var(--surface-sunken)] px-1.5 py-1 text-[12px]"
                          >
                            {Array.from({ length: 13 }, (_, h) => h + 5).map((h) => (
                              <option key={h} value={h * 60}>
                                {h % 12 === 0 ? 12 : h % 12} {h < 12 ? 'AM' : 'PM'}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex items-center justify-between gap-2 text-[12px] text-[var(--ink-60)]">
                          Day ends
                          <select
                            value={settings.dayEndMin}
                            onChange={(e) => patchSettings({ dayEndMin: Number(e.target.value) })}
                            className="fb-field bg-[var(--surface-sunken)] px-1.5 py-1 text-[12px]"
                          >
                            {Array.from({ length: 12 }, (_, k) => k + 12).map((h) => (
                              <option key={h} value={h * 60}>
                                {h % 12 === 0 ? 12 : h % 12} {h < 12 ? 'AM' : 'PM'}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex items-center justify-between gap-2 text-[12px] text-[var(--ink-60)]">
                          Planned work ceiling
                          <select
                            value={settings.maxDailyPlannedMin}
                            onChange={(e) => patchSettings({ maxDailyPlannedMin: Number(e.target.value) })}
                            className="fb-field bg-[var(--surface-sunken)] px-1.5 py-1 text-[12px]"
                          >
                            {[180, 240, 330, 390, 480].map((m) => (
                              <option key={m} value={m}>
                                {(m / 60).toFixed(1).replace('.0', '')} h/day
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex items-center justify-between gap-2 text-[12px] text-[var(--ink-60)]">
                          Drag books instantly
                          {/* Step 9's off switch — flag OFF restores the
                              dialog as what greets a drag (DEC-053 path). */}
                          <input
                            type="checkbox"
                            checked={settings.inlineCreate}
                            onChange={(e) => patchSettings({ inlineCreate: e.target.checked })}
                            data-testid="inline-create-toggle"
                            className="h-4 w-4 accent-[rgb(var(--accent))]"
                          />
                        </label>
                        <label className="flex items-center justify-between gap-2 text-[12px] text-[var(--ink-60)]">
                          Longest sitting
                          <select
                            value={settings.maxSessionMin}
                            onChange={(e) => patchSettings({ maxSessionMin: Number(e.target.value) })}
                            className="fb-field bg-[var(--surface-sunken)] px-1.5 py-1 text-[12px]"
                          >
                            {[45, 60, 90, 120].map((m) => (
                              <option key={m} value={m}>
                                {m} min
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex items-center justify-between gap-2 text-[12px] text-[var(--ink-60)]">
                          Meeting buffer
                          {/* DEC-092 — the operator's rule: never schedule
                              right against an actual meeting. 0 turns it off. */}
                          <select
                            value={settings.meetingBufferMin}
                            onChange={(e) => patchSettings({ meetingBufferMin: Number(e.target.value) })}
                            data-testid="meeting-buffer-select"
                            className="fb-field bg-[var(--surface-sunken)] px-1.5 py-1 text-[12px]"
                          >
                            {[0, 10, 15, 20, 30].map((m) => (
                              <option key={m} value={m}>
                                {m === 0 ? 'off' : `${m} min around meetings`}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex items-center justify-between gap-2 text-[12px] text-[var(--ink-60)]">
                          Breathing room
                          <select
                            value={settings.gapMin}
                            onChange={(e) => patchSettings({ gapMin: Number(e.target.value) })}
                            className="fb-field bg-[var(--surface-sunken)] px-1.5 py-1 text-[12px]"
                          >
                            {[5, 10, 15, 20].map((m) => (
                              <option key={m} value={m}>
                                {m} min between blocks
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="fb-t-caption text-[var(--ink-30)]">
                          The planner reads these next time you plan. Saved on this device.
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                {(proposals || planNote) && (
                  <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-accent/50 bg-accent/[0.06] px-3.5 py-2 backdrop-blur-sm">
                    <Icon name="draw" size={14} className="shrink-0 text-[rgb(var(--accent))]" />
                    {/* DEC-071 — the bar carries the COUNT; the review carries
                        the content. It used to append a truncated note here,
                        which read as an explanation while being unable to
                        finish a sentence. Clicking it reopens the review. */}
                    {proposals ? (
                      <button
                        onClick={() => setReviewOpen(true)}
                        className="fb-t-label text-[var(--ink-80)] flex-1 min-w-0 text-left hover:text-[var(--ink-100)] fb-press"
                      >
                        {proposals.length} block{proposals.length === 1 ? '' : 's'} proposed ·{' '}
                        {proposals.reduce((n, x) => n + x.durationMin, 0)} min
                        <span className="text-[rgb(var(--accent))] ml-1.5">Review</span>
                      </button>
                    ) : (
                      <span className="fb-t-label text-[var(--ink-80)] flex-1 min-w-0">
                        {planNote}
                        {/* DEC-090 — the honest zero comes with the real
                            alternative: one click plans from the full queue
                            instead of the intent silently doing it anyway. */}
                        {planOfferFull && (
                          <button
                            onClick={() => void runPlan(true)}
                            data-testid="plan-offer-full"
                            className="ml-2 text-[rgb(var(--accent))] hover:underline fb-press"
                          >
                            Plan the rest of the day instead
                          </button>
                        )}
                      </span>
                    )}
                    {proposals && (
                      <>
                        <span className="fb-t-caption text-[var(--ink-40)] shrink-0 hidden lg:inline">
                          Nothing is booked until you accept
                        </span>
                        <button
                          onClick={() => void acceptPlan()}
                          className="h-7 px-3 fb-btn-surface fb-press fb-t-label text-[var(--ink-100)] shrink-0"
                        >
                          Accept all
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => {
                        setProposals(null)
                        setPlanNote(null)
                        setPlanOfferFull(false)
                        setPendingMove(null)
                      }}
                      className="icon-btn !h-7 !w-7 shrink-0"
                      title="Clear"
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                )}
              </div>
            )}
            {mode === 'year' ? (
              /* The year: twelve months, each day carrying a real density mark
                 rather than a decorative one -- a dot only where something is
                 actually due, so an empty year reads as empty. Clicking any day
                 opens it. */
              <div
                className="rounded-[var(--radius-card)] fb-glass-card p-3 flex-1 min-h-[240px] overflow-y-auto"
                data-testid="calendar-year"
              >
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
                  {Array.from({ length: 12 }, (_, m) => {
                    const first = new Date(rangeStart.getFullYear(), m, 1)
                    // Monday-first offset, then six weeks so every month has
                    // the same height and the grid does not jump.
                    const lead = (first.getDay() + 6) % 7
                    const cells = Array.from({ length: 42 }, (_, i) => {
                      const d = new Date(rangeStart.getFullYear(), m, 1 - lead + i)
                      return d
                    })
                    return (
                      <div key={m} data-testid="calendar-year-month" className="flex flex-col gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setAnchor(first)
                            localStorage.setItem('calendar.mode', 'month')
                            setMode('month')
                          }}
                          title={`Open ${first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`}
                          className="fb-t-label text-left font-semibold text-[var(--ink-70)] hover:text-[var(--ink-100)] fb-press"
                        >
                          {first.toLocaleDateString(undefined, { month: 'long' })}
                        </button>
                        <div className="grid grid-cols-7 gap-px">
                          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w, i) => (
                            <div
                              key={i}
                              className="text-center text-[9px] font-medium text-[var(--ink-35)]"
                            >
                              {w}
                            </div>
                          ))}
                          {cells.map((d) => {
                            const key = dayMs(d)
                            const inMonth = d.getMonth() === m
                            const isToday = d.toDateString() === today.toDateString()
                            const count =
                              (dueItemsByDay.get(key)?.length ?? 0) +
                              (dueDesksByDay.get(key)?.length ?? 0)
                            return (
                              <button
                                key={key}
                                type="button"
                                onClick={() => openDay(d)}
                                title={
                                  count > 0
                                    ? `${d.toLocaleDateString()} — ${count} due`
                                    : d.toLocaleDateString()
                                }
                                className={`relative aspect-square rounded-[3px] text-[9px] leading-none fb-press flex items-start justify-center pt-[3px] transition-colors ${
                                  inMonth ? 'text-[var(--ink-60)]' : 'text-[var(--ink-25)]'
                                } ${
                                  isToday
                                    ? 'bg-accent/[0.18] font-semibold text-accent'
                                    : 'hover:bg-accent/[0.10]'
                                }`}
                              >
                                {d.getDate()}
                                {count > 0 && inMonth && (
                                  <span
                                    aria-hidden
                                    className="absolute bottom-[2px] left-1/2 -translate-x-1/2 h-[3px] w-[3px] rounded-full bg-accent"
                                  />
                                )}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : mode === 'month' ? (
              /* DEC-134 — the month fills the window too: the weekday row is
                 pinned, and the six weeks share whatever height is left
                 (`minmax(max-content, 1fr)` — never shorter than a cell's own
                 content, taller when there is room, and the grid scrolls when
                 the window cannot hold six weeks at all). */
              <div className="rounded-[var(--radius-card)] fb-glass-card p-3 flex-1 min-h-[240px] flex flex-col" data-testid="calendar-month">
                <div className="grid grid-cols-7 gap-1.5 mb-1.5 shrink-0">
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                    <div key={d} className="text-center fb-t-caption font-semibold text-[var(--ink-40)]">
                      {d}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1.5 flex-1 min-h-0 overflow-y-auto auto-rows-[minmax(max-content,1fr)]" data-testid="calendar-month-cells">
                  {monthDays.map((d) => {
                    const key = dayMs(d)
                    const inMonth = d.getMonth() === rangeStart.getMonth()
                    const isToday = d.toDateString() === today.toDateString()
                    const due = dueItemsByDay.get(key) ?? []
                    const desks = dueDesksByDay.get(key) ?? []
                    return (
                      <div
                        key={key}
                        onDragOver={(e) => {
                          if (e.dataTransfer.types.includes('text/fb-workitem')) e.preventDefault()
                        }}
                        onDrop={(e) => {
                          // Dropping an item on a month day sets its DUE date —
                          // month is the deadlines lens, not the hour grid.
                          const id = e.dataTransfer.getData('text/fb-workitem')
                          if (!id) return
                          e.preventDefault()
                          const iso = new Date(key + 17 * 3600_000).toISOString()
                          void updateFields(id, { dueAt: iso })
                        }}
                        className={`min-h-[104px] rounded-lg p-2 flex flex-col gap-1 transition-colors ${
                          isToday
                            ? 'fb-glass-row ring-2 ring-accent/45'
                            : 'fb-glass-row'
                        } ${inMonth ? '' : 'opacity-40'}`}
                      >
                        <button
                          type="button"
                          onClick={() => openDay(d)}
                          title={`Open ${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}`}
                          className={`fb-t-caption fb-tabular text-left fb-press rounded px-1 -mx-1 hover:bg-accent/[0.10] ${
                            isToday ? 'text-accent font-semibold' : 'text-[var(--ink-40)]'
                          }`}
                        >
                          {d.getDate()}
                        </button>
                        {due.slice(0, 3).map((i) => (
                          <button
                            key={i.id}
                            onClick={goAttention}
                            title={i.title}
                            className="relative w-full text-left truncate rounded-[var(--radius-chip)] pl-2.5 pr-1.5 py-1 text-[11px] leading-snug fb-press"
                            style={{
                              backgroundColor: queueTint(QUEUE_COLOR[queueOf(i)] ?? '#64748b', 0.12),
                              color: 'var(--ink-80)'
                            }}
                          >
                            <span
                              aria-hidden
                              className="absolute left-0 top-0.5 bottom-0.5 w-[2px] rounded-full"
                              style={{
                                backgroundColor: queueTint(QUEUE_COLOR[queueOf(i)] ?? '#64748b', 0.65)
                              }}
                            />
                            {i.title}
                          </button>
                        ))}
                        {due.length > 3 && (
                          <button
                            onClick={() => openDay(d)}
                            title="Open this day"
                            className="fb-t-caption text-[var(--ink-40)] text-left fb-press hover:text-[var(--ink-80)]"
                          >
                            +{due.length - 3} more
                          </button>
                        )}
                        {desks.slice(0, 2).map((n) => (
                          <div
                            key={n.id}
                            title={`Desk due: ${n.title}`}
                            className="flex items-center gap-1 truncate text-[10px] text-[var(--ink-40)]"
                          >
                            <Icon name="desk" size={9} />
                            <span className="truncate">{n.title}</span>
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : (
              /* DEC-134 — `fill`: the grid's pinned band (day headers and
                 deadline chips) stays, and the hours window takes the rest
                 of the card down to the page's floor — the assistant tab's
                 own mode (DEC-131), on the page. The 240px floor is the old
                 `max(280px, …)` guarantee: below it the page scrolls rather
                 than the window collapsing. */
              <div className="rounded-[var(--radius-card)] fb-glass-card p-3 flex-1 min-h-[240px] flex flex-col" data-testid="calendar-grid-card">
              <WeekTimeGrid
                fill
                weekStart={rangeStart}
                days={isGridMode(mode) ? MODE_DAYS[mode] : 1}
                filterQueue={classFilter === 'all' ? undefined : classFilter}
                onBlockDragOut={handleBlockDragOut}
                onBlockDragActive={setBlockDragging}
                ghosts={ghosts}
                onGhostRemove={(itemId) =>
                  setProposals((cur) => {
                    const next = (cur ?? []).filter((p) => p.itemId !== itemId)
                    return next.length ? next : null
                  })
                }
              />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* DEC-071 — the plan review. Centre-peek, same shape as the item editor
          (DEC-065): centred, bounded by the viewport, scrolls internally rather
          than running off a laptop screen.

          It exists because a proposal was previously un-inspectable. The
          summary line truncated, and the ghosts on the grid are not real blocks
          — nothing is booked until accept — so there was nothing to click. You
          could see THAT three blocks were proposed and never which items, when
          each landed, or why the planner chose them. Every one of those facts
          already existed on PlannedProposal; none of them were shown. */}
      {showCalendars && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30 p-6"
          onClick={() => setShowCalendars(false)}
        >
          <div
            className="w-full max-w-[560px] max-h-[80vh] overflow-y-auto rounded-[var(--radius-card)] bg-[var(--surface-raised)] shadow-xl"
            onClick={(e) => e.stopPropagation()}
            data-testid="calendars-sheet"
          >
            <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
              <span className="fb-t-label font-semibold text-[var(--ink-90)]">Calendars</span>
              <button
                type="button"
                onClick={() => setShowCalendars(false)}
                className="rounded p-1 text-[var(--ink-40)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]"
                aria-label="Close"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <ExternalCalendarsPanel />
          </div>
        </div>
      )}

      {editItem && (
        <AttentionItemEditor
          item={editItem}
          desks={deskChoices}
          onClose={(changed) => {
            setEditItem(null)
            if (changed) void refreshItems()
          }}
        />
      )}
      {reviewOpen && proposals && proposals.length > 0 && (
        <div
          className="fb-scrim fixed inset-0 z-[320] flex items-center justify-center p-6"
          onMouseDown={() => setReviewOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Review the proposed plan"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setReviewOpen(false)
            }}
            className="fb-card w-[min(680px,94vw)] px-5 py-4 max-h-full overflow-y-auto"
          >
            <div className="flex items-start gap-2.5">
              {/* DEC-094 — the mark sits in an accent tile, the way it does on
                  the assistant surfaces: this dialog is Plexii speaking. */}
              <span className="mt-0.5 shrink-0 h-7 w-7 rounded-[var(--radius-chip)] bg-accent/15 inline-flex items-center justify-center">
                <Icon name="auto_awesome" size={15} className="text-[rgb(var(--accent))]" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[17px] font-semibold leading-tight text-[var(--ink-100)]">
                  The plan Plexii proposes
                </div>
                <div className="fb-t-caption text-[var(--ink-45)] mt-1">
                  <span className="font-semibold text-[var(--ink-70)]">
                    {proposals.length} block{proposals.length === 1 ? '' : 's'}
                  </span>{' '}
                  · {fmtSpan(proposals.reduce((n, x) => n + x.durationMin, 0))}
                  {reviewDayCount > 1 ? ` across ${reviewDayCount} days` : ''} ·{' '}
                  <span className="text-[var(--ink-50)]">nothing is booked until you accept</span>
                </div>
              </div>
              <button onClick={() => setReviewOpen(false)} className="icon-btn !h-7 !w-7 shrink-0">
                <Icon name="close" size={14} />
              </button>
            </div>

            {/* What was actually asked for, echoed in full — the prompt is the
                thing the plan has to be judged against, and it is the text that
                used to scroll out of the single-line field. */}
            {planIntent && (
              <div className="mt-2.5 pl-[38px] fb-t-body text-[var(--ink-55)] italic break-words">
                “{planIntent}”
              </div>
            )}

            {/* The planner's own note, in full rather than truncated into the bar. */}
            {planNote && (
              <div className="mt-3 flex items-start gap-2 rounded-[var(--radius-row)] border border-accent/25 bg-accent/[0.07] px-3 py-2">
                <Icon
                  name="info"
                  size={13}
                  className="mt-[3px] shrink-0 text-[rgb(var(--accent))]"
                />
                <div className="fb-t-caption text-[var(--ink-70)] whitespace-pre-wrap break-words">
                  {planNote}
                </div>
              </div>
            )}

            {/* Grouped by day, because a plan routinely spans several and a flat
                list makes "when" the hardest thing to read off it. */}
            <div className="mt-3 flex flex-col gap-3">
              {Array.from(
                proposals.reduce((m, p) => {
                  const key = new Date(p.startMs).toDateString()
                  const arr = m.get(key) ?? []
                  arr.push(p)
                  m.set(key, arr)
                  return m
                }, new Map<string, PlannedProposal[]>())
              ).map(([day, ps]) => (
                <div key={day}>
                  <div className="flex items-baseline gap-2 mb-1.5 px-0.5">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ink-60)]">
                      {new Date(ps[0].startMs).toLocaleDateString(undefined, {
                        weekday: 'long',
                        month: 'short',
                        day: 'numeric'
                      })}
                    </span>
                    <span className="flex-1 h-px bg-[var(--edge-soft)]" aria-hidden />
                    <span className="fb-t-caption fb-tabular text-[var(--ink-45)]">
                      {fmtSpan(ps.reduce((n, x) => n + x.durationMin, 0))}
                    </span>
                  </div>
                  {/* DEC-094 — no divide-y: the GAP RULES are the dividers now,
                      and they carry the empty time the old list hid entirely. */}
                  <div className="rounded-[var(--radius-card)] border border-[var(--edge-soft)] bg-[var(--surface-raised)] overflow-hidden">
                    {ps
                      .slice()
                      .sort((a, b) => a.startMs - b.startMs)
                      .map((pr, idx, arr) => {
                        // DEC-089 — honesty over auto-fixing: a hand edit or
                        // a drag can make rows collide. Warn in place; the
                        // operator's own edits are the repair tool.
                        const endMs = pr.startMs + pr.durationMin * 60_000
                        const clash =
                          (proposals ?? []).some(
                            (q) =>
                              q.uid !== pr.uid &&
                              pr.startMs < q.startMs + q.durationMin * 60_000 &&
                              q.startMs < endMs
                          ) ||
                          blocks.some(
                            (b) =>
                              (b.status === 'planned' || b.status === 'done') &&
                              pr.startMs < b.startMs + b.durationMin * 60_000 &&
                              b.startMs < endMs
                          )
                        const editingWhen =
                          rowEdit != null && rowEdit.uid === pr.uid && rowEdit.field === 'when'
                        const editingDur =
                          rowEdit != null && rowEdit.uid === pr.uid && rowEdit.field === 'dur'
                        const localDate = (ms: number): string => {
                          const d = new Date(ms)
                          const mm = String(d.getMonth() + 1).padStart(2, '0')
                          const dd = String(d.getDate()).padStart(2, '0')
                          return `${d.getFullYear()}-${mm}-${dd}`
                        }
                        const localTime = (ms: number): string => {
                          const d = new Date(ms)
                          return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
                        }
                        const commitDur = (): void => {
                          const v = parseInt(rowEdit?.draft ?? '', 10)
                          if (Number.isFinite(v) && v > 0)
                            editProposal(pr.uid!, {
                              durationMin: Math.max(5, Math.round(v / 5) * 5)
                            })
                          setRowEdit(null)
                        }
                        // DEC-094 — the empty time between two rows, which
                        // the old list hid completely. 30m+ reads as "open"
                        // in stronger ink: a real hole you can drop work into.
                        const prev = idx > 0 ? arr[idx - 1] : null
                        const gapMin = prev
                          ? Math.round(
                              (pr.startMs - (prev.startMs + prev.durationMin * 60_000)) / 60_000
                            )
                          : 0
                        return (
                        <Fragment key={pr.uid ?? `${pr.itemId}-${pr.startMs}`}>
                        {prev && gapMin > 0 && (
                          <div
                            data-testid="plan-gap-rule"
                            className="flex items-center gap-2 px-3 py-1 select-none"
                            aria-hidden
                          >
                            <span className="flex-1 h-px bg-[var(--edge-soft)]" />
                            <span
                              className={`fb-t-caption fb-tabular ${
                                gapMin >= 30 ? 'text-[var(--ink-50)]' : 'text-[var(--ink-30)]'
                              }`}
                            >
                              {fmtSpan(gapMin)}
                              {gapMin >= 30 ? ' open' : ''}
                            </span>
                            <span className="flex-1 h-px bg-[var(--edge-soft)]" />
                          </div>
                        )}
                        {prev && gapMin <= 0 && (
                          <div className="mx-3 h-px bg-[var(--edge-soft)]" aria-hidden />
                        )}
                        <div
                          data-testid="plan-review-row"
                          // DEC-089 — the whole row is the drag surface, same
                          // grammar as the Attention queues (DEC-077). The
                          // slot ladder stays; items reorder over it.
                          draggable={rowEdit?.uid !== pr.uid}
                          onDragStart={(e) => {
                            setDragRowUid(pr.uid ?? null)
                            e.dataTransfer.setData('text/fb-planrow', pr.uid ?? '')
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragEnd={() => {
                            setDragRowUid(null)
                            setDragRowOver(null)
                          }}
                          onDragOver={(e) => {
                            if (!dragRowUid || dragRowUid === pr.uid) return
                            e.preventDefault()
                            const r = e.currentTarget.getBoundingClientRect()
                            const pos = e.clientY - r.top < r.height / 2 ? 'before' : 'after'
                            setDragRowOver({ uid: pr.uid!, pos })
                          }}
                          onDragLeave={() =>
                            setDragRowOver((cur) => (cur?.uid === pr.uid ? null : cur))
                          }
                          onDrop={(e) => {
                            e.preventDefault()
                            const from = e.dataTransfer.getData('text/fb-planrow') || dragRowUid
                            const over = dragRowOver
                            setDragRowUid(null)
                            setDragRowOver(null)
                            if (from && over && over.uid === pr.uid)
                              reorderProposal(from, pr.uid!, over.pos)
                          }}
                          title="Drag to reorder — the item takes the slot it lands on"
                          className={`group relative flex items-start gap-3 px-3 py-2.5 cursor-grab active:cursor-grabbing transition-colors hover:bg-accent/[0.05] ${
                            dragRowUid === pr.uid ? 'opacity-40' : ''
                          }`}
                        >
                          {dragRowOver != null && dragRowOver.uid === pr.uid && (
                            <span
                              aria-hidden
                              className={`absolute left-0 right-0 h-0.5 bg-[rgb(var(--accent))] ${
                                dragRowOver.pos === 'before' ? 'top-0' : 'bottom-0'
                              }`}
                            />
                          )}
                          {editingWhen ? (
                            <span
                              className="shrink-0 w-[126px] flex flex-col gap-1"
                              draggable={false}
                              onMouseDown={(e) => e.stopPropagation()}
                              // Focus leaving the WHOLE editor (date and time
                              // both) is what ends the edit — either input can
                              // be the one the operator finishes in.
                              onBlur={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                                  setRowEdit(null)
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  e.stopPropagation()
                                  setRowEdit(null)
                                }
                                if (e.key === 'Enter') setRowEdit(null)
                              }}
                            >
                              <input
                                type="date"
                                autoFocus
                                value={localDate(pr.startMs)}
                                data-testid="plan-row-date"
                                onChange={(e) => {
                                  if (!e.target.value) return
                                  const d = new Date(pr.startMs)
                                  const [y, m, dd] = e.target.value.split('-').map(Number)
                                  d.setFullYear(y, m - 1, dd)
                                  editProposal(pr.uid!, { startMs: d.getTime() })
                                }}
                                className="w-full h-7 px-1.5 rounded-[var(--radius-chip)] bg-[var(--surface-sunken)] border border-[rgb(var(--accent))] outline-none [&:focus-visible]:outline-none text-[11px] fb-tabular text-[var(--ink-90)] [accent-color:rgb(var(--accent))] [color-scheme:inherit]"
                              />
                              <input
                                type="time"
                                value={localTime(pr.startMs)}
                                data-testid="plan-row-time"
                                onChange={(e) => {
                                  if (!e.target.value) return
                                  const [h, min] = e.target.value.split(':').map(Number)
                                  const d = new Date(pr.startMs)
                                  d.setHours(h, min, 0, 0)
                                  editProposal(pr.uid!, { startMs: d.getTime() })
                                }}
                                className="w-full h-7 px-1.5 rounded-[var(--radius-chip)] bg-[var(--surface-sunken)] border border-[rgb(var(--accent))] outline-none [&:focus-visible]:outline-none text-[11px] fb-tabular text-[var(--ink-90)] [accent-color:rgb(var(--accent))] [color-scheme:inherit]"
                              />
                            </span>
                          ) : (
                            <button
                              onClick={() => setRowEdit({ uid: pr.uid!, field: 'when' })}
                              data-testid="plan-row-when"
                              title={`Change the day or start time — ends ${new Date(
                                endMs
                              ).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`}
                              // DEC-094 — the START only. The end is the start
                              // plus the duration chip two columns over: the
                              // old range said one fact twice and wrapped.
                              className="text-[13px] font-medium fb-tabular text-[var(--ink-70)] hover:text-[rgb(var(--accent))] shrink-0 w-[82px] pt-px text-left fb-press rounded transition-colors"
                            >
                              {new Date(pr.startMs).toLocaleTimeString(undefined, {
                                hour: 'numeric',
                                minute: '2-digit'
                              })}
                            </button>
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-[13.5px] font-medium leading-snug text-[var(--ink-100)] break-words">
                              {pr.title}
                            </div>
                            {/* The WHY. It was on the proposal all along and had
                                nowhere to be shown. */}
                            {pr.reason && (
                              <div className="fb-t-caption text-[var(--ink-45)] mt-0.5 break-words">
                                {pr.reason}
                              </div>
                            )}
                            {clash && (
                              <span
                                data-testid="plan-row-clash"
                                title="Overlaps another block — adjust the time or duration"
                                className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
                              >
                                <Icon name="warning" size={11} />
                                overlaps
                              </span>
                            )}
                          </div>
                          {editingDur ? (
                            <input
                              autoFocus
                              type="number"
                              min={5}
                              step={5}
                              value={rowEdit?.draft ?? String(pr.durationMin)}
                              data-testid="plan-row-dur-input"
                              draggable={false}
                              onMouseDown={(e) => e.stopPropagation()}
                              onChange={(e) =>
                                setRowEdit((cur) => (cur ? { ...cur, draft: e.target.value } : cur))
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitDur()
                                if (e.key === 'Escape') {
                                  e.stopPropagation()
                                  setRowEdit(null)
                                }
                              }}
                              onBlur={commitDur}
                              className="w-16 h-7 px-1.5 rounded-[var(--radius-chip)] bg-[var(--surface-sunken)] outline-none [&:focus-visible]:outline-none text-[11px] fb-tabular text-[var(--ink-90)] shrink-0"
                            />
                          ) : (
                            <button
                              onClick={() =>
                                setRowEdit({ uid: pr.uid!, field: 'dur', draft: String(pr.durationMin) })
                              }
                              data-testid="plan-row-dur"
                              title="Change how long this gets"
                              // DEC-094 — a chip, not loose text: it is the
                              // row's second control and should look like one.
                              className="shrink-0 h-7 min-w-[46px] px-2 rounded-[var(--radius-chip)] border border-[var(--edge-strong)] bg-[var(--surface-sunken)] text-[12px] font-medium fb-tabular text-[var(--ink-70)] hover:border-[rgb(var(--accent))] hover:text-[rgb(var(--accent))] fb-press transition-colors"
                            >
                              {fmtSpan(pr.durationMin)}
                            </button>
                          )}
                          <button
                            onClick={() => dropProposal(pr.uid!)}
                            title="Drop this block from the plan"
                            className="icon-btn !h-6 !w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity hover:text-red-500"
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                        </Fragment>
                        )
                      })}
                  </div>
                </div>
              ))}
            </div>

            {/* DEC-094 — the footer sits on its own rule, the hint is quiet,
                and the primary action is unmistakably the primary action. */}
            <div className="mt-4 pt-3 border-t border-[var(--edge-soft)] flex items-center gap-2.5">
              <span className="fb-t-caption text-[var(--ink-40)] flex-1 leading-snug">
                Drag rows to reorder · click a time or duration to edit it.
                <br />
                <span className="text-[var(--ink-30)]">
                  Accepting books {proposals.length} block
                  {proposals.length === 1 ? '' : 's'} — ⌘Z undoes the whole plan.
                </span>
              </span>
              <button
                onClick={() => {
                  setProposals(null)
                  setPlanNote(null)
                  setPendingMove(null)
                  setReviewOpen(false)
                }}
                className="h-9 px-3.5 rounded-[var(--radius-field)] fb-press fb-t-label text-[var(--ink-60)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] transition-colors"
              >
                Discard
              </button>
              <button
                onClick={() => void acceptPlan()}
                className="btn-primary !h-9 !px-4 font-semibold shadow-[0_2px_10px_rgb(var(--accent)/0.35)]"
                data-testid="plan-review-accept"
              >
                <Icon name="check" size={14} />
                <span>Accept plan</span>
                <span aria-hidden className="rounded bg-white/20 px-1 text-[11px] leading-4">
                  ↵
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
