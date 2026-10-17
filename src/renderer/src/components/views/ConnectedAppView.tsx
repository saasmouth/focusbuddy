import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppNotifications } from '../../stores/appNotifications'
import { confirmDialog } from '../plexi/PromptDialog'
import { useConnectedAppsStore } from '../../stores/connectedApps'
import { useVaultStore } from '../../stores/vault'
import { useViewStore } from '../../stores/view'
import { autofillWebview } from '../../lib/vaultAutofill'
import PlaceholderView from './PlaceholderView'
import VaultBindPopover from './VaultBindPopover'
import Icon from '../Icon'
import AppLogo from '../AppLogo'
import { openHttpUrl } from '../../lib/openUrl'
import { useSignInWatch } from '../../lib/signInWatch'

interface Props {
  appId: string
}

// Full-pane Connected App. Renders an Electron <webview> with a slim toolbar at top:
// app icon + title + back/forward/reload/open-in-browser. Sessions persist via the
// Electron partition (cookies, local storage) across app restarts.
export default function ConnectedAppView({ appId }: Props): JSX.Element {
  const app = useConnectedAppsStore((s) => s.apps.find((a) => a.id === appId)) ?? null
  const remove = useConnectedAppsStore((s) => s.remove)
  const touchApp = useConnectedAppsStore((s) => s.touch)
  const vaultEntries = useVaultStore((s) => s.entries)
  const vaultUnlocked = useVaultStore((s) => s.unlocked)
  const goHome = useViewStore((s) => s.goHome)
  const webviewRef = useRef<HTMLElement | null>(null)
  const setNotifications = useConnectedAppsStore((v) => v.setNotifications)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [loading, setLoading] = useState(true)
  const [currentTitle, setCurrentTitle] = useState<string | null>(null)
  const [vaultPopoverOpen, setVaultPopoverOpen] = useState(false)
  const autofilledForUrl = useRef<string>('')
  // The element as state as well as a ref, so the sign-in watch can attach once
  // the guest exists. A stable callback ref: an inline one would be re-called
  // on every render.
  const [wvEl, setWvEl] = useState<HTMLElement | null>(null)
  const attachWebview = useCallback((el: HTMLElement | null) => {
    webviewRef.current = el
    setWvEl(el)
  }, [])
  // Signed-out detection: the page this app settles on, fed to the detector
  // that drives the side menu's "Signed out — sign in" state.
  useSignInWatch(wvEl, app?.id ?? null)

  // Bump usage on mount so Favourites reflects actual use of the app.
  useEffect(() => {
    if (!appId) return
    void touchApp(appId)
  }, [appId, touchApp])

  // Vault auto-fill: when the page loads and a vault entry is bound to this app,
  // inject credentials. Only fire once per URL.
  useEffect(() => {
    if (!app) return
    if (!app.autofillEnabled) return
    if (!app.vaultEntryId) return
    if (!vaultUnlocked) return
    const wv = webviewRef.current
    if (!wv) return
    const entry = vaultEntries.find((e) => e.id === app.vaultEntryId) ?? null
    if (!entry) return
    // Origin gate: only auto-fill on the host this Connected App is bound to.
    let boundHost = ''
    try {
      boundHost = new URL(app.url).hostname
    } catch {
      boundHost = ''
    }

    function onFinish(): void {
      try {
        const url =
          (wv as unknown as { getURL?: () => string } | null)?.getURL?.() ?? ''
        if (!url || url === autofilledForUrl.current) return
        autofilledForUrl.current = url
        void autofillWebview(wv as HTMLElement | null, entry, boundHost)
      } catch {
        // ignore
      }
    }
    wv.addEventListener('did-finish-load', onFinish as EventListener)
    return () => {
      wv.removeEventListener('did-finish-load', onFinish as EventListener)
    }
  }, [app, vaultEntries, vaultUnlocked])

  // Update nav state on every navigation
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || !app) return
    function refreshNav(): void {
      try {
        const w = wv as unknown as {
          canGoBack: () => boolean
          canGoForward: () => boolean
          getTitle?: () => string
        }
        setCanBack(w.canGoBack())
        setCanForward(w.canGoForward())
        const t = w.getTitle?.() ?? ''
        if (t) setCurrentTitle(t)
      } catch {
        // pre-attach
      }
    }
    function onStart(): void {
      setLoading(true)
    }
    function onStop(): void {
      setLoading(false)
      refreshNav()
    }
    // The app's own unread claim, reported as it changes. Only for apps that
    // asked for it — see stores/appNotifications for why the title is the
    // honest source and what it cannot do.
    const onTitle = (e: Event): void => {
      if (!app.notifications) return
      const title = (e as unknown as { title?: string }).title ?? ''
      useAppNotifications.getState().report(app.id, title)
    }
    wv.addEventListener('page-title-updated', onTitle as EventListener)
    wv.addEventListener('did-start-loading', onStart as EventListener)
    wv.addEventListener('did-stop-loading', onStop as EventListener)
    wv.addEventListener('did-navigate', refreshNav as EventListener)
    wv.addEventListener('did-navigate-in-page', refreshNav as EventListener)
    return () => {
      wv.removeEventListener('page-title-updated', onTitle as EventListener)
      wv.removeEventListener('did-start-loading', onStart as EventListener)
      wv.removeEventListener('did-stop-loading', onStop as EventListener)
      wv.removeEventListener('did-navigate', refreshNav as EventListener)
      wv.removeEventListener('did-navigate-in-page', refreshNav as EventListener)
    }
  }, [app])

  // Popups (OAuth sign-in, modals, redirects) are allowed via the allowpopups
  // attribute on the <webview> below, set at attach time. It used to be set
  // from an effect here, which does nothing: Electron reads the attribute when
  // the guest is created, so "Sign in with Google / GitHub / etc." was broken
  // for every connected app despite the code that looked like it enabled it.
  // Letting Electron open a real native window keeps `window.opener` intact,
  // which is what the provider posts its callback back through.

  if (!app) {
    return (
      <PlaceholderView
        icon="apps"
        title="App not found"
        blurb="This connected app may have been removed. Pick another from the sidebar or add a new one."
        cta={{ label: 'Go home', onClick: goHome }}
      />
    )
  }

  function navBack(): void {
    const wv = webviewRef.current
    if (!wv) return
    ;(wv as unknown as { goBack: () => void }).goBack()
  }
  function navForward(): void {
    const wv = webviewRef.current
    if (!wv) return
    ;(wv as unknown as { goForward: () => void }).goForward()
  }
  function reload(): void {
    const wv = webviewRef.current
    if (!wv) return
    ;(wv as unknown as { reload: () => void }).reload()
  }
  function openInBrowser(): void {
    // http(s) only, with no opener and no referrer; the main process's
    // window-open handler still hands it to the system browser.
    openHttpUrl(app!.url)
  }

  return (
    <div className="h-full flex flex-col bg-[var(--surface-raised)]">
      {/* Toolbar */}
      <div className="px-3 py-2 border-b border-[var(--edge-soft)] bg-[var(--surface-sunken)] flex items-center gap-1 shrink-0">
        <AppLogo app={app} size={28} glyphSize={14} className="rounded-md mr-1" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-[var(--ink-100)] truncate">
            {app.title}
          </div>
          <div className="text-[10px] text-[var(--ink-50)] truncate font-mono">
            {currentTitle ? `${currentTitle} · ` : ''}
            {(() => {
              try {
                return new URL(app.url).hostname.replace(/^www\./, '')
              } catch {
                return app.url
              }
            })()}
          </div>
        </div>
        <button
          onClick={navBack}
          disabled={!canBack}
          className="icon-btn disabled:opacity-40 disabled:cursor-not-allowed"
          title="Back"
        >
          <Icon name="arrow_back" size={14} />
        </button>
        <button
          onClick={navForward}
          disabled={!canForward}
          className="icon-btn disabled:opacity-40 disabled:cursor-not-allowed"
          title="Forward"
        >
          <Icon name="arrow_forward" size={14} />
        </button>
        <button
          onClick={reload}
          className={`icon-btn ${loading ? 'animate-spin' : ''}`}
          title="Reload"
        >
          <Icon name="refresh" size={14} />
        </button>
        <button
          onClick={openInBrowser}
          className="icon-btn"
          title="Open in system browser"
        >
          <Icon name="open_in_new" size={14} />
        </button>
        {/* The notifications toggle the connect dialog promises you can change
            later. Without it that sentence was a lie, and the preference would
            have been settable exactly once. */}
        <button
          onClick={() => void setNotifications(app.id, !app.notifications)}
          className={`icon-btn ${app.notifications ? '!text-accent' : ''}`}
          data-testid="connected-app-notifications"
          title={
            app.notifications
              ? 'Unread count shown in the side menu — click to stop showing it'
              : 'Show this app’s unread count in the side menu'
          }
        >
          <Icon
            name={app.notifications ? 'notifications_active' : 'notifications_off'}
            size={14}
            filled={app.notifications}
          />
        </button>
        <div className="relative">
          <button
            onClick={() => setVaultPopoverOpen((v) => !v)}
            className={`icon-btn ${app.vaultEntryId ? '!text-accent' : ''}`}
            title={
              app.vaultEntryId
                ? 'Vault binding — auto-fill enabled'
                : 'Bind vault credentials for auto-fill'
            }
          >
            <Icon name={app.vaultEntryId ? 'key' : 'key_off'} size={14} />
          </button>
          {vaultPopoverOpen && (
            <VaultBindPopover
              app={app}
              onClose={() => setVaultPopoverOpen(false)}
            />
          )}
        </div>
        <button
          onClick={() => {
            void confirmDialog({
              title: `Remove "${app.title}"?`,
              body: 'It disappears from Connected Apps. You can add it again any time.',
              confirmLabel: 'Remove',
              danger: true
            }).then((ok) => {
              if (ok) void remove(app.id).then(goHome)
            })
          }}
          className="icon-btn hover:!text-red-700"
          title="Remove this app"
        >
          <Icon name="delete" size={14} />
        </button>
      </div>

      {/* Webview fills the rest. Partition name ties cookies/storage to this app, so
          sessions survive app restarts even though the element unmounts on view switch. */}
      <div className="flex-1 min-h-0 relative">
        <webview
          ref={attachWebview as never}
          src={app.url}
          // Persistent partition per app so cookies + storage survive app restarts.
          partition={`persist:connectedapp-${app.id}`}
          // MUST be here, in the JSX, not set later from an effect. Electron
          // reads allowpopups when the guest webContents is created; an
          // attribute added afterwards is silently ignored. It WAS being set
          // from a useEffect below — which runs after attach, so it never took
          // and no popup could open from a connected app at all. The main
          // process's window-open handler never even got a say, because the
          // guest was not permitted to ask.
          // @ts-ignore — allowpopups is a valid <webview> attribute
          allowpopups="true"
          style={{ width: '100%', height: '100%', display: 'inline-flex' }}
        />
      </div>
    </div>
  )
}
