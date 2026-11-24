// Runs page filters (SPEC-AI-SPACE.md §1 Runs). Pure, so the list, the counts
// and the tests agree on one definition of "Active", "Needs you" and "Done".

import type { RunSummary } from '@shared/aispace/api'
import type { RunStatus } from '@shared/aispace/model'
import { providerName } from './runText'

export type StatusGroup = 'all' | 'active' | 'needs' | 'done'

export const STATUS_GROUPS: Record<Exclude<StatusGroup, 'all'>, ReadonlySet<RunStatus>> = {
  // Still going, or might be: an unobservable external run may still be running.
  active: new Set<RunStatus>(['queued', 'running', 'waiting', 'unavailable']),
  // Something a person should look at: a held draft, a failure, a lost signal.
  needs: new Set<RunStatus>(['waiting', 'failed', 'unavailable']),
  // Finished and nothing to decide. Failed runs stay under "Needs you".
  done: new Set<RunStatus>(['succeeded', 'cancelled'])
}

export const STATUS_GROUP_LABEL: Record<StatusGroup, string> = {
  all: 'All',
  active: 'Active',
  needs: 'Needs you',
  done: 'Done'
}

export interface RunFilter {
  group: StatusGroup
  // '' = every project.
  projectId: string
  // '' = every connection; otherwise a connectionKey().
  connection: string
}

export const ALL_RUNS: RunFilter = { group: 'all', projectId: '', connection: '' }

// Runs carry the connection by alias and provider (the manifest keeps the
// credential by reference only), so that pair identifies "which connection".
export function connectionKey(r: Pick<RunSummary, 'provider' | 'connectionAlias'>): string {
  return `${r.provider ?? ''}|${r.connectionAlias ?? ''}`
}

export function inGroup(status: RunStatus, group: StatusGroup): boolean {
  return group === 'all' || STATUS_GROUPS[group].has(status)
}

export function matchesFilter(r: RunSummary, f: RunFilter): boolean {
  if (!inGroup(r.status, f.group)) return false
  if (f.projectId && r.projectId !== f.projectId) return false
  if (f.connection && connectionKey(r) !== f.connection) return false
  return true
}

// Counts per status group under the project and connection filters in force.
export function groupCounts(runs: RunSummary[], f: RunFilter): Record<StatusGroup, number> {
  const out: Record<StatusGroup, number> = { all: 0, active: 0, needs: 0, done: 0 }
  for (const r of runs) {
    if (!matchesFilter(r, { ...f, group: 'all' })) continue
    out.all++
    for (const g of ['active', 'needs', 'done'] as const) if (STATUS_GROUPS[g].has(r.status)) out[g]++
  }
  return out
}

export function projectOptions(runs: RunSummary[]): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>()
  for (const r of runs) if (!seen.has(r.projectId)) seen.set(r.projectId, r.projectTitle || 'Untitled project')
  return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
}

export function connectionOptions(runs: RunSummary[]): Array<{ value: string; label: string }> {
  const seen = new Map<string, string>()
  for (const r of runs) {
    const key = connectionKey(r)
    if (seen.has(key)) continue
    const alias = r.connectionAlias ?? 'No connection'
    const provider = r.provider ? providerName(r.provider) : null
    seen.set(key, provider && provider !== alias ? `${alias} · ${provider}` : alias)
  }
  return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
}
