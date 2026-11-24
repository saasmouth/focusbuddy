// Impact (SPEC-AI-SPACE.md §2, the flagship view): read the project by
// consequence. One row per meaningful change, with stable columns What changed
// / What it affected / What you can do. Each relation says why it is there:
// "Used this version" (recorded) or "Possible match" (inferred, with the exact
// excerpt). Items expand in place; other rows stay where they are.
//
// "As of" rebuilds the project at any recorded moment from the same records
// (main: stateAsOf), so "When I left" and "Now" share headings and positions.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import Icon from '../Icon'
import type { ImpactResponse } from '@shared/aispace/api'
import type { AffectedItem, ImpactAction, ImpactRow } from '@shared/aispace/impact'
import Modal from '../plexi/Modal'
import { useViewStore } from '../../stores/view'
import { useActionHistory } from '../../stores/actionHistory'
import { EmptyState, Excerpt, LinkButton, NewUpdatesBar, PrimaryButton, QuietButton, RelationTag, StatusBadge, Tabs, announce, fmtAgo, fmtWhen, useOnRequestUpdates } from './ui'

export type InspectTarget = { kind: 'output'; id: string; versionId?: string | null; compare?: [string, string] | null } | { kind: 'run'; id: string } | { kind: 'source'; id: string } | { kind: 'decision'; id: string } | { kind: 'task'; id: string } | { kind: 'request'; id: string } | { kind: 'branches'; id: string }

const STATUS_TEXT: Record<AffectedItem['status'], string> = {
  stale: 'Still on the old input',
  revision_ready: 'Revision ready',
  will_use_old_input: 'Will use the old input',
  blocked: 'Blocked',
  possible_match: 'Possible match',
  ready_for_review: 'Ready for review',
  failed: 'Failed',
  supplied: 'Answer found',
  waiting_on_decision: 'Waiting on a decision'
}

const STATUS_ICON: Record<AffectedItem['status'], string> = {
  stale: 'history',
  revision_ready: 'auto_fix_high',
  will_use_old_input: 'schedule',
  blocked: 'block',
  possible_match: 'help_center',
  ready_for_review: 'rate_review',
  failed: 'error',
  supplied: 'task_alt',
  waiting_on_decision: 'gavel'
}

export default function ImpactView(props: { projectId: string; onInspect: (t: InspectTarget) => void; focusChangeId?: string | null; onChanged: () => void }): JSX.Element {
  const [data, setData] = useState<ImpactResponse | null>(null)
  const [asOf, setAsOf] = useState<number | null>(null) // null = now
  const [tab, setTab] = useState<'impact' | 'activity'>('impact')
  const [scope, setScope] = useState<'focus' | 'all'>('focus')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [bundle, setBundle] = useState<ImpactRow | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [leftRows, setLeftRows] = useState<Set<string> | null>(null)

  const load = useCallback(async () => {
    const d = await window.api.aiSpace.impact(props.projectId, { asOf })
    setData(d)
    // Mark rows that are new since the person left (Now view only).
    if (!asOf && d.leftAt) {
      const then = await window.api.aiSpace.impact(props.projectId, { asOf: d.leftAt })
      setLeftRows(new Set(then.result.rows.map((r) => r.change.id)))
    } else setLeftRows(null)
  }, [props.projectId, asOf])

  useEffect(() => {
    void load()
  }, [load])
  const { pending, apply, reload } = useOnRequestUpdates(load, (p) => (p.topic === 'event' || p.topic === 'run') && (!p.projectId || p.projectId === props.projectId))

  useEffect(() => {
    if (props.focusChangeId) {
      setExpanded((s) => new Set([...s, props.focusChangeId!]))
      setTimeout(() => document.getElementById(`impact-row-${props.focusChangeId}`)?.scrollIntoView({ block: 'center' }), 60)
    }
  }, [props.focusChangeId, data])

  const rows = useMemo(() => {
    if (!data) return []
    const all = data.result.rows
    // Minor = a change that affected nothing. A possible match is never
    // minor: it waits for the person to confirm or dismiss it.
    return scope === 'all' ? all : all.filter((r) => r.category !== 'info' || r.affected.length > 0 || r.change.id === props.focusChangeId)
  }, [data, scope, props.focusChangeId])

  const historical = asOf !== null

  async function act(row: ImpactRow, item: AffectedItem | null, action: ImpactAction): Promise<void> {
    if (historical) return
    const key = `${row.change.id}:${item?.key ?? ''}:${action.id}`
    setBusy(key)
    try {
      switch (action.id) {
        case 'compare': {
          const pl = action.payload as { a?: string; b?: string } | undefined
          props.onInspect({ kind: 'output', id: action.target.id, versionId: pl?.b ?? null, compare: pl?.a && pl?.b ? [pl.a, pl.b] : null })
          break
        }
        case 'review':
          props.onInspect({ kind: 'output', id: action.target.id, versionId: action.target.versionId ?? null })
          break
        case 'queue_revision': {
          const r = await window.api.aiSpace.queueRevision(props.projectId, action.target.id, row.change.id)
          announce(r.ok ? 'Revision started.' : r.reason)
          if (!r.ok) alertReason(r.reason)
          break
        }
        case 'update_input': {
          const pl = action.payload as { from?: { type: string; id: string; versionId?: string | null } | null; to?: { type: string; id: string; versionId?: string | null; label?: string } | null } | undefined
          if (pl?.from && pl.to) {
            const r = await window.api.aiSpace.updateRunInput(action.target.id, pl.from as never, pl.to as never)
            announce(r.detail)
          } else props.onInspect({ kind: 'run', id: action.target.id })
          break
        }
        case 'confirm_link':
        case 'dismiss_match': {
          const related = action.id === 'confirm_link'
          const r = await window.api.aiSpace.judgeMatch(props.projectId, action.target.id, row.change.id, related)
          const label = related ? `Mark ${item?.title ?? 'it'} as related` : `Mark ${item?.title ?? 'it'} as not related`
          // Reversible: Undo reopens the judgement and the match shows again.
          if (r.suggestionId) {
            const sid = r.suggestionId
            useActionHistory.getState().recordWithToast({
              label,
              toastIcon: related ? 'link' : 'link_off',
              undo: async () => {
                await window.api.aiSpace.reopenSuggestion(sid)
                await load()
              },
              redo: async () => {
                await window.api.aiSpace.judgeMatch(props.projectId, action.target.id, row.change.id, related)
                await load()
              }
            })
          }
          announce(related ? 'Marked as related.' : 'Marked as not related.')
          break
        }
        case 'approve':
          if (item) await window.api.aiSpace.approveVersion(item.ref.id, action.target.id)
          announce('Approved.')
          break
        case 'retry':
          await window.api.aiSpace.retryRun(action.target.id)
          announce('Started again.')
          break
        case 'handover':
          props.onInspect({ kind: 'run', id: action.target.id })
          break
        case 'reconnect':
          useViewStore.getState().goConnections(action.target.id)
          break
        case 'deliver':
          await window.api.aiSpace.deliverRequest(action.target.id)
          announce('Delivered.')
          break
        case 'decide':
          props.onInspect({ kind: 'decision', id: action.target.id })
          break
        case 'open_source':
          openRef(action.target, props.onInspect)
          break
      }
      // The person's own action: refresh without announcing it as new.
      await reload()
      props.onChanged()
    } finally {
      setBusy(null)
    }
  }

  const toggle = (id: string): void =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  if (!data) return <div className="fb-skeleton h-40 rounded-xl" aria-busy="true" />

  return (
    <div data-testid="ais-impact" className="relative">
      <NewUpdatesBar count={historical ? 0 : pending} onApply={apply} />
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Tabs label="Impact or activity" tabs={[{ id: 'impact', label: 'Impact', count: data.result.rows.length }, { id: 'activity', label: 'Activity' }]} active={tab} onChange={setTab} testIdPrefix="ais-impact-tab" />
        <AsOfControl data={data} asOf={asOf} onChange={setAsOf} />
        {tab === 'impact' && (
          <label className="ml-auto inline-flex items-center gap-2 text-[12.5px] text-[var(--ink-70)]">
            <input type="checkbox" checked={scope === 'all'} onChange={(e) => setScope(e.target.checked ? 'all' : 'focus')} data-testid="ais-impact-all" />
            Show minor changes too
          </label>
        )}
      </div>

      {historical && (
        <div className="mb-4 rounded-lg border border-[var(--edge-soft)] px-3.5 py-2.5 text-[13px] flex flex-wrap items-center gap-3" data-testid="ais-impact-history-note">
          <Icon name="history" size={16} className="text-[var(--ink-60)]" />
          <span>
            You’re looking at the project as it was on <strong>{fmtWhen(asOf!)}</strong>. Nothing here can be changed.
          </span>
          <span className="ml-auto flex gap-2">
            <QuietButton onClick={() => setAsOf(null)} testId="ais-impact-back-now">
              Act on the current project
            </QuietButton>
            <QuietButton
              onClick={async () => {
                const b = await window.api.aiSpace.createBranch(props.projectId, `From ${new Date(asOf!).toLocaleDateString()}`)
                announce(`Branch “${b.name}” started.`)
                props.onChanged()
              }}
              testId="ais-impact-branch-here"
            >
              Start a branch from now
            </QuietButton>
          </span>
        </div>
      )}

      {tab === 'activity' ? (
        <ActivityList data={data} onOpen={(ref) => openRef(ref, props.onInspect)} />
      ) : rows.length === 0 ? (
        <EmptyState icon="done_all" title={historical ? 'Nothing open at that moment' : 'Nothing needs attention'} body={historical ? undefined : 'When a decision, brief or input changes, what it affects shows up here, ordered by consequence.'} testId="ais-impact-empty" />
      ) : (
        <div role="table" aria-label="Changes and what they affected" className="fb-card overflow-hidden">
          <div role="row" className="hidden md:grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_minmax(0,0.9fr)] gap-4 px-4 py-2 text-[11.5px] uppercase tracking-wide text-[var(--ink-50)] border-b border-[var(--edge-soft)]">
            <span role="columnheader">What changed</span>
            <span role="columnheader">What it affected</span>
            <span role="columnheader">What you can do</span>
          </div>
          {rows.map((row) => (
            <ImpactRowView
              key={row.change.id}
              row={row}
              isNew={Boolean(leftRows && !leftRows.has(row.change.id))}
              expanded={expanded.has(row.change.id)}
              onToggle={() => toggle(row.change.id)}
              onAct={(item, a) => void act(row, item, a)}
              onInspect={props.onInspect}
              busyKey={busy}
              historical={historical}
              revisions={data.result.proposedRevisions}
              onBundle={() => setBundle(row)}
            />
          ))}
        </div>
      )}
      {bundle && <BundleDialog projectId={props.projectId} row={bundle} onClose={() => setBundle(null)} onDone={async () => {
        await load()
        props.onChanged()
      }} />}
    </div>
  )
}

function alertReason(reason: string): void {
  void import('../plexi/PromptDialog').then((m) => m.alertDialog({ title: 'That didn’t start', body: reason }))
}

function openRef(ref: { type: string; id: string; versionId?: string | null }, onInspect: (t: InspectTarget) => void): void {
  if (ref.type === 'run') onInspect({ kind: 'run', id: ref.id })
  else if (ref.type === 'source') onInspect({ kind: 'source', id: ref.id })
  else if (ref.type === 'decision') onInspect({ kind: 'decision', id: ref.id })
  else if (ref.type === 'output') onInspect({ kind: 'output', id: ref.id, versionId: ref.versionId ?? null })
  else if (ref.type === 'task') onInspect({ kind: 'task', id: ref.id })
  else if (ref.type === 'request') onInspect({ kind: 'request', id: ref.id })
  else if (ref.type === 'connection') useViewStore.getState().goConnections(ref.id)
  else if (ref.type === 'version') onInspect({ kind: 'output', id: '', versionId: ref.id })
}

function ImpactRowView(props: {
  row: ImpactRow
  isNew: boolean
  expanded: boolean
  onToggle: () => void
  onAct: (item: AffectedItem | null, a: ImpactAction) => void
  onInspect: (t: InspectTarget) => void
  busyKey: string | null
  historical: boolean
  revisions: Array<{ id: string; outputId: string; outputTitle: string; contributingChangeIds: string[] }>
  onBundle: () => void
}): JSX.Element {
  const { row } = props
  const detailsId = useId()
  const fixes = row.affected.filter((a) => a.relation !== 'possible' && a.actions.some((x) => x.id === 'queue_revision' || x.id === 'update_input')).length
  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter') {
      e.preventDefault()
      props.onToggle()
    } else if (e.key === 'Escape' && props.expanded) {
      e.preventDefault()
      props.onToggle()
    }
  }
  const possibleOnly = row.affected.length > 0 && row.affected.every((a) => a.relation === 'possible')
  const cat = row.category === 'decision_due' ? { icon: 'gavel', text: 'Decision due' } : row.category === 'conflict' ? { icon: 'priority_high', text: 'Needs attention' } : row.category === 'usable' ? { icon: 'task_alt', text: 'Ready to use' } : possibleOnly ? { icon: 'help_center', text: 'Check possible matches' } : { icon: 'info', text: 'For your information' }
  // The right column can name the same action twice (two possible matches):
  // say which item each one is for.
  const labelCount = new Map<string, number>()
  for (const a of row.actions) labelCount.set(a.label, (labelCount.get(a.label) ?? 0) + 1)
  return (
    <div
      role="row"
      id={`impact-row-${row.change.id}`}
      tabIndex={0}
      onKeyDown={onKey}
      aria-expanded={props.expanded}
      aria-controls={detailsId}
      data-testid="ais-impact-row"
      data-change={row.change.id}
      className="grid md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_minmax(0,0.9fr)] gap-x-4 gap-y-3 px-4 py-4 border-b border-[var(--edge-hairline)] last:border-b-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[rgb(var(--accent))]"
    >
      {/* What changed */}
      <div role="cell" className="min-w-0">
        <div className="flex items-center gap-2 text-[12px] text-[var(--ink-50)]">
          <Icon name={cat.icon} size={14} className={row.category === 'conflict' || row.category === 'decision_due' ? 'text-[color:var(--ais-warn)]' : ''} />
          <span>{cat.text}</span>
          <span aria-hidden>·</span>
          <span className="fb-tabular">{fmtAgo(row.change.at)}</span>
          {props.isNew && <span className="ml-1 px-1.5 rounded-md bg-[rgb(var(--accent)/0.10)] text-[rgb(var(--accent))] text-[11px]">New since you left</span>}
        </div>
        <p className="mt-1 text-[14.5px] font-medium text-[var(--ink-100)]">{row.change.title}</p>
        {row.change.detail && <p className="text-[14px] text-[var(--ink-70)]">{row.change.detail}</p>}
        {row.change.source && (
          <div className="mt-1.5">
            <LinkButton onClick={() => openRef(row.change.source!, props.onInspect)} testId="ais-impact-open-source">
              Open source
            </LinkButton>
          </div>
        )}
      </div>

      {/* What it affected */}
      <div role="cell" className="min-w-0 space-y-2" id={detailsId}>
        {row.affected.length === 0 && <p className="text-[13px] text-[var(--ink-60)]">Nothing recorded depends on it.</p>}
        {row.affected.map((a) => {
          const rev = a.proposedRevisionId ? props.revisions.find((r) => r.id === a.proposedRevisionId) : null
          return (
            <div key={a.key} className="rounded-lg border border-[var(--edge-hairline)] px-3 py-2" data-testid="ais-impact-item" data-relation={a.relation} data-status={a.status}>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => openRef(a.ref, props.onInspect)} className="text-[14px] font-medium text-left hover:underline underline-offset-2 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]">
                  {a.title}
                </button>
                {a.status !== 'possible_match' && (
                  <span className="inline-flex items-center gap-1 text-[12px] text-[var(--ink-70)]">
                    <Icon name={STATUS_ICON[a.status]} size={13} />
                    {STATUS_TEXT[a.status]}
                  </span>
                )}
                <RelationTag relation={a.relation} />
                {a.preview?.versionLabel && <span className="text-[11.5px] text-[var(--ink-50)] fb-tabular">{a.preview.versionLabel}</span>}
              </div>
              <p className="mt-0.5 text-[13.5px] text-[var(--ink-80)]">{a.reason}</p>
              {rev && rev.contributingChangeIds.length > 1 && (
                <p className="mt-0.5 text-[12px] text-[var(--ink-60)]" data-testid="ais-impact-grouped">
                  One proposed revision for {rev.outputTitle} covers {rev.contributingChangeIds.length} changes.
                </p>
              )}
              {/* Evidence is shown BEFORE any review, always for inferred links. */}
              {(props.expanded || a.relation === 'possible') && (
                <div className="mt-2 ais-expand space-y-2">
                  {a.evidence.map((ev, i) => (
                    <div key={i} className="text-[12.5px]">
                      <p className="text-[var(--ink-60)]">
                        {ev.basis === 'recorded' ? 'Recorded: ' : 'Inferred: '}
                        {ev.text}
                      </p>
                      {ev.excerpt && (
                        <blockquote className="mt-1 border-l-2 border-[var(--edge-firm)] pl-2.5 text-[13px] text-[var(--ink-80)]">
                          <Excerpt text={ev.excerpt} start={ev.matchStart} end={ev.matchEnd} />
                        </blockquote>
                      )}
                    </div>
                  ))}
                  {props.expanded && a.preview?.mediaRef && /^(data:image\/|https:\/\/)/.test(a.preview.mediaRef) && (
                    <img src={a.preview.mediaRef} alt={a.title} style={{ aspectRatio: a.preview.mediaWidth && a.preview.mediaHeight ? `${a.preview.mediaWidth} / ${a.preview.mediaHeight}` : undefined }} className="max-h-48 rounded-md border border-[var(--edge-hairline)] object-contain" />
                  )}
                  {props.expanded && !a.evidence.some((e) => e.excerpt) && a.preview?.excerpt && <p className="text-[13px] text-[var(--ink-70)] whitespace-pre-wrap line-clamp-6">{a.preview.excerpt}</p>}
                </div>
              )}
              {!props.historical && a.actions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {a.actions.map((x) => (
                    <QuietButton key={x.id} onClick={() => props.onAct(a, x)} disabled={props.busyKey !== null} testId={`ais-item-action-${x.id}`}>
                      {x.label}
                    </QuietButton>
                  ))}
                </div>
              )}
            </div>
          )
        })}
        {row.affected.length > 0 && (
          <button type="button" onClick={props.onToggle} className="text-[12.5px] text-[var(--ink-60)] hover:text-[var(--ink-100)] inline-flex items-center gap-1 min-h-[24px] rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]" aria-expanded={props.expanded} data-testid="ais-impact-expand">
            <Icon name={props.expanded ? 'expand_less' : 'expand_more'} size={15} />
            {props.expanded ? 'Hide evidence' : 'Show evidence'}
          </button>
        )}
      </div>

      {/* What you can do */}
      <div role="cell" className="min-w-0 flex flex-col items-start gap-2">
        {!props.historical &&
          row.actions.map((a) => {
            const item = row.affected.find((x) => x.actions.some((y) => y.id === a.id && y.target.id === a.target.id)) ?? null
            return (
              <QuietButton key={`${a.id}:${a.target.id}`} onClick={() => props.onAct(item, a)} disabled={props.busyKey !== null} testId={`ais-row-action-${a.id}`}>
                {(labelCount.get(a.label) ?? 0) > 1 && item ? `${a.label}: ${item.title}` : a.label}
              </QuietButton>
            )
          })}
        {!props.historical && fixes >= 2 && (
          <PrimaryButton onClick={props.onBundle} testId="ais-row-bundle">
            Fix all {fixes}…
          </PrimaryButton>
        )}
        {props.historical && <span className="text-[12.5px] text-[var(--ink-50)]">Read-only at this point in time.</span>}
      </div>
    </div>
  )
}

function AsOfControl({ data, asOf, onChange }: { data: ImpactResponse; asOf: number | null; onChange: (t: number | null) => void }): JSX.Element {
  // Points the person can pick: When I left, and every recorded change.
  const points = useMemo(() => {
    const out: Array<{ at: number; label: string }> = []
    const seen = new Set<number>()
    for (const e of [...data.timeline].reverse()) {
      if (seen.has(e.at)) continue
      seen.add(e.at)
      out.push({ at: e.at, label: `${fmtWhen(e.at)} · ${e.summary.slice(0, 60)}` })
      if (out.length >= 60) break
    }
    return out
  }, [data.timeline])
  const value = asOf === null ? 'now' : data.leftAt && asOf === data.leftAt ? 'left' : String(asOf)
  return (
    <label className="inline-flex items-center gap-2 text-[13px]">
      <span className="text-[var(--ink-60)]">As of</span>
      <select
        value={value}
        data-testid="ais-asof"
        onChange={(e) => {
          const v = e.target.value
          onChange(v === 'now' ? null : v === 'left' ? data.leftAt : Number(v))
        }}
        className="fb-field h-8 rounded-lg px-2 text-[13px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)] max-w-[300px]"
      >
        <option value="now">Now</option>
        {data.leftAt && <option value="left">When I left ({fmtWhen(data.leftAt)})</option>}
        {points.map((p) => (
          <option key={p.at} value={String(p.at)}>
            {p.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function ActivityList({ data, onOpen }: { data: ImpactResponse; onOpen: (ref: { type: string; id: string }) => void }): JSX.Element {
  const list = [...data.activity].reverse()
  if (list.length === 0) return <EmptyState icon="history" title="No activity yet" />
  return (
    <ol className="fb-card divide-y divide-[var(--edge-hairline)]" data-testid="ais-activity">
      {list.map((e) => (
        <li key={e.seq} className="px-4 py-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-3 text-[13.5px]">
          <span className="text-[12px] text-[var(--ink-50)] fb-tabular w-[150px]">{fmtWhen(e.at)}</span>
          <span className="min-w-0">
            <span>{e.summary}</span>
            <span className="text-[12px] text-[var(--ink-50)]"> · {e.actor.replace(/^(user|agent|connection):/, '').replace(/^me$/, 'You')}</span>
            {e.subject && e.subject.type !== 'project' && (
              <button type="button" onClick={() => onOpen(e.subject!)} className="ml-2 text-[12px] text-[rgb(var(--accent))] hover:underline">
                Open
              </button>
            )}
          </span>
        </li>
      ))}
    </ol>
  )
}

// One approval for several activities, after a preview of the scope, the
// account that pays and the dependencies. Results are shown per activity; one
// failing never undoes the others (§3).
function BundleDialog({ projectId, row, onClose, onDone }: { projectId: string; row: ImpactRow; onClose: () => void; onDone: () => Promise<void> }): JSX.Element {
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof window.api.aiSpace.previewBundle>>>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<Array<{ activityId: string; ok: boolean; detail: string }> | null>(null)
  const [busy, setBusy] = useState(false)
  const head = useId()
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void window.api.aiSpace.previewBundle(projectId, row.change.id).then((p) => {
      setPreview(p)
      setChosen(new Set(p?.activities.map((a) => a.id) ?? []))
    })
  }, [projectId, row.change.id])
  async function approve(): Promise<void> {
    setBusy(true)
    try {
      const r = await window.api.aiSpace.approveBundle(projectId, row.change.id, [...chosen])
      setResults(r)
      announce(`${r.filter((x) => x.ok).length} of ${r.length} started.`)
      await onDone()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal onClose={onClose} labelledById={head} testId="ais-bundle" className="fb-card w-[min(620px,94vw)]">
      <div className="p-5">
        <h2 id={head} className="text-[18px] font-semibold">
          {preview?.title ?? 'Fix what this affected'}
        </h2>
        <p className="mt-1 text-[13px] text-[var(--ink-60)]">Each item runs on its own. If one fails, the others still finish and stay available.</p>
        {!preview ? (
          <div className="mt-4 fb-skeleton h-24 rounded-lg" />
        ) : (
          <ul className="mt-4 space-y-2">
            {preview.activities.map((a) => {
              const res = results?.find((r) => r.activityId === a.id)
              return (
                <li key={a.id} className="rounded-lg border border-[var(--edge-soft)] px-3 py-2.5">
                  <label className="flex items-start gap-2.5">
                    <input type="checkbox" className="mt-1" checked={chosen.has(a.id)} disabled={Boolean(results)} onChange={(e) => setChosen((s) => { const n = new Set(s); if (e.target.checked) n.add(a.id); else n.delete(a.id); return n })} />
                    <span className="min-w-0">
                      <span className="block text-[14px]">{a.label}</span>
                      <span className="block text-[12px] text-[var(--ink-60)]">
                        {a.connection ?? 'No connection set'}
                        {a.payer ? ` · paid by ${a.payer}` : ''} · {a.estimate}
                        {a.dependsOn.length ? ` · waits for ${a.dependsOn.length}` : ''}
                      </span>
                    </span>
                  </label>
                  {res && (
                    <p className={`mt-1.5 text-[12.5px] inline-flex items-center gap-1 ${res.ok ? 'text-[color:var(--ais-ok)]' : 'text-[color:var(--ais-bad)]'}`} data-testid="ais-bundle-result">
                      <Icon name={res.ok ? 'check_circle' : 'error'} size={14} />
                      {res.detail}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <QuietButton onClick={onClose}>{results ? 'Close' : 'Cancel'}</QuietButton>
          {!results && (
            <PrimaryButton onClick={() => void approve()} disabled={busy || chosen.size === 0} testId="ais-bundle-approve">
              {busy ? 'Starting…' : `Approve ${chosen.size}`}
            </PrimaryButton>
          )}
        </div>
      </div>
    </Modal>
  )
}

export { StatusBadge }
