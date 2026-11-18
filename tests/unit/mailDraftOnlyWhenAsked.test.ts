// Opening a message never sends it to AI by itself (4.3.50).
//
// openMessage used to call suggestReply on every open ("their opt-in choice",
// but no switch existed). Each opened email went to the AI source for a reply
// draft, unasked, and with no account and no key every open ended in "Could
// not draft a reply" (seen capturing 4.3.48 screens, 2026-11-17). It also
// contradicted the privacy notes, which say AI runs in the background only
// with Background AI tasks on. A reply is now drafted when the person presses
// Draft a reply (MailView, data-testid mail-draft-reply).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useMailStore } from '../../src/renderer/src/stores/mail'

const message = {
  uid: 7,
  subject: 'Lunch?',
  fromName: 'Ana',
  fromAddress: 'ana@example.com',
  date: 1_700_000_000_000,
  text: 'Are you free on Thursday?',
  html: null,
  attachments: [],
  messageId: '<7@example.com>',
  references: []
}

const suggestReply = vi.fn(async () => ({ ok: true, reply: 'Yes, Thursday works.' }))

beforeEach(() => {
  suggestReply.mockClear()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      mail: {
        get: vi.fn(async () => ({ ok: true, message })),
        markSeen: vi.fn(async () => ({ ok: true })),
        suggestReply
      }
    }
  }
  useMailStore.setState({ messages: [], open: null, openUid: null, replyDraft: null, draftUid: null, loadingDraft: false })
})

describe('Mail reply drafts', () => {
  it('opening a message does not ask AI for a draft', async () => {
    await useMailStore.getState().openMessage(7)
    await new Promise((r) => setTimeout(r, 20))
    expect(useMailStore.getState().open?.uid).toBe(7)
    expect(suggestReply).not.toHaveBeenCalled()
    expect(useMailStore.getState().loadingDraft).toBe(false)
    expect(useMailStore.getState().replyDraft).toBeNull()
  })

  it('asking for a draft does ask AI (the control: the stub sees a call when there is one)', async () => {
    await useMailStore.getState().openMessage(7)
    await useMailStore.getState().suggestReply(useMailStore.getState().open!)
    expect(suggestReply).toHaveBeenCalledTimes(1)
    expect(useMailStore.getState().replyDraft).toMatchObject({ ok: true, reply: 'Yes, Thursday works.' })
  })

  it('the open message offers Draft a reply, which asks for one', () => {
    const view = readFileSync(join(__dirname, '../../src/renderer/src/components/views/MailView.tsx'), 'utf8')
    const at = view.indexOf('data-testid="mail-draft-reply"')
    const button = at < 0 ? '' : view.slice(view.lastIndexOf('<button', at), view.indexOf('</button>', at))
    expect(button, 'a Draft a reply button in MailView').toContain('Draft a reply')
    expect(button).toMatch(/suggestReply\(open\)/)
  })
})
