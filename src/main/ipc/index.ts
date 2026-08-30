import { app, ipcMain, BrowserWindow, dialog, shell, webContents as allWebContents, type WebContents } from 'electron'
import { detectPreviewBuild } from '../appMode'
import { writeFile } from 'node:fs/promises'
import { join as pathJoin } from 'node:path'
import { buildMeetingIcs } from '@shared/ics'
import { consumePendingAuthHandoff, consumePendingShareToken, consumePendingMeetRoom, consumePendingMdEditPath } from '../authProtocol'
import {
  checkForUpdates,
  getCurrentUpdateState,
  installUpdateAndRestart,
  openDownloadPage,
  downloadAndInstallMacUpdate
} from '../autoUpdate'
import {
  clearSecret,
  encryptionAvailable,
  hint,
  resolveAnthropicKey,
  resolveOpenAIKey,
  setSecret,
  setAiMode,
  type AiMode
} from '../settingsStore'
import { searchGifs } from '../gifSearch'
import {
  collectPending,
  collectPendingOrg,
  collectPendingShared,
  markPushed,
  advanceBaseRev,
  applyRemote,
  applyRemoteOrg,
  applyRemoteShared,
  stampSharedDesk,
  adoptSharedDesk,
  pruneSharedDesk,
  getSyncCursor,
  setSyncCursor,
  getSyncCursorOrg,
  setSyncCursorOrg,
  getSyncCursorShared,
  setSyncCursorShared,
  listLocalSharedRoots,
  type RemoteItem
} from '../db/workspaceSync'
import { invalidateAnthropicClient } from '../ai/anthropic'
import { getAiStatus, refreshCredits, startTopUp } from '../ai/creditMode'
import * as mailAccount from '../mail/mailAccount'
import type { MailAccountConfig } from '../mail/mailAccount'
import {
  testConnection as testMailConnection,
  listInbox,
  getMessage,
  markSeen,
  resetConnection as resetMailConnection, archiveMessage } from '../mail/imap'
// NOTE: mail-OAuth wiring temporarily reverted for the 4.1.1 release. The
// ../mail/oauth and ../mail/oauthProviders modules, explainImapError, and the
// mailAccount OAuth methods were referenced here but never committed, which broke
// the build on a clean checkout. Re-add these imports + the two handlers below
// (mail:oauthProviders / mail:oauthConnect) once those modules land.
import {
  listDocuments,
  listTrashedDocuments,
  getDocument,
  createDocument,
  updateDocument,
  upsertDocument,
  trashDocument,
  restoreDocument,
  deleteDocument
} from '../db/documents'
import { captureDocSnapshot, listDocSnapshots, restoreDocSnapshot } from '../db/docSnapshots'
import { listDocComments, addDocComment, resolveDocComment } from '../db/docComments'
import { searchAll, setMailSearchCache } from '../db/search'

// Unseen mail uids already announced with a desktop notification, so a banner
// fires once per message per app run (the renderer polls mail:list).
const announcedMailUids = new Set<number>()
import { getActiveOrgId, setActiveOrgId } from '../db/activeOrg'
import { getDb } from '../db/database'
import {
  applyRemoteWorkItemSnapshot,
  applyRemoteWorkItemAttr,
  applyRemoteWorkItemTrash,
  createWorkItem,
  listWorkItems,
  getWorkItem,
  updateWorkItemFields,
  setWorkItemState,
  reclassifyWorkItem,
  snoozeWorkItem,
  markWorkItemRead,
  clearWorkItemDetached,
  workItemCounts,
  workItemAttentionPrecision,
  attentionBadgeCounts,
  type WorkItemDraft,
  type WorkItemState,
  type WorkItemActor
} from '../db/workItems'
import { postNotification, type PostInput } from '../notifications/substrate'
import { classifyCapture } from '../ai/intentClassify'
import { proposeCleanup } from '../ai/cleanupRewrite'
import {
  isWorkItemsEnabled,
  setWorkItemsEnabled,
  workItemsOrgEnabled,
  orgMigrationAttested,
  attestOrgMigrated,
  revokeOrgAttestation
} from '../workItemsPref'
import { staleDesks } from '../db/nodeActivity'
import { createDeskLayoutStore } from '../db/deskLayoutStore'
import type { DeskLayout, DeviceClass } from '@shared/deskLayout'
import { generateDocument, processMeetingEnd, generateDesignContent, generateDesignVariations, setConversationSnapshot } from '../ai/anthropic'
import { generateImage } from '../imageGen'
import { exportDesign } from '../designExport'
import { exportMap } from '../mapExport'
import { importVsdx } from '../mapImport'
import { searchStockPhotos, fetchImageDataUrl, removeBackground } from '../stockMedia'
import { setPeopleDirectory, type DirectoryPerson } from '../peopleDirectory'
import type { DesignBody } from '@shared/design'
import { getBrandKit, saveBrandKit, hasBrandKit } from '../db/brandKit'
import type { OrgBrandKit } from '@shared/brandKit'
import type { DocType, DocumentDraft, DocumentPatch, FbDocument, MailSendInput } from '@shared/types'
import { sendMail } from '../mail/smtp'
import { suggestReply, resetToneCache } from '../mail/aiReply'
import { getModelClient } from '../ai/modelClient'
import {
  createNode,
  deleteNode,
  deleteNodePermanent,
  moveNodeToOrg,
  restoreNodes,
  getNode,
  listNodes,
  listTrash,
  restoreTree,
  moveNode,
  updateNode,
  ensureSharedContainer
} from '../db/nodes'
import { relateNodes, unrelateNodes, listRelatedNodeIds } from '../db/nodeRelations'
import {
  emitObjectEvent,
  mirrorUserRelation,
  unmirrorUserRelation,
  relatedObjectIds as ceRelatedObjectIds,
  healthFor as ceHealthFor,
  markReviewed as ceMarkReviewed,
  decisionImpactForObject as ceDecisionImpactForObject,
  createDecision as ceCreateDecision,
  cancelDecision as ceCancelDecision,
  listDecisions as ceListDecisions,
  decisionsForObject as ceDecisionsForObject,
  backfillWidgetLinkRelations as ceBackfillWidgetLinkRelations,
  liveResumeForDesk as ceLiveResumeForDesk
} from '../context/engine'
import { plexiId } from '@shared/plexiId'
import type { MaterialityInput } from '../context/materiality'
import { isRealCreate, isRealDelete, stateChanged } from '../context/objectEventGuards'
import type { WriteOrigin } from '../../shared/writeOrigin'
import {
  bringToFront,
  createWidget,
  deleteWidget,
  restoreWidget,
  getWidget,
  listWidgetsByTask,
  listWidgetsByKind,
  updateWidget, createWidgetIfTaskExists } from '../db/widgets'
import { collectTelemetry, recordAiCall, setOnboardingSummary } from '../db/telemetry'
import { recordCrash, listCrashes, listUnforwarded, markForwarded } from '../db/crashLog'
import {
  recordEvent as recordChangeEvent,
  unsyncedEvents as unsyncedChangeEvents,
  markSynced as markChangeSynced,
  knownIds as knownChangeIds,
  eventsForObject as changeEventsForObject,
  type RecordInput as ChangeRecordInput
} from '../db/changeLog'
import { getLaunchInfo } from '../launchVersion'
import {
  createLink,
  deleteLink,
  getLink,
  listLinksByTask,
  updateLink,
  type WireUpdate
} from '../db/widgetLinks'
import {
  recordWireRun,
  listWireRunsByWire,
  listWireRunsByTask,
  type WireRunInput
} from '../db/wireRuns'
import {
  branchSnapshot,
  createSnapshot,
  getSnapshot,
  listSnapshots,
  restoreSnapshot
} from '../db/canvasSnapshots'
import {
  clearSession,
  loadAccountState,
  saveSession,
  setCachedEmail,
  setSkipped
} from '../db/account'
import {
  executeAction,
  openAccessibilitySettings,
  openSettingsAppPlain,
  revealAppBundleInFinder,
  type ExecuteResult
} from '../streamdeckActions'
import { loadUniversalDeck, saveUniversalDeck } from '../db/speeddeck'
import type { StreamDeckAction } from '@shared/streamdeck'
import {
  acceptShare,
  createShareLink,
  deleteShareLink,
  listAllShareLinks,
  listShareLinksForEntity,
  listSharedWithMe,
  removeSharedItem,
  revokeShareLink,
  setShareLinkScope
} from '../db/shares'
import {
  createTemplateFromTask,
  deleteTemplate,
  listTemplates
} from '../db/templates'
import { getRecentHistory, recordVisit } from '../db/browsing'
import {
  createConnectedApp,
  deleteConnectedApp,
  findConnectedAppByHostname,
  listConnectedApps,
  reorderConnectedApps,
  touchConnectedApp,
  updateConnectedApp
} from '../db/connectedApps'
import {
  describeLocalApp,
  isLocalAppRunning,
  launchLocalApp,
  pickLocalApp,
  refreshAppIcon
} from '../localApps'
import {
  deleteFile,
  getFile,
  ingestFromBuffer,
  ingestFromPath,
  readFileBytes,
  listEntries as listFileEntries,
  getEntry as getFileEntry,
  folderPath as fileFolderPath,
  createFolder as createFileFolder,
  renameEntry as renameFileEntry,
  moveEntry as moveFileEntry,
  deleteEntry as deleteFileEntry,
  restoreEntries as restoreFileEntries,
  listTrashedEntries as listTrashedFileEntries,
  restoreEntryDeep as restoreFileEntryDeep,
  purgeEntry as purgeFileEntry,
  searchEntries as searchFileEntries,
  tagsFor as fileTagsFor,
  addTags as addFileTags,
  removeTag as removeFileTag,
  allTags as allFileTags,
  entriesByTag as fileEntriesByTag,
  entriesByTags as fileEntriesByTags,
  untaggedEntries as untaggedFileEntries,
  listSmartFolders as listFileSmartFolders,
  createSmartFolder as createFileSmartFolder,
  deleteSmartFolder as deleteFileSmartFolder,
  smartFolderEntries as fileSmartFolderEntries,
  fileDocument,
  unfiledDocuments,
  locateDocument,
  hasFileBytes,
  readFileBytesForSync,
  writeSyncedFileBytes,
  moveFileToOrg,
  importFolderTree
} from '../db/files'
import { extractFileText } from '../fileText'
import { ingestWorkspaceIntoBrain } from '../brainIngest'
import { extractDocText, retrieveSources, relatedDocuments } from '../workspaceSearch'
import {
  openExternalUrl,
  openLocalFile,
  pickAndIngestFile,
  pickFilesIntoFolder,
  revealFile,
  thumbnailForFile
} from '../filePreviews'
import {
  extractActionsFromTranscript,
  processTranscript,
  transcribeAudio,
  type ProcessMode,
  type TranscriptionProvider
} from '../ai/voiceNote'
import { preloadLocalWhisper } from '../ai/localWhisper'
import { getVoiceCommandPrefs, setVoiceCommandPrefs } from '../voiceCommandPref'
import {
  createAgentRun,
  stopAgentRun,
  endAgentRun,
  performAgentAction,
  type AgentAction
} from '../ai/browserActions'
import { runBrowserAgent, stopBrowserAgent, resolveBrowserConsent } from '../ai/browserAgent'
import { listConsent, revokeConsent } from '../browserConsent'
import {
  importFile,
  pickFileForImport,
  pickGridFileForImport,
  type ImportTargetKind
} from '../fileImport'
import {
  expandMindMapNode,
  listAvailableAgents,
  suggestAgentsForNode,
  type MindMapNodeKind,
  type LocalAgent
} from '../ai/mindMap'
import {
  createAgent,
  type AgentModelTier,
  type AgentTool
} from '../ai/agentBuilder'
import { shell as electronShell } from 'electron'
import {
  getWorkspaceOverride,
  setWorkspaceOverride
} from '../workspacePref'
import { invokeAgent } from '../ai/agentDispatcher'
import {
  listInvocationsForNode,
  recordOutcome,
  statsForSlug,
  undoLastApply
} from '../ai/agentHistory'
import {
  getTranscriptionProvider,
  setTranscriptionProvider
} from '../voiceProviderPref'
import {
  createRow,
  createTable,
  deleteRow,
  deleteTable,
  getTable,
  listRows,
  listTables,
  reorderRows,
  restoreRow,
  updateRow,
  updateTable
} from '../db/tables'
import {
  listKnowledge,
  getKnowledge,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge
} from '../db/knowledge'
import type { KnowledgeDraft, KnowledgePatch } from '@shared/knowledge'
import {
  semanticSearchKnowledge,
  embedKnowledgeEntry,
  reindexKnowledge,
  knowledgeSemanticActive
} from '../semanticRetrieval'
import {
  embedDocument,
  reindexDocuments,
  documentSemanticActive
} from '../documentRetrieval'
import { reindexDocumentChunks } from '../chunkIndex'
import { enrichDocument, enrichAllDocuments } from '../ai/enrichDocuments'
import { localModelStatus } from '../ai/localModel'
import { getDocMetadata } from '../db/docMetadata'
import { listMemories, addMemory, forgetMemory } from '../db/memory'
import { extractMemoryFromDocuments } from '../ai/extractMemory'
import { embedQuery } from '../ai/embeddings'
import { lookupAnswer, storeAnswer, bumpAnswerCacheVersion } from '../ai/answerCache'
import type { MemoryKind } from '@shared/types'
import {
  getProjectPlan,
  setTaskPlan,
  addDependency,
  setDependency,
  removeDependency,
  captureBaseline,
  listBaselines,
  loadProjectCalendar,
  saveProjectCalendar,
  levelResources,
  rescheduleProject,
  listProjectSummaries
} from '../db/projectPlan'
import type { PlanTaskPatch, DepType } from '@shared/projects'
import type { WorkingCalendar } from '@shared/workingCalendar'
import { toProjectXml } from '@shared/projectXml'
import {
  listReports,
  getReport,
  createReport,
  updateReport,
  deleteReport,
  generateReport,
  runDueReports
} from '../db/reports'
import type { ReportDraft, ReportPatch } from '@shared/reports'
import {
  listFlows,
  getFlow,
  createFlow,
  updateFlow,
  deleteFlow,
  runFlow,
  runDueFlows
} from '../db/flows'
import type { FlowDraft, FlowPatch } from '@shared/flows'
import { listTokens, createToken, revokeToken, getApiConfig, setApiConfig, isValidApiPort } from '../db/apiTokens'
import { startApiServer, stopApiServer, isApiServerRunning, initApiServer } from '../apiServer'
import type { ApiScope } from '@shared/apiAccess'
import { applyTemplate } from '../templates'
import { deleteEmbedding } from '../db/embeddings'
import {
  listMeetings,
  getMeeting,
  createMeeting,
  updateMeeting,
  deleteMeeting
} from '../db/meetings'
import type { MeetingDraft, MeetingPatch } from '@shared/meetings'
import { listApps, getApp, createApp, updateApp, deleteApp } from '../db/apps'
import type { PlexiAppDraft, PlexiAppPatch } from '@shared/apps'
import { listForms, getForm, createForm, updateForm, deleteForm } from '../db/forms'
import type { PlexiFormDraft, PlexiFormPatch } from '@shared/forms'
import {
  listSignRequests,
  getSignRequest,
  createSignRequest,
  updateSignRequest,
  deleteSignRequest,
  sendSignRequest,
  signSignRequest,
  declineSignRequest,
  voidSignRequest
} from '../db/sign'
import type { PlexiSignDraft, PlexiSignPatch, SignAction } from '@shared/sign'
import type {
  FbRowDraft,
  FbRowPatch,
  FbTableDraft,
  FbTablePatch
} from '@shared/fields'
import {
  deleteDashboardLayout,
  getDashboardLayout,
  setDashboardLayout,
  type DashboardLayoutInput
} from '../db/dashboardLayouts'
import { currentEnergy, logEnergy, recentEnergy } from '../db/energy'
import {
  createTimeBlock,
  deleteTimeBlock,
  listBlocksInRange,
  updateTimeBlock, materializeRecurringBlocks } from '../db/timeBlocks'
import { fireHaptic, isHapticsAvailable, type HapticFeel } from '../haptics'
import {
  backupInfo,
  createBackup,
  defaultExportName,
  restoreFromFile,
  validateBackupFile
} from '../db/backup'
import {
  changeMasterPassword,
  createEntry,
  createVault,
  decryptWithMaster,
  deleteEntry,
  encryptWithMaster,
  getVaultMeta,
  isUnlocked,
  listEntries,
  lockVault,
  unlockVault,
  updateEntry
} from '../db/vault'
import {
  completeFocusSession,
  listRecentSessions,
  startFocusSession
} from '../db/focusSessions'
import { deleteCluster, listClustersForTask, saveCluster } from '../db/focusClusters'
import {
  listConversations as listAiChatConversations,
  getConversation as getAiChatConversation,
  createConversation as createAiChatConversation,
  appendMessage as appendAiChatMessage,
  setMessageApplied as setAiChatMessageApplied,
  renameConversation as renameAiChatConversation,
  deleteConversation as deleteAiChatConversation,
  linkDesk as linkAiChatDesk,
  setConversationMode as setAiChatConversationMode,
  setConversationWebSearch as setAiChatConversationWebSearch
} from '../db/aiChat'
import { getRecentActivity, recordActivity } from '../db/activity'
import {
  generatePresenceNarration,
  generateProactiveWelcome,
  generateDailyBrief,
  buildFromPrompt,
  generateResume,
  proposeSmartStacks,
  designAgentProfile,
  regenerateLivingPage,
  runDeskAgent,
  runTransformWire,
  sendChat,
  sendChatStream,
  routeCommandBar,
  transformText,
  suggestWidgetSetup,
  suggestPageContent,
  suggestSetupWidgets,
  suggestFileTags,
  groupWidgetsByTopic,
  askWorkspace,
  askWorkspaceStream,
  suggestWorkspaceActions,
  suggestTableRows,
  summarizeRecentTrail,
  suggestDocContent,
  rewriteSelection,
  suggestSheetColumns,
  suggestFormula,
  fillSheetRange,
  generateSlideElements,
  runAgentStep,
  verifyAgentGoal
} from '../ai/anthropic'
import { importDocx, exportDocx, exportPdf, pickImage, type PageSetupInput } from '../officeDocx'
import { importSheet, exportSheet } from '../sheetIo'
import { runSheetMacro } from '../sheetMacro'
import { exportSlides, importPptx } from '../slidesIo'
import { getModelMode, setModelMode } from '../ai/modelRouting'
import { describeWidgetForAgent } from '../ai/agentInputs'
// Static import (not a lazy require): electron-vite only bundles the static import
// graph, so a runtime require('../assistant/standupRun') throws MODULE_NOT_FOUND in
// the built app.
import { runStandup } from '../assistant/standupRun'
import type {
  ActivityRecordDraft,
  ChatRequest,
  ConnectedAppDraft,
  ConnectedAppPatch,
  DashboardCardKind,
  EnergyLevel,
  TimeBlockDraft,
  TimeBlockPatch,
  FocusSessionCompletePatch,
  FocusSessionStartDraft,
  ModelMode,
  NodeDraft,
  NodePatch,
  VaultEntryDraft,
  VaultEntryPatch,
  Widget,
  WidgetDraft,
  WidgetPatch,
  WireType,
  ActionProposal,
  AppliedProposal,
  AiChatConversationContext,
  ChatMentionRef,
  ChatQuestion,
  ChatSource,
  StoredTrace,
  FocusClusterDraft
} from '@shared/types'

// A plain-language description of the content format a wired output widget
// expects, so a desk agent can produce the right shape for each one.
function outputFormatHint(w: { kind: string; content: string | null }): string {
  switch (w.kind) {
    case 'markdown':
      return 'Markdown'
    case 'page':
      return 'a document written in Markdown (headings, bullet lists, paragraphs)'
    case 'sticky':
    case 'note':
      return 'plain text'
    case 'card':
      return 'a short title on the first line, then the body'
    case 'table':
      return 'a list of items, one per line (the app turns them into typed table rows)'
    case 'mindmap':
      return 'an outline: the first line is the root, then one item per line'
    case 'field': {
      try {
        const t = (JSON.parse(w.content || '{}') as { def?: { type?: string } }).def?.type
        if (t === 'number') return 'a single number'
        if (t === 'date') return 'a date'
        if (t === 'checkbox') return 'yes or no'
        if (t === 'single-select' || t === 'multi-select') return 'one of the field’s options'
      } catch {
        /* fall through */
      }
      return 'a short single value'
    }
    default:
      return 'plain text'
  }
}

// Derive a deterministic materiality input from a node's real fields (PLX-CTX-011:
// no model call). Higher importance, org reach and confirmed relations raise the
// score; a completed desk scores as final-stage work.
function materialityForNode(node: {
  id: string
  importance: number
  status: string
  parentId: string | null
  sharedFromHandle: string | null
}): MaterialityInput {
  const related = ceRelatedObjectIds(node.id).length
  const stage: MaterialityInput['workflowStage'] =
    node.status === 'done' ? 'final' : node.status === 'open' ? 'active' : 'review'
  return {
    affectedObjectCount: related,
    decisionImpact: node.importance >= 4 ? 'high' : node.importance >= 3 ? 'low' : 'none',
    relationshipDepth: related > 0 ? 1 : 0,
    organisationalReach: node.sharedFromHandle ? 'team' : node.parentId ? 'desk' : 'self',
    userRole: 'owner',
    workflowStage: stage,
    historicalSignificance: Math.min(1, node.importance / 5)
  }
}

// Materiality inputs for a Widget (Object). A change scores as material when the
// widget is referenced by a live Decision or has confirmed relations, so a
// content change to a decision-linked or well-connected widget can escalate its
// Context Health, while an isolated note stays a quiet "changed".
function materialityForWidget(widget: {
  id: string
  kind: string
  parentSectionId: string | null
}): MaterialityInput {
  const related = ceRelatedObjectIds(widget.id).length
  const decisionImpact = ceDecisionImpactForObject(widget.id)
  return {
    affectedObjectCount: related,
    decisionImpact,
    relationshipDepth: related > 0 ? 1 : 0,
    organisationalReach: 'desk',
    userRole: 'owner',
    workflowStage: 'active',
    historicalSignificance: decisionImpact === 'high' ? 0.6 : 0.2
  }
}

// Context Health for any object id, resolving whether it is a node (Desk/Room) or
// a widget and applying the matching materiality. Shared by context:health and the
// decisions risk report.
function objectHealth(id: string): ReturnType<typeof ceHealthFor> {
  const node = getNode(id)
  if (node) return ceHealthFor(id, materialityForNode(node))
  const widget = getWidget(id)
  if (widget) return ceHealthFor(id, materialityForWidget(widget))
  return { objectId: id, state: 'current', materiality: null, changedEventCount: 0, decisionsAtRisk: [] }
}

// Lazily-constructed desk-layout overlay store, bound to the app DB on first use
// (getDb() is ready by the time any IPC handler fires). Its constructor creates
// the desk_layouts table if absent.
let _deskLayoutStore: ReturnType<typeof createDeskLayoutStore> | null = null
function deskLayoutStore(): ReturnType<typeof createDeskLayoutStore> {
  if (!_deskLayoutStore) _deskLayoutStore = createDeskLayoutStore(getDb())
  return _deskLayoutStore
}

export function registerIpcHandlers(): void {
  // ── Body-double cross-window relay ──────────────────────────────────────
  // BroadcastChannel is per-renderer-process — fine for two browser tabs,
  // useless for two Electron windows. The bridge below lets the local-mock
  // matcher work across multiple FocusBuddy windows on the same machine:
  // when one renderer sends a `fb:body-double-bus` message, main forwards
  // it to every OTHER renderer. The wire format is whatever the matcher
  // wants — main treats payloads as opaque blobs.
  ipcMain.on('fb:body-double-bus', (event, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const wc: WebContents = win.webContents
      if (wc.id === event.sender.id) continue
      try {
        wc.send('fb:body-double-bus', payload)
      } catch {
        // window may have closed mid-broadcast — ignore
      }
    }
  })

  // The workItems:* namespace (Attention S3, §4) — every verb wraps the S2
  // db-module functions (F008 one code path); create carries the typed
  // refusal codes (flag OFF / un-migrated / non-personal scope) to the caller.
  ipcMain.handle('workItems:list', () => listWorkItems())
  ipcMain.handle('workItems:get', (_e, id: string) => getWorkItem(id))
  ipcMain.handle('workItems:create', (_e, draft: WorkItemDraft, actor?: WorkItemActor) =>
    createWorkItem(draft, actor)
  )
  ipcMain.handle(
    'workItems:updateFields',
    (_e, id: string, patch: Record<string, unknown>, actor?: WorkItemActor) =>
      updateWorkItemFields(id, patch, actor)
  )
  ipcMain.handle('workItems:setState', (_e, id: string, state: WorkItemState, actor?: WorkItemActor) =>
    setWorkItemState(id, state, actor)
  )
  ipcMain.handle('workItems:reclassify', (_e, id: string, intentClass: string) =>
    reclassifyWorkItem(id, intentClass)
  )
  ipcMain.handle('workItems:snooze', (_e, id: string, until: number | null) =>
    snoozeWorkItem(id, until)
  )
  ipcMain.handle('workItems:markRead', (_e, id: string) => markWorkItemRead(id))
  ipcMain.handle('workItems:clearDetached', (_e, id: string) => clearWorkItemDetached(id))
  ipcMain.handle('workItems:counts', () => workItemCounts())
  ipcMain.handle('workItems:badgeCounts', () => attentionBadgeCounts())
  // S5: the capture classifier (hard rules first — zero model latency on the
  // common cases; Haiku fallback; loose_thought floor) and the capability
  // probe surfaces can gate on.
  ipcMain.handle('workItems:classify', (_e, text: string) => classifyCapture(String(text ?? '')))
  // DEC-026 (Δ6): the opt-in tidy proposal — gated on the deterministic
  // messiness test inside, null on any failure, never blocks a capture.
  ipcMain.handle('workItems:proposeCleanup', (_e, text: string) =>
    isWorkItemsEnabled() ? proposeCleanup(String(text ?? '')) : null
  )
  ipcMain.handle('workItems:enabled', () => isWorkItemsEnabled())
  // V2 (DEC-023): the Settings toggle — the pref finally has a real switch.
  // Prompt vocabulary reads the pref live per call; renderer surfaces
  // re-probe on the fb:workitems-toggled event the Settings row dispatches.
  ipcMain.handle('workItems:setEnabled', (_e, enabled: boolean) => {
    setWorkItemsEnabled(enabled === true)
    return isWorkItemsEnabled()
  })
  // P1 migrated-peer confirmation (§2.6/§8): the per-org gate the SPEC-027
  // org-carry branch will consult. Record/revoke are operator actions.
  ipcMain.handle('workItems:orgEnabled', (_e, orgId: string) => workItemsOrgEnabled(String(orgId ?? '')))
  ipcMain.handle('workItems:orgAttestation', (_e, orgId: string) => orgMigrationAttested(String(orgId ?? '')))
  ipcMain.handle('workItems:attestOrgMigrated', (_e, orgId: string, note: string) =>
    attestOrgMigrated(String(orgId ?? ''), String(note ?? ''))
  )
  ipcMain.handle('workItems:revokeOrgAttestation', (_e, orgId: string) =>
    revokeOrgAttestation(String(orgId ?? ''))
  )
  // Lifecycle L3: computed desk staleness — the Stale Desks widget's feed.
  ipcMain.handle('nodes:staleDesks', () => staleDesks())
  // Attention precision (MET-006 wiring): acted vs dismissed over recent
  // terminal transitions — the metric Q1's threshold recalibrates against.
  ipcMain.handle('workItems:precision', () => workItemAttentionPrecision())
  // The notification substrate (S4, §5): the one posting door. The renderer's
  // live banners post records-of-record through it; scheduled deliveries are
  // swept by the main scheduler.
  ipcMain.handle('notifications:post', (_e, input: PostInput) => postNotification(getDb(), input))
  // Internal seam (S2): the arrival router's channel into the same code path.
  ipcMain.handle('workItems:kindOf', (_e, id: string) => {
    const row = getDb().prepare('SELECT kind FROM nodes WHERE id = ?').get(id) as
      | { kind: string }
      | undefined
    return row?.kind ?? null
  })
  ipcMain.handle(
    'workItems:applySyncEvent',
    (
      _e,
      ev:
        | { type: 'create'; snapshot: Record<string, unknown> }
        | { type: 'attr'; id: string; attr: string; value: unknown }
        | { type: 'trash'; id: string; trashed: boolean }
    ) => {
      if (ev.type === 'create') return applyRemoteWorkItemSnapshot(ev.snapshot)
      if (ev.type === 'attr') return applyRemoteWorkItemAttr(ev.id, ev.attr, ev.value)
      applyRemoteWorkItemTrash(ev.id, ev.trashed)
      return 'applied'
    }
  )
  ipcMain.handle('nodes:list', () => listNodes())
  ipcMain.handle('nodes:get', (_e, id: string) => getNode(id))
  ipcMain.handle('nodes:create', (_e, draft: NodeDraft, origin?: WriteOrigin) => {
    // Work_items never travel the nodes:* namespace (F008 one-code-path):
    // their creator is workItems:create (S3), which wraps the dedicated
    // db-module function. This protocol-boundary refusal is additional to
    // createNode's own capability/migration/scope gates.
    if (draft.kind === 'work_item') {
      throw new Error('work_item creation goes through workItems:create, not nodes:create')
    }
    // DEC-059 — createNode is idempotent by id: it returns the existing row
    // untouched when the id is already present, so a replayed create is a
    // no-op in the database. Ask what happened before claiming it happened.
    const preexisting = draft.id ? getNode(draft.id) : null
    const node = createNode(draft)
    // Live projection: a real ObjectCreated Event on a real user action.
    // (Binary ternary is safe: work_item was refused above.)
    if (origin !== 'sync' && isRealCreate(preexisting)) {
      emitObjectEvent({
      eventType: node.kind === 'folder' ? 'RoomCreated' : 'DeskCreated',
      category: 'user',
      objectId: node.id,
      deskId: node.parentId ?? null,
      currentState: { title: node.title, kind: node.kind, importance: node.importance, status: node.status },
        changeSummary: `Created ${node.kind} "${node.title}"`
      })
      // You created it, so you have seen it: anchor the review point past the
      // creation event so a brand-new desk does not report itself as "changed
      // since your last visit". Later changes still surface honestly.
      ceMarkReviewed(node.id)
    }
    return node
  })
  ipcMain.handle('nodes:update', (_e, id: string, patch: NodePatch, origin?: WriteOrigin) => {
    const before = getNode(id)
    const node = updateNode(id, patch)
    // DEC-059 — a write that changed nothing is not an update.
    if (origin !== 'sync' && node && stateChanged(before as never, node as never)) {
      emitObjectEvent({
        eventType: node.status === 'done' && before?.status !== 'done' ? 'DeskCompleted' : 'DeskUpdated',
        category: 'user',
        objectId: node.id,
        deskId: node.parentId ?? null,
        previousState: before ? { title: before.title, status: before.status, importance: before.importance } : undefined,
        currentState: { title: node.title, status: node.status, importance: node.importance },
        changeSummary: `Updated "${node.title}"`
      })
    }
    return node
  })
  // Trash surfacing (lifecycle L1): the Trash view's list + subtree restore.
  ipcMain.handle('nodes:listTrash', () => listTrash())
  ipcMain.handle('nodes:restoreTree', (_e, rootId: string) => restoreTree(rootId))
  ipcMain.handle('nodes:delete', (_e, id: string, origin?: WriteOrigin) => {
    const before = getNode(id)
    const removed = deleteNode(id)
    // DEC-059 — deleting an id that is already gone is not a transition.
    if (origin !== 'sync' && isRealDelete(before)) {
      emitObjectEvent({
        eventType: 'DeskDeleted',
        category: 'user',
        objectId: id,
        currentState: { title: before?.title ?? null, trashed: true },
        changeSummary: `Deleted "${before?.title ?? id}"`
      })
    }
    return removed
  })
  // DEC-021 (D2): the permanent-purge arm of the delete dialog. Refusals (C2
  // work_item root, D1 shared desk) throw typed errors the renderer surfaces.
  ipcMain.handle('nodes:deletePermanent', (_e, id: string) => {
    const before = getNode(String(id || ''))
    const result = deleteNodePermanent(String(id || ''))
    if (isRealDelete(before)) {
      emitObjectEvent({
        eventType: 'DeskDeleted',
        category: 'user',
        objectId: String(id || ''),
        currentState: { title: before?.title ?? null, trashed: false },
        changeSummary: `Permanently deleted "${before?.title ?? id}" (memory purged)`
      })
    }
    return result
  })
  ipcMain.handle('nodes:restore', (_e, ids: string[]) => restoreNodes(ids))
  ipcMain.handle('nodes:moveToOrg', (_e, id: string, orgId: string, teamId?: string | null) =>
    moveNodeToOrg(String(id || ''), String(orgId || ''), teamId ?? null)
  )
  // User-driven desk relatedness (see db/nodeRelations.ts). The legacy table stays
  // the UI's source of truth; each edge is ALSO mirrored into the knowledge graph
  // as a confirmed Relationship so Context Health can propagate across it.
  ipcMain.handle('nodes:relate', (_e, a: string, b: string) => {
    relateNodes(a, b)
    mirrorUserRelation(a, b, plexiId(), 'user linked these desks')
    return listRelatedNodeIds(a)
  })
  ipcMain.handle('nodes:unrelate', (_e, a: string, b: string) => {
    unrelateNodes(a, b)
    unmirrorUserRelation(a, b)
    return listRelatedNodeIds(a)
  })
  ipcMain.handle('nodes:listRelated', (_e, id: string) => listRelatedNodeIds(id))

  // ── Context Engine read surface (live) ──────────────────────────────────
  // Confirmed relationship neighbours of an object — "surfaces with relations".
  ipcMain.handle('context:related', (_e, id: string) => ceRelatedObjectIds(id))
  // Per-(user, object) Context Health, honest against the user's last review point.
  // Per-(user, object) Context Health. Widgets are first-class objects too, so
  // this frames a widget that changed while away, not just a desk.
  ipcMain.handle('context:health', (_e, id: string) => objectHealth(id))
  ipcMain.handle('context:markReviewed', (_e, id: string) => {
    ceMarkReviewed(id)
    return true
  })
  // Decisions (spec §37). A human-owned Decision references Objects/Desks so a
  // later material change raises Decision Risk against them (the red widget frame
  // + desk decisions-at-risk). Creating one is the entry point that activates the
  // whole decision-risk surface.
  ipcMain.handle(
    'decisions:create',
    (_e, input: { title: string; decisionStatement?: string; relatedObjectIds?: string[]; affectedDeskIds?: string[] }) =>
      ceCreateDecision(input)
  )
  ipcMain.handle('decisions:list', () => ceListDecisions())
  ipcMain.handle('decisions:forObject', (_e, objectId: string) => ceDecisionsForObject(objectId))
  // Live risk report for the decisions panel: each live Decision with whether any
  // Object it references has a material change since review (so it is at risk).
  ipcMain.handle('decisions:withRisk', () => {
    return ceListDecisions()
      .filter((d) => d.state !== 'superseded' && d.state !== 'cancelled')
      .map((d) => {
        const riskyObjectIds = d.relatedObjectIds.filter((oid) => {
          const s = objectHealth(oid).state
          return s === 'attention-required' || s === 'decision-risk'
        })
        return { decision: d, atRisk: riskyObjectIds.length > 0, riskyObjectIds }
      })
  })
  ipcMain.handle('decisions:cancel', (_e, id: string) => {
    ceCancelDecision(id)
    return true
  })
  // Live catch-up Resume with an AI summary (degrades to deterministic without a key).
  ipcMain.handle('context:resumeSummary', (_e, deskId: string) => ceLiveResumeForDesk(deskId))
  ipcMain.handle(
    'nodes:move',
    (_e, id: string, newParentId: string | null, beforeId: string | null) =>
      moveNode(id, newParentId, beforeId)
  )

  ipcMain.handle('widgets:get', (_e, id: string) => getWidget(id))
  ipcMain.handle('widgets:listByTask', (_e, taskId: string) => listWidgetsByTask(taskId))
  ipcMain.handle('widgets:listByKind', (_e, kind: Widget['kind']) => listWidgetsByKind(kind))
  ipcMain.handle('widgets:create', (_e, draft: WidgetDraft, origin?: WriteOrigin) => {
    const preexistingWidget = draft.id ? getWidget(draft.id) : null
    const widget = createWidget(draft)
    // Widgets are first-class Context-Engine objects (PLX-APP-002): a real create
    // emits an Event on the widget's object id so its Context Health can be derived.
    // DEC-059 — createWidget is idempotent by id ("so a replayed/echoed create
    // never duplicates"); the event layer has to honour the same contract.
    if (origin !== 'sync' && isRealCreate(preexistingWidget)) {
      emitObjectEvent({
        eventType: 'WidgetCreated',
        category: 'user',
        objectId: widget.id,
        deskId: widget.taskId ?? null,
        currentState: { kind: widget.kind, title: widget.title ?? null },
        changeSummary: `Added ${widget.kind}${widget.title ? ` "${widget.title}"` : ''}`
      })
      // You created it, so you have seen it: baseline past the creation so a
      // brand-new widget does not report itself as "changed since your last visit".
      ceMarkReviewed(widget.id)
    }
    return widget
  })
  // Tolerant variant for auto-spawned chrome (minimap): no-op if the task is gone.
  // Chrome is not user content, so it emits no Object Event.
  ipcMain.handle('widgets:createOptional', (_e, draft: WidgetDraft) => createWidgetIfTaskExists(draft))
  ipcMain.handle('widgets:update', (_e, id: string, patch: WidgetPatch, origin?: WriteOrigin) => {
    const beforeWidget = getWidget(id)
    const widget = updateWidget(id, patch)
    // Emit only for content-meaningful changes. Pure geometry/layout moves are not
    // "changed since your last visit" content and must never flood the log or
    // flicker a health frame on every drag.
    //
    // DEC-059 — the patch naming a field is not the same as the field changing.
    // A replay re-sends the content it already stored, so presence alone let one
    // sticky mint six identical Events inside 2ms. Check the outcome too.
    if (
      origin !== 'sync' &&
      widget &&
      ('content' in patch || 'title' in patch) &&
      stateChanged(beforeWidget as never, widget as never)
    ) {
      emitObjectEvent({
        eventType: 'WidgetUpdated',
        category: 'user',
        objectId: widget.id,
        deskId: widget.taskId ?? null,
        currentState: { kind: widget.kind, title: widget.title ?? null },
        changeSummary: `Updated ${widget.kind}${widget.title ? ` "${widget.title}"` : ''}`
      })
    }
    return widget
  })
  ipcMain.handle('widgets:delete', (_e, id: string) => {
    const before = getWidget(id)
    const removed = deleteWidget(id)
    if (origin !== 'sync' && isRealDelete(before)) {
      emitObjectEvent({
        eventType: 'WidgetDeleted',
        category: 'user',
        objectId: id,
        deskId: before.taskId ?? null,
        currentState: { kind: before.kind, trashed: true },
        changeSummary: `Removed ${before.kind}${before.title ? ` "${before.title}"` : ''}`
      })
    }
    return removed
  })
  ipcMain.handle('widgets:restore', (_e, id: string) => restoreWidget(id))
  ipcMain.handle('widgets:bringToFront', (_e, id: string) => bringToFront(id))

  // Desk layout overlay (PLX-APP-010 / UX-032, ADR-0006). Per-(user, Desk,
  // device class) camera + selection, persisted and restored on Desk open. The
  // store lazily creates its own table; instantiate once against the app DB.
  ipcMain.handle('deskLayout:load', (_e, userId: string, deskId: string, deviceClass: DeviceClass) =>
    deskLayoutStore().load(userId, deskId, deviceClass)
  )
  ipcMain.handle('deskLayout:save', (_e, layout: DeskLayout) =>
    deskLayoutStore().save(layout, new Date().toISOString())
  )

  ipcMain.handle('widgetLinks:listByTask', (_e, taskId: string) => listLinksByTask(taskId))

  // Share-link CRUD
  ipcMain.handle('shares:listAll', () => listAllShareLinks())
  ipcMain.handle(
    'shares:listForEntity',
    (_e, kind: 'folder' | 'task' | 'widget', entityId: string) =>
      listShareLinksForEntity(kind, entityId)
  )
  ipcMain.handle(
    'shares:create',
    (
      _e,
      input: {
        token: string
        kind: 'folder' | 'task' | 'widget'
        entityId: string
        label: string
        scope: 'view' | 'copy'
        expiresAt: number | null
        createdBy?: string | null
      }
    ) => createShareLink(input)
  )
  ipcMain.handle('shares:revoke', (_e, id: string) => revokeShareLink(id))
  ipcMain.handle('shares:setScope', (_e, id: string, scope: 'view' | 'copy') => setShareLinkScope(id, scope))
  ipcMain.handle('shares:delete', (_e, id: string) => deleteShareLink(id))
  // "Shared with me" inbox
  ipcMain.handle('shares:inbox', () => listSharedWithMe())
  ipcMain.handle(
    'shares:accept',
    (
      _e,
      input: {
        token: string
        kind: 'folder' | 'task' | 'widget'
        snapshot: unknown
        fromHandle: string
        scope: 'view' | 'copy'
      }
    ) => acceptShare(input)
  )
  ipcMain.handle('shares:removeInbox', (_e, id: string) => removeSharedItem(id))

  // Account session — load/save/clear via main-process safeStorage. The
  // renderer never sees the encryption key or the file path. Skipped is
  // a separate boolean used by the launch modal to remember "user
  // dismissed me" between launches.
  ipcMain.handle('account:load', () => loadAccountState())
  ipcMain.handle(
    'account:saveSession',
    (_e, input: { token: string; email: string | null }) =>
      saveSession(input.token, input.email)
  )
  ipcMain.handle('account:clearSession', () => clearSession())
  ipcMain.handle('account:setSkipped', (_e, skipped: boolean) => setSkipped(skipped))
  ipcMain.handle('account:setCachedEmail', (_e, email: string | null) =>
    setCachedEmail(email)
  )

  // Stream Deck — single execute endpoint takes any action (single or
  // multi-step) and runs it. Returns {ok, error?} for the renderer to
  // surface on the button.
  ipcMain.handle(
    'streamdeck:execute',
    (_e, action: StreamDeckAction): Promise<ExecuteResult> => executeAction(action)
  )
  ipcMain.handle('streamdeck:openAccessibilitySettings', () =>
    openAccessibilitySettings()
  )
  // Lets the renderer ask "are we trusted for accessibility right now?"
  // Used so the dialog can stop nagging once the user has flipped the
  // toggle in System Settings, without requiring a restart.
  ipcMain.handle('streamdeck:checkAccessibility', () => {
    if (process.platform !== 'darwin') return true
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { systemPreferences } = require('electron')
      return systemPreferences.isTrustedAccessibilityClient(false)
    } catch {
      return false
    }
  })
  // Triggers macOS's NATIVE accessibility permission prompt. This is the
  // canonical way every Mac app gets accessibility — passing `true`
  // makes macOS itself show the standard system dialog with a working
  // "Open System Settings" button that goes to the exact right pane.
  // No URL scheme guessing, no password manager hijack risk. The dialog
  // only shows once per app launch and only if not already trusted, so
  // the renderer should call this ONCE when the user clicks "Open
  // System Settings" — after that, falls back to opening Settings
  // manually if the user dismissed it.
  ipcMain.handle('streamdeck:promptAccessibility', () => {
    if (process.platform !== 'darwin') return true
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { systemPreferences } = require('electron')
      return systemPreferences.isTrustedAccessibilityClient(true)
    } catch {
      return false
    }
  })
  // Bulletproof: open System Settings (or System Preferences) by app
  // name with NO URL scheme involved. No deep-linking, no password
  // manager hijack, no pane id guessing. The user navigates manually
  // using the modal's instructions.
  ipcMain.handle('streamdeck:openSettingsApp', () => openSettingsAppPlain())
  // Reveal the running app's .app bundle in Finder so the user can
  // drag it into the Accessibility list. In dev mode this is
  // Electron.app; in production it's PlexiDesk.app.
  ipcMain.handle('streamdeck:revealAppInFinder', () => revealAppBundleInFinder())
  // Universal SpeedDeck — same buttons across every task, every folder.
  // The renderer reads on widget mount and writes on every edit; this
  // way every SpeedDeck widget set to "Universal" scope shares the
  // same persistent deck.
  ipcMain.handle('speeddeck:loadUniversal', () => loadUniversalDeck())
  ipcMain.handle('speeddeck:saveUniversal', (_e, json: string) =>
    saveUniversalDeck(json)
  )

  ipcMain.handle(
    'widgetLinks:create',
    (_e, sourceWidgetId: string, targetWidgetId: string, taskId: string, type?: WireType, id?: string) => {
      const link = createLink(sourceWidgetId, targetWidgetId, taskId, type ?? 'context', id)
      // A link the user drew IS a relationship: mirror it into the graph as a
      // confirmed RelatedTo, so the connection feeds context.related, decision-risk
      // propagation and Assemble's related-surfacing (widget-link-owner approved,
      // all wire types). Idempotent; self-loops already blocked by createLink.
      if (link) {
        mirrorUserRelation(link.sourceWidgetId, link.targetWidgetId, link.id, 'user linked these widgets')
      }
      return link
    }
  )
  // updateLink only changes wire behaviour (enable/disable/retype); the
  // relationship exists as long as the link does, so the mirror is untouched here.
  ipcMain.handle('widgetLinks:update', (_e, id: string, patch: WireUpdate) =>
    updateLink(id, patch)
  )
  ipcMain.handle('widgetLinks:delete', (_e, id: string) => {
    const link = getLink(id)
    const ok = deleteLink(id)
    // Remove the mirrored relationship only when no other link still connects the
    // pair in EITHER direction (widget_links allows independent A->B and B->A).
    if (link) {
      const a = link.sourceWidgetId
      const b = link.targetWidgetId
      const stillLinked = listLinksByTask(link.taskId).some(
        (l) =>
          (l.sourceWidgetId === a && l.targetWidgetId === b) ||
          (l.sourceWidgetId === b && l.targetWidgetId === a)
      )
      if (!stillLinked) unmirrorUserRelation(a, b)
    }
    return ok
  })
  // Wire run history — durable before/after of every reactive-wire write, so the
  // user can see what an automation did and revert it (the trust layer).
  ipcMain.handle('wireRuns:record', (_e, input: WireRunInput) => recordWireRun(input))
  ipcMain.handle('wireRuns:listByWire', (_e, wireId: string, limit?: number) =>
    listWireRunsByWire(wireId, limit)
  )
  ipcMain.handle('wireRuns:listByTask', (_e, taskId: string, limit?: number) =>
    listWireRunsByTask(taskId, limit)
  )
  // Outbound webhook POST (Lever 3, Phase 0). Runs in main so there's no CORS and
  // the desk's data goes straight out to the user's URL. https/http only; bounded
  // by a timeout so a dead endpoint can't hang a wire. Returns an honest result —
  // never a fabricated success — so the wire's run status reflects reality.
  ipcMain.handle(
    'webhooks:send',
    async (
      _e,
      input: { url: string; method?: string; body?: string; contentType?: string }
    ): Promise<{ ok: boolean; status?: number; error?: string }> => {
      const url = (input.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Enter a valid http(s) URL.' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      try {
        const res = await fetch(url, {
          method: input.method?.toUpperCase() === 'PUT' ? 'PUT' : 'POST',
          headers: { 'content-type': input.contentType || 'application/json' },
          body: input.body ?? '',
          signal: controller.signal
        })
        return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: controller.signal.aborted ? 'Request timed out.' : msg }
      } finally {
        clearTimeout(timer)
      }
    }
  )
  // One-time-ish: mirror widget links that existed before links fed the graph, so
  // historical connections also surface as related. Idempotent, non-fatal.
  ceBackfillWidgetLinkRelations()

  // Desk time-travel snapshots.
  ipcMain.handle('snapshots:create', (_e, taskId: string, label?: string) =>
    createSnapshot(taskId, listWidgetsByTask(taskId), label ?? '')
  )
  ipcMain.handle('snapshots:list', (_e, taskId: string) => listSnapshots(taskId))
  ipcMain.handle('snapshots:get', (_e, id: string) => getSnapshot(id))
  ipcMain.handle('snapshots:restore', (_e, id: string) => restoreSnapshot(id))
  ipcMain.handle('snapshots:branch', (_e, id: string, title: string) => branchSnapshot(id, title))

  // Live wires: run a transform wire. Reads the source + target content in
  // main (avoids shipping large documents over IPC twice) and returns the
  // plain-text result for the renderer to write into the target.
  ipcMain.handle(
    'wires:runTransform',
    async (_e, sourceId: string, targetId: string, verb: string, liveText?: string) => {
      const source = getWidget(sourceId)
      const target = getWidget(targetId)
      if (!source || !target) {
        return { ok: false, error: 'A wired widget no longer exists.' }
      }
      // Resolve the source to real content (an agent feeds its output; a browser
      // contributes its LIVE page text if supplied, else a server-side fetch).
      const described = await describeWidgetForAgent(source, liveText)
      return runTransformWire({
        sourceContent: described.content,
        verb,
        targetCurrentContent: target.content ?? ''
      })
    }
  )

  // Desk agents: gather the agent's wired inputs (widgets wired INTO it) in
  // main and run the standing instruction over them. Returns plain-text output
  // for the renderer to log on the agent widget. An agent wired in contributes
  // its latest OUTPUT as the input (so agents can pipeline into each other).
  ipcMain.handle(
    'agents:run',
    async (
      _e,
      agentId: string,
      taskId: string,
      instruction: string,
      liveInputs?: Record<string, string>,
      persona?: string,
      browserWcId?: number
    ) => {
      const links = listLinksByTask(taskId)
      const inputWidgets = links
        .filter((l) => l.targetWidgetId === agentId)
        .map((l) => getWidget(l.sourceWidgetId))
        .filter((w): w is NonNullable<ReturnType<typeof getWidget>> => !!w && !w.archived)
      // Resolve each input to real, readable content. A browser uses its LIVE
      // rendered text when the renderer supplied it (so logged-in pages work),
      // else a server-side fetch; a table becomes its rows, etc.
      const inputs = await Promise.all(
        inputWidgets.map((w) => describeWidgetForAgent(w, liveInputs?.[w.id]))
      )
      // Where this agent's output is auto-delivered + the FORMAT each target
      // expects, so the agent produces the right shape and doesn't ask the user
      // for "access" to write the linked page/note/table/field.
      const outputWidgets = links
        .filter((l) => l.sourceWidgetId === agentId)
        .map((l) => getWidget(l.targetWidgetId))
        .filter((w): w is NonNullable<ReturnType<typeof getWidget>> => !!w && !w.archived)
      const outputs = outputWidgets.map((w) => ({
        kind: w.kind,
        title: w.title ?? '',
        format: outputFormatHint(w)
      }))
      // Build the ACTIONABLE WIDGETS block: the real ids (and, for tables, the
      // schema + a sample of row ids) of every widget wired to this agent, so it
      // can propose precise changes (set a cell, add a row, update a note, edit a
      // doc) that come back as review cards. Only these ids are offered.
      const actionable = [...inputWidgets, ...outputWidgets]
      const seenIds = new Set<string>()
      const actionParts: string[] = []
      for (const w of actionable) {
        if (seenIds.has(w.id)) continue
        seenIds.add(w.id)
        let line = `- widgetId=${w.id} kind=${w.kind}${w.title ? ` "${w.title}"` : ''}`
        if (w.kind === 'table' && w.content) {
          const t = getTable(w.content)
          if (t) {
            const cols = t.schema.columns.map((c) => `${c.label}(id:${c.id},${c.type})`).join(', ')
            line += `\n    tableId=${w.content} columns=[${cols}]`
            const rows = listRows(w.content).slice(0, 12)
            if (rows.length > 0) {
              const firstCol = t.schema.columns[0]?.id
              const sample = rows
                .map(
                  (r) =>
                    `${r.id}="${String((firstCol && (r.cells as Record<string, unknown>)[firstCol]) ?? '').slice(0, 24)}"`
                )
                .join(', ')
              line += `\n    rowIds: ${sample}`
            }
          }
        } else if ((w.kind === 'doc' || w.kind === 'sheet' || w.kind === 'slides' || w.kind === 'map') && w.content) {
          line += `\n    documentId=${w.content}`
        }
        actionParts.push(line)
      }
      // Only enable action-proposals for non-browser agents (browser agents stay
      // research-and-report) and only when there is something real to act on.
      const actionContext = !browserWcId && actionParts.length > 0 ? actionParts.join('\n') : undefined
      return runDeskAgent({ instruction, inputs, persona, browserWcId, outputs, actionContext })
    }
  )

  ipcMain.handle('agents:designProfile', (_e, description: string) =>
    designAgentProfile(description)
  )

  // Dev metrics — per-process RAM + CPU for the whole Electron app, so the perf
  // overlay can show exactly what each browser process costs.
  ipcMain.handle('metrics:get', () => {
    return app.getAppMetrics().map((m) => ({
      pid: m.pid,
      // 'Browser' is the main process; 'Tab' is a renderer (the main window AND
      // each <webview>); plus GPU / Utility / etc.
      type: m.type,
      name: m.name ?? '',
      cpu: Math.round((m.cpu?.percentCPUUsage ?? 0) * 10) / 10,
      // workingSetSize is in KB → MB.
      memMB: Math.round((m.memory?.workingSetSize ?? 0) / 1024)
    }))
  })

  // Map every live webContents to the OS process it runs in, so the overlay can
  // label each renderer ('Tab') row with the widget that owns it. app.getAppMetrics
  // gives RAM/CPU keyed by OS pid; webContents.getOSProcessId() is the bridge.
  // The renderer joins osPid → process row, and webContentsId → widget via the
  // webview registry. type 'window' is the app's own UI window.
  ipcMain.handle('metrics:webContents', () => {
    return allWebContents.getAllWebContents().map((wc) => {
      let osPid = 0
      let title = ''
      let url = ''
      try {
        osPid = wc.getOSProcessId()
      } catch {
        /* process gone */
      }
      try {
        title = wc.getTitle()
      } catch {
        /* destroyed */
      }
      try {
        url = wc.getURL()
      } catch {
        /* destroyed */
      }
      return { webContentsId: wc.id, osPid, type: wc.getType(), title, url }
    })
  })

  // Inspect what a widget contributes when wired into an agent — for a portal,
  // its aggregated desk(s). Powers tests + a future "preview feed" affordance.
  ipcMain.handle('agents:previewInput', async (_e, widgetId: string) => {
    const w = getWidget(widgetId)
    if (!w) return { content: '' }
    const d = await describeWidgetForAgent(w)
    return { kind: d.kind, content: d.content }
  })

  ipcMain.handle('templates:list', () => listTemplates())
  ipcMain.handle(
    'templates:createFromTask',
    (
      _e,
      taskId: string,
      name: string,
      description?: string,
      widgetIds?: string[]
    ) => createTemplateFromTask(taskId, name, description, widgetIds)
  )
  ipcMain.handle('templates:delete', (_e, id: string) => deleteTemplate(id))

  ipcMain.handle('chat:send', (_e, req: ChatRequest) => {
    recordAiCall()
    return sendChat(req)
  })
  // One step of the autonomous agent loop. Stateless: the renderer drives the
  // rounds (applies actions, builds observations, calls again). Each round is a
  // real model call, so it counts as an AI call.
  ipcMain.handle(
    'agent:step',
    (
      _e,
      input: {
        goal: string
        taskId: string | null
        systemPrompt?: string
        messages: Array<{ role: 'user' | 'assistant'; content: string }>
        priorFailedCount?: number
        context?: string
      }
    ) => {
      recordAiCall()
      return runAgentStep(input)
    }
  )
  // Self-verification of a completed run: judge whether the goal was met given
  // only what was applied. One model call, so it counts as an AI call.
  ipcMain.handle('agent:verify', (_e, input: { goal: string; applied: string }) => {
    recordAiCall()
    return verifyAgentGoal(input)
  })
  // Self-building memory: list / remember (manual) / forget, plus a local-model
  // backfill over documents. Extraction is local (no cloud call), so it does not
  // count as an AI call.
  ipcMain.handle('memory:list', () => listMemories())
  ipcMain.handle('memory:remember', (_e, input: { kind: MemoryKind; text: string; subject?: string; due?: string }) =>
    addMemory({ ...input, source: 'user', confidence: 1 })
  )
  ipcMain.handle('memory:forget', (_e, id: string) => forgetMemory(id))
  ipcMain.handle('memory:extractDocuments', () => extractMemoryFromDocuments())
  // Streaming variant — retrieval, reply and each prepared action arrive on a
  // per-request channel `chat:stream:<reqId>` so the assistant can show the work
  // as it happens. Caller mints the reqId. `chat:send` above is untouched and
  // stays the fallback for every other caller.
  // Live model streams by requestId, so the composer's Stop button can abort
  // the one it started. Entries live exactly as long as their stream.
  const liveChatAborts = new Map<string, () => void>()
  ipcMain.handle('chat:cancelStream', (_e, requestId: string): { ok: boolean } => {
    const abort = liveChatAborts.get(requestId)
    if (abort) abort()
    return { ok: Boolean(abort) }
  })
  ipcMain.handle(
    'chat:sendStream',
    async (e, input: ChatRequest & { requestId: string }): Promise<{ ok: boolean }> => {
      recordAiCall()
      const channel = `chat:stream:${input.requestId}`
      const sender = e.sender
      const send = (type: string, payload?: unknown): void => {
        if (sender.isDestroyed()) return
        sender.send(channel, { type, payload })
      }
      // Forward the WHOLE request rather than re-listing its fields. The old
      // hand-built object silently dropped `mentions` and `includeMemory` —
      // every @-reference and the memory block were lost on the streaming
      // path (the normal one), while the non-streaming fallback passed them
      // through, so the two paths disagreed. Spreading also means the next
      // field added to ChatRequest cannot go missing here again.
      const { requestId: _requestId, ...chatReq } = input
      try {
        await sendChatStream(
          chatReq,
          {
            onMentions: (m) => send('mentions', m),
            onSources: (t) => send('sources', t),
            onReply: (text) => send('reply', text),
            onReplyDelta: (text) => send('reply-delta', text),
            onActivity: (a) => send('activity', a),
            onTool: (tool) => send('tool', tool),
            onQuestion: (q) => send('question', q),
            onError: (err) => send('error', err),
            onComplete: (resp) => send('complete', resp)
          },
          { onAbortReady: (abort) => liveChatAborts.set(input.requestId, abort) }
        )
      } finally {
        liveChatAborts.delete(input.requestId)
      }
      return { ok: true }
    }
  )
  ipcMain.handle('chat:hasApiKey', () => Boolean(resolveAnthropicKey()))
  ipcMain.handle('ai:dailyBrief', () => generateDailyBrief())
  // Daily standup: the assistant catch-up duo (Work-Completed look-back woven with
  // the brief look-forward) into one narrative. The caller passes the synced-per-user
  // cursor and persists the returned toCursor. Read-only + honest-degrading.
  ipcMain.handle(
    'assistant:standup',
    async (_e, input: { sinceCursor: number; scope: 'personal' | 'team'; organisationId?: string | null }) => {
      recordAiCall()
      return runStandup(input)
    }
  )
  // Save a meeting to the OS default calendar (Apple Calendar / Outlook) by
  // writing a standards .ics and opening it — the universal "add to calendar".
  // Google users use the web URL the renderer builds separately.
  ipcMain.handle(
    'calendar:addMeetingIcs',
    async (_e, ev: { roomId: string; title: string; startMs: number; durationMin: number }) => {
      try {
        const joinUrl = `haptyx://meet?room=${encodeURIComponent(ev.roomId)}`
        const ics = buildMeetingIcs({
          uid: `${ev.roomId}@plexidesk`,
          title: ev.title,
          startMs: ev.startMs,
          durationMin: ev.durationMin,
          joinUrl
        })
        const file = pathJoin(app.getPath('temp'), `plexi-meeting-${ev.roomId.replace(/[^a-z0-9]/gi, '')}.ics`)
        await writeFile(file, ics, 'utf8')
        const err = await electronShell.openPath(file)
        if (err) return { ok: false, error: err }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )
  ipcMain.handle('chat:proactiveWelcome', (_e, taskId: string) =>
    generateProactiveWelcome(taskId)
  )
  ipcMain.handle('resume:generate', (_e, taskId: string) => {
    recordAiCall()
    return generateResume(taskId)
  })
  ipcMain.handle('setup:suggest', (_e, taskId: string) => {
    recordAiCall()
    return suggestSetupWidgets(taskId)
  })
  ipcMain.handle(
    'setup:buildFromPrompt',
    (_e, input: { prompt: string; taskId: string | null }) => {
      recordAiCall()
      return buildFromPrompt(input)
    }
  )
  ipcMain.handle('livingPage:regenerate', (_e, widgetId: string) => {
    recordAiCall()
    return regenerateLivingPage(widgetId)
  })
  ipcMain.handle('ai:suggestPageContent', (_e, prompt: string) => {
    recordAiCall()
    return suggestPageContent(prompt)
  })
  ipcMain.handle('ai:routeCommand', (_e, input: { system: string; text: string }) => {
    recordAiCall()
    return routeCommandBar(input)
  })
  // In-editor document AI: formatted insert + selection rewrite.
  ipcMain.handle('ai:suggestDocContent', (_e, input: { prompt: string }) => {
    recordAiCall()
    return suggestDocContent(input)
  })
  ipcMain.handle('ai:rewriteSelection', (_e, input: { text: string; instruction: string }) => {
    recordAiCall()
    return rewriteSelection(input)
  })

  // ── Office interop for the document editor (.docx / PDF / image) ───────────
  ipcMain.handle('office:importDocx', () => importDocx())
  ipcMain.handle('design:generateImage', (_e, input: { prompt: string; width?: number; height?: number }) => generateImage(input))
  ipcMain.handle('design:export', (_e, input: { design: DesignBody; title: string; format: 'png' | 'pdf' }) => exportDesign(input))
  ipcMain.handle('map:export', (_e, input: Parameters<typeof exportMap>[0]) => exportMap(input))
  ipcMain.handle('map:import', () => importVsdx())
  ipcMain.handle('design:searchPhotos', (_e, input: { query: string; perPage?: number }) => searchStockPhotos(input))
  ipcMain.handle('design:fetchImage', (_e, input: { url: string }) => fetchImageDataUrl(input))
  ipcMain.handle('design:removeBackground', (_e, input: { dataUrl: string }) => removeBackground(input))
  ipcMain.handle('brand:get', () => ({ kit: getBrandKit(), isSet: hasBrandKit() }))
  ipcMain.handle('brand:set', (_e, kit: OrgBrandKit) => saveBrandKit(kit))
  ipcMain.handle('design:generateContent', (_e, input: { prompt: string; designKind: string; audience?: string }) =>
    generateDesignContent(input)
  )
  ipcMain.handle('design:generateVariations', (_e, input: { prompt: string; designKind: string; count?: number; audience?: string }) =>
    generateDesignVariations(input)
  )
  ipcMain.handle('office:exportDocx', (_e, input: { html: string; title: string; page?: PageSetupInput }) => exportDocx(input))
  ipcMain.handle('office:exportPdf', (_e, input: { html: string; title: string; page?: PageSetupInput }) => exportPdf(input))
  ipcMain.handle('office:pickImage', () => pickImage())

  // ── Spreadsheet interop + AI fill ─────────────────────────────────────────
  ipcMain.handle('sheet:import', () => importSheet())
  ipcMain.handle('sheet:export', (_e, input: Parameters<typeof exportSheet>[0]) => exportSheet(input))
  ipcMain.handle('sheet:runMacro', (_e, input: { tab: Parameters<typeof runSheetMacro>[0]; code: string }) =>
    runSheetMacro(input.tab, input.code)
  )
  ipcMain.handle('ai:suggestSheetColumns', (_e, input: { prompt: string; existing?: string[] }) => {
    recordAiCall()
    return suggestSheetColumns(input)
  })
  ipcMain.handle(
    'ai:suggestFormula',
    (_e, input: { prompt: string; headers: string[]; activeRef: string; sample?: string[][] }) => {
      recordAiCall()
      return suggestFormula(input)
    }
  )
  ipcMain.handle(
    'ai:fillSheetRange',
    (_e, input: { prompt: string; headers: string[]; rangeRows: number; auto?: boolean }) => {
      recordAiCall()
      return fillSheetRange(input)
    }
  )

  // ── Slides interop + AI ───────────────────────────────────────────────────
  ipcMain.handle('slides:export', (_e, input: Parameters<typeof exportSlides>[0]) => exportSlides(input))
  ipcMain.handle('slides:import', () => importPptx())
  ipcMain.handle('documents:generateSlides', (_e, input: { mode: 'deck' | 'append' | 'redesign'; prompt: string }) => {
    recordAiCall()
    return generateSlideElements(input)
  })

  // ── AI source: PlexiDesk credits vs bring-your-own-key ────────────────────
  // Status snapshot for the settings panel + out-of-credits prompts.
  ipcMain.handle('ai:getStatus', () => getAiStatus())
  // Switch source; invalidate the cached client so the next call honours it.
  ipcMain.handle('ai:setMode', (_e, mode: AiMode) => {
    setAiMode(mode)
    invalidateAnthropicClient()
    return getAiStatus()
  })
  // Pull the live balance from the signal server (lazily grants the trial).
  ipcMain.handle('ai:refreshCredits', () => refreshCredits())
  // Begin a Stripe checkout for a credit top-up and open it in the browser.
  ipcMain.handle('ai:topUpCredits', async (_e, amountUsd: number) => {
    const result = await startTopUp(amountUsd)
    if (result.ok && result.url) {
      await shell.openExternal(result.url)
    }
    return result
  })
  // Telemetry snapshot for the renderer to report to the signal server.
  ipcMain.handle('telemetry:collect', () => collectTelemetry())
  // Crash telemetry (WS03): the renderer forwards render-side errors here, and
  // the whole recent crash log is readable back for inspection.
  ipcMain.handle('crash:report', (_e, input: Parameters<typeof recordCrash>[0]) =>
    recordCrash({ ...input, source: 'renderer' })
  )
  ipcMain.handle('crash:list', (_e, limit?: number) => listCrashes(limit))
  // Forwarding: the renderer reads not-yet-sent crashes, POSTs them to the signal
  // server (it holds the session token), then marks them forwarded.
  ipcMain.handle('crash:unforwarded', (_e, limit?: number) => listUnforwarded(limit))
  ipcMain.handle('crash:markForwarded', (_e, ids: string[]) => markForwarded(ids))
  // WS01 sync substrate: the renderer's CRDT engine persists every widget event
  // here (offline queue + local record) and reads back what it hasn't synced.
  ipcMain.handle('crdt:record', (_e, input: ChangeRecordInput) => recordChangeEvent(input))
  ipcMain.handle('crdt:unsynced', (_e, limit?: number) => unsyncedChangeEvents(limit))
  ipcMain.handle('crdt:markSynced', (_e, entries: Array<{ id: string; seq?: number | null }>) =>
    markChangeSynced(entries)
  )
  ipcMain.handle('crdt:knownIds', (_e, ids: string[]) => knownChangeIds(ids))
  ipcMain.handle('crdt:eventsForObject', (_e, objectId: string) => changeEventsForObject(objectId))
  // Persist onboarding progress locally so it rides the next telemetry snapshot.
  ipcMain.handle(
    'onboarding:record',
    (_e, summary: { coreCompleted: boolean; modulesCompleted: number }) => setOnboardingSummary(summary)
  )
  ipcMain.handle(
    'ai:transformText',
    (_e, input: { text: string; instruction: string; kind?: string }) => {
      recordAiCall()
      return transformText(input)
    }
  )
  ipcMain.handle(
    'ai:suggestWidgetSetup',
    (_e, input: { widgetId: string; prompt?: string }) => {
      recordAiCall()
      return suggestWidgetSetup(input)
    }
  )
  ipcMain.handle(
    'ai:suggestTableRows',
    (_e, tableId: string, prompt: string, count: number) => {
      recordAiCall()
      return suggestTableRows(tableId, prompt, count)
    }
  )

  ipcMain.handle(
    'history:record',
    (_e, url: string, title: string, taskId: string | null, countsAsVisit?: boolean) =>
      recordVisit(url, title, taskId, countsAsVisit ?? true)
  )
  ipcMain.handle('history:recent', (_e, limit: number, taskId?: string | null) =>
    getRecentHistory(limit, taskId ?? null)
  )

  ipcMain.handle('focus:start', (_e, draft: FocusSessionStartDraft) =>
    startFocusSession(draft)
  )
  ipcMain.handle(
    'focus:complete',
    (_e, id: string, patch: FocusSessionCompletePatch) => completeFocusSession(id, patch)
  )
  ipcMain.handle('focus:recent', (_e, limit: number, taskId?: string | null) =>
    listRecentSessions(limit, taskId ?? null)
  )

  // Focus-Mode clusters (split "groups") — per-desk saved split layouts.
  ipcMain.handle('clusters:list', (_e, taskId: string) => listClustersForTask(taskId))
  ipcMain.handle('clusters:save', (_e, draft: FocusClusterDraft) => saveCluster(draft))
  ipcMain.handle('clusters:delete', (_e, id: string) => {
    deleteCluster(id)
  })

  ipcMain.handle('trail:record', (_e, draft: ActivityRecordDraft) => recordActivity(draft))
  ipcMain.handle(
    'trail:recent',
    (_e, taskId: string | null, sinceMs: number, limit: number) =>
      getRecentActivity({ taskId, sinceMs, limit })
  )
  ipcMain.handle(
    'trail:summarize',
    (_e, taskId: string | null, sinceMs: number) => summarizeRecentTrail(taskId, sinceMs)
  )

  ipcMain.handle('model:get', () => getModelMode())
  ipcMain.handle('model:set', (_e, mode: ModelMode) => setModelMode(mode))

  ipcMain.handle(
    'bodyDouble:tick',
    (_e, taskId: string | null, recentMessages: string[]) =>
      generatePresenceNarration(taskId, recentMessages)
  )

  ipcMain.handle('smartStack:propose', (_e, taskId: string) => proposeSmartStacks(taskId))

  ipcMain.handle('connectedApps:list', () => listConnectedApps())
  ipcMain.handle('connectedApps:create', (_e, draft: ConnectedAppDraft) =>
    createConnectedApp(draft)
  )
  ipcMain.handle(
    'connectedApps:update',
    (_e, id: string, patch: ConnectedAppPatch) => updateConnectedApp(id, patch)
  )
  ipcMain.handle('connectedApps:delete', (_e, id: string) => deleteConnectedApp(id))
  ipcMain.handle('connectedApps:reorder', (_e, ids: string[]) =>
    reorderConnectedApps(ids)
  )
  ipcMain.handle('connectedApps:touch', (_e, id: string) => touchConnectedApp(id))
  ipcMain.handle('connectedApps:findByHostname', (_e, hostname: string) =>
    findConnectedAppByHostname(hostname)
  )

  // ── Local app launcher ─────────────────────────────────────────────────────
  // Surfaces native-app management to the renderer. Only the picker can open a
  // file dialog (main-process only); the rest can be called from anywhere.
  ipcMain.handle('localApp:pick', () => pickLocalApp())
  ipcMain.handle('localApp:describe', (_e, appPath: string) =>
    describeLocalApp(appPath)
  )
  ipcMain.handle(
    'localApp:launch',
    (_e, input: { appPath: string | null; bundleId: string | null }) =>
      launchLocalApp(input)
  )
  ipcMain.handle(
    'localApp:isRunning',
    (_e, input: { appPath: string | null; title: string }) =>
      isLocalAppRunning(input)
  )
  ipcMain.handle('localApp:refreshIcon', (_e, appPath: string) =>
    refreshAppIcon(appPath)
  )

  // ── Dashboard layouts (Phase 6) ───────────────────────────────────────────
  ipcMain.handle('dashboard:getLayout', (_e, key: string) => getDashboardLayout(key))
  ipcMain.handle(
    'dashboard:setLayout',
    (_e, key: string, input: DashboardCardKind[] | DashboardLayoutInput) =>
      setDashboardLayout(key, input)
  )
  ipcMain.handle('dashboard:resetLayout', (_e, key: string) =>
    deleteDashboardLayout(key)
  )

  // ── Active organisation (multi-org tenancy) ───────────────────────────────
  // The active org is the tenancy boundary for the local workspace. Reading it
  // is what every org-scoped query filters by; setting it (from the org switcher)
  // persists so the choice survives a restart. The renderer reloads its stores
  // after a set so every surface reflects the new org.
  ipcMain.handle('session:getActiveOrg', () => getActiveOrgId())
  ipcMain.handle('session:setActiveOrg', (_e, orgId: string) => setActiveOrgId(orgId))

  // ── Vault (Phase 7) ───────────────────────────────────────────────────────
  ipcMain.handle('vault:meta', () => getVaultMeta())
  ipcMain.handle('vault:isUnlocked', () => isUnlocked())
  ipcMain.handle('vault:create', (_e, master: string) => createVault(master))
  ipcMain.handle('vault:unlock', (_e, master: string) => unlockVault(master))
  ipcMain.handle('vault:lock', () => {
    lockVault()
  })
  ipcMain.handle('vault:listEntries', () => listEntries())
  ipcMain.handle('vault:createEntry', (_e, draft: VaultEntryDraft) =>
    createEntry(draft)
  )
  ipcMain.handle(
    'vault:updateEntry',
    (_e, id: string, patch: VaultEntryPatch) => updateEntry(id, patch)
  )
  ipcMain.handle('vault:deleteEntry', (_e, id: string) => deleteEntry(id))
  ipcMain.handle(
    'vault:changeMasterPassword',
    (_e, currentPassword: string, newPassword: string) =>
      changeMasterPassword(currentPassword, newPassword)
  )
  ipcMain.handle('vault:encrypt', (_e, plaintext: string) => encryptWithMaster(plaintext))
  ipcMain.handle('vault:decrypt', (_e, iv: string, ciphertext: string) =>
    decryptWithMaster(iv, ciphertext)
  )

  // ── Energy log ────────────────────────────────────────────────────────────
  ipcMain.handle('energy:log', (_e, level: EnergyLevel) => logEnergy(level))
  ipcMain.handle('energy:current', () => currentEnergy())
  ipcMain.handle('energy:recent', (_e, hours: number) => recentEnergy(hours))

  // ── Calendar time blocks ────────────────────────────────────────────────
  ipcMain.handle('timeblocks:list', (_e, fromMs: number, toMs: number) => {
    // Keep repeating series materialised ahead whenever the calendar is read;
    // idempotent and cheap (each series continues from its newest row).
    materializeRecurringBlocks()
    return listBlocksInRange(fromMs, toMs)
  })
  ipcMain.handle('timeblocks:create', (_e, draft: TimeBlockDraft) => createTimeBlock(draft))
  ipcMain.handle('timeblocks:update', (_e, id: string, patch: TimeBlockPatch) =>
    updateTimeBlock(id, patch)
  )
  ipcMain.handle('timeblocks:delete', (_e, id: string, scope?: 'one' | 'series') =>
    deleteTimeBlock(id, scope ?? 'one')
  )

  // ── Mac haptics ───────────────────────────────────────────────────────────
  ipcMain.handle('haptics:available', () => isHapticsAvailable())
  ipcMain.handle('haptics:fire', (_e, feel: HapticFeel) => fireHaptic(feel))

  // ── Files (uploads, attachments, previews) ────────────────────────────────
  ipcMain.handle('files:ingestPath', (_e, sourcePath: string) =>
    ingestFromPath(sourcePath)
  )
  // Recursively import a whole local folder into the Drive under `parentId`, so it
  // becomes part of the workspace + brain. Shows a directory picker.
  ipcMain.handle('fileManager:importFolder', async (_e, parentId: string | null) => {
    const parent = BrowserWindow.getFocusedWindow()
    const opts = { title: 'Import a folder into your Drive', properties: ['openDirectory' as const] }
    const open = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
    if (open.canceled || open.filePaths.length === 0) return { ok: false as const, canceled: true as const }
    const res = importFolderTree(open.filePaths[0], parentId ?? null)
    return { ok: true as const, ...res }
  })
  ipcMain.handle(
    'files:ingestBuffer',
    (
      _e,
      input: { buffer: ArrayBuffer; originalName: string; mimeType: string; parentId?: string | null }
    ) =>
      ingestFromBuffer({
        buffer: new Uint8Array(input.buffer),
        originalName: input.originalName,
        mimeType: input.mimeType,
        parentId: input.parentId ?? null
      })
  )
  ipcMain.handle('files:get', (_e, id: string) => getFile(id))
  ipcMain.handle('files:delete', (_e, id: string) => deleteFile(id))

  // Document export — the markdown widget (and any rich-text surface) hands us
  // a fully self-contained, styled HTML string. We save it as a standalone
  // .html file, or render it in a hidden window and printToPDF for a clean PDF,
  // writing either through the native save dialog so the user picks the spot.
  // ── Workspace backup / export / restore ─────────────────────────────────
  // A backup is one consistent SQLite snapshot. Export writes it where the user
  // chooses; restore validates a chosen file, snapshots current data for safety,
  // swaps it in, and reports back so the renderer can reload onto the new data.
  ipcMain.handle('backup:info', () => backupInfo())
  ipcMain.handle('backup:export', async () => {
    const parent = BrowserWindow.getFocusedWindow()
    const opts = {
      title: 'Export a PlexiDesk backup',
      defaultPath: defaultExportName(),
      filters: [{ name: 'PlexiDesk backup', extensions: ['fbbackup'] }]
    }
    const { canceled, filePath } = parent
      ? await dialog.showSaveDialog(parent, opts)
      : await dialog.showSaveDialog(opts)
    if (canceled || !filePath) return { ok: false as const, canceled: true as const }
    try {
      await createBackup(filePath)
      return { ok: true as const, path: filePath }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })
  ipcMain.handle('backup:restore', async () => {
    const parent = BrowserWindow.getFocusedWindow()
    const open = parent
      ? await dialog.showOpenDialog(parent, {
          title: 'Restore from a PlexiDesk backup',
          properties: ['openFile'],
          filters: [{ name: 'PlexiDesk backup', extensions: ['fbbackup', 'db'] }]
        })
      : await dialog.showOpenDialog({
          title: 'Restore from a PlexiDesk backup',
          properties: ['openFile'],
          filters: [{ name: 'PlexiDesk backup', extensions: ['fbbackup', 'db'] }]
        })
    if (open.canceled || open.filePaths.length === 0) {
      return { ok: false as const, canceled: true as const }
    }
    const src = open.filePaths[0]
    const valid = validateBackupFile(src)
    if (!valid.ok) return { ok: false as const, error: valid.error }

    // Destructive: replacing all current data. Confirm explicitly first.
    const confirmOpts = {
      type: 'warning' as const,
      buttons: ['Cancel', 'Replace my data'],
      defaultId: 0,
      cancelId: 0,
      title: 'Restore from backup',
      message: 'Replace all your current data with this backup?',
      detail:
        'Your current data will be snapshotted first (you can recover it from the backups folder), then replaced. PlexiDesk will reload when done.'
    }
    const { response } = parent
      ? await dialog.showMessageBox(parent, confirmOpts)
      : await dialog.showMessageBox(confirmOpts)
    if (response !== 1) return { ok: false as const, canceled: true as const }

    const result = await restoreFromFile(src)
    if (!result.ok) return { ok: false as const, error: result.error }
    return { ok: true as const, safetyBackupPath: result.safetyBackupPath }
  })
  ipcMain.handle('backup:revealFolder', () => {
    electronShell.openPath(backupInfo().dir)
    return { ok: true as const }
  })

  ipcMain.handle(
    'export:html',
    async (_e, input: { html: string; suggestedName: string }) => {
      const name = input.suggestedName.replace(/\.html?$/i, '') || 'note'
      const parent = BrowserWindow.getFocusedWindow()
      const opts = { defaultPath: `${name}.html`, filters: [{ name: 'HTML', extensions: ['html'] }] }
      const { canceled, filePath } = parent
        ? await dialog.showSaveDialog(parent, opts)
        : await dialog.showSaveDialog(opts)
      if (canceled || !filePath) return { ok: false as const }
      await writeFile(filePath, input.html, 'utf8')
      return { ok: true as const, path: filePath }
    }
  )
  ipcMain.handle(
    'export:pdf',
    async (_e, input: { html: string; suggestedName: string }) => {
      const name = input.suggestedName.replace(/\.pdf$/i, '') || 'note'
      const parent = BrowserWindow.getFocusedWindow()
      const opts = { defaultPath: `${name}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] }
      const { canceled, filePath } = parent
        ? await dialog.showSaveDialog(parent, opts)
        : await dialog.showSaveDialog(opts)
      if (canceled || !filePath) return { ok: false as const }
      const render = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
      try {
        await render.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(input.html))
        const pdf = await render.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          margins: { marginType: 'default' }
        })
        await writeFile(filePath, pdf)
      } finally {
        render.destroy()
      }
      return { ok: true as const, path: filePath }
    }
  )
  // Extract readable plain text from a file (PDF/Word/spreadsheet/text). Used by
  // wires + desk agents + the brain to read file CONTENTS; also lets the UI show
  // "what's in this file". Returns null for a binary with no text.
  ipcMain.handle('files:extractText', (_e, id: string) => extractFileText(id))
  // Sync the whole workspace (desks, documents, notes/pages, Drive files) into the
  // PlexiBrain knowledge base. Idempotent; returns honest counts.
  ipcMain.handle('brain:ingestWorkspace', () => ingestWorkspaceIntoBrain())
  ipcMain.handle('files:read', (_e, id: string) => {
    const r = readFileBytes(id)
    if (!r) return null
    // Buffer → ArrayBuffer for the IPC bridge so the renderer can wrap in a Blob.
    return {
      mimeType: r.mimeType,
      buffer: r.bytes.buffer.slice(
        r.bytes.byteOffset,
        r.bytes.byteOffset + r.bytes.byteLength
      )
    }
  })
  // pickAndIngest: opens the native file picker AND copies the chosen file
  // into userData/files in one round-trip. Returns the new FbFile or null
  // if the user cancelled.
  ipcMain.handle(
    'files:pickAndIngest',
    (_e, opts?: { title?: string; defaultPath?: string }) =>
      pickAndIngestFile(opts ?? {})
  )
  // QuickLook-backed thumbnail for any ingested file. Cached on disk by file
  // id + size, regenerated only on cache miss.
  ipcMain.handle(
    'files:thumbnail',
    (_e, id: string, opts?: { size?: number }) =>
      thumbnailForFile(id, opts ?? {})
  )
  // Open a locally ingested file in the user's default app (Preview, Word,
  // VS Code, etc. — whatever Finder would open). Returns { ok } discriminated
  // result so the renderer can surface error toasts.
  ipcMain.handle('files:open', (_e, id: string) => openLocalFile(id))
  // Open a remote URL in the user's default browser. Allowed only for
  // http: / https: — other protocols return { ok: false, error }.
  ipcMain.handle('files:openExternal', (_e, url: string) => openExternalUrl(url))

  // ── File / folder manager ─────────────────────────────────────────────────
  // fb_files doubles as a foldered library: folders, imported external files,
  // and references to internal documents. Handlers are thin wrappers over the
  // db/files manager functions plus OS-level pick/reveal in filePreviews.
  ipcMain.handle('fileManager:list', (_e, parentId: string | null) => listFileEntries(parentId))
  ipcMain.handle('fileManager:get', (_e, id: string) => getFileEntry(id))
  ipcMain.handle('fileManager:path', (_e, id: string | null) => fileFolderPath(id))
  ipcMain.handle('fileManager:createFolder', (_e, parentId: string | null, name: string, explicitId?: string) =>
    createFileFolder(parentId, name, explicitId)
  )
  ipcMain.handle('fileManager:rename', (_e, id: string, name: string) => renameFileEntry(id, name))
  ipcMain.handle('fileManager:move', (_e, id: string, newParentId: string | null) => moveFileEntry(id, newParentId))
  ipcMain.handle('fileManager:moveToOrg', (_e, id: string, orgId: string, teamId?: string | null) =>
    moveFileToOrg(String(id || ''), String(orgId || ''), teamId ?? null)
  )
  ipcMain.handle('fileManager:delete', (_e, id: string) => deleteFileEntry(id))
  ipcMain.handle('fileManager:restore', (_e, ids: string[]) => restoreFileEntries(ids))
  ipcMain.handle('fileManager:listTrashed', () => listTrashedFileEntries())
  ipcMain.handle('fileManager:restoreDeep', (_e, id: string) => restoreFileEntryDeep(id))
  ipcMain.handle('fileManager:purge', (_e, id: string) => purgeFileEntry(id))
  ipcMain.handle('fileManager:search', (_e, query: string) => searchFileEntries(query))
  ipcMain.handle('fileManager:tagsFor', (_e, fileId: string) => fileTagsFor(fileId))
  ipcMain.handle('fileManager:addTags', (_e, fileId: string, tags: string[], source?: 'user' | 'ai') =>
    addFileTags(fileId, tags, source)
  )
  ipcMain.handle('fileManager:removeTag', (_e, fileId: string, tag: string) => removeFileTag(fileId, tag))
  ipcMain.handle('fileManager:allTags', () => allFileTags())
  ipcMain.handle('fileManager:entriesByTag', (_e, tag: string) => fileEntriesByTag(tag))
  ipcMain.handle('fileManager:entriesByTags', (_e, tags: string[]) => fileEntriesByTags(tags))
  ipcMain.handle('fileManager:untaggedEntries', () => untaggedFileEntries())
  ipcMain.handle('fileManager:listSmartFolders', () => listFileSmartFolders())
  ipcMain.handle('fileManager:createSmartFolder', (_e, name: string, tags: string[], search?: string) =>
    createFileSmartFolder(name, tags, search)
  )
  ipcMain.handle('fileManager:deleteSmartFolder', (_e, id: string) => deleteFileSmartFolder(id))
  ipcMain.handle('fileManager:smartFolderEntries', (_e, tags: string[], search?: string) =>
    fileSmartFolderEntries(tags, search)
  )
  // Auto-filing: read the item's text + the existing tag vocabulary and let the
  // AI propose tags. Suggest-only; the renderer decides what to accept.
  ipcMain.handle('files:suggestTags', async (_e, fileId: string) => {
    const entry = getFileEntry(fileId)
    if (!entry) return { ok: false, error: 'Item not found' }
    let content = ''
    if (entry.kind === 'doc' && entry.docId) {
      const doc = getDocument(entry.docId)
      if (doc) content = `${doc.title}\n${extractDocText(doc.docType, doc.body)}`
    } else {
      // A binary file: only its name and type are readable for now.
      content = `File name: ${entry.name}${entry.ext ? ` (${entry.ext})` : ''}`
    }
    const existingTags = allFileTags().map((t) => t.tag)
    recordAiCall()
    return suggestFileTags(content, existingTags)
  })
  // Topic grouping for the Columns view: label each desk object with a short topic
  // so the view can lay them out as topical columns. Suggest-only; honest
  // degradation (needsApiKey) when no AI is configured.
  ipcMain.handle(
    'ai:groupByTopic',
    async (_e, items: Array<{ id: string; title: string; text: string }>) => {
      recordAiCall()
      return groupWidgetsByTopic(items)
    }
  )
  // Ask-your-workspace: retrieve the most relevant documents for the question,
  // then answer grounded in them with citations. Returns the answer plus the
  // source documents (with snippet + whether each was cited) for the UI.
  ipcMain.handle(
    'workspace:ask',
    async (_e, question: string, history?: Array<{ question: string; answer: string }>) => {
      const hist = Array.isArray(history) ? history.slice(-4) : []
      // Retrieve using the recent thread so a bare follow-up ("what about year two?")
      // still pulls the documents the conversation is actually about.
      const query = [...hist.map((h) => h.question), question].join(' ')
      const sources = await retrieveSources(query)
      const buildSourceMeta = (citedIds: Set<string>): Array<{ docId: string; title: string; docType: string; snippet: string; cited: boolean }> =>
        sources.map((s) => ({ docId: s.docId, title: s.title, docType: s.docType, snippet: s.snippet, cited: citedIds.has(s.docId) }))
      // Semantic answer cache: a near-identical question, with the workspace
      // unchanged since (version-stamped, so any doc edit invalidates it), reuses
      // the prior answer for free — no model call. Embedding is LOCAL/free.
      const qvec = await embedQuery(query)
      if (qvec) {
        const hit = lookupAnswer(qvec, Date.now())
        if (hit) {
          return {
            ok: true,
            answer: hit.answer,
            citedDocIds: hit.citedDocIds,
            cached: true,
            sources: buildSourceMeta(new Set(hit.citedDocIds)),
            proposals: [] as ActionProposal[]
          }
        }
      }
      if (sources.length) recordAiCall()
      const res = await askWorkspace(
        question,
        sources.map((s) => ({
          docId: s.docId,
          title: s.title,
          docType: s.docType,
          text: s.text,
          summary: s.summary,
          category: s.category,
          dates: s.dates,
          entities: s.entities
        })),
        hist
      )
      // Cache a successful answer for the current workspace version.
      if (res.ok && res.answer && qvec) storeAnswer(qvec, res.answer, res.citedDocIds ?? [], Date.now())
      const cited = new Set(res.citedDocIds ?? [])
      const sourceMeta = buildSourceMeta(cited)
      // "Offer to create anything": once the answer is in, let the brain propose
      // concrete things it could build from it. Approval happens in the renderer;
      // a failure here never blocks the answer.
      let proposals: ActionProposal[] = []
      if (res.ok && res.answer) {
        const suggestion = await suggestWorkspaceActions(
          question,
          res.answer,
          sources.map((s) => ({ title: s.title, docType: s.docType })),
          Date.now()
        ).catch(() => ({ ok: false as const }))
        if (suggestion.ok && 'proposals' in suggestion && suggestion.proposals) proposals = suggestion.proposals
      }
      return { ...res, sources: sourceMeta, proposals }
    }
  )
  // Streaming ask-your-workspace: same retrieval + grounding, but the answer
  // streams to the renderer over a per-request channel so it appears live.
  ipcMain.handle(
    'workspace:askStream',
    async (
      e,
      question: string,
      history: Array<{ question: string; answer: string }> | undefined,
      requestId: string,
      docContext?: { title?: string; text?: string } | null
    ) => {
      const hist = Array.isArray(history) ? history.slice(-4) : []
      // Scope: when the caller passes the open document's text, ground ONLY on it
      // (the "This document" scope); otherwise retrieve across the whole workspace.
      const sources =
        docContext && docContext.text && docContext.text.trim()
          ? [{ docId: 'current-doc', title: docContext.title || 'This document', docType: 'doc', snippet: docContext.text.slice(0, 200), text: docContext.text.slice(0, 12000), score: 1 }]
          : await retrieveSources([...hist.map((h) => h.question), question].join(' '))
      if (sources.length) recordAiCall()
      const channel = `workspace:askStream:${requestId}`
      const res = await askWorkspaceStream(
        question,
        sources.map((s) => ({
          docId: s.docId,
          title: s.title,
          docType: s.docType,
          text: s.text,
          summary: s.summary,
          category: s.category,
          dates: s.dates,
          entities: s.entities
        })),
        hist,
        (delta) => e.sender.send(channel, { type: 'delta', payload: delta })
      )
      const cited = new Set(res.citedDocIds ?? [])
      const sourceMeta = sources.map((s) => ({
        docId: s.docId,
        title: s.title,
        docType: s.docType,
        snippet: s.snippet,
        cited: cited.has(s.docId)
      }))
      // "Offer to create anything": once the answer is in, let the brain propose
      // concrete things it could build from it. Approval happens in the renderer;
      // a failure here never blocks the answer.
      let proposals: ActionProposal[] = []
      if (res.ok && res.answer) {
        const suggestion = await suggestWorkspaceActions(
          question,
          res.answer,
          sources.map((s) => ({ title: s.title, docType: s.docType })),
          Date.now()
        ).catch(() => ({ ok: false as const }))
        if (suggestion.ok && 'proposals' in suggestion && suggestion.proposals) proposals = suggestion.proposals
      }
      return { ...res, sources: sourceMeta, proposals }
    }
  )
  // The documents most related to a given one, by content overlap. No AI.
  ipcMain.handle('workspace:related', async (_e, docId: string) => {
    return relatedDocuments(docId, 5).map((s) => ({
      docId: s.docId,
      title: s.title,
      docType: s.docType,
      snippet: s.snippet
    }))
  })
  ipcMain.handle('fileManager:fileDocument', (_e, docId: string, parentId: string | null) =>
    fileDocument(docId, parentId)
  )
  ipcMain.handle('fileManager:unfiledDocuments', () => unfiledDocuments())
  ipcMain.handle('fileManager:locateDocument', (_e, docId: string) => locateDocument(docId))
  ipcMain.handle('fileManager:pickFiles', (_e, parentId: string | null) => pickFilesIntoFolder(parentId))
  ipcMain.handle('fileManager:reveal', (_e, id: string) => revealFile(id))

  // ── Voice / video note AI pipeline ────────────────────────────────────────
  // Three independently-invokable stages so the renderer can:
  //   1. Record → transcribe (calls Whisper)
  //   2. Choose Full / Cleaned / Summary → render the chosen text
  //   3. (optional) Run action extraction → preview proposals → apply
  // Each returns a tagged-union result so the renderer can branch on
  // result.ok without unwrapping exceptions.
  ipcMain.handle(
    'ai:transcribeAudio',
    (
      _e,
      input: {
        buffer?: ArrayBuffer
        mimeType?: string
        samples?: ArrayBuffer | Float32Array
        sampleRate?: number
      }
    ) => {
      // Float32Array travels via structured-clone over IPC and tends to
      // arrive intact, but defensively normalise from ArrayBuffer as
      // well (in case a serializer flattens the typed-array tag).
      let samples: Float32Array | undefined
      if (input.samples instanceof Float32Array) {
        samples = input.samples
      } else if (input.samples instanceof ArrayBuffer) {
        samples = new Float32Array(input.samples)
      }
      return transcribeAudio({
        bytes: input.buffer ? new Uint8Array(input.buffer) : undefined,
        mimeType: input.mimeType,
        samples,
        sampleRate: input.sampleRate
      })
    }
  )
  ipcMain.handle(
    'ai:processTranscript',
    (_e, input: { transcript: string; mode: ProcessMode }) =>
      processTranscript(input.transcript, input.mode)
  )
  ipcMain.handle(
    'ai:extractActionsFromTranscript',
    (_e, input: { transcript: string }) =>
      extractActionsFromTranscript(input.transcript)
  )
  ipcMain.handle(
    'ai:processMeetingEnd',
    (_e, input: { transcript: string; meetingTitle?: string; durationSec?: number | null }) =>
      processMeetingEnd(input)
  )

  // Transcription provider preference — read + write the persisted
  // choice between 'cloud' (OpenAI Whisper) and 'local' (Transformers.js).
  // Flipping to 'local' immediately fires a preload so the user doesn't
  // wait ~30s on their first recording.
  // ── Mind-mapper AI pipeline ───────────────────────────────────────────────
  // Three handlers backing the mind-map widget:
  //   - mindmap:expand        — Claude generates 3-5 child branches
  //   - mindmap:listAgents    — read .claude/agents/*.md
  //   - mindmap:suggestAgents — Claude picks 1-3 best matches per node
  ipcMain.handle(
    'mindmap:expand',
    (
      _e,
      input: {
        rootPath: string[]
        nodeLabel: string
        nodeKind?: MindMapNodeKind
        guidance?: string
      }
    ) => expandMindMapNode(input)
  )

  // workspaceResolver handles the path probing in one centralised
  // place (settings override → cwd walk → known operator paths →
  // userData fallback). Returns the inventory PLUS metadata so the
  // renderer can show "Agents from: <path>" and offer Open-in-Finder.
  ipcMain.handle('mindmap:listAgents', () => listAvailableAgents())

  // Workspace path override + Open-in-Finder. Exposed under the
  // `agents:` namespace because the resolver primarily serves the
  // agent system, but the resolved path is useful for any other
  // tool that wants to read from .claude/.
  ipcMain.handle('agents:getWorkspaceOverride', () => getWorkspaceOverride())
  ipcMain.handle(
    'agents:setWorkspaceOverride',
    (_e, path: string) => {
      setWorkspaceOverride(path)
      return { ok: true }
    }
  )
  ipcMain.handle('agents:revealInFinder', (_e, path: string) => {
    try {
      electronShell.showItemInFolder(path)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'mindmap:suggestAgents',
    (
      _e,
      input: {
        rootPath: string[]
        nodeLabel: string
        nodeKind?: MindMapNodeKind
        candidates: LocalAgent[]
      }
    ) => suggestAgentsForNode(input)
  )

  // Phase 2A — Agent creation. Generates the body via Claude Sonnet
  // and writes a new .md file to <workspace>/.claude/agents/.
  ipcMain.handle(
    'agents:create',
    (
      _e,
      input: {
        slug: string
        description: string
        model: AgentModelTier
        tools: AgentTool[]
        purpose: string
        contextPath?: string[]
      }
    ) => createAgent(input)
  )

  // Phase 2C foundation — single-turn agent invocation. Returns
  // ActionProposal[] for the renderer to review-and-apply via the
  // existing chat-side flow. NOT autonomous; user is always in the
  // loop. See agentDispatcher.ts for the PHASE_3 markers.
  ipcMain.handle(
    'agents:invoke',
    (
      _e,
      input: {
        agentPath: string
        rootPath: string[]
        nodeLabel: string
        nodeKind: string
        userMessage: string
        conversationHistory?: Array<{ role: 'user' | 'agent'; content: string }>
        conversationKey?: string
        nodeId?: string | null
      }
    ) => invokeAgent(input)
  )

  // Phase 2 polish — outcome recording + per-agent stats + undo.
  ipcMain.handle(
    'agents:recordOutcome',
    (
      _e,
      input: {
        invocationId: string
        agentSlug: string
        proposalId: string
        proposalKind: string
        action: 'applied' | 'dismissed' | 'undone'
        createdEntityRef?: string | null
      }
    ) => {
      recordOutcome(input)
      return { ok: true }
    }
  )
  ipcMain.handle(
    'agents:listInvocationsForNode',
    (_e, nodeId: string) => listInvocationsForNode(nodeId)
  )
  ipcMain.handle(
    'agents:statsForSlug',
    (_e, slug: string) => statsForSlug(slug)
  )
  ipcMain.handle('agents:undoLast', () => undoLastApply())

  ipcMain.handle('voice:getProvider', () => getTranscriptionProvider())
  ipcMain.handle('voice:setProvider', async (_e, p: TranscriptionProvider) => {
    setTranscriptionProvider(p)
    if (p === 'local') {
      const result = await preloadLocalWhisper()
      return { ok: result.ok, error: result.error }
    }
    return { ok: true }
  })

  // Voice prefs (the mascot hold + dictation UX). The voiceCommand
  // proposals ENGINE is retired (A6/B0, R30) — its sanitiser discipline
  // lives on in ai/browserAgentEnvelope.ts.
  ipcMain.handle('voiceCommand:getPrefs', () => getVoiceCommandPrefs())
  ipcMain.handle(
    'voiceCommand:setPrefs',
    (_e, patch: Parameters<typeof setVoiceCommandPrefs>[0]) =>
      setVoiceCommandPrefs(patch)
  )
  // Agentic browsing (A6/B1) — the deterministic action bridge. Every page
  // action funnels through agentBrowser:perform's single door; stop flips
  // the run's kill switch and every later action refuses. B2's loop and the
  // fake-site probe drive the same four handles.
  ipcMain.handle('agentBrowser:createRun', (_e, wcId: number) => createAgentRun(wcId))
  ipcMain.handle('agentBrowser:stopRun', (_e, runId: string) => stopAgentRun(runId))
  ipcMain.handle('agentBrowser:endRun', (_e, runId: string) => endAgentRun(runId))
  ipcMain.handle('agentBrowser:perform', (_e, runId: string, action: AgentAction) =>
    performAgentAction(runId, action)
  )
  // The agentic-browsing loop (A6/B2): start returns the runId immediately;
  // progress arrives as browserAgent:event pushes. consent answers the R26
  // pause; the grant list is reviewable and revocable (settings, B3/B4).
  ipcMain.handle(
    'browserAgent:start',
    (_e, input: { wcId: number; task: string; startUrl?: string }) => runBrowserAgent(input)
  )
  ipcMain.handle('browserAgent:stop', (_e, runId: string) => stopBrowserAgent(runId))
  ipcMain.handle(
    'browserAgent:consent',
    (_e, runId: string, granted: boolean, remember: boolean) =>
      resolveBrowserConsent(runId, granted, remember)
  )
  ipcMain.handle('browserConsent:list', () => listConsent())
  ipcMain.handle('browserConsent:revoke', (_e, host: string) => revokeConsent(host))
  // File import — system file picker, plus a content-aware converter
  // that turns .txt/.md/.csv/.json into widget drafts.
  ipcMain.handle('fileImport:pick', () => pickFileForImport())
  ipcMain.handle(
    'fileImport:run',
    (_e, args: { path: string; preferredTextKind?: ImportTargetKind }) =>
      importFile(args.path, args.preferredTextKind ?? 'page')
  )
  // Table import wizard — pick a tabular file and read it into a normalised
  // { headers, rows } grid the renderer maps onto an existing table.
  ipcMain.handle('fileImport:pickGrid', () => pickGridFileForImport())
  ipcMain.handle('fileImport:parseGrid', async (_e, path: string) => {
    const { parseGridFromFile } = await import('../gridImport')
    return parseGridFromFile(path)
  })

  // ── Tables (Notion/Airtable-style databases) ──────────────────────────────
  ipcMain.handle('tables:list', () => listTables())
  ipcMain.handle('tables:get', (_e, id: string) => getTable(id))
  ipcMain.handle('tables:create', (_e, draft: FbTableDraft) => createTable(draft))
  ipcMain.handle('tables:update', (_e, id: string, patch: FbTablePatch) =>
    updateTable(id, patch)
  )
  ipcMain.handle('tables:delete', (_e, id: string) => deleteTable(id))
  ipcMain.handle('tables:listRows', (_e, tableId: string) => listRows(tableId))
  ipcMain.handle('tables:createRow', (_e, draft: FbRowDraft) => createRow(draft))
  ipcMain.handle('tables:updateRow', (_e, id: string, patch: FbRowPatch) =>
    updateRow(id, patch)
  )
  ipcMain.handle('tables:deleteRow', (_e, id: string) => deleteRow(id))
  ipcMain.handle('tables:restoreRow', (_e, id: string) => restoreRow(id))
  ipcMain.handle('tables:reorderRows', (_e, tableId: string, ids: string[]) =>
    reorderRows(tableId, ids)
  )

  // ── PlexiBrain knowledge base ────────────────────────────────────────────
  ipcMain.handle('knowledge:list', () => listKnowledge())
  ipcMain.handle('knowledge:get', (_e, id: string) => getKnowledge(id))
  // Semantic + keyword blended search (falls back to keyword with no embed key).
  ipcMain.handle('knowledge:search', (_e, query: string) => semanticSearchKnowledge(query))
  ipcMain.handle('knowledge:create', (_e, draft: KnowledgeDraft) => {
    const entry = createKnowledge(draft)
    void embedKnowledgeEntry(entry) // best-effort index; never blocks the save
    return entry
  })
  ipcMain.handle('knowledge:update', (_e, id: string, patch: KnowledgePatch) => {
    const entry = updateKnowledge(id, patch)
    if (entry) void embedKnowledgeEntry(entry)
    return entry
  })
  ipcMain.handle('knowledge:delete', (_e, id: string) => {
    deleteEmbedding('knowledge', id)
    return deleteKnowledge(id)
  })
  // Backfill embeddings for entries that lack one (called on opening PlexiBrain).
  ipcMain.handle('knowledge:reindex', () => reindexKnowledge())
  ipcMain.handle('knowledge:semanticActive', () => knowledgeSemanticActive())

  // ── PlexiMeet meetings ───────────────────────────────────────────────────
  ipcMain.handle('meetings:list', () => listMeetings())
  ipcMain.handle('meetings:get', (_e, id: string) => getMeeting(id))
  ipcMain.handle('meetings:create', (_e, draft: MeetingDraft) => createMeeting(draft))
  ipcMain.handle('meetings:update', (_e, id: string, patch: MeetingPatch) => updateMeeting(id, patch))
  ipcMain.handle('meetings:delete', (_e, id: string) => deleteMeeting(id))

  // ── PlexiBuild apps ──────────────────────────────────────────────────────
  ipcMain.handle('apps:list', () => listApps())
  ipcMain.handle('apps:get', (_e, id: string) => getApp(id))
  ipcMain.handle('apps:create', (_e, draft: PlexiAppDraft) => createApp(draft))
  ipcMain.handle('apps:update', (_e, id: string, patch: PlexiAppPatch) => updateApp(id, patch))
  ipcMain.handle('apps:delete', (_e, id: string) => deleteApp(id))

  // ── PlexiForms forms ─────────────────────────────────────────────────────
  ipcMain.handle('forms:list', () => listForms())
  ipcMain.handle('forms:get', (_e, id: string) => getForm(id))
  ipcMain.handle('forms:create', (_e, draft: PlexiFormDraft) => createForm(draft))
  ipcMain.handle('forms:update', (_e, id: string, patch: PlexiFormPatch) => updateForm(id, patch))
  ipcMain.handle('forms:delete', (_e, id: string) => deleteForm(id))

  // ── PlexiSign signature requests ───────────────────────────────────────────
  ipcMain.handle('sign:list', () => listSignRequests())
  ipcMain.handle('sign:get', (_e, id: string) => getSignRequest(id))
  ipcMain.handle('sign:create', (_e, draft: PlexiSignDraft) => createSignRequest(draft))
  ipcMain.handle('sign:update', (_e, id: string, patch: PlexiSignPatch) => updateSignRequest(id, patch))
  ipcMain.handle('sign:delete', (_e, id: string) => deleteSignRequest(id))
  ipcMain.handle('sign:send', (_e, id: string) => sendSignRequest(id))
  ipcMain.handle('sign:sign', (_e, id: string, action: SignAction) => signSignRequest(id, action))
  ipcMain.handle('sign:decline', (_e, id: string, signerId: string, reason: string) => declineSignRequest(id, signerId, reason))
  ipcMain.handle('sign:void', (_e, id: string) => voidSignRequest(id))

  // ── haptyx:// deep-link auth handoff ─────────────────────────────────────
  // The renderer calls `auth:get-pending` on mount to drain any token that
  // arrived before the window was ready (cold-start case where the user
  // clicked the brochure "Open in Haptyx" button while the app wasn't
  // running). Subsequent tokens arrive via the `auth:incoming-token`
  // event broadcast from authProtocol.ts.
  ipcMain.handle('auth:get-pending', () => consumePendingAuthHandoff())
  // Same drain-pending pattern for a share deep link (haptyx://share?token=...).
  ipcMain.handle('share:get-pending', () => consumePendingShareToken())
  ipcMain.handle('meet:get-pending', () => consumePendingMeetRoom())
  ipcMain.handle('mdext:get-pending', () => consumePendingMdEditPath())

  // ── Auto-update ──────────────────────────────────────────────────────────
  // The renderer subscribes via the `update:state` event (broadcast from
  // autoUpdate.ts on every state transition). On mount the renderer
  // can read the current snapshot via `update:get-state` so it picks
  // up whatever state was missed before subscription.
  ipcMain.handle('update:get-state', () => getCurrentUpdateState())
  ipcMain.handle('update:check', () => {
    checkForUpdates()
    return { ok: true }
  })
  ipcMain.handle('update:install-and-restart', () => {
    installUpdateAndRestart()
    return { ok: true }
  })
  ipcMain.handle('update:open-download', () => {
    openDownloadPage()
    return { ok: true }
  })
  ipcMain.handle('update:download-and-install', () => {
    void downloadAndInstallMacUpdate()
    return { ok: true }
  })

  // First-run detection for the "What's new" modal: did this launch follow an
  // update? Authoritative because main persists the last-run version in
  // userData (the renderer can't tell a fresh install from an upgrade).
  ipcMain.handle('app:get-launch-info', () => getLaunchInfo())
  // Bring the main window to the front (used when a desktop notification is clicked).
  ipcMain.handle('app:focus-window', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
  // App-wide text size: drive Chromium page zoom so every surface (menus, lists,
  // labels, buttons) scales together. Clamped to a sensible range.
  ipcMain.handle('app:setZoomFactor', (_e, factor: number) => {
    const f = typeof factor === 'number' && factor >= 0.8 && factor <= 2 ? factor : 1
    for (const win of BrowserWindow.getAllWindows()) win.webContents.setZoomFactor(f)
  })

  // ── Settings: API-key vault ──────────────────────────────────────────────
  // Replaces the old "edit projects/focusbuddy/.env and restart" flow with
  // an in-app form. Plaintext never crosses the IPC boundary on read —
  // the renderer only sees `{ hasKey, last4 }` so the UI can render a
  // "set" / "•••• abcd" badge. Saving and testing accept plaintext one-way.

  ipcMain.handle('settings:encryptionAvailable', () => encryptionAvailable())

  // Turn a nodemailer/SMTP send failure into a short, human message. The auth
  // case is the common one — Gmail and friends reject a normal password and
  // need an app-specific one, the same as the IMAP side.
  function explainSendError(err: unknown): string {
    const e = (err ?? {}) as { code?: string; responseCode?: number; message?: string }
    const msg = [e.code, e.message].filter(Boolean).join(' ')
    if (e.code === 'EAUTH' || e.responseCode === 535 || /auth|credential|password|535/i.test(msg)) {
      return 'The mail server rejected the login when sending. Gmail, iCloud and Fastmail need an app-specific password, not your normal one.'
    }
    if (e.code === 'EENVELOPE' || /no recipients|envelope/i.test(msg)) {
      return 'The server rejected the recipients. Check the To, Cc and Bcc addresses.'
    }
    if (/ECONNECTION|ETIMEDOUT|ECONNREFUSED|timeout|ESOCKET| EDNS|ENOTFOUND/i.test(msg)) {
      return 'Could not reach the sending server. Check your connection and try again.'
    }
    return e.message || 'Sending failed.'
  }

  // ── Mail (IMAP) ────────────────────────────────────────────────────────
  // The user's own mailbox, connected directly from the desktop. The renderer
  // only ever sees host/port/user (never the password), proposes a config to
  // save+test, and asks for the message list / one full message on demand.
  // Resolve the connected account, renewing an expiring OAuth access token
  // first. Every handler below goes through this rather than getFull(), because
  // an access token only lasts about an hour and a stale one comes back from
  // the server as a bare authentication failure.
  type MailConfigResult =
    | { ok: true; config: MailAccountConfig }
    | { ok: false; error: string }

  async function currentMailAccount(): Promise<MailConfigResult> {
    try {
      const config = mailAccount.getFull()
      if (!config) return { ok: false, error: 'No mail account connected.' }
      return { ok: true, config }
    } catch (err) {
      // A failed refresh means the grant is genuinely gone. Say so plainly
      // instead of reporting an empty inbox as if the mailbox were fine.
      return { ok: false, error: (err as Error).message }
    }
  }

  ipcMain.handle('mail:getAccount', () => mailAccount.getPublic())

  // mail:oauthProviders and mail:oauthConnect handlers temporarily removed for
  // the 4.1.1 release: their ../mail/oauth and ../mail/oauthProviders modules
  // were referenced but not committed. Re-add both handlers together with those
  // modules (see the NOTE at the imports above).

  ipcMain.handle('mail:saveAccount', async (_e, config: MailAccountConfig) => {
    try {
      // Verify the credentials before persisting, so a typo never silently
      // saves a broken account.
      const result = await testMailConnection(config)
      if (!result.ok) return result
      mailAccount.save(config)
      // Drop any warm connection so the next fetch reconnects with the
      // just-saved credentials (a password change keeps the same host/user),
      // and forget the learned tone — it was sampled from the old mailbox.
      resetMailConnection()
      resetToneCache()
      return { ok: true as const, account: mailAccount.getPublic() }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('mail:testAccount', async (_e, config: MailAccountConfig) => {
    return testMailConnection(config)
  })

  ipcMain.handle('mail:clearAccount', () => {
    mailAccount.clear()
    // Close the live socket and forget the learned tone — the account they both
    // belonged to is gone.
    resetMailConnection()
    resetToneCache()
    return { ok: true as const }
  })

  ipcMain.handle('mail:list', async (e, limit?: number) => {
    const acc = await currentMailAccount()
    if (!acc.ok) return { ok: false as const, error: acc.error }
    const config = acc.config
    try {
      const items = await listInbox(config, limit ?? 40)
      // New-mail detection: any unseen uid we have not announced yet fires one
      // OS notification (batched: one banner per fetch, not one per message).
      // The cache also powers global-search mail hits (search.ts).
      const fresh = items.filter((m) => !m.seen && !announcedMailUids.has(m.uid))
      if (announcedMailUids.size > 0 && fresh.length > 0) {
        const first = fresh[0]
        const title = fresh.length === 1 ? `Mail from ${first.fromName || first.fromAddress}` : `${fresh.length} new emails`
        const body = fresh.length === 1 ? first.subject || '(no subject)' : fresh.map((f) => f.subject || '(no subject)').slice(0, 3).join(' · ')
        try {
          e.sender.send('mail:newMail', { title, body, uid: first.uid })
        } catch {
          // window gone — skip
        }
      }
      for (const m of items) if (!m.seen) announcedMailUids.add(m.uid)
      setMailSearchCache(items)
      return { ok: true as const, items }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('mail:get', async (_e, uid: number) => {
    const acc = await currentMailAccount()
    if (!acc.ok) return { ok: false as const, error: acc.error }
    try {
      const message = await getMessage(acc.config, uid)
      if (!message) return { ok: false as const, error: 'Message not found.' }
      return { ok: true as const, message }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle('mail:archive', async (_e, uid: number) => {
    const acc = await currentMailAccount()
    if (!acc.ok) return { ok: false as const, error: acc.error }
    try {
      await archiveMessage(acc.config, uid)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })
  ipcMain.handle('mail:markSeen', async (_e, uid: number) => {
    const acc = await currentMailAccount()
    if (!acc.ok) return { ok: false as const, error: acc.error }
    try {
      await markSeen(acc.config, uid)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    'mail:suggestReply',
    async (_e, incoming: { subject: string; from: string; body: string }) => {
      const acc = await currentMailAccount()
      if (!acc.ok) return { ok: false as const, error: acc.error }
      try {
        return await suggestReply(acc.config, {
          subject: incoming?.subject ?? '',
          from: incoming?.from ?? '',
          body: incoming?.body ?? ''
        })
      } catch (err) {
        return { ok: false as const, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('mail:send', async (_e, input: MailSendInput) => {
    const acc = await currentMailAccount()
    if (!acc.ok) return { ok: false as const, error: acc.error }
    const to = (input.to ?? []).map((a) => a.trim()).filter(Boolean)
    if (to.length === 0) {
      return { ok: false as const, error: 'Add at least one recipient.' }
    }
    try {
      await sendMail(acc.config, {
        to,
        cc: (input.cc ?? []).map((a) => a.trim()).filter(Boolean),
        bcc: (input.bcc ?? []).map((a) => a.trim()).filter(Boolean),
        subject: input.subject ?? '',
        text: input.text ?? '',
        inReplyTo: input.inReplyTo,
        references: input.references
      })
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: explainSendError(err) }
    }
  })

  // Lets the renderer know it is the side-by-side preview build, so sync
  // layers can refuse to run against the production backend (the preview must
  // never touch existing accounts' synced data).
  ipcMain.handle('app:isPreviewBuild', () =>
    detectPreviewBuild({ plexiAppEnv: process.env['PLEXI_APP'], execPath: process.execPath, appName: app.getName() })
  )

  // Native window background follows the renderer theme so occlusion
  // recovery, resizes and webview surface churn expose the right colour
  // instead of flashing the hardcoded light cream over a dark desk.
  ipcMain.handle('app:setBackgroundColor', (e, hex: string) => {
    if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return false
    const win = BrowserWindow.fromWebContents(e.sender)
    try {
      win?.setBackgroundColor(hex)
      return true
    } catch {
      return false
    }
  })

  // The renderer mirrors a compact chat-conversation snapshot so the AI
  // prompt builder can surface real conversation ids for post-chat drafts.
  ipcMain.handle('ai:setConversationSnapshot', (_e, convs: Array<{ id: string; label: string }>) => {
    setConversationSnapshot(Array.isArray(convs) ? convs : [])
    return true
  })

  // ── Global search ───────────────────────────────────────────────────────
  ipcMain.handle('search:query', (_e, q: string) => searchAll(typeof q === 'string' ? q : ''))

  // ── Office documents (doc / sheet / slides) ─────────────────────────────
  ipcMain.handle('documents:list', () => listDocuments())
  ipcMain.handle('documents:get', (_e, id: string) => getDocument(id))
  ipcMain.handle('documents:create', (_e, draft: DocumentDraft) => {
    const doc = createDocument(draft)
    void embedDocument(doc.id) // best-effort index; never blocks the save
    return doc
  })
  ipcMain.handle('documents:update', (_e, id: string, patch: DocumentPatch, snapshotLabel?: string) => {
    const doc = updateDocument(id, patch)
    if (doc) {
      void embedDocument(doc.id)
      // Version history: body saves accrue periodic snapshots (interval-gated
      // and deduped inside captureDocSnapshot, so this is cheap to call). A
      // label (e.g. "AI edit") bypasses the interval gate so the entry is
      // distinguishable in the history panel.
      if (patch.body !== undefined) captureDocSnapshot(id, snapshotLabel ?? '')
    }
    return doc
  })
  // "Delete" from the editors and the Documents list is a soft-delete into the
  // Documents Trash — the menu item says "Move to trash" and now means it.
  // Permanent removal is only the Trash view's explicit "Delete forever".
  ipcMain.handle('documents:delete', (_e, id: string) => {
    bumpAnswerCacheVersion() // the doc set changed — invalidate cached answers
    const ok = trashDocument(id)
    reindexDocumentChunks(id) // the doc is now trashed: its chunks come out
    return ok
  })
  ipcMain.handle('documents:listTrashed', () => listTrashedDocuments())
  ipcMain.handle('documents:restore', (_e, id: string) => {
    const ok = restoreDocument(id)
    if (ok) void embedDocument(id) // back into semantic search, best-effort
    return ok
  })
  ipcMain.handle('documents:purge', (_e, id: string) => {
    deleteEmbedding('document', id)
    bumpAnswerCacheVersion() // the doc set changed — invalidate cached answers
    const ok = deleteDocument(id)
    reindexDocumentChunks(id)
    return ok
  })
  // Version history.
  ipcMain.handle('documents:listSnapshots', (_e, docId: string) => listDocSnapshots(docId))
  ipcMain.handle('documents:restoreSnapshot', (_e, snapshotId: string) => {
    const doc = restoreDocSnapshot(snapshotId)
    if (doc) void embedDocument(doc.id)
    return doc
  })
  // Local-document comments (live docs keep theirs on the signal server).
  ipcMain.handle('docComments:list', (_e, docId: string) => listDocComments(docId))
  ipcMain.handle(
    'docComments:add',
    (_e, input: { docId: string; body: string; author: string; anchorId?: string | null; parentId?: string | null }) =>
      addDocComment(input)
  )
  ipcMain.handle('docComments:resolve', (_e, id: string, resolved: boolean) => resolveDocComment(id, resolved))
  ipcMain.handle('documents:reindex', () => reindexDocuments())
  ipcMain.handle('documents:semanticActive', () => documentSemanticActive())
  // Local-model document enrichment (Ollama). Status lets the UI show honestly
  // whether local AI is available; enrichAll distils every document into metadata
  // and then reindexes so the enriched summary/keywords feed the vectors too.
  ipcMain.handle('ai:localModelStatus', () => localModelStatus())
  ipcMain.handle('documents:metadata', (_e, docId: string) => getDocMetadata(docId))
  ipcMain.handle('documents:enrich', (_e, docId: string) => enrichDocument(docId))
  ipcMain.handle('documents:enrichAll', async (_e, force?: boolean) => {
    const res = await enrichAllDocuments(force === true)
    // Refresh vectors so the freshly-enriched metadata lands in the embeddings
    // that retrieval ranks on. Best-effort: a missing embedder just leaves the
    // metadata for the grounding header, which still helps.
    if (res.enriched > 0) await reindexDocuments(true).catch(() => ({ embedded: 0 }))
    return res
  })

  // Persisted AI-assistant chat history (local, free-standing conversations) —
  // backs the Focus-Mode chat surface.
  ipcMain.handle('aiChat:listConversations', () => listAiChatConversations())
  ipcMain.handle('aiChat:getConversation', (_e, id: string) => getAiChatConversation(id))
  ipcMain.handle(
    'aiChat:createConversation',
    (
      _e,
      input: {
        taskId: string | null
        title?: string
        context?: AiChatConversationContext | null
        mode?: import('@shared/types').AiChatMode
        webSearch?: boolean
      }
    ) => createAiChatConversation(input)
  )
  ipcMain.handle(
    'aiChat:setConversationMode',
    (_e, id: string, mode: import('@shared/types').AiChatMode) => setAiChatConversationMode(id, mode)
  )
  ipcMain.handle(
    'aiChat:setConversationWebSearch',
    (_e, id: string, on: boolean) => setAiChatConversationWebSearch(id, !!on)
  )
  ipcMain.handle(
    'aiChat:appendMessage',
    (
      _e,
      conversationId: string,
      message: {
        role: 'user' | 'assistant' | 'system'
        content: string
        ts: number
        proposals?: ActionProposal[]
        applied?: Record<string, AppliedProposal>
        sources?: ChatSource[]
        question?: ChatQuestion | null
        trace?: StoredTrace | null
        mentions?: ChatMentionRef[]
      }
    ) => appendAiChatMessage(conversationId, message)
  )
  ipcMain.handle(
    'aiChat:setMessageApplied',
    (_e, conversationId: string, messageId: string, applied: Record<string, AppliedProposal>) =>
      setAiChatMessageApplied(messageId, conversationId, applied)
  )
  ipcMain.handle('aiChat:renameConversation', (_e, id: string, title: string) =>
    renameAiChatConversation(id, title)
  )
  ipcMain.handle('aiChat:deleteConversation', (_e, id: string) => deleteAiChatConversation(id))
  ipcMain.handle(
    'aiChat:linkDesk',
    (_e, conversationId: string, taskId: string, makePrimary?: boolean) =>
      linkAiChatDesk(conversationId, taskId, makePrimary)
  )

  // People the renderer has genuinely fetched from the signal server, handed to
  // the main process so @-mentions can resolve one (Phase 4.7). Same shape as
  // the mail search cache: main knows only what the app actually loaded.
  ipcMain.handle('people:setDirectory', (_e, people: DirectoryPerson[]) =>
    setPeopleDirectory(Array.isArray(people) ? people : [])
  )

  // PlexiProjects: project plans, the Gantt schedule, dependencies and reschedule.
  ipcMain.handle('projects:list', () => listProjectSummaries())
  ipcMain.handle('projects:plan', (_e, projectId: string) => getProjectPlan(projectId))
  ipcMain.handle('projects:setTaskPlan', (_e, taskId: string, patch: PlanTaskPatch) =>
    setTaskPlan(taskId, patch)
  )
  ipcMain.handle('projects:addDep', (_e, predId: string, succId: string, type?: DepType, lag?: number) =>
    addDependency(predId, succId, type ?? 'FS', lag ?? 0)
  )
  ipcMain.handle('projects:setDep', (_e, predId: string, succId: string, type: DepType, lag: number) =>
    setDependency(predId, succId, type, lag)
  )
  ipcMain.handle('projects:removeDep', (_e, predId: string, succId: string) =>
    removeDependency(predId, succId)
  )
  ipcMain.handle('projects:reschedule', (_e, projectId: string) => rescheduleProject(projectId))
  ipcMain.handle('projects:captureBaseline', (_e, projectId: string, name: string) => captureBaseline(projectId, name))
  ipcMain.handle('projects:listBaselines', (_e, projectId: string) => listBaselines(projectId))
  ipcMain.handle('projects:getCalendar', (_e, projectId: string) => loadProjectCalendar(projectId))
  ipcMain.handle('projects:setCalendar', (_e, projectId: string, cal: WorkingCalendar) => saveProjectCalendar(projectId, cal))
  ipcMain.handle('projects:level', (_e, projectId: string) => levelResources(projectId))
  ipcMain.handle('projects:exportXml', async (_e, projectId: string) => {
    const plan = getProjectPlan(projectId)
    const xml = toProjectXml(plan)
    const parent = BrowserWindow.getFocusedWindow()
    const safe = (plan.title || 'project').replace(/[^a-z0-9-_ ]/gi, '').trim() || 'project'
    const opts = {
      title: 'Export to Microsoft Project (XML)',
      defaultPath: `${safe}.xml`,
      filters: [{ name: 'Microsoft Project XML', extensions: ['xml'] }]
    }
    const { canceled, filePath } = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
    if (canceled || !filePath) return { ok: false as const, canceled: true as const }
    try {
      await writeFile(filePath, xml, 'utf8')
      return { ok: true as const, path: filePath }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  // PlexiReports: scheduled, AI-narrated reports over your tables.
  ipcMain.handle('reports:list', () => listReports())
  ipcMain.handle('reports:get', (_e, id: string) => getReport(id))
  ipcMain.handle('reports:create', (_e, draft: ReportDraft) => createReport(draft))
  ipcMain.handle('reports:update', (_e, id: string, patch: ReportPatch) => updateReport(id, patch))
  ipcMain.handle('reports:delete', (_e, id: string) => deleteReport(id))
  ipcMain.handle('reports:generate', (_e, id: string) => generateReport(id))
  ipcMain.handle('reports:runDue', () => runDueReports())

  // PlexiFlow: trigger-and-action automations across the workspace.
  ipcMain.handle('flows:list', () => listFlows())
  ipcMain.handle('flows:get', (_e, id: string) => getFlow(id))
  ipcMain.handle('flows:create', (_e, draft: FlowDraft) => createFlow(draft))
  ipcMain.handle('flows:update', (_e, id: string, patch: FlowPatch) => updateFlow(id, patch))
  ipcMain.handle('flows:delete', (_e, id: string) => deleteFlow(id))
  ipcMain.handle('flows:run', (_e, id: string) => runFlow(id))
  ipcMain.handle('flows:runDue', () => runDueFlows())

  // PlexiAPI: the local REST server and its scoped tokens. Off by default; the
  // server only ever binds to 127.0.0.1.
  function apiStatus(): { enabled: boolean; port: number; host: string; running: boolean } {
    const cfg = getApiConfig()
    return { enabled: cfg.enabled, port: cfg.port, host: '127.0.0.1', running: isApiServerRunning() }
  }
  ipcMain.handle('api:status', () => apiStatus())
  ipcMain.handle('api:setEnabled', async (_e, enabled: boolean) => {
    setApiConfig({ enabled })
    if (enabled) {
      const r = await startApiServer(getApiConfig().port)
      if (!r.ok) {
        setApiConfig({ enabled: false })
        return { ...apiStatus(), error: r.error }
      }
    } else {
      await stopApiServer()
    }
    return apiStatus()
  })
  ipcMain.handle('api:setPort', async (_e, port: number) => {
    if (!isValidApiPort(port)) return { ...apiStatus(), error: 'Port must be a whole number between 1024 and 65535.' }
    if (isApiServerRunning()) {
      // Rebind atomically: try the new port before committing it, and fall back
      // to the previous port on failure so the server is never left down.
      const previous = getApiConfig().port
      await stopApiServer()
      const r = await startApiServer(port)
      if (!r.ok) {
        await startApiServer(previous)
        return { ...apiStatus(), error: r.error }
      }
      setApiConfig({ port })
    } else {
      setApiConfig({ port })
    }
    return apiStatus()
  })
  // PlexiMarketplace: built-in starter templates applied with one click.
  ipcMain.handle('marketplace:apply', (_e, key: string) => applyTemplate(key))

  ipcMain.handle('api:listTokens', () => listTokens())
  ipcMain.handle('api:createToken', (_e, name: string, scopes: ApiScope[]) => createToken(name, scopes))
  ipcMain.handle('api:revokeToken', (_e, id: string) => revokeToken(id))
  // Bring the server up if the user enabled it in a previous session.
  void initApiServer()
  ipcMain.handle(
    'documents:upsert',
    (
      _e,
      input: {
        id: string
        docType: FbDocument['docType']
        title: string
        body: FbDocument['body']
        archived?: boolean
        updatedAt?: number
      }
    ) => {
      const doc = upsertDocument(input)
      if (doc) void embedDocument(doc.id)
      return doc
    }
  )
  ipcMain.handle(
    'documents:generate',
    (_e, input: { docType: DocType; prompt: string; audience?: string }) => {
      // Designs have their own AI path (design:generateContent); this handler
      // covers the text-document kinds only.
      if (input.docType === 'design') {
        return Promise.resolve({ ok: false, error: 'Designs are generated through the design tools.' })
      }
      return generateDocument({ ...input, docType: input.docType })
    }
  )

  ipcMain.handle('settings:hintAnthropic', () => hint('anthropic'))
  ipcMain.handle('settings:hintOpenAI', () => hint('openai'))

  ipcMain.handle('settings:saveAnthropicKey', (_e, plaintext: string) => {
    try {
      setSecret('anthropic', plaintext)
      invalidateAnthropicClient()
      return { ok: true, ...hint('anthropic') }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('settings:saveOpenAIKey', (_e, plaintext: string) => {
    try {
      setSecret('openai', plaintext)
      // No client cache to invalidate — Whisper calls construct the
      // fetch directly per request, so the next call picks up the new
      // key automatically.
      return { ok: true, ...hint('openai') }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('settings:clearAnthropicKey', () => {
    try {
      clearSecret('anthropic')
      invalidateAnthropicClient()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('settings:clearOpenAIKey', () => {
    try {
      clearSecret('openai')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Tenor (GIF search) key — same encrypted-store pattern.
  ipcMain.handle('settings:hintTenor', () => hint('tenor'))
  ipcMain.handle('settings:saveTenorKey', (_e, plaintext: string) => {
    try {
      setSecret('tenor', plaintext)
      return { ok: true, ...hint('tenor') }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('settings:clearTenorKey', () => {
    try {
      clearSecret('tenor')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // PlexiDesign provider keys: Pexels (stock photos) and remove.bg (background
  // removal). Same hint/save/clear pattern as the others.
  ipcMain.handle('settings:hintPexels', () => hint('pexels'))
  ipcMain.handle('settings:savePexelsKey', (_e, plaintext: string) => {
    try {
      setSecret('pexels', plaintext)
      return { ok: true, ...hint('pexels') }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('settings:clearPexelsKey', () => {
    try {
      clearSecret('pexels')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('settings:hintRemoveBg', () => hint('removebg'))
  ipcMain.handle('settings:saveRemoveBgKey', (_e, plaintext: string) => {
    try {
      setSecret('removebg', plaintext)
      return { ok: true, ...hint('removebg') }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipcMain.handle('settings:clearRemoveBgKey', () => {
    try {
      clearSecret('removebg')
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // GIF search runs in main so the Tenor key never reaches the renderer.
  ipcMain.handle('gif:search', (_e, query: string) => searchGifs(typeof query === 'string' ? query : ''))

  // Multi-device workspace sync. The renderer drives the network (it has the
  // signal URL + token); these expose the local-DB half: what to push, what to
  // mark pushed, applying pulled rows, and the pull cursor.
  ipcMain.handle('workspace:pending', () => collectPending())
  // F010 (Attention S2): floor local sync_rev to the server's after a 409
  // conflict-apply so baseRev advances even when the apply no-opped.
  ipcMain.handle('workspace:advanceBaseRev', (_e, itemType: string, id: string, rev: number) =>
    advanceBaseRev(itemType, id, rev)
  )
  ipcMain.handle('workspace:markPushed', (_e, itemType: 'node' | 'widget' | 'timeblock' | 'document' | 'table' | 'row' | 'file', id: string, rev: number) => {
    // P1 diagnostics, widget-only trail: paired with "[sync-409]" this tells
    // a live churn loop apart from a permanent-conflict loop at a glance.
    // eslint-disable-next-line no-console
    if (itemType === 'widget') console.log(`[sync-mark] pushed widget/${id} @ rev ${rev}`)
    return markPushed(itemType, id, rev)
  })
  ipcMain.handle('workspace:applyRemote', (_e, items: RemoteItem[]) =>
    applyRemote(Array.isArray(items) ? items : [])
  )
  ipcMain.handle('workspace:getCursor', () => getSyncCursor())
  ipcMain.handle('workspace:setCursor', (_e, n: number) => setSyncCursor(typeof n === 'number' ? n : 0))

  // Org-shared workspace sync — cross-member time blocks (first slice). Separate
  // handlers from the personal ones so the two scopes can never be confused. The
  // renderer supplies the active org id; the server independently re-checks the
  // membership from the x-plexi-org header, so this id only ever narrows scope.
  ipcMain.handle('workspace:pendingOrg', (_e, orgId: string) => collectPendingOrg(String(orgId || '')))
  ipcMain.handle('workspace:applyRemoteOrg', (_e, items: RemoteItem[], orgId: string) =>
    applyRemoteOrg(Array.isArray(items) ? items : [], String(orgId || ''))
  )
  ipcMain.handle('workspace:getCursorOrg', (_e, orgId: string) => getSyncCursorOrg(String(orgId || '')))
  ipcMain.handle('workspace:setCursorOrg', (_e, orgId: string, n: number) =>
    setSyncCursorOrg(String(orgId || ''), typeof n === 'number' ? n : 0)
  )

  // Per-desk shared sync (desks shared with named individuals via ACL). Separate
  // handlers again so the shared scope is never confused with personal/org. The
  // apply path resolves the local "Shared with me" container itself, so a
  // materialized desk always anchors correctly regardless of the active org.
  ipcMain.handle('workspace:pendingShared', () => collectPendingShared())
  ipcMain.handle('workspace:applyRemoteShared', (_e, items: RemoteItem[], ownerHandles?: Record<string, string>) =>
    applyRemoteShared(Array.isArray(items) ? items : [], {
      sharedContainerId: ensureSharedContainer(),
      ownerHandles: ownerHandles && typeof ownerHandles === 'object' ? ownerHandles : undefined
    })
  )
  ipcMain.handle('workspace:getCursorShared', () => getSyncCursorShared())
  ipcMain.handle('workspace:setCursorShared', (_e, n: number) =>
    setSyncCursorShared(typeof n === 'number' ? n : 0)
  )
  ipcMain.handle('workspace:stampSharedDesk', (_e, rootId: string) => stampSharedDesk(String(rootId || '')))
  ipcMain.handle('workspace:adoptSharedDesk', (_e, rootId: string) => adoptSharedDesk(String(rootId || '')))
  ipcMain.handle('workspace:pruneSharedDesk', (_e, rootId: string) => pruneSharedDesk(String(rootId || '')))
  ipcMain.handle('workspace:localSharedRoots', () => listLocalSharedRoots())

  // Cross-member Drive file bytes. A file's metadata syncs over the org loop
  // above; these move the actual bytes. The renderer reads a local file's bytes to
  // upload, checks whether a pulled file's bytes are already on disk, and lands
  // downloaded bytes under the canonical id+ext path.
  ipcMain.handle('workspace:fileBytesForPush', (_e, id: string) => readFileBytesForSync(String(id || '')))
  ipcMain.handle('workspace:hasLocalFileBytes', (_e, id: string) => hasFileBytes(String(id || '')))
  ipcMain.handle('workspace:writeSyncedFileBytes', (_e, id: string, bytes: Uint8Array) =>
    writeSyncedFileBytes(String(id || ''), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  )

  // Validate the stored key by sending a 1-token "ping" prompt. Costs
  // roughly $0.0001 on Haiku — small enough that a "Test" button click is
  // basically free, and it confirms the key, the model, and the network
  // path all work end-to-end (vs. just checking a list endpoint).
  ipcMain.handle('settings:testAnthropicKey', async () => {
    const key = resolveAnthropicKey()
    if (!key) return { ok: false, error: 'No key set.' }
    try {
      const client = getModelClient(key)
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      })
      if ((response.stop_reason as string) === 'refusal') {
        return { ok: false, error: 'Claude declined this request. Try rephrasing or breaking it into smaller steps.' }
      }
      if ((response.stop_reason as string) === 'model_context_window_exceeded') {
        return { ok: false, error: 'Conversation hit the model context window. Start a fresh session.' }
      }
      return { ok: true, model: response.model }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Strip the SDK's verbose response body so the renderer can show a
      // single-line error rather than a wall of JSON.
      const short = msg.length > 240 ? msg.slice(0, 240) + '…' : msg
      return { ok: false, error: short }
    }
  })

  // Validate the OpenAI key by hitting /v1/models (free — no token cost,
  // confirms the key + network + scope all line up before the user runs
  // into it via the Whisper transcription flow). Mirrors the Anthropic
  // test pattern.
  ipcMain.handle('settings:testOpenAIKey', async () => {
    const key = resolveOpenAIKey()
    if (!key) return { ok: false, error: 'No key set.' }
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { authorization: `Bearer ${key}` }
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        const short = txt.length > 240 ? txt.slice(0, 240) + '…' : txt
        return { ok: false, error: `${res.status} ${res.statusText}${short ? ' · ' + short : ''}` }
      }
      const body = (await res.json()) as { data?: Array<{ id: string }> }
      const hasWhisper = (body.data ?? []).some((m) => m.id.startsWith('whisper'))
      return {
        ok: true,
        model: hasWhisper ? 'whisper available' : 'no whisper model in account'
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const short = msg.length > 240 ? msg.slice(0, 240) + '…' : msg
      return { ok: false, error: short }
    }
  })
}
