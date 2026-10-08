import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppliedProposal, ChatMessage, ChatSource } from '@shared/types'
import { useNodeStore } from '../stores/nodes'
import { useViewStore } from '../stores/view'
import { targetForSource } from '../lib/sourceTarget'
import { canPeek } from '../lib/sourcePeek'
import { goToSourceTarget } from '../lib/goToSourceTarget'
import { useSourcePeek } from '../stores/sourcePeek'
import { useChatStore, appliedKey, NEW_CHAT_KEY } from '../stores/chat'
import { useAccountStore } from '../stores/account'
import MentionComposer from './assistant/MentionComposer'
import MentionRefRow from './assistant/MentionRefRow'
import ConversationList from './assistant/ConversationList'
import { activeMentions, type MentionRef } from '../lib/assistantMentions'
import { docToInput, splitMentionText } from '../lib/mentionDoc'
import { usePeopleStore } from '../lib/peopleDirectory'
import { deriveAssistantBlocks } from '../lib/chatBlocks'
import ChatBlockView from './focus/ChatBlockView'
import RetrievalTrace from './assistant/RetrievalTrace'
import StreamingProse from './assistant/StreamingProse'
import { cascadeDurationMs } from '../lib/traceView'
import { useDocumentsStore } from '../stores/documents'
import { composerOmniIntents, type OmniIntent, type OmniTarget } from '../lib/omniIntent'
import { performOmniIntent as performOmniIntentAct } from '../lib/omniPerform'
import QuestionCard from './assistant/QuestionCard'
import { activeQuestionFor } from '../lib/assistantQuestion'
import { useAssistantContext } from '../lib/assistantContext'
import { useWidgetStore } from '../stores/widgets'
import { chimeIn } from '../lib/audioBeep'
import CanvasContextMenu, { type CtxMenuItem } from './CanvasContextMenu'
import { FLOATING_MENU_ASIDE, FLOATING_MENU_STYLE } from './chrome/floatingMenu'
import ModelPickerChip from './assistant/ModelPickerChip'
import { CHAT_MODES, chatModeDef } from '../lib/chatModes'
import { ASSISTANT_CAPABILITIES } from '../lib/assistantCapabilities'
import { useAssistantChrome } from '../stores/assistantChrome'
import AssistantHeader from './assistant/AssistantHeader'
import {
  PUSH_TO_DESK_MESSAGE,
  TURN_INTO_DESK_MESSAGE
} from '../lib/conversationDesks'
import Icon from './Icon'
import AttentionConfirmCard from './AttentionConfirmCard'
import { deskCaptureContext } from '../lib/captureContext'
import { parseAttentionCommand, hasAttentionCommand } from '../lib/attentionCommand'
import { presetForSelection } from '../lib/attentionPresets'

const EMPTY_MESSAGES: ChatMessage[] = []

interface Props {
  // The Plexii hub renders this same panel as a real page in the main pane
  // (view.kind 'plexii'). Page mode forces the fullscreen layout regardless of
  // the overlay's chrome mode and drops the display-mode menu — a page is a
  // place you navigated to, not a dressing you switch.
  page?: boolean
}

export default function ChatPanel({ page }: Props = {}): JSX.Element {
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const nodes = useNodeStore((s) => s.nodes)
  const send = useChatStore((s) => s.send)
  const sending = useChatStore((s) => s.sending)
  const cancelSend = useChatStore((s) => s.cancelSend)
  const hasApiKey = useChatStore((s) => s.hasApiKey)
  // Signed-in users get managed Plexii (the metered proxy on our key, with a
  // free trial grant), so they never need to paste an API key. The no-key nudge
  // below therefore only shows to signed-out users, and leads with "sign in,
  // it's included" rather than "paste a key".
  const signedIn = useAccountStore((s) => !!s.sessionToken)
  const checkApiKey = useChatStore((s) => s.checkApiKey)
  const messagesByTask = useChatStore((s) => s.messagesByTask)
  const proposalsByMessage = useChatStore((s) => s.proposalsByMessage)
  const appliedProposals = useChatStore((s) => s.appliedProposals)
  const sourcesByMessage = useChatStore((s) => s.sourcesByMessage)
  const blocksByMessage = useChatStore((s) => s.blocksByMessage)
  const liveTraceByThread = useChatStore((s) => s.liveTraceByThread)
  const traceByMessage = useChatStore((s) => s.traceByMessage)
  const traceDisclosureByMessage = useChatStore((s) => s.traceDisclosureByMessage)
  const setTraceDisclosure = useChatStore((s) => s.setTraceDisclosure)
  const questionByMessage = useChatStore((s) => s.questionByMessage)
  const dismissQuestion = useChatStore((s) => s.dismissQuestion)
  const markProposalApplied = useChatStore((s) => s.markProposalApplied)
  const consumeProposal = useChatStore((s) => s.consumeProposal)
  const rewindTo = useChatStore((s) => s.rewindTo)
  const clear = useChatStore((s) => s.clear)
  // The assistant is one panel that adapts to the current screen (desk / room /
  // doc / chat / meet / design / focused widget). ctx.key threads the
  // conversation per context; ctx.serverTaskId is the real task handed to the
  // server for task-scoped context (null off a desk).
  const ctx = useAssistantContext()
  // The conversation on screen. Normally the current screen's, but a thread
  // pinned by following a citation keeps its place until the user picks this
  // page instead — otherwise the assistant sends you somewhere and then loses
  // the conversation that sent you, which makes its own links unusable.
  // The conversation on screen (Phase 4.5/4.6). It is keyed by the conversation
  // itself, not by the screen: walking to another page no longer replaces it.
  // That also retires pinnedThread — it existed only to stop navigation from
  // swapping a conversation mid-thought after following a citation, which is
  // now simply what happens by default.
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const setPendingContext = useChatStore((s) => s.setPendingContext)
  const refreshConversations = useChatStore((s) => s.refreshConversations)
  const newConversation = useChatStore((s) => s.newConversation)
  const openConversation = useChatStore((s) => s.openConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  // The docked composer is absolutely positioned OVER the transcript, so the
  // transcript must reserve room for it. That reservation was a fixed pb-44
  // (176px), which is only right while the composer happens to be that tall:
  // tag several references and the chips wrap onto more rows, the composer grows
  // past the reservation, and it covers the newest messages — the chat appears
  // to vanish underneath the tags. Measure it instead of assuming.
  const composerRef = useRef<HTMLFormElement | null>(null)
  const [composerH, setComposerH] = useState(176)
  useEffect(() => {
    const el = composerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      // A little breathing room so the last line never sits flush against it.
      setComposerH(Math.ceil(el.getBoundingClientRect().height) + 12)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // The conversation's referenced objects (Phase 4.3) — one layer holding both
  // typed "@" mentions and clicked widgets. Shown only on the conversation they
  // belong to; the click half of the lifecycle runs in useAssistantWidgetPin,
  // mounted by AssistantOverlay. This panel renders the row and its ×.
  const mentions = useChatStore((s) => s.mentions)
  const removeMentionRef = useChatStore((s) => s.removeMentionRef)
  const addMentionRef = useChatStore((s) => s.addMentionRef)
  const mentionResolution = useChatStore((s) => s.mentionResolution)
  const mentionsByMessage = useChatStore((s) => s.mentionsByMessage)
  const conversationKey = activeConversationId ?? NEW_CHAT_KEY
  // A conversation carries the context it STARTED in; only a brand-new one
  // takes its framing from the screen you are on right now. So an old chat
  // still says what it was about, and never relabels itself as you walk around.
  const activeMeta = useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId]
  )
  const startedIn = activeMeta?.context ?? null
  // The desks this conversation produced (Plexii P5) — element 0 is the
  // primary: the pinned chip and the default push target.
  const linkedDesks = useMemo(() => activeMeta?.linkedDesks ?? [], [activeMeta])
  const primaryDeskId = linkedDesks[0] ?? null
  const linkConversationDesk = useChatStore((s) => s.linkDesk)
  // Discovery mode (Plexii P6): per-conversation, switchable at any time.
  // Subscribed through the fields it derives from so the badge re-renders.
  const pendingMode = useChatStore((s) => s.pendingMode)
  const setChatMode = useChatStore((s) => s.setMode)
  const mode = activeConversationId ? (activeMeta?.mode ?? 'chat') : pendingMode
  const discovering = mode === 'discovery'
  // The web-search globe (A4, R21): per-conversation and sticky, default on.
  // Same derivation pattern as the mode above.
  const pendingWebSearch = useChatStore((s) => s.pendingWebSearch)
  const setWebSearch = useChatStore((s) => s.setWebSearch)
  const webSearchOn = activeConversationId ? (activeMeta?.webSearch ?? true) : pendingWebSearch
  const thread = {
    key: conversationKey,
    label: startedIn?.label ?? ctx.label,
    title: startedIn?.title ?? ctx.title,
    icon: startedIn?.icon ?? ctx.icon,
    // The desk handed to the server for task-scoped context: the one you are
    // on NOW when there is one; otherwise the conversation's primary linked
    // desk (Plexii P5), so a hub chat with a desk works IN that desk — pushes
    // land there and the model can see its canvas.
    serverTaskId: ctx.serverTaskId ?? primaryDeskId
  }
  // Where an approved card lands: the desk on screen when there is one,
  // otherwise the conversation's primary linked desk — so a hub push builds on
  // the conversation's own desk instead of failing for want of a canvas.
  const applyTaskId = activeTaskId ?? primaryDeskId
  // The primary desk's live node, for the pinned chip. A deleted desk renders
  // the honest stale state instead of a link that goes nowhere.
  const primaryDeskNode = primaryDeskId ? nodes.find((n) => n.id === primaryDeskId) ?? null : null
  const [deskMenuOpen, setDeskMenuOpen] = useState(false)
  const deskMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!deskMenuOpen) return
    function onPointerDown(e: PointerEvent): void {
      if (!deskMenuRef.current?.contains(e.target as Node)) setDeskMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [deskMenuOpen])
  // Desk-to-chat continuity, door 2 (A5, AI-04 — R24): the assistant OPENING
  // over a desk lands in the conversation that built it, by default. The panel
  // unmounts while closed, so "opening" is observed two ways: this panel
  // mounting while the chrome is already open (the pill/shortcut path), and
  // the closed→open transition for any mode that keeps it mounted. Guards
  // (never hijack the desk's own conversations or a live unsaved chat) live in
  // the store action so both observers behave identically.
  const chromeOpen = useAssistantChrome((s) => s.open)
  const prevChromeOpenRef = useRef(false)
  useEffect(() => {
    const was = prevChromeOpenRef.current
    prevChromeOpenRef.current = chromeOpen
    if (was || !chromeOpen) return
    if (ctx.kind !== 'desk' || !ctx.serverTaskId) return
    void useChatStore.getState().defaultToDeskConversation(ctx.serverTaskId)
  }, [chromeOpen, ctx])

  // The conversation-mode chip's menu (A4, R19). Body portal, the
  // EnginePickerChip idiom: the chip lives inside glass (backdrop-filter =
  // its own stacking context) where an absolute child gets buried under
  // sibling cards — the probe's first shot caught exactly that ghosting.
  // ("conv" — the CHROME display-mode menu lives in AssistantHeader now.)
  const [convModeMenuOpen, setConvModeMenuOpen] = useState(false)
  const convModeMenuRef = useRef<HTMLDivElement | null>(null)
  const convModeMenuPopRef = useRef<HTMLDivElement | null>(null)
  const [convModeMenuPos, setConvModeMenuPos] = useState<{ bottom: number; left: number } | null>(
    null
  )
  useEffect(() => {
    if (!convModeMenuOpen) return
    const place = (): void => {
      const r = convModeMenuRef.current?.getBoundingClientRect()
      if (!r) return
      setConvModeMenuPos({
        bottom: window.innerHeight - r.top + 6,
        left: Math.max(8, Math.min(r.left, window.innerWidth - 258))
      })
    }
    place()
    window.addEventListener('resize', place)
    function onPointerDown(e: PointerEvent): void {
      const t = e.target as Node
      if (!convModeMenuRef.current?.contains(t) && !convModeMenuPopRef.current?.contains(t)) {
        setConvModeMenuOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('pointerdown', onPointerDown)
    }
  }, [convModeMenuOpen])
  const openLinkedDesk = useCallback((taskId: string): void => {
    useNodeStore.getState().setActive(taskId)
    useViewStore.getState().goTask(taskId)
  }, [])
  const activeRefs = useMemo(() => activeMentions(mentions, thread.key), [mentions, thread.key])
  const messages = useMemo(
    () => messagesByTask[thread.key] ?? EMPTY_MESSAGES,
    [messagesByTask, thread.key]
  )
  // The trace for the send currently in flight on THIS thread. Scoped by
  // the active thread, not by the global `sending` flag, so a request started in another
  // context can't draw its progress here.
  const liveTrace = liveTraceByThread[thread.key]
  // The in-flight turn (A1). One trace instance for the whole send: it used
  // to render standalone before the first delta and then remount inside the
  // streaming turn, restarting its reveal from zero — the "searching twice"
  // defect from Caleb's drive. The container after the map now owns the
  // entire live turn. `streaming` is thread-true because liveTrace is
  // per-thread; `sending` alone is global and can belong to another
  // conversation's request.
  const streaming = sending && !!liveTrace
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null
  const streamingMsg = streaming && lastMsg?.role === 'assistant' ? lastMsg : null
  // The drain (AI-30, Caleb: "same pace to the end"). The store settles the
  // instant the stream closes, but the waves still on their way must keep
  // landing at reading pace — so the live turn stays mounted for the answer
  // that just finished until its last wave is on screen, and only then does
  // the turn render through the block pipeline (trace folded, cards in).
  // The same StreamingProse instance carries across, so no reveal restarts.
  // Derived at render time, not in an effect: the child's onDrained can fire
  // in the very commit the stream closes, and an effect-set flag would miss
  // it and leave the turn draining forever.
  const lastStreamingTs = useRef<number | null>(null)
  if (streamingMsg) lastStreamingTs.current = streamingMsg.ts
  const [drainedTs, setDrainedTs] = useState<number | null>(null)
  const drainingMsg =
    !streaming &&
    lastMsg?.role === 'assistant' &&
    lastMsg.ts === lastStreamingTs.current &&
    drainedTs !== lastMsg.ts
      ? lastMsg
      : null
  // The turn whose drain just ended: its cards cascade in once (AI-12). The
  // flag outlives the cascade by a beat and then clears, so a navigation
  // back to this page never replays it.
  const [enteringTs, setEnteringTs] = useState<number | null>(null)
  useEffect(() => {
    if (enteringTs === null) return
    const id = window.setTimeout(() => setEnteringTs(null), 1500)
    return () => window.clearTimeout(id)
  }, [enteringTs])
  const drainingTs = drainingMsg?.ts ?? null
  const endDrain = useCallback((): void => {
    if (drainingTs === null) return
    setDrainedTs(drainingTs)
    setEnteringTs(drainingTs)
  }, [drainingTs])
  const liveMsg = streamingMsg ?? drainingMsg
  const liveTurnTrace = liveTrace ?? (drainingMsg ? traceByMessage[String(drainingMsg.ts)] : undefined)
  // "Tree lands first": the first wave waits for the source cascade, timed
  // from the moment retrieval actually landed — an answer that arrives after
  // a long think never waits on a cascade that finished seconds ago.
  const holdUntil =
    liveTurnTrace && liveTurnTrace.retrievedAt !== null
      ? liveTurnTrace.retrievedAt + cascadeDurationMs(liveTurnTrace.sources.length)
      : 0
  const visibleMessages = liveMsg ? messages.slice(0, -1) : messages
  // The follow-up question that is live for the displayed thread, if any —
  // attached to the last message and neither answered nor dismissed. Derived
  // by a pure, tested rule (lib/assistantQuestion).
  const activeQuestion = activeQuestionFor(messages, questionByMessage)
  // Keep the pending context in step with the screen while the chat is still
  // unsaved, so the conversation it becomes remembers where it began.
  useEffect(() => {
    if (activeConversationId === null) {
      setPendingContext({ kind: ctx.kind, label: ctx.label, title: ctx.title, icon: ctx.icon })
    }
  }, [activeConversationId, ctx.kind, ctx.label, ctx.title, ctx.icon, setPendingContext])
  // The history list backs both the rail and the context of the open chat.
  useEffect(() => {
    void refreshConversations()
  }, [refreshConversations])
  // Load the people directory once the panel is live, so @-mentioning a
  // colleague works without opening the org admin screen first. Fails quiet:
  // signed out or personal-workspace leaves it empty and offers nobody.
  useEffect(() => {
    void usePeopleStore.getState().load()
  }, [])
  // ⌘O / Ctrl+O starts a new conversation from anywhere, in every mode. Checked
  // free of conflicts: App.tsx's global handlers use ⌘⇧K, ⌘/ and ⌘Z only.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== 'o') return
      e.preventDefault()
      newConversation()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newConversation])
  // The composer is a TipTap editor now (Phase 4.3), so the draft lives in its
  // document. `draft` mirrors the plain-text rendering purely so Send can be
  // disabled on an empty box — the document remains the source of truth.
  const [draft, setDraft] = useState('')
  // The composer as the mascot's omnibar door (A2, AI-01, R11): what Enter
  // will do is previewed, Tab flips the pick, and it never guesses silently.
  const [omniPick, setOmniPick] = useState(0)
  // The mode pills (Caleb's seamless ruling): Auto = smart preview; Search
  // and Ask lock the composer to one behaviour, sticky across sessions.
  const [composerMode, setComposerModeState] = useState<'auto' | 'search' | 'ask'>(() => {
    try {
      const v = localStorage.getItem('fb.omni.mode.composer')
      if (v === 'search' || v === 'ask') return v
    } catch {
      /* fresh profile */
    }
    return 'auto'
  })
  const setComposerMode = (m: 'auto' | 'search' | 'ask'): void => {
    setComposerModeState(m)
    try {
      localStorage.setItem('fb.omni.mode.composer', m)
    } catch {
      /* ignore */
    }
  }
  const editorRef = useRef<import('@tiptap/core').Editor | null>(null)
  // Draft persistence (A1, defect AI-16): the panel unmounts when you walk to
  // a desk or collapse to the pill, and the draft used to live only in the
  // editor — the walk ate what was being typed. Every change now mirrors the
  // document into the store per conversation; this pair restores it when the
  // editor (re)appears or the conversation changes. The key ref keeps the
  // change handler stable (TipTap captures onUpdate once, at creation).
  const draftKeyRef = useRef(conversationKey)
  draftKeyRef.current = conversationKey
  const loadedDraftKey = useRef<string | null>(null)
  const handleComposerChange = useCallback((text: string, doc: import('@tiptap/core').JSONContent): void => {
    setDraft(text)
    setOmniPick(0) // a changed input re-previews from its leading intent (R11)
    useChatStore.getState().setThreadDraft(draftKeyRef.current, text.trim() ? doc : null)
  }, [])
  const restoreDraft = useCallback((ed: import('@tiptap/core').Editor, key: string): void => {
    if (loadedDraftKey.current === key) return
    loadedDraftKey.current = key
    const stored = useChatStore.getState().draftDocByThread[key]
    if (stored) {
      ed.commands.setContent(stored)
      setDraft(docToInput(stored).text)
    } else if (!ed.isEmpty) {
      // Switching to a conversation that has no draft: the box belongs to it
      // now, and the previous conversation's words are safe under its own key.
      ed.commands.clearContent()
      setDraft('')
    }
  }, [])
  useEffect(() => {
    const ed = editorRef.current
    if (ed) restoreDraft(ed, conversationKey)
  }, [conversationKey, restoreDraft])
  // Fill the composer without sending — what the suggestion rows and home cards
  // have always done. Goes through the editor because there is no textarea to
  // set a value on any more.
  const fillComposer = useCallback((text: string): void => {
    const ed = editorRef.current
    if (!ed) return
    ed.chain().focus().clearContent().insertContent(text).run()
    setDraft(text)
  }, [])
  // Voice staging (A3, R17): a held-mascot transcript lands HERE for review —
  // filled and focused under the R11 preview strip, never sent. The store
  // draft covers the closed-panel path (restoreDraft on mount); this event
  // covers a panel that is already open, whose editor fills live.
  useEffect(() => {
    function onStage(e: Event): void {
      const text = (e as CustomEvent<string>).detail
      if (typeof text === 'string' && text.trim()) fillComposer(text)
    }
    window.addEventListener('fb:composer-stage', onStage)
    return () => window.removeEventListener('fb:composer-stage', onStage)
  }, [fillComposer])
  // Insert an answer into the document currently open in the editor (the doc
  // exposes itself as window.__docEditor). This gives the one assistant the
  // "drop the answer into my doc" capability the old in-doc panel had, so the
  // separate doc AI tab is no longer needed.
  const insertIntoDoc = useCallback((content: string): void => {
    const ed = (window as unknown as { __docEditor?: import('@tiptap/core').Editor }).__docEditor
    if (!ed) return
    ed.chain().focus().insertContent(content).run()
  }, [])
  // Which turn most recently had its text copied — drives the ✓ confirmation on
  // the copy button, then clears itself.
  const [copiedTs, setCopiedTs] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const createWidget = useWidgetStore((s) => s.create)
  const bumpLayout = useWidgetStore((s) => s.bumpLayoutVersion)
  // Display mode (sidebar / floating / fullscreen) — chrome state, not
  // conversation state; the switch itself lives in AssistantHeader now.
  const chromeMode = useAssistantChrome((s) => s.mode)
  const historyOpen = useAssistantChrome((s) => s.historyOpen)
  const setHistoryOpen = useAssistantChrome((s) => s.setHistoryOpen)
  // Fullscreen with an empty thread renders as Notion's AI home (3a.4):
  // greeting and composer centered as a group, capability row and suggestion
  // cards under the input. Same panel, same nodes — only layout classes
  // change, so the draft and every store subscription survive the swap.
  const isFullscreen = page || chromeMode === 'fullscreen'
  const fullscreenHome = isFullscreen && messages.length === 0

  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    selection: string
  } | null>(null)

  async function saveSelection(kind: 'sticky' | 'note', text: string): Promise<void> {
    if (!activeTaskId) {
      alert('Pick a task first — the saved note attaches to whichever task is on the desk.')
      return
    }
    const trimmed = text.trim()
    if (!trimmed) return
    // Place near the canvas origin with a small random jitter so multiple saves don't overlap exactly.
    const jitterX = Math.floor(Math.random() * 40)
    const jitterY = Math.floor(Math.random() * 40)
    await createWidget({
      taskId: activeTaskId,
      kind,
      title: kind === 'sticky' ? '' : 'From assistant',
      content: trimmed,
      x: 80 + jitterX,
      y: 80 + jitterY,
      width: kind === 'sticky' ? 240 : 360,
      height: kind === 'sticky' ? 200 : 280,
      color: kind === 'sticky' ? '#fef08a' : null
    })
    chimeIn()
    bumpLayout()
    // Drop the browser selection so the right-click feels resolved
    window.getSelection()?.removeAllRanges()
  }

  function handleMessagesContextMenu(e: React.MouseEvent): void {
    const selection = window.getSelection()?.toString() ?? ''
    if (!selection.trim()) return // let the default browser menu show (or nothing)
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, selection })
  }

  function ctxMenuItems(): CtxMenuItem[] {
    if (!ctxMenu) return []
    const text = ctxMenu.selection
    const noTask = !activeTaskId
    return [
      {
        // DEC-044: a highlight in the CHAT marks the same way one in a doc
        // does — first row, first line titles it, the full selection rides
        // the notes. Works with no desk open (the item files standalone).
        label: 'Add to Attention…',
        icon: 'notifications',
        onClick: () => {
          // 'ai-chat' lands the preset's DEFAULT class (to_do): a highlighted
          // AI answer is usually something to act on — 'chat' would map to
          // to_respond, but nobody awaits words back from a bot.
          const p = presetForSelection('ai-chat', text)
          window.dispatchEvent(
            new CustomEvent('fb:command-new-work-item', {
              detail: {
                captureText: p.text,
                notes: p.notes || undefined,
                source: {
                  sourceType: 'chat',
                  sourceRef: activeConversationId ?? 'chat',
                  intentClass: p.intentClass,
                  deskId: activeTaskId
                }
              }
            })
          )
          window.getSelection()?.removeAllRanges()
        }
      },
      { separator: true },
      {
        label: 'Save selection as sticky',
        icon: 'sticky_note_2',
        disabled: noTask,
        onClick: () => void saveSelection('sticky', text)
      },
      {
        label: 'Save selection as note',
        icon: 'description',
        disabled: noTask,
        onClick: () => void saveSelection('note', text)
      },
      { separator: true },
      {
        label: 'Copy',
        icon: 'content_copy',
        onClick: () => void navigator.clipboard?.writeText(text)
      }
    ]
  }

  useEffect(() => {
    void checkApiKey()
  }, [checkApiKey])

  // Scroll discipline (P3): follow the conversation only while the reader is
  // already at the bottom (within ~100px). Scrolling up locks the position —
  // an answer must never yank the page out from under a reading eye — and a
  // "Jump to latest" pill offers the way back. A ResizeObserver on the column
  // follows the smoothed reveal, whose height grows between store updates.
  const stickRef = useRef(true)
  const columnRef = useRef<HTMLDivElement | null>(null)
  const [showJump, setShowJump] = useState(false)
  const jumpTimer = useRef<number | null>(null)
  // The follow glides (AI-30). Content now grows a wave at a time rather
  // than a character at a time, so snapping scrollTop to the bottom on every
  // resize would yank the transcript by a wave's height each beat once the
  // answer overflows the viewport. Instead the viewport eases toward the
  // bottom on the frame clock, re-reading the target every frame so it
  // tracks growth that lands mid-glide. Reduced motion snaps as before.
  const followRaf = useRef(0)
  const following = useRef(false)
  const syncStickRef = useRef<() => void>(() => {})
  const followBottom = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.scrollTop = el.scrollHeight
      return
    }
    cancelAnimationFrame(followRaf.current)
    let expected = el.scrollTop
    const step = (): void => {
      const now = scrollRef.current
      if (!now || !stickRef.current) {
        following.current = false
        return
      }
      // The reader moved the viewport themselves since the last frame: the
      // glide lets go at once and the stick rule re-measures from there.
      if (Math.abs(now.scrollTop - expected) > 2) {
        following.current = false
        syncStickRef.current()
        return
      }
      const target = now.scrollHeight - now.clientHeight
      const d = target - now.scrollTop
      if (Math.abs(d) < 0.5) {
        now.scrollTop = target
        following.current = false
        return
      }
      now.scrollTop += d * 0.2
      expected = now.scrollTop
      followRaf.current = requestAnimationFrame(step)
    }
    following.current = true
    followRaf.current = requestAnimationFrame(step)
  }, [])
  useEffect(() => () => cancelAnimationFrame(followRaf.current), [])
  const syncStick = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    // Our own glide fires scroll events; mid-glide the distance can read as
    // "left the bottom" for a frame. Only the reader's scrolling counts.
    if (following.current) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    const stick = dist < 100
    stickRef.current = stick
    // The pill appears only after the reader has genuinely left the bottom
    // (150ms debounce, real scrollback below them) — a single-frame layout
    // wobble must never flash chrome into the transcript.
    if (stick) {
      if (jumpTimer.current !== null) window.clearTimeout(jumpTimer.current)
      jumpTimer.current = null
      setShowJump(false)
    } else if (jumpTimer.current === null) {
      jumpTimer.current = window.setTimeout(() => {
        jumpTimer.current = null
        const now = scrollRef.current
        if (!now) return
        // Re-measure live: layout may have settled back to the bottom since
        // the scroll event that armed this timer.
        const nowDist = now.scrollHeight - now.scrollTop - now.clientHeight
        if (nowDist >= 100 && now.scrollHeight - now.clientHeight > 40) setShowJump(true)
        else stickRef.current = true
      }, 150)
    }
  }, [])
  syncStickRef.current = syncStick
  const jumpToLatest = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = true
    setShowJump(false)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])
  useEffect(() => {
    const el = scrollRef.current
    const col = columnRef.current
    if (!el || !col) return
    const ro = new ResizeObserver(() => {
      if (stickRef.current) followBottom()
      else syncStick()
    })
    ro.observe(col)
    return () => ro.disconnect()
  }, [syncStick, followBottom])
  // A new message (the user's own send, or a turn appearing) re-follows when
  // stuck; the length hook keeps the non-streamed reply path followed too.
  const lastMessageLen = messages.length > 0 ? messages[messages.length - 1].content.length : 0
  useEffect(() => {
    if (stickRef.current && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    // Completion swaps the streaming renderer for the block pipeline, which
    // changes content height without changing message count — re-measure so
    // the pill cannot linger over a transcript that is in fact at its end.
    if (!sending) syncStick()
  }, [messages.length, lastMessageLen, sending, syncStick])

  // What "take me to X" can reach from the composer: fixed pages, desks, and
  // documents. Same OmniTarget shape the palette's classifier speaks.
  const docList = useDocumentsStore((s) => s.list)
  const omniTargets = useMemo<OmniTarget[]>(
    () => [
      { kind: 'page', id: 'home', title: 'Home' },
      { kind: 'page', id: 'tasks', title: 'Tasks' },
      { kind: 'page', id: 'calendar', title: 'Calendar' },
      { kind: 'page', id: 'files', title: 'Files' },
      { kind: 'page', id: 'vault', title: 'Vault' },
      ...nodes
        .filter((n) => n.kind === 'task')
        .map((n) => ({ kind: 'desk' as const, id: n.id, title: n.title || 'Untitled desk' })),
      ...docList.map((d) => ({ kind: 'document' as const, id: d.id, title: d.title || 'Untitled' }))
    ],
    [nodes, docList]
  )
  // DEC-027: capability probe for the deterministic @attention interception —
  // at mount, re-probed when the Settings toggle flips.
  const [workItemsOn, setWorkItemsOn] = useState(false)
  useEffect(() => {
    const probe = (): void => {
      window.api.workItems
        .enabled()
        .then(setWorkItemsOn)
        .catch(() => {})
    }
    probe()
    window.addEventListener('fb:workitems-toggled', probe)
    return () => window.removeEventListener('fb:workitems-toggled', probe)
  }, [])

  const composerIntents = useMemo(
    // Mid-conversation, short phrases are usually replies, so chat leads;
    // on a fresh conversation the same phrase is searchy and the web leads
    // (the instant ruling). Deterministic intents divert either way.
    //
    // …EXCEPT while the draft is a leading-@attention capture: submitComposer
    // intercepts that before any intent runs, so Enter files it and can never
    // search. The strip exists to say what Enter will do (R11), so offering
    // "Search the web" here was a false promise — and on a fresh conversation
    // it even rendered as the PRE-SELECTED ⏎ action (operator live QA). One
    // predicate, shared with the send path, so the two can never disagree.
    () =>
      workItemsOn && hasAttentionCommand(draft)
        ? []
        : composerOmniIntents(draft, omniTargets, { chatFirst: messages.length > 0 }),
    [draft, omniTargets, messages.length, workItemsOn]
  )
  const pickedIntent: OmniIntent | null =
    composerIntents.length > 0
      ? composerIntents[Math.min(omniPick, composerIntents.length - 1)]
      : null

  // Perform a non-chat intent and clear the box — the shared act every door
  // uses (lib/omniPerform), so the three doors stay one door.
  const performOmniIntent = useCallback((intent: OmniIntent): void => {
    performOmniIntentAct(intent)
    editorRef.current?.commands.clearContent()
    setDraft('')
    setOmniPick(0)
    useChatStore.getState().setThreadDraft(draftKeyRef.current, null)
  }, [])

  // DEC-028: the inline capture card — @attention filed WITHOUT leaving the
  // chat. deskCtx is snapshotted at send so navigation can't re-target it.
  const [inlineCapture, setInlineCapture] = useState<{
    text: string
    deskCtx: { id: string; title: string } | null
  } | null>(null)
  const [inlineFiled, setInlineFiled] = useState<string | null>(null)

  const submitComposer = useCallback(async (): Promise<void> => {
    const ed = editorRef.current
    // The document is the source of truth: its chips serialise to "@Title" in
    // the text, and the references themselves ride from the store (they are
    // sticky to the conversation, not to this message).
    const content = ed ? docToInput(ed.getJSON()).text.trim() : draft.trim()
    if (!content || useChatStore.getState().sending) return
    // A locked mode is literal: Search always searches, Ask always chats.
    if (composerMode === 'search') {
      performOmniIntent({ kind: 'search', label: 'Search the web', url: content })
      return
    }
    // DEC-027/028 + DEC-031: @attention ANYWHERE is a DETERMINISTIC capture —
    // the confirm stop renders INLINE above the composer (the same shared card
    // as the console) so the operator never leaves the chat.
    //   leading → pure capture; the model never sees it.
    //   inline  → capture AND still send the message, token stripped, so a
    //             "build me X @attention" gets both halves. This replaced a
    //             prompt rule the model could ignore — and did (live QA: only
    //             the page was created, the item never reached the queue).
    const attn = workItemsOn ? parseAttentionCommand(content) : null
    if (attn && attn.mode !== 'none') {
      ed?.commands.clearContent()
      setDraft('')
      if (attn.captureText) {
        setInlineCapture({
          text: attn.captureText,
          deskCtx: deskCaptureContext(useViewStore.getState().view, useNodeStore.getState().nodes)
        })
        setInlineFiled(null)
      }
      // The conversational half of an inline token still runs.
      if (attn.mode === 'inline' && attn.messageText) {
        await send(thread.serverTaskId, attn.messageText, thread.key)
      }
      return
    }
    // Auto (the omni door, AI-01): when the previewed pick is a non-chat
    // intent, Enter performs it instead of sending — exactly what the strip
    // said it would do.
    if (composerMode === 'auto' && pickedIntent && pickedIntent.kind !== 'ask') {
      performOmniIntent(pickedIntent)
      return
    }
    ed?.commands.clearContent()
    setDraft('')
    await send(thread.serverTaskId, content, thread.key)
  }, [draft, send, thread.serverTaskId, thread.key, pickedIntent, performOmniIntent, composerMode, workItemsOn])

  async function handleSend(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    await submitComposer()
  }

  // Handed to the "@" suggestion plugin. Reading through getState keeps the
  // hooks object stable while still seeing live values, so re-configuring the
  // extension never throws the draft away.
  const mentionHooks = useMemo(
    () => ({
      conversationKey: (): string => thread.key,
      current: (): readonly MentionRef[] => useChatStore.getState().mentions,
      onPick: (ref: MentionRef): void => {
        addMentionRef(ref)
      }
    }),
    [thread.key, addMentionRef]
  )

  // Open the thing a citation points at.
  //
  // Where it goes is decided by targetForSource (pure, tested); this only
  // performs it. Two of the five kinds need a lookup first: a source names a
  // widget or a table, not the desk it sits on, so the canvas has to be resolved
  // before we can navigate to it. Routing matches PlexiSearchView's openHit, so
  // a citation and a search result for the same thing land in the same place.
  async function openSource(source: ChatSource): Promise<void> {
    const target = targetForSource(source)
    if (!target) return
    // Show it here if it can be shown here; otherwise go to it, exactly as
    // before. Following a citation to check something used to cost you your
    // place in the conversation — which is the wrong trade when the reference
    // is the evidence behind a decision you are in the middle of making.
    if (canPeek(target)) {
      useSourcePeek.getState().open(target, source.title ?? null)
      return
    }
    await goToSourceTarget(target)
  }

  async function copyTurn(content: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(content)
      const stamp = Date.now()
      setCopiedTs(stamp)
      // Clear the ✓ only if nothing else has been copied since.
      setTimeout(() => setCopiedTs((c) => (c === stamp ? null : c)), 1600)
    } catch {
      /* clipboard can be denied; failing to copy is not worth an error state */
    }
  }

  // Regenerate an assistant turn: drop it (and anything after) and re-send the
  // user message that produced it. Getting a bad answer should not mean
  // retyping the question.
  async function retryFrom(assistantIndex: number): Promise<void> {
    if (sending) return
    // Walk back to the user turn that produced this answer.
    let userIndex = -1
    for (let k = assistantIndex - 1; k >= 0; k--) {
      if (messages[k].role === 'user') {
        userIndex = k
        break
      }
    }
    if (userIndex < 0) return
    const question = messages[userIndex].content
    // Rewind to just before that question, then re-send it, so the request is
    // rebuilt with exactly the history it had the first time.
    rewindTo(thread.key, userIndex)
    await send(thread.serverTaskId, question, thread.key)
  }

  return (
    // In sidebar and floating modes the assistant is a floating rounded card,
    // the same chrome the desk sidebar / segment / PlexiOffice menus use. In
    // fullscreen it is deliberately NOT a card (operator's live-drive call:
    // "no borders and edges, it should just be the screen you are in") — the
    // panel goes flat and full-bleed and IS the page; readable width comes
    // from internal centered columns instead of an inset box.
    <aside
      className={
        isFullscreen
          ? 'fb-chat-container h-full w-full flex flex-col overflow-hidden bg-[var(--surface-base)] text-[var(--ink-100)]'
          : chromeMode === 'floating'
            ? // A5.5 (AI-39): in floating mode the OVERLAY wrapper is the
              // rounded card (tab strip included) — a card inside a card read
              // as a box with an inner outline, which is what Caleb saw.
              'fb-chat-container relative h-full w-full flex flex-col overflow-hidden bg-[var(--surface-raised)] text-[var(--ink-100)]'
            : `fb-chat-container relative ${FLOATING_MENU_ASIDE}`
      }
      style={isFullscreen || chromeMode === 'floating' ? undefined : FLOATING_MENU_STYLE}
      data-testid="assistant-panel"
    >
      {/* Fullscreen is the AI home, so it carries a permanent conversation rail
          beside the chat (plan D10). The narrow modes cannot give a rail the
          width without taking it from the conversation, so they get the same
          list as an overlay, toggled from the header. One component either
          way — two containers, not two implementations.

          The overlay half of that sentence was described here but never
          actually rendered, so for as long as history lived in the desk
          sidebar nobody noticed. It is wired now (the sidebar sublist is
          gone), which is what makes the assistant the one place conversations
          live. Opening one closes the overlay, so a pick returns you straight
          to the thread. */}
      <div className={isFullscreen ? 'flex-1 min-h-0 flex' : 'contents'}>
      {isFullscreen && (
        <ConversationList
          variant="rail"
          conversations={conversations}
          activeId={activeConversationId}
          onOpen={(id) => void openConversation(id)}
          onNew={newConversation}
          onDelete={(id) => void deleteConversation(id)}
        />
      )}
      {!isFullscreen && historyOpen && (
        <ConversationList
          variant="overlay"
          conversations={conversations}
          activeId={activeConversationId}
          onOpen={(id) => {
            void openConversation(id)
            setHistoryOpen(false)
          }}
          onNew={() => {
            newConversation()
            setHistoryOpen(false)
          }}
          onDelete={(id) => void deleteConversation(id)}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      <div className={isFullscreen ? 'flex-1 min-w-0 flex flex-col relative' : 'contents'}>
      {/* DEC-120 — the header moved to the overlay chrome (AssistantHeader,
          above the tabs); the page dresses itself with the same bar minus the
          display-mode and minimize doors. What stays here is the
          conversation's own context — the focused thread, Discovery, the
          linked desk — and Clear chat, shown only when there is one. */}
      {page && <AssistantHeader chrome={false} />}
      {(discovering || primaryDeskId || thread.title || messages.length > 0) && (
        <div className="px-3 pt-2.5 flex items-center gap-1.5 flex-wrap" data-testid="chat-context">
          {thread.title && (
            <span
              className="inline-flex items-center gap-1 fb-t-caption text-[var(--ink-50)] truncate max-w-[220px]"
              title={`Plexii is focused on ${thread.label} — ${thread.title}`}
            >
              <Icon name={thread.icon} size={12} className="text-[var(--ink-60)] shrink-0" />
              <span className="truncate">{thread.title}</span>
            </span>
          )}
          {/* The mode badge (Plexii P6) — visible whenever discovery is on,
              so the different posture is never a mystery. */}
          {discovering && (
            <span
              data-testid="chat-mode-badge"
              title="Discovery mode — Plexii is leading with questions toward a desk"
              className="inline-flex items-center gap-1 rounded-[var(--radius-chip)] bg-accent/10 px-1.5 py-px fb-t-caption font-medium text-[rgb(var(--accent))]"
            >
              <Icon name="plexii:discover" size={11} />
              Discovery
            </span>
          )}
          {/* The conversation's desk, pinned where the conversation lives
              (Plexii P5). Clicking goes to it; a deleted desk says so instead
              of linking nowhere. */}
          {primaryDeskId && (
            <>
              <button
                type="button"
                data-testid="chat-linked-desk"
                disabled={!primaryDeskNode}
                onClick={() => primaryDeskNode && openLinkedDesk(primaryDeskId)}
                title={
                  primaryDeskNode
                    ? `Open the linked desk — ${primaryDeskNode.title}`
                    : 'The linked desk was deleted'
                }
                className={`fb-press inline-flex max-w-full items-center gap-1 rounded-[var(--radius-chip)] px-1.5 py-0.5 fb-t-caption transition-colors ${
                  primaryDeskNode
                    ? 'bg-accent/10 text-[rgb(var(--accent))] hover:bg-accent/20'
                    : 'bg-[var(--surface-sunken)] text-[var(--ink-40)] cursor-default'
                }`}
              >
                <Icon name="desk" size={11} className="shrink-0" />
                <span className="truncate">
                  {primaryDeskNode ? primaryDeskNode.title : 'Desk removed'}
                </span>
              </button>
              {linkedDesks.length > 1 && (
                <span
                  className="fb-t-caption text-[var(--ink-50)]"
                  title={`${linkedDesks.length - 1} more linked desk${linkedDesks.length > 2 ? 's' : ''}`}
                >
                  +{linkedDesks.length - 1}
                </span>
              )}
            </>
          )}
          {messages.length > 0 && (
            <button
              onClick={() => clear(thread.key)}
              className="ml-auto icon-btn"
              title="Clear chat"
              aria-label="Clear chat"
              data-testid="chat-clear"
            >
              <Icon name="delete_sweep" size={15} />
            </button>
          )}
        </div>
      )}

      {hasApiKey === false && !signedIn && (
        <div className="m-3 p-3 fb-card bg-accent/10 fb-t-label text-[var(--ink-90)] leading-relaxed flex gap-2">
          <Icon name="auto_awesome" size={16} className="text-accent mt-0.5" />
          <div>
            <strong className="text-[var(--ink-100)]">Plexii is included free.</strong> Sign in
            and it just works, no API key to set up. Prefer to use your own Anthropic key?
            Add it in <strong>Settings → AI · API keys</strong> (encrypted in your system
            keychain, readable only on this Mac).
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        data-testid="chat-scroll"
        onContextMenu={handleMessagesContextMenu}
        onScroll={syncStick}
        style={fullscreenHome ? undefined : { paddingBottom: composerH }}
        className={
          fullscreenHome
            ? 'shrink-0 mt-auto w-full max-w-[640px] mx-auto px-6 pb-5'
            : 'flex-1 overflow-auto px-3 pt-5'
        }
      >
        {/* In fullscreen the flat page needs a readable column; elsewhere the
            card provides the width. Always the same wrapper node — classes
            only — so switching modes mid-conversation re-lays-out without
            remounting the panel. */}
        {/* Turn rhythm (F1): a question and its answer read as one pair —
            tight inside the pair, real air between pairs. The base gap is
            small; each USER turn opens a new pair with its own top margin. */}
        <div
          ref={columnRef}
          className={
            isFullscreen && !fullscreenHome ? 'max-w-[780px] mx-auto w-full space-y-3' : 'space-y-2.5'
          }
        >
        {fullscreenHome && (
          // The Notion-home greeting: centered over the composer. The
          // suggestion cards and capability row render under the composer,
          // inside the form below.
          <div data-testid="assistant-home" className="text-center">
            <h3 className="fb-t-hero fb-display text-[var(--ink-100)] mb-2">
              {discovering ? "What are we building?" : 'How can I help you today?'}
            </h3>
            <p className="fb-t-body text-[var(--ink-60)] leading-relaxed">
              {discovering
                ? 'Start anywhere — a question, an idea, a list, a business. I will ask my way through it with you, and we finish with a desk that brings it to life.'
                : ctx.intro}
            </p>
          </div>
        )}
        {messages.length === 0 && !fullscreenHome && discovering && (
          // Discovery in the narrow modes: its own invitation, no starter rows.
          <div className="mt-2 px-1" data-testid="assistant-empty-state">
            <h3 className="fb-t-title text-[var(--ink-100)] mb-1">
              What are we building?
            </h3>
            <p className="fb-t-caption text-[var(--ink-60)] leading-relaxed">
              Start anywhere — a question, an idea, a list, a business. I will ask my way through it
              with you, and we finish with a desk that brings it to life.
            </p>
          </div>
        )}
        {messages.length === 0 && !fullscreenHome && !discovering && (
          // Notion-mirror empty state: avatar, "How can I help you today?",
          // the per-screen intro, then iconed suggestion ROWS — the reference
          // layout. (The earlier wrap-chips predate the mirror direction.)
          // Content still comes from ctx per screen — no curated static list,
          // no invented "New" badges (plan D4).
          <div className="mt-2 px-1 flex flex-col" data-testid="assistant-empty-state">
            <h3 className="fb-t-title text-[var(--ink-100)] mb-1">
              How can I help you today?
            </h3>
            <p className="fb-t-caption text-[var(--ink-60)] leading-relaxed mb-4">{ctx.intro}</p>
            <div className="flex flex-col -mx-1">
              {ctx.suggestions.map((s) => (
                <button
                  key={s.text}
                  onClick={() => fillComposer(s.text)}
                  data-testid="chat-suggestion"
                  className="flex items-center gap-2.5 text-left fb-t-label px-2 py-2 rounded-[var(--radius-row)] text-[var(--ink-80)] hover:text-[var(--ink-100)] hover:bg-[var(--surface-sunken)] transition-colors"
                >
                  <Icon name={s.icon} size={15} className="text-accent shrink-0" />
                  <span className="truncate">{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {visibleMessages.map((m, i) => {
          // The user's turn is a quiet accent-tinted block, built from tokens so
          // it follows every theme. It used to be hardcoded stone-900/stone-100
          // — the one element in the panel that ignored the token system and so
          // stayed the same slab under futuristic and atelier.
          if (m.role === 'user') {
            // Any references this turn was sent with re-render as chips exactly
            // where they were typed (plan P1's first rendering). splitMentionText
            // only chips a reference whose own token is genuinely in the text —
            // so a turn shows what was actually sent, never a chip invented to
            // match a reference the words no longer contain.
            const turnRefs = mentionsByMessage[String(m.ts)] ?? []
            const segments = splitMentionText(m.content, turnRefs)
            return (
              <div
                key={i}
                data-testid="user-turn"
                className="ml-auto w-fit max-w-[70%] mt-8 first:mt-0 rounded-[var(--radius-card)] px-4 py-2.5 fb-chat-prose whitespace-pre-wrap bg-[rgb(var(--accent)/0.10)] text-[var(--ink-100)]"
              >
                {segments.length <= 1
                  ? m.content
                  : segments.map((seg, si) =>
                      seg.kind === 'text' ? (
                        <span key={si}>{seg.text}</span>
                      ) : (
                        <span
                          key={si}
                          data-testid="turn-mention-chip"
                          data-mention-id={seg.ref.id}
                          title={`${seg.ref.title} — referenced in this message`}
                          className="inline-flex items-center gap-1 rounded-[var(--radius-chip)] border border-[rgb(var(--accent)/0.35)] bg-[rgb(var(--accent)/0.14)] px-1.5 py-[1px] mx-[1px] align-baseline"
                        >
                          <Icon name={seg.ref.icon} size={11} className="shrink-0 text-accent" />
                          <span className="truncate max-w-[160px]">{seg.ref.title}</span>
                        </span>
                      )
                    )}
              </div>
            )
          }
          // Each assistant turn renders as an ordered list of typed blocks
          // rather than one markdown lump: the reply text, then one block per
          // proposal — connector-branded (Gmail / Calendar / Message) when the
          // action maps to an integration. Blocks are derived on this side from
          // the existing {reply, actions} response, so the backend contract is
          // untouched. Same path the Focus chat already uses.
          const proposals = proposalsByMessage[String(m.ts)] ?? []
          const sources = sourcesByMessage[String(m.ts)] ?? []
          const uiBlocks = blocksByMessage[String(m.ts)] ?? []
          const blocks = deriveAssistantBlocks(m, proposals, sources, uiBlocks)
          // Interactive blocks answer for the user only on the latest turn and
          // only while nothing is in flight — older blocks stay visible as a
          // record of what was offered, but no longer speak.
          const uiEnabled = i === messages.length - 1 && !sending
          // The sources this turn actually cites, read back off the derived
          // blocks rather than recomputed — so an inline [n] resolves to exactly
          // the chip below it, and the two can't disagree about what was cited.
          const citedSources =
            blocks.find((b): b is Extract<typeof b, { kind: 'sources' }> => b.kind === 'sources')
              ?.sources ?? []
          // Slice the composite-keyed applied-state down to THIS message,
          // re-keyed by plain proposalId, so ProposalCards stays store-shape
          // agnostic (the Focus chat passes the same shape).
          const appliedForMsg: Record<string, AppliedProposal> = {}
          for (const p of proposals) {
            const a = appliedProposals[appliedKey(m.ts, p.id)]
            if (a) appliedForMsg[p.id] = a
          }
          const finishedTrace = traceByMessage[String(m.ts)]
          const entering = enteringTs === m.ts
          let enteringIndex = 0
          return (
            <div key={i} className="group/turn flex flex-col gap-3" data-testid="assistant-turn">
              {/* No identity row (P2). The premium-chat convention is
                  unanimous: the asymmetry itself marks the speaker — user
                  turns sit right-anchored in a quiet tint, assistant turns are
                  flat full-width prose on the page. A repeated logo eyebrow
                  reads as messenger chrome, and the trace's summary line
                  already heads the answers that did retrieval work. */}
              {/* What produced this answer, above it — collapsed to a single
                  summary line once it has been read, absent entirely when
                  retrieval found nothing and no action was prepared. */}
              {finishedTrace && (
                <RetrievalTrace
                  trace={finishedTrace}
                  disclosure={traceDisclosureByMessage[String(m.ts)]}
                  onDisclosureChange={(state) => setTraceDisclosure(m.ts, state)}
                  onOpenSource={(s) => void openSource(s)}
                />
              )}
              {blocks.map((block, bi) => {
                const view = (
                  <ChatBlockView
                    block={block}
                    activeTaskId={applyTaskId}
                    appliedProposals={appliedForMsg}
                    onApplied={(id, applied) => markProposalApplied(m.ts, id, applied)}
                    onConsumeProposal={(id) => consumeProposal(m.ts, id)}
                    onOpenSource={(s) => void openSource(s)}
                    citedSources={citedSources}
                    uiEnabled={uiEnabled}
                    onUiSubmit={(text) => {
                      if (useChatStore.getState().sending) return
                      void send(thread.serverTaskId, text, thread.key)
                    }}
                  />
                )
                // The turn that just finished draining (AI-12, AI-30): its
                // cards and blocks cascade in with the app's tile entrance,
                // after the prose — the prose itself is already on screen
                // and must not flinch at the handoff. History never animates.
                if (entering && block.kind !== 'text') {
                  const at = enteringIndex++
                  return (
                    <div
                      key={bi}
                      className="fb-fade-in-up empty:hidden"
                      style={{ animationDelay: `${Math.min(at * 35, 350)}ms` }}
                    >
                      {view}
                    </div>
                  )
                }
                return (
                  <div key={bi} className="empty:hidden">
                    {view}
                  </div>
                )
              })}
              {/* Per-turn actions (P2): completion is a state change. Nothing
                  but the answer exists while it streams; the actions
                  materialize when the turn is done and reveal on hover/focus —
                  present for the pointer that goes looking, invisible to the
                  reading eye. Keyboard users get them via focus-within. */}
              <div
                className={`flex items-center gap-0.5 transition-opacity ${
                  sending && i === messages.length - 1
                    ? 'hidden'
                    : 'opacity-0 group-hover/turn:opacity-100 focus-within:opacity-100'
                }`}
              >
                <button
                  onClick={() => void copyTurn(m.content)}
                  title="Copy this reply"
                  className="icon-btn !h-6 !w-6"
                  data-testid="turn-copy"
                >
                  <Icon name={copiedTs === m.ts ? 'check' : 'content_copy'} size={12} />
                </button>
                {typeof window !== 'undefined' &&
                  !!(window as unknown as { __docEditor?: unknown }).__docEditor && (
                    <button
                      onClick={() => insertIntoDoc(m.content)}
                      title="Insert this into the document"
                      className="icon-btn !h-6 !w-6"
                      data-testid="turn-insert-doc"
                    >
                      <Icon name="post_add" size={12} />
                    </button>
                  )}
                <button
                  onClick={() => void retryFrom(i)}
                  disabled={sending}
                  title="Ask again — regenerate this reply"
                  className="icon-btn !h-6 !w-6"
                  data-testid="turn-retry"
                >
                  <Icon name="refresh" size={12} />
                </button>
              </div>
            </div>
          )
        })}
        {/* The live turn (A1): ONE container from send to completion, so the
            trace mounts once and never replays its reveal. Before the first
            delta it stands alone — retrieval genuinely is the pending state,
            and the trace says so truthfully. Once prose arrives,
            StreamingProse joins below and the trace settles in the same
            commit, so the ceremony never pushes the living text down. On
            completion this container unmounts and the finished message
            renders through the block pipeline with its trace already folded
            to the summary line (the store closes it at settle). */}
        {(streaming || drainingMsg) && (
          <div className="flex flex-col gap-3" data-testid="assistant-turn">
            {liveTurnTrace && (
              <RetrievalTrace
                trace={liveTurnTrace}
                settled={!!liveMsg}
                holdOpen={!!drainingMsg}
                onOpenSource={(s) => void openSource(s)}
              />
            )}
            {liveMsg && (
              <StreamingProse
                markdown={liveMsg.content}
                active={streaming}
                holdUntil={holdUntil}
                onDrained={endDrain}
              />
            )}
          </div>
        )}
        </div>
      </div>

      {/* The composer is one container that holds the field AND its actions,
          rather than a bare textarea with a detached Send button underneath.
          The whole box carries the focus ring, so it reads as a single control.
          In the fullscreen home it joins the greeting as one centered column
          (mt-auto above + mb-auto here center the pair), with the capability
          row and suggestion cards underneath. */}
      {/* The bottom region floats (F1). No dividing line anywhere: the
          composer hangs over the transcript on a soft fade of the page
          colour, and the transcript scrolls underneath (the scroll area
          carries matching bottom padding). */}
      <form
        ref={composerRef}
        onSubmit={handleSend}
        className={
          fullscreenHome
            ? 'p-3 pt-0 mb-auto w-full max-w-[640px] mx-auto'
            : 'absolute inset-x-0 bottom-0 z-20 px-3 pb-3 pt-10 pointer-events-none bg-gradient-to-t from-[var(--surface-base)] via-[color-mix(in_oklab,var(--surface-base)_85%,transparent)] to-transparent'
        }
      >
        {!fullscreenHome && showJump && (
          <div className="flex justify-center mb-2 pointer-events-none">
            <button
              type="button"
              onClick={jumpToLatest}
              data-testid="jump-to-latest"
              className="pointer-events-auto fb-glass-panel fb-press rounded-full h-7 px-3 flex items-center gap-1.5 fb-t-caption font-medium text-[var(--ink-90)] shadow-[var(--shadow-cast)]"
            >
              <span aria-hidden="true">↓</span> Jump to latest
            </button>
          </div>
        )}
        <div
          className={`pointer-events-auto ${isFullscreen && !fullscreenHome ? 'max-w-[780px] mx-auto w-full' : ''}`}
        >
        {/* Glass composer (P5), one surface that also asks (F1): the
            follow-up question docks inside this card — no separate box, no
            extra border. The edge-light is gone by ruling: the breathing
            double-i is the only thinking motion. */}
        <div className="relative fb-glass-panel rounded-[var(--radius-card)] px-2.5 pt-2 pb-1.5 flex flex-col gap-2 transition-shadow focus-within:border-[rgb(var(--accent)/0.55)] focus-within:shadow-[var(--shadow-cast),var(--shadow-inset-highlight),0_0_0_3px_rgb(var(--accent)/0.13)]">
          {activeQuestion && (
            <QuestionCard
              docked
              question={activeQuestion.question}
              disabled={sending}
              onDismiss={() => dismissQuestion(activeQuestion.messageTs)}
              onAnswer={(option) => {
                if (sending) return
                void send(thread.serverTaskId, option, thread.key)
              }}
            />
          )}
          {/* What this conversation is working from, restated at the point of
              typing. Either the objects it references (typed with "@" or
              clicked on the canvas — one layer, plan D7/D8) or, when it
              references nothing, the surface it is scoped to (Notion's 📄-chip
              pattern; same fact as the header subtitle, which in floating and
              fullscreen modes is far from the composer).

              The row is the live set: exactly what will ride the NEXT message.
              The chips INSIDE the box are per-message, and stay in the
              transcript as a record of what each message said. Two renderings,
              one set (plan P1). */}
          <div>
            {activeRefs.length > 0 ? (
              <MentionRefRow
                refs={activeRefs}
                resolution={mentionResolution}
                onRemove={(key) => removeMentionRef(thread.key, key)}
              />
            ) : (
              <span
                data-testid="composer-context-chip"
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--edge-soft)] bg-[var(--surface-sunken)] px-2 py-0.5 fb-t-caption text-[var(--ink-60)]"
                title={`This conversation is scoped to ${thread.title || thread.label}`}
              >
                <Icon name={thread.icon} size={11} className="shrink-0" />
                <span className="truncate">{thread.title || thread.label}</span>
              </span>
            )}
          </div>
          {composerMode === 'auto' && composerIntents.length > 0 && !sending && (
            /* The intent preview (R11): the composer says what Enter will do
               before it does it. Tab steps the pick; clicking a chip acts. */
            <div
              data-testid="composer-intent-row"
              className="flex items-center gap-1 flex-wrap fb-t-caption"
            >
              {composerIntents.map((intent, i) => {
                const selected = intent === pickedIntent
                return (
                  <button
                    key={`${intent.kind}-${intent.target?.id ?? ''}`}
                    type="button"
                    data-testid={`composer-intent-${intent.kind}`}
                    onClick={() =>
                      intent.kind === 'ask' ? setOmniPick(i) : performOmniIntent(intent)
                    }
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 border transition-colors ${
                      selected
                        ? 'border-[rgb(var(--accent)/0.5)] text-[rgb(var(--accent))] bg-[rgb(var(--accent)/0.08)]'
                        : 'border-[var(--edge-soft)] text-[var(--ink-50)] hover:text-[var(--ink-80)]'
                    }`}
                  >
                    <Icon
                      name={
                        intent.kind === 'url'
                          ? 'language'
                          : intent.kind === 'search'
                            ? 'travel_explore'
                            : intent.kind === 'goto'
                              ? 'arrow_forward'
                              : 'forum'
                      }
                      size={11}
                      className="shrink-0"
                    />
                    <span className="truncate max-w-[220px]">{intent.label}</span>
                    <span className="opacity-60 font-mono text-[9px]">{selected ? '⏎' : '⇥'}</span>
                  </button>
                )
              })}
            </div>
          )}
          {inlineCapture && (
            <div className="mb-2 rounded-[var(--radius-field)] border border-accent/35 bg-[var(--surface-raised)] p-2.5">
              <div className="flex items-center gap-2 mb-2">
                <span className="inline-flex items-center gap-1 px-1.5 h-5 rounded bg-accent/[0.14] text-[rgb(var(--accent))] fb-t-caption font-medium">
                  @attention
                </span>
                <span className="fb-t-caption text-[var(--ink-50)] truncate flex-1 min-w-0">
                  “{inlineCapture.text.slice(0, 60)}
                  {inlineCapture.text.length > 60 ? '…' : ''}”
                </span>
                <button
                  onClick={() => {
                    // Back to the composer, text restored where it was.
                    const restore = `@attention ${inlineCapture.text}`
                    setInlineCapture(null)
                    window.dispatchEvent(new CustomEvent('fb:composer-stage', { detail: restore }))
                  }}
                  title="Cancel — back to the message"
                  className="icon-btn !h-6 !w-6 shrink-0"
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
              <AttentionConfirmCard
                text={inlineCapture.text}
                deskCtx={inlineCapture.deskCtx}
                cancelLabel="Cancel"
                onFiled={(summary) => {
                  setInlineCapture(null)
                  setInlineFiled(summary)
                  setTimeout(() => setInlineFiled(null), 4000)
                }}
                onCancel={() => {
                  const restore = `@attention ${inlineCapture.text}`
                  setInlineCapture(null)
                  window.dispatchEvent(new CustomEvent('fb:composer-stage', { detail: restore }))
                }}
              />
            </div>
          )}
          {inlineFiled && (
            <div className="mb-2 flex items-center gap-1.5 fb-t-caption text-[var(--ink-60)]">
              <Icon name="check_circle" size={13} /> Filed to Attention · {inlineFiled}
            </div>
          )}
          <div
            onKeyDownCapture={(e) => {
              // The "@" picker OWNS Tab whenever it is open (DEC-028's keyboard
              // contract: Tab picks the highlighted row). This handler is
              // capture-phase, so it runs BEFORE ProseMirror's suggestion
              // plugin — without this guard it swallowed every Tab, the picker
              // never saw one, and the stolen keystroke silently cycled the
              // intent to "Search the web" instead (operator live QA).
              if (e.key === 'Tab' && document.querySelector('[data-testid="mention-picker"]')) return
              // Tab flips the previewed intent (R11) — only while the strip
              // is showing, so normal focus travel is untouched otherwise.
              if (e.key === 'Tab' && !e.shiftKey && composerMode === 'auto' && composerIntents.length > 1) {
                e.preventDefault()
                e.stopPropagation()
                setOmniPick((p) => (p + 1) % composerIntents.length)
              }
            }}
          >
            <MentionComposer
              placeholder={
                composerMode === 'search'
                  ? 'Search the web — results open in Plexii'
                  : discovering
                    ? 'Start anywhere — an idea, a question, a hunch…'
                    : ctx.placeholder
              }
              disabled={sending}
              hooks={mentionHooks}
              onTextChange={handleComposerChange}
              onSubmit={() => void submitComposer()}
              onReady={(ed) => {
                editorRef.current = ed
                restoreDraft(ed, conversationKey)
              }}
            />
          </div>
          <div className="flex items-center gap-1.5">
            {/* The conversation-mode chip (A4, R19): a mode is a property of
                the conversation, worn here and switched deliberately — sticky
                on the row, never auto-detected. Discovery is the first of
                several; the menu is driven by the CHAT_MODES registry. */}
            <div className="relative flex items-center" ref={convModeMenuRef}>
              <button
                type="button"
                data-testid="chat-mode-chip"
                aria-expanded={convModeMenuOpen}
                onClick={() => setConvModeMenuOpen((v) => !v)}
                title={`${chatModeDef(mode).label} mode — ${chatModeDef(mode).blurb} Click to switch.`}
                className={`fb-press inline-flex items-center gap-1 h-[26px] px-2 rounded-full border fb-t-caption font-medium transition-colors ${
                  discovering
                    ? 'border-[rgb(var(--accent)/0.45)] bg-accent/10 text-[rgb(var(--accent))]'
                    : 'border-[var(--edge-soft)] bg-[var(--surface-sunken)] text-[var(--ink-70)] hover:text-[rgb(var(--accent))] hover:border-[rgb(var(--accent)/0.45)]'
                }`}
              >
                <Icon name={chatModeDef(mode).icon} size={12} className="shrink-0" filled={discovering} />
                <span className="fb-cq-label">{chatModeDef(mode).label}</span>
                <Icon name="expand_more" size={11} className="shrink-0 opacity-70" />
              </button>
              {convModeMenuOpen &&
                convModeMenuPos &&
                createPortal(
                <div
                  ref={convModeMenuPopRef}
                  data-testid="chat-mode-menu"
                  className="fb-pop-in fixed z-[240] w-[250px] rounded-[var(--radius-row)] border border-[var(--edge-soft)] bg-[var(--surface-raised)] p-1"
                  style={{
                    boxShadow: 'var(--shadow-cast)',
                    bottom: convModeMenuPos.bottom,
                    left: convModeMenuPos.left
                  }}
                >
                  {CHAT_MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      data-testid={`chat-mode-option-${m.id}`}
                      onClick={() => {
                        setChatMode(m.id)
                        setConvModeMenuOpen(false)
                      }}
                      className="w-full flex items-start gap-2 rounded-[var(--radius-chip)] px-2 py-1.5 text-left hover:bg-[var(--surface-sunken)] transition-colors"
                    >
                      <Icon
                        name={m.icon}
                        size={14}
                        className={`shrink-0 mt-px ${mode === m.id ? 'text-accent' : 'text-[var(--ink-60)]'}`}
                        filled={mode === m.id}
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block fb-t-label text-[var(--ink-90)]">{m.label}</span>
                        <span className="block fb-t-caption text-[var(--ink-50)]">{m.blurb}</span>
                      </span>
                      {mode === m.id && (
                        <Icon name="check" size={13} className="text-accent shrink-0 mt-px" />
                      )}
                    </button>
                  ))}
                </div>,
                document.body
              )}
            </div>
            {/* The globe (A4, R21): web search's visible control. Lit when the
                conversation's turns run the live web search; a tap toggles and
                sticks on the row. The trace stays honest either way — an off
                turn never claims a search (retrievalIntent + searched). */}
            <button
              type="button"
              onClick={() => setWebSearch(!webSearchOn)}
              aria-pressed={webSearchOn}
              data-testid="chat-web-globe"
              title={
                webSearchOn
                  ? 'Web search is ON for this conversation — substantive turns search the live web. Click to turn off.'
                  : 'Web search is OFF for this conversation — answers use only your workspace. Click to turn on.'
              }
              className={`fb-press inline-flex items-center justify-center h-[26px] w-[26px] rounded-full border transition-colors ${
                webSearchOn
                  ? 'border-[rgb(var(--accent)/0.45)] bg-accent/10 text-[rgb(var(--accent))]'
                  : 'border-[var(--edge-soft)] bg-[var(--surface-sunken)] text-[var(--ink-40)] hover:text-[var(--ink-70)]'
              }`}
            >
              <Icon name={webSearchOn ? 'language' : 'public_off'} size={13} />
            </button>
            {/* The mode pills (Caleb's seamless ruling): tapping acts on the
                current text AND locks the mode until switched (sticky). */}
            <div
              data-testid="composer-modes"
              className="inline-flex items-center gap-0.5 rounded-full bg-[var(--surface-sunken)] p-0.5"
            >
              {(
                [
                  { id: 'auto', label: 'Auto', icon: 'auto_awesome' },
                  { id: 'search', label: 'Search', icon: 'travel_explore' },
                  { id: 'ask', label: 'Ask', icon: 'forum' }
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  data-testid={`composer-mode-${m.id}`}
                  aria-pressed={composerMode === m.id}
                  title={
                    m.id === 'auto'
                      ? 'Smart: URLs open, take-me-to navigates, everything else asks'
                      : m.id === 'search'
                        ? 'Type straight into your search engine — results open in Plexii'
                        : 'Everything goes to Plexii'
                  }
                  onClick={() => {
                    setComposerMode(m.id)
                    // Both semantics: a pill tap acts on what is typed.
                    const text = draft.trim()
                    if (!text || sending) return
                    if (m.id === 'search') {
                      performOmniIntent({ kind: 'search', label: 'Search the web', url: text })
                    } else if (m.id === 'ask') {
                      editorRef.current?.commands.clearContent()
                      setDraft('')
                      void send(thread.serverTaskId, text, thread.key)
                    }
                  }}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full fb-t-caption transition-colors ${
                    composerMode === m.id
                      ? 'bg-[var(--surface-raised)] text-[rgb(var(--accent))]'
                      : 'text-[var(--ink-50)] hover:text-[var(--ink-80)]'
                  }`}
                >
                  <Icon name={m.icon} size={11} className="shrink-0" />
                  {m.label}
                </button>
              ))}
            </div>
            {/* Real model picker (P7) — shared with the focus AI Chat. */}
            <ModelPickerChip />
            {/* The persistent out (Plexii P5): any conversation with substance
                can become a desk, and a conversation that has one can push
                what's new to it. Both ride the normal proposal pipeline — the
                model proposes, the user approves, nothing lands silently. */}
            {messages.length > 0 && (
              <div className="relative flex items-center" ref={deskMenuRef}>
                <button
                  type="button"
                  data-testid="chat-turn-into-desk"
                  disabled={sending}
                  onClick={() => {
                    if (useChatStore.getState().sending) return
                    void send(
                      thread.serverTaskId,
                      primaryDeskId ? PUSH_TO_DESK_MESSAGE : TURN_INTO_DESK_MESSAGE,
                      thread.key
                    )
                  }}
                  title={
                    primaryDeskId
                      ? 'Push to desk — Plexii proposes what is new from this conversation as cards you approve'
                      : 'Turn into desk — Plexii proposes the desk and its widgets as cards you approve'
                  }
                  className="fb-press inline-flex items-center gap-1 h-[26px] px-2 rounded-full border border-[var(--edge-soft)] bg-[var(--surface-sunken)] fb-t-caption font-medium text-[var(--ink-70)] hover:text-[rgb(var(--accent))] hover:border-[rgb(var(--accent)/0.45)] transition-colors disabled:opacity-50"
                >
                  <Icon name="desk" size={12} className="shrink-0" />
                  <span className="fb-cq-label">{primaryDeskId ? 'Push to desk' : 'Turn into desk'}</span>
                </button>
                {linkedDesks.length > 1 && (
                  <>
                    <button
                      type="button"
                      data-testid="chat-desk-switcher"
                      onClick={() => setDeskMenuOpen((v) => !v)}
                      title="Choose which linked desk pushes target"
                      aria-expanded={deskMenuOpen}
                      className="icon-btn !h-[26px] !w-5 -ml-0.5"
                    >
                      <Icon name="expand_more" size={13} />
                    </button>
                    {deskMenuOpen && (
                      <div
                        data-testid="chat-desk-menu"
                        className="fb-pop-in absolute bottom-full left-0 mb-1.5 z-30 min-w-[190px] rounded-[var(--radius-row)] border border-[var(--edge-soft)] bg-[var(--surface-raised)] p-1"
                        style={{ boxShadow: 'var(--shadow-cast)' }}
                      >
                        {linkedDesks.map((id) => {
                          const node = nodes.find((n) => n.id === id) ?? null
                          return (
                            <button
                              key={id}
                              type="button"
                              onClick={() => {
                                if (activeConversationId) {
                                  void linkConversationDesk(activeConversationId, id, true)
                                }
                                setDeskMenuOpen(false)
                              }}
                              className="w-full flex items-center gap-2 rounded-[var(--radius-chip)] px-2 py-1.5 fb-t-label text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] transition-colors"
                            >
                              <Icon name="desk" size={13} className="text-[var(--ink-60)] shrink-0" />
                              <span className="flex-1 min-w-0 truncate text-left">
                                {node ? node.title : 'Deleted desk'}
                              </span>
                              {id === primaryDeskId && (
                                <Icon name="check" size={13} className="text-accent shrink-0" />
                              )}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            <span className="flex-1" />
            {/* Send ⇄ Stop (P5): while Plexii writes, the primary control is
                stopping it — prominent, same seat, never buried. Stop keeps
                the partial answer (the abort path completes the turn with
                what already streamed). The square is drawn, not an icon. */}
            {sending ? (
              <button
                type="button"
                onClick={cancelSend}
                title="Stop — keeps what has been written so far"
                aria-label="Stop generating"
                data-testid="chat-stop"
                className="fb-press w-[26px] h-[26px] rounded-full grid place-items-center shrink-0 transition-colors bg-[rgb(var(--accent))] text-white hover:bg-[rgb(var(--accent-hover))]"
              >
                <span className="w-[9px] h-[9px] rounded-[2px] bg-current" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!draft.trim()}
                title="Send"
                aria-label="Send"
                className="fb-press w-[26px] h-[26px] rounded-full grid place-items-center shrink-0 transition-colors bg-[rgb(var(--accent))] text-white hover:bg-[rgb(var(--accent-hover))] disabled:bg-[var(--surface-sunken)] disabled:text-[var(--ink-40)] disabled:border disabled:border-[var(--edge-soft)]"
              >
                <Icon name="arrow_upward" size={14} />
              </button>
            )}
          </div>
        </div>
        {/* Discovery supplies its own invitation ("start anywhere"), so the
            normal-chat starters are suppressed there: "Draft an email" and
            "What should I work on next?" are the wrong offer for someone who
            came to explore an idea. */}
        {fullscreenHome && !discovering && (
          <>
            {/* What the assistant can genuinely act on today (P8), and a real
                entry point for each (3b — operator's call): clicking a chip
                sends its declared starter as a genuine user request; the
                question protocol gathers the specifics. Backed by real
                proposal kinds (lib/assistantCapabilities, type-locked). */}
            <div
              data-testid="assistant-capability-row"
              aria-label="What the assistant can act on"
              className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5"
            >
              {ASSISTANT_CAPABILITIES.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  data-testid="capability-chip"
                  data-starter={c.starter}
                  disabled={sending}
                  onClick={() => {
                    if (sending) return
                    void send(thread.serverTaskId, c.starter, thread.key)
                  }}
                  title={`Start now — sends “${c.starter}”; I'll ask for any details I need`}
                  className="inline-flex items-center gap-1 fb-t-caption text-[var(--ink-60)] hover:text-accent underline decoration-transparent hover:decoration-current underline-offset-2 transition-colors disabled:opacity-50"
                >
                  <Icon name={c.icon} size={12} className="shrink-0" />
                  {c.label}
                </button>
              ))}
            </div>
            {/* The per-screen suggestions as home cards under the input —
                Notion's preset options. Same ctx data as the panel rows; an
                offer that fills the composer, never a command. */}
            <div className="mt-5 grid grid-cols-2 gap-2">
              {ctx.suggestions.map((s) => (
                <button
                  key={s.text}
                  type="button"
                  data-testid="home-suggestion-card"
                  onClick={() => fillComposer(s.text)}
                  className="text-left px-3 py-2.5 rounded-[var(--radius-card)] border border-[var(--edge-soft)] bg-[var(--surface-raised)] hover:border-[rgb(var(--accent)/0.45)] hover:bg-[var(--surface-sunken)] transition-colors flex items-center gap-2.5"
                >
                  <Icon name={s.icon} size={15} className="text-accent shrink-0" />
                  <span className="fb-t-label text-[var(--ink-80)] truncate">{s.text}</span>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="flex justify-end mt-1.5">
          <span className="fb-t-caption font-mono text-[var(--ink-40)]">
            ↵ send · ⇧↵ newline
          </span>
        </div>
        </div>
      </form>
      </div>
      </div>
      {ctxMenu && (
        <CanvasContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenuItems()}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </aside>
  )
}
