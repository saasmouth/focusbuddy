// How a project uses connections (SPEC-CONNECTIONS.md §6): one pure function per
// permission question, each returning every check it made so the run inspector
// and the Connections activity log can show WHY a call was allowed or refused.
//
// The rules these encode:
//  - A project uses only connections in its own workspace. A work project never
//    falls back to a personal key (acceptance: Two accounts with one provider).
//  - A grant names the project, the agents and the exact operations. Nothing
//    else is implied: untrusted text asking for an ungranted operation is
//    refused here, whatever the text says (acceptance: Agent permissions).
//  - Writes to unknown or unreviewed tools are refused until classified.
//  - Budget is checked before dispatch with the reservation counted.
//  - A fallback that changes provider, payer, region or destination needs that
//    exact route pre-authorised.

import type { AccessContext } from './model'
import type { Connection, Grant, OperationDef, PolicyCheck, PolicyDecision } from './connections'
import { BLOCKING_STATUSES, CONNECTION_STATUS_LABEL, capabilityPassed } from './connections'
import type { Capability } from './connections'

export interface PolicyProject {
  id: string
  workspaceId: string
  // Minor units are cents; budget math here runs in micros (1e-6 of currency).
  budgetLimitMicros: number | null
}

export interface UseInput {
  ctx: AccessContext
  project: PolicyProject
  connection: Connection
  grants: Grant[]
  // 'user:<id>' when a person starts the work; 'agent:<id>' when an agent does.
  principal: string
  agentId: string | null
  now: number
  // The capability the call needs (run_model, call_tool, app_read…).
  capability: Capability
}

function decide(checks: PolicyCheck[], failCode: PolicyDecision['code'] | null, reason: string): PolicyDecision {
  if (failCode) return { allowed: false, code: failCode, reason, checks }
  return { allowed: true, code: 'ok', reason: 'Allowed.', checks }
}

export function activeGrant(grants: Grant[], connectionId: string, projectId: string, now: number): Grant | null {
  return (
    grants.find(
      (g) =>
        g.connectionId === connectionId &&
        g.projectId === projectId &&
        g.revokedAt === null &&
        (g.expiresAt === null || g.expiresAt > now)
    ) ?? null
  )
}

// Can this run use this connection?
export function canUseConnection(input: UseInput): PolicyDecision {
  const { ctx, project, connection, grants, agentId, now, capability } = input
  const checks: PolicyCheck[] = []

  const inCtx = ctx.workspaceIds.includes(project.workspaceId)
  checks.push({ name: 'Project is in this context', ok: inCtx, detail: inCtx ? 'Yes.' : 'This project is not in the workspace you are working in.' })
  if (!inCtx) return decide(checks, 'workspace_mismatch', 'This project is outside the current workspace.')

  const sameSpace = connection.workspaceId === project.workspaceId
  checks.push({
    name: 'Workspace policy',
    ok: sameSpace,
    detail: sameSpace ? 'The connection belongs to the project’s workspace.' : 'The connection belongs to a different workspace.'
  })
  if (!sameSpace) return decide(checks, 'workspace_mismatch', `${connection.alias} belongs to another workspace, so this project can’t use it.`)

  const blocked = BLOCKING_STATUSES.has(connection.status)
  checks.push({
    name: 'Connection status',
    ok: !blocked,
    detail: blocked ? `${CONNECTION_STATUS_LABEL[connection.status]}.` : `${CONNECTION_STATUS_LABEL[connection.status]}.`
  })
  if (blocked) return decide(checks, 'connection_blocked', `${connection.alias}: ${CONNECTION_STATUS_LABEL[connection.status]}.`)

  const cap = capabilityPassed(connection, capability)
  checks.push({ name: 'Capability checked', ok: cap, detail: cap ? 'Its last check passed.' : 'This capability has not passed a check on this connection.' })
  if (!cap) return decide(checks, 'capability_missing', `${connection.alias} hasn’t passed a check for this yet. Test the connection first.`)

  const any = grants.filter((g) => g.connectionId === connection.id && g.projectId === project.id && g.revokedAt === null)
  const grant = activeGrant(grants, connection.id, project.id, now)
  if (!grant) {
    const expired = any.length > 0
    checks.push({ name: 'Project grant', ok: false, detail: expired ? 'The grant has expired.' : 'No grant for this project.' })
    return decide(checks, expired ? 'grant_expired' : 'no_grant', expired ? 'The project’s access to this connection expired.' : `This project hasn’t been given access to ${connection.alias}.`)
  }
  checks.push({ name: 'Project grant', ok: true, detail: `Granted ${new Date(grant.createdAt).toISOString().slice(0, 10)}.` })

  if (agentId) {
    const assigned = grant.agentIds.includes('*') || grant.agentIds.includes(agentId)
    checks.push({ name: 'Agent assignment', ok: assigned, detail: assigned ? 'The agent is on the grant.' : 'This agent is not on the grant.' })
    if (!assigned) return decide(checks, 'agent_not_assigned', 'This agent isn’t allowed to use this connection.')
  }
  return decide(checks, null, '')
}

// Can it invoke this exact action? Called for EVERY tool or app call, including
// ones a model asked for, so untrusted text never widens what runs.
export function canInvoke(
  input: UseInput & { op: OperationDef | null; requestedOperationId: string; approval: { by: string; at: number } | null }
): PolicyDecision {
  const base = canUseConnection(input)
  if (!base.allowed) return base
  const checks = [...base.checks]
  const { op, requestedOperationId } = input

  if (!op) {
    checks.push({ name: 'Operation known', ok: false, detail: `“${requestedOperationId}” is not a known operation on this connection.` })
    return decide(checks, 'operation_unknown', 'That action isn’t one this connection offers.')
  }
  if (op.connectionId && op.connectionId !== input.connection.id) {
    checks.push({ name: 'Operation known', ok: false, detail: 'The operation belongs to another connection.' })
    return decide(checks, 'operation_unknown', 'That action belongs to another connection.')
  }
  checks.push({ name: 'Operation known', ok: true, detail: `${op.title} (${op.classification}).` })

  // On the grant at all? The most basic question comes first.
  const grant = activeGrant(input.grants, input.connection.id, input.project.id, input.now)!
  const action = grant.actions.find((a) => a.operationId === op.id)
  if (!action) {
    checks.push({ name: 'Action granted', ok: false, detail: 'Not on the project’s grant.' })
    return decide(checks, 'operation_not_granted', `This project isn’t allowed to run ${op.title}.`)
  }

  if (op.reviewState !== 'approved' || op.classification === 'unknown') {
    const never = op.classification === 'unknown'
    checks.push({ name: 'Operation reviewed', ok: false, detail: never ? 'Nobody has said yet whether it reads or changes data.' : 'Its definition changed since it was approved.' })
    return decide(checks, 'operation_needs_review', never ? `${op.title} hasn’t been reviewed yet. Review it first.` : `${op.title} changed since it was approved. Review it first.`)
  }

  const needsWrite = op.classification === 'write'
  const granted = !needsWrite || action.mode === 'write'
  checks.push({ name: 'Action granted', ok: granted, detail: granted ? `Granted for ${action.mode}.` : 'Granted for reading only.' })
  if (!granted) return decide(checks, 'operation_not_granted', `This project may only read with ${op.title}, not change data.`)

  // Writes take an approval unless the grant says this exact action is automatic.
  if (needsWrite && grant.approval === 'ask_each_time' && !input.approval) {
    checks.push({ name: 'Approval', ok: false, detail: 'A person must approve this write.' })
    return decide(checks, 'approval_required', `${op.title} changes data in ${input.connection.alias}. Approve it to continue.`)
  }
  checks.push({
    name: 'Approval',
    ok: true,
    detail: !needsWrite ? 'Not needed for a read.' : input.approval ? `Approved by ${input.approval.by}.` : 'Automatic on this grant.'
  })
  return decide(checks, null, '')
}

// Can it send this data to that provider? `items` are what the request would
// carry; each names the workspace it came from and its type tag.
export function canSendData(
  input: UseInput & { items: Array<{ label: string; workspaceId: string; tag: string; sharedInto?: string[] }> }
): PolicyDecision {
  const base = canUseConnection(input)
  if (!base.allowed) return base
  const checks = [...base.checks]
  const grant = activeGrant(input.grants, input.connection.id, input.project.id, input.now)!
  for (const item of input.items) {
    const fromHere = item.workspaceId === input.project.workspaceId || (item.sharedInto ?? []).includes(input.project.workspaceId)
    if (!fromHere) {
      checks.push({ name: `Source: ${item.label}`, ok: false, detail: 'Comes from another workspace and was not shared into this one.' })
      return decide(checks, 'data_not_permitted', `${item.label} belongs to another workspace, so it can’t be sent.`)
    }
    const filtered = grant.dataFilters.length === 0 || grant.dataFilters.includes(item.tag)
    checks.push({ name: `Source: ${item.label}`, ok: filtered, detail: filtered ? 'Permitted.' : `This connection may receive ${grant.dataFilters.join(', ')} only.` })
    if (!filtered) return decide(checks, 'data_not_permitted', `${item.label} isn’t something ${input.connection.alias} is allowed to receive.`)
  }
  return decide(checks, null, '')
}

// Can it spend this amount? Micros of the project's currency.
export interface SpendInput {
  limitMicros: number | null
  spentMicros: number
  reservedMicros: number
  // null = the cost can't be estimated (no verified price for the model).
  estimateMicros: number | null
  approvedUnknownCost: boolean
}

export function canSpend(s: SpendInput): PolicyDecision {
  const checks: PolicyCheck[] = []
  if (s.limitMicros === null) {
    checks.push({ name: 'Budget', ok: true, detail: 'No budget set for this project.' })
    return decide(checks, null, '')
  }
  if (s.estimateMicros === null) {
    checks.push({ name: 'Budget', ok: s.approvedUnknownCost, detail: 'The cost of this request can’t be estimated.' })
    if (!s.approvedUnknownCost) return decide(checks, 'approval_required', 'Plexii can’t estimate this cost, so it needs your OK against the budget.')
    return decide(checks, null, '')
  }
  const after = s.spentMicros + s.reservedMicros + s.estimateMicros
  const ok = after <= s.limitMicros
  checks.push({
    name: 'Budget',
    ok,
    detail: `${fmtMicros(s.spentMicros)} spent + ${fmtMicros(s.reservedMicros)} reserved + ${fmtMicros(s.estimateMicros)} estimated of ${fmtMicros(s.limitMicros)}.`
  })
  if (!ok) return decide(checks, 'over_budget', `This would go over the project budget (${fmtMicros(after)} of ${fmtMicros(s.limitMicros)}).`)
  return decide(checks, null, '')
}

// Can it switch when the provider fails?
export interface FallbackRoute {
  fromConnectionId: string
  toConnectionId: string
}

export function canFallback(from: Connection, to: Connection, destinationOf: (c: Connection) => string, preAuthorised: FallbackRoute[]): PolicyDecision {
  const checks: PolicyCheck[] = []
  const diffs: string[] = []
  if (from.providerId !== to.providerId) diffs.push('provider')
  if ((from.billedTo ?? '') !== (to.billedTo ?? '')) diffs.push('payer')
  if ((from.region ?? '') !== (to.region ?? '')) diffs.push('region')
  if (destinationOf(from) !== destinationOf(to)) diffs.push('data destination')
  if (from.workspaceId !== to.workspaceId) diffs.push('workspace')
  const pre = preAuthorised.some((r) => r.fromConnectionId === from.id && r.toConnectionId === to.id)
  checks.push({ name: 'Same route', ok: diffs.length === 0, detail: diffs.length ? `Changes the ${diffs.join(', ')}.` : 'Nothing that matters changes.' })
  if (from.workspaceId !== to.workspaceId) return decide(checks, 'workspace_mismatch', 'A fallback can never cross workspaces.')
  if (diffs.length && !pre) {
    checks.push({ name: 'Pre-authorised', ok: false, detail: 'This exact fallback was not approved in advance.' })
    return decide(checks, 'fallback_not_authorised', `Switching to ${to.alias} changes the ${diffs.join(', ')}. Approve it first.`)
  }
  if (diffs.length) checks.push({ name: 'Pre-authorised', ok: true, detail: 'This exact fallback was approved in advance.' })
  return decide(checks, null, '')
}

export function fmtMicros(micros: number, currency = 'USD'): string {
  const v = micros / 1e6
  const digits = v !== 0 && Math.abs(v) < 0.1 ? 4 : 2
  return `${currency === 'USD' ? 'US$' : `${currency} `}${v.toFixed(digits)}`
}
