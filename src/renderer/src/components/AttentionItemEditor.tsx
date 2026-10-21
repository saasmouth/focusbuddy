import { useEffect, useRef, useState } from 'react'
import { isoToLocalParts, localPartsToIso, formatMeetWhen } from '../lib/meetWhen'
import { joinUrlOf, meetProviderLabel } from '../lib/meetInvite'
import { blockDraftForMeeting, blockForItem } from '../lib/meetSchedule'
import { newMeetingRoomId } from '../lib/startMeeting'
import type { TimeBlock } from '@shared/types'
import type { FbNode } from '@shared/types'
import { useWorkItemStore } from '../stores/workItems'
import { CLASS_CHOICES, queueOf } from '../lib/attentionQueues'
import { URGENCY_LEVELS, parseTags, serializeTags, urgencyOf } from '../lib/itemTags'
import { parseMentions, serializeMentions, type ItemMention } from '../lib/itemMentions'
import { parseMessageUrl } from '../lib/messageLink'
import { openMessageLink } from '../lib/openMessage'
import TagMentionInput from './TagMentionInput'
import Icon from './Icon'

// DEC-036 — the item editor. Double-clicking a queue row opens the WHOLE item
// and lets every part of it be changed: title, notes, classification, due
// date, and the desk it lives on.
//
// This closes the oldest Layer-0 gap in the layer (analysis/21 Part II §12:
// "no post-creation editing — updateFields exists at IPC; no UI"). Until now a
// capture was effectively immutable from the surface: you could reclassify it,
// snooze it, or close it, but you could not correct a typo in your own words.
//
// Every write goes through the one store seam (F008), and ONLY changed fields
// are sent — so an edit that touches the title cannot quietly restamp the due
// date or the class.

const isoToInputDate = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

export default function AttentionItemEditor({
  item,
  desks,
  onClose
}: {
  item: FbNode
  /** Personal, live desks — shared/archived ones refuse work-item parenting. */
  desks: Array<{ id: string; title: string }>
  onClose: (changed: boolean) => void
}): JSX.Element {
  const updateFields = useWorkItemStore((s) => s.updateFields)
  // DEC-144 — a task filed on a desk is edited here too. It holds title,
  // notes, due date and queue (its own columns); urgency, tags, mentions and
  // the meeting fields belong to a captured item only, so they are not
  // offered for it rather than offered and silently dropped. And it must stay
  // ON a desk: a task with no desk above it is a desk itself.
  const isDeskTask = item.kind === 'task'
  const [title, setTitle] = useState(item.title ?? '')
  const [notes, setNotes] = useState(item.description ?? '')
  const [cls, setCls] = useState(queueOf(item))
  const [due, setDue] = useState(isoToInputDate(item.dueAt))
  const [deskId, setDeskId] = useState(item.parentId ?? '')
  // DEC-037 — the chosen context. Never mandatory.
  const [urgency, setUrgency] = useState<string>(urgencyOf(item) ?? 'normal')
  const [tagList, setTagList] = useState<string[]>(parseTags(item.tags))
  const [mentionList, setMentionList] = useState<ItemMention[]>(parseMentions(item.mentions))
  // DEC-064 — the meeting a Meet item points at. Held in local wall-clock parts
  // because that is what the person types; converted to an instant on save.
  const initialWhen = isoToLocalParts(item.meetStartAt)
  const [meetDate, setMeetDate] = useState(initialWhen.date)
  const [meetTime, setMeetTime] = useState(initialWhen.time)
  const [meetDur, setMeetDur] = useState<number | ''>(item.meetDurationMin ?? '')
  const [meetUrl, setMeetUrl] = useState(item.meetUrl ?? '')
  const [meetLoc, setMeetLoc] = useState(item.meetLocation ?? '')
  const [meetWho, setMeetWho] = useState(item.meetAttendees ?? '')
  const [meetRsvp, setMeetRsvp] = useState<string>(item.meetRsvp ?? '')
  // DEC-068 — the block that already reserves time for this meeting, if one
  // does. Looked up by the LINK (taskId), never by time: a block dragged to
  // another day is still this meeting's block, and matching on time would offer
  // to schedule again and quietly create a duplicate.
  const [linkedBlock, setLinkedBlock] = useState<TimeBlock | null>(null)
  const [schedNote, setSchedNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setTimeout(() => titleRef.current?.focus(), 0)
  }, [])

  // Look across a wide window rather than "around now": a meeting can be
  // scheduled months out, and a narrow query would report it unscheduled and
  // offer to double-book it.
  useEffect(() => {
    let live = true
    const YEAR = 365 * 24 * 3600 * 1000
    void window.api.timeBlocks
      .list(Date.now() - YEAR, Date.now() + YEAR)
      .then((bs) => {
        if (live) setLinkedBlock(blockForItem(bs, item.id))
      })
      .catch(() => {
        /* the editor still works without knowing; the button just offers */
      })
    return () => {
      live = false
    }
  }, [item.id])

  async function putOnCalendar(): Promise<void> {
    setSchedNote(null)
    // Schedule from what is IN THE FORM, not from what was last saved —
    // otherwise a time typed a moment ago is silently ignored and the block
    // lands at the old one.
    const pending = {
      ...item,
      meetStartAt: localPartsToIso(meetDate, meetTime),
      meetDurationMin: meetDur === '' ? null : Number(meetDur),
      meetUrl: meetUrl.trim() || null,
      meetLocation: meetLoc.trim() || null,
      meetAttendees: meetWho.trim() || null
    }
    const out = blockDraftForMeeting(pending, newMeetingRoomId)
    if (!out.ok) {
      setSchedNote(out.reason)
      return
    }
    try {
      if (linkedBlock) {
        const updated = await window.api.timeBlocks.update(linkedBlock.id, {
          title: out.draft.title,
          startMs: out.draft.startMs,
          durationMin: out.draft.durationMin,
          meeting: out.draft.meeting
        })
        setLinkedBlock(updated ?? linkedBlock)
        setSchedNote('Calendar updated.')
      } else {
        setLinkedBlock(await window.api.timeBlocks.create(out.draft))
        setSchedNote('On your calendar.')
      }
    } catch (err) {
      setSchedNote(err instanceof Error ? err.message : 'Could not reach the calendar.')
    }
  }

  async function save(): Promise<void> {
    if (busy) return
    const trimmed = title.trim()
    if (!trimmed) {
      setError('A task needs a title.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Only what actually changed — an edit must never restamp a field the
      // operator did not touch.
      const patch: Record<string, unknown> = {}
      if (trimmed !== (item.title ?? '')) patch.title = trimmed
      if (notes !== (item.description ?? '')) patch.notes = notes
      if (cls !== queueOf(item)) patch.intentClass = cls
      const nextDue = due ? new Date(`${due}T17:00:00`).toISOString() : null
      if (nextDue !== (item.dueAt ?? null)) patch.dueAt = nextDue
      if (!isDeskTask) {
        const nextUrgency = urgency === 'normal' ? null : urgency
        if (nextUrgency !== (item.wiUrgency ?? null)) patch.wiUrgency = nextUrgency
        const nextTags = serializeTags(tagList)
        if (nextTags !== (item.tags ?? null)) patch.tags = nextTags
        const nextMentions = serializeMentions(mentionList)
        if (nextMentions !== (item.mentions ?? null)) patch.mentions = nextMentions
      }

      // DEC-064 — the meeting. Only sent when the item IS a Meet: the fields
      // are hidden for every other class, so writing them from a stale state
      // would store a meeting nobody can see or edit. Switching a Meet item to
      // another class leaves the values ALONE rather than deleting them —
      // reclassifying is not the same as saying the meeting never happened, and
      // switching back must not have silently destroyed the details.
      if (cls === 'to_meet' && !isDeskTask) {
        const nextStart = localPartsToIso(meetDate, meetTime)
        if (nextStart !== (item.meetStartAt ?? null)) patch.meetStartAt = nextStart
        const nextDur = meetDur === '' ? null : Number(meetDur)
        if (nextDur !== (item.meetDurationMin ?? null)) patch.meetDurationMin = nextDur
        const nz = (v: string): string | null => (v.trim() ? v.trim() : null)
        if (nz(meetUrl) !== (item.meetUrl ?? null)) patch.meetUrl = nz(meetUrl)
        if (nz(meetLoc) !== (item.meetLocation ?? null)) patch.meetLocation = nz(meetLoc)
        if (nz(meetWho) !== (item.meetAttendees ?? null)) patch.meetAttendees = nz(meetWho)
        const nextRsvp = meetRsvp || null
        if (nextRsvp !== (item.meetRsvp ?? null)) patch.meetRsvp = nextRsvp
      }
      let changed = Object.keys(patch).length > 0
      if (changed && !(await updateFields(item.id, patch))) {
        // A refused write (DEC-144) is said out loud, never shown as saved.
        setError('That change could not be saved. Nothing was changed.')
        setBusy(false)
        return
      }

      // The desk is a NODE move, not a work-item field — same call the
      // Detached shelf's recovery uses.
      const nextDesk = deskId || null
      if (nextDesk !== (item.parentId ?? null)) {
        if (nextDesk) await window.api.nodes.move(item.id, nextDesk, null)
        else await window.api.nodes.move(item.id, null, null)
        changed = true
      }
      onClose(changed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save those changes.')
      setBusy(false)
    }
  }

  return (
    <div
      /* DEC-065 — centred, and bounded by the viewport. It used to be pinned
         14vh from the top with no height cap, so a tall item (a Meet, once
         DEC-064 gave it a meeting section) simply ran off the bottom of a
         laptop screen with its Save button unreachable. Content that cannot be
         reached is worse than content that scrolls, so there is a max-height
         and an internal scroll as the floor — but the section below is sized so
         that on a normal laptop it never comes to that. */
      className="fb-scrim fixed inset-0 z-[320] flex items-center justify-center p-6"
      onMouseDown={() => onClose(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Edit task"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose(false)
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
        }}
        className="fb-card w-[min(620px,94vw)] p-4 max-h-full overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <div className="text-[14px] font-semibold text-[var(--ink-100)]">Edit task</div>
          <button onClick={() => onClose(false)} title="Close" className="icon-btn !h-7 !w-7">
            <Icon name="close" size={14} />
          </button>
        </div>

        <label className="block mt-3">
          <span className="fb-t-caption text-[var(--ink-40)]">Title</span>
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="fb-field mt-1 w-full bg-[var(--surface-raised)] px-3 py-2 text-[13px]"
          />
        </label>

        <label className="block mt-3">
          <span className="fb-t-caption text-[var(--ink-40)]">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Context, links, anything worth keeping with it…"
            className="fb-field mt-1 w-full bg-[var(--surface-raised)] px-3 py-2 text-[12.5px] resize-y"
          />
        </label>

        <div className="mt-3">
          <span className="fb-t-caption text-[var(--ink-40)]">Classification</span>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {CLASS_CHOICES.map((c) => (
              <button
                key={c.value}
                onClick={() => setCls(c.value)}
                title={c.hint}
                className={`px-2.5 h-7 fb-t-label fb-press rounded-full ${
                  cls === c.value
                    ? 'bg-[rgb(var(--accent))] text-white'
                    : 'bg-[var(--surface-raised)] text-[var(--ink-60)] hover:text-[var(--ink-100)]'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* DEC-064 — the meeting, when the item IS one. Shown by the class
            rather than by a toggle: choosing "Meet" above is already the
            statement that this is a meeting, and asking twice would be asking
            the same question in two places. Every field is optional — an item
            can be "meet with Sam" long before any of it is known, and the queue
            only dresses it as an invitation once something is. */}
        {cls === 'to_meet' && !isDeskTask && (
          <div className="mt-3 rounded-[var(--radius-row)] border border-[var(--edge-soft)] bg-[var(--surface-raised)] px-3 py-2.5">
            <div className="flex items-center gap-1.5 mb-2">
              <Icon name="event" size={13} className="text-[var(--ink-40)]" />
              <span className="fb-t-caption uppercase tracking-wider font-medium text-[var(--ink-50)]">
                The meeting
              </span>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <label className="block">
                <span className="fb-t-caption text-[var(--ink-40)]">When</span>
                <div className="mt-1 flex items-center gap-1">
                  <input
                    type="date"
                    value={meetDate}
                    onChange={(e) => setMeetDate(e.target.value)}
                    className="fb-field bg-[var(--surface-sunken)] px-2 py-1.5 text-[12px]"
                    data-testid="meet-date"
                  />
                  <input
                    type="time"
                    value={meetTime}
                    onChange={(e) => setMeetTime(e.target.value)}
                    className="fb-field bg-[var(--surface-sunken)] px-2 py-1.5 text-[12px]"
                    data-testid="meet-time"
                  />
                  {(meetDate || meetTime) && (
                    <button
                      onClick={() => {
                        setMeetDate('')
                        setMeetTime('')
                      }}
                      title="Clear the time — an invitation can be unscheduled"
                      className="icon-btn !h-7 !w-7"
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </div>
              </label>

              <label className="block">
                <span className="fb-t-caption text-[var(--ink-40)]">Length</span>
                <select
                  value={meetDur}
                  onChange={(e) => setMeetDur(e.target.value === '' ? '' : Number(e.target.value))}
                  className="fb-field bg-[var(--surface-sunken)] mt-1 px-2 py-1.5 text-[12px]"
                  data-testid="meet-duration"
                >
                  <option value="">Not set</option>
                  {[15, 30, 45, 60, 90, 120].map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/* The read-back. The fields say what was typed; this says what it
                MEANS — the same sentence the queue row will show. */}
            {localPartsToIso(meetDate, meetTime) && (
              <div className="mt-2 fb-t-caption text-[var(--ink-45)] fb-tabular">
                {formatMeetWhen(
                  Date.parse(localPartsToIso(meetDate, meetTime) as string),
                  meetDur === '' ? null : Number(meetDur),
                  Date.now()
                )}
              </div>
            )}

            {/* DEC-065 — two single-line fields side by side. Stacked, they
                cost a row each and pushed the Save button off a laptop screen;
                neither needs full width to be usable. */}
            <div className="mt-2 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="fb-t-caption text-[var(--ink-40)]">Join link</span>
              <input
                value={meetUrl}
                onChange={(e) => setMeetUrl(e.target.value)}
                placeholder="Google Meet, Zoom, Teams…"
                className="fb-field bg-[var(--surface-sunken)] mt-1 px-2 py-1.5 text-[12px] w-full"
                data-testid="meet-url"
              />
              {/* Honest about a link that will not open: the queue refuses to
                  show a Join button for anything that is not http(s), so the
                  editor says so here rather than letting it fail silently. */}
              {meetUrl.trim() !== '' && (
                <span className="fb-t-caption mt-1 block">
                  {joinUrlOf(meetUrl) ? (
                    <span className="text-[var(--ink-45)]">
                      Opens as {meetProviderLabel(joinUrlOf(meetUrl))}
                    </span>
                  ) : (
                    <span className="text-amber-600">
                      That is not a web link — the queue will not offer a Join button for it.
                    </span>
                  )}
                </span>
              )}
            </label>

            <label className="block">
              <span className="fb-t-caption text-[var(--ink-40)]">Location</span>
              <input
                value={meetLoc}
                onChange={(e) => setMeetLoc(e.target.value)}
                placeholder="An address, a room, or where to meet"
                className="fb-field bg-[var(--surface-sunken)] mt-1 px-2 py-1.5 text-[12px] w-full"
                data-testid="meet-location"
              />
            </label>

            </div>

            <label className="block mt-2">
              <span className="fb-t-caption text-[var(--ink-40)]">Others coming</span>
              <input
                value={meetWho}
                onChange={(e) => setMeetWho(e.target.value)}
                placeholder="sam@acme.com, alex@acme.com"
                className="fb-field bg-[var(--surface-sunken)] mt-1 px-2 py-1.5 text-[12px] w-full"
                data-testid="meet-attendees"
              />
            </label>

            {/* The answer owed. "Waiting on you" is the state that makes an
                invitation interrupt at all, and it is what ruled out modelling
                a Meet item AS a time block — an unanswered invite is not on
                your calendar yet. */}
            <div className="mt-2">
              <span className="fb-t-caption text-[var(--ink-40)]">Your answer</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {[
                  { v: '', label: 'None asked' },
                  { v: 'needed', label: 'Waiting on you' },
                  { v: 'yes', label: 'Yes' },
                  { v: 'maybe', label: 'Maybe' },
                  { v: 'no', label: 'No' }
                ].map((o) => (
                  <button
                    key={o.v || 'none'}
                    onClick={() => setMeetRsvp(o.v)}
                    className={`px-2.5 h-7 fb-t-label fb-press rounded-full ${
                      meetRsvp === o.v
                        ? 'bg-[rgb(var(--accent))] text-white'
                        : 'bg-[var(--surface-sunken)] text-[var(--ink-60)] hover:text-[var(--ink-100)]'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {/* DEC-068 — the link to the calendar. The item is the record of the
                meeting; the block is a reservation of time for it, so this
                reads as putting it somewhere rather than converting it. */}
            <div className="mt-3 pt-2.5 border-t border-[var(--edge-soft)] flex items-center gap-2 flex-wrap">
              <button
                onClick={() => void putOnCalendar()}
                className="btn-soft !h-7 fb-t-label"
                data-testid="meet-schedule"
              >
                <Icon name="event_available" size={13} />
                <span>{linkedBlock ? 'Update the calendar' : 'Put on calendar'}</span>
              </button>
              {linkedBlock && !schedNote && (
                <span className="fb-t-caption text-[var(--ink-45)] fb-tabular">
                  On your calendar · {formatMeetWhen(linkedBlock.startMs, linkedBlock.durationMin, Date.now())}
                </span>
              )}
              {schedNote && (
                <span className="fb-t-caption text-[var(--ink-50)]">{schedNote}</span>
              )}
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="fb-t-caption text-[var(--ink-40)]">Due</span>
            <div className="mt-1 flex items-center gap-1">
              <input
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
                className="fb-field bg-[var(--surface-raised)] px-2 py-1.5 text-[12px]"
              />
              {due && (
                <button
                  onClick={() => setDue('')}
                  title="Clear the due date"
                  className="icon-btn !h-7 !w-7"
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
          </label>
          <label className="block min-w-0">
            <span className="fb-t-caption text-[var(--ink-40)]">Desk</span>
            <select
              value={deskId}
              onChange={(e) => setDeskId(e.target.value)}
              className="fb-field mt-1 bg-[var(--surface-raised)] px-2 py-1.5 text-[12px] max-w-[260px]"
            >
              {!isDeskTask && <option value="">No desk</option>}
              {desks.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title || 'Untitled desk'}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!isDeskTask && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <span className="fb-t-caption text-[var(--ink-40)]">Urgency</span>
            <div className="mt-1 flex items-center gap-1">
              {URGENCY_LEVELS.map((u) => (
                <button
                  key={u}
                  onClick={() => setUrgency(u)}
                  className={`px-2.5 h-7 fb-t-label fb-press rounded-full capitalize ${
                    urgency === u
                      ? 'bg-[rgb(var(--accent))] text-white'
                      : 'bg-[var(--surface-raised)] text-[var(--ink-60)] hover:text-[var(--ink-100)]'
                  }`}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
        </div>
        )}

        {item.sourceUrl && (
          <div className="block mt-3">
            <span className="fb-t-caption text-[var(--ink-40)]">Source</span>
            <button
              onClick={() => {
                // DEC-127 — an internal message link opens the floating
                // assistant on the message; anything else is the web page.
                if (!openMessageLink(item.sourceUrl)) void window.api.files.openExternal(item.sourceUrl!)
              }}
              data-testid="item-source-link"
              title={item.sourceUrl}
              className="mt-1 flex items-center gap-1.5 text-[13px] text-[rgb(var(--accent))] hover:underline fb-press max-w-full"
            >
              <Icon name={parseMessageUrl(item.sourceUrl) ? 'forum' : 'link'} size={13} className="shrink-0" />
              {/* DEC-091 — the exact page this was marked from (frozen at
                  mark time; the widget may have browsed away since). */}
              <span className="truncate">
                {(() => {
                  if (parseMessageUrl(item.sourceUrl)) return 'The message, in PlexiiMessage'
                  try {
                    return new URL(item.sourceUrl!).hostname + new URL(item.sourceUrl!).pathname
                  } catch {
                    return item.sourceUrl
                  }
                })()}
              </span>
              {!parseMessageUrl(item.sourceUrl) && (
                <Icon name="open_in_new" size={12} className="shrink-0 text-[var(--ink-40)]" />
              )}
            </button>
          </div>
        )}

        {!isDeskTask && (
        <div className="block mt-3">
          <span className="fb-t-caption text-[var(--ink-40)]">
            Tags &amp; mentions{' '}
            <span className="text-[var(--ink-30)]">— optional · @ mentions a person, desk, room or plan</span>
          </span>
          <TagMentionInput
            tags={tagList}
            mentions={mentionList}
            onTags={setTagList}
            onMentions={setMentionList}
          />
        </div>
        )}

        {error && <div className="mt-2 text-[12px] text-red-600 dark:text-red-400">{error}</div>}

        <div className="mt-4 flex items-center justify-between">
          <span className="text-[11px] text-[var(--ink-30)]">⌘↵ to save · Esc to cancel</span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onClose(false)}
              className="h-8 px-3 fb-press fb-t-label text-[var(--ink-60)] hover:text-[var(--ink-100)]"
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={busy}
              className="h-8 px-3.5 fb-btn-surface fb-press fb-t-label text-[var(--ink-100)] disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
