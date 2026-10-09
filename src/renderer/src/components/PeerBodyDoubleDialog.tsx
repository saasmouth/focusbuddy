import { useEffect, useRef, useState } from 'react'
import {
  MODE_META,
  MODE_ORDER,
  getDefaultBodyDoubleMode,
  setDefaultBodyDoubleMode
} from '../lib/bodyDoubleModes'
import { createPortal } from 'react-dom'
import type { BodyDoubleMode } from '@shared/types'
import { usePeerBodyDoubleStore } from '../stores/peerBodyDouble'
import { useMeetingRoomStore } from '../stores/meetingRoom'
import { useAccountStore } from '../stores/account'
import { useSignInPrompt } from '../stores/signInPrompt'
import { useEntitlement } from '../lib/entitlementReason'
import { bodyDoubleMedia } from '../lib/bodyDoubleMedia'
import { signalConfig } from '../lib/signalConfig'
import Icon from './Icon'

// Peer body double — the whole user journey lives in this one dialog:
//   idle      → preference picker (mode + workingOn) + "Find a partner"
//   looking   → "Searching…" with cancel
//   matched   → partner intro card + "Start session" / "Skip"
//   connected → the session: where the video is, chat (mode permitting),
//               End and Block
//
// Starting the session opens the pair's private PlexiiMeet room, docked to
// the side of the screen by the meeting overlay, so the person keeps working
// with their partner in view. This dialog is the session's control panel; the
// video lives in the room.
//
// The dialog stays mounted across status changes so the chat history survives
// the matched→connected transition. Closing it without explicitly ending only
// HIDES it — the session keeps running. The same header button reopens it.

interface Props {
  onClose: () => void
}


// Minimum duration to hold the "Looking…" UI even when the matcher finds a
// partner instantly, so a real match never flashes past unread and both sides
// arrive at the intro card together. It only paces the display; the match
// itself is real and already in the store.
const MIN_LOOKING_MS = 3000

// MODE_META now lives in lib/bodyDoubleModes (Settings and the onboarding
// module need it too). Re-exported so this remains its historical home.
export { MODE_META }


export default function PeerBodyDoubleDialog({ onClose }: Props): JSX.Element {
  const status = usePeerBodyDoubleStore((s) => s.status)
  const mode = usePeerBodyDoubleStore((s) => s.mode)
  const workingOn = usePeerBodyDoubleStore((s) => s.workingOn)
  const myHandle = usePeerBodyDoubleStore((s) => s.myHandle)
  const partner = usePeerBodyDoubleStore((s) => s.partner)
  const meetingRoomId = usePeerBodyDoubleStore((s) => s.meetingRoomId)
  const videoIssue = usePeerBodyDoubleStore((s) => s.videoIssue)
  const chat = usePeerBodyDoubleStore((s) => s.chat)
  const toast = usePeerBodyDoubleStore((s) => s.toast)
  const error = usePeerBodyDoubleStore((s) => s.error)
  const startLooking = usePeerBodyDoubleStore((s) => s.startLooking)
  const cancelLooking = usePeerBodyDoubleStore((s) => s.cancelLooking)
  const enterConnected = usePeerBodyDoubleStore((s) => s.enterConnected)
  const retryVideo = usePeerBodyDoubleStore((s) => s.retryVideo)
  const sendChat = usePeerBodyDoubleStore((s) => s.sendChat)
  const endSession = usePeerBodyDoubleStore((s) => s.endSession)
  const blockPartner = usePeerBodyDoubleStore((s) => s.blockPartner)
  const dismissToast = usePeerBodyDoubleStore((s) => s.dismissToast)
  const dismissError = usePeerBodyDoubleStore((s) => s.dismissError)

  const meetingRoom = useMeetingRoomStore((s) => s.roomId)
  const meetingStatus = useMeetingRoomStore((s) => s.status)
  const meetingLayout = useMeetingRoomStore((s) => s.layout)
  const setMeetingLayout = useMeetingRoomStore((s) => s.setLayout)

  const signedIn = useAccountStore((s) => !!s.sessionToken)
  const requestSignIn = useSignInPrompt((s) => s.requestOpen)
  const entitlement = useEntitlement('body_double', 'Body double')
  // The dev mock has no server, accounts or plans; everything else needs both.
  const needsSignIn = signalConfig.useRemote && !signedIn
  const needsPlan = signalConfig.useRemote && signedIn && !entitlement.enabled

  // Preference picker local state — kept here (not in the store) so the
  // picker resets on each new request.
  // Seeded from the saved default (Settings › Account › Body double) rather
  // than hard-coded: picking a mode here also saves it as the default, so
  // the next session starts where this one left off.
  const [pickedMode, setPickedMode] = useState<BodyDoubleMode>(getDefaultBodyDoubleMode)
  const [workingOnDraft, setWorkingOnDraft] = useState('')
  const [chatDraft, setChatDraft] = useState('')
  const chatScrollRef = useRef<HTMLDivElement | null>(null)

  // "Hold looking" floor — see MIN_LOOKING_MS. effectiveStatus is what the
  // body switches on; the store status keeps moving so chat events and partner
  // data are ready by the time the floor elapses.
  const lookingStartedAtRef = useRef<number | null>(null)
  const [floorPassed, setFloorPassed] = useState(true)
  useEffect(() => {
    if (status === 'looking') {
      lookingStartedAtRef.current = Date.now()
      setFloorPassed(false)
    } else if (
      (status === 'matched' || status === 'connected') &&
      lookingStartedAtRef.current !== null
    ) {
      const elapsed = Date.now() - lookingStartedAtRef.current
      const remaining = Math.max(0, MIN_LOOKING_MS - elapsed)
      const t = window.setTimeout(() => setFloorPassed(true), remaining)
      return () => window.clearTimeout(t)
    } else if (status === 'idle') {
      lookingStartedAtRef.current = null
      setFloorPassed(true)
    }
    return undefined
  }, [status])

  const effectiveStatus =
    status === 'matched' || status === 'connected'
      ? floorPassed
        ? status
        : 'looking'
      : status

  // Auto-scroll the chat to the latest message — but only when already at
  // the bottom (so reviewing earlier messages while a new one arrives
  // doesn't yank you down).
  useEffect(() => {
    const el = chatScrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (atBottom) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [chat.length])

  // Esc closes the dialog (without ending the session if one is active).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const chatAllowed = mode ? bodyDoubleMedia(mode).chat : false
  const inVideo = !!meetingRoomId && meetingRoom === meetingRoomId
  const videoOpening = inVideo && meetingStatus === 'joining'

  const submitChat = (): void => {
    if (!chatDraft.trim()) return
    sendChat(chatDraft)
    setChatDraft('')
  }

  return createPortal(
    <div
      className="fb-scrim fixed inset-0 z-[260] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="fb-card w-[460px] max-h-[80vh] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="body-double-dialog"
      >
        {/* Header — stays consistent across all phases */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--edge-soft)]">
          <div className="h-8 w-8 rounded-full bg-accent/10 inline-flex items-center justify-center">
            <Icon name="diversity_3" size={18} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--ink-100)]">
              Body double
            </h2>
            <p className="text-[11px] text-[var(--ink-50)] leading-tight">
              {effectiveStatus === 'idle' && 'Work alongside someone, matched at random'}
              {effectiveStatus === 'looking' && 'Looking for someone who picked the same…'}
              {effectiveStatus === 'matched' && 'You\'re matched — say hello'}
              {effectiveStatus === 'connected' && (mode ? MODE_META[mode].label : 'Connected')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 rounded inline-flex items-center justify-center text-[var(--ink-40)] hover:bg-[var(--surface-sunken)]"
            aria-label="Close panel"
            title={effectiveStatus === 'connected' ? 'Hide panel — session keeps running' : 'Close'}
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* Body switches by status */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {toast && (
            <div className="m-3 p-2 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-[12px] text-amber-800 dark:text-amber-300 flex items-start gap-2" data-testid="body-double-toast">
              <Icon name="info" size={13} className="mt-0.5 shrink-0" />
              <span className="flex-1">{toast}</span>
              <button onClick={dismissToast} aria-label="Dismiss" className="text-amber-700 hover:text-amber-900">
                <Icon name="close" size={11} />
              </button>
            </div>
          )}

          {error && effectiveStatus === 'idle' && (
            <div className="m-3 p-2 rounded-md bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-[12px] text-rose-800 dark:text-rose-300 flex items-start gap-2" data-testid="body-double-error" data-code={error.code}>
              <Icon name="error" size={13} className="mt-0.5 shrink-0" />
              <span className="flex-1">{error.message}</span>
              {error.code === 'bd_sign_in' && (
                <button onClick={requestSignIn} className="font-medium underline underline-offset-2">
                  Sign in
                </button>
              )}
              {error.code === 'bd_not_entitled' && (
                <button onClick={entitlement.onLockedClick} className="font-medium underline underline-offset-2">
                  See plans
                </button>
              )}
              <button onClick={dismissError} aria-label="Dismiss" className="text-rose-700 hover:text-rose-900">
                <Icon name="close" size={11} />
              </button>
            </div>
          )}

          {/* ── IDLE: mode picker ───────────────────────────────────── */}
          {effectiveStatus === 'idle' && (
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-50)] mb-1.5">
                  How much interaction would you like?
                </label>
                <div className="space-y-1.5" role="radiogroup" aria-label="Interaction mode">
                  {MODE_ORDER.map((m) => {
                    const meta = MODE_META[m]
                    const active = pickedMode === m
                    return (
                      <button
                        key={m}
                        role="radio"
                        aria-checked={active}
                        data-testid={`body-double-mode-${m}`}
                        onClick={() => {
                          setPickedMode(m)
                          // Choosing here is also the answer to "how do I
                          // usually want to pair", so it becomes the default.
                          setDefaultBodyDoubleMode(m)
                        }}
                        className={`w-full text-left p-2.5 rounded-md border-2 flex items-start gap-2.5 transition-colors ${
                          active
                            ? 'border-accent bg-accent/[0.06]'
                            : 'border-[var(--edge-soft)] hover:border-[var(--edge-firm)]'
                        }`}
                      >
                        <Icon
                          name={meta.icon}
                          size={16}
                          className={active ? 'text-accent mt-0.5 shrink-0' : 'text-[var(--ink-40)] mt-0.5 shrink-0'}
                        />
                        <div className="flex-1 min-w-0">
                          <div className={`text-[13px] font-medium ${active ? 'text-accent' : 'text-[var(--ink-90)]'}`}>
                            {meta.label}
                          </div>
                          <div className="text-[11px] text-[var(--ink-50)] leading-snug">
                            {meta.tagline}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
                <p className="text-[10.5px] text-[var(--ink-50)] mt-1.5">
                  You are matched only with someone who picked the same option.
                </p>
              </div>

              {pickedMode !== 'silent' && (
                <div>
                  <label className="block text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-50)] mb-1.5">
                    What are you working on?{' '}
                    <span className="text-[var(--ink-40)] normal-case font-normal">(shared with your partner — optional)</span>
                  </label>
                  <input
                    value={workingOnDraft}
                    onChange={(e) => setWorkingOnDraft(e.target.value)}
                    placeholder="e.g. drafting Q3 brief, deep work on a paper, inbox triage"
                    className="fb-field w-full text-[13px] px-2.5 py-1.5"
                    maxLength={80}
                  />
                </div>
              )}

              <div className="text-[10px] text-[var(--ink-50)] leading-relaxed bg-[var(--surface-sunken)] p-2 rounded">
                <strong className="text-[var(--ink-70)]">Privacy:</strong>{' '}
                {signalConfig.useRemote ? (
                  <>
                    You will be matched with someone you do not know. You see each other on camera in a private
                    PlexiiMeet room that only the two of you can join, and you can turn your camera off at any time.
                    They see a made-up session name like QuietCedar34, never your name or email. Nothing is
                    recorded. End the session whenever you like, or block someone so you are never matched again.
                  </>
                ) : (
                  <>
                    Development mode: matching is local to this machine (two PlexiDesk windows), text only, with
                    no video room.
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── LOOKING: searching state ────────────────────────────── */}
          {effectiveStatus === 'looking' && (
            <div className="p-6 flex flex-col items-center text-center gap-3">
              <div className="relative">
                <div className="h-16 w-16 rounded-full bg-accent/10 inline-flex items-center justify-center">
                  <Icon name="diversity_3" size={28} className="text-accent" />
                </div>
                <div className="absolute inset-0 rounded-full border-2 border-accent/40 animate-ping" />
              </div>
              <div className="space-y-1">
                <div className="text-[14px] font-medium text-[var(--ink-90)]">
                  Looking for someone who picked {mode ? `“${MODE_META[mode].label}”` : 'the same'}…
                </div>
                <div className="text-[11px] text-[var(--ink-50)]">
                  You're <span className="font-mono text-accent">{myHandle}</span>{' '}
                  while you wait
                </div>
              </div>
              {workingOn && (
                <div className="text-[11px] text-[var(--ink-70)] italic max-w-[280px]">
                  "{workingOn}"
                </div>
              )}
              <button
                onClick={() => void cancelLooking()}
                className="mt-3 text-[12px] px-3 py-1.5 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
              >
                Cancel
              </button>
            </div>
          )}

          {/* ── MATCHED: partner intro ──────────────────────────────── */}
          {effectiveStatus === 'matched' && partner && (
            <div className="p-6 flex flex-col items-center text-center gap-3">
              <div className="h-12 w-12 rounded-full bg-emerald-100 dark:bg-emerald-950/30 inline-flex items-center justify-center">
                <Icon name="handshake" size={22} className="text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="space-y-1">
                <div className="text-[13px] text-[var(--ink-50)]">
                  Say hello to
                </div>
                <div className="text-[18px] font-semibold text-[var(--ink-100)] font-mono" data-testid="body-double-partner">
                  {partner.handle}
                </div>
              </div>
              {partner.workingOn && (
                <div className="bg-[var(--surface-sunken)] rounded-md px-3 py-2 text-[12px] text-[var(--ink-70)] max-w-[320px]">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--ink-50)] block mb-0.5">
                    Working on
                  </span>
                  {partner.workingOn}
                </div>
              )}
              <div className="text-[11px] text-[var(--ink-50)] max-w-[320px] leading-snug">
                You both picked{' '}
                <strong className="text-[var(--ink-70)]">{mode ? MODE_META[mode].label : '…'}</strong>.{' '}
                {meetingRoomId
                  ? 'Starting opens your camera in a private room, docked to the side of your screen.'
                  : 'This session is text only.'}
              </div>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => void endSession()}
                  className="text-[12px] px-3 py-1.5 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                >
                  Skip
                </button>
                <button
                  onClick={() => void enterConnected()}
                  data-testid="body-double-start"
                  className="text-[12px] px-4 py-1.5 rounded bg-accent text-white hover:brightness-110 font-medium"
                >
                  Start session
                </button>
              </div>
            </div>
          )}

          {/* ── CONNECTED: active session ───────────────────────────── */}
          {effectiveStatus === 'connected' && partner && (
            <div className="flex flex-col h-full">
              {/* Where the video is. The room itself is the meeting overlay;
                  this says honestly what state it is in. */}
              <div className="px-3 py-2.5 border-b border-[var(--edge-soft)] flex items-center gap-2.5" data-testid="body-double-video-state">
                <Icon
                  name={inVideo ? 'videocam' : 'videocam_off'}
                  size={16}
                  className={inVideo ? 'text-emerald-600 dark:text-emerald-400 shrink-0' : 'text-[var(--ink-40)] shrink-0'}
                />
                <div className="flex-1 min-w-0 text-[11.5px] text-[var(--ink-70)] leading-snug">
                  {!meetingRoomId && 'Text-only session: this pairing has no video room.'}
                  {meetingRoomId && videoOpening && 'Opening your camera…'}
                  {meetingRoomId && inVideo && !videoOpening && 'You are on camera together. The video is docked at the side of your screen.'}
                  {meetingRoomId && !inVideo && videoIssue}
                  {meetingRoomId && !inVideo && !videoIssue && 'The video is closed. The session continues.'}
                </div>
                {meetingRoomId && inVideo && !videoOpening && (
                  <button
                    onClick={() => setMeetingLayout(meetingLayout === 'stage' ? 'collaborate' : 'stage')}
                    className="text-[11px] px-2 py-1 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] shrink-0"
                  >
                    {meetingLayout === 'stage' ? 'Dock video' : 'Full screen'}
                  </button>
                )}
                {meetingRoomId && !inVideo && (
                  <button
                    onClick={() => void retryVideo()}
                    data-testid="body-double-retry-video"
                    className="text-[11px] px-2 py-1 rounded text-accent hover:bg-accent/10 shrink-0"
                  >
                    {videoIssue ? 'Try again' : 'Reopen video'}
                  </button>
                )}
              </div>

              {/* Partner strip */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--edge-soft)]">
                <span className="relative inline-flex items-center justify-center h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium text-[var(--ink-90)] font-mono truncate">
                    {partner.handle}
                  </div>
                  {partner.workingOn && (
                    <div className="text-[10px] text-[var(--ink-50)] truncate italic">
                      {partner.workingOn}
                    </div>
                  )}
                </div>
                {meetingRoomId && (
                  <button
                    onClick={() => void blockPartner()}
                    title="End the session and never be matched with them again"
                    data-testid="body-double-block"
                    className="text-[11px] px-2 py-1 rounded text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]"
                  >
                    Block
                  </button>
                )}
                <button
                  onClick={() => void endSession()}
                  data-testid="body-double-end"
                  className="text-[11px] px-2 py-1 rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                >
                  End session
                </button>
              </div>

              {chatAllowed ? (
                <>
                  <div
                    ref={chatScrollRef}
                    className="flex-1 min-h-[200px] max-h-[40vh] overflow-y-auto px-3 py-2 space-y-1.5"
                  >
                    {chat.length === 0 && (
                      <div className="text-center text-[11px] text-[var(--ink-40)] py-4">
                        {mode === 'greetings' ? 'Say hi and what you are working on.' : 'Say hi to break the ice.'}
                      </div>
                    )}
                    {chat.map((m) => {
                      const mine = m.senderHandle === myHandle
                      return (
                        <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                          <div
                            className={`max-w-[75%] px-2.5 py-1.5 rounded-lg text-[12px] ${
                              mine ? 'bg-accent text-white' : 'bg-[var(--surface-sunken)] text-[var(--ink-90)]'
                            }`}
                          >
                            {!mine && (
                              <div className="text-[9px] uppercase tracking-wider opacity-70 mb-0.5 font-mono">
                                {m.senderHandle}
                              </div>
                            )}
                            <div className="whitespace-pre-wrap leading-snug">{m.text}</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="border-t border-[var(--edge-soft)] p-2 flex gap-2">
                    <input
                      value={chatDraft}
                      onChange={(e) => setChatDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          submitChat()
                        }
                      }}
                      placeholder={mode === 'greetings' ? 'Say hi + share what you\'re working on…' : 'Send a message…'}
                      maxLength={1000}
                      className="fb-field flex-1 text-[12px] px-2.5 py-1.5"
                    />
                    <button
                      onClick={submitChat}
                      disabled={!chatDraft.trim()}
                      className="text-[12px] px-3 py-1.5 rounded bg-accent text-white hover:brightness-110 disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      <Icon name="send" size={11} />
                      Send
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center gap-2 py-10 px-6 text-center">
                  <Icon name="volume_off" size={28} className="text-[var(--ink-30)]" />
                  <div className="text-[13px] text-[var(--ink-70)] font-medium">
                    You're not alone.
                  </div>
                  <div className="text-[11px] text-[var(--ink-50)] max-w-[280px]">
                    Silent session: no microphone and no chat. Close this panel and get to work. Your partner
                    is working right there beside you.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer — only on idle */}
        {effectiveStatus === 'idle' && (
          <div className="px-4 py-3 border-t border-[var(--edge-soft)] flex items-center justify-end gap-2">
            {needsPlan && (
              <span className="flex-1 text-[10.5px] text-[var(--ink-50)] leading-snug">{entitlement.reason}</span>
            )}
            <button
              onClick={onClose}
              className="text-[12px] px-3 py-1.5 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
            >
              Cancel
            </button>
            {needsSignIn ? (
              <button
                onClick={requestSignIn}
                className="text-[12px] px-4 py-1.5 rounded bg-accent text-white hover:brightness-110 font-medium inline-flex items-center gap-1.5"
              >
                <Icon name="login" size={12} />
                Sign in to find a partner
              </button>
            ) : needsPlan ? (
              <button
                onClick={entitlement.onLockedClick}
                className="text-[12px] px-4 py-1.5 rounded bg-accent text-white hover:brightness-110 font-medium inline-flex items-center gap-1.5"
              >
                <Icon name="lock" size={12} />
                See plans
              </button>
            ) : (
              <button
                onClick={() => void startLooking(pickedMode, pickedMode === 'silent' ? null : workingOnDraft.trim() || null)}
                data-testid="body-double-find"
                className="text-[12px] px-4 py-1.5 rounded bg-accent text-white hover:brightness-110 font-medium inline-flex items-center gap-1.5"
              >
                <Icon name="diversity_3" size={12} />
                Find a partner
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
