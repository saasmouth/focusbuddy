// The return brief (SPEC-AI-SPACE.md §3 "User returns"): what changed since the
// person's last viewed position, which work is usable, and the one decision or
// action that helps most. Built only from recorded events and versions, with
// an explicit reference on every line, so each claim can be opened.
//
// Rules:
//  - At most three consequential updates, each with ONE action and a source.
//  - Opening the brief never clears anything: open decisions, reviews waiting
//    and uncertain external actions stay in "Needs you" until someone acts.
//  - Bundles: one change's fixes can be approved together, after a preview of
//    the scope, estimated usage and dependencies (§3 last paragraph).

import type { AiOutput, RecordRef } from './model'
import type { ImpactAction, ImpactResult, ImpactRow, ProjectState } from './impact'
import { computeImpact } from './impact'

export interface BriefUpdate {
  id: string
  text: string
  detail: string
  action: ImpactAction | null
  source: RecordRef | null
  category: ImpactRow['category']
  at: number
}

export interface NeedsYou {
  id: string
  kind: 'decision' | 'review' | 'suggestion' | 'uncertain_action' | 'approval' | 'reconnect'
  text: string
  target: RecordRef
  since: number
}

export interface ReturnBrief {
  projectId: string
  projectTitle: string
  since: number
  headline: string
  updates: BriefUpdate[]
  // The deliverable the person is most likely coming back to.
  currentDeliverable: { output: AiOutput; why: string } | null
  usable: Array<{ output: AiOutput; versionLabel: string }>
  needsYou: NeedsYou[]
  nextStep: { text: string; action: ImpactAction | null } | null
  bundles: Bundle[]
  impact: ImpactResult
}

export interface BundleActivity {
  id: string
  label: string
  action: ImpactAction
  dependsOn: string[]
}

export interface Bundle {
  id: string
  changeId: string
  title: string
  activities: BundleActivity[]
}

export function buildReturnBrief(state: ProjectState, since: number, extraNeeds: NeedsYou[] = []): ReturnBrief {
  const impact = computeImpact(state, { since })
  const fresh = impact.rows.filter((r) => r.change.kind !== 'decision_due')
  const updates: BriefUpdate[] = fresh.slice(0, 3).map((row) => ({
    id: row.change.id,
    text: row.change.title,
    detail: summariseAffected(row),
    action: row.actions[0] ?? null,
    source: row.change.source,
    category: row.category,
    at: row.change.at
  }))

  const needsYou: NeedsYou[] = []
  for (const d of state.decisions) {
    if (d.status === 'open') needsYou.push({ id: `nd_${d.id}`, kind: 'decision', text: `Decide: ${d.title}`, target: { type: 'decision', id: d.id, label: d.title }, since: d.createdAt })
  }
  for (const o of state.outputs) {
    if (o.reviewState === 'in_review' && o.latestVersionId) {
      const v = state.versions.find((x) => x.id === o.latestVersionId)
      needsYou.push({ id: `nr_${o.id}`, kind: 'review', text: `Review ${o.title}${v ? ` v${v.n}` : ''}`, target: { type: 'output', id: o.id, versionId: o.latestVersionId, label: o.title }, since: v?.createdAt ?? o.updatedAt })
    }
  }
  for (const s of state.suggestions) {
    if (s.status === 'pending' && s.recipient === 'user') needsYou.push({ id: `ns_${s.id}`, kind: 'suggestion', text: s.proposedAction, target: { type: 'suggestion', id: s.id }, since: s.createdAt })
  }
  needsYou.push(...extraNeeds)
  needsYou.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.since - b.since)

  const usable = state.outputs
    .filter((o) => o.role !== 'brief' && o.latestVersionId && (o.reviewState === 'in_review' || o.reviewState === 'approved'))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 6)
    .map((o) => {
      const v = state.versions.find((x) => x.id === (o.approvedVersionId ?? o.latestVersionId))
      return { output: o, versionLabel: v ? `v${v.n}${o.approvedVersionId === v.id ? ' · approved' : ''}` : '' }
    })

  const deliverables = state.outputs.filter((o) => o.role !== 'brief' && o.latestVersionId)
  const inReview = deliverables.filter((o) => o.reviewState === 'in_review').sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const recent = [...deliverables].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const currentDeliverable = inReview
    ? { output: inReview, why: 'A new version is waiting for your review.' }
    : recent
      ? { output: recent, why: 'The most recently changed deliverable.' }
      : null

  const due = impact.rows.find((r) => r.category === 'decision_due')
  const conflict = impact.rows.find((r) => r.category === 'conflict')
  const nextStep = due
    ? { text: due.change.title, action: due.actions[0] ?? null }
    : conflict
      ? { text: `${conflict.change.title} ${conflict.affected[0]?.reason ?? ''}`.trim(), action: conflict.actions[0] ?? null }
      : needsYou[0]
        ? { text: needsYou[0].text, action: null }
        : null

  const changes = fresh.length
  const need = needsYou.length
  const headline =
    changes === 0 && need === 0
      ? 'Nothing new since you were last here.'
      : `${changes === 0 ? 'No new changes' : `${changes} change${changes === 1 ? '' : 's'} since you were last here`}${need ? `, ${need} need${need === 1 ? 's' : ''} you` : ''}.`

  return {
    projectId: state.project.id,
    projectTitle: state.project.title,
    since,
    headline,
    updates,
    currentDeliverable,
    usable,
    needsYou,
    nextStep,
    bundles: impact.rows.map(bundleForRow).filter((b): b is Bundle => b !== null),
    impact
  }
}

// One change's fixes as a bundle: queued revisions and input updates that can
// be approved in one click. Possible matches are never bundled: an inferred
// link needs a person to confirm it first.
export function bundleForRow(row: ImpactRow): Bundle | null {
  const acts: BundleActivity[] = []
  for (const a of row.affected) {
    if (a.relation === 'possible') continue
    for (const act of a.actions) {
      if (act.id !== 'queue_revision' && act.id !== 'update_input') continue
      acts.push({ id: `${row.change.id}:${a.key}:${act.id}`, label: act.id === 'queue_revision' ? `Draft a revision of ${a.title}` : `Give ${a.title} the new input`, action: act, dependsOn: [] })
    }
  }
  if (acts.length < 2) return null
  // An input update for a run that consumes a revised output waits for that revision.
  return { id: `bnd_${row.change.id}`, changeId: row.change.id, title: `Fix what “${row.change.title.replace(/\.$/, '')}” affected`, activities: acts }
}

function summariseAffected(row: ImpactRow): string {
  if (row.affected.length === 0) return row.change.detail
  const parts = row.affected.slice(0, 3).map((a) => a.reason.replace(/\.$/, ''))
  const more = row.affected.length - parts.length
  return `${parts.join('. ')}${more > 0 ? `, and ${more} more` : ''}.`
}

function kindRank(k: NeedsYou['kind']): number {
  return ['decision', 'uncertain_action', 'reconnect', 'approval', 'review', 'suggestion'].indexOf(k)
}
