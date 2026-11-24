// Impact: read a project by consequence (SPEC-AI-SPACE.md §2).
//
// Pure and DB-free. The store loads a project's records once into a
// ProjectState; `stateAsOf` rewinds that state to any moment using only the
// recorded versions and events; `computeImpact` turns a state into rows of
// What changed / What it affected / What you can do. The current view and the
// "As of" view call the same two functions on the same records, which is the
// spec's "implement the current and historical views using the same underlying
// records" made literal.
//
// Two kinds of relation, never blurred:
//   recorded  ("Used this version") a run's manifest recorded consuming the input.
//   inferred  ("Possible match")    the old value's text was found in an output
//                                   that has no recorded link. Shown with the
//                                   exact excerpt, never acted on automatically.
//
// Nothing here moves an approved or published pointer. Impact reports; people
// (or agents within authority, on drafts only) act.

import type {
  AiDecision,
  AiOutput,
  AiProject,
  AiRun,
  AiSource,
  AiSpaceEvent,
  AiSuggestion,
  AiTask,
  Evidence,
  InfoRequest,
  OutputKind,
  OutputVersion,
  RecordRef,
  RunStatus
} from './model'
import { isTerminalRun } from './model'

export interface ProjectState {
  asOf: number
  project: AiProject
  tasks: AiTask[]
  runs: AiRun[]
  outputs: AiOutput[]
  versions: OutputVersion[]
  decisions: AiDecision[]
  sources: AiSource[]
  requests: InfoRequest[]
  suggestions: AiSuggestion[]
  events: AiSpaceEvent[]
  // Connections that are revoked/disconnected as of `asOf` (ids only).
  revokedConnectionIds: string[]
}

// ── As of: rewind a state to a moment, from recorded versions and events ─────

// Everything created after `t` disappears; pointers, statuses and decision
// states are replayed from the events at or before `t`. Records keep their ids
// and order so headings and positions stay consistent between two states.
export function stateAsOf(full: ProjectState, t: number): ProjectState {
  const events = full.events.filter((e) => e.at <= t)
  const versions = full.versions.filter((v) => v.createdAt <= t)
  const versionIds = new Set(versions.map((v) => v.id))

  // Output pointers from events. The current row is only a cache of them.
  const latest = new Map<string, string>()
  const approved = new Map<string, string>()
  const published = new Map<string, string>()
  const review = new Map<string, AiOutput['reviewState']>()
  for (const v of [...versions].sort((a, b) => a.createdAt - b.createdAt || a.n - b.n)) {
    latest.set(v.outputId, v.id)
  }
  for (const e of events) {
    const outputId = e.subject?.type === 'output' ? e.subject.id : null
    const versionId = typeof e.data.versionId === 'string' ? e.data.versionId : null
    if (!outputId) continue
    if (e.kind === 'output.approved' && versionId && versionIds.has(versionId)) {
      approved.set(outputId, versionId)
      review.set(outputId, 'approved')
    } else if (e.kind === 'output.published' && versionId && versionIds.has(versionId)) {
      published.set(outputId, versionId)
    } else if (e.kind === 'output.review_requested') {
      review.set(outputId, 'in_review')
    } else if (e.kind === 'output.version_added' && review.get(outputId) === 'approved') {
      // A new draft after approval puts the output back in draft review state,
      // while the approved pointer stays where it was.
      review.set(outputId, 'draft')
    }
  }
  const outputs = full.outputs
    .filter((o) => o.createdAt <= t)
    .map((o) => ({
      ...o,
      latestVersionId: latest.get(o.id) ?? null,
      approvedVersionId: approved.get(o.id) ?? null,
      publishedVersionId: published.get(o.id) ?? null,
      reviewState: review.get(o.id) ?? 'draft'
    }))

  // Run status from run events.
  const runStatus = new Map<string, { status: RunStatus; at: number; detail: string }>()
  for (const e of events) {
    if (e.subject?.type !== 'run') continue
    const s = RUN_EVENT_STATUS[e.kind]
    if (s) runStatus.set(e.subject.id, { status: s, at: e.at, detail: e.summary })
  }
  const runs = full.runs
    .filter((r) => r.createdAt <= t)
    .map((r) => {
      const s = runStatus.get(r.id)
      if (!s) return { ...r, status: 'queued' as RunStatus, endedAt: null, startedAt: null }
      return {
        ...r,
        status: s.status,
        statusDetail: s.detail,
        endedAt: isTerminalRun(s.status) ? s.at : null,
        startedAt: r.startedAt && r.startedAt <= t ? r.startedAt : null
      }
    })

  // Decision status from decision events.
  const decisionState = new Map<string, AiDecision['status']>()
  const decidedAt = new Map<string, number>()
  for (const e of events) {
    if (e.subject?.type !== 'decision') continue
    if (e.kind === 'decision.recorded') decisionState.set(e.subject.id, 'open')
    if (e.kind === 'decision.approved') {
      decisionState.set(e.subject.id, 'approved')
      decidedAt.set(e.subject.id, e.at)
      const sup = typeof e.data.supersedes === 'string' ? e.data.supersedes : null
      if (sup) decisionState.set(sup, 'superseded')
    }
    if (e.kind === 'decision.resolved') {
      decisionState.set(e.subject.id, 'resolved')
      decidedAt.set(e.subject.id, e.at)
    }
  }
  const decisions = full.decisions
    .filter((d) => d.createdAt <= t)
    .map((d) => ({
      ...d,
      status: decisionState.get(d.id) ?? d.status,
      decidedAt: decidedAt.get(d.id) ?? (d.decidedAt && d.decidedAt <= t ? d.decidedAt : null)
    }))

  const requests = full.requests
    .filter((r) => r.createdAt <= t)
    .map((r) => {
      const supplied = events.find(
        (e) => e.kind === 'request.supplied' && e.subject?.type === 'request' && e.subject.id === r.id
      )
      const delivered = events.find(
        (e) => e.kind === 'request.delivered' && e.subject?.type === 'request' && e.subject.id === r.id
      )
      return {
        ...r,
        status: supplied ? ('supplied' as const) : r.status === 'withdrawn' ? r.status : ('open' as const),
        suppliedSourceId: supplied ? r.suppliedSourceId : null,
        deliveredAt: delivered ? delivered.at : null
      }
    })

  const revoked = new Set<string>()
  for (const e of events) {
    if (e.subject?.type !== 'connection') continue
    if (e.kind === 'connection.revoked') revoked.add(e.subject.id)
    if (e.kind === 'connection.resumed' || e.kind === 'connection.added') revoked.delete(e.subject.id)
  }

  return {
    asOf: t,
    project: full.project,
    tasks: full.tasks.filter((x) => x.createdAt <= t),
    runs,
    outputs,
    versions,
    decisions,
    sources: full.sources.filter((s) => s.createdAt <= t),
    requests,
    suggestions: full.suggestions.filter((s) => s.createdAt <= t),
    events,
    revokedConnectionIds: [...revoked]
  }
}

const RUN_EVENT_STATUS: Partial<Record<AiSpaceEvent['kind'], RunStatus>> = {
  'run.queued': 'queued',
  'run.started': 'running',
  'run.succeeded': 'succeeded',
  'run.failed': 'failed',
  'run.cancelled': 'cancelled',
  'run.unavailable': 'unavailable',
  'run.interrupted': 'failed'
}

// ── Impact rows ───────────────────────────────────────────────────────────────

export type ChangeKind =
  | 'decision'
  | 'input_revised'
  | 'evidence_supplied'
  | 'connection_revoked'
  | 'run_failed'
  | 'output_ready'
  | 'decision_due'

export interface ImpactChange {
  id: string
  kind: ChangeKind
  // "Client approved a 30-day trial."
  title: string
  // "Previously 14 days."
  detail: string
  at: number
  eventSeq: number | null
  // The "Open source" link: where the change came from.
  source: RecordRef | null
  // Old input → new input. Empty for changes with nothing superseded.
  changed: Array<{ from: RecordRef; to: RecordRef }>
}

export type AffectedStatus =
  | 'stale'
  | 'revision_ready'
  | 'will_use_old_input'
  | 'blocked'
  | 'possible_match'
  | 'ready_for_review'
  | 'failed'
  | 'supplied'
  | 'waiting_on_decision'

export type ImpactActionId =
  | 'compare'
  | 'queue_revision'
  | 'update_input'
  | 'confirm_link'
  | 'dismiss_match'
  | 'approve'
  | 'review'
  | 'retry'
  | 'handover'
  | 'reconnect'
  | 'deliver'
  | 'decide'
  | 'open_source'

export interface ImpactAction {
  id: ImpactActionId
  label: string
  target: RecordRef
  payload?: Record<string, unknown>
}

export interface AffectedPreview {
  kind: OutputKind | 'run' | 'task' | 'request'
  excerpt: string | null
  matchStart: number | null
  matchEnd: number | null
  mediaRef: string | null
  mediaWidth: number | null
  mediaHeight: number | null
  versionLabel: string | null
}

export interface AffectedItem {
  key: string
  ref: RecordRef
  title: string
  // recorded = Used this version · possible = Possible match ·
  // acted = an agent already made a revision · direct = the item is the change's subject
  relation: 'recorded' | 'possible' | 'acted' | 'direct'
  status: AffectedStatus
  // "Image 03 still says 14 days."
  reason: string
  evidence: Evidence[]
  depth: number
  proposedRevisionId: string | null
  actions: ImpactAction[]
  preview: AffectedPreview | null
}

export type ImpactCategory = 'decision_due' | 'conflict' | 'usable' | 'info'

export interface ImpactRow {
  change: ImpactChange
  affected: AffectedItem[]
  // The row's "What you can do", most useful first, at most three.
  actions: ImpactAction[]
  severity: number
  category: ImpactCategory
}

export interface ProposedRevision {
  id: string
  outputId: string
  outputTitle: string
  contributingChangeIds: string[]
}

export interface ImpactResult {
  asOf: number
  rows: ImpactRow[]
  proposedRevisions: ProposedRevision[]
}

export interface ImpactOptions {
  // Only changes after this time (the "since" of a return brief). 0 = all.
  since?: number
  // A scheduled run inside this window counts as a material conflict.
  soonMs?: number
}

const DAY = 24 * 60 * 60 * 1000

export function computeImpact(state: ProjectState, opts: ImpactOptions = {}): ImpactResult {
  const since = opts.since ?? 0
  const soonMs = opts.soonMs ?? 2 * DAY
  const idx = indexState(state)
  const rows: ImpactRow[] = []

  // 1. Decisions approved that supersede an earlier one, plus the input
  //    revisions made from them (a brief rewritten because of the decision is
  //    the same change, not a second row).
  const absorbedVersionIds = new Set<string>()
  for (const d of state.decisions) {
    if (d.status !== 'approved' && d.status !== 'superseded') continue
    if (!d.supersedes && d.previousValue == null) continue
    const at = d.decidedAt ?? d.createdAt
    if (at <= since) continue
    const prior = d.supersedes ? idx.decision.get(d.supersedes) ?? null : null
    const changed: ImpactChange['changed'] = []
    if (prior) changed.push({ from: { type: 'decision', id: prior.id }, to: { type: 'decision', id: d.id } })
    // Input versions made from this decision: their predecessors become stale.
    for (const v of state.versions) {
      if (!v.sources.some((s) => s.type === 'decision' && s.id === d.id)) continue
      const out = idx.output.get(v.outputId)
      if (!out) continue
      const prev = v.parentVersionId ? idx.version.get(v.parentVersionId) : null
      if (prev && (out.role === 'brief' || out.approvedVersionId === v.id)) {
        changed.push({
          from: { type: 'version', id: prev.id, label: `${out.title} v${prev.n}` },
          to: { type: 'version', id: v.id, label: `${out.title} v${v.n}` }
        })
        absorbedVersionIds.add(v.id)
      }
    }
    const previous = d.previousValue ?? prior?.value ?? null
    const change: ImpactChange = {
      id: `chg_${d.id}`,
      kind: 'decision',
      title: `${d.title}.`,
      detail: previous != null ? `Previously ${previous}.` : '',
      at,
      eventSeq: eventSeqFor(state, 'decision', d.id, 'decision.approved'),
      source: d.evidence[0] ?? { type: 'decision', id: d.id },
      changed
    }
    rows.push(buildChangeRow(state, idx, change, previous, soonMs))
  }

  // 2. Input revisions not caused by a decision: a newly approved version of an
  //    output that other runs consumed (e.g. a brief edited by hand).
  for (const e of state.events) {
    if (e.kind !== 'output.approved' || e.at <= since) continue
    const versionId = typeof e.data.versionId === 'string' ? e.data.versionId : null
    if (!versionId || absorbedVersionIds.has(versionId)) continue
    const v = idx.version.get(versionId)
    if (!v || !v.parentVersionId) continue
    const out = idx.output.get(v.outputId)
    if (!out) continue
    const consumers = runsConsumingOutput(state, out.id).filter((r) =>
      r.manifest.inputs.some((i) => i.versionId && i.versionId !== v.id && versionOlder(idx, i.versionId, v))
    )
    if (consumers.length === 0) continue
    const prevApproved = typeof e.data.previousVersionId === 'string' ? idx.version.get(e.data.previousVersionId) : null
    const from = prevApproved ?? idx.version.get(v.parentVersionId)
    if (!from) continue
    const change: ImpactChange = {
      id: `chg_${e.id}`,
      kind: 'input_revised',
      title: `${out.title} v${v.n} approved.`,
      detail: v.changeSummary ? v.changeSummary : `Replaces v${from.n}.`,
      at: e.at,
      eventSeq: e.seq,
      source: { type: 'version', id: v.id, label: `${out.title} v${v.n}` },
      changed: [
        {
          from: { type: 'version', id: from.id, label: `${out.title} v${from.n}` },
          to: { type: 'version', id: v.id, label: `${out.title} v${v.n}` }
        }
      ]
    }
    rows.push(buildChangeRow(state, idx, change, null, soonMs))
  }

  // 3. Evidence supplied for an open request (§3 "Agent needs information").
  for (const r of state.requests) {
    if (r.status !== 'supplied' || !r.suppliedSourceId) continue
    const src = idx.source.get(r.suppliedSourceId)
    if (!src || src.createdAt <= since) continue
    const task = r.aiTaskId ? idx.task.get(r.aiTaskId) : null
    const affected: AffectedItem[] = [
      {
        key: `request:${r.id}`,
        ref: { type: 'request', id: r.id, label: r.question },
        title: task ? task.title : r.question,
        relation: 'direct',
        status: 'supplied',
        reason: `${r.requestedBy === 'user' ? 'You' : agentLabel(r.requestedBy)} asked: “${r.question}”. ${src.title} supplies it.`,
        evidence: [
          {
            basis: 'recorded',
            text: `Finding from ${src.title}`,
            ref: { type: 'source', id: src.id, label: src.title },
            excerpt: firstWords(src.content, 280)
          }
        ],
        depth: 0,
        proposedRevisionId: null,
        actions: r.deliveredAt
          ? [{ id: 'open_source', label: 'Open source', target: { type: 'source', id: src.id } }]
          : [{ id: 'deliver', label: 'Deliver to agent', target: { type: 'request', id: r.id } }],
        preview: { ...emptyPreview('request'), excerpt: firstWords(src.content, 280) }
      }
    ]
    // Draft revisions the requester proposed from it (suggestions targeting outputs).
    for (const s of state.suggestions) {
      if (s.evidence.some((ev) => ev.ref?.type === 'source' && ev.ref.id === src.id) && s.target.type === 'output') {
        const out = idx.output.get(s.target.id)
        if (out) affected.push(outputItem(state, idx, out, 'acted', 'revision_ready', s.proposedAction, [], 1))
      }
    }
    rows.push({
      change: {
        id: `chg_${r.id}`,
        kind: 'evidence_supplied',
        title: `${src.title} answers an open question.`,
        detail: `Asked by ${r.requestedBy === 'user' ? 'you' : agentLabel(r.requestedBy)}.`,
        at: src.createdAt,
        eventSeq: eventSeqFor(state, 'request', r.id, 'request.supplied'),
        source: { type: 'source', id: src.id, label: src.title },
        changed: []
      },
      affected,
      actions: topActions(affected),
      severity: r.deliveredAt ? 2 : 3,
      category: 'usable'
    })
  }

  // 4. Revoked connections: queued work and scheduled jobs that need attention.
  for (const cid of state.revokedConnectionIds) {
    const ev = [...state.events].reverse().find((e) => e.kind === 'connection.revoked' && e.subject?.id === cid)
    if (ev && ev.at <= since) continue
    const affected: AffectedItem[] = []
    for (const run of state.runs) {
      if (run.manifest.connectionId !== cid || isTerminalRun(run.status)) continue
      affected.push(runItem(state, idx, run, 'blocked', `Can't start: ${run.manifest.connectionAlias ?? 'its connection'} was disconnected.`))
    }
    if (affected.length === 0) continue
    rows.push({
      change: {
        id: `chg_${cid}`,
        kind: 'connection_revoked',
        title: `${String(ev?.data.alias ?? 'A connection')} was disconnected.`,
        detail: ev?.summary ?? '',
        at: ev?.at ?? state.asOf,
        eventSeq: ev?.seq ?? null,
        source: { type: 'connection', id: cid },
        changed: []
      },
      affected,
      actions: ([{ id: 'reconnect', label: 'Reconnect', target: { type: 'connection', id: cid } }] as ImpactAction[]).concat(topActions(affected)).slice(0, 3),
      severity: 4,
      category: 'conflict'
    })
  }

  // 5. Failed runs: verified progress is kept; offer retry or hand over.
  for (const run of state.runs) {
    if (run.status !== 'failed' || (run.endedAt ?? 0) <= since) continue
    const later = state.runs.some((r) => (r.handoverOf === run.id || (r.aiTaskId === run.aiTaskId && r.createdAt > run.createdAt && r.manifest.instruction === run.manifest.instruction)))
    if (later) continue
    const item = runItem(state, idx, run, 'failed', run.statusDetail || 'The run stopped before it finished.')
    rows.push({
      change: {
        id: `chg_${run.id}`,
        kind: 'run_failed',
        title: `${taskTitle(idx, run.aiTaskId) ?? 'A run'} stopped.`,
        detail: run.lastConfirmedStep ? `Last confirmed: ${run.lastConfirmedStep}.` : '',
        at: run.endedAt ?? run.createdAt,
        eventSeq: eventSeqFor(state, 'run', run.id, 'run.failed'),
        source: { type: 'run', id: run.id },
        changed: []
      },
      affected: [item],
      actions: item.actions,
      severity: 3,
      category: 'conflict'
    })
  }

  // 6. Completed work the user can use: new versions waiting for review.
  for (const out of state.outputs) {
    if (out.reviewState === 'approved' || !out.latestVersionId) continue
    const v = idx.version.get(out.latestVersionId)
    if (!v || v.createdAt <= since) continue
    if (rows.some((row) => row.affected.some((a) => a.ref.type === 'output' && a.ref.id === out.id))) continue
    const item = outputItem(state, idx, out, 'direct', 'ready_for_review', v.changeSummary || `Version ${v.n} is ready.`, [], 0)
    rows.push({
      change: {
        id: `chg_${v.id}`,
        kind: 'output_ready',
        title: `${out.title} v${v.n} is ready.`,
        detail: v.runId ? `Made by ${authorLabel(v.author)}.` : `Saved by ${authorLabel(v.author)}.`,
        at: v.createdAt,
        eventSeq: eventSeqFor(state, 'output', out.id, 'output.version_added'),
        source: v.runId ? { type: 'run', id: v.runId } : { type: 'version', id: v.id },
        changed: []
      },
      affected: [item],
      actions: item.actions,
      severity: 2,
      category: 'usable'
    })
  }

  // 7. Decisions due: open decisions are shown whatever `since` says, because
  //    opening a brief never clears an unresolved request (§3).
  for (const d of state.decisions) {
    if (d.status !== 'open') continue
    const waiting = state.tasks.filter((t) => t.status === 'waiting' || t.status === 'blocked')
    const affected: AffectedItem[] = waiting.slice(0, 4).map((t) => ({
      key: `task:${t.id}`,
      ref: { type: 'task', id: t.id, label: t.title },
      title: t.title,
      relation: 'recorded',
      status: 'waiting_on_decision',
      reason: `Waiting on this decision.`,
      evidence: [],
      depth: 0,
      proposedRevisionId: null,
      actions: [],
      preview: emptyPreview('task')
    }))
    rows.push({
      change: {
        id: `chg_${d.id}`,
        kind: 'decision_due',
        title: `Decision needed: ${d.title}`,
        detail: d.dueAt ? `Due ${new Date(d.dueAt).toISOString().slice(0, 10)}.` : '',
        at: d.createdAt,
        eventSeq: eventSeqFor(state, 'decision', d.id, 'decision.recorded'),
        source: d.evidence[0] ?? { type: 'decision', id: d.id },
        changed: []
      },
      affected,
      actions: [{ id: 'decide', label: 'Decide', target: { type: 'decision', id: d.id } }],
      severity: 6,
      category: 'decision_due'
    })
  }

  // Group: one proposed revision per output touched by two or more changes.
  const byOutput = new Map<string, Set<string>>()
  for (const row of rows) {
    for (const a of row.affected) {
      if (a.ref.type !== 'output' || a.status === 'ready_for_review') continue
      const set = byOutput.get(a.ref.id) ?? new Set<string>()
      set.add(row.change.id)
      byOutput.set(a.ref.id, set)
    }
  }
  const proposedRevisions: ProposedRevision[] = []
  for (const [outputId, changeIds] of byOutput) {
    if (changeIds.size < 2) continue
    const out = idx.output.get(outputId)
    const id = `rev_${outputId}`
    proposedRevisions.push({ id, outputId, outputTitle: out?.title ?? outputId, contributingChangeIds: [...changeIds] })
    for (const row of rows) for (const a of row.affected) if (a.ref.type === 'output' && a.ref.id === outputId) a.proposedRevisionId = id
  }

  rows.sort((a, b) => b.severity - a.severity || b.change.at - a.change.at || a.change.id.localeCompare(b.change.id))
  return { asOf: state.asOf, rows, proposedRevisions }
}

// ── One change → its affected work ────────────────────────────────────────────

function buildChangeRow(
  state: ProjectState,
  idx: StateIndex,
  change: ImpactChange,
  previousValue: string | null,
  soonMs: number
): ImpactRow {
  const affected: AffectedItem[] = []
  const seen = new Set<string>()
  const staleRefs = new Set(change.changed.map((c) => refId(c.from)))
  const newRefs = new Set(change.changed.map((c) => refId(c.to)))

  // Recorded: runs that consumed an old input, then what they emitted, then
  // what consumed THAT (depth 2). Bounded so a cycle cannot spin.
  let frontier = new Set(staleRefs)
  for (let depth = 0; depth < 3 && frontier.size > 0; depth++) {
    const next = new Set<string>()
    for (const run of state.runs) {
      const hit = run.manifest.inputs.find((i) => frontier.has(refId(i)))
      if (!hit) continue
      const hitLabel = hit.label ?? labelFor(idx, hit)
      if (!isTerminalRun(run.status)) {
        const key = `run:${run.id}`
        if (seen.has(key)) continue
        seen.add(key)
        const when = run.manifest && runWhen(idx, run)
        const soon = when !== null && when - state.asOf <= soonMs
        const item = runItem(
          state,
          idx,
          run,
          'will_use_old_input',
          `${when ? `${relativeDay(when, state.asOf)}'s` : 'A queued'} ${taskTitle(idx, run.aiTaskId) ?? 'run'} uses ${hitLabel}.`
        )
        item.depth = depth
        item.evidence = [{ basis: 'recorded', text: `Run manifest lists ${hitLabel} as an input.`, ref: { type: 'run', id: run.id } }]
        item.actions = [
          {
            id: 'update_input',
            label: depth === 0 ? 'Update input' : 'Review input',
            target: { type: 'run', id: run.id },
            payload: { from: hit, to: change.changed.find((c) => refId(c.from) === refId(hit))?.to ?? null }
          }
        ]
        if (soon) item.status = 'will_use_old_input'
        affected.push(item)
        continue
      }
      if (run.status !== 'succeeded') continue
      for (const v of state.versions) {
        if (v.runId !== run.id) continue
        const out = idx.output.get(v.outputId)
        if (!out) continue
        next.add(refId({ type: 'version', id: v.id }))
        const key = `output:${out.id}`
        if (seen.has(key)) continue
        seen.add(key)
        // Did someone already revise it from the new input?
        const revision = state.versions
          .filter((x) => x.outputId === out.id && x.createdAt > v.createdAt)
          .find((x) => x.sources.some((s) => newRefs.has(refId(s))) || x.sources.some((s) => s.type === 'decision' && change.changed.some((c) => c.to.type === 'decision' && c.to.id === s.id)))
        if (revision) {
          const item = outputItem(
            state,
            idx,
            out,
            'acted',
            'revision_ready',
            `${out.title} has a revision.`,
            [
              {
                basis: 'recorded',
                text: `v${revision.n} by ${authorLabel(revision.author)} used ${labelFor(idx, revision.sources.find((s) => newRefs.has(refId(s)) || s.type === 'decision') ?? null)}.`,
                ref: { type: 'version', id: revision.id },
                excerpt: revision.changeSummary || undefined
              }
            ],
            depth
          )
          item.ref = { type: 'output', id: out.id, versionId: revision.id, label: out.title }
          item.actions = [
            { id: 'compare', label: `Compare ${shortTitle(out.title)}`, target: { type: 'output', id: out.id }, payload: { a: out.approvedVersionId ?? v.id, b: revision.id } },
            ...(out.approvedVersionId !== revision.id ? [{ id: 'approve' as const, label: 'Approve revision', target: { type: 'version' as const, id: revision.id } }] : [])
          ]
          affected.push(item)
        } else {
          const excerpt = previousValue ? findValue(contentOf(idx, out), previousValue) : null
          const reason = excerpt
            ? `${out.title} still says ${excerpt.matched}.`
            : `${out.title} was made from ${hitLabel}.`
          const item = outputItem(
            state,
            idx,
            out,
            'recorded',
            'stale',
            reason,
            [
              {
                basis: 'recorded',
                text: `v${v.n} was made by a run that used ${hitLabel}.`,
                ref: { type: 'run', id: run.id },
                ...(excerpt ? { excerpt: excerpt.excerpt, matchStart: excerpt.start, matchEnd: excerpt.end } : {})
              }
            ],
            depth
          )
          item.actions = [
            { id: 'queue_revision', label: `Queue ${shortTitle(out.title)} revision`, target: { type: 'output', id: out.id }, payload: { changeId: change.id } }
          ]
          affected.push(item)
        }
      }
    }
    frontier = next
  }

  // Inferred: outputs with no recorded link whose current text still holds the
  // old value. Shown as a possibility with the exact excerpt.
  if (previousValue) {
    for (const out of state.outputs) {
      if (seen.has(`output:${out.id}`) || out.role === 'brief') continue
      const hit = findValue(contentOf(idx, out), previousValue)
      if (!hit) continue
      seen.add(`output:${out.id}`)
      // A person's judgement on this match wins: dismissed disappears,
      // confirmed becomes a recorded link with the person as the evidence.
      const judged = state.suggestions.find((sg) => sg.target.id === out.id && sg.sourceEventId === `match:${change.id}` && sg.status !== 'pending')
      if (judged?.status === 'dismissed') continue
      if (judged?.status === 'acted') {
        const confirmed = outputItem(state, idx, out, 'recorded', 'stale', `${out.title} still says ${hit.matched}.`, [
          { basis: 'recorded', text: 'You confirmed this match.', ref: { type: 'suggestion', id: judged.id }, excerpt: hit.excerpt, matchStart: hit.start, matchEnd: hit.end }
        ], 0)
        confirmed.actions = [{ id: 'queue_revision', label: `Queue ${shortTitle(out.title)} revision`, target: { type: 'output', id: out.id }, payload: { changeId: change.id } }]
        affected.push(confirmed)
        continue
      }
      const item = outputItem(
        state,
        idx,
        out,
        'possible',
        'possible_match',
        `${out.title} mentions ${hit.matched}.`,
        [
          {
            basis: 'inferred',
            text: `No recorded link. The text matches the old value “${previousValue}”.`,
            ref: { type: 'version', id: currentVersionId(out) ?? '' },
            excerpt: hit.excerpt,
            matchStart: hit.start,
            matchEnd: hit.end
          }
        ],
        0
      )
      item.actions = [
        { id: 'confirm_link', label: 'Confirm match', target: { type: 'output', id: out.id }, payload: { changeId: change.id } },
        { id: 'dismiss_match', label: 'Not related', target: { type: 'output', id: out.id }, payload: { changeId: change.id } }
      ]
      affected.push(item)
    }
  }

  // Severity: an approved or published output still on the old value, or a
  // run about to use the old input, is a material conflict.
  const conflict = affected.some((a) => {
    if (a.status === 'will_use_old_input') {
      const run = idx.run.get(a.ref.id)
      const when = run ? runWhen(idx, run) : null
      return when === null || when - state.asOf <= soonMs
    }
    if (a.status !== 'stale') return false
    const out = idx.output.get(a.ref.id)
    return Boolean(out && (out.approvedVersionId || out.publishedVersionId))
  })
  return {
    change,
    affected,
    actions: topActions(affected),
    severity: conflict ? 5 : affected.some((a) => a.status === 'revision_ready') ? 3 : affected.length ? 2 : 1,
    category: conflict ? 'conflict' : affected.some((a) => a.status === 'revision_ready') ? 'usable' : 'info'
  }
}

// ── Value matching (Possible match evidence) ──────────────────────────────────

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five',
  'twenty-six', 'twenty-seven', 'twenty-eight', 'twenty-nine', 'thirty'
]

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A pattern for a stated value. "14 days" also matches "14-day", "14 day" and
// "fourteen days"; anything else matches as a phrase, case-insensitive.
export function valuePattern(value: string): RegExp | null {
  const v = value.trim()
  if (!v) return null
  const m = /^(\d+)\s*[- ]?\s*([a-z]+?)s?$/i.exec(v)
  if (m) {
    const n = Number(m[1])
    const unit = escapeRe(m[2])
    const word = n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : null
    const num = word ? `(?:${m[1]}|${escapeRe(word)})` : m[1]
    return new RegExp(`(?<![\\w.])${num}[\\s-]?${unit}s?(?!\\w)`, 'i')
  }
  return new RegExp(`(?<!\\w)${escapeRe(v).replace(/\s+/g, '\\s+')}(?!\\w)`, 'i')
}

export interface ValueHit {
  matched: string
  excerpt: string
  start: number
  end: number
}

export function findValue(text: string, value: string, radius = 90): ValueHit | null {
  const re = valuePattern(value)
  if (!re || !text) return null
  const m = re.exec(text)
  if (!m) return null
  let from = Math.max(0, m.index - radius)
  let to = Math.min(text.length, m.index + m[0].length + radius)
  if (from > 0) {
    const sp = text.indexOf(' ', from)
    if (sp !== -1 && sp < m.index) from = sp + 1
  }
  if (to < text.length) {
    const sp = text.lastIndexOf(' ', to)
    if (sp > m.index + m[0].length) to = sp
  }
  const lead = from > 0 ? '…' : ''
  const tail = to < text.length ? '…' : ''
  const body = text.slice(from, to).replace(/\s+/g, ' ')
  // Recompute offsets after whitespace collapse inside the excerpt.
  const inner = body.search(re)
  const start = inner === -1 ? 0 : inner + lead.length
  const matchLen = inner === -1 ? 0 : (re.exec(body)?.[0].length ?? 0)
  return { matched: m[0], excerpt: `${lead}${body}${tail}`, start, end: start + matchLen }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface StateIndex {
  output: Map<string, AiOutput>
  version: Map<string, OutputVersion>
  run: Map<string, AiRun>
  task: Map<string, AiTask>
  decision: Map<string, AiDecision>
  source: Map<string, AiSource>
}

function indexState(state: ProjectState): StateIndex {
  return {
    output: new Map(state.outputs.map((o) => [o.id, o])),
    version: new Map(state.versions.map((v) => [v.id, v])),
    run: new Map(state.runs.map((r) => [r.id, r])),
    task: new Map(state.tasks.map((t) => [t.id, t])),
    decision: new Map(state.decisions.map((d) => [d.id, d])),
    source: new Map(state.sources.map((s) => [s.id, s]))
  }
}

// A ref to an output version is identified by the version; a ref to anything
// else by its own id.
function refId(r: RecordRef): string {
  if (r.versionId) return `version:${r.versionId}`
  return `${r.type}:${r.id}`
}

function versionOlder(idx: StateIndex, versionId: string, than: OutputVersion): boolean {
  const v = idx.version.get(versionId)
  return Boolean(v && v.outputId === than.outputId && v.n < than.n)
}

function runsConsumingOutput(state: ProjectState, outputId: string): AiRun[] {
  return state.runs.filter((r) => r.manifest.inputs.some((i) => (i.type === 'output' && i.id === outputId) || (i.type === 'version' && state.versions.find((v) => v.id === i.id)?.outputId === outputId)))
}

function eventSeqFor(state: ProjectState, type: RecordRef['type'], id: string, kind: AiSpaceEvent['kind']): number | null {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e = state.events[i]
    if (e.kind === kind && e.subject?.type === type && e.subject.id === id) return e.seq
  }
  return null
}

function currentVersionId(out: AiOutput): string | null {
  return out.latestVersionId ?? out.approvedVersionId
}

function contentOf(idx: StateIndex, out: AiOutput): string {
  const id = currentVersionId(out)
  return id ? idx.version.get(id)?.content ?? '' : ''
}

function emptyPreview(kind: AffectedPreview['kind']): AffectedPreview {
  return { kind, excerpt: null, matchStart: null, matchEnd: null, mediaRef: null, mediaWidth: null, mediaHeight: null, versionLabel: null }
}

function outputItem(
  _state: ProjectState,
  idx: StateIndex,
  out: AiOutput,
  relation: AffectedItem['relation'],
  status: AffectedStatus,
  reason: string,
  evidence: Evidence[],
  depth: number
): AffectedItem {
  const vid = currentVersionId(out)
  const v = vid ? idx.version.get(vid) : null
  const ev = evidence.find((e) => e.excerpt)
  const actions: ImpactAction[] =
    status === 'ready_for_review'
      ? [
          { id: 'review', label: 'Review', target: { type: 'output', id: out.id, versionId: vid } },
          ...(out.approvedVersionId && vid && out.approvedVersionId !== vid
            ? [{ id: 'compare' as const, label: 'Compare with approved', target: { type: 'output' as const, id: out.id }, payload: { a: out.approvedVersionId, b: vid } }]
            : [])
        ]
      : []
  return {
    key: `output:${out.id}`,
    ref: { type: 'output', id: out.id, versionId: vid, label: out.title },
    title: out.title,
    relation,
    status,
    reason,
    evidence,
    depth,
    proposedRevisionId: null,
    actions,
    preview: {
      kind: out.kind,
      excerpt: ev?.excerpt ?? (v ? firstWords(v.content, 240) : null),
      matchStart: ev?.matchStart ?? null,
      matchEnd: ev?.matchEnd ?? null,
      mediaRef: v?.mediaRef ?? null,
      mediaWidth: v?.mediaWidth ?? null,
      mediaHeight: v?.mediaHeight ?? null,
      versionLabel: v ? `v${v.n}${out.approvedVersionId === v.id ? ' · approved' : ''}${out.publishedVersionId === v.id ? ' · published' : ''}` : null
    }
  }
}

function runItem(_state: ProjectState, idx: StateIndex, run: AiRun, status: AffectedStatus, reason: string): AffectedItem {
  const title = taskTitle(idx, run.aiTaskId) ?? run.manifest.instruction.slice(0, 60)
  const actions: ImpactAction[] =
    status === 'failed'
      ? [
          { id: 'retry', label: 'Retry', target: { type: 'run', id: run.id } },
          { id: 'handover', label: 'Hand over', target: { type: 'run', id: run.id } }
        ]
      : []
  return {
    key: `run:${run.id}`,
    ref: { type: 'run', id: run.id, label: title },
    title,
    relation: 'recorded',
    status,
    reason,
    evidence: [],
    depth: 0,
    proposedRevisionId: null,
    actions,
    preview: { ...emptyPreview('run'), excerpt: run.lastConfirmedStep || null }
  }
}

function runWhen(idx: StateIndex, run: AiRun): number | null {
  const t = run.aiTaskId ? idx.task.get(run.aiTaskId) : null
  return t?.scheduledAt ?? null
}

function taskTitle(idx: StateIndex, id: string | null): string | null {
  if (!id) return null
  return idx.task.get(id)?.title ?? null
}

function labelFor(idx: StateIndex, ref: RecordRef | null): string {
  if (!ref) return 'the new input'
  if (ref.label) return ref.label
  const vid = ref.versionId ?? (ref.type === 'version' ? ref.id : null)
  if (vid) {
    const v = idx.version.get(vid)
    const out = v ? idx.output.get(v.outputId) : null
    if (v && out) return `${out.role === 'brief' ? 'the brief' : out.title} v${v.n}`
  }
  if (ref.type === 'decision') {
    const d = idx.decision.get(ref.id)
    if (d) return `the decision “${d.title}”`
  }
  return ref.type
}

function agentLabel(id: string): string {
  return id.startsWith('agent:') ? id.slice(6) : id
}

export function authorLabel(author: string): string {
  if (author.startsWith('user:')) return 'you'
  if (author.startsWith('agent:')) return author.slice(6)
  if (author.startsWith('run:')) return 'a run'
  return author
}

function shortTitle(title: string): string {
  const t = title.replace(/^(the\s+)/i, '')
  return t.length > 24 ? `${t.slice(0, 22)}…` : t.toLowerCase()
}

function firstWords(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.lastIndexOf(' ', max)
  return `${t.slice(0, cut > max * 0.6 ? cut : max)}…`
}

function topActions(affected: AffectedItem[]): ImpactAction[] {
  const out: ImpactAction[] = []
  const seen = new Set<string>()
  // Conflicts first, then revisions, then the rest.
  const order: AffectedStatus[] = ['will_use_old_input', 'stale', 'blocked', 'failed', 'revision_ready', 'supplied', 'ready_for_review', 'possible_match', 'waiting_on_decision']
  const sorted = [...affected].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
  // Show the row the way people read it: revision first if one exists.
  const revisionFirst = [...sorted.filter((a) => a.status === 'revision_ready'), ...sorted.filter((a) => a.status !== 'revision_ready')]
  for (const a of revisionFirst) {
    const act = a.actions[0]
    if (!act) continue
    const k = `${act.id}:${act.target.type}:${act.target.id}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(act)
    if (out.length === 3) break
  }
  return out
}

export function relativeDay(t: number, now: number): string {
  const d0 = new Date(now)
  d0.setHours(0, 0, 0, 0)
  const diff = Math.floor((t - d0.getTime()) / DAY)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return new Date(t).toLocaleDateString(undefined, { weekday: 'long' })
}
