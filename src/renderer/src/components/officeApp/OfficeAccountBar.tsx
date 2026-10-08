import { useState } from 'react'
import { useAccountStore } from '@runtime'
import Icon from '../Icon'
import { personDisplayName } from '../../lib/personName'

// Minimal, self-contained account bar for the PlexiOffice shell. PlexiOffice signs
// in to the SAME account as PlexiDesk (the shared signal server), which is what
// makes the same documents appear in both apps via cloud sync. It deliberately
// doesn't reuse the desk's sign-in modal (that pulls in desk-only infrastructure);
// it talks to the runtime account store directly.

export default function OfficeAccountBar(): JSX.Element {
  const account = useAccountStore((s) => s.account)
  const login = useAccountStore((s) => s.login)
  const signup = useAccountStore((s) => s.signup)
  const signOut = useAccountStore((s) => s.signOut)

  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(): Promise<void> {
    if (busy || !email.trim() || !password) return
    setBusy(true)
    setError(null)
    try {
      const res =
        mode === 'signin'
          ? await login({ email: email.trim(), password })
          : await signup({ email: email.trim(), password })
      if (!res.ok) {
        setError(res.error || 'Could not sign in.')
        return
      }
      setOpen(false)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  if (account) {
    return (
      <div className="px-3 py-2 border-t border-[var(--edge-soft)] flex items-center gap-2 text-[12px]">
        <Icon name="account_circle" size={16} className="text-accent shrink-0" />
        <span className="truncate text-[var(--ink-70)]">{personDisplayName(account, account.email)}</span>
        <button
          onClick={() => void signOut()}
          className="ml-auto text-[var(--ink-40)] hover:text-[var(--ink-70)]"
          title="Sign out"
        >
          Sign out
        </button>
      </div>
    )
  }

  return (
    <div className="border-t border-[var(--edge-soft)]">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          data-testid="office-signin"
          className="w-full px-3 py-2 flex items-center gap-2 text-[12px] text-accent hover:bg-accent/[0.05]"
        >
          <Icon name="login" size={15} />
          Sign in to sync documents
        </button>
      ) : (
        <div className="p-3 space-y-1.5">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-[var(--ink-40)]">
            {mode === 'signin' ? 'Sign in' : 'Create account'}
            <button onClick={() => setOpen(false)} className="ml-auto icon-btn" aria-label="Close">
              <Icon name="close" size={12} />
            </button>
          </div>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="fb-field w-full bg-[var(--surface-raised)] px-2 py-1 text-[12px]"
          />
          <input
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
            className="fb-field w-full bg-[var(--surface-raised)] px-2 py-1 text-[12px]"
          />
          {error && <div className="text-[11px] text-red-600 dark:text-red-400">{error}</div>}
          <button
            onClick={() => void submit()}
            disabled={busy || !email.trim() || !password}
            data-testid="office-signin-submit"
            className="w-full btn-primary text-[12px] py-1.5 disabled:opacity-50"
          >
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
          <button
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin')
              setError(null)
            }}
            className="w-full text-[11px] text-[var(--ink-50)] hover:text-accent"
          >
            {mode === 'signin' ? 'No account? Create one' : 'Have an account? Sign in'}
          </button>
        </div>
      )}
    </div>
  )
}
