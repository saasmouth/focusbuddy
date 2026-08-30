import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../Icon'
import BrowserSurface, { hostnameOf, type BrowserNavState, type WebviewEl } from './BrowserSurface'
import AgentRunDock from './AgentRunDock'
import { useWebPanel } from '../../stores/webPanel'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import { useWidgetStore } from '../../stores/widgets'
import { catalogFor } from '../../lib/widgetCatalog'
import { spawnPositionFor } from '../../lib/spawnPosition'
import { sanitizeWebviewUrl } from '../../lib/browserUrl'
// Side-effect: the agent-run store subscribes to main's browserAgent events
// for the window's lifetime — the panel is the surface those runs drive.
import '../../stores/browserAgentRuns'

// The in-app browser panel (A2, AI-03, R4/R13): the web never leaves Plexi.
// One right-side panel serves citations, omnibar URLs, and search results —
// Claude-style, over the content, dismissed with Esc or its close control.
// Since the desk-browser unification it renders the SAME BrowserSurface core
// as the desk's browser widget: one toolbar grammar, one cookie jar
// (persist:webview-default — sign in once, signed in everywhere in Plexi),
// one browsing history. This wrapper owns only panel chrome: the portal, the
// fullscreen connected-app rectangle, Esc stepping down, send-to-desk, close.

export default function WebPanel(): React.JSX.Element | null {
  const open = useWebPanel((s) => s.open)
  const url = useWebPanel((s) => s.url)
  const close = useWebPanel((s) => s.close)
  const expanded = useWebPanel((s) => s.expanded)
  const toggleExpanded = useWebPanel((s) => s.toggleExpanded)
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  // The live page (URL + title) for send-to-desk — the webview navigates
  // freely after src, so the store's url is only where the panel STARTED.
  const navRef = useRef<BrowserNavState | null>(null)
  const src = sanitizeWebviewUrl(url ?? '')
  // The A6 door on the panel itself: "let Plexii drive this page".
  const [askOpen, setAskOpen] = useState(false)

  // The webview's webContents id, published to the store once attached —
  // the agent runtime (A6) drives THIS page through main and can only act
  // on a webContents it can address. getWebContentsId throws before attach,
  // so poll briefly instead of racing the attach event.
  const setWcId = useWebPanel((s) => s.setWcId)
  const [wvEl, setWvEl] = useState<WebviewEl | null>(null)
  useEffect(() => {
    if (!wvEl) {
      setWcId(null)
      return
    }
    let stopped = false
    const read = (): void => {
      if (stopped) return
      try {
        setWcId(wvEl.getWebContentsId())
      } catch {
        setTimeout(read, 120)
      }
    }
    read()
    return () => {
      stopped = true
      setWcId(null)
    }
  }, [wvEl, setWcId])

  // Fullscreen means "like a connected app" (Caleb's ruling on the live
  // drive): the browser fills the CONTENT area — the nav rail stays visible
  // and clickable, exactly like opening Claude or Slack. The panel is a
  // fixed portal (so expanding never remounts the webview and never reloads
  // the page), so the content rectangle is measured from the live layout —
  // <main> minus the sidebar dock — and tracked per frame while expanded,
  // which also follows sidebar resizes and collapses for free.
  const [fullRect, setFullRect] = useState<{
    top: number
    left: number
    width: number
    height: number
  } | null>(null)
  useEffect(() => {
    if (!open || !expanded) {
      setFullRect(null)
      return
    }
    let raf = 0
    const tick = (): void => {
      const main = document.querySelector('main')
      if (main) {
        const m = main.getBoundingClientRect()
        const aside = document.querySelector(
          '[data-testid="desk-sidebar"], [data-testid="desk-sidebar-collapsed"]'
        )
        const left = aside
          ? Math.min(Math.max(aside.getBoundingClientRect().right + 6, m.left), m.right - 320)
          : m.left
        setFullRect((prev) => {
          const next = { top: m.top, left, width: m.right - left, height: m.height }
          return prev &&
            prev.top === next.top &&
            prev.left === next.left &&
            prev.width === next.width &&
            prev.height === next.height
            ? prev
            : next
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open, expanded])

  // Esc steps DOWN: a fullscreen browser first returns to the panel, a
  // second Esc closes it. (The webview swallows its own keys; this catches
  // the chrome.)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (useWebPanel.getState().expanded) toggleExpanded()
      else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close, toggleExpanded])

  // Send-to-desk (unification hand-off, Caleb's pick): the CURRENT page —
  // logins ride along, the cookie jar is shared — lands as a browser widget
  // on the open desk, selected, and the panel steps aside.
  async function sendToDesk(): Promise<void> {
    const taskId = useNodeStore.getState().activeTaskId
    if (!taskId) return
    const pageUrl = navRef.current?.url || src
    const pageTitle = navRef.current?.title || ''
    const entry = catalogFor('webview')
    const widget = await useWidgetStore.getState().create({
      taskId,
      kind: 'webview',
      title: pageTitle || hostnameOf(pageUrl),
      content: pageUrl,
      ...spawnPositionFor(entry?.defaultWidth ?? 560, entry?.defaultHeight ?? 400),
      width: entry?.defaultWidth,
      height: entry?.defaultHeight,
      color: null
    })
    useNodeStore.getState().setActive(taskId)
    useViewStore.getState().goTask(taskId)
    useWidgetStore.getState().setSelection([widget.id])
    close()
  }

  if (!open || !src) return null

  return createPortal(
    <aside
      data-testid="web-panel"
      data-expanded={expanded ? 'true' : 'false'}
      className={`fixed z-[130] flex flex-col bg-[var(--surface-raised)] overflow-hidden ${
        expanded
          ? ''
          : 'top-10 bottom-7 right-[14px] w-[min(560px,calc(100vw-120px))] rounded-[var(--radius-card)] fb-fade-in-up'
      }`}
      style={
        expanded && fullRect
          ? { top: fullRect.top, left: fullRect.left, width: fullRect.width, height: fullRect.height }
          : expanded
            ? { top: 40, left: 90, right: 8, bottom: 28 }
            : {
                boxShadow:
                  '0 0 0 1px var(--edge-hairline), var(--shadow-cast), var(--shadow-inset-highlight)'
              }
      }
    >
      <BrowserSurface
        // The panel is a singleton surface, so a constant is a stable identity.
        surfaceId="web-panel"
        src={src}
        partition="persist:webview-default"
        taskId={null}
        linkClicks="navigate"
        onWebviewEl={setWvEl}
        showTitle={expanded}
        toolbarClassName={
          expanded
            ? 'border-b border-[var(--edge-soft)] bg-[var(--surface-sunken)]'
            : 'bg-[var(--surface-raised)]'
        }
        onNav={(nav) => {
          navRef.current = nav
        }}
        toolbarTrailing={
          <>
            <button
              className="icon-btn !h-6 !w-6"
              onClick={() => setAskOpen((v) => !v)}
              title="Let Plexii do something on this page"
              data-testid="web-panel-agent"
            >
              <Icon name="plexii:ai" size={14} />
            </button>
            {activeTaskId && (
              <button
                className="icon-btn !h-6 !w-6"
                onClick={() => void sendToDesk()}
                title="Send this page to your desk"
                data-testid="web-panel-send-to-desk"
              >
                <Icon name="desk" size={14} />
              </button>
            )}
            <button
              className="icon-btn !h-6 !w-6"
              onClick={toggleExpanded}
              title={expanded ? 'Back to the side panel (Esc)' : 'Full screen'}
              data-testid="web-panel-expand"
            >
              <Icon name={expanded ? 'fullscreen_exit' : 'fullscreen'} size={14} />
            </button>
            <button
              className="icon-btn !h-6 !w-6"
              onClick={close}
              title="Close"
              data-testid="web-panel-close"
            >
              <Icon name="close" size={14} />
            </button>
          </>
        }
      />
      <AgentRunDock askOpen={askOpen} onCloseAsk={() => setAskOpen(false)} onOpenAsk={() => setAskOpen(true)} />
    </aside>,
    document.body
  )
}
