import { useEffect, useMemo, useState } from 'react'
import { useViewStore } from '../../stores/view'
import { DashboardHeader } from '../plexi'
import Icon from '../Icon'
import { parseAgent } from '../../lib/deskAgent'
import { BUILT_IN_PROFILES } from '../../lib/agentProfiles'
import type { Widget, FbNode } from '@shared/types'

// Agents — every desk agent across the workspace in one place. Desk agents are
// widgets of kind 'agent' that live on individual desks; this view reads them
// all through the real widgets.listByKind query and the real node titles for the
// desk each one sits on. Nothing is invented: a workspace with no agents shows an
// honest empty state, and each row reflects that agent's real saved config.

function relTime(ms: number | null): string {
  if (!ms) return 'never run'
  const diff = Date.now() - ms
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const hrs = Math.round(m / 60)
  if (hrs < 24) return `${hrs}h ago`
  const d = Math.round(hrs / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function profileName(profileId: string | undefined): string {
  if (!profileId) return 'Generalist'
  return BUILT_IN_PROFILES.find((p) => p.id === profileId)?.name ?? 'Generalist'
}

export default function AgentsView(): JSX.Element {
  const goTask = useViewStore((s) => s.goTask)
  const goHome = useViewStore((s) => s.goHome)
  const [agents, setAgents] = useState<Widget[] | null>(null)
  const [nodes, setNodes] = useState<FbNode[]>([])

  useEffect(() => {
    let alive = true
    void (async () => {
      const [ws, ns] = await Promise.all([
        window.api.widgets.listByKind('agent'),
        window.api.nodes.list()
      ])
      if (!alive) return
      setAgents(ws)
      setNodes(ns)
    })()
    return () => {
      alive = false
    }
  }, [])

  const deskTitle = useMemo(() => {
    const map = new Map(nodes.map((n) => [n.id, n.title]))
    return (taskId: string): string => map.get(taskId) || 'Untitled desk'
  }, [nodes])

  return (
    <div className="h-full w-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="agents-view">
      <div className="max-w-4xl mx-auto px-6 py-6">
        <DashboardHeader
          title="Agents"
          subtitle="Every desk agent across your workspace, and the desk each one runs on"
        />

        {agents === null ? (
          <div className="px-3 py-16 text-center text-[13px] text-[var(--ink-50)]" data-testid="agents-loading">
            Loading your agents…
          </div>
        ) : agents.length === 0 ? (
          <div className="px-3 py-16 text-center" data-testid="agents-empty">
            <Icon name="smart_toy" size={30} className="text-[var(--ink-30)]" />
            <p className="mt-3 text-[14px] text-[var(--ink-70)] max-w-md mx-auto leading-relaxed">
              You have not placed any agents yet. Open a desk and add an agent work widget to put a
              standing AI worker to work, and it will appear here.
            </p>
            <button
              onClick={() => goHome()}
              data-testid="agents-empty-cta"
              className="mt-4 h-9 px-4 rounded-lg bg-[rgb(var(--accent))] text-white text-[13px] font-medium"
            >
              Open my desk
            </button>
          </div>
        ) : (
          <div className="fb-card mt-2 overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-4 py-2 text-[11px] uppercase tracking-wide text-[var(--ink-50)] border-b border-[var(--edge-soft)]">
              <span>Agent</span>
              <span>Status</span>
              <span>Last run</span>
            </div>
            {agents.map((w) => {
              const cfg = parseAgent(w.content)
              const name = (w.title && w.title.trim()) || 'Untitled agent'
              return (
                <button
                  key={w.id}
                  onClick={() => goTask(w.taskId)}
                  data-testid={`agent-row-${w.id}`}
                  className="grid grid-cols-[1fr_auto_auto] gap-3 w-full px-4 py-2.5 items-center text-left border-b border-[color-mix(in_oklab,var(--edge-soft)_60%,transparent)] hover:bg-[var(--surface-sunken)] last:border-b-0"
                  title={cfg.instruction || undefined}
                >
                  <span className="flex items-center gap-2.5 min-w-0">
                    <Icon name="smart_toy" size={17} className="text-[rgb(var(--accent))] shrink-0" />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px]">{name}</span>
                      <span className="block truncate text-[11.5px] text-[var(--ink-50)]">
                        {profileName(cfg.profileId)} on {deskTitle(w.taskId)}
                      </span>
                    </span>
                  </span>
                  <span
                    className={`text-[11.5px] px-2 py-0.5 rounded-full whitespace-nowrap ${
                      cfg.enabled
                        ? 'bg-emerald-500/15 text-emerald-500'
                        : 'bg-[var(--surface-sunken)] text-[var(--ink-50)]'
                    }`}
                  >
                    {cfg.enabled ? `Active, ${cfg.trigger}` : 'Paused'}
                  </span>
                  <span className="text-[12px] text-[var(--ink-60)] whitespace-nowrap fb-tabular">
                    {relTime(cfg.lastRunAt)}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
