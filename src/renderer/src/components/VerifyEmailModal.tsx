import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'
import Modal from './plexi/Modal'
import { useVerifyEmailStore } from '../stores/verifyEmail'
import { useAccountStore } from '../stores/account'
import { useCapabilityStore, useEmailUnverified } from '../stores/capabilities'
import { useAiCreditsStore } from '../stores/aiCredits'
import { verifyEmail, resendVerification } from '../lib/accountClient'

// Email verification (growth spec section 3). New accounts get a 6-digit code
// by email (or a link). Unverified, the app works without managed AI; the
// 14-day trial and its 300 AI credits start on verification.
//
// Opens by itself once per app session when the server reports the signed-in
// account as unverified, and on demand from the footer pill, the AI settings
// card, or a managed-AI refusal. "Later" closes it; the footer pill stays until
// the account is verified.

export function normaliseCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6)
}

export default function VerifyEmailModal(): JSX.Element | null {
  const isOpen = useVerifyEmailStore((s) => s.isOpen)
  const open = useVerifyEmailStore((s) => s.open)
  const close = useVerifyEmailStore((s) => s.close)
  const unverified = useEmailUnverified()
  const account = useAccountStore((s) => s.account)
  const token = useAccountStore((s) => s.sessionToken)
  const refreshCaps = useCapabilityStore((s) => s.refresh)
  const trial = useCapabilityStore((s) => s.trial)
  const syncCredits = useAiCreditsStore((s) => s.sync)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const autoShownFor = useRef<string | null>(null)

  // Show once per session per account the first time it is known unverified.
  useEffect(() => {
    if (unverified && account && autoShownFor.current !== account.id) {
      autoShownFor.current = account.id
      open()
    }
  }, [unverified, account, open])

  useEffect(() => {
    if (!isOpen) {
      setCode('')
      setError(null)
      setInfo(null)
      setDone(false)
    }
  }, [isOpen])

  if (!isOpen || !account || !token) return null

  async function submit(e?: React.FormEvent): Promise<void> {
    e?.preventDefault()
    if (busy || code.length !== 6 || !token) return
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const r = await verifyEmail(token, code)
      if (!r.ok) {
        setError(r.error)
        return
      }
      setDone(true)
      // The server starts the trial and grants the trial credits now; read
      // both back rather than assuming them.
      await refreshCaps()
      await window.api.ai.markEmailVerified().catch(() => null)
      await syncCredits()
    } finally {
      setBusy(false)
    }
  }

  async function resend(): Promise<void> {
    if (busy || !token) return
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const r = await resendVerification(token)
      if (r.ok) setInfo(`A new code is on its way to ${account?.email ?? 'your inbox'}.`)
      else setError(r.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={close} label="Verify your email" z={9997} className="fb-card max-w-sm w-full p-6" testId="verify-email-modal">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="h-8 w-8 inline-flex items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Icon name="mark_email_read" size={16} />
          </span>
          <h2 className="text-base font-semibold text-[var(--ink-100)]">
            {done ? 'Email verified' : 'Verify your email'}
          </h2>
        </div>
        <button
          onClick={close}
          className="h-6 w-6 inline-flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)]"
          aria-label="Close"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      {done ? (
        <>
          <p className="text-xs text-[var(--ink-70)] leading-relaxed mb-4" data-testid="verify-email-done">
            {/* Read back from the server, not assumed: one trial per verified
                email, and a paying account has none to start. */}
            {trial.active
              ? `Thanks. Your trial is running, with ${trial.daysLeft} day${trial.daysLeft === 1 ? '' : 's'} left and everything unlocked.`
              : 'Thanks. Your email is verified.'}
          </p>
          <div className="flex justify-end">
            <button onClick={close} className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90">
              Done
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <p className="text-xs text-[var(--ink-70)] leading-relaxed mb-3">
            We sent a 6-digit code to <span className="font-medium text-[var(--ink-90)]">{account.email}</span>. Enter it
            here, or use the link in the email. Verifying starts your 14-day trial and 300 AI credits.
          </p>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(normaliseCode(e.target.value))}
            placeholder="123456"
            autoFocus
            aria-label="Verification code"
            data-testid="verify-email-code"
            className="fb-field w-full px-3 py-2 text-center tracking-[0.4em] font-mono text-base bg-[var(--surface-sunken)]"
          />
          {error && (
            <p className="fb-t-caption text-rose-600 dark:text-rose-400 mt-2" data-testid="verify-email-error">
              {error}
            </p>
          )}
          {info && <p className="fb-t-caption text-[var(--ink-50)] mt-2">{info}</p>}
          <div className="flex items-center justify-between gap-2 pt-3 mt-3 border-t border-[var(--edge-soft)]">
            <button
              type="button"
              onClick={() => void resend()}
              disabled={busy}
              className="text-xs px-2 py-1.5 rounded-md text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
              data-testid="verify-email-resend"
            >
              Send a new code
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={close}
                className="text-xs px-3 py-1.5 rounded-md text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                data-testid="verify-email-later"
              >
                Later
              </button>
              <button
                type="submit"
                disabled={busy || code.length !== 6}
                className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-50"
                data-testid="verify-email-submit"
              >
                {busy ? 'Checking…' : 'Verify'}
              </button>
            </div>
          </div>
        </form>
      )}
    </Modal>
  )
}
