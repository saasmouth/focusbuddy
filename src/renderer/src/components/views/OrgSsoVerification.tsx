// The org's SSO domain proof, in the SSO settings card (OrgAdminView).
//
// Signal runs single sign-on for a domain only once the org has proved it owns
// it with a DNS TXT record, plexii-verify=<token> (signal sso.ts
// verifySsoDomain), and looks the record up again on every save and on Check
// now. So this says plainly whether SSO is on: until the record is found, it
// shows the record to add and that SSO stays off; once found, that it is on,
// and only if this server can do SSO at all.
import { useState } from 'react'

export interface SsoRecord {
  type: 'TXT'
  /** The domain the record goes on. */
  name: string
  /** plexii-verify=<token> */
  value: string
  /** The other name it may go on instead: _plexii-verify.<domain>. */
  alsoAt: string
}

export interface SsoCheck {
  verified: boolean
  verifiedAt: number | null
  message: string
}

interface Props {
  domain: string
  record: SsoRecord | null
  verifiedAt: number | null
  /** The server has WorkOS set up; without it SSO is off whatever the domain. */
  serverReady: boolean
  /** POST /orgs/:id/sso/verify. */
  onCheck: () => Promise<SsoCheck>
}

export default function OrgSsoVerification({ domain, record, verifiedAt: verifiedAtProp, serverReady, onCheck }: Props): JSX.Element {
  const [verifiedAt, setVerifiedAt] = useState<number | null>(verifiedAtProp)
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function check(): Promise<void> {
    setChecking(true)
    try {
      const r = await onCheck()
      setVerifiedAt(r.verified ? r.verifiedAt : null)
      setMessage(r.message)
    } catch {
      setMessage('Plexii could not check the record. Try again in a moment.')
    } finally {
      setChecking(false)
    }
  }

  async function copy(): Promise<void> {
    if (!record) return
    try {
      await navigator.clipboard.writeText(record.value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setMessage('Could not copy. Select the value and copy it by hand.')
    }
  }

  const checkButton = (
    <button
      onClick={() => void check()}
      disabled={checking}
      className="text-[12px] px-2.5 py-1 rounded border border-[var(--edge-firm)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
      data-testid="org-sso-check"
    >
      {checking ? 'Checking…' : 'Check now'}
    </button>
  )

  return (
    <div className="mt-2 rounded-md border border-[var(--edge-soft)] p-3 space-y-2" data-testid="org-sso-verification">
      {verifiedAt !== null ? (
        <>
          <p className="text-[12px] text-emerald-600 dark:text-emerald-400" data-testid="org-sso-verified">
            Verified {new Date(verifiedAt).toLocaleDateString()}.{' '}
            {serverReady ? `Single sign-on is on for ${domain}.` : 'Sign in with SSO starts once SSO is set up on this server.'}
          </p>
          <p className="text-[11px] text-[var(--ink-50)] leading-relaxed">
            Keep the DNS record in place: Plexii checks it again whenever these settings are saved.
          </p>
          <div className="flex items-center gap-2">{checkButton}</div>
        </>
      ) : (
        <>
          <p className="text-[12px] font-medium" data-testid="org-sso-unverified">Not verified yet</p>
          <p className="text-[11px] text-[var(--ink-50)] leading-relaxed">
            Single sign-on stays off for {domain} until Plexii finds this DNS record, which shows the domain is yours.
            Add it where you manage the domain's DNS, then press Check now.
          </p>
          {record && (
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-[var(--ink-50)]">Type</dt>
              <dd className="font-mono">{record.type}</dd>
              <dt className="text-[var(--ink-50)]">Name</dt>
              <dd className="font-mono break-all">
                {record.name} <span className="text-[var(--ink-40)] font-sans">(or {record.alsoAt})</span>
              </dd>
              <dt className="text-[var(--ink-50)]">Value</dt>
              <dd className="font-mono break-all" data-testid="org-sso-record-value">{record.value}</dd>
            </dl>
          )}
          <div className="flex items-center gap-2">
            {record && (
              <button
                onClick={() => void copy()}
                className="text-[12px] px-2.5 py-1 rounded border border-[var(--edge-firm)] hover:bg-[var(--surface-sunken)]"
                data-testid="org-sso-copy"
              >
                {copied ? 'Copied' : 'Copy value'}
              </button>
            )}
            {checkButton}
          </div>
        </>
      )}
      {message && (
        <p role="status" className="text-[11px] text-[var(--ink-60)] leading-relaxed" data-testid="org-sso-check-message">
          {message}
        </p>
      )}
    </div>
  )
}
