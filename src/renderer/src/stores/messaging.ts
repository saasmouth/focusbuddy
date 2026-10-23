import { create } from 'zustand'
import type {
  ChatMessage,
  ConversationSummary,
  InboxItem,
  MessageAttachment
} from '../lib/messagingClient'
import * as api from '../lib/messagingClient'
import {
  connectMessagingSocket,
  disconnectMessagingSocket,
  setReactionHandler,
  setMessageEditHandler,
  setMessageDeleteHandler,
  setTypingHandler,
  sendTyping as socketSendTyping,
  type ReactionEvent
} from '../lib/messagingSocket'
import { usePresenceStore } from './presence'
import { useAccountStore } from './account'
import { maybeIngestBrief } from '../lib/briefInbox'
import { useViewStore } from './view'
import { useOrgStore, PERSONAL_ORG_ID } from './org'
import { notifyExternal } from '../lib/notify'
import { bodyMentionsHandle } from '../lib/mentions'
import { personDisplayName } from '../lib/personName'

// Apply a reaction add/remove to a message in the conversation map, immutably and
// idempotently (so the actor's own optimistic update plus the echoed broadcast do
// not double count). Returns a new messagesByConv.
// Throttle outbound typing pings so a fast typist sends at most one every 2s.
let lastTypingSentAt = 0

type ThreadState = {
  messagesByConv: Record<string, ChatMessage[]>
  threadsByParent: Record<string, ChatMessage[]>
}

// Route an incoming message into the right place: a threaded reply goes into its
// open thread (if loaded) and bumps the parent's reply count, never entering the
// main timeline; a top-level message appends to the main timeline. Pure and
// dedupes by id, so an echoed message is folded in idempotently.
export function routeIncomingMessage(state: ThreadState, conversationId: string, message: ChatMessage): ThreadState {
  if (message.parentId) {
    const parentId = message.parentId
    const thread = state.threadsByParent[parentId]
    const threadsByParent =
      thread && !thread.some((m) => m.id === message.id)
        ? { ...state.threadsByParent, [parentId]: [...thread, message] }
        : state.threadsByParent
    const conv = state.messagesByConv[conversationId]
    // Only bump the count once, when we are first seeing this reply.
    const alreadySeen = thread?.some((m) => m.id === message.id) ?? false
    const messagesByConv =
      conv && !alreadySeen
        ? {
            ...state.messagesByConv,
            [conversationId]: conv.map((m) =>
              m.id === parentId ? { ...m, replyCount: (m.replyCount ?? 0) + 1 } : m
            )
          }
        : state.messagesByConv
    return { messagesByConv, threadsByParent }
  }
  const existing = state.messagesByConv[conversationId] ?? []
  if (existing.some((m) => m.id === message.id)) return state
  return {
    messagesByConv: { ...state.messagesByConv, [conversationId]: [...existing, message] },
    threadsByParent: state.threadsByParent
  }
}

export function applyReaction(
  byConv: Record<string, ChatMessage[]>,
  e: ReactionEvent
): Record<string, ChatMessage[]> {
  const list = byConv[e.conversationId]
  if (!list) return byConv
  let changed = false
  const next = list.map((m) => {
    if (m.id !== e.messageId) return m
    const reactions = (m.reactions ?? []).map((r) => ({ emoji: r.emoji, accountIds: [...r.accountIds] }))
    let entry = reactions.find((r) => r.emoji === e.emoji)
    if (e.added) {
      if (!entry) {
        entry = { emoji: e.emoji, accountIds: [] }
        reactions.push(entry)
      }
      if (!entry.accountIds.includes(e.accountId)) entry.accountIds.push(e.accountId)
    } else if (entry) {
      entry.accountIds = entry.accountIds.filter((id) => id !== e.accountId)
    }
    changed = true
    return { ...m, reactions: reactions.filter((r) => r.accountIds.length > 0) }
  })
  return changed ? { ...byConv, [e.conversationId]: next } : byConv
}

// Apply a transform to one message within a conversation's list, returning a new
// map only if it changed (keeps referential stability for unaffected lists).
export function mapMessage(
  byConv: Record<string, ChatMessage[]>,
  conversationId: string,
  messageId: string,
  fn: (m: ChatMessage) => ChatMessage
): Record<string, ChatMessage[]> {
  const list = byConv[conversationId]
  if (!list) return byConv
  let changed = false
  const next = list.map((m) => {
    if (m.id !== messageId) return m
    changed = true
    return fn(m)
  })
  return changed ? { ...byConv, [conversationId]: next } : byConv
}

// Same, for the per-parent thread reply lists (the edited/deleted message may be
// a reply, or a parent whose copy is also shown in an open thread panel).
export function mapThreadMessage(
  byParent: Record<string, ChatMessage[]>,
  messageId: string,
  fn: (m: ChatMessage) => ChatMessage
): Record<string, ChatMessage[]> {
  let changed = false
  const out: Record<string, ChatMessage[]> = {}
  for (const [parent, list] of Object.entries(byParent)) {
    let listChanged = false
    const next = list.map((m) => {
      if (m.id !== messageId) return m
      listChanged = true
      changed = true
      return fn(m)
    })
    out[parent] = listChanged ? next : list
  }
  return changed ? out : byParent
}

// Messaging store — the cohesive client state behind direct messages, shared
// spaces and the unified-inbox unread badge. REST loads history; the socket
// pushes new messages in real time into the same state.

interface MessagingStore {
  token: string | null
  conversations: ConversationSummary[]
  messagesByConv: Record<string, ChatMessage[]>
  inboxItems: InboxItem[]
  activeId: string | null
  unreadTotal: number
  connected: boolean
  // conversationId -> accountId -> who is typing and when we last heard. The UI
  // shows recent entries and they self-clear on a timeout.
  typingByConv: Record<string, Record<string, { handle: string; name: string; at: number }>>
  // parentMessageId -> the replies loaded for that thread.
  threadsByParent: Record<string, ChatMessage[]>
  // The parent message whose thread panel is open, or null.
  activeThreadId: string | null
  // A composer draft queued by the AI post-chat proposal: consumed (once) by
  // ChatComposer when its conversation becomes active. Draft only — the human
  // presses send.
  pendingDraft: { conversationId: string; text: string } | null
  // DEC-127 — a message to land on once its conversation (and, for a reply,
  // its thread) is on screen: set by the route back from an Attention item,
  // consumed once by the view that lands. `at` lets a landing that never
  // finds its message expire instead of firing weeks later.
  landOnMessage: { messageId: string; parentId: string | null; at: number } | null

  connect: (token: string) => Promise<void>
  disconnect: () => void
  refreshConversations: () => Promise<void>
  refreshInbox: () => Promise<void>
  openConversation: (id: string) => Promise<void>
  setPendingDraft: (draft: { conversationId: string; text: string } | null) => void
  /** Alias used by the AI applier: open a conversation as the active one. */
  setActive: (id: string) => Promise<void>
  startDm: (handle: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
  send: (body: string, attachment?: MessageAttachment | null) => Promise<void>
  react: (messageId: string, emoji: string) => Promise<void>
  editMessage: (messageId: string, body: string) => Promise<boolean>
  deleteMessage: (messageId: string) => Promise<boolean>
  // PlexiChat P4: drop one AI-proposal card from a message after it is applied or
  // dismissed, so it does not linger. Local only; proposals are not persisted per
  // user, they are a one-time offer on the message.
  consumeProposal: (conversationId: string, messageId: string, proposalId: string) => void
  openThread: (parentId: string) => Promise<void>
  closeThread: () => void
  landOn: (messageId: string | null, parentId?: string | null) => void
  sendThreadReply: (parentId: string, body: string) => Promise<void>
  notifyTyping: () => void
  browseChannels: (orgId: string) => Promise<api.OrgChannel[]>
  createChannel: (orgId: string, name: string) => Promise<{ ok: true; id: string } | { ok: false; error: string }>
  joinChannel: (conversationId: string) => Promise<void>
  // Open (get-or-create) the chat channel bound to a Room/Desk/Document and jump to
  // it. memberIds = the object's collaborators (the caller is added server-side).
  openObjectChannel: (
    objectKind: 'room' | 'desk' | 'document',
    objectId: string,
    title: string,
    memberIds?: string[]
  ) => Promise<void>
  // Get-or-create the channel bound to an object and return its id WITHOUT
  // switching the active view. For the on-desk chat widget, which binds to the
  // desk's channel but keeps the user on the canvas.
  resolveObjectChannel: (
    objectKind: 'room' | 'desk' | 'document',
    objectId: string,
    title: string,
    memberIds?: string[]
  ) => Promise<string | null>
  // Load a conversation's history into messagesByConv without making it active,
  // so a widget can show a channel the user has not opened in Messages. No-op if
  // already loaded. Live updates then arrive via the same socket handler.
  ensureConversationLoaded: (conversationId: string) => Promise<void>
  // Send into an arbitrary conversation (not necessarily the active one), for the
  // on-desk chat widget's inline composer.
  sendToConversation: (
    conversationId: string,
    body: string,
    attachment?: MessageAttachment | null
  ) => Promise<void>
  archiveObjectChannel: (objectKind: 'room' | 'desk' | 'document', objectId: string) => Promise<void>
  // Slack-class polish (P6): search + pinned messages.
  search: (query: string) => Promise<api.SearchHit[]>
  pinsByConv: Record<string, ChatMessage[]>
  loadPins: (conversationId: string) => Promise<void>
  pin: (conversationId: string, messageId: string) => Promise<void>
  unpin: (conversationId: string, messageId: string) => Promise<void>
  activity: api.ActivityItem[]
  loadActivity: () => Promise<void>
  setNotif: (conversationId: string, level: 'all' | 'mentions' | 'muted') => Promise<void>
  addMemberByHandle: (conversationId: string, handle: string) => Promise<{ ok: boolean; error?: string }>
  removeMember: (conversationId: string, accountId: string) => Promise<void>
  setVisibility: (conversationId: string, visibility: 'public' | 'private') => Promise<void>
  inviteContact: (
    email: string
  ) => Promise<{ ok: true; status: 'requested' | 'invited' } | { ok: false; error: string }>
  acceptContactRequest: (requestId: string) => Promise<void>
  declineContactRequest: (requestId: string) => Promise<void>
}

export const useMessagingStore = create<MessagingStore>((set, get) => ({
  token: null,
  conversations: [],
  messagesByConv: {},
  inboxItems: [],
  activeId: null,
  pendingDraft: null,
  unreadTotal: 0,
  connected: false,
  typingByConv: {},
  threadsByParent: {},
  pinsByConv: {},
  activity: [],
  activeThreadId: null,
  landOnMessage: null,

  connect: async (token) => {
    set({ token, connected: true })
    // Real-time: append pushed messages, then refresh the conversation list so
    // unread counts + ordering stay correct. If the pushed message is for the
    // open conversation, mark it read immediately.
    connectMessagingSocket(token, (incoming) => {
      const { activeId, conversations } = get()
      set((s) => routeIncomingMessage(s, incoming.conversationId, incoming.message))
      // Desktop notification when the app is in the background. notifyExternal
      // self-suppresses when the window is focused, so no banner for the chat you
      // are reading. Resolve a friendly sender name from the conversation members.
      const conv = conversations.find((c) => c.id === incoming.conversationId)
      const senderMember = conv?.members.find((m) => m.accountId === incoming.message.fromAccount)
      const sender = personDisplayName(senderMember, 'New message')
      // Q14 — a live-delivered meeting brief offers the per-series follow.
      // Idempotent via the inbox ledger, so the history load below cannot
      // double-act on the same message.
      maybeIngestBrief(incoming.message, sender)
      const preview = incoming.message.body || (incoming.message.attachment ? 'Shared something' : '')
      // A message that @mentions the signed-in handle alerts even while the
      // app is focused elsewhere: being named is the one chat event that
      // should cut through.
      const myHandle = useAccountStore.getState().account?.handle ?? null
      const mentioned = bodyMentionsHandle(incoming.message.body ?? '', myHandle)
      // Honour the member's per-conversation notification level: muted = never,
      // mentions = only when named, all = every message. A mention still cuts
      // through 'mentions' but not 'muted' (mute is absolute).
      const level = conv?.notifLevel ?? 'all'
      const shouldNotify = level === 'all' || (level === 'mentions' && mentioned)
      if (shouldNotify) {
        notifyExternal(
          mentioned ? `${sender} mentioned you` : conv ? conv.title : sender,
          conv ? `${sender}: ${preview}` : preview,
          {
            force: mentioned,
            tag: `msg-${incoming.conversationId}`,
            onClick: () => {
              useViewStore.getState().goMessages()
              void get().openConversation(incoming.conversationId)
            }
          }
        )
      }
      void get().refreshConversations()
      if (incoming.conversationId === activeId) {
        void api.markRead(token, incoming.conversationId)
      }
    })
    // Live emoji reactions: apply each add/remove to the message in place.
    setReactionHandler((e) => set((s) => ({ messagesByConv: applyReaction(s.messagesByConv, e) })))
    // Live edits / deletes: update the message in place across the conversation
    // list and any open thread.
    setMessageEditHandler((e) =>
      set((s) => ({
        messagesByConv: mapMessage(s.messagesByConv, e.conversationId, e.messageId, (m) => ({
          ...m,
          body: e.body,
          editedAt: e.editedAt
        })),
        threadsByParent: mapThreadMessage(s.threadsByParent, e.messageId, (m) => ({ ...m, body: e.body, editedAt: e.editedAt }))
      }))
    )
    setMessageDeleteHandler((e) =>
      set((s) => ({
        messagesByConv: mapMessage(s.messagesByConv, e.conversationId, e.messageId, (m) => ({
          ...m,
          body: '',
          attachment: null,
          deletedAt: Date.now()
        })),
        threadsByParent: mapThreadMessage(s.threadsByParent, e.messageId, (m) => ({
          ...m,
          body: '',
          attachment: null,
          deletedAt: Date.now()
        }))
      }))
    )
    // Live typing indicators: record who is typing, and clear them after a short
    // timeout unless a fresher ping arrives.
    setTypingHandler((e) => {
      const at = Date.now()
      set((s) => ({
        typingByConv: {
          ...s.typingByConv,
          [e.conversationId]: {
            ...(s.typingByConv[e.conversationId] ?? {}),
            [e.accountId]: { handle: e.handle, name: personDisplayName(e, e.handle), at }
          }
        }
      }))
      window.setTimeout(() => {
        set((s) => {
          const conv = s.typingByConv[e.conversationId]
          if (!conv || conv[e.accountId]?.at !== at) return s
          const nextConv = { ...conv }
          delete nextConv[e.accountId]
          return { typingByConv: { ...s.typingByConv, [e.conversationId]: nextConv } }
        })
      }, 5000)
    })
    // Join account-level presence on the same socket once we're connected.
    usePresenceStore.getState().start()
    await get().refreshConversations()
  },

  disconnect: () => {
    usePresenceStore.getState().stop()
    disconnectMessagingSocket()
    set({
      token: null,
      connected: false,
      conversations: [],
      messagesByConv: {},
      inboxItems: [],
      activeId: null,
      unreadTotal: 0,
      typingByConv: {},
      threadsByParent: {},
      pinsByConv: {},
      activeThreadId: null
    })
  },

  refreshConversations: async () => {
    const { token } = get()
    if (!token) return
    const conversations = await api.listConversations(token)
    const unreadTotal = conversations.reduce((sum, c) => sum + c.unreadCount, 0)
    set({ conversations, unreadTotal })
    void get().refreshInbox()
  },

  refreshInbox: async () => {
    const { token } = get()
    if (!token) return
    const { items } = await api.getUnifiedInbox(token)
    set({ inboxItems: items })
  },

  setPendingDraft: (draft) => set({ pendingDraft: draft }),
  setActive: async (id) => {
    await get().openConversation(id)
  },
  openConversation: async (id) => {
    const { token } = get()
    if (!token) return
    // Switching conversations closes any open thread panel.
    set({ activeId: id, activeThreadId: null })
    const messages = await api.getMessages(token, id)
    set((s) => ({ messagesByConv: { ...s.messagesByConv, [id]: messages } }))
    // Q14 — an attendee who was AWAY at wrap-up meets the brief here, on
    // history load. The ledger makes this scan idempotent across opens.
    const convMembers = get().conversations.find((c) => c.id === id)?.members ?? []
    for (const m of messages) {
      const from = convMembers.find((mm) => mm.accountId === m.fromAccount)
      maybeIngestBrief(m, personDisplayName(from, 'Someone'))
    }
    await api.markRead(token, id)
    await get().refreshConversations()
  },

  startDm: async (handle) => {
    const { token } = get()
    if (!token) return { ok: false, error: 'Sign in to send messages.' }
    const user = await api.lookupUser(token, handle)
    if (!user) return { ok: false, error: 'No user with that handle.' }
    const id = await api.startDm(token, handle)
    if (!id) return { ok: false, error: 'Could not start the conversation.' }
    await get().refreshConversations()
    await get().openConversation(id)
    return { ok: true, id }
  },

  send: async (body, attachment = null) => {
    const { token, activeId } = get()
    if (!token || !activeId) return
    const trimmed = body.trim()
    if (!trimmed && !attachment) return
    const message = await api.sendMessage(token, activeId, trimmed, attachment)
    if (!message) return
    set((s) => {
      const existing = s.messagesByConv[activeId] ?? []
      if (existing.some((m) => m.id === message.id)) return s
      return { messagesByConv: { ...s.messagesByConv, [activeId]: [...existing, message] } }
    })
    await get().refreshConversations()
  },

  react: async (messageId, emoji) => {
    const { token, activeId, messagesByConv } = get()
    if (!token || !activeId) return
    const me = useAccountStore.getState().account?.id
    if (!me) return
    const msg = (messagesByConv[activeId] ?? []).find((m) => m.id === messageId)
    if (!msg) return
    const mine = (msg.reactions ?? []).find((r) => r.emoji === emoji)?.accountIds.includes(me) ?? false
    // Optimistically toggle, then call the server. The server echoes the change
    // back over the socket, which applyReaction folds in idempotently.
    set((s) => ({ messagesByConv: applyReaction(s.messagesByConv, { conversationId: activeId, messageId, emoji, accountId: me, added: !mine }) }))
    if (mine) await api.removeReaction(token, activeId, messageId, emoji)
    else await api.addReaction(token, activeId, messageId, emoji)
  },

  editMessage: async (messageId, body) => {
    const { token, activeId } = get()
    if (!token || !activeId) return false
    const trimmed = body.trim()
    if (!trimmed) return false
    const updated = await api.editMessage(token, activeId, messageId, trimmed)
    if (!updated) return false
    set((s) => ({
      messagesByConv: mapMessage(s.messagesByConv, activeId, messageId, (m) => ({
        ...m,
        body: updated.body,
        editedAt: updated.editedAt ?? Date.now()
      })),
      threadsByParent: mapThreadMessage(s.threadsByParent, messageId, (m) => ({
        ...m,
        body: updated.body,
        editedAt: updated.editedAt ?? Date.now()
      }))
    }))
    return true
  },

  deleteMessage: async (messageId) => {
    const { token, activeId } = get()
    if (!token || !activeId) return false
    const ok = await api.deleteMessage(token, activeId, messageId)
    if (!ok) return false
    set((s) => ({
      messagesByConv: mapMessage(s.messagesByConv, activeId, messageId, (m) => ({
        ...m,
        body: '',
        attachment: null,
        deletedAt: Date.now()
      })),
      threadsByParent: mapThreadMessage(s.threadsByParent, messageId, (m) => ({
        ...m,
        body: '',
        attachment: null,
        deletedAt: Date.now()
      }))
    }))
    void get().refreshConversations()
    return true
  },

  consumeProposal: (conversationId, messageId, proposalId) => {
    set((s) => ({
      messagesByConv: mapMessage(s.messagesByConv, conversationId, messageId, (m) => ({
        ...m,
        proposals: (m.proposals ?? []).filter((p) => p.id !== proposalId)
      }))
    }))
  },

  openThread: async (parentId) => {
    const { token, activeId } = get()
    if (!token || !activeId) return
    set({ activeThreadId: parentId })
    const replies = await api.getThreadReplies(token, activeId, parentId)
    set((s) => ({ threadsByParent: { ...s.threadsByParent, [parentId]: replies } }))
  },

  closeThread: () => set({ activeThreadId: null }),
  landOn: (messageId, parentId = null) =>
    set({ landOnMessage: messageId ? { messageId, parentId: parentId ?? null, at: Date.now() } : null }),

  sendThreadReply: async (parentId, body) => {
    const { token, activeId } = get()
    if (!token || !activeId) return
    const trimmed = body.trim()
    if (!trimmed) return
    const message = await api.sendMessage(token, activeId, trimmed, null, parentId)
    if (!message) return
    set((s) => {
      const thread = s.threadsByParent[parentId] ?? []
      const nextThread = thread.some((m) => m.id === message.id) ? thread : [...thread, message]
      const conv = s.messagesByConv[activeId]
      const nextConv = conv
        ? conv.map((m) => (m.id === parentId ? { ...m, replyCount: (m.replyCount ?? 0) + 1 } : m))
        : conv
      return {
        threadsByParent: { ...s.threadsByParent, [parentId]: nextThread },
        messagesByConv: nextConv ? { ...s.messagesByConv, [activeId]: nextConv } : s.messagesByConv
      }
    })
    await get().refreshConversations()
  },

  notifyTyping: () => {
    const { activeId } = get()
    if (!activeId) return
    const now = Date.now()
    if (now - lastTypingSentAt < 2000) return
    lastTypingSentAt = now
    socketSendTyping(activeId)
  },

  browseChannels: async (orgId) => {
    const { token } = get()
    if (!token) return []
    return api.listOrgChannels(token, orgId)
  },

  createChannel: async (orgId, name) => {
    const { token } = get()
    if (!token) return { ok: false, error: 'Not signed in.' }
    const trimmed = name.trim()
    if (!trimmed) return { ok: false, error: 'A channel needs a name.' }
    const id = await api.createChannel(token, orgId, trimmed)
    if (!id) return { ok: false, error: 'Could not create the channel.' }
    await get().refreshConversations()
    await get().openConversation(id)
    return { ok: true, id }
  },

  joinChannel: async (conversationId) => {
    const { token } = get()
    if (!token) return
    const ok = await api.joinChannel(token, conversationId)
    if (!ok) return
    await get().refreshConversations()
    await get().openConversation(conversationId)
  },

  openObjectChannel: async (objectKind, objectId, title, memberIds) => {
    const { token } = get()
    if (!token) return
    const activeOrg = useOrgStore.getState().activeOrgId
    const orgId = activeOrg && activeOrg !== PERSONAL_ORG_ID ? activeOrg : null
    const id = await api.getOrCreateObjectChannel(token, { objectKind, objectId, orgId, memberIds, title })
    if (!id) return
    await get().refreshConversations()
    await get().openConversation(id)
  },

  resolveObjectChannel: async (objectKind, objectId, title, memberIds) => {
    const { token } = get()
    if (!token) return null
    const activeOrg = useOrgStore.getState().activeOrgId
    const orgId = activeOrg && activeOrg !== PERSONAL_ORG_ID ? activeOrg : null
    const id = await api.getOrCreateObjectChannel(token, { objectKind, objectId, orgId, memberIds, title })
    if (id) void get().refreshConversations()
    return id ?? null
  },

  ensureConversationLoaded: async (conversationId) => {
    const { token, messagesByConv } = get()
    if (!token || messagesByConv[conversationId]) return
    const messages = await api.getMessages(token, conversationId)
    set((s) => ({ messagesByConv: { ...s.messagesByConv, [conversationId]: messages } }))
  },

  sendToConversation: async (conversationId, body, attachment = null) => {
    const { token } = get()
    if (!token) return
    const trimmed = body.trim()
    if (!trimmed && !attachment) return
    const message = await api.sendMessage(token, conversationId, trimmed, attachment)
    if (!message) return
    set((s) => {
      const existing = s.messagesByConv[conversationId] ?? []
      if (existing.some((m) => m.id === message.id)) return s
      return { messagesByConv: { ...s.messagesByConv, [conversationId]: [...existing, message] } }
    })
    void get().refreshConversations()
  },

  archiveObjectChannel: async (objectKind, objectId) => {
    const { token } = get()
    if (!token) return
    await api.archiveObjectChannel(token, objectKind, objectId)
    await get().refreshConversations()
  },

  search: async (query) => {
    const { token } = get()
    if (!token || !query.trim()) return []
    return api.searchMessages(token, query.trim())
  },

  loadPins: async (conversationId) => {
    const { token } = get()
    if (!token) return
    const pins = await api.listPins(token, conversationId)
    set({ pinsByConv: { ...get().pinsByConv, [conversationId]: pins } })
  },

  pin: async (conversationId, messageId) => {
    const { token } = get()
    if (!token) return
    await api.pinMessage(token, conversationId, messageId)
    await get().loadPins(conversationId)
  },

  unpin: async (conversationId, messageId) => {
    const { token } = get()
    if (!token) return
    await api.unpinMessage(token, conversationId, messageId)
    await get().loadPins(conversationId)
  },

  loadActivity: async () => {
    const { token } = get()
    if (!token) return
    set({ activity: await api.getActivity(token) })
  },

  setNotif: async (conversationId, level) => {
    const { token } = get()
    if (!token) return
    await api.setNotifLevel(token, conversationId, level)
    await get().refreshConversations()
  },

  addMemberByHandle: async (conversationId, handle) => {
    const { token } = get()
    if (!token) return { ok: false, error: 'Not signed in.' }
    const res = await api.addConversationMember(token, conversationId, handle.trim().replace(/^@/, ''))
    if (res.ok) await get().refreshConversations()
    return res
  },

  removeMember: async (conversationId, accountId) => {
    const { token } = get()
    if (!token) return
    await api.removeConversationMember(token, conversationId, accountId)
    await get().refreshConversations()
  },

  setVisibility: async (conversationId, visibility) => {
    const { token } = get()
    if (!token) return
    await api.setConversationVisibility(token, conversationId, visibility)
    await get().refreshConversations()
  },

  inviteContact: async (email) => {
    const { token } = get()
    if (!token) return { ok: false, error: 'Sign in first.' }
    const r = await api.inviteContact(token, email)
    if (!r.ok || !r.status) return { ok: false, error: r.error ?? 'Could not send the invite.' }
    await get().refreshInbox()
    return { ok: true, status: r.status }
  },

  acceptContactRequest: async (requestId) => {
    const { token } = get()
    if (!token) return
    const conversationId = await api.acceptContact(token, requestId)
    await get().refreshConversations()
    if (conversationId) await get().openConversation(conversationId)
  },

  declineContactRequest: async (requestId) => {
    const { token } = get()
    if (!token) return
    await api.declineContact(token, requestId)
    await get().refreshInbox()
  }
}))

// Mirror the conversation list to the main process whenever it changes, so the
// AI prompt builder can surface real conversation ids for post-chat drafts.
// Fire-and-forget; a failed mirror only means the AI omits chat targets.
useMessagingStore.subscribe((state, prev) => {
  if (state.conversations === prev.conversations) return
  void window.api.ai
    .setConversationSnapshot(state.conversations.map((c) => ({ id: c.id, label: c.title || c.id })))
    .catch(() => {})
})

// Expose the messaging store on window so e2e specs can open a conversation in a
// signed-in session they seeded (beside __fbAccount). A thin handle to the real
// store, not a mock; it changes nothing about how the app behaves.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbMessaging?: typeof useMessagingStore }).__fbMessaging = useMessagingStore
}
