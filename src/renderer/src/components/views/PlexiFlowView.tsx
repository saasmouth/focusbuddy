import { useEffect, useRef, useState } from 'react'
import Icon from '../Icon'
import { DashboardHeader, StatusPill, PLEXI_CARD } from '../plexi'
import ModuleDashboard from '../ModuleDashboard'
import { useQuickCreate } from '../../stores/quickCreate'
import { useLandOnContent } from '../../hooks/useLandOnContent'
import { bucketByWeek, periodDelta, countByKey } from '../../lib/dashboardMetrics'
import type { FbTable } from '@shared/fields'
import {
  blankAction,
  ACTION_LABELS,
  FLOW_EVENT_LABELS,
  type FlowDef,
  type FlowAction,
  type FlowActionType,
  type FlowTrigger,
  type FlowRunStep
} from '@shared/flows'

// One-line description of a trigger for the flow list.
function triggerSummary(t: FlowTrigger): string {
  if (t.kind === 'schedule') return `every ${t.every === 'daily' ? 'day' : t.every === 'weekly' ? 'week' : 'month'}`
  if (t.kind === 'event') return FLOW_EVENT_LABELS[t.event].toLowerCase()
  if (t.kind === 'webhook') return 'incoming webhook'
  return 'manual'
}

// PlexiFlow: a visual automation builder. A flow runs an ordered list of actions
// across the workspace, manually or on a schedule. Each run records an honest
// per-step log, so a missing AI key or mail account shows as a failed step rather
// than a fabricated success. An AI step's output can be reused by a later step
// with the token {{ai}}.

const ACTION_TYPES: FlowActionType[] = ['create-task', 'add-table-row', 'send-email', 'create-knowledge', 'ai-step', 'http-request']

const ACTION_ICON: Record<FlowActionType, string> = {
  'create-task': 'task_alt',
  'add-table-row': 'table_chart',
  'send-email': 'send',
  'create-knowledge': 'neurology',
  'ai-step': 'auto_awesome',
  'http-request': 'http'
}

export default function PlexiFlowView(): JSX.Element {
  const [flows, setFlows] = useState<FlowDef[] | null>(null)
  const [tables, setTables] = useState<FbTable[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load(): Promise<void> {
    setError(null)
    try {
      const [f, t] = await Promise.all([window.api.flows.list(), window.api.tables.list()])
      setFlows(f)
      setTables(t)
    } catch (e) {
      setError(`Could not load flows: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  useEffect(() => {
    void load()
    // Run any scheduled flows that have come due since the app was last open.
    void window.api.flows
      .runDue()
      .then(() => load())
      .catch((e) => setError(`Could not run due flows: ${e instanceof Error ? e.message : String(e)}`))
  }, [])

  async function addFlow(): Promise<void> {
    setError(null)
    try {
      const created = await window.api.flows.create({ title: 'New flow' })
      await load()
      setSelectedId(created.id)
    } catch (e) {
      setError(`Could not create a flow: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Global quick-create (Cmd+K "New flow").
  const quickPending = useQuickCreate((s) => s.pending)
  useEffect(() => {
    if (quickPending === 'flows' && useQuickCreate.getState().consume('flows')) void addFlow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickPending])

  const selected = flows?.find((f) => f.id === selectedId) ?? null
  const { showOverview } = useLandOnContent(flows !== null, flows ?? [], selectedId, setSelectedId)
  const flowList = flows ?? []
  const now = Date.now()

  return (
    <div className="h-full w-full flex bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="plexiflow-view">
      <div className="w-[300px] shrink-0 border-r border-[var(--edge-soft)] flex flex-col">
        <div className="px-4 py-3.5 border-b border-[var(--edge-soft)]">
          <div className="flex items-center gap-2">
            <Icon name="account_tree" size={18} className="text-[rgb(var(--accent))]" filled />
            <h1 className="fb-display text-[15px] font-bold tracking-tight">PlexiiFlow</h1>
          </div>
          <p className="mt-0.5 text-[11.5px] text-[var(--ink-70)]">When this happens, do that.</p>
        </div>
        <div className="px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => void addFlow()}
              data-testid="flow-new"
              className="flex-1 inline-flex items-center justify-center gap-1.5 h-8 rounded-md bg-[rgb(var(--accent))] text-white text-[12.5px] font-medium hover:bg-[rgb(var(--accent-hover))]"
            >
              <Icon name="add" size={15} /> New flow
            </button>
            {flows && flows.length > 0 && (
              <button
                onClick={showOverview}
                data-testid="flow-overview"
                title="Module overview"
                aria-label="Module overview"
                className={`inline-flex items-center justify-center h-8 w-8 rounded-md border text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] ${selectedId ? 'border-[var(--edge-soft)]' : 'border-[rgb(var(--accent)/0.40)] text-[rgb(var(--accent))]'}`}
              >
                <Icon name="dashboard" size={15} />
              </button>
            )}
          </div>
          {error && <p className="mt-2 text-rose-500 text-[12px]" data-testid="flows-error">{error}</p>}
        </div>
        <div className="flex-1 overflow-auto px-2 pb-2">
          {flows === null ? (
            <p className="px-3 py-6 text-[12px] text-[var(--ink-70)]">Loading…</p>
          ) : flows.length === 0 ? (
            <div className="px-3 py-10 text-center" data-testid="flows-empty">
              <Icon name="account_tree" size={24} className="text-[var(--ink-30)]" />
            </div>
          ) : (
            flows.map((f) => (
              <button
                key={f.id}
                data-testid={`flow-card-${f.id}`}
                onClick={() => setSelectedId(f.id)}
                className={`w-full text-left rounded-lg px-3 py-2.5 mb-1 border transition-colors ${
                  f.id === selectedId
                    ? 'bg-[rgb(var(--accent)/0.10)] border-[rgb(var(--accent)/0.30)]'
                    : 'hover:bg-[var(--surface-sunken)] border-transparent'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-semibold truncate flex-1 min-w-0">{f.title || 'Untitled flow'}</span>
                  {!f.enabled && <StatusPill tone="stone" label="Off" dot={false} />}
                  {f.lastStatus === 'ok' && <StatusPill tone="emerald" label="OK" dot={false} />}
                  {f.lastStatus === 'error' && <StatusPill tone="rose" label="Error" dot={false} />}
                </div>
                <p className="mt-0.5 text-[11px] text-[var(--ink-50)]">{f.actions.length} step(s) · {triggerSummary(f.trigger)}</p>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-auto">
        {selected ? (
          <FlowEditor key={selected.id} flow={selected} tables={tables} onChanged={load} />
        ) : (
          <ModuleDashboard
            moduleKey="flows"
            title="Flows"
            subtitle="Automate your workspace, an ordered set of actions that runs by hand or on a schedule"
            icon="account_tree"
            accentClass="text-violet-500"
            stats={[
              {
                icon: 'account_tree',
                label: 'Flows',
                value: flowList.length,
                tone: 'violet',
                delta: periodDelta(flowList.map((f) => f.createdAt), 7 * 86400000, now),
                sparkline: bucketByWeek(flowList.map((f) => f.createdAt), 8, now)
              },
              { icon: 'toggle_on', label: 'On', value: flowList.filter((f) => f.enabled).length, tone: 'emerald' },
              { icon: 'error', label: 'Failing', value: flowList.filter((f) => f.lastStatus === 'error').length, tone: 'rose' },
              { icon: 'pending_actions', label: 'Never run', value: flowList.filter((f) => !f.lastRunAt).length, tone: 'amber' }
            ]}
            timeline={{
              title: 'Flows created',
              points: bucketByWeek(flowList.map((f) => f.createdAt), 8, now),
              bucketLabel: 'last 8 weeks',
              unit: 'flows',
              tone: 'violet',
              emptyHint: 'Build your first flow to see your automation grow here.'
            }}
            breakdown={{
              title: 'By trigger',
              icon: 'bolt',
              items: countByKey(flowList, (f) => f.trigger.kind).map((b) => ({
                label: b.label.charAt(0).toUpperCase() + b.label.slice(1),
                value: b.value,
                tone: b.label === 'schedule' ? ('accent' as const) : b.label === 'event' ? ('violet' as const) : b.label === 'webhook' ? ('sky' as const) : ('stone' as const)
              })),
              emptyHint: 'No flows yet.'
            }}
            recentItems={{
              label: 'Your flows',
              items: flowList.slice(0, 6).map((f) => ({
                id: f.id,
                title: f.title,
                subtitle: `Runs ${triggerSummary(f.trigger)}, ${f.actions.length} action(s)`,
                meta: f.lastRunAt ? `Last run ${new Date(f.lastRunAt).toLocaleDateString()}` : 'Not run yet',
                status:
                  f.lastStatus === 'error'
                    ? { tone: 'rose' as const, label: 'Last run failed' }
                    : f.enabled
                      ? { tone: 'emerald' as const, label: 'On' }
                      : { tone: 'stone' as const, label: 'Off' },
                onOpen: () => setSelectedId(f.id)
              })),
              onCreate: () => void addFlow(),
              createLabel: 'New flow',
              emptyHint: 'No flows yet. Create one to run a sequence of actions across your workspace, automatically.'
            }}
          />
        )}
      </div>
    </div>
  )
}

function FlowEditor({
  flow,
  tables,
  onChanged
}: {
  flow: FlowDef
  tables: FbTable[]
  onChanged: () => Promise<void>
}): JSX.Element {
  const [title, setTitle] = useState(flow.title)
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<FlowRunStep[]>(flow.lastLog)
  const [error, setError] = useState<string | null>(null)

  async function patch(p: Parameters<typeof window.api.flows.update>[1]): Promise<void> {
    setError(null)
    try {
      await window.api.flows.update(flow.id, p)
      await onChanged()
    } catch (e) {
      setError(`Could not save the flow: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Flush a pending title edit if this editor unmounts (it is keyed by flow.id
  // and remounts on selection change), so switching flows before blur does not
  // lose the edit.
  const titleRef = useRef(title)
  titleRef.current = title
  useEffect(() => {
    return () => {
      if (titleRef.current !== flow.title) {
        void window.api.flows.update(flow.id, { title: titleRef.current }).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.id])

  function setTrigger(t: FlowTrigger): void {
    void patch({ trigger: t })
  }

  // Match by action id, not index, so a deferred commit (e.g. an unmount-flush
  // after the action was deleted or reordered) can never land on the wrong slot:
  // if the id is gone it is a no-op, and a moved action still updates in place.
  function updateAction(next: FlowAction): void {
    if (!flow.actions.some((a) => a.id === next.id)) return
    const actions = flow.actions.map((a) => (a.id === next.id ? next : a))
    void patch({ actions })
  }

  function addAction(type: FlowActionType): void {
    const id = `a-${Date.now()}-${flow.actions.length}`
    void patch({ actions: [...flow.actions, blankAction(type, id)] })
  }

  function removeAction(id: string): void {
    void patch({ actions: flow.actions.filter((a) => a.id !== id) })
  }

  function moveAction(idx: number, dir: -1 | 1): void {
    const j = idx + dir
    if (j < 0 || j >= flow.actions.length) return
    const next = [...flow.actions]
    ;[next[idx], next[j]] = [next[j], next[idx]]
    void patch({ actions: next })
  }

  async function run(): Promise<void> {
    setRunning(true)
    setError(null)
    try {
      const res = await window.api.flows.run(flow.id)
      setLog(res.steps)
      await onChanged()
    } catch (e) {
      setError(`Could not run the flow: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <DashboardHeader title="Flow" subtitle="A trigger and a sequence of actions across your workspace" />

      <div className="flex items-center gap-3 mb-4">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== flow.title && void patch({ title })}
          data-testid="flow-title"
          placeholder="Flow title"
          aria-label="Flow title"
          className="fb-display-hero flex-1 bg-transparent text-[20px] font-bold text-[var(--ink-100)] placeholder:text-[var(--ink-50)]"
        />
        <label className="flex items-center gap-1.5 text-[12px] text-[var(--ink-90)] cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={flow.enabled}
            data-testid="flow-enabled"
            onChange={(e) => void patch({ enabled: e.target.checked })}
            className="accent-[rgb(var(--accent))]"
          />
          Enabled
        </label>
      </div>

      {/* Trigger */}
      <div className={`${PLEXI_CARD} p-3 mb-3`}>
        <div className="flex items-center gap-2">
          <Icon name="bolt" size={15} className="text-[rgb(var(--accent))]" />
          <span className="text-[12px] font-semibold text-[var(--ink-90)]">When</span>
          <select
            value={
              flow.trigger.kind === 'schedule'
                ? flow.trigger.every
                : flow.trigger.kind === 'event'
                  ? flow.trigger.event
                  : flow.trigger.kind === 'webhook'
                    ? 'webhook'
                    : 'manual'
            }
            data-testid="flow-trigger"
            onChange={(e) => {
              const v = e.target.value
              if (v === 'manual') setTrigger({ kind: 'manual' })
              else if (v === 'webhook') setTrigger({ kind: 'webhook' })
              else if (v === 'task-completed' || v === 'row-added') setTrigger({ kind: 'event', event: v })
              else setTrigger({ kind: 'schedule', every: v as 'daily' | 'weekly' | 'monthly' })
            }}
            className="fb-field ml-1 px-2 py-1 text-[12px] text-[var(--ink-100)]"
          >
            <option value="manual">I run it manually</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
            <option value="task-completed">When a task is completed</option>
            <option value="row-added">When a table row is added</option>
            <option value="webhook">When a webhook is called</option>
          </select>
        </div>
        {flow.trigger.kind === 'webhook' && (
          <p className="mt-2 text-[11px] text-[var(--ink-50)] leading-relaxed">
            POST to{' '}
            <code className="font-mono text-[var(--ink-90)]">http://127.0.0.1:&lt;api-port&gt;/webhooks/{flow.id}</code>{' '}
            to run this flow. The local PlexiiAPI server must be on (Settings). It is bound to your machine, so an
            outside service needs a tunnel to reach it.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="space-y-2">
        {flow.actions.map((action, idx) => (
          <ActionCard
            key={action.id}
            action={action}
            index={idx}
            total={flow.actions.length}
            tables={tables}
            onChange={(next) => updateAction(next)}
            onRemove={() => removeAction(action.id)}
            onMove={(dir) => moveAction(idx, dir)}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2 flex-wrap" data-testid="flow-add-actions">
        <span className="text-[11.5px] text-[var(--ink-50)]">Add step:</span>
        {ACTION_TYPES.map((t) => (
          <button
            key={t}
            onClick={() => addAction(t)}
            data-testid={`flow-add-${t}`}
            className="fb-btn-surface inline-flex items-center gap-1 px-2 py-1 text-[11.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
          >
            <Icon name={ACTION_ICON[t]} size={13} /> {ACTION_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="mt-5 flex items-center gap-2">
        <button
          onClick={() => void run()}
          disabled={running || flow.actions.length === 0}
          data-testid="flow-run"
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[rgb(var(--accent))] text-white text-[13px] font-medium hover:bg-[rgb(var(--accent-hover))] disabled:opacity-40"
        >
          <Icon name="play_arrow" size={16} /> {running ? 'Running…' : 'Run now'}
        </button>
        <span className="text-[11.5px] text-[var(--ink-50)]">Use {'{{ai}}'} in a later step to reuse an AI step output.</span>
      </div>

      {error && <p className="mt-3 text-rose-500 text-[12px]" data-testid="flow-editor-error">{error}</p>}

      {log.length > 0 && (
        <div className="mt-4" data-testid="flow-log">
          <span className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--ink-50)]">Last run</span>
          <div className="mt-1.5 space-y-1">
            {log.map((s, i) => (
              <div key={i} className="flex items-start gap-2 text-[12.5px]">
                <Icon
                  name={s.ok ? 'check_circle' : 'error'}
                  size={14}
                  className={`mt-0.5 shrink-0 ${s.ok ? 'text-emerald-500' : 'text-rose-500'}`}
                  filled
                />
                <span className="text-[var(--ink-90)]">
                  <span className="text-[var(--ink-50)]">{ACTION_LABELS[s.type]}:</span> {s.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ActionCard({
  action,
  index,
  total,
  tables,
  onChange,
  onRemove,
  onMove
}: {
  action: FlowAction
  index: number
  total: number
  tables: FbTable[]
  onChange: (next: FlowAction) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
}): JSX.Element {
  const field =
    'fb-field w-full px-2 py-1.5 text-[12.5px] placeholder:text-[var(--ink-50)]'

  // Hold the editable action locally so typing is snappy and never races the
  // parent prop. The edit commits upward on blur. Committing here is keyed by the
  // action id (see updateAction), so even a late blur cannot land on the wrong
  // slot. We deliberately do NOT flush on unmount: switching flows or actions
  // blurs the focused field first, which commits it, and a delete must not
  // resurrect the row it just removed by re-committing a stale array.
  const [local, setLocal] = useState<FlowAction>(action)
  // Re-seed from the prop when the action identity or type changes (e.g. a
  // reorder swaps which action lives at this slot), but keep local edits while
  // the same action is being typed into.
  useEffect(() => {
    setLocal(action)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action.id, action.type])

  const commit = (): void => {
    if (JSON.stringify(local) !== JSON.stringify(action)) onChange(local)
  }

  return (
    <div className={`${PLEXI_CARD} p-3`} data-testid={`flow-action-${index}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-[var(--surface-sunken)] text-[var(--ink-70)] fb-tabular text-[11px]">{index + 1}</span>
        <Icon name={ACTION_ICON[action.type]} size={14} className="text-[rgb(var(--accent))]" />
        <span className="text-[12.5px] font-semibold text-[var(--ink-90)] flex-1">{ACTION_LABELS[action.type]}</span>
        <button aria-label="Move step up" onClick={() => onMove(-1)} disabled={index === 0} className="p-1 rounded text-[var(--ink-50)] hover:text-[var(--ink-100)] disabled:opacity-30">
          <Icon name="arrow_upward" size={13} />
        </button>
        <button aria-label="Move step down" onClick={() => onMove(1)} disabled={index === total - 1} className="p-1 rounded text-[var(--ink-50)] hover:text-[var(--ink-100)] disabled:opacity-30">
          <Icon name="arrow_downward" size={13} />
        </button>
        <button
          aria-label="Remove step"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onRemove}
          className="p-1 rounded text-[var(--ink-50)] hover:text-rose-500"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="space-y-2 pl-8">
        {local.type === 'create-task' && (
          <input value={local.title} onChange={(e) => setLocal({ ...local, title: e.target.value })} onBlur={commit} placeholder="Desk title" className={field} />
        )}
        {local.type === 'add-table-row' && (
          <select
            value={local.tableId}
            onChange={(e) => {
              const next = { ...local, tableId: e.target.value }
              setLocal(next)
              // A select has no meaningful blur step, so commit immediately.
              if (JSON.stringify(next) !== JSON.stringify(action)) onChange(next)
            }}
            className={field}
          >
            <option value="">Choose a table…</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>{t.title || 'Untitled table'}</option>
            ))}
          </select>
        )}
        {local.type === 'send-email' && (
          <>
            <input value={local.to} onChange={(e) => setLocal({ ...local, to: e.target.value })} onBlur={commit} placeholder="to@company.com, ..." className={field} />
            <input value={local.subject} onChange={(e) => setLocal({ ...local, subject: e.target.value })} onBlur={commit} placeholder="Subject" className={field} />
            <textarea value={local.body} onChange={(e) => setLocal({ ...local, body: e.target.value })} onBlur={commit} placeholder="Body (use {{ai}} to insert an AI step output)" rows={3} className={`${field} resize-none`} />
          </>
        )}
        {local.type === 'create-knowledge' && (
          <>
            <input value={local.title} onChange={(e) => setLocal({ ...local, title: e.target.value })} onBlur={commit} placeholder="Entry title" className={field} />
            <textarea value={local.body} onChange={(e) => setLocal({ ...local, body: e.target.value })} onBlur={commit} placeholder="Entry body (use {{ai}} to insert an AI step output)" rows={3} className={`${field} resize-none`} />
          </>
        )}
        {local.type === 'ai-step' && (
          <textarea value={local.prompt} onChange={(e) => setLocal({ ...local, prompt: e.target.value })} onBlur={commit} placeholder="Prompt for the AI. Its output is reusable as {{ai}} in later steps." rows={3} className={`${field} resize-none`} />
        )}
        {local.type === 'http-request' && (
          <>
            <div className="flex items-center gap-1.5">
              <select
                value={local.method}
                onChange={(e) => {
                  const next = { ...local, method: e.target.value as typeof local.method }
                  setLocal(next)
                  if (JSON.stringify(next) !== JSON.stringify(action)) onChange(next)
                }}
                className={`${field} w-24 shrink-0`}
              >
                {(['POST', 'GET', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <input value={local.url} onChange={(e) => setLocal({ ...local, url: e.target.value })} onBlur={commit} placeholder="https://hooks.slack.com/services/…" className={field} />
            </div>
            <textarea value={local.headers} onChange={(e) => setLocal({ ...local, headers: e.target.value })} onBlur={commit} placeholder={'Headers, one per line:\nAuthorization: Bearer …'} rows={2} className={`${field} resize-none font-mono text-[11px]`} />
            <textarea value={local.body} onChange={(e) => setLocal({ ...local, body: e.target.value })} onBlur={commit} placeholder={'Request body (JSON). Use {{ai}} to insert a prior step output.'} rows={3} className={`${field} resize-none font-mono text-[11px]`} />
          </>
        )}
      </div>
    </div>
  )
}
