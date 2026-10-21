import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TimeBlock, TimeBlockStatus } from '@shared/types'
import Icon from '../Icon'
import BookTimeDialog from '../BookTimeDialog'
import { useTimeBlockStore } from '../../stores/timeBlocks'
import { useMeetingsStore } from '../../stores/meetings'
import { useNodeStore } from '../../stores/nodes'
import { useWorkItemStore } from '../../stores/workItems'
import { useViewStore } from '../../stores/view'
import { useFocusSessionStore } from '../../stores/focusSession'
import { useGuestCaptureStore } from '../../stores/guestCapture'
import { futuristicPowerOn } from '../../lib/audioBeep'
import { joinMeetingRoom } from '../../lib/startMeeting'
import { openMeetingMoment } from '../../lib/openMeeting'
import { saveBlockEdit } from '../../lib/blockEdit'
import { formatMeetWhen } from '../../lib/meetWhen'
import { meetProviderLabel } from '../../lib/meetInvite'
import { queueTint } from '../../lib/attentionQueues'

// DEC-129 — a calendar block (a meeting, or focus time) as a widget row with
// the DEC-128 depths, so the Today tile behaves exactly like the Attention
// widget beside it:
//
//   at rest      the title and the time — a meeting wears the camera, focus
//                time the clock; live now pulses, done / missed / skipped show;
//   one click    the summary IN PLACE — when (range + relative), the agenda,
//                the chips (status · where: the provider or the Plexii room ·
//                location · who's invited · the desk or item it is booked
//                for · repeats · pinned · the meeting's Record · last time in
//                the series) — and the calendar's own doors: Join, Record an
//                external meeting, Start (a focus session, on its desk), Done,
//                Skip, Open the block, Delete (undo in the toast), and the
//                Calendar page;
//   double-click the full block — the calendar's own BookTimeDialog in edit
//                mode — over the page you are on (portalled to <body>).
//
// Operator (DEC-129): "Now do the same for the meeting and calendar items."

const TONE_MEETING = '#8b5cf6'
const TONE_BLOCK = '#10b981'
const chipClass =
  'inline-flex items-center gap-1 px-1.5 h-5 rounded-full text-[10.5px] bg-[var(--surface-sunken)] text-[var(--ink-50)] max-w-[160px]'
const chipDoorClass = `${chipClass} hover:text-[var(--ink-100)] fb-press`
const actionClass = 'icon-btn !h-6 !w-6'

const STATUS_LABEL: Record<TimeBlockStatus, string> = {
  planned: 'Planned',
  done: 'Done',
  missed: 'Missed',
  skipped: 'Skipped'
}

export function CalendarBlockRow({ block, nowMs }: { block: TimeBlock; nowMs: number }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const nodes = useNodeStore((s) => s.nodes)
  const setActiveNode = useNodeStore((s) => s.setActive)
  const items = useWorkItemStore((s) => s.items)
  const goTask = useViewStore((s) => s.goTask)
  const goRoom = useViewStore((s) => s.goRoom)
  const goCalendar = useViewStore((s) => s.goCalendar)
  const goAttention = useViewStore((s) => s.goAttention)
  const updateBlock = useTimeBlockStore((s) => s.update)
  const removeBlock = useTimeBlockStore((s) => s.remove)
  const startSession = useFocusSessionStore((s) => s.start)
  const meetings = useMeetingsStore((s) => s.meetings)
  const meetingsLoaded = useMeetingsStore((s) => s.loaded)
  const loadMeetings = useMeetingsStore((s) => s.load)
  // The Record chips need the meetings list — fetched the first time a row
  // opens, never on every tile mount.
  useEffect(() => {
    if (open && !meetingsLoaded) void loadMeetings()
  }, [open, meetingsLoaded, loadMeetings])

  const meeting = block.meeting ?? null
  const isMeeting = !!meeting
  const endMs = block.startMs + block.durationMin * 60_000
  const ended = endMs < nowMs
  const live = block.startMs <= nowMs && !ended
  const status = block.status
  const linked = block.taskId ? (nodes.find((n) => n.id === block.taskId) ?? null) : null
  const linkedItem = !linked && block.taskId ? (items.find((i) => i.id === block.taskId) ?? null) : null
  // The grid's rule: a block with no link, or linked to a desk, can be started.
  const isTaskBlock = !block.taskId || linked?.kind === 'task'
  const record = useMemo(() => meetings.find((m) => m.blockId === block.id) ?? null, [meetings, block.id])
  const lastInSeries = useMemo(
    () =>
      block.seriesId
        ? (meetings
            .filter((m) => m.seriesId === block.seriesId && m.blockId !== block.id)
            .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null)
        : null,
    [meetings, block.seriesId, block.id]
  )
  const tone = isMeeting ? TONE_MEETING : TONE_BLOCK
  const title = block.title || (isMeeting ? 'Meeting' : 'Focus time')
  const hhmm = (ms: number): string =>
    new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  // The calendar grid's own join rule: an external link wins; the minted
  // Plexii room is the fallback, not the destination.
  const join = (): void => {
    if (!meeting) return
    const ext = meeting.joinUrl
    if (ext) void window.api.files.openExternal(ext)
    else
      void joinMeetingRoom(meeting.roomId, block.title || 'Meeting', {
        blockId: block.id,
        seriesId: block.seriesId ?? null,
        agenda: meeting.agenda ?? null,
        invitees: meeting.invitees
      })
  }
  // M6 — an EXTERNAL meeting can be recorded on this machine; its own act,
  // never a side effect of Join.
  const recordExternal = (): void => {
    void useGuestCaptureStore.getState().start({
      title: block.title || 'Meeting',
      blockId: block.id,
      seriesId: block.seriesId ?? null,
      agenda: meeting?.agenda ?? null
    })
  }
  // The grid's focusBlock: a session for the block's length, on its desk.
  const startFocus = (): void => {
    futuristicPowerOn()
    void startSession(block.taskId, block.durationMin * 60, 'planned')
    if (block.taskId) {
      setActiveNode(block.taskId)
      goTask(block.taskId)
    }
  }
  const openLinked = (): void => {
    if (linked) {
      if (linked.kind === 'folder') goRoom(linked.id)
      else {
        setActiveNode(linked.id)
        goTask(linked.id)
      }
    } else if (linkedItem) goAttention()
  }
  const setStatus = (next: TimeBlockStatus): void => {
    void updateBlock(block.id, { status: next })
  }

  return (
    <div
      data-calendar-block
      data-block-id={block.id}
      data-testid={`block-row-${block.id}`}
      onDoubleClick={(e) => {
        // The action cluster is off-limits — double-clicking Delete should
        // delete, not open the editor behind it.
        e.stopPropagation()
        if ((e.target as HTMLElement).closest('[data-row-action]')) return
        setEditing(true)
      }}
      className={`group relative min-w-0 rounded-md border border-[var(--edge-soft)] bg-[var(--surface-raised)] hover:border-[var(--edge-firm)] transition-colors ${
        open ? 'bg-accent/[0.045]' : 'hover:bg-accent/[0.045]'
      }`}
    >
      <span
        aria-hidden
        className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full"
        style={{ backgroundColor: queueTint(tone, 0.55) }}
      />
      <div className="flex items-center gap-2 min-w-0 pl-2.5 pr-2 py-1.5">
        <Icon
          name={isMeeting ? 'videocam' : 'schedule'}
          size={13}
          style={{ color: queueTint(tone, 0.8) }}
          className="shrink-0"
        />
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={open ? 'Hide details · double-click to open the block' : 'Click for details · double-click to open the block'}
          data-testid={`block-row-toggle-${block.id}`}
          className="min-w-0 flex-1 text-left fb-press"
        >
          <span className="flex items-center gap-1 min-w-0">
            <span
              className={`min-w-0 text-[12px] text-[var(--ink-90)] ${
                open ? 'whitespace-pre-wrap break-words' : 'truncate'
              }`}
            >
              {title}
            </span>
            <Icon
              name="expand_more"
              size={12}
              className={`shrink-0 text-[var(--ink-30)] transition-transform duration-200 ${
                open ? 'rotate-180' : 'opacity-0 group-hover:opacity-100'
              }`}
            />
          </span>
        </button>
        <span
          className={`shrink-0 text-[10px] fb-tabular ${live ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-40)]'}`}
        >
          {hhmm(block.startMs)}
        </span>
        {status === 'done' ? (
          <Icon name="task_alt" size={13} className="shrink-0 text-emerald-500" />
        ) : status === 'missed' ? (
          <span title="Missed" className="shrink-0 h-2 w-2 rounded-full bg-rose-500" />
        ) : status === 'skipped' ? (
          <Icon name="skip_next" size={13} className="shrink-0 text-[var(--ink-30)]" />
        ) : live ? (
          <span title="Happening now" className="shrink-0 h-2 w-2 rounded-full bg-[rgb(var(--accent))] motion-safe:animate-pulse" />
        ) : null}
      </div>
      {open && (
        <div className="px-2.5 pb-2 flex flex-col gap-1.5 select-text" data-testid={`block-row-open-${block.id}`}>
          {/* "Today 9:00 – 9:30 AM", "Tomorrow 2 PM", "Ended" — the Meet
              items' own wording, range included. */}
          <div className="text-[11.5px] text-[var(--ink-70)] fb-tabular">
            {formatMeetWhen(block.startMs, block.durationMin, nowMs)}
          </div>
          {meeting?.agenda && (
            <div className="text-[11.5px] text-[var(--ink-70)] whitespace-pre-wrap break-words">{meeting.agenda}</div>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <span
              className={`${chipClass} ${
                status === 'done'
                  ? 'text-emerald-600 bg-emerald-500/10'
                  : status === 'missed'
                    ? 'text-rose-600 bg-rose-500/10'
                    : ''
              }`}
            >
              <Icon name={status === 'done' ? 'task_alt' : status === 'missed' ? 'error' : status === 'skipped' ? 'skip_next' : 'schedule'} size={10} />
              {STATUS_LABEL[status]}
            </span>
            {meeting && (
              <span className={chipClass} title={meeting.joinUrl ?? 'A Plexii room — join from here'}>
                <Icon name="videocam" size={10} />
                {meeting.joinUrl ? meetProviderLabel(meeting.joinUrl) : 'Plexii room'}
              </span>
            )}
            {meeting?.location && (
              <span className={chipClass} title={meeting.location}>
                <Icon name="place" size={10} />
                <span className="truncate">{meeting.location}</span>
              </span>
            )}
            {meeting && meeting.invitees.length > 0 && (
              <span className={chipClass} title={meeting.invitees.join(', ')}>
                <Icon name="group" size={10} />
                {meeting.invitees.length} invited
              </span>
            )}
            {(linked || linkedItem) && (
              <button
                data-row-action
                onClick={openLinked}
                title={linked ? (linked.kind === 'folder' ? 'Open the room' : 'Open the desk') : 'Open it in Focus'}
                className={chipDoorClass}
                data-testid="block-row-linked"
              >
                <Icon name={linked ? (linked.kind === 'folder' ? 'folder_open' : 'desk') : 'notifications'} size={10} />
                <span className="truncate">{(linked ?? linkedItem)!.title || 'Untitled'}</span>
              </button>
            )}
            {block.recurrence && (
              <span className={chipClass} title="Part of a repeating series">
                <Icon name="repeat" size={10} />
                Repeats
              </span>
            )}
            {block.locked && (
              <span className={chipClass} title="Pinned — never moved by the planner">
                <Icon name="push_pin" size={10} />
                Pinned
              </span>
            )}
            {record && (
              <button
                data-row-action
                onClick={() => openMeetingMoment(record.id)}
                title="Open this meeting's Record in PlexiiCall"
                className={chipDoorClass}
                data-testid="block-row-record"
              >
                <Icon name="history_edu" size={10} />
                Record
              </button>
            )}
            {lastInSeries && (
              <button
                data-row-action
                onClick={() => openMeetingMoment(lastInSeries.id)}
                title={`Last time in this series — ${lastInSeries.title}`}
                className={chipDoorClass}
                data-testid="block-row-last-time"
              >
                <Icon name="history" size={10} />
                Last time
              </button>
            )}
          </div>
          <div data-row-action className="flex items-center gap-1 flex-wrap" data-testid={`block-row-actions-${block.id}`}>
            {isMeeting && !ended && (
              <button
                onClick={join}
                title={meeting?.joinUrl ? `Join — ${meetProviderLabel(meeting.joinUrl)}` : 'Join this meeting'}
                className="h-6 px-2 rounded-full bg-accent !text-white inline-flex items-center gap-1 text-[11px] fb-press"
                data-testid="block-row-join"
              >
                <Icon name="videocam" size={12} />
                Join
              </button>
            )}
            {isMeeting && meeting?.joinUrl && !ended && (
              <button
                onClick={recordExternal}
                title="Record this external meeting — your mic + this machine's audio, transcribed locally"
                className={actionClass}
                data-testid="block-row-record-external"
              >
                <Icon name="radio_button_checked" size={14} />
              </button>
            )}
            {!isMeeting && isTaskBlock && status !== 'done' && (
              <button
                onClick={startFocus}
                title="Start it now — a focus session for this block, on its desk"
                className={actionClass}
                data-testid="block-row-start"
              >
                <Icon name="play_arrow" size={14} />
              </button>
            )}
            {status !== 'done' && (
              <button onClick={() => setStatus('done')} title="Mark it done" className={actionClass}>
                <Icon name="check" size={14} />
              </button>
            )}
            {status === 'planned' && (
              <button onClick={() => setStatus('skipped')} title="Skip it" className={actionClass}>
                <Icon name="skip_next" size={14} />
              </button>
            )}
            {status !== 'planned' && (
              <button onClick={() => setStatus('planned')} title="Back to planned" className={actionClass}>
                <Icon name="undo" size={14} />
              </button>
            )}
            <button
              onClick={() => setEditing(true)}
              title="Open the block — every field, right here"
              className={actionClass}
              data-testid={`block-row-edit-${block.id}`}
            >
              <Icon name="open_in_new" size={14} />
            </button>
            <button
              onClick={() => void removeBlock(block.id)}
              title="Delete this block — undo is in the toast"
              className={actionClass}
              data-testid={`block-row-delete-${block.id}`}
            >
              <Icon name="delete" size={14} />
            </button>
            <button
              onClick={goCalendar}
              title="Open the calendar"
              className={`${actionClass} ml-auto`}
              data-testid={`block-row-page-${block.id}`}
            >
              <Icon name="calendar_month" size={14} />
            </button>
          </div>
        </div>
      )}
      {editing &&
        createPortal(
          <BookTimeDialog
            startMs={block.startMs}
            initialDurationMin={block.durationMin}
            editBlock={block}
            prefillNode={
              linked
                ? { id: linked.id, title: linked.title, kind: linked.kind }
                : linkedItem
                  ? { id: linkedItem.id, title: linkedItem.title, kind: linkedItem.kind }
                  : undefined
            }
            onCancel={() => setEditing(false)}
            onSave={async (patch) => {
              setEditing(false)
              await saveBlockEdit(block, patch)
            }}
          />,
          document.body
        )}
    </div>
  )
}
