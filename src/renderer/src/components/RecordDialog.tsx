import { useEffect, useMemo, useRef, useState } from 'react'
import { openMicrophoneSettings, type StartResult } from '../lib/micHealth'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import Icon from './Icon'
import { useNodeStore } from '../stores/nodes'

// Record notes / Record external — the Calendar's Book-time composer,
// twinned a second time (operator, 2026-09-06: "do the same for the Record
// notes and Record external buttons"). The same header slider, the same
// 23px title, the same time-row chips, the same filled fields, the same
// Attach row and Esc / ↵ footer as BookTimeDialog and NewMeetingDialog —
// every recipe is the composer's own string (recordDialogTwin.test.ts).
//
// What each mode can honestly carry — only fields that land somewhere:
//   Record notes    — the title of the meeting the recording becomes, NOTES
//                     (your own words, minted as `yours` spans on its
//                     Record — never rewritten), and a REAL desk attach
//                     (the meeting's deskNodeId).
//   Record external — the title, WHERE the call is (a call on this Mac →
//                     mic + system audio, You / Them; in the room → mic
//                     only, and the loopback picker is never raised), and
//                     NOTES (the wrap-up's notes, the same `yours` spans a
//                     live meeting's notes become). No attach: the wrap-up
//                     mints this meeting's desk itself (S3-DEC-020).
// Nothing here starts a recording until you press Start; the dialog closes
// on success and reports the microphone honestly when it cannot.

export type RecordMode = 'notes' | 'external'

export interface RecordNotesDraft {
  title: string
  notes: string
  deskNodeId: string | null
}

export interface RecordExternalDraft {
  title: string
  notes: string
  micOnly: boolean
}

function fmtDateChip(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function RecordDialog({
  initialMode,
  onClose,
  onStartNotes,
  onStartExternal
}: {
  initialMode: RecordMode
  onClose: () => void
  /** Resolves true once the mic is live and the recording has begun. */
  onStartNotes: (draft: RecordNotesDraft) => Promise<StartResult>
  /** Resolves true once the capture is running (the disclosure bar is up). */
  onStartExternal: (draft: RecordExternalDraft) => Promise<StartResult>
}): JSX.Element {
  const reduceMotion = useReducedMotion()
  const [mode, setMode] = useState<RecordMode>(initialMode)
  const [title, setTitle] = useState('')
  const [titleFocused, setTitleFocused] = useState(false)
  const [notes, setNotes] = useState('')
  const [where, setWhere] = useState<'both' | 'mic'>('both')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorReason, setErrorReason] = useState<'mic-denied' | 'mic-silent' | 'failed' | null>(null)

  // Attach — a REAL desk from the store (Record notes only): the meeting
  // the recording becomes links to it.
  const nodes = useNodeStore((s) => s.nodes)
  const desks = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === 'task' && n.status !== 'done')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [nodes]
  )
  const [attached, setAttached] = useState<{ id: string; title: string } | null>(null)
  const [attachOpen, setAttachOpen] = useState(false)
  const [attachQuery, setAttachQuery] = useState('')
  const attachMatches = useMemo(() => {
    const q = attachQuery.trim().toLowerCase()
    return desks.filter((d) => !q || d.title.toLowerCase().includes(q)).slice(0, 8)
  }, [desks, attachQuery])

  const titleRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  // Placeholder resolution, the composer's rule reduced: the attached desk
  // names it (Record notes only — an external capture mints its own desk,
  // so an attachment made before switching must not name it), else the
  // mode does. Empty on commit saves the placeholder.
  const placeholder =
    (mode === 'notes' && attached?.title.trim()) || (mode === 'notes' ? 'Notes' : 'External meeting')

  function switchMode(m: RecordMode): void {
    setMode(m)
    setError(null)
  }

  async function commit(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const finalTitle = title.trim() || placeholder
      const r =
        mode === 'notes'
          ? await onStartNotes({ title: finalTitle, notes: notes.trim(), deskNodeId: attached?.id ?? null })
          : await onStartExternal({ title: finalTitle, notes: notes.trim(), micOnly: where === 'mic' })
      if (!r.ok) {
        // DEC-130 — the door says exactly why it did not open: the microphone
        // refused, or it "worked" and delivered digital silence (macOS has not
        // allowed it). Either way the fix is one door away.
        setError(r.message)
        setErrorReason(r.reason)
        return
      }
      onClose()
    } finally {
      setBusy(false)
    }
  }

  /** Enter commits from anywhere except NOTES (there Enter is the newline
   *  and ⌘↵ starts); Esc discards; Cmd+M flips the mode. */
  function onDialogKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault()
      switchMode(mode === 'notes' ? 'external' : 'notes')
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void commit()
    }
  }
  function onNotesKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) e.stopPropagation()
  }

  const thumbTransition = reduceMotion ? { duration: 0 } : { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const }
  const revealTransition = reduceMotion ? { duration: 0 } : { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const }

  const chipStatic =
    'h-9 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] text-[13px] font-medium ' +
    'text-[var(--ink-90)] fb-tabular inline-flex items-center gap-1.5 cursor-default'
  const field =
    'w-full h-9 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] outline-none [&:focus-visible]:outline-none border border-transparent focus:border-[rgb(var(--accent))] text-[13px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)] transition-colors'

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
        transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.16, 1, 0.3, 1] }}
        role="dialog"
        aria-modal="true"
        aria-label="Record"
        data-testid="record-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        className="fb-card w-full max-w-[560px] overflow-hidden max-h-[86vh] flex flex-col shadow-[0_32px_80px_-16px_rgba(0,0,0,0.5)]"
      >
        <div className="px-6 pt-5 pb-5 flex flex-col gap-4 overflow-y-auto">
          {/* ── Mode slider — the header. Mode decides which fields exist. ── */}
          <div
            role="tablist"
            aria-label="What to record"
            className="relative grid grid-cols-2 rounded-full bg-[var(--surface-sunken)] p-1 select-none"
            data-testid="record-mode"
          >
            <motion.span
              aria-hidden
              className="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-[var(--surface-raised)] border border-[var(--edge-soft)] shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
              animate={{ x: mode === 'external' ? '100%' : '0%' }}
              transition={thumbTransition}
              data-testid="record-mode-thumb"
            />
            {(
              [
                ['notes', 'mic', 'Record notes'],
                ['external', 'radio_button_checked', 'Record external']
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
                data-testid={`record-mode-${m}`}
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
              data-testid="record-title"
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

          {/* ── Time row — one row, one fact: it starts now and runs until you stop. ── */}
          <div className="flex items-center gap-2 flex-wrap" data-testid="record-when">
            <span className={chipStatic} title="Starts the moment you press Start">
              {fmtDateChip(Date.now())}
            </span>
            <span className={chipStatic}>Now</span>
            <span aria-hidden className="text-[var(--ink-40)]">
              →
            </span>
            <span className={chipStatic} data-testid="record-until">
              Until you stop
            </span>
          </div>

          {/* ── WHERE — external only: one question, two honest answers, and the
                 capture mode follows it (in the room never raises the picker). ── */}
          <AnimatePresence initial={false}>
            {mode === 'external' && (
              <motion.div
                key="where"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={revealTransition}
                className="overflow-hidden"
                data-testid="record-where"
              >
                <div className="text-[10.5px] font-semibold tracking-wider text-[var(--ink-40)] mb-1">WHERE</div>
                <div className="flex rounded-full bg-[var(--surface-sunken)] p-1 select-none">
                  {(
                    [
                      ['both', 'headset_mic', 'A call on this Mac'],
                      ['mic', 'place', 'In the room']
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
                      data-testid={`record-where-${w}`}
                    >
                      <Icon name={icon} size={14} />
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex items-start gap-1.5 mt-2 text-[12px] text-[var(--ink-70)] leading-snug" data-testid="record-where-line">
                  <Icon name="check" size={13} className="text-[rgb(var(--accent))] shrink-0 mt-px" />
                  <span>
                    {where === 'both'
                      ? 'Your mic and this Mac’s audio are recorded and transcribed on this machine — you and them, labelled You / Them. A disclosure bar stays on screen until you stop.'
                      : 'Mic only — Plexii can hear you, not them. Nothing on this Mac is captured, and the bar stays on screen until you stop.'}
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ── NOTES — your own words, into the Record as `yours`: never rewritten. ── */}
          <div>
            <div className="text-[10.5px] font-semibold tracking-wider text-[var(--ink-40)] mb-1">NOTES</div>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={onNotesKeyDown}
              placeholder="What this is about, or anything you already know — it goes in the Record as your own words"
              aria-label="Notes"
              data-testid="record-notes"
              className="w-full px-3 py-2 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] outline-none [&:focus-visible]:outline-none border border-transparent focus:border-[rgb(var(--accent))] text-[13px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)] resize-none transition-colors"
            />
          </div>

          {/* ── Attach — Record notes only: the meeting the recording becomes
                 links to a real desk. External captures mint their own desk. ── */}
          <AnimatePresence initial={false}>
            {mode === 'notes' && (
              <motion.div
                key="attach"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={revealTransition}
                className="overflow-hidden"
              >
                <div className="relative self-start inline-flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="record-attach"
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
                    title={attached ? 'Detach the desk' : 'Attach a desk — the meeting this becomes links to it'}
                    className="h-10 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] border border-[var(--edge-strong)] inline-flex items-center gap-2 text-[13px] text-[var(--ink-70)] fb-press transition-colors hover:text-[var(--ink-90)]"
                  >
                    <Icon name="folder" size={15} />
                    {attached ? attached.title : 'Attach a desk or task'}
                    {attached && <Icon name="close" size={13} className="text-[var(--ink-40)]" />}
                  </button>
                  {attached && (
                    <span
                      data-testid="record-staged"
                      title="Staged — the recording lands on this desk"
                      className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[11px] font-semibold"
                    >
                      <Icon name="bolt" size={11} />
                      Staged
                    </span>
                  )}
                  {attachOpen && !attached && (
                    <div
                      className="absolute left-0 top-11 z-20 w-72 rounded-[var(--radius-row)] fb-glass-panel fb-pop-in p-1.5"
                      data-testid="record-attach-picker"
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
                              setAttached({ id: first.id, title: first.title })
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
                            data-testid={`record-attach-${d.id}`}
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
              </motion.div>
            )}
          </AnimatePresence>

          {error && (
            <div className="rounded-[var(--radius-field)] bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[12px] px-3 py-2" data-testid="record-error" data-reason={errorReason ?? undefined}>
              {error}
              {(errorReason === 'mic-silent' || errorReason === 'mic-denied') && (
                <button
                  onClick={openMicrophoneSettings}
                  className="ml-2 underline underline-offset-2 fb-press font-medium"
                  title="Open System Settings › Privacy & Security › Microphone"
                  data-testid="record-mic-settings"
                >
                  Open microphone settings
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── Bottom row: Esc is the cancel; the action keeps its name. ── */}
        <div className="px-6 py-4 border-t border-[var(--edge-soft)] flex items-center gap-3 shrink-0">
          <span className="text-[12px] text-[var(--ink-50)]">
            <kbd className="px-1.5 py-0.5 rounded bg-[var(--surface-sunken)] text-[11px] font-medium text-[var(--ink-50)]">Esc</kbd>{' '}
            to discard
          </span>
          <button
            type="button"
            onClick={() => void commit()}
            disabled={busy}
            data-testid="record-start"
            className="btn-primary ml-auto"
          >
            <Icon name={mode === 'notes' ? 'mic' : 'radio_button_checked'} size={14} />
            <span>{mode === 'notes' ? 'Start recording' : 'Start capturing'}</span>
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
