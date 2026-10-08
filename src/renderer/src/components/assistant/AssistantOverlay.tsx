import { useCallback, useEffect, useRef, useState } from 'react'
import ChatPanel from '../ChatPanel'
import Icon from '../Icon'
import WebPanel from '../browser/WebPanel'
import PlexiiMark from '../brand/PlexiiMark'
import { FLOATING_MENU_INSET_RIGHT, FLOATING_MENU_STYLE } from '../chrome/floatingMenu'
import { useAssistantChrome, type AssistantTab } from '../../stores/assistantChrome'
import { useVoiceHold, useVoiceHoldKeys, startHold, stopHold } from '../../lib/voiceHold'
import AssistantAttentionTab from './tabs/AssistantAttentionTab'
import AssistantMessagesTab from './tabs/AssistantMessagesTab'
import AssistantAgentTab from './tabs/AssistantAgentTab'
import AssistantCalendarTab from './tabs/AssistantCalendarTab'
import AssistantHeader from './AssistantHeader'
import { useChatStore } from '../../stores/chat'
import { useViewStore } from '../../stores/view'
import { useWidgetStore } from '../../stores/widgets'
import { useAssistantWidgetPin } from '../../lib/useAssistantWidgetPin'
import { useSidebarDockInset } from '../../lib/useSidebarDockInset'

// The assistant's global chrome, mirroring Notion's: a persistent pill at the
// bottom-right of EVERY screen, opening into Sidebar / Floating / Fullscreen —
// three containers over one conversation.
//
// Mounted at App level as a fixed overlay, so it survives the segment
// takeovers (office / plexidesk / plexipeople / plexibrain) that replace the
// whole <main> area — which is exactly why the old desk-PanelGroup assistant
// vanished on those screens.
//
// The invariant that matters: ONE ChatPanel instance at ONE stable tree
// position. Switching modes changes only the wrapper's classes, so nothing
// remounts — the conversation (store-held) AND the half-typed composer draft
// (component state) both survive. Closing to the pill is deliberate and does
// unmount; the conversation survives that too, the draft does not.
//
// Geometry facts this leans on: the app header is h-10 (40px), the footer is
// h-7 (28px). The pill and floating card sit above the footer; sidebar mode
// docks between header and footer while App pads <main> by the dock width so
// content is never covered (the meetPad precedent).

// Wrapper classes per mode. z-[120] keeps the assistant above the canvas
// chrome (FloatingToolbar z-45) and below the mic bar (z-150) and dialogs;
// fullscreen at z-[190] takes over everything below CommandCenter (220) and
// prompts (300).
//
// Fullscreen is Notion's AI page, not a modal takeover (3a.4, P6 + approved
// amendment): on normal screens it insets below the header (top-10) and to
// the right of the live-measured desk sidebar dock, so the app's nav stays
// visible AND clickable — navigating re-threads the conversation exactly as
// everywhere else. On segment takeovers there is no dock and the segment owns
// its own nav, so fullscreen stays full-bleed.
const WRAPPER_BY_MODE = {
  sidebar: 'fixed top-10 bottom-7 right-0 z-[120]',
  // A5.5 (AI-39): the floating wrapper IS the rounded card — tab strip and
  // panel clipped inside one radius-card surface with the floating-menu
  // material (Caleb: the old square composite read "very boxy"). ChatPanel
  // drops its own inner card in this mode so no outline sits inside.
  floating:
    'fb-floating-chrome fixed right-[14px] bottom-[42px] z-[120] w-[min(420px,calc(100vw-28px))] h-[min(680px,calc(100vh-96px))] rounded-[var(--radius-card)] overflow-hidden bg-[var(--surface-raised)] text-[var(--ink-100)]'
} as const
const FULLSCREEN_TAKEOVER = 'fixed inset-0 z-[190] bg-[var(--surface-base)]'
const FULLSCREEN_PAGE =
  'fixed top-10 bottom-0 right-0 z-[190] bg-[var(--surface-base)] border-l border-[var(--edge-soft)]'

// The persistent assistant's tabs (spec §5.3, rearranged by DEC-121/122).
// First the conversation, worn as the animated double-ii mark alone (the
// brand's own sign for the AI — one blink on mount, a wink on hover, breathing
// while it thinks); then Attention (every attention item — Tasks folded in),
// Calendar (DEC-131: today's day column, the month at a glance, a day click
// that books), Message (messaging people — the Office Chat tab in the
// panel; "PlexiiMessage" until DEC-131), and Agents (the autonomous agent
// with desk agents as its sub-view). Order matches the store's ASSISTANT_TABS.
const TAB_META: { id: AssistantTab; label: string; icon?: string; mark?: boolean }[] = [
  { id: 'chat', label: 'Plexii AI', mark: true },
  { id: 'attention', label: 'Attention', icon: 'notifications' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar_month' },
  { id: 'messages', label: 'Message', icon: 'chat' },
  { id: 'agent', label: 'Agents', icon: 'rocket_launch' }
]

// The always-mounted web panel (A2, R4): it rides this component because it
// is the one assistant surface App.tsx always renders — the panel must
// exist on every view (the hub included, where the chrome below
// early-returns), so the default export mounts it unconditionally beside
// the chrome. The omnibar routes live in CommandCenter — one door.
export default function AssistantOverlay(): JSX.Element {
  // Hold-to-talk (A3, R7/R17/R18) rides this always-mounted component: the
  // Cmd+Shift+Space chord and the listening/transcribing indicator must work
  // on every screen, panel open or closed.
  useVoiceHoldKeys()
  return (
    <>
      <WebPanel />
      <VoiceHoldIndicator />
      <AssistantOverlayChrome />
    </>
  )
}

// The one voice status surface: a chip above the mascot's corner while a
// capture is live or a transcript is forming, and the error, when there is
// one, as a dismissible chip in the same spot. Replaces the retired
// bottom-center bar's overlay; motion is earned (listening is state).
function VoiceHoldIndicator(): JSX.Element | null {
  const phase = useVoiceHold((s) => s.phase)
  const error = useVoiceHold((s) => s.error)
  const clearError = useVoiceHold((s) => s.clearError)
  if (phase === 'idle' && !error) return null
  return (
    <div
      className="fixed right-[14px] bottom-[92px] z-[150] flex flex-col items-end gap-1.5"
      data-testid="voice-hold-indicator"
    >
      {phase !== 'idle' && (
        <div className="fb-glass-chrome border rounded-full pl-2.5 pr-3 py-1.5 flex items-center gap-2 shadow-[var(--shadow-soft)]">
          {phase === 'listening' ? (
            <>
              <span className="relative inline-flex h-2 w-2" aria-hidden>
                <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-70 motion-safe:animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
              <span className="text-[12px] text-[var(--ink-90)]">Listening — release to review</span>
            </>
          ) : (
            <>
              <Icon name="mic" size={13} className="text-[var(--ink-60)]" />
              <span className="text-[12px] text-[var(--ink-70)]">Transcribing…</span>
            </>
          )}
        </div>
      )}
      {error && (
        <button
          type="button"
          onClick={clearError}
          title="Dismiss"
          data-testid="voice-hold-error"
          className="fb-glass-chrome border rounded-[var(--radius-row)] px-3 py-1.5 max-w-[300px] text-left text-[12px] text-[var(--ink-90)]"
        >
          {error}
        </button>
      )}
    </div>
  )
}

function AssistantOverlayChrome(): JSX.Element {
  const open = useAssistantChrome((s) => s.open)
  const mode = useAssistantChrome((s) => s.mode)
  const width = useAssistantChrome((s) => s.width)
  const activeTab = useAssistantChrome((s) => s.activeTab)
  const setTab = useAssistantChrome((s) => s.setTab)
  const openPanel = useAssistantChrome((s) => s.openPanel)
  const setWidth = useAssistantChrome((s) => s.setWidth)
  const persistWidth = useAssistantChrome((s) => s.persistWidth)
  // The pill pulses while a request is genuinely in flight — the one honest
  // "something is happening" signal we have. No invented unread badges.
  const sending = useChatStore((s) => s.sending)
  // Hold-to-talk gesture state for the pill (A3, R7): a 250ms press
  // threshold separates a click (open the panel) from a hold (listen);
  // pillJustHeldRef swallows the click event a hold-release still fires.
  const voicePhase = useVoiceHold((s) => s.phase)
  const pillHoldTimer = useRef<number | null>(null)
  const pillHeldRef = useRef(false)
  const pillJustHeldRef = useRef(false)
  // Personality moments (AI-18, Caleb's four picks): a moment replays ONE
  // blink cycle by remounting the mark (mount = one cycle, then frozen — the
  // brand machine's own law). Guarded by the collision law: no moment while
  // an answer is in flight (breathe) or a capture is live (ring). The boot
  // greeting is the standing mount blink itself — the pill mounts once per
  // boot, so no extra wiring exists for it, by design.
  const [momentToken, setMomentToken] = useState(0)
  const playMoment = useCallback((): void => {
    if (useChatStore.getState().sending) return
    if (useVoiceHold.getState().phase !== 'idle') return
    setMomentToken((t) => t + 1)
  }, [])
  // Heard-you: voiceHold announces a landed transcript (dictation or staging).
  useEffect(() => {
    window.addEventListener('fb:plexii-moment', playMoment)
    return () => window.removeEventListener('fb:plexii-moment', playMoment)
  }, [playMoment])
  // Done blink: the sending edge falling — a long task just finished; one
  // contented blink as the ping dot leaves.
  const prevSending = useRef(sending)
  useEffect(() => {
    if (prevSending.current && !sending) playMoment()
    prevSending.current = sending
  }, [sending, playMoment])
  // Click-to-pin lifecycle (3a.1): watches the widget-activation signal and
  // the pin's clearing conditions. Lives here because this component never
  // unmounts, so the rules keep running even while the panel is closed.
  useAssistantWidgetPin()
  // Focus-mode suppression (3a.2, P4): while focus mode is genuinely showing,
  // its AI Chat tab IS the assistant — pill and panel both disappear. Keyed on
  // focus mode actually rendering (desk-type view + focusedWidgetId — the
  // predicate assistantContext uses), NOT on the raw store field: a stale
  // focusedWidgetId left behind by navigating away must not hide the pill on
  // other screens. Chrome state (open/mode/width) is deliberately untouched,
  // so exiting focus mode restores the assistant exactly as it was.
  const view = useViewStore((s) => s.view)
  const focusedWidgetId = useWidgetStore((s) => s.focusedWidgetId)
  const focusModeShowing =
    (view.kind === 'task' || view.kind === 'project-dashboard') && focusedWidgetId !== null
  // Plexii-hub suppression: while the hub page is showing, the page IS the
  // assistant (same rule as focus mode). Pill and panel both disappear so the
  // ONE-ChatPanel invariant holds; chrome state is untouched, so leaving the
  // hub restores the overlay exactly as it was.
  const hubShowing = view.kind === 'plexii'
  // Fullscreen-as-a-page geometry (3a.4): the same four takeover kinds App
  // uses. The dock inset is measured live so sidebar resizes and the minimised
  // 58px strip track truthfully.
  const segmentTakeover =
    view.kind === 'office' ||
    view.kind === 'plexidesk' ||
    view.kind === 'plexipeople' ||
    view.kind === 'plexibrain'
  const dockInset = useSidebarDockInset(open && mode === 'fullscreen' && !segmentTakeover)

  // Any surface can summon the assistant without prop-threading — the same
  // window event the empty-desk hint and the mindmap starting kit already
  // dispatch. It used to expand the desk panel; now it opens the overlay in
  // whichever mode was last used.
  useEffect(() => {
    function onOpen(): void {
      openPanel()
    }
    window.addEventListener('fb:open-assistant', onOpen)
    return () => window.removeEventListener('fb:open-assistant', onOpen)
  }, [openPanel])

  // Sidebar-mode resize — the same pointer-capture drag the desk sidebar uses
  // (chrome/floatingMenu useSidebarWidth), mirrored for a right-docked column:
  // dragging LEFT widens. Width persists when the drag settles.
  const [resizing, setResizing] = useState(false)
  const startX = useRef(0)
  const startW = useRef(0)
  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      startX.current = e.clientX
      startW.current = width
      setResizing(true)
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* falls back to the window listeners below */
      }
    },
    [width]
  )
  useEffect(() => {
    if (!resizing) return
    function onMove(e: PointerEvent): void {
      setWidth(startW.current + (startX.current - e.clientX))
    }
    function onUp(): void {
      setResizing(false)
      persistWidth()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [resizing, setWidth, persistWidth])

  if (focusModeShowing || hubShowing) return <></>

  if (!open) {
    return (
      <button
        type="button"
        // Hold-to-talk (A3, R7): press and hold the mascot to speak; release
        // stages the transcript in the composer (R17). A plain click still
        // opens the panel. The pointerdown preventDefault keeps focus where
        // it is, so dictation can capture the editable the user was in.
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          pillHeldRef.current = false
          pillHoldTimer.current = window.setTimeout(() => {
            pillHeldRef.current = true
            void startHold()
          }, 250)
        }}
        onPointerUp={() => {
          if (pillHoldTimer.current !== null) {
            window.clearTimeout(pillHoldTimer.current)
            pillHoldTimer.current = null
          }
          if (pillHeldRef.current) {
            pillHeldRef.current = false
            pillJustHeldRef.current = true
            window.setTimeout(() => {
              pillJustHeldRef.current = false
            }, 250)
            void stopHold()
          }
        }}
        onPointerLeave={() => {
          if (pillHoldTimer.current !== null) {
            window.clearTimeout(pillHoldTimer.current)
            pillHoldTimer.current = null
          }
          // Released (or dragged) off the pill mid-hold: still stage — the
          // words were spoken; losing them to a 2px slide would be cruel.
          if (pillHeldRef.current) {
            pillHeldRef.current = false
            pillJustHeldRef.current = true
            window.setTimeout(() => {
              pillJustHeldRef.current = false
            }, 250)
            void stopHold()
          }
        }}
        onClick={() => {
          // A click that was really a hold-release already staged; swallow it.
          if (pillJustHeldRef.current) return
          openPanel()
        }}
        title="Plexii — click to open, hold to talk"
        aria-label="Open Plexii (hold to talk)"
        data-testid="assistant-pill"
        className="fb-assistant-pill fixed right-[14px] z-[120] h-[52px] w-[52px] rounded-full grid place-items-center text-white transition-all duration-200 motion-safe:hover:-translate-y-[2px] motion-safe:active:translate-y-0"
        style={{
          // Clear of the open-item tray. The tray publishes a FINISHED offset
          // (see OpenTray) rather than a height, because the root carries a
          // user UI scale and mixing an authored px with a measured one
          // silently resolves wrong. 42px is the no-tray case and clears the
          // footer on its own.
          bottom: 'var(--fb-pill-bottom, 42px)'
        }}
      >
        {/* Brand motion Phase 1 + AI-18: the pill wears the ii mark — one
            blink on mount (the boot greeting), a wink on hover, and one
            replayed cycle per personality moment (the key remount). The
            hover lift above is the "hover play" pick — a 2px rise, gone
            under reduced motion. Collision law: blink = alive, breathe =
            thinking, never both on one surface, so while an answer is in
            flight (the ping dot below) OR a capture is live (the ring), the
            mark holds still. Decorative (title null): the button's
            aria-label already names it. */}
        {/* The halo that makes this findable lives in CSS (.fb-assistant-pill
            ::after) so it animates on the compositor instead of repainting
            this subtree every frame. Collision law still holds: the halo is
            chrome, and the MARK holds still whenever something is actually in
            flight (sending, or a live capture). */}
        <PlexiiMark
          key={`moment-${momentToken}`}
          height={24}
          // `color` drives the ii; `letterColor` only drives the LETTERFORMS and
          // is ignored by the icon variant, which is what this is. That is why
          // the mark stayed accent-coloured on the purple disc after being told
          // to be white.
          color="#FFFFFF"
          motion={sending || voicePhase !== 'idle' ? 'off' : 'once+hover'}
          title={null}
        />
        {/* The listening ring (R7): a live arc around the mascot while the
            mic is open — state, never decoration; static under reduced
            motion (the arc still shows, it just doesn't sweep). */}
        {voicePhase === 'listening' && (
          <svg
            className="absolute inset-[-4px] motion-safe:animate-spin text-accent pointer-events-none"
            viewBox="0 0 48 48"
            fill="none"
            aria-hidden
            data-testid="assistant-pill-ring"
          >
            <circle cx="24" cy="24" r="22" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
            <path d="M24 2 a22 22 0 0 1 22 22" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        )}
        {sending && (
          <span className="absolute -top-0.5 -right-0.5 inline-flex h-2 w-2" aria-label="working">
            <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-70 animate-ping" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
        )}
      </button>
    )
  }

  return (
    <div
      className={
        mode === 'fullscreen'
          ? segmentTakeover
            ? FULLSCREEN_TAKEOVER
            : FULLSCREEN_PAGE
          : WRAPPER_BY_MODE[mode]
      }
      style={
        mode === 'sidebar'
          ? { width }
          : mode === 'fullscreen' && !segmentTakeover
            ? { left: dockInset }
            : mode === 'floating'
              ? FLOATING_MENU_STYLE
              : undefined
      }
      data-testid="assistant-overlay"
      data-mode={mode}
    >
      {/* Sidebar-mode resize grip on the dock's left edge — the same
          affordance as the desk sidebar's, mirrored. */}
      {mode === 'sidebar' && (
        <div
          onPointerDown={onResizeStart}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              setWidth(width + 16)
              persistWidth()
            } else if (e.key === 'ArrowRight') {
              e.preventDefault()
              setWidth(width - 16)
              persistWidth()
            }
          }}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Plexii"
          title="Drag to resize Plexii"
          tabIndex={0}
          data-testid="assistant-resize"
          className="group absolute top-0 left-0 h-full w-2.5 -translate-x-1 z-10 flex items-center justify-center cursor-col-resize outline-none touch-none"
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
      {/* One panel, three dressings — deliberately ONE element whose classes
          change, never a branch per mode: a per-mode branch would remount
          ChatPanel on every switch and eat the half-typed draft. In sidebar
          mode the inset column detaches the card from the window edge exactly
          as the old desk column did; in floating mode the wrapper IS the
          card's footprint; in fullscreen the panel IS the page — full-bleed,
          no inset box (ChatPanel drops its card chrome there and centers its
          own content columns). */}
      {/* Tabbed shell (spec §5): a tab strip over the content area. The Chat tab
          renders the EXISTING ChatPanel, which stays permanently mounted (hidden,
          never unmounted) so its half-typed draft + TipTap editor survive a tab
          switch — the same invariant the mode switch already relies on. The other
          tabs are cheap + stateless, so they mount/unmount freely. */}
      <div
        className={
          mode === 'sidebar'
            ? `h-full box-border ${FLOATING_MENU_INSET_RIGHT} flex flex-col`
            : 'h-full w-full flex flex-col'
        }
      >
        {/* The header FIRST (operator direction): the sidebar's wordmark and,
            from the right, Minimize · Display mode · What was I doing? · New
            chat. The tab strip sits under it on every tab. */}
        <AssistantHeader chrome />
        <div
          role="tablist"
          aria-label="Plexii sections"
          data-testid="assistant-tabs"
          className="shrink-0 flex items-center gap-0.5 px-1.5 py-1 border-b border-[var(--edge-soft)] bg-[var(--surface-raised)]"
        >
          {TAB_META.map((t) => {
            const isActive = activeTab === t.id
            return (
              <button
                key={t.id}
                role="tab"
                  id={`assistant-tab-${t.id}`}
                  // The tab strip had no panel to point at, so assistive
                  // technology saw the tabs and never their contents.
                  aria-controls="assistant-tabpanel"
                  tabIndex={isActive ? 0 : -1}
                aria-selected={isActive}
                onClick={() => setTab(t.id)}
                data-testid={`assistant-tab-${t.id}`}
                title={t.label}
                aria-label={t.label}
                className={`flex-1 min-w-0 inline-flex items-center justify-center gap-1 h-7 rounded-md text-[11px] font-medium transition-colors ${
                  isActive
                    ? 'bg-accent/10 text-[rgb(var(--accent))]'
                    : 'text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                {t.mark ? (
                  /* The mark IS the label: the brand's sign for the AI, animated
                     the brand way — and breathing while a reply is in flight. */
                  <PlexiiMark height={16} motion={'once+hover'} title={null} className="shrink-0" />
                ) : (
                  <>
                    <Icon name={t.icon!} size={14} className="shrink-0" />
                    <span className="truncate">{t.label}</span>
                  </>
                )}
              </button>
            )
          })}
        </div>
        {/* Opaque surface so the non-Chat tabs (Today/Agent/Tasks/Activity/Work)
            are never see-through — the Chat tab supplies its own card. Fullscreen
            uses the wrapper's own base surface. */}
        <div
          role="tabpanel"
          id="assistant-tabpanel"
          aria-labelledby={`assistant-tab-${activeTab}`}
          className={`flex-1 min-h-0 relative ${mode !== 'fullscreen' ? 'bg-[var(--surface-raised)]' : ''}`}
        >
          {/* Chat: always mounted, shown only on the Chat tab. */}
          <div className="h-full w-full" style={{ display: activeTab === 'chat' ? 'block' : 'none' }}>
            <ChatPanel />
          </div>
          {activeTab === 'attention' && <AssistantAttentionTab />}
          {activeTab === 'calendar' && <AssistantCalendarTab />}
          {activeTab === 'agent' && <AssistantAgentTab />}
          {activeTab === 'messages' && <AssistantMessagesTab />}
        </div>
      </div>
    </div>
  )
}
