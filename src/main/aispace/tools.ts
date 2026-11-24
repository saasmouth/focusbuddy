// The tool gateway: every app-API operation and MCP tool call from AI Space
// goes through here (SPEC-CONNECTIONS.md §4 Tool invocation, §5, §6).
//
//  1. Policy per call: workspace, grant, agent, operation, classification,
//     review state, and approval for writes (canInvoke). A model's or a tool's
//     request for an ungranted operation is refused here, whatever it says.
//  2. Reconcile before retry: an earlier identical write whose outcome is
//     uncertain blocks the call until a person says what happened.
//  3. The invocation is recorded BEFORE the call with status 'uncertain' and
//     finished with the real outcome, so a crash mid-write leaves an honest
//     "uncertain" row rather than nothing.
//  4. Output enters the project as an untrusted source with provenance
//     (connection, operation, run). It can't grant permission or start work.

import { createHash } from 'node:crypto'
import type { OperationDef } from '@shared/aispace/connections'
import { redactSecrets } from '@shared/aispace/connections'
import { canInvoke } from '@shared/aispace/policy'
import type { AiSpaceStore } from './store'
import type { ConnectionsStore } from './connectionsStore'
import type { Broker } from './broker'
import { appAdapterFor, invokeOperation, operationDefsFor, verifyConnection } from './appapi'
import type { InvokeResult } from './appapi/adapter'
import { loopbackAllowedByEnv } from './net'

export interface ToolCallResult {
  status: 'ok' | 'error' | 'uncertain' | 'blocked' | 'awaiting_approval'
  invocationId: string | null
  detail: string
  sourceId: string | null
  output: unknown
  // Shown when approval is needed: the tool, account, data touched and effect.
  approval: null | { tool: string; account: string; payer: string; touches: string; effect: string; destination: string }
}

// MCP plugs in through this interface so the gateway owns policy for both.
export interface McpCaller {
  call(connectionId: string, toolName: string, input: unknown): Promise<{ ok: boolean; uncertain: boolean; text: string; output: unknown; detail: string; providerRequestId: string | null }>
}

export interface ToolGatewayDeps {
  store: AiSpaceStore
  conns: ConnectionsStore
  broker: Broker
  now?: () => number
  mcp?: () => McpCaller | null
  // Test-only origin overrides for local fakes (honoured only with
  // AISPACE_ALLOW_LOOPBACK=1).
  appOptions?: (providerId: string) => { fetchImpl?: typeof fetch; adapterOverride?: ReturnType<typeof appAdapterFor> } | undefined
}

export function appOpId(connectionId: string, opId: string): string {
  return `app:${connectionId}:${opId}`
}

export function createToolGateway(deps: ToolGatewayDeps) {
  const { store, conns, broker } = deps
  const now = deps.now ?? (() => Date.now())

  function adapterFor(providerId: string) {
    const override = loopbackAllowedByEnv() ? deps.appOptions?.(providerId)?.adapterOverride : undefined
    return override ?? appAdapterFor(providerId)
  }

  // Catalogue operations are stored per connection (namespaced), approved as
  // reviewed adapter definitions.
  function syncAppOperations(connectionId: string): OperationDef[] {
    const c = conns.getConnection(connectionId)
    if (!c) throw new Error('Connection not found.')
    const defs = operationDefsFor(adapterFor(c.providerId)!, connectionId).map((d) => ({ ...d, id: appOpId(connectionId, d.id) }))
    for (const d of defs) conns.upsertOperation(d)
    return defs
  }

  async function addAppApi(input: { providerId: string; workspaceId: string; alias: string; token: string; billedTo?: string | null; draftParentId?: string | null; draftParentTitle?: string | null }) {
    const adapter = adapterFor(input.providerId)
    if (!adapter) throw new Error('This app can’t be connected yet.')
    const token = input.token.trim()
    if (!token) throw new Error('Paste the token.')
    const check = await verifyConnection({ adapter, connectionId: 'pending', secret: token, allowLoopback: loopbackAllowedByEnv(), fetchImpl: deps.appOptions?.(input.providerId)?.fetchImpl })
    if (!check.ok) return { ok: false as const, detail: check.detail }
    const c = conns.addConnection({
      workspaceId: input.workspaceId,
      providerId: input.providerId,
      kind: 'app_api',
      alias: input.alias || adapter.id,
      credentialOwner: 'You',
      billedTo: input.billedTo ?? null,
      config: { draftParentId: input.draftParentId ?? null, draftParentTitle: input.draftParentTitle ?? null }
    })
    broker.store(c.id, token)
    conns.updateConnection(c.id, { hasSecret: true, secretHint: `…${token.slice(-4)}` })
    conns.recordCheck(c.id, check.capabilities, { identity: check.identity, providerOrg: check.providerOrg })
    syncAppOperations(c.id)
    return { ok: true as const, connection: conns.getConnection(c.id)!, confirmed: [check.detail] }
  }

  async function testAppApi(connectionId: string) {
    const c = conns.getConnection(connectionId)
    if (!c) throw new Error('Connection not found.')
    const adapter = adapterFor(c.providerId)!
    const check = await broker.withSecret(c, 'verify', (secret) => verifyConnection({ adapter, connectionId, secret, allowLoopback: loopbackAllowedByEnv(), fetchImpl: deps.appOptions?.(c.providerId)?.fetchImpl }))
    if (!check.ok) {
      conns.setStatus(c.id, check.code === 'reconnect_required' ? 'reconnect_required' : 'limited', check.detail, 'user:me')
      return { connection: conns.getConnection(c.id)!, confirmed: [check.detail] }
    }
    if (c.identity && check.identity && c.identity !== check.identity) {
      conns.setStatus(c.id, 'reconnect_required', 'The token now belongs to a different workspace.', 'user:me')
      return { connection: conns.getConnection(c.id)!, confirmed: ['Account mismatch: this token belongs to a different workspace than before.'] }
    }
    return { connection: conns.recordCheck(c.id, check.capabilities, { identity: check.identity, providerOrg: check.providerOrg }), confirmed: [check.detail] }
  }

  function inputHash(operationId: string, input: unknown): string {
    return createHash('sha256').update(operationId).update('\u0000').update(JSON.stringify(input ?? null)).digest('hex').slice(0, 24)
  }

  function describeTouches(op: OperationDef, input: unknown): string {
    const where = op.destination ? ` at ${op.destination}` : ''
    const keys = input && typeof input === 'object' ? Object.entries(input as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === 'string' ? (v.length > 60 ? `${v.slice(0, 58)}…` : v) : JSON.stringify(v)}`) : []
    return `${keys.length ? keys.join(' · ') : 'No input.'}${where}`
  }

  async function call(input: { projectId: string; connectionId: string; operationId: string; input: unknown; principal: string; agentId?: string | null; runId?: string | null; approval?: { by: string; at: number } | null }): Promise<ToolCallResult> {
    const project = store.getProject(input.projectId)
    const connection = conns.getConnection(input.connectionId)
    if (!project || !connection) return { status: 'blocked', invocationId: null, detail: 'Project or connection not found.', sourceId: null, output: null, approval: null }
    const op = conns.getOperation(input.operationId)
    const grants = conns.grantsForProject(project.id)
    const capability = connection.kind === 'mcp' ? 'call_tool' : op?.classification === 'write' ? 'app_write' : 'app_read'
    const policyCtx = { ctx: { workspaceIds: [project.workspaceId] }, project: { id: project.id, workspaceId: project.workspaceId, budgetLimitMicros: null }, connection, grants, principal: input.principal, agentId: input.agentId ?? null, now: now() }
    // app_write can't be proven without writing; the first approved write proves it.
    const capOk = capability === 'app_write' ? 'app_read' : capability
    const decision = canInvoke({ ...policyCtx, capability: capOk, op, requestedOperationId: input.operationId, approval: input.approval ?? null })
    const hash = inputHash(input.operationId, input.input)
    const base = {
      runId: input.runId ?? null,
      projectId: project.id,
      connectionId: connection.id,
      principal: input.principal,
      operationId: input.operationId,
      inputRef: `sha256:${hash}`,
      idempotencyKey: null
    }
    if (!decision.allowed) {
      if (decision.code === 'approval_required' && op) {
        const inv = conns.startInvocation({ ...base, approval: { mode: 'ask_each_time', by: null, at: null }, status: 'awaiting_approval', detail: decision.reason })
        return {
          status: 'awaiting_approval',
          invocationId: inv.id,
          detail: decision.reason,
          sourceId: null,
          output: null,
          approval: { tool: op.title, account: connection.alias, payer: connection.billedTo ?? 'Unknown payer', touches: describeTouches(op, input.input), effect: op.description || (op.classification === 'write' ? 'Changes data in the app.' : 'Reads data.'), destination: op.destination }
        }
      }
      const inv = conns.startInvocation({ ...base, approval: { mode: 'not_required', by: null, at: null }, status: 'blocked', detail: decision.reason })
      conns.finishInvocation(inv.id, { status: 'blocked', detail: `${decision.reason} (${decision.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')})` })
      return { status: 'blocked', invocationId: inv.id, detail: decision.reason, sourceId: null, output: null, approval: null }
    }
    // Reconcile before retry: an identical write with an unknown outcome waits.
    if (op!.classification === 'write') {
      const prior = conns.uncertainInvocations(connection.id).find((i) => i.operationId === input.operationId && i.inputRef === base.inputRef)
      if (prior) {
        return { status: 'blocked', invocationId: prior.id, detail: 'An earlier identical request may already have gone through. Check in the app and mark it done or not done before trying again.', sourceId: null, output: null, approval: null }
      }
    }
    const inv = conns.startInvocation({ ...base, approval: input.approval ? { mode: 'ask_each_time', by: input.approval.by, at: input.approval.at } : { mode: op!.classification === 'write' ? 'auto' : 'not_required', by: null, at: null }, status: 'uncertain', detail: 'In progress.' })
    let result: { status: 'ok' | 'error' | 'uncertain' | 'blocked'; detail: string; output: unknown; text: string; providerRequestId: string | null }
    try {
      if (connection.kind === 'mcp') {
        const mcp = deps.mcp?.()
        if (!mcp) throw new Error('MCP isn’t available.')
        const toolName = input.operationId.split(':').slice(2).join(':')
        const r = await mcp.call(connection.id, toolName, input.input)
        result = { status: r.ok ? 'ok' : r.uncertain ? 'uncertain' : 'error', detail: r.detail, output: r.output, text: r.text, providerRequestId: r.providerRequestId }
      } else {
        const adapter = adapterFor(connection.providerId)!
        const rawOpId = input.operationId.split(':').slice(2).join(':')
        const r: InvokeResult = await broker.withSecret(connection, 'invoke', (secret) =>
          invokeOperation({ adapter, operationId: rawOpId, connectionId: connection.id, input: input.input, secret, allowLoopback: loopbackAllowedByEnv(), fetchImpl: deps.appOptions?.(connection.providerId)?.fetchImpl })
        )
        result = { status: r.status, detail: r.detail, output: r.output, text: textOf(r.output), providerRequestId: r.providerRequestId }
        if (r.code === 'reconnect_required') conns.setStatus(connection.id, 'reconnect_required', r.detail, 'system')
      }
    } catch (e) {
      const msg = redactSecrets(e instanceof Error ? e.message : String(e))
      // A thrown error before anything was sent is a plain error; the gateway
      // can't tell for MCP writes, so those stay uncertain.
      const uncertain = op!.classification === 'write' && connection.kind === 'mcp'
      result = { status: uncertain ? 'uncertain' : 'error', detail: msg, output: null, text: '', providerRequestId: null }
    }
    let sourceId: string | null = null
    if (result.status === 'ok') {
      if (op!.classification === 'write' && connection.kind === 'app_api') conns.markCapability(connection.id, { capability: 'app_write', state: 'passed', checkedAt: now(), detail: 'An approved write succeeded.' })
      if (connection.kind === 'mcp') conns.markCapability(connection.id, { capability: 'call_tool', state: 'passed', checkedAt: now(), detail: 'A tool call succeeded.' })
      const src = store.addSource({
        projectId: project.id,
        workspaceId: project.workspaceId,
        kind: connection.kind === 'mcp' ? 'tool_result' : 'app_api',
        title: `${op!.title} · ${connection.alias}`,
        content: result.text,
        provider: connection.providerId,
        connectionId: connection.id,
        runId: input.runId ?? null,
        originalLocation: urlOf(result.output),
        actor: input.principal
      })
      sourceId = src.id
    }
    conns.finishInvocation(inv.id, { status: result.status, detail: result.detail, outputRef: sourceId ? `source:${sourceId}` : null, providerRequestId: result.providerRequestId })
    return { status: result.status, invocationId: inv.id, detail: result.detail, sourceId, output: result.output, approval: null }
  }

  // Approve a held write: re-run it with the person's approval on record.
  async function approve(invocationId: string, input: unknown, by = 'user:me'): Promise<ToolCallResult> {
    const inv = conns.getInvocation(invocationId)
    if (!inv || inv.status !== 'awaiting_approval') throw new Error('Nothing is waiting for approval there.')
    if (inv.inputRef !== `sha256:${inputHash(inv.operationId, input)}`) throw new Error('The request changed since it was shown. Review it again.')
    conns.finishInvocation(inv.id, { status: 'blocked', detail: `Approved by ${by.replace(/^user:/, '')}; sent as a new attempt.` })
    return call({ projectId: inv.projectId!, connectionId: inv.connectionId, operationId: inv.operationId, input, principal: inv.principal, runId: inv.runId, approval: { by, at: now() } })
  }

  function decline(invocationId: string, by = 'user:me'): void {
    const inv = conns.getInvocation(invocationId)
    if (!inv || inv.status !== 'awaiting_approval') return
    conns.finishInvocation(inv.id, { status: 'blocked', detail: `Declined by ${by.replace(/^user:/, '')}.` })
  }

  // The person reconciles an uncertain write after checking in the app.
  function reconcile(invocationId: string, outcome: 'done' | 'not_done', by = 'user:me'): void {
    const inv = conns.getInvocation(invocationId)
    if (!inv || inv.status !== 'uncertain') return
    conns.finishInvocation(inv.id, { status: outcome === 'done' ? 'ok' : 'error', detail: outcome === 'done' ? `Confirmed done by ${by.replace(/^user:/, '')} after checking.` : `Confirmed not done by ${by.replace(/^user:/, '')}; safe to try again.` })
  }

  // After a restart: an in-flight READ is simply an error now (safe to redo);
  // an in-flight WRITE stays uncertain for a person to reconcile.
  function recoverOnStartup(): number {
    let n = 0
    for (const inv of conns.uncertainInvocations()) {
      if (inv.endedAt !== null) continue
      const op = conns.getOperation(inv.operationId)
      if (op?.classification === 'read') {
        conns.finishInvocation(inv.id, { status: 'error', detail: 'Plexii closed before the answer arrived. Nothing changed; you can run it again.' })
        n++
      } else {
        conns.finishInvocation(inv.id, { status: 'uncertain', detail: 'Plexii closed before the answer arrived. Check in the app whether it happened before trying again.' })
      }
    }
    return n
  }

  return { syncAppOperations, addAppApi, testAppApi, call, approve, decline, reconcile, recoverOnStartup }
}

export type ToolGateway = ReturnType<typeof createToolGateway>

function textOf(output: unknown): string {
  if (output == null) return ''
  if (typeof output === 'string') return output
  const o = output as Record<string, unknown>
  if (typeof o.text === 'string') return `${typeof o.title === 'string' ? `# ${o.title}\n\n` : ''}${o.text}`
  if (Array.isArray(o.results)) return (o.results as Array<Record<string, unknown>>).map((r) => `- ${String(r.title ?? r.id)}${r.url ? ` (${String(r.url)})` : ''}`).join('\n')
  return JSON.stringify(output, null, 2).slice(0, 60_000)
}

function urlOf(output: unknown): string | null {
  if (output && typeof output === 'object' && typeof (output as Record<string, unknown>).url === 'string') return String((output as Record<string, unknown>).url)
  return null
}
