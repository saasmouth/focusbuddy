import { useCallback, useEffect, useState } from 'react'
import Icon from '../Icon'
import { useAccountStore } from '../../stores/account'
import { useCapabilityStore, usePlan } from '../../stores/capabilities'
import { getReferrals, redeemCreditBank, type ReferralSummary } from '../../lib/accountClient'
import { PAID_PLANS, priceLabel, type PaidPlanId } from '../../lib/plans'
import { REFERRAL_BONUS_CREDITS } from '@shared/aiCredits'

// Referrals and the credit bank (growth spec sections 4 and 4b).
//
// Each friend who joins free through your link and verifies their email earns
// you US$12 of plan credit (a month of Pro), up to US$144 a year, and you both
// get 500 AI credits. The bank pays for a plan: a Free account can switch one
// on with it here, no card; a paying account has it applied to invoices by the
// server. Every number on this panel is the server's (GET /referrals); when it
// cannot be read the panel says so instead of showing zeros.

export const REFERRAL_COPY =
  "Invite friends to Plexii. Each friend who joins free earns you US$12 of credit toward any plan (that's a month of Pro). Earn up to US$144 a year."

export function usd(n: number): string {
  return Number.isInteger(n) ? `US$${n}` : `US$${n.toFixed(2)}`
}

/** How many months of a plan the bank covers at its monthly price. */
export function monthsCovered(bankUsd: number, monthlyUsd: number): number {
  return monthlyUsd > 0 ? Math.floor(bankUsd / monthlyUsd) : 0
}

export default function ReferralPanel(): JSX.Element | null {
  const token = useAccountStore((s) => s.sessionToken)
  const plan = usePlan()
  const refreshCaps = useCapabilityStore((s) => s.refresh)
  const [data, setData] = useState<ReferralSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [redeemPlan, setRedeemPlan] = useState<PaidPlanId>('pro')
  const [busy, setBusy] = useState(false)
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

  async function redeem(): Promise<void> {
    if (!token || busy) return
    setBusy(true)
    setNote(null)
    try {
      const r = await redeemCreditBank(token, redeemPlan)
      if (!r.ok) {
        setNote(r.error)
        return
      }
      await refreshCaps()
      await load()
      setNote('Done. Your plan is switched on and paid from your credit.')
    } finally {
      setBusy(false)
    }
  }

  const redeemInfo = PAID_PLANS.find((p) => p.id === redeemPlan) ?? PAID_PLANS[0]
  const canRedeem = plan === 'free' && data !== null && data.creditBankUsd >= redeemInfo.monthly

  return (
    <div className="space-y-1.5" data-testid="referral-panel">
      <div className="fb-t-caption uppercase tracking-wider text-[var(--ink-50)] font-medium">Invite friends</div>
      <p className="fb-t-caption text-[var(--ink-70)] leading-snug" data-testid="referral-copy">
        {REFERRAL_COPY} You both get {REFERRAL_BONUS_CREDITS} AI credits too.
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
              <span className="fb-t-caption text-[var(--ink-70)]">Credit bank</span>
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
            {plan === 'free' ? (
              <div className="flex items-center gap-1.5">
                <select
                  value={redeemPlan}
                  onChange={(e) => setRedeemPlan(e.target.value as PaidPlanId)}
                  aria-label="Plan to pay for with credit"
                  data-testid="referral-redeem-plan"
                  className="fb-field flex-1 min-w-0 rounded-[var(--radius-field)] bg-[var(--surface-raised)] px-2 py-1 text-[12px]"
                >
                  {PAID_PLANS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}, {priceLabel(p, 'month')} ({monthsCovered(data.creditBankUsd, p.monthly)} month
                      {monthsCovered(data.creditBankUsd, p.monthly) === 1 ? '' : 's'} covered)
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void redeem()}
                  disabled={!canRedeem || busy}
                  data-testid="referral-redeem"
                  title={canRedeem ? undefined : `Your bank needs at least ${usd(redeemInfo.monthly)} for a month of ${redeemInfo.name}.`}
                  className="shrink-0 px-2.5 py-1 rounded-[var(--radius-field)] fb-t-caption bg-accent text-white hover:opacity-90 disabled:opacity-40"
                >
                  {busy ? 'Working…' : 'Use my credit'}
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
