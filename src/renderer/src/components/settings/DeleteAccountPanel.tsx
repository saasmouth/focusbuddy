// "Delete my account and data" (Settings > Account), self-service from 4.3.34.
//
// Two steps on purpose: open the panel, then type DELETE and re-authenticate
// (password, plus a 2FA code if 2FA is on; accounts without a password ask for
// a code by email). The server deletes the account and everything tied to it
// and returns what it must keep and why; that list is shown as the server
// wrote it, never paraphrased here. Work saved on this computer is not touched,
// and the panel says so.

import { useState } from 'react'
import { useAccountStore } from '../../stores/account'
import { useCapabilityStore } from '../../stores/capabilities'
import { deleteMyAccount, requestDeleteEmailCode } from '../../lib/accountClient'

type Stage = 'closed' | 'confirm' | 'deleting' | 'done'

export default function DeleteAccountPanel(): JSX.Element | null {
  const token = useAccountStore((s) => s.sessionToken)
  const [stage, setStage] = useState<Stage>('closed')
  const [typed, setTyped] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [needsTotp, setNeedsTotp] = useState(false)
  const [useEmailCode, setUseEmailCode] = useState(false)
  const [emailCode, setEmailCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kept, setKept] = useState<string[]>([])

  if (!token && stage !== 'done') return null

  const ready =
    typed.trim() === 'DELETE' &&
    (useEmailCode ? /^\d{6}$/.test(emailCode.trim()) : password.length > 0) &&
    (!needsTotp || /^\d{6}$/.test(totp.trim()))

  async function sendCode(): Promise<void> {
    if (!token) return
    setError(null)
    const r = await requestDeleteEmailCode(token)
    if (r.ok) setCodeSent(true)
    else setError(r.message ?? 'The code could not be sent.')
  }

  async function confirmDelete(): Promise<void> {
    if (!token || !ready) return
    setStage('deleting')
    setError(null)
    const r = await deleteMyAccount(
      token,
      useEmailCode
        ? { emailCode: emailCode.trim() }
        : { password, ...(needsTotp ? { totp: totp.trim() } : {}) }
    )
    if (!r.ok) {
      if (r.error === 'totp_required') setNeedsTotp(true)
      if (r.error === 'reauth_required') setUseEmailCode(true)
      setError(r.message)
      setStage('confirm')
      return
    }
    setKept(r.kept)
    setStage('done')
    // The server has already ended every session; drop this one locally.
    try {
      await window.api.account.clearSession()
    } catch {
      /* the session is invalid server-side either way */
    }
    useAccountStore.setState({ sessionToken: null, account: null })
    void useCapabilityStore.getState().refresh()
  }

  if (stage === 'done') {
    return (
      <div className="rounded-[var(--radius-field)] border border-[var(--edge-soft)] p-2.5 space-y-1.5" data-testid="account-deleted">
        <div className="text-[12px] font-medium text-[var(--ink-90)]">Your account and its data are deleted.</div>
        {kept.length > 0 && (
          <>
            <div className="fb-t-caption text-[var(--ink-70)]">What is kept, and why:</div>
            <ul className="list-disc pl-4 fb-t-caption text-[var(--ink-70)] space-y-0.5" data-testid="account-deleted-kept">
              {kept.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          </>
        )}
        <p className="fb-t-caption text-[var(--ink-50)] leading-relaxed">
          Your work saved on this computer was not touched. To remove it as well, delete PlexiiDesk and its data
          folder, or keep it as a backup first (Settings &gt; Data &gt; Backup).
        </p>
      </div>
    )
  }

  if (stage === 'closed') {
    return (
      <button
        onClick={() => setStage('confirm')}
        data-testid="account-delete-open"
        className="fb-t-caption text-rose-600 dark:text-rose-400 underline underline-offset-2 hover:opacity-80"
      >
        Delete my account and data
      </button>
    )
  }

  return (
    <div
      className="rounded-[var(--radius-field)] border border-rose-300/60 dark:border-rose-500/40 p-2.5 space-y-2"
      data-testid="account-delete-panel"
    >
      <div className="text-[12px] font-medium text-[var(--ink-90)]">Delete my account and data</div>
      <p className="fb-t-caption text-[var(--ink-70)] leading-relaxed">
        This permanently deletes your PlexiiDesk account and what our server holds for it: your synced workspace,
        documents and files, shares and invites you sent, chat history, AI credit balance, referral credit, usage data,
        crash reports and sign-in history. It cancels a paid plan. It cannot be undone. Anything the law requires us to
        keep, such as invoices, is listed when the deletion completes. Work saved on this computer is not touched.
      </p>
      <label className="block fb-t-caption text-[var(--ink-70)]">
        Type DELETE to confirm
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          data-testid="account-delete-confirm"
          autoComplete="off"
          className="fb-field mt-1 w-full rounded-[var(--radius-field)] bg-[var(--surface-raised)] px-2 py-1.5 text-[12px]"
        />
      </label>
      {useEmailCode ? (
        <div className="space-y-1.5">
          <button
            onClick={() => void sendCode()}
            data-testid="account-delete-send-code"
            className="fb-btn-surface px-2.5 py-1 rounded-[var(--radius-field)] fb-t-caption text-[var(--ink-70)]"
          >
            {codeSent ? 'Send the code again' : 'Email me a code'}
          </button>
          <input
            value={emailCode}
            onChange={(e) => setEmailCode(e.target.value)}
            placeholder="6-digit code from the email"
            inputMode="numeric"
            data-testid="account-delete-email-code"
            className="fb-field w-full rounded-[var(--radius-field)] bg-[var(--surface-raised)] px-2 py-1.5 text-[12px]"
          />
        </div>
      ) : (
        <div className="space-y-1.5">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Your password"
            autoComplete="current-password"
            data-testid="account-delete-password"
            className="fb-field w-full rounded-[var(--radius-field)] bg-[var(--surface-raised)] px-2 py-1.5 text-[12px]"
          />
          {needsTotp && (
            <input
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="6-digit code from your authenticator"
              inputMode="numeric"
              data-testid="account-delete-totp"
              className="fb-field w-full rounded-[var(--radius-field)] bg-[var(--surface-raised)] px-2 py-1.5 text-[12px]"
            />
          )}
          <button
            onClick={() => setUseEmailCode(true)}
            className="fb-t-caption text-[var(--ink-50)] underline underline-offset-2"
          >
            No password? Use a code sent by email
          </button>
        </div>
      )}
      {error && (
        <p className="fb-t-caption text-rose-600 dark:text-rose-400" role="alert" data-testid="account-delete-error">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={() => void confirmDelete()}
          disabled={!ready || stage === 'deleting'}
          data-testid="account-delete-submit"
          className="px-2.5 py-1.5 rounded-[var(--radius-field)] fb-t-caption bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40"
        >
          {stage === 'deleting' ? 'Deleting…' : 'Delete everything'}
        </button>
        <button
          onClick={() => {
            setStage('closed')
            setTyped('')
            setPassword('')
            setTotp('')
            setEmailCode('')
            setError(null)
          }}
          data-testid="account-delete-cancel"
          className="fb-t-caption text-[var(--ink-50)] hover:text-[var(--ink-90)]"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
