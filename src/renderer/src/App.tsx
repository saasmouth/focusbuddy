import { useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import PlexiiLogo from './components/PlexiiLogo'
import { FLOATING_MENU_INSET, SIDEBAR_MIN, SIDEBAR_MAX } from './components/chrome/floatingMenuStyle'
import { useMinimizable, useSidebarWidth } from './components/chrome/floatingMenu'
import MainPane from './components/MainPane'
import PlexiOfficeShell from './components/office/PlexiOfficeShell'
import { PlexiDeskShell, PlexiPeopleShell, PlexiBrainShell } from './components/segment/segments'
import AssistantOverlay from './components/assistant/AssistantOverlay'
import PinTray from './components/pins/PinTray'
import { useAssistantChrome } from './stores/assistantChrome'
import LiveDeskPublisherHost from './components/LiveDeskPublisherHost'
import TelemetryReporter from './components/TelemetryReporter'
import ReleaseModal from './components/ReleaseModal'
import Tooltip from './components/Tooltip'
import { getPendingReleaseEntry, advanceRunVersion, type ChangelogEntry } from './lib/changelog'
import Icon from './components/Icon'
import SettingsPanel from './components/SettingsPanel'
import RelatedDesksModal from './components/RelatedDesksModal'
import TeamPresenceButton from './components/TeamPresenceButton'
import Footer from './components/Footer'
import FocusSessionOverlay from './components/FocusSessionOverlay'
import CallOverlay from './components/CallOverlay'
import MeetingOverlay from './components/MeetingOverlay'
import MeetingLaunchDialog from './components/MeetingLaunchDialog'
import WrapupOverlay from './components/WrapupOverlay'
import KnockOverlay from './components/KnockOverlay'
import { useCallStore } from './stores/call'
import { useMeetingRoomStore } from './stores/meetingRoom'
import { useKnockStore } from './stores/knock'
import BringMeBack from './components/BringMeBack'
import HyperfocusGuardian from './components/HyperfocusGuardian'
import PreTaskBridge from './components/PreTaskBridge'
import HistoryNav, { useHistoryKeys } from './components/HistoryNav'
import SmartStackModal from './components/SmartStackModal'
import CursorSpotlight from './components/CursorSpotlight'
import PeerBodyDoubleDialog from './components/PeerBodyDoubleDialog'
import CommandCenter from './components/CommandCenter'
import MetricsOverlay from './components/MetricsOverlay'
import LaunchSignInModal from './components/LaunchSignInModal'
import UpgradePromptModal from './components/UpgradePromptModal'
import FirstRunOnboarding from './components/FirstRunOnboarding'
import OnboardingTour from './components/onboarding/OnboardingTour'
import FeatureSpotlightPopup from './components/onboarding/FeatureSpotlightPopup'
import OnboardingHub from './components/onboarding/OnboardingHub'
import { useOnboarding } from './stores/onboarding'
import { useMessagingStore } from './stores/messaging'
import { useMailStore } from './stores/mail'
import { usePeerBodyDoubleStore } from './stores/peerBodyDouble'
import { useNodeStore } from './stores/nodes'
import { useTemplateStore } from './stores/templates'
import { useVaultStore } from './stores/vault'
import { useAccountStore } from './stores/account'
import { personDisplayName, personInitials } from './lib/personName'
import { installInboxPoller } from './lib/inboxPoller'
import { startWorkspaceSync, stopWorkspaceSync } from './lib/workspaceSync'
import { isShareRecipient, shareDeskId } from './lib/shareMode'
import { initCrdtSync, stopCrdtSync } from './lib/crdtSync'
import { applyCustomization, applyFont, applyTheme, loadCustomization, loadTheme, useTheme } from './lib/theme'
import { typingClick } from './lib/audioBeep'
import { setActiveWidgetForSound } from './lib/soundPrefs'
import { useWidgetStore } from './stores/widgets'
import { installLivingPageScheduler } from './lib/livingPageScheduler'
import { installCapabilityWatcher } from './stores/capabilities'
import { useViewStore } from './stores/view'
import { useActionHistory } from './stores/actionHistory'
import UndoToast from './components/UndoToast'
import CompletionToast from './components/CompletionToast'
import NoticeToast from './components/NoticeToast'
import GuestCaptureBar from './components/GuestCaptureBar'
import MissedTriagePrompt from './components/MissedTriagePrompt'
import { PromptDialogHost, confirmDialog } from './components/plexi/PromptDialog'
import { DocHistoryPanelHost } from './components/documents/DocHistoryPanel'
import ShortcutsOverlay from './components/ShortcutsOverlay'
import CaptureConsole from './components/CaptureConsole'
import AttentionBadge from './components/AttentionBadge'
import './lib/timeOfDay' // side-effect: pushes --tod-* CSS vars to :root + ticks every 60s
// Block reminders moved to the main-process notification substrate (Attention
// S4): durable rows + the 30s sweep replace the renderer setInterval engine,
// so a reminder scheduled before a restart still fires after it.
import './lib/modelPrefs' // side-effect: pushes user's saved model mode to main process
import './lib/bodyDouble' // side-effect: auto-resumes Body Double mode if user had it enabled
import './lib/driftDetector' // side-effect: listens for window/document visibility + idle to detect drift
import './lib/hyperfocusGuardian' // side-effect: tracks continuous focus runs to offer breaks at 90 min

// Apply theme on script load — before React mounts — to avoid a light flash in dark mode
const _bootTheme = loadTheme()
applyTheme(_bootTheme.mode, _bootTheme.accent, _bootTheme.customAccentHex)
applyFont(_bootTheme.font)
applyCustomization(loadCustomization())

export default function App(): JSX.Element {
  const refresh = useNodeStore((s) => s.refresh)
  const setActive = useNodeStore((s) => s.setActive)
  const refreshTemplates = useTemplateStore((s) => s.refresh)
  // The global Desk sidebar is now a floating, resizable, minimisable card
  // rather than a docked resize panel. Its minimise state and width persist
  // across reloads; on a small window it starts minimised so it doesn't cover
  // the content.
  const {
    minimized: sidebarMinimized,
    toggle: toggleSidebar
  } = useMinimizable('fb.sidebar.minimized')
  // ⌘←/⌘→ and mouse back/forward drive the view history from anywhere.
  useHistoryKeys()
  // PlexiOffice is a full-bleed segment with its own chrome: when active it takes
  // over the main area, replacing the global sidebar / desk panels.
  const currentView = useViewStore((s) => s.view)
  // Phase 1b spike (Edges + Glass, Caleb 2026-08-23): on the desk canvas the
  // main pane runs full-bleed BENEATH the dock column, so the desk moves
  // behind the floating menu and the menu earns the chrome glass tier. Every
  // other view keeps the dock beside the content so nothing is ever hidden.
  const canvasFullBleed = currentView.kind === 'task'
  const segmentTakeover =
    currentView.kind === 'office' ||
    currentView.kind === 'plexidesk' ||
    currentView.kind === 'plexipeople' ||
    currentView.kind === 'plexibrain'
  // The assistant is a global overlay (AssistantOverlay) rather than a desk
  // panel, so it exists on every screen — segment takeovers included. In
  // sidebar mode it docks right and <main> reserves its width below, the same
  // way a docked meeting reserves its edge.
  const assistantOpen = useAssistantChrome((s) => s.open)
  const assistantMode = useAssistantChrome((s) => s.mode)
  const assistantWidth = useAssistantChrome((s) => s.width)
  // Focus mode suppresses the assistant entirely (3a.2, P4) — release the
  // sidebar-mode pad too, or the focus overlay's translucent backdrop shows a
  // phantom empty strip where the hidden dock would be. Same predicate the
  // overlay uses: focus mode genuinely showing, not a stale focusedWidgetId.
  const focusedWidgetId = useWidgetStore((s) => s.focusedWidgetId)
  // A 48-hour share shows the desk and nothing else. The recipient has no
  // workspace of their own to navigate, so a sidebar of desks they do not have,
  // a titlebar of tools they cannot keep and a footer are all noise around the
  // one thing they were sent. The countdown and the download call-to-action are
  // rendered by the cloud entry, above this.
  const shareView = isShareRecipient()

  // A share window opens on the desk it was sent, not on a home view of a
  // workspace the visitor does not have. Runs once the nodes are loaded, since
  // setActive on an id the store has never seen would select nothing.
  const nodesForShare = useNodeStore((n) => n.nodes)
  const setActiveForShare = useNodeStore((n) => n.setActive)
  const activeForShare = useNodeStore((n) => n.activeTaskId)
  useEffect(() => {
    if (!shareView || activeForShare) return
    const wanted = shareDeskId()
    const desk = wanted
      ? nodesForShare.find((n) => n.id === wanted)
      : nodesForShare.find((n) => n.kind === 'task')
    if (desk) setActiveForShare(desk.id)
  }, [shareView, activeForShare, nodesForShare, setActiveForShare])

  const focusModeShowing =
    (currentView.kind === 'task' || currentView.kind === 'project-dashboard') &&
    focusedWidgetId !== null
  const assistantPad =
    assistantOpen && assistantMode === 'sidebar' && !focusModeShowing ? assistantWidth : 0
  // When a meeting is docked (collaborate mode), reserve space on that edge so the
  // docked panel does not cover the workspace content. The panel itself is a
  // fixed-position surface (MeetingOverlay); this just keeps the content clear.
  const meetDocked = useMeetingRoomStore((s) => s.status !== 'idle' && s.layout === 'collaborate')
  const meetDockSide = useMeetingRoomStore((s) => s.dockSide)
  const meetPad: React.CSSProperties = meetDocked
    ? {
        paddingLeft: meetDockSide === 'left' ? 300 : undefined,
        paddingRight: meetDockSide === 'right' ? 300 : undefined,
        paddingTop: meetDockSide === 'top' ? 210 : undefined,
        paddingBottom: meetDockSide === 'bottom' ? 210 : undefined
      }
    : {}
  // Reserved edges compose: a right-docked meeting and a sidebar-mode
  // assistant each claim their own strip, so the paddings add.
  const mainPad: React.CSSProperties =
    assistantPad > 0
      ? {
          ...meetPad,
          paddingRight: (meetDocked && meetDockSide === 'right' ? 300 : 0) + assistantPad
        }
      : meetPad
  // On macOS the window uses hiddenInset, so the traffic lights sit at the top
  // left of the header. Reserve room so the header's left controls (the show-
  // workspace toggle, the trust chip) never sit under them.
  const isMac = typeof window !== 'undefined' && window.api?.platform === 'darwin'
  const [settingsOpen, setSettingsOpen] = useState<{ x: number; y: number } | null>(null)
  const [smartStackOpen, setSmartStackOpen] = useState(false)
  // First-run "What's new in vX.Y.Z" modal — shown once on the first launch
  // after an update. Resolved on mount; a fresh install sets the baseline
  // silently so it never appears retroactively.
  const [releaseEntry, setReleaseEntry] = useState<ChangelogEntry | null>(null)
  // The one-shot AI command bar retired in the Plexii consolidation: ⌘⇧K and
  // every former summoner open the Plexii hub (view.kind 'plexii') instead.
  // Peer body double — controlled HERE rather than inside its own
  // component so the dialog can be summoned from anywhere (button in
  // chrome, future keyboard shortcut, future "you've been stuck for 20
  // minutes — try a body double?" nudge) without losing state.
  const [bodyDoubleOpen, setBodyDoubleOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const peerStatus = usePeerBodyDoubleStore((s) => s.status)
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null)
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const unsectionedCount = useWidgetStore(
    (s) =>
      s.widgets.filter(
        (w) =>
          !w.archived &&
          !w.pinned &&
          w.kind !== 'section' &&
          w.parentSectionId === null
      ).length
  )
  const canSmartStack = !!activeTaskId && unsectionedCount >= 3
  const theme = useTheme()
  const activeWidgetId = useWidgetStore((s) => s.activeWidgetId)
  // Vault state powers the "Local · encrypted" chip in the header. We
  // refresh meta on mount so the chip can reflect whether the vault has
  // been initialised at all (no chip = surprising; chip with a "set up
  // vault" hint = informative).
  const vaultMeta = useVaultStore((s) => s.meta)
  const vaultUnlocked = useVaultStore((s) => s.unlocked)
  const refreshVaultMeta = useVaultStore((s) => s.refreshMeta)
  // Account boot — kicked off once on mount. The LaunchSignInModal reads
  // bootStatus to know when it's safe to render.
  const accountInit = useAccountStore((s) => s.init)
  const account = useAccountStore((s) => s.account)
  const sessionToken = useAccountStore((s) => s.sessionToken)
  const signOut = useAccountStore((s) => s.signOut)
  const adoptHandoff = useAccountStore((s) => s.adoptHandoff)
  // Messaging: open the persistent, authenticated socket while signed in so
  // DMs + shared-space chat arrive in real time; tear it down on sign-out.
  const connectMessaging = useMessagingStore((s) => s.connect)
  const disconnectMessaging = useMessagingStore((s) => s.disconnect)
  // Wire the PlexiCam call signaling + PlexiPeople knock handlers once; both ride
  // the same socket.
  useEffect(() => {
    useCallStore.getState().init()
    useMeetingRoomStore.getState().init()
    useKnockStore.getState().init()
  }, [])
  useEffect(() => {
    if (account && sessionToken) {
      void connectMessaging(sessionToken)
      // Learn the credit balance + whether the server proxy is live as soon as
      // we're signed in, so the very first AI call routes correctly (credits vs
      // BYOK) instead of bouncing off a dormant proxy.
      void window.api.ai.refreshCredits()
      // Multi-device sync: keep this account's tasks + canvas widgets in step with
      // its other devices. Default-on; pushes local changes and pulls remote ones.
      startWorkspaceSync()
      // WS01 sync substrate (flagged, off by default): routes widget edits through
      // the one CRDT change log alongside the poll. No-op unless fb.sync.crdt.widgets.
      initCrdtSync()
    } else {
      disconnectMessaging()
      stopWorkspaceSync()
      stopCrdtSync()
    }
    return () => {
      stopWorkspaceSync()
      stopCrdtSync()
    }
  }, [account, sessionToken, connectMessaging, disconnectMessaging])

  // Mail is local (IMAP straight from the desktop), so it loads independently
  // of PlexiDesk sign-in. Doing it once at startup populates the sidebar's
  // unread badge and warms the inbox list before the user opens Mail.
  const loadMailAccount = useMailStore((s) => s.loadAccount)
  useEffect(() => {
    void loadMailAccount()
  }, [loadMailAccount])

  // Web→desktop auth handoff. The brochure sign-in flow at haptyx.app/account/*
  // produces a session token, then deep-links to haptyx://auth?token=...
  // which main forwards over IPC. We adopt the token here.
  useEffect(() => {
    let detach: (() => void) | null = null
    async function consumeAndSubscribe(): Promise<void> {
      const pending = await window.api.auth.getPending()
      if (pending) await adoptHandoff({ sessionToken: pending.sessionToken, email: pending.email })
      // A haptyx://auth deep link can be triggered by ANY website while the app
      // is open, so a live incoming token is a forced-login (session-fixation)
      // vector. Require an explicit confirmation naming the account before
      // adopting it. The startup getPending path above is the user's own
      // just-completed login returning focus, so it stays friction-free.
      detach = window.api.auth.onIncomingToken((handoff) => {
        void confirmDialog({
          title: 'Sign in to PlexiDesk?',
          body: handoff.email
            ? `A sign-in link wants to log this app in as ${handoff.email}. Only continue if you just started this sign-in.`
            : 'A sign-in link wants to log this app in. Only continue if you just started this sign-in.',
          confirmLabel: 'Sign in'
        }).then((ok) => {
          if (ok) void adoptHandoff({ sessionToken: handoff.sessionToken, email: handoff.email })
        })
      })
    }
    void consumeAndSubscribe()
    return () => { detach?.() }
  }, [adoptHandoff])

  // Share deep link (haptyx://share?token=...) from the "Open in PlexiDesk"
  // notification email → accept the share into "Shared with me" so it appears in
  // the app, exactly as the paste-a-link flow does. Same drain-pending +
  // subscribe pattern as the auth handoff.
  useEffect(() => {
    let detach: (() => void) | null = null
    async function run(): Promise<void> {
      const accept = async (token: string): Promise<void> => {
        try {
          const { useSharesStore } = await import('./stores/shares')
          await useSharesStore.getState().acceptByToken(token)
        } catch {
          /* non-fatal — the item is also in the server inbox */
        }
      }
      const pendingToken = await window.api.share.getPending()
      if (pendingToken) await accept(pendingToken)
      detach = window.api.share.onIncomingToken((t) => void accept(t))
    }
    void run()
    return () => {
      detach?.()
    }
  }, [])

  // Meeting-join deep link (haptyx://meet?room=...) from an invite email → open
  // the meeting view and join that room. Same drain-pending + subscribe pattern.
  useEffect(() => {
    let detach: (() => void) | null = null
    async function run(): Promise<void> {
      const join = async (roomId: string): Promise<void> => {
        try {
          const { joinMeetingRoom } = await import('./lib/startMeeting')
          await joinMeetingRoom(roomId, 'Meeting')
        } catch {
          /* non-fatal — the user can join from the calendar block instead */
        }
      }
      const pendingRoom = await window.api.meet.getPending()
      if (pendingRoom) await join(pendingRoom)
      detach = window.api.meet.onIncomingRoom((r) => void join(r))
    }
    void run()
    return () => {
      detach?.()
    }
  }, [])

  // External markdown deep link (haptyx://edit-md?path=...) from the ops
  // console: open the file as a PlexiDocs surface (ws-v-3).
  useEffect(() => {
    let detach: (() => void) | undefined
    const openPath = (p: string): void => {
      useViewStore.getState().go({ kind: 'mdext', path: p })
    }
    const run = async (): Promise<void> => {
      const pending = await window.api.mdext.getPending()
      if (pending) openPath(pending)
      detach = window.api.mdext.onIncomingPath(openPath)
    }
    void run()
    return () => {
      detach?.()
    }
  }, [])

  // First launch after an update → show the "What's new" modal once for this
  // version. The main process says authoritatively whether this boot followed
  // an update; we then advance the run-version marker so the next update is
  // detected. A fresh install shows nothing.
  useEffect(() => {
    let cancelled = false
    const decide = (wasUpdated: boolean): void => {
      if (cancelled) return
      const entry = getPendingReleaseEntry({ wasUpdated })
      if (entry) setReleaseEntry(entry)
      advanceRunVersion()
    }
    void window.api.app
      .getLaunchInfo()
      .then((info) => decide(!!info?.wasUpdated))
      .catch(() => decide(false))
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    void refresh()
    void refreshTemplates()
    void refreshVaultMeta()
    void accountInit()
    // First-run onboarding gate — decides (once) whether this is a fresh
    // install that should see the welcome flow, or an existing user to skip.
    void useOnboarding.getState().init()
    // Living-page auto-regen scheduler — subscribes to the widget store and
    // debounces regens whenever source widgets in a task change. Installs
    // once per app process; no teardown needed because it's a singleton.
    installLivingPageScheduler()
    // Inbox poller — subscribes to the account store and polls the server
    // for new inbox items when the user is signed in. No-op when signed
    // out. Tears down automatically on sign-out.
    installInboxPoller()
    // Capability watcher — fetches /account/capabilities on auth change
    // and on window focus. Drives the useCapability hook + the in-app
    // gates (body double, marketplace credits, AI features per tier).
    installCapabilityWatcher()
  }, [refresh, refreshTemplates, refreshVaultMeta, accountInit])

  // Keep the active desk in sync with the view so the Canvas (rendered by MainPane)
  // shows the right widgets. Every desk is a canvas: both a task and a top-level
  // folder-desk (project-dashboard) point the canvas at their own node.
  useEffect(() => {
    if (currentView.kind === 'task') setActive(currentView.taskId)
    else if (currentView.kind === 'project-dashboard') setActive(currentView.projectId)
  }, [currentView, setActive])

  // Feed the active-widget id into the sound system so "Quiet while widget active" works
  useEffect(() => {
    setActiveWidgetForSound(activeWidgetId)
  }, [activeWidgetId])

  // Global keypress click (controlled by the user's sound prefs)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key.length !== 1) return // skip modifiers, arrows, function keys
      if (e.metaKey || e.ctrlKey || e.altKey) return
      typingClick()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Cmd+Shift+K toggles the Plexii hub — distinct from Cmd+K (the search
  // palette). Two shortcuts for two purposes: search what exists, vs. talk to
  // Plexii. Pressed on the hub it steps back out, so the key genuinely
  // toggles. (The one-shot AI command bar this used to open retired in the
  // Plexii consolidation — the conversation proposes builds now.)
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const v = useViewStore.getState()
        if (v.view.kind === 'plexii') {
          v.back()
        } else {
          // Being on the hub means being on no desk (Plexii P5) — the same
          // setActive(null) every other hub door performs.
          useNodeStore.getState().setActive(null)
          v.goPlexii()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Cmd+/ opens the global shortcuts reference. The document editors bind the
  // same key for their own editor-scoped panel and preventDefault when they
  // handle it, so we only act on unclaimed presses.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === '/' && !e.defaultPrevented) {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Global undo/redo for structural workspace actions (create/delete/move/rename
  // of tasks, folders, widgets). Yields to text fields and the full editors
  // (docs/sheets/slides/files), which keep their own per-character undo.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const el = document.activeElement as HTMLElement | null
      const tag = (el?.tagName ?? '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return
      const v = useViewStore.getState().view
      if (v.kind === 'document' || v.kind === 'livedoc' || v.kind === 'files') return
      const hist = useActionHistory.getState()
      if (e.shiftKey) {
        if (hist.future.length === 0) return
        e.preventDefault()
        void hist.redo()
      } else {
        if (hist.past.length === 0) return
        e.preventDefault()
        void hist.undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // fb:open-assistant is handled by AssistantOverlay itself — any surface can
  // still summon the assistant with the same window event as before.

  function toggleSettings(): void {
    if (settingsOpen) {
      setSettingsOpen(null)
      return
    }
    const rect = settingsBtnRef.current?.getBoundingClientRect()
    if (!rect) return
    setSettingsOpen({ x: rect.right, y: rect.bottom + 6 })
  }

  return (
    <div className="fb-app-shell flex flex-col">
      {/* Reports aggregate usage telemetry while signed in (admin Analytics). */}
      <TelemetryReporter />
      {/* Keeps every desk with a public link up to date. Mounted at the root
          because publishing belongs to the app: it used to run only while the
          share dialog was open, so a "live" desk was frozen the moment you
          closed it. */}
      <LiveDeskPublisherHost />
      {/* First-run "What's new in vX.Y.Z" after an update. */}
      {releaseEntry && (
        <ReleaseModal entry={releaseEntry} onClose={() => setReleaseEntry(null)} />
      )}
      {!shareView && (
      <header
        className={`titlebar-drag fb-glass-chrome h-10 flex items-center justify-between pr-3 border-b border-[color:var(--glass-chrome-border)] transition-colors ${
          isMac ? 'pl-[78px]' : 'pl-3'
        }`}
      >
        <div className="titlebar-nodrag flex items-center gap-2">
          {/* Back/forward through the view history — the true back button. */}
          <HistoryNav />
          {/* "Local · encrypted" — the trust chip. Reflects whether the
              user has set up the vault (and unlocked it). Reinforces the
              BYO-key promise without nagging. Hidden on a fresh install
              with no vault yet to avoid noise. */}
          {vaultMeta?.exists && (
            <div
              className={`hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                vaultUnlocked
                  ? 'bg-emerald-100/70 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-300/50 dark:border-emerald-800/50'
                  : 'bg-stone-100/70 dark:bg-stone-800/70 text-stone-600 dark:text-stone-300 border border-stone-300/50 dark:border-stone-700/50'
              }`}
              title={
                vaultUnlocked
                  ? 'Vault unlocked. Your secrets stay on this device — PlexiDesk never sees them.'
                  : 'Vault is locked. Unlock from the Vault view to use saved credentials.'
              }
            >
              <Icon name={vaultUnlocked ? 'lock_open' : 'lock'} size={10} />
              <span>Local · encrypted</span>
            </div>
          )}
          {/* Account chip — visible when signed in. Click to sign out
              (with confirm). Server-validated session means this chip
              only renders for users with a verified live token. */}
          {account && (
            <button
              onClick={() => {
                const ok = window.confirm(
                  `Sign out of ${account.email}? Your local data stays on this device. Shared items in your inbox will stay until you remove them.`
                )
                if (ok) void signOut()
              }}
              className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-accent/15 dark:bg-accent/15 text-accent border border-accent/30 hover:brightness-110 transition-colors"
              title={`Signed in as ${account.email}. Click to sign out.`}
            >
              <span className="h-3.5 w-3.5 rounded-full bg-accent/30 inline-flex items-center justify-center text-[8px] font-mono text-accent uppercase">
                {personInitials(account).slice(0, 1)}
              </span>
              <span className="max-w-[120px] truncate">
                {personDisplayName(account, account.email.split('@')[0])}
              </span>
            </button>
          )}
        </div>
        <h1 className="select-none flex items-center gap-1.5">
          <PlexiiLogo height={16} />
          <span className="text-[9px] font-mono text-accent px-1 py-px rounded bg-accent/10 border border-accent/20">
            2.0
          </span>
        </h1>
        <div className="titlebar-nodrag flex items-center gap-1">
          {/* The header Build button retired in the Plexii consolidation
              (Caleb's ruling, 2026-08-21): with the sidebar tab, the pill, the
              Home input and ⌘⇧K all opening the one conversational engine, a
              fifth door duplicated chrome. */}
          <Tooltip
            placement="bottom"
            content={
              canSmartStack
                ? `Smart Stack — let AI group your ${unsectionedCount} loose objects into related sections`
                : activeTaskId
                  ? 'Smart Stack needs at least 3 loose objects on the canvas to find groups'
                  : 'Smart Stack — pick a task with objects first'
            }
          >
            <button
              onClick={() => canSmartStack && setSmartStackOpen(true)}
              disabled={!canSmartStack}
              className={`icon-btn ${canSmartStack ? '!text-accent' : ''}`}
              aria-label="Smart Stack"
            >
              <Icon name="hub" size={16} filled={canSmartStack} />
            </button>
          </Tooltip>
          <Tooltip
            placement="bottom"
            content={
              peerStatus === 'idle'
                ? 'Body double — pair with someone to feel less alone while you work'
                : peerStatus === 'looking'
                  ? 'Body double — searching for a partner…'
                  : peerStatus === 'matched'
                    ? 'Body double — partner found, click to greet'
                    : 'Body double — session active, click to open the panel'
            }
          >
            <button
              onClick={() => setBodyDoubleOpen(true)}
              className="icon-btn relative"
              aria-label="Body double"
            >
              <Icon
                name="diversity_3"
                size={16}
                filled={peerStatus !== 'idle'}
                className={peerStatus !== 'idle' ? 'text-accent' : ''}
              />
              {/* Presence dot when a session is active */}
              {peerStatus === 'connected' && (
                <span className="absolute top-1 right-1 inline-flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-70 animate-ping" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                </span>
              )}
              {peerStatus === 'matched' && (
                <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent" />
              )}
            </button>
          </Tooltip>
          <TeamPresenceButton />
          <AttentionBadge />
          <Tooltip content="Search and commands (⌘K)" placement="bottom">
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('fb:open-command-palette'))}
              className="icon-btn"
              aria-label="Search and commands"
              data-testid="topbar-search"
            >
              <Icon name="search" size={16} />
            </button>
          </Tooltip>
          <Tooltip content="Appearance settings — theme, accent colour and font" placement="bottom">
            <button
              ref={settingsBtnRef}
              onClick={toggleSettings}
              className="icon-btn"
              aria-label="Appearance settings"
            >
              <Icon name="settings" size={16} />
            </button>
          </Tooltip>
        </div>
      </header>
      )}
      <main
        className="flex-1 min-h-0 relative flex bg-[var(--surface-base)]"
        style={shareView ? undefined : mainPad}
      >
        {segmentTakeover ? (
          // Grow the segment shell to fill <main> up to the reserved assistant
          // strip, the same wrapper the MainPane branch uses. Without this the
          // shell is a grow-0 flex item that collapses to content width and pins
          // left, leaving dead whitespace on wide screens.
          <div className="flex-1 min-w-0 h-full">
            {currentView.kind === 'office' ? (
              <PlexiOfficeShell initialApp={currentView.app} />
            ) : currentView.kind === 'plexidesk' ? (
              <PlexiDeskShell initialApp={currentView.app} />
            ) : currentView.kind === 'plexipeople' ? (
              <PlexiPeopleShell initialApp={currentView.app ?? 'home'} />
            ) : (
              <PlexiBrainShell initialApp={currentView.app} />
            )}
          </div>
        ) : (
        <>
          {/* The Desk sidebar floats as a rounded card beside the content. The
              dock column reserves its width so dashboard content is never hidden
              behind it, while the inset margin lets the desk surface show around
              the card so it reads as floating above the surface. Minimising it
              collapses the column entirely, giving the content the full width. */}
          {!shareView && (
            <SidebarDock collapsed={sidebarMinimized} onToggle={toggleSidebar} fullBleed={canvasFullBleed} />
          )}
          {/* The assistant no longer lives in a desk-only split here — it is a
              global overlay (AssistantOverlay, mounted below) so it exists on
              every screen. Sidebar mode reserves its width via mainPad above. */}
          <div
            className={canvasFullBleed && !shareView ? 'absolute inset-y-0' : 'flex-1 min-w-0 h-full'}
            style={
              canvasFullBleed && !shareView
                ? { left: mainPad.paddingLeft ?? 0, right: mainPad.paddingRight ?? 0 }
                : undefined
            }
          >
            <MainPane />
          </div>
        </>
        )}
      </main>
      {!shareView && <Footer />}

      <FocusSessionOverlay />
      <CallOverlay />
      <MeetingOverlay />
      <GuestCaptureBar />
      <MeetingLaunchDialog />
      <WrapupOverlay />
      <KnockOverlay />
      <BringMeBack />
      <HyperfocusGuardian />
      <PreTaskBridge />
      <CursorSpotlight />
      <CommandCenter
        onOpenBodyDouble={() => setBodyDoubleOpen(true)}
        onOpenSmartStack={() => canSmartStack && setSmartStackOpen(true)}
        canSmartStack={canSmartStack}
      />
      <FirstRunOnboarding />
      <OnboardingTour />
      <FeatureSpotlightPopup />
      <OnboardingHub />
      <UndoToast />
      <CompletionToast />
      <NoticeToast />
      {/* DEC-075 — yesterday's never-completed blocks greet the launch once. */}
      <MissedTriagePrompt />
      <CaptureConsole />
      <PromptDialogHost />
      <DocHistoryPanelHost />
      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}
      <LaunchSignInModal />
      <UpgradePromptModal />
      <MetricsOverlay />
      {/* The assistant: a pill on every screen, opening into sidebar /
          floating / fullscreen over one conversation. */}
      <AssistantOverlay />
      {/* The universal pin layer (spec §7): a persistent tray of globally pinned
          items, reachable on every surface, droppable onto the current desk. */}
      <PinTray />
      {/* The bottom-center voice bar retired with A3 (R7): voice lives in the
          mascot now — hold the pill or Cmd+Shift+Space (AssistantOverlay). */}
      {smartStackOpen && <SmartStackModal onClose={() => setSmartStackOpen(false)} />}
      <RelatedDesksModal />
      {bodyDoubleOpen && (
        <PeerBodyDoubleDialog onClose={() => setBodyDoubleOpen(false)} />
      )}

      {settingsOpen && (
        <SettingsPanel
          mode={theme.mode}
          accent={theme.accent}
          font={theme.font}
          customAccentHex={theme.customAccentHex}
          customization={theme.customization}
          onModeChange={theme.setMode}
          onAccentChange={theme.setAccent}
          onFontChange={theme.setFont}
          onCustomAccentChange={theme.setCustomAccent}
          onCustomizationChange={theme.setCustomization}
          onResetCustomization={theme.resetCustomization}
          onClose={() => setSettingsOpen(null)}
          anchorX={settingsOpen.x}
          anchorY={settingsOpen.y}
        />
      )}
    </div>
  )
}

// Width of the dock column when the sidebar is collapsed to icon-only strip.
// 58px = 10px left-inset + 38px card + 8px right-inset (FLOATING_MENU_INSET).
const SIDEBAR_COLLAPSED_DOCK_WIDTH = 58

// The dock column that carries the floating Desk sidebar. It reserves the
// sidebar's width so content sits beside the card rather than under it, applies
// the inset margin that detaches the card from the window edges, and hosts the
// drag-to-resize grip on its right edge. When collapsed the dock narrows to an
// icon-only strip; the resize grip hides in that state.
function SidebarDock({
  collapsed,
  onToggle,
  fullBleed = false
}: {
  collapsed: boolean
  onToggle: () => void
  fullBleed?: boolean
}): JSX.Element {
  const { width, onResizeStart, nudge, resizing } = useSidebarWidth()
  const dockRef = useRef<HTMLDivElement>(null)
  // Publish the dock's live width as --fb-dock-inset while the canvas runs
  // beneath it, so left-anchored and centred canvas chrome (breadcrumb, zoom,
  // hint pills) and the edge-pan zone can treat the dock's right edge as the
  // visible left edge. 0px everywhere else. ResizeObserver follows the
  // collapse animation and the drag-to-resize grip.
  useEffect(() => {
    const root = document.documentElement
    if (!fullBleed || !dockRef.current) {
      root.style.setProperty('--fb-dock-inset', '0px')
      useWidgetStore.getState().setDockInset(0)
      return
    }
    const el = dockRef.current
    const publish = (): void => {
      const px = Math.round(el.offsetWidth)
      root.style.setProperty('--fb-dock-inset', `${px}px`)
      useWidgetStore.getState().setDockInset(px)
    }
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.setProperty('--fb-dock-inset', '0px')
      useWidgetStore.getState().setDockInset(0)
    }
  }, [fullBleed])
  return (
    <div
      ref={dockRef}
      className={`relative shrink-0 h-full box-border ${FLOATING_MENU_INSET} transition-[width] duration-200 ${fullBleed ? 'z-10' : ''}`}
      style={{ width: collapsed ? SIDEBAR_COLLAPSED_DOCK_WIDTH : width }}
      data-testid="sidebar-dock"
    >
      <Sidebar collapsed={collapsed} onToggle={onToggle} glass={fullBleed} />
      {!collapsed && (
        <div
          onPointerDown={onResizeStart}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              nudge(-16)
            } else if (e.key === 'ArrowRight') {
              e.preventDefault()
              nudge(16)
            }
          }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the workspace panel"
          aria-valuenow={width}
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          aria-valuetext={`${width} pixels wide`}
          title="Drag to resize the workspace panel"
          tabIndex={0}
          data-testid="sidebar-resize"
          className="group absolute top-0 right-0 h-full w-2.5 flex items-center justify-center cursor-col-resize outline-none touch-none"
        >
          <span
            className={`h-10 w-[3px] rounded-full transition-colors ${
              resizing
                ? 'bg-[rgb(var(--accent))]'
                : 'bg-transparent group-hover:bg-[rgb(var(--accent)/0.5)] group-focus-visible:bg-[rgb(var(--accent))]'
            }`}
          />
        </div>
      )}
    </div>
  )
}
