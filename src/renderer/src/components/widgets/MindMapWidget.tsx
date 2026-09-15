import { useEffect, useMemo, useRef, useState } from 'react'
import MentionTextarea from '../MentionTextarea'
import type { ActionProposal, GoToTarget, Widget, WidgetKind } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import UnifiedConnectedMenu from '../contextMenu/UnifiedConnectedMenu'
import Icon from '../Icon'
import { useWidgetStore } from '../../stores/widgets'
import { useNodeStore } from '../../stores/nodes'
import { applyProposal } from '../../lib/actionExecutor'
import { resolveGoToTarget, goToTarget } from '../../lib/goToTarget'
import { catalogFor, entriesByCategory } from '../../lib/widgetCatalog'
import { setOrigin } from '../../lib/nodeCanvasOrigin'

// AI mind-mapper widget — Phase 1 + Phase 2 (this file).
//
// Phase 1: visual node tree, AI-driven branch expansion, agent
// recommendation per node, "convert to task" action.
//
// Phase 2A: agent creation wizard — when Claude returns 0 agent
// matches (or the user explicitly wants a fresh one), an in-app
// modal collects slug/description/model/tools/purpose and writes a
// new agent .md to .claude/agents/ via the main process.
//
// Phase 2B: node-attached widgets — every node can carry a list of
// linked widget ids. The side panel's "Tools" section lets the user
// spawn a real canvas widget of any kind, and a back-link is stored
// on the node so removing the node can offer to remove the widget
// too.
//
// Phase 2C foundation: single-turn agent invocation. Each suggested
// agent gets a Run button; invoking it returns ActionProposal[]
// rendered as accept/dismiss cards in the side panel. The actual
// proposals apply via the existing actionExecutor chain.
//
// PHASE_3 (multi-week, deferred): autonomous agent execution. Needs
// a watcher / scheduler, kill switches, token budget meter, audit
// log of every dispatch, and a trust-building UX surface so users
// don't get burned by silent autonomous edits. See agentDispatcher.ts
// for the markers and the bounded floor this file sits on top of.
//
// Data model — stored as JSON in widget.content:
//
//   {
//     "root": { id, label, kind, children: [...], attachedWidgetIds, assignedAgentSlugs },
//     "selectedId": "<node id or null>",
//     "agentSuggestions": { "<node-id>": [{slug,name,rationale}, ...] },
//     "agentInvocations": { "<node-id>:<slug>": { reply, proposals } }
//   }

type MindMapNodeKind = 'idea' | 'task' | 'question' | 'tool' | 'agent'
type AgentModelTier = 'haiku' | 'sonnet' | 'opus'
type AgentTool =
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'Bash'
  | 'Glob'
  | 'Grep'
  | 'WebFetch'
  | 'WebSearch'
  | 'Agent'

interface MindMapNode {
  id: string
  label: string
  kind: MindMapNodeKind
  rationale?: string
  children: MindMapNode[]
  // Phase 2B — ids of canvas widgets linked to this node. Lookup via
  // the widgets store; ids may dangle if a widget was deleted from
  // the canvas independently, so renderers must defend against that.
  attachedWidgetIds?: string[]
  // Phase 2C — agents the user has explicitly "assigned" to this
  // node (a future autonomous runtime would consult this list).
  assignedAgentSlugs?: string[]
  // Phase 2 polish — AI-generated children that haven't been accepted
  // yet. They render in the tree with a dashed outline + reduced
  // opacity so the user sees them in context but knows they're
  // proposals. Accept moves them to `children`; Reject drops them.
  // This implements the "triage child nodes before committing" UX
  // pattern from the task-starting AI flow.
  pendingChildren?: MindMapNode[]
  // Phase 3 — when a node is "explored", it gets its OWN task + canvas. This
  // is the forward link to that FbNode task; exploring again just re-opens it
  // (lazy: the task is created on first explore). The reverse breadcrumb hint
  // lives in lib/nodeCanvasOrigin.
  taskId?: string
}

interface AgentSuggestion {
  slug: string
  name: string
  rationale: string
  // Set when the renderer fetches the full agent list AND notes the
  // suggested agent's .md path. Kept here so "Run agent" doesn't
  // need a second round-trip.
  path?: string
}

// Phase 2 polish — a conversation is a SEQUENCE of turns between
// the user and the agent, capped at MAX_TURNS round-trips. Each
// agent turn carries its own proposals so the user can apply
// per-turn rather than mass-apply across the whole conversation.
//
// Per-proposal apply state tracks what's been applied + whether it
// can still be undone. The createdEntityRef shape mirrors what
// agentHistory.ts records ("task:<id>" / "widget:<id>").
type ApplyState = 'pending' | 'applied' | 'dismissed' | 'undone'

interface ProposalState {
  proposal: ActionProposal
  state: ApplyState
  // Set when applied. Lets the renderer offer a per-card Undo, and
  // lets us correlate with the server-side outcome record.
  createdEntityRef?: string | null
}

interface ConversationTurn {
  // The raw agent message string — what gets fed back to Anthropic
  // for follow-up turns as an `assistant` message.
  rawReply: string
  reply: string
  proposalStates: ProposalState[]
  invocationId: string
  conversationTurn: number
  at: number
}

interface AgentConversation {
  agentName: string
  agentSlug: string
  // Turns in chronological order. Even-indexed entries are agent
  // turns; odd-indexed represent user replies in between.
  turns: ConversationTurn[]
  userReplies: Array<{ content: string; at: number }>
  capped: boolean
}

interface PersistedState {
  root: MindMapNode
  selectedId: string | null
  // The node id that is currently being viewed as the visual root.
  // Defaults to the actual root. Click-to-drill-in sets this to the
  // clicked node so the user can focus on a subtree; the breadcrumb
  // at the top lets them step back up.
  viewRootId: string
  agentSuggestions: Record<string, AgentSuggestion[]>
  // Phase 2 polish — full conversation per (nodeId, agentSlug). Key
  // is `${nodeId}:${slug}`. Replaces the earlier single-turn cache;
  // legacy parse rehydrates the old single-result shape into a
  // 1-turn conversation so existing widget.content blobs don't break.
  agentConversations: Record<string, AgentConversation>
  // Per-slug cached stats (applied / dismissed / undone / applyRate).
  // Refreshed after every outcome so the suggestion card badges stay
  // honest.
  agentStats: Record<
    string,
    {
      slug: string
      invocations: number
      totalProposals: number
      applied: number
      dismissed: number
      undone: number
      applyRate: number
    }
  >
}

const EMPTY_STATE: PersistedState = {
  root: {
    id: 'root',
    label: 'New idea',
    kind: 'idea',
    children: [],
    attachedWidgetIds: [],
    assignedAgentSlugs: [],
    pendingChildren: []
  },
  selectedId: 'root',
  viewRootId: 'root',
  agentSuggestions: {},
  agentConversations: {},
  agentStats: {}
}

// Server cap (mirrors MAX_CONVERSATION_TURNS in agentDispatcher.ts).
// We keep our own copy so the UI can disable inputs locally before
// the round-trip; the server still enforces the cap definitively.
const MAX_CONVERSATION_TURNS = 5

interface Props {
  widget: Widget
  inline?: boolean
}

export default function MindMapWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const createWidget = useWidgetStore((s) => s.create)
  const allWidgets = useWidgetStore((s) => s.widgets)
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const createNode = useNodeStore((s) => s.create)

  const persisted = useRef<PersistedState>(parsePersisted(widget.content))
  const [state, setState] = useState<PersistedState>(persisted.current)

  // Per-turn resolvedIds map, keyed `${conversationKey}:${turnIndex}`. Applying a
  // proposal stashes the created entity's id under the proposal id here, exactly
  // as ProposalCards' shared applier does — so a later proposal in the same turn
  // that $refs an earlier one resolves, and so we can name what was created via
  // resolveGoToTarget instead of a brittle before/after world diff.
  const turnResolvedIds = useRef<Map<string, Map<string, string>>>(new Map())
  function resolvedIdsForTurn(conversationKey: string, turnIndex: number): Map<string, string> {
    const key = `${conversationKey}:${turnIndex}`
    let m = turnResolvedIds.current.get(key)
    if (!m) {
      m = new Map<string, string>()
      turnResolvedIds.current.set(key, m)
    }
    return m
  }

  function persist(next: PersistedState): void {
    persisted.current = next
    setState(next)
    void update(widget.id, { content: JSON.stringify(next) })
  }

  // Reflect external content updates that arrive after mount, such as Build
  // with AI appending branch nodes from the context menu. parsePersisted only
  // runs once on init, so without this a menu-driven update would not appear
  // until the widget remounted. The guard compares against what we last
  // persisted so a local edit (which writes the identical content) is a no-op.
  useEffect(() => {
    if (widget.content && widget.content !== JSON.stringify(persisted.current)) {
      const incoming = parsePersisted(widget.content)
      persisted.current = incoming
      setState(incoming)
    }
  }, [widget.content])

  // ── Selected node lookup ─────────────────────────────────────────────────
  const selected = useMemo(() => {
    if (!state.selectedId) return null
    return findNode(state.root, state.selectedId)
  }, [state.root, state.selectedId])

  const [busy, setBusy] = useState<
    'expand' | 'agents' | 'invoke' | 'creating-agent' | null
  >(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // Position of the unified right-click menu, or null when closed.
  const [mindCtxMenu, setMindCtxMenu] = useState<{ x: number; y: number } | null>(null)
  // The agent-creation wizard is a modal; the slug is the suggested
  // starting point when the user first opens it.
  const [agentWizardOpen, setAgentWizardOpen] = useState(false)
  // The "Add tool" picker for node-attached widgets.
  const [toolPickerOpen, setToolPickerOpen] = useState(false)

  // ── Tree mutation helpers ────────────────────────────────────────────────
  function updateNode(id: string, mutator: (n: MindMapNode) => MindMapNode): void {
    persist({ ...state, root: mapTree(state.root, id, mutator) })
  }
  function deleteNode(id: string): void {
    if (id === state.root.id) return
    persist({
      ...state,
      root: pruneTree(state.root, id),
      selectedId: state.selectedId === id ? state.root.id : state.selectedId,
      // If we drilled into the deleted node, pop back to its parent
      // by resetting the view root. Falling all the way back to the
      // tree root is the simple choice; a smarter version would walk
      // to the nearest live ancestor.
      viewRootId: state.viewRootId === id ? state.root.id : state.viewRootId
    })
  }

  // Triage staging — accept or reject AI-proposed children one at a
  // time or in bulk. Accepted children move from pendingChildren to
  // children; rejected ones vanish.
  function acceptPending(parentId: string, pendingId: string): void {
    persist({
      ...state,
      root: mapTree(state.root, parentId, (n) => {
        const child = (n.pendingChildren ?? []).find((c) => c.id === pendingId)
        if (!child) return n
        return {
          ...n,
          children: [...n.children, child],
          pendingChildren: (n.pendingChildren ?? []).filter((c) => c.id !== pendingId)
        }
      })
    })
  }
  function rejectPending(parentId: string, pendingId: string): void {
    persist({
      ...state,
      root: mapTree(state.root, parentId, (n) => ({
        ...n,
        pendingChildren: (n.pendingChildren ?? []).filter((c) => c.id !== pendingId)
      }))
    })
  }
  function acceptAllPending(parentId: string): void {
    persist({
      ...state,
      root: mapTree(state.root, parentId, (n) => ({
        ...n,
        children: [...n.children, ...(n.pendingChildren ?? [])],
        pendingChildren: []
      }))
    })
  }
  function rejectAllPending(parentId: string): void {
    persist({
      ...state,
      root: mapTree(state.root, parentId, (n) => ({
        ...n,
        pendingChildren: []
      }))
    })
  }

  // Manual node creation — add a child of the selected node, or a
  // sibling. Returns the new node id so the caller can auto-select
  // it (so the user can start typing the label immediately).
  function addChild(parentId: string): string {
    const id = `n-${Math.floor(Math.random() * 1e9).toString(36)}-${Date.now().toString(36)}`
    const newNode: MindMapNode = {
      id,
      label: 'New idea',
      kind: 'idea',
      children: [],
      attachedWidgetIds: [],
      assignedAgentSlugs: [],
      pendingChildren: []
    }
    persist({
      ...state,
      root: mapTree(state.root, parentId, (n) => ({
        ...n,
        children: [...n.children, newNode]
      })),
      selectedId: id
    })
    return id
  }
  function addSibling(targetId: string): string | null {
    if (targetId === state.root.id) return null
    const parent = findParent(state.root, targetId)
    if (!parent) return null
    return addChild(parent.id)
  }

  // Drill-down navigation. Sets the visual root to the given node so
  // the SVG canvas shows just that subtree; the breadcrumb at the
  // top of the widget lets the user step back up. Clicking the root
  // breadcrumb resets to the actual tree root.
  function drillInto(nodeId: string): void {
    persist({ ...state, viewRootId: nodeId, selectedId: nodeId })
  }
  function drillUp(nodeId: string): void {
    persist({ ...state, viewRootId: nodeId })
  }

  // ── AI Expand ────────────────────────────────────────────────────────────
  async function expand(node: MindMapNode): Promise<void> {
    if (busy) return
    setBusy('expand')
    setErrorMsg(null)
    const rootPath = pathFromRoot(state.root, node.id).map((n) => n.label).slice(0, -1)
    try {
      const result = await window.api.mindmap.expand({
        rootPath,
        nodeLabel: node.label,
        nodeKind: node.kind
      })
      setBusy(null)
      if (!result.ok) {
        setErrorMsg(result.error)
        return
      }
      // Triage staging — AI children land in pendingChildren and
      // render with a dashed outline. The user accepts or rejects
      // each before they're committed to the tree. Drops the
      // anxiety of "I asked AI and now there are 5 nodes I don't
      // want and can't easily undo."
      updateNode(node.id, (n) => ({
        ...n,
        pendingChildren: [
          ...(n.pendingChildren ?? []),
          ...result.children.map((c) => ({
            id: c.id,
            label: c.label,
            kind: c.kind,
            rationale: c.rationale,
            children: [],
            attachedWidgetIds: [],
            assignedAgentSlugs: [],
            pendingChildren: []
          }))
        ]
      }))
    } catch (err) {
      setBusy(null)
      setErrorMsg(
        `Expand unavailable: ${err instanceof Error ? err.message : String(err)}. ` +
          'Quit PlexiDesk (⌘Q) and reopen if you just shipped new code.'
      )
    }
  }

  // ── Agent suggestion (Phase 1) + on-demand invocation (Phase 2C) ─────────
  // Cached inventory metadata so the suggestion header can show
  // "Agents from: <workspaceRoot>" + offer Open-in-Finder. Refreshed
  // every time fetchAgentSuggestions runs.
  const [agentsInventory, setAgentsInventory] = useState<{
    source:
      | 'override'
      | 'workspace'
      | 'userData-existing'
      | 'userData-new'
      | 'none'
    agentsDir: string | null
    workspaceRoot: string | null
  } | null>(null)

  async function fetchAgentSuggestions(node: MindMapNode): Promise<void> {
    if (busy) return
    setBusy('agents')
    setErrorMsg(null)
    try {
      const inv = await window.api.mindmap.listAgents()
      setAgentsInventory({
        source: inv.source,
        agentsDir: inv.agentsDir,
        workspaceRoot: inv.workspaceRoot
      })
      if (inv.agents.length === 0) {
        if (inv.source === 'userData-new' || inv.source === 'none') {
          setErrorMsg(
            `No agents found. Looked in:\n  ${inv.agentsDir ?? '(no writable directory)'}\n\nClick "+ New" to author one. To point PlexiDesk at an existing workspace with .claude/agents/, use Settings → Workspace path.`
          )
        } else {
          setErrorMsg(
            `No agents found at ${inv.agentsDir}. Click "+ New" to author one, or drop your existing agent .md files into that directory and re-run Find agents.`
          )
        }
        setBusy(null)
        return
      }
      const rootPath = pathFromRoot(state.root, node.id).map((n) => n.label).slice(0, -1)
      const result = await window.api.mindmap.suggestAgents({
        rootPath,
        nodeLabel: node.label,
        nodeKind: node.kind,
        candidates: inv.agents
      })
      setBusy(null)
      if (!result.ok) {
        if (result.reason === 'no_agents') {
          setErrorMsg('No agents available to suggest.')
        } else {
          setErrorMsg(result.error)
        }
        return
      }
      const byCount = new Map(inv.agents.map((a) => [a.slug, a]))
      const suggestionsWithPath: AgentSuggestion[] = result.suggestions.map(
        (s) => ({
          ...s,
          path: byCount.get(s.slug)?.path
        })
      )
      persist({
        ...state,
        agentSuggestions: {
          ...state.agentSuggestions,
          [node.id]: suggestionsWithPath
        }
      })
    } catch (err) {
      setBusy(null)
      setErrorMsg(
        `Agent suggestion unavailable: ${err instanceof Error ? err.message : String(err)}. ` +
          'Quit PlexiDesk (⌘Q) and reopen if you just shipped new code.'
      )
    }
  }

  async function revealAgentsDir(): Promise<void> {
    if (!agentsInventory?.agentsDir) return
    try {
      await window.api.agents.revealInFinder(agentsInventory.agentsDir)
    } catch (err) {
      setErrorMsg(
        `Could not open in Finder: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  function conversationKey(nodeId: string, slug: string): string {
    return `${nodeId}:${slug}`
  }

  async function refreshAgentStats(slug: string): Promise<void> {
    try {
      const stats = await window.api.agents.statsForSlug(slug)
      persist({
        ...state,
        agentStats: { ...state.agentStats, [slug]: stats }
      })
    } catch (err) {
      // Non-fatal. The badge just won't update — the user can still
      // apply/dismiss; the next invocation will refresh.
      // eslint-disable-next-line no-console
      console.warn('[MindMapWidget] statsForSlug failed:', err)
    }
  }

  async function runAgent(node: MindMapNode, suggestion: AgentSuggestion): Promise<void> {
    if (busy) return
    if (!suggestion.path) {
      setErrorMsg(
        `Agent ${suggestion.slug} has no resolved path. Re-run "Find agents" to refresh.`
      )
      return
    }
    setBusy('invoke')
    setErrorMsg(null)
    const key = conversationKey(node.id, suggestion.slug)
    try {
      const rootPath = pathFromRoot(state.root, node.id).map((n) => n.label).slice(0, -1)
      const result = await window.api.agents.invoke({
        agentPath: suggestion.path,
        rootPath,
        nodeLabel: node.label,
        nodeKind: node.kind,
        userMessage: '',
        conversationKey: key,
        nodeId: node.id
      })
      setBusy(null)
      if (!result.ok) {
        setErrorMsg(result.error)
        return
      }
      const turn: ConversationTurn = {
        rawReply: result.reply,
        reply: result.reply,
        proposalStates: result.proposals.map((p) => ({ proposal: p, state: 'pending' })),
        invocationId: result.invocationId,
        conversationTurn: result.conversationTurn,
        at: Date.now()
      }
      const conv: AgentConversation = {
        agentName: result.agentName,
        agentSlug: suggestion.slug,
        turns: [turn],
        userReplies: [],
        capped: result.conversationCapped
      }
      persist({
        ...state,
        agentConversations: { ...state.agentConversations, [key]: conv }
      })
      void refreshAgentStats(suggestion.slug)
    } catch (err) {
      setBusy(null)
      setErrorMsg(
        `Run unavailable: ${err instanceof Error ? err.message : String(err)}. ` +
          'Quit PlexiDesk (⌘Q) and reopen.'
      )
    }
  }

  async function replyToAgent(
    node: MindMapNode,
    suggestion: AgentSuggestion,
    userText: string
  ): Promise<void> {
    if (busy) return
    if (!userText.trim()) return
    if (!suggestion.path) {
      setErrorMsg(`Agent ${suggestion.slug} has no resolved path.`)
      return
    }
    const key = conversationKey(node.id, suggestion.slug)
    const existing = state.agentConversations[key]
    if (!existing) {
      setErrorMsg('Conversation lost — run the agent fresh.')
      return
    }
    if (existing.capped) {
      setErrorMsg(
        `Conversation is at the ${MAX_CONVERSATION_TURNS}-turn cap. Start a new run for further work.`
      )
      return
    }
    setBusy('invoke')
    setErrorMsg(null)
    // Build history: each prior agent turn becomes an 'agent' entry,
    // each user reply an 'user' entry, in chronological order.
    const history: Array<{ role: 'user' | 'agent'; content: string }> = []
    const maxIdx = Math.max(existing.turns.length, existing.userReplies.length)
    // We received the FIRST agent turn before any user reply; subsequent
    // turns alternate. The serialization here is:
    //   agent turn 1 → user reply 1 → agent turn 2 → user reply 2 → …
    for (let i = 0; i < maxIdx; i++) {
      if (i < existing.turns.length) {
        history.push({ role: 'agent', content: existing.turns[i].rawReply })
      }
      if (i < existing.userReplies.length) {
        history.push({ role: 'user', content: existing.userReplies[i].content })
      }
    }
    try {
      const rootPath = pathFromRoot(state.root, node.id).map((n) => n.label).slice(0, -1)
      const result = await window.api.agents.invoke({
        agentPath: suggestion.path,
        rootPath,
        nodeLabel: node.label,
        nodeKind: node.kind,
        userMessage: userText.trim(),
        conversationHistory: history,
        conversationKey: key,
        nodeId: node.id
      })
      setBusy(null)
      if (!result.ok) {
        setErrorMsg(result.error)
        return
      }
      const nextConv: AgentConversation = {
        ...existing,
        capped: result.conversationCapped,
        userReplies: [
          ...existing.userReplies,
          { content: userText.trim(), at: Date.now() }
        ],
        turns: [
          ...existing.turns,
          {
            rawReply: result.reply,
            reply: result.reply,
            proposalStates: result.proposals.map((p) => ({
              proposal: p,
              state: 'pending'
            })),
            invocationId: result.invocationId,
            conversationTurn: result.conversationTurn,
            at: Date.now()
          }
        ]
      }
      persist({
        ...state,
        agentConversations: { ...state.agentConversations, [key]: nextConv }
      })
      void refreshAgentStats(suggestion.slug)
    } catch (err) {
      setBusy(null)
      setErrorMsg(
        `Reply unavailable: ${err instanceof Error ? err.message : String(err)}.`
      )
    }
  }

  // ── Convert node to task ─────────────────────────────────────────────────
  async function convertToTask(node: MindMapNode): Promise<void> {
    if (!activeTaskId) {
      setErrorMsg('Open a task before converting — new tasks need a parent task.')
      return
    }
    try {
      await createNode({
        parentId: activeTaskId,
        kind: 'task',
        title: node.label,
        description: node.rationale ?? ''
      })
      updateNode(node.id, (n) => ({ ...n, kind: 'task' }))
    } catch (err) {
      setErrorMsg(
        `Could not create task: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // ── Phase 3: explore a node as its OWN task canvas ───────────────────────
  // Lazily create (or re-open) a real task + canvas for this node, record the
  // breadcrumb origin so the canvas can climb back to the map, then switch the
  // desk to it. The node remembers its taskId — exploring again re-opens it.
  async function exploreNode(node: MindMapNode): Promise<void> {
    const nodes = useNodeStore.getState().nodes
    const goTo = (taskId: string): void => {
      const sourceTitle = nodes.find((n) => n.id === activeTaskId)?.title ?? 'Mind map'
      setOrigin(taskId, {
        sourceTaskId: activeTaskId ?? '',
        sourceTaskTitle: sourceTitle,
        mindmapWidgetId: widget.id,
        nodeId: node.id,
        nodeLabel: node.label,
        // Ancestor labels (root → parent), excluding the node itself.
        nodePath: pathFromRoot(state.root, node.id)
          .slice(0, -1)
          .map((n) => n.label)
      })
      useNodeStore.getState().setActive(taskId)
    }
    // Re-open the existing canvas if its task still exists.
    if (node.taskId && nodes.some((n) => n.id === node.taskId)) {
      goTo(node.taskId)
      return
    }
    if (!activeTaskId) {
      setErrorMsg('Open a task first — node canvases need a parent task.')
      return
    }
    try {
      const task = await createNode({
        parentId: activeTaskId,
        kind: 'task',
        title: node.label || 'Untitled',
        description: node.rationale ?? ''
      })
      updateNode(node.id, (n) => ({ ...n, taskId: task.id, kind: 'task' }))
      goTo(task.id)
    } catch (err) {
      setErrorMsg(
        `Could not open node canvas: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // ── Phase 2B: attach a real canvas widget to this node ───────────────────
  async function attachWidget(node: MindMapNode, kind: WidgetKind): Promise<void> {
    if (!activeTaskId) {
      setErrorMsg('Open a task before adding tools — widgets need a parent task.')
      return
    }
    const entry = catalogFor(kind)
    if (!entry) {
      setErrorMsg(`No catalog entry for kind "${kind}".`)
      return
    }
    try {
      // Place the new widget near the mindmap widget. The user can
      // re-position. We could compute a clever offset based on node
      // position inside the mindmap SVG, but the SVG coords aren't
      // in canvas-space — punt to a simple offset.
      const newWidget = await createWidget({
        taskId: activeTaskId,
        kind,
        title: `${node.label} · ${entry.label}`,
        content: entry.defaultContent ?? '',
        x: widget.x + widget.width + 24,
        y:
          widget.y + ((node.attachedWidgetIds?.length ?? 0) * (entry.defaultHeight + 16)),
        width: entry.defaultWidth,
        height: entry.defaultHeight
      })
      updateNode(node.id, (n) => ({
        ...n,
        attachedWidgetIds: [...(n.attachedWidgetIds ?? []), newWidget.id]
      }))
      setToolPickerOpen(false)
    } catch (err) {
      setErrorMsg(
        `Could not attach tool: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  function detachWidget(node: MindMapNode, widgetId: string): void {
    updateNode(node.id, (n) => ({
      ...n,
      attachedWidgetIds: (n.attachedWidgetIds ?? []).filter((id) => id !== widgetId)
    }))
  }

  // Resolve attached widgets to their store entries. We don't delete
  // the widget when it's detached — that would be a destructive
  // action the user didn't ask for. Detach only removes the link.
  const attachedWidgets: Widget[] = useMemo(() => {
    if (!selected?.attachedWidgetIds) return []
    return selected.attachedWidgetIds
      .map((id) => allWidgets.find((w) => w.id === id))
      .filter((w): w is Widget => Boolean(w))
  }, [selected, allWidgets])

  // ── Phase 2 polish: apply / undo / dismiss with history records ─────────
  async function applyAgentProposal(
    conversationKey: string,
    turnIndex: number,
    proposalIndex: number
  ): Promise<void> {
    if (!activeTaskId) {
      setErrorMsg('Open a task first.')
      return
    }
    const conv = state.agentConversations[conversationKey]
    if (!conv) return
    const turn = conv.turns[turnIndex]
    if (!turn) return
    const ps = turn.proposalStates[proposalIndex]
    if (!ps || ps.state !== 'pending') return

    // Apply through the SAME shared applier + resolvedIds map the standard
    // ProposalCards use, so a proposal that $refs an earlier one in this turn
    // resolves. resolveGoToTarget then names what was created (task / widget /
    // document) from that map, replacing the old brittle before/after world diff.
    const resolvedIds = resolvedIdsForTurn(conversationKey, turnIndex)
    const result = await applyProposal(ps.proposal, { activeTaskId, resolvedIds })
    if (!result.ok) {
      setErrorMsg(`Apply failed: ${result.message}`)
      return
    }
    const target = resolveGoToTarget(ps.proposal, resolvedIds)
    const createdEntityRef = target ? `${target.kind}:${target.id}` : null

    // Tell the history table.
    try {
      await window.api.agents.recordOutcome({
        invocationId: turn.invocationId,
        agentSlug: conv.agentSlug,
        proposalId: ps.proposal.id,
        proposalKind: ps.proposal.kind,
        action: 'applied',
        createdEntityRef
      })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[MindMapWidget] recordOutcome(applied) failed:', err)
    }

    persist({
      ...state,
      agentConversations: {
        ...state.agentConversations,
        [conversationKey]: mutateProposalState(conv, turnIndex, proposalIndex, {
          state: 'applied',
          createdEntityRef
        })
      }
    })
    void refreshAgentStats(conv.agentSlug)
  }

  async function dismissAgentProposal(
    conversationKey: string,
    turnIndex: number,
    proposalIndex: number
  ): Promise<void> {
    const conv = state.agentConversations[conversationKey]
    if (!conv) return
    const turn = conv.turns[turnIndex]
    if (!turn) return
    const ps = turn.proposalStates[proposalIndex]
    if (!ps || ps.state !== 'pending') return
    try {
      await window.api.agents.recordOutcome({
        invocationId: turn.invocationId,
        agentSlug: conv.agentSlug,
        proposalId: ps.proposal.id,
        proposalKind: ps.proposal.kind,
        action: 'dismissed',
        createdEntityRef: null
      })
    } catch {
      // non-fatal — UI still moves
    }
    persist({
      ...state,
      agentConversations: {
        ...state.agentConversations,
        [conversationKey]: mutateProposalState(conv, turnIndex, proposalIndex, {
          state: 'dismissed'
        })
      }
    })
    void refreshAgentStats(conv.agentSlug)
  }

  // Per-proposal Undo: re-fires the server-side undo which deletes
  // the created entity, then flips local UI state to 'undone'.
  async function undoAgentProposal(
    conversationKey: string,
    turnIndex: number,
    proposalIndex: number
  ): Promise<void> {
    const conv = state.agentConversations[conversationKey]
    if (!conv) return
    const turn = conv.turns[turnIndex]
    if (!turn) return
    const ps = turn.proposalStates[proposalIndex]
    if (!ps || ps.state !== 'applied' || !ps.createdEntityRef) return
    try {
      // Use the same undoLast IPC for consistency. The server walks
      // back from now() looking for the most recent applied-outcome
      // that hasn't been undone — typically what the user wants,
      // since they almost always undo what they just applied.
      const result = await window.api.agents.undoLast()
      if (!result.ok) {
        setErrorMsg(result.message)
        return
      }
      // Refresh the canvas stores so the deletion is visible.
      await reloadCanvasStores()
      persist({
        ...state,
        agentConversations: {
          ...state.agentConversations,
          [conversationKey]: mutateProposalState(conv, turnIndex, proposalIndex, {
            state: 'undone'
          })
        }
      })
      void refreshAgentStats(conv.agentSlug)
    } catch (err) {
      setErrorMsg(
        `Undo failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // Top-of-panel "Undo last apply" — useful when the user already
  // closed the conversation but wants to reverse the most recent
  // change. Same server call as the per-card undo.
  async function undoLastApplyGlobally(): Promise<void> {
    try {
      const result = await window.api.agents.undoLast()
      if (!result.ok) {
        setErrorMsg(result.message)
        return
      }
      await reloadCanvasStores()
      // Walk every conversation looking for the matching applied
      // outcome and flip it to 'undone' so the UI stays consistent.
      const ref = result.entityRef
      if (ref) {
        const nextConversations = { ...state.agentConversations }
        for (const [k, c] of Object.entries(nextConversations)) {
          let mutated = c
          c.turns.forEach((t, ti) => {
            t.proposalStates.forEach((ps, pi) => {
              if (ps.state === 'applied' && ps.createdEntityRef === ref) {
                mutated = mutateProposalState(mutated, ti, pi, { state: 'undone' })
              }
            })
          })
          nextConversations[k] = mutated
        }
        persist({ ...state, agentConversations: nextConversations })
      }
    } catch (err) {
      setErrorMsg(
        `Undo failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // Refresh nodes + widgets after an undo so the deletion appears
  // immediately in the canvas. Both stores have `loadForTask`-style
  // hydration; calling them directly is the cleanest path.
  async function reloadCanvasStores(): Promise<void> {
    if (!activeTaskId) return
    const widgetStore = useWidgetStore.getState()
    await widgetStore.loadForTask(activeTaskId)
    const nodeStore = useNodeStore.getState()
    // The node store doesn't have a per-task reload; nuke + refetch
    // via its list IPC. Most apps will already have this — call
    // through to whatever bulk-reload exists.
    if (typeof (nodeStore as unknown as { reload?: () => Promise<void> }).reload === 'function') {
      await (nodeStore as unknown as { reload: () => Promise<void> }).reload()
    }
  }

  // Helper for the apply/dismiss/undo mutations — returns a new
  // conversation object with one ProposalState updated. Kept as a
  // top-level helper since it's pure.
  function mutateProposalState(
    conv: AgentConversation,
    turnIndex: number,
    proposalIndex: number,
    patch: Partial<ProposalState>
  ): AgentConversation {
    return {
      ...conv,
      turns: conv.turns.map((t, ti) => {
        if (ti !== turnIndex) return t
        return {
          ...t,
          proposalStates: t.proposalStates.map((ps, pi) => {
            if (pi !== proposalIndex) return ps
            return { ...ps, ...patch }
          })
        }
      })
    }
  }

  // ── Phase 2A: handle wizard completion ───────────────────────────────────
  async function handleAgentCreated(slug: string, node: MindMapNode): Promise<void> {
    // Refresh the suggestion list for the current node so the new
    // agent shows up. We append it as the first suggestion so the
    // user immediately sees their work.
    const newSuggestion: AgentSuggestion = {
      slug,
      name: slug, // Will be replaced when the user re-runs Find agents.
      rationale: 'Just created for this node.',
      path: undefined
    }
    persist({
      ...state,
      agentSuggestions: {
        ...state.agentSuggestions,
        [node.id]: [newSuggestion, ...(state.agentSuggestions[node.id] ?? [])]
      }
    })
    setAgentWizardOpen(false)
  }

  // ── Layout ───────────────────────────────────────────────────────────────
  // Use the view-root subtree so drill-in zooms to a single branch
  // without losing the underlying full tree (which stays persisted).
  const viewRoot = useMemo(
    () => findNode(state.root, state.viewRootId) ?? state.root,
    [state.root, state.viewRootId]
  )
  const breadcrumb = useMemo(
    () => pathFromRoot(state.root, viewRoot.id),
    [state.root, viewRoot.id]
  )
  const layout = useMemo(() => layoutTree(viewRoot), [viewRoot])

  // ── Render ───────────────────────────────────────────────────────────────
  const body = (
    <div
      className="h-full w-full flex bg-[var(--surface-sunken)] overflow-hidden"
      onContextMenu={(e) => {
        // Right-click anywhere in the mind map opens the unified menu, which is
        // where "Build with AI" lives. Shift-right-click falls through to the
        // native menu.
        if (e.shiftKey) return
        e.preventDefault()
        setMindCtxMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {mindCtxMenu && (
        <UnifiedConnectedMenu
          sourceWidgetId={widget.id}
          x={mindCtxMenu.x}
          y={mindCtxMenu.y}
          onClose={() => setMindCtxMenu(null)}
        />
      )}
      <div className="flex-1 min-w-0 overflow-auto relative">
        {/* Breadcrumb — only when drilled in. The user clicks any
            segment to step back up. Double-clicking a node in the
            tree drills further in; the breadcrumb is the only way
            to drill back up. */}
        {breadcrumb.length > 1 && (
          <div
            className="sticky top-0 z-10 fb-glass-chrome px-3 py-1.5 border-b border-[var(--edge-soft)] flex items-center gap-1 text-[10px] overflow-x-auto"
            data-testid="mindmap-breadcrumb"
          >
            {breadcrumb.map((b, i) => (
              <span key={b.id} className="inline-flex items-center gap-1 shrink-0">
                {i > 0 && (
                  <Icon name="chevron_right" size={11} className="text-[var(--ink-40)]" />
                )}
                <button
                  onClick={() => drillUp(b.id)}
                  disabled={i === breadcrumb.length - 1}
                  className={`px-1 py-0.5 rounded ${
                    i === breadcrumb.length - 1
                      ? 'text-[var(--ink-90)] font-semibold cursor-default'
                      : 'text-accent hover:underline'
                  }`}
                  data-testid={`mindmap-breadcrumb-${i}`}
                >
                  {truncate(b.label || 'Untitled', 22)}
                </button>
              </span>
            ))}
          </div>
        )}
        <svg
          width={layout.width}
          height={layout.height}
          className="block select-none"
          data-testid="mindmap-svg"
        >
          {layout.edges.map((e) => (
            <path
              key={`${e.from}-${e.to}`}
              d={curvedEdge(e.x1, e.y1, e.x2, e.y2)}
              fill="none"
              stroke="var(--edge-firm)"
              strokeOpacity={0.25}
              strokeWidth={1.5}
            />
          ))}
          {layout.nodes.map((n) => {
            const isSelected = state.selectedId === n.id
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation()
                  if (n.pending) {
                    // Pending nodes don't select — their controls live
                    // on a hover overlay (accept / reject buttons in
                    // SVG, below).
                    return
                  }
                  persist({ ...state, selectedId: n.id })
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (n.pending) return
                  // Drill-down: zoom view to this subtree. The
                  // breadcrumb at the top of the widget lets the user
                  // step back up.
                  drillInto(n.id)
                }}
                data-testid={`mindmap-node-${n.id}`}
              >
                <rect
                  x={-n.width / 2}
                  y={-n.height / 2}
                  width={n.width}
                  height={n.height}
                  rx={8}
                  fill={fillForKind(n.kind, isSelected)}
                  fillOpacity={n.pending ? 0.5 : 1}
                  stroke={
                    isSelected
                      ? 'rgb(var(--accent))'
                      : n.pending
                        ? 'rgb(var(--accent))'
                        : 'rgba(120,113,108,0.4)'
                  }
                  strokeWidth={isSelected ? 2 : 1}
                  strokeDasharray={n.pending ? '4 3' : undefined}
                />
                {/* foreignObject lets the label wrap naturally via
                    CSS. SVG <text> alone can't word-wrap without
                    manual tspan placement. */}
                <foreignObject
                  x={-n.width / 2}
                  y={-n.height / 2}
                  width={n.width}
                  height={n.height}
                  style={{ pointerEvents: 'none' }}
                >
                  <div
                    className="w-full h-full flex items-center justify-center px-2 text-center text-[11px] font-medium leading-tight"
                    style={{
                      color: isSelected ? 'rgb(var(--accent))' : 'currentColor',
                      opacity: n.pending ? 0.85 : 1,
                      wordBreak: 'break-word'
                    }}
                  >
                    {n.label || 'Untitled'}
                  </div>
                </foreignObject>
                {n.hasAttachments && !n.pending && (
                  <circle
                    cx={n.width / 2 - 6}
                    cy={-n.height / 2 + 6}
                    r={3}
                    fill="rgb(var(--accent))"
                  />
                )}
                {/* "Has its own canvas" badge (bottom-right) — click to open it. */}
                {n.hasCanvas && !n.pending && (
                  <g
                    transform={`translate(${n.width / 2 - 11}, ${n.height / 2 - 11})`}
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation()
                      const full = findNode(state.root, n.id)
                      if (full) void exploreNode(full)
                    }}
                    data-testid={`mindmap-open-canvas-${n.id}`}
                  >
                    <title>Open this node’s canvas</title>
                    <rect x={-6} y={-6} width={12} height={12} rx={3} fill="rgb(var(--accent))" />
                    <path
                      d="M -3 -2 H 3 M -3 1 H 1"
                      stroke="white"
                      strokeWidth={1.2}
                      strokeLinecap="round"
                    />
                  </g>
                )}
                {n.pending && n.pendingParentId && (
                  <g>
                    {/* Accept (✓) — bottom-left of node */}
                    <g
                      transform={`translate(${-n.width / 2 + 10}, ${n.height / 2 - 10})`}
                      onClick={(e) => {
                        e.stopPropagation()
                        acceptPending(n.pendingParentId!, n.id)
                      }}
                      className="cursor-pointer"
                      data-testid={`mindmap-accept-pending-${n.id}`}
                    >
                      <circle r={9} fill="rgb(16,185,129)" />
                      <text
                        x={0}
                        y={3}
                        textAnchor="middle"
                        fontSize={10}
                        fill="white"
                        fontWeight="bold"
                      >
                        ✓
                      </text>
                    </g>
                    {/* Reject (×) — bottom-right of node */}
                    <g
                      transform={`translate(${n.width / 2 - 10}, ${n.height / 2 - 10})`}
                      onClick={(e) => {
                        e.stopPropagation()
                        rejectPending(n.pendingParentId!, n.id)
                      }}
                      className="cursor-pointer"
                      data-testid={`mindmap-reject-pending-${n.id}`}
                    >
                      <circle r={9} fill="rgba(120,113,108,0.7)" />
                      <text
                        x={0}
                        y={3}
                        textAnchor="middle"
                        fontSize={11}
                        fill="white"
                        fontWeight="bold"
                      >
                        ×
                      </text>
                    </g>
                  </g>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      {selected && (
        <SidePanel
          node={selected}
          isRoot={selected.id === state.root.id}
          pendingChildrenCount={selected.pendingChildren?.length ?? 0}
          suggestions={state.agentSuggestions[selected.id] ?? []}
          conversations={state.agentConversations}
          agentStats={state.agentStats}
          agentsInventory={agentsInventory}
          onRevealAgentsDir={() => void revealAgentsDir()}
          attachedWidgets={attachedWidgets}
          rootPath={pathFromRoot(state.root, selected.id).map((n) => n.label)}
          busy={busy}
          errorMsg={errorMsg}
          onLabelEdit={(label) => updateNode(selected.id, (n) => ({ ...n, label }))}
          onKindChange={(kind) => updateNode(selected.id, (n) => ({ ...n, kind }))}
          onExpand={() => void expand(selected)}
          onAddChild={() => addChild(selected.id)}
          onAddSibling={() => addSibling(selected.id)}
          onAcceptAllPending={() => acceptAllPending(selected.id)}
          onRejectAllPending={() => rejectAllPending(selected.id)}
          onFetchAgents={() => void fetchAgentSuggestions(selected)}
          onRunAgent={(s) => void runAgent(selected, s)}
          onReplyToAgent={(s, text) => void replyToAgent(selected, s, text)}
          onCreateAgent={() => {
            setErrorMsg(null)
            setAgentWizardOpen(true)
          }}
          onExplore={() => void exploreNode(selected)}
          hasCanvas={!!selected.taskId}
          onConvertToTask={() => void convertToTask(selected)}
          onDelete={() => deleteNode(selected.id)}
          onOpenToolPicker={() => setToolPickerOpen(true)}
          onDetachWidget={(id) => detachWidget(selected, id)}
          onApplyProposal={(ck, ti, pi) => void applyAgentProposal(ck, ti, pi)}
          onDismissProposal={(ck, ti, pi) => void dismissAgentProposal(ck, ti, pi)}
          onUndoProposal={(ck, ti, pi) => void undoAgentProposal(ck, ti, pi)}
          onUndoLastApply={() => void undoLastApplyGlobally()}
          onClose={() => persist({ ...state, selectedId: null })}
        />
      )}
      {agentWizardOpen && selected && (
        <AgentBuilderModal
          rootPath={pathFromRoot(state.root, selected.id).map((n) => n.label)}
          selectedNode={selected}
          onCancel={() => setAgentWizardOpen(false)}
          onCreated={(slug) => void handleAgentCreated(slug, selected)}
        />
      )}
      {toolPickerOpen && selected && (
        <ToolPickerModal
          onPick={(kind) => void attachWidget(selected, kind)}
          onCancel={() => setToolPickerOpen(false)}
        />
      )}
    </div>
  )

  if (inline) return body
  return (
    <WidgetFrame widget={widget} headerLabel="Mind map" headerAccent="bg-[var(--edge-firm)]">
      {body}
    </WidgetFrame>
  )
}

// ── Side panel ─────────────────────────────────────────────────────────────

function SidePanel({
  node,
  isRoot,
  pendingChildrenCount,
  suggestions,
  conversations,
  agentStats,
  agentsInventory,
  onRevealAgentsDir,
  attachedWidgets,
  rootPath,
  busy,
  errorMsg,
  onLabelEdit,
  onKindChange,
  onExpand,
  onAddChild,
  onAddSibling,
  onAcceptAllPending,
  onRejectAllPending,
  onFetchAgents,
  onRunAgent,
  onReplyToAgent,
  onCreateAgent,
  onExplore,
  hasCanvas,
  onConvertToTask,
  onDelete,
  onOpenToolPicker,
  onDetachWidget,
  onApplyProposal,
  onDismissProposal,
  onUndoProposal,
  onUndoLastApply,
  onClose
}: {
  node: MindMapNode
  isRoot: boolean
  pendingChildrenCount: number
  suggestions: AgentSuggestion[]
  conversations: Record<string, AgentConversation>
  agentStats: PersistedState['agentStats']
  agentsInventory: {
    source:
      | 'override'
      | 'workspace'
      | 'userData-existing'
      | 'userData-new'
      | 'none'
    agentsDir: string | null
    workspaceRoot: string | null
  } | null
  onRevealAgentsDir: () => void
  attachedWidgets: Widget[]
  rootPath: string[]
  busy: 'expand' | 'agents' | 'invoke' | 'creating-agent' | null
  errorMsg: string | null
  onLabelEdit: (s: string) => void
  onKindChange: (k: MindMapNodeKind) => void
  onExpand: () => void
  onAddChild: () => void
  onAddSibling: () => void
  onAcceptAllPending: () => void
  onRejectAllPending: () => void
  onFetchAgents: () => void
  onRunAgent: (s: AgentSuggestion) => void
  onReplyToAgent: (s: AgentSuggestion, text: string) => void
  onCreateAgent: () => void
  onExplore: () => void
  hasCanvas: boolean
  onConvertToTask: () => void
  onDelete: () => void
  onOpenToolPicker: () => void
  onDetachWidget: (id: string) => void
  onApplyProposal: (conversationKey: string, turnIndex: number, proposalIndex: number) => void
  onDismissProposal: (conversationKey: string, turnIndex: number, proposalIndex: number) => void
  onUndoProposal: (conversationKey: string, turnIndex: number, proposalIndex: number) => void
  onUndoLastApply: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <aside className="w-[300px] shrink-0 border-l border-[var(--edge-soft)] bg-[var(--surface-raised)] flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--edge-soft)]">
        <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-semibold">
          Node
        </span>
        <button
          onClick={onClose}
          className="h-5 w-5 inline-flex items-center justify-center text-[var(--ink-40)] hover:text-[var(--ink-100)]"
        >
          <Icon name="close" size={11} />
        </button>
      </div>
      <div className="px-3 py-2 space-y-3 overflow-y-auto flex-1">
        {rootPath.length > 1 && (
          <div className="text-[10px] text-[var(--ink-50)] leading-snug">
            {rootPath.slice(0, -1).join(' › ')} ›
          </div>
        )}
        <input
          value={node.label}
          onChange={(e) => onLabelEdit(e.target.value)}
          className="w-full text-[13px] font-medium bg-transparent border-b border-[var(--edge-soft)] px-1 py-1 focus:border-accent text-[var(--ink-100)]"
          data-testid="mindmap-node-label-input"
        />
        <div className="flex flex-wrap gap-1">
          {(['idea', 'task', 'question', 'tool', 'agent'] as MindMapNodeKind[]).map((k) => (
            <button
              key={k}
              onClick={() => onKindChange(k)}
              className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                node.kind === k
                  ? 'bg-accent text-white'
                  : 'bg-[var(--surface-sunken)] text-[var(--ink-70)] hover:bg-[var(--edge-soft)]'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        {node.rationale && (
          <div className="text-[10px] text-[var(--ink-50)] leading-snug italic">
            "{node.rationale}"
          </div>
        )}
        <div className="space-y-1.5">
          <button
            onClick={onExpand}
            disabled={busy === 'expand'}
            className="w-full text-[11px] px-2 py-1.5 rounded-md bg-accent text-white hover:opacity-90 inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
            data-testid="mindmap-expand"
          >
            <Icon name="auto_awesome" size={12} />
            {busy === 'expand' ? 'Expanding…' : 'AI Expand (+ branches)'}
          </button>
          {/* Manual node creation. Add child = subordinate; Add
              sibling = peer at the same level. Sibling is disabled
              for the root (it has no parent). */}
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={onAddChild}
              className="text-[11px] px-2 py-1.5 rounded-md bg-[var(--surface-sunken)] text-[var(--ink-90)] hover:opacity-90 inline-flex items-center justify-center gap-1"
              data-testid="mindmap-add-child"
            >
              <Icon name="add" size={11} />
              Add child
            </button>
            <button
              onClick={onAddSibling}
              disabled={isRoot}
              title={isRoot ? 'Root has no sibling' : 'Add a peer node at the same level'}
              className="text-[11px] px-2 py-1.5 rounded-md bg-[var(--surface-sunken)] text-[var(--ink-90)] hover:opacity-90 inline-flex items-center justify-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="mindmap-add-sibling"
            >
              <Icon name="add" size={11} />
              Sibling
            </button>
          </div>
          <button
            onClick={onExplore}
            className="w-full text-[11px] px-2 py-1.5 rounded-md bg-[rgb(var(--accent))] text-white hover:opacity-90 inline-flex items-center justify-center gap-1.5"
            data-testid="mindmap-explore"
            title={
              hasCanvas
                ? 'Open this node’s own task canvas'
                : 'Turn this node into its own task with a canvas you can explore'
            }
          >
            <Icon name={hasCanvas ? 'open_in_full' : 'dashboard'} size={12} />
            {hasCanvas ? 'Open canvas' : 'Explore as canvas'}
          </button>
          <button
            onClick={onConvertToTask}
            className="w-full text-[11px] px-2 py-1.5 rounded-md bg-[var(--surface-sunken)] text-[var(--ink-90)] hover:opacity-90 inline-flex items-center justify-center gap-1.5"
            data-testid="mindmap-convert-task"
            title="Add this node to the sidebar as a task, without leaving the map"
          >
            <Icon name="task_alt" size={12} />
            Convert to task
          </button>
          <button
            onClick={onDelete}
            disabled={isRoot}
            title={isRoot ? 'Can\'t delete the root' : 'Delete this node and its subtree'}
            className="w-full text-[11px] px-2 py-1.5 rounded-md text-rose-500 hover:bg-rose-500/10 inline-flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Icon name="delete_outline" size={12} />
            Delete this node
          </button>
        </div>

        {/* Triage staging — bulk controls for AI-proposed branches
            that haven't been accepted yet. Each pending node also
            has its own ✓/× buttons in the SVG so the user can
            triage in-place; this section is the bulk affordance. */}
        {pendingChildrenCount > 0 && (
          <div className="rounded-md border border-accent/40 bg-accent/5 px-2 py-1.5 space-y-1.5">
            <div className="text-[10px] uppercase tracking-[0.12em] text-accent font-semibold">
              {pendingChildrenCount} proposed branch{pendingChildrenCount === 1 ? '' : 'es'}
            </div>
            <div className="text-[10px] text-[var(--ink-70)] leading-snug">
              Click ✓ or × on each dashed node, or use:
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={onAcceptAllPending}
                className="text-[10px] px-1.5 py-1 rounded bg-accent text-white hover:opacity-90"
                data-testid="mindmap-accept-all-pending"
              >
                Accept all
              </button>
              <button
                onClick={onRejectAllPending}
                className="fb-btn-surface text-[10px] px-1.5 py-1 text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                data-testid="mindmap-reject-all-pending"
              >
                Reject all
              </button>
            </div>
          </div>
        )}

        {/* Phase 2B — attached widgets */}
        <div className="pt-3 border-t border-[var(--edge-soft)]">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-semibold">
              Tools attached ({attachedWidgets.length})
            </span>
            <button
              onClick={onOpenToolPicker}
              className="text-[10px] text-accent hover:underline"
              data-testid="mindmap-open-tool-picker"
            >
              + Add tool
            </button>
          </div>
          {attachedWidgets.length === 0 ? (
            <div className="text-[10px] text-[var(--ink-50)] leading-snug">
              Attach any widget kind to this node — table, search, sticky, etc.
              The widget spawns on the canvas and the link lets you find it
              again from here.
            </div>
          ) : (
            <ul className="space-y-1">
              {attachedWidgets.map((w) => (
                <li
                  key={w.id}
                  className="text-[11px] bg-[var(--surface-sunken)] rounded px-2 py-1 flex items-center gap-2"
                  data-testid={`mindmap-attached-${w.id}`}
                >
                  <Icon
                    name={catalogFor(w.kind)?.icon ?? 'widgets'}
                    size={12}
                    className="text-[var(--ink-50)] shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[var(--ink-90)] truncate">
                      {w.title || catalogFor(w.kind)?.label || w.kind}
                    </div>
                    <div className="text-[10px] text-[var(--ink-50)] truncate">
                      {w.kind}
                    </div>
                  </div>
                  <button
                    onClick={() => onDetachWidget(w.id)}
                    className="text-[10px] text-[var(--ink-40)] hover:text-[var(--ink-70)]"
                    title="Detach (does NOT delete the widget — only removes the link)"
                  >
                    Unlink
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Phase 1 + 2A + 2C — suggested agents with Run + Create-new */}
        <div className="pt-3 border-t border-[var(--edge-soft)]">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-semibold">
              Suggested agents
            </span>
            <div className="flex gap-2">
              <button
                onClick={onFetchAgents}
                disabled={busy === 'agents'}
                className="text-[10px] text-accent hover:underline disabled:opacity-60"
                data-testid="mindmap-suggest-agents"
              >
                {busy === 'agents'
                  ? 'Picking…'
                  : suggestions.length > 0
                    ? 'Re-suggest'
                    : 'Find agents'}
              </button>
              <button
                onClick={onCreateAgent}
                className="text-[10px] text-accent hover:underline"
                data-testid="mindmap-create-agent"
              >
                + New
              </button>
            </div>
          </div>
          {agentsInventory && (
            <div className="text-[9px] text-[var(--ink-50)] mb-1.5 leading-snug">
              <div className="flex items-center gap-1.5">
                <span className="truncate">
                  {agentsInventory.source === 'none'
                    ? 'No agents directory found yet'
                    : `From: ${friendlyPath(agentsInventory.workspaceRoot)}`}
                </span>
                {agentsInventory.agentsDir && (
                  <button
                    onClick={onRevealAgentsDir}
                    className="text-accent hover:underline shrink-0"
                    title={agentsInventory.agentsDir}
                    data-testid="mindmap-reveal-agents-dir"
                  >
                    Open
                  </button>
                )}
              </div>
              {(agentsInventory.source === 'userData-new' ||
                agentsInventory.source === 'userData-existing') && (
                <div className="text-amber-700 dark:text-amber-300 mt-0.5">
                  Using PlexiDesk&apos;s userData fallback — set a workspace path in
                  Settings to point at your starter kit.
                </div>
              )}
            </div>
          )}
          {suggestions.length === 0 ? (
            <div className="text-[10px] text-[var(--ink-50)] leading-snug">
              Find agents picks the best matches from .claude/agents/.
              + New opens a wizard to author one for this node.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {suggestions.map((a) => {
                const ck = `${node.id}:${a.slug}`
                const conv = conversations[ck]
                const stats = agentStats[a.slug]
                return (
                  <li
                    key={a.slug}
                    className="text-[11px] bg-[var(--surface-sunken)] rounded px-2 py-1.5"
                    data-testid={`mindmap-agent-${a.slug}`}
                  >
                    <div className="flex items-start gap-1.5 mb-1">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-[var(--ink-90)] truncate">
                          {a.name}
                        </div>
                        <div className="text-[10px] text-[var(--ink-50)] leading-snug">
                          {a.rationale}
                        </div>
                        {/* Per-agent track-record badge — surfaces
                            applied / dismissed counts so the user can
                            calibrate trust per agent over time. */}
                        {stats && stats.invocations > 0 && (
                          <div
                            className="text-[9px] text-[var(--ink-50)] mt-0.5 tabular-nums"
                            data-testid={`mindmap-agent-stats-${a.slug}`}
                          >
                            {stats.invocations} run{stats.invocations === 1 ? '' : 's'} · {stats.applied} applied · {stats.dismissed} dismissed
                            {stats.undone > 0 && ` · ${stats.undone} undone`}
                          </div>
                        )}
                      </div>
                      {!conv && (
                        <button
                          onClick={() => onRunAgent(a)}
                          disabled={busy === 'invoke' || !a.path}
                          title={
                            a.path
                              ? 'Bounded invocation — agent proposes actions you review and apply'
                              : 'Re-run Find agents to resolve this agent\'s file path'
                          }
                          className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-white hover:opacity-90 disabled:opacity-50"
                          data-testid={`mindmap-run-agent-${a.slug}`}
                        >
                          {busy === 'invoke' ? '…' : 'Run'}
                        </button>
                      )}
                    </div>
                    {conv && (
                      <ConversationView
                        conversationKey={ck}
                        suggestion={a}
                        conversation={conv}
                        busy={busy}
                        onReplyToAgent={onReplyToAgent}
                        onApplyProposal={onApplyProposal}
                        onDismissProposal={onDismissProposal}
                        onUndoProposal={onUndoProposal}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {Object.keys(conversations).length > 0 && (
            <button
              onClick={onUndoLastApply}
              className="fb-btn-surface mt-2 w-full text-[10px] px-2 py-1 text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] inline-flex items-center justify-center gap-1.5"
              data-testid="mindmap-undo-last-apply"
              title="Reverses the most recent applied proposal across all agents (deletes the entity it created)"
            >
              <Icon name="undo" size={11} />
              Undo last applied proposal
            </button>
          )}
        </div>

        {errorMsg && (
          <div className="text-[10px] text-rose-500 leading-snug whitespace-pre-wrap">
            {errorMsg}
          </div>
        )}
      </div>
    </aside>
  )
}

// ── Phase 2 polish — multi-turn conversation transcript ────────────────────
//
// Renders the back-and-forth between the user and one agent as a
// vertical stack of turn cards. Each agent turn carries its own
// ActionProposals; per-proposal Apply / Dismiss / Undo buttons
// reflect the persisted state so a reload restores the exact UI
// the user left.
//
// The trailing reply box is only enabled when the conversation isn't
// capped AND no invocation is in flight. The cap matches the server's
// MAX_CONVERSATION_TURNS (5 round-trips). Past that we show a
// muted notice + a hint to start a fresh Run.

function ConversationView({
  conversationKey,
  suggestion,
  conversation,
  busy,
  onReplyToAgent,
  onApplyProposal,
  onDismissProposal,
  onUndoProposal
}: {
  conversationKey: string
  suggestion: AgentSuggestion
  conversation: AgentConversation
  busy: 'expand' | 'agents' | 'invoke' | 'creating-agent' | null
  onReplyToAgent: (s: AgentSuggestion, text: string) => void
  onApplyProposal: (ck: string, ti: number, pi: number) => void
  onDismissProposal: (ck: string, ti: number, pi: number) => void
  onUndoProposal: (ck: string, ti: number, pi: number) => void
}): JSX.Element {
  const [replyDraft, setReplyDraft] = useState('')
  function handleSubmit(): void {
    if (!replyDraft.trim() || busy === 'invoke' || conversation.capped) return
    onReplyToAgent(suggestion, replyDraft)
    setReplyDraft('')
  }
  return (
    <div
      className="mt-1 pt-1 border-t border-[var(--edge-soft)] space-y-1.5"
      data-testid={`mindmap-conversation-${suggestion.slug}`}
    >
      {conversation.turns.map((turn, ti) => (
        <div key={ti}>
          {/* The matching user reply (if any) is rendered BEFORE the
              next agent turn — i.e. the user reply that produced this
              turn. Render it for ti >= 1 so the first turn has no
              preceding user message. */}
          {ti >= 1 && conversation.userReplies[ti - 1] && (
            <div className="text-[10px] text-[var(--ink-50)] italic mb-1">
              You: {conversation.userReplies[ti - 1].content}
            </div>
          )}
          <div className="text-[10px] text-[var(--ink-70)] leading-snug whitespace-pre-wrap">
            {turn.reply}
          </div>
          {turn.proposalStates.length > 0 && (
            <ul className="mt-1.5 space-y-1">
              {turn.proposalStates.map((ps, pi) => (
                <li
                  key={ps.proposal.id}
                  className={`flex items-start gap-1.5 text-[10px] rounded px-1.5 py-1 border ${
                    ps.state === 'applied'
                      ? 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800'
                      : ps.state === 'dismissed'
                        ? 'bg-[var(--surface-sunken)] border-[var(--edge-soft)] opacity-60'
                        : ps.state === 'undone'
                          ? 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800 opacity-75'
                          : 'bg-[var(--surface-raised)] border-[var(--edge-soft)]'
                  }`}
                  data-testid={`mindmap-proposal-${ps.proposal.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[var(--ink-90)] truncate">
                      {labelForProposal(ps.proposal)}
                    </div>
                    {ps.state === 'applied' && (
                      <div className="text-[9px] text-emerald-700 dark:text-emerald-300 mt-0.5">
                        ✓ applied
                      </div>
                    )}
                    {ps.state === 'undone' && (
                      <div className="text-[9px] text-amber-700 dark:text-amber-300 mt-0.5">
                        ↶ undone
                      </div>
                    )}
                    {ps.state === 'dismissed' && (
                      <div className="text-[9px] text-[var(--ink-50)] mt-0.5">
                        ⊘ dismissed
                      </div>
                    )}
                  </div>
                  {ps.state === 'pending' && (
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => onApplyProposal(conversationKey, ti, pi)}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-white hover:opacity-90"
                        data-testid={`mindmap-apply-${ps.proposal.id}`}
                      >
                        Apply
                      </button>
                      <button
                        onClick={() => onDismissProposal(conversationKey, ti, pi)}
                        className="text-[10px] px-1.5 py-0.5 rounded text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
                      >
                        ⊘
                      </button>
                    </div>
                  )}
                  {ps.state === 'applied' && ps.createdEntityRef && (
                    <div className="flex gap-1 shrink-0">
                      {(() => {
                        const t = refToGoTarget(
                          ps.createdEntityRef,
                          labelForProposal(ps.proposal)
                        )
                        return t ? (
                          <button
                            onClick={() => void goToTarget(t)}
                            className="text-[10px] px-1.5 py-0.5 rounded text-accent hover:bg-[var(--surface-sunken)]"
                            data-testid={`mindmap-goto-${ps.proposal.id}`}
                          >
                            Go to
                          </button>
                        ) : null
                      })()}
                      <button
                        onClick={() => onUndoProposal(conversationKey, ti, pi)}
                        className="text-[10px] px-1.5 py-0.5 rounded text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/30"
                        data-testid={`mindmap-undo-${ps.proposal.id}`}
                      >
                        Undo
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {conversation.capped ? (
        <div className="text-[9px] text-[var(--ink-50)] italic mt-1">
          Conversation full ({MAX_CONVERSATION_TURNS} turns). Start a fresh Run
          for further work.
        </div>
      ) : (
        <div className="flex gap-1 mt-1">
          <input
            type="text"
            value={replyDraft}
            onChange={(e) => setReplyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit()
              }
            }}
            placeholder="Reply to the agent…"
            disabled={busy === 'invoke'}
            className="fb-field flex-1 min-w-0 text-[10px] px-1.5 py-0.5 disabled:opacity-60"
            data-testid={`mindmap-reply-input-${suggestion.slug}`}
          />
          <button
            onClick={handleSubmit}
            disabled={!replyDraft.trim() || busy === 'invoke'}
            className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-white hover:opacity-90 disabled:opacity-50 shrink-0"
            data-testid={`mindmap-reply-send-${suggestion.slug}`}
          >
            Send
          </button>
        </div>
      )}
    </div>
  )
}

// ── Phase 2A — Agent creation wizard modal ─────────────────────────────────

function AgentBuilderModal({
  rootPath,
  selectedNode,
  onCancel,
  onCreated
}: {
  rootPath: string[]
  selectedNode: MindMapNode
  onCancel: () => void
  onCreated: (slug: string) => void
}): JSX.Element {
  // Pre-fill from the node context. The user can edit before submit.
  const [slug, setSlug] = useState(slugify(selectedNode.label))
  const [description, setDescription] = useState(
    `Designed for: ${selectedNode.label}.`
  )
  const [model, setModel] = useState<AgentModelTier>('sonnet')
  const [tools, setTools] = useState<AgentTool[]>(['Read', 'Write', 'Grep'])
  const [purpose, setPurpose] = useState(
    `Context: ${rootPath.join(' › ')}\n\nAgent should: [describe what the agent does, step by step]`
  )
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(): Promise<void> {
    if (submitting) return
    setSubmitting(true)
    setErr(null)
    try {
      const result = await window.api.agents.create({
        slug,
        description,
        model,
        tools,
        purpose,
        contextPath: rootPath
      })
      setSubmitting(false)
      if (!result.ok) {
        setErr(result.error)
        return
      }
      onCreated(result.slug)
    } catch (err) {
      setSubmitting(false)
      setErr(`Creation failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function toggleTool(t: AgentTool): void {
    setTools((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))
  }

  return (
    <div
      className="fb-scrim absolute inset-0 z-30 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="fb-card fb-press w-full max-w-[420px] p-3 max-h-[90%] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-semibold">
            New agent
          </span>
          <button
            onClick={onCancel}
            className="h-5 w-5 inline-flex items-center justify-center text-[var(--ink-40)] hover:text-[var(--ink-100)]"
          >
            <Icon name="close" size={11} />
          </button>
        </div>
        <div className="space-y-2">
          <Field label="Slug (filename)">
            <input
              value={slug}
              onChange={(e) => setSlug(slugify(e.target.value))}
              className="fb-field w-full text-[12px] px-2 py-1"
              data-testid="agent-wizard-slug"
            />
          </Field>
          <Field label="One-line description">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="fb-field w-full text-[12px] px-2 py-1"
              data-testid="agent-wizard-description"
            />
          </Field>
          <Field label="Model tier">
            <div className="flex gap-1">
              {(['haiku', 'sonnet', 'opus'] as AgentModelTier[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setModel(m)}
                  className={`flex-1 text-[10px] px-1.5 py-1 rounded ${
                    model === m
                      ? 'bg-accent text-white'
                      : 'bg-[var(--surface-sunken)] text-[var(--ink-70)]'
                  }`}
                  data-testid={`agent-wizard-model-${m}`}
                >
                  {m}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Tools available to this agent">
            <div className="flex flex-wrap gap-1">
              {(
                [
                  'Read',
                  'Write',
                  'Edit',
                  'Bash',
                  'Glob',
                  'Grep',
                  'WebFetch',
                  'WebSearch',
                  'Agent'
                ] as AgentTool[]
              ).map((t) => (
                <button
                  key={t}
                  onClick={() => toggleTool(t)}
                  className={`text-[10px] px-1.5 py-0.5 rounded ${
                    tools.includes(t)
                      ? 'bg-accent text-white'
                      : 'bg-[var(--surface-sunken)] text-[var(--ink-70)]'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Purpose — what should it do?">
            <MentionTextarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={5}
              className="fb-field w-full text-[11px] px-2 py-1 font-mono"
              data-testid="agent-wizard-purpose"
            />
          </Field>
          {err && (
            <div className="text-[10px] text-rose-500 leading-snug">
              {err}
            </div>
          )}
          <div className="flex gap-1.5 pt-1">
            <button
              onClick={onCancel}
              className="text-[11px] px-2 py-1.5 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
            >
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={submitting || !slug.trim() || !description.trim() || !purpose.trim()}
              className="flex-1 text-[11px] px-2 py-1.5 rounded bg-accent text-white hover:opacity-90 disabled:opacity-50"
              data-testid="agent-wizard-submit"
            >
              {submitting ? 'Writing .md…' : 'Create agent'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div>
      <label className="block text-[10px] uppercase tracking-wider text-[var(--ink-50)] mb-0.5">
        {label}
      </label>
      {children}
    </div>
  )
}

// ── Phase 2B — Tool picker modal ───────────────────────────────────────────

function ToolPickerModal({
  onPick,
  onCancel
}: {
  onPick: (kind: WidgetKind) => void
  onCancel: () => void
}): JSX.Element {
  const grouped = entriesByCategory()
  return (
    <div
      className="fb-scrim absolute inset-0 z-30 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="fb-card fb-press w-full max-w-[360px] p-3 max-h-[80%] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-semibold">
            Attach a tool to this node
          </span>
          <button
            onClick={onCancel}
            className="h-5 w-5 inline-flex items-center justify-center text-[var(--ink-40)] hover:text-[var(--ink-100)]"
          >
            <Icon name="close" size={11} />
          </button>
        </div>
        <div className="space-y-3">
          {Object.entries(grouped).map(([cat, items]) => {
            if (items.length === 0) return null
            return (
              <div key={cat}>
                <div className="text-[9px] uppercase tracking-[0.14em] text-[var(--ink-50)] font-semibold mb-1">
                  {cat}
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {items.map((entry) => (
                    <button
                      key={entry.kind}
                      onClick={() => onPick(entry.kind)}
                      className="fb-btn-surface flex flex-col items-center gap-0.5 px-1.5 py-1.5 hover:border-accent hover:bg-accent/5 dark:hover:bg-accent/10 text-[var(--ink-70)]"
                      title={entry.hint}
                      data-testid={`mindmap-tool-${entry.kind}`}
                    >
                      <Icon
                        name={entry.icon}
                        size={14}
                        className="text-[var(--ink-70)]"
                      />
                      <span className="text-[9px] font-medium text-center">
                        {entry.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Tree helpers ───────────────────────────────────────────────────────────

function findNode(root: MindMapNode, id: string): MindMapNode | null {
  if (root.id === id) return root
  for (const c of root.children) {
    const found = findNode(c, id)
    if (found) return found
  }
  return null
}

function pathFromRoot(root: MindMapNode, id: string): MindMapNode[] {
  if (root.id === id) return [root]
  for (const c of root.children) {
    const sub = pathFromRoot(c, id)
    if (sub.length > 0) return [root, ...sub]
  }
  return []
}

function findParent(root: MindMapNode, childId: string): MindMapNode | null {
  for (const c of root.children) {
    if (c.id === childId) return root
    const deeper = findParent(c, childId)
    if (deeper) return deeper
  }
  return null
}

function mapTree(
  node: MindMapNode,
  id: string,
  mutator: (n: MindMapNode) => MindMapNode
): MindMapNode {
  if (node.id === id) return mutator(node)
  return { ...node, children: node.children.map((c) => mapTree(c, id, mutator)) }
}

function pruneTree(node: MindMapNode, id: string): MindMapNode {
  return {
    ...node,
    children: node.children.filter((c) => c.id !== id).map((c) => pruneTree(c, id))
  }
}

// ── Layout (tidy-tree, horizontal) ─────────────────────────────────────────

interface LaidOutNode {
  id: string
  label: string
  kind: MindMapNodeKind
  x: number
  y: number
  width: number
  height: number
  hasAttachments: boolean
  // True when the node has been explored into its own task canvas.
  hasCanvas: boolean
  // Pending nodes render with a dashed outline + reduced opacity so
  // the triage stage is visually obvious. Click → accept (in the
  // side panel); click reject (×) to drop.
  pending: boolean
  // Pending nodes need to know their parent to wire accept/reject
  // controls without an extra lookup at click time.
  pendingParentId?: string
}
interface LaidOutEdge {
  from: string
  to: string
  x1: number
  y1: number
  x2: number
  y2: number
}
interface Layout {
  nodes: LaidOutNode[]
  edges: LaidOutEdge[]
  width: number
  height: number
}

const MIN_NODE_W = 120
const MAX_NODE_W = 220
const NODE_H = 40
const NODE_H_MULTI = 24 // additional height per wrapped line
const H_GAP = 80
const V_GAP = 14

/**
 * Estimate the rendered dimensions of a node from its label. Uses
 * char-width approximation (we don't measure actual text — too
 * expensive for layout). Wraps to 2-3 lines when the label exceeds
 * the max single-line width, growing height accordingly.
 *
 * The function is intentionally tolerant: precise sizing isn't
 * critical because the foreignObject's flexbox-centred div will
 * adapt to the actual rendered text. We just need the layout to
 * roughly match so the edge curves don't overlap.
 */
function sizeForLabel(label: string): { width: number; height: number } {
  const text = label || 'Untitled'
  const CHAR_W = 7.5 // approximation for the 11px sans-serif we use
  const PAD = 24
  const estWidth = text.length * CHAR_W + PAD
  if (estWidth <= MAX_NODE_W) {
    return {
      width: Math.max(MIN_NODE_W, Math.ceil(estWidth)),
      height: NODE_H
    }
  }
  // Wraps. Estimate lines: divide total width by max line capacity.
  const usableLineW = MAX_NODE_W - PAD
  const lines = Math.min(3, Math.ceil((text.length * CHAR_W) / usableLineW))
  return {
    width: MAX_NODE_W,
    height: NODE_H + (lines - 1) * NODE_H_MULTI
  }
}

function layoutTree(root: MindMapNode): Layout {
  const nodeOut = new Map<string, LaidOutNode>()
  const edgeOut: LaidOutEdge[] = []
  let cursorY = 0

  // Per-depth x positions, computed greedily — when a deeper child has
  // a wider parent, we shift the level accordingly. This is fine for
  // small mind maps; a rigorous walker would solve a constraint
  // system but the user-perceived difference is invisible.
  const depthOffsets: number[] = [0]
  function xForDepth(depth: number, width: number): number {
    while (depthOffsets.length <= depth) {
      // Use the running max from the prior depth + gap.
      const prior = depthOffsets[depthOffsets.length - 1]
      depthOffsets.push(prior + MAX_NODE_W + H_GAP)
    }
    return depthOffsets[depth] + width / 2
  }

  // Combined iteration helper that yields BOTH children and pending
  // children so the layout treats them uniformly. Pending children
  // are rendered, just with a dashed outline.
  function combinedChildren(
    n: MindMapNode
  ): Array<{ node: MindMapNode; pending: boolean; parentId: string }> {
    const out: Array<{ node: MindMapNode; pending: boolean; parentId: string }> = []
    for (const c of n.children) out.push({ node: c, pending: false, parentId: n.id })
    for (const c of n.pendingChildren ?? [])
      out.push({ node: c, pending: true, parentId: n.id })
    return out
  }

  function place(
    node: MindMapNode,
    depth: number,
    pending: boolean,
    pendingParentId?: string
  ): { centerY: number; height: number } {
    const dims = sizeForLabel(node.label)
    const allChildren = combinedChildren(node)
    if (allChildren.length === 0) {
      const y = cursorY + dims.height / 2
      cursorY += dims.height + V_GAP
      nodeOut.set(node.id, {
        id: node.id,
        label: node.label,
        kind: node.kind,
        x: xForDepth(depth, dims.width),
        y,
        width: dims.width,
        height: dims.height,
        hasAttachments: (node.attachedWidgetIds?.length ?? 0) > 0,
        hasCanvas: !!node.taskId,
        pending,
        pendingParentId
      })
      return { centerY: y, height: dims.height }
    }
    const childResults: { centerY: number; height: number }[] = []
    for (const c of allChildren) {
      childResults.push(place(c.node, depth + 1, c.pending, c.parentId))
    }
    const top = childResults[0].centerY
    const bottom = childResults[childResults.length - 1].centerY
    const centerY = (top + bottom) / 2
    nodeOut.set(node.id, {
      id: node.id,
      label: node.label,
      kind: node.kind,
      x: xForDepth(depth, dims.width),
      y: centerY,
      width: dims.width,
      height: dims.height,
      hasAttachments: (node.attachedWidgetIds?.length ?? 0) > 0,
      hasCanvas: !!node.taskId,
      pending,
      pendingParentId
    })
    return { centerY, height: dims.height }
  }

  place(root, 0, false, undefined)

  function buildEdges(node: MindMapNode): void {
    const fromPlaced = nodeOut.get(node.id)
    if (!fromPlaced) return
    for (const c of combinedChildren(node)) {
      const toPlaced = nodeOut.get(c.node.id)
      if (!toPlaced) continue
      edgeOut.push({
        from: node.id,
        to: c.node.id,
        x1: fromPlaced.x + fromPlaced.width / 2,
        y1: fromPlaced.y,
        x2: toPlaced.x - toPlaced.width / 2,
        y2: toPlaced.y
      })
      buildEdges(c.node)
    }
  }
  buildEdges(root)

  let maxX = 0
  let maxY = 0
  for (const n of nodeOut.values()) {
    if (n.x + n.width / 2 > maxX) maxX = n.x + n.width / 2
    if (n.y + n.height / 2 > maxY) maxY = n.y + n.height / 2
  }
  const PAD = 20
  return {
    nodes: Array.from(nodeOut.values()).map((n) => ({
      ...n,
      x: n.x + PAD,
      y: n.y + PAD
    })),
    edges: edgeOut.map((e) => ({
      ...e,
      x1: e.x1 + PAD,
      y1: e.y1 + PAD,
      x2: e.x2 + PAD,
      y2: e.y2 + PAD
    })),
    width: maxX + 2 * PAD,
    height: maxY + 2 * PAD
  }
}

function curvedEdge(x1: number, y1: number, x2: number, y2: number): string {
  const cx = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`
}

// ── Cosmetic helpers ───────────────────────────────────────────────────────

function fillForKind(kind: MindMapNodeKind, selected: boolean): string {
  if (selected) return 'rgb(var(--accent) / 0.12)'
  switch (kind) {
    case 'task':
      return 'rgba(16,185,129,0.10)'
    case 'question':
      return 'rgba(245,158,11,0.10)'
    case 'tool':
      return 'rgb(14 165 233 / 0.10)'
    case 'agent':
      return 'rgb(139 92 246 / 0.10)'
    case 'idea':
    default:
      return 'rgba(120,113,108,0.08)'
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

// Compress an absolute path for display. Substitutes the user's
// home directory with ~/ and the cwd with ./, then truncates the
// middle if the result still exceeds ~40 chars. Good enough for
// the small "Agents from:" header.
function friendlyPath(path: string | null): string {
  if (!path) return ''
  // Best-effort homedir compression. We can't read process.env.HOME
  // synchronously in renderer; the basename + 1 parent is usually
  // identifying enough.
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 2) return path
  return '…/' + parts.slice(-2).join('/')
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function labelForProposal(p: ActionProposal): string {
  switch (p.kind) {
    case 'create-task':
      return `New desk — ${p.title}`
    case 'create-work-item':
      return `To Attention — ${p.title}`
    case 'create-todo-list':
      return `Todo list — ${p.title} (${p.items.length} items)`
    case 'create-widget':
      return `New ${p.widgetKind} — ${p.title || '(no title)'}`
    case 'create-page':
      return `New page — ${p.title}`
    default:
      return 'Proposal'
  }
}

// Parse a stored `${kind}:${id}` agent-outcome ref back into a navigable
// GoToTarget so an applied proposal's compact card can offer "Go to" — same
// navigation the standard ProposalCards give, in node-appropriate form.
function refToGoTarget(ref: string, label: string): GoToTarget | null {
  const idx = ref.indexOf(':')
  if (idx < 0) return null
  const kind = ref.slice(0, idx)
  const id = ref.slice(idx + 1)
  if (!id) return null
  if (kind === 'task' || kind === 'widget' || kind === 'document') {
    return { kind, id, label }
  }
  return null
}

function parsePersisted(raw: string | null | undefined): PersistedState {
  if (!raw) return EMPTY_STATE
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState> & {
      // Legacy single-turn shape — present in widget.content blobs
      // written by Phase 2C v1. We rehydrate each entry into a
      // 1-turn AgentConversation so the user doesn't lose their
      // prior agent runs across the upgrade.
      agentInvocations?: Record<string, { agentName: string; reply: string; proposals: ActionProposal[] }>
    }
    if (!parsed.root || typeof parsed.root !== 'object') return EMPTY_STATE
    let conversations: Record<string, AgentConversation> = {}
    if (parsed.agentConversations && typeof parsed.agentConversations === 'object') {
      conversations = parsed.agentConversations as Record<string, AgentConversation>
    } else if (parsed.agentInvocations && typeof parsed.agentInvocations === 'object') {
      for (const [k, v] of Object.entries(parsed.agentInvocations)) {
        const slug = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k
        conversations[k] = {
          agentName: v.agentName,
          agentSlug: slug,
          turns: [
            {
              rawReply: v.reply,
              reply: v.reply,
              proposalStates: v.proposals.map((p) => ({
                proposal: p,
                state: 'pending'
              })),
              invocationId: 'legacy',
              conversationTurn: 1,
              at: Date.now()
            }
          ],
          userReplies: [],
          capped: false
        }
      }
    }
    const normalisedRoot = normaliseNode(parsed.root as MindMapNode)
    return {
      root: normalisedRoot,
      selectedId:
        typeof parsed.selectedId === 'string' ? parsed.selectedId : normalisedRoot.id,
      viewRootId:
        typeof parsed.viewRootId === 'string' && findNode(normalisedRoot, parsed.viewRootId)
          ? parsed.viewRootId
          : normalisedRoot.id,
      agentSuggestions:
        parsed.agentSuggestions && typeof parsed.agentSuggestions === 'object'
          ? (parsed.agentSuggestions as Record<string, AgentSuggestion[]>)
          : {},
      agentConversations: conversations,
      agentStats:
        parsed.agentStats && typeof parsed.agentStats === 'object'
          ? (parsed.agentStats as PersistedState['agentStats'])
          : {}
    }
  } catch {
    return EMPTY_STATE
  }
}

function normaliseNode(n: MindMapNode): MindMapNode {
  return {
    id: typeof n.id === 'string' && n.id ? n.id : 'root',
    label: typeof n.label === 'string' ? n.label : 'Untitled',
    kind:
      n.kind === 'task' || n.kind === 'question' || n.kind === 'tool' || n.kind === 'agent'
        ? n.kind
        : 'idea',
    rationale: typeof n.rationale === 'string' ? n.rationale : undefined,
    // Preserve the explored-canvas link across reloads.
    taskId: typeof n.taskId === 'string' && n.taskId ? n.taskId : undefined,
    children: Array.isArray(n.children) ? n.children.map(normaliseNode) : [],
    attachedWidgetIds: Array.isArray(n.attachedWidgetIds)
      ? n.attachedWidgetIds.filter((x): x is string => typeof x === 'string')
      : [],
    assignedAgentSlugs: Array.isArray(n.assignedAgentSlugs)
      ? n.assignedAgentSlugs.filter((x): x is string => typeof x === 'string')
      : [],
    pendingChildren: Array.isArray(n.pendingChildren)
      ? n.pendingChildren.map(normaliseNode)
      : []
  }
}
