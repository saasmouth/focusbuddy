// A browser that belongs to nobody.
//
// The desk browser is a widget: it lives on a canvas, it is part of that piece
// of work, and closing the desk puts it away. That is right for a page you are
// working FROM and wrong for the other kind of browsing — looking something up,
// keeping a reference open across several desks, reading documentation while
// building something else. Those had nowhere to go but a desk they had nothing
// to do with.
//
// So this is the same browser with no desk attached. It reuses BrowserSurface,
// which is the one browser core in the app (A2), so history, the engine picker,
// the address grammar and every hard-won webview rule are shared rather than
// reimplemented — a fix there fixes this too.

import { useEffect, useRef, useState } from 'react'
import BrowserSurface, { type WebviewEl } from '../browser/BrowserSurface'
import Icon from '../Icon'
import { useViewStore } from '../../stores/view'
import { useWidgetStore } from '../../stores/widgets'
import { useNodeStore } from '../../stores/nodes'
import { useNoticeStore } from '../../stores/notice'

// Where it was last pointed. Per device, like the tray: which page you had open
// on this machine is not workspace data.
const KEY = 'plexi.officeBrowser.url'
const HOME = 'https://duckduckgo.com'

function lastUrl(): string {
  try {
    return localStorage.getItem(KEY) || HOME
  } catch {
    return HOME
  }
}

export default function OfficeBrowser(): JSX.Element {
  const [src] = useState(lastUrl)
  const currentUrl = useRef(src)
  const [title, setTitle] = useState('')
  const [sending, setSending] = useState(false)
  const desks = useNodeStore((s) => s.nodes)
  const goTask = useViewStore((s) => s.goTask)
  const [pickDesk, setPickDesk] = useState(false)

  useEffect(() => {
    return () => {
      try {
        localStorage.setItem(KEY, currentUrl.current)
      } catch {
        /* quota — losing the last page is not worth failing over */
      }
    }
  }, [])

  // The one thing a desk-less browser still needs a desk for: "this page turned
  // out to matter, put it on some work." It creates the widget on the chosen
  // desk directly rather than requiring you to open that desk first.
  const sendToDesk = async (deskId: string): Promise<void> => {
    setSending(true)
    try {
      await window.api.widgets.create({
        taskId: deskId,
        kind: 'webview',
        title: title || currentUrl.current,
        content: currentUrl.current,
        width: 520,
        height: 380
      })
      const desk = desks.find((d) => d.id === deskId)
      useNoticeStore.getState().show({
        text: `Sent to ${desk?.title || 'the desk'}`,
        icon: 'desk',
        action: { label: 'Open', run: () => goTask(deskId) }
      })
      // Refresh the target desk's widgets when it is the one on screen, so the
      // page appears rather than waiting for the next visit.
      const v = useViewStore.getState().view
      if (v.kind === 'task' && v.taskId === deskId) {
        void useWidgetStore.getState().loadForTask(deskId, { refresh: true })
      }
    } catch {
      useNoticeStore.getState().show({ text: 'Could not send that page to the desk.', icon: 'warning' })
    } finally {
      setSending(false)
      setPickDesk(false)
    }
  }

  const openDesks = desks.filter((n) => n.kind === 'task' && !n.archived).slice(0, 40)

  return (
    <div className="relative h-full w-full" data-testid="office-browser">
      <BrowserSurface
        surfaceId="office-browser"
        src={src}
        partition="persist:plexii-browser"
        taskId={null}
        onNav={(nav) => {
          currentUrl.current = nav.url
          if (nav.title) setTitle(nav.title)
        }}
        onWebviewEl={(_el: WebviewEl | null) => undefined}
        linkClicks="navigate"
        showTitle
        toolbarTrailing={
          <button
            onClick={() => setPickDesk((v) => !v)}
            disabled={sending}
            data-testid="office-browser-send"
            title="Put this page on a desk"
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 fb-t-label text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-100)] disabled:opacity-50"
          >
            <Icon name="desk" size={14} />
            Send to desk
          </button>
        }
      />

      {pickDesk && (
        <div
          className="absolute right-2 top-11 z-30 w-64 max-h-80 overflow-y-auto rounded-[var(--radius-row)] fb-glass-panel fb-pop-in py-1"
          onMouseLeave={() => setPickDesk(false)}
          data-testid="office-browser-desk-picker"
        >
          <p className="px-3 py-1 fb-t-caption">Put this page on…</p>
          {openDesks.length === 0 && (
            <p className="px-3 py-2 fb-t-label text-[var(--ink-50)]">No desks yet.</p>
          )}
          {openDesks.map((d) => (
            <button
              key={d.id}
              onClick={() => void sendToDesk(d.id)}
              data-testid={`office-browser-desk-${d.id}`}
              className="w-full truncate px-3 py-1.5 text-left fb-t-label text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
            >
              {d.title || 'Untitled desk'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
