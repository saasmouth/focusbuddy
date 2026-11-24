// Connections records (SPEC-CONNECTIONS.md §7 Core records): connections,
// grants, operations, invocations, usage entries, pre-authorised fallbacks and
// connect drafts (setup recovery). Secrets are NOT here: a connection row only
// knows whether a secret exists and its last four characters. The vault holds
// the secret (vault.ts) and only the broker reads it.
//
// Every administrative change (add, test, pause, resume, rotate, disconnect,
// grant changes) is written to the append-only activity log with who did it,
// which is the audit trail §3 asks for.

import { randomUUID } from 'node:crypto'
import type { SqlDb } from '../db/eventStore'
import { ensureAiSpaceSchema } from './schema'
import type {
  ApprovalLevel,
  CapabilityHealth,
  Connection,
  ConnectionKind,
  ConnectionStatus,
  Grant,
  GrantAction,
  GrantRole,
  Invocation,
  InvocationStatus,
  OperationDef,
  UsageEntry,
  UsageSource
} from '@shared/aispace/connections'
import { BLOCKING_STATUSES, CONNECTION_STATUS_LABEL, redactSecrets } from '@shared/aispace/connections'
import type { ConnectionConfig } from '@shared/aispace/connections'
import type { AccessContext } from '@shared/aispace/model'
import type { AiSpaceStore } from './store'

type Row = Record<string, unknown>
const j = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string' || !s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

export type ConnectionsStore = ReturnType<typeof createConnectionsStore>

export type { ConnectionConfig } from '@shared/aispace/connections'

export function createConnectionsStore(db: SqlDb, ais: AiSpaceStore, opts: { now?: () => number; newId?: (p: string) => string } = {}) {
  ensureAiSpaceSchema(db)
  const now = opts.now ?? (() => Date.now())
  const newId = opts.newId ?? ((p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 20)}`)
  const run = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...a)
  const get = (sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as Row | undefined
  const all = (sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as Row[]

  const toConnection = (r: Row): Connection & { config: ConnectionConfig } => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    providerId: String(r.provider_id),
    kind: r.kind as ConnectionKind,
    alias: String(r.alias),
    providerOrg: str(r.provider_org),
    identity: str(r.identity),
    credentialOwner: String(r.credential_owner),
    billedTo: str(r.billed_to),
    region: str(r.region),
    endpoint: str(r.endpoint),
    verifiedOrigin: str(r.verified_origin),
    status: r.status as ConnectionStatus,
    statusDetail: String(r.status_detail ?? ''),
    statusSince: Number(r.status_since),
    pausedBy: str(r.paused_by),
    lastCheckedAt: num(r.last_checked_at),
    hasSecret: Number(r.has_secret) === 1,
    secretHint: str(r.secret_hint),
    capabilities: j<CapabilityHealth[]>(r.capabilities_json, []),
    createdAt: Number(r.created_at),
    disconnectedAt: num(r.disconnected_at),
    providerAction: str(r.provider_action),
    config: j<ConnectionConfig>(r.config_json, {})
  })

  const toGrant = (r: Row): Grant => ({
    id: String(r.id),
    connectionId: String(r.connection_id),
    projectId: String(r.project_id),
    agentIds: j<string[]>(r.agent_ids_json, ['*']),
    role: r.role as GrantRole,
    actions: j<GrantAction[]>(r.actions_json, []),
    dataFilters: j<string[]>(r.data_filters_json, []),
    approval: r.approval as ApprovalLevel,
    expiresAt: num(r.expires_at),
    createdBy: String(r.created_by),
    createdAt: Number(r.created_at),
    revokedAt: num(r.revoked_at)
  })

  const toOperation = (r: Row): OperationDef & { suggestedClass: 'read' | 'write' | null } => ({
    id: String(r.id),
    connectionId: str(r.connection_id),
    adapter: String(r.adapter),
    title: String(r.title),
    description: String(r.description ?? ''),
    classification: r.classification as OperationDef['classification'],
    suggestedClass: (str(r.suggested_class) as 'read' | 'write' | null) ?? null,
    scope: str(r.scope),
    destination: String(r.destination),
    inputSchema: j(r.input_schema_json, {}),
    outputSchema: j(r.output_schema_json, null),
    schemaVersion: Number(r.schema_version),
    schemaHash: String(r.schema_hash),
    rateLimitPerMinute: Number(r.rate_limit),
    timeoutMs: Number(r.timeout_ms),
    retry: r.retry as OperationDef['retry'],
    reviewState: r.review_state as OperationDef['reviewState'],
    origin: r.origin as OperationDef['origin']
  })

  const toInvocation = (r: Row): Invocation => ({
    id: String(r.id),
    runId: str(r.run_id),
    projectId: str(r.project_id),
    connectionId: String(r.connection_id),
    principal: String(r.principal),
    operationId: String(r.operation_id),
    inputRef: String(r.input_ref),
    outputRef: str(r.output_ref),
    approval: j(r.approval_json, { mode: 'not_required', by: null, at: null }),
    status: r.status as InvocationStatus,
    detail: String(r.detail ?? ''),
    providerRequestId: str(r.provider_request_id),
    idempotencyKey: str(r.idempotency_key),
    startedAt: Number(r.started_at),
    endedAt: num(r.ended_at)
  })

  const toUsage = (r: Row): UsageEntry => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    projectId: str(r.project_id),
    runId: str(r.run_id),
    connectionId: String(r.connection_id),
    providerId: String(r.provider_id),
    model: str(r.model),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    amountMicros: num(r.amount_micros),
    currency: String(r.currency),
    tokensSource: r.tokens_source as UsageSource,
    amountSource: r.amount_source as UsageSource,
    state: r.state as UsageEntry['state'],
    createdAt: Number(r.created_at)
  })

  function audit(c: { id: string; workspaceId: string; alias: string }, actor: string, kind: 'connection.added' | 'connection.status_changed' | 'connection.revoked' | 'connection.paused' | 'connection.resumed' | 'connection.rotated' | 'grant.changed', summary: string, data: Record<string, unknown> = {}, projectId: string | null = null) {
    ais.appendEvent({ workspaceId: c.workspaceId, projectId, actor, kind, subject: { type: 'connection', id: c.id, label: c.alias }, summary: redactSecrets(summary), data: { alias: c.alias, ...data }, visibility: 'workspace' })
  }

  // ── Connections ─────────────────────────────────────────────────────────────

  function addConnection(input: {
    workspaceId: string
    providerId: string
    kind: ConnectionKind
    alias: string
    credentialOwner: string
    billedTo?: string | null
    endpoint?: string | null
    verifiedOrigin?: string | null
    region?: string | null
    config?: ConnectionConfig
    actor?: string
  }): Connection & { config: ConnectionConfig } {
    return ais.tx(() => {
      const id = newId('con')
      const t = now()
      run(
        `INSERT INTO ais_connections (id, workspace_id, provider_id, kind, alias, credential_owner, billed_to, region, endpoint, verified_origin, status, status_detail, status_since, config_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        input.workspaceId,
        input.providerId,
        input.kind,
        input.alias.trim() || input.providerId,
        input.credentialOwner,
        input.billedTo ?? null,
        input.region ?? null,
        input.endpoint ?? null,
        input.verifiedOrigin ?? null,
        'draft',
        'Setup not finished.',
        t,
        JSON.stringify(input.config ?? {}),
        t
      )
      const c = getConnection(id)!
      audit(c, input.actor ?? 'user:me', 'connection.added', `Added ${c.alias}.`, { providerId: input.providerId })
      return c
    })
  }

  function getConnection(id: string): (Connection & { config: ConnectionConfig }) | null {
    const r = get(`SELECT * FROM ais_connections WHERE id = ?`, id)
    return r ? toConnection(r) : null
  }

  function listConnections(ctx: AccessContext, opts: { kind?: ConnectionKind; includeDisconnected?: boolean } = {}): Array<Connection & { config: ConnectionConfig }> {
    if (ctx.workspaceIds.length === 0) return []
    const where = [`workspace_id IN (${ctx.workspaceIds.map(() => '?').join(',')})`]
    const args: unknown[] = [...ctx.workspaceIds]
    if (opts.kind) {
      where.push('kind = ?')
      args.push(opts.kind)
    }
    if (!opts.includeDisconnected) where.push(`status != 'disconnected'`)
    return all(`SELECT * FROM ais_connections WHERE ${where.join(' AND ')} ORDER BY created_at`, ...args).map(toConnection)
  }

  function updateConnection(
    id: string,
    patch: Partial<Pick<Connection, 'alias' | 'providerOrg' | 'identity' | 'billedTo' | 'region' | 'endpoint' | 'verifiedOrigin' | 'hasSecret' | 'secretHint' | 'lastCheckedAt' | 'providerAction'>> & { config?: ConnectionConfig; capabilities?: CapabilityHealth[] }
  ): Connection & { config: ConnectionConfig } {
    const c = getConnection(id)
    if (!c) throw new Error('Connection not found.')
    const n = { ...c, ...patch, config: patch.config ? { ...c.config, ...patch.config } : c.config, capabilities: patch.capabilities ?? c.capabilities }
    run(
      `UPDATE ais_connections SET alias = ?, provider_org = ?, identity = ?, billed_to = ?, region = ?, endpoint = ?, verified_origin = ?, has_secret = ?, secret_hint = ?, last_checked_at = ?, provider_action = ?, config_json = ?, capabilities_json = ? WHERE id = ?`,
      n.alias,
      n.providerOrg,
      n.identity,
      n.billedTo,
      n.region,
      n.endpoint,
      n.verifiedOrigin,
      n.hasSecret ? 1 : 0,
      n.secretHint,
      n.lastCheckedAt,
      n.providerAction,
      JSON.stringify(n.config),
      JSON.stringify(n.capabilities),
      id
    )
    return getConnection(id)!
  }

  // Status changes are audited and carry their reason.
  function setStatus(id: string, status: ConnectionStatus, detail: string, actor = 'system', extra: { pausedBy?: string | null } = {}): Connection & { config: ConnectionConfig } {
    return ais.tx(() => {
      const c = getConnection(id)
      if (!c) throw new Error('Connection not found.')
      if (c.status === status && c.statusDetail === detail) return c
      const t = now()
      run(
        `UPDATE ais_connections SET status = ?, status_detail = ?, status_since = ?, paused_by = ?, disconnected_at = CASE WHEN ? = 'disconnected' THEN ? ELSE disconnected_at END WHERE id = ?`,
        status,
        redactSecrets(detail),
        t,
        status === 'paused' ? extra.pausedBy ?? actor : null,
        status,
        t,
        id
      )
      const kind = status === 'paused' ? 'connection.paused' : status === 'disconnected' ? 'connection.revoked' : c.status === 'paused' && status === 'ready' ? 'connection.resumed' : 'connection.status_changed'
      audit(c, actor, kind, `${c.alias}: ${CONNECTION_STATUS_LABEL[status]}${detail ? ` — ${detail}` : ''}`, { from: c.status, to: status })
      return getConnection(id)!
    })
  }

  function recordCheck(id: string, capabilities: CapabilityHealth[], identity: { identity?: string | null; providerOrg?: string | null }, actor = 'user:me'): Connection & { config: ConnectionConfig } {
    return ais.tx(() => {
      const c = getConnection(id)
      if (!c) throw new Error('Connection not found.')
      const merged = mergeCapabilities(c.capabilities, capabilities)
      updateConnection(id, { capabilities: merged, lastCheckedAt: now(), identity: identity.identity ?? c.identity, providerOrg: identity.providerOrg ?? c.providerOrg })
      const passed = merged.filter((h) => h.state === 'passed').length
      const failed = merged.filter((h) => h.state === 'failed').length
      // Ready when everything checked passed; Limited when some failed or are
      // untested but at least one works; Reconnect when nothing works.
      let status: ConnectionStatus = c.status
      let detail = ''
      if (c.status !== 'paused' && c.status !== 'disconnected') {
        if (passed === 0) {
          status = 'reconnect_required'
          detail = merged.find((h) => h.state === 'failed')?.detail || 'No capability passed its check.'
        } else if (failed > 0) {
          status = 'limited'
          detail = `${merged.filter((h) => h.state === 'failed').map((h) => h.detail).join(' ')}`.trim()
        } else {
          status = 'ready'
          detail = 'Checked.'
        }
      }
      audit(c, actor, 'connection.status_changed', `Checked ${c.alias}: ${passed} working, ${failed} failing.`, { capabilities: merged.map((h) => `${h.capability}:${h.state}`) })
      return setStatus(id, status, detail, actor)
    })
  }

  function markCapability(id: string, health: CapabilityHealth): void {
    const c = getConnection(id)
    if (!c) return
    updateConnection(id, { capabilities: mergeCapabilities(c.capabilities, [health]) })
  }

  function connectionUsable(c: Connection): boolean {
    return !BLOCKING_STATUSES.has(c.status)
  }

  // ── Grants ──────────────────────────────────────────────────────────────────

  function setGrant(input: { connectionId: string; projectId: string; agentIds?: string[]; role?: GrantRole; actions: GrantAction[]; dataFilters?: string[]; approval?: ApprovalLevel; expiresAt?: number | null; actor?: string }): Grant {
    return ais.tx(() => {
      const c = getConnection(input.connectionId)
      if (!c) throw new Error('Connection not found.')
      const p = ais.getProject(input.projectId)
      if (!p) throw new Error('Project not found.')
      // Explicit scope picker only: a grant never crosses workspaces.
      if (p.workspaceId !== c.workspaceId) throw new Error(`${c.alias} belongs to another workspace, so it can’t be granted to this project.`)
      const t = now()
      const prev = activeGrantFor(c.id, p.id)
      if (prev) run(`UPDATE ais_grants SET revoked_at = ? WHERE id = ?`, t, prev.id)
      const id = newId('grt')
      run(
        `INSERT INTO ais_grants (id, connection_id, project_id, agent_ids_json, role, actions_json, data_filters_json, approval, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        c.id,
        p.id,
        JSON.stringify(input.agentIds ?? ['*']),
        input.role ?? 'use',
        JSON.stringify(input.actions),
        JSON.stringify(input.dataFilters ?? []),
        input.approval ?? 'ask_each_time',
        input.expiresAt ?? null,
        input.actor ?? 'user:me',
        t
      )
      const g = getGrant(id)!
      audit(c, input.actor ?? 'user:me', 'grant.changed', `${p.title} can use ${c.alias}: ${describeActions(input.actions)}.`, { projectId: p.id, actions: input.actions, approval: g.approval }, p.id)
      return g
    })
  }

  function revokeGrant(grantId: string, actor = 'user:me'): void {
    ais.tx(() => {
      const g = getGrant(grantId)
      if (!g || g.revokedAt) return
      run(`UPDATE ais_grants SET revoked_at = ? WHERE id = ?`, now(), grantId)
      const c = getConnection(g.connectionId)!
      const p = ais.getProject(g.projectId)
      audit(c, actor, 'grant.changed', `${p?.title ?? 'A project'} can no longer use ${c.alias}.`, { projectId: g.projectId, revoked: true }, g.projectId)
    })
  }

  function getGrant(id: string): Grant | null {
    const r = get(`SELECT * FROM ais_grants WHERE id = ?`, id)
    return r ? toGrant(r) : null
  }

  function activeGrantFor(connectionId: string, projectId: string): Grant | null {
    const r = get(`SELECT * FROM ais_grants WHERE connection_id = ? AND project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, connectionId, projectId)
    return r ? toGrant(r) : null
  }

  function grantsForProject(projectId: string): Grant[] {
    return all(`SELECT * FROM ais_grants WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at`, projectId).map(toGrant)
  }

  function grantsForConnection(connectionId: string, includeRevoked = false): Grant[] {
    return all(`SELECT * FROM ais_grants WHERE connection_id = ? ${includeRevoked ? '' : 'AND revoked_at IS NULL'} ORDER BY created_at`, connectionId).map(toGrant)
  }

  // ── Operations (catalogue and MCP tool snapshots) ───────────────────────────

  function upsertOperation(op: OperationDef & { suggestedClass?: 'read' | 'write' | null }): void {
    run(
      `INSERT INTO ais_operations (id, connection_id, adapter, title, description, classification, suggested_class, scope, destination, input_schema_json, output_schema_json, schema_version, schema_hash, rate_limit, timeout_ms, retry, review_state, origin, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, classification=excluded.classification, suggested_class=excluded.suggested_class, scope=excluded.scope,
         destination=excluded.destination, input_schema_json=excluded.input_schema_json, output_schema_json=excluded.output_schema_json, schema_version=excluded.schema_version, schema_hash=excluded.schema_hash,
         rate_limit=excluded.rate_limit, timeout_ms=excluded.timeout_ms, retry=excluded.retry, review_state=excluded.review_state, updated_at=excluded.updated_at`,
      op.id,
      op.connectionId,
      op.adapter,
      op.title,
      op.description,
      op.classification,
      op.suggestedClass ?? null,
      op.scope,
      op.destination,
      JSON.stringify(op.inputSchema ?? {}),
      op.outputSchema ? JSON.stringify(op.outputSchema) : null,
      op.schemaVersion,
      op.schemaHash,
      op.rateLimitPerMinute,
      op.timeoutMs,
      op.retry,
      op.reviewState,
      op.origin,
      now()
    )
  }

  function getOperation(id: string): (OperationDef & { suggestedClass: 'read' | 'write' | null }) | null {
    const r = get(`SELECT * FROM ais_operations WHERE id = ?`, id)
    return r ? toOperation(r) : null
  }

  function listOperations(connectionId: string): Array<OperationDef & { suggestedClass: 'read' | 'write' | null }> {
    return all(`SELECT * FROM ais_operations WHERE connection_id = ? ORDER BY title`, connectionId).map(toOperation)
  }

  // A person classifies an MCP tool (read or write) and approves it for use.
  function reviewOperation(id: string, classification: 'read' | 'write', actor = 'user:me'): void {
    ais.tx(() => {
      const op = getOperation(id)
      if (!op) throw new Error('Operation not found.')
      run(`UPDATE ais_operations SET classification = ?, review_state = 'approved', retry = ?, updated_at = ? WHERE id = ?`, classification, classification === 'read' ? 'safe_read' : 'never', now(), id)
      const c = op.connectionId ? getConnection(op.connectionId) : null
      if (c) audit(c, actor, 'connection.status_changed', `${op.title} reviewed as ${classification === 'read' ? 'reads data' : 'takes action'}.`, { operationId: id, classification })
    })
  }

  // ── Invocations (the attributed run log) ────────────────────────────────────

  function startInvocation(input: Omit<Invocation, 'id' | 'startedAt' | 'endedAt' | 'outputRef' | 'providerRequestId'> & { providerRequestId?: string | null }): Invocation {
    const id = newId('inv')
    run(
      `INSERT INTO ais_invocations (id, run_id, project_id, connection_id, principal, operation_id, input_ref, approval_json, status, detail, provider_request_id, idempotency_key, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.runId,
      input.projectId,
      input.connectionId,
      input.principal,
      input.operationId,
      input.inputRef,
      JSON.stringify(input.approval),
      input.status,
      redactSecrets(input.detail),
      input.providerRequestId ?? null,
      input.idempotencyKey,
      now()
    )
    return getInvocation(id)!
  }

  function finishInvocation(id: string, patch: { status: InvocationStatus; detail: string; outputRef?: string | null; providerRequestId?: string | null }): Invocation {
    run(
      `UPDATE ais_invocations SET status = ?, detail = ?, output_ref = COALESCE(?, output_ref), provider_request_id = COALESCE(?, provider_request_id), ended_at = ? WHERE id = ?`,
      patch.status,
      redactSecrets(patch.detail),
      patch.outputRef ?? null,
      patch.providerRequestId ?? null,
      now(),
      id
    )
    const inv = getInvocation(id)!
    const c = getConnection(inv.connectionId)
    if (c) {
      ais.appendEvent({
        workspaceId: c.workspaceId,
        projectId: inv.projectId,
        actor: inv.principal,
        kind: 'invocation.recorded',
        subject: { type: 'connection', id: c.id, label: c.alias },
        refs: inv.runId ? [{ type: 'run', id: inv.runId }] : [],
        summary: redactSecrets(`${inv.operationId} on ${c.alias}: ${patch.status}${patch.detail ? ` — ${patch.detail}` : ''}`),
        data: { invocationId: id, operationId: inv.operationId, status: patch.status },
        visibility: 'workspace'
      })
    }
    return inv
  }

  function getInvocation(id: string): Invocation | null {
    const r = get(`SELECT * FROM ais_invocations WHERE id = ?`, id)
    return r ? toInvocation(r) : null
  }

  function listInvocations(opts: { connectionId?: string; runId?: string; projectId?: string; limit?: number }): Invocation[] {
    const where: string[] = []
    const args: unknown[] = []
    if (opts.connectionId) {
      where.push('connection_id = ?')
      args.push(opts.connectionId)
    }
    if (opts.runId) {
      where.push('run_id = ?')
      args.push(opts.runId)
    }
    if (opts.projectId) {
      where.push('project_id = ?')
      args.push(opts.projectId)
    }
    args.push(opts.limit ?? 100)
    return all(`SELECT * FROM ais_invocations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`, ...args).map(toInvocation)
  }

  // Unresolved = an external action whose outcome is uncertain. Reconcile
  // before any retry (SPEC-AI-SPACE §6).
  function uncertainInvocations(connectionId?: string): Invocation[] {
    if (connectionId) return all(`SELECT * FROM ais_invocations WHERE status = 'uncertain' AND connection_id = ? ORDER BY started_at DESC`, connectionId).map(toInvocation)
    return all(`SELECT * FROM ais_invocations WHERE status = 'uncertain' ORDER BY started_at DESC`).map(toInvocation)
  }

  // ── Usage and budget reservations ───────────────────────────────────────────

  // Reserve the estimate before dispatch; reconcile when usage arrives (§7).
  function reserveUsage(input: { workspaceId: string; projectId: string | null; runId: string | null; connectionId: string; providerId: string; model: string | null; estimateMicros: number | null; currency?: string }): UsageEntry {
    const id = newId('use')
    run(
      `INSERT INTO ais_usage (id, workspace_id, project_id, run_id, connection_id, provider_id, model, amount_micros, currency, tokens_source, amount_source, state, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.workspaceId,
      input.projectId,
      input.runId,
      input.connectionId,
      input.providerId,
      input.model,
      input.estimateMicros,
      input.currency ?? 'USD',
      'unavailable',
      input.estimateMicros === null ? 'unavailable' : 'estimated',
      'reserved',
      now()
    )
    return getUsage(id)!
  }

  function settleUsage(id: string, actual: { inputTokens: number | null; outputTokens: number | null; tokensSource: UsageSource; amountMicros: number | null; amountSource: UsageSource }): UsageEntry {
    run(
      `UPDATE ais_usage SET input_tokens = ?, output_tokens = ?, tokens_source = ?, amount_micros = ?, amount_source = ?, state = 'final' WHERE id = ?`,
      actual.inputTokens,
      actual.outputTokens,
      actual.tokensSource,
      actual.amountMicros,
      actual.amountSource,
      id
    )
    return getUsage(id)!
  }

  function releaseUsage(id: string): void {
    run(`UPDATE ais_usage SET state = 'released' WHERE id = ? AND state = 'reserved'`, id)
  }

  function getUsage(id: string): UsageEntry | null {
    const r = get(`SELECT * FROM ais_usage WHERE id = ?`, id)
    return r ? toUsage(r) : null
  }

  function listUsage(opts: { connectionId?: string; projectId?: string; runId?: string; limit?: number }): UsageEntry[] {
    const where: string[] = [`state != 'released'`]
    const args: unknown[] = []
    if (opts.connectionId) {
      where.push('connection_id = ?')
      args.push(opts.connectionId)
    }
    if (opts.projectId) {
      where.push('project_id = ?')
      args.push(opts.projectId)
    }
    if (opts.runId) {
      where.push('run_id = ?')
      args.push(opts.runId)
    }
    args.push(opts.limit ?? 500)
    return all(`SELECT * FROM ais_usage WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...args).map(toUsage)
  }

  // Spent = settled amounts; reserved = in-flight estimates. Unknown amounts
  // are counted separately so a budget never pretends to know them.
  function projectSpend(projectId: string): { spentMicros: number; reservedMicros: number; unknownCount: number } {
    const r = get(
      `SELECT COALESCE(SUM(CASE WHEN state='final' AND amount_micros IS NOT NULL THEN amount_micros END),0) AS spent,
              COALESCE(SUM(CASE WHEN state='reserved' AND amount_micros IS NOT NULL THEN amount_micros END),0) AS reserved,
              COALESCE(SUM(CASE WHEN amount_micros IS NULL THEN 1 ELSE 0 END),0) AS unknown
         FROM ais_usage WHERE project_id = ? AND state != 'released'`,
      projectId
    )
    return { spentMicros: Number(r?.spent ?? 0), reservedMicros: Number(r?.reserved ?? 0), unknownCount: Number(r?.unknown ?? 0) }
  }

  function usageSummary(connectionId: string): { calls: number; inputTokens: number; outputTokens: number; amountMicros: number; unknownAmounts: number; estimated: boolean } {
    const r = get(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
              COALESCE(SUM(amount_micros),0) AS a, COALESCE(SUM(CASE WHEN amount_micros IS NULL THEN 1 ELSE 0 END),0) AS u,
              COALESCE(SUM(CASE WHEN amount_source='estimated' THEN 1 ELSE 0 END),0) AS e
         FROM ais_usage WHERE connection_id = ? AND state = 'final'`,
      connectionId
    )
    return { calls: Number(r?.calls ?? 0), inputTokens: Number(r?.i ?? 0), outputTokens: Number(r?.o ?? 0), amountMicros: Number(r?.a ?? 0), unknownAmounts: Number(r?.u ?? 0), estimated: Number(r?.e ?? 0) > 0 }
  }

  // ── Fallback routes ─────────────────────────────────────────────────────────

  function authoriseFallback(fromId: string, toId: string, actor = 'user:me'): void {
    const a = getConnection(fromId)
    const b = getConnection(toId)
    if (!a || !b) throw new Error('Connection not found.')
    if (a.workspaceId !== b.workspaceId) throw new Error('A fallback can never cross workspaces.')
    run(`INSERT OR IGNORE INTO ais_fallbacks (from_connection_id, to_connection_id, created_by, created_at) VALUES (?,?,?,?)`, fromId, toId, actor, now())
    audit(a, actor, 'connection.status_changed', `Approved ${b.alias} as a fallback for ${a.alias}.`, { fallbackTo: toId })
  }

  function listFallbacks(): Array<{ fromConnectionId: string; toConnectionId: string }> {
    return all(`SELECT * FROM ais_fallbacks`).map((r) => ({ fromConnectionId: String(r.from_connection_id), toConnectionId: String(r.to_connection_id) }))
  }

  // ── Connect drafts (setup recovery) ─────────────────────────────────────────

  function saveDraft(input: { id?: string; providerId: string; workspaceId: string | null; step: string; state: Record<string, unknown> }): string {
    const id = input.id ?? newId('dft')
    const t = now()
    run(
      `INSERT INTO ais_connect_drafts (id, provider_id, workspace_id, step, state_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET step = excluded.step, state_json = excluded.state_json, workspace_id = excluded.workspace_id, updated_at = excluded.updated_at`,
      id,
      input.providerId,
      input.workspaceId,
      input.step,
      JSON.stringify(input.state),
      t,
      t
    )
    return id
  }

  function listDrafts(): Array<{ id: string; providerId: string; workspaceId: string | null; step: string; state: Record<string, unknown>; updatedAt: number }> {
    return all(`SELECT * FROM ais_connect_drafts ORDER BY updated_at DESC`).map((r) => ({ id: String(r.id), providerId: String(r.provider_id), workspaceId: str(r.workspace_id), step: String(r.step), state: j(r.state_json, {}), updatedAt: Number(r.updated_at) }))
  }

  function deleteDraft(id: string): void {
    run(`DELETE FROM ais_connect_drafts WHERE id = ?`, id)
  }

  return {
    addConnection,
    getConnection,
    listConnections,
    updateConnection,
    setStatus,
    recordCheck,
    markCapability,
    connectionUsable,
    setGrant,
    revokeGrant,
    getGrant,
    activeGrantFor,
    grantsForProject,
    grantsForConnection,
    upsertOperation,
    getOperation,
    listOperations,
    reviewOperation,
    startInvocation,
    finishInvocation,
    getInvocation,
    listInvocations,
    uncertainInvocations,
    reserveUsage,
    settleUsage,
    releaseUsage,
    listUsage,
    projectSpend,
    usageSummary,
    authoriseFallback,
    listFallbacks,
    saveDraft,
    listDrafts,
    deleteDraft
  }
}

export function mergeCapabilities(prev: CapabilityHealth[], next: CapabilityHealth[]): CapabilityHealth[] {
  const map = new Map(prev.map((h) => [h.capability, h]))
  for (const h of next) map.set(h.capability, h)
  return [...map.values()]
}

function describeActions(actions: GrantAction[]): string {
  if (actions.length === 0) return 'nothing yet'
  const reads = actions.filter((a) => a.mode === 'read').length
  const writes = actions.filter((a) => a.mode === 'write').length
  const parts: string[] = []
  if (actions.some((a) => a.operationId === 'model:*')) parts.push('run models')
  if (reads - (actions.some((a) => a.operationId === 'model:*' && a.mode === 'read') ? 1 : 0) > 0) parts.push(`${reads} read action${reads === 1 ? '' : 's'}`)
  if (writes) parts.push(`${writes} write action${writes === 1 ? '' : 's'}`)
  return parts.join(', ')
}
