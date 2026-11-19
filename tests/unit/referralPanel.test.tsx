// Settings › Earn credit (share credit, 4.3.52): the US$5 copy, the part of
// the balance that is share credit, and "Use my credit" opening the site's
// credit page (share credit is spent at checkout, so the app does not redeem).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const h = vi.hoisted(() => ({
  plan: 'free' as string,
  referrals: null as unknown,
  opened: [] as string[],
  openOk: true
}))
vi.mock('../../src/renderer/src/components/Icon', () => ({ default: ({ name }: { name: string }) => <i data-icon={name} /> }))
vi.mock('../../src/renderer/src/stores/capabilities', () => ({ usePlan: () => h.plan }))
vi.mock('../../src/renderer/src/lib/accountClient', () => ({
  getReferrals: vi.fn(async () => ({ status: 'ok', data: h.referrals }))
}))

import ReferralPanel, { CREDIT_PAGE_URL, REFERRAL_COPY } from '../../src/renderer/src/components/settings/ReferralPanel'
import { useAccountStore } from '../../src/renderer/src/stores/account'

const summary = (over: Record<string, unknown> = {}) => ({
  code: 'ab12',
  link: 'https://www.plexiidesk.com/r/ab12',
  invited: 4,
  qualified: 3,
  creditBankUsd: 15,
  creditCardFreeUsd: 5,
  creditCheckoutUsd: 10,
  creditEarnedUsd12m: 15,
  creditCapUsd: 144,
  creditPaidUntil: null,
  ...over
})

let host: HTMLDivElement
let root: Root
const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`)
async function mount(): Promise<void> {
  await act(async () => root.render(<ReferralPanel />))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  h.plan = 'free'
  h.referrals = summary()
  h.opened.length = 0
  h.openOk = true
  ;(window as unknown as { api: unknown }).api = {
    files: {
      openExternal: vi.fn(async (url: string) => {
        h.opened.push(url)
        return h.openOk ? { ok: true } : { ok: false, error: 'no browser' }
      })
    }
  }
  useAccountStore.setState({ sessionToken: 'tok' } as never)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('Earn credit', () => {
  it('says what a join earns, and that the link adds AI credits', async () => {
    await mount()
    expect(host.textContent).toContain('Earn credit')
    expect(q('referral-copy')!.textContent).toContain(REFERRAL_COPY)
    expect(q('referral-copy')!.textContent).toContain('Your link also gives you both')
    expect(q('referral-progress')!.textContent).toContain('US$15 of US$144 earned this year')
  })

  it('names the part of the balance that is spent at checkout', async () => {
    await mount()
    expect(q('referral-bank')!.textContent).toBe('US$15')
    expect(q('referral-checkout-credit')!.textContent).toBe('US$10 of it is share and invite credit, spent at checkout with a card.')
  })

  it('no share credit: no checkout line', async () => {
    h.referrals = summary({ creditBankUsd: 5, creditCheckoutUsd: 0 })
    await mount()
    expect(q('referral-checkout-credit')).toBeNull()
  })

  it('on Free, “Use my credit” opens the credit page in the browser', async () => {
    await mount()
    await act(async () => q('referral-use-credit')!.click())
    expect(h.opened).toEqual([CREDIT_PAGE_URL])
    expect(CREDIT_PAGE_URL).toBe('https://www.plexiidesk.com/account/referrals')
  })

  it('when the browser cannot be opened, it says where the credit is', async () => {
    h.openOk = false
    await mount()
    await act(async () => q('referral-use-credit')!.click())
    expect(q('referral-note')!.textContent).toBe(`Could not open your browser. Your credit is at ${CREDIT_PAGE_URL}`)
  })

  it('no credit yet: the button waits', async () => {
    h.referrals = summary({ creditBankUsd: 0, creditCardFreeUsd: 0, creditCheckoutUsd: 0 })
    await mount()
    expect((q('referral-use-credit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('on a paid plan, credit goes to invoices; no button', async () => {
    h.plan = 'pro'
    await mount()
    expect(q('referral-use-credit')).toBeNull()
    expect(host.textContent).toContain('applied to your next invoices automatically')
  })
})
