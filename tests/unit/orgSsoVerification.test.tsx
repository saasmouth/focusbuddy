// The org's SSO settings show the DNS record that proves the email domain, and
// say honestly whether SSO is on (a0 and d0, 2026-11-20; signal sso.ts
// verifySsoDomain).
//
// Signal answers 503 to every SSO sign-in until the org's domain is verified by
// a TXT record, plexii-verify=<token>. The card used to say "Active for
// <domain>" as soon as the settings were saved, which is no longer true: until
// the record is found, SSO is off. It now shows the record to add, with Copy
// and Check now, and "on" only once the domain is verified and this server can
// do SSO.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrgSsoVerification, { type SsoCheck } from '../../src/renderer/src/components/views/OrgSsoVerification'

const RECORD = { type: 'TXT' as const, name: 'acme.com', value: 'plexii-verify=AbCdEfGhIjKlMnOpQrStUvWxYz012345', alsoAt: '_plexii-verify.acme.com' }

let host: HTMLElement
let root: Root
const written: string[] = []
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  written.length = 0
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void written.push(t) } })
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (props: Partial<Parameters<typeof OrgSsoVerification>[0]> = {}): void => {
  act(() =>
    root.render(
      <OrgSsoVerification
        domain="acme.com"
        record={RECORD}
        verifiedAt={null}
        serverReady
        onCheck={async () => ({ verified: false, verifiedAt: null, message: 'not yet' })}
        {...props}
      />
    )
  )
}
const text = (): string => host.textContent ?? ''
const button = (name: RegExp): HTMLButtonElement => [...host.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''))!

describe('an unverified domain', () => {
  it('shows the TXT record to add, and says SSO stays off', () => {
    render()
    expect(text()).toContain('Not verified yet')
    expect(text()).toContain(RECORD.value)
    expect(text()).toContain('acme.com')
    expect(text()).toContain(RECORD.alsoAt)
    expect(text()).toMatch(/stays off/i)
    expect(text()).not.toMatch(/Active|is on/i)
  })

  it('Copy puts exactly the record value on the clipboard', async () => {
    render()
    await act(async () => button(/Copy/).click())
    expect(written).toEqual([RECORD.value])
  })

  it('Check now asks the server and shows its answer; a found record turns it verified', async () => {
    const answers: SsoCheck[] = [
      { verified: false, verifiedAt: null, message: 'Add a TXT record to acme.com with the value plexii-verify=…, then press Check now.' },
      { verified: true, verifiedAt: Date.UTC(2026, 10, 20, 6, 0), message: 'acme.com is verified.' }
    ]
    const onCheck = vi.fn(async () => answers.shift()!)
    render({ onCheck })
    await act(async () => button(/Check now/).click())
    expect(onCheck).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[role=status]')?.textContent).toContain('Add a TXT record to acme.com')
    expect(text()).toContain('Not verified yet')
    await act(async () => button(/Check now/).click())
    expect(text()).toContain('Verified')
    expect(text()).toMatch(/Single sign-on is on for acme\.com/)
  })
})

describe('a verified domain', () => {
  it('says SSO is on only when this server can do SSO', () => {
    render({ verifiedAt: Date.UTC(2026, 10, 20) })
    expect(text()).toMatch(/Single sign-on is on for acme\.com/)
    expect(text()).not.toContain(RECORD.value)
  })

  it('verified but the server is not set up for SSO: it does not claim SSO is on', () => {
    render({ verifiedAt: Date.UTC(2026, 10, 20), serverReady: false })
    expect(text()).toContain('Verified')
    expect(text()).not.toMatch(/is on/i)
  })
})
