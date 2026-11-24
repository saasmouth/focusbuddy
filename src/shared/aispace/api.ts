// The shapes AI Space IPC returns. Main's service is annotated with these, so
// the compiler holds main and the renderer to one contract.

import type {
  AiAgent,
  AiBranch,
  AiDecision,
  AiMessage,
  AiOutput,
  AiProject,
  AiSource,
  AiSpaceEvent,
  AiSuggestion,
  AiTask,
  AiThread,
  AiWorkspace,
  ConnectionLevel,
  InfoRequest,
  OutputKind,
  RecordRef,
  RunManifest,
  RunStatus,
  RunStep
} from './model'
import type { CapabilityHealth, Connection, ConnectionConfig, Grant, Invocation, ModelInfo, OperationDef, ProviderDefinition, UsageEntry } from './connections'
import type { ImpactResult } from './impact'
import type { NeedsYou, ReturnBrief } from './brief'
import type { McpCatalogueEntry } from './catalogue'

export interface RunSummary {
  id: string
  projectId: string
  aiTaskId: string | null
  projectTitle: string
  title: string
  status: RunStatus
  statusDetail: string
  kind: string
  connectionAlias: string | null
  provider: string | null
  model: string | null
  billedTo: string | null
  externalId: string | null
  lastConfirmedStep: string
  lastConfirmedAt: number | null
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  canCancel: boolean
  canPause: boolean
  canRetry: boolean
  hasHeldDraft: boolean
}

export interface VersionMeta {
  id: string
  n: number
  author: string
  createdAt: number
  changeSummary: string
  mediaRef: string | null
  mediaWidth: number | null
  mediaHeight: number | null
  excerpt: string
}

export type OutputWithMeta = AiOutput & { latest: VersionMeta | null; approved: VersionMeta | null; versionCount: number }

export interface UsageSummary {
  calls: number
  inputTokens: number
  outputTokens: number
  amountMicros: number
  unknownAmounts: number
  estimated: boolean
}

export interface ConnectionCard extends Connection {
  config: ConnectionConfig
  providerName: string
  group: string
  payer: string
  dataDestination: string | null
  onThisMac: boolean
  eligibleProjects: Array<{ projectId: string; title: string }>
  usage: UsageSummary
  keySettingsUrl: string | null
  billingUrl: string | null
  certification: ProviderDefinition['certification'] | null
  defaultModel: string | null
  models: ModelInfo[]
}

export type HomeNeed = NeedsYou & { projectId: string | null; projectTitle: string | null }

export interface HomeData {
  since: number
  firstVisit: boolean
  updates: Array<ReturnBrief['updates'][number] & { projectId: string; projectTitle: string }>
  needsYou: HomeNeed[]
  activeRuns: RunSummary[]
  projects: Array<{
    project: AiProject
    headline: string
    currentDeliverable: { id: string; title: string; kind: OutputKind; why: string } | null
    needs: number
    nextStep: ReturnBrief['nextStep']
  }>
  sharedIn: Array<{ shareId: string; title: string; kind: OutputKind; versionId: string; n: number; excerpt: string }>
  inbox: Array<{ id: string; title: string; provider: string | null; level: ConnectionLevel; capturedAt: number | null }>
  storageNote: string
}

export type ProjectBrief = Omit<ReturnBrief, 'impact'> & { impact?: undefined }

export interface ProjectViewData {
  project: AiProject
  workspace: AiWorkspace | null
  tasks: AiTask[]
  outputs: OutputWithMeta[]
  agents: AiAgent[]
  threads: AiThread[]
  decisions: AiDecision[]
  sources: AiSource[]
  requests: InfoRequest[]
  suggestions: AiSuggestion[]
  branches: AiBranch[]
  runs: RunSummary[]
  brief: ProjectBrief
  grants: Array<Grant & { connection: ConnectionCard | null }>
  eligibleConnections: Array<ConnectionCard & { granted: boolean }>
  spend: { spentMicros: number; reservedMicros: number; unknownCount: number }
  storageNote: string
}

export interface ImpactResponse {
  asOf: number
  leftAt: number | null
  result: ImpactResult
  activity: AiSpaceEvent[]
  timeline: Array<{ seq: number; at: number; kind: string; summary: string }>
}

export interface RunDetailData {
  run: RunSummary
  manifest: RunManifest
  inputs: Array<{ ref: RecordRef; label: string }>
  steps: RunStep[]
  invocations: Invocation[]
  usage: UsageEntry[]
  handoverOf: string | null
  followUps: string[]
}

export interface ConnectionDetailData {
  connection: ConnectionCard
  grants: Array<Grant & { projectTitle: string }>
  operations: Array<OperationDef & { suggestedClass: 'read' | 'write' | null }>
  usage: UsageEntry[]
  invocations: Invocation[]
  runs: RunSummary[]
  activity: AiSpaceEvent[]
  projects: Array<{ id: string; title: string }>
}

export interface AccessImpactData {
  projects: Array<{ id: string; title: string }>
  agents: Array<{ id: string; name: string; projectTitle: string }>
  activeRuns: RunSummary[]
  scheduled: RunSummary[]
  defaultFor: Array<{ id: string; title: string }>
  external: number
}

export interface CatalogueData {
  providers: ProviderDefinition[]
  addable: string[]
  mcp: McpCatalogueEntry[]
}

export type AddConnectionResult =
  | { ok: true; connection: ConnectionCard; confirmed: string[] }
  | { ok: false; detail: string; confirmed?: string[]; separate?: { providerId: string; identity: string } | null }

export interface TestConnectionResult {
  connection: ConnectionCard
  confirmed: string[]
}

export interface CaptureResultData {
  thread: AiThread
  source: AiSource | null
  provider: { id: string; name: string } | null
  suggestions: Array<{ id: string; title: string; score: number; why: string }>
}

export type StartRunResponse =
  | { ok: true; run: RunSummary; duplicate: boolean }
  | { ok: false; code: string; reason: string; checks: Array<{ name: string; ok: boolean; detail: string }> }

export interface SearchHitData {
  type: 'project' | 'task' | 'thread' | 'output' | 'decision'
  id: string
  projectId: string | null
  projectTitle: string | null
  title: string
  snippet: string
  provider: string | null
}

export interface ToolCallResponse {
  status: 'ok' | 'error' | 'uncertain' | 'blocked' | 'awaiting_approval'
  invocationId: string | null
  detail: string
  sourceId: string | null
  output: unknown
  approval: null | { tool: string; account: string; payer: string; touches: string; effect: string; destination: string }
}

export interface McpInspectResult {
  ok: boolean
  origin: string | null
  onThisMac: boolean
  reason: string
  needsAuth: boolean | null
  authServer: string | null
  scopes: string[]
}

export type McpAddResult =
  | { ok: true; connection: ConnectionCard; next: 'authorize' | 'done'; confirmed: string[] }
  | { ok: false; detail: string }

export interface McpAuthorizeResult {
  ok: boolean
  outcome: 'authorized' | 'denied' | 'timeout' | 'error' | 'consent_required'
  detail: string
  connection: ConnectionCard | null
}

export interface MessagesData {
  thread: AiThread
  messages: AiMessage[]
}

export type { CapabilityHealth }
