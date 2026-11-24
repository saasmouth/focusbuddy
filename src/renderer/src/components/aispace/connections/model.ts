// Connections screen: the data it shows and the small rules it follows
// (SPEC-CONNECTIONS.md §1, §2, §7).
//
// The screen state lives in a module store rather than in the component. The
// panel's link is part of the view (`{kind:'connections', connectionId}`), and
// MainPane keys each page on its whole view, so opening or closing the panel
// mounts the screen afresh. Keeping the list, the filter and "which card to
// hand focus back to" here means that remount paints the same list instantly
// and puts focus back on the card the person came from.

import { create } from 'zustand'
import type { CatalogueData, ConnectionCard, ConnectionDetailData } from '@shared/aispace/api'
import type { AiWorkspace } from '@shared/aispace/model'
import {
  CAPABILITY_LABEL,
  CONNECTION_KINDS,
  redactSecrets,
  type CapabilityState,
  type ConnectionKind,
  type Grant,
  type InvocationStatus,
  type OperationDef,
  type ProviderDefinition,
  type UsageSource
} from '@shared/aispace/connections'

export type FilterId = 'all' | ConnectionKind

export interface ConnectionsScreenState {
  cards: ConnectionCard[] | null
  catalogue: CatalogueData | null
  workspaces: AiWorkspace[]
  activeWorkspaceIds: string[]
  loadError: string | null
  filter: FilterId
  plannedOpen: boolean
  disconnectedOpen: boolean
  // The card to focus after the side panel closes (survives the remount).
  returnFocusId: string | null
}

const INITIAL: ConnectionsScreenState = {
  cards: null,
  catalogue: null,
  workspaces: [],
  activeWorkspaceIds: [],
  loadError: null,
  filter: 'all',
  plannedOpen: false,
  disconnectedOpen: false,
  returnFocusId: null
}

export const useConnectionsScreen = create<ConnectionsScreenState>(() => ({ ...INITIAL }))

// Tests start from a clean screen.
export function resetConnectionsScreen(): void {
  useConnectionsScreen.setState({ ...INITIAL }, true)
  inflight = null
  again = false
}

// One load at a time; a change that lands mid-load triggers exactly one more.
let inflight: Promise<void> | null = null
let again = false

export function loadConnections(): Promise<void> {
  if (inflight) {
    again = true
    return inflight
  }
  const run = (async () => {
    try {
      do {
        again = false
        const api = window.api.aiSpace
        const cached = useConnectionsScreen.getState().catalogue
        const [cards, catalogue, ctx] = await Promise.all([
          api.listConnections({ includeDisconnected: true }),
          cached ? Promise.resolve(cached) : api.catalogue(),
          api.getContext()
        ])
        useConnectionsScreen.setState({ cards, catalogue, workspaces: ctx.workspaces, activeWorkspaceIds: ctx.active, loadError: null })
      } while (again)
    } catch (e) {
      useConnectionsScreen.setState({ loadError: errorText(e) })
    } finally {
      inflight = null
    }
  })()
  inflight = run
  return run
}

// ── Text helpers ──────────────────────────────────────────────────────────────

// Electron wraps a main-process throw as "Error invoking remote method '…':
// Error: <message>". Show the message only, and never anything key-shaped.
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return redactSecrets(raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')).trim() || 'Something went wrong.'
}

export const FILTERS: FilterId[] = ['all', ...CONNECTION_KINDS]

export const CERTIFICATION_LABEL: Record<ProviderDefinition['certification']['status'], string> = {
  certified: 'Certified',
  conformance_tested: 'Contract-tested',
  planned: 'Planned'
}

export const CAPABILITY_STATE: Record<CapabilityState, { label: string; icon: string; status: string }> = {
  passed: { label: 'Working', icon: 'check_circle', status: 'ready' },
  failed: { label: 'Not working', icon: 'error', status: 'failed' },
  untested: { label: 'Not checked yet', icon: 'help', status: 'queued' },
  unsupported: { label: 'Not offered', icon: 'block', status: 'cancelled' }
}

export const SOURCE_LABEL: Record<UsageSource, string> = {
  reported: 'Reported',
  estimated: 'Estimated',
  unavailable: 'Unavailable'
}

// Invocation status → a StatusBadge key (icon + tone) and plain words.
export const INVOCATION_STATUS: Record<InvocationStatus, { status: string; label: string }> = {
  ok: { status: 'succeeded', label: 'Done' },
  error: { status: 'failed', label: 'Failed' },
  uncertain: { status: 'unavailable', label: 'Result uncertain' },
  blocked: { status: 'blocked', label: 'Blocked' },
  awaiting_approval: { status: 'waiting', label: 'Waiting for approval' }
}

// "Claude API" → "Claude", "OpenAI API" → "OpenAI", "Notion" → "Notion".
export function shortProviderName(name: string): string {
  return name.replace(/\s+API$/i, '').trim() || name
}

// "SaaSMouth Claude", "Personal Claude": the identity the person will recognise.
export function defaultAlias(def: Pick<ProviderDefinition, 'name' | 'kind'>, workspace: AiWorkspace | null | undefined): string {
  const short = shortProviderName(def.name)
  return workspace ? `${workspace.name} ${short}` : short
}

export function ownerLabel(kind: ConnectionKind): string {
  return kind === 'ai_account' ? 'Signed in through' : kind === 'mcp' ? 'Signed in by' : 'Key owner'
}

export function workspaceLabel(ws: AiWorkspace | undefined): string {
  if (!ws) return 'Unknown workspace'
  return `${ws.name} (${ws.kind === 'work' ? 'work' : 'personal'})`
}

// ── Grants ────────────────────────────────────────────────────────────────────

export function activeGrantFor(grants: ConnectionDetailData['grants'], projectId: string, now = Date.now()): (Grant & { projectTitle: string }) | null {
  return grants.find((g) => g.projectId === projectId && !g.revokedAt && (g.expiresAt === null || g.expiresAt > now)) ?? null
}

export function expiredGrantFor(grants: ConnectionDetailData['grants'], projectId: string, now = Date.now()): (Grant & { projectTitle: string }) | null {
  return grants.find((g) => g.projectId === projectId && !g.revokedAt && g.expiresAt !== null && g.expiresAt <= now) ?? null
}

// An operation a project may be granted right now: classified, and reviewed.
export function operationUsable(op: Pick<OperationDef, 'classification' | 'reviewState'>): boolean {
  return op.classification !== 'unknown' && op.reviewState === 'approved'
}

// The minimum a new grant starts with (§2 step 5): reads only. Writes are a
// separate, explicit choice; unreviewed tools are never included.
export function defaultActions(kind: ConnectionKind, operations: ConnectionDetailData['operations']): Array<{ operationId: string; mode: 'read' | 'write' }> {
  if (kind === 'model_api') return [{ operationId: 'model:*', mode: 'read' }]
  if (kind === 'app_api' || kind === 'mcp') return operations.filter((op) => operationUsable(op) && op.classification === 'read').map((op) => ({ operationId: op.id, mode: 'read' as const }))
  return []
}

export function describeGrant(kind: ConnectionKind, g: Grant, operations: ConnectionDetailData['operations']): string {
  const parts: string[] = []
  if (kind === 'model_api') parts.push(g.actions.some((a) => a.operationId === 'model:*') ? 'Run models' : 'No models')
  else if (kind === 'app_api' || kind === 'mcp') {
    const byId = new Map(operations.map((o) => [o.id, o]))
    const reads = g.actions.filter((a) => a.mode === 'read' && byId.get(a.operationId)?.classification !== 'write').length
    const writes = g.actions.filter((a) => a.mode === 'write').length
    parts.push(reads || writes ? [reads ? `reads ${reads}` : '', writes ? `acts with ${writes}` : ''].filter(Boolean).join(', ') : 'no actions')
    if (writes) parts.push(g.approval === 'auto' ? 'automatic' : 'asks each time')
  } else parts.push('Open chats and import')
  if (!g.agentIds.includes('*')) parts.push(`${g.agentIds.length} agent${g.agentIds.length === 1 ? '' : 's'}`)
  if (g.expiresAt) parts.push(`until ${new Date(g.expiresAt).toLocaleDateString()}`)
  return parts.join(' · ')
}

export function capabilityLabel(cap: keyof typeof CAPABILITY_LABEL): string {
  return CAPABILITY_LABEL[cap]
}

// ── Usage ─────────────────────────────────────────────────────────────────────

// One label for a set of entries: the same source everywhere, or the weakest.
export function combinedSource(sources: UsageSource[]): UsageSource | null {
  if (sources.length === 0) return null
  if (sources.every((s) => s === 'reported')) return 'reported'
  if (sources.every((s) => s === 'unavailable')) return 'unavailable'
  return 'estimated'
}

export function fmtCount(n: number): string {
  return n.toLocaleString()
}
