import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../../Icon'

interface Props {
  open: boolean
  onClose: () => void
}

// Accessibility permission prompt.
//
// PROBLEM: macOS keeps changing how to deep-link the Accessibility pane.
// On Sequoia (15+) the URL scheme `x-apple.systempreferences:` can be
// hijacked by password managers AND some pane IDs no longer exist —
// every URL-based approach the previous version of this dialog tried
// landed the user in the Passwords app instead.
//
// SOLUTION: stop trying to deep-link. We give the user three CLEAR
// actions, each of which is bulletproof:
//
//   1. "Allow keyboard control" → triggers macOS's NATIVE prompt via
//      `systemPreferences.isTrustedAccessibilityClient(true)`. The
//      OS itself shows a standard dialog with a "Open System Settings"
//      button that always works. Only shows once per app launch and
//      only when not already trusted.
//   2. "Open System Settings app" → uses `open -a "System Settings"` —
//      no URL processing. Just opens Settings. The user navigates the
//      sidebar manually following the steps shown.
//   3. "Show me the PlexiDesk app" → uses `open -R` to reveal the
//      running .app bundle in Finder. In dev mode this is Electron.app
//      (the dev binary), in prod it's PlexiDesk.app. The user drags
//      it into the Accessibility list — the foolproof way to add it.
//
// While the modal is open we poll the trust state every 1.5s so the
// dialog self-dismisses the moment the toggle is flipped.

export default function AccessibilityPrompt({ open, onClose }: Props): JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const [trusted, setTrusted] = useState(false)
  const [revealedBundleName, setRevealedBundleName] = useState<string | null>(null)

  // Poll the live trust state. Auto-closes when permission is granted.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    async function check(): Promise<void> {
      try {
        const ok = await window.api.streamdeck.checkAccessibility()
        if (cancelled) return
        setTrusted(ok)
        if (ok) {
          window.setTimeout(() => {
            if (!cancelled) onClose()
          }, 1100)
        }
      } catch {
        // ignore — keep polling
      }
    }
    void check()
    const id = window.setInterval(check, 1500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  async function handleNativePrompt(): Promise<void> {
    setBusy(true)
    try {
      // macOS shows its native permission dialog (only the first time
      // per app launch). If already trusted, returns true synchronously.
      await window.api.streamdeck.promptAccessibility()
    } finally {
      setBusy(false)
    }
  }

  async function handleOpenSettingsApp(): Promise<void> {
    setBusy(true)
    try {
      await window.api.streamdeck.openSettingsApp()
    } finally {
      setBusy(false)
    }
  }

  async function handleRevealApp(): Promise<void> {
    setBusy(true)
    try {
      const result = await window.api.streamdeck.revealAppInFinder()
      setRevealedBundleName(result.bundleName)
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return createPortal(
    <div
      className="fb-scrim fixed inset-0 z-[280] flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-white/[0.08] shadow-2xl"
        style={{
          background: 'rgba(16, 24, 39, 0.97)',
          boxShadow:
            'inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 0 1px rgba(139, 92, 246, 0.12), 0 24px 64px -12px rgba(139, 92, 246, 0.28)',
          maxHeight: '92vh'
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-4 pb-3 border-b border-white/[0.05]">
          <div className="flex items-center gap-2 mb-1">
            <div
              className="h-7 w-7 rounded-md inline-flex items-center justify-center shrink-0"
              style={{
                background:
                  'linear-gradient(135deg, rgba(244, 114, 182, 0.25), rgba(244, 114, 182, 0.10))',
                color: 'rgb(251, 207, 232)'
              }}
            >
              <Icon name="key" size={14} />
            </div>
            <h3 className="text-[14px] font-semibold text-stone-100 flex-1">
              Allow PlexiiDesk to control your keyboard
            </h3>
            <button
              onClick={onClose}
              className="text-stone-400 hover:text-stone-100 px-1"
              title="Close"
            >
              <Icon name="close" size={13} />
            </button>
          </div>
          <p className="text-[11px] text-stone-400 leading-snug">
            macOS blocks synthetic keystrokes (⌘C, ⌘V, ⌘⇧4, type-text) until
            PlexiiDesk is granted <strong className="text-stone-200">Accessibility</strong>{' '}
            permission. Three ways to grant it, in order of how reliable they
            are on different macOS versions:
          </p>
        </div>

        <div className="px-5 py-3 space-y-3 overflow-y-auto" style={{ maxHeight: '60vh' }}>
          {trusted ? (
            <div
              className="rounded-md px-3 py-3 flex items-center gap-2"
              style={{
                background: 'rgba(52, 211, 153, 0.10)',
                border: '1px solid rgba(52, 211, 153, 0.30)',
                color: 'rgb(167, 243, 208)'
              }}
            >
              <Icon name="check_circle" size={16} />
              <div className="flex-1">
                <div className="text-[13px] font-medium">Permission granted ✨</div>
                <div className="text-[11px] opacity-80">
                  Closing automatically — your keystroke buttons will work now.
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Option A — native macOS prompt */}
              <Option
                label="A. Try macOS's built-in prompt"
                description={
                  <>
                    macOS shows its own dialog with a working{' '}
                    <strong className="text-stone-100">Open System Settings</strong>{' '}
                    button. <span className="text-amber-300/80">Only fires once per app launch — if you don't see it, use option B.</span>
                  </>
                }
                buttonLabel="Allow keyboard control"
                onClick={() => void handleNativePrompt()}
                busy={busy}
                primary
              />

              {/* Option B — just open Settings, navigate manually */}
              <Option
                label="B. Open System Settings yourself"
                description={
                  <>
                    Just opens the Settings app. <strong className="text-stone-100">No URL deep-linking</strong> (which is what was sending you to Passwords). Use the steps below to navigate once it opens.
                  </>
                }
                buttonLabel="Open System Settings"
                onClick={() => void handleOpenSettingsApp()}
                busy={busy}
              />

              {/* Option C — reveal the app bundle for drag-drop */}
              <Option
                label={
                  <>
                    C. Show me the app to drag in{' '}
                    <span className="text-[9px] text-stone-500 normal-case">
                      (foolproof)
                    </span>
                  </>
                }
                description={
                  <>
                    Reveals the running app bundle in Finder. After clicking, you can <strong className="text-stone-100">drag it directly into the Accessibility list</strong> — works even when the + button in System Settings is acting up.
                  </>
                }
                buttonLabel="Show me the app"
                onClick={() => void handleRevealApp()}
                busy={busy}
              />
              {revealedBundleName && (
                <div
                  className="rounded-md p-2 text-[10px]"
                  style={{
                    background: 'rgba(52, 211, 153, 0.08)',
                    border: '1px solid rgba(52, 211, 153, 0.20)',
                    color: 'rgb(167, 243, 208)'
                  }}
                >
                  Finder opened with <strong>{revealedBundleName}</strong> highlighted. Drag
                  that file into the Accessibility list in System Settings →
                  Privacy &amp; Security → Accessibility.
                </div>
              )}

              {/* Step-by-step instructions for navigating Settings */}
              <div className="space-y-1.5 pt-1">
                <div className="text-[10px] uppercase tracking-wider text-stone-400 font-semibold">
                  Once System Settings is open
                </div>
                <ol
                  className="text-[11px] text-stone-200 leading-relaxed space-y-1.5 pl-5 list-decimal"
                  style={{
                    background: 'rgba(0, 0, 0, 0.32)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    borderRadius: 6,
                    padding: '10px 12px 10px 30px'
                  }}
                >
                  <li>
                    In the <strong className="text-white">left sidebar</strong>, scroll down and click{' '}
                    <strong className="text-white">Privacy &amp; Security</strong>
                  </li>
                  <li>
                    On the right, scroll down to find{' '}
                    <strong className="text-white">Accessibility</strong> and click it
                  </li>
                  <li>
                    Look for{' '}
                    <strong className="text-white">
                      {revealedBundleName || 'PlexiiDesk'}
                    </strong>{' '}
                    in the list:
                    <ul className="mt-1 ml-4 text-[10px] text-stone-400 space-y-0.5 list-disc">
                      <li>
                        If it's there: <strong className="text-stone-200">toggle the switch ON</strong>
                      </li>
                      <li>
                        If it's not there: <strong className="text-stone-200">drag it in</strong> from
                        the Finder window that opened (Option C), or click the{' '}
                        <strong className="text-stone-200">+</strong> button under the list
                      </li>
                    </ul>
                  </li>
                </ol>
              </div>

              {/* Dev-mode gotcha */}
              <div
                className="rounded-md p-2.5 text-[10px] leading-snug"
                style={{
                  background: 'rgba(99, 102, 241, 0.08)',
                  border: '1px solid rgba(99, 102, 241, 0.20)',
                  color: 'rgb(199, 210, 254)'
                }}
              >
                <strong className="text-indigo-200">Dev-mode note:</strong> when
                running PlexiiDesk from{' '}
                <code className="bg-black/30 px-1 rounded">npm run dev</code>, the
                app appears in the Accessibility list as{' '}
                <strong>"Electron"</strong> (the dev binary), not "PlexiiDesk".
                The  <strong>Show me the app</strong> button reveals exactly
                the bundle macOS sees — drag-dropping that file is foolproof.
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-2.5 border-t border-white/[0.05] flex items-center justify-between">
          <span className="text-[10px] text-stone-500 inline-flex items-center gap-1">
            <Icon name="autorenew" size={10} className="opacity-60" />
            Checking every 1.5s…
          </span>
          <button
            onClick={onClose}
            className="text-[11px] px-3 py-1 rounded-md text-stone-300 hover:bg-white/[0.06]"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function Option({
  label,
  description,
  buttonLabel,
  onClick,
  busy,
  primary
}: {
  label: React.ReactNode
  description: React.ReactNode
  buttonLabel: string
  onClick: () => void
  busy: boolean
  primary?: boolean
}): JSX.Element {
  return (
    <div
      className="rounded-md p-2.5 flex items-start gap-2.5"
      style={{
        background: primary ? 'rgba(139, 92, 246, 0.08)' : 'rgba(0, 0, 0, 0.28)',
        border: primary
          ? '1px solid rgba(139, 92, 246, 0.25)'
          : '1px solid rgba(255, 255, 255, 0.06)'
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold text-stone-100 mb-0.5">{label}</div>
        <div className="text-[10px] text-stone-400 leading-snug">{description}</div>
      </div>
      <button
        onClick={onClick}
        disabled={busy}
        className="text-[11px] px-2.5 py-1.5 rounded-md font-medium shrink-0 disabled:opacity-50"
        style={
          primary
            ? {
                background:
                  'linear-gradient(180deg, rgba(139, 92, 246, 0.95), rgba(124, 58, 237, 0.95))',
                color: 'white',
                boxShadow:
                  'inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 6px 18px -6px rgba(139, 92, 246, 0.4)'
              }
            : {
                background: 'rgba(255, 255, 255, 0.08)',
                color: '#e2e8f0',
                border: '1px solid rgba(255, 255, 255, 0.08)'
              }
        }
      >
        {buttonLabel}
      </button>
    </div>
  )
}
