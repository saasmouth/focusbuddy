import { useRef, useState } from 'react'
import Icon from './Icon'
import { CORNER_PRIORITY, useCornerSlot } from '../lib/cornerStack'
import { formatUsd, safeActionUrl } from '../lib/creditNotices'
import { openShareForDeskInView } from '../lib/openShare'
import { useCreditNoticesStore } from '../stores/creditNotices'
import { useNoticeStore } from '../stores/notice'
import { useViewStore } from '../stores/view'

// "You earned US$5": share credit, celebrated (4.3.52; owner: "make a big deal
// about the credit"). Its own card in the bottom-right stack, not the grey
// notice toast: the amount large in the accent, the new balance, the server's
// own words for what happened, and two ways on, spending it or sharing again.
// One short shimmer when it arrives live (none under reduced motion). It stays
// until dismissed; dismissing marks it seen (stores/creditNotices.ts). Several
// unseen ones wait behind each other, newest first.

export const NO_DESK_IN_VIEW_NOTE = 'Open a desk, then choose Share in its menu.'

export default function CreditEarnedCard(): JSX.Element | null {
  const notices = useCreditNoticesStore((s) => s.notices)
  const arrivedId = useCreditNoticesStore((s) => s.arrivedId)
  const dismiss = useCreditNoticesStore((s) => s.dismiss)
  const [index, setIndex] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const shown = notices.length ? notices[Math.min(index, notices.length - 1)] : null
  const corner = useCornerSlot('credit-earned', CORNER_PRIORITY.notice, !!shown, ref)
  if (!shown || !corner.visible) return null

  async function openCredit(): Promise<void> {
    if (!shown) return
    setNote(null)
    const url = safeActionUrl(shown.actionUrl)
    const r = url ? await window.api.files.openExternal(url) : { ok: false as const }
    if (!r.ok) setNote(`Could not open your browser. Your credit is at ${shown.actionUrl}`)
  }

  function shareAnother(): void {
    if (openShareForDeskInView()) return
    // No desk in view: All desks, where one can be opened and shared.
    useViewStore.getState().goAllTasks()
    useNoticeStore.getState().show({ text: NO_DESK_IN_VIEW_NOTE, icon: 'info' })
  }

  const more = notices.length - 1
  return (
    <div
      ref={ref}
      style={{ bottom: corner.bottom, right: corner.right }}
      role="status"
      aria-live="polite"
      data-testid="credit-earned-card"
      data-notice-id={shown.id}
      className={`fixed z-[9997] w-[300px] fb-card rounded-[var(--radius-field)] shadow-lg overflow-hidden fb-pop-in ${
        shown.id === arrivedId ? 'fb-credit-shimmer' : ''
      }`}
    >
      <div className="px-3.5 pt-3 pb-3 space-y-2">
        <div className="flex items-center gap-1.5">
          <Icon name="redeem" size={15} className="text-accent" />
          <span className="flex-1 fb-t-caption uppercase tracking-wider font-medium text-[var(--ink-50)]">Plexii credit</span>
          <button
            type="button"
            aria-label="Dismiss"
            data-testid="credit-earned-dismiss"
            onClick={() => {
              setIndex(0)
              setNote(null)
              void dismiss(shown.id)
            }}
            className="text-[var(--ink-50)] hover:text-[var(--ink-100)] leading-none"
          >
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[30px] leading-none font-semibold text-accent tabular-nums" data-testid="credit-earned-amount">
            {formatUsd(shown.usd)}
          </span>
          <span className="text-[13px] font-medium text-[var(--ink-90)]">earned</span>
        </div>
        <p className="text-[12.5px] leading-snug text-[var(--ink-80)]" data-testid="credit-earned-text">
          {shown.text}
        </p>
        <p className="fb-t-caption text-[var(--ink-50)]" data-testid="credit-earned-balance">
          Your Plexii credit is now {formatUsd(shown.balanceUsd)}.
        </p>
        <div className="flex items-center gap-1.5 pt-0.5">
          <button
            type="button"
            onClick={() => void openCredit()}
            data-testid="credit-earned-use"
            className="px-2.5 py-1.5 rounded-[var(--radius-field)] fb-t-caption font-medium bg-accent text-white hover:opacity-90"
          >
            {shown.actionLabel}
          </button>
          <button
            type="button"
            onClick={shareAnother}
            data-testid="credit-earned-share"
            className="fb-btn-surface px-2.5 py-1.5 rounded-[var(--radius-field)] fb-t-caption text-[var(--ink-80)] hover:text-accent"
          >
            {shown.shareActionLabel}
          </button>
        </div>
        {note && (
          <p className="fb-t-caption text-[var(--ink-70)]" data-testid="credit-earned-note">
            {note}
          </p>
        )}
        {more > 0 && (
          <button
            type="button"
            data-testid="credit-earned-next"
            onClick={() => setIndex((i) => (i + 1) % notices.length)}
            className="fb-t-caption text-[var(--ink-50)] hover:text-[var(--ink-90)]"
          >
            {index + 1} of {notices.length} · Next
          </button>
        )}
      </div>
    </div>
  )
}
