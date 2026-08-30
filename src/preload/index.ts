import type { WriteOrigin } from '../shared/writeOrigin'
import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActionProposal,
  ActivityEvent,
  ActivityRecordDraft,
  AiBuildResponse,
  BodyDoubleResponse,
  BrowsingHistoryEntry,
  ChatQuestion,
  ChatRequest,
  ChatResponse,
  ChatMentionResolved,
  ChatRetrievalTrace,
  ChatToolTrace,
  ConnectedApp,
  ConnectedAppDraft,
  ConnectedAppPatch,
  ContextMenuPayload,
  DashboardCardKind,
  DashboardLayout,
  DashboardLayoutInput,
  EnergyLevel,
  EnergyLogEntry,
  TimeBlock,
  TimeBlockDraft,
  TimeBlockPatch,
  FbNode,
  HapticFeel,
  FocusSession,
  FocusSessionCompletePatch,
  FocusSessionStartDraft,
  LivingPageRegenerateResponse,
  MailAccountInput,
  MailAccountPublic,
  MailListItem,
  MailFullMessage,
  MailSendInput,
  MailSendResult,
  EmailReplyDraftResult,
  DocType,
  DocumentDraft,
  DocumentMeta,
  DocSnapshotMeta,
  DocumentPatch,
  FbDocument,
  ModelMode,
  NodeDraft,
  NodePatch,
  SetupSuggestResponse,
  SmartStackResponse,
  SnapshotMeta,
  Template,
  TrailSummaryResponse,
  VaultEntryDraft,
  VaultEntryPatch,
  VaultEntryStored,
  VaultMeta,
  Widget,
  WidgetDraft,
  ShareableKind,
  ShareLink,
  SharedItem,
  ShareScope,
  SearchHit,
  WidgetLink,
  WidgetPatch,
  WireType,
  WireRun
} from '@shared/types'
import type {
  FbFile,
  FileEntry,
  FbRow,
  FbRowDraft,
  FbRowPatch,
  FbTable,
  FbTableDraft,
  FbTablePatch
} from '@shared/fields'
import type { KnowledgeEntry, KnowledgeDraft, KnowledgePatch } from '@shared/knowledge'
import type { DeskLayout, DeviceClass } from '@shared/deskLayout'
import type { Decision } from '@shared/decision'

// Local-document comment row as returned by the docComments IPC.
interface DocCommentDto {
  id: string
  docId: string
  parentId: string | null
  anchorId: string | null
  author: string
  body: string
  resolved: boolean
  createdAt: number
}
import type { Meeting, MeetingDraft, MeetingPatch } from '@shared/meetings'
import type { PlexiApp, PlexiAppDraft, PlexiAppPatch } from '@shared/apps'
import type { PlexiForm, PlexiFormDraft, PlexiFormPatch } from '@shared/forms'
import type { PlexiSignRequest, PlexiSignDraft, PlexiSignPatch, SignAction } from '@shared/sign'

type VaultResult = { ok: true } | { ok: false; error: string }

// Mirror of the document page setup carried to the .docx/PDF exporters.
interface PageSetupInput {
  size: 'letter' | 'a4'
  orientation: 'portrait' | 'landscape'
  margin: { top: number; right: number; bottom: number; left: number }
  header?: { text?: string; showPageNumber?: boolean }
  footer?: { text?: string; showPageNumber?: boolean }
}

const api = {
  // The host OS, so the renderer can tailor flows that differ by platform
  // (e.g. macOS updates are download-to-replace rather than in-place install).
  platform: process.platform as NodeJS.Platform,
  nodes: {
    list: (): Promise<FbNode[]> => ipcRenderer.invoke('nodes:list'),
    get: (id: string): Promise<FbNode | null> => ipcRenderer.invoke('nodes:get', id),
    create: (draft: NodeDraft, origin?: WriteOrigin): Promise<FbNode> =>
      ipcRenderer.invoke('nodes:create', draft, origin),
    update: (id: string, patch: NodePatch, origin?: WriteOrigin): Promise<FbNode | null> =>
      ipcRenderer.invoke('nodes:update', id, patch, origin),
    // Soft-delete: returns the trashed ids (the node + its subtree) for undo.
    delete: (id: string, origin?: WriteOrigin): Promise<string[]> =>
      ipcRenderer.invoke('nodes:delete', id, origin),
    // DEC-021 (D2): immediate hard-delete + memory purge — the dialog's
    // "Delete everything permanently" choice. No trash window, no undo.
    deletePermanent: (
      id: string
    ): Promise<{
      purgedNodes: number
      revived: number
      memory: { memoryRows: number; chunkRows: number; ledgerRows: number; reviewPoints: number }
    }> => ipcRenderer.invoke('nodes:deletePermanent', id),
    restore: (ids: string[]): Promise<boolean> => ipcRenderer.invoke('nodes:restore', ids),
    // Trash surfacing (lifecycle L1): trashed roots + days-remaining, and
    // lossless subtree restore.
    listTrash: (): Promise<
      Array<{ id: string; kind: string; title: string; trashedAt: number; purgeAt: number }>
    > => ipcRenderer.invoke('nodes:listTrash'),
    restoreTree: (rootId: string): Promise<string[]> =>
      ipcRenderer.invoke('nodes:restoreTree', rootId),
    // Lifecycle L3: computed desk staleness (Stale Desks widget's only feed).
    staleDesks: (): Promise<
      Array<{ id: string; title: string; lastActivityMs: number; daysQuiet: number }>
    > => ipcRenderer.invoke('nodes:staleDesks'),
    moveToOrg: (id: string, orgId: string, teamId?: string | null): Promise<string[]> =>
      ipcRenderer.invoke('nodes:moveToOrg', id, orgId, teamId ?? null),
    move: (
      id: string,
      newParentId: string | null,
      beforeId: string | null
    ): Promise<FbNode | null> =>
      ipcRenderer.invoke('nodes:move', id, newParentId, beforeId),
    // User-driven desk relatedness. relate/unrelate return the updated related-id
    // list for the first desk so the caller can refresh without a second call.
    relate: (a: string, b: string): Promise<string[]> => ipcRenderer.invoke('nodes:relate', a, b),
    unrelate: (a: string, b: string): Promise<string[]> => ipcRenderer.invoke('nodes:unrelate', a, b),
    listRelated: (id: string): Promise<string[]> => ipcRenderer.invoke('nodes:listRelated', id)
  },
  // Context Engine (plexi-4.0) — live contextual awareness read surface.
  context: {
    // Confirmed knowledge-graph neighbours of an object ("surfaces with relations").
    related: (id: string): Promise<string[]> => ipcRenderer.invoke('context:related', id),
    // Per-(user, object) Context Health, honest against the user's last review point.
    health: (
      id: string
    ): Promise<{
      objectId: string
      state: 'current' | 'changed' | 'attention-required' | 'decision-risk'
      changedEventCount: number
      materiality: { score: number; band: string } | null
      decisionsAtRisk: Array<{ decisionId: string; title: string; invalidatingChange: string }>
    }> => ipcRenderer.invoke('context:health', id),
    // Record that the user has reviewed an object now (resets health to current).
    markReviewed: (id: string): Promise<boolean> => ipcRenderer.invoke('context:markReviewed', id),
    // Live catch-up Resume with an AI summary (degrades to the deterministic summary
    // when no model key is set).
    resumeSummary: (
      deskId: string
    ): Promise<{ summary: string; aiSummary: string | null; degraded: boolean; cacheHit: boolean; changedEventCount: number }> =>
      ipcRenderer.invoke('context:resumeSummary', deskId)
  },
  // Decisions (spec §37). Human-owned records that reference Objects/Desks; a
  // change to a referenced Object raises Decision Risk against it. Creating one is
  // what activates the decision-risk surface (red widget frame + desk alerts).
  decisions: {
    create: (input: {
      title: string
      decisionStatement?: string
      relatedObjectIds?: string[]
      affectedDeskIds?: string[]
    }): Promise<Decision> => ipcRenderer.invoke('decisions:create', input),
    list: (): Promise<Decision[]> => ipcRenderer.invoke('decisions:list'),
    forObject: (objectId: string): Promise<Decision[]> => ipcRenderer.invoke('decisions:forObject', objectId),
    // Each live Decision with whether an Object it references has a material change
    // since review (drives the decisions panel's at-risk status).
    withRisk: (): Promise<Array<{ decision: Decision; atRisk: boolean; riskyObjectIds: string[] }>> =>
      ipcRenderer.invoke('decisions:withRisk'),
    cancel: (id: string): Promise<boolean> => ipcRenderer.invoke('decisions:cancel', id)
  },
  widgets: {
    // Fetch one widget by id. Needed to answer "which desk is this on?" when all
    // you have is the widget — a cited source names the widget, not its canvas.
    get: (id: string): Promise<Widget | null> => ipcRenderer.invoke('widgets:get', id),
    listByTask: (taskId: string): Promise<Widget[]> =>
      ipcRenderer.invoke('widgets:listByTask', taskId),
    listByKind: (kind: Widget['kind']): Promise<Widget[]> =>
      ipcRenderer.invoke('widgets:listByKind', kind),
    create: (draft: WidgetDraft, origin?: WriteOrigin): Promise<Widget> =>
      ipcRenderer.invoke('widgets:create', draft, origin),
    createOptional: (draft: WidgetDraft): Promise<Widget | null> =>
      ipcRenderer.invoke('widgets:createOptional', draft),
    update: (id: string, patch: WidgetPatch, origin?: WriteOrigin): Promise<Widget | null> =>
      ipcRenderer.invoke('widgets:update', id, patch, origin),
    delete: (id: string, origin?: WriteOrigin): Promise<boolean> =>
      ipcRenderer.invoke('widgets:delete', id, origin),
    restore: (id: string): Promise<boolean> => ipcRenderer.invoke('widgets:restore', id),
    bringToFront: (id: string): Promise<Widget | null> =>
      ipcRenderer.invoke('widgets:bringToFront', id)
  },
  widgetLinks: {
    listByTask: (taskId: string): Promise<WidgetLink[]> =>
      ipcRenderer.invoke('widgetLinks:listByTask', taskId),
    create: (
      sourceWidgetId: string,
      targetWidgetId: string,
      taskId: string,
      type?: WireType,
      // Optional explicit id — the CRDT substrate materialises a link with the same
      // id on another device (create-if-missing).
      id?: string
    ): Promise<WidgetLink | null> =>
      ipcRenderer.invoke('widgetLinks:create', sourceWidgetId, targetWidgetId, taskId, type, id),
    update: (
      id: string,
      patch: {
        type?: WireType
        verb?: string
        enabled?: boolean
        lastRunAt?: number | null
        lastError?: string | null
      }
    ): Promise<WidgetLink | null> => ipcRenderer.invoke('widgetLinks:update', id, patch),
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('widgetLinks:delete', id)
  },
  wireRuns: {
    record: (input: Omit<WireRun, 'id'>): Promise<WireRun> =>
      ipcRenderer.invoke('wireRuns:record', input),
    listByWire: (wireId: string, limit?: number): Promise<WireRun[]> =>
      ipcRenderer.invoke('wireRuns:listByWire', wireId, limit),
    listByTask: (taskId: string, limit?: number): Promise<WireRun[]> =>
      ipcRenderer.invoke('wireRuns:listByTask', taskId, limit)
  },
  webhooks: {
    // Outbound POST from the main process (no CORS). Returns an honest result.
    send: (input: {
      url: string
      method?: string
      body?: string
      contentType?: string
    }): Promise<{ ok: boolean; status?: number; error?: string }> =>
      ipcRenderer.invoke('webhooks:send', input)
  },
  brain: {
    // Sync the whole workspace (desks, documents, notes/pages, Drive files) into
    // the PlexiBrain knowledge base. Idempotent; returns counts.
    ingestWorkspace: (): Promise<{
      desks: number
      documents: number
      widgets: number
      files: number
      created: number
      updated: number
    }> => ipcRenderer.invoke('brain:ingestWorkspace')
  },
  snapshots: {
    create: (taskId: string, label?: string): Promise<SnapshotMeta> =>
      ipcRenderer.invoke('snapshots:create', taskId, label),
    list: (taskId: string): Promise<SnapshotMeta[]> =>
      ipcRenderer.invoke('snapshots:list', taskId),
    get: (id: string): Promise<{ meta: SnapshotMeta; widgets: Widget[] } | null> =>
      ipcRenderer.invoke('snapshots:get', id),
    restore: (id: string): Promise<{ taskId: string; widgets: Widget[] } | null> =>
      ipcRenderer.invoke('snapshots:restore', id),
    branch: (id: string, title: string): Promise<{ taskId: string } | null> =>
      ipcRenderer.invoke('snapshots:branch', id, title)
  },
  wires: {
    runTransform: (
      sourceId: string,
      targetId: string,
      verb: string,
      liveText?: string
    ): Promise<{
      ok: boolean
      result?: string
      skipped?: boolean
      needsApiKey?: boolean
      error?: string
    }> => ipcRenderer.invoke('wires:runTransform', sourceId, targetId, verb, liveText)
  },
  shares: {
    listAll: (): Promise<ShareLink[]> => ipcRenderer.invoke('shares:listAll'),
    listForEntity: (
      kind: ShareableKind,
      entityId: string
    ): Promise<ShareLink[]> =>
      ipcRenderer.invoke('shares:listForEntity', kind, entityId),
    create: (input: {
      token: string
      kind: ShareableKind
      entityId: string
      label: string
      scope: ShareScope
      expiresAt: number | null
      createdBy?: string | null
    }): Promise<ShareLink> => ipcRenderer.invoke('shares:create', input),
    revoke: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('shares:revoke', id),
    setScope: (id: string, scope: 'view' | 'copy'): Promise<ShareLink | null> =>
      ipcRenderer.invoke('shares:setScope', id, scope),
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('shares:delete', id),
    inbox: (): Promise<SharedItem[]> => ipcRenderer.invoke('shares:inbox'),
    accept: (input: {
      token: string
      kind: ShareableKind
      snapshot: unknown
      fromHandle: string
      scope: ShareScope
    }): Promise<SharedItem> => ipcRenderer.invoke('shares:accept', input),
    removeInbox: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('shares:removeInbox', id)
  },
  // Account session — load/save/clear lives in main so the session token
  // is encrypted at rest via Electron safeStorage. The renderer treats
  // the token as opaque and never persists it directly.
  streamdeck: {
    execute: (
      action: unknown
    ): Promise<{ ok: boolean; error?: string; needsAccessibility?: boolean }> =>
      ipcRenderer.invoke('streamdeck:execute', action),
    openAccessibilitySettings: (): Promise<{
      ok: boolean
      strategy: string
    }> => ipcRenderer.invoke('streamdeck:openAccessibilitySettings'),
    checkAccessibility: (): Promise<boolean> =>
      ipcRenderer.invoke('streamdeck:checkAccessibility'),
    // Triggers the macOS native accessibility prompt with a working
    // "Open System Settings" button. Returns the current trust state.
    promptAccessibility: (): Promise<boolean> =>
      ipcRenderer.invoke('streamdeck:promptAccessibility'),
    // Just opens System Settings (or System Preferences) by app name —
    // bulletproof, no URL processing involved. User navigates manually.
    openSettingsApp: (): Promise<boolean> =>
      ipcRenderer.invoke('streamdeck:openSettingsApp'),
    // Reveals the running app's bundle in Finder. In dev = Electron.app,
    // in prod = PlexiDesk.app. The user drags this into Accessibility.
    revealAppInFinder: (): Promise<{
      ok: boolean
      bundleName: string | null
    }> => ipcRenderer.invoke('streamdeck:revealAppInFinder')
  },
  // Universal SpeedDeck config — shared across every SpeedDeck widget
  // in "Universal" scope so the same buttons follow the user from task
  // to task. Stored as opaque JSON in userData; the renderer
  // parses/serialises via parseDeckConfig.
  speeddeck: {
    loadUniversal: (): Promise<string | null> =>
      ipcRenderer.invoke('speeddeck:loadUniversal'),
    saveUniversal: (json: string): Promise<void> =>
      ipcRenderer.invoke('speeddeck:saveUniversal', json)
  },
  activity: {
    getState: (): Promise<{
      enabled: boolean
      switchCount: number
      pressCount: number
    }> => ipcRenderer.invoke('activity:getState'),
    setEnabled: (enabled: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('activity:setEnabled', enabled),
    read: (): Promise<{
      enabled: boolean
      switches: Array<{ app: string; ts: number }>
      presses: Array<{ label: string; kind: string; ts: number }>
    }> => ipcRenderer.invoke('activity:read'),
    logPress: (input: { label: string; kind: string }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('activity:logPress', input),
    wipe: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('activity:wipe')
  },
  account: {
    load: (): Promise<{
      sessionToken: string | null
      skippedAt: number | null
      cachedEmail: string | null
    }> => ipcRenderer.invoke('account:load'),
    saveSession: (input: { token: string; email: string | null }): Promise<void> =>
      ipcRenderer.invoke('account:saveSession', input),
    clearSession: (): Promise<void> => ipcRenderer.invoke('account:clearSession'),
    setSkipped: (skipped: boolean): Promise<void> =>
      ipcRenderer.invoke('account:setSkipped', skipped),
    setCachedEmail: (email: string | null): Promise<void> =>
      ipcRenderer.invoke('account:setCachedEmail', email)
  },
  // Desk layout overlay (PLX-APP-010 / UX-032). Per-(user, Desk, device class)
  // camera + selection, saved on user action and restored on Desk open.
  deskLayout: {
    load: (userId: string, deskId: string, deviceClass: DeviceClass): Promise<DeskLayout | null> =>
      ipcRenderer.invoke('deskLayout:load', userId, deskId, deviceClass),
    save: (layout: DeskLayout): Promise<void> => ipcRenderer.invoke('deskLayout:save', layout)
  },
  chat: {
    send: (req: ChatRequest): Promise<ChatResponse> => ipcRenderer.invoke('chat:send', req),
    hasApiKey: (): Promise<boolean> => ipcRenderer.invoke('chat:hasApiKey'),
    // Abort the live model stream behind a requestId (the composer's Stop).
    // The stream finishes through its normal path with everything that
    // already arrived — Stop keeps the partial answer, it never discards it.
    cancelStream: (requestId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('chat:cancelStream', requestId),
    proactiveWelcome: (taskId: string): Promise<ChatResponse> =>
      ipcRenderer.invoke('chat:proactiveWelcome', taskId),
    // Streaming variant — the caller mints a requestId and listens on the
    // per-request channel, so several sends can be in flight without their
    // events crossing. Returns a cleanup function to unsubscribe.
    //
    // `sources` fires the moment retrieval returns, `reply` when the prose
    // lands whole, `question` if (and only if) the model asked one, `tool`
    // once per action the model finishes writing, then exactly one of
    // `complete` / `error`. The `complete` payload is the same ChatResponse
    // `send` returns — the streamed events are the trace, this is the result
    // (it carries the question too, so missing the event loses only earliness).
    sendStream: (
      req: ChatRequest & { requestId: string },
      callbacks: {
        onMentions?: (mentions: ChatMentionResolved[]) => void
        onSources?: (trace: ChatRetrievalTrace) => void
        onReply?: (text: string) => void
        // Cumulative prose-so-far while the reply is still streaming — the
        // token-by-token feel. Never fires after onReply.
        onReplyDelta?: (text: string) => void
        // In-progress counterpart of onTool: fires when an action STARTS
        // arriving, so the UI can say what the assistant is doing right now.
        onActivity?: (activity: ChatToolTrace) => void
        onTool?: (tool: ChatToolTrace) => void
        onQuestion?: (question: ChatQuestion) => void
        onError?: (error: { ok: false; error: string; needsApiKey?: boolean }) => void
        onComplete?: (response: ChatResponse) => void
      }
    ): (() => void) => {
      const channel = `chat:stream:${req.requestId}`
      type Event =
        | { type: 'mentions'; payload: ChatMentionResolved[] }
        | { type: 'sources'; payload: ChatRetrievalTrace }
        | { type: 'reply'; payload: string }
        | { type: 'reply-delta'; payload: string }
        | { type: 'activity'; payload: ChatToolTrace }
        | { type: 'tool'; payload: ChatToolTrace }
        | { type: 'question'; payload: ChatQuestion }
        | { type: 'error'; payload: { ok: false; error: string; needsApiKey?: boolean } }
        | { type: 'complete'; payload: ChatResponse }
      // Whether a terminal event (complete | error) has already been delivered.
      // Guards the invoke-rejection backstop below from firing a second one.
      let settled = false
      const handler = (_: unknown, ev: Event): void => {
        switch (ev.type) {
          case 'mentions':
            callbacks.onMentions?.(ev.payload)
            break
          case 'sources':
            callbacks.onSources?.(ev.payload)
            break
          case 'reply':
            callbacks.onReply?.(ev.payload)
            break
          case 'reply-delta':
            callbacks.onReplyDelta?.(ev.payload)
            break
          case 'activity':
            callbacks.onActivity?.(ev.payload)
            break
          case 'tool':
            callbacks.onTool?.(ev.payload)
            break
          case 'question':
            callbacks.onQuestion?.(ev.payload)
            break
          case 'error':
            settled = true
            callbacks.onError?.(ev.payload)
            break
          case 'complete':
            settled = true
            callbacks.onComplete?.(ev.payload)
            break
        }
      }
      ipcRenderer.on(channel, handler)
      // Same fire-and-forget shape as voiceCommand.runStream: the events carry
      // the result. The one thing we watch is the invoke itself rejecting — if
      // the main handler dies before emitting anything, no terminal event is
      // coming and the caller would wait forever. Synthesise the error so a dead
      // handler surfaces as a failure, not a stuck spinner.
      void ipcRenderer.invoke('chat:sendStream', req).catch((e: unknown) => {
        if (settled) return
        settled = true
        callbacks.onError?.({
          ok: false,
          error: e instanceof Error ? e.message : 'The assistant request stopped unexpectedly.'
        })
      })
      // Braces so the cleanup arrow returns void — ipcRenderer.removeListener
      // returns the IpcRenderer instance, which a `(): void =>` concise body
      // would otherwise try (and fail) to return.
      return (): void => {
        ipcRenderer.removeListener(channel, handler)
      }
    }
  },
  // Focus-Mode clusters (split "groups") — per-desk saved split layouts.
  clusters: {
    list: (taskId: string): Promise<import('@shared/types').FocusCluster[]> =>
      ipcRenderer.invoke('clusters:list', taskId),
    save: (draft: import('@shared/types').FocusClusterDraft): Promise<import('@shared/types').FocusCluster> =>
      ipcRenderer.invoke('clusters:save', draft),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('clusters:delete', id)
  },
  resume: {
    generate: (
      taskId: string
    ): Promise<{ ok: boolean; markdown?: string; error?: string; needsApiKey?: boolean }> =>
      ipcRenderer.invoke('resume:generate', taskId)
  },
  setup: {
    suggest: (taskId: string): Promise<SetupSuggestResponse> =>
      ipcRenderer.invoke('setup:suggest', taskId),
    buildFromPrompt: (input: {
      prompt: string
      taskId: string | null
    }): Promise<AiBuildResponse> =>
      ipcRenderer.invoke('setup:buildFromPrompt', input)
  },
  livingPage: {
    regenerate: (widgetId: string): Promise<LivingPageRegenerateResponse> =>
      ipcRenderer.invoke('livingPage:regenerate', widgetId)
  },
  ai: {
    // The Daily Brief: a proactive summary built from real tasks / calendar /
    // recent docs. No input — it reads the environment.
    dailyBrief: (): Promise<{
      ok: boolean
      brief?: string
      actions?: Array<{ taskId: string; title: string; startMs: number; durationMin: number }>
      needsApiKey?: boolean
      error?: string
    }> => ipcRenderer.invoke('ai:dailyBrief'),
    // Mirror a compact {id,label} snapshot of chat conversations so the main
    // process prompt builder can offer real conversation ids to post-chat.
    setConversationSnapshot: (convs: Array<{ id: string; label: string }>): Promise<boolean> =>
      ipcRenderer.invoke('ai:setConversationSnapshot', convs),
    // Daily standup: Work-Completed (look-back) woven with the brief (look-forward)
    // into one narrative. Pass the synced-per-user cursor; persist the returned
    // toCursor. Honest degradation (falls back to a deterministic narrative, no key).
    standup: (input: {
      sinceCursor: number
      scope: 'personal' | 'team'
      organisationId?: string | null
    }): Promise<{
      ok: boolean
      narrative: string
      aiUsed: boolean
      needsApiKey?: boolean
      hasContent: boolean
      completed: Array<{ objectId: string | null; title: string | null; at: string; kind: 'node' | 'document' | null }>
      nextUp: Array<{ id: string; title: string; kind: 'node' | 'document' }>
      counts: { completed: number; created: number; updated: number; deleted: number }
      fromCursor: number
      toCursor: number
    }> => ipcRenderer.invoke('assistant:standup', input),
    // Label each desk object with a short topic so the Columns view can lay them
    // out as topical columns. Honest degradation (needsApiKey) when no AI is set.
    groupByTopic: (
      items: Array<{ id: string; title: string; text: string }>
    ): Promise<{
      ok: boolean
      topicByWidget?: Record<string, string>
      needsApiKey?: boolean
      error?: string
    }> => ipcRenderer.invoke('ai:groupByTopic', items),
    // Raw single-turn completion for the command bar's intent router. The caller
    // supplies the system prompt and receives the model's text verbatim (no
    // workspace-build envelope parsing), so the router's small intent JSON
    // arrives intact.
    routeCommand: (input: {
      system: string
      text: string
    }): Promise<{ ok: boolean; text?: string; needsApiKey?: boolean; error?: string }> =>
      ipcRenderer.invoke('ai:routeCommand', input),
    suggestPageContent: (
      prompt: string
    ): Promise<{
      ok: boolean
      tiptapJson?: string
      markdown?: string
      error?: string
      needsApiKey?: boolean
    }> => ipcRenderer.invoke('ai:suggestPageContent', prompt),
    suggestDocContent: (input: {
      prompt: string
    }): Promise<{ ok: boolean; html?: string; error?: string; needsApiKey?: boolean }> =>
      ipcRenderer.invoke('ai:suggestDocContent', input),
    rewriteSelection: (input: {
      text: string
      instruction: string
    }): Promise<{ ok: boolean; html?: string; error?: string; needsApiKey?: boolean }> =>
      ipcRenderer.invoke('ai:rewriteSelection', input),
    suggestTableRows: (
      tableId: string,
      prompt: string,
      count: number
    ): Promise<{
      ok: boolean
      rows?: Array<Record<string, unknown>>
      columnsToAdd?: Array<{
        label: string
        type: string
        options?: string[]
      }>
      error?: string
      needsApiKey?: boolean
    }> => ipcRenderer.invoke('ai:suggestTableRows', tableId, prompt, count),
    transformText: (input: {
      text: string
      instruction: string
      kind?: string
    }): Promise<{
      ok: boolean
      result?: string
      error?: string
      needsApiKey?: boolean
    }> => ipcRenderer.invoke('ai:transformText', input),
    // Local usage snapshot (aggregate counts only) the renderer reports to the
    // signal server for the admin Analytics tab.
    collectTelemetry: (): Promise<{
      appVersion: string
      platform: string
      widgetTotal: number
      widgetsByKind: Record<string, number>
      taskCount: number
      folderCount: number
      focusSessions: number
      focusMinutes: number
      aiCalls: number
      aiInputTokens: number
      aiOutputTokens: number
      aiEstCostUsd: number
      onboardingCoreCompleted: boolean
      onboardingModules: number
    }> => ipcRenderer.invoke('telemetry:collect'),
    suggestWidgetSetup: (input: {
      widgetId: string
      prompt?: string
    }): Promise<{
      ok: boolean
      kind?: string
      applyAs?:
        | 'sticky-checklist'
        | 'note-lines'
        | 'markdown-bullets'
        | 'card-bullets'
        | 'mindmap-nodes'
        | 'diagram-nodes'
        | 'page-doc'
        | 'webview-url'
      noun?: string
      items?: Array<{ id: string; text: string }>
      pageContent?: object
      url?: string
      summary?: string
      error?: string
      needsApiKey?: boolean
    }> => ipcRenderer.invoke('ai:suggestWidgetSetup', input),
    // AI source (PlexiDesk credits vs bring-your-own-key) + credit balance.
    getStatus: (): Promise<{
      mode: 'auto' | 'credits' | 'byok'
      signedIn: boolean
      hasOwnKey: boolean
      balanceUsd: number | null
      outOfCredits: boolean
      proxyAvailable: boolean
    }> => ipcRenderer.invoke('ai:getStatus'),
    setMode: (mode: 'auto' | 'credits' | 'byok'): Promise<{
      mode: 'auto' | 'credits' | 'byok'
      signedIn: boolean
      hasOwnKey: boolean
      balanceUsd: number | null
      outOfCredits: boolean
      proxyAvailable: boolean
    }> => ipcRenderer.invoke('ai:setMode', mode),
    refreshCredits: (): Promise<{
      balanceUsd: number | null
      outOfCredits: boolean
      proxyAvailable: boolean
    }> => ipcRenderer.invoke('ai:refreshCredits'),
    topUpCredits: (
      amountUsd: number
    ): Promise<{
      ok: boolean
      action?: 'redirect' | 'pending'
      url?: string
      amountUsd?: number
      error?: string
    }> => ipcRenderer.invoke('ai:topUpCredits', amountUsd)
  },
  history: {
    record: (url: string, title: string, taskId: string | null, countsAsVisit?: boolean): Promise<void> =>
      ipcRenderer.invoke('history:record', url, title, taskId, countsAsVisit),
    recent: (limit: number, taskId?: string | null): Promise<BrowsingHistoryEntry[]> =>
      ipcRenderer.invoke('history:recent', limit, taskId ?? null)
  },
  focus: {
    start: (draft: FocusSessionStartDraft): Promise<FocusSession> =>
      ipcRenderer.invoke('focus:start', draft),
    complete: (id: string, patch: FocusSessionCompletePatch): Promise<FocusSession | null> =>
      ipcRenderer.invoke('focus:complete', id, patch),
    recent: (limit: number, taskId?: string | null): Promise<FocusSession[]> =>
      ipcRenderer.invoke('focus:recent', limit, taskId ?? null)
  },
  trail: {
    record: (draft: ActivityRecordDraft): Promise<void> =>
      ipcRenderer.invoke('trail:record', draft),
    recent: (
      taskId: string | null,
      sinceMs: number,
      limit: number
    ): Promise<ActivityEvent[]> => ipcRenderer.invoke('trail:recent', taskId, sinceMs, limit),
    summarize: (taskId: string | null, sinceMs: number): Promise<TrailSummaryResponse> =>
      ipcRenderer.invoke('trail:summarize', taskId, sinceMs)
  },
  model: {
    get: (): Promise<ModelMode> => ipcRenderer.invoke('model:get'),
    set: (mode: ModelMode): Promise<void> => ipcRenderer.invoke('model:set', mode)
  },
  bodyDouble: {
    tick: (taskId: string | null, recentMessages: string[]): Promise<BodyDoubleResponse> =>
      ipcRenderer.invoke('bodyDouble:tick', taskId, recentMessages)
  },
  smartStack: {
    propose: (taskId: string): Promise<SmartStackResponse> =>
      ipcRenderer.invoke('smartStack:propose', taskId)
  },
  // Crash telemetry (WS03): forward a render-side error, and read the recent crash
  // log back. Technical data only, never document content.
  crash: {
    report: (input: {
      kind: string
      message: string
      stack?: string | null
      componentStack?: string | null
      context?: string | null
    }): Promise<unknown> => ipcRenderer.invoke('crash:report', input),
    list: (
      limit?: number
    ): Promise<
      Array<{
        id: string
        ts: number
        source: string
        kind: string
        message: string
        stack: string | null
        componentStack: string | null
        appVersion: string
        context: string | null
      }>
    > => ipcRenderer.invoke('crash:list', limit),
    // Forwarding to the signal server: read not-yet-sent crashes, then mark the
    // ones the server accepted.
    unforwarded: (
      limit?: number
    ): Promise<
      Array<{
        id: string
        ts: number
        source: string
        kind: string
        message: string
        stack: string | null
        componentStack: string | null
        appVersion: string
        context: string | null
      }>
    > => ipcRenderer.invoke('crash:unforwarded', limit),
    markForwarded: (ids: string[]): Promise<void> => ipcRenderer.invoke('crash:markForwarded', ids)
  },
  // WS01 sync substrate: the renderer's CRDT engine persists every widget event to
  // the local change log (offline queue + record) and reads back what it hasn't
  // synced. The wire shape is object-type-agnostic (field + dataClass pick the
  // merge). Gated by the fb.sync.crdt.widgets flag; a no-op path when off.
  crdt: {
    record: (input: {
      id: string
      partitionKey: string
      ts: string
      objectType: string
      objectId: string
      field: string
      dataClass: string
      actor: string
      payload: unknown
      synced?: boolean
      seq?: number | null
    }): Promise<void> => ipcRenderer.invoke('crdt:record', input),
    unsynced: (
      limit?: number
    ): Promise<
      Array<{
        id: string
        partitionKey: string
        seq: number | null
        ts: string
        objectType: string
        objectId: string
        field: string
        dataClass: string
        actor: string
        payload: unknown
        synced: boolean
      }>
    > => ipcRenderer.invoke('crdt:unsynced', limit),
    markSynced: (entries: Array<{ id: string; seq?: number | null }>): Promise<void> =>
      ipcRenderer.invoke('crdt:markSynced', entries),
    knownIds: (ids: string[]): Promise<string[]> => ipcRenderer.invoke('crdt:knownIds', ids),
    eventsForObject: (
      objectId: string
    ): Promise<
      Array<{
        id: string
        partitionKey: string
        seq: number | null
        ts: string
        objectType: string
        objectId: string
        field: string
        dataClass: string
        actor: string
        payload: unknown
        synced: boolean
      }>
    > => ipcRenderer.invoke('crdt:eventsForObject', objectId)
  },
  connectedApps: {
    list: (): Promise<ConnectedApp[]> => ipcRenderer.invoke('connectedApps:list'),
    create: (draft: ConnectedAppDraft): Promise<ConnectedApp> =>
      ipcRenderer.invoke('connectedApps:create', draft),
    update: (id: string, patch: ConnectedAppPatch): Promise<ConnectedApp | null> =>
      ipcRenderer.invoke('connectedApps:update', id, patch),
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('connectedApps:delete', id),
    reorder: (ids: string[]): Promise<void> =>
      ipcRenderer.invoke('connectedApps:reorder', ids),
    touch: (id: string): Promise<ConnectedApp | null> =>
      ipcRenderer.invoke('connectedApps:touch', id),
    findByHostname: (hostname: string): Promise<ConnectedApp | null> =>
      ipcRenderer.invoke('connectedApps:findByHostname', hostname)
  },
  webview: {
    // Fired when a <webview> inside a connected app or canvas widget tries to
    // open a target=_blank link. The renderer turns these into canvas widgets
    // so users keep clicked links inside FocusBuddy.
    onLinkClicked: (
      cb: (payload: { sourceWebContentsId: number; url: string }) => void
    ): (() => void) => {
      const handler = (
        _: unknown,
        payload: { sourceWebContentsId: number; url: string }
      ): void => cb(payload)
      ipcRenderer.on('webview:link-clicked', handler)
      return () => ipcRenderer.removeListener('webview:link-clicked', handler)
    }
  },
  localApp: {
    // Opens the macOS file picker filtered to .app bundles; returns null if
    // the user cancels.
    pick: (): Promise<{
      title: string
      appPath: string
      bundleId: string | null
      iconPngBase64: string | null
    } | null> => ipcRenderer.invoke('localApp:pick'),
    describe: (
      appPath: string
    ): Promise<{
      title: string
      appPath: string
      bundleId: string | null
      iconPngBase64: string | null
    } | null> => ipcRenderer.invoke('localApp:describe', appPath),
    launch: (input: {
      appPath: string | null
      bundleId: string | null
      title?: string
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('localApp:launch', input),
    isRunning: (input: {
      appPath: string | null
      title: string
    }): Promise<boolean> => ipcRenderer.invoke('localApp:isRunning', input),
    refreshIcon: (appPath: string): Promise<string | null> =>
      ipcRenderer.invoke('localApp:refreshIcon', appPath)
  },
  dashboard: {
    getLayout: (key: string): Promise<DashboardLayout | null> =>
      ipcRenderer.invoke('dashboard:getLayout', key),
    setLayout: (
      key: string,
      input: DashboardCardKind[] | DashboardLayoutInput
    ): Promise<DashboardLayout> =>
      ipcRenderer.invoke('dashboard:setLayout', key, input),
    resetLayout: (key: string): Promise<boolean> =>
      ipcRenderer.invoke('dashboard:resetLayout', key)
  },
  onboarding: {
    // Persist onboarding progress locally so it rides the next telemetry
    // snapshot up to the admin as a per-user completion record.
    record: (summary: { coreCompleted: boolean; modulesCompleted: number }): Promise<void> =>
      ipcRenderer.invoke('onboarding:record', summary)
  },
  session: {
    // The active organisation is the tenancy boundary for the local workspace.
    getActiveOrg: (): Promise<string> => ipcRenderer.invoke('session:getActiveOrg'),
    setActiveOrg: (orgId: string): Promise<string> =>
      ipcRenderer.invoke('session:setActiveOrg', orgId)
  },
  haptics: {
    available: (): Promise<boolean> => ipcRenderer.invoke('haptics:available'),
    fire: (feel: HapticFeel): Promise<boolean> => ipcRenderer.invoke('haptics:fire', feel)
  },
  calendar: {
    // Save a meeting to the OS default calendar (Apple Calendar / Outlook) via .ics.
    addMeetingIcs: (ev: {
      roomId: string
      title: string
      startMs: number
      durationMin: number
    }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('calendar:addMeetingIcs', ev)
  },
  energy: {
    log: (level: EnergyLevel): Promise<EnergyLogEntry> =>
      ipcRenderer.invoke('energy:log', level),
    current: (): Promise<EnergyLogEntry | null> =>
      ipcRenderer.invoke('energy:current'),
    recent: (hours: number): Promise<EnergyLogEntry[]> =>
      ipcRenderer.invoke('energy:recent', hours)
  },
  timeBlocks: {
    list: (fromMs: number, toMs: number): Promise<TimeBlock[]> =>
      ipcRenderer.invoke('timeblocks:list', fromMs, toMs),
    create: (draft: TimeBlockDraft): Promise<TimeBlock> =>
      ipcRenderer.invoke('timeblocks:create', draft),
    update: (id: string, patch: TimeBlockPatch): Promise<TimeBlock | null> =>
      ipcRenderer.invoke('timeblocks:update', id, patch),
    // scope 'series' removes this occurrence and everything after it in the
    // repeating series; 'one' (default) removes just this occurrence.
    delete: (id: string, scope?: 'one' | 'series'): Promise<boolean> =>
      ipcRenderer.invoke('timeblocks:delete', id, scope)
  },
  vault: {
    meta: (): Promise<VaultMeta> => ipcRenderer.invoke('vault:meta'),
    isUnlocked: (): Promise<boolean> => ipcRenderer.invoke('vault:isUnlocked'),
    create: (masterPassword: string): Promise<VaultResult> =>
      ipcRenderer.invoke('vault:create', masterPassword),
    unlock: (masterPassword: string): Promise<VaultResult> =>
      ipcRenderer.invoke('vault:unlock', masterPassword),
    lock: (): Promise<void> => ipcRenderer.invoke('vault:lock'),
    listEntries: (): Promise<VaultEntryStored[]> =>
      ipcRenderer.invoke('vault:listEntries'),
    createEntry: (draft: VaultEntryDraft): Promise<VaultEntryStored | null> =>
      ipcRenderer.invoke('vault:createEntry', draft),
    updateEntry: (
      id: string,
      patch: VaultEntryPatch
    ): Promise<VaultEntryStored | null> =>
      ipcRenderer.invoke('vault:updateEntry', id, patch),
    deleteEntry: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('vault:deleteEntry', id),
    changeMasterPassword: (
      currentPassword: string,
      newPassword: string
    ): Promise<VaultResult> =>
      ipcRenderer.invoke('vault:changeMasterPassword', currentPassword, newPassword),
    encrypt: (
      plaintext: string
    ): Promise<{ iv: string; ciphertext: string } | null> =>
      ipcRenderer.invoke('vault:encrypt', plaintext),
    decrypt: (iv: string, ciphertext: string): Promise<string | null> =>
      ipcRenderer.invoke('vault:decrypt', iv, ciphertext)
  },
  backup: {
    info: (): Promise<{ dir: string; count: number; lastBackupMs: number | null }> =>
      ipcRenderer.invoke('backup:info'),
    export: (): Promise<
      { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
    > => ipcRenderer.invoke('backup:export'),
    restore: (): Promise<
      { ok: true; safetyBackupPath: string } | { ok: false; canceled?: boolean; error?: string }
    > => ipcRenderer.invoke('backup:restore'),
    revealFolder: (): Promise<{ ok: true }> => ipcRenderer.invoke('backup:revealFolder')
  },
  templates: {
    list: (): Promise<Template[]> => ipcRenderer.invoke('templates:list'),
    createFromTask: (
      taskId: string,
      name: string,
      description?: string,
      widgetIds?: string[]
    ): Promise<Template> =>
      ipcRenderer.invoke(
        'templates:createFromTask',
        taskId,
        name,
        description,
        widgetIds
      ),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('templates:delete', id)
  },
  contextMenu: {
    onAction: (cb: (payload: ContextMenuPayload) => void): (() => void) => {
      const handler = (_: unknown, payload: ContextMenuPayload): void => cb(payload)
      ipcRenderer.on('context-menu:action', handler)
      return () => ipcRenderer.removeListener('context-menu:action', handler)
    },
    // Fired when a NON-editable right-click happens inside a browser widget. The
    // renderer opens the unified Haptyx menu for the classified target.
    onWebviewContextMenu: (
      cb: (payload: {
        webContentsId: number
        x: number
        y: number
        selectionText?: string
        linkURL?: string
        srcURL?: string
        mediaType?: string
      }) => void
    ): (() => void) => {
      const handler = (_: unknown, payload: Parameters<typeof cb>[0]): void => cb(payload)
      ipcRenderer.on('webview:context-menu', handler)
      return () => ipcRenderer.removeListener('webview:context-menu', handler)
    }
  },
  // Cross-window IPC bus used by the body-double BridgeMatcher. Two
  // FocusBuddy windows on the same machine share this channel — main
  // process broadcasts everything one renderer sends to every other.
  bodyDoubleBus: {
    send: (payload: unknown): void => {
      ipcRenderer.send('fb:body-double-bus', payload)
    },
    onMessage: (cb: (payload: unknown) => void): (() => void) => {
      const handler = (_: unknown, payload: unknown): void => cb(payload)
      ipcRenderer.on('fb:body-double-bus', handler)
      return () => ipcRenderer.removeListener('fb:body-double-bus', handler)
    }
  },
  files: {
    // Ingest from a path on disk (Electron drag-drop gives us .path on File).
    ingestPath: (sourcePath: string): Promise<FbFile> =>
      ipcRenderer.invoke('files:ingestPath', sourcePath),
    // Ingest from raw bytes (HTML5 drag-drop without a path, or paste).
    ingestBuffer: (input: {
      buffer: ArrayBuffer
      originalName: string
      mimeType: string
      parentId?: string | null
    }): Promise<FbFile> => ipcRenderer.invoke('files:ingestBuffer', input),
    get: (id: string): Promise<FbFile | null> => ipcRenderer.invoke('files:get', id),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('files:delete', id),
    // Extract readable text from a file (PDF/Word/spreadsheet/text); null if binary.
    extractText: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('files:extractText', id),
    // Read raw bytes back — used for previews that can't reference a file://
    // URL directly (e.g. images with content-security-policy restrictions).
    read: (
      id: string
    ): Promise<{ mimeType: string; buffer: ArrayBuffer } | null> =>
      ipcRenderer.invoke('files:read', id),
    // Open the native file picker + ingest the chosen file in one round-trip.
    // Returns null when the user cancels.
    pickAndIngest: (opts?: {
      title?: string
      defaultPath?: string
    }): Promise<FbFile | null> => ipcRenderer.invoke('files:pickAndIngest', opts),
    // Generate (or read from cache) a QuickLook-backed PNG thumbnail for any
    // ingested file. Works for images, PDFs, Office docs, Keynote, etc. —
    // anything Finder's preview can render.
    thumbnail: (
      id: string,
      opts?: { size?: number }
    ): Promise<{
      base64: string
      mimeType: 'image/png'
      width: number
      height: number
    } | null> => ipcRenderer.invoke('files:thumbnail', id, opts),
    // Open a local file in the user's default app (Preview/Word/VS Code/etc.)
    open: (id: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('files:open', id),
    // Open a remote URL in the user's default browser. http:/https: only.
    openExternal: (
      url: string
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('files:openExternal', url),
    // Auto-filing: ask the AI which tags an item should carry. Suggest-only.
    suggestTags: (
      fileId: string
    ): Promise<{
      ok: boolean
      tags?: Array<{ name: string; isNew: boolean; reason: string }>
      needsApiKey?: boolean
      error?: string
    }> => ipcRenderer.invoke('files:suggestTags', fileId)
  },
  // Ask-your-workspace: a grounded, cited answer drawn from your own documents.
  workspace: {
    ask: (
      question: string,
      history?: Array<{ question: string; answer: string }>
    ): Promise<{
      ok: boolean
      answer?: string
      citedDocIds?: string[]
      sources?: Array<{ docId: string; title: string; docType: string; snippet: string; cited: boolean }>
      proposals?: ActionProposal[]
      needsApiKey?: boolean
      error?: string
    }> => ipcRenderer.invoke('workspace:ask', question, history),
    // Streaming ask: deltas arrive via onDelta as the answer is written; the
    // promise resolves with the final answer + cited sources.
    askStream: (
      question: string,
      history: Array<{ question: string; answer: string }> | undefined,
      requestId: string,
      onDelta: (text: string) => void,
      docContext?: { title?: string; text?: string } | null
    ): Promise<{
      ok: boolean
      answer?: string
      sources?: Array<{ docId: string; title: string; docType: string; snippet: string; cited: boolean }>
      proposals?: ActionProposal[]
      needsApiKey?: boolean
      error?: string
    }> => {
      const channel = `workspace:askStream:${requestId}`
      const handler = (_: unknown, ev: { type: string; payload: string }): void => {
        if (ev?.type === 'delta') onDelta(ev.payload)
      }
      ipcRenderer.on(channel, handler)
      return ipcRenderer
        .invoke('workspace:askStream', question, history, requestId, docContext)
        .finally(() => ipcRenderer.removeListener(channel, handler))
    },
    related: (
      docId: string
    ): Promise<Array<{ docId: string; title: string; docType: string; snippet: string }>> =>
      ipcRenderer.invoke('workspace:related', docId)
  },
  // The file/folder manager: a foldered library over fb_files (folders,
  // imported files, and references to internal documents).
  fileManager: {
    list: (parentId: string | null): Promise<FileEntry[]> =>
      ipcRenderer.invoke('fileManager:list', parentId),
    get: (id: string): Promise<FileEntry | null> => ipcRenderer.invoke('fileManager:get', id),
    path: (id: string | null): Promise<Array<{ id: string; name: string }>> =>
      ipcRenderer.invoke('fileManager:path', id),
    createFolder: (parentId: string | null, name: string, explicitId?: string): Promise<FileEntry> =>
      ipcRenderer.invoke('fileManager:createFolder', parentId, name, explicitId),
    rename: (id: string, name: string): Promise<FileEntry | null> =>
      ipcRenderer.invoke('fileManager:rename', id, name),
    move: (id: string, newParentId: string | null): Promise<boolean> =>
      ipcRenderer.invoke('fileManager:move', id, newParentId),
    moveToOrg: (id: string, orgId: string, teamId?: string | null): Promise<string[]> =>
      ipcRenderer.invoke('fileManager:moveToOrg', id, orgId, teamId ?? null),
    importFolder: (
      parentId: string | null
    ): Promise<{ ok: boolean; canceled?: boolean; files?: number; folders?: number; skipped?: number; rootId?: string | null }> =>
      ipcRenderer.invoke('fileManager:importFolder', parentId),
    // Soft-delete: returns the ids trashed (entry + subtree) so the caller can undo.
    delete: (id: string): Promise<string[]> => ipcRenderer.invoke('fileManager:delete', id),
    restore: (ids: string[]): Promise<boolean> => ipcRenderer.invoke('fileManager:restore', ids),
    listTrashed: (): Promise<FileEntry[]> => ipcRenderer.invoke('fileManager:listTrashed'),
    restoreDeep: (id: string): Promise<boolean> => ipcRenderer.invoke('fileManager:restoreDeep', id),
    purge: (id: string): Promise<boolean> => ipcRenderer.invoke('fileManager:purge', id),
    search: (query: string): Promise<FileEntry[]> => ipcRenderer.invoke('fileManager:search', query),
    tagsFor: (fileId: string): Promise<Array<{ tag: string; source: 'user' | 'ai' }>> =>
      ipcRenderer.invoke('fileManager:tagsFor', fileId),
    addTags: (
      fileId: string,
      tags: string[],
      source?: 'user' | 'ai'
    ): Promise<Array<{ tag: string; source: 'user' | 'ai' }>> =>
      ipcRenderer.invoke('fileManager:addTags', fileId, tags, source),
    removeTag: (fileId: string, tag: string): Promise<boolean> =>
      ipcRenderer.invoke('fileManager:removeTag', fileId, tag),
    allTags: (): Promise<Array<{ tag: string; count: number }>> => ipcRenderer.invoke('fileManager:allTags'),
    entriesByTag: (tag: string): Promise<FileEntry[]> => ipcRenderer.invoke('fileManager:entriesByTag', tag),
    entriesByTags: (tags: string[]): Promise<FileEntry[]> => ipcRenderer.invoke('fileManager:entriesByTags', tags),
    untaggedEntries: (): Promise<FileEntry[]> => ipcRenderer.invoke('fileManager:untaggedEntries'),
    listSmartFolders: (): Promise<Array<{ id: string; name: string; tags: string[]; search: string }>> =>
      ipcRenderer.invoke('fileManager:listSmartFolders'),
    createSmartFolder: (
      name: string,
      tags: string[],
      search?: string
    ): Promise<{ id: string; name: string; tags: string[]; search: string }> =>
      ipcRenderer.invoke('fileManager:createSmartFolder', name, tags, search),
    deleteSmartFolder: (id: string): Promise<boolean> => ipcRenderer.invoke('fileManager:deleteSmartFolder', id),
    smartFolderEntries: (tags: string[], search?: string): Promise<FileEntry[]> =>
      ipcRenderer.invoke('fileManager:smartFolderEntries', tags, search),
    fileDocument: (docId: string, parentId: string | null): Promise<FileEntry | null> =>
      ipcRenderer.invoke('fileManager:fileDocument', docId, parentId),
    unfiledDocuments: (): Promise<Array<{ id: string; title: string; docType: string }>> =>
      ipcRenderer.invoke('fileManager:unfiledDocuments'),
    locateDocument: (
      docId: string
    ): Promise<{ entryId: string; parentId: string | null; path: Array<{ id: string; name: string }> } | null> =>
      ipcRenderer.invoke('fileManager:locateDocument', docId),
    pickFiles: (parentId: string | null): Promise<FbFile[]> =>
      ipcRenderer.invoke('fileManager:pickFiles', parentId),
    reveal: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('fileManager:reveal', id)
  },
  // Document export — write a self-contained, styled HTML string out as a
  // standalone .html file or a printed PDF, each through the native save dialog.
  // Used by the markdown widget's Export buttons.
  exportDoc: {
    html: (input: {
      html: string
      suggestedName: string
    }): Promise<{ ok: true; path: string } | { ok: false }> =>
      ipcRenderer.invoke('export:html', input),
    pdf: (input: {
      html: string
      suggestedName: string
    }): Promise<{ ok: true; path: string } | { ok: false }> =>
      ipcRenderer.invoke('export:pdf', input)
  },
  // Voice / video note AI pipeline. Three independent stages — record
  // → transcribe, transcript → processed text, transcript → action
  // proposals. Each returns a tagged-union result; renderer branches on
  // `ok` to either show the success payload or a "set your key" /
  // "network error" affordance.
  voiceNote: {
    // Transcription IPC. Cloud provider needs `buffer` + `mimeType`;
    // local provider needs pre-decoded `samples` (Float32Array, 16kHz
    // mono PCM) + `sampleRate`. The renderer should branch on
    // getProvider() and only decode for the local path — decoding for
    // cloud would be wasted work (Whisper API accepts webm/opus
    // directly and the raw bytes are 5-10x smaller over IPC).
    transcribe: (input: {
      buffer?: ArrayBuffer
      mimeType?: string
      samples?: Float32Array
      sampleRate?: number
    }): Promise<
      | {
          ok: true
          transcript: string
          durationSec: number | null
          language: string | null
        }
      | { ok: false; error: string; reason?: 'no_key' | 'network' | 'api' | 'unknown' | 'model_load' | 'decode' }
    > => ipcRenderer.invoke('ai:transcribeAudio', input),
    process: (input: {
      transcript: string
      mode: 'full' | 'cleaned' | 'summary' | 'diarised'
    }): Promise<
      | { ok: true; mode: 'full' | 'cleaned' | 'summary' | 'diarised'; text: string }
      | { ok: false; error: string; reason?: 'no_key' | 'api' | 'unknown' }
    > => ipcRenderer.invoke('ai:processTranscript', input),
    extractActions: (input: { transcript: string }): Promise<
      | { ok: true; proposals: ActionProposal[] }
      | { ok: false; error: string; reason?: 'no_key' | 'api' | 'parse' }
    > => ipcRenderer.invoke('ai:extractActionsFromTranscript', input),
    // End-of-meeting wrap-up: one call returns a grounded summary plus the
    // deliverables (tasks, todos, tables, knowledge, documents) the conversation
    // produced, as applyable ActionProposals.
    processMeetingEnd: (input: {
      transcript: string
      meetingTitle?: string
      durationSec?: number | null
    }): Promise<
      | { ok: true; summary?: string; proposals?: ActionProposal[] }
      | { ok: false; error: string; needsApiKey?: boolean; reason?: 'no_key' | 'api' | 'parse' }
    > => ipcRenderer.invoke('ai:processMeetingEnd', input),
    // Provider preference — 'cloud' = OpenAI Whisper API,
    // 'local' = on-device ONNX Whisper tiny (downloads ~80MB on first
    // selection). Calling setProvider('local') preloads the model so
    // the first recording isn't blocked on the download.
    getProvider: (): Promise<'cloud' | 'local'> =>
      ipcRenderer.invoke('voice:getProvider'),
    setProvider: (
      p: 'cloud' | 'local'
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('voice:setProvider', p)
  },
  // Voice command — floating mic interpreter. Takes a transcript plus a
  // pruned canvas snapshot and returns ActionProposal[] for the user to
  // review. Same Apply/Dismiss UX as the existing AI assistants.
  // Agentic browsing (A6/B1) — the deterministic action bridge. The runtime
  // (and the fake-site probe) drives a webview's webContents through one
  // sanitised door; stopRun is the kill switch.
  agentBrowser: {
    createRun: (
      wcId: number
    ): Promise<{ id: string; wcId: number; aborted: boolean; steps: number; downloadsCancelled: number }> =>
      ipcRenderer.invoke('agentBrowser:createRun', wcId),
    stopRun: (runId: string): Promise<boolean> => ipcRenderer.invoke('agentBrowser:stopRun', runId),
    endRun: (runId: string): Promise<void> => ipcRenderer.invoke('agentBrowser:endRun', runId),
    perform: (
      runId: string,
      action: Record<string, unknown> & { kind: string }
    ): Promise<{
      ok: boolean
      refused?: string
      detail?: string
      pageUrl?: string
      text?: string
      elements?: Array<Record<string, unknown>>
      captchaPresent?: boolean
      image?: { base64Png: string; width: number; height: number }
    }> => ipcRenderer.invoke('agentBrowser:perform', runId, action)
  },
  // The agentic-browsing loop (A6/B2): start a supervised run, answer its
  // consent pauses, stop it, watch its events, review the standing grants.
  browserAgent: {
    start: (input: { wcId: number; task: string; startUrl?: string }): Promise<{ runId: string }> =>
      ipcRenderer.invoke('browserAgent:start', input),
    stop: (runId: string): Promise<boolean> => ipcRenderer.invoke('browserAgent:stop', runId),
    consent: (runId: string, granted: boolean, remember: boolean): Promise<boolean> =>
      ipcRenderer.invoke('browserAgent:consent', runId, granted, remember),
    onEvent: (cb: (ev: Record<string, unknown> & { kind: string; runId: string }) => void): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        ev: Record<string, unknown> & { kind: string; runId: string }
      ): void => cb(ev)
      ipcRenderer.on('browserAgent:event', handler)
      return () => ipcRenderer.removeListener('browserAgent:event', handler)
    },
    listConsent: (): Promise<Array<{ host: string; grantedAt: string }>> =>
      ipcRenderer.invoke('browserConsent:list'),
    revokeConsent: (host: string): Promise<void> => ipcRenderer.invoke('browserConsent:revoke', host)
  },
  // Voice prefs only — the voiceCommand proposals engine retired with
  // A6/B0's R30 ruling (harvested into the browser-agent sanitiser).
  voiceCommand: {
    getPrefs: (): Promise<{
      commandMode: 'press-hold' | 'click-toggle'
      autoStopSilenceMs: number
      voiceback: boolean
    }> => ipcRenderer.invoke('voiceCommand:getPrefs'),
    setPrefs: (
      patch: Partial<{
        commandMode: 'press-hold' | 'click-toggle'
        autoStopSilenceMs: number
        voiceback: boolean
      }>
    ): Promise<{
      commandMode: 'press-hold' | 'click-toggle'
      autoStopSilenceMs: number
      voiceback: boolean
    }> => ipcRenderer.invoke('voiceCommand:setPrefs', patch)
  },
  // Phase 2A — agent creation wizard. Writes a brand-new agent .md
  // file to .claude/agents/ with a Claude-generated body following
  // the kit's conventions. Phase 2C — single-turn agent invocation
  // returning ActionProposal[] for review-and-apply.
  agents: {
    // Desk agents (canvas widget): run a placed agent's standing instruction
    // over the widgets wired into it. Distinct from the Agent OS create/invoke
    // flow below.
    run: (
      agentId: string,
      taskId: string,
      instruction: string,
      liveInputs?: Record<string, string>,
      persona?: string,
      browserWcId?: number
    ): Promise<{
      ok: boolean
      output?: string
      proposals?: ActionProposal[]
      needsApiKey?: boolean
      error?: string
    }> =>
      ipcRenderer.invoke('agents:run', agentId, taskId, instruction, liveInputs, persona, browserWcId),
    designProfile: (
      description: string
    ): Promise<{
      ok: boolean
      name?: string
      blurb?: string
      systemPrompt?: string
      needsApiKey?: boolean
      error?: string
    }> => ipcRenderer.invoke('agents:designProfile', description),
    previewInput: (widgetId: string): Promise<{ kind?: string; content: string }> =>
      ipcRenderer.invoke('agents:previewInput', widgetId),
    create: (input: {
      slug: string
      description: string
      model: 'haiku' | 'sonnet' | 'opus'
      tools: Array<
        'Read' | 'Write' | 'Edit' | 'Bash' | 'Glob' | 'Grep' | 'WebFetch' | 'WebSearch' | 'Agent'
      >
      purpose: string
      contextPath?: string[]
    }): Promise<
      | { ok: true; slug: string; path: string }
      | {
          ok: false
          error: string
          reason?: 'no_key' | 'api' | 'fs' | 'exists' | 'no_workspace'
        }
    > => ipcRenderer.invoke('agents:create', input),
    invoke: (input: {
      agentPath: string
      rootPath: string[]
      nodeLabel: string
      nodeKind: string
      userMessage: string
      // Phase 2 polish — multi-turn conversation. Pass prior history
      // for follow-up turns; omit for the initial invocation. Hard
      // cap of 5 round-trips enforced server-side; the response's
      // conversationCapped flag signals when the renderer should
      // disable further replies.
      conversationHistory?: Array<{ role: 'user' | 'agent'; content: string }>
      conversationKey?: string
      nodeId?: string | null
    }): Promise<
      | {
          ok: true
          agentName: string
          reply: string
          proposals: ActionProposal[]
          invocationId: string
          conversationTurn: number
          conversationCapped: boolean
        }
      | {
          ok: false
          error: string
          reason?: 'no_key' | 'agent_not_found' | 'agent_unreadable' | 'api' | 'parse'
        }
    > => ipcRenderer.invoke('agents:invoke', input),
    // Outcome bookkeeping — applied / dismissed / undone. Drives the
    // per-agent stats and "undo last apply" affordances.
    recordOutcome: (input: {
      invocationId: string
      agentSlug: string
      proposalId: string
      proposalKind: string
      action: 'applied' | 'dismissed' | 'undone'
      createdEntityRef?: string | null
    }): Promise<{ ok: true }> =>
      ipcRenderer.invoke('agents:recordOutcome', input),
    listInvocationsForNode: (
      nodeId: string
    ): Promise<
      Array<{
        id: string
        agentSlug: string
        agentName: string
        nodeId: string | null
        nodeLabel: string
        rootPath: string[]
        reply: string
        proposals: ActionProposal[]
        conversationTurn: number
        conversationKey: string
        invokedAt: number
      }>
    > => ipcRenderer.invoke('agents:listInvocationsForNode', nodeId),
    statsForSlug: (
      slug: string
    ): Promise<{
      slug: string
      invocations: number
      totalProposals: number
      applied: number
      dismissed: number
      undone: number
      applyRate: number
    }> => ipcRenderer.invoke('agents:statsForSlug', slug),
    undoLast: (): Promise<{
      ok: boolean
      message: string
      entityRef?: string | null
    }> => ipcRenderer.invoke('agents:undoLast'),
    // Workspace path override — when set, the resolver pushes this
    // path to the front of its probe list. Used by Settings to let
    // users point Haptyx at their workspace if auto-detect missed it.
    getWorkspaceOverride: (): Promise<string | null> =>
      ipcRenderer.invoke('agents:getWorkspaceOverride'),
    setWorkspaceOverride: (
      path: string
    ): Promise<{ ok: true }> =>
      ipcRenderer.invoke('agents:setWorkspaceOverride', path),
    // Reveal a path in Finder. Wraps shell.showItemInFolder so the
    // renderer can offer "show me where Haptyx is reading agents from"
    // affordances without needing the Electron API directly.
    revealInFinder: (
      path: string
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('agents:revealInFinder', path)
  },
  metrics: {
    get: (): Promise<
      Array<{ pid: number; type: string; name: string; cpu: number; memMB: number }>
    > => ipcRenderer.invoke('metrics:get'),
    webContents: (): Promise<
      Array<{ webContentsId: number; osPid: number; type: string; title: string; url: string }>
    > => ipcRenderer.invoke('metrics:webContents')
  },
  // Mind-mapper AI pipeline. Three thin wrappers over Claude:
  //   expand → child branches for a node
  //   listAgents → static enumeration of .claude/agents/*.md
  //   suggestAgents → Claude-ranked top picks for a node
  mindmap: {
    expand: (input: {
      rootPath: string[]
      nodeLabel: string
      nodeKind?: 'idea' | 'task' | 'question' | 'tool' | 'agent'
      guidance?: string
    }): Promise<
      | {
          ok: true
          children: Array<{
            id: string
            label: string
            kind: 'idea' | 'task' | 'question' | 'tool' | 'agent'
            rationale?: string
          }>
        }
      | { ok: false; error: string; reason?: 'no_key' | 'api' | 'parse' }
    > => ipcRenderer.invoke('mindmap:expand', input),
    listAgents: (): Promise<{
      source:
        | 'override'
        | 'workspace'
        | 'userData-existing'
        | 'userData-new'
        | 'none'
      agentsDir: string | null
      workspaceRoot: string | null
      agents: Array<{ slug: string; path: string; name: string; description: string }>
    }> => ipcRenderer.invoke('mindmap:listAgents'),
    suggestAgents: (input: {
      rootPath: string[]
      nodeLabel: string
      nodeKind?: 'idea' | 'task' | 'question' | 'tool' | 'agent'
      candidates: Array<{ slug: string; path: string; name: string; description: string }>
    }): Promise<
      | {
          ok: true
          suggestions: Array<{ slug: string; name: string; rationale: string }>
        }
      | { ok: false; error: string; reason?: 'no_key' | 'api' | 'parse' | 'no_agents' }
    > => ipcRenderer.invoke('mindmap:suggestAgents', input)
  },
  tables: {
    list: (): Promise<FbTable[]> => ipcRenderer.invoke('tables:list'),
    get: (id: string): Promise<FbTable | null> => ipcRenderer.invoke('tables:get', id),
    create: (draft: FbTableDraft): Promise<FbTable> =>
      ipcRenderer.invoke('tables:create', draft),
    update: (id: string, patch: FbTablePatch): Promise<FbTable | null> =>
      ipcRenderer.invoke('tables:update', id, patch),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('tables:delete', id),
    listRows: (tableId: string): Promise<FbRow[]> =>
      ipcRenderer.invoke('tables:listRows', tableId),
    // Fires whenever ANY writer (flows, forms, the local REST API, templates,
    // or this window) changes a table's rows, so cached views can refetch.
    onRowsChanged: (cb: (tableId: string) => void): (() => void) => {
      const listener = (_e: unknown, tableId: string): void => cb(tableId)
      ipcRenderer.on('tables:rowsChanged', listener)
      return () => ipcRenderer.removeListener('tables:rowsChanged', listener)
    },
    createRow: (draft: FbRowDraft): Promise<FbRow> =>
      ipcRenderer.invoke('tables:createRow', draft),
    updateRow: (id: string, patch: FbRowPatch): Promise<FbRow | null> =>
      ipcRenderer.invoke('tables:updateRow', id, patch),
    deleteRow: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('tables:deleteRow', id),
    restoreRow: (id: string): Promise<FbRow | null> =>
      ipcRenderer.invoke('tables:restoreRow', id),
    reorderRows: (tableId: string, ids: string[]): Promise<void> =>
      ipcRenderer.invoke('tables:reorderRows', tableId, ids)
  },
  // PlexiBrain — the company knowledge base.
  knowledge: {
    list: (): Promise<KnowledgeEntry[]> => ipcRenderer.invoke('knowledge:list'),
    get: (id: string): Promise<KnowledgeEntry | null> => ipcRenderer.invoke('knowledge:get', id),
    search: (query: string): Promise<KnowledgeEntry[]> =>
      ipcRenderer.invoke('knowledge:search', query),
    create: (draft: KnowledgeDraft): Promise<KnowledgeEntry> =>
      ipcRenderer.invoke('knowledge:create', draft),
    update: (id: string, patch: KnowledgePatch): Promise<KnowledgeEntry | null> =>
      ipcRenderer.invoke('knowledge:update', id, patch),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('knowledge:delete', id),
    // Backfill embeddings for unindexed entries; returns how many + why-not.
    reindex: (): Promise<{ embedded: number; reason?: string }> =>
      ipcRenderer.invoke('knowledge:reindex'),
    // True once entries are embedded (an embedding key is set and indexed).
    semanticActive: (): Promise<boolean> => ipcRenderer.invoke('knowledge:semanticActive')
  },
  // PlexiMeet — meetings with transcript, summary and action items.
  meetings: {
    list: (): Promise<Meeting[]> => ipcRenderer.invoke('meetings:list'),
    get: (id: string): Promise<Meeting | null> => ipcRenderer.invoke('meetings:get', id),
    create: (draft: MeetingDraft): Promise<Meeting> => ipcRenderer.invoke('meetings:create', draft),
    update: (id: string, patch: MeetingPatch): Promise<Meeting | null> =>
      ipcRenderer.invoke('meetings:update', id, patch),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('meetings:delete', id)
  },
  // PlexiBuild — no-code apps.
  apps: {
    list: (): Promise<PlexiApp[]> => ipcRenderer.invoke('apps:list'),
    get: (id: string): Promise<PlexiApp | null> => ipcRenderer.invoke('apps:get', id),
    create: (draft: PlexiAppDraft): Promise<PlexiApp> => ipcRenderer.invoke('apps:create', draft),
    update: (id: string, patch: PlexiAppPatch): Promise<PlexiApp | null> =>
      ipcRenderer.invoke('apps:update', id, patch),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('apps:delete', id)
  },
  // PlexiForms — forms backed by a table.
  forms: {
    list: (): Promise<PlexiForm[]> => ipcRenderer.invoke('forms:list'),
    get: (id: string): Promise<PlexiForm | null> => ipcRenderer.invoke('forms:get', id),
    create: (draft: PlexiFormDraft): Promise<PlexiForm> => ipcRenderer.invoke('forms:create', draft),
    update: (id: string, patch: PlexiFormPatch): Promise<PlexiForm | null> =>
      ipcRenderer.invoke('forms:update', id, patch),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('forms:delete', id)
  },
  // PlexiSign — send a document for signature, collect approvals in order.
  sign: {
    list: (): Promise<PlexiSignRequest[]> => ipcRenderer.invoke('sign:list'),
    get: (id: string): Promise<PlexiSignRequest | null> => ipcRenderer.invoke('sign:get', id),
    create: (draft: PlexiSignDraft): Promise<PlexiSignRequest> => ipcRenderer.invoke('sign:create', draft),
    update: (id: string, patch: PlexiSignPatch): Promise<PlexiSignRequest | null> =>
      ipcRenderer.invoke('sign:update', id, patch),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('sign:delete', id),
    send: (id: string): Promise<PlexiSignRequest | null> => ipcRenderer.invoke('sign:send', id),
    sign: (id: string, action: SignAction): Promise<PlexiSignRequest | null> =>
      ipcRenderer.invoke('sign:sign', id, action),
    decline: (id: string, signerId: string, reason: string): Promise<PlexiSignRequest | null> =>
      ipcRenderer.invoke('sign:decline', id, signerId, reason),
    void: (id: string): Promise<PlexiSignRequest | null> => ipcRenderer.invoke('sign:void', id)
  },
  // Settings — API-key vault. Replaces the old "edit .env and restart"
  // flow. Plaintext only travels renderer→main on save; reads return
  // `{ hasKey, last4 }` so the UI can render a confirmation badge
  // without ever holding the secret in renderer memory.
  settings: {
    encryptionAvailable: (): Promise<boolean> =>
      ipcRenderer.invoke('settings:encryptionAvailable'),
    hintAnthropic: (): Promise<{ hasKey: boolean; last4: string | null }> =>
      ipcRenderer.invoke('settings:hintAnthropic'),
    saveAnthropicKey: (
      plaintext: string
    ): Promise<{ ok: boolean; hasKey?: boolean; last4?: string | null; error?: string }> =>
      ipcRenderer.invoke('settings:saveAnthropicKey', plaintext),
    clearAnthropicKey: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('settings:clearAnthropicKey'),
    testAnthropicKey: (): Promise<{ ok: boolean; model?: string; error?: string }> =>
      ipcRenderer.invoke('settings:testAnthropicKey'),
    // OpenAI key — used by the audio transcription pipeline (Whisper API).
    // Mirror the Anthropic surface 1:1 so the ApiKeysSection UI can render
    // both with one shared row component.
    hintOpenAI: (): Promise<{ hasKey: boolean; last4: string | null }> =>
      ipcRenderer.invoke('settings:hintOpenAI'),
    saveOpenAIKey: (
      plaintext: string
    ): Promise<{ ok: boolean; hasKey?: boolean; last4?: string | null; error?: string }> =>
      ipcRenderer.invoke('settings:saveOpenAIKey', plaintext),
    clearOpenAIKey: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('settings:clearOpenAIKey'),
    testOpenAIKey: (): Promise<{ ok: boolean; model?: string; error?: string }> =>
      ipcRenderer.invoke('settings:testOpenAIKey'),
    // Tenor key — used by GIF search. Same hint/save/clear surface as the others.
    hintTenor: (): Promise<{ hasKey: boolean; last4: string | null }> =>
      ipcRenderer.invoke('settings:hintTenor'),
    saveTenorKey: (
      plaintext: string
    ): Promise<{ ok: boolean; hasKey?: boolean; last4?: string | null; error?: string }> =>
      ipcRenderer.invoke('settings:saveTenorKey', plaintext),
    clearTenorKey: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('settings:clearTenorKey'),
    // PlexiDesign provider keys: Pexels (stock photos), remove.bg (cutouts).
    hintPexels: (): Promise<{ hasKey: boolean; last4: string | null }> => ipcRenderer.invoke('settings:hintPexels'),
    savePexelsKey: (plaintext: string): Promise<{ ok: boolean; hasKey?: boolean; last4?: string | null; error?: string }> =>
      ipcRenderer.invoke('settings:savePexelsKey', plaintext),
    clearPexelsKey: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('settings:clearPexelsKey'),
    hintRemoveBg: (): Promise<{ hasKey: boolean; last4: string | null }> => ipcRenderer.invoke('settings:hintRemoveBg'),
    saveRemoveBgKey: (plaintext: string): Promise<{ ok: boolean; hasKey?: boolean; last4?: string | null; error?: string }> =>
      ipcRenderer.invoke('settings:saveRemoveBgKey', plaintext),
    clearRemoveBgKey: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('settings:clearRemoveBgKey')
  },
  // GIF search (Tenor) — runs in main so the key stays out of the renderer.
  gif: {
    search: (
      query: string
    ): Promise<
      | { ok: true; results: Array<{ id: string; previewUrl: string; url: string; width: number; height: number; description: string }> }
      | { ok: false; needsKey: true }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('gif:search', query)
  },
  // Multi-device workspace sync — the renderer drives the network, main owns the
  // local DB. These expose the local half (collect changes, apply pulls, cursor).
  // The workItems:* namespace (Attention S3, §4). Work items NEVER travel
  // nodes:* — this is their one seam; the store wraps it.
  workItems: {
    list: (): Promise<FbNode[]> => ipcRenderer.invoke('workItems:list'),
    get: (id: string): Promise<FbNode | null> => ipcRenderer.invoke('workItems:get', id),
    create: (draft: {
      title: string
      notes?: string
      parentId?: string | null
      intentClass?: string
      dueAt?: string | null
      wiUrgency?: string | null
      sourceRef?: string | null
      sourceType?: string | null
      confidence?: number | null
      approvalState?: string
      wiOrigin?: 'human' | 'ai' | 'system'
    }): Promise<FbNode> => ipcRenderer.invoke('workItems:create', draft),
    updateFields: (id: string, patch: Record<string, unknown>): Promise<FbNode | null> =>
      ipcRenderer.invoke('workItems:updateFields', id, patch),
    setState: (id: string, state: string): Promise<boolean> =>
      ipcRenderer.invoke('workItems:setState', id, state),
    reclassify: (id: string, intentClass: string): Promise<FbNode | null> =>
      ipcRenderer.invoke('workItems:reclassify', id, intentClass),
    snooze: (id: string, until: number | null): Promise<void> =>
      ipcRenderer.invoke('workItems:snooze', id, until),
    markRead: (id: string): Promise<void> => ipcRenderer.invoke('workItems:markRead', id),
    clearDetached: (id: string): Promise<void> => ipcRenderer.invoke('workItems:clearDetached', id),
    counts: (): Promise<Record<string, number>> => ipcRenderer.invoke('workItems:counts'),
    badgeCounts: (): Promise<{ headline: number; byIntent: Record<string, number> }> =>
      ipcRenderer.invoke('workItems:badgeCounts'),
    setEnabled: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('workItems:setEnabled', enabled),
    // P1 migrated-peer confirmation: per-org gate + attestation record.
    orgEnabled: (orgId: string): Promise<boolean> => ipcRenderer.invoke('workItems:orgEnabled', orgId),
    orgAttestation: (orgId: string): Promise<{ attestedAt: number; note: string } | null> =>
      ipcRenderer.invoke('workItems:orgAttestation', orgId),
    attestOrgMigrated: (orgId: string, note: string): Promise<void> =>
      ipcRenderer.invoke('workItems:attestOrgMigrated', orgId, note),
    revokeOrgAttestation: (orgId: string): Promise<void> =>
      ipcRenderer.invoke('workItems:revokeOrgAttestation', orgId),
    classify: (
      text: string
    ): Promise<{
      intentClass: string
      confidence: number
      title: string
      dueAt: string | null
      clarify: { kind: 'deadline'; phrase: string } | null
      via: 'rules' | 'model' | 'fallback'
      secondaries: Array<{
        text: string
        intentClass: string
        trigger: string
        title: string
        dueAt: string | null
      }>
    }> => ipcRenderer.invoke('workItems:classify', text),
    // DEC-026: the opt-in tidy — null unless the capture is messy enough AND
    // the model produced a faithful title+gist. Approve-before-apply.
    proposeCleanup: (text: string): Promise<{ title: string; note: string } | null> =>
      ipcRenderer.invoke('workItems:proposeCleanup', text),
    enabled: (): Promise<boolean> => ipcRenderer.invoke('workItems:enabled'),
    precision: (): Promise<number | null> => ipcRenderer.invoke('workItems:precision'),
    // Internal (S2): the arrival router's seam.
    kindOf: (id: string): Promise<string | null> => ipcRenderer.invoke('workItems:kindOf', id),
    applySyncEvent: (
      ev:
        | { type: 'create'; snapshot: Record<string, unknown> }
        | { type: 'attr'; id: string; attr: string; value: unknown }
        | { type: 'trash'; id: string; trashed: boolean }
    ): Promise<string> => ipcRenderer.invoke('workItems:applySyncEvent', ev)
  },
  // The notification substrate (Attention S4): every notifier posts through
  // this one door — the renderer's live banners as records-of-record, and
  // anything scheduled for the main sweep to deliver.
  notifications: {
    post: (input: {
      ref?: string | null
      queue: string
      title: string
      body?: string
      deliverAt?: number
      dedupeKey?: string | null
      category?: 'security' | 'decision-risk' | 'attention' | 'activity' | 'digest'
      layer?: 'ambient' | 'inbox' | 'interruptive'
      trigger: string
      origin?: 'human' | 'ai' | 'system'
      critical?: boolean
      alreadyDelivered?: boolean
    }): Promise<{ posted: boolean; id: string | null }> =>
      ipcRenderer.invoke('notifications:post', input)
  },
  workspaceSync: {
    // F010 — after a 409 conflict-apply, floor the local sync_rev to the
    // server's so baseRev advances even when the apply no-opped.
    advanceBaseRev: (
      itemType: 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file',
      id: string,
      rev: number
    ): Promise<void> => ipcRenderer.invoke('workspace:advanceBaseRev', itemType, id, rev),
    pending: (): Promise<{
      upserts: Array<{ id: string; itemType: 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file'; body: Record<string, unknown>; baseRev: number }>
      deletes: Array<{ id: string; itemType: 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file'; baseRev: number }>
    }> => ipcRenderer.invoke('workspace:pending'),
    markPushed: (itemType: 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file', id: string, rev: number): Promise<void> =>
      ipcRenderer.invoke('workspace:markPushed', itemType, id, rev),
    applyRemote: (
      items: Array<{ id: string; itemType: 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file'; body: Record<string, unknown> | null; rev: number; deleted: boolean }>
    ): Promise<{ applied: number }> => ipcRenderer.invoke('workspace:applyRemote', items),
    getCursor: (): Promise<number> => ipcRenderer.invoke('workspace:getCursor'),
    setCursor: (n: number): Promise<void> => ipcRenderer.invoke('workspace:setCursor', n),
    // Org-shared variants (cross-member sync). The active org id selects the scope
    // and its own cursor; markPushed is shared (it keys by id only).
    pendingOrg: (
      orgId: string
    ): Promise<{
      upserts: Array<{ id: string; itemType: 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file'; body: Record<string, unknown>; baseRev: number; teamId?: string | null }>
      deletes: Array<{ id: string; itemType: 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file'; baseRev: number }>
    }> => ipcRenderer.invoke('workspace:pendingOrg', orgId),
    applyRemoteOrg: (
      items: Array<{ id: string; itemType: 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file'; body: Record<string, unknown> | null; rev: number; deleted: boolean; teamId?: string | null }>,
      orgId: string
    ): Promise<{ applied: number }> => ipcRenderer.invoke('workspace:applyRemoteOrg', items, orgId),
    getCursorOrg: (orgId: string): Promise<number> => ipcRenderer.invoke('workspace:getCursorOrg', orgId),
    setCursorOrg: (orgId: string, n: number): Promise<void> =>
      ipcRenderer.invoke('workspace:setCursorOrg', orgId, n),
    // Per-desk shared sync (desks shared with named individuals). One cursor across
    // all such desks; each pending item carries the desk root id it belongs to.
    pendingShared: (): Promise<{
      upserts: Array<{ id: string; itemType: 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file'; body: Record<string, unknown>; baseRev: number; rootId?: string | null }>
      deletes: Array<{ id: string; itemType: 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file'; baseRev: number; rootId?: string | null }>
    }> => ipcRenderer.invoke('workspace:pendingShared'),
    applyRemoteShared: (
      items: Array<{ id: string; itemType: 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file'; body: Record<string, unknown> | null; rev: number; deleted: boolean; rootId?: string | null }>,
      ownerHandles?: Record<string, string>
    ): Promise<{ applied: number }> => ipcRenderer.invoke('workspace:applyRemoteShared', items, ownerHandles),
    getCursorShared: (): Promise<number> => ipcRenderer.invoke('workspace:getCursorShared'),
    setCursorShared: (n: number): Promise<void> => ipcRenderer.invoke('workspace:setCursorShared', n),
    // Stamp a desk subtree for shared sync (owner side, at share time) / prune a
    // desk this account no longer has access to (recipient side, after a revoke).
    stampSharedDesk: (rootId: string): Promise<string[]> => ipcRenderer.invoke('workspace:stampSharedDesk', rootId),
    adoptSharedDesk: (rootId: string): Promise<boolean> => ipcRenderer.invoke('workspace:adoptSharedDesk', rootId),
    pruneSharedDesk: (rootId: string): Promise<number> => ipcRenderer.invoke('workspace:pruneSharedDesk', rootId),
    localSharedRoots: (): Promise<string[]> => ipcRenderer.invoke('workspace:localSharedRoots'),
    // Cross-member Drive file bytes. Metadata rides the loops above; these move the
    // bytes: read a local file to upload, check whether a pulled file's bytes are
    // already here, and write downloaded bytes to disk.
    fileBytesForPush: (
      id: string
    ): Promise<{ ext: string; mimeType: string; bytes: Uint8Array } | null> =>
      ipcRenderer.invoke('workspace:fileBytesForPush', id),
    hasLocalFileBytes: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('workspace:hasLocalFileBytes', id),
    writeSyncedFileBytes: (id: string, bytes: Uint8Array): Promise<boolean> =>
      ipcRenderer.invoke('workspace:writeSyncedFileBytes', id, bytes)
  },
  // Mail (IMAP) — the user's own mailbox, connected straight from the desktop.
  // The password never crosses this boundary on read; the renderer only ever
  // sees host/port/user and the message list/body it asks for.
  mail: {
    // Fired by the main process when a fetch discovers unseen messages that
    // have not been announced this run. One event per fetch, batched.
    onNewMail: (cb: (info: { title: string; body: string; uid: number }) => void): (() => void) => {
      const listener = (_e: unknown, info: { title: string; body: string; uid: number }): void => cb(info)
      ipcRenderer.on('mail:newMail', listener)
      return () => ipcRenderer.removeListener('mail:newMail', listener)
    },
    // Move a message to the account's archive mailbox.
    archive: (uid: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('mail:archive', uid),
    getAccount: (): Promise<MailAccountPublic> => ipcRenderer.invoke('mail:getAccount'),
    saveAccount: (
      config: MailAccountInput
    ): Promise<
      { ok: true; account: MailAccountPublic } | { ok: false; error: string }
    > => ipcRenderer.invoke('mail:saveAccount', config),
    testAccount: (
      config: MailAccountInput
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('mail:testAccount', config),
    clearAccount: (): Promise<{ ok: true }> => ipcRenderer.invoke('mail:clearAccount'),
    list: (
      limit?: number
    ): Promise<{ ok: true; items: MailListItem[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke('mail:list', limit),
    get: (
      uid: number
    ): Promise<{ ok: true; message: MailFullMessage } | { ok: false; error: string }> =>
      ipcRenderer.invoke('mail:get', uid),
    markSeen: (uid: number): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('mail:markSeen', uid),
    send: (input: MailSendInput): Promise<MailSendResult> =>
      ipcRenderer.invoke('mail:send', input),
    suggestReply: (incoming: {
      subject: string
      from: string
      body: string
    }): Promise<EmailReplyDraftResult> => ipcRenderer.invoke('mail:suggestReply', incoming)
  },
  // Office documents — standalone doc / sheet / slides files, created with AI
  // and edited full-screen. CRUD plus the AI "create" generator.
  search: {
    // Global "find anything" across the local workspace.
    query: (q: string): Promise<SearchHit[]> => ipcRenderer.invoke('search:query', q)
  },
  documents: {
    list: (): Promise<DocumentMeta[]> => ipcRenderer.invoke('documents:list'),
    get: (id: string): Promise<FbDocument | null> => ipcRenderer.invoke('documents:get', id),
    create: (draft: DocumentDraft): Promise<FbDocument> =>
      ipcRenderer.invoke('documents:create', draft),
    update: (id: string, patch: DocumentPatch, snapshotLabel?: string): Promise<FbDocument | null> =>
      ipcRenderer.invoke('documents:update', id, patch, snapshotLabel),
    // Soft-delete into the Documents Trash (restorable); purge is the only
    // permanent removal, from the Trash view's "Delete forever".
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('documents:delete', id),
    listTrashed: (): Promise<DocumentMeta[]> => ipcRenderer.invoke('documents:listTrashed'),
    // Comments on local documents (live docs use the signal server instead).
    listComments: (docId: string): Promise<DocCommentDto[]> => ipcRenderer.invoke('docComments:list', docId),
    addComment: (input: {
      docId: string
      body: string
      author: string
      anchorId?: string | null
      parentId?: string | null
    }): Promise<DocCommentDto> => ipcRenderer.invoke('docComments:add', input),
    resolveComment: (id: string, resolved: boolean): Promise<boolean> =>
      ipcRenderer.invoke('docComments:resolve', id, resolved),
    listSnapshots: (docId: string): Promise<DocSnapshotMeta[]> =>
      ipcRenderer.invoke('documents:listSnapshots', docId),
    restoreSnapshot: (snapshotId: string): Promise<FbDocument | null> =>
      ipcRenderer.invoke('documents:restoreSnapshot', snapshotId),
    restore: (id: string): Promise<boolean> => ipcRenderer.invoke('documents:restore', id),
    purge: (id: string): Promise<boolean> => ipcRenderer.invoke('documents:purge', id),
    // Insert-or-replace by explicit id (used by cloud-document sync to land a
    // server document under its own id).
    upsert: (input: {
      id: string
      docType: DocType
      title: string
      body: unknown
      archived?: boolean
      updatedAt?: number
    }): Promise<FbDocument> => ipcRenderer.invoke('documents:upsert', input),
    generate: (input: {
      docType: DocType
      prompt: string
      audience?: string
    }): Promise<{
      ok: boolean
      title?: string
      body?: unknown
      error?: string
      needsApiKey?: boolean
    }> => ipcRenderer.invoke('documents:generate', input),
    generateSlides: (input: {
      mode: 'deck' | 'append' | 'redesign'
      prompt: string
    }): Promise<{
      ok: boolean
      body?: import('@shared/types').SlidesBody
      error?: string
      needsApiKey?: boolean
    }> => ipcRenderer.invoke('documents:generateSlides', input),
    // Backfill embeddings so grounding ranks documents by meaning. Best-effort:
    // with no embedding key it is a silent no-op and grounding stays keyword-based.
    reindex: (): Promise<{ embedded: number; reason?: string }> =>
      ipcRenderer.invoke('documents:reindex'),
    semanticActive: (): Promise<boolean> => ipcRenderer.invoke('documents:semanticActive'),
    // Local-model (Ollama) enrichment: distil every document into metadata that
    // feeds the AI's retrieval + grounding. Honest when no local model is present.
    enrich: (docId: string): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke('documents:enrich', docId),
    enrichAll: (
      force?: boolean
    ): Promise<{ enriched: number; skipped: number; failed: number; reason?: string }> =>
      ipcRenderer.invoke('documents:enrichAll', force),
    metadata: (
      docId: string
    ): Promise<{
      docId: string
      summary: string
      category: string
      entities: string[]
      dates: string[]
      keywords: string[]
      language: string
      wordCount: number
      model: string
      enrichedAt: number
    } | null> => ipcRenderer.invoke('documents:metadata', docId)
  },
  localAi: {
    status: (): Promise<{
      available: boolean
      baseUrl: string
      chatModel: string | null
      embedModel: string | null
    }> => ipcRenderer.invoke('ai:localModelStatus')
  },
  agent: {
    // One round of the autonomous agent loop, driven by lib/agentRunner. The
    // renderer applies the returned actions, builds observations, and calls again.
    step: (input: {
      goal: string
      taskId: string | null
      systemPrompt?: string
      messages: Array<{ role: 'user' | 'assistant'; content: string }>
      priorFailedCount?: number
      context?: string
    }): Promise<import('@shared/types').AgentStepResult> => ipcRenderer.invoke('agent:step', input),
    // Self-verification once a run claims done: {met, score, gaps}. The driver
    // re-enters the loop with the gaps when the goal isn't fully met.
    verify: (input: {
      goal: string
      applied: string
    }): Promise<{ met: boolean; score: number; gaps: string[] }> => ipcRenderer.invoke('agent:verify', input)
  },
  // Self-building memory: what the assistant durably knows about the user + their
  // work. list / remember (manual) / forget, plus a local-model backfill.
  memory: {
    list: (): Promise<import('@shared/types').MemoryItem[]> => ipcRenderer.invoke('memory:list'),
    remember: (input: {
      kind: import('@shared/types').MemoryKind
      text: string
      subject?: string
      due?: string
    }): Promise<import('@shared/types').MemoryItem | null> => ipcRenderer.invoke('memory:remember', input),
    forget: (id: string): Promise<boolean> => ipcRenderer.invoke('memory:forget', id),
    extractDocuments: (): Promise<{ scanned: number; added: number; reason?: string }> =>
      ipcRenderer.invoke('memory:extractDocuments')
  },
  // People the app has fetched, published to the main process so an @-mention
  // can resolve one. Coverage is honestly partial: whatever the renderer has
  // actually loaded, never a promise of the whole directory.
  people: {
    setDirectory: (
      people: Array<{
        accountId: string
        handle: string
        firstName: string | null
        lastName: string | null
        role: string
      }>
    ): Promise<void> => ipcRenderer.invoke('people:setDirectory', people)
  },
  // Persisted AI-assistant chat history (local, free-standing conversations) —
  // backs the assistant's one conversation system.
  aiChat: {
    listConversations: (): Promise<import('@shared/types').AiChatConversationMeta[]> =>
      ipcRenderer.invoke('aiChat:listConversations'),
    getConversation: (id: string): Promise<import('@shared/types').AiChatConversation | null> =>
      ipcRenderer.invoke('aiChat:getConversation', id),
    createConversation: (input: {
      taskId: string | null
      title?: string
      context?: import('@shared/types').AiChatConversationContext | null
      mode?: import('@shared/types').AiChatMode
      webSearch?: boolean
    }): Promise<import('@shared/types').AiChatConversationMeta> =>
      ipcRenderer.invoke('aiChat:createConversation', input),
    // Plexii P6: switch a conversation between normal chat and guided discovery.
    setConversationMode: (
      id: string,
      mode: import('@shared/types').AiChatMode
    ): Promise<void> => ipcRenderer.invoke('aiChat:setConversationMode', id, mode),
    // A4 (R21): flip the conversation's web-search globe.
    setConversationWebSearch: (id: string, on: boolean): Promise<void> =>
      ipcRenderer.invoke('aiChat:setConversationWebSearch', id, on),
    appendMessage: (
      conversationId: string,
      message: {
        role: 'user' | 'assistant' | 'system'
        content: string
        ts: number
        proposals?: import('@shared/types').ActionProposal[]
        applied?: Record<string, import('@shared/types').AppliedProposal>
        sources?: import('@shared/types').ChatSource[]
        question?: import('@shared/types').ChatQuestion | null
        trace?: import('@shared/types').StoredTrace | null
        mentions?: import('@shared/types').ChatMentionRef[]
        blocks?: import('@shared/types').ChatUiBlock[]
      }
    ): Promise<import('@shared/types').AiChatStoredMessage> =>
      ipcRenderer.invoke('aiChat:appendMessage', conversationId, message),
    setMessageApplied: (
      conversationId: string,
      messageId: string,
      applied: Record<string, import('@shared/types').AppliedProposal>
    ): Promise<void> =>
      ipcRenderer.invoke('aiChat:setMessageApplied', conversationId, messageId, applied),
    renameConversation: (id: string, title: string): Promise<void> =>
      ipcRenderer.invoke('aiChat:renameConversation', id, title),
    deleteConversation: (id: string): Promise<void> =>
      ipcRenderer.invoke('aiChat:deleteConversation', id),
    // Plexii P5: link a desk the conversation produced/adopted. Element 0 of
    // the returned list is the primary. makePrimary moves it to the front.
    linkDesk: (
      conversationId: string,
      taskId: string,
      makePrimary?: boolean
    ): Promise<string[] | null> =>
      ipcRenderer.invoke('aiChat:linkDesk', conversationId, taskId, makePrimary)
  },
  // PlexiProjects: roll tasks up into a scheduled plan with a critical path.
  projects: {
    list: (): Promise<import('@shared/projects').ProjectSummary[]> => ipcRenderer.invoke('projects:list'),
    plan: (projectId: string): Promise<import('@shared/projects').ProjectPlan> =>
      ipcRenderer.invoke('projects:plan', projectId),
    setTaskPlan: (
      taskId: string,
      patch: import('@shared/projects').PlanTaskPatch
    ): Promise<boolean> => ipcRenderer.invoke('projects:setTaskPlan', taskId, patch),
    addDep: (
      predId: string,
      succId: string,
      type?: import('@shared/projects').DepType,
      lag?: number
    ): Promise<import('@shared/projects').AddDepResult> =>
      ipcRenderer.invoke('projects:addDep', predId, succId, type ?? 'FS', lag ?? 0),
    setDep: (
      predId: string,
      succId: string,
      type: import('@shared/projects').DepType,
      lag: number
    ): Promise<boolean> => ipcRenderer.invoke('projects:setDep', predId, succId, type, lag),
    removeDep: (predId: string, succId: string): Promise<boolean> =>
      ipcRenderer.invoke('projects:removeDep', predId, succId),
    reschedule: (projectId: string): Promise<import('@shared/projects').ProjectPlan> =>
      ipcRenderer.invoke('projects:reschedule', projectId),
    captureBaseline: (projectId: string, name: string): Promise<{ id: string; name: string; createdAt: number }> =>
      ipcRenderer.invoke('projects:captureBaseline', projectId, name),
    listBaselines: (projectId: string): Promise<Array<{ id: string; name: string; createdAt: number }>> =>
      ipcRenderer.invoke('projects:listBaselines', projectId),
    getCalendar: (projectId: string): Promise<import('@shared/workingCalendar').WorkingCalendar> =>
      ipcRenderer.invoke('projects:getCalendar', projectId),
    setCalendar: (projectId: string, cal: import('@shared/workingCalendar').WorkingCalendar): Promise<boolean> =>
      ipcRenderer.invoke('projects:setCalendar', projectId, cal),
    level: (projectId: string): Promise<import('@shared/projects').ProjectPlan> =>
      ipcRenderer.invoke('projects:level', projectId),
    exportXml: (projectId: string): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> =>
      ipcRenderer.invoke('projects:exportXml', projectId)
  },
  // PlexiReports: scheduled, AI-narrated reports over your tables.
  reports: {
    list: (): Promise<import('@shared/reports').ReportDef[]> => ipcRenderer.invoke('reports:list'),
    get: (id: string): Promise<import('@shared/reports').ReportDef | null> =>
      ipcRenderer.invoke('reports:get', id),
    create: (draft: import('@shared/reports').ReportDraft): Promise<import('@shared/reports').ReportDef> =>
      ipcRenderer.invoke('reports:create', draft),
    update: (
      id: string,
      patch: import('@shared/reports').ReportPatch
    ): Promise<import('@shared/reports').ReportDef | null> => ipcRenderer.invoke('reports:update', id, patch),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('reports:delete', id),
    generate: (id: string): Promise<import('@shared/reports').GenerateReportResult> =>
      ipcRenderer.invoke('reports:generate', id),
    runDue: (): Promise<{ generated: number; failed: number }> => ipcRenderer.invoke('reports:runDue')
  },
  // PlexiFlow: trigger-and-action automations across the workspace.
  flows: {
    list: (): Promise<import('@shared/flows').FlowDef[]> => ipcRenderer.invoke('flows:list'),
    get: (id: string): Promise<import('@shared/flows').FlowDef | null> => ipcRenderer.invoke('flows:get', id),
    create: (draft: import('@shared/flows').FlowDraft): Promise<import('@shared/flows').FlowDef> =>
      ipcRenderer.invoke('flows:create', draft),
    update: (
      id: string,
      patch: import('@shared/flows').FlowPatch
    ): Promise<import('@shared/flows').FlowDef | null> => ipcRenderer.invoke('flows:update', id, patch),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('flows:delete', id),
    run: (id: string): Promise<import('@shared/flows').FlowRunResult> => ipcRenderer.invoke('flows:run', id),
    runDue: (): Promise<{ ran: number }> => ipcRenderer.invoke('flows:runDue')
  },
  // PlexiAPI: the local REST server and its scoped tokens.
  apiAccess: {
    status: (): Promise<import('@shared/apiAccess').ApiServerConfig> => ipcRenderer.invoke('api:status'),
    setEnabled: (
      enabled: boolean
    ): Promise<import('@shared/apiAccess').ApiServerConfig & { error?: string }> =>
      ipcRenderer.invoke('api:setEnabled', enabled),
    setPort: (
      port: number
    ): Promise<import('@shared/apiAccess').ApiServerConfig & { error?: string }> =>
      ipcRenderer.invoke('api:setPort', port),
    listTokens: (): Promise<import('@shared/apiAccess').ApiTokenPublic[]> =>
      ipcRenderer.invoke('api:listTokens'),
    createToken: (
      name: string,
      scopes: import('@shared/apiAccess').ApiScope[]
    ): Promise<import('@shared/apiAccess').CreateTokenResult> =>
      ipcRenderer.invoke('api:createToken', name, scopes),
    revokeToken: (id: string): Promise<boolean> => ipcRenderer.invoke('api:revokeToken', id)
  },
  // PlexiMarketplace: built-in starter templates applied with one click.
  marketplace: {
    apply: (key: string): Promise<import('@shared/templates').ApplyTemplateResult> =>
      ipcRenderer.invoke('marketplace:apply', key)
  },
  // haptyx:// deep-link auth handoff. The brochure at haptyx.app/account/*
  // signs the user in against the signal server, then redirects to
  // haptyx://auth?token=...&email=...&handle=... — main process catches
  // that URL and forwards it here. The renderer either gets the token
  // immediately via `onIncomingToken`, or drains the pending one via
  // `getPending` on mount (cold-start case).
  auth: {
    getPending: (): Promise<{
      sessionToken: string
      email: string | null
      handle: string | null
      origin: 'open-url' | 'argv' | 'second-instance'
    } | null> => ipcRenderer.invoke('auth:get-pending'),
    onIncomingToken: (
      cb: (handoff: {
        sessionToken: string
        email: string | null
        handle: string | null
        origin: 'open-url' | 'argv' | 'second-instance'
      }) => void
    ): (() => void) => {
      const handler = (_: unknown, handoff: {
        sessionToken: string
        email: string | null
        handle: string | null
        origin: 'open-url' | 'argv' | 'second-instance'
      }): void => cb(handoff)
      ipcRenderer.on('auth:incoming-token', handler)
      return () => ipcRenderer.removeListener('auth:incoming-token', handler)
    }
  },
  // Share deep links (haptyx://share?token=...) from the "Open in PlexiDesk"
  // notification email. Same drain-pending + subscribe pattern as auth.
  share: {
    getPending: (): Promise<string | null> => ipcRenderer.invoke('share:get-pending'),
    onIncomingToken: (cb: (token: string) => void): (() => void) => {
      const handler = (_: unknown, token: string): void => cb(token)
      ipcRenderer.on('share:incoming-token', handler)
      return () => ipcRenderer.removeListener('share:incoming-token', handler)
    }
  },
  // Meeting-join deep link (haptyx://meet?room=...) from an invite email —
  // same drain-on-mount + live-event pattern as share.
  meet: {
    getPending: (): Promise<string | null> => ipcRenderer.invoke('meet:get-pending'),
    onIncomingRoom: (cb: (roomId: string) => void): (() => void) => {
      const handler = (_: unknown, roomId: string): void => cb(roomId)
      ipcRenderer.on('meet:incoming-room', handler)
      return () => ipcRenderer.removeListener('meet:incoming-room', handler)
    }
  },
  // External markdown editing (ws-v-3): ops-console artifacts open in
  // PlexiDocs and save straight back to disk. Same drain + live pattern.
  mdext: {
    read: (path: string): Promise<{ ok: boolean; content?: string; error?: string }> =>
      ipcRenderer.invoke('mdext:read', path),
    write: (path: string, content: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('mdext:write', path, content),
    getPending: (): Promise<string | null> => ipcRenderer.invoke('mdext:get-pending'),
    onIncomingPath: (cb: (path: string) => void): (() => void) => {
      const handler = (_: unknown, path: string): void => cb(path)
      ipcRenderer.on('mdext:incoming-path', handler)
      return () => ipcRenderer.removeListener('mdext:incoming-path', handler)
    }
  },
  // File import — opens a native picker scoped to importable extensions,
  // then converts the contents into a widget draft (text / table /
  // page-from-json). The renderer creates the actual widget through the
  // widget store so import shares the same persistence + drop semantics
  // as a manually-created widget.
  fileImport: {
    pick: (): Promise<string | null> => ipcRenderer.invoke('fileImport:pick'),
    // Table import wizard: pick a tabular file, then read it into a grid.
    pickGrid: (): Promise<string | null> => ipcRenderer.invoke('fileImport:pickGrid'),
    parseGrid: (
      path: string
    ): Promise<
      | { ok: true; grid: { headers: string[]; rows: Array<Record<string, string>> } }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('fileImport:parseGrid', path),
    run: (args: {
      path: string
      preferredTextKind?: 'page' | 'markdown' | 'note'
    }): Promise<
      | {
          kind: 'text'
          targetKind: 'page' | 'markdown' | 'note'
          title: string
          content: string
          sourcePath: string
        }
      | {
          kind: 'table'
          title: string
          schema: import('@shared/fields').TableSchema
          rows: Array<Record<string, string>>
          sourcePath: string
        }
      | {
          kind: 'page-from-json'
          title: string
          content: string
          sourcePath: string
        }
      | {
          ok: false
          error: string
          reason: 'cancelled' | 'unsupported' | 'parse' | 'read' | 'docx_not_supported'
        }
    > => ipcRenderer.invoke('fileImport:run', args)
  },
  // Office interop for the document editor: import .docx, export .docx / PDF,
  // and pick an image to embed.
  office: {
    importDocx: (): Promise<{ ok: boolean; html?: string; fileName?: string; page?: PageSetupInput; error?: string }> =>
      ipcRenderer.invoke('office:importDocx'),
    exportDocx: (input: {
      html: string
      title: string
      page?: PageSetupInput
    }): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('office:exportDocx', input),
    exportPdf: (input: {
      html: string
      title: string
      page?: PageSetupInput
    }): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke('office:exportPdf', input),
    pickImage: (): Promise<{ ok: boolean; dataUrl?: string; error?: string }> =>
      ipcRenderer.invoke('office:pickImage')
  },
  // PlexiDesign: AI image generation (OpenAI gpt-image-1) and AI design copy
  // (Anthropic). Both return honest needsKey/needsApiKey states when unconfigured.
  design: {
    generateImage: (input: {
      prompt: string
      width?: number
      height?: number
    }): Promise<{ ok: boolean; dataUrl?: string; error?: string; needsKey?: boolean }> =>
      ipcRenderer.invoke('design:generateImage', input),
    generateContent: (input: {
      prompt: string
      designKind: string
      audience?: string
    }): Promise<{
      ok: boolean
      content?: { eyebrow?: string; headline?: string; subhead?: string; body?: string; cta?: string; background?: 'brand' | 'light' | 'dark' }
      error?: string
      needsApiKey?: boolean
    }> => ipcRenderer.invoke('design:generateContent', input),
    generateVariations: (input: {
      prompt: string
      designKind: string
      count?: number
      audience?: string
    }): Promise<{
      ok: boolean
      concepts?: Array<{
        eyebrow?: string
        headline?: string
        subhead?: string
        body?: string
        cta?: string
        background?: 'brand' | 'light' | 'dark'
        layout?: 'left' | 'centered' | 'band' | 'bold' | 'split' | 'minimal'
      }>
      error?: string
      needsApiKey?: boolean
    }> => ipcRenderer.invoke('design:generateVariations', input),
    export: (input: {
      design: import('@shared/design').DesignBody
      title: string
      format: 'png' | 'pdf'
      printMarks?: boolean
    }): Promise<{ ok: boolean; path?: string; error?: string }> => ipcRenderer.invoke('design:export', input),
    searchPhotos: (input: {
      query: string
      perPage?: number
    }): Promise<{
      ok: boolean
      photos?: Array<{ id: string; thumb: string; full: string; alt: string; photographer: string }>
      error?: string
      needsKey?: boolean
    }> => ipcRenderer.invoke('design:searchPhotos', input),
    fetchImage: (input: { url: string }): Promise<{ ok: boolean; dataUrl?: string; error?: string }> =>
      ipcRenderer.invoke('design:fetchImage', input),
    removeBackground: (input: { dataUrl: string }): Promise<{ ok: boolean; dataUrl?: string; error?: string; needsKey?: boolean }> =>
      ipcRenderer.invoke('design:removeBackground', input)
  },
  // PlexiDraw export — one diagram out to .svg / .png / .jpg / .pdf.
  map: {
    export: (input: {
      map: import('@shared/types').MapBody
      title: string
      format: 'svg' | 'png' | 'jpg' | 'pdf'
    }): Promise<{ ok: boolean; path?: string; error?: string }> => ipcRenderer.invoke('map:export', input),
    // Import a Visio .vsdx file (opens a picker) into a MapBody.
    import: (): Promise<{
      ok: boolean
      title?: string
      body?: import('@shared/types').MapBody
      error?: string
    }> => ipcRenderer.invoke('map:import')
  },
  // The organization Brand Kit — one brand the whole workspace reads.
  brand: {
    get: (): Promise<{ kit: import('@shared/brandKit').OrgBrandKit; isSet: boolean }> => ipcRenderer.invoke('brand:get'),
    set: (kit: import('@shared/brandKit').OrgBrandKit): Promise<import('@shared/brandKit').OrgBrandKit> =>
      ipcRenderer.invoke('brand:set', kit)
  },
  // Spreadsheet Office interop (.xlsx/.csv) + AI fill.
  sheet: {
    import: (): Promise<{
      ok: boolean
      body?: import('@shared/types').SheetBodyV2
      name?: string
      error?: string
    }> => ipcRenderer.invoke('sheet:import'),
    export: (input: {
      body: import('@shared/types').SheetBodyV2
      format: 'xlsx' | 'csv'
      name: string
    }): Promise<{ ok: boolean; path?: string; error?: string }> => ipcRenderer.invoke('sheet:export', input),
    aiColumns: (input: {
      prompt: string
      existing?: string[]
    }): Promise<{ ok: boolean; columns?: string[]; error?: string; needsApiKey?: boolean }> =>
      ipcRenderer.invoke('ai:suggestSheetColumns', input),
    aiFormula: (input: {
      prompt: string
      headers: string[]
      activeRef: string
      sample?: string[][]
    }): Promise<{
      ok: boolean
      formula?: string
      explanation?: string
      columnsToAdd?: string[]
      tabsToAdd?: { name: string; purpose: string }[]
      error?: string
      needsApiKey?: boolean
    }> => ipcRenderer.invoke('ai:suggestFormula', input),
    aiFill: (input: {
      prompt: string
      headers: string[]
      rangeRows: number
      auto?: boolean
    }): Promise<{ ok: boolean; rows?: string[][]; error?: string; needsApiKey?: boolean }> =>
      ipcRenderer.invoke('ai:fillSheetRange', input),
    // Run a user macro against a tab in the main-process vm (CSP-clean).
    runMacro: (input: {
      tab: import('@shared/types').SheetTab
      code: string
    }): Promise<{ tab: import('@shared/types').SheetTab; logs: string[]; error: string | null }> =>
      ipcRenderer.invoke('sheet:runMacro', input)
  },
  // Slides Office interop (.pptx/.pdf) + AI deck generation.
  slides: {
    export: (input: {
      body: import('@shared/types').SlidesBody
      title: string
      format: 'pptx' | 'pdf'
    }): Promise<{ ok: boolean; path?: string; error?: string }> => ipcRenderer.invoke('slides:export', input),
    import: (): Promise<{
      ok: boolean
      body?: import('@shared/types').SlidesBody
      name?: string
      error?: string
    }> => ipcRenderer.invoke('slides:import')
  },
  // Auto-update bridge. Renderer reads the snapshot via getState on
  // mount, then subscribes via onState to receive every transition.
  update: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke('update:get-state'),
    check: (): Promise<{ ok: true }> => ipcRenderer.invoke('update:check'),
    installAndRestart: (): Promise<{ ok: true }> => ipcRenderer.invoke('update:install-and-restart'),
    // Open the latest release in the browser. Used on macOS where ad-hoc
    // signing prevents in-place auto-install, so the update is a one-click
    // download instead.
    openDownload: (): Promise<{ ok: true }> => ipcRenderer.invoke('update:open-download'),
    // macOS one-click: the app downloads the release and swaps itself in place,
    // then relaunches. Progress flows through the normal update:state events.
    downloadAndInstall: (): Promise<{ ok: true }> =>
      ipcRenderer.invoke('update:download-and-install'),
    onState: (cb: (state: UpdateState) => void): (() => void) => {
      const handler = (_: unknown, s: UpdateState): void => cb(s)
      ipcRenderer.on('update:state', handler)
      return () => ipcRenderer.removeListener('update:state', handler)
    }
  },
  app: {
    // Keep the native window background in step with the theme.
    setBackgroundColor: (hex: string): Promise<boolean> =>
      ipcRenderer.invoke('app:setBackgroundColor', hex),
    // True in the side-by-side "PlexiDesk 3 Preview" build.
    isPreviewBuild: (): Promise<boolean> => ipcRenderer.invoke('app:isPreviewBuild'),
    // Whether this launch followed an update (authoritative; main-process
    // persisted). Drives the first-run "What's new" modal.
    getLaunchInfo: (): Promise<{
      version: string
      previousVersion: string | null
      wasUpdated: boolean
      firstInstall: boolean
    }> => ipcRenderer.invoke('app:get-launch-info'),
    // Bring the main window forward (used when a desktop notification is clicked).
    focusWindow: (): Promise<void> => ipcRenderer.invoke('app:focus-window'),
    // App-wide text size via Chromium page zoom (1 = default).
    setZoomFactor: (factor: number): Promise<void> => ipcRenderer.invoke('app:setZoomFactor', factor),
    // Zoom commands from the View menu / Cmd +/-/0. The renderer owns the scale
    // value (lib/uiScale.ts); the menu just tells it which way to step. Returns
    // an unsubscribe function.
    onZoom: (cb: (dir: 'in' | 'out' | 'reset') => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, dir: 'in' | 'out' | 'reset'): void => cb(dir)
      ipcRenderer.on('app:zoom', listener)
      return () => ipcRenderer.removeListener('app:zoom', listener)
    }
  }
}

// Mirror of UpdateState from main/autoUpdate.ts. Kept in sync by hand —
// only six variants and the field shapes are tiny, so a shared types
// module would be heavier than it's worth.
export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes?: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'ready'; version: string; releaseNotes?: string }
  | { kind: 'none'; currentVersion: string }
  | { kind: 'error'; message: string }

try {
  contextBridge.exposeInMainWorld('api', api)
} catch (error) {
  console.error('preload contextBridge error:', error)
}

export type Api = typeof api
