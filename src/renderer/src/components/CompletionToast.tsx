import { useEffect, useRef } from 'react'
import { CORNER_PRIORITY, useCornerSlot } from '../lib/cornerStack'
import Icon from './Icon'
import { useCompletionOffer } from '../stores/completionOffer'
import { useWorkItemStore } from '../stores/workItems'
import { useCloseWorkItem } from './attention/useCloseWorkItem'

// DEC-052 (Track D) — the one-keystroke completion offer. The operator's
// spec, verbatim shape: a lightweight prompt appears ("Complete this task?"),
// you hit Enter and keep moving — or ignore it at zero cost. Bottom-RIGHT so
// it never fights the UndoToast (bottom-centre). Closing runs the SAME
// accounted path as every other surface (useCloseWorkItem: subtask + desk
// offers included), so this shortcut can never skip the bookkeeping.

export default function CompletionToast(): JSX.Element | null {
  const offer = useCompletionOffer((s) => s.offer)
  const resolve = useCompletionOffer((s) => s.resolve)
  const items = useWorkItemStore((s) => s.items)
  const closeItem = useCloseWorkItem()

  useEffect(() => {
    if (!offer) return
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = items.find((i) => i.id === offer.itemId)
        resolve('completed')
        if (item) void closeItem(item, offer.verbState)
      } else if (e.key === 'Escape') {
        resolve('dismissed')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [offer, items, resolve, closeItem])

  // A slot in the corner stack (lib/cornerStack) rather than a bare
  // `bottom-5`, which put this on top of the desk's minimap and on top of
  // whatever else was already in the corner. Above the early return: hooks
  // run every render.
  const cornerRef = useRef<HTMLDivElement>(null)
  const corner = useCornerSlot('completion-toast', CORNER_PRIORITY.toast, !!offer, cornerRef)

  if (!offer) return null
  // Queued, not squeezed in: with the corner full this waits for room rather
  // than covering a control or another overlay. The offer stays in the store,
  // so it appears as soon as there is space.
  if (!corner.visible) return null
  return (
    <div
      ref={cornerRef}
      style={{ bottom: corner.bottom, right: corner.right }}
      data-testid="completion-toast"
      className="fixed z-50 flex items-center gap-3 rounded-xl border border-[var(--edge-firm)] bg-[var(--surface-raised)] shadow-lg pl-3.5 pr-2 py-2.5 max-w-[380px]"
    >
      <Icon name="task_alt" size={17} className="shrink-0 text-emerald-500" />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-[var(--ink-90)] truncate font-medium">
          {offer.verbLabel}: “{offer.title}”?
        </div>
        <div className="text-[11px] text-[var(--ink-50)] truncate">{offer.reason}</div>
      </div>
      <button
        onClick={() => {
          const item = items.find((i) => i.id === offer.itemId)
          resolve('completed')
          if (item) void closeItem(item, offer.verbState)
        }}
        className="h-7 px-2.5 shrink-0 fb-btn-surface fb-press fb-t-label text-emerald-600 dark:text-emerald-400"
        title={`${offer.verbLabel} — or press Enter`}
      >
        {offer.verbLabel} ↵
      </button>
      <button
        onClick={() => resolve('dismissed')}
        className="icon-btn !h-7 !w-7 shrink-0"
        title="Not done — never ask about this pairing again (Esc)"
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}
