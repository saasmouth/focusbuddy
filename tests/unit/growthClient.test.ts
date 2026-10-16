import { describe, it, expect, vi } from 'vitest'
import { parseReferrals } from '../../src/renderer/src/lib/accountClient'
import { reportFirstLaunch, FIRST_LAUNCH_KEY_PREFIX } from '../../src/renderer/src/lib/firstLaunch'
import { promptFor } from '../../src/renderer/src/stores/aiCredits'
import { shouldNudge, INVITE_NUDGE_COPY } from '../../src/renderer/src/components/InviteTeammateNudge'
import { normaliseCode } from '../../src/renderer/src/components/VerifyEmailModal'
import { monthsCovered, usd, REFERRAL_COPY } from '../../src/renderer/src/components/settings/ReferralPanel'

describe('GET /referrals (growth spec 4b)', () => {
  it('reads the credit-bank shape', () => {
    expect(
      parseReferrals({
        code: 'ab12',
        link: 'https://plexiidesk.com/r/ab12',
        invited: 5,
        qualified: 3,
        creditBankUsd: 36,
        creditEarnedUsd12m: 36,
        creditCapUsd: 144,
        creditPaidUntil: '2027-01-15T00:00:00Z'
      })
    ).toEqual({
      code: 'ab12',
      link: 'https://plexiidesk.com/r/ab12',
      invited: 5,
      qualified: 3,
      creditBankUsd: 36,
      creditEarnedUsd12m: 36,
      creditCapUsd: 144,
      creditPaidUntil: Date.parse('2027-01-15T00:00:00Z')
    })
  })
  it('refuses a body without a code and link rather than showing an empty panel', () => {
    expect(parseReferrals({ invited: 2 })).toBeNull()
  })
  it('uses the owner\'s copy', () => {
    expect(REFERRAL_COPY).toBe(
      "Invite friends to Plexii. Each friend who joins free earns you US$12 of credit toward any plan (that's a month of Pro). Earn up to US$144 a year."
    )
    expect(monthsCovered(36, 12)).toBe(3)
    expect(monthsCovered(36, 25)).toBe(1)
    expect(usd(12)).toBe('US$12')
    expect(usd(12.5)).toBe('US$12.50')
  })
})

describe('first_launch', () => {
  const mem = (): Storage => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as Storage
  }
  const base = {
    httpUrl: 'https://signal.test/',
    token: 't',
    accountId: 'acc1',
    enabled: () => true,
    props: async () => ({ appVersion: '4.3.29', platform: 'darwin' }),
    now: () => 1000
  }

  it('posts once per account and remembers it', async () => {
    const storage = mem()
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    expect(await reportFirstLaunch({ ...base, storage, fetchImpl })).toBe('sent')
    expect(await reportFirstLaunch({ ...base, storage, fetchImpl })).toBe('already-sent')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    // The server records first_launch from the first /telemetry snapshot.
    expect(url).toBe('https://signal.test/telemetry')
    expect(JSON.parse(String(init.body))).toEqual({ appVersion: '4.3.29', platform: 'darwin' })
    expect(storage.getItem(FIRST_LAUNCH_KEY_PREFIX + 'acc1')).toBe('1000')
  })
  it('does not mark a failed send as sent', async () => {
    const storage = mem()
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }))
    expect(await reportFirstLaunch({ ...base, storage, fetchImpl })).toBe('failed')
    expect(storage.getItem(FIRST_LAUNCH_KEY_PREFIX + 'acc1')).toBeNull()
  })
  it('sends nothing with usage sharing off', async () => {
    const fetchImpl = vi.fn()
    expect(await reportFirstLaunch({ ...base, enabled: () => false, storage: mem(), fetchImpl })).toBe('disabled')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('which credit prompt a refusal raises', () => {
  it('"Trial credits used" for a free trialist out of credits', () => {
    expect(promptFor({ error: 'out_of_credits', next: 'upgrade' }, { trialActive: true, plan: 'free', balance: 0 })).toBe('trial_used')
  })
  it('plain "used up" after the trial or on a paid plan', () => {
    expect(promptFor({ error: 'out_of_credits', next: 'upgrade' }, { trialActive: false, plan: 'free', balance: 0 })).toBe('out_of_credits')
    expect(promptFor({ error: 'out_of_credits', next: 'topup' }, { trialActive: true, plan: 'pro', balance: 0 })).toBe('out_of_credits')
  })
  it('routes model and verification refusals to their own prompts', () => {
    expect(promptFor({ error: 'model_not_in_plan', next: 'upgrade' }, { trialActive: false, plan: 'pro', balance: 10 })).toBe('model_not_in_plan')
    expect(promptFor({ error: 'email_not_verified', next: null }, { trialActive: false, plan: 'free', balance: null })).toBe('verify_email')
  })
})

describe('the invite-a-teammate nudge', () => {
  const ok = { signedIn: true, trialActive: true, plan: 'free', emailVerified: true as boolean | null, seen: false, orgRole: null as string | null }
  it('shows once, during a verified trial, to someone not yet in a team', () => {
    expect(shouldNudge(ok)).toBe(true)
    expect(shouldNudge({ ...ok, seen: true })).toBe(false)
    expect(shouldNudge({ ...ok, trialActive: false })).toBe(false)
    expect(shouldNudge({ ...ok, emailVerified: false })).toBe(false)
    expect(shouldNudge({ ...ok, plan: 'pro' })).toBe(false)
    expect(shouldNudge({ ...ok, orgRole: 'member' })).toBe(false)
  })
  it('uses the spec copy', () => {
    expect(INVITE_NUDGE_COPY).toBe('Plexii is better with your team: invite a colleague, they get their own 14-day trial.')
  })
})

describe('verification code entry', () => {
  it('keeps six digits and nothing else', () => {
    expect(normaliseCode(' 12-34 56 7')).toBe('123456')
    expect(normaliseCode('abc')).toBe('')
  })
})
