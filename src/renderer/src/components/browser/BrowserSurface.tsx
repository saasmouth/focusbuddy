import { useEffect, useRef, useState } from 'react'
import { navTrailGate } from '@shared/navTrail'
import Icon from '../Icon'
import EnginePickerChip from './EnginePickerChip'
import { useWebPanel } from '../../stores/webPanel'
import { searchUrl as engineSearchUrl } from '../../lib/omniIntent'
import { resolveAddressInput } from '../../lib/browserUrl'

// The ONE browser inside Plexi (A2 desk-browser unification, Caleb's picks
// 2026-08-23): the desk's browser widget and the panel/fullscreen surface
// share this core — one webview shape, one toolbar grammar (back/forward/
// reload, an address bar that navigates or searches the pinned engine, the
// engine picker, the explicit system-browser escape), one browsing history.
// Surfaces wrap it with their own chrome: the widget adds canvas overlay,
// pin-to-apps and resolution presets; the panel adds fullscreen, send-to-
// desk and close. A fix here fixes every browser in the app.
//
// Hard-won rules this core carries (do not relearn them):
// - src is NEVER rebound on navigation. persist/omni writes drive an explicit
//   loadURL sync; rebinding src reloads the page and kills mid-sign-in POSTs.
// - allowpopups must be present at ATTACH time — Electron reads it when the
//   guest webContents is created; setting it later silently does nothing.
// - partition is locked at attach and must never change while mounted.

// The webview element's imperative surface, the parts this core uses.
export interface WebviewEl extends HTMLElement {
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): Promise<void>
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  getTitle(): string
  getWebContentsId(): number
}

export interface BrowserNavState {
  url: string
  title: string
  /**
   * DEC-061 — whether the nav-trail gate admitted this navigation.
   *
   * The gate is STATEFUL: an admitted call updates the trail, so asking twice
   * about the same event answers false the second time. The decision therefore
   * has to be made once, here, where the event originates — and handed to
   * consumers rather than re-asked. Both writers (browsing_history's count and
   * the activity trail) then agree by construction instead of by coincidence.
   */
  admitted: boolean
}

interface Props {
  /**
   * DEC-061 — a STABLE identity for this surface, supplied by the caller.
   *
   * Deliberately not useId() or anything mounted-scoped: the workspace-sync
   * tick remounts browser widgets, and a per-mount identity would be reset by
   * the very thing the gate exists to absorb — which is precisely how 39,762
   * rows and a 14,096 "visit" count were written in one 19-hour session.
   */
  surfaceId: string
  // The address this surface was asked to show, already sanitized. Changing
  // it triggers a loadURL sync; the webview navigates freely in between.
  src: string
  partition: string
  // Desk attribution for the browsing-history record; null for surfaces that
  // do not belong to a desk (the panel).
  taskId?: string | null
  // Fires on every main-frame navigation commit — surfaces persist URLs,
  // record trails, or update their own chrome from here. History recording
  // itself lives in the core (one history for one browser).
  onNav?: (nav: BrowserNavState) => void
  // Hands the surface the live webview element (registry, autofill, popup
  // routing). Called with null on unmount.
  onWebviewEl?: (el: WebviewEl | null) => void
  // target=_blank links forwarded by main: 'navigate' loads them in place
  // (the panel — no tabs, the page IS the surface); 'ignore' leaves them to
  // the surface (the widget spawns a sibling canvas widget).
  linkClicks?: 'navigate' | 'ignore'
  // Page title shown left of the address bar (the connected-app grammar);
  // the compact panel and the widget omit it — their frames carry identity.
  showTitle?: boolean
  // Surface-specific controls, rendered at the toolbar's right end.
  toolbarTrailing?: React.ReactNode
  toolbarClassName?: string
  // Rendered over the webview area (the widget's click-to-interact overlay
  // and HUD chips — a deliberate edges-census keep).
  overlay?: React.ReactNode
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export default function BrowserSurface({
  surfaceId,
  src,
  partition,
  taskId = null,
  onNav,
  onWebviewEl,
  linkClicks = 'ignore',
  showTitle = false,
  toolbarTrailing,
  toolbarClassName = '',
  overlay
}: Props): React.JSX.Element {
  const webviewRef = useRef<WebviewEl | null>(null)
  const engine = useWebPanel((s) => s.engine)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [loading, setLoading] = useState(false)
  const [currentUrl, setCurrentUrl] = useState(src)
  const [title, setTitle] = useState('')
  // Address-bar edit buffer — commits on Enter/blur only, so transient typing
  // never navigates (the widget's proven pattern).
  const [urlDraft, setUrlDraft] = useState('')
  const [urlEditing, setUrlEditing] = useState(false)
  // Callback ref so the surface's own effects (autofill, registry, popups)
  // re-run when the element genuinely appears, not on a render race.
  const setWebviewNode = (el: HTMLElement | null): void => {
    webviewRef.current = el as WebviewEl | null
    onWebviewElRef.current?.(el as WebviewEl | null)
  }
  // Keep the latest onWebviewEl without retriggering the callback ref.
  const onWebviewElRef = useRef(onWebviewEl)
  onWebviewElRef.current = onWebviewEl
  const onNavRef = useRef(onNav)
  onNavRef.current = onNav

  // Navigation + loading + title wiring — one subscription for every surface.
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const nav = (e: Event): void => {
      const ev = e as Event & { url?: string; isMainFrame?: boolean }
      if (ev.isMainFrame === false) return
      let url = ''
      let pageTitle = ''
      try {
        url = ev.url ?? wv.getURL()
        pageTitle = wv.getTitle()
      } catch {
        // pre-attach race — the next event fills in
      }
      if (!url || !/^https?:\/\//i.test(url)) return
      setCurrentUrl(url)
      try {
        setCanGoBack(wv.canGoBack())
        setCanGoForward(wv.canGoForward())
      } catch {
        // ignore
      }
      // DEC-061 — ONE gate decision per navigation, made here and shared.
      //
      // The count is gated; the metadata write is not. Each pass of the
      // four-event fan-in carries a better getTitle(), and the upsert takes the
      // better one — so the record still sharpens while the counter stops
      // lying. See recordVisit for why the two had to be separated rather than
      // the whole call suppressed.
      const admitted = navTrailGate.admit({ widgetId: surfaceId, url }, Date.now())
      // One history for one browser: every surface records, attributed to its
      // desk when it has one (null taskId is the panel — the handler accepts it).
      void window.api.history.record(url, pageTitle, taskId, admitted)
      onNavRef.current?.({ url, title: pageTitle, admitted })
    }
    const onTitle = (e: Event): void => {
      const t = (e as unknown as { title?: string }).title
      if (t) setTitle(t)
    }
    const start = (): void => setLoading(true)
    const stop = (): void => setLoading(false)
    wv.addEventListener('did-navigate', nav)
    wv.addEventListener('did-navigate-in-page', nav)
    wv.addEventListener('did-finish-load', nav)
    wv.addEventListener('did-redirect-navigation', nav)
    wv.addEventListener('did-start-loading', start)
    wv.addEventListener('did-stop-loading', stop)
    wv.addEventListener('page-title-updated', onTitle)
    return () => {
      wv.removeEventListener('did-navigate', nav)
      wv.removeEventListener('did-navigate-in-page', nav)
      wv.removeEventListener('did-finish-load', nav)
      wv.removeEventListener('did-redirect-navigation', nav)
      wv.removeEventListener('did-start-loading', start)
      wv.removeEventListener('did-stop-loading', stop)
      wv.removeEventListener('page-title-updated', onTitle)
    }
    // taskId is stable per mounted surface; src changes ride the same webview.
  }, [taskId, src])

  // Explicit loadURL sync when the ASKED-FOR address changes (a new openWeb
  // call, an external widget.content write). Never fires on the webview's own
  // navigation, so no reload loop is possible.
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    if (!src || !/^https?:\/\//i.test(src)) return
    try {
      if (wv.getURL() === src) return
      void wv.loadURL(src)
    } catch {
      // not yet attached — the initial src attribute will load
    }
  }, [src])

  // target=_blank links: main forwards them over IPC with the source
  // webContents id. 'navigate' surfaces load them in place — no tabs, the
  // page is the surface (R4: the web never leaves Plexi).
  useEffect(() => {
    if (linkClicks !== 'navigate') return
    const off = window.api.webview.onLinkClicked(({ sourceWebContentsId, url }) => {
      const wv = webviewRef.current
      if (!wv) return
      let myId = -1
      try {
        myId = wv.getWebContentsId()
      } catch {
        return
      }
      if (myId !== sourceWebContentsId) return
      if (!url || !/^https?:\/\//i.test(url)) return
      try {
        void wv.loadURL(url)
      } catch {
        // ignore
      }
    })
    return off
  }, [linkClicks])

  // Unmount: hand the surface a null element so registries clean up.
  useEffect(() => {
    return () => onWebviewElRef.current?.(null)
  }, [])

  function commitAddress(): void {
    setUrlEditing(false)
    const raw = urlDraft.trim()
    if (!raw) return
    // A real address navigates; anything searchy runs on the PINNED engine —
    // the same preference the omnibar and the panel chip share (AI-02), so
    // the address bar can never disagree with the rest of the app.
    const next = resolveAddressInput(raw, (q) => engineSearchUrl(engine, q))
    if (!next || next === currentUrl) return
    const wv = webviewRef.current
    try {
      void wv?.loadURL(next)
    } catch {
      // bad URL — the draft keeps the user's text
    }
  }

  return (
    <div className="h-full w-full min-h-0 flex flex-col">
      <div
        className={`flex items-center gap-1 shrink-0 px-2 py-1.5 ${toolbarClassName}`}
        data-testid="browser-toolbar"
      >
        <button
          className="icon-btn !h-6 !w-6"
          disabled={!canGoBack}
          onClick={() => webviewRef.current?.goBack()}
          title="Back"
          aria-label="Go back"
        >
          <Icon name="arrow_back" size={14} />
        </button>
        <button
          className="icon-btn !h-6 !w-6"
          disabled={!canGoForward}
          onClick={() => webviewRef.current?.goForward()}
          title="Forward"
          aria-label="Go forward"
        >
          <Icon name="arrow_forward" size={14} />
        </button>
        <button
          className="icon-btn !h-6 !w-6"
          onClick={() => (loading ? webviewRef.current?.stop() : webviewRef.current?.reload())}
          title={loading ? 'Stop' : 'Reload'}
          aria-label={loading ? 'Stop loading' : 'Reload'}
        >
          <Icon name={loading ? 'close' : 'refresh'} size={14} />
        </button>
        {showTitle && (
          <div className="min-w-0 max-w-[220px] pl-1 shrink" title={title || currentUrl}>
            <div className="text-sm font-semibold text-[var(--ink-100)] truncate">
              {title || hostnameOf(currentUrl)}
            </div>
          </div>
        )}
        {/* Width law (edges census): the field's wrapper is flex-1 min-w-0 and
            the input fills IT — a bare 100%-wide field swallows the row. */}
        <div className="flex-1 min-w-0 px-1">
          <input
            value={urlEditing ? urlDraft : currentUrl}
            onFocus={(e) => {
              setUrlDraft(currentUrl)
              setUrlEditing(true)
              e.currentTarget.select()
            }}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitAddress()
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'Escape') {
                // Esc here only cancels the edit — it must never reach the
                // panel's window listener, which would step the surface down.
                e.preventDefault()
                e.stopPropagation()
                setUrlEditing(false)
                setUrlDraft('')
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            onBlur={() => {
              if (urlEditing) commitAddress()
            }}
            onMouseDown={(e) => e.stopPropagation()}
            spellCheck={false}
            placeholder="Search or enter address"
            // The glass pillow is the affordance — no hard focus rectangle
            // (Caleb's Home-bar ruling, the composer's precedent).
            className="w-full h-6 px-2 rounded-[var(--radius-chip)] bg-[var(--surface-sunken)] text-[11px] text-[var(--ink-90)] placeholder:text-[var(--ink-40)] truncate focus:outline-none"
            title={currentUrl}
            data-testid="browser-address"
          />
        </div>
        <EnginePickerChip />
        <button
          className="icon-btn !h-6 !w-6"
          onClick={() => void window.api.files.openExternal(currentUrl || src)}
          title="Open in your system browser"
          data-testid="browser-external"
        >
          <Icon name="open_in_new" size={14} />
        </button>
        {toolbarTrailing}
      </div>
      <div className="flex-1 relative min-h-0">
        <webview
          ref={setWebviewNode}
          src={src}
          partition={partition}
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore — allowpopups is a valid <webview> attribute
          allowpopups="true"
          style={{ width: '100%', height: '100%', display: 'inline-flex' }}
        />
        {overlay}
      </div>
    </div>
  )
}
