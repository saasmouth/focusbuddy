// Settings > Account: "Your data", then "Close and archive my account" (4.3.40).
//
// The owner's ruling: people keep a copy of their data as a file, and closing
// an account ARCHIVES it so it can be restored on request; nobody permanently
// deletes their own account any more. So, in order:
//
//   1. Your data. "Download what our server holds" saves the server's ZIP
//      (GET /accounts/me/export); "Back up this computer" saves the existing
//      .fbbackup of the local workspace. Together they are everything. Offered
//      first; never required before closing.
//   2. Close and archive my account. Two deliberate steps (open, then type
//      CLOSE and re-authenticate: password, plus a 2FA code if on; accounts
//      without a password ask for a code by email). The server cancels billing
//      first, archives, and answers with the erase date and two lists, what a
//      restore cannot bring back and what it holds meanwhile, shown verbatim.
//
// Every server control waits for the server to list its feature in
// serverFeatures (stores/capabilities). Against an older server there is no
// button that could fail or promise the wrong thing, only how to ask instead.
// Restoring a closed account happens at sign-in (LaunchSignInModal), because a
// closed account cannot be signed in to reach this panel.

import { useState } from 'react'
import { useAccountStore } from '../../stores/account'
import { useCapabilityStore, useServerFeature } from '../../stores/capabilities'
import { closeMyAccount, downloadServerExport, requestCloseEmailCode } from '../../lib/accountClient'

type Stage = 'closed' | 'confirm' | 'closing' | 'done'

interface ClosedInfo {
  eraseAt: number
  notRestorable: string[]
  held: string[]
}

const longDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

const BTN =
  'fb-btn-surface inline-flex items-center gap-1 px-2.5 py-1 rounded-[var(--radius-field)] fb-t-caption text-[var(--ink-70)] hover:border-accent hover:text-accent transition-colors disabled:opacity-50'
const FIELD = 'fb-field w-full rounded-[var(--radius-field)] bg-[var(--surface-raised)] px-2 py-1.5 text-[12px]'

function YourData({ token }: { token: string }): JSX.Element {
  const canExport = useServerFeature('account_export')
  const [busy, setBusy] = useState<'server' | 'local' | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)

  async function saveServer(): Promise<void> {
    setBusy('server')
    setNote(null)
    try {
      const r = await downloadServerExport(token)
      if (!r.ok) {
        setNote({ ok: false, text: r.message })
        return
      }
      const saved = await window.api.account.saveExport(r.bytes, r.fileName)
      if (saved.ok) setNote({ ok: true, text: `Saved ${saved.path.split(/[\\/]/).pop()}.` })
      else if (!saved.canceled) setNote({ ok: false, text: 'The file could not be saved there. Choose another folder and try again.' })
    } finally {
      setBusy(null)
    }
  }

  async function saveLocal(): Promise<void> {
    setBusy('local')
    setNote(null)
    try {
      const r = await window.api.backup.export()
      if (r.ok) setNote({ ok: true, text: `Saved ${r.path.split(/[\\/]/).pop()}.` })
      else if (!r.canceled) setNote({ ok: false, text: 'The backup could not be saved there. Choose another folder and try again.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-1.5" data-testid="account-your-data">
      <div className="text-[12px] font-medium text-[var(--ink-90)]">Your data</div>
      <p className="fb-t-caption text-[var(--ink-70)] leading-relaxed">
        Keep your own copy at any time.{' '}
        {canExport
          ? 'What our server holds comes as one ZIP: your account and settings, synced workspace and documents, organisations you created, messages, comments, shares, AI credits, the usage data and crash reports you chose to send, your sign-in history and the files you uploaded (passwords and other sign-in secrets are left out). '
          : 'For a copy of what our server holds, email connect@plexiidesk.com from your account’s address. '}
        A backup of this computer holds the work kept here.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {canExport && (
          <button onClick={() => void saveServer()} disabled={busy !== null} data-testid="account-export-server" className={BTN}>
            {busy === 'server' ? 'Preparing…' : 'Download what our server holds (.zip)'}
          </button>
        )}
        <button onClick={() => void saveLocal()} disabled={busy !== null} data-testid="account-export-local" className={BTN}>
          {busy === 'local' ? 'Saving…' : 'Back up this computer (.fbbackup)'}
        </button>
      </div>
      {note && (
        <p
          role={note.ok ? 'status' : 'alert'}
          className={`fb-t-caption ${note.ok ? 'text-[var(--ink-50)]' : 'text-rose-600 dark:text-rose-400'}`}
          data-testid="account-export-note"
        >
          {note.text}
        </p>
      )}
    </div>
  )
}

export default function AccountDataPanel(): JSX.Element | null {
  const token = useAccountStore((s) => s.sessionToken)
  const canClose = useServerFeature('account_archive')
  const canEmailCode = useServerFeature('account_archive_email')
  const [stage, setStage] = useState<Stage>('closed')
  const [typed, setTyped] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [needsTotp, setNeedsTotp] = useState(false)
  const [useEmailCode, setUseEmailCode] = useState(false)
  const [emailCode, setEmailCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [closed, setClosed] = useState<ClosedInfo | null>(null)

  if (stage === 'done' && closed) {
    return (
      <div className="rounded-[var(--radius-field)] border border-[var(--edge-soft)] p-2.5 space-y-1.5" data-testid="account-closed">
        <div className="text-[12px] font-medium text-[var(--ink-90)]">Your account is closed and archived.</div>
        <p className="fb-t-caption text-[var(--ink-70)] leading-relaxed" data-testid="account-closed-restore">
          You can restore it until {longDate(closed.eraseAt)}: sign in again with this address and choose Restore my
          account, or email connect@plexiidesk.com. After that date it is erased for good.
        </p>
        {closed.notRestorable.length > 0 && (
          <>
            <div className="fb-t-caption text-[var(--ink-70)]">What a restore cannot bring back:</div>
            <ul className="list-disc pl-4 fb-t-caption text-[var(--ink-70)] space-y-0.5" data-testid="account-closed-not-restorable">
              {closed.notRestorable.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          </>
        )}
        {closed.held.length > 0 && (
          <>
            <div className="fb-t-caption text-[var(--ink-70)]">What we hold while it is closed:</div>
            <ul className="list-disc pl-4 fb-t-caption text-[var(--ink-70)] space-y-0.5" data-testid="account-closed-held">
              {closed.held.map((k) => (
                <li key={k}>{k}</li>
              ))}
            </ul>
          </>
        )}
        <p className="fb-t-caption text-[var(--ink-50)] leading-relaxed">
          Your work saved on this computer was not touched. PlexiiDesk needs an account to open, so sign in or create a new one to keep using it here.
        </p>
      </div>
    )
  }

  if (!token) return null

  const ready =
    typed.trim() === 'CLOSE' &&
    (useEmailCode ? /^\d{6}$/.test(emailCode.trim()) : password.length > 0) &&
    (!needsTotp || totp.trim().length > 0)

  async function sendCode(): Promise<void> {
    if (!token) return
    setError(null)
    const r = await requestCloseEmailCode(token)
    if (r.ok) setCodeSent(true)
    else setError(r.message ?? 'The code could not be sent.')
  }

  async function confirmClose(): Promise<void> {
    if (!token || !ready) return
    setStage('closing')
    setError(null)
    const r = await closeMyAccount(
      token,
      useEmailCode
        ? { emailCode: emailCode.trim(), ...(needsTotp ? { totp: totp.trim() } : {}) }
        : { password, ...(needsTotp ? { totp: totp.trim() } : {}) }
    )
    if (!r.ok) {
      if (r.error === 'totp_required' || r.error === 'bad_totp') setNeedsTotp(true)
      if (r.error === 'reauth_required' && canEmailCode && !password) setUseEmailCode(true)
      setError(r.message)
      setStage('confirm')
      return
    }
    setClosed({ eraseAt: r.eraseAt, notRestorable: r.notRestorable, held: r.held })
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

  return (
    <div className="space-y-3">
      <YourData token={token} />
      {!canClose ? (
        <p className="fb-t-caption text-[var(--ink-50)] leading-relaxed" data-testid="account-close-unavailable">
          Closing your account from here comes with the next server update. Until then, email connect@plexiidesk.com
          from your account&apos;s address and we close it for you.
        </p>
      ) : stage === 'closed' ? (
        <button
          onClick={() => setStage('confirm')}
          data-testid="account-close-open"
          className="fb-t-caption text-rose-600 dark:text-rose-400 underline underline-offset-2 hover:opacity-80"
        >
          Close and archive my account
        </button>
      ) : (
        <div
          className="rounded-[var(--radius-field)] border border-rose-300/60 dark:border-rose-500/40 p-2.5 space-y-2"
          data-testid="account-close-panel"
        >
          <div className="text-[12px] font-medium text-[var(--ink-90)]">Close and archive my account</div>
          <p className="fb-t-caption text-[var(--ink-70)] leading-relaxed">
            Closing signs you out everywhere and archives your PlexiiDesk account and what our server holds for it:
            your synced workspace, documents and files, shares, chat history, AI credit balance, referral credit, usage
            data and crash reports. While it is closed nobody can use it and nothing reads it. A paid subscription is
            cancelled straight away. You can restore it for 12 months, then it is erased. Work saved on this computer is
            not touched.
          </p>
          <p className="fb-t-caption text-[var(--ink-50)] leading-relaxed">
            A restore cannot bring back your subscription (you come back on the Free plan), shared links (they stay
            revoked), organisations or shared documents passed to another member so their work was kept, or anything
            someone else deleted meanwhile. You will see what applies to you when it is done. Save a copy of your data
            above first if you want one.
          </p>
          <label className="block fb-t-caption text-[var(--ink-70)]">
            Type CLOSE to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              data-testid="account-close-confirm"
              autoComplete="off"
              className={`${FIELD} mt-1`}
            />
          </label>
          {useEmailCode ? (
            <div className="space-y-1.5">
              <button onClick={() => void sendCode()} data-testid="account-close-send-code" className={BTN}>
                {codeSent ? 'Send the code again' : 'Email me a code'}
              </button>
              <input
                value={emailCode}
                onChange={(e) => setEmailCode(e.target.value)}
                placeholder="6-digit code from the email"
                inputMode="numeric"
                data-testid="account-close-email-code"
                className={FIELD}
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
                data-testid="account-close-password"
                className={FIELD}
              />
              {canEmailCode && (
                <button
                  onClick={() => setUseEmailCode(true)}
                  data-testid="account-close-use-email-code"
                  className="fb-t-caption text-[var(--ink-50)] underline underline-offset-2"
                >
                  No password? Use a code sent by email
                </button>
              )}
            </div>
          )}
          {needsTotp && (
            <input
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="Code from your authenticator, or a recovery code"
              data-testid="account-close-totp"
              className={FIELD}
            />
          )}
          {error && (
            <p className="fb-t-caption text-rose-600 dark:text-rose-400" role="alert" data-testid="account-close-error">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => void confirmClose()}
              disabled={!ready || stage === 'closing'}
              data-testid="account-close-submit"
              className="px-2.5 py-1.5 rounded-[var(--radius-field)] fb-t-caption bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40"
            >
              {stage === 'closing' ? 'Closing…' : 'Close my account'}
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
              data-testid="account-close-cancel"
              className="fb-t-caption text-[var(--ink-50)] hover:text-[var(--ink-90)]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
