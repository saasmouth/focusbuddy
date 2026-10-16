import { useState } from 'react'
import Icon from './Icon'
import Modal from './plexi/Modal'
import { PRICING_URL } from '../lib/siteUrls'
import {
  useStoredTier,
  useTrial,
  useCapabilityStore
} from '../stores/capabilities'
import { useAccountStore } from '../stores/account'
import { useEmailUnverified, usePlan } from '../stores/capabilities'
import { useVerifyEmailStore } from '../stores/verifyEmail'
import { promptUpgrade } from '../stores/upgradePrompt'
import { PLANS, priceLabel, aiAllowanceLabel } from '../lib/plans'
import { fundedPlanLabel } from '../lib/planDisplay'

// Footer trial affordance. Four states the user can be in:
//
//   0. Signed in, email NOT verified (growth spec section 3): "Verify email"
//      pill, click → the code-entry modal. The trial starts on verification,
//      so until then there is no trial to count down.
//   1. Active trial (1+ day left): small green pill "Trial · 7d left",
//      click → upgrade picker modal.
//   2. Trial lapsed AND stored tier is Free: amber pill "Trial ended ·
//      Upgrade", click → upgrade picker modal. Renders as a one-shot
//      "Trial ended" modal automatically the first time the user opens
//      the app after lapse (until they dismiss it).
//   3. No trial, stored tier is Pro/Team: nothing in the footer. User
//      already paid — don't pester them.
//
// We deliberately don't show the badge for signed-out users; the empty
// state is enough indication that they need to sign in.
export default function TrialBadge(): JSX.Element | null {
  const trial = useTrial()
  const storedTier = useStoredTier()
  const accountId = useAccountStore((s) => s.account?.id ?? null)
  const loadedAt = useCapabilityStore((s) => s.loadedAt)
  const [modalOpen, setModalOpen] = useState(false)
  const unverified = useEmailUnverified()
  const openVerify = useVerifyEmailStore((s) => s.open)
  const plan = usePlan()
  const creditPaidUntil = useCapabilityStore((s) => s.creditPaidUntil)

  // Don't render until we've actually heard from the server once.
  // Otherwise we'd flash "Trial ended" on every cold boot before the
  // first /account/capabilities call resolves.
  if (loadedAt === null || !accountId) return null

  if (unverified) {
    return (
      <button
        onClick={openVerify}
        className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25 transition-colors inline-flex items-center gap-1"
        title="Verify your email to start your 14-day trial and 300 AI credits."
        data-testid="trial-badge-verify"
      >
        <Icon name="mark_email_unread" size={10} />
        Verify email
      </button>
    )
  }

  // A plan paid from the referral credit bank (section 4b) says until when.
  if (plan !== 'free' && creditPaidUntil !== null && creditPaidUntil > Date.now()) {
    return (
      <span
        className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1"
        data-testid="trial-badge-credit-funded"
      >
        <Icon name="redeem" size={10} />
        {fundedPlanLabel(plan, creditPaidUntil)}
      </span>
    )
  }

  if (trial.active && trial.daysLeft > 0) {
    return (
      <>
        <button
          onClick={() => setModalOpen(true)}
          className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/25 transition-colors inline-flex items-center gap-1"
          title={`Trial: ${trial.daysLeft} day${trial.daysLeft === 1 ? '' : 's'} left with everything unlocked. Click to see the plans.`}
          data-testid="trial-badge-active"
        >
          <Icon name="bolt" size={10} />
          Trial · {trial.daysLeft}d
        </button>
        {modalOpen && <TierPickerModal onClose={() => setModalOpen(false)} />}
      </>
    )
  }

  // Trial expired (or never existed) AND user is on the post-trial
  // restricted-free tier. Nudge them to upgrade.
  if (storedTier === 'free') {
    return (
      <>
        <button
          onClick={() => setModalOpen(true)}
          className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25 transition-colors inline-flex items-center gap-1"
          title="Your trial has ended. Upgrade to keep premium features, or stay on the restricted free plan."
          data-testid="trial-badge-lapsed"
        >
          <Icon name="lock_clock" size={10} />
          Free · Upgrade
        </button>
        {modalOpen && <TierPickerModal onClose={() => setModalOpen(false)} />}
      </>
    )
  }

  // Pro / Team — user has paid. No nag.
  return null
}

// The plans, with their real prices and AI allowances (lib/plans.ts, pinned to
// the growth spec). "Choose a plan" opens the checkout modal; "Stay on Free"
// records that this was seen so it does not reappear on every boot.
function TierPickerModal({ onClose }: { onClose: () => void }): JSX.Element {
  const stayOnFree = (): void => {
    try {
      localStorage.setItem('fb.tier-picker-acknowledged', '1')
    } catch {
      // ignore — modal still closes
    }
    onClose()
  }
  const choose = (): void => {
    stayOnFree()
    promptUpgrade('Pick the plan that fits.', 'pro')
  }
  const openPricing = (): void => {
    window.open(PRICING_URL, '_blank', 'noopener,noreferrer')
  }
  return (
    <Modal
      onClose={onClose}
      label="Pick a plan"
      z={9999}
      className="fb-card max-w-md w-full p-6"
      testId="tier-picker-modal"
    >
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-base font-semibold text-[var(--ink-100)]">
            Pick a plan
          </h2>
          <button
            onClick={onClose}
            className="h-6 w-6 inline-flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)]"
            aria-label="Close"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <p className="text-xs text-[var(--ink-70)] mb-4 leading-relaxed">
          Your 14-day trial unlocks everything. When it ends you keep Free, with 100 AI
          credits a month, or choose a plan to keep the rest.
        </p>
        <div className="space-y-2 mb-4">
          {PLANS.map((p) => (
            <TierRow
              key={p.id}
              name={p.name}
              price={p.id === 'free' ? 'US$0' : priceLabel(p, 'month')}
              blurb={`${p.tagline} ${aiAllowanceLabel(p)}.`}
              highlight={p.id === 'pro'}
            />
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 pt-3 border-t border-[var(--edge-soft)]">
          <button
            onClick={openPricing}
            className="text-xs px-2 py-1.5 rounded-md text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] transition-colors"
            data-testid="see-pricing"
          >
            Compare plans
          </button>
          <div className="flex gap-2">
            <button
              onClick={stayOnFree}
              className="text-xs px-3 py-1.5 rounded-md text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] transition-colors"
              data-testid="stay-on-free"
            >
              Stay on Free
            </button>
            <button
              onClick={choose}
              className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 transition-opacity"
              data-testid="choose-plan"
            >
              Choose a plan
            </button>
          </div>
        </div>
    </Modal>
  )
}

function TierRow({
  name,
  price,
  blurb,
  highlight
}: {
  name: string
  price: string
  blurb: string
  highlight?: boolean
}): JSX.Element {
  return (
    <div
      className={`rounded-md border px-3 py-2 ${
        highlight
          ? 'border-accent/40 bg-accent/5'
          : 'border-[var(--edge-soft)]'
      }`}
    >
      <div className="text-[11px] font-semibold text-[var(--ink-100)] flex items-baseline gap-2">
        <span>{name}</span>
        <span className="ml-auto font-normal text-[var(--ink-70)]">{price}</span>
        {highlight && (
          <span className="ml-2 text-[9px] uppercase tracking-wider text-accent">
            Recommended
          </span>
        )}
      </div>
      <div className="text-[10px] text-[var(--ink-50)] leading-snug mt-0.5">
        {blurb}
      </div>
    </div>
  )
}
