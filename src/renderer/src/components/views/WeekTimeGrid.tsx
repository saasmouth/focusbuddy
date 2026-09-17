import { useEffect, useMemo, useRef, useState } from 'react'
import type { FbNode, TimeBlock } from '@shared/types'
import { useNodeStore } from '../../stores/nodes'
import { useWorkItemStore } from '../../stores/workItems'
import { useTimeBlockStore } from '../../stores/timeBlocks'
import { useExternalEventStore } from '../../stores/externalEvents'
import { colorOfBlock, colorOfCalendar, tint, useCalendarStore } from '../../stores/calendars'
import { useFocusSessionStore } from '../../stores/focusSession'
import { useViewStore } from '../../stores/view'
import { futuristicPowerOn } from '../../lib/audioBeep'
import { blockFit } from '../../lib/calendarGeometry'
import { PRIMARY_ACTION, QUEUE_COLOR, queueOf, queueTint, isTerminalState } from '../../lib/attentionQueues'
import AttentionItemEditor from '../AttentionItemEditor'
import BookTimeDialog from '../BookTimeDialog'
import { bookBlockWithToast } from '../../lib/bookBlock'
import { saveBlockEdit } from '../../lib/blockEdit'
import { loadPlannerSettings } from '../../lib/attentionPlanner'
import { resolvePlaceholder } from '../../lib/bookTime'
import CompleteCircle from '../attention/CompleteCircle'
import { useCloseWorkItem } from '../attention/useCloseWorkItem'
import { joinMeetingRoom } from '../../lib/startMeeting'
import { useGuestCaptureStore } from '../../stores/guestCapture'
import { googleCalendarUrl } from '@shared/ics'
import Icon from '../Icon'

// Week time-grid — the time-blocking surface. Twenty-four hour rows × seven
// day columns, midnight to midnight. Click an empty slot to book a block (tie
// it to a task or leave it as generic focus time), drag a block to reschedule,
// drag its bottom edge to change its length, and start a focus session
// straight from a block.
//
// DEC-078 — the hours live in their OWN scroll window (Google-style): day
// headers + deadline chips stay pinned while the time area scrolls beneath
// them, so a wheel over the grid moves through the day and the page never
// budges. DEC-079: the rail's compact mode windows too — twelve hours on
// screen, the rest a scroll away — since midnight-to-midnight made its
// full-height habit a 720px column of mostly night.

// DEC-078 follow-up (operator): the day runs midnight to midnight. The old
// 6am–10pm window silently HID anything booked outside it — an early flight
// or a late call rendered off-canvas with no hint it existed. All 24 hours
// exist now; the scroll window (below) decides how many are on screen.
const START_HOUR = 0
const END_HOUR = 24 // exclusive-ish; we render rows START_HOUR..END_HOUR-1
// DEC-078 — taller hours, fewer on screen. 44px showed all seventeen rows at
// once and every one of them was cramped; 56px gives each hour real room and
// lets the scroll window own how many are visible.
const HOUR_PX = 56
const SNAP_MIN = 15
const DAY_MS = 86_400_000

function dayStartMs(weekStart: Date, dayIndex: number): number {
  const d = new Date(weekStart)
  d.setDate(weekStart.getDate() + dayIndex)
  return d.getTime()
}

function snapMs(ms: number): number {
  const snap = SNAP_MIN * 60000
  return Math.round(ms / snap) * snap
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

interface Composer {
  dayIndex: number
  startMs: number
  /** DEC-053 — set when a drag selected a span; the composer opens at that
   *  exact length instead of its default. */
  initialDurationMin?: number
  // A node (task or folder) dragged onto the grid — booked directly without
  // the picker.
  prefillNode?: { id: string; title: string; kind: FbNode['kind'] }
  /** Inline create's Cmd+Enter carries the typed draft into the dialog. */
  initialTitle?: string
  /** Step 8 — the Attendant-proposed state (manual trigger only today). */
  proposal?: { reason: string; autoBookAtMs: number }
}

export interface GridGhost {
  itemId: string
  title: string
  startMs: number
  durationMin: number
  reason: string
}

export default function WeekTimeGrid({
  weekStart,
  days = 7,
  compact = false,
  ghosts,
  onGhostRemove,
  filterQueue,
  onBlockDragOut,
  onBlockDragActive,
  fill = false
}: {
  weekStart: Date
  /** How many day columns to render from weekStart (7 = week, 3, 1 = day). */
  days?: number
  /** Narrow-surface mode (the Attention rail): tighter rows, smaller gutter. */
  compact?: boolean
  /** DEC-052 B3 — PROPOSED blocks, rendered dashed until the person accepts.
   *  Nothing here is written; the caller owns the preview-confirm. */
  ghosts?: GridGhost[]
  onGhostRemove?: (itemId: string) => void
  /** DEC-053 — show only one classification's deadlines (undefined = all). */
  filterQueue?: string
  /** DEC-053 — a block pointer-dragged and RELEASED outside the grid: return
   *  true to consume the drop (the caller unschedules); false = normal move. */
  onBlockDragOut?: (block: TimeBlock, clientX: number, clientY: number) => boolean
  /** Fires when a block pointer-drag starts/ends, so the caller can light an
   *  unschedule zone. */
  onBlockDragActive?: (active: boolean) => void
  /** DEC-131 (operator: "fill up the full window… so you can see more on
   *  screen") — the hour window takes ALL the room left under the day
   *  headers instead of the twelve-hour cap; the host owns the height (the
   *  assistant's Calendar tab). */
  fill?: boolean
}): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const blocks = useTimeBlockStore((s) => s.blocks)
  const loadRange = useTimeBlockStore((s) => s.loadRange)
  // Subscribed calendars ride the same window as the blocks.
  const externalEvents = useExternalEventStore((s) => s.events)
  const loadExternal = useExternalEventStore((s) => s.loadRange)
  // Colours come from the calendar an entry belongs to, so a week of mixed
  // sources reads at a glance.
  const calendars = useCalendarStore((s) => s.calendars)
  const loadCalendars = useCalendarStore((s) => s.load)
  const createBlock = useTimeBlockStore((s) => s.create)
  const updateBlock = useTimeBlockStore((s) => s.update)
  const removeBlock = useTimeBlockStore((s) => s.remove)
  const startSession = useFocusSessionStore((s) => s.start)
  const setActive = useNodeStore((s) => s.setActive)
  const goTask = useViewStore((s) => s.goTask)
  const goProject = useViewStore((s) => s.goProject)

  const hourPx = compact ? 30 : HOUR_PX
  const weekFrom = weekStart.getTime()
  const weekTo = weekFrom + days * DAY_MS

  useEffect(() => {
    void loadRange(weekFrom, weekTo)
    void loadExternal(weekFrom, weekTo)
  }, [weekFrom, weekTo, loadRange, loadExternal])

  // Refetch when a background sync lands, so a calendar left open on screen does
  // not quietly go stale between the 15-minute refreshes.
  useEffect(() => {
    void loadCalendars()
  }, [loadCalendars])

  useEffect(() => {
    const api = (window as { api?: Record<string, unknown> }).api
    const ext = api?.externalCalendars as { onEventsChanged?: (cb: () => void) => () => void } | undefined
    return ext?.onEventsChanged?.(() => {
      void loadExternal(weekFrom, weekTo)
      void loadCalendars()
    })
  }, [weekFrom, weekTo, loadExternal, loadCalendars])

  // A block can link to ANY node — a task (focusable), a folder (jump-to), or
  // (DEC-052) a WORK ITEM. Work items never pass through the node store by
  // design (listNodes filters the kind out), so they resolve from their own
  // store — widening listNodes would leak them into every desk surface.
  const workItems = useWorkItemStore((st) => st.items)
  const wiLoaded = useWorkItemStore((st) => st.loaded)
  const refreshItems = useWorkItemStore((st) => st.refresh)
  useEffect(() => {
    if (!wiLoaded) void refreshItems()
  }, [wiLoaded, refreshItems])
  const goAttention = useViewStore((st) => st.goAttention)
  const nodesById = useMemo(() => {
    const m = new Map<string, FbNode>()
    for (const n of nodes) m.set(n.id, n)
    return m
  }, [nodes])
  const itemsById = useMemo(() => {
    const m = new Map<string, FbNode>()
    for (const i of workItems) m.set(i.id, i)
    return m
  }, [workItems])
  // DEC-052 — the deadline band: due Attention items render ABOVE the grid,
  // per day, visually distinct from scheduled blocks (the Akiflow deadline-row
  // convention). Active items only; closing one clears it from the band.
  const dueByDay = useMemo(() => {
    const m = new Map<number, FbNode[]>()
    for (const i of workItems) {
      if (!i.dueAt || isTerminalState(i.workItemState) || i.detachedFromId != null) continue
      if (filterQueue && queueOf(i) !== filterQueue) continue
      const t = Date.parse(i.dueAt)
      if (Number.isNaN(t) || t < weekFrom || t >= weekTo) continue
      const dayIndex = Math.floor((t - weekFrom) / DAY_MS)
      m.set(dayIndex, [...(m.get(dayIndex) ?? []), i])
    }
    for (const list of m.values())
      list.sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))
    return m
  }, [workItems, weekFrom, weekTo, filterQueue])

  // Open the node a block links to: tasks open in the canvas, folders open the
  // project dashboard.
  function jumpToNode(node: FbNode): void {
    if (node.kind === 'work_item') {
      goAttention()
    } else if (node.kind === 'task') {
      setActive(node.id)
      goTask(node.id)
    } else {
      goProject(node.id)
    }
  }

  // DEC-074 — details + completion without leaving the grid. Double-click a
  // work-item block (or a deadline chip) → the DEC-036 editor; the check on a
  // work-item block closes the ITEM with its queue's verb through the one
  // close path, then marks the block done — but only if the close actually
  // happened (the subtask offer can be cancelled; the store's setState
  // refreshes the row before resolving, so re-reading it is authoritative).
  const closeWorkItem = useCloseWorkItem()
  const [editItem, setEditItem] = useState<FbNode | null>(null)
  // Step 9 — inline create: the block exists already; this is just its name
  // being typed in place on the calendar.
  // A booked block double-clicked open for full editing — the Book time
  // dialog is the edit surface (its own step-9 charter).
  const [editBlock, setEditBlockState] = useState<TimeBlock | null>(null)
  const [inlineEdit, setInlineEdit] = useState<{
    blockId: string
    dayIndex: number
    startMs: number
    durationMin: number
    draft: string
  } | null>(null)
  // Step 8 — hold-time doesn't exist yet, so the proposed state fires from a
  // manual trigger: window.__plexiiProposeBlock({ inMin, durationMin,
  // autoBookInMin, reason }) opens the SAME dialog pre-filled with the banner.
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__plexiiProposeBlock = (opts?: {
      inMin?: number
      durationMin?: number
      autoBookInMin?: number
      reason?: string
    }) => {
      const startMs = snapMs(Date.now() + (opts?.inMin ?? 60) * 60_000)
      setComposer({
        dayIndex: 0,
        startMs,
        initialDurationMin: opts?.durationMin ?? 30,
        proposal: {
          reason:
            opts?.reason ??
            'Plexii held this for you. Free window before your 4:30. Change anything, or leave it — it books itself in 20 minutes.',
          autoBookAtMs: Date.now() + (opts?.autoBookInMin ?? 20) * 60_000
        }
      })
    }
    return () => {
      delete (window as unknown as Record<string, unknown>).__plexiiProposeBlock
    }
  }, [])
  const deskChoices = useMemo(
    () => nodes.filter((n) => n.kind === 'task' && !n.archived && !n.sharedRootId),
    [nodes]
  )
  async function completeItemAndBlock(block: TimeBlock, item: FbNode): Promise<void> {
    await closeWorkItem(item, (PRIMARY_ACTION[queueOf(item)] ?? PRIMARY_ACTION.to_do).state)
    const after = useWorkItemStore.getState().items.find((x) => x.id === item.id)
    if (after && isTerminalState(after.workItemState)) {
      await updateBlock(block.id, { status: 'done' })
    }
  }

  const [composer, setComposer] = useState<Composer | null>(null)
  // DEC-053 — Google-style drag-to-create: press on empty grid, drag a span
  // (15-min snap), release → the composer opens for exactly that span. A
  // press that never travels stays a plain click-to-create.
  const [sel, setSel] = useState<{ dayIndex: number; startMs: number; endMs: number } | null>(null)
  const selRef = useRef<{ dayIndex: number; anchorMs: number; moved: boolean } | null>(null)
  // "Add to calendar" menu for a meeting block — anchored at the click point.
  const [calMenu, setCalMenu] = useState<{ block: TimeBlock; x: number; y: number } | null>(null)
  const [drag, setDrag] = useState<{ id: string; previewStart: number; previewDur: number } | null>(
    null
  )
  const dragRef = useRef<{
    id: string
    mode: 'move' | 'resize' | 'resize-top'
    startClientX: number
    startClientY: number
    lastClientX: number
    lastClientY: number
    origStartMs: number
    origDur: number
    origDayIndex: number
    // DEC-087 — true once the pointer travels past the dead zone. Until then
    // the press is a CLICK-in-waiting, not a drag: no preview shift, no
    // commit, and the click that follows opens the editor.
    moved: boolean
  } | null>(null)
  // DEC-087 — a drag that actually moved swallows the click event that the
  // browser fires at pointerup, so drag-release never doubles as open-editor.
  const dragConsumedClickRef = useRef(false)
  // Live refs to each day column so a move-drag can hit-test the pointer's X and
  // reschedule a block onto another day (Google-Calendar-style cross-day drag).
  const colRefs = useRef<(HTMLDivElement | null)[]>([])
  // DEC-078 — the time window opens where the day actually is: on mount,
  // scroll so the current hour sits one row below the top edge. Once; the
  // person owns the scroll position after that.
  const timeScrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = timeScrollRef.current
    if (!el) return
    const h = new Date().getHours() + new Date().getMinutes() / 60
    el.scrollTop = Math.max(0, (h - START_HOUR - 1) * hourPx)
  }, [compact, hourPx])

  // Convert a y offset within a day column to an absolute time for that day.
  function yToMs(dayIndex: number, y: number): number {
    const base = dayStartMs(weekStart, dayIndex) + START_HOUR * 3_600_000
    return base + (y / hourPx) * 3_600_000
  }

  function onColumnPointerDown(e: React.PointerEvent, dayIndex: number): void {
    // Blocks stopPropagation on their own pointerdown, so reaching here means
    // empty grid. Left button only; ignore while a composer is open.
    if (e.button !== 0 || composer) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = e.clientY - rect.top
    const anchorMs = snapMs(yToMs(dayIndex, y))
    selRef.current = { dayIndex, anchorMs, moved: false }
    const onMove = (ev: PointerEvent): void => {
      const cur = selRef.current
      if (!cur) return
      const yy = ev.clientY - rect.top
      const at = snapMs(yToMs(cur.dayIndex, yy))
      if (at !== cur.anchorMs) cur.moved = true
      setSel({
        dayIndex: cur.dayIndex,
        startMs: Math.min(cur.anchorMs, at),
        endMs: Math.max(cur.anchorMs, at) + (at === cur.anchorMs ? 0 : 0)
      })
    }
    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const cur = selRef.current
      selRef.current = null
      setSel(null)
      if (!cur) return
      const yy = ev.clientY - rect.top
      const at = snapMs(yToMs(cur.dayIndex, yy))
      if (!cur.moved || at === cur.anchorMs) {
        // A plain click: composer at the pressed slot, default length.
        setComposer({ dayIndex: cur.dayIndex, startMs: cur.anchorMs })
        return
      }
      const startMs = Math.min(cur.anchorMs, at)
      const durationMin = Math.max(SNAP_MIN, Math.round((Math.abs(at - cur.anchorMs)) / 60000))
      // Step 9 (flagged) — a drag books instantly, named by the SAME
      // placeholder resolution the dialog uses, with the title in inline
      // edit right on the block. The dialog stays the edit/proposal surface;
      // it just stops being what greets a drag. Flag OFF = the DEC-053 path,
      // verbatim, seed and all.
      if (loadPlannerSettings().inlineCreate) {
        const title = resolvePlaceholder({
          mode: 'focus',
          attachedTitle: null,
          guests: [],
          roomName: null
        })
        void createBlock({
          taskId: null,
          title,
          startMs,
          durationMin,
          meeting: null,
          recurrence: null
        }).then((b) =>
          setInlineEdit({ blockId: b.id, dayIndex: cur.dayIndex, startMs, durationMin, draft: '' })
        )
        return
      }
      setComposer({ dayIndex: cur.dayIndex, startMs, initialDurationMin: durationMin })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Dragging a task or folder from the sidebar onto a day column opens the
  // composer pre-filled at the dropped time, so you book it by just confirming
  // how long. The sidebar already publishes the node id as `text/fb-node`.
  function onColumnDragOver(e: React.DragEvent): void {
    if (
      e.dataTransfer.types.includes('text/fb-node') ||
      e.dataTransfer.types.includes('text/fb-workitem')
    ) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  function onColumnDrop(e: React.DragEvent, dayIndex: number): void {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = e.clientY - rect.top
    const startMs = snapMs(yToMs(dayIndex, y))
    // DEC-052 — dropping an ATTENTION item books it immediately: a 30-minute
    // block linked to the item, resizable after the fact. No composer stop —
    // the drag was the decision (Undo covers regret). Title stays empty so
    // the block always renders the item's live title.
    const itemId = e.dataTransfer.getData('text/fb-workitem')
    if (itemId && itemsById.has(itemId)) {
      e.preventDefault()
      void createBlock({ taskId: itemId, title: '', startMs, durationMin: 30 })
      return
    }
    const id = e.dataTransfer.getData('text/fb-node')
    if (!id) return
    e.preventDefault()
    const node = nodes.find((n) => n.id === id)
    if (!node) return
    setComposer({
      dayIndex,
      startMs,
      prefillNode: { id: node.id, title: node.title, kind: node.kind }
    })
  }

  function beginDrag(
    e: React.PointerEvent,
    block: TimeBlock,
    mode: 'move' | 'resize' | 'resize-top'
  ): void {
    e.stopPropagation()
    e.preventDefault()
    dragRef.current = {
      id: block.id,
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      origStartMs: block.startMs,
      origDur: block.durationMin,
      origDayIndex: Math.floor((block.startMs - weekFrom) / DAY_MS),
      moved: false
    }
    if (mode === 'move') onBlockDragActive?.(true)
    setDrag({ id: block.id, previewStart: block.startMs, previewDur: block.durationMin })
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragEnd, { once: true })
  }

  function onDragMove(e: PointerEvent): void {
    const d = dragRef.current
    if (!d) return
    d.lastClientX = e.clientX
    d.lastClientY = e.clientY
    const deltaY = e.clientY - d.startClientY
    // DEC-087 — 5px dead zone (all modes): a sloppy click on a block or its
    // 6px resize lip used to snap a 15-minute step before the hand settled.
    // Below the threshold the press stays a click; past it, it is a drag for
    // good (jitter back through zero must not re-arm the click).
    if (!d.moved && Math.abs(deltaY) < 5 && Math.abs(e.clientX - d.startClientX) < 5) return
    d.moved = true
    const deltaMs = (deltaY / hourPx) * 3_600_000
    if (d.mode === 'move') {
      // Cross-day: find the day column under the pointer's X so a block can be
      // dragged to another day, keeping its time-of-day plus the vertical delta.
      let targetDay = d.origDayIndex
      for (let i = 0; i < days; i++) {
        const r = colRefs.current[i]?.getBoundingClientRect()
        if (r && e.clientX >= r.left && e.clientX <= r.right) {
          targetDay = i
          break
        }
      }
      const timeOfDay = d.origStartMs - dayStartMs(weekStart, d.origDayIndex)
      const newStart = snapMs(dayStartMs(weekStart, targetDay) + timeOfDay + deltaMs)
      setDrag({ id: d.id, previewStart: newStart, previewDur: d.origDur })
    } else if (d.mode === 'resize') {
      const dur = Math.max(SNAP_MIN, Math.round((d.origDur + deltaMs / 60000) / SNAP_MIN) * SNAP_MIN)
      setDrag({ id: d.id, previewStart: d.origStartMs, previewDur: dur })
    } else {
      // resize-top: drag the top edge to start earlier/later, keeping the end fixed.
      const end = d.origStartMs + d.origDur * 60000
      const newStart = Math.min(snapMs(d.origStartMs + deltaMs), end - SNAP_MIN * 60000)
      setDrag({ id: d.id, previewStart: newStart, previewDur: Math.round((end - newStart) / 60000) })
    }
  }

  function onDragEnd(): void {
    window.removeEventListener('pointermove', onDragMove)
    const d = dragRef.current
    dragRef.current = null
    if (d?.mode === 'move') onBlockDragActive?.(false)
    // DEC-087 — the click event that follows this pointerup belongs to the
    // drag, not the editor. (A press that never left the dead zone keeps it.)
    dragConsumedClickRef.current = !!d?.moved
    // DEC-053 — released OUTSIDE the grid (over the queue rail): the caller
    // may consume the drop as an UNSCHEDULE instead of a move.
    if (d && d.mode === 'move' && onBlockDragOut) {
      const block = blocks.find((b) => b.id === d.id)
      if (block && onBlockDragOut(block, d.lastClientX, d.lastClientY)) {
        setDrag(null)
        return
      }
    }
    setDrag((cur) => {
      if (d && cur && cur.id === d.id) {
        if (cur.previewStart !== d.origStartMs || cur.previewDur !== d.origDur) {
          void updateBlock(d.id, { startMs: cur.previewStart, durationMin: cur.previewDur })
        }
      }
      return null
    })
  }

  function focusBlock(block: TimeBlock): void {
    futuristicPowerOn()
    void startSession(block.taskId, block.durationMin * 60, 'planned')
    if (block.taskId) {
      setActive(block.taskId)
      goTask(block.taskId)
    }
  }

  /** Inline create endings: Enter/blur keep the block (typed name wins,
   *  resolved name stays if empty) · Esc removes it · Cmd+Enter promotes to
   *  the full dialog with everything carried over (the block is re-made by
   *  the dialog's own commit, so it is removed here first). */
  async function finishInline(keepDraft: boolean): Promise<void> {
    const ie = inlineEdit
    if (!ie) return
    setInlineEdit(null)
    if (keepDraft && ie.draft.trim()) await updateBlock(ie.blockId, { title: ie.draft.trim() })
  }
  async function cancelInline(): Promise<void> {
    const ie = inlineEdit
    if (!ie) return
    setInlineEdit(null)
    await removeBlock(ie.blockId)
  }
  async function promoteInline(): Promise<void> {
    const ie = inlineEdit
    if (!ie) return
    setInlineEdit(null)
    await removeBlock(ie.blockId)
    setComposer({
      dayIndex: ie.dayIndex,
      startMs: ie.startMs,
      initialDurationMin: ie.durationMin,
      initialTitle: ie.draft
    })
  }

  const gridHeight = (END_HOUR - START_HOUR) * hourPx
  const now = Date.now()

  return (
    <div className={`flex flex-col ${fill ? 'h-full min-h-0' : ''}`} data-testid="week-time-grid" data-fill={fill || undefined}>
      {/* DEC-078 — the pinned band: day headers + deadline chips stay put
          while the hours scroll beneath them. Living up here (not inside each
          column) also means a tall chip stack can no longer push its own
          column's canvas out of line with the others. */}
      <div className="flex">
        <div className={`${compact ? 'w-8' : 'w-14'} shrink-0`} />
        <div
          className={`grid flex-1 min-w-0 ${compact ? 'gap-1' : 'gap-1.5'}`}
          style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: days }, (_, dayIndex) => {
            const dStart = dayStartMs(weekStart, dayIndex)
            const label = new Date(dStart).toLocaleDateString(undefined, { weekday: 'short' })
            const isToday = new Date(dStart).toDateString() === new Date().toDateString()
            return (
              <div key={dayIndex} className="flex flex-col min-w-0">
                <div
                  className={`text-center py-1.5 mb-1 rounded-[var(--radius-chip)] truncate ${
                    isToday
                      ? 'text-accent font-semibold bg-accent/10'
                      : 'text-[var(--ink-50)] font-medium'
                  } ${compact ? 'text-[11px]' : 'text-[12px]'}`}
                  title={new Date(dStart).toLocaleDateString(undefined, {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric'
                  })}
                >
                  {label} {new Date(dStart).getDate()}
                </div>
                {(dueByDay.get(dayIndex)?.length ?? 0) > 0 && (
                  <div className="flex flex-col gap-0.5 pb-1" data-testid="deadline-band">
                    {(dueByDay.get(dayIndex) ?? []).slice(0, compact ? 2 : 4).map((i) => (
                      <button
                        key={i.id}
                        // DEC-093 — a deadline chip is a DRAG SOURCE, exactly
                        // like a queue-rail row: same 'text/fb-workitem'
                        // payload, so the day columns' existing drop handler
                        // books it (DEC-052: the drag is the decision, 30 min,
                        // undo covers regret). The chip stays after the drop —
                        // it marks the DUE DATE, which the booking doesn't move.
                        draggable
                        onDragStart={(e) => {
                          e.stopPropagation()
                          e.dataTransfer.setData('text/fb-workitem', i.id)
                          e.dataTransfer.effectAllowed = 'copy'
                          // NOT onBlockDragActive: that rings the queue rail
                          // as an UNSCHEDULE target (DEC-053), which would be
                          // a lie for an item that has no block yet.
                        }}
                        onClick={(e) => {
                          e.stopPropagation()
                          goAttention()
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          setEditItem(i)
                        }}
                        title={`Due: ${i.title} — drag onto the grid to book time · click to open Attention · double-click for details`}
                        className={`relative w-full text-left truncate rounded-[var(--radius-chip)] border border-dashed pl-2.5 pr-1.5 py-1 fb-press bg-[var(--surface-raised)] ${
                          compact ? 'text-[10.5px]' : 'text-[11px]'
                        } leading-snug`}
                        style={{
                          borderColor: queueTint(QUEUE_COLOR[queueOf(i)] ?? '#64748b', 0.6),
                          color: 'var(--ink-70)'
                        }}
                      >
                        <span
                          aria-hidden
                          className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full"
                          style={{ backgroundColor: queueTint(QUEUE_COLOR[queueOf(i)] ?? '#64748b', 0.7) }}
                        />
                        {i.title}
                      </button>
                    ))}
                    {(dueByDay.get(dayIndex)?.length ?? 0) > (compact ? 2 : 4) && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          goAttention()
                        }}
                        className="fb-t-caption text-[var(--ink-40)] hover:text-[var(--ink-80)] text-left pl-2 fb-press"
                      >
                        +{(dueByDay.get(dayIndex)?.length ?? 0) - (compact ? 2 : 4)} more due
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
      {/* DEC-078/079 — the hours scroll in their own window: hover the grid
          and a wheel moves through the day, never the page (overscroll
          contained). The rail's compact window is twelve hours. pt-2 is the
          12 AM fix: the first gutter label translates 6px up to sit ON its
          line, and with no headroom the top half clipped at the scroll edge. */}
      <div
        ref={timeScrollRef}
        // DEC-093 — dragging a deadline chip (or a queue row) from ABOVE the
        // grid can only reach the hours currently in view, and the window
        // shows about half a day. Hovering near an edge scrolls the day under
        // the pointer, so any hour is reachable without letting go.
        onDragOver={(e) => {
          if (
            !e.dataTransfer.types.includes('text/fb-workitem') &&
            !e.dataTransfer.types.includes('text/fb-node')
          )
            return
          const el = timeScrollRef.current
          if (!el) return
          const r = el.getBoundingClientRect()
          const EDGE = 56
          const y = e.clientY
          if (y < r.top + EDGE) el.scrollTop -= Math.max(6, (r.top + EDGE - y) / 2)
          else if (y > r.bottom - EDGE) el.scrollTop += Math.max(6, (y - (r.bottom - EDGE)) / 2)
        }}
        className={`flex overflow-y-auto overscroll-contain pt-2 ${fill ? 'flex-1 min-h-0' : ''}`}
        style={fill ? undefined : { maxHeight: compact ? 12 * hourPx : 'max(280px, calc(100vh - 380px))' }}
      >
      {/* Hour gutter */}
      <div className={`${compact ? 'w-8' : 'w-14'} shrink-0 select-none`}>
        {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
          <div
            key={i}
            style={{ height: hourPx }}
            className={`font-mono text-[var(--ink-40)] text-right pr-2 -translate-y-1.5 whitespace-nowrap ${compact ? 'text-[9.5px]' : 'text-[11px]'}`}
          >
            {(() => {
              // DEC-053 — 12-hour cycle, per operator ruling (no military time).
              const h = START_HOUR + i
              const h12 = h % 12 === 0 ? 12 : h % 12
              const mer = h < 12 ? 'AM' : 'PM'
              return compact ? `${h12}${mer === 'AM' ? 'a' : 'p'}` : `${h12} ${mer}`
            })()}
          </div>
        ))}
      </div>

      {/* Day columns */}
      <div
        className={`grid flex-1 min-w-0 ${compact ? 'gap-1' : 'gap-1.5'}`}
        style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: days }, (_, dayIndex) => {
          const dStart = dayStartMs(weekStart, dayIndex)
          const isToday = new Date(dStart).toDateString() === new Date().toDateString()
          // A block being dragged is placed by its PREVIEW start, so a cross-day
          // drag relocates it into the day column under the pointer live.
          const effStart = (b: TimeBlock): number =>
            drag && drag.id === b.id ? drag.previewStart : b.startMs
          const dayBlocks = blocks.filter((b) => effStart(b) >= dStart && effStart(b) < dStart + DAY_MS)
          return (
            <div key={dayIndex} className="flex flex-col min-w-0">
              {/* DEC-078 — no graying: every day is the same raised surface,
                  and today is marked by a light accent outline ALONE. The old
                  sunken wash on non-today columns made the week read as
                  sixth-sevenths disabled. */}
              <div
                ref={(el) => (colRefs.current[dayIndex] = el)}
                className={`relative rounded-[var(--radius-row)] border ${
                  isToday
                    ? 'border-transparent bg-[var(--surface-raised)] ring-2 ring-accent/35'
                    : 'border-[var(--edge-soft)] bg-[var(--surface-raised)]'
                }`}
                style={{ height: gridHeight }}
                onPointerDown={(e) => onColumnPointerDown(e, dayIndex)}
                onDragOver={onColumnDragOver}
                onDrop={(e) => onColumnDrop(e, dayIndex)}
                data-testid={`day-col-${dayIndex}`}
              >
                {/* hour lines */}
                {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
                  <div
                    key={i}
                    style={{ top: i * hourPx, height: hourPx }}
                    className="absolute left-0 right-0 border-t border-[var(--edge-soft)] pointer-events-none"
                  />
                ))}

                {dayBlocks.map((block) => {
                  const preview = drag && drag.id === block.id ? drag : null
                  const startMs = preview ? preview.previewStart : block.startMs
                  const durMin = preview ? preview.previewDur : block.durationMin
                  const top =
                    ((startMs - (dStart + START_HOUR * 3_600_000)) / 3_600_000) * hourPx
                  const height = (durMin / 60) * hourPx
                  const linked = block.taskId
                    ? nodesById.get(block.taskId) ?? itemsById.get(block.taskId) ?? null
                    : null
                  const isWorkItem = linked?.kind === 'work_item'
                  const isTaskBlock = !block.taskId || linked?.kind === 'task'
                  const wiHue = isWorkItem ? QUEUE_COLOR[queueOf(linked!)] ?? '#64748b' : null
                  const done = block.status === 'done'
                  // DEC-077 — an ACTIVE work-item block completes via the same
                  // circle every other surface uses; the hover cluster's check
                  // then only serves plain blocks (and done-undo).
                  const itemCompletable =
                    isWorkItem && !done && !!linked && !isTerminalState(linked.workItemState)
                  const isPast = startMs + durMin * 60000 < now
                  // A short block cannot hold padded text. The caption line is
                  // ~15px on its own, so py-1's 4px top and bottom crop it
                  // inside a 16px box — a 15-minute event rendered its title
                  // with the bottom sheared off. Short blocks therefore shed
                  // the vertical padding and centre a single line, and the
                  // floor rises to the height one line actually needs.
                  const fit = blockFit(height)
                  const tight = fit.tight
                  return (
                    <div
                      key={block.id}
                      data-testid="time-block"
                      data-calendar-id={block.calendarId ?? ''}
                      onPointerDown={(e) => beginDrag(e, block, 'move')}
                      onClick={(e) => {
                        e.stopPropagation()
                        // DEC-087 — SINGLE click opens the editor (same
                        // routing as double-click, which stays for habit).
                        // Before this, a click did nothing, so people clicked
                        // beside the block and the column's plain-click
                        // booked a NEW slot — the demo's "it duplicated".
                        // A click that ends a real drag is the drag's.
                        if (dragConsumedClickRef.current) {
                          dragConsumedClickRef.current = false
                          return
                        }
                        if (block.meeting || !block.taskId) setEditBlockState(block)
                        else if (isWorkItem) setEditItem(linked!)
                        else if (linked) jumpToNode(linked)
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        // A meeting block (whatever it links) and a plain
                        // block open the FULL dialog with every detail —
                        // guests, where, agenda, time — seeded for editing.
                        // Work-item and desk links keep their DEC-074 routes.
                        if (block.meeting || !block.taskId) setEditBlockState(block)
                        else if (isWorkItem) setEditItem(linked!)
                        else if (linked) jumpToNode(linked)
                      }}
                      className={`absolute left-0.5 right-0.5 rounded-[var(--radius-chip)] px-1.5 ${
                        tight ? 'py-0 flex items-center' : 'py-1'
                      } fb-t-caption overflow-hidden cursor-grab active:cursor-grabbing group/block border ${
                        done
                          ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                          : isPast
                            ? 'bg-[color-mix(in_oklab,var(--surface-sunken)_90%,transparent)] border-[color-mix(in_oklab,var(--edge-firm)_50%,transparent)] text-[var(--ink-50)]'
                            : 'bg-accent/15 border-accent/40 text-[var(--ink-90)]'
                      }`}
                      style={{
                        top: Math.max(0, top),
                        height: fit.boxHeight,
                        // A work item's queue hue wins: it says something the
                        // calendar colour does not. Everything else takes the
                        // colour of the Plexii calendar it belongs to, so an
                        // own block is told apart from a subscribed one and
                        // from the other Plexii calendars at a glance.
                        ...(wiHue && !done && !isPast
                          ? {
                              backgroundColor: queueTint(wiHue, 0.14),
                              borderColor: queueTint(wiHue, 0.45)
                            }
                          : !done && !isPast
                            ? {
                                backgroundColor: tint(colorOfBlock(calendars, block.calendarId), 0.15),
                                borderColor: tint(colorOfBlock(calendars, block.calendarId), 0.45)
                              }
                            : {})
                      }}
                      title={`${block.title || linked?.title || 'Focus time'} · ${fmtTime(startMs)}`}
                    >
                      <div className={`flex gap-1 min-w-0 ${tight ? 'items-center flex-1' : 'items-start'}`}>
                        {itemCompletable && (
                          <CompleteCircle
                            size={12}
                            className={tight ? '' : 'mt-[2px]'}
                            onClick={() => void completeItemAndBlock(block, linked!)}
                            title={`${(PRIMARY_ACTION[queueOf(linked!)] ?? PRIMARY_ACTION.to_do).label} — complete the item and this block`}
                            dataTestId="block-complete-circle"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          {inlineEdit?.blockId === block.id ? (
                            /* Step 9 — the name typed in place. Enter/blur
                               keep, Esc removes the block, Cmd+Enter promotes
                               to the full dialog with the draft carried. */
                            <input
                              autoFocus
                              value={inlineEdit.draft}
                              data-testid="inline-title-input"
                              placeholder={block.title}
                              onChange={(e) =>
                                setInlineEdit((ie) => (ie ? { ...ie, draft: e.target.value } : ie))
                              }
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => e.stopPropagation()}
                              onDoubleClick={(e) => e.stopPropagation()}
                              onBlur={() => void finishInline(true)}
                              onKeyDown={(e) => {
                                e.stopPropagation()
                                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                  e.preventDefault()
                                  void promoteInline()
                                } else if (e.key === 'Enter') {
                                  e.preventDefault()
                                  void finishInline(true)
                                } else if (e.key === 'Escape') {
                                  e.preventDefault()
                                  void cancelInline()
                                }
                              }}
                              className="w-full bg-transparent outline-none [&:focus-visible]:outline-none font-medium leading-[1.25] text-inherit placeholder:text-[var(--ink-40)] border-b border-[rgb(var(--accent))]"
                            />
                          ) : (
                          <div
                            className={`font-medium leading-[1.25] ${done ? 'line-through' : ''} ${
                              height < 34 ? 'truncate' : 'line-clamp-2'
                            }`}
                          >
                            {block.title || linked?.title || 'Focus time'}
                          </div>
                          )}
                          {height >= 34 && (
                            <div className="text-[9.5px] opacity-70 tabular-nums mt-px">
                              {fmtTime(startMs)}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* hover actions — z-raised above the resize handles,
                          whose top strip otherwise overlaps these buttons'
                          first few pixels and eats clicks there. */}
                      <div className="absolute top-0.5 right-0.5 z-10 hidden group-hover/block:flex items-center gap-0.5">
                        {block.meeting && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              // An external link wins: if someone pasted a Zoom
                              // URL, that is the meeting — the minted Plexii
                              // room is the fallback, not the destination.
                              const ext = block.meeting?.joinUrl
                              if (ext) void window.api.files.openExternal(ext)
                              else
                                void joinMeetingRoom(block.meeting!.roomId, block.title || 'Meeting', {
                                  blockId: block.id,
                                  seriesId: block.seriesId ?? null,
                                  agenda: block.meeting!.agenda ?? null,
                                  invitees: block.meeting!.invitees
                                })
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="h-4 w-4 inline-flex items-center justify-center rounded-[var(--radius-chip)] bg-accent !text-white fb-press"
                            title="Join this meeting"
                            data-testid="block-join-meeting"
                          >
                            <Icon name="videocam" size={9} />
                          </button>
                        )}
                        {/* M6 — an EXTERNAL meeting (Zoom/Meet/Teams) can be
                            recorded on this machine: mic + system audio,
                            local transcription, the same wrap-up. Explicitly
                            separate from Join — recording is its own act,
                            never a side effect of opening a link. */}
                        {block.meeting?.joinUrl && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void useGuestCaptureStore.getState().start({
                                title: block.title || 'Meeting',
                                blockId: block.id,
                                seriesId: block.seriesId ?? null,
                                agenda: block.meeting?.agenda ?? null
                              })
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="h-4 w-4 inline-flex items-center justify-center rounded-[var(--radius-chip)] bg-rose-500/90 !text-white fb-press"
                            title="Record this external meeting — your mic + this machine's audio, transcribed locally"
                            data-testid="block-record-external"
                          >
                            <Icon name="radio_button_checked" size={9} />
                          </button>
                        )}
                        {block.meeting && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setCalMenu({ block, x: e.clientX, y: e.clientY })
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="h-4 w-4 inline-flex items-center justify-center rounded-[var(--radius-chip)] bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] text-[var(--ink-70)] fb-press"
                            title="Add to my calendar"
                            data-testid="block-add-to-calendar"
                          >
                            <Icon name="event" size={9} />
                          </button>
                        )}
                        {linked && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              jumpToNode(linked)
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="h-4 w-4 inline-flex items-center justify-center rounded-[var(--radius-chip)] bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] text-[var(--ink-70)] fb-press"
                            title={linked.kind === 'folder' ? 'Open this folder' : 'Jump to this task'}
                            data-testid="block-jump"
                          >
                            <Icon name={linked.kind === 'folder' ? 'folder_open' : 'open_in_new'} size={9} />
                          </button>
                        )}
                        {!done && isTaskBlock && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              focusBlock(block)
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="h-4 w-4 inline-flex items-center justify-center rounded-[var(--radius-chip)] bg-accent !text-white fb-press"
                            title="Start a focus session for this block"
                            data-testid="block-focus"
                          >
                            <Icon name="bolt" size={9} />
                          </button>
                        )}
                        {!itemCompletable && (
                          /* DEC-074/077 — an active work-item block completes
                             via its visible circle instead; this check serves
                             plain blocks and the done-undo. Undo stays
                             calendar-local: it revives the BLOCK only — the
                             item reopens from Attention, not from here. */
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void updateBlock(block.id, { status: done ? 'planned' : 'done' })
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="h-4 w-4 inline-flex items-center justify-center rounded-[var(--radius-chip)] bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] text-[var(--ink-70)] fb-press"
                            title={done ? 'Mark not done' : 'Mark done'}
                            data-testid="block-complete"
                          >
                            <Icon name={done ? 'undo' : 'check'} size={9} />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            // Repeating blocks offer this-only vs this-and-future.
                            // The Undo toast covers recovery either way.
                            if (block.seriesId) {
                              const wholeSeries = confirm(
                                'This block repeats. OK deletes this and all future occurrences; Cancel deletes just this one.'
                              )
                              void removeBlock(block.id, wholeSeries ? 'series' : 'one')
                            } else {
                              void removeBlock(block.id)
                            }
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="h-4 w-4 inline-flex items-center justify-center rounded-[var(--radius-chip)] bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] text-[var(--ink-70)] hover:text-rose-500 fb-press"
                          title="Delete block"
                          data-testid="block-delete"
                        >
                          <Icon name="close" size={9} />
                        </button>
                      </div>

                      {/* resize handles — top edge changes the start, bottom edge
                          the end, matching Google Calendar. */}
                      <div
                        onPointerDown={(e) => beginDrag(e, block, 'resize-top')}
                        className="absolute top-0 left-0 right-0 h-1.5 cursor-ns-resize"
                        title="Drag to change the start time"
                        data-testid="block-resize-top"
                      />
                      <div
                        onPointerDown={(e) => beginDrag(e, block, 'resize')}
                        className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize"
                        title="Drag to change the end time"
                        data-testid="block-resize-bottom"
                      />
                    </div>
                  )
                })}

                {sel && sel.dayIndex === dayIndex && sel.endMs > sel.startMs && (
                  <div
                    data-testid="drag-select"
                    className="absolute left-0.5 right-0.5 rounded-[var(--radius-chip)] border-[1.5px] border-accent/70 bg-accent/15 pointer-events-none z-10 px-1.5 py-0.5 fb-t-caption text-[var(--ink-80)]"
                    style={{
                      top: ((sel.startMs - (dStart + START_HOUR * 3_600_000)) / 3_600_000) * hourPx,
                      height: Math.max(10, ((sel.endMs - sel.startMs) / 3_600_000) * hourPx)
                    }}
                  >
                    {fmtTime(sel.startMs)} – {fmtTime(sel.endMs)}
                  </div>
                )}
                {/* Subscribed events: real entries from somebody's Google or
                    Outlook calendar. Drawn flat and unclickable-for-edit
                    because they cannot be changed from here -- a block you can
                    drag and an event you cannot must not look alike. */}
                {externalEvents
                  .filter((e) => e.startMs >= dStart && e.startMs < dStart + DAY_MS && !e.allDay)
                  .map((e) => {
                    const top =
                      ((e.startMs - (dStart + START_HOUR * 3_600_000)) / 3_600_000) * hourPx
                    const height = ((e.endMs - e.startMs) / 3_600_000) * hourPx
                    return (
                      <div
                        key={`ext:${e.id}`}
                        data-testid="external-event"
                        data-calendar-id={e.calendarId}
                        onClick={(ev) => ev.stopPropagation()}
                        className="absolute left-0.5 right-0.5 overflow-hidden rounded-[var(--radius-chip)] border-l-[3px] px-1.5 py-1 fb-t-caption text-[var(--ink-80)]"
                        style={{
                          top: Math.max(0, top),
                          height: Math.max(16, height),
                          borderLeftColor: colorOfCalendar(calendars, e.calendarId),
                          background: tint(colorOfCalendar(calendars, e.calendarId))
                        }}
                        title={[e.title, e.location, e.organizer].filter(Boolean).join(' — ')}
                      >
                        <div className="truncate font-medium leading-[1.25]">
                          {e.title || 'Untitled event'}
                        </div>
                        {height >= 34 && e.location && (
                          <div className="truncate text-[9.5px] opacity-70">{e.location}</div>
                        )}
                      </div>
                    )
                  })}
                {(ghosts ?? [])
                  .filter((g) => g.startMs >= dStart && g.startMs < dStart + DAY_MS)
                  .map((g) => {
                    const top =
                      ((g.startMs - (dStart + START_HOUR * 3_600_000)) / 3_600_000) * hourPx
                    const height = (g.durationMin / 60) * hourPx
                    return (
                      <div
                        key={`ghost:${g.itemId}`}
                        data-testid="plan-ghost"
                        onClick={(e) => e.stopPropagation()}
                        className="absolute left-0.5 right-0.5 rounded-[var(--radius-chip)] px-1.5 py-1 fb-t-caption overflow-hidden border-[1.5px] border-dashed border-accent/60 bg-accent/[0.06] text-[var(--ink-80)] group/ghost"
                        style={{ top: Math.max(0, top), height: Math.max(16, height) }}
                        title={`${g.title} — ${g.reason} (proposed; accept to book)`}
                      >
                        <div className="font-medium leading-[1.25] truncate">{g.title}</div>
                        {(g.durationMin / 60) * hourPx >= 34 && (
                          <div className="text-[9.5px] opacity-70 truncate">{g.reason}</div>
                        )}
                        {onGhostRemove && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              onGhostRemove(g.itemId)
                            }}
                            className="absolute top-0.5 right-0.5 hidden group-hover/ghost:inline-flex h-4 w-4 items-center justify-center rounded-[var(--radius-chip)] bg-[color-mix(in_oklab,var(--surface-raised)_90%,transparent)] text-[var(--ink-70)] hover:text-rose-500 fb-press"
                            title="Drop this proposal"
                          >
                            <Icon name="close" size={9} />
                          </button>
                        )}
                      </div>
                    )
                  })}
              </div>
            </div>
          )
        })}
      </div>
      </div>

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
      {editBlock && (
        <BookTimeDialog
          startMs={editBlock.startMs}
          initialDurationMin={editBlock.durationMin}
          editBlock={editBlock}
          prefillNode={(() => {
            const n = editBlock.taskId
              ? nodesById.get(editBlock.taskId) ?? itemsById.get(editBlock.taskId)
              : null
            return n ? { id: n.id, title: n.title, kind: n.kind } : undefined
          })()}
          onCancel={() => setEditBlockState(null)}
          onSave={async (patch) => {
            const prev = editBlock
            setEditBlockState(null)
            // DEC-129 — the save (and its undo toast) is lib/blockEdit, shared
            // with the Today tile's row, so an edit lands the same everywhere.
            await saveBlockEdit(prev, patch)
          }}
        />
      )}
      {/* Book time (spec pass 1, steps 1–3) — replaces BlockComposer at the
          mount. The old composer stays below as the steps‑4–9 reference
          (guests / where / agenda / invites) and is deleted at step 9.
          Drop-books-immediately never reaches this mount, unchanged. */}
      {composer && (
        <BookTimeDialog
          startMs={composer.startMs}
          initialDurationMin={composer.initialDurationMin}
          initialTitle={composer.initialTitle}
          prefillNode={composer.prefillNode}
          proposal={composer.proposal}
          onCancel={() => setComposer(null)}
          onCreate={async (taskId, title, startMs, durationMin, meeting, recurrence) => {
            // Step 7 — closes IMMEDIATELY; no spinner, no confirmation step.
            // The create is a local write; the toast is where regret goes.
            setComposer(null)
            // DEC-131 — the booking itself (create, the undo toast, the stated
            // invite hold) is lib/bookBlock, shared with the assistant's
            // Calendar tab, so a day picked there books exactly like this.
            await bookBlockWithToast({ taskId, title, startMs, durationMin, meeting, recurrence })
          }}
        />
      )}
      {calMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setCalMenu(null)} />
          <div
            className="fixed z-50 w-52 rounded-[var(--radius-row)] fb-glass-panel fb-pop-in p-1 fb-t-label"
            style={{
              left: Math.min(calMenu.x, window.innerWidth - 220),
              top: Math.min(calMenu.y, window.innerHeight - 120)
            }}
            data-testid="add-to-calendar-menu"
          >
            <div className="px-2 py-1 fb-t-caption uppercase tracking-wide">
              Add to calendar
            </div>
            <button
              className="w-full text-left px-2 py-1.5 rounded-[var(--radius-chip)] hover:bg-[var(--surface-sunken)] fb-press flex items-center gap-2"
              onClick={() => {
                const b = calMenu.block
                void window.api.calendar.addMeetingIcs({
                  roomId: b.meeting!.roomId,
                  title: b.title || 'Meeting',
                  startMs: b.startMs,
                  durationMin: b.durationMin
                })
                setCalMenu(null)
              }}
            >
              <Icon name="event" size={13} />
              Apple Calendar / Outlook
            </button>
            <button
              className="w-full text-left px-2 py-1.5 rounded-[var(--radius-chip)] hover:bg-[var(--surface-sunken)] fb-press flex items-center gap-2"
              onClick={() => {
                const b = calMenu.block
                void window.api.files.openExternal(
                  googleCalendarUrl({
                    uid: `${b.meeting!.roomId}@plexidesk`,
                    title: b.title || 'Meeting',
                    startMs: b.startMs,
                    durationMin: b.durationMin,
                    joinUrl: `haptyx://meet?room=${encodeURIComponent(b.meeting!.roomId)}`
                  })
                )
                setCalMenu(null)
              }}
            >
              <Icon name="public" size={13} />
              Google Calendar
            </button>
          </div>
        </>
      )}
    </div>
  )
}
