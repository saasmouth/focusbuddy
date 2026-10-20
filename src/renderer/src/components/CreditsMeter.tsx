import { useEffect } from 'react'
import Icon from './Icon'
import { useAiCreditsStore, openAiSettings } from '../stores/aiCredits'
import { useAccountStore } from '../stores/account'
import { formatCredits } from '@shared/aiCredits'

// The AI credit balance, wherever AI is used (growth spec section 2:
// "The app shows the balance"). Reads main's cached status; the number shown
// is the server's, or "—" when it has not been read yet. It never estimates.
//
// compact: one line for AI surfaces (Build with AI, the assistant composer).
// full:    the Settings → AI card, with the reset date and the buckets.

export function resetsLabel(resetsAt: number | null): string | null {
  if (resetsAt === null) return null
  return `resets ${new Date(resetsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
}

export default function CreditsMeter({ variant = 'compact' }: { variant?: 'compact' | 'full' }): JSX.Element | null {
  const status = useAiCreditsStore((s) => s.status)
  const refresh = useAiCreditsStore((s) => s.refresh)
  const signedIn = useAccountStore((s) => s.account !== null)

  useEffect(() => {
    if (signedIn) void refresh()
  }, [signedIn, refresh])

  // On the device, no credits are spent and no key is used.
  if (status?.mode === 'local') {
    if (variant === 'full') return null
    return (
      <span className="fb-t-caption text-[var(--ink-50)] inline-flex items-center gap-1" data-testid="credits-meter">
        <Icon name="memory" size={12} /> On this device
      </span>
    )
  }
  if (!signedIn || !status || !status.signedIn) return null
  // On their own key, the balance is not what pays for this call.
  if (status.mode === 'byok') {
    if (variant === 'full') return null
    return (
      <span className="fb-t-caption text-[var(--ink-50)] inline-flex items-center gap-1" data-testid="credits-meter">
        <Icon name="key" size={12} /> Your own key
      </span>
    )
  }
  const bal = status.balance
  const resets = resetsLabel(status.resetsAt)
  const low = bal !== null && bal <= 0

  if (variant === 'compact') {
    return (
      <button
        type="button"
        onClick={openAiSettings}
        data-testid="credits-meter"
        title="AI credits: open Settings → AI"
        className={`fb-t-caption inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-[var(--surface-sunken)] ${
          low ? 'text-rose-600 dark:text-rose-400' : 'text-[var(--ink-50)]'
        }`}
      >
        <Icon name="toll" size={12} />
        <span data-testid="credits-meter-balance">{bal === null ? '— credits' : formatCredits(bal)}</span>
        {resets && <span className="text-[var(--ink-40)]">· {resets}</span>}
      </button>
    )
  }

  const kinds: Array<{ kind: 'allowance' | 'bonus' | 'purchased'; label: string }> = [
    { kind: 'allowance', label: 'Monthly allowance' },
    { kind: 'bonus', label: 'Bonus (trial, referrals)' },
    { kind: 'purchased', label: 'Top-ups' }
  ]
  return (
    <div data-testid="credits-meter-full">
      <div className="flex items-center justify-between">
        <span className="fb-t-caption text-[var(--ink-70)]">AI credits</span>
        <span
          data-testid="ai-credit-balance"
          className={`text-xs font-mono ${low ? 'text-rose-600 dark:text-rose-400' : 'text-[var(--ink-90)]'}`}
        >
          {bal === null ? '—' : formatCredits(bal)}
        </span>
      </div>
      {(resets || status.allowance !== null) && (
        <div className="fb-t-caption text-[var(--ink-50)] mt-0.5" data-testid="credits-resets">
          {status.allowance !== null && `${formatCredits(status.allowance)} a month`}
          {status.allowance !== null && resets && ', '}
          {resets}
        </div>
      )}
      {status.buckets.length > 0 && (
        <ul className="mt-1.5 space-y-0.5" data-testid="credits-buckets">
          {kinds.map(({ kind, label }) => {
            const rows = status.buckets.filter((b) => b.kind === kind && b.credits > 0)
            if (rows.length === 0) return null
            const total = rows.reduce((a, b) => a + b.credits, 0)
            const soonest = rows
              .map((b) => b.expiresAt)
              .filter((t): t is number => t !== null)
              .sort((a, b) => a - b)[0]
            return (
              <li key={kind} className="fb-t-caption text-[var(--ink-50)] flex justify-between gap-2">
                <span>{label}</span>
                <span className="font-mono">
                  {formatCredits(total)}
                  {soonest !== undefined &&
                    ` · expires ${new Date(soonest).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
