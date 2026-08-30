import { useEffect, useRef, useState } from 'react'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import { useConnectedAppsStore } from '../../stores/connectedApps'
import { useVaultStore } from '../../stores/vault'
import { useWebPanel } from '../../stores/webPanel'
import { catalogFor } from '../../lib/widgetCatalog'
import { registerWebview, unregisterWebviewByWidgetId } from '../../lib/webviewRegistry'
import { autofillWebview } from '../../lib/vaultAutofill'
import { normalizeUrl, sanitizeWebviewUrl } from '../../lib/browserUrl'
import BrowserSurface, {
  hostnameOf,
  type BrowserNavState,
  type WebviewEl
} from '../browser/BrowserSurface'
import Icon from '../Icon'
import ConnectedToolMenu from '../contextMenu/UnifiedConnectedMenu'

// The desk's browser widget. Since the A2 desk-browser unification it renders
// the SAME BrowserSurface core as the panel/fullscreen browser — one toolbar
// grammar, one cookie jar for freeform widgets (persist:webview-default), one
// browsing history. This wrapper owns only what makes it a CANVAS widget:
// the frame, the click-to-interact overlay, Connected-App sessions + vault
// autofill, pin-to-apps, resolution presets, the target=_blank spawn, and
// persisting the live URL back into widget.content.

// Stored viewport presets the user can snap a browser window to. Sizes are
// the common device classes (CSS px) so a page renders the way it would on
// that form factor — the user asked for "4 commonly used options".
const BROWSER_RESOLUTIONS: { label: string; sub: string; width: number; height: number }[] = [
  { label: 'Mobile', sub: '390 × 844', width: 390, height: 844 },
  { label: 'Tablet', sub: '768 × 1024', width: 768, height: 1024 },
  // Tablet landscape — the small-screen-friendly wide option. 1024×768 fits
  // comfortably where Laptop/Desktop would run off the edges of a small display.
  { label: 'Tablet (landscape)', sub: '1024 × 768', width: 1024, height: 768 },
  { label: 'Laptop', sub: '1366 × 768', width: 1366, height: 768 },
  { label: 'Desktop', sub: '1920 × 1080', width: 1920, height: 1080 }
]

interface Props {
  widget: Widget
  inline?: boolean
}

export default function WebViewWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const create = useWidgetStore((s) => s.create)
  // setActive (not focusOn): activating a browser widget you can already see
  // must NOT pan the camera — focusOn bumps centerToken and yanks the world.
  // The overlay's whole job is to hand the NEXT click to the page, so it just
  // marks the widget active in place.
  const setActive = useWidgetStore((s) => s.setActive)
  const isActive = useWidgetStore((s) => s.activeWidgetId === widget.id)
  // The live webview element, handed up by BrowserSurface once attached.
  // State (not a ref) so the registry/autofill/popup effects re-run when the
  // element genuinely appears or is torn down.
  const [wvEl, setWvEl] = useState<WebviewEl | null>(null)
  const entry = catalogFor(widget.kind)
  const placeholder = entry?.urlPlaceholder ?? 'https://…'
  const [editing, setEditing] = useState(!widget.content)
  const [draft, setDraft] = useState(widget.content)
  // Resolution-preset dropdown (snap the browser window to a stored viewport).
  const [resMenuOpen, setResMenuOpen] = useState(false)
  // Right-click on the widget frame (NOT the inner webview — webviews
  // own their own context menu). Captures clicks on the chrome / URL
  // bar area; we ALWAYS suppress the chrome's native menu so the
  // create-and-connect entry is reachable.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; cellText?: string } | null>(null)
  // Live preview shown in the header — tracks the CURRENT page while navigating.
  const [livePreview, setLivePreview] = useState<{ url: string; title: string } | null>(null)
  // Last URL we persisted into widget.content — avoids redundant DB writes on rapid navs
  const lastPersistedUrl = useRef<string>(widget.content)
  // ── webviewSrc — the URL we hand BrowserSurface as its load target ────────
  // CRITICAL: this is intentionally NOT derived from widget.content. Binding
  // src={widget.content} causes the webview to reload on every navigation,
  // because persistNavUrl writes the post-nav URL back to widget.content →
  // React re-renders with a new src → the core's loadURL sync treats it as a
  // load request → reload kills mid-sign-in POSTs.
  //
  // Instead, webviewSrc is only updated when the URL change is EXTERNAL to
  // this webview: the user typed a new URL in the edit form, or a sibling
  // widget instance (e.g. focus-mode swap) wrote a different URL. The
  // webview navigates organically for everything else.
  const [webviewSrc, setWebviewSrc] = useState(() => sanitizeWebviewUrl(widget.content))
  const headerLabel = (() => {
    const previewTitle = livePreview?.title
    const previewHost = livePreview ? hostnameOf(livePreview.url) : ''
    if (previewTitle) return previewTitle
    if (previewHost) return previewHost
    if (widget.title) return widget.title
    if (widget.content) return hostnameOf(widget.content)
    return entry?.label ?? 'browser'
  })()

  // Full reset when the widget instance itself changes (different widget id —
  // e.g. focus-mode mounts a fresh sibling for the same content). Notably we
  // do NOT include widget.content here: that would refire on every persistNavUrl
  // write and reset state mid-navigation.
  useEffect(() => {
    setDraft(widget.content)
    setEditing(!widget.content)
    lastPersistedUrl.current = widget.content
    setWebviewSrc(sanitizeWebviewUrl(widget.content))
    setLivePreview(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.id])

  // External-sync: widget.content changed but it wasn't from THIS webview's
  // own navigation (lastPersistedUrl tracks our own writes). Cases that fire
  // this branch: the focus-mode sibling wrote a new URL while we were
  // mounted, or the user explicitly edited the URL via the form (commit()
  // also sets lastPersistedUrl so we don't double-load there).
  useEffect(() => {
    if (widget.content === lastPersistedUrl.current) return
    // Genuine external change — sync to webview + adopt as our new baseline.
    lastPersistedUrl.current = widget.content
    setWebviewSrc(sanitizeWebviewUrl(widget.content))
    setDraft(widget.content)
  }, [widget.content])

  // Safety-net flush on unmount: if the last nav event didn't fire (rare) or
  // the user closes focus mode mid-load, read the webview's getURL() and
  // commit it. Keyed on the element so the cleanup always sees the live one.
  useEffect(() => {
    if (!wvEl) return
    return () => {
      try {
        const finalUrl = wvEl.getURL?.() ?? ''
        const finalTitle = wvEl.getTitle?.() ?? ''
        if (finalUrl && /^https?:\/\//i.test(finalUrl) && finalUrl !== lastPersistedUrl.current) {
          lastPersistedUrl.current = finalUrl
          void update(widget.id, {
            content: finalUrl,
            title: finalTitle || hostnameOf(finalUrl)
          })
        }
      } catch {
        // Element already detached; best effort
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wvEl, widget.id])

  // Persist the latest URL into widget.content so the next mount (incl. focus-mode
  // expand) loads where you left off. NO debounce — saves are tiny and racing the user
  // clicking "expand" is worse than 3 extra writes during a redirect chain.
  function persistNavUrl(url: string, title: string): void {
    if (!/^https?:\/\//i.test(url)) return
    if (url === lastPersistedUrl.current) return
    setLivePreview({ url, title })
    lastPersistedUrl.current = url
    void update(widget.id, {
      content: url,
      title: title || hostnameOf(url)
    })
  }

  // Every main-frame navigation, from the shared core: record the trail and
  // persist where the user actually is. (History recording lives in the core.)
  //
  // The trail row is gated (DEC-058). The core funnels four webview events into
  // one onNav — did-navigate, did-navigate-in-page, did-finish-load,
  // did-redirect-navigation — so a single page load arrives here three times,
  // and the 20s workspace-sync tick reloads the webview underneath us. Ungated,
  // a desk nobody was touching wrote 39,762 rows carrying 15 distinct URLs in
  // one 19-hour session. `persistNavUrl` below has always skipped the redundant
  // write with its own `url === lastPersistedUrl` check; this is the same
  // question asked on behalf of the activity log, which never asked it.
  //
  // Deliberately NOT reset when this component unmounts: the sync refresh
  // remounts browser widgets, so a per-mount trail would be cleared by the very
  // thing it exists to absorb. The gate is module-scoped and bounds its own
  // memory with an LRU over widget ids.
  function handleNav({ url, title, admitted }: BrowserNavState): void {
    // DEC-061 — the verdict rides the event now. Calling admit() again here
    // would consume the gate a second time for one navigation and answer false,
    // silently dropping the trail row this branch exists to write.
    if (admitted) {
      void window.api.trail.record({
        taskId: widget.taskId,
        kind: 'browser_nav',
        payload: { url, title, host: hostnameOf(url), widgetId: widget.id }
      })
    }
    persistNavUrl(url, title)
  }

  // Spawn a canvas widget for target=_blank links that originated from this
  // webview's webContents. We compare webContentsId so a link click in one
  // browser widget doesn't spawn duplicates across every other browser widget.
  // (Popups themselves — OAuth, window.open — are routed by the main process;
  // intercepting new-window in the renderer would kill window.opener.)
  useEffect(() => {
    if (!wvEl) return
    const off = window.api.webview.onLinkClicked(({ sourceWebContentsId, url }) => {
      let myId = -1
      try {
        myId = wvEl.getWebContentsId()
      } catch {
        return
      }
      if (myId !== sourceWebContentsId) return
      if (!url || !/^https?:\/\//i.test(url)) return
      void create({
        taskId: widget.taskId,
        kind: 'webview',
        title: '',
        content: url,
        x: widget.x + 40,
        y: widget.y + 40,
        width: 560,
        height: 400,
        color: null,
        sourceAppId: widget.sourceAppId
      })
    })
    return off
  }, [wvEl, widget.id, widget.taskId, widget.x, widget.y, widget.sourceAppId, create])

  // Register this webview's webContentsId so the host renderer can look it up
  // when the main process forwards a context-menu action.
  useEffect(() => {
    if (!wvEl) return
    function handleDomReady(): void {
      try {
        registerWebview(wvEl!.getWebContentsId(), widget.id, wvEl!)
      } catch {
        // webview not yet attached
      }
    }
    wvEl.addEventListener('dom-ready', handleDomReady as EventListener)
    // The element may already be past dom-ready by the time this effect runs
    // (the core hands it up on attach) — register eagerly too; the registry
    // call is idempotent per widget id.
    handleDomReady()
    return () => {
      wvEl.removeEventListener('dom-ready', handleDomReady as EventListener)
      unregisterWebviewByWidgetId(widget.id)
    }
  }, [wvEl, widget.id])

  function commit(): void {
    const url = normalizeUrl(draft)
    if (!url) return
    setDraft(url)
    // User-initiated URL change. Mark as our write (so the external-sync
    // useEffect skips it) AND drive the webview load via webviewSrc.
    lastPersistedUrl.current = url
    setWebviewSrc(url)
    void update(widget.id, { content: url, title: hostnameOf(url) })
    setEditing(false)
  }

  // ── Connected App binding ─────────────────────────────────────────────────
  // If this widget was dragged from a Connected App OR has been pinned to one,
  // share that app's session partition + auto-fill its vault credentials.
  const apps = useConnectedAppsStore((s) => s.apps)
  const touchApp = useConnectedAppsStore((s) => s.touch)
  const createApp = useConnectedAppsStore((s) => s.create)
  const vaultEntries = useVaultStore((s) => s.entries)
  const vaultUnlocked = useVaultStore((s) => s.unlocked)
  const sourceApp = widget.sourceAppId
    ? apps.find((a) => a.id === widget.sourceAppId) ?? null
    : null
  // Derive the persistent partition from the id the widget ALREADY carries, not
  // from the looked-up app object. Electron locks a webview's partition at attach
  // time and it can never change afterward, so if the connected-apps store hasn't
  // hydrated yet when this mounts (or during the rapid remount on a desk switch),
  // reading it off `sourceApp` would fall back to the empty default partition and
  // strand the app there — logged out, even though its real cookies live under
  // persist:connectedapp-<id>. Keying off widget.sourceAppId removes that race so
  // the session survives desk switches and cold boots alike. (sourceApp is still
  // looked up above for the vault/autofill logic that needs the full object.)
  // Freeform widgets share persist:webview-default with the panel/fullscreen
  // browser — the unification's one cookie jar.
  const partition = widget.sourceAppId
    ? `persist:connectedapp-${widget.sourceAppId}`
    : 'persist:webview-default'

  // Bump the connected app's usage when this widget is first focused — signals
  // the Favourites sort that the user is actively working with it.
  const bumpedFocusFor = useRef<string | null>(null)
  useEffect(() => {
    if (!sourceApp) return
    if (!isActive) return
    if (bumpedFocusFor.current === sourceApp.id) return
    bumpedFocusFor.current = sourceApp.id
    void touchApp(sourceApp.id)
  }, [isActive, sourceApp, touchApp])

  // Vault auto-fill: when the page settles and we have a bound vault entry,
  // inject credentials. Only fire once per load (tracked via the URL ref) so
  // we don't refill a half-submitted form on every sub-frame did-finish-load.
  const autofilledForUrl = useRef<string>('')
  useEffect(() => {
    if (!wvEl) return
    if (!sourceApp) return
    if (!sourceApp.autofillEnabled) return
    if (!sourceApp.vaultEntryId) return
    if (!vaultUnlocked) return
    const vaultEntry = vaultEntries.find((e) => e.id === sourceApp.vaultEntryId) ?? null
    if (!vaultEntry) return
    // Origin gate: only auto-fill on the host this Connected App is bound to.
    const boundHost = hostnameOf(sourceApp.url)

    function onFinish(): void {
      try {
        const url = wvEl?.getURL?.() ?? ''
        if (!url || url === autofilledForUrl.current) return
        autofilledForUrl.current = url
        void autofillWebview(wvEl, vaultEntry, boundHost)
      } catch {
        // ignore
      }
    }
    wvEl.addEventListener('did-finish-load', onFinish as EventListener)
    return () => {
      wvEl.removeEventListener('did-finish-load', onFinish as EventListener)
    }
  }, [wvEl, sourceApp, vaultEntries, vaultUnlocked])

  // ── "Pin this site" handler ───────────────────────────────────────────────
  // One-click promotion from a freeform browser widget to a Connected App.
  // Re-uses the existing connected app if the hostname already matches one we
  // know about (no duplicates), otherwise creates a new app from the current
  // URL + title. The widget's sourceAppId then drives partition + autofill.
  const [pinning, setPinning] = useState(false)
  async function handlePinToApps(): Promise<void> {
    if (pinning || sourceApp || !widget.content) return
    setPinning(true)
    try {
      let host = ''
      try {
        host = new URL(widget.content).hostname.replace(/^www\./, '')
      } catch {
        return
      }
      const existing = await window.api.connectedApps.findByHostname(host)
      if (existing) {
        await update(widget.id, { sourceAppId: existing.id })
        void touchApp(existing.id)
        return
      }
      let title = ''
      try {
        title = wvEl?.getTitle?.() ?? ''
      } catch {
        // ignore
      }
      const app = await createApp({
        title: title || host,
        url: widget.content,
        icon: 'apps',
        color: null
      })
      await update(widget.id, { sourceAppId: app.id })
      void touchApp(app.id)
    } finally {
      setPinning(false)
    }
  }

  // In inline (focus modal) mode the modal already provides isolation, so always interactive.
  const showOverlay = !inline && !editing && !isActive

  // Hand-off to the fullscreen connected-app browser (unification, Caleb's
  // pick): the same page — shared cookie jar, logins ride along — opens
  // edge-to-edge; Esc steps back down to the panel, then away.
  function openFullScreen(): void {
    const url = livePreview?.url || widget.content
    if (!url) return
    useWebPanel.getState().openWeb(url, { expanded: true })
  }

  // The widget's HUD chips over web content (pin-to-apps / linked / edit) are
  // a deliberate edges-census keep: containment hairlines over arbitrary
  // media, the video-stage-chrome family.
  const overlay = (
    <>
      {showOverlay && (
        <div
          onClick={(e) => {
            e.stopPropagation()
            // ⌘/Ctrl-click while zoomed out dives into this browser: jump
            // to 100% with it centred. The overlay swallows the event
            // (stopPropagation) so it never reaches WidgetFrame — we have
            // to honour the gesture here too, or browsers would be the
            // one widget kind that can't be dived into.
            const store = useWidgetStore.getState()
            if ((e.metaKey || e.ctrlKey) && store.zoom < 0.8) {
              store.zoomToWidget(widget.id)
              return
            }
            setActive(widget.id)
          }}
          className="absolute inset-0 cursor-pointer group bg-transparent"
          title="Click to interact — scroll pans the canvas while not active"
        >
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-full fb-glass-chrome border text-[11px] text-[var(--ink-90)] shadow-[var(--shadow-soft)] flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            <Icon name="touch_app" size={12} />
            <span>Click to interact</span>
          </div>
        </div>
      )}
      {!editing && (
        <div className="absolute top-1 right-1 flex items-center gap-1 z-10">
          {!sourceApp && widget.content && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                void handlePinToApps()
              }}
              disabled={pinning}
              title="Pin this site to Connected Apps (shares session + enables vault auto-fill)"
              className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-raised)]/90 border border-[var(--edge-firm)] hover:bg-[var(--surface-sunken)] text-[var(--ink-70)] disabled:opacity-60"
            >
              <Icon name="push_pin" size={11} />
              <span>{pinning ? 'pinning…' : 'pin to apps'}</span>
            </button>
          )}
          {sourceApp && (
            <span
              title={`Linked to "${sourceApp.title}" — session + auto-fill shared`}
              className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-raised)]/90 border border-[var(--edge-firm)] text-[var(--ink-70)]"
            >
              <Icon name="link" size={11} />
              <span className="truncate max-w-[120px]">{sourceApp.title}</span>
            </span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              setEditing(true)
            }}
            title="Change URL (full form)"
            className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-raised)]/90 border border-[var(--edge-firm)] hover:bg-[var(--surface-sunken)] text-[var(--ink-70)]"
          >
            <Icon name="edit" size={11} />
            <span>edit</span>
          </button>
        </div>
      )}
    </>
  )

  const toolbarTrailing = (
    <>
      <button
        className="icon-btn !h-6 !w-6"
        onClick={openFullScreen}
        title="Open full screen"
        aria-label="Open this page full screen"
        data-testid="widget-browser-fullscreen"
      >
        <Icon name="fullscreen" size={14} />
      </button>
      <div className="relative shrink-0">
        <button
          onClick={(e) => {
            e.stopPropagation()
            setResMenuOpen((v) => !v)
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className={`icon-btn !h-6 !w-6 ${resMenuOpen ? 'bg-[var(--surface-sunken)]' : ''}`}
          title="Resize to a stored resolution"
          aria-label="Resize to a stored resolution"
        >
          <Icon name="aspect_ratio" size={14} />
        </button>
        {resMenuOpen && (
          <>
            {/* click-away backdrop */}
            <div
              className="fixed inset-0 z-40"
              onClick={(e) => {
                e.stopPropagation()
                setResMenuOpen(false)
              }}
              onMouseDown={(e) => e.stopPropagation()}
            />
            <div
              className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute right-0 top-7 z-50 w-44 py-1"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--ink-40)]">
                Window size
              </div>
              {BROWSER_RESOLUTIONS.map((r) => {
                const active =
                  Math.round(widget.width) === r.width && Math.round(widget.height) === r.height
                return (
                  <button
                    key={r.label}
                    onClick={(e) => {
                      e.stopPropagation()
                      update(widget.id, { width: r.width, height: r.height })
                      setResMenuOpen(false)
                    }}
                    className={`w-full flex items-center justify-between px-3 py-1.5 text-left text-[12px] hover:bg-[var(--surface-sunken)] ${active ? 'text-[var(--ink-100)] font-medium' : 'text-[var(--ink-70)]'}`}
                  >
                    <span className="flex items-center gap-2">
                      {active && <Icon name="check" size={12} />}
                      <span className={active ? '' : 'pl-[18px]'}>{r.label}</span>
                    </span>
                    <span className="text-[10px] text-[var(--ink-40)] tabular-nums">{r.sub}</span>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>
    </>
  )

  const body = (
    <div
      className="h-full w-full bg-[var(--surface-raised)] relative flex flex-col"
      onContextMenu={(e) => {
        // The <webview> element owns its inner context menu via
        // shell-level webContents; we only act on right-clicks landing
        // on the chrome / URL bar / loading overlay (everything OUTSIDE
        // the webview). Detect by checking whether the target is
        // inside the webview element.
        const t = e.target as HTMLElement
        if (t.closest && t.closest('webview')) return
        if (e.shiftKey) return
        e.preventDefault()
        // For webview widgets, the most useful seed is the URL — passes
        // through as content for sticky/note/markdown so the user has
        // the URL handy in the new tool too.
        const seed = widget.content || ''
        setCtxMenu({ x: e.clientX, y: e.clientY, cellText: seed })
      }}
    >
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            commit()
          }}
          className="h-full w-full flex flex-col items-stretch justify-center gap-2 p-4"
        >
          <label className="text-xs uppercase tracking-wider text-[var(--ink-50)] flex items-center gap-1.5">
            <Icon name={entry?.icon ?? 'public'} size={16} className="text-[var(--ink-70)]" />
            {entry?.label ?? 'URL'}
          </label>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            className="fb-field w-auto bg-[var(--surface-raised)] px-3 py-2 text-sm"
          />
          <p className="text-[11px] text-[var(--ink-70)]">
            {entry?.hint ?? 'Renders inside a focused browser tab — no other tabs allowed.'}
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <button type="submit" className="btn-primary">
              <Icon name="open_in_new" size={14} />
              <span>Load</span>
            </button>
          </div>
        </form>
      ) : (
        <BrowserSurface
          surfaceId={widget.id}
          src={webviewSrc}
          partition={partition}
          taskId={widget.taskId}
          onNav={handleNav}
          onWebviewEl={setWvEl}
          linkClicks="ignore"
          toolbarClassName="border-b border-[var(--edge-soft)] bg-[var(--surface-sunken)]/80 !px-1.5 !py-1"
          toolbarTrailing={toolbarTrailing}
          overlay={overlay}
        />
      )}
      {ctxMenu && (
        <ConnectedToolMenu
          sourceWidgetId={widget.id}
          x={ctxMenu.x}
          y={ctxMenu.y}
          selectionContext={{ selectionText: ctxMenu.cellText }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )

  if (inline) return body

  // Build the kind-specific context menu extras. WidgetFrame's generic menu
  // (Make-this-a-task / Duplicate / Bring-to-front / Archive) sits beneath
  // these; we surface webview-only actions like "Pin to Apps" and "Reload"
  // at the top so they're a single right-click away.
  const headerMenuExtras: { label: string; icon: string; onClick: () => void }[] = []
  // Pin to Apps — only meaningful for a freeform widget with a URL that
  // isn't already bound to a Connected App. Once bound, the entry stays
  // hidden because re-pinning would be a no-op.
  if (!sourceApp && widget.content) {
    headerMenuExtras.push({
      label: 'Pin to Apps',
      icon: 'push_pin',
      onClick: () => void handlePinToApps()
    })
  }
  // Reload — duplicates the toolbar button so it's reachable when the user
  // is already in a right-click context.
  headerMenuExtras.push({
    label: 'Reload',
    icon: 'refresh',
    onClick: () => {
      try {
        wvEl?.reload?.()
      } catch {
        // ignore
      }
    }
  })
  // Open full screen — the unification hand-off, also reachable by right-click.
  if (widget.content) {
    headerMenuExtras.push({
      label: 'Open full screen',
      icon: 'fullscreen',
      onClick: openFullScreen
    })
  }
  // Change URL (full form) — same path as the existing "edit" button in
  // the top-right cluster. Useful when the user wants the hint-rich form
  // instead of the inline URL bar.
  headerMenuExtras.push({
    label: 'Change URL…',
    icon: 'edit',
    onClick: () => setEditing(true)
  })

  return (
    <WidgetFrame
      widget={widget}
      headerLabel={`${entry?.label ?? 'Browser'} · ${headerLabel}`}
      headerAccent="bg-stone-300/60"
      headerMenuExtras={headerMenuExtras}
    >
      {body}
    </WidgetFrame>
  )
}
