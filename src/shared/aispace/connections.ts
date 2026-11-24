// Plexii Connections: the records (SPEC-CONNECTIONS.md §7 Core records).
//
// A connection is ONE credential/identity at ONE provider. A ChatGPT web login
// and an OpenAI API key are two connections under one provider group, each
// with its own state, capabilities and payer (§1). Secrets never appear in
// these shapes: a connection carries a vault reference and a hint (last four
// characters) and nothing else. The renderer can never read a secret back.

// ── Kinds and filters ─────────────────────────────────────────────────────────

export const CONNECTION_KINDS = ['ai_account', 'model_api', 'agent', 'mcp', 'app_api', 'local'] as const
export type ConnectionKind = (typeof CONNECTION_KINDS)[number]

export const CONNECTION_KIND_LABEL: Record<ConnectionKind, string> = {
  ai_account: 'AI accounts',
  model_api: 'Models',
  agent: 'Agents',
  mcp: 'MCP',
  app_api: 'App APIs',
  local: 'Local'
}

// ── Capabilities ──────────────────────────────────────────────────────────────

export const CAPABILITIES = [
  'open_source',
  'import',
  'run_model',
  'track_run',
  'cancel_run',
  'resume_run',
  'call_tool',
  'read_resource',
  'app_read',
  'app_write'
] as const
export type Capability = (typeof CAPABILITIES)[number]

export const CAPABILITY_LABEL: Record<Capability, string> = {
  open_source: 'Open source',
  import: 'Import',
  run_model: 'Run model',
  track_run: 'Track run',
  cancel_run: 'Cancel run',
  resume_run: 'Resume run',
  call_tool: 'Call tool',
  read_resource: 'Read resource',
  app_read: 'Read data',
  app_write: 'Create drafts'
}

// Health is recorded per capability (§2 Status and repair). A label is shown
// on a card only when its capability is 'passed' (§1 certification rule).
export type CapabilityState = 'passed' | 'failed' | 'untested' | 'unsupported'

export interface CapabilityHealth {
  capability: Capability
  state: CapabilityState
  checkedAt: number | null
  detail: string
}

// ── Status ────────────────────────────────────────────────────────────────────

export const CONNECTION_STATUSES = [
  'draft',
  'ready',
  'limited',
  'reconnect_required',
  'unavailable',
  'paused',
  'disconnected'
] as const
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number]

export const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  draft: 'Setup not finished',
  ready: 'Ready',
  limited: 'Limited',
  reconnect_required: 'Reconnect required',
  unavailable: 'Temporarily unavailable',
  paused: 'Paused',
  disconnected: 'Disconnected'
}

// Statuses under which no NEW call may start (§3 disconnect, §2 paused).
export const BLOCKING_STATUSES: ReadonlySet<ConnectionStatus> = new Set([
  'draft',
  'reconnect_required',
  'paused',
  'disconnected'
])

// ── Provider catalogue ────────────────────────────────────────────────────────

export type AuthMethod = 'api_key' | 'oauth_pkce' | 'bearer_token' | 'account_link' | 'none'

export interface ModelInfo {
  id: string
  label: string
  modalities: Array<'text' | 'image' | 'audio'>
  // USD per million tokens, when published by the provider and checked. null =
  // unknown, so cost shows as Unavailable rather than a guess.
  usdPerMInput: number | null
  usdPerMOutput: number | null
  maxOutputTokens: number
}

export type CertificationStatus = 'certified' | 'conformance_tested' | 'planned'

export interface ProviderDefinition {
  id: string
  name: string
  // Providers are grouped visually under this name (§1).
  group: string
  kind: ConnectionKind
  adapterVersion: string
  auth: AuthMethod[]
  accountDiscovery: boolean
  models: ModelInfo[]
  streaming: boolean
  maxTaskDuration: string
  usageReporting: 'per_request' | 'none'
  // The capabilities the adapter CAN offer. A connection shows one only after
  // its own check passed.
  declaredCapabilities: Capability[]
  regions: string[]
  // Where data goes when this connection is used. Shown before any send.
  dataDestination: string
  keySettingsUrl: string | null
  billingUrl: string | null
  docsUrl: string | null
  // How a web chat link is recognised for an AI web account.
  chatUrlPattern: string | null
  certification: {
    status: CertificationStatus
    // What the status rests on, in plain words.
    basis: string
  }
}

// ── Connection ────────────────────────────────────────────────────────────────

export interface Connection {
  id: string
  workspaceId: string
  providerId: string
  kind: ConnectionKind
  alias: string
  providerOrg: string | null
  // A stable identity for the account behind the credential (an org id, a
  // workspace id, a user id). Reconnect must match it (§3).
  identity: string | null
  credentialOwner: string
  // Who pays. null shows as "Unknown payer" (acceptance: Web subscription and API key).
  billedTo: string | null
  region: string | null
  // For MCP and custom endpoints: the exact resource URL.
  endpoint: string | null
  verifiedOrigin: string | null
  status: ConnectionStatus
  statusDetail: string
  statusSince: number
  pausedBy: string | null
  lastCheckedAt: number | null
  hasSecret: boolean
  // Last four characters only; never more.
  secretHint: string | null
  capabilities: CapabilityHealth[]
  createdAt: number
  disconnectedAt: number | null
  // A step the person must still take at the provider (e.g. delete the key in
  // the console) after Plexii disconnected.
  providerAction: string | null
}

export interface ConnectionConfig {
  // MCP: the person typed a loopback endpoint ("on this Mac").
  localEndpoint?: boolean
  // MCP: OAuth or bearer, and what the server asked for.
  authMode?: 'oauth' | 'bearer' | 'none'
  // MCP servers without dynamic registration: the client id their owner issued.
  clientId?: string | null
  grantedScope?: string | null
  // Model API: the default model for this connection.
  defaultModel?: string | null
  // Notion: the parent page drafts are created under.
  draftParentId?: string | null
  draftParentTitle?: string | null
}

// ── Grants ────────────────────────────────────────────────────────────────────

export type GrantRole = 'use' | 'manage'
export type ApprovalLevel = 'auto' | 'ask_each_time'

export interface GrantAction {
  // An operation id ('notion.search'), an MCP tool id ('mcp:<conn>:<tool>'),
  // or 'model:*' for running models.
  operationId: string
  mode: 'read' | 'write'
}

export interface Grant {
  id: string
  connectionId: string
  projectId: string
  // Agent ids allowed to use this grant; ['*'] = every agent in the project.
  agentIds: string[]
  role: GrantRole
  actions: GrantAction[]
  // Record types or tags this connection may receive (e.g. ['brief', 'output']).
  // Empty = everything the project itself can read.
  dataFilters: string[]
  approval: ApprovalLevel
  expiresAt: number | null
  createdBy: string
  createdAt: number
  revokedAt: number | null
}

// ── Operations ────────────────────────────────────────────────────────────────

export type OperationClass = 'read' | 'write' | 'unknown'
export type RetryRule = 'safe_read' | 'idempotent_write' | 'never'

export interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchema & { description?: string }>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  description?: string
  additionalProperties?: boolean | JsonSchema
  maxLength?: number
  minimum?: number
  maximum?: number
  [k: string]: unknown
}

export interface OperationDef {
  // Stable id: '<adapter>.<name>' for catalogue operations, 'mcp:<connectionId>:<tool>' for MCP tools.
  id: string
  connectionId: string | null
  adapter: string
  title: string
  description: string
  classification: OperationClass
  scope: string | null
  // The one host this operation may send to.
  destination: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema | null
  schemaVersion: number
  schemaHash: string
  rateLimitPerMinute: number
  timeoutMs: number
  retry: RetryRule
  // An MCP tool whose schema, endpoint or permissions changed since it was
  // granted goes back to 'needs_review' (§4 Tool discovery).
  reviewState: 'approved' | 'needs_review'
  origin: 'catalogue' | 'mcp'
}

// ── Invocations and usage ─────────────────────────────────────────────────────

export type InvocationStatus = 'ok' | 'error' | 'uncertain' | 'blocked' | 'awaiting_approval'

export interface Invocation {
  id: string
  runId: string | null
  projectId: string | null
  connectionId: string
  principal: string
  operationId: string
  // Hashes and version refs of what went out and what came back; payload
  // contents follow the workspace retention policy, never secrets.
  inputRef: string
  outputRef: string | null
  approval: { mode: ApprovalLevel | 'not_required'; by: string | null; at: number | null }
  status: InvocationStatus
  detail: string
  providerRequestId: string | null
  idempotencyKey: string | null
  startedAt: number
  endedAt: number | null
}

export type UsageSource = 'reported' | 'estimated' | 'unavailable'

export interface UsageEntry {
  id: string
  workspaceId: string
  projectId: string | null
  runId: string | null
  connectionId: string
  providerId: string
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  // Micro-units of `currency` (1e-6), so cents of a cent survive.
  amountMicros: number | null
  currency: string
  // Tokens and amount are labelled independently: a provider can report tokens
  // while the amount is our estimate.
  tokensSource: UsageSource
  amountSource: UsageSource
  state: 'reserved' | 'final' | 'released'
  createdAt: number
}

// ── Policy decisions ──────────────────────────────────────────────────────────

export interface PolicyCheck {
  name: string
  ok: boolean
  detail: string
}

export interface PolicyDecision {
  allowed: boolean
  // A stable code the UI maps to a repair action.
  code:
    | 'ok'
    | 'no_grant'
    | 'grant_expired'
    | 'agent_not_assigned'
    | 'connection_blocked'
    | 'workspace_mismatch'
    | 'operation_not_granted'
    | 'operation_unknown'
    | 'operation_needs_review'
    | 'approval_required'
    | 'data_not_permitted'
    | 'over_budget'
    | 'fallback_not_authorised'
    | 'capability_missing'
  reason: string
  checks: PolicyCheck[]
}

// ── Small helpers ─────────────────────────────────────────────────────────────

export function capabilityPassed(c: Pick<Connection, 'capabilities'>, cap: Capability): boolean {
  return c.capabilities.some((h) => h.capability === cap && h.state === 'passed')
}

export function passedCapabilities(c: Pick<Connection, 'capabilities'>): Capability[] {
  return CAPABILITIES.filter((cap) => capabilityPassed(c, cap))
}

export function payerLabel(c: Pick<Connection, 'billedTo'>): string {
  return c.billedTo && c.billedTo.trim() ? c.billedTo : 'Unknown payer'
}

// Mask anything that looks like a key before it can reach a log or a message.
// Matches common provider key shapes and long opaque tokens.
const SECRETISH = /\b(sk-[A-Za-z0-9_\-]{8,}|sk-ant-[A-Za-z0-9_\-]{8,}|ntn_[A-Za-z0-9]{8,}|secret_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}|Bearer\s+[A-Za-z0-9._\-]{12,})/g

export function redactSecrets(text: string): string {
  return text.replace(SECRETISH, (m) => (m.startsWith('Bearer') ? 'Bearer [redacted]' : '[redacted]'))
}

export function secretHintOf(secret: string): string {
  const s = secret.trim()
  return s.length <= 8 ? '…' : `…${s.slice(-4)}`
}
