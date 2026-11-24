// AI Space + Connections service: the one object IPC talks to.
//
// It owns the access context (which workspaces the person is working in), so
// every list, search, brief and notification is filtered the same way
// (SPEC-AI-SPACE §6 "Keep permissions consistent across search, previews,
// agent inputs and notifications").

import type { SqlDb } from '../db/eventStore'
import type { AccessContext, AiProject, AiRun, OutputKind, RecordRef, RunStatus, WorkspaceKind } from '@shared/aispace/model'
import type { Connection, ConnectionKind, GrantAction, ApprovalLevel, CapabilityHealth } from '@shared/aispace/connections'
import { redactSecrets, secretHintOf, payerLabel } from '@shared/aispace/connections'
import { addableProviders, providerById, providerForChatUrl, MCP_CATALOGUE } from '@shared/aispace/catalogue'
import { computeImpact, stateAsOf } from '@shared/aispace/impact'
import { buildReturnBrief, type NeedsYou, type ReturnBrief } from '@shared/aispace/brief'
import { createAiSpaceStore, type AiSpaceStore } from './store'
import { createConnectionsStore, type ConnectionConfig, type ConnectionsStore } from './connectionsStore'
import { createBroker, type Broker } from './broker'
import type { Vault } from './vault'
import { createRunner, type Runner, type StartRunInput } from './runner'
import { createCoordinator, type Coordinator } from './coordinator'
import { createModelAdapter, isModelProviderId, type ModelAdapter } from './providers'
import { ProviderError } from './providers/types'
import { loopbackAllowedByEnv } from './net'
import { providerModels, providersWithModels } from './models'
import type { AccessImpactData, AddConnectionResult, CaptureResultData, CatalogueData, ConnectionCard, ConnectionDetailData, HomeData, ImpactResponse, ProjectViewData, RunDetailData, RunSummary, SearchHitData, StartRunResponse, TestConnectionResult } from '@shared/aispace/api'

export interface ServiceDeps {
  db: SqlDb
  vault: Vault
  grant: <T>(fn: () => Promise<T>) => Promise<T>
  now?: () => number
  // Push a change to open windows ({topic, projectId?, runId?}).
  emit?: (payload: { topic: string; projectId?: string | null; runId?: string | null }) => void
  // Test-only: point a provider at a local server (honoured only when
  // AISPACE_ALLOW_LOOPBACK=1, which nothing in the shipped app sets).
  baseUrlFor?: (providerId: string) => string | undefined
  pollEveryMs?: number
}

export type AiSpaceService = ReturnType<typeof createAiSpaceService>

export function createAiSpaceService(deps: ServiceDeps) {
  const now = deps.now ?? (() => Date.now())
  const store: AiSpaceStore = createAiSpaceStore(deps.db, { now })
  const conns: ConnectionsStore = createConnectionsStore(deps.db, store, { now })
  const broker: Broker = createBroker(deps.vault)
  const emit = deps.emit ?? (() => {})

  const adapters = new Map<string, ModelAdapter>()
  function adapterForProvider(providerId: string): ModelAdapter | null {
    if (!isModelProviderId(providerId)) return null
    const cached = adapters.get(providerId)
    if (cached) return cached
    const loop = loopbackAllowedByEnv()
    const baseUrl = loop ? deps.baseUrlFor?.(providerId) : undefined
    const a = createModelAdapter(providerId, baseUrl ? { baseUrl, allowLoopback: true } : {})
    adapters.set(providerId, a)
    return a
  }

  const runner: Runner = createRunner({
    store,
    conns,
    broker,
    adapterFor: (c) => (c.kind === 'model_api' ? adapterForProvider(c.providerId) : null),
    grant: deps.grant,
    now,
    pollEveryMs: deps.pollEveryMs,
    onChange: (runId) => {
      const r = store.getRun(runId)
      emit({ topic: 'run', projectId: r?.projectId ?? null, runId })
    }
  })

  const revoked = () => conns.listConnections(allCtx(), { includeDisconnected: true }).filter((c) => c.status === 'disconnected').map((c) => c.id)
  const coordinator: Coordinator = createCoordinator({ store, conns, runner, revokedConnectionIds: revoked })
  coordinator.start()
  store.onEvent((e) => emit({ topic: 'event', projectId: e.projectId }))

  // ── Context ─────────────────────────────────────────────────────────────────

  store.ensureDefaultWorkspaces()
  const allCtx = (): AccessContext => ({ workspaceIds: store.listWorkspaces().map((w) => w.id) })
  let ctx: AccessContext = allCtx()

  function getContext() {
    return { workspaces: store.listWorkspaces(), active: ctx.workspaceIds }
  }

  function setContext(workspaceIds: string[]) {
    const known = new Set(store.listWorkspaces().map((w) => w.id))
    const ids = workspaceIds.filter((id) => known.has(id))
    ctx = { workspaceIds: ids.length ? ids : allCtx().workspaceIds }
    emit({ topic: 'context' })
    return getContext()
  }

  function createWorkspace(kind: WorkspaceKind, name: string) {
    const w = store.createWorkspace(kind, name)
    ctx = { workspaceIds: [...ctx.workspaceIds, w.id] }
    emit({ topic: 'context' })
    return w
  }

  function inContext(projectId: string): AiProject {
    const p = store.getProjectInCtx(ctx, projectId)
    if (!p) throw new Error('That project isn’t in the workspace you’re working in.')
    return p
  }

  // ── Home ────────────────────────────────────────────────────────────────────

  function connectionNeeds(): NeedsYou[] {
    const out: NeedsYou[] = []
    for (const c of conns.listConnections(ctx)) {
      if (c.status === 'reconnect_required' || c.status === 'limited') {
        const used = conns.grantsForConnection(c.id).length
        if (used === 0 && c.status === 'limited') continue
        out.push({ id: `nc_${c.id}`, kind: 'reconnect', text: `${c.alias}: ${c.status === 'reconnect_required' ? 'reconnect required' : 'limited'}${c.statusDetail ? ` — ${c.statusDetail}` : ''}`, target: { type: 'connection', id: c.id, label: c.alias }, since: c.statusSince })
      }
    }
    for (const inv of conns.uncertainInvocations()) {
      const c = conns.getConnection(inv.connectionId)
      if (!c || !ctx.workspaceIds.includes(c.workspaceId)) continue
      out.push({ id: `nu_${inv.id}`, kind: 'uncertain_action', text: `Check ${inv.operationId} on ${c.alias}: the result is uncertain, so Plexii won’t retry it.`, target: { type: 'connection', id: c.id, label: c.alias }, since: inv.startedAt })
    }
    return out
  }

  function home(): HomeData {
    const mark = store.getViewMark('home')
    const since = mark?.at ?? 0
    const projects = store.listProjects(ctx).slice(0, 30)
    const briefs: ReturnBrief[] = []
    const needsYou: Array<NeedsYou & { projectId: string | null; projectTitle: string | null }> = []
    for (const p of projects) {
      const state = store.loadProjectState(p.id, revoked())
      const b = buildReturnBrief(state, Math.max(since, store.getViewMark(`project:${p.id}`)?.at ?? 0))
      briefs.push(b)
      for (const n of b.needsYou) needsYou.push({ ...n, projectId: p.id, projectTitle: p.title })
    }
    for (const n of connectionNeeds()) needsYou.push({ ...n, projectId: null, projectTitle: null })
    const activeRuns = store.listRuns(ctx, { statuses: ['queued', 'running', 'waiting', 'unavailable'], limit: 50 }).map((r) => runSummary(r))
    const updates = briefs
      .flatMap((b) => b.updates.map((u) => ({ ...u, projectId: b.projectId, projectTitle: b.projectTitle })))
      .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || b.at - a.at)
    return {
      since,
      firstVisit: !mark,
      updates,
      needsYou,
      activeRuns,
      projects: projects.map((p) => {
        const b = briefs.find((x) => x.projectId === p.id)!
        return { project: p, headline: b.headline, currentDeliverable: b.currentDeliverable ? { id: b.currentDeliverable.output.id, title: b.currentDeliverable.output.title, kind: b.currentDeliverable.output.kind, why: b.currentDeliverable.why } : null, needs: b.needsYou.length, nextStep: b.nextStep }
      }),
      sharedIn: store.listSharedInto(ctx).map((s) => ({ shareId: s.shareId, title: s.title, kind: s.kind, versionId: s.version.id, n: s.version.n, excerpt: s.version.content.slice(0, 200) })),
      inbox: store.listThreads(ctx, null).map((t) => ({ id: t.id, title: t.title, provider: t.provider, level: t.level, capturedAt: t.capturedAt })),
      storageNote: 'AI Space projects are stored on this Mac only. They don’t sync to your other devices yet.'
    }
  }

  function markHomeViewed() {
    store.markViewed('home')
  }

  // ── Projects ────────────────────────────────────────────────────────────────

  function createProject(input: { workspaceId?: string; title: string; goal?: string; brief?: string; deskId?: string | null; roomId?: string | null }) {
    const workspaceId = input.workspaceId && ctx.workspaceIds.includes(input.workspaceId) ? input.workspaceId : ctx.workspaceIds[0]
    const p = store.createProject({ ...input, workspaceId })
    store.markViewed(`project:${p.id}`)
    return p
  }

  function projectForDesk(deskId: string) {
    const p = store.projectForDesk(deskId)
    return p && ctx.workspaceIds.includes(p.workspaceId) ? p : null
  }

  function projectView(projectId: string): ProjectViewData {
    const p = inContext(projectId)
    const mark = store.getViewMark(`project:${p.id}`)
    const state = store.loadProjectState(p.id, revoked())
    const brief = buildReturnBrief(state, mark?.at ?? 0, connectionNeeds().filter((n) => conns.grantsForProject(p.id).some((g) => g.connectionId === n.target.id)))
    const outputs = store.listOutputs(p.id, { includeBrief: true }).map((o) => {
      const latest = o.latestVersionId ? store.getVersion(o.latestVersionId) : null
      const approved = o.approvedVersionId ? store.getVersion(o.approvedVersionId) : null
      return { ...o, latest: latest ? versionMeta(latest) : null, approved: approved ? versionMeta(approved) : null, versionCount: store.listVersions(o.id).length }
    })
    const grants = conns.grantsForProject(p.id).map((g) => {
      const c = conns.getConnection(g.connectionId)
      return { ...g, connection: c ? connectionCard(c) : null }
    })
    return {
      project: p,
      workspace: store.listWorkspaces().find((w) => w.id === p.workspaceId) ?? null,
      tasks: store.listTasks(p.id),
      outputs,
      agents: store.listAgents(p.id),
      threads: store.listThreads(ctx, p.id),
      decisions: store.listDecisions(p.id),
      sources: store.listSources(p.id),
      requests: store.listRequests(p.id),
      suggestions: store.listSuggestions(p.id),
      branches: store.listBranches(p.id),
      runs: store.listRuns(ctx, { projectId: p.id, limit: 50 }).map(runSummary),
      brief: { ...brief, impact: undefined },
      grants,
      eligibleConnections: eligibleConnections(p),
      spend: conns.projectSpend(p.id),
      storageNote: 'Stored on this Mac only. AI Space projects don’t sync yet.'
    }
  }

  function eligibleConnections(p: AiProject) {
    return conns
      .listConnections({ workspaceIds: [p.workspaceId] })
      .map((c) => ({ ...connectionCard(c), granted: Boolean(conns.activeGrantFor(c.id, p.id)) }))
  }

  function markProjectViewed(projectId: string) {
    inContext(projectId)
    store.markViewed(`project:${projectId}`)
  }

  // Impact now, or as of a moment, or "When I left" vs now, from one record set.
  function impact(projectId: string, opts: { asOf?: number | null; since?: number | null } = {}): ImpactResponse {
    const p = inContext(projectId)
    const full = store.loadProjectState(p.id, revoked())
    const state = opts.asOf ? stateAsOf(full, opts.asOf) : stateAsOf(full, full.asOf)
    const mark = store.getViewMark(`project:${p.id}`)
    return {
      asOf: state.asOf,
      leftAt: mark?.at ?? null,
      result: computeImpact(state, { since: opts.since ?? 0 }),
      activity: store.listEvents(ctx, { projectId: p.id, limit: 300 }).filter((e) => e.at <= state.asOf),
      timeline: full.events.map((e) => ({ seq: e.seq, at: e.at, kind: e.kind, summary: e.summary }))
    }
  }

  // ── Runs ────────────────────────────────────────────────────────────────────

  function runSummary(r: AiRun): RunSummary {
    const p = store.getProject(r.projectId)
    const t = r.aiTaskId ? store.getTask(r.aiTaskId) : null
    const target = r.manifest.targetOutputId ? store.getOutput(r.manifest.targetOutputId) : null
    return {
      id: r.id,
      projectId: r.projectId,
      aiTaskId: r.aiTaskId,
      projectTitle: p?.title ?? '',
      title: t?.title ?? target?.title ?? firstWords(r.manifest.instruction, 60),
      status: r.status,
      statusDetail: r.statusDetail,
      kind: r.kind,
      connectionAlias: r.manifest.connectionAlias,
      provider: r.manifest.provider,
      model: r.manifest.model,
      modelLabel: r.manifest.model ? providerModels(r.manifest.provider ?? '').find((m) => m.id === r.manifest.model)?.label ?? null : null,
      billedTo: r.manifest.billedTo,
      externalId: r.externalId,
      lastConfirmedStep: r.lastConfirmedStep,
      lastConfirmedAt: r.lastConfirmedAt,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      canCancel: !['succeeded', 'failed', 'cancelled'].includes(r.status) && (runner.isInflight(r.id) || Boolean(r.externalId) || r.status === 'queued'),
      canPause: false,
      canRetry: r.status === 'failed' || r.status === 'cancelled',
      hasHeldDraft: r.status === 'waiting' && Boolean(r.manifest.targetOutputId)
    }
  }

  function listRuns(filter: { projectId?: string; statuses?: RunStatus[]; provider?: string } = {}): RunSummary[] {
    return store
      .listRuns(ctx, { projectId: filter.projectId, statuses: filter.statuses, limit: 300 })
      .filter((r) => !filter.provider || r.manifest.provider === filter.provider)
      .map(runSummary)
  }

  function runDetail(runId: string): RunDetailData {
    const r = store.getRun(runId)
    if (!r) throw new Error('Run not found.')
    inContext(r.projectId)
    const inputs = r.manifest.inputs.map((ref) => ({ ref, label: labelRef(ref) }))
    return {
      run: runSummary(r),
      manifest: r.manifest,
      inputs,
      steps: store.listRunSteps(r.id),
      invocations: conns.listInvocations({ runId: r.id }),
      usage: conns.listUsage({ runId: r.id }),
      handoverOf: r.handoverOf,
      followUps: store.listRuns(ctx, { projectId: r.projectId }).filter((x) => x.handoverOf === r.id).map((x) => x.id)
    }
  }

  function startRun(input: StartRunInput): StartRunResponse {
    inContext(input.projectId)
    const res = runner.startRun(input)
    return res.ok ? { ok: true as const, run: runSummary(res.run), duplicate: res.duplicate } : res
  }

  // ── Capture ─────────────────────────────────────────────────────────────────

  function capture(input: { url?: string | null; selectedText?: string | null; title?: string | null; projectId?: string | null; workspaceId?: string | null }): CaptureResultData {
    const url = input.url?.trim() || null
    if (url && !/^https:\/\//i.test(url)) throw new Error('Only https links can be captured.')
    const provider = url ? providerForChatUrl(url) ?? null : null
    const workspaceId = input.projectId ? inContext(input.projectId).workspaceId : input.workspaceId && ctx.workspaceIds.includes(input.workspaceId) ? input.workspaceId : ctx.workspaceIds[0]
    const title = input.title?.trim() || (input.selectedText ? firstWords(input.selectedText, 60) : url ? `${provider?.name ?? 'Link'} chat` : 'Capture')
    const { thread, source } = store.captureChat({ workspaceId, projectId: input.projectId ?? null, url, title, provider: provider?.id ?? null, selectedText: input.selectedText ?? null })
    const suggestions = input.projectId ? [] : suggestProjects(`${title} ${input.selectedText ?? ''}`)
    return { thread, source, provider: provider ? { id: provider.id, name: provider.name } : null, suggestions }
  }

  // Up to three matching projects for an unfiled capture (§1 Start and capture).
  function suggestProjects(text: string) {
    const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3))
    return store
      .listProjects(ctx)
      .map((p) => {
        const pw = `${p.title} ${p.goal}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3)
        const hits = pw.filter((w) => words.has(w))
        return { id: p.id, title: p.title, score: hits.length, why: hits.length ? `Mentions ${[...new Set(hits)].slice(0, 3).join(', ')}` : '' }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
  }

  // ── Connections ─────────────────────────────────────────────────────────────

  function connectionCard(c: Connection & { config?: ConnectionConfig }): ConnectionCard {
    const def = providerById(c.providerId)
    const usage = conns.usageSummary(c.id)
    return {
      ...c,
      config: c.config ?? {},
      providerName: def?.name ?? c.providerId,
      group: def?.group ?? c.providerId,
      payer: payerLabel(c),
      dataDestination: c.endpoint ? new URL(c.endpoint).host : def?.dataDestination ?? null,
      onThisMac: Boolean(c.config?.localEndpoint),
      eligibleProjects: conns.grantsForConnection(c.id).map((g) => ({ projectId: g.projectId, title: store.getProject(g.projectId)?.title ?? '' })),
      usage,
      keySettingsUrl: def?.keySettingsUrl ?? null,
      billingUrl: def?.billingUrl ?? null,
      certification: def?.certification ?? null,
      defaultModel: c.config?.defaultModel ?? providerModels(c.providerId)[0]?.id ?? null,
      models: providerModels(c.providerId)
    }
  }

  function catalogue(): CatalogueData {
    return { providers: providersWithModels(), addable: addableProviders().map((p) => p.id), mcp: MCP_CATALOGUE }
  }

  function listConnections(filter: { kind?: ConnectionKind; includeDisconnected?: boolean } = {}): ConnectionCard[] {
    return conns.listConnections(ctx, filter).map(connectionCard)
  }

  function connectionDetail(id: string): ConnectionDetailData {
    const c = conns.getConnection(id)
    if (!c || !ctx.workspaceIds.includes(c.workspaceId)) throw new Error('Connection not found.')
    return {
      connection: connectionCard(c),
      grants: conns.grantsForConnection(c.id, true).map((g) => ({ ...g, projectTitle: store.getProject(g.projectId)?.title ?? '' })),
      operations: conns.listOperations(c.id),
      usage: conns.listUsage({ connectionId: c.id, limit: 200 }),
      invocations: conns.listInvocations({ connectionId: c.id, limit: 100 }),
      runs: store.listRuns(ctx, { limit: 300 }).filter((r) => r.manifest.connectionId === c.id).slice(0, 50).map(runSummary),
      activity: store.listEvents(ctx, { limit: 500 }).filter((e) => e.subject?.type === 'connection' && e.subject.id === c.id).reverse(),
      projects: store.listProjects({ workspaceIds: [c.workspaceId] }).map((p) => ({ id: p.id, title: p.title }))
    }
  }

  // What changes if access changes: shown BEFORE pause/disconnect/revoke (§2).
  function accessImpact(id: string): AccessImpactData {
    const c = conns.getConnection(id)
    if (!c) throw new Error('Connection not found.')
    const grants = conns.grantsForConnection(c.id)
    const agents = grants.flatMap((g) => store.listAgents(g.projectId).filter((a) => a.connectionId === c.id).map((a) => ({ id: a.id, name: a.name, projectTitle: store.getProject(g.projectId)?.title ?? '' })))
    const runs = store.listRuns(ctx, { statuses: ['queued', 'running', 'waiting', 'unavailable'], limit: 500 }).filter((r) => r.manifest.connectionId === c.id)
    const scheduled = runs.filter((r) => r.aiTaskId && store.getTask(r.aiTaskId)?.scheduledAt)
    const defaults = store.listProjects({ workspaceIds: [c.workspaceId] }).filter((p) => p.defaultConnectionId === c.id)
    return {
      projects: grants.map((g) => ({ id: g.projectId, title: store.getProject(g.projectId)?.title ?? '' })),
      agents,
      activeRuns: runs.filter((r) => !scheduled.includes(r)).map(runSummary),
      scheduled: scheduled.map(runSummary),
      defaultFor: defaults.map((p) => ({ id: p.id, title: p.title })),
      external: runs.filter((r) => r.externalId).length
    }
  }

  async function verifyModelKey(providerId: string, secret: string) {
    const adapter = adapterForProvider(providerId)
    if (!adapter) throw new Error('This provider can’t be added yet.')
    try {
      return await deps.grant(() => adapter.verify(secret))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const code = e instanceof ProviderError ? e.code : 'unavailable'
      return { ok: false, identity: null, providerOrg: null, models: [], capabilities: [] as CapabilityHealth[], detail: redactSecrets(msg), billable: false as const, errorCode: code }
    }
  }

  // Add a model API key: verify READ-ONLY first; nothing is stored when the
  // key fails. A different key at the same provider is a separate connection.
  async function addModelApi(input: { providerId: string; workspaceId: string; alias: string; billedTo?: string | null; secret: string; defaultModel?: string | null }): Promise<AddConnectionResult> {
    if (!ctx.workspaceIds.includes(input.workspaceId)) throw new Error('Pick a workspace you’re working in.')
    const def = providerById(input.providerId)
    if (!def || def.kind !== 'model_api' || def.certification.status === 'planned') throw new Error('This provider can’t be added yet.')
    const secret = input.secret.trim()
    if (!secret) throw new Error('Paste the API key.')
    const check = await verifyModelKey(input.providerId, secret)
    if (!check.ok) return { ok: false as const, detail: check.detail || 'The key didn’t pass its check.', confirmed: [] as string[] }
    const c = conns.addConnection({ workspaceId: input.workspaceId, providerId: def.id, kind: 'model_api', alias: input.alias || `${def.group}`, credentialOwner: 'You', billedTo: input.billedTo ?? check.providerOrg ?? null, config: { defaultModel: input.defaultModel ?? providerModels(def.id)[0]?.id ?? null } })
    broker.store(c.id, secret)
    conns.updateConnection(c.id, { hasSecret: true, secretHint: secretHintOf(secret) })
    const after = conns.recordCheck(c.id, check.capabilities, { identity: check.identity, providerOrg: check.providerOrg })
    return { ok: true as const, connection: connectionCard(after), confirmed: confirmedList(check) }
  }

  function confirmedList(check: { identity: string | null; providerOrg: string | null; models: string[]; capabilities: CapabilityHealth[] }): string[] {
    const out = ['The key was accepted (read-only check, no charge).']
    if (check.providerOrg) out.push(`Organisation: ${check.providerOrg}.`)
    else out.push('The provider didn’t say which organisation the key belongs to.')
    if (check.models.length) out.push(`${check.models.length} models available to this key.`)
    for (const h of check.capabilities) out.push(`${h.capability.replace('_', ' ')}: ${h.state}${h.detail ? ` — ${h.detail}` : ''}`)
    return out
  }

  // AI web accounts hold no credential: links open in the browser, imports are
  // what the person selects. Nothing to verify over the network.
  function addChatAccount(input: { providerId: string; workspaceId: string; alias: string }): ConnectionCard {
    if (!ctx.workspaceIds.includes(input.workspaceId)) throw new Error('Pick a workspace you’re working in.')
    const def = providerById(input.providerId)
    if (!def || def.kind !== 'ai_account') throw new Error('Not an AI web account.')
    const c = conns.addConnection({ workspaceId: input.workspaceId, providerId: def.id, kind: 'ai_account', alias: input.alias || def.name, credentialOwner: 'Your browser', billedTo: null })
    const t = now()
    const after = conns.recordCheck(c.id, [
      { capability: 'open_source', state: 'passed', checkedAt: t, detail: 'Chat links open in your browser, signed in as you.' },
      { capability: 'import', state: 'passed', checkedAt: t, detail: 'You paste or drop what to import; it is saved with the date and link.' }
    ], {})
    return connectionCard(after)
  }

  async function testConnection(id: string): Promise<TestConnectionResult> {
    const c = conns.getConnection(id)
    if (!c) throw new Error('Connection not found.')
    if (c.kind === 'ai_account') return { connection: connectionCard(c), confirmed: ['Nothing to check over the network: links open in your browser.'] }
    if (c.kind === 'model_api') {
      const check = await broker.withSecret(c, 'verify', (secret) => verifyModelKey(c.providerId, secret))
      if (!check.ok) {
        const status = check.errorCode === 'reconnect_required' ? 'reconnect_required' : check.errorCode === 'rate_limited' || check.errorCode === 'unavailable' ? 'unavailable' : 'limited'
        conns.setStatus(c.id, status, check.detail, 'user:me')
        return { connection: connectionCard(conns.getConnection(c.id)!), confirmed: [check.detail] }
      }
      if (c.identity && check.identity && check.identity !== c.identity) {
        conns.setStatus(c.id, 'reconnect_required', 'The key now belongs to a different account.', 'user:me')
        return { connection: connectionCard(conns.getConnection(c.id)!), confirmed: ['Account mismatch: this key belongs to a different organisation than before.'] }
      }
      const after = conns.recordCheck(c.id, check.capabilities, { identity: check.identity, providerOrg: check.providerOrg })
      return { connection: connectionCard(after), confirmed: confirmedList(check) }
    }
    return { connection: connectionCard(c), confirmed: ['Use the connection’s own check in its panel.'] }
  }

  // Rotate or reconnect: verify the replacement first, and only switch when it
  // belongs to the SAME account. A different account becomes a new connection.
  async function replaceKey(id: string, secret: string, mode: 'rotate' | 'reconnect'): Promise<AddConnectionResult> {
    const c = conns.getConnection(id)
    if (!c || c.kind !== 'model_api') throw new Error('Only API-key connections take a new key here.')
    const check = await verifyModelKey(c.providerId, secret.trim())
    if (!check.ok) return { ok: false as const, detail: `The new key didn’t pass its check: ${check.detail}`, separate: null }
    if (c.identity && check.identity && c.identity !== check.identity) {
      return { ok: false as const, detail: 'That key belongs to a different account, so it can’t replace this one. Add it as a separate connection instead.', separate: { providerId: c.providerId, identity: check.identity } }
    }
    broker.store(c.id, secret)
    conns.updateConnection(c.id, { hasSecret: true, secretHint: secretHintOf(secret) })
    store.appendEvent({ workspaceId: c.workspaceId, projectId: null, actor: 'user:me', kind: 'connection.rotated', subject: { type: 'connection', id: c.id, label: c.alias }, summary: `${mode === 'rotate' ? 'Rotated' : 'Reconnected'} ${c.alias} with a verified key (${secretHintOf(secret)}).`, data: { mode, identityMatched: Boolean(c.identity && check.identity) }, visibility: 'workspace' })
    const after = conns.recordCheck(c.id, check.capabilities, { identity: check.identity ?? c.identity, providerOrg: check.providerOrg ?? c.providerOrg })
    return { ok: true as const, connection: connectionCard(after), confirmed: [...confirmedList(check), c.identity && check.identity ? 'Same account as before.' : 'The provider gave no account id, so the account could not be compared.'] }
  }

  function pause(id: string) {
    return connectionCard(conns.setStatus(id, 'paused', 'Paused by you. New calls are stopped; work already running at a provider keeps running there.', 'user:me', { pausedBy: 'You' }))
  }

  function resume(id: string) {
    const c = conns.getConnection(id)!
    const hasPassed = c.capabilities.some((h) => h.state === 'passed')
    return connectionCard(conns.setStatus(id, hasPassed ? 'ready' : 'limited', 'Resumed.', 'user:me'))
  }

  // Disconnect: block new calls now, remove the stored credential, revoke the
  // project grants, leave history and outputs, and say what the person must do
  // at the provider (API keys can't be revoked from outside the console).
  function disconnect(id: string) {
    const c = conns.getConnection(id)
    if (!c) throw new Error('Connection not found.')
    const impactBefore = accessImpact(id)
    conns.setStatus(id, 'disconnected', 'Disconnected by you.', 'user:me')
    broker.forget(id)
    for (const g of conns.grantsForConnection(id)) conns.revokeGrant(g.id, 'user:me')
    const def = providerById(c.providerId)
    const providerAction = c.kind === 'model_api' ? `Plexii deleted its copy of the key. The key itself still works until you delete it in ${def?.name ?? 'the provider'}’s settings${def?.keySettingsUrl ? ` (${def.keySettingsUrl})` : ''}.` : c.kind === 'mcp' ? 'Plexii deleted its tokens. You can also remove Plexii’s access in the server’s own settings.' : null
    conns.updateConnection(id, { hasSecret: false, secretHint: null, providerAction })
    for (const r of impactBefore.activeRuns.concat(impactBefore.scheduled)) {
      if (r.externalId) store.setRunStatus(r.id, 'unavailable', 'Status unavailable: the connection was disconnected, so Plexii can’t ask the provider about this job. It may still be running there.')
      else if (r.status === 'queued') store.setRunStatus(r.id, 'cancelled', 'Cancelled: its connection was disconnected.')
    }
    return { connection: connectionCard(conns.getConnection(id)!), affected: impactBefore }
  }

  function setGrant(input: { connectionId: string; projectId: string; agentIds?: string[]; role?: 'use' | 'manage'; actions: GrantAction[]; dataFilters?: string[]; approval?: ApprovalLevel; expiresAt?: number | null }) {
    inContext(input.projectId)
    return conns.setGrant(input)
  }

  function setProjectDefault(projectId: string, connectionId: string | null, model: string | null) {
    const p = inContext(projectId)
    if (connectionId) {
      const c = conns.getConnection(connectionId)
      if (!c || c.workspaceId !== p.workspaceId) throw new Error('That connection belongs to another workspace.')
      if (!conns.activeGrantFor(c.id, p.id)) conns.setGrant({ connectionId: c.id, projectId: p.id, actions: [{ operationId: 'model:*', mode: 'read' }] })
      const mgr = store.listAgents(p.id).find((a) => a.role === 'manager')
      if (mgr) store.updateAgent(mgr.id, { connectionId, model })
    }
    return store.updateProject(p.id, { defaultConnectionId: connectionId, defaultModel: model })
  }

  // ── Impact actions ──────────────────────────────────────────────────────────

  function queueRevision(projectId: string, outputId: string, changeId: string) {
    inContext(projectId)
    const state = store.loadProjectState(projectId, revoked())
    const row = computeImpact(state).rows.find((r) => r.change.id === changeId)
    if (!row) return { ok: false as const, code: 'not_found', reason: 'That change is no longer open.' }
    const item = row.affected.find((a) => a.ref.type === 'output' && a.ref.id === outputId)
    if (!item) return { ok: false as const, code: 'not_found', reason: 'That output is no longer affected.' }
    const r = coordinator.draftRevision(projectId, item, row, `manual:${changeId}`, 'manual', 'user:me')
    return r.ok ? { ok: true as const, runId: r.run.id } : { ok: false as const, code: r.code, reason: r.reason }
  }

  // Confirm or dismiss a Possible match. Recorded as a suggestion the person
  // resolved, so the judgement is on the record and Impact honours it.
  function judgeMatch(projectId: string, outputId: string, changeId: string, related: boolean) {
    inContext(projectId)
    const out = store.getOutput(outputId)
    if (!out) throw new Error('Output not found.')
    const { suggestion } = store.createSuggestion({
      projectId,
      fromActor: 'user:me',
      recipient: 'agent:Project Manager',
      target: { type: 'output', id: outputId, label: out.title },
      targetVersionId: out.latestVersionId,
      evidence: [],
      proposedAction: `${related ? 'Related to' : 'Not related to'} ${changeId}`,
      sourceEventId: `match:${changeId}`
    })
    store.resolveSuggestion(suggestion.id, related ? 'acted' : 'dismissed', 'user:me')
    return { ok: true, suggestionId: suggestion.id }
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  function search(query: string, filter: { projectId?: string; type?: 'project' | 'task' | 'thread' | 'output' | 'decision'; provider?: string } = {}): SearchHitData[] {
    return store.search(ctx, query, filter).map((h) => ({ ...h, projectTitle: h.projectId ? store.getProject(h.projectId)?.title ?? null : null }))
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function labelRef(ref: RecordRef): string {
    if (ref.label) return ref.label
    const vid = ref.versionId ?? (ref.type === 'version' ? ref.id : null)
    if (vid) {
      const v = store.getVersion(vid)
      const o = v ? store.getOutput(v.outputId) : null
      if (v && o) return `${o.role === 'brief' ? 'Project brief' : o.title} v${v.n}`
    }
    if (ref.type === 'source') return store.getSource(ref.id)?.title ?? 'Source'
    if (ref.type === 'decision') return store.getDecision(ref.id)?.title ?? 'Decision'
    if (ref.type === 'output') return store.getOutput(ref.id)?.title ?? 'Output'
    return ref.type
  }

  function recover() {
    return runner.recoverOnStartup()
  }

  function dispose() {
    runner.stopAll()
  }

  return {
    store,
    conns,
    broker,
    runner,
    coordinator,
    getContext,
    setContext,
    createWorkspace,
    home,
    markHomeViewed,
    createProject,
    projectForDesk,
    projectView,
    markProjectViewed,
    impact,
    listRuns,
    runDetail,
    startRun,
    capture,
    suggestProjects,
    catalogue,
    listConnections,
    connectionDetail,
    accessImpact,
    addModelApi,
    addChatAccount,
    testConnection,
    replaceKey,
    pause,
    resume,
    disconnect,
    setGrant,
    setProjectDefault,
    queueRevision,
    judgeMatch,
    search,
    labelRef,
    inContext,
    connectionCard,
    recover,
    dispose,
    ctx: () => ctx
  }
}

function versionMeta(v: { id: string; n: number; author: string; createdAt: number; changeSummary: string; mediaRef: string | null; content: string; mediaWidth: number | null; mediaHeight: number | null }) {
  return { id: v.id, n: v.n, author: v.author, createdAt: v.createdAt, changeSummary: v.changeSummary, mediaRef: v.mediaRef, mediaWidth: v.mediaWidth, mediaHeight: v.mediaHeight, excerpt: v.content.slice(0, 600) }
}

function firstWords(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function categoryRank(c: string): number {
  return ['decision_due', 'conflict', 'usable', 'info'].indexOf(c)
}

export type { OutputKind }
