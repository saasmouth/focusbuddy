import { useEffect, useState } from 'react'
import Icon from './Icon'
import { useAccountStore } from '../stores/account'
import { useCapabilityStore } from '../stores/capabilities'

// Growth spec section 5: "During the trial the app nudges once to invite a
// teammate." One small corner card, once per account per device, a few minutes
// into a session on a verified trial. Either button retires it for good; it
// never comes back on its own. Inviting happens in Settings → Organisation,
// where the real invite flow (and its email) lives.

export const INVITE_NUDGE_KEY_PREFIX = 'fb.growth.inviteNudge.v1.'
export const INVITE_NUDGE_COPY =
  'Plexii is better with your team: invite a colleague, they get their own 14-day trial.'
const DELAY_MS = 3 * 60 * 1000

/** Whether the nudge may show now. Pure, for the unit test. */
export function shouldNudge(input: {
  signedIn: boolean
  trialActive: boolean
  plan: string
  emailVerified: boolean | null
  seen: boolean
  orgRole: string | null
}): boolean {
  if (!input.signedIn || input.seen) return false
  if (!input.trialActive) return false
  // Already paying, or already in a team: nothing to nudge toward.
  if (input.plan !== 'free') return false
  if (input.orgRole) return false
  return input.emailVerified !== false
}

function readSeen(accountId: string): boolean {
  try {
    return localStorage.getItem(INVITE_NUDGE_KEY_PREFIX + accountId) !== null
  } catch {
    return true // cannot remember a dismissal, so do not risk repeating it
  }
}

export default function InviteTeammateNudge(): JSX.Element | null {
  const account = useAccountStore((s) => s.account)
  const trialActive = useCapabilityStore((s) => s.trial.active)
  const plan = useCapabilityStore((s) => s.plan)
  const emailVerified = useCapabilityStore((s) => s.emailVerified)
  const orgRole = useCapabilityStore((s) => s.orgRole)
  const [visible, setVisible] = useState(false)

  const eligible =
    account !== null &&
    shouldNudge({ signedIn: true, trialActive, plan, emailVerified, seen: readSeen(account.id), orgRole })

  useEffect(() => {
    if (!eligible) {
      setVisible(false)
      return
    }
    const t = window.setTimeout(() => setVisible(true), DELAY_MS)
    return () => window.clearTimeout(t)
  }, [eligible])

  if (!visible || !account) return null

  const retire = (): void => {
    try {
      localStorage.setItem(INVITE_NUDGE_KEY_PREFIX + account.id, String(Date.now()))
    } catch {
      /* ignore */
    }
    setVisible(false)
  }

  return (
    <div
      role="dialog"
      aria-label="Invite a colleague"
      data-testid="invite-teammate-nudge"
      className="fixed bottom-5 left-5 z-[225] w-[320px] max-w-[92vw] fb-card rounded-2xl p-4 shadow-2xl"
    >
      <div className="flex items-start gap-2.5">
        <span className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Icon name="group_add" size={16} />
        </span>
        <p className="text-xs text-[var(--ink-80)] leading-relaxed flex-1">{INVITE_NUDGE_COPY}</p>
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <button
          type="button"
          onClick={retire}
          data-testid="invite-nudge-dismiss"
          className="text-xs px-3 py-1.5 rounded-md text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
        >
          Not now
        </button>
        <button
          type="button"
          onClick={() => {
            retire()
            window.dispatchEvent(new CustomEvent('fb:open-settings', { detail: { tab: 'organisation' } }))
          }}
          data-testid="invite-nudge-invite"
          className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90"
        >
          Invite a colleague
        </button>
      </div>
    </div>
  )
}
