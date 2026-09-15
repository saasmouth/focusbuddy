import { create } from 'zustand'
import { trailFor } from '../lib/replyTrail'
import { notifyExternal } from '../lib/notify'
import { useViewStore } from './view'
import type {
  MailAccountInput,
  MailAccountPublic,
  MailListItem,
  MailFullMessage,
  MailSendInput,
  EmailReplyDraftResult
} from '@shared/types'

// Mail store — the IMAP inbox the user connects with their own mailbox. All
// the IMAP work happens in the main process; this store holds the account
// status, the message list (envelope only), and the one open message body, and
// it drives both the dedicated Mail view and the email rows in the unified
// Inbox feed.

// Seed values for the compose window — new mail, reply, reply-all or forward.
// Lives here (not in the component) so any part of the app can open a composer
// through the store without a circular import.
export interface ComposeInitial {
  to?: string[]
  cc?: string[]
  bcc?: string[]
  subject?: string
  text?: string
  inReplyTo?: string | null
  references?: string[]
  aiDrafted?: boolean
}

interface MailStore {
  account: MailAccountPublic | null
  loadedAccount: boolean
  messages: MailListItem[]
  open: MailFullMessage | null
  openUid: number | null
  loadingList: boolean
  loadingOpen: boolean
  error: string | null
  // The compose window, when one is open. null = closed.
  composing: ComposeInitial | null
  // Proactive AI reply draft for the open message. draftUid ties the draft to
  // the message it was made for, so a fast click-through never shows a stale
  // draft against the wrong email.
  replyDraft: EmailReplyDraftResult | null
  draftUid: number | null
  loadingDraft: boolean

  loadAccount: () => Promise<void>
  saveAccount: (config: MailAccountInput) => Promise<{ ok: boolean; error?: string }>
  testAccount: (config: MailAccountInput) => Promise<{ ok: boolean; error?: string }>
  disconnect: () => Promise<void>
  refresh: () => Promise<void>
  /** Move a message to the archive mailbox; removes it from the inbox list. */
  archive: (uid: number) => Promise<{ ok: boolean; error?: string }>
  openMessage: (uid: number) => Promise<void>
  closeMessage: () => void
  // Send a message (new, reply, or reply-all). Returns the result so the
  // composer can show an inline error and stay open on failure.
  send: (input: MailSendInput) => Promise<{ ok: boolean; error?: string }>
  // Open / close the compose window.
  startCompose: (initial?: ComposeInitial) => void
  closeCompose: () => void
  // Build reply seed values from the currently-open message. `all` includes the
  // other recipients (reply-all); otherwise just the original sender.
  replyToOpen: (all: boolean) => ComposeInitial | null
  // Ask AI to draft a reply to a message in the user's voice. Runs
  // automatically when a message is opened (the user opted into proactive
  // drafts) and can be re-run manually.
  suggestReply: (msg: MailFullMessage) => Promise<void>
}

/** Count of unread messages in the current list — a derived selector. */
export const selectMailUnread = (s: MailStore): number =>
  s.messages.filter((m) => !m.seen).length

export const useMailStore = create<MailStore>((set, get) => ({
  account: null,
  loadedAccount: false,
  messages: [],
  open: null,
  openUid: null,
  loadingList: false,
  loadingOpen: false,
  error: null,
  composing: null,
  replyDraft: null,
  draftUid: null,
  loadingDraft: false,

  loadAccount: async () => {
    const account = await window.api.mail.getAccount()
    set({ account: account.configured ? account : null, loadedAccount: true })
    if (account.configured) void get().refresh()
  },

  saveAccount: async (config) => {
    const r = await window.api.mail.saveAccount(config)
    if (!r.ok) {
      set({ error: r.error })
      return { ok: false, error: r.error }
    }
    set({ account: r.account, error: null })
    void get().refresh()
    return { ok: true }
  },

  testAccount: async (config) => {
    const r = await window.api.mail.testAccount(config)
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  },

  disconnect: async () => {
    await window.api.mail.clearAccount()
    set({ account: null, messages: [], open: null, openUid: null, error: null })
  },

  refresh: async () => {
    if (!get().account) return
    set({ loadingList: true, error: null })
    // An IPC can REJECT as well as answer badly: a slow IMAP fetch that is
    // still in flight when the window reloads or closes comes back as
    // "reply was never sent". Unguarded that is an unhandled rejection --
    // eleven of them are in the crash log -- and the store already has the
    // right place to put a failure, so it goes there instead.
    let r: Awaited<ReturnType<typeof window.api.mail.list>>
    try {
      r = await window.api.mail.list(40)
    } catch (err) {
      set({
        loadingList: false,
        error: err instanceof Error ? err.message : 'The mailbox did not answer.'
      })
      return
    }
    if (!r.ok) {
      set({ loadingList: false, error: r.error })
      return
    }
    set({ messages: r.items, loadingList: false })
  },

  openMessage: async (uid) => {
    // Opening a different message clears any draft for the previous one.
    set({ loadingOpen: true, openUid: uid, error: null, replyDraft: null, draftUid: null })
    // Same reasoning as refresh: a rejection is a failure, not a crash.
    let r: Awaited<ReturnType<typeof window.api.mail.get>>
    try {
      r = await window.api.mail.get(uid)
    } catch (err) {
      set({
        loadingOpen: false,
        error: err instanceof Error ? err.message : 'That message could not be opened.'
      })
      return
    }
    if (!r.ok) {
      set({ loadingOpen: false, error: r.error })
      return
    }
    set({ open: r.message, loadingOpen: false })
    // Reflect the read state locally and on the server.
    set((s) => ({
      messages: s.messages.map((m) => (m.uid === uid ? { ...m, seen: true } : m))
    }))
    void window.api.mail.markSeen(uid)
    // Proactively draft a reply in the user's voice (their opt-in choice).
    void get().suggestReply(r.message)
  },

  closeMessage: () =>
    set({ open: null, openUid: null, replyDraft: null, draftUid: null, loadingDraft: false }),

  send: async (input) => {
    const r = await window.api.mail.send(input)
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  },

  archive: async (uid) => {
    const before = get().messages
    // Optimistic: drop it from the list; restore on failure with the error.
    set({ messages: before.filter((m) => m.uid !== uid), open: get().open?.uid === uid ? null : get().open })
    const r = await window.api.mail.archive(uid)
    if (!r.ok) {
      set({ messages: before, error: r.error ?? 'Could not archive that message.' })
      return { ok: false, error: r.error }
    }
    return { ok: true }
  },

  startCompose: (initial) => set({ composing: initial ?? {} }),
  closeCompose: () => set({ composing: null }),

  replyToOpen: (all) => {
    const { open, account } = get()
    if (!open) return null
    const self = (account?.email || account?.user || '').toLowerCase()
    const subject = /^re:/i.test(open.subject) ? open.subject : `Re: ${open.subject}`
    // Reply goes to the original sender. Reply-all adds the other To/Cc
    // recipients, minus the sender (already in To) and the user's own address.
    const to = [open.fromAddress].filter(Boolean)
    let cc: string[] = []
    if (all) {
      const senderLc = open.fromAddress.toLowerCase()
      cc = [...open.toAddresses, ...open.ccAddresses].filter(
        (a) => a && a.toLowerCase() !== self && a.toLowerCase() !== senderLc
      )
      // De-dupe while preserving order.
      cc = [...new Set(cc)]
    }
    // Quote the original under an attribution line, prefixing each line with "> ".
    const when = open.date ? new Date(open.date).toLocaleString() : ''
    const quoted = open.text
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
    const text = `\n\nOn ${when}, ${open.fromName} <${open.fromAddress}> wrote:\n${quoted}\n`
    // Thread the reply: In-Reply-To is the original Message-ID; References is
    // the original's chain with the Message-ID appended.
    const references = open.messageId
      ? [...open.references, open.messageId]
      : open.references
    return { to, cc, subject, text, inReplyTo: open.messageId, references }
  },

  suggestReply: async (msg) => {
    set({ loadingDraft: true, replyDraft: null, draftUid: msg.uid })
    const from = msg.fromAddress
      ? `${msg.fromName} <${msg.fromAddress}>`
      : msg.fromName || 'Unknown sender'
    try {
      // The rest of the conversation, oldest first. A reply drafted from the
      // latest message alone re-asks questions the thread already settled, so
      // the trail goes with it. Building it needs each earlier body, and a
      // failure to fetch one costs context rather than the draft.
      let trail: Array<{ from: string; date?: number; body: string }> = []
      try {
        const earlier = trailFor(
          {
            uid: msg.uid,
            subject: msg.subject,
            date: msg.date,
            messageId: msg.messageId,
            inReplyTo: null,
            references: (msg.references ?? []).join(' ')
          } as never,
          get().messages
        )
        trail = (
          await Promise.all(
            earlier.map(async (m) => {
              const full = await window.api.mail.get(m.uid)
              return full.ok
                ? {
                    from: m.fromAddress || m.fromName,
                    date: m.date,
                    body: full.message.text
                  }
                : null
            })
          )
        ).filter((x): x is { from: string; date: number; body: string } => x !== null)
      } catch {
        trail = []
      }
      const r = await window.api.mail.suggestReply(
        {
          subject: msg.subject,
          from,
          body: msg.text
        },
        trail
      )
      // A newer open may have superseded this draft while the call was in flight.
      if (get().draftUid !== msg.uid) return
      set({ replyDraft: r, loadingDraft: false })
    } catch (err) {
      // The IPC itself rejected (channel error, unexpected throw). Clear the
      // spinner and surface an honest failed draft instead of spinning forever.
      if (get().draftUid !== msg.uid) return
      set({
        replyDraft: { ok: false, error: err instanceof Error ? err.message : 'Could not draft a reply.' },
        loadingDraft: false
      })
    }
  }
}))

// New-mail banners: the main process announces unseen messages found during a
// fetch (batched, once per message per run). Clicking opens Mail on the item.
if (typeof window !== 'undefined' && window.api?.mail?.onNewMail) {
  window.api.mail.onNewMail(({ title, body, uid }) => {
    notifyExternal(title, body, {
      tag: `mail-${uid}`,
      onClick: () => {
        useViewStore.getState().goMail(uid)
      }
    })
  })
}
