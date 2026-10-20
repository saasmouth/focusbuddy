import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { TimeBlockRecurrence } from '@shared/types'
import Icon from './Icon'
import {
  DURATION_STEPS,
  nearestStepIndex,
  resolvePlaceholder,
  rankGuestSuggestions,
  resolveGuestEntry,
  filterSuggestions,
  guestInitials,
  type GuestChip
} from '../lib/bookTime'
import { useMeetingRoomStore } from '../stores/meetingRoom'
import { useTimeBlockStore } from '../stores/timeBlocks'
import { useAccountStore } from '../stores/account'
import { usePresenceStore } from '../stores/presence'
import { useCapabilityEnabled } from '../stores/capabilities'
import { useNodeStore } from '../stores/nodes'
import { newMeetingRoomId } from '../lib/startMeeting'
import { inviteDeliveryNote, sendMeetingInvites } from '../lib/meetingInvite'
import { personDisplayName } from '../lib/personName'
import { useEntitlement } from '../lib/entitlementReason'

// Start or schedule a meeting — the Calendar's Book-time composer, twinned
// (operator, 2026-09-06: "nearly identical" to the booking page). The same
// header slider, the same 23px title with placeholder resolution, the same
// date / start → end chips with duration cycling and the quiet Repeat chip,
// GUESTS as chips on a filled field with ranked suggestions, WHERE as one
// segmented question, AGENDA, the Attach row, and the Esc / ↵ footer. Every
// recipe below is BookTimeDialog's own string, so the two cannot drift apart
// without a test noticing (meetDialogTwin.test.ts).
//
// What is Meet's, not the Calendar's: the slider chooses Start now vs
// Schedule (both meetings — there is no Focus here). Start now opens the live
// room at once, rings the online teammates you picked, and emails the join
// link to everyone else; Schedule writes a real calendar meeting block (room
// id minted, guests / where / agenda / attach / repeat all persisted) and
// emails the invites. Email rides the connected mailbox; without one we say
// so rather than pretend the invites went out.

type Mode = 'now' | 'schedule'

/** A guest is an email (anyone, anywhere) or a teammate online right now
 *  (rung into the live room; no address needed). */
type Guest = GuestChip & { accountId?: string; handle?: string }

function guestKey(g: Guest): string {
  return g.accountId ?? g.email.toLowerCase()
}

function fmtDateChip(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}

function fmtTimeChip(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

function toDateInputValue(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function toTimeInputValue(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

const REPEAT_LABEL: Record<TimeBlockRecurrence, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly'
}

// The default schedule slot: the next round half hour, built from local
// parts so the chips match the clock.
function nextHalfHour(): number {
  const d = new Date()
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() <= 30 ? 30 : 60)
  return d.getTime()
}

export default function NewMeetingDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const reduceMotion = useReducedMotion()
  const startRoom = useMeetingRoomStore((s) => s.start)
  const inviteToRoom = useMeetingRoomStore((s) => s.invite)
  const createBlock = useTimeBlockStore((s) => s.create)
  const account = useAccountStore((s) => s.account)
  const accountEmail = useAccountStore((s) => s.account?.email ?? s.cachedEmail)
  const workspaceDomain = accountEmail?.includes('@') ? accountEmail.split('@')[1] : null
  // Live presence is a Team-tier capability: the online-now teammates render
  // only when it allows. Email guests are for everyone.
  const presenceEnabled = useCapabilityEnabled('presence')
  const presencePeers = usePresenceStore((s) => s.peers)
  // Starting a meeting needs 'meet'; scheduling one also needs 'meet_schedule'.
  // A blocked action reports the reason rather than starting or scheduling.
  const meetEnt = useEntitlement('meet', 'Meetings')
  const scheduleEnt = useEntitlement('meet_schedule', 'Meeting scheduling')
  const hostName = account ? personDisplayName(account) : undefined

  const [mode, setMode] = useState<Mode>('now')
  const [title, setTitle] = useState('')
  const [titleFocused, setTitleFocused] = useState(false)
  const [startMs, setStartMs] = useState(nextHalfHour)
  const [durationMin, setDurationMin] = useState(30)
  const cycleIdx = useRef<number | null>(DURATION_STEPS.indexOf(30))
  const [repeat, setRepeat] = useState<TimeBlockRecurrence | ''>('')
  const [repeatOpen, setRepeatOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // ── Guests — chips; suggestions rank past invitees by shared-meeting recency,
  // and in Start-now mode the teammates online right now sit on top. ───────
  const [guests, setGuests] = useState<Guest[]>([])
  const [guestInput, setGuestInput] = useState('')
  const [guestSel, setGuestSel] = useState(0)
  const [guestFocused, setGuestFocused] = useState(false)
  const [contacts, setContacts] = useState<GuestChip[]>([])
  useEffect(() => {
    const now = Date.now()
    window.api?.timeBlocks
      ?.list(now - 90 * 86_400_000, now + 30 * 86_400_000)
      .then((bs) => setContacts(rankGuestSuggestions(bs)))
      .catch(() => setContacts([]))
  }, [])
  const chosenEmails = useMemo(() => guests.filter((g) => g.email).map((g) => g.email), [guests])
  const peers = useMemo(
    () =>
      presenceEnabled
        ? Object.values(presencePeers).map((p) => ({
            chip: {
              name: personDisplayName(p, p.handle),
              email: '',
              accountId: p.accountId,
              handle: p.handle
            } as Guest,
            status: p.status as string
          }))
        : [],
    [presenceEnabled, presencePeers]
  )
  const suggestions = useMemo(() => {
    const q = guestInput.trim().toLowerCase()
    const chosen = new Set(guests.map(guestKey))
    const online =
      mode === 'now'
        ? peers.filter(
            (p) =>
              !chosen.has(guestKey(p.chip)) &&
              (!q || p.chip.name.toLowerCase().includes(q) || (p.chip.handle ?? '').toLowerCase().includes(q))
          )
        : []
    const past = filterSuggestions(contacts, guestInput, chosenEmails).map((chip) => ({
      chip: chip as Guest,
      status: null as string | null
    }))
    return [
      ...online.map((p) => ({
        chip: p.chip,
        status: p.status as string | null
      })),
      ...past
    ]
  }, [mode, peers, contacts, guestInput, guests, chosenEmails])

  // ── Where / agenda / attach — the scheduled meeting's facts. A live room
  // started now IS Plexii Meet, takes no agenda and links no desk, so those
  // fields reveal with Schedule, the way the composer reveals meeting fields.
  const [where, setWhere] = useState<'plexi' | 'link' | 'inperson' | 'none'>('plexi')
  const [joinUrl, setJoinUrl] = useState('')
  const [location, setLocation] = useState('')
  const [agenda, setAgenda] = useState('')
  const nodes = useNodeStore((s) => s.nodes)
  const desks = useMemo(
    () => nodes.filter((n) => n.kind === 'task' && n.status !== 'done').sort((a, b) => b.updatedAt - a.updatedAt),
    [nodes]
  )
  const [attached, setAttached] = useState<{
    id: string
    title: string
  } | null>(null)
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachQuery, setAttachQuery] = useState('')
  const attachMatches = useMemo(() => {
    const q = attachQuery.trim().toLowerCase()
    return desks.filter((d) => !q || d.title.toLowerCase().includes(q)).slice(0, 8)
  }, [desks, attachQuery])

  const titleRef = useRef<HTMLInputElement | null>(null)
  const dateRef = useRef<HTMLInputElement | null>(null)
  const timeRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const guestNames = useMemo(() => guests.map((g) => g.name), [guests])
  const placeholder = useMemo(
    () =>
      resolvePlaceholder({
        mode: 'meeting',
        attachedTitle: attached?.title ?? null,
        guests: guestNames,
        roomName: null
      }),
    [attached, guestNames]
  )

  function cycleDuration(back: boolean): void {
    if (cycleIdx.current == null) cycleIdx.current = nearestStepIndex(durationMin)
    else cycleIdx.current = Math.min(DURATION_STEPS.length - 1, Math.max(0, cycleIdx.current + (back ? -1 : 1)))
    setDurationMin(DURATION_STEPS[cycleIdx.current])
  }

  function addGuest(chip: Guest): void {
    setGuests((gs) => (gs.some((g) => guestKey(g) === guestKey(chip)) ? gs : [...gs, chip]))
  }
  function commitGuest(pick?: Guest): void {
    const chip = pick ?? resolveGuestEntry(guestInput, contacts, workspaceDomain)
    if (!chip) return
    addGuest(chip)
    setGuestInput('')
    setGuestSel(0)
  }
  function togglePeer(chip: Guest): void {
    setGuests((gs) =>
      gs.some((g) => guestKey(g) === guestKey(chip)) ? gs.filter((g) => guestKey(g) !== guestKey(chip)) : [...gs, chip]
    )
  }

  /** ENTER GUARD: the guest input consumes Enter to commit a chip —
   *  stopPropagation on every branch keeps the dialog-level Enter-commits
   *  handler from ever seeing it. Tab with content commits too; Backspace on
   *  an empty input deletes the last chip. */
  function onGuestKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      commitGuest(suggestions.length > 0 ? suggestions[Math.min(guestSel, suggestions.length - 1)].chip : undefined)
      return
    }
    if (e.key === ',') {
      e.preventDefault()
      commitGuest()
      return
    }
    if (e.key === 'Tab' && guestInput.trim()) {
      e.preventDefault()
      commitGuest(suggestions.length > 0 ? suggestions[Math.min(guestSel, suggestions.length - 1)].chip : undefined)
      return
    }
    if (e.key === 'Backspace' && guestInput === '' && guests.length > 0) {
      setGuests((gs) => gs.slice(0, -1))
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setGuestSel((s) => Math.min(s + 1, Math.max(0, suggestions.length - 1)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setGuestSel((s) => Math.max(0, s - 1))
    }
  }

  /** ENTER GUARD, agenda half: plain Enter is consumed; Shift+Enter is the newline. */
  function onAgendaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter') {
      e.stopPropagation()
      if (!e.shiftKey) e.preventDefault()
    }
  }

  function moveDate(dateValue: string): void {
    const [y, m, d] = dateValue.split('-').map(Number)
    if (!y || !m || !d) return
    const next = new Date(startMs)
    next.setFullYear(y, m - 1, d)
    setStartMs(next.getTime())
  }
  function moveStart(timeValue: string): void {
    const [h, min] = timeValue.split(':').map(Number)
    if (Number.isNaN(h) || Number.isNaN(min)) return
    const next = new Date(startMs)
    next.setHours(h, min, 0, 0)
    setStartMs(next.getTime())
  }

  /** The guest list at commit time — a typed, uncommitted address still counts. */
  function finalGuests(): Guest[] {
    const pending = guestInput.trim() ? resolveGuestEntry(guestInput, contacts, workspaceDomain) : null
    return pending && !guests.some((g) => guestKey(g) === guestKey(pending)) ? [...guests, pending] : guests
  }

  async function commit(): Promise<void> {
    if (busy) return
    const all = finalGuests()
    const emails = Array.from(
      new Set(all.filter((g) => g.email.includes('@')).map((g) => g.email.trim().toLowerCase()))
    )
    const ring = all.filter((g) => g.accountId && g.handle)
    // Empty on commit writes the placeholder value as the REAL title — the
    // user is never blocked on naming.
    const finalTitle = title.trim() || placeholder
    if (mode === 'now') {
      if (!meetEnt.enabled) {
        setError(meetEnt.reason)
        return
      }
      setBusy(true)
      setError(null)
      setNote(null)
      try {
        const roomId = await startRoom(finalTitle)
        if (!roomId) {
          setError('Could not start the meeting. Check your microphone and camera permissions.')
          return
        }
        // Online teammates get a realtime ring into the live room; it lands as
        // their in-app meeting-invite notification.
        for (const p of ring) inviteToRoom({ accountId: p.accountId!, handle: p.handle! })
        // Email the join link for the room we just opened, so invited guests
        // land in the same room. Delivery is reported honestly.
        if (emails.length > 0) {
          const r = await sendMeetingInvites({
            title: finalTitle,
            startMs: Date.now(),
            durationMin,
            roomId,
            invitees: emails,
            hostName
          })
          const msg = inviteDeliveryNote(r, emails.length)
          if (msg) setNote(msg)
        }
        onClose()
      } finally {
        setBusy(false)
      }
      return
    }
    if (!scheduleEnt.enabled) {
      setError(scheduleEnt.reason)
      return
    }
    if (!Number.isFinite(startMs)) {
      setError('Pick a valid date and time.')
      return
    }
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      // The real meeting payload — the composer's: a room id is always minted
      // (any meeting can be joined remotely), the external link or the place
      // ride beside it, the agenda too. The attached desk links the block.
      const roomId = newMeetingRoomId()
      const meeting = {
        roomId,
        invitees: emails,
        joinUrl: where === 'link' && joinUrl.trim() ? joinUrl.trim() : null,
        location: where === 'inperson' && location.trim() ? location.trim() : null,
        agenda: agenda.trim() || null
      }
      await createBlock({
        taskId: attached?.id ?? null,
        title: finalTitle,
        startMs,
        durationMin,
        meeting,
        recurrence: repeat || null
      })
      let msg = 'Meeting scheduled. It is on your calendar with a Join button.'
      if (emails.length > 0) {
        const r = await sendMeetingInvites({
          title: finalTitle,
          startMs,
          durationMin,
          roomId,
          invitees: emails,
          hostName,
          joinUrl: meeting.joinUrl,
          location: meeting.location
        })
        const im = inviteDeliveryNote(r, emails.length)
        if (im) msg = `${msg} ${im}`
      }
      setNote(msg)
      // Give the confirmation a moment to read, then close.
      setTimeout(onClose, 1400)
    } finally {
      setBusy(false)
    }
  }

  function switchMode(m: Mode): void {
    setMode(m)
    setNote(null)
    setError(null)
  }

  /** Enter commits from anywhere except Guests and Agenda; Esc discards;
   *  Cmd+M toggles the mode. */
  function onDialogKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault()
      switchMode(mode === 'now' ? 'schedule' : 'now')
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void commit()
    }
  }

  const thumbTransition = reduceMotion ? { duration: 0 } : { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const }
  const revealTransition = reduceMotion ? { duration: 0 } : { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const }

  const chip =
    'h-9 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] text-[13px] font-medium ' +
    'text-[var(--ink-90)] fb-tabular fb-press inline-flex items-center gap-1.5'
  const chipStatic =
    'h-9 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] text-[13px] font-medium ' +
    'text-[var(--ink-90)] fb-tabular inline-flex items-center gap-1.5 cursor-default'
  const field =
    'w-full h-9 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] outline-none [&:focus-visible]:outline-none border border-transparent focus:border-[rgb(var(--accent))] text-[13px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)] transition-colors'

  const emailCount = finalGuests().filter((g) => g.email.includes('@')).length
  const ringCount = guests.filter((g) => g.accountId).length
  const inviteCount = mode === 'now' ? emailCount + ringCount : emailCount
  const primaryLabel =
    mode === 'now'
      ? inviteCount > 0
        ? `Start & invite ${inviteCount}`
        : 'Start now'
      : inviteCount > 0
        ? `Schedule & invite ${inviteCount}`
        : 'Schedule meeting'

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.15, ease: 'easeOut' }}
      className="fb-scrim fixed inset-0 z-[300] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.985, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{
          duration: reduceMotion ? 0 : 0.2,
          ease: [0.16, 1, 0.3, 1]
        }}
        role="dialog"
        aria-modal="true"
        aria-label="New meeting"
        data-testid="new-meeting-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        className="fb-card w-full max-w-[560px] overflow-hidden max-h-[86vh] flex flex-col shadow-[0_32px_80px_-16px_rgba(0,0,0,0.5)]"
      >
        <div className="px-6 pt-5 pb-5 flex flex-col gap-4 overflow-y-auto">
          {/* ── Mode slider — the header. Mode decides which fields exist. ── */}
          <div
            role="tablist"
            aria-label="When"
            className="relative grid grid-cols-2 rounded-full bg-[var(--surface-sunken)] p-1 select-none"
            data-testid="new-meeting-mode"
          >
            <motion.span
              aria-hidden
              className="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-[var(--surface-raised)] border border-[var(--edge-soft)] shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
              animate={{ x: mode === 'schedule' ? '100%' : '0%' }}
              transition={thumbTransition}
              data-testid="new-meeting-mode-thumb"
            />
            {(
              [
                ['now', 'videocam', 'Start now'],
                ['schedule', 'event', 'Schedule']
              ] as const
            ).map(([m, icon, label]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => switchMode(m)}
                onKeyDown={(e) => {
                  if (e.key === ' ') {
                    e.preventDefault()
                    switchMode(m)
                  }
                }}
                data-testid={`new-meeting-mode-${m}`}
                className={`relative z-10 h-9 rounded-full inline-flex items-center justify-center gap-2 text-[13.5px] font-semibold transition-colors fb-press ${
                  mode === m ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-50)]'
                }`}
              >
                <Icon name={icon} size={16} />
                {label}
              </button>
            ))}
          </div>

          {/* ── Title — the act of intent. Empty commits the placeholder as the real name. ── */}
          <div>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onFocus={() => setTitleFocused(true)}
              onBlur={() => setTitleFocused(false)}
              placeholder={placeholder}
              aria-label="Title"
              data-testid="new-meeting-title"
              className="w-full bg-transparent text-[23px] font-semibold text-[var(--ink-100)] placeholder:text-[var(--ink-50)] outline-none [&:focus-visible]:outline-none border-b border-[var(--edge-soft)] focus:border-[rgb(var(--accent))] pb-1.5 transition-colors"
            />
            <div className="h-[18px] pt-1 text-[11.5px] text-[var(--ink-50)] leading-tight" aria-live="polite">
              {titleFocused && title === '' && (
                <>
                  Leave blank and it saves as <span className="font-semibold text-[var(--ink-70)]">{placeholder}</span>
                </>
              )}
            </div>
          </div>

          {/* ── Time row — one row, one fact. Start now: today, now → end (cycles).
                 Schedule: date + start open pickers, the end chip cycles, Repeat. ── */}
          <div className="flex items-center gap-2 flex-wrap" data-testid="new-meeting-when">
            {mode === 'now' ? (
              <>
                <span className={chipStatic} title="Starts the moment you press Start">
                  {fmtDateChip(Date.now())}
                </span>
                <span className={chipStatic} data-testid="new-meeting-now">
                  Now
                </span>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={chip}
                  data-testid="new-meeting-date"
                  title="Change the date"
                  onClick={() => {
                    const el = dateRef.current
                    if (!el) return
                    try {
                      el.showPicker()
                    } catch {
                      el.focus()
                    }
                  }}
                >
                  {fmtDateChip(startMs)}
                  <input
                    ref={dateRef}
                    type="date"
                    tabIndex={-1}
                    aria-hidden
                    value={toDateInputValue(startMs)}
                    onChange={(e) => moveDate(e.target.value)}
                    className="sr-only"
                    data-testid="new-meeting-date-input"
                  />
                </button>
                <button
                  type="button"
                  className={chip}
                  data-testid="new-meeting-time"
                  title="Change the start time"
                  onClick={() => {
                    const el = timeRef.current
                    if (!el) return
                    try {
                      el.showPicker()
                    } catch {
                      el.focus()
                    }
                  }}
                >
                  {fmtTimeChip(startMs)}
                  <input
                    ref={timeRef}
                    type="time"
                    tabIndex={-1}
                    aria-hidden
                    value={toTimeInputValue(startMs)}
                    onChange={(e) => moveStart(e.target.value)}
                    className="sr-only"
                    data-testid="new-meeting-time-input"
                  />
                </button>
              </>
            )}
            <span aria-hidden className="text-[var(--ink-40)]">
              →
            </span>
            <button
              type="button"
              className={chip}
              data-testid="new-meeting-end"
              title="Click: longer · Shift+Click: shorter"
              aria-label={`Ends after ${durationMin} minutes — click to cycle duration`}
              onClick={(e) => cycleDuration(e.shiftKey)}
              onKeyDown={(e) => {
                if (e.key === ' ') {
                  e.preventDefault()
                  cycleDuration(e.shiftKey)
                }
              }}
            >
              {fmtTimeChip((mode === 'now' ? Date.now() : startMs) + durationMin * 60_000)}
            </button>
            <span className="text-[12px] text-[var(--ink-50)] fb-tabular" data-testid="new-meeting-duration">
              {durationMin >= 60 && durationMin % 60 === 0 ? `${durationMin / 60}h` : `${durationMin}m`}
            </span>
            {mode === 'schedule' && (
              <div className="relative ml-auto">
                <button
                  type="button"
                  data-testid="new-meeting-repeat"
                  onClick={() => setRepeatOpen((o) => !o)}
                  onKeyDown={(e) => {
                    if (e.key === ' ') {
                      e.preventDefault()
                      setRepeatOpen((o) => !o)
                    }
                  }}
                  aria-expanded={repeatOpen}
                  className="h-9 px-2 text-[13px] font-medium text-[var(--ink-70)] hover:text-[var(--ink-100)] transition-colors fb-press rounded-[var(--radius-chip)]"
                >
                  {repeat ? REPEAT_LABEL[repeat] : 'Repeat'}
                </button>
                {repeatOpen && (
                  <div className="absolute right-0 top-10 z-20 w-40 rounded-[var(--radius-row)] fb-glass-panel fb-pop-in p-1 text-[13px]">
                    {(['daily', 'weekly', 'monthly'] as const).map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => {
                          setRepeat(r)
                          setRepeatOpen(false)
                        }}
                        className={`w-full text-left px-2 py-1.5 rounded-[var(--radius-chip)] hover:bg-[var(--surface-sunken)] fb-press ${
                          repeat === r ? 'text-[rgb(var(--accent))] font-semibold' : ''
                        }`}
                      >
                        {REPEAT_LABEL[r]}
                      </button>
                    ))}
                    {repeat && (
                      <button
                        type="button"
                        onClick={() => {
                          setRepeat('')
                          setRepeatOpen(false)
                        }}
                        className="w-full text-left px-2 py-1.5 rounded-[var(--radius-chip)] hover:bg-[var(--surface-sunken)] fb-press text-[var(--ink-50)]"
                      >
                        Don&rsquo;t repeat
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── GUESTS — chips on a filled field. Enter/comma/Tab commit; Backspace
                 on empty deletes the last; online teammates lead the suggestions
                 in Start-now mode and can be tapped straight from the strip. ── */}
          <div className="relative">
            <div className="text-[10.5px] font-semibold tracking-wider text-[var(--ink-40)] mb-1">GUESTS</div>
            <div
              className="min-h-10 px-2 py-1.5 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] flex flex-wrap items-center gap-1.5 cursor-text"
              onClick={(e) => {
                ;(e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()
              }}
              data-testid="new-meeting-guests"
            >
              {guests.map((g) => (
                <span
                  key={guestKey(g)}
                  data-testid="new-meeting-guest-chip"
                  title={g.email || `@${g.handle} — online now`}
                  className="inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-full bg-[var(--surface-raised)] border border-[var(--edge-soft)] text-[12.5px] text-[var(--ink-90)]"
                >
                  <span
                    aria-hidden
                    className="h-5 w-5 rounded-full bg-accent/15 text-[rgb(var(--accent))] text-[9px] font-bold inline-flex items-center justify-center"
                  >
                    {guestInitials(g.name)}
                  </span>
                  {g.name}
                  {g.accountId && (
                    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" title="Online now" />
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${g.name}`}
                    onClick={() => setGuests((gs) => gs.filter((x) => guestKey(x) !== guestKey(g)))}
                    className="text-[var(--ink-40)] hover:text-[var(--ink-90)] transition-colors fb-press"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </span>
              ))}
              <input
                value={guestInput}
                onChange={(e) => {
                  setGuestInput(e.target.value)
                  setGuestSel(0)
                }}
                onKeyDown={onGuestKeyDown}
                onFocus={() => setGuestFocused(true)}
                onBlur={() => setTimeout(() => setGuestFocused(false), 120)}
                placeholder={guests.length === 0 ? 'Name or email' : ''}
                aria-label="Guests"
                data-testid="new-meeting-invitees"
                className="flex-1 min-w-[120px] bg-transparent outline-none [&:focus-visible]:outline-none text-[13px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)] py-0.5"
              />
            </div>
            {guestFocused && suggestions.length > 0 && (
              <div
                className="absolute left-0 right-0 top-full mt-1 z-20 rounded-[var(--radius-row)] fb-glass-panel fb-pop-in p-1"
                data-testid="new-meeting-guest-suggestions"
              >
                {suggestions.map((s, i) => (
                  <button
                    key={guestKey(s.chip)}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      commitGuest(s.chip)
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-chip)] text-left text-[12.5px] fb-press ${
                      i === guestSel ? 'bg-[var(--surface-sunken)]' : 'hover:bg-[var(--surface-sunken)]'
                    }`}
                  >
                    <span
                      aria-hidden
                      className="h-5 w-5 rounded-full bg-accent/15 text-[rgb(var(--accent))] text-[9px] font-bold inline-flex items-center justify-center shrink-0"
                    >
                      {guestInitials(s.chip.name)}
                    </span>
                    <span className="text-[var(--ink-90)]">{s.chip.name}</span>
                    {s.chip.accountId ? (
                      <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> online
                        {s.status && s.status !== 'online' ? ` · ${s.status}` : ''}
                      </span>
                    ) : (
                      <span className="ml-auto text-[11px] text-[var(--ink-40)] truncate">{s.chip.email}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {mode === 'now' && peers.length > 0 && (
              <div className="mt-2 flex items-center gap-1.5 flex-wrap" data-testid="new-meeting-peers">
                <span className="text-[11px] text-[var(--ink-50)] mr-0.5">Online now</span>
                {peers.map((p) => {
                  const on = guests.some((g) => guestKey(g) === guestKey(p.chip))
                  return (
                    <button
                      key={p.chip.accountId}
                      type="button"
                      onClick={() => togglePeer(p.chip)}
                      aria-pressed={on}
                      data-testid={`new-meeting-peer-${p.chip.accountId}`}
                      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] fb-press transition-colors border ${
                        on
                          ? 'border-[rgb(var(--accent))] text-[rgb(var(--accent))] bg-accent/10'
                          : 'border-[var(--edge-soft)] text-[var(--ink-70)] hover:text-[var(--ink-100)]'
                      }`}
                      title={
                        on
                          ? 'Will be rung when the meeting starts — click to remove'
                          : 'Ring them when the meeting starts'
                      }
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      {p.chip.name}
                      {(p.status === 'away' || p.status === 'busy' || p.status === 'focus') && (
                        <span className="text-[10px] text-amber-600 dark:text-amber-400">{p.status}</span>
                      )}
                      {on && <Icon name="check" size={12} />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* ── WHERE — one question. Start now has one honest answer; Schedule
                 has the composer's four, and only the chosen branch expands. ── */}
          <div>
            <div className="text-[10.5px] font-semibold tracking-wider text-[var(--ink-40)] mb-1">WHERE</div>
            {mode === 'now' ? (
              <div
                className="flex items-start gap-1.5 text-[12px] text-[var(--ink-70)] leading-snug"
                data-testid="new-meeting-where-now"
              >
                <Icon name="check" size={13} className="text-[rgb(var(--accent))] shrink-0 mt-px" />
                <span>
                  A PlexiiCall room opens for you the moment you start. Online teammates you picked are rung; everyone
                  else is emailed the join link — anyone with it can join, inside or outside your organisation.
                </span>
              </div>
            ) : (
              <>
                <div className="flex rounded-full bg-[var(--surface-sunken)] p-1 select-none">
                  {(
                    [
                      ['plexi', 'videocam', 'PlexiiCall'],
                      ['link', 'link', 'Paste link'],
                      ['inperson', 'place', 'In person'],
                      ['none', null, 'None']
                    ] as const
                  ).map(([w, icon, label]) => (
                    <button
                      key={w}
                      type="button"
                      aria-pressed={where === w}
                      onClick={() => setWhere(w)}
                      className={`flex-1 h-8 rounded-full inline-flex items-center justify-center gap-1.5 text-[12.5px] font-medium transition-colors fb-press ${
                        where === w
                          ? 'bg-[var(--surface-raised)] border border-[var(--edge-soft)] text-[rgb(var(--accent))] shadow-[0_1px_3px_rgba(0,0,0,0.06)]'
                          : 'text-[var(--ink-50)] hover:text-[var(--ink-70)]'
                      }`}
                      data-testid={`new-meeting-where-${w}`}
                    >
                      {icon && <Icon name={icon} size={14} />}
                      {label}
                    </button>
                  ))}
                </div>
                {where === 'plexi' && (
                  <div className="flex items-start gap-1.5 mt-2 text-[12px] text-[var(--ink-70)] leading-snug">
                    <Icon name="check" size={13} className="text-[rgb(var(--accent))] shrink-0 mt-px" />
                    <span>
                      A PlexiiCall link is created and emailed with the invite. Anyone with the link can join in
                      PlexiiDesk, inside or outside your organisation.
                    </span>
                  </div>
                )}
                {where === 'link' && (
                  <input
                    autoFocus
                    value={joinUrl}
                    onChange={(e) => setJoinUrl(e.target.value)}
                    placeholder="Paste a Google Meet, Zoom or Teams link"
                    aria-label="Meeting link"
                    data-testid="new-meeting-where-link-input"
                    className={`mt-2 ${field}`}
                  />
                )}
                {where === 'inperson' && (
                  <input
                    autoFocus
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="An address, a room, or where to meet"
                    aria-label="Location"
                    data-testid="new-meeting-where-inperson-input"
                    className={`mt-2 ${field}`}
                  />
                )}
              </>
            )}
          </div>

          {/* ── Schedule-only: AGENDA (rides the block into the Stage's PREP pane)
                 and Attach (a real desk — the block links to it). ── */}
          <AnimatePresence initial={false}>
            {mode === 'schedule' && (
              <motion.div
                key="schedule-fields"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={revealTransition}
                className="overflow-hidden"
                data-testid="new-meeting-schedule-fields"
              >
                <div className="flex flex-col gap-3.5">
                  <div>
                    <div className="text-[10.5px] font-semibold tracking-wider text-[var(--ink-40)] mb-1">AGENDA</div>
                    <textarea
                      rows={2}
                      value={agenda}
                      onChange={(e) => setAgenda(e.target.value)}
                      onKeyDown={onAgendaKeyDown}
                      placeholder="What this meeting needs to settle"
                      aria-label="Agenda"
                      data-testid="new-meeting-agenda"
                      className="w-full px-3 py-2 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] outline-none [&:focus-visible]:outline-none border border-transparent focus:border-[rgb(var(--accent))] text-[13px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)] resize-none transition-colors"
                    />
                  </div>
                  <div className="relative self-start inline-flex items-center gap-2">
                    <button
                      type="button"
                      data-testid="new-meeting-attach"
                      onClick={() => {
                        if (attached) setAttached(null)
                        else setAttachOpen((o) => !o)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === ' ') {
                          e.preventDefault()
                          if (attached) setAttached(null)
                          else setAttachOpen((o) => !o)
                        }
                      }}
                      aria-expanded={attachOpen}
                      title={attached ? 'Detach the desk' : 'Attach a desk — the meeting block links to it'}
                      className="h-10 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] border border-[var(--edge-strong)] inline-flex items-center gap-2 text-[13px] text-[var(--ink-70)] fb-press transition-colors hover:text-[var(--ink-90)]"
                    >
                      <Icon name="folder" size={15} />
                      {attached ? attached.title : 'Attach a desk or work item'}
                      {attached && <Icon name="close" size={13} className="text-[var(--ink-40)]" />}
                    </button>
                    {attached && (
                      <span
                        data-testid="new-meeting-staged"
                        title="Staged — the desk can be prepared before this meeting starts"
                        className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[11px] font-semibold"
                      >
                        <Icon name="bolt" size={11} />
                        Staged
                      </span>
                    )}
                    {attachOpen && !attached && (
                      <div
                        className="absolute left-0 top-11 z-20 w-72 rounded-[var(--radius-row)] fb-glass-panel fb-pop-in p-1.5"
                        data-testid="new-meeting-attach-picker"
                      >
                        <input
                          autoFocus
                          value={attachQuery}
                          onChange={(e) => setAttachQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              e.stopPropagation()
                              const first = attachMatches[0]
                              if (first) {
                                setAttached({
                                  id: first.id,
                                  title: first.title
                                })
                                setAttachOpen(false)
                              }
                            }
                            if (e.key === 'Escape') {
                              e.stopPropagation()
                              setAttachOpen(false)
                            }
                          }}
                          placeholder="Find a desk"
                          aria-label="Find a desk"
                          className={`${field} h-8 mb-1`}
                        />
                        {attachMatches.length === 0 ? (
                          <p className="px-2 py-2 text-[12px] text-[var(--ink-50)]">No open desks match.</p>
                        ) : (
                          attachMatches.map((d) => (
                            <button
                              key={d.id}
                              type="button"
                              onClick={() => {
                                setAttached({ id: d.id, title: d.title })
                                setAttachOpen(false)
                              }}
                              data-testid={`new-meeting-attach-${d.id}`}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-chip)] text-left text-[12.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] fb-press"
                            >
                              <Icon name="desk" size={14} className="text-[var(--ink-50)] shrink-0" />
                              <span className="truncate">{d.title}</span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {note && (
            <div
              className="rounded-[var(--radius-field)] bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[12px] px-3 py-2"
              data-testid="new-meeting-note"
            >
              {note}
            </div>
          )}
          {error && (
            <div
              className="rounded-[var(--radius-field)] bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[12px] px-3 py-2"
              data-testid="new-meeting-error"
            >
              {error}
            </div>
          )}
        </div>

        {/* ── Bottom row: Esc is the cancel; the action keeps its name. ── */}
        <div className="px-6 py-4 border-t border-[var(--edge-soft)] flex items-center gap-3 shrink-0">
          <span className="text-[12px] text-[var(--ink-50)]">
            <kbd className="px-1.5 py-0.5 rounded bg-[var(--surface-sunken)] text-[11px] font-medium text-[var(--ink-50)]">
              Esc
            </kbd>{' '}
            to discard
          </span>
          <button
            type="button"
            onClick={() => void commit()}
            disabled={busy}
            data-testid={mode === 'now' ? 'new-meeting-start' : 'new-meeting-schedule'}
            className="btn-primary ml-auto"
          >
            <Icon name={mode === 'now' ? 'videocam' : 'event'} size={14} />
            <span>{primaryLabel}</span>
            <span aria-hidden className="rounded bg-white/20 px-1 text-[11px] leading-4">
              ↵
            </span>
          </button>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  )
}
