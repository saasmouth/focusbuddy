import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { FbNode, TimeBlock, TimeBlockMeeting, TimeBlockPatch, TimeBlockRecurrence } from '@shared/types'
import Icon from './Icon'
import {
  DURATION_STEPS,
  nearestStepIndex,
  resolvePlaceholder,
  rankGuestSuggestions,
  resolveGuestEntry,
  filterSuggestions,
  guestInitials,
  nameFromEmail,
  parseBlockTokens,
  type GuestChip
} from '../lib/bookTime'
import { useAccountStore } from '../stores/account'
import { useNodeStore } from '../stores/nodes'
import { newMeetingRoomId } from '../lib/startMeeting'

// Book time — the dialog a drag-selected range opens on the Calendar.
// Spec: the book-time contract (operator, 2026-08-30). The dialog owns the
// complete flow: intent, time, guests, place, agenda and a persisted link to
// the desk or work item that should be ready when the block begins.
//
// The design rule the spec leads with: mode decides which fields exist, so
// the mode slider IS the header; the title is the act of intent, everything
// under it is refinement; the fast path never leaves the title field.

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

export default function BookTimeDialog({
  startMs: initialStartMs,
  initialDurationMin,
  initialTitle,
  prefillNode,
  proposal,
  editBlock,
  onSave,
  roomName = null,
  onCancel,
  onCreate
}: {
  startMs: number
  /** DEC-053 — a drag-selected span opens at exactly that length. */
  initialDurationMin?: number
  /** Inline create's Cmd+Enter carries the typed draft in here. */
  initialTitle?: string
  /** Step 8 — the Attendant-proposed state: SAME dialog, same fields, fully
   *  editable (a proposal you can't edit in place isn't a proposal), with a
   *  stated default and a countdown. Esc dismisses — one keystroke, no
   *  reason asked. At the deadline it books itself. hold-time doesn't exist
   *  yet (SPEC-002's wire name, unruled), so only the manual trigger fires
   *  this today — built now so the proposed state is native, not bolted on. */
  proposal?: { reason: string; autoBookAtMs: number }
  /** A node dragged onto the grid — becomes the persisted Attach value. */
  prefillNode?: { id: string; title: string; kind: FbNode['kind'] }
  /** Placeholder rule 4's source. The Calendar page has no live room
   *  context today, so this arrives null and the rule falls to "Focus". */
  roomName?: string | null
  /** EDIT MODE — double-clicking a booked block opens this same dialog with
   *  every field seeded from the block (title, time, guests, where, agenda,
   *  attach). Recurrence is read-only here: occurrences are materialised
   *  rows, so a recurrence edit is series surgery, not a field write. */
  editBlock?: TimeBlock
  onSave?: (patch: TimeBlockPatch) => Promise<void>
  onCancel: () => void
  onCreate?: (
    taskId: string | null,
    title: string,
    startMs: number,
    durationMin: number,
    meeting: TimeBlockMeeting | null,
    recurrence: TimeBlockRecurrence | null
  ) => Promise<void>
}): JSX.Element {
  const reduceMotion = useReducedMotion()
  const isEdit = !!editBlock
  const [mode, setMode] = useState<'focus' | 'meeting'>(editBlock?.meeting ? 'meeting' : 'focus')
  const [title, setTitle] = useState(editBlock?.title ?? initialTitle ?? '')
  const [titleFocused, setTitleFocused] = useState(false)
  const [startMs, setStartMs] = useState(initialStartMs)
  // The seed is never clobbered: it displays as-is (DEC-053), and the first
  // cycle click jumps to the nearest step rather than resetting.
  const [durationMin, setDurationMin] = useState(initialDurationMin ?? 60)
  const cycleIdx = useRef<number | null>(
    DURATION_STEPS.includes(initialDurationMin ?? 60) ? DURATION_STEPS.indexOf(initialDurationMin ?? 60) : null
  )
  const [repeat, setRepeat] = useState<TimeBlockRecurrence | ''>(editBlock?.recurrence ?? '')
  const [repeatOpen, setRepeatOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  // ── Step 4 — the meeting-only fields ────────────────────────────────────
  const [guests, setGuests] = useState<GuestChip[]>(
    (editBlock?.meeting?.invitees ?? []).map((e) => ({
      email: e,
      name: nameFromEmail(e)
    }))
  )
  const [guestInput, setGuestInput] = useState('')
  const [guestSel, setGuestSel] = useState(0)
  const [guestFocused, setGuestFocused] = useState(false)
  const [contacts, setContacts] = useState<GuestChip[]>([])
  const [where, setWhere] = useState<'plexi' | 'link' | 'inperson' | 'none'>(
    editBlock?.meeting?.joinUrl ? 'link' : editBlock?.meeting?.location ? 'inperson' : 'plexi'
  )
  const [joinUrl, setJoinUrl] = useState(editBlock?.meeting?.joinUrl ?? '')
  const [location, setLocation] = useState(editBlock?.meeting?.location ?? '')
  const [agenda, setAgenda] = useState(editBlock?.meeting?.agenda ?? '')
  // The workspace domain an unresolved bare word gets appended to — derived
  // from the signed-in address, never invented.
  const accountEmail = useAccountStore((s) => s.account?.email ?? s.cachedEmail)
  const workspaceDomain = accountEmail?.includes('@') ? accountEmail.split('@')[1] : null
  // Suggestion source: the last ~90 days of meeting invitees, ranked by the
  // recency of the meeting you shared (see rankGuestSuggestions).
  useEffect(() => {
    const now = Date.now()
    window.api?.timeBlocks
      ?.list(now - 90 * 86_400_000, now + 30 * 86_400_000)
      .then((bs) => setContacts(rankGuestSuggestions(bs)))
      .catch(() => setContacts([]))
  }, [])
  const suggestions = useMemo(
    () =>
      filterSuggestions(
        contacts,
        guestInput,
        guests.map((g) => g.email)
      ),
    [contacts, guestInput, guests]
  )
  // ── Step 6 — attach a real node. Time blocks already persist this relation
  // as taskId, so the picker uses the live node store rather than displaying a
  // stand-in. It accepts desks, tasks and Attention work items.
  const nodes = useNodeStore((s) => s.nodes)
  const [attached, setAttached] = useState<{
    id: string
    title: string
  } | null>(prefillNode ? { id: prefillNode.id, title: prefillNode.title } : null)
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachQuery, setAttachQuery] = useState('')
  const attachableNodes = useMemo(() => {
    const q = attachQuery.trim().toLocaleLowerCase()
    return nodes
      .filter((node) => !q || node.title.toLocaleLowerCase().includes(q))
      .sort((a, b) => {
        if (a.kind === b.kind) return a.title.localeCompare(b.title)
        if (a.kind === 'folder') return -1
        if (b.kind === 'folder') return 1
        return a.title.localeCompare(b.title)
      })
  }, [attachQuery, nodes])
  const attachedTitle = attached?.title ?? null

  // An existing block stores only the id. Resolve its current title after
  // nodes load; a deleted node remains safely detached.
  useEffect(() => {
    if (prefillNode || !editBlock?.taskId) return
    const node = nodes.find((candidate) => candidate.id === editBlock.taskId)
    setAttached(node ? { id: node.id, title: node.title } : null)
  }, [editBlock?.taskId, nodes, prefillNode])

  const titleRef = useRef<HTMLInputElement | null>(null)
  const dateRef = useRef<HTMLInputElement | null>(null)
  const timeRef = useRef<HTMLInputElement | null>(null)

  // Step 5 (option B) — the token grammar's room targets: real rooms only.
  const rooms = useMemo(
    () => nodes.filter((n) => n.kind === 'folder').map((n) => ({ id: n.id, title: n.title })),
    [nodes]
  )
  const [echo, setEcho] = useState<string | null>(null)
  /** Runs when a token COMPLETES (a trailing space, or blur) — never
   *  mid-word, so typing "45min" is not clipped at "45m". Applies each
   *  effect, strips what it consumed, and echoes what it did. */
  function applyTokens(text: string): void {
    const fx = parseBlockTokens(text, rooms, mode === 'meeting')
    if (!fx.echo) return
    if (fx.cleaned !== text) setTitle(fx.cleaned)
    if (fx.durationMin != null) {
      // The DEC-053 contract holds for typed durations too: display as-is,
      // enter the cycle at the nearest step on first click.
      setDurationMin(fx.durationMin)
      cycleIdx.current = DURATION_STEPS.includes(fx.durationMin) ? DURATION_STEPS.indexOf(fx.durationMin) : null
    }
    if (fx.room) setAttached({ id: fx.room.id, title: fx.room.title })
    if (fx.meeting) setMode('meeting')
    setEcho(fx.echo)
  }

  const guestNames = useMemo(() => guests.map((g) => g.name), [guests])
  const placeholder = useMemo(
    () => resolvePlaceholder({ mode, attachedTitle, guests: guestNames, roomName }),
    [mode, attachedTitle, guestNames, roomName]
  )

  // Open → focus lands in the title field (spec §KEYBOARD).
  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  // Step 8 — the countdown IS the stated default: at zero the proposal books
  // itself. Dismissal (Esc → onCancel) unmounts this and nothing fires.
  const [nowTick, setNowTick] = useState(Date.now())
  useEffect(() => {
    if (!proposal) return
    const t = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [proposal])
  const commitRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!proposal) return
    const ms = proposal.autoBookAtMs - Date.now()
    if (ms <= 0) return
    const t = setTimeout(() => commitRef.current(), ms)
    return () => clearTimeout(t)
  }, [proposal])

  function cycleDuration(back: boolean): void {
    if (cycleIdx.current == null) cycleIdx.current = nearestStepIndex(durationMin)
    else cycleIdx.current = Math.min(DURATION_STEPS.length - 1, Math.max(0, cycleIdx.current + (back ? -1 : 1)))
    setDurationMin(DURATION_STEPS[cycleIdx.current])
  }

  function commitGuest(pick?: GuestChip): void {
    const chip = pick ?? resolveGuestEntry(guestInput, contacts, workspaceDomain)
    if (!chip) return
    if (!guests.some((g) => g.email.toLowerCase() === chip.email.toLowerCase())) setGuests((gs) => [...gs, chip])
    setGuestInput('')
    setGuestSel(0)
  }

  /** ENTER GUARD (spec §step 4): the guest input consumes Enter to commit a
   *  chip — stopPropagation on every branch keeps the dialog-level
   *  Enter-commits handler from ever seeing it. Tab with content commits too;
   *  Backspace on an empty input deletes the last chip. */
  function onGuestKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      commitGuest(suggestions.length > 0 ? suggestions[Math.min(guestSel, suggestions.length - 1)] : undefined)
      return
    }
    if (e.key === ',') {
      e.preventDefault()
      commitGuest()
      return
    }
    if (e.key === 'Tab' && guestInput.trim()) {
      e.preventDefault()
      commitGuest(suggestions.length > 0 ? suggestions[Math.min(guestSel, suggestions.length - 1)] : undefined)
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

  /** ENTER GUARD, agenda half: plain Enter is consumed (no commit, no
   *  newline); Shift+Enter is THE newline, per the spec's keyboard map. */
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

  async function commit(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      // Empty on commit writes the placeholder value as the REAL title —
      // the user is never blocked on naming (spec §TITLE).
      const finalTitle = title.trim() || placeholder
      // Step 7 — the real meeting payload. roomId is always minted (house
      // convention: costs nothing, means any meeting can be joined remotely);
      // the agenda rides the same JSON payload. Focus blocks carry none.
      const meeting: TimeBlockMeeting | null =
        mode === 'meeting'
          ? {
              // An edit keeps the block's own room — a meeting's join link
              // must survive a title change. Only a NEW meeting mints one.
              roomId: editBlock?.meeting?.roomId ?? newMeetingRoomId(),
              invitees: guests.map((g) => g.email),
              joinUrl: where === 'link' && joinUrl.trim() ? joinUrl.trim() : null,
              location: where === 'inperson' && location.trim() ? location.trim() : null,
              agenda: agenda.trim() || null
            }
          : null
      const taskId = attached?.id ?? null
      if (isEdit && onSave) {
        await onSave({
          taskId,
          title: finalTitle,
          startMs,
          durationMin,
          meeting
        })
      } else if (onCreate) {
        await onCreate(taskId, finalTitle, startMs, durationMin, meeting, repeat || null)
      }
    } finally {
      setBusy(false)
    }
  }

  commitRef.current = () => void commit()

  /** Enter commits from anywhere except Guests and Agenda (neither exists
   *  this pass); Esc discards; Cmd+M toggles the mode. */
  function onDialogKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onCancel()
      return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault()
      setMode((m) => (m === 'focus' ? 'meeting' : 'focus'))
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

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduceMotion ? 0 : 0.15, ease: 'easeOut' }}
      className="fb-scrim fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onCancel}
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
        aria-label="Book time"
        data-testid="book-time-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        className="fb-card w-full max-w-[560px] overflow-hidden max-h-[86vh] flex flex-col shadow-[0_32px_80px_-16px_rgba(0,0,0,0.5)]"
      >
        <div className="px-6 pt-5 pb-5 flex flex-col gap-4 overflow-y-auto">
          {proposal && (
            /* Step 8 — accent-soft, a stated default with a countdown, and
               the one-keystroke exit named right in it. */
            <div
              data-testid="proposal-banner"
              className="flex items-start gap-2.5 rounded-[var(--radius-field)] bg-accent/10 px-3 py-2.5 text-[12.5px] leading-snug text-[var(--ink-90)]"
            >
              <Icon name="bolt" size={14} className="text-[rgb(var(--accent))] shrink-0 mt-px" />
              <span className="min-w-0">
                {proposal.reason} <span className="text-[var(--ink-50)]">Esc dismisses.</span>
              </span>
              <span
                data-testid="proposal-countdown"
                className="ml-auto shrink-0 fb-tabular text-[12px] font-semibold text-[rgb(var(--accent))]"
              >
                {(() => {
                  const left = Math.max(0, proposal.autoBookAtMs - nowTick)
                  const m = Math.floor(left / 60_000)
                  const s = Math.floor((left % 60_000) / 1000)
                  return m >= 2 ? `${m}m` : `${m}:${String(s).padStart(2, '0')}`
                })()}
              </span>
            </div>
          )}
          {/* ── Mode slider — the header. Mode decides which fields exist. ── */}
          <div
            role="tablist"
            aria-label="Block kind"
            className="relative grid grid-cols-2 rounded-full bg-[var(--surface-sunken)] p-1 select-none"
          >
            <motion.span
              aria-hidden
              className="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-[var(--surface-raised)] border border-[var(--edge-soft)] shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
              animate={{ x: mode === 'meeting' ? '100%' : '0%' }}
              transition={thumbTransition}
              data-testid="mode-thumb"
            />
            {(
              [
                ['focus', 'schedule', 'Focus time'],
                ['meeting', 'groups', 'Meeting']
              ] as const
            ).map(([m, icon, label]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                onKeyDown={(e) => {
                  // Enter commits (spec keyboard map); Space still toggles.
                  if (e.key === ' ') {
                    e.preventDefault()
                    setMode(m)
                  }
                }}
                className={`relative z-10 h-9 rounded-full inline-flex items-center justify-center gap-2 text-[13.5px] font-semibold transition-colors fb-press ${
                  mode === m ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-50)]'
                }`}
              >
                <Icon name={icon} size={16} />
                {label}
              </button>
            ))}
          </div>

          {/* ── Title — the act of intent. 23px, 600, borderless field with a
                 hairline base; never blocks: empty commits the placeholder as
                 the real name. NO date/time fallback, by explicit refusal. ── */}
          <div>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                if (e.target.value.endsWith(' ')) applyTokens(e.target.value)
              }}
              onFocus={() => setTitleFocused(true)}
              onBlur={() => {
                setTitleFocused(false)
                applyTokens(title)
              }}
              placeholder={placeholder}
              aria-label="Title"
              data-testid="book-title"
              className="w-full bg-transparent text-[23px] font-semibold text-[var(--ink-100)] placeholder:text-[var(--ink-50)] outline-none [&:focus-visible]:outline-none border-b border-[var(--edge-soft)] focus:border-[rgb(var(--accent))] pb-1.5 transition-colors"
            />
            {/* Reserved height so nothing jumps (spec §TITLE hint line). */}
            <div className="h-[18px] pt-1 text-[11.5px] text-[var(--ink-50)] leading-tight" aria-live="polite">
              {echo ? (
                <span data-testid="parse-echo" className="text-[var(--ink-70)]">
                  {echo}
                </span>
              ) : (
                titleFocused &&
                title === '' && (
                  <>
                    Leave blank and it saves as{' '}
                    <span className="font-semibold text-[var(--ink-70)]">{placeholder}</span>
                  </>
                )
              )}
            </div>
          </div>

          {/* ── Time row — one row, one fact. Date + start open pickers, the
                 end chip cycles duration, the duration label is derived text,
                 Repeat is a quiet chip that never says "Does not repeat". ── */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className={chip}
              data-testid="book-date-chip"
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
              />
            </button>
            <button
              type="button"
              className={chip}
              data-testid="book-start-chip"
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
              />
            </button>
            <span aria-hidden className="text-[var(--ink-40)]">
              →
            </span>
            <button
              type="button"
              className={chip}
              data-testid="book-end-chip"
              title="Click: longer · Shift+Click: shorter"
              aria-label={`Ends ${fmtTimeChip(startMs + durationMin * 60_000)} — click to cycle duration`}
              onClick={(e) => cycleDuration(e.shiftKey)}
              onKeyDown={(e) => {
                // Space cycles (Shift+Space back); Enter falls through to the
                // dialog handler and commits, per the keyboard map.
                if (e.key === ' ') {
                  e.preventDefault()
                  cycleDuration(e.shiftKey)
                }
              }}
            >
              {fmtTimeChip(startMs + durationMin * 60_000)}
            </button>
            <span className="text-[12px] text-[var(--ink-50)] fb-tabular" data-testid="book-duration">
              {durationMin >= 60 && durationMin % 60 === 0 ? `${durationMin / 60}h` : `${durationMin}m`}
            </span>
            <div className="relative ml-auto">
              <button
                type="button"
                data-testid="book-repeat-chip"
                disabled={isEdit}
                title={isEdit ? 'Recurrence can\u2019t be changed on a booked block yet' : undefined}
                onClick={() => !isEdit && setRepeatOpen((o) => !o)}
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
          </div>

          {/* ── Meeting fields — revealed by the mode (step 4). Meeting-only
                 ON PURPOSE: a description on a solo focus block is a second
                 home for context that already lives on the desk; guests can't
                 see the desk, so meetings genuinely need one. ── */}
          <AnimatePresence initial={false}>
            {mode === 'meeting' && (
              <motion.div
                key="meeting-fields"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={revealTransition}
                className="overflow-hidden"
                data-testid="meeting-reveal"
              >
                <div className="flex flex-col gap-3.5 pt-1">
                  {/* GUESTS — chips on a filled field. Enter/comma/Tab commit;
                      Backspace on empty deletes the last; suggestions rank by
                      the recency of the meeting you shared. */}
                  <div className="relative">
                    <div className="text-[10.5px] font-semibold tracking-wider text-[var(--ink-40)] mb-1">GUESTS</div>
                    <div
                      className="min-h-10 px-2 py-1.5 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] flex flex-wrap items-center gap-1.5 cursor-text"
                      onClick={(e) => {
                        ;(e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()
                      }}
                      data-testid="guest-field"
                    >
                      {guests.map((g) => (
                        <span
                          key={g.email}
                          data-testid="guest-chip"
                          title={g.email}
                          className="inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-full bg-[var(--surface-raised)] border border-[var(--edge-soft)] text-[12.5px] text-[var(--ink-90)]"
                        >
                          <span
                            aria-hidden
                            className="h-5 w-5 rounded-full bg-accent/15 text-[rgb(var(--accent))] text-[9px] font-bold inline-flex items-center justify-center"
                          >
                            {guestInitials(g.name)}
                          </span>
                          {g.name}
                          <button
                            type="button"
                            aria-label={`Remove ${g.name}`}
                            onClick={() => setGuests((gs) => gs.filter((x) => x.email !== g.email))}
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
                        data-testid="guest-input"
                        className="flex-1 min-w-[120px] bg-transparent outline-none [&:focus-visible]:outline-none text-[13px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)] py-0.5"
                      />
                    </div>
                    {guestFocused && suggestions.length > 0 && (
                      <div
                        className="absolute left-0 right-0 top-full mt-1 z-20 rounded-[var(--radius-row)] fb-glass-panel fb-pop-in p-1"
                        data-testid="guest-suggestions"
                      >
                        {suggestions.map((c, i) => (
                          <button
                            key={c.email}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault()
                              commitGuest(c)
                            }}
                            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-chip)] text-left text-[12.5px] fb-press ${
                              i === guestSel ? 'bg-[var(--surface-sunken)]' : 'hover:bg-[var(--surface-sunken)]'
                            }`}
                          >
                            <span
                              aria-hidden
                              className="h-5 w-5 rounded-full bg-accent/15 text-[rgb(var(--accent))] text-[9px] font-bold inline-flex items-center justify-center shrink-0"
                            >
                              {guestInitials(c.name)}
                            </span>
                            <span className="text-[var(--ink-90)]">{c.name}</span>
                            <span className="ml-auto text-[11px] text-[var(--ink-40)] truncate">{c.email}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* WHERE — one question, four answers, only the chosen
                      branch expands, and the revealed input AUTOFOCUSES (the
                      behaviour that makes a segmented control faster than
                      three stacked fields). */}
                  <div>
                    <div className="text-[10.5px] font-semibold tracking-wider text-[var(--ink-40)] mb-1">WHERE</div>
                    <div className="flex rounded-full bg-[var(--surface-sunken)] p-1 select-none">
                      {(
                        [
                          ['plexi', 'videocam', 'Plexii Meet'],
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
                          data-testid={`where-${w}`}
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
                          A Plexii room is added to the meeting. After the 10-second undo window, guests are emailed a
                          link that opens PlexiiDesk when Mail is connected.
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
                        data-testid="where-link-input"
                        className="mt-2 w-full h-9 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] outline-none [&:focus-visible]:outline-none border border-transparent focus:border-[rgb(var(--accent))] text-[13px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)] transition-colors"
                      />
                    )}
                    {where === 'inperson' && (
                      <input
                        autoFocus
                        value={location}
                        onChange={(e) => setLocation(e.target.value)}
                        placeholder="An address, a room, or where to meet"
                        aria-label="Location"
                        data-testid="where-inperson-input"
                        className="mt-2 w-full h-9 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] outline-none [&:focus-visible]:outline-none border border-transparent focus:border-[rgb(var(--accent))] text-[13px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)] transition-colors"
                      />
                    )}
                  </div>

                  {/* AGENDA — Shift+Enter is the newline; plain Enter is
                      consumed so it can never commit the dialog from here. */}
                  <div>
                    <div className="text-[10.5px] font-semibold tracking-wider text-[var(--ink-40)] mb-1">AGENDA</div>
                    <textarea
                      rows={2}
                      value={agenda}
                      onChange={(e) => setAgenda(e.target.value)}
                      onKeyDown={onAgendaKeyDown}
                      placeholder="What this meeting needs to settle"
                      aria-label="Agenda"
                      data-testid="agenda-input"
                      className="w-full px-3 py-2 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] outline-none [&:focus-visible]:outline-none border border-transparent focus:border-[rgb(var(--accent))] text-[13px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)] resize-none transition-colors"
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── Attach — quiet, last, and the reason a block can be staged. ── */}
          <div className="self-start inline-flex items-center gap-2 max-w-full">
            <div className="relative inline-flex min-w-0">
              <button
                type="button"
                data-testid="book-attach-row"
                aria-haspopup="listbox"
                aria-expanded={attachOpen}
                onClick={() => setAttachOpen((open) => !open)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    setAttachOpen((open) => !open)
                  }
                }}
                title={attached ? `Attached to ${attached.title}` : 'Attach a desk or work item'}
                 className="h-10 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] border border-[var(--edge-strong)] inline-flex items-center gap-2 text-[13px] text-[var(--ink-70)] fb-press transition-colors hover:text-[var(--ink-90)] max-w-[340px]"
              >
                <Icon name={attached ? 'link' : 'folder'} size={15} />
                <span className="truncate">{attached ? attached.title : 'Attach a desk or work item'}</span>
                <Icon name="expand_more" size={14} className="text-[var(--ink-40)] shrink-0" />
              </button>
              {attached && (
                <button
                  type="button"
                  aria-label={`Detach ${attached.title}`}
                  title="Detach"
                  onClick={() => {
                    setAttached(null)
                    setAttachOpen(false)
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                  className="h-10 w-10 -ml-px rounded-r-[var(--radius-field)] bg-[var(--surface-sunken)] border border-[var(--edge-strong)] inline-flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-90)] fb-press"
                >
                  <Icon name="close" size={15} />
                </button>
              )}
              {attachOpen && (
                <div
                  className="absolute left-0 bottom-full mb-1 z-30 w-[340px] max-w-[calc(100vw-3rem)] rounded-[var(--radius-row)] fb-glass-panel fb-pop-in p-1.5"
                  data-testid="book-attach-picker"
                >
                  <input
                    autoFocus
                    value={attachQuery}
                    onChange={(e) => setAttachQuery(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setAttachOpen(false)
                      }
                    }}
                    placeholder="Search desks and work items"
                    aria-label="Search desks and work items"
                    className="mb-1 h-9 w-full rounded-[var(--radius-field)] bg-[var(--surface-sunken)] px-3 text-[13px] text-[var(--ink-100)] outline-none border border-transparent focus:border-[rgb(var(--accent))]"
                  />
                  <div role="listbox" aria-label="Desks and work items" className="max-h-52 overflow-y-auto">
                    {attachableNodes.map((node) => (
                      <button
                        key={node.id}
                        type="button"
                        role="option"
                        aria-selected={attached?.id === node.id}
                        onClick={() => {
                          setAttached({ id: node.id, title: node.title })
                          setAttachOpen(false)
                          setAttachQuery('')
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                        className={`w-full min-h-9 rounded-[var(--radius-chip)] px-2 py-1.5 flex items-center gap-2 text-left text-[13px] fb-press ${
                          attached?.id === node.id
                            ? 'bg-accent/10 text-[rgb(var(--accent))]'
                            : 'text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]'
                        }`}
                      >
                        <Icon name={node.kind === 'folder' ? 'folder' : 'check_box'} size={15} />
                        <span className="truncate">{node.title}</span>
                        <span className="ml-auto text-[10px] uppercase tracking-wide text-[var(--ink-40)]">
                          {node.kind === 'folder' ? 'Desk' : node.kind === 'work_item' ? 'Attention' : 'Task'}
                        </span>
                      </button>
                    ))}
                    {attachableNodes.length === 0 && (
                      <div className="px-2 py-3 text-center text-[12px] text-[var(--ink-50)]">
                        No matching desks or work items
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            {attached && (
              /* The Staged badge — the persisted relation lets the Attendant
                 prepare the linked workspace before the block starts. */
              <span
                data-testid="staged-badge"
                title="Staged — the desk can be prepared before this block starts"
                className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[11px] font-semibold"
              >
                <Icon name="bolt" size={11} />
                Staged
              </span>
            )}
          </div>
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
            data-testid="book-commit"
            className="btn-primary ml-auto"
          >
            <span>{isEdit ? 'Save' : mode === 'meeting' ? 'Schedule meeting' : 'Book it'}</span>
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
