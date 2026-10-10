// A real mount of the mail setup screen's provider presets, Zoho in particular.
//
// Zoho's IMAP server depends on two choices the other providers do not have: the
// datacentre the account lives in, and whether it is a paid organisation account
// on its own domain (the "pro" hosts) or a personal / free-plan one. Getting
// either wrong does not fail loudly — the wrong region's server refuses the login
// and the user is told their password is wrong — so what is checked here is the
// exact host the form hands to the connection test for every combination, and
// that the send server smtp.ts derives from it is the matching Zoho one.
//
// The expected hosts are written out independently of MailView's own table, so a
// typo in either shows up as a failure. Each was checked on 2026-10-10 to resolve
// and present a certificate valid for its name on 993 (IMAP) and 465 (SMTP).

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveSmtp } from '../../src/main/mail/smtp'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
// MailView renders the setup form when no account is connected; everything else
// it imports is for the connected inbox and is not under test. The stores pull in
// the whole app graph, so each is replaced with just the slice MailView reads.
const testAccount = vi.fn()
const saveAccount = vi.fn()
const mailState = {
  account: null,
  loadedAccount: true,
  messages: [],
  open: null,
  openUid: null,
  loadingList: false,
  error: null,
  hasMore: false,
  loadingMore: false,
  total: 0,
  composing: null,
  loadAccount: vi.fn(),
  refresh: vi.fn(),
  loadMore: vi.fn(),
  openMessage: vi.fn(),
  disconnect: vi.fn(),
  startCompose: vi.fn(),
  closeCompose: vi.fn(),
  archive: vi.fn(),
  testAccount,
  saveAccount
}
vi.mock('../../src/renderer/src/stores/mail', () => ({
  useMailStore: Object.assign((sel: (s: unknown) => unknown) => sel(mailState), {
    getState: () => mailState
  }),
  selectMailUnread: () => 0
}))
vi.mock('../../src/renderer/src/stores/mailTags', () => ({
  useMailTagStore: (sel: (s: unknown) => unknown) =>
    sel({
      tags: [],
      scope: { kind: 'inbox' },
      setScope: vi.fn(),
      refresh: vi.fn(),
      pin: vi.fn(),
      exclude: vi.fn()
    })
}))
vi.mock('../../src/renderer/src/stores/view', () => ({
  useViewStore: (sel: (s: unknown) => unknown) => sel({ view: { kind: 'mail' } })
}))
vi.mock('../../src/renderer/src/stores/nodes', () => ({ useNodeStore: vi.fn() }))
vi.mock('../../src/renderer/src/stores/widgets', () => ({ useWidgetStore: vi.fn() }))
vi.mock('../../src/renderer/src/stores/notice', () => ({ useNoticeStore: vi.fn() }))
vi.mock('../../src/renderer/src/components/mail/MailTagRail', () => ({
  default: () => null,
  COLOUR_DOT: {}
}))
vi.mock('../../src/renderer/src/components/mail/MailTagEditor', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/mail/MailTriagePanel', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/mail/MailSearchBar', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/mail/EmailTaskDialog', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/ComposeDialog', () => ({ default: () => null }))

import MailView from '../../src/renderer/src/components/views/MailView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ZOHO_REGIONS: [label: string, domain: string][] = [
  ['US', 'zoho.com'],
  ['EU', 'zoho.eu'],
  ['UK', 'zoho.uk'],
  ['India', 'zoho.in'],
  ['Australia', 'zoho.com.au'],
  ['Japan', 'zoho.jp'],
  ['Canada', 'zohocloud.ca'],
  ['Saudi Arabia', 'zoho.sa'],
  ['UAE', 'zoho.ae'],
  ['China', 'zoho.com.cn']
]
const ORG = 'Own domain (paid plan)'
const PERSONAL = '@zohomail.com or free plan'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(async () => {
  testAccount.mockReset().mockResolvedValue({ ok: true })
  saveAccount.mockReset().mockResolvedValue({ ok: true })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<MailView />)
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function button(label: string, scope: ParentNode = host): HTMLButtonElement {
  const b = Array.from(scope.querySelectorAll('button')).find((el) => el.textContent?.trim() === label)
  if (!b) throw new Error(`No button labelled "${label}"`)
  return b
}

async function click(label: string, scope?: ParentNode): Promise<void> {
  const b = button(label, scope)
  await act(async () => {
    b.click()
  })
}

// React tracks a controlled input's value itself, so assigning .value directly
// is ignored; going through the native setter and firing `input` is what a
// keystroke does.
async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const zohoRow = (): HTMLElement | null => host.querySelector('[data-testid="mail-zoho-options"]')
const pressed = (label: string, scope?: ParentNode): string | null =>
  button(label, scope).getAttribute('aria-pressed')
const connectingTo = (): string | undefined =>
  /Connecting to (\S+)/.exec(host.textContent ?? '')?.[1]

describe('Mail setup — provider presets', () => {
  it('keeps every existing provider and adds Zoho in the same chip row', () => {
    for (const label of ['Gmail', 'Outlook', 'iCloud', 'Fastmail', 'Yahoo', 'Zoho']) {
      expect(pressed(label)).toBe('false')
    }
    expect(zohoRow()).toBeNull()
  })

  it('opens Zoho on the US paid-plan host with Zoho’s setup hint', async () => {
    await click('Zoho')

    expect(pressed('Zoho')).toBe('true')
    const row = zohoRow()!
    expect(row).not.toBeNull()
    expect(pressed(ORG, row)).toBe('true')
    expect(pressed(PERSONAL, row)).toBe('false')
    expect(pressed('US', row)).toBe('true')
    expect(connectingTo()).toBe('imappro.zoho.com:993')
    expect(host.textContent).toContain('over SSL')

    const text = host.textContent ?? ''
    expect(text).toContain('Turn on IMAP Access first (Zoho Mail → Settings → Mail Accounts → IMAP)')
    expect(text).toContain('app-specific password (Zoho Accounts → Security → App Passwords)')
  })

  it('connects an Australian custom-domain account to imappro.zoho.com.au and sends via smtppro', async () => {
    await click('Zoho')
    await click('Australia', zohoRow()!)

    const inputs = host.querySelectorAll('input')
    await type(inputs[0] as HTMLInputElement, 'me@example.com.au')
    await type(inputs[1] as HTMLInputElement, 'app-pass')
    await click('Test connection')

    expect(testAccount).toHaveBeenCalledTimes(1)
    const config = testAccount.mock.calls[0][0]
    expect(config).toEqual({
      host: 'imappro.zoho.com.au',
      port: 993,
      secure: true,
      user: 'me@example.com.au',
      password: 'app-pass',
      email: 'me@example.com.au'
    })
    expect(deriveSmtp(config)).toEqual({ host: 'smtppro.zoho.com.au', port: 465, secure: true })
  })

  it.each(ZOHO_REGIONS)('pairs %s (%s) correctly for both plans, inbound and outbound', async (label, dc) => {
    await click('Zoho')

    await click(label, zohoRow()!)
    await click(ORG, zohoRow()!)
    expect(connectingTo()).toBe(`imappro.${dc}:993`)
    expect(deriveSmtp({ host: `imappro.${dc}`, port: 993, secure: true, user: 'u', password: 'p' }).host).toBe(
      `smtppro.${dc}`
    )
    expect(pressed(label, zohoRow()!)).toBe('true')

    await click(PERSONAL, zohoRow()!)
    expect(connectingTo()).toBe(`imap.${dc}:993`)
    expect(deriveSmtp({ host: `imap.${dc}`, port: 993, secure: true, user: 'u', password: 'p' }).host).toBe(
      `smtp.${dc}`
    )
    // Switching plan keeps the region, and the Zoho chip stays lit throughout.
    expect(pressed(label, zohoRow()!)).toBe('true')
    expect(pressed('Zoho')).toBe('true')
  })

  it('re-pressing Zoho keeps the region and plan already picked', async () => {
    await click('Zoho')
    await click('Australia', zohoRow()!)
    await click(PERSONAL, zohoRow()!)
    await click('Zoho')

    expect(connectingTo()).toBe('imap.zoho.com.au:993')
  })

  it('picking another provider closes the Zoho row and shows that provider’s hint', async () => {
    await click('Zoho')
    await click('Gmail')

    expect(zohoRow()).toBeNull()
    expect(pressed('Zoho')).toBe('false')
    expect(pressed('Gmail')).toBe('true')
    expect(connectingTo()).toBe('imap.gmail.com:993')
    expect(host.textContent).toContain('Google account → Security → App passwords')
    expect(host.textContent).not.toContain('Zoho Mail → Settings')
  })

  it('recognises a Zoho host typed by hand and lights its region and plan', async () => {
    await click('IMAP server settings')
    const server = host.querySelector('input[placeholder="imap.example.com"]') as HTMLInputElement
    await type(server, 'imap.zoho.eu')

    const row = zohoRow()!
    expect(row).not.toBeNull()
    expect(pressed('Zoho')).toBe('true')
    expect(pressed('EU', row)).toBe('true')
    expect(pressed(PERSONAL, row)).toBe('true')
    expect(host.textContent).toContain('Turn on IMAP Access first')
  })

  it('does not mistake a look-alike host for Zoho', async () => {
    await click('IMAP server settings')
    const server = host.querySelector('input[placeholder="imap.example.com"]') as HTMLInputElement
    for (const lookalike of ['imappro.zoho.example.com', 'imap.zohomail.com', 'mail.zoho.com.au']) {
      await type(server, lookalike)
      expect(zohoRow()).toBeNull()
      expect(pressed('Zoho')).toBe('false')
    }
  })
})
