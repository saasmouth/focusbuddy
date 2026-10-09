// A real mount of the body-double dialog, with its stores driven directly.
//
// What is checked is what someone sees: the four preferences in the words
// people use for them; the doors that replace the search when they cannot
// search (signed out, no plan); a refusal stated with what to do about it;
// and, once matched, where the video actually is. It also pins that the mock
// furniture this dialog used to carry — invented public rooms with made-up
// "N here" counts, a reward for invites nobody could redeem, a looping stock
// clip standing in for the partner's camera — stays gone.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
vi.mock('../../src/renderer/src/lib/signalConfig', () => ({
  signalConfig: { useRemote: true, httpUrl: 'http://signal.test', wsUrl: 'ws://signal.test/ws' }
}))
const account = { sessionToken: 'tok' as string | null }
vi.mock('../../src/renderer/src/stores/account', () => ({
  useAccountStore: Object.assign((sel: (s: unknown) => unknown) => sel(account), { getState: () => account })
}))
const requestOpen = vi.fn()
vi.mock('../../src/renderer/src/stores/signInPrompt', () => ({
  useSignInPrompt: (sel: (s: unknown) => unknown) => sel({ requestOpen })
}))
const entitlement = { enabled: true, restricted: false, reason: 'Body double is part of Pro.', canUpgrade: true, onLockedClick: vi.fn() }
vi.mock('../../src/renderer/src/lib/entitlementReason', () => ({
  useEntitlement: () => entitlement
}))
const meeting = { roomId: null as string | null, status: 'idle', layout: 'collaborate', setLayout: vi.fn(), bodyDouble: null }
vi.mock('../../src/renderer/src/stores/meetingRoom', () => ({
  useMeetingRoomStore: Object.assign((sel: (s: unknown) => unknown) => sel(meeting), { getState: () => meeting })
}))

import PeerBodyDoubleDialog from '../../src/renderer/src/components/PeerBodyDoubleDialog'
import { usePeerBodyDoubleStore } from '../../src/renderer/src/stores/peerBodyDouble'

let host: HTMLDivElement
let root: Root

function mount(): void {
  act(() => {
    root.render(<PeerBodyDoubleDialog onClose={() => {}} />)
  })
}
const text = (): string => document.body.textContent ?? ''
const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`)

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  account.sessionToken = 'tok'
  entitlement.enabled = true
  Object.assign(meeting, { roomId: null, status: 'idle', layout: 'collaborate' })
  usePeerBodyDoubleStore.setState({
    status: 'idle',
    mode: null,
    workingOn: null,
    myHandle: null,
    partner: null,
    meetingRoomId: null,
    videoIssue: null,
    chat: [],
    toast: null,
    error: null
  })
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
})

describe('idle', () => {
  it('offers the four preferences in plain words', () => {
    mount()
    for (const label of ['Silent', 'Intros only', 'A little chat is fine', 'Happy to talk']) {
      expect(text()).toContain(label)
    }
    expect(q('body-double-find')).not.toBeNull()
  })

  it('carries none of the old mock furniture', () => {
    mount()
    expect(text()).not.toMatch(/\d+ here/)
    expect(text()).not.toContain('Public rooms')
    expect(text()).not.toContain('month free')
    expect(text()).not.toContain('Mock video')
    expect(document.querySelector('video')).toBeNull()
  })

  it('says plainly that it is video, by handle, unrecorded', () => {
    mount()
    expect(text()).toContain('on camera in a private')
    expect(text()).toContain('never your name or email')
    expect(text()).toContain('Nothing is')
  })

  it('signed out: the button signs in instead of searching', () => {
    account.sessionToken = null
    mount()
    expect(q('body-double-find')).toBeNull()
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Sign in to find a partner'))
    expect(btn).toBeDefined()
    act(() => btn!.click())
    expect(requestOpen).toHaveBeenCalled()
  })

  it('no plan: the reason is shown and the button leads to plans', () => {
    entitlement.enabled = false
    mount()
    expect(q('body-double-find')).toBeNull()
    expect(text()).toContain('Body double is part of Pro.')
    expect(text()).toContain('See plans')
  })

  it('a refusal is stated with the way out', () => {
    usePeerBodyDoubleStore.setState({ error: { code: 'bd_sign_in', message: 'Your sign-in has expired.' } })
    mount()
    const banner = q('body-double-error')
    expect(banner?.getAttribute('data-code')).toBe('bd_sign_in')
    expect(banner?.textContent).toContain('Your sign-in has expired.')
    expect(banner?.textContent).toContain('Sign in')
  })
})

describe('in a session', () => {
  const partner = { handle: 'SteadyWren66', workingOn: 'grant report', joinedAt: 1 }

  it('matched: names the partner by handle and says a camera room will open', () => {
    usePeerBodyDoubleStore.setState({ status: 'matched', mode: 'open', partner, meetingRoomId: 'bd-1', myHandle: 'KindLark77' })
    mount()
    expect(q('body-double-partner')?.textContent).toBe('SteadyWren66')
    expect(text()).toContain('grant report')
    expect(text()).toContain('opens your camera in a private room')
  })

  it('connected and in the room: says where the video is; Block and End are there', () => {
    usePeerBodyDoubleStore.setState({ status: 'connected', mode: 'light', partner, meetingRoomId: 'bd-2', myHandle: 'KindLark77' })
    Object.assign(meeting, { roomId: 'bd-2', status: 'in' })
    mount()
    expect(q('body-double-video-state')?.textContent).toContain('You are on camera together')
    expect(q('body-double-block')).not.toBeNull()
    expect(q('body-double-end')).not.toBeNull()
    expect(text()).toContain('Send')
  })

  it('connected but the video failed: the reason and a retry, never a fake feed', () => {
    usePeerBodyDoubleStore.setState({
      status: 'connected',
      mode: 'silent',
      partner,
      meetingRoomId: 'bd-3',
      myHandle: 'KindLark77',
      videoIssue: 'Could not access your camera. Check system permissions.'
    })
    mount()
    expect(q('body-double-video-state')?.textContent).toContain('Could not access your camera')
    expect(q('body-double-retry-video')?.textContent).toBe('Try again')
    expect(document.querySelector('video')).toBeNull()
  })

  it('silent: no chat box at all', () => {
    usePeerBodyDoubleStore.setState({ status: 'connected', mode: 'silent', partner, meetingRoomId: 'bd-4', myHandle: 'KindLark77' })
    Object.assign(meeting, { roomId: 'bd-4', status: 'in' })
    mount()
    expect(document.querySelector('input')).toBeNull()
    expect(text()).toContain('no microphone and no chat')
  })

  it('text-only pairing says so', () => {
    usePeerBodyDoubleStore.setState({ status: 'connected', mode: 'open', partner, meetingRoomId: null, myHandle: 'KindLark77' })
    mount()
    expect(q('body-double-video-state')?.textContent).toContain('Text-only session')
    expect(q('body-double-block')).toBeNull()
  })
})
