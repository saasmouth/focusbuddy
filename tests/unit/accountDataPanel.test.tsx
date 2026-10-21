// Settings > Account > Your data, and "Close and archive my account" (4.3.40).
// Two deliberate steps (open, then type CLOSE and re-authenticate), the
// server's own lists shown verbatim, the local session dropped afterwards, and
// against a server without the routes no button at all, only how to ask.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  closeMyAccount: vi.fn(),
  requestCloseEmailCode: vi.fn(),
  downloadServerExport: vi.fn()
}))
vi.mock('../../src/renderer/src/lib/accountClient', () => client)
const ALL = ['account_export', 'account_archive', 'account_archive_email']
const features = vi.hoisted(() => ({ list: [] as string[] }))
vi.mock('../../src/renderer/src/stores/capabilities', () => ({
  useCapabilityStore: { getState: () => ({ refresh: vi.fn() }) },
  useServerFeature: (f: string) => features.list.includes(f)
}))

import AccountDataPanel from '../../src/renderer/src/components/settings/AccountDataPanel'
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
  act(() => root.render(<AccountDataPanel />))
}

beforeEach(() => {
  features.list = [...ALL]
  client.closeMyAccount.mockReset()
  client.requestCloseEmailCode.mockReset()
  client.downloadServerExport.mockReset()
  ;(window as unknown as { api: unknown }).api = {
    account: {
      clearSession: vi.fn(async () => {}),
      saveExport: vi.fn(async () => ({ ok: true, path: '/Users/x/Downloads/plexiidesk-data-2026-10-21.zip' }))
    },
    backup: { export: vi.fn(async () => ({ ok: true, path: '/Users/x/b.fbbackup' })) }
  }
  useAccountStore.setState({ sessionToken: 'tok', account: { id: 'a1', email: 'x@y.z' } as never })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<AccountDataPanel />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const api = (): { account: { saveExport: ReturnType<typeof vi.fn> }; backup: { export: ReturnType<typeof vi.fn> } } =>
  (window as unknown as { api: never }).api

describe('Your data', () => {
  it('downloads what the server holds and saves it through the save dialog', async () => {
    client.downloadServerExport.mockResolvedValue({ ok: true, bytes: new Uint8Array([1, 2]), fileName: 'plexiidesk-data-2026-10-21.zip' })
    act(() => q<HTMLButtonElement>('account-export-server').click())
    await flush()
    expect(client.downloadServerExport).toHaveBeenCalledWith('tok')
    expect(api().account.saveExport).toHaveBeenCalledWith(new Uint8Array([1, 2]), 'plexiidesk-data-2026-10-21.zip')
    expect(q('account-export-note')?.textContent).toBe('Saved plexiidesk-data-2026-10-21.zip.')
  })

  it('a failed download says why and saves nothing', async () => {
    client.downloadServerExport.mockResolvedValue({ ok: false, message: 'Too many downloads this hour.' })
    act(() => q<HTMLButtonElement>('account-export-server').click())
    await flush()
    expect(api().account.saveExport).not.toHaveBeenCalled()
    expect(q('account-export-note')?.textContent).toBe('Too many downloads this hour.')
  })

  it('backs up this computer with the existing local backup', async () => {
    act(() => q<HTMLButtonElement>('account-export-local').click())
    await flush()
    expect(api().backup.export).toHaveBeenCalled()
    expect(q('account-export-note')?.textContent).toBe('Saved b.fbbackup.')
  })
})

describe('Close and archive my account', () => {
  it('needs the panel opened, CLOSE typed and a password before it can submit', () => {
    expect(q('account-close-panel')).toBeNull()
    act(() => q<HTMLButtonElement>('account-close-open').click())
    expect(q<HTMLButtonElement>('account-close-submit').disabled).toBe(true)
    type('account-close-confirm', 'close')
    type('account-close-password', 'pw')
    expect(q<HTMLButtonElement>('account-close-submit').disabled).toBe(true)
    type('account-close-confirm', 'CLOSE')
    expect(q<HTMLButtonElement>('account-close-submit').disabled).toBe(false)
  })

  it('on success shows the restore date and the server lists verbatim, and drops the session', async () => {
    client.closeMyAccount.mockResolvedValue({
      ok: true,
      closedAt: Date.UTC(2026, 9, 21),
      eraseAt: Date.UTC(2027, 9, 21),
      notRestorable: ['Your subscription was cancelled.'],
      held: ['Stripe keeps invoices.']
    })
    act(() => q<HTMLButtonElement>('account-close-open').click())
    type('account-close-confirm', 'CLOSE')
    type('account-close-password', 'pw')
    act(() => q<HTMLButtonElement>('account-close-submit').click())
    await flush()
    expect(client.closeMyAccount).toHaveBeenCalledWith('tok', { password: 'pw' })
    expect(q('account-closed-restore')?.textContent).toMatch(/restore it until .*2027/)
    expect(q('account-closed-not-restorable')?.textContent).toBe('Your subscription was cancelled.')
    expect(q('account-closed-held')?.textContent).toBe('Stripe keeps invoices.')
    expect(useAccountStore.getState().sessionToken).toBeNull()
    expect(host.textContent).toMatch(/not touched/)
  })

  it('a server refusal shows its message, asks for the 2FA code when needed, and closes nothing', async () => {
    client.closeMyAccount.mockResolvedValue({ ok: false, error: 'totp_required', message: 'Enter your 2FA code.' })
    act(() => q<HTMLButtonElement>('account-close-open').click())
    type('account-close-confirm', 'CLOSE')
    type('account-close-password', 'pw')
    act(() => q<HTMLButtonElement>('account-close-submit').click())
    await flush()
    expect(q('account-close-error')?.textContent).toBe('Enter your 2FA code.')
    expect(q('account-close-totp')).not.toBeNull()
    expect(useAccountStore.getState().sessionToken).toBe('tok')
  })

  it('an account without a password can use an emailed code', async () => {
    client.requestCloseEmailCode.mockResolvedValue({ ok: true })
    client.closeMyAccount.mockResolvedValue({ ok: true, closedAt: 1, eraseAt: 2, notRestorable: [], held: [] })
    act(() => q<HTMLButtonElement>('account-close-open').click())
    act(() => q<HTMLButtonElement>('account-close-use-email-code').click())
    act(() => q<HTMLButtonElement>('account-close-send-code').click())
    await flush()
    expect(client.requestCloseEmailCode).toHaveBeenCalledWith('tok')
    type('account-close-confirm', 'CLOSE')
    type('account-close-email-code', '123456')
    act(() => q<HTMLButtonElement>('account-close-submit').click())
    await flush()
    expect(client.closeMyAccount).toHaveBeenCalledWith('tok', { emailCode: '123456' })
  })
})

describe('against the live server today (no export / archive routes)', () => {
  it('shows no server button at all, says it comes with the next server update, and keeps the local backup', () => {
    features.list = []
    remount()
    expect(q('account-close-open')).toBeNull()
    expect(q('account-export-server')).toBeNull()
    expect(q('account-close-unavailable')?.textContent).toMatch(/next server update/)
    expect(q('account-close-unavailable')?.textContent).toMatch(/connect@plexiidesk\.com/)
    expect(q('account-your-data')?.textContent).toMatch(/email connect@plexiidesk\.com/)
    expect(q('account-export-local')).not.toBeNull()
  })

  it('a 4.3.34-style server advertising only account_delete still gets no close button', () => {
    features.list = ['account_delete', 'account_delete_email']
    remount()
    expect(q('account-close-open')).toBeNull()
    expect(q('account-close-unavailable')).not.toBeNull()
  })

  it('without the emailed-code route, the no-password option is not offered', () => {
    features.list = ['account_archive']
    remount()
    act(() => q<HTMLButtonElement>('account-close-open').click())
    expect(q('account-close-password')).not.toBeNull()
    expect(q('account-close-use-email-code')).toBeNull()
  })
})
