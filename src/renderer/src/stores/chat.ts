import { create } from 'zustand'
import { useCompletionOffer } from './completionOffer'
import { conversationForDesk } from '../lib/deskConversation'
import { parseAttentionCommand } from '../lib/attentionCommand'
import { useAssistantChrome } from './assistantChrome'
import type { JSONContent } from '@tiptap/core'
import type {
  ActionProposal,
  AiChatConversationContext,
  AiChatConversationMeta,
  AppliedProposal,
  ChatMessage,
  ChatQuestion,
  ChatResponse,
  ChatSource,
  ChatUiBlock,
  AiChatMode,
  StoredTrace
} from '@shared/types'
import { recordTrail } from '../lib/trail'
import { gatherCanvasAttachments } from '../lib/canvasContent'
import type { AssistantTrace } from '../lib/traceView'
import {
  activeMentions,
  addMention,
  clearConversationMentions,
  mergeMentionResolution,
  removeMention,
  toWireMentions,
  type MentionRef,
  type MentionResolution
} from '../lib/assistantMentions'
import { linkTargetForApplied } from '../lib/conversationDesks'

function newTrace(): AssistantTrace {
  return {
    status: 'running',
    startedAt: Date.now(),
    retrievedAt: null,
    retrievalMs: null,
    repliedAt: null,
    completedAt: null,
    mentions: [],
    sources: [],
    semantic: null,
    searched: null,
    tools: [],
    activity: null,
    error: null
  }
}

// Applied proposals are keyed by "<messageTs>::<proposalId>" — the same
// composite key the persisted Focus chat uses — so two different messages can
// each carry a proposal with the same id without colliding. The renderer slices
// this down to a plain {proposalId: AppliedProposal} map per message before
// handing it to ProposalCards, which stays store-shape agnostic.
export function appliedKey(messageTs: number, proposalId: string): string {
  return `${messageTs}::${proposalId}`
}

// Window for the "What was I doing?" lookback — last 30 minutes covers most context switches.
const TRAIL_LOOKBACK_MS = 30 * 60 * 1000

interface ChatStore {
  messagesByTask: Record<string, ChatMessage[]>
  // Action proposals attached to an assistant message. Keyed by the message's
  // timestamp (unique within a conversation). When the user applies or
  // dismisses every proposal in a set, the entry is removed.
  proposalsByMessage: Record<string, ActionProposal[]>
  // Approved proposals, keyed by appliedKey(). An applied card is NOT removed
  // from the thread — it stays as a durable green record with a "Go to", so the
  // conversation reads as a log of what actually happened rather than a
  // transcript that eats its own actions.
  appliedProposals: Record<string, AppliedProposal>
  // The workspace material each assistant answer was grounded on, keyed by the
  // message timestamp. Rendered as numbered chips matching the [n] markers in
  // the reply. Retrieval already ran server-side to build the prompt — this is
  // the same set, surfaced rather than discarded.
  sourcesByMessage: Record<string, ChatSource[]>
  // Interactive UI blocks each assistant turn carried (Plexii P4), keyed by the
  // message timestamp. Rendered inside the turn; a tap sends the selection back
  // as the user's next message.
  blocksByMessage: Record<string, ChatUiBlock[]>
  // The trace for the send currently in flight, keyed by thread. Lives here
  // rather than under a message id because it starts before there IS a message —
  // the first thing it shows is retrieval, which happens before a word is
  // written. On completion it moves to traceByMessage under the answer's ts.
  liveTraceByThread: Record<string, AssistantTrace>
  // Finished traces, keyed by the assistant message's timestamp, so a completed
  // turn can still show its collapsed "3 sources · 2 tools" summary.
  traceByMessage: Record<string, AssistantTrace>
  // Whether each finished trace is open or shut. Lives here rather than in the
  // component because the panel unmounts whenever you navigate away: local state
  // would mean a trace you closed comes back open — and replays its reveal —
  // every single time you return to the page.
  traceDisclosureByMessage: Record<string, 'open' | 'closed'>
  setTraceDisclosure: (messageTs: number, state: 'open' | 'closed') => void
  // Follow-up questions the model asked, keyed by the asking message's
  // timestamp. Store-held for the same reason as trace disclosure: the panel
  // unmounts on navigation, and a question must neither vanish nor resurrect
  // because you changed screens. The card renders only while its message is
  // the LAST in the thread — answering appends a user turn, which un-lasts the
  // question without deleting the record; a rewind that makes it last again
  // honestly re-opens it, because in that history it is still unanswered.
  questionByMessage: Record<string, ChatQuestion>
  // Dismiss (the card's ×): the user declined to answer. Deletes the record so
  // the question never comes back, even if its message becomes last again.
  dismissQuestion: (messageTs: number) => void
  // The workspace objects this conversation references (Phase 4.3). One layer
  // for BOTH gestures: typing "@" and clicking a widget produce the same kind
  // of chip (plan D7), all chips are equal, and all are sticky to the
  // CONVERSATION until dismissed (plan D8) — 3a.1's single pinnedWidget
  // generalised to N typed references.
  //
  // Distinct from the conversation itself — this pins reference MATERIAL to one.
  mentions: MentionRef[]
  addMentionRef: (ref: MentionRef) => { added: boolean; rejectedForCap: boolean }
  removeMentionRef: (conversationKey: string, key: string) => void
  // What the main process reported each reference actually produced. The sole
  // basis for rendering a chip as broken — the renderer never assumes a
  // reference resolved just because it was sent.
  mentionResolution: MentionResolution
  // The references a given user turn was sent with, keyed by its timestamp, so
  // a past message can re-draw its chips inline exactly where they were typed
  // (plan P1's first rendering). Kept per message rather than derived, because
  // the conversation's live set changes and the transcript must not.
  mentionsByMessage: Record<string, MentionRef[]>
  // The composer's unsent draft per conversation (A1, defect AI-16): the
  // TipTap document JSON, so mention chips survive, not just the words. The
  // panel unmounts whenever you walk to a desk or collapse to the pill; the
  // draft living only in the editor meant that walk ATE what was being
  // typed. Session-scoped by design — an unsent draft is not durable data.
  draftDocByThread: Record<string, JSONContent>
  // null deletes the entry (an emptied composer has no draft).
  setThreadDraft: (threadKey: string, doc: JSONContent | null) => void
  // ── One persisted conversation system (Phase 4.5) ────────────────────────
  // The panel and the focus chat used to be two engines: in-memory per-screen
  // threads here, SQLite conversations there, bridged one-way by the 3a.3
  // import. This store is now the single one, and the bridge is gone.
  //
  // The active conversation's id, or null for a fresh chat nobody has spoken in
  // yet. Created lazily on the first message so history never fills with empty
  // conversations (the rule the focus chat already had, kept).
  activeConversationId: string | null
  // The history list — metadata only, refreshed on demand.
  conversations: AiChatConversationMeta[]
  // Guards the lazy first-message create so two fast sends cannot each mint a
  // conversation and split the turns across duplicates.
  creatingConversation: boolean
  // The persisted row id for each message ts, so an applied-state write targets
  // a unique id rather than a Date.now() that can collide.
  messageIdByTs: Record<string, string>
  // The key the per-conversation maps use right now: the real conversation id,
  // or NEW_CHAT_KEY while the chat is still unsaved.
  conversationKey: () => string
  refreshConversations: () => Promise<void>
  newConversation: () => void
  openConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  // Link a desk to a conversation (Plexii P5). Optimistic on the local meta,
  // persisted best-effort; element 0 of linkedDesks is the primary.
  linkDesk: (conversationId: string, taskId: string, makePrimary?: boolean) => Promise<void>
  // Where a NEW conversation says it was started. Set by the panel from the
  // current screen just before the first send; a conversation created without
  // one records nothing rather than a placeholder.
  pendingContext: AiChatConversationContext | null
  setPendingContext: (ctx: AiChatConversationContext | null) => void
  // The mode a NOT-YET-SAVED chat will be created in (Plexii P6). A saved
  // conversation's mode lives on its meta; this covers the window before the
  // first message, so opening discovery from Home is discovery from turn one.
  pendingMode: AiChatMode
  // Switch the active conversation's mode. Works before the conversation
  // exists (sets pendingMode) and after (persists on the row).
  setMode: (mode: AiChatMode) => void
  // The mode in force right now: the active conversation's, or the pending one.
  activeMode: () => AiChatMode
  // The web-search globe (A4, R21), exactly the mode pattern: a not-yet-saved
  // chat holds the pending value; a saved conversation's lives on its meta.
  // Default on.
  pendingWebSearch: boolean
  // Flip the active conversation's globe. Works before the conversation exists
  // (sets pendingWebSearch) and after (persists on the row).
  setWebSearch: (on: boolean) => void
  // The globe in force right now: the active conversation's, or the pending one.
  activeWebSearch: () => boolean
  // AI-04 (R24): open the conversation that built a desk, in the assistant
  // panel. False when the desk has no linked conversation.
  openDeskConversation: (deskId: string) => Promise<boolean>
  // Door 2 of R24: land in the desk's conversation when the assistant opens
  // over that desk — unless the user is already in one of the desk's own
  // conversations, or an unsaved chat already has words in it. False when
  // nothing changed.
  defaultToDeskConversation: (deskId: string) => Promise<boolean>
  sending: boolean
  // The in-flight stream's requestId, so Stop can abort exactly the request
  // it belongs to. Null whenever nothing is streaming.
  liveRequestId: string | null
  // Abort the live stream (the composer's Stop). The turn finishes through
  // its normal completion path with everything that already arrived.
  cancelSend: () => void
  hasApiKey: boolean | null
  checkApiKey: () => Promise<void>
  getMessages: (taskId: string | null) => ChatMessage[]
  getProposals: (messageTs: number) => ActionProposal[]
  // Record that a proposal was approved and applied to the workspace.
  markProposalApplied: (
    messageTs: number,
    proposalId: string,
    applied: AppliedProposal
  ) => void
  // Drop one proposal from a message's set (dismissed, or applied on a surface
  // with no applied-state).
  consumeProposal: (messageTs: number, proposalId: string) => void
  // Truncate a thread to its first `keepCount` messages, discarding the
  // proposals, applied records and sources that hung off the dropped ones.
  // Backs "retry": rewind to just before a question, then re-send it.
  rewindTo: (threadKey: string, keepCount: number) => void
  // threadKey scopes the conversation thread (the context the assistant is in).
  // When omitted it falls back to taskId, preserving existing desk behaviour. The
  // real taskId is still what's sent to the server for task context.
  send: (taskId: string | null, content: string, threadKey?: string) => Promise<void>
  sendProactiveWelcome: (taskId: string) => Promise<void>
  // Push a synthetic assistant message into the conversation. Used by "What was I doing?"
  // and other AI features that produce output without a user prompt.
  pushAssistantMessage: (taskId: string | null, content: string) => void
  /** "What was I doing?" — the last 30 minutes of the trail, narrated into
   *  the active thread. Lifted here (DEC-120) so the overlay header and the
   *  hub page share one implementation. */
  recapping: boolean
  recap: (taskId: string | null) => Promise<void>
  clear: (taskId: string | null) => void
}

// DEC-031 — the last-mile guarantee. Every surface that sends a message funnels
// through send(), and several of them (⌘K's Ask row, the home bar, voice) call
// it DIRECTLY, bypassing the composer where the @attention interception lives.
// That bypass is exactly how a "…@attention" from ⌘K reached the model and
// filed nothing. The capability is probed once here, refreshed on the Settings
// toggle, so the check inside send() is synchronous.
let workItemsOn = false
const probeWorkItems = (): void => {
  window.api?.workItems
    ?.enabled?.()
    .then((v: boolean) => {
      workItemsOn = v
    })
    .catch(() => {})
}
probeWorkItems()
window.addEventListener('fb:workitems-toggled', probeWorkItems)

const GLOBAL_KEY = '__global__'
const EMPTY_MESSAGES: ChatMessage[] = []

// The key the per-conversation maps use before the first message has created a
// real conversation row. A fresh chat is genuinely unsaved until you say
// something — an empty conversation in history would be clutter nobody asked
// for — so it lives under this sentinel and is re-keyed to its real id the
// moment it becomes real.
export const NEW_CHAT_KEY = '__new__'

// The live trace reduced to what is worth keeping. The renderer clock stamps
// that drive the progressive reveal describe one session's animation, not a
// durable fact, so they are dropped rather than persisted and replayed.
function toStoredTrace(t: AssistantTrace | undefined): StoredTrace | null {
  if (!t) return null
  if (t.sources.length === 0 && t.tools.length === 0 && t.mentions.length === 0 && !t.error) {
    return null
  }
  return {
    sources: t.sources,
    tools: t.tools,
    mentions: t.mentions,
    retrievalMs: t.retrievalMs,
    error: t.error,
    semantic: t.semantic
  }
}

// A persisted trace restored for display. status is 'done' because a stored
// trace is by definition finished, and the timestamps are set to a constant so
// the reveal shows it complete rather than replaying an animation for work that
// happened days ago.
function fromStoredTrace(t: StoredTrace | null): AssistantTrace | null {
  if (!t) return null
  return {
    status: t.error ? 'error' : 'done',
    startedAt: 0,
    retrievedAt: 0,
    retrievalMs: t.retrievalMs,
    repliedAt: 0,
    completedAt: 0,
    mentions: t.mentions ?? [],
    sources: t.sources ?? [],
    semantic: t.semantic ?? null,
    tools: t.tools ?? [],
    // A restored trace is finished work — there is no in-flight action to name.
    activity: null,
    error: t.error
  }
}

const EMPTY_PROPOSALS: ActionProposal[] = []

export const useChatStore = create<ChatStore>((set, get) => ({
  messagesByTask: {},
  proposalsByMessage: {},
  appliedProposals: {},
  sourcesByMessage: {},
  blocksByMessage: {},
  liveTraceByThread: {},
  traceByMessage: {},
  traceDisclosureByMessage: {},
  questionByMessage: {},
  setTraceDisclosure: (messageTs, state) => {
    set({
      traceDisclosureByMessage: {
        ...get().traceDisclosureByMessage,
        [String(messageTs)]: state
      }
    })
  },
  dismissQuestion: (messageTs) => {
    const next = { ...get().questionByMessage }
    delete next[String(messageTs)]
    set({ questionByMessage: next })
  },
  mentions: [],
  mentionResolution: {},
  mentionsByMessage: {},
  draftDocByThread: {},
  setThreadDraft: (threadKey, doc) => {
    const next = { ...get().draftDocByThread }
    if (doc === null) delete next[threadKey]
    else next[threadKey] = doc
    set({ draftDocByThread: next })
  },
  addMentionRef: (ref) => {
    const r = addMention(get().mentions, ref)
    if (r.added) set({ mentions: r.mentions })
    return { added: r.added, rejectedForCap: r.rejectedForCap }
  },
  removeMentionRef: (conversationKey, key) => {
    set({ mentions: removeMention(get().mentions, conversationKey, key) })
  },
  activeConversationId: null,
  conversations: [],
  creatingConversation: false,
  messageIdByTs: {},
  pendingContext: null,
  setPendingContext: (ctx) => set({ pendingContext: ctx }),
  pendingMode: 'chat',
  activeMode: () => {
    const id = get().activeConversationId
    if (!id) return get().pendingMode
    return get().conversations.find((c) => c.id === id)?.mode ?? 'chat'
  },
  setMode: (mode) => {
    const id = get().activeConversationId
    if (!id) {
      set({ pendingMode: mode })
      return
    }
    // Optimistic on the meta so the badge flips instantly; persisted after.
    set({
      conversations: get().conversations.map((c) => (c.id === id ? { ...c, mode } : c))
    })
    if (typeof window.api?.aiChat?.setConversationMode === 'function') {
      void window.api.aiChat.setConversationMode(id, mode).catch(() => {})
    }
  },
  pendingWebSearch: true,
  activeWebSearch: () => {
    const id = get().activeConversationId
    if (!id) return get().pendingWebSearch
    return get().conversations.find((c) => c.id === id)?.webSearch ?? true
  },
  setWebSearch: (on) => {
    const id = get().activeConversationId
    if (!id) {
      set({ pendingWebSearch: on })
      return
    }
    // Optimistic on the meta so the globe flips instantly; persisted after.
    set({
      conversations: get().conversations.map((c) => (c.id === id ? { ...c, webSearch: on } : c))
    })
    if (typeof window.api?.aiChat?.setConversationWebSearch === 'function') {
      void window.api.aiChat.setConversationWebSearch(id, on).catch(() => {})
    }
  },
  openDeskConversation: async (deskId) => {
    if (get().conversations.length === 0) await get().refreshConversations()
    const meta = conversationForDesk(get().conversations, deskId)
    if (!meta) return false
    if (get().activeConversationId !== meta.id) await get().openConversation(meta.id)
    const chrome = useAssistantChrome.getState()
    chrome.setTab('chat')
    chrome.openPanel()
    return true
  },
  defaultToDeskConversation: async (deskId) => {
    if (get().conversations.length === 0) await get().refreshConversations()
    const linked = conversationForDesk(get().conversations, deskId)
    if (!linked || get().activeConversationId === linked.id) return false
    const currentId = get().activeConversationId
    const current = currentId ? get().conversations.find((c) => c.id === currentId) : null
    // Already in one of this desk's conversations: never hijack.
    if (current?.linkedDesks.includes(deskId)) return false
    // An unsaved chat with words in it is live work: never bury it.
    if (!currentId && (get().messagesByTask[NEW_CHAT_KEY]?.length ?? 0) > 0) return false
    await get().openConversation(linked.id)
    return true
  },
  conversationKey: () => get().activeConversationId ?? NEW_CHAT_KEY,
  refreshConversations: async () => {
    const list = await window.api.aiChat.listConversations().catch(() => null)
    if (list) set({ conversations: list })
  },
  newConversation: () => {
    // Drop whatever an unsaved chat had accumulated so a second New chat does
    // not inherit the first one's half-written draft state. A conversation that
    // was already persisted is untouched — it lives on disk.
    const key = NEW_CHAT_KEY
    const nextMessages = { ...get().messagesByTask }
    delete nextMessages[key]
    const nextLive = { ...get().liveTraceByThread }
    delete nextLive[key]
    // A second New chat must not inherit the first one's half-typed draft.
    const nextDrafts = { ...get().draftDocByThread }
    delete nextDrafts[key]
    set({
      activeConversationId: null,
      messagesByTask: nextMessages,
      liveTraceByThread: nextLive,
      draftDocByThread: nextDrafts,
      messageIdByTs: {},
      mentions: clearConversationMentions(get().mentions, key),
      pendingContext: null,
      // A fresh chat starts as a normal chat unless the caller (the Discover
      // widget) asks for discovery straight after. The globe resets to its
      // default-on too (R21 stickiness is per conversation, never inherited).
      pendingMode: 'chat',
      pendingWebSearch: true
    })
  },
  openConversation: async (id) => {
    const conv = await window.api.aiChat.getConversation(id).catch((e: unknown) => {
      // Surface the failure — a silent return here looks like a dead click
      // and cost a debugging session to trace (a stale main process serving
      // an old payload shape). The rail row exists, so say why it won't open.
      console.warn('[assistant] getConversation failed for', id, e)
      return null
    })
    if (!conv) return
    const messages: ChatMessage[] = conv.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ts: m.ts
    }))
    const proposalsByMessage: Record<string, ActionProposal[]> = {}
    const appliedProposals: Record<string, AppliedProposal> = { ...get().appliedProposals }
    const sourcesByMessage: Record<string, ChatSource[]> = { ...get().sourcesByMessage }
    const blocksByMessage: Record<string, ChatUiBlock[]> = { ...get().blocksByMessage }
    const questionByMessage: Record<string, ChatQuestion> = { ...get().questionByMessage }
    const traceByMessage: Record<string, AssistantTrace> = { ...get().traceByMessage }
    const traceDisclosureByMessage: Record<string, 'open' | 'closed'> = {
      ...get().traceDisclosureByMessage
    }
    const mentionsByMessage: Record<string, MentionRef[]> = { ...get().mentionsByMessage }
    const messageIdByTs: Record<string, string> = {}
    for (const m of conv.messages) {
      const k = String(m.ts)
      messageIdByTs[k] = m.id
      // Every optional field is read defensively: a version-skewed backend (a
      // stale dev main, an older packaged app) may omit fields this renderer
      // is newer than, and one missing array must not throw away the whole
      // conversation open.
      if (m.proposals?.length) proposalsByMessage[k] = m.proposals
      for (const [proposalId, applied] of Object.entries(m.applied ?? {})) {
        appliedProposals[appliedKey(m.ts, proposalId)] = applied
      }
      if (m.sources?.length) sourcesByMessage[k] = m.sources
      if (m.blocks?.length) blocksByMessage[k] = m.blocks
      if (m.question) questionByMessage[k] = m.question
      const restored = fromStoredTrace(m.trace ?? null)
      if (restored) {
        traceByMessage[k] = restored
        // History never re-animates (P3 doctrine): a restored trace opens as
        // its quiet summary line instead of arriving expanded and folding
        // itself away 1.4s later on every conversation open.
        if (!traceDisclosureByMessage[k]) traceDisclosureByMessage[k] = 'closed'
      }
      // The references a user turn was sent with, rehydrated onto this
      // conversation so its inline chips redraw where they were typed.
      if (m.mentions?.length) {
        mentionsByMessage[k] = m.mentions.map((r) => ({
          ...r,
          icon: 'attachment',
          conversationKey: id
        }))
      }
    }
    set({
      activeConversationId: id,
      messagesByTask: { ...get().messagesByTask, [id]: messages },
      proposalsByMessage: { ...get().proposalsByMessage, ...proposalsByMessage },
      appliedProposals,
      sourcesByMessage,
      blocksByMessage,
      questionByMessage,
      traceByMessage,
      traceDisclosureByMessage,
      mentionsByMessage,
      messageIdByTs,
      pendingContext: null
    })
  },
  deleteConversation: async (id) => {
    await window.api.aiChat.deleteConversation(id).catch(() => {})
    const nextDrafts = { ...get().draftDocByThread }
    delete nextDrafts[id]
    set({ draftDocByThread: nextDrafts })
    if (get().activeConversationId === id) get().newConversation()
    await get().refreshConversations()
  },
  linkDesk: async (conversationId, taskId, makePrimary) => {
    // Optimistic: the chip should appear the moment the desk exists, not after
    // a round-trip. The idempotent server write reconciles on the next refresh.
    set({
      conversations: get().conversations.map((c) => {
        if (c.id !== conversationId) return c
        const current = c.linkedDesks ?? []
        const next = makePrimary
          ? [taskId, ...current.filter((t) => t !== taskId)]
          : current.includes(taskId)
            ? current
            : [...current, taskId]
        return { ...c, linkedDesks: next }
      })
    })
    // Older preloads predate linkDesk — degrade to in-memory linking rather
    // than throwing away the chip the user can already see.
    if (typeof window.api?.aiChat?.linkDesk === 'function') {
      await window.api.aiChat.linkDesk(conversationId, taskId, makePrimary).catch(() => {})
      await get().refreshConversations()
    }
  },
  sending: false,
  liveRequestId: null,
  cancelSend: () => {
    const id = get().liveRequestId
    if (id) void window.api.chat.cancelStream(id).catch(() => {})
  },
  hasApiKey: null,
  recapping: false,
  recap: async (taskId) => {
    if (get().recapping) return
    if (get().hasApiKey === false) {
      get().pushAssistantMessage(
        taskId,
        'Open Settings → AI · API keys and paste your Anthropic API key to use "What was I doing?".'
      )
      return
    }
    set({ recapping: true })
    try {
      const result = await window.api.trail.summarize(taskId, Date.now() - TRAIL_LOOKBACK_MS)
      if (result.ok && result.summary) {
        const stamp = result.eventCount ? `_(from ${result.eventCount} events in the last 30 min)_\n\n` : ''
        get().pushAssistantMessage(taskId, `${stamp}${result.summary}`)
      } else {
        get().pushAssistantMessage(taskId, result.error ?? "Couldn't summarize — try again in a moment.")
      }
    } finally {
      set({ recapping: false })
    }
  },
  checkApiKey: async () => {
    const has = await window.api.chat.hasApiKey()
    set({ hasApiKey: has })
  },
  getMessages: (taskId) => {
    const key = taskId ?? GLOBAL_KEY
    return get().messagesByTask[key] ?? EMPTY_MESSAGES
  },
  getProposals: (messageTs) => {
    return get().proposalsByMessage[String(messageTs)] ?? EMPTY_PROPOSALS
  },
  markProposalApplied: (messageTs, proposalId, applied) => {
    const next = { ...get().appliedProposals, [appliedKey(messageTs, proposalId)]: applied }
    set({ appliedProposals: next })
    // Plexii P5: a desk this conversation just produced links to it — the
    // conversation and its desk stay pinned together from the moment of birth.
    const producedKind = (get().proposalsByMessage[String(messageTs)] ?? []).find(
      (p) => p.id === proposalId
    )?.kind
    const linkTaskId = linkTargetForApplied(producedKind, applied)
    const linkConvId = get().activeConversationId
    if (linkTaskId && linkConvId) void get().linkDesk(linkConvId, linkTaskId)
    // Persist so an approved card is still green after a restart (Phase 4.5 —
    // the behaviour the focus chat already had, now that both surfaces share
    // one store). Addressed by the message's own row id: a ts can collide, an
    // id cannot. Without one we keep the in-memory green state and skip the
    // write rather than guessing at a row.
    const convId = get().activeConversationId
    const messageId = get().messageIdByTs[String(messageTs)]
    if (!convId || !messageId) return
    const forMsg: Record<string, AppliedProposal> = {}
    for (const p of get().proposalsByMessage[String(messageTs)] ?? []) {
      const a = next[appliedKey(messageTs, p.id)]
      if (a) forMsg[p.id] = a
    }
    void window.api.aiChat.setMessageApplied(convId, messageId, forMsg).catch(() => {})
  },
  consumeProposal: (messageTs, proposalId) => {
    const key = String(messageTs)
    const current = get().proposalsByMessage[key] ?? []
    const filtered = current.filter((p) => p.id !== proposalId)
    const next = { ...get().proposalsByMessage }
    if (filtered.length === 0) {
      delete next[key]
    } else {
      next[key] = filtered
    }
    // Drop any applied record for the removed proposal so the two maps can't
    // drift (a dismissed card must not leave an orphan green record behind).
    const nextApplied = { ...get().appliedProposals }
    delete nextApplied[appliedKey(messageTs, proposalId)]
    set({ proposalsByMessage: next, appliedProposals: nextApplied })
  },
  rewindTo: (threadKey, keepCount) => {
    const current = get().messagesByTask[threadKey] ?? []
    if (keepCount >= current.length) return
    const dropped = current.slice(Math.max(0, keepCount))
    const nextProposals = { ...get().proposalsByMessage }
    const nextApplied = { ...get().appliedProposals }
    const nextSources = { ...get().sourcesByMessage }
    const nextBlocks = { ...get().blocksByMessage }
    const nextTraces = { ...get().traceByMessage }
    const nextDisclosure = { ...get().traceDisclosureByMessage }
    const nextQuestions = { ...get().questionByMessage }
    const nextMentionsByMessage = { ...get().mentionsByMessage }
    for (const m of dropped) {
      for (const p of nextProposals[String(m.ts)] ?? []) {
        delete nextApplied[appliedKey(m.ts, p.id)]
      }
      delete nextProposals[String(m.ts)]
      delete nextSources[String(m.ts)]
      delete nextBlocks[String(m.ts)]
      delete nextTraces[String(m.ts)]
      delete nextDisclosure[String(m.ts)]
      delete nextQuestions[String(m.ts)]
      delete nextMentionsByMessage[String(m.ts)]
    }
    // A rewind is the front half of a retry, so any trace still running for this
    // thread describes work the user just discarded. Drop it too.
    const nextLive = { ...get().liveTraceByThread }
    delete nextLive[threadKey]
    set({
      messagesByTask: {
        ...get().messagesByTask,
        [threadKey]: current.slice(0, Math.max(0, keepCount))
      },
      proposalsByMessage: nextProposals,
      appliedProposals: nextApplied,
      sourcesByMessage: nextSources,
      blocksByMessage: nextBlocks,
      traceByMessage: nextTraces,
      traceDisclosureByMessage: nextDisclosure,
      questionByMessage: nextQuestions,
      mentionsByMessage: nextMentionsByMessage,
      liveTraceByThread: nextLive
    })
  },
  send: async (taskId, content, threadKey) => {
    // DEC-031: @attention is deterministic on EVERY path. The composer strips
    // the token before it calls send(), so this fires only for the direct
    // callers above — a double capture is impossible by construction.
    if (workItemsOn) {
      const attn = parseAttentionCommand(content)
      if (attn.mode !== 'none') {
        window.dispatchEvent(
          new CustomEvent('fb:command-new-work-item', {
            detail: attn.captureText ? { captureText: attn.captureText } : undefined
          })
        )
        // A leading token is a pure capture — nothing is sent. An inline one
        // still converses, with the token stripped out of the message.
        if (attn.mode === 'leading' || !attn.messageText) return
        content = attn.messageText
      }
    }
    let key = threadKey ?? taskId ?? GLOBAL_KEY
    // First message in a fresh chat: mint the conversation now, and move
    // everything the unsaved chat accumulated onto its real id. Persistence is
    // best-effort throughout — a DB that will not write must never cost the
    // user their message, so a failure here logs and continues unsaved.
    let convId = get().activeConversationId
    if (!convId && key === NEW_CHAT_KEY && !get().creatingConversation) {
      set({ creatingConversation: true })
      try {
        const meta = await window.api.aiChat.createConversation({
          taskId,
          title: content.slice(0, 60),
          context: get().pendingContext,
          // The mode chosen before the first word carries into the row.
          mode: get().pendingMode,
          // Likewise the globe flipped before the first word (R21).
          webSearch: get().pendingWebSearch
        })
        convId = meta.id
        const carried = get().messagesByTask[NEW_CHAT_KEY] ?? []
        const nextMessages = { ...get().messagesByTask }
        delete nextMessages[NEW_CHAT_KEY]
        nextMessages[meta.id] = carried
        // A draft typed before the first send belongs to the conversation it
        // just became — the composer keeps it through the re-key.
        const nextDrafts = { ...get().draftDocByThread }
        if (nextDrafts[NEW_CHAT_KEY]) {
          nextDrafts[meta.id] = nextDrafts[NEW_CHAT_KEY]
          delete nextDrafts[NEW_CHAT_KEY]
        }
        set({
          draftDocByThread: nextDrafts,
          activeConversationId: meta.id,
          // The new row is not in the list until the next refresh, so seed it
          // now — otherwise activeMode() would read 'chat' for a conversation
          // that was just created in discovery.
          conversations: [meta, ...get().conversations.filter((c) => c.id !== meta.id)],
          messagesByTask: nextMessages,
          // References picked before the first send belong to this conversation.
          mentions: get().mentions.map((m) =>
            m.conversationKey === NEW_CHAT_KEY ? { ...m, conversationKey: meta.id } : m
          ),
          pendingContext: null
        })
        key = meta.id
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[assistant] could not create conversation (continuing unsaved)', e)
      } finally {
        set({ creatingConversation: false })
      }
    }
    // Read AFTER any lazy conversation-create above, so a discovery chat is
    // discovery from its very first request. Same for the globe (R21).
    const mode = get().activeMode()
    const webSearch = get().activeWebSearch()
    const current = get().messagesByTask[key] ?? []
    const userMsg: ChatMessage = { role: 'user', content, ts: Date.now() }
    // DEC-052 Track D — a message SENT into a conversation an item was
    // captured from plausibly closes its loop. Observed, matched, offered —
    // never auto-completed. Fire-and-forget: an observation must never slow
    // or break the send.
    {
      const convId = get().activeConversationId
      if (convId) {
        void useCompletionOffer.getState().observe({
          kind: 'chat_message_sent',
          targetKind: 'conversation',
          targetRef: convId
        })
      }
    }
    // Carry what each prior assistant turn actually DID. Actions ride a
    // separate field from the reply, so a history of reply-prose alone showed
    // the model turns that appeared to have done nothing — and it copied that
    // shape, writing "**Actions:**" as markdown instead of emitting any.
    const priors = get().proposalsByMessage
    const withActions = current.map((m) => {
      if (m.role !== 'assistant') return m
      const ps = priors[String(m.ts)]
      if (!ps || ps.length === 0) return m
      return {
        ...m,
        actions: ps.map((p) => ({
          kind: p.kind,
          label: 'title' in p && typeof p.title === 'string' ? p.title : undefined
        }))
      }
    })
    const next = [...withActions, userMsg]
    set({
      messagesByTask: { ...get().messagesByTask, [key]: next },
      liveTraceByThread: { ...get().liveTraceByThread, [key]: newTrace() },
      sending: true
    })
    recordTrail('chat_sent', taskId, { preview: content.slice(0, 200) })
    const persist = convId
    // The conversation's references ride every message on it, and a send does
    // NOT clear them (plan D8) — "referenced in the conversation", not in one
    // message. Recorded against this turn as well, so the transcript can draw
    // the chips back inline where they were typed.
    const refs = activeMentions(get().mentions, key)
    const wireMentions = refs.length > 0 ? toWireMentions(refs) : undefined
    if (refs.length > 0) {
      set({ mentionsByMessage: { ...get().mentionsByMessage, [String(userMsg.ts)]: refs } })
    }
    if (persist) {
      const savedUser = await window.api.aiChat
        .appendMessage(persist, {
          role: 'user',
          content,
          ts: userMsg.ts,
          mentions: wireMentions
        })
        .catch(() => null)
      if (savedUser) {
        set({ messageIdByTs: { ...get().messageIdByTs, [String(userMsg.ts)]: savedUser.id } })
      }
    }
    // A referenced widget that happens to live on the desk in front of us is
    // also force-included through the canvas path, exactly as the 3a.1 pin was,
    // so its LIVE text (a rendered browser page the main process cannot read)
    // still rides. Off-desk references are resolved in main instead.
    const localWidget = refs.find((m) => m.kind === 'widget' && (!taskId || m.taskId === taskId))
    const pinnedWidgetId = localWidget?.id
    // Gather any browser/doc/pdf content the user has open so the assistant can
    // act on it (e.g. create calendar events from a booking page). Best-effort:
    // a failure here must never block the message.
    let attachments: Awaited<ReturnType<typeof gatherCanvasAttachments>> = []
    try {
      attachments = await gatherCanvasAttachments(taskId, pinnedWidgetId)
    } catch {
      attachments = []
    }

    // Merge a patch into the in-flight trace. A no-op once the trace has been
    // moved to traceByMessage or cleared, so a late event from a request the
    // user has already walked away from can't resurrect it.
    const patchTrace = (patch: Partial<AssistantTrace>): void => {
      const live = get().liveTraceByThread[key]
      if (!live) return
      set({ liveTraceByThread: { ...get().liveTraceByThread, [key]: { ...live, ...patch } } })
    }

    // The prose shows as it streams (Plexii P3): the first reply delta creates
    // the turn and later deltas rewrite it in place, so the text types out
    // live. `answerTs` is that turn's identity — `reply` lands the final prose
    // on it and `complete` updates the same turn instead of appending a second
    // one.
    let answerTs: number | null = null
    const appendAnswer = (text: string): number => {
      const ts = Date.now()
      answerTs = ts
      const thread = get().messagesByTask[key] ?? next
      set({
        messagesByTask: {
          ...get().messagesByTask,
          [key]: [...thread, { role: 'assistant', content: text, ts }]
        }
      })
      return ts
    }
    // Rewrite the streaming turn's prose in place. No-op until the turn exists
    // or when the text hasn't changed, so replays and late events cost nothing.
    const updateAnswer = (text: string): void => {
      if (answerTs === null) return
      const thread = get().messagesByTask[key] ?? []
      const at = thread.findIndex((m) => m.ts === answerTs)
      if (at < 0 || thread[at].content === text) return
      const copy = thread.slice()
      copy[at] = { ...copy[at], content: text }
      set({ messagesByTask: { ...get().messagesByTask, [key]: copy } })
    }

    // Land the finished response and retire the trace onto the answer's turn.
    const settle = (resp: ChatResponse): void => {
      let ts = answerTs
      if (ts === null) {
        // Nothing has been shown yet: the finished reply (or the error) becomes
        // the turn.
        ts = appendAnswer(resp.ok && resp.message ? resp.message.content : (resp.error ?? 'Something went wrong.'))
      } else if (resp.ok && resp.message && resp.message.content !== '') {
        // Prose is already on screen. Rewrite it only when the finished response
        // differs — it gains a notice when the model was truncated mid-actions.
        // A FAILED response never overwrites prose that really arrived; the
        // failure is recorded on the trace instead.
        const thread = get().messagesByTask[key] ?? []
        const at = thread.findIndex((m) => m.ts === ts)
        if (at >= 0 && thread[at].content !== resp.message.content) {
          const copy = thread.slice()
          copy[at] = { ...copy[at], content: resp.message.content }
          set({ messagesByTask: { ...get().messagesByTask, [key]: copy } })
        }
      }
      const tsKey = String(ts)
      const live = get().liveTraceByThread[key]
      const updates: Partial<ChatStore> = { sending: false, liveRequestId: null }
      if (resp.ok && resp.proposals && resp.proposals.length > 0) {
        updates.proposalsByMessage = { ...get().proposalsByMessage, [tsKey]: resp.proposals }
      }
      // The full retrieved set. Which of these the answer actually cites is
      // derived from the [n] markers in the prose at render time — retrieval is
      // not grounding, and only grounding earns a chip.
      if (resp.ok && resp.sources && resp.sources.length > 0) {
        updates.sourcesByMessage = { ...get().sourcesByMessage, [tsKey]: resp.sources }
      }
      // Interactive blocks land with the completed envelope (Plexii P4).
      if (resp.ok && resp.blocks && resp.blocks.length > 0) {
        updates.blocksByMessage = { ...get().blocksByMessage, [tsKey]: resp.blocks }
      }
      // The durable response is the sole source of truth for a question — the
      // renderer must never show one the completed envelope does not carry.
      if (resp.ok && resp.question) {
        updates.questionByMessage = { ...get().questionByMessage, [tsKey]: resp.question }
      }
      // What each reference genuinely produced, straight from the response. A
      // chip is marked broken on this basis and no other.
      if (resp.mentions && resp.mentions.length > 0) {
        updates.mentionResolution = mergeMentionResolution(get().mentionResolution, resp.mentions)
      }
      if (live) {
        const nextLive = { ...get().liveTraceByThread }
        delete nextLive[key]
        updates.liveTraceByThread = nextLive
        updates.traceByMessage = {
          ...get().traceByMessage,
          [tsKey]: {
            ...live,
            status: resp.ok ? 'done' : 'error',
            error: resp.ok ? live.error : (resp.error ?? 'Something went wrong.'),
            completedAt: Date.now()
          }
        }
        // The disclosure is deliberately NOT forced closed here (AI-30). The
        // A1 version folded the trace in this same commit to dodge the
        // post-completion jump; now the finished turn keeps draining its
        // waves under the open tree, the handoff mounts the tree in place
        // without replaying its cascade, and the auto-collapse folds it by
        // height — the loved fold, made smooth. A FAILED trace stays open
        // regardless: it is the only thing on screen explaining what went
        // wrong.
      }
      set(updates)

      // Persist the finished assistant turn with everything the panel shows for
      // it: the prose, its proposals, its citations, any question it asked, and
      // the trace of what it actually did. Persisting only the prose would make
      // reopening a conversation a quieter, less honest version of what the user
      // saw the first time.
      if (persist && ts !== null) {
        const storedTrace = toStoredTrace(get().traceByMessage[tsKey])
        void window.api.aiChat
          .appendMessage(persist, {
            role: 'assistant',
            content: get().messagesByTask[key]?.find((m) => m.ts === ts)?.content ?? '',
            ts,
            proposals: resp.ok ? resp.proposals : undefined,
            sources: resp.ok ? resp.sources : undefined,
            question: resp.ok ? (resp.question ?? null) : null,
            trace: storedTrace,
            blocks: resp.ok ? resp.blocks : undefined
          })
          .then((saved) => {
            if (saved) {
              set({ messageIdByTs: { ...get().messageIdByTs, [String(ts)]: saved.id } })
            }
            return get().refreshConversations()
          })
          .catch(() => {})
      }
    }

    // Streaming is the normal path. The non-streaming `chat:send` stays wired as
    // the fallback for a renderer talking to a preload that predates it — in
    // practice, an Electron process still running the old preload after a code
    // change, because a released build ships both together.
    //
    // The fallback is LOUD on purpose. It degrades the headline behaviour: no
    // events means no trace, and the panel then looks exactly like a trace that
    // doesn't work rather than one that was never fed. This warning is the
    // difference between "restart the app" and an hour of debugging. (ART-0 in
    // assistantRetrievalTrace.spec.ts locks the surface so CI catches it too.)
    const api = window.api.chat
    if (typeof api.sendStream !== 'function') {
      console.warn(
        '[assistant] window.api.chat.sendStream is missing — falling back to the ' +
          'non-streaming chat:send. The retrieval trace needs the streaming ' +
          'transport and will not render. This almost always means the Electron ' +
          'process is running an older preload bundle: restart it (npm run dev).'
      )
      // supportsQuestions: this panel renders the question card, so the model
      // is allowed to ask here — the one surface that opts in.
      const resp = await api.send({
        taskId,
        messages: next,
        attachments,
        supportsQuestions: true,
        // Conversational surface: inject the "what I know about you" memory block.
        includeMemory: true,
        pinnedWidgetId,
        mentions: wireMentions,
        mode,
        // The conversation's globe (R21); false turns the web pool off.
        webSearch,
        // Keeps this conversation out of its own chat-history retrieval pool.
        conversationId: persist ?? undefined
      })
      settle(resp)
      return
    }

    const requestId = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    set({ liveRequestId: requestId })
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        cleanup()
        resolve()
      }
      const cleanup = api.sendStream(
        {
          taskId,
          messages: next,
          attachments,
          requestId,
          supportsQuestions: true,
          includeMemory: true,
          pinnedWidgetId,
          mentions: wireMentions,
          mode,
          // The conversation's globe (R21); false turns the web pool off.
          webSearch,
          // Keeps this conversation out of its own chat-history retrieval pool.
          conversationId: persist ?? undefined
        },
        {
          onMentions: (m) => {
            patchTrace({ mentions: m })
            // Same verdicts the completed response carries, applied as soon as
            // they are known so a broken chip does not wait for the answer.
            set({ mentionResolution: mergeMentionResolution(get().mentionResolution, m) })
          },
          onSources: (t) =>
            patchTrace({
              retrievedAt: Date.now(),
              retrievalMs: t.elapsedMs,
              sources: t.sources,
              // Absent on an older main process: stays unknown, discloses nothing.
              semantic: t.semantic ?? null,
              // What actually ran (A4 gating). Absent = everything, pre-A4 truth.
              searched: t.searched ?? null
            }),
          // Token-by-token prose: the first delta creates the turn, later ones
          // grow it in place. Cumulative text, so each event simply replaces.
          onReplyDelta: (text) => {
            if (answerTs === null) {
              if (!text.trim()) return
              patchTrace({ repliedAt: Date.now() })
              appendAnswer(text)
              return
            }
            updateAnswer(text)
          },
          onReply: (text) => {
            patchTrace({ repliedAt: Date.now() })
            if (answerTs === null) {
              if (text.trim()) appendAnswer(text)
              return
            }
            // The field closed: the final decoded prose replaces the
            // progressively-decoded draft (they can differ at escape
            // boundaries).
            updateAnswer(text)
          },
          // What the model is writing RIGHT NOW ("Generating a document…").
          // Kept until superseded by a newer activity; the view ignores it once
          // the action it names has completed, so it can never claim stale work.
          onActivity: (activity) => patchTrace({ activity }),
          onTool: (tool) => {
            const live = get().liveTraceByThread[key]
            if (!live) return
            patchTrace({ tools: [...live.tools, tool] })
          },
          onError: (err) => {
            // Prose that already landed is real work and stays on screen — the
            // failure came after it. settle() keeps that message and marks the
            // trace failed, so the phases end red rather than finishing green on
            // a request that broke. With no prose yet, the error becomes the turn.
            settle({ ok: false, error: err.error })
            finish()
          },
          onComplete: (resp) => {
            settle(resp)
            finish()
          }
        }
      )
    })
  },
  sendProactiveWelcome: async (taskId) => {
    if (get().hasApiKey === false) return
    const existing = get().messagesByTask[taskId] ?? []
    if (existing.length > 0) return // user already in a conversation about this task
    const resp = await window.api.chat.proactiveWelcome(taskId)
    if (resp.ok && resp.message) {
      const current = get().messagesByTask[taskId] ?? []
      // Race guard: if the user typed something in the meantime, append after their messages
      set({
        messagesByTask: { ...get().messagesByTask, [taskId]: [...current, resp.message] }
      })
    }
  },
  pushAssistantMessage: (taskId, content) => {
    const key = taskId ?? GLOBAL_KEY
    const current = get().messagesByTask[key] ?? []
    set({
      messagesByTask: {
        ...get().messagesByTask,
        [key]: [...current, { role: 'assistant', content, ts: Date.now() }]
      }
    })
  },
  clear: (taskId) => {
    const key = taskId ?? GLOBAL_KEY
    const cleared = get().messagesByTask[key] ?? []
    const next = { ...get().messagesByTask }
    delete next[key]
    // Clearing a thread must also drop the proposals and applied records that
    // hung off its messages, or they accumulate forever keyed to timestamps
    // whose conversation no longer exists.
    const nextProposals = { ...get().proposalsByMessage }
    const nextApplied = { ...get().appliedProposals }
    const nextSources = { ...get().sourcesByMessage }
    const nextBlocks = { ...get().blocksByMessage }
    const nextTraces = { ...get().traceByMessage }
    const nextDisclosure = { ...get().traceDisclosureByMessage }
    const nextQuestions = { ...get().questionByMessage }
    const nextMentionsByMessage = { ...get().mentionsByMessage }
    for (const m of cleared) {
      for (const p of nextProposals[String(m.ts)] ?? []) {
        delete nextApplied[appliedKey(m.ts, p.id)]
      }
      delete nextProposals[String(m.ts)]
      delete nextSources[String(m.ts)]
      delete nextBlocks[String(m.ts)]
      delete nextTraces[String(m.ts)]
      delete nextDisclosure[String(m.ts)]
      delete nextQuestions[String(m.ts)]
      delete nextMentionsByMessage[String(m.ts)]
    }
    const nextLive = { ...get().liveTraceByThread }
    delete nextLive[key]
    const nextDrafts = { ...get().draftDocByThread }
    delete nextDrafts[key]
    set({
      messagesByTask: next,
      proposalsByMessage: nextProposals,
      appliedProposals: nextApplied,
      sourcesByMessage: nextSources,
      blocksByMessage: nextBlocks,
      traceByMessage: nextTraces,
      traceDisclosureByMessage: nextDisclosure,
      questionByMessage: nextQuestions,
      mentionsByMessage: nextMentionsByMessage,
      liveTraceByThread: nextLive,
      draftDocByThread: nextDrafts,
      // A cleared conversation has nothing left referencing it.
      mentions: clearConversationMentions(get().mentions, key)
    })
  }
}))

// Expose the unified conversation store on window so e2e specs can drive it
// without a live model call (the harness strips the API key). A thin handle to
// the real store — it replaces __fbFocusChat, which pointed at the second engine
// this store absorbed.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbChat?: typeof useChatStore }).__fbChat = useChatStore
}
