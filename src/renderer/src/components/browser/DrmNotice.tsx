import { useEffect, useState } from 'react'
import type { DrmNoticePayload } from '@shared/drm'
import Icon from '../Icon'

// The protected-video notice above a web page (src/main/widevine.ts decides
// when, src/shared/drm.ts what it says). It says WHY the page's video can't
// play here (Widevine missing, the site refusing this build's DRM signature,
// or a licence error) and offers the person's own browser, which can. It sits
// in the surface's own layout above the page, never over it: the page keeps
// working (its sound, its controls, anything else it shows).

interface PageHandle {
  getWebContentsId(): number
}

/** The latest notice main sent for this page, or null; and a way to dismiss it. */
export function useDrmNotice(page: PageHandle | null): [DrmNoticePayload | null, () => void] {
  const [notice, setNotice] = useState<DrmNoticePayload | null>(null)
  useEffect(() => {
    if (!page) return
    const subscribe = window.api?.webview?.onDrmNotice
    if (typeof subscribe !== 'function') return
    const off = subscribe((p) => {
      let id = -1
      try {
        id = page.getWebContentsId()
      } catch {
        return // not attached yet
      }
      if (p.webContentsId === id) setNotice(p)
    })
    // Another document in this surface: the notice was about the last one.
    const el = page as unknown as HTMLElement
    const onNavigate = (): void => setNotice(null)
    el.addEventListener?.('did-navigate', onNavigate)
    return () => {
      off()
      el.removeEventListener?.('did-navigate', onNavigate)
      setNotice(null)
    }
  }, [page])
  return [notice, () => setNotice(null)]
}

export default function DrmNotice({
  notice,
  onDismiss
}: {
  notice: DrmNoticePayload
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-start gap-2 shrink-0 px-3 py-2 border-b border-[var(--edge-soft)] bg-[var(--surface-sunken)] text-[11.5px] leading-snug text-[var(--ink-70)]"
      data-testid="browser-drm-notice"
      data-reason={notice.reason}
    >
      <Icon name="lock" size={14} className="mt-px shrink-0 text-[var(--ink-50)]" />
      <span className="flex-1 min-w-0" data-testid="browser-drm-notice-text">
        {notice.text}
      </span>
      <button
        type="button"
        className="shrink-0 font-medium text-[rgb(var(--accent))] hover:underline"
        title={notice.url}
        data-testid="browser-drm-open"
        onClick={() => void window.api.files.openExternal(notice.url)}
      >
        Open in your browser
      </button>
      <button
        type="button"
        className="icon-btn !h-5 !w-5 shrink-0"
        aria-label="Dismiss"
        title="Dismiss"
        data-testid="browser-drm-dismiss"
        onClick={onDismiss}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}
