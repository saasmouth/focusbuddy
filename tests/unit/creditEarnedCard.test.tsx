// The credit-earned card (share credit, 4.3.52): the amount, the server's
// words and the new balance; spending it opens the credit page, sharing again
// opens the desk in view's share sheet (or All desks); dismissing marks it
// seen; several wait behind each other; the shimmer is for the live one only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const h = vi.hoisted(() => ({ seen: [] as string[], opened: [] as string[], openOk: true }))
vi.mock('../../src/renderer/src/lib/cornerStack', () => ({
  CORNER_PRIORITY: { call: 0, meetingInvite: 1, notice: 2, toast: 3, featureSpotlight: 4 },
  useCornerSlot: () => ({ bottom: 20, right: 20, visible: true })
}))
vi.mock('../../src/renderer/src/components/Icon', () => ({ default: ({ name }: { name: string }) => <i data-icon={name} /> }))
vi.mock('../../src/renderer/src/lib/notify', () => ({ notifyExternal: vi.fn() }))
vi.mock('../../src/renderer/src/lib/creditNotices', async (orig) => {
  const real = await orig<typeof import('../../src/renderer/src/lib/creditNotices')>()
  return {
    ...real,
    markCreditNoticeSeen: vi.fn(async (id: string) => {
      h.seen.push(id)
      return true
    })
  }
})

import CreditEarnedCard, { NO_DESK_IN_VIEW_NOTE } from '../../src/renderer/src/components/CreditEarnedCard'
import { parseCreditNotice } from '../../src/renderer/src/lib/creditNotices'
import { useCreditNoticesStore } from '../../src/renderer/src/stores/creditNotices'
import { useNoticeStore } from '../../src/renderer/src/stores/notice'
import { useViewStore } from '../../src/renderer/src/stores/view'
import { OPEN_SHARE_EVENT } from '../../src/renderer/src/lib/openShare'

const notice = (over: Record<string, unknown> = {}) =>
  parseCreditNotice({
    id: 'n1',
    kind: 'creditEarned',
    usd: 5,
    balanceUsd: 15,
    source: 'email_invite',
    deskTitle: 'Launch plan',
    inviteeName: 'Bea Jones',
    text: 'Bea Jones joined Plexii from your invite to “Launch plan”.',
    actionLabel: 'Use my credit',
    actionUrl: 'https://www.plexiidesk.com/account/referrals',
    shareActionLabel: 'Share another desk',
    createdAt: 10,
    ...over
  })!

let host: HTMLDivElement
let root: Root
const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`)
const click = async (id: string): Promise<void> => {
  await act(async () => {
    q(id)!.click()
  })
}

beforeEach(async () => {
  h.seen.length = 0
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
  useCreditNoticesStore.getState().reset()
  useNoticeStore.getState().clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<CreditEarnedCard />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('the credit-earned card', () => {
  it('nothing to celebrate, no card', () => {
    expect(q('credit-earned-card')).toBeNull()
  })

  it('the amount, large; the server’s words as sent; the new balance', async () => {
    await act(async () => useCreditNoticesStore.getState().add(notice(), { live: true }))
    expect(q('credit-earned-amount')!.textContent).toBe('US$5')
    expect(q('credit-earned-text')!.textContent).toBe('Bea Jones joined Plexii from your invite to “Launch plan”.')
    expect(q('credit-earned-balance')!.textContent).toBe('Your Plexii credit is now US$15.')
    expect(q('credit-earned-use')!.textContent).toBe('Use my credit')
    expect(q('credit-earned-share')!.textContent).toBe('Share another desk')
  })

  it('the shimmer is for the one that just arrived, not one listed at launch', async () => {
    await act(async () => useCreditNoticesStore.getState().add(notice()))
    expect(q('credit-earned-card')!.className).not.toContain('fb-credit-shimmer')
    await act(async () => useCreditNoticesStore.getState().add(notice({ id: 'n2', createdAt: 20 }), { live: true }))
    expect(q('credit-earned-card')!.className).toContain('fb-credit-shimmer')
  })

  it('“Use my credit” opens the credit page in the browser, and the card stays', async () => {
    await act(async () => useCreditNoticesStore.getState().add(notice()))
    await click('credit-earned-use')
    expect(h.opened).toEqual(['https://www.plexiidesk.com/account/referrals'])
    expect(q('credit-earned-card')).not.toBeNull()
  })

  it('a link that is not https is never opened; the card says where the credit is', async () => {
    await act(async () => useCreditNoticesStore.getState().add(notice({ actionUrl: 'file:///etc/passwd' })))
    await click('credit-earned-use')
    expect(h.opened).toEqual([])
    expect(q('credit-earned-note')!.textContent).toContain('Could not open your browser')
  })

  it('“Share another desk” opens the share sheet of the desk in view', async () => {
    const goAllTasks = vi.spyOn(useViewStore.getState(), 'goAllTasks')
    const taken: string[] = []
    const onOpen = (e: Event): void => {
      taken.push(e.type)
      e.preventDefault()
    }
    window.addEventListener(OPEN_SHARE_EVENT, onOpen)
    await act(async () => useCreditNoticesStore.getState().add(notice()))
    await click('credit-earned-share')
    window.removeEventListener(OPEN_SHARE_EVENT, onOpen)
    expect(taken).toEqual([OPEN_SHARE_EVENT])
    expect(goAllTasks).not.toHaveBeenCalled()
  })

  it('with no desk in view, it goes to All desks and says how to share one', async () => {
    const goAllTasks = vi.fn()
    useViewStore.setState({ goAllTasks } as never)
    await act(async () => useCreditNoticesStore.getState().add(notice()))
    await click('credit-earned-share')
    expect(goAllTasks).toHaveBeenCalledTimes(1)
    expect(useNoticeStore.getState().notice?.text).toBe(NO_DESK_IN_VIEW_NOTE)
  })

  it('dismissing marks it seen; the next waiting one shows; the last one closes the card', async () => {
    await act(async () => {
      useCreditNoticesStore.getState().add(notice({ id: 'old', createdAt: 1, usd: 5 }))
      useCreditNoticesStore.getState().add(notice({ id: 'new', createdAt: 2, usd: 10, balanceUsd: 20 }))
    })
    expect(q('credit-earned-card')!.dataset.noticeId).toBe('new')
    expect(q('credit-earned-next')!.textContent).toBe('1 of 2 · Next')
    await click('credit-earned-next')
    expect(q('credit-earned-card')!.dataset.noticeId).toBe('old')
    await click('credit-earned-dismiss')
    expect(h.seen).toEqual(['old'])
    expect(q('credit-earned-card')!.dataset.noticeId).toBe('new')
    expect(q('credit-earned-next')).toBeNull()
    await click('credit-earned-dismiss')
    expect(h.seen).toEqual(['old', 'new'])
    expect(q('credit-earned-card')).toBeNull()
  })
})
