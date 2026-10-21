// Restore at sign-in (LaunchSignInModal) is offered only where it can work:
//   - "Closed your account? Restore it" (the emailed-code path) waits for the
//     server to list account_restore in serverFeatures. Against a server
//     without the route there is no link, so no button that fails.
//   - A sign-in answered with account_archived (only a server that HAS the
//     restore routes sends it) offers Restore with the same password.
//   - What the person reads on a failure is the app's sentence, never the
//     server's text.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  login: vi.fn(),
  restoreAccount: vi.fn(),
  requestRestoreEmailCode: vi.fn()
}))
vi.mock('../../src/renderer/src/lib/accountClient', async (orig) => ({
  ...(await orig<typeof import('../../src/renderer/src/lib/accountClient')>()),
  ...client
}))

import LaunchSignInModal from '../../src/renderer/src/components/LaunchSignInModal'
import { useAccountStore } from '../../src/renderer/src/stores/account'
import { useCapabilityStore } from '../../src/renderer/src/stores/capabilities'
import { useOnboarding } from '../../src/renderer/src/stores/onboarding'
import { plainAccountError } from '../../src/renderer/src/lib/accountClient'

let host: HTMLDivElement
let root: Root
const q = <T extends Element>(id: string): T | null => document.body.querySelector(`[data-testid="${id}"]`) as T | null
const type = (el: HTMLInputElement, value: string): void => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

function mount(): void {
  act(() => root.render(<LaunchSignInModal />))
}

beforeEach(() => {
  client.login.mockReset()
  client.restoreAccount.mockReset()
  client.requestRestoreEmailCode.mockReset()
  ;(window as unknown as { api: unknown }).api = {
    account: { saveSession: vi.fn(async () => {}), setSkipped: vi.fn(async () => {}) },
    files: { openExternal: vi.fn() }
  }
  useAccountStore.setState({
    bootStatus: 'ready',
    account: null,
    sessionToken: null,
    anonymousAllowed: true,
    skippedAt: null,
    cachedEmail: 'closed@example.test'
  } as never)
  useOnboarding.setState({ status: 'done', activeModuleId: null } as never)
  useCapabilityStore.setState({ serverFeatures: [], publicServerFeatures: [] })
  // Today's server: no /public/server-features route.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Route GET:/public/server-features not found', statusCode: 404 }), { status: 404 })))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('Restore at sign-in', () => {
  it('without account_restore there is no "Restore it" link (today\'s server)', () => {
    mount()
    expect(q('signin-password')).not.toBeNull()
    expect(q('signin-restore-start')).toBeNull()
  })

  it('with account_restore the link shows, and opens the emailed-code path', () => {
    useCapabilityStore.setState({ serverFeatures: ['account_restore'] })
    mount()
    const link = q<HTMLButtonElement>('signin-restore-start')
    expect(link?.textContent).toMatch(/Restore it/)
    act(() => link!.click())
    expect(q('signin-restore-code')).not.toBeNull()
    expect(q('signin-restore-send-code')).not.toBeNull()
  })

  it('a sign-in answered account_archived offers Restore even without serverFeatures, and restores', async () => {
    client.login.mockResolvedValue({
      ok: false,
      code: 'ARCHIVED',
      error: 'This account is closed. You can restore it until 21 October 2027, with its data.',
      archived: { closedAt: 1, eraseAt: Date.UTC(2027, 9, 21) }
    })
    client.restoreAccount.mockResolvedValue({
      ok: true,
      sessionToken: 'tok2',
      account: { id: 'a1', email: 'closed@example.test' },
      notRestored: []
    })
    mount()
    type(q<HTMLInputElement>('signin-password')!, 'pw')
    act(() => q<HTMLButtonElement>('signin-submit')!.click())
    await flush()
    expect(q('signin-archived')?.textContent).toMatch(/restore it until/)
    expect(q('signin-restore-start')).toBeNull()
    expect(q('signin-submit')?.textContent).toBe('Restore my account')
    act(() => q<HTMLButtonElement>('signin-submit')!.click())
    await flush()
    expect(client.restoreAccount).toHaveBeenCalledWith(expect.objectContaining({ email: 'closed@example.test', password: 'pw' }))
    expect(q('signin-restored')?.textContent).toMatch(/Everything that was archived came back/)
  })

  it('a failed restore shows the app\'s sentence', async () => {
    client.login.mockResolvedValue({ ok: false, code: 'ARCHIVED', error: 'closed', archived: { closedAt: 1, eraseAt: 2 } })
    client.restoreAccount.mockResolvedValue({ ok: false, error: 'email_in_use', message: plainAccountError('email_in_use', 409) })
    mount()
    type(q<HTMLInputElement>('signin-password')!, 'pw')
    act(() => q<HTMLButtonElement>('signin-submit')!.click())
    await flush()
    act(() => q<HTMLButtonElement>('signin-submit')!.click())
    await flush()
    expect(document.body.textContent).toMatch(/An open account already uses this email address/)
  })
})

describe('signing in', () => {
  it('does not crash when the session list turns account_restore on (hook order stays fixed)', () => {
    const errors: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((e) => errors.push(e))
    mount()
    act(() => useCapabilityStore.setState({ serverFeatures: ['account_restore'] }))
    act(() => useCapabilityStore.setState({ serverFeatures: [] }))
    act(() => useCapabilityStore.setState({ serverFeatures: ['account_restore'], publicServerFeatures: ['account_restore'] }))
    spy.mockRestore()
    expect(errors.filter((e) => /hooks|#310|#311/i.test(String(e)))).toEqual([])
    expect(q('signin-restore-start')).not.toBeNull()
  })
})

describe('signed out: the public feature list', () => {
  it('today\'s server answers 404: the link stays hidden', async () => {
    mount()
    await flush()
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/public\/server-features$/))
    expect(q('signin-restore-start')).toBeNull()
  })

  it('a request that fails outright: the link stays hidden', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    mount()
    await flush()
    expect(q('signin-restore-start')).toBeNull()
  })

  it('a reply that is not a list: the link stays hidden', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status: 200 })))
    mount()
    await flush()
    expect(q('signin-restore-start')).toBeNull()
  })

  it('the 4.3.40 server lists account_restore publicly: the link shows while signed out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, serverFeatures: ['account_restore', 'account_archive_email'] }), { status: 200 }))
    )
    mount()
    await flush()
    expect(q('signin-restore-start')?.textContent).toMatch(/Restore it/)
  })
})

describe('plain error messages', () => {
  it('maps known codes, statuses and anything else to the app\'s own words', () => {
    expect(plainAccountError('bad_password', 401)).toBe('That password is not right.')
    expect(plainAccountError(undefined, 429)).toMatch(/Too many attempts/)
    expect(plainAccountError('Not Found', 404)).toMatch(/not available on PlexiiDesk's server yet/)
    const odd = plainAccountError('Some <html> proxy page', 502)
    expect(odd).toMatch(/^Something went wrong\. Nothing was changed/)
    expect(odd).not.toMatch(/proxy/)
  })
})
