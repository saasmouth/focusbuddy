import { useEffect } from 'react'
import Icon from './Icon'
import { useNoticeStore } from '../stores/notice'
import { useCompletionOffer } from '../stores/completionOffer'

// DEC-091 — renders the one live Notice (stores/notice.ts). Bottom-right,
// the CompletionToast's corner — when both are up, this one steps above it
// so neither is hidden. No keyboard claims: a notice never owns focus.

export default function NoticeToast(): JSX.Element | null {
  const notice = useNoticeStore((s) => s.notice)
  const clear = useNoticeStore((s) => s.clear)
  const completionUp = useCompletionOffer((s) => !!s.offer)
  // Dev-only drive seam (the __plexiiProposeBlock precedent): lets live
  // verification raise a notice without a model call. Compiled out of prod.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const on = (e: Event): void => {
      const d = (e as CustomEvent).detail as { text?: string } | undefined
      if (d?.text) useNoticeStore.getState().show({ text: d.text, icon: 'science' })
    }
    window.addEventListener('fb:dev-notice', on)
    return () => window.removeEventListener('fb:dev-notice', on)
  }, [])
  if (!notice) return null
  return (
    <div
      data-testid="notice-toast"
      className={`fixed right-5 z-50 flex items-center gap-2.5 rounded-xl border border-[var(--edge-firm)] bg-[var(--surface-raised)] shadow-lg pl-3.5 pr-2 py-2.5 max-w-[420px] ${
        completionUp ? 'bottom-[86px]' : 'bottom-5'
      }`}
    >
      <Icon name={notice.icon ?? 'check_circle'} size={16} className="shrink-0 text-[rgb(var(--accent))]" />
      <span className="min-w-0 flex-1 text-[12.5px] text-[var(--ink-90)] line-clamp-3 break-words" title={notice.text}>{notice.text}</span>
      {notice.action && (
        <button
          onClick={() => {
            notice.action!.run()
            clear()
          }}
          className="h-7 px-2.5 shrink-0 fb-btn-surface fb-press fb-t-label text-[rgb(var(--accent))]"
        >
          {notice.action.label}
        </button>
      )}
      <button onClick={clear} className="icon-btn !h-6 !w-6 shrink-0" title="Dismiss">
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}
