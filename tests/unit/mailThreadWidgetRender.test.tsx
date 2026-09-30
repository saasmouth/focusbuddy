// A real mount of the mail-thread widget.
//
// The rest of this widget's tests are unit tests of the pieces -- the content
// whitelist, the quoted-history split, the store query. None of them would catch
// the widget rendering nothing, and "nothing" is precisely how its first two bugs
// presented: a conditional hook after an early return, and a blank tile from an
// unhandled kind.
//
// What is checked here is what someone actually sees, and specifically the states
// that are easy to get wrong because they look like success: a message whose body
// has not been fetched yet, and a message that is not in the local store at all.
// Both must SAY so. A blank card in either case is the No-Fakery failure -- it
// reads as "this email is empty" when the truth is "not read yet" or "not here".

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
// The widget only reads actions off these; the stores themselves pull in the
// whole app graph, which is not what is under test.
vi.mock('../../src/renderer/src/stores/mailModal', () => ({
  useMailModalStore: (sel: (s: unknown) => unknown) => sel({ open: vi.fn() })
}))
vi.mock('../../src/renderer/src/stores/view', () => ({
  useViewStore: (sel: (s: unknown) => unknown) => sel({ goMail: vi.fn() })
}))
vi.mock('../../src/renderer/src/stores/widgets', () => ({
  useWidgetStore: (sel: (s: unknown) => unknown) => sel({ update: vi.fn() })
}))

import MailThreadWidget from '../../src/renderer/src/components/widgets/MailThreadWidget'
import type { PinnedMailMessage, Widget } from '../../src/shared/types'

const message = (over: Partial<PinnedMailMessage> = {}): PinnedMailMessage => ({
  uid: 41,
  fromName: 'Dana Reed',
  fromAddress: 'dana@example.test',
  toText: 'me@example.test',
  subject: 'Strata levy notice',
  date: Date.UTC(2026, 2, 3, 9, 14),
  seen: true,
  hasAttachments: false,
  bodyText: 'The quarterly levy is due on the 14th.',
  attachments: [],
  ...over
})

const widget = (content: object, title = 'Email'): Widget =>
  ({ id: 'w1', kind: 'mail-thread', title, content: JSON.stringify(content) }) as unknown as Widget

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

const mount = async (w: Widget): Promise<void> => {
  await act(async () => {
    root.render(<MailThreadWidget widget={w} />)
  })
}

const setStored = (
  r: { ok: true; messages: PinnedMailMessage[] } | { ok: false; error: string }
): void => {
  ;(globalThis as { window?: unknown }).window = globalThis
  ;(globalThis as unknown as { api: unknown }).api = {
    mail: { storedThread: vi.fn().mockResolvedValue(r) }
  }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('MailThreadWidget', () => {
  it('renders a pinned email as a document', async () => {
    setStored({ ok: true, messages: [message()] })
    await mount(
      widget({ mode: 'one', uids: [41], subject: 'Strata levy notice' }, 'Strata levy notice')
    )

    const text = host.textContent ?? ''
    expect(text).toContain('Strata levy notice')
    expect(text).toContain('The quarterly levy is due on the 14th.')
    expect(text).toContain('Dana Reed')
  })

  it('names a card that was created without a subject snapshot', async () => {
    // Pinning from Mail always records the subject. A mail-thread widget proposed
    // by Plexii need only carry uids, and such a card used to sit on the desk
    // labelled "Email" while the message it displayed had a subject line.
    setStored({ ok: true, messages: [message()] })
    await mount(widget({ mode: 'one', uids: [41] }, ''))

    expect(host.textContent).toContain('Strata levy notice')
  })

  it('says a body has not been downloaded instead of showing an empty card', async () => {
    setStored({ ok: true, messages: [message({ bodyText: null })] })
    await mount(widget({ mode: 'one', uids: [41] }))

    expect(host.textContent).toMatch(/has not been downloaded/i)
  })

  it('distinguishes an empty body from a missing one', async () => {
    setStored({ ok: true, messages: [message({ bodyText: '' })] })
    await mount(widget({ mode: 'one', uids: [41] }))

    expect(host.textContent).toMatch(/no text body/i)
    expect(host.textContent).not.toMatch(/has not been downloaded/i)
  })

  it('says so, and names the message, when it is not in the local store', async () => {
    setStored({ ok: true, messages: [] })
    await mount(
      widget({ mode: 'one', uids: [41], subject: 'Strata levy notice', fromName: 'Dana Reed' })
    )

    const text = host.textContent ?? ''
    expect(text).toMatch(/not in PlexiDesk/i)
    // The snapshot is the point: the card is never anonymous, so the user can see
    // WHICH email is missing rather than an unexplained blank.
    expect(text).toContain('Strata levy notice')
    expect(text).toContain('Dana Reed')
  })

  it('surfaces a store error rather than looking empty', async () => {
    setStored({ ok: false, error: 'No mail account connected.' })
    await mount(widget({ mode: 'one', uids: [41] }))

    expect(host.textContent).toContain('No mail account connected.')
  })

  it('hides quoted reply history behind a disclosure and can show it', async () => {
    setStored({
      ok: true,
      messages: [
        message({
          bodyText:
            'Confirmed, the 14th works.\n\nOn Tue, 3 Mar 2026 at 09:14, Dana Reed wrote:\n> Is the 14th ok?\n> Dana'
        })
      ]
    })
    await mount(widget({ mode: 'one', uids: [41] }))

    expect(host.textContent).toContain('Confirmed, the 14th works.')
    expect(host.textContent).not.toContain('Is the 14th ok?')

    const toggle = [...host.querySelectorAll('button')].find((b) =>
      /quoted history/i.test(b.textContent ?? '')
    )
    expect(toggle, 'no disclosure for the quoted history').toBeTruthy()
    await act(async () => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(host.textContent).toContain('Is the 14th ok?')
  })

  it('attributes every message in a thread, and counts them', async () => {
    setStored({
      ok: true,
      messages: [
        message({ uid: 41, fromName: 'Dana Reed', bodyText: 'Is the 14th ok?' }),
        message({ uid: 42, fromName: 'Sam Okafor', bodyText: 'Works for me.' })
      ]
    })
    await mount(widget({ mode: 'thread', uids: [41], rootMessageId: '<a@x>' }))

    const text = host.textContent ?? ''
    expect(text).toContain('2 messages in this thread')
    expect(text).toContain('Dana Reed')
    expect(text).toContain('Sam Okafor')
    expect(text).toContain('Is the 14th ok?')
    expect(text).toContain('Works for me.')
  })

  it('lists attachments by name', async () => {
    setStored({
      ok: true,
      messages: [
        message({
          hasAttachments: true,
          attachments: [
            { filename: 'levy-notice.pdf', contentType: 'application/pdf', sizeBytes: 81_920 }
          ]
        })
      ]
    })
    await mount(widget({ mode: 'one', uids: [41] }))

    expect(host.textContent).toContain('levy-notice.pdf')
  })

  it('sends the pinned account key to the store, not just the uids', async () => {
    // The widget is the only thing that knows which mailbox it was pinned from.
    // Dropping the field here is what made a pinned email orphan itself.
    setStored({ ok: true, messages: [message()] })
    await mount(
      widget({ mode: 'one', uids: [41], accountKey: 'someone@example.test' })
    )

    const call = (globalThis as unknown as { api: { mail: { storedThread: { mock: { calls: unknown[][] } } } } })
      .api.mail.storedThread.mock.calls[0][0] as { accountKey?: string; uids: number[] }
    expect(call.accountKey).toBe('someone@example.test')
    expect(call.uids).toEqual([41])
  })

  it('survives a body arriving after the first render', async () => {
    // The exact shape of the conditional-hook bug: `bodyText` flips from null to
    // text when the sweep fetches it, and a hook after the null check changed the
    // hook order at precisely that moment.
    setStored({ ok: true, messages: [message({ bodyText: null })] })
    const w = widget({ mode: 'one', uids: [41] })
    await mount(w)
    expect(host.textContent).toMatch(/has not been downloaded/i)

    setStored({ ok: true, messages: [message({ bodyText: 'It arrived.' })] })
    await mount(widget({ mode: 'one', uids: [41], subject: 'refetch' }))
    expect(host.textContent).toContain('It arrived.')
  })
})
