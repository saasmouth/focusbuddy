// AI Space: the shared project record (SPEC-AI-SPACE.md §6, SPEC-CONNECTIONS.md §7).
//
// These are the data-transfer shapes that main, preload and the renderer agree
// on. Every record links to the others by a stable id. Naming rule for this
// codebase: a bare `taskId` means a DESK id everywhere else in Plexii, so an AI
// Space task is always `aiTaskId`, and a Desk is always `deskId`.
//
// Times are ms epoch numbers. Ids are opaque strings with a short type prefix
// (`prj_`, `out_`, `ver_` …) so a log line or a deep link says what it points at.

// ── Workspaces and access context ─────────────────────────────────────────────

export type WorkspaceKind = 'personal' | 'work'

export interface AiWorkspace {
  id: string
  kind: WorkspaceKind
  name: string
  createdAt: number
}

// The context a screen, a search, a suggestion or a notification is evaluated
// in. A record is visible only when its workspace is in `workspaceIds`. This is
// the single gate the privacy acceptance test exercises: a personal project is
// absent from work search, suggestions and notifications because the work
// context does not list the personal workspace.
export interface AccessContext {
  workspaceIds: string[]
}

// ── Projects ──────────────────────────────────────────────────────────────────

export interface AiProject {
  id: string
  workspaceId: string
  // The Desk this project uses (nodes.id of kind 'task'), and the Room it lives
  // in (the Desk's parent folder) when there is one.
  deskId: string | null
  roomId: string | null
  title: string
  goal: string
  // The brief is an output (kind 'document', role 'brief') so every change to it
  // is an immutable version that runs can record consuming.
  briefOutputId: string | null
  // Authority the Project Manager and agents act under (§3).
  authority: ProjectAuthority
  // Budget in minor units of `budgetCurrency` (cents), per project. null = none set.
  budgetLimitMinor: number | null
  budgetCurrency: string
  // "Set project default" (Connections connect flow): the connection and model
  // new work starts with, so people don't repeat setup.
  defaultConnectionId: string | null
  defaultModel: string | null
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

export interface ProjectAuthority {
  // Agents may write new DRAFT versions of outputs on their own. Approving,
  // publishing and sending are never in this set; they need a person (§3).
  draftRevisions: boolean
  // How many automatic follow-ups one change may trigger before the Manager
  // stops and asks.
  maxAutoFollowUps: number
}

// Automatic drafts are OFF until the person opts in per project: they are AI
// calls nobody started, sending project content to a provider and spending
// money. Egress happens only on a user action or a run the person started or
// approved (house rule; d0 2026-11-24).
export const DEFAULT_AUTHORITY: ProjectAuthority = { draftRevisions: false, maxAutoFollowUps: 3 }

// ── Tasks ─────────────────────────────────────────────────────────────────────

export const AI_TASK_STATUSES = [
  'todo',
  'in_progress',
  'waiting',
  'awaiting_review',
  'done',
  'blocked'
] as const
export type AiTaskStatus = (typeof AI_TASK_STATUSES)[number]

export interface AiTask {
  id: string
  projectId: string
  parentTaskId: string | null
  branchId: string | null
  title: string
  // The outcome this task must produce, in the user's words.
  outcome: string
  deliverableKind: OutputKind | null
  status: AiTaskStatus
  // An agent profile id, 'user', or null when unassigned.
  assignee: string | null
  // When set, the task runs at this time (e.g. "tomorrow's email run").
  scheduledAt: number | null
  sortOrder: number
  createdAt: number
  updatedAt: number
  dependsOn: string[]
}

// ── Agents ────────────────────────────────────────────────────────────────────

export type AgentRole = 'manager' | 'writer' | 'research' | 'design' | 'review' | 'custom'

export interface AiAgent {
  id: string
  projectId: string
  name: string
  role: AgentRole
  connectionId: string | null
  model: string | null
  instructions: string
  createdAt: number
}

// ── Threads (chats) ───────────────────────────────────────────────────────────

// Linked opens the original chat. Imported stores selected messages with the
// capture time. Connected can start or track a run (§1 Start and capture).
export type ConnectionLevel = 'linked' | 'imported' | 'connected' | 'native'

export interface AiThread {
  id: string
  projectId: string | null // null = the unfiled inbox
  workspaceId: string
  aiTaskId: string | null
  kind: 'manager' | 'chat' | 'capture'
  title: string
  level: ConnectionLevel
  provider: string | null
  originalUrl: string | null
  capturedAt: number | null
  createdAt: number
}

export interface AiMessage {
  id: string
  threadId: string
  role: 'user' | 'assistant' | 'system' | 'agent'
  author: string
  text: string
  // References this message rests on (output versions, sources, decisions).
  refs: RecordRef[]
  runId: string | null
  createdAt: number
}

// ── Runs ──────────────────────────────────────────────────────────────────────

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
  'unavailable'
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled'
])

export interface RunManifest {
  // Credentials by reference only: never a secret (SPEC-CONNECTIONS §6).
  connectionId: string | null
  connectionAlias: string | null
  billedTo: string | null
  provider: string | null
  model: string | null
  // Exact input versions the run was given.
  inputs: RecordRef[]
  tools: string[]
  hostedExecution: boolean
  budgetMinor: number | null
  // What the run is asked to produce.
  instruction: string
  targetOutputId: string | null
  // The target's latest version when the run started (stale-write check).
  baseVersionId?: string | null
  // OpenAI background mode: the run continues at the provider.
  background?: boolean
  maxOutputTokens?: number
  // The result is a chat reply in the run's thread, not an output version.
  replyInThread?: boolean
}

export interface AiRun {
  id: string
  projectId: string
  aiTaskId: string | null
  threadId: string | null
  agentId: string | null
  branchId: string | null
  kind: 'model' | 'revision' | 'tool' | 'app_api' | 'external' | 'import'
  status: RunStatus
  statusDetail: string
  manifest: RunManifest
  idempotencyKey: string
  // An external provider's id for a run that continues outside Plexii.
  externalId: string | null
  // The last step Plexii confirmed, and when, for "Status unavailable".
  lastConfirmedStep: string
  lastConfirmedAt: number | null
  handoverOf: string | null
  attempt: number
  createdAt: number
  startedAt: number | null
  endedAt: number | null
}

export interface RunStep {
  runId: string
  seq: number
  kind: 'info' | 'progress' | 'output' | 'tool' | 'error' | 'usage'
  text: string
  at: number
}

// ── Outputs and immutable versions ────────────────────────────────────────────

export const OUTPUT_KINDS = [
  'document',
  'sheet',
  'slides',
  'image',
  'canvas',
  'site',
  'code',
  'media',
  'other'
] as const
export type OutputKind = (typeof OUTPUT_KINDS)[number]

export const OUTPUT_KIND_LABEL: Record<OutputKind, string> = {
  document: 'Documents',
  sheet: 'Sheets',
  slides: 'Slides',
  image: 'Images',
  canvas: 'Canvases',
  site: 'Sites',
  code: 'Code',
  media: 'Media',
  other: 'Other Files'
}

export type ReviewState = 'draft' | 'in_review' | 'approved' | 'changes_requested'

export interface AiOutput {
  id: string
  projectId: string
  aiTaskId: string | null
  branchId: string | null
  kind: OutputKind
  role: 'deliverable' | 'brief'
  title: string
  // Two separate pointers (§1 Outputs). Previewing one never moves the other.
  latestVersionId: string | null
  approvedVersionId: string | null
  // Sites only: the version that is live, and the domain when connected.
  publishedVersionId: string | null
  domain: string | null
  reviewState: ReviewState
  createdAt: number
  updatedAt: number
}

export interface OutputVersion {
  id: string
  outputId: string
  n: number
  parentVersionId: string | null
  branchId: string | null
  // 'user:<id>', 'agent:<id>' or 'run:<id>'.
  author: string
  runId: string | null
  // Text content for documents, code and site HTML; a caption/alt text for
  // images; JSON for canvases and sheets.
  content: string
  // An image or media file kept beside the record (data URL or local path).
  mediaRef: string | null
  mediaWidth: number | null
  mediaHeight: number | null
  contentHash: string
  changeSummary: string
  // What this version was made from.
  sources: RecordRef[]
  createdAt: number
}

// ── Decisions, sources, requests, suggestions, branches ──────────────────────

export type DecisionStatus = 'open' | 'approved' | 'resolved' | 'superseded' | 'rejected'

export interface AiDecision {
  id: string
  projectId: string
  // A stable topic key, so a later decision on the same topic supersedes this
  // one (e.g. 'trial_length').
  topic: string
  title: string
  value: string
  previousValue: string | null
  status: DecisionStatus
  dueAt: number | null
  // Where the decision came from.
  evidence: RecordRef[]
  decidedBy: string | null
  decidedAt: number | null
  supersedes: string | null
  createdAt: number
}

export type SourceKind = 'link' | 'import' | 'file' | 'note' | 'tool_result' | 'app_api'

export interface AiSource {
  id: string
  projectId: string | null
  workspaceId: string
  kind: SourceKind
  title: string
  url: string | null
  content: string
  // Imported and tool text is material, never instructions (§3).
  trusted: false
  provider: string | null
  connectionId: string | null
  runId: string | null
  originalLocation: string | null
  capturedAt: number
  createdAt: number
}

export interface InfoRequest {
  id: string
  projectId: string
  aiTaskId: string | null
  requestedBy: string // agent id
  recipient: string // 'user' or an agent id
  question: string
  // Keywords the Manager matches later evidence against.
  topics: string[]
  canProceed: string
  status: 'open' | 'supplied' | 'withdrawn'
  suppliedSourceId: string | null
  deliveredAt: number | null
  createdAt: number
}

export type SuggestionStatus = 'pending' | 'acted' | 'deferred' | 'dismissed'

export interface AiSuggestion {
  id: string
  projectId: string
  fromActor: string
  recipient: string
  target: RecordRef
  targetVersionId: string | null
  evidence: Evidence[]
  proposedAction: string
  status: SuggestionStatus
  // event id + target version + proposed action (§3 dedupe rule).
  dedupeKey: string
  sourceEventId: string | null
  createdAt: number
  resolvedAt: number | null
}

export interface AiBranch {
  id: string
  projectId: string
  name: string
  // The named snapshot this branch started from.
  snapshot: { briefVersionId: string | null; outputVersions: Record<string, string> }
  status: 'open' | 'merged' | 'abandoned'
  createdAt: number
}

// ── References and evidence ───────────────────────────────────────────────────

export type RecordType =
  | 'project'
  | 'task'
  | 'thread'
  | 'message'
  | 'run'
  | 'output'
  | 'version'
  | 'decision'
  | 'source'
  | 'request'
  | 'suggestion'
  | 'branch'
  | 'connection'

export interface RecordRef {
  type: RecordType
  id: string
  // For an output: pin a version, or follow the approved one (§1 Outputs).
  versionId?: string | null
  follow?: 'approved' | 'pinned'
  label?: string
}

export interface Evidence {
  // 'recorded' = the input was recorded (Used this version).
  // 'inferred' = the system matched it (Possible match).
  basis: 'recorded' | 'inferred'
  text: string
  ref: RecordRef | null
  // The exact excerpt that matched, with the match offsets inside it.
  excerpt?: string
  matchStart?: number
  matchEnd?: number
}

// ── Activity events ───────────────────────────────────────────────────────────

export const AISPACE_EVENT_KINDS = [
  'project.created',
  'project.updated',
  'task.created',
  'task.updated',
  'task.status_changed',
  'thread.captured',
  'message.posted',
  'run.queued',
  'run.started',
  'run.step',
  'run.succeeded',
  'run.failed',
  'run.cancelled',
  'run.unavailable',
  'run.interrupted',
  'output.created',
  'output.version_added',
  'output.approved',
  'output.published',
  'output.review_requested',
  'decision.recorded',
  'decision.approved',
  'decision.resolved',
  'source.added',
  'request.opened',
  'request.supplied',
  'request.delivered',
  'suggestion.created',
  'suggestion.resolved',
  'branch.created',
  'branch.merged',
  'disagreement.recorded',
  'budget.blocked',
  'connection.added',
  'connection.status_changed',
  'connection.revoked',
  'connection.paused',
  'connection.resumed',
  'connection.rotated',
  'grant.changed',
  'invocation.recorded',
  'share.created'
] as const
export type AiSpaceEventKind = (typeof AISPACE_EVENT_KINDS)[number]

export interface AiSpaceEvent {
  seq: number
  id: string
  workspaceId: string
  projectId: string | null
  // 'user:<id>', 'agent:<id>', 'system', 'connection:<id>'.
  actor: string
  kind: AiSpaceEventKind
  subject: RecordRef | null
  // Explicit references the return brief and Impact rows cite.
  refs: RecordRef[]
  summary: string
  data: Record<string, unknown>
  visibility: 'project' | 'workspace' | 'private'
  at: number
}

// ── Small helpers ─────────────────────────────────────────────────────────────

export function isTerminalRun(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

export function refKey(ref: RecordRef): string {
  return `${ref.type}:${ref.id}${ref.versionId ? `@${ref.versionId}` : ''}`
}
