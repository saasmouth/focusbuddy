import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'framer-motion'
import type { PresencePeer } from '../lib/messagingSocket'
import Icon from './Icon'
import { personDisplayName } from '../lib/personName'
import { guestInitials } from '../lib/bookTime'

// Message — record a quick video or voice message for a teammate and send it
// as a PlexiChat direct message. The Calendar's Book-time composer, twinned
// a third time (operator, 2026-09-06: "do the same for the Message button"):
// the same header slider (Video message / Voice message — the one real
// choice, it sets the capture), the same 23px field (here the message TEXT,
// sent with the recording — blank sends the recording alone), the same time
// row (now → until you stop), TO as a chip on the filled field (one
// teammate, from live presence — a DM needs an account, so no emails here)
// and the Esc / ↵ footer. Nothing is captured until Start; the dialog closes
// once the camera / mic are live and the page's Message door becomes
// "Stop & send to <name>". Every recipe is BookTimeDialog's own string
// (messageDialogTwin.test.ts).

export type MessageKind = 'video' | 'voice'

export interface MessageDraft {
  to: PresencePeer
  text: string
  video: boolean
}

function fmtDateChip(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function MessageDialog({
  peers,
  onClose,
  onStart
}: {
  /** Teammates on the live presence socket — away / busy / focus included and flagged. */
  peers: PresencePeer[]
  onClose: () => void
  /** Resolves true once the recording is running. */
  onStart: (draft: MessageDraft) => Promise<boolean>
}): JSX.Element {
  const reduceMotion = useReducedMotion()
  const [kind, setKind] = useState<MessageKind>('video')
  const [text, setText] = useState('')
  const [textFocused, setTextFocused] = useState(false)
  const [to, setTo] = useState<PresencePeer | null>(null)
  const [toInput, setToInput] = useState('')
  const [toSel, setToSel] = useState(0)
  const [toFocused, setToFocused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const textRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    textRef.current?.focus()
  }, [])

  const nameOf = (p: PresencePeer): string => personDisplayName(p, p.handle)
  const suggestions = useMemo(() => {
    const q = toInput.trim().toLowerCase()
    return peers.filter(
      (p) => p.accountId !== to?.accountId && (!q || nameOf(p).toLowerCase().includes(q) || p.handle.toLowerCase().includes(q))
    )
  }, [peers, toInput, to])

  function pick(p: PresencePeer): void {
    setTo(p)
    setToInput('')
    setToSel(0)
    setError(null)
  }

  /** ENTER GUARD: the TO input consumes Enter to pick the highlighted
   *  teammate — stopPropagation keeps the dialog-level Enter-commits handler
   *  from seeing it. Backspace on an empty input clears the recipient. */
  function onToKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (suggestions.length > 0) pick(suggestions[Math.min(toSel, suggestions.length - 1)])
      return
    }
    if (e.key === 'Backspace' && toInput === '' && to) {
      setTo(null)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setToSel((s) => Math.min(s + 1, Math.max(0, suggestions.length - 1)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setToSel((s) => Math.max(0, s - 1))
    }
  }

  async function commit(): Promise<void> {
    if (busy) return
    if (!to) {
      setError('Pick a teammate to send it to.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const ok = await onStart({ to, text: text.trim(), video: kind === 'video' })
      if (!ok) {
        setError(
          kind === 'video'
            ? 'Could not access your camera or microphone. Check your system permissions.'
            : 'Could not access your microphone. Check your system permissions.'
        )
        return
      }
      onClose()
    } finally {
      setBusy(false)
    }
  }

  /** Enter commits from anywhere except TO; Esc discards; Cmd+M flips the kind. */
  function onDialogKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault()
      setKind((k) => (k === 'video' ? 'voice' : 'video'))
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void commit()
    }
  }

  const thumbTransition = reduceMotion ? { duration: 0 } : { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const }
  const chipStatic =
    'h-9 px-3 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] text-[13px] font-medium ' +
    'text-[var(--ink-90)] fb-tabular inline-flex items-center gap-1.5 cursor-default'
  const flagged = (p: PresencePeer): boolean => p.status === 'away' || p.status === 'busy' || p.status === 'focus'

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
        aria-label="Message"
        data-testid="message-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        className="fb-card w-full max-w-[560px] overflow-hidden max-h-[86vh] flex flex-col shadow-[0_32px_80px_-16px_rgba(0,0,0,0.5)]"
      >
        <div className="px-6 pt-5 pb-5 flex flex-col gap-4 overflow-y-auto">
          {/* ── Mode slider — the header. The kind decides what is captured. ── */}
          <div
            role="tablist"
            aria-label="Message kind"
            className="relative grid grid-cols-2 rounded-full bg-[var(--surface-sunken)] p-1 select-none"
            data-testid="message-kind"
          >
            <motion.span
              aria-hidden
              className="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-[var(--surface-raised)] border border-[var(--edge-soft)] shadow-[0_1px_4px_rgba(0,0,0,0.08)]"
              animate={{ x: kind === 'voice' ? '100%' : '0%' }}
              transition={thumbTransition}
              data-testid="message-kind-thumb"
            />
            {(
              [
                ['video', 'videocam', 'Video message'],
                ['voice', 'mic', 'Voice message']
              ] as const
            ).map(([m, icon, label]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={kind === m}
                onClick={() => setKind(m)}
                onKeyDown={(e) => {
                  if (e.key === ' ') {
                    e.preventDefault()
                    setKind(m)
                  }
                }}
                data-testid={`message-kind-${m}`}
                className={`relative z-10 h-9 rounded-full inline-flex items-center justify-center gap-2 text-[13.5px] font-semibold transition-colors fb-press ${
                  kind === m ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-50)]'
                }`}
              >
                <Icon name={icon} size={16} />
                {label}
              </button>
            ))}
          </div>

          {/* ── The message text — the act of intent; sent with the recording. ── */}
          <div>
            <input
              ref={textRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setTextFocused(true)}
              onBlur={() => setTextFocused(false)}
              placeholder="A quick message"
              aria-label="Message text"
              data-testid="message-text"
              className="w-full bg-transparent text-[23px] font-semibold text-[var(--ink-100)] placeholder:text-[var(--ink-50)] outline-none [&:focus-visible]:outline-none border-b border-[var(--edge-soft)] focus:border-[rgb(var(--accent))] pb-1.5 transition-colors"
            />
            <div className="h-[18px] pt-1 text-[11.5px] text-[var(--ink-50)] leading-tight" aria-live="polite">
              {textFocused && text === '' && <>Leave blank and only the recording is sent</>}
            </div>
          </div>

          {/* ── Time row — one row, one fact: it starts now and runs until you stop. ── */}
          <div className="flex items-center gap-2 flex-wrap" data-testid="message-when">
            <span className={chipStatic} title="Starts the moment you press Start">
              {fmtDateChip(Date.now())}
            </span>
            <span className={chipStatic}>Now</span>
            <span aria-hidden className="text-[var(--ink-40)]">
              →
            </span>
            <span className={chipStatic}>Until you stop</span>
          </div>

          {/* ── TO — one teammate, as a chip on the filled field. A direct message
                 needs an account, so the source is live presence, not an address. ── */}
          <div className="relative">
            <div className="text-[10.5px] font-semibold tracking-wider text-[var(--ink-40)] mb-1">TO</div>
            <div
              className="min-h-10 px-2 py-1.5 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] flex flex-wrap items-center gap-1.5 cursor-text"
              onClick={(e) => {
                ;(e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()
              }}
              data-testid="message-to"
            >
              {to && (
                <span
                  data-testid="message-to-chip"
                  title={`@${to.handle}`}
                  className="inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-full bg-[var(--surface-raised)] border border-[var(--edge-soft)] text-[12.5px] text-[var(--ink-90)]"
                >
                  <span
                    aria-hidden
                    className="h-5 w-5 rounded-full bg-accent/15 text-[rgb(var(--accent))] text-[9px] font-bold inline-flex items-center justify-center"
                  >
                    {guestInitials(nameOf(to))}
                  </span>
                  {nameOf(to)}
                  {flagged(to) && <span className="text-[10px] text-amber-600 dark:text-amber-400">{to.status}</span>}
                  <button
                    type="button"
                    aria-label={`Remove ${nameOf(to)}`}
                    onClick={() => setTo(null)}
                    className="text-[var(--ink-40)] hover:text-[var(--ink-90)] transition-colors fb-press"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </span>
              )}
              <input
                value={toInput}
                onChange={(e) => {
                  setToInput(e.target.value)
                  setToSel(0)
                }}
                onKeyDown={onToKeyDown}
                onFocus={() => setToFocused(true)}
                onBlur={() => setTimeout(() => setToFocused(false), 120)}
                placeholder={to ? '' : peers.length === 0 ? 'No teammates online right now.' : 'A teammate'}
                aria-label="To"
                data-testid="message-to-input"
                className="flex-1 min-w-[120px] bg-transparent outline-none [&:focus-visible]:outline-none text-[13px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)] py-0.5"
              />
            </div>
            {toFocused && suggestions.length > 0 && (
              <div
                className="absolute left-0 right-0 top-full mt-1 z-20 rounded-[var(--radius-row)] fb-glass-panel fb-pop-in p-1"
                data-testid="message-to-suggestions"
              >
                {suggestions.map((p, i) => (
                  <button
                    key={p.accountId}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      pick(p)
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-chip)] text-left text-[12.5px] fb-press ${
                      i === toSel ? 'bg-[var(--surface-sunken)]' : 'hover:bg-[var(--surface-sunken)]'
                    }`}
                  >
                    <span
                      aria-hidden
                      className="h-5 w-5 rounded-full bg-accent/15 text-[rgb(var(--accent))] text-[9px] font-bold inline-flex items-center justify-center shrink-0"
                    >
                      {guestInitials(nameOf(p))}
                    </span>
                    <span className="text-[var(--ink-90)]">{nameOf(p)}</span>
                    <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> online
                      {flagged(p) ? ` · ${p.status}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {peers.length > 0 && (
              <div className="mt-2 flex items-center gap-1.5 flex-wrap" data-testid="message-peers">
                <span className="text-[11px] text-[var(--ink-50)] mr-0.5">Online now</span>
                {peers.map((p) => {
                  const on = to?.accountId === p.accountId
                  return (
                    <button
                      key={p.accountId}
                      type="button"
                      onClick={() => (on ? setTo(null) : pick(p))}
                      aria-pressed={on}
                      data-testid={`message-peer-${p.accountId}`}
                      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] fb-press transition-colors border ${
                        on
                          ? 'border-[rgb(var(--accent))] text-[rgb(var(--accent))] bg-accent/10'
                          : 'border-[var(--edge-soft)] text-[var(--ink-70)] hover:text-[var(--ink-100)]'
                      }`}
                      title={on ? 'Sending to them — click to clear' : 'Send it to them'}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      {nameOf(p)}
                      {flagged(p) && <span className="text-[10px] text-amber-600 dark:text-amber-400">{p.status}</span>}
                      {on && <Icon name="check" size={12} />}
                    </button>
                  )
                })}
              </div>
            )}
            <div className="flex items-start gap-1.5 mt-2 text-[12px] text-[var(--ink-70)] leading-snug" data-testid="message-how">
              <Icon name="check" size={13} className="text-[rgb(var(--accent))] shrink-0 mt-px" />
              <span>
                {kind === 'video' ? 'Camera and mic' : 'Mic only'} — recorded on this Mac, then sent as a direct message in
                PlexiiChat. They see it when they are back.
              </span>
            </div>
          </div>

          {error && (
            <div className="rounded-[var(--radius-field)] bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[12px] px-3 py-2" data-testid="message-error">
              {error}
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
            data-testid="message-start"
            className="btn-primary ml-auto"
          >
            <Icon name={kind === 'video' ? 'videocam' : 'mic'} size={14} />
            <span>{to ? `Record for ${nameOf(to)}` : 'Start recording'}</span>
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
