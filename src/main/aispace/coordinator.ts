// The Project Manager's coordination (SPEC-AI-SPACE.md §3 event table).
//
// It listens to the activity log and acts only within the project's authority:
//
//  Approved input changes → find RECORDED dependants and ask their assigned
//    agents for draft fixes, within budget and the follow-up bound. Inferred
//    (possible) matches are only flagged, never acted on: the spec's first
//    decision to revisit is automatic action, so autonomy stays limited to
//    known dependencies.
//  Agent needs information → when a later source matches the request's
//    topics, supply it, deliver it ONCE to the requester, and the requester
//    proposes a draft revision that records what the source supports.
//  Agents disagree → record where they differ; open a decision for a person.
//    A second disagreement on the same topic stops automatic follow-ups there.
//  Output is ready → handled by the runner (filed, versioned, put in review);
//    here: dependent tasks are told their inputs are ready.
//  Run fails or stops → the runner keeps verified progress; Impact offers
//    retry or hand over. Nothing is retried automatically.
//
// Everything an agent does is a suggestion + a run with a recorded manifest,
// so the recipient's choice (acted, deferred, dismissed) is on the record.
// Imported text and tool output are material only: nothing in them can start
// work here; only recorded events can.

import type { AiSpaceEvent, AiTask, RecordRef } from '@shared/aispace/model'
import { computeImpact } from '@shared/aispace/impact'
import type { AffectedItem, ImpactRow } from '@shared/aispace/impact'
import type { AiSpaceStore } from './store'
import type { ConnectionsStore } from './connectionsStore'
import type { Runner, StartRunResult } from './runner'

export interface CoordinatorDeps {
  store: AiSpaceStore
  conns: ConnectionsStore
  runner: Runner
  revokedConnectionIds: () => string[]
}

export interface BundleActivityResult {
  activityId: string
  ok: boolean
  detail: string
  runId?: string
}

const MANAGER = 'agent:Project Manager'

export function createCoordinator(deps: CoordinatorDeps) {
  const { store, conns, runner } = deps
  let busy = false
  const queue: AiSpaceEvent[] = []

  function start(): () => void {
    return store.onEvent((e) => {
      queue.push(e)
      if (!busy) void drain()
    })
  }

  async function drain(): Promise<void> {
    busy = true
    try {
      while (queue.length) {
        const e = queue.shift()!
        try {
          handle(e)
        } catch {
          /* coordination is best-effort; the record already holds the change */
        }
      }
    } finally {
      busy = false
    }
  }

  function handle(e: AiSpaceEvent): void {
    if (!e.projectId) return
    if (e.kind === 'decision.approved' && e.data.supersedes) return onInputChanged(e)
    if (e.kind === 'output.approved' && e.data.previousVersionId) {
      const out = e.subject ? store.getOutput(e.subject.id) : null
      if (out) return onInputChanged(e)
    }
    if (e.kind === 'source.added' && e.subject) return onSourceAdded(e.projectId, e.subject.id, e)
    if (e.kind === 'run.succeeded' && e.subject) return onRunSucceeded(e.subject.id)
  }

  // ── Approved input changes ──────────────────────────────────────────────────

  function rowFor(projectId: string, e: AiSpaceEvent): ImpactRow | null {
    const state = store.loadProjectState(projectId, deps.revokedConnectionIds())
    const res = computeImpact(state, { since: e.at - 1 })
    const subjectId = e.subject?.id
    return (
      res.rows.find((r) => r.change.id === `chg_${subjectId}` || r.change.id === `chg_${e.id}`) ??
      // A brief revision made from a decision is folded into that decision's row.
      res.rows.find((r) => r.change.changed.some((c) => c.to.id === e.data.versionId)) ??
      null
    )
  }

  function onInputChanged(e: AiSpaceEvent): void {
    const project = store.getProject(e.projectId!)
    if (!project || !project.authority.draftRevisions) return
    const row = rowFor(project.id, e)
    if (!row) return
    const topic = e.subject?.type === 'decision' ? store.getDecision(e.subject.id)?.topic ?? null : null
    if (topic && disagreementCount(project.id, topic) >= 2) return
    let followUps = 0
    for (const item of row.affected) {
      if (item.relation !== 'recorded' || item.status !== 'stale' || item.ref.type !== 'output') continue
      if (followUps >= project.authority.maxAutoFollowUps) {
        store.appendEvent({ workspaceId: project.workspaceId, projectId: project.id, actor: MANAGER, kind: 'suggestion.created', subject: { type: 'project', id: project.id }, summary: `Stopped after ${followUps} automatic drafts for one change. The rest wait for you in Impact.`, data: { bound: project.authority.maxAutoFollowUps } })
        break
      }
      const result = draftRevision(project.id, item, row, e.id, 'auto')
      if (result.ok) followUps++
      else if (result.code === 'over_budget' || result.code === 'no_grant' || result.code === 'connection_blocked' || result.code === 'approval_required') break
    }
  }

  // Ask the output's assigned agent for a draft fix. Returns why not, if not.
  function draftRevision(projectId: string, item: AffectedItem, row: ImpactRow, eventId: string, mode: 'auto' | 'manual', principal?: string): StartRunResult | { ok: false; code: string; reason: string; checks: [] } {
    const project = store.getProject(projectId)!
    const out = store.getOutput(item.ref.id)
    if (!out || !out.latestVersionId) return { ok: false, code: 'not_found', reason: 'Output not found.', checks: [] }
    const task = out.aiTaskId ? store.getTask(out.aiTaskId) : null
    const agent = pickAgent(project.id, task)
    const connectionId = agent?.connectionId ?? project.defaultConnectionId
    const model = agent?.model ?? project.defaultModel
    const recipient = agent ? `agent:${agent.id}` : 'user'
    const newInputs: RecordRef[] = row.change.changed.map((c) => (c.to.type === 'version' ? { type: 'version', id: c.to.id, versionId: c.to.id, label: c.to.label } : c.to))
    const action = `Draft a revision of ${out.title} that reflects: ${row.change.title.replace(/\.$/, '')}`
    const { suggestion, created } = store.createSuggestion({
      projectId,
      fromActor: MANAGER,
      recipient,
      target: { type: 'output', id: out.id, label: out.title },
      targetVersionId: out.latestVersionId,
      evidence: item.evidence,
      proposedAction: action,
      sourceEventId: eventId
    })
    if (!created && mode === 'auto') return { ok: false, code: 'duplicate', reason: 'Already suggested.', checks: [] }
    if (!connectionId || !model) return { ok: false, code: 'no_grant', reason: 'No connection is set for this work. The suggestion waits for you.', checks: [] }
    const res = runner.startRun({
      projectId,
      connectionId,
      model,
      instruction: `${action}.\n\nChange only what the new input requires and keep everything else as it is.\n${row.change.detail}`,
      inputs: [...newInputs, { type: 'version', id: out.latestVersionId, versionId: out.latestVersionId, label: `${out.title} (current)` }],
      aiTaskId: out.aiTaskId,
      agentId: agent?.id ?? null,
      targetOutputId: out.id,
      kind: 'revision',
      principal: principal ?? recipient,
      idempotencyKey: `rev:${eventId}:${out.id}:${out.latestVersionId}`
    })
    if (res.ok) store.resolveSuggestion(suggestion.id, 'acted', recipient)
    return res
  }

  function pickAgent(projectId: string, task: AiTask | null) {
    const agents = store.listAgents(projectId)
    if (task?.assignee) {
      const a = agents.find((x) => x.id === task.assignee || `agent:${x.id}` === task.assignee)
      if (a) return a
    }
    return agents.find((a) => a.role === 'writer' && a.connectionId) ?? agents.find((a) => a.role === 'manager') ?? null
  }

  // ── Agent needs information ─────────────────────────────────────────────────

  function onSourceAdded(projectId: string, sourceId: string, e: AiSpaceEvent): void {
    const src = store.getSource(sourceId)
    if (!src) return
    const words = tokenSet(`${src.title} ${src.content}`)
    for (const req of store.listRequests(projectId)) {
      if (req.status !== 'open') continue
      // At least two of its topics (or its only one) must appear, so one
      // generic word can't answer an unrelated question.
      const hits = req.topics.filter((t) => topicMatches(t, words)).length
      if (hits === 0 || hits < Math.min(2, req.topics.length)) continue
      store.supplyRequest(req.id, src.id, MANAGER)
      deliver(req.id, e.id)
    }
  }

  // Deliver once; the requester proposes a draft revision citing what the
  // source supports.
  function deliver(requestId: string, eventId: string): boolean {
    const req = store.getRequest(requestId)
    if (!req || req.status !== 'supplied' || !req.suppliedSourceId) return false
    if (!store.markRequestDelivered(req.id, MANAGER)) return false
    const src = store.getSource(req.suppliedSourceId)!
    const support = supportingExcerpt(src.content, req.topics)
    const task = req.aiTaskId ? store.getTask(req.aiTaskId) : null
    const out = task ? store.listOutputs(req.projectId).find((o) => o.aiTaskId === task.id) : null
    const agentId = req.requestedBy.startsWith('agent:') ? req.requestedBy.slice(6) : null
    const agent = agentId ? store.getAgent(agentId) ?? store.listAgents(req.projectId).find((a) => a.name === agentId) ?? null : null
    if (!out || !out.latestVersionId) return true
    const action = `Use ${src.title} to answer: ${req.question}`
    const { suggestion } = store.createSuggestion({
      projectId: req.projectId,
      fromActor: req.requestedBy,
      recipient: 'user',
      target: { type: 'output', id: out.id, label: out.title },
      targetVersionId: out.latestVersionId,
      evidence: [{ basis: 'recorded', text: `${src.title} supports: “${support}”`, ref: { type: 'source', id: src.id, label: src.title }, excerpt: support }],
      proposedAction: action,
      sourceEventId: eventId
    })
    const project = store.getProject(req.projectId)!
    const connectionId = agent?.connectionId ?? project.defaultConnectionId
    const model = agent?.model ?? project.defaultModel
    if (!project.authority.draftRevisions || !connectionId || !model) return true
    const res = runner.startRun({
      projectId: req.projectId,
      connectionId,
      model,
      instruction: `${action}.\nRevise the draft using only what the source supports. The source says: “${support}”. Note in the text what the source does not cover.`,
      inputs: [{ type: 'source', id: src.id, label: src.title }, { type: 'version', id: out.latestVersionId, versionId: out.latestVersionId, label: `${out.title} (current)` }],
      aiTaskId: task!.id,
      agentId: agent?.id ?? null,
      targetOutputId: out.id,
      kind: 'revision',
      principal: req.requestedBy,
      idempotencyKey: `req:${req.id}:${out.latestVersionId}`
    })
    if (res.ok) store.resolveSuggestion(suggestion.id, 'acted', req.requestedBy)
    return true
  }

  // ── Disagreement ────────────────────────────────────────────────────────────

  function recordDisagreement(input: { projectId: string; topic: string; title: string; a: { actor: string; claim: string; ref: RecordRef | null }; b: { actor: string; claim: string; ref: RecordRef | null } }): string {
    const p = store.getProject(input.projectId)!
    store.appendEvent({
      workspaceId: p.workspaceId,
      projectId: p.id,
      actor: MANAGER,
      kind: 'disagreement.recorded',
      subject: { type: 'project', id: p.id },
      refs: [input.a.ref, input.b.ref].filter((x): x is RecordRef => Boolean(x)),
      summary: `${input.a.actor.replace(/^agent:/, '')} and ${input.b.actor.replace(/^agent:/, '')} disagree on ${input.title}.`,
      data: { topic: input.topic, a: input.a, b: input.b }
    })
    // It would change a decision: ask a person to choose.
    const d = store.recordDecision({ projectId: p.id, topic: input.topic, title: `Choose: ${input.title}`, value: `${input.a.claim} — or — ${input.b.claim}`, evidence: [input.a.ref, input.b.ref].filter((x): x is RecordRef => Boolean(x)), actor: MANAGER })
    return d.id
  }

  function disagreementCount(projectId: string, topic: string): number {
    const p = store.getProject(projectId)!
    return store.listEvents({ workspaceIds: [p.workspaceId] }, { projectId, kinds: ['disagreement.recorded'] }).filter((e) => e.data.topic === topic).length
  }

  // ── Output ready → dependants ───────────────────────────────────────────────

  function onRunSucceeded(runId: string): void {
    const run = store.getRun(runId)
    if (!run?.aiTaskId) return
    const done = store.getTask(run.aiTaskId)
    if (!done) return
    for (const t of store.listTasks(run.projectId)) {
      if (!t.dependsOn.includes(done.id) || t.status !== 'waiting') continue
      const allReady = t.dependsOn.every((d) => {
        const dt = store.getTask(d)
        return dt && (dt.status === 'done' || dt.status === 'awaiting_review')
      })
      if (allReady) store.updateTask(t.id, { status: 'todo' }, MANAGER)
    }
  }

  // ── Bundles (one approval for several activities) ───────────────────────────

  function previewBundle(projectId: string, changeId: string): { title: string; activities: Array<{ id: string; label: string; connection: string | null; payer: string | null; estimate: string; dependsOn: string[] }> } | null {
    const state = store.loadProjectState(projectId, deps.revokedConnectionIds())
    const row = computeImpact(state).rows.find((r) => r.change.id === changeId)
    if (!row) return null
    const project = store.getProject(projectId)!
    const acts: Array<{ id: string; label: string; connection: string | null; payer: string | null; estimate: string; dependsOn: string[] }> = []
    for (const a of row.affected) {
      if (a.relation === 'possible') continue
      for (const act of a.actions) {
        if (act.id !== 'queue_revision' && act.id !== 'update_input') continue
        const out = act.id === 'queue_revision' ? store.getOutput(a.ref.id) : null
        const agent = out ? pickAgent(projectId, out.aiTaskId ? store.getTask(out.aiTaskId) : null) : null
        const cid = act.id === 'queue_revision' ? agent?.connectionId ?? project.defaultConnectionId : null
        const c = cid ? conns.getConnection(cid) : null
        acts.push({
          id: `${row.change.id}:${a.key}:${act.id}`,
          label: act.id === 'queue_revision' ? `Draft a revision of ${a.title}` : `Give ${a.title} the new input`,
          connection: c?.alias ?? (act.id === 'update_input' ? 'No model call' : null),
          payer: c ? c.billedTo ?? 'Unknown payer' : null,
          estimate: act.id === 'update_input' ? 'No cost' : c ? 'One model run, estimated when it starts' : 'Needs a connection',
          dependsOn: []
        })
      }
    }
    return { title: `Fix what “${row.change.title.replace(/\.$/, '')}” affected`, activities: acts }
  }

  // Runs each activity independently and reports each result: a failure in
  // one never undoes or blocks the others.
  function approveBundle(projectId: string, changeId: string, activityIds: string[], principal = 'user:me'): BundleActivityResult[] {
    const state = store.loadProjectState(projectId, deps.revokedConnectionIds())
    const row = computeImpact(state).rows.find((r) => r.change.id === changeId)
    if (!row) return activityIds.map((id) => ({ activityId: id, ok: false, detail: 'That change is no longer open.' }))
    const results: BundleActivityResult[] = []
    for (const a of row.affected) {
      for (const act of a.actions) {
        const id = `${row.change.id}:${a.key}:${act.id}`
        if (!activityIds.includes(id)) continue
        try {
          if (act.id === 'queue_revision') {
            const r = draftRevision(projectId, a, row, `bundle:${changeId}`, 'manual', principal)
            results.push(r.ok ? { activityId: id, ok: true, detail: 'Draft started.', runId: r.run.id } : { activityId: id, ok: false, detail: r.reason })
          } else if (act.id === 'update_input') {
            const payload = act.payload as { from: RecordRef; to: RecordRef | null } | undefined
            const res = updateRunInput(a.ref.id, payload?.from ?? null, payload?.to ?? null, principal)
            results.push({ activityId: id, ok: res.ok, detail: res.detail })
          }
        } catch (e) {
          results.push({ activityId: id, ok: false, detail: e instanceof Error ? e.message : String(e) })
        }
      }
    }
    return results
  }

  // Swap one input of a queued/scheduled run for its newer version.
  function updateRunInput(runId: string, from: RecordRef | null, to: RecordRef | null, principal = 'user:me'): { ok: boolean; detail: string } {
    const run = store.getRun(runId)
    if (!run || !from || !to) return { ok: false, detail: 'Nothing to update.' }
    const key = (r: RecordRef) => r.versionId ?? `${r.type}:${r.id}`
    const toRef: RecordRef = to.type === 'version' ? { type: 'version', id: to.id, versionId: to.id, label: to.label } : to
    const inputs = run.manifest.inputs.map((i) => (key(i) === key(from) ? toRef : i))
    store.updateRunManifest(runId, { ...run.manifest, inputs }, principal, `Input updated to ${to.label ?? 'the newer version'}.`)
    return { ok: true, detail: `Now uses ${to.label ?? 'the newer version'}.` }
  }

  return { start, handle, drain, draftRevision, deliver, recordDisagreement, previewBundle, approveBundle, updateRunInput }
}

export type Coordinator = ReturnType<typeof createCoordinator>

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'what', 'from', 'are', 'was', 'our', 'your', 'have', 'has', 'how', 'why', 'who'])

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9%$.-]+/).filter((w) => w.length > 2 && !STOP.has(w)))
}

function topicMatches(topic: string, words: Set<string>): boolean {
  const parts = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w))
  return parts.length > 0 && parts.every((p) => words.has(p) || [...words].some((w) => w.startsWith(p)))
}

export function supportingExcerpt(content: string, topics: string[]): string {
  const sentences = content.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)
  const hit = sentences.find((s) => topics.some((t) => s.toLowerCase().includes(t.toLowerCase().split(/\s+/)[0])))
  const s = (hit ?? sentences[0] ?? '').trim()
  return s.length > 280 ? `${s.slice(0, 278)}…` : s
}
