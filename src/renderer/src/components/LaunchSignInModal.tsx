import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import PlexiiMark from './brand/PlexiiMark'
import { useAccountStore } from '../stores/account'
import { useSignInPrompt } from '../stores/signInPrompt'
import { useOnboarding } from '../stores/onboarding'
import { signalConfig } from '../lib/signalConfig'
import { forgotPasswordUrl } from '../lib/siteUrls'
import Icon from './Icon'

// LaunchSignInModal — appears on app boot when the user isn't signed in
// and hasn't recently skipped the modal.
//
// Two tabs:
//   - Log in (default if cachedEmail exists)
//   - Sign up
//
// Plus a calm "Continue without account" button so existing users who
// were happy local-only aren't forced into an account. Their choice is
// remembered for a week (see SKIP_TTL_MS) — after that, the modal
// surfaces again because eventually most users want shares to sync.
//
// All auth goes through the signal server's /accounts/signup and
// /accounts/login endpoints (see lib/accountClient.ts).

const SKIP_TTL_MS = 7 * 24 * 60 * 60 * 1000 // one week

// Three opens without an account are free. On the fourth, the modal stops
// offering a way past itself.
//
// The ask is deliberately late. Someone who has opened PlexiDesk four times has
// come back three times after the first look — the prompt lands on a person who
// has decided they like it, not on a stranger being charged a toll at the door.
// Earlier would convert worse and read worse.
const FREE_LAUNCHES = 3

export default function LaunchSignInModal(): JSX.Element | null {
  const bootStatus = useAccountStore((s) => s.bootStatus)
  const account = useAccountStore((s) => s.account)
  const skippedAt = useAccountStore((s) => s.skippedAt)
  const anonLaunches = useAccountStore((s) => s.anonLaunches)
  const cachedEmail = useAccountStore((s) => s.cachedEmail)
  const signupAction = useAccountStore((s) => s.signup)
  const loginAction = useAccountStore((s) => s.login)
  const setSkipped = useAccountStore((s) => s.setSkipped)
  // Manual open requested from elsewhere (Settings account section, etc.).
  // When set, the modal shows even if the user previously skipped.
  const manualOpen = useSignInPrompt((s) => s.open)
  const closeManual = useSignInPrompt((s) => s.close)
  const onboardingStatus = useOnboarding((s) => s.status)
  // Manually dismissed in this session — we don't want it to re-appear
  // if some other state change fires after the user closed it.
  const [dismissedThisSession, setDismissedThisSession] = useState(false)

  const [mode, setMode] = useState<'login' | 'signup'>(
    cachedEmail ? 'login' : 'signup'
  )
  // Pre-fill email from the cached value (so a returning user only types
  // their password). Sync once cachedEmail is loaded.
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // Reveal is per-open, never remembered: a password left on screen because
  // of a setting chosen days ago is a worse default than one extra click.
  const [showPassword, setShowPassword] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set when an attempt failed because the server could not be reached, as
  // opposed to being rejected. It unlocks the offline escape below: the app is
  // local-first, so an outage must not stand between someone and their own
  // desks, and the session is no longer carried across launches — which means
  // without this, one unreachable server locks every user out of local data.
  const [serverUnreachable, setServerUnreachable] = useState(false)
  // Set once the server says this account has 2FA on; reveals the code field.
  const [twoFactor, setTwoFactor] = useState(false)
  const [code, setCode] = useState('')

  useEffect(() => {
    if (cachedEmail && !email) {
      setEmail(cachedEmail)
      setMode('login')
    }
  }, [cachedEmail, email])

  // Decide whether to render. Three reasons we don't:
  //  - Account store hasn't finished booting (don't flash the modal).
  //  - User is already signed in.
  //  - User skipped recently (within SKIP_TTL_MS) — but skippedAt is
  //    wiped on a successful sign-in, so this only blocks while they're
  //    truly in the "no thanks" state.
  //  - User dismissed in this session.
  if (bootStatus !== 'ready') return null
  if (account) return null
  // Don't stack on top of first-run onboarding. A fresh user does the welcome +
  // API-key + starter flow first; the account prompt waits until that's done.
  if (!manualOpen && onboardingStatus === 'active') return null
  // A manual open (from Settings) overrides the skip/dismiss throttling — the
  // user explicitly asked to sign in, so always show it in that case.
  // Past the free launches, an account is required: the skip, the weekly
  // throttle and the per-session dismiss all stop applying, because every one
  // of them is a way out and there is no longer meant to be one.
  const required = anonLaunches > FREE_LAUNCHES
  if (!manualOpen && !required) {
    if (dismissedThisSession) return null
    if (skippedAt && Date.now() - skippedAt < SKIP_TTL_MS) return null
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result =
        mode === 'login'
          ? await loginAction({
              email: email.trim().toLowerCase(),
              password,
              code: twoFactor ? code.trim() : undefined
            })
          : await signupAction({
              email: email.trim().toLowerCase(),
              password,
              firstName: firstName.trim() || null,
              lastName: lastName.trim() || null
            })
      if (result.ok) {
        // Modal will unmount because `account` is now populated. No
        // additional close needed.
        return
      }
      if (result.code === 'TWO_FACTOR') {
        // Password was accepted; the account needs a code. Reveal the field and
        // keep the password in place so the user just adds the code.
        setTwoFactor(true)
        setError(twoFactor ? result.error : null)
        return
      }
      if (result.code === 'EMAIL_EXISTS') {
        setError('An account with that email exists. Switched you to log in.')
        setMode('login')
        return
      }
      if (result.code === 'NETWORK') {
        // This message used to be a lie past the free launches: the close button
        // is hidden when an account is required, so there was no way to
        // "continue" at all.
        setServerUnreachable(true)
        setError(
          'Could not reach the PlexiDesk server. Your desks are on this machine, so you can carry on offline and sign in when it is back.'
        )
        return
      }
      setError(result.error)
    } finally {
      setBusy(false)
    }
  }

  async function handleSkip(): Promise<void> {
    await setSkipped(true)
    setDismissedThisSession(true)
    closeManual()
  }

  // Close without recording a week-long skip — used by the X when the modal
  // was opened on demand from Settings.
  function handleClose(): void {
    setDismissedThisSession(true)
    closeManual()
  }

  return createPortal(
    <div
      className="fb-scrim fixed inset-0 z-[280] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in to PlexiDesk"
    >
      <div
        className="w-full max-w-md rounded-2xl p-6 fb-glass-chrome border border-white/[0.08] shadow-2xl"
        style={{
          background: 'rgba(20, 28, 48, 0.96)',
          boxShadow:
            'inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 0 1px rgba(139, 92, 246, 0.12), 0 24px 64px -12px rgba(139, 92, 246, 0.28), 0 32px 80px -16px rgba(0, 0, 0, 0.65)'
        }}
      >
        <div className="flex justify-center mb-4">
          {/* Hero surface: the master artwork's gradient ii, one cycle on open. */}
          <PlexiiMark wordmark gradient height={26} letterColor="#FFFFFF" motion="once" />
        </div>
        <div className="flex items-center gap-3 mb-1">
          <div
            className="h-10 w-10 rounded-xl inline-flex items-center justify-center text-[20px] shrink-0"
            style={{
              background:
                'linear-gradient(135deg, rgba(139, 92, 246, 0.25), rgba(99, 102, 241, 0.18))',
              color: 'white'
            }}
          >
            <Icon name="auto_awesome" size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold text-stone-100 tracking-[0.04em]">
              {required
                ? 'You seem to like us'
                : mode === 'login'
                  ? 'Welcome back'
                  : 'Sign in to PlexiDesk'}
            </h2>
            <p className="text-[11px] text-stone-400">
              {/* Says what an account actually does. "Protect your work" on its
                  own would promise a backup nobody has turned on — sync is
                  opt-in — and a promise the product does not keep is a bad
                  first thing to say to someone on their fourth visit. */}
              {required
                ? 'Create an account to protect your work on Plexii — so it can be recovered, synced and shared, rather than living only on this machine.'
                : mode === 'login'
                  ? 'Sign in to sync shared items across your devices.'
                  : 'Create an account to receive shares and sync across your devices.'}
            </p>
          </div>
          {/* The close button is the other way past this modal, so it goes too.
              A gate with a working X is not a gate — and leaving it visible but
              inert would just look broken. */}
          {(!required || serverUnreachable) && (
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            data-testid="signin-close"
            className="shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-md text-stone-400 hover:text-stone-100 hover:bg-white/[0.06] transition-colors"
          >
            <Icon name="close" size={16} />
          </button>
          )}
        </div>

        {/* Mode toggle */}
        <div className="mt-4 flex items-center gap-0.5 p-0.5 rounded-md bg-white/[0.03] border border-white/[0.06] w-fit">
          <button
            onClick={() => {
              setMode('login')
              setError(null)
            }}
            className={`px-3 py-1 rounded text-[11px] font-medium transition-colors ${
              mode === 'login'
                ? 'bg-accent/15 text-accent'
                : 'text-stone-400 hover:text-stone-200'
            }`}
            type="button"
          >
            Log in
          </button>
          <button
            onClick={() => {
              setMode('signup')
              setError(null)
            }}
            className={`px-3 py-1 rounded text-[11px] font-medium transition-colors ${
              mode === 'signup'
                ? 'bg-accent/15 text-accent'
                : 'text-stone-400 hover:text-stone-200'
            }`}
            type="button"
          >
            Sign up
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold mb-1">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              autoFocus
              className="w-full px-3 py-2 rounded-md text-stone-100 placeholder:text-stone-500"
              style={{
                background: 'rgba(0,0,0,0.32)',
                border: '1px solid rgba(255,255,255,0.08)'
              }}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          {mode === 'signup' && (
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold mb-1">
                  First name
                </label>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Jane"
                  maxLength={40}
                  autoComplete="given-name"
                  data-testid="signup-first-name"
                  className="w-full px-3 py-2 rounded-md text-stone-100 placeholder:text-stone-500"
                  style={{ background: 'rgba(0,0,0,0.32)', border: '1px solid rgba(255,255,255,0.08)' }}
                />
              </div>
              <div className="flex-1">
                <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold mb-1">
                  Last name
                </label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Smith"
                  maxLength={40}
                  autoComplete="family-name"
                  data-testid="signup-last-name"
                  className="w-full px-3 py-2 rounded-md text-stone-100 placeholder:text-stone-500"
                  style={{ background: 'rgba(0,0,0,0.32)', border: '1px solid rgba(255,255,255,0.08)' }}
                />
              </div>
            </div>
          )}
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold mb-1">
              Password
            </label>
            {/* Reveal, and the macOS substitution opt-outs.

                Reported 2026-10-08: a password with mixed case and symbols
                "wasn't typing properly", while pasting it worked. The field
                itself was cleared by test: it keeps every character at a 0ms
                typing delay, with Shift held across runs of letters and
                symbols, and with the main thread stalled 70ms out of every
                90ms. But those tests inject key events through the debug
                protocol, which bypasses the macOS layout and text-input layer
                entirely — so they can prove the app is innocent and still
                cannot see a substitution happening above Chromium. This
                machine has Text Replacement switched on with short triggers,
                which is exactly that layer.

                So: opt the field out of every automatic substitution (the
                attributes below), and let the user SEE what is landing. A
                password field that silently takes the wrong characters is
                unfalsifiable from the user's side, which is why this was hard
                to report in the first place. */}
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === 'signup' ? 8 : undefined}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                data-testid="signin-password"
                className="w-full pl-3 pr-10 py-2 rounded-md text-stone-100 placeholder:text-stone-500"
                style={{
                  background: 'rgba(0,0,0,0.32)',
                  border: '1px solid rgba(255,255,255,0.08)'
                }}
                placeholder={mode === 'signup' ? 'at least 8 characters' : 'your password'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                data-testid="signin-password-reveal"
                title={showPassword ? 'Hide password' : 'Show password'}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 grid place-items-center rounded-md text-stone-400 hover:text-stone-100 transition-colors"
              >
                <Icon name={showPassword ? 'visibility_off' : 'visibility'} size={16} />
              </button>
            </div>
            {mode === 'login' && (
              <div className="text-right mt-1">
                <button
                  type="button"
                  onClick={() => void window.api.files.openExternal(forgotPasswordUrl(email))}
                  data-testid="signin-forgot"
                  className="text-[11px] text-stone-400 hover:text-accent transition-colors"
                >
                  Forgot password?
                </button>
              </div>
            )}
          </div>

          {mode === 'login' && twoFactor && (
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-stone-400 font-semibold mb-1">
                Authentication code
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoFocus
                data-testid="signin-2fa-code"
                className="w-full px-3 py-2 rounded-md text-stone-100 placeholder:text-stone-500 tracking-[0.3em] font-mono"
                style={{ background: 'rgba(0,0,0,0.32)', border: '1px solid rgba(255,255,255,0.08)' }}
                placeholder="123456"
                autoComplete="one-time-code"
              />
              <p className="mt-1 text-[10px] text-stone-500">
                From your authenticator app, or use a recovery code.
              </p>
            </div>
          )}

          {error && (
            <div
              className="text-[11px] px-3 py-2 rounded-md"
              style={{
                background: 'rgba(244,114,182,0.10)',
                border: '1px solid rgba(244,114,182,0.25)',
                color: 'rgb(251, 207, 232)'
              }}
            >
              {error}
            </div>
          )}

          {mode === 'login' && (
            <button
              type="button"
              onClick={() => {
                const domain = email.split('@')[1]?.trim().toLowerCase()
                if (!domain) {
                  setError('Enter your work email first, then use Sign in with SSO.')
                  return
                }
                const url = `${signalConfig.httpUrl.replace(/\/+$/, '')}/auth/sso/start?domain=${encodeURIComponent(domain)}`
                void window.api.files.openExternal(url)
              }}
              data-testid="signin-sso"
              className="w-full text-[12px] text-accent hover:underline py-1"
            >
              Sign in with SSO
            </button>
          )}

          <div className="pt-1 flex items-center justify-between gap-2">
            {required ? (
              // No skip past this point. Leaving a disabled or hidden-but-present
              // control here would read as a bug; saying plainly that the free
              // opens are used up is the honest version of the same screen.
              <span className="text-[11px] text-stone-500" data-testid="account-required-note">
                Your first {FREE_LAUNCHES} opens were on us.
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void handleSkip()}
                className="text-[11px] text-stone-400 hover:text-stone-100 transition-colors"
                title="Use PlexiDesk locally without an account. You can sign in later from Settings."
              >
                Continue without account
              </button>
            )}
            <button
              type="submit"
              disabled={busy || !email || !password || (mode === 'login' && twoFactor && !code.trim())}
              className="btn-primary !text-[12px] disabled:opacity-50"
            >
              {busy
                ? 'Working…'
                : mode === 'login'
                  ? twoFactor
                    ? 'Verify'
                    : 'Log in'
                  : 'Create account'}
            </button>
          </div>
          {serverUnreachable && (
            <button
              type="button"
              onClick={handleClose}
              data-testid="signin-continue-offline"
              className="mt-2 w-full text-[11px] text-stone-400 hover:text-stone-200 underline decoration-stone-600 underline-offset-2 transition-colors"
            >
              Continue offline for now
            </button>
          )}
        </form>

        <p className="mt-4 pt-3 border-t border-white/[0.04] text-[10px] text-stone-500 leading-relaxed">
          Your local data stays on this device. Only the items you share, and your
          email, touch our server. No third-party trackers or ads. Anonymous,
          aggregate usage helps us improve the app, and you can turn that off in
          Settings.
        </p>
      </div>
    </div>,
    document.body
  )
}
