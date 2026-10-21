import { useEffect, useRef, useState } from 'react'
import { useCaptureConsole } from '../stores/captureConsole'
import { useWorkItemStore } from '../stores/workItems'
import { useViewStore } from '../stores/view'
import { useNodeStore } from '../stores/nodes'
import { deskCaptureContext } from '../lib/captureContext'
import AttentionConfirmCard, { CLASS_LABEL } from './AttentionConfirmCard'
import { CAPTURE_LEADINS, ROTATE_MS } from '../lib/captureCopy'
import { usePeopleStore } from '../lib/peopleDirectory'

// Capture (the Attention capture window, rebuilt as Book time's sibling —
// same visual language, same tokens, same restraint). The tab bar is GONE:
// Routed and Unrouted had identical fields, so the difference was never a
// mode — it was a destination, and destinations belong on the commit:
//
//   Enter      → classify and show the confirm step   (the default)
//   Cmd+Enter  → file exactly as typed — no classification, no confirm
//
// Expand left the dialog entirely (it was an escape hatch to the assistant,
// not a peer; the assistant remains a keystroke away everywhere else).
// The governing constraint: someone who has never used this app must know
// what to do without being told. Two labelled fields, two Enters, and the
// second Enter is usually the only decision.
//
// DEC-028 stands: a capture arriving WITH text (armed pill, @attention
// prefix, chat hand-off) opens straight at the confirm card. DEC-023 stands:
// a desk-context capture parents onto that desk — the context now surfaces
// as the confirm step's Desk pill (accent = inferred) instead of a chip.


export default function CaptureConsole(): JSX.Element | null {
  const open = useCaptureConsole((s) => s.open)
  const initialText = useCaptureConsole((s) => s.initialText)
  const source = useCaptureConsole((s) => s.source)
  const close = useCaptureConsole((s) => s.close)
  const createItem = useWorkItemStore((s) => s.create)

  const [text, setText] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // DEC-019(b)/DEC-028: when set, the confirm card owns the flow.
  const [confirmText, setConfirmText] = useState<string | null>(null)
  // DEC-023 — capture over a desk view files ONTO that desk.
  const [deskCtx, setDeskCtx] = useState<{ id: string; title: string } | null>(null)
  const [titleFocused, setTitleFocused] = useState(false)
  const [leadIdx, setLeadIdx] = useState(0)
  const fieldRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (open) {
      const t = initialText.trim()
      setText(t)
      setNotes(useCaptureConsole.getState().initialNotes || '')
      setError(null)
      setConfirmText(t ? t : null)
      const marked = useCaptureConsole.getState().source
      setDeskCtx(
        marked?.deskId
          ? { id: marked.deskId, title: marked.deskTitle || 'this desk' }
          : deskCaptureContext(useViewStore.getState().view, useNodeStore.getState().nodes)
      )
      if (!t) setTimeout(() => fieldRef.current?.focus(), 0)
      // DEC-088 — start the directory fetch the moment capture opens, so by
      // the time Enter classifies, main's people scan has real names. Never
      // awaited; a cold first capture may honestly suggest nobody.
      if (!usePeopleStore.getState().attempted) void usePeopleStore.getState().load()
    }
  }, [open, initialText])

  // The rotation: only while there is nothing typed and nothing focused —
  // a moving placeholder under a cursor is noise, not teaching.
  useEffect(() => {
    if (!open || text || titleFocused) return
    const t = setInterval(() => setLeadIdx((i) => (i + 1) % CAPTURE_LEADINS.length), ROTATE_MS)
    return () => clearInterval(t)
  }, [open, text, titleFocused])

  if (!open) return null

  /** Cmd+Enter — file exactly as typed. No classification, no confirm stop,
   *  no AI touch by contract (the old Unrouted, now a commit path). */
  async function fileVerbatim(): Promise<void> {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      const title = t.length > 120 ? `${t.slice(0, 117)}…` : t
      await createItem({
        title,
        notes: [t === title ? '' : t, notes.trim()].filter(Boolean).join('\n\n') || undefined,
        parentId: deskCtx?.id ?? null,
        intentClass: 'to_remember',
        dueAt: null,
        confidence: 1,
        approvalState: 'auto',
        sourceType: 'note',
        wiOrigin: 'human'
      })
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not file that. Try again.')
    } finally {
      setBusy(false)
    }
  }

  function onFieldKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void fileVerbatim()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const t = text.trim()
      if (t) setConfirmText(t)
      return
    }
    if (e.key === 'Escape') close()
  }

  const label = 'text-[10.5px] font-semibold tracking-wider text-[var(--ink-40)] mb-1'
  const field =
    'w-full rounded-[var(--radius-field)] bg-[var(--surface-sunken)] px-3 py-2 outline-none ' +
    '[&:focus-visible]:outline-none border border-transparent focus:border-[rgb(var(--accent))] ' +
    'resize-none text-[var(--ink-100)] placeholder:text-[var(--ink-50)] transition-colors'

  return (
    <div
      className="fb-scrim fixed inset-0 z-[300] flex items-start justify-center pt-[16vh]"
      onMouseDown={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Capture"
        data-testid="capture-console"
        onMouseDown={(e) => e.stopPropagation()}
        // DEC-087 — the card sits 16vh down, so anything past ~76vh ran off
        // the bottom of the viewport with no scrollbar (the demo's cut-off
        // Desk drawer). Header stays pinned; the body scrolls.
        className="fb-card w-[min(600px,92vw)] px-6 pt-5 pb-4 flex flex-col max-h-[76vh]"
      >
        <div className="flex items-baseline gap-2.5">
          <div className="text-[17px] font-semibold text-[var(--ink-100)]">Capture</div>
          <button
            onClick={() => {
              useViewStore.getState().goAttention()
              close()
            }}
            className="text-[13px] text-[var(--ink-40)] hover:text-[var(--ink-100)] fb-press"
            title="Open Focus"
          >
            Open Focus →
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain -mx-6 px-6">
        {confirmText == null ? (
          <>
            <div className="mt-4">
              <div className={label}>WHAT NEEDS YOU?</div>
              <textarea
                ref={fieldRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onFocus={() => setTitleFocused(true)}
                onBlur={() => setTitleFocused(false)}
                onKeyDown={onFieldKeyDown}
                placeholder={CAPTURE_LEADINS[leadIdx]}
                rows={2}
                data-testid="capture-title"
                className={`${field} text-[16.5px]`}
              />
            </div>
            <div className="mt-3">
              <div className={label}>NOTES</div>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onKeyDown={onFieldKeyDown}
                placeholder="Anything worth keeping with it — links, names, what you already know"
                rows={2}
                data-testid="capture-notes"
                className={`${field} text-[14.5px] text-[var(--ink-90)]`}
              />
            </div>
            {error && (
              <div className="mt-2 text-[12px] text-red-600 dark:text-red-400">{error}</div>
            )}
            <div className="mt-4 pt-3 border-t border-[var(--edge-soft)] flex items-center gap-3">
              <span className="text-[12px] text-[var(--ink-50)]">
                <kbd className="px-1.5 py-0.5 rounded bg-[var(--surface-sunken)] text-[11px] font-medium">
                  ⌘↵
                </kbd>{' '}
                file exactly as typed{' '}
                <span className="text-[var(--ink-30)]">·</span>{' '}
                <kbd className="px-1.5 py-0.5 rounded bg-[var(--surface-sunken)] text-[11px] font-medium">
                  esc
                </kbd>{' '}
                close
              </span>
              <button
                onClick={() => {
                  const t = text.trim()
                  if (t) setConfirmText(t)
                }}
                disabled={busy || !text.trim()}
                data-testid="capture-continue"
                className="btn-primary ml-auto"
              >
                <span>Continue</span>
                <span aria-hidden className="rounded bg-white/20 px-1 text-[11px] leading-4">
                  ↵
                </span>
              </button>
            </div>
          </>
        ) : (
          <div className="mt-3">
            <AttentionConfirmCard
              text={confirmText}
              notes={notes}
              deskCtx={deskCtx}
              source={source}
              cancelLabel="← back to your words"
              onFiled={() => {
                setText('')
                setNotes('')
                setConfirmText(null)
                // The toast (with Undo) is the confirmation now — the window
                // has nothing left to say.
                setTimeout(close, 350)
              }}
              onCancel={() => {
                setConfirmText(null)
                // "Back to your words" puts the cursor back IN the words —
                // and keeps Esc alive (focus on <body> hears nothing).
                setTimeout(() => fieldRef.current?.focus(), 0)
              }}
            />
          </div>
        )}
        </div>
      </div>
    </div>
  )
}

export { CLASS_LABEL }
