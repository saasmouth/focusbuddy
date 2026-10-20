// Settings > Account > "Delete my account and data" (4.3.34). Two deliberate
// steps (open, then type DELETE and re-authenticate), the server's own list of
// what it keeps shown verbatim, and the local session dropped afterwards.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  deleteMyAccount: vi.fn(),
  requestDeleteEmailCode: vi.fn()
}))
vi.mock('../../src/renderer/src/lib/accountClient', () => client)
const features = vi.hoisted(() => ({ list: ['account_delete', 'account_delete_email'] as string[] }))
vi.mock('../../src/renderer/src/stores/capabilities', () => ({
  useCapabilityStore: { getState: () => ({ refresh: vi.fn() }) },
  useServerFeature: (f: string) => features.list.includes(f)
}))

import DeleteAccountPanel from '../../src/renderer/src/components/settings/DeleteAccountPanel'
import { useAccountStore } from '../../src/renderer/src/stores/account'

let host: HTMLDivElement
let root: Root
const q = <T extends Element>(id: string): T => host.querySelector(`[data-testid="${id}"]`) as T
const type = (id: string, value: string): void => {
  const el = q<HTMLInputElement>(id)
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function remount(): void {
  act(() => root.render(<></>))
  act(() => root.render(<DeleteAccountPanel />))
}

beforeEach(() => {
  features.list = ['account_delete', 'account_delete_email']
  client.deleteMyAccount.mockReset()
  client.requestDeleteEmailCode.mockReset()
  ;(window as unknown as { api: unknown }).api = { account: { clearSession: vi.fn(async () => {}) } }
  useAccountStore.setState({ sessionToken: 'tok', account: { id: 'a1', email: 'x@y.z' } as never })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<DeleteAccountPanel />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Delete my account and data', () => {
  it('needs the panel opened, DELETE typed and a password before it can submit', () => {
    expect(q('account-delete-panel')).toBeNull()
    act(() => q<HTMLButtonElement>('account-delete-open').click())
    expect(q<HTMLButtonElement>('account-delete-submit').disabled).toBe(true)
    type('account-delete-confirm', 'delete')
    type('account-delete-password', 'pw')
    expect(q<HTMLButtonElement>('account-delete-submit').disabled).toBe(true)
    type('account-delete-confirm', 'DELETE')
    expect(q<HTMLButtonElement>('account-delete-submit').disabled).toBe(false)
  })

  it('on success shows exactly what the server kept and drops the session', async () => {
    client.deleteMyAccount.mockResolvedValue({ ok: true, kept: ['Invoices stay with Stripe for 7 years (tax law).'] })
    act(() => q<HTMLButtonElement>('account-delete-open').click())
    type('account-delete-confirm', 'DELETE')
    type('account-delete-password', 'pw')
    act(() => q<HTMLButtonElement>('account-delete-submit').click())
    await flush()
    expect(client.deleteMyAccount).toHaveBeenCalledWith('tok', { password: 'pw' })
    expect(q('account-deleted-kept')?.textContent).toBe('Invoices stay with Stripe for 7 years (tax law).')
    expect(useAccountStore.getState().sessionToken).toBeNull()
    expect(host.textContent).toMatch(/not touched/)
  })

  it('a server refusal shows its message, asks for the 2FA code when needed, and deletes nothing locally', async () => {
    client.deleteMyAccount.mockResolvedValue({ ok: false, error: 'totp_required', message: 'Enter your 2FA code.' })
    act(() => q<HTMLButtonElement>('account-delete-open').click())
    type('account-delete-confirm', 'DELETE')
    type('account-delete-password', 'pw')
    act(() => q<HTMLButtonElement>('account-delete-submit').click())
    await flush()
    expect(q('account-delete-error')?.textContent).toBe('Enter your 2FA code.')
    expect(q('account-delete-totp')).not.toBeNull()
    expect(useAccountStore.getState().sessionToken).toBe('tok')
  })

  it('an account without a password can use an emailed code', async () => {
    client.requestDeleteEmailCode.mockResolvedValue({ ok: true })
    client.deleteMyAccount.mockResolvedValue({ ok: true, kept: [] })
    act(() => q<HTMLButtonElement>('account-delete-open').click())
    act(() => (Array.from(host.querySelectorAll('button')).find((b) => /code sent by email/.test(b.textContent ?? '')) as HTMLButtonElement).click())
    act(() => q<HTMLButtonElement>('account-delete-send-code').click())
    await flush()
    expect(client.requestDeleteEmailCode).toHaveBeenCalledWith('tok')
    type('account-delete-confirm', 'DELETE')
    type('account-delete-email-code', '123456')
    act(() => q<HTMLButtonElement>('account-delete-submit').click())
    await flush()
    expect(client.deleteMyAccount).toHaveBeenCalledWith('tok', { emailCode: '123456' })
  })

  it('against a server without the route: no button, just how to ask instead', () => {
    features.list = []
    remount()
    expect(q('account-delete-open')).toBeNull()
    expect(q('account-delete-unavailable')?.textContent).toMatch(/connect@plexiidesk\.com/)
    expect(q('account-delete-unavailable')?.textContent).toMatch(/next server update/)
  })

  it('without the emailed-code route, the no-password option is not offered', () => {
    features.list = ['account_delete']
    remount()
    act(() => q<HTMLButtonElement>('account-delete-open').click())
    expect(q('account-delete-password')).not.toBeNull()
    expect(q('account-delete-use-email-code')).toBeNull()
  })
})
