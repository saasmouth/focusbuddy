import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useActionHistory } from '../stores/actionHistory'
import Icon from './Icon'

// A small bottom-centre toast for the unified action history. After a delete it
// offers an explicit "Undo" (in addition to Cmd-Z); after an undo/redo it just
// confirms what happened, then fades. Text editing and the full editors have
// their own undo and never surface here.

export default function UndoToast(): JSX.Element | null {
  const toast = useActionHistory((s) => s.toast)
  const undo = useActionHistory((s) => s.undo)
  const dismiss = useActionHistory((s) => s.dismissToast)

  useEffect(() => {
    if (!toast) return
    // Deletes linger so the Undo is reachable; confirmations fade quickly.
    const ms = toast.kind === 'action' ? 7000 : 2500
    const t = setTimeout(() => dismiss(), ms)
    return () => clearTimeout(t)
  }, [toast, dismiss])

  if (!toast) return null

  const verb = toast.kind === 'undo' ? 'Undid' : toast.kind === 'redo' ? 'Redid' : null

  return createPortal(
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[260] pointer-events-none">
      {/* Forced-dark HUD capsule in every theme (like the video stage); its hairline is relative to the capsule, not the theme. */}
      <div
        data-testid="undo-toast"
        className="pointer-events-auto flex items-center gap-3 rounded-full bg-stone-900/95 dark:bg-stone-800/95 text-stone-100 border border-white/10 shadow-2xl pl-4 pr-2 py-2 text-[13px]"
      >
        {toast.kind === 'action' ? (
          <>
            <Icon name={toast.entry?.toastIcon ?? 'delete'} size={15} className="text-stone-300" />
            <span className="max-w-[280px] truncate" data-testid="undo-toast-label">{toast.label}</span>
            {toast.entry?.toastAction && (
              <button
                onClick={() => {
                  toast.entry?.toastAction?.run()
                  dismiss()
                }}
                data-testid="undo-toast-action"
                className="ml-1 inline-flex items-center rounded-full px-2.5 py-1 text-[12px] font-medium text-stone-200 hover:bg-white/10"
              >
                {toast.entry.toastAction.label}
              </button>
            )}
            <button
              onClick={() => void undo()}
              data-testid="undo-toast-undo"
              className="ml-1 inline-flex items-center gap-1 rounded-full bg-accent/20 text-accent px-2.5 py-1 text-[12px] font-medium hover:bg-accent/30"
            >
              <Icon name="undo" size={13} /> Undo
            </button>
            <button onClick={dismiss} className="icon-btn-sm text-stone-400 hover:text-stone-200" aria-label="Dismiss">
              <Icon name="close" size={14} />
            </button>
          </>
        ) : (
          <>
            <Icon name={toast.kind === 'undo' ? 'undo' : 'redo'} size={15} className="text-stone-300" />
            <span className="max-w-[300px] truncate">
              {verb} {toast.label}
            </span>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
