import { useCallback, useEffect, useState } from 'react'
import Icon from '../Icon'
import { useAccountStore } from '../../stores/account'
import { usePlan } from '../../stores/capabilities'
import { getReferrals, type ReferralSummary } from '../../lib/accountClient'
import { REFERRAL_BONUS_CREDITS } from '@shared/aiCredits'
import { SITE_BASE } from '../../lib/siteUrls'

// Earning Plexii credit, and the credit bank (growth spec sections 4 and 4b;
// share credit, 4.3.52).
//
// Someone new who joins from a desk you share, an invite you send or your link
// earns you US$5 of Plexii credit, up to US$144 a year; your link also gives
// you both 500 AI credits. Share credit is spent at checkout with a card, so
// "Use my credit" opens the site's credit page (/account/referrals, titled
// "Plexii credit"), which handles both kinds. Every number on this panel is the
// server's (GET /referrals); when it cannot be read the panel says so instead
// of showing zeros.

export const REFERRAL_COPY =
  'You earn US$5 of Plexii credit each time someone new joins from a desk you share, an invite you send or your link. Up to US$144 a year.'

/** The site's credit page, where credit is spent (card-free, or at checkout). */
export const CREDIT_PAGE_URL = `${SITE_BASE}/account/referrals`

export function usd(n: number): string {
  return Number.isInteger(n) ? `US$${n}` : `US$${n.toFixed(2)}`
}

export default function ReferralPanel(): JSX.Element | null {
  const token = useAccountStore((s) => s.sessionToken)
  const plan = usePlan()
  const [data, setData] = useState<ReferralSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    const r = await getReferrals(token)
    if (r.status === 'ok') {
      setData(r.data)
      setError(null)
    } else {
      setData(null)
      setError(r.error)
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  if (!token) return null

  async function copy(): Promise<void> {
    if (!data) return
    try {
      await navigator.clipboard.writeText(data.link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard refused; the link is on screen to copy by hand */
    }
  }

  async function openCreditPage(): Promise<void> {
    setNote(null)
    const r = await window.api.files.openExternal(CREDIT_PAGE_URL)
    if (!r.ok) setNote(`Could not open your browser. Your credit is at ${CREDIT_PAGE_URL}`)
  }

  return (
    <div className="space-y-1.5" data-testid="referral-panel">
      <div className="fb-t-caption uppercase tracking-wider text-[var(--ink-50)] font-medium">Earn credit</div>
      <p className="fb-t-caption text-[var(--ink-70)] leading-snug" data-testid="referral-copy">
        {REFERRAL_COPY} Your link also gives you both {REFERRAL_BONUS_CREDITS} AI credits.
      </p>
      {error && (
        <p className="fb-t-caption text-[var(--ink-50)]" data-testid="referral-error">
          {error}
        </p>
      )}
      {data && (
        <>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={data.link}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Your referral link"
              data-testid="referral-link"
              className="fb-field flex-1 min-w-0 rounded-[var(--radius-field)] bg-[var(--surface-raised)] px-2 py-1.5 text-[12px] font-mono"
            />
            <button
              type="button"
              onClick={() => void copy()}
              data-testid="referral-copy-link"
              className="fb-btn-surface shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-[var(--radius-field)] fb-t-caption text-[var(--ink-70)] hover:text-accent"
            >
              <Icon name="content_copy" size={13} />
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
          <div className="fb-t-caption text-[var(--ink-50)]" data-testid="referral-progress">
            {data.invited} signed up · {data.qualified} joined and verified · {usd(data.creditEarnedUsd12m)} of{' '}
            {usd(data.creditCapUsd)} earned this year
          </div>
          <div className="rounded-[var(--radius-field)] bg-[var(--surface-sunken)] px-2.5 py-2 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="fb-t-caption text-[var(--ink-70)]">Plexii credit</span>
              <span className="text-xs font-mono text-[var(--ink-90)]" data-testid="referral-bank">
                {usd(data.creditBankUsd)}
              </span>
            </div>
            {data.creditPaidUntil !== null && (
              <div className="fb-t-caption text-[var(--ink-50)]" data-testid="referral-paid-until">
                Your plan is paid with credit until{' '}
                {new Date(data.creditPaidUntil).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric'
                })}
                .
              </div>
            )}
            {data.creditCheckoutUsd > 0 && (
              <div className="fb-t-caption text-[var(--ink-50)]" data-testid="referral-checkout-credit">
                {usd(data.creditCheckoutUsd)} of it is share and invite credit, spent at checkout with a card.
              </div>
            )}
            {plan === 'free' ? (
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => void openCreditPage()}
                  disabled={data.creditBankUsd <= 0}
                  data-testid="referral-use-credit"
                  title={data.creditBankUsd > 0 ? 'Opens your Plexii credit page in the browser' : 'No credit yet'}
                  className="shrink-0 px-2.5 py-1 rounded-[var(--radius-field)] fb-t-caption bg-accent text-white hover:opacity-90 disabled:opacity-40"
                >
                  Use my credit
                </button>
              </div>
            ) : (
              <div className="fb-t-caption text-[var(--ink-50)]">
                On a paid plan your credit is applied to your next invoices automatically.
              </div>
            )}
            {note && (
              <div className="fb-t-caption text-[var(--ink-70)]" data-testid="referral-note">
                {note}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
