import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../Icon'
import PlexiiIcon from '../PlexiiIcon'
import { DashboardHeader, StatusPill, StatTile, PLEXI_CARD, spawnSparkBurst } from '../plexi'
import { useViewStore } from '../../stores/view'
import { useNodeStore } from '../../stores/nodes'
import { useQuickCreate } from '../../stores/quickCreate'
import type { ProjectPlan, ProjectSummary, PlanTask, PlanDep, DepType } from '@shared/projects'
import type { WorkingCalendar } from '@shared/workingCalendar'
import type { FileEntry } from '@shared/fields'
import { usePresenceStore } from '../../stores/presence'

// PlexiProjects: roll the tasks you already work in up into a scheduled plan. A
// portfolio lists every project (a folder with tasks) with its progress and end
// date; opening one shows a Gantt with a critical path, dependency arrows, a
// today line and drift markers, all computed from real task dates and estimates
// by the engine in shared/gantt.ts. Nothing is invented: a project with no dated
// tasks still shows a real, if trivial, one-day-per-task schedule.

const DAY_MS = 24 * 60 * 60 * 1000
const DAY_W = 26 // px per day
const ROW_H = 32 // px per task row
const HEADER_H = 32
const NAME_W = 224

// A plan is one container read through several contextual views of its real
// universal objects. Overview summarises the plan, Files lists the documents and
// files filed under it, and the rest (timeline, board, grid, calendar, workload)
// are views of the plan's tasks. A file in a plan is still just a file; a task in
// a plan is still just a task. These are views, not duplicated modules.
type ProjectViewMode = 'overview' | 'gantt' | 'board' | 'grid' | 'calendar' | 'workload' | 'files'
const VIEW_MODES: { id: ProjectViewMode; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'gantt', label: 'Timeline', icon: 'timeline' },
  { id: 'board', label: 'Board', icon: 'view_kanban' },
  { id: 'grid', label: 'Grid', icon: 'table_rows' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar_month' },
  { id: 'workload', label: 'Workload', icon: 'groups' },
  { id: 'files', label: 'Files', icon: 'folder' }
]

// Workflow statuses shown as board columns, in order.
const STATUS_COLUMNS: { id: string; label: string; tone: string }[] = [
  { id: 'open', label: 'To do', tone: 'stone' },
  { id: 'in_progress', label: 'In progress', tone: 'accent' },
  { id: 'parked', label: 'Parked', tone: 'amber' },
  { id: 'done', label: 'Done', tone: 'emerald' }
]
function statusOf(t: PlanTask): string {
  if (t.status === 'done' || t.completedAt != null) return 'done'
  if (t.status === 'in_progress' || t.status === 'parked') return t.status
  return 'open'
}

function toDateInput(ms: number | null): string {
  if (ms == null) return ''
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fromDateInput(s: string): number | null {
  if (!s) return null
  const [y, m, d] = s.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d).getTime()
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Currency-agnostic cost formatting: thousands separators, up to 2 decimals.
function fmtCost(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export default function PlexiProjectsView(): JSX.Element {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadPortfolio = useCallback(() => {
    setError(null)
    window.api.projects
      .list()
      .then(setProjects)
      .catch((e) => setError(`Could not load plans: ${e instanceof Error ? e.message : String(e)}`))
  }, [])

  useEffect(() => {
    loadPortfolio()
  }, [loadPortfolio])

  // Global quick-create (Cmd+K "New project"): create + open straight away.
  const quickPending = useQuickCreate((s) => s.pending)
  useEffect(() => {
    if (quickPending === 'projects' && useQuickCreate.getState().consume('projects')) void newProject()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickPending])

  // Create a new project (a folder) and open it straight away so the user can add
  // its first task, even before it shows in the portfolio (which lists folders that
  // already have tasks).
  async function newProject(): Promise<void> {
    setError(null)
    try {
      const node = await window.api.nodes.create({ parentId: null, kind: 'folder', title: 'New plan', isPlan: true })
      setOpenId(node.id)
    } catch (e) {
      setError(`Could not create the plan: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (openId) {
    return <ProjectGantt projectId={openId} onBack={() => { setOpenId(null); loadPortfolio() }} />
  }

  return (
    <div className="h-full w-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="plexiprojects-view">
      <div className="max-w-5xl mx-auto px-6 py-6">
        <div className="flex items-start justify-between gap-3">
          <DashboardHeader title="Plans" subtitle="Milestones and a timeline built from the tasks you already work in" />
          <button
            onClick={() => void newProject()}
            data-testid="projects-new"
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-[rgb(var(--accent))] text-white text-[12.5px] font-medium hover:bg-[rgb(var(--accent-hover))]"
          >
            <Icon name="add" size={16} /> New plan
          </button>
        </div>

        {error && <p className="mb-3 text-rose-500 text-[12px]" data-testid="projects-error">{error}</p>}

        {projects === null ? (
          <div className="flex items-center gap-2 px-3 py-10 text-[13px] text-[var(--ink-70)]">
            <Icon name="progress_activity" size={16} className="text-[rgb(var(--accent))] animate-spin" />
            Loading plans…
          </div>
        ) : projects.length === 0 ? (
          <div className="px-3 py-16 text-center" data-testid="projects-empty">
            <PlexiiIcon kind="tool" id="projects" size={36} fallback="account_tree" fallbackClassName="text-[var(--ink-30)]" className="mx-auto block" />
            <p className="mt-3 text-[14px] text-[var(--ink-70)] max-w-md mx-auto leading-relaxed">
              No plans yet. A plan is any folder that contains tasks. Create a folder, add tasks under it, and it
              shows up here with a timeline.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4 fb-fade-in-up" data-testid="projects-portfolio-stats">
              {(() => {
                const totalTasks = projects.reduce((n, p) => n + p.taskCount, 0)
                const totalDone = projects.reduce((n, p) => n + p.doneCount, 0)
                const avg = projects.length ? Math.round(projects.reduce((n, p) => n + p.percentComplete, 0) / projects.length) : 0
                const atRisk = projects.filter((p) => p.hasDrift || p.hasCycle).length
                return (
                  <>
                    <StatTile icon="account_tree" label="Plans" value={projects.length} tone="violet" />
                    <StatTile icon="task_alt" label="Tasks done" value={`${totalDone}/${totalTasks}`} tone="emerald" />
                    <StatTile icon="donut_large" label="Avg complete" value={`${avg}%`} tone="accent" />
                    <StatTile icon="warning" label="At risk" value={atRisk} tone={atRisk ? 'amber' : 'stone'} />
                  </>
                )
              })()}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="projects-portfolio">
              {projects.map((p) => (
                <ProjectCard key={p.id} project={p} onOpen={() => setOpenId(p.id)} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function ProjectCard({ project, onOpen }: { project: ProjectSummary; onOpen: () => void }): JSX.Element {
  return (
    <button
      onClick={onOpen}
      data-testid={`project-card-${project.id}`}
      className={`${PLEXI_CARD} fb-hover-lift fb-fade-in-up p-4 text-left hover:border-[rgb(var(--accent)/0.40)] transition-colors`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[14px] font-semibold text-[var(--ink-100)] truncate">{project.title}</h3>
        <div className="flex items-center gap-1 shrink-0">
          {project.hasCycle && <StatusPill tone="rose" label="Cycle" dot={false} />}
          {project.hasDrift && <StatusPill tone="amber" label="Drift" dot={false} />}
        </div>
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between text-[11.5px] text-[var(--ink-70)]">
          <span className="fb-tabular">{project.doneCount}/{project.taskCount} done</span>
          <span className="fb-tabular">{project.percentComplete}%</span>
        </div>
        <div className="mt-1 h-1.5 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
          <div
            className="h-full rounded-full bg-[rgb(var(--accent))]"
            style={{
              width: `${project.percentComplete}%`,
              minWidth: project.percentComplete > 0 ? '0.375rem' : '0',
              transition: 'width var(--dur-slow) var(--ease-spring-glide)'
            }}
          />
        </div>
      </div>
      {project.endMs && (
        <p className="mt-2.5 text-[11.5px] text-[var(--ink-50)] fb-tabular">Finishes {fmtDate(project.endMs)}</p>
      )}
    </button>
  )
}

function ProjectGantt({ projectId, onBack }: { projectId: string; onBack: () => void }): JSX.Element {
  const [plan, setPlan] = useState<ProjectPlan | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    window.api.projects
      .plan(projectId)
      .then(setPlan)
      .catch((e) => setError(`Could not load the plan: ${e instanceof Error ? e.message : String(e)}`))
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [viewMode, setViewMode] = useState<ProjectViewMode>('overview')
  const [showCalSettings, setShowCalSettings] = useState(false)

  // Capture the current schedule as a baseline, so the timeline can show planned-
  // vs-actual variance from here on.
  async function setBaseline(): Promise<void> {
    setError(null)
    try {
      const stamp = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      await window.api.projects.captureBaseline(projectId, `Baseline ${stamp}`)
      load()
    } catch (e) {
      setError(`Could not set the baseline: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Greedy resource leveling: serialize each person's overlapping tasks.
  async function levelResources(): Promise<void> {
    setError(null)
    try {
      await window.api.projects.level(projectId)
      load()
    } catch (e) {
      setError(`Could not level resources: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Export the plan to a Microsoft Project XML file via a save dialog.
  async function exportXml(): Promise<void> {
    setError(null)
    try {
      const r = await window.api.projects.exportXml(projectId)
      if (!r.ok && !r.canceled) setError(`Export failed: ${r.error ?? 'unknown error'}`)
    } catch (e) {
      setError(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Update a task's workflow status (used by the board's drag-between-columns).
  async function setTaskStatus(taskId: string, status: string): Promise<void> {
    setError(null)
    try {
      await window.api.nodes.update(taskId, { status: status as never })
      load()
    } catch (e) {
      setError(`Could not update the task: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function reschedule(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const next = await window.api.projects.reschedule(projectId)
      setPlan(next)
    } catch (e) {
      setError(`Could not reschedule: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  // Add a task to this project (a child of the project folder), then reload so it
  // appears on the timeline.
  async function addTask(): Promise<void> {
    const title = newTitle.trim()
    if (!title) return
    setError(null)
    try {
      const node = await window.api.nodes.create({ parentId: projectId, kind: 'task', title })
      setNewTitle('')
      setAdding(false)
      load()
      setSelectedId(node.id)
    } catch (e) {
      setError(`Could not add the task: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Commit a drag of a task bar: pin its planned start to the dropped day and, if
  // a finish date was set, shift it by the same number of days to keep the length.
  async function rescheduleTask(t: PlanTask, newStartMs: number): Promise<void> {
    setError(null)
    try {
      const patch: { planStart: number; planDue?: number | null } = { planStart: newStartMs }
      if (t.planDue != null && t.planStart != null) {
        patch.planDue = t.planDue + (newStartMs - t.planStart)
      }
      await window.api.projects.setTaskPlan(t.id, patch)
      load()
    } catch (e) {
      setError(`Could not move the task: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const selected = plan?.tasks.find((t) => t.id === selectedId) ?? null

  // Width of the scrollable timeline area, measured so the axis always fills the
  // screen instead of stopping mid-way for a short plan.
  const [viewportW, setViewportW] = useState(0)

  // Timeline geometry: anchor day 0 to the later of project end and today. The
  // axis always runs a few weeks PAST the last task so you can drag a bar into
  // the future, and is never shorter than the visible area so it does not stop
  // mid-screen.
  const geom = useMemo(() => {
    if (!plan) return null
    const now = Date.now()
    const end = Math.max(plan.projectEndMs, now + 2 * DAY_MS)
    // Always keep ~3 weeks of empty runway after the last scheduled day so a task
    // can be dragged/rescheduled into the future.
    const FUTURE_RUNWAY_DAYS = 21
    const planDays = Math.ceil((end - plan.anchorMs) / DAY_MS) + FUTURE_RUNWAY_DAYS
    // Fill at least the visible width (fall back to a sensible minimum before the
    // first measure) so the grid never ends in the middle of the screen.
    const daysToFill = viewportW > 0 ? Math.ceil(viewportW / DAY_W) : 45
    const totalDays = Math.max(7, planDays, daysToFill)
    const xOf = (ms: number): number => ((ms - plan.anchorMs) / DAY_MS) * DAY_W
    const rowIndex = new Map(plan.tasks.map((t, i) => [t.id, i]))
    return { totalDays, xOf, rowIndex, now, width: totalDays * DAY_W, height: plan.tasks.length * ROW_H }
  }, [plan, viewportW])

  // Measure the scroll area so the timeline can fill the width available beside
  // the sticky task-name column (rather than stopping mid-screen).
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setViewportW(Math.max(0, el.clientWidth - NAME_W))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const critPathSet = useMemo(() => new Set(plan?.criticalPath ?? []), [plan])
  // A task is "late" if it finished after plan (in plan.drift) or is still open
  // and already past its scheduled finish. The second case is the actionable one,
  // a task slipping right now, which the finished-late drift data cannot show.
  const lateSet = useMemo(() => {
    if (!plan) return new Set<string>()
    const now = Date.now()
    const byId = new Map(plan.tasks.map((t) => [t.id, t]))
    const isDone = (id: string): boolean => {
      const t = byId.get(id)
      return !!t && (t.status === 'done' || t.completedAt != null)
    }
    // The late marker flags actionable, in-flight slippage. A completed task that
    // finished late is historical (the drift banner records it), so it does not
    // keep wearing a "running late" badge: seed only from not-done drifted tasks.
    const late = new Set(plan.drift.map((d) => d.id).filter((id) => !isDone(id)))
    for (const t of plan.tasks) {
      if (!isDone(t.id) && !t.isMilestone && t.scheduledEndMs < now) late.add(t.id)
    }
    return late
  }, [plan])

  return (
    <div className="h-full w-full flex flex-col bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="plexiprojects-view">
      <div className="px-6 pt-5 pb-3 border-b border-[var(--edge-soft)]">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            data-testid="projects-back"
            className="inline-flex items-center gap-1 text-[12.5px] text-[var(--ink-70)] hover:text-[var(--ink-100)]"
          >
            <Icon name="arrow_back" size={16} /> Plans
          </button>
          <span className="text-[var(--ink-30)]">/</span>
          <h1 className="fb-display text-[16px] font-bold tracking-tight text-[var(--ink-100)] truncate">{plan?.title ?? 'Plan'}</h1>
          <div className="ml-auto flex items-center gap-2">
            <div className="inline-flex items-center rounded-lg bg-[var(--surface-sunken)] p-0.5" role="tablist" aria-label="Plan view">
              {VIEW_MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setViewMode(m.id)}
                  data-testid={`projects-view-${m.id}`}
                  aria-selected={viewMode === m.id}
                  title={m.label}
                  className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[12px] font-medium transition-colors ${
                    viewMode === m.id ? 'bg-[rgb(var(--accent))] text-white' : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
                  }`}
                >
                  <Icon name={m.icon} size={14} /> {m.label}
                </button>
              ))}
            </div>
            {viewMode === 'gantt' && <GanttLegend />}
            {adding ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void addTask()
                    if (e.key === 'Escape') {
                      setAdding(false)
                      setNewTitle('')
                    }
                  }}
                  placeholder="New task title…"
                  data-testid="projects-new-task-input"
                  className="fb-field h-8 w-48 px-2.5 text-[12.5px] text-[var(--ink-100)]"
                />
                <button
                  onClick={() => void addTask()}
                  disabled={!newTitle.trim()}
                  data-testid="projects-new-task-confirm"
                  className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg bg-[rgb(var(--accent))] text-white text-[12.5px] font-medium hover:bg-[rgb(var(--accent-hover))] disabled:opacity-40"
                >
                  Add
                </button>
                <button
                  onClick={() => { setAdding(false); setNewTitle('') }}
                  className="p-1 rounded text-[var(--ink-50)] hover:text-[var(--ink-100)]"
                >
                  <Icon name="close" size={15} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setAdding(true)}
                data-testid="projects-add-task"
                className="fb-btn-surface inline-flex items-center gap-1.5 h-8 px-3 text-[12.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
              >
                <Icon name="add" size={15} /> Add task
              </button>
            )}
            <button
              onClick={() => void setBaseline()}
              data-testid="projects-set-baseline"
              className="fb-btn-surface inline-flex items-center gap-1.5 h-8 px-3 text-[12.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
              title={plan?.hasBaseline ? 'Re-capture the baseline at the current plan' : 'Capture the current plan as a baseline to track variance against'}
            >
              <Icon name="flag_circle" size={15} /> {plan?.hasBaseline ? 'Baseline set' : 'Set baseline'}
            </button>
            <div className="relative">
              <button
                onClick={() => setShowCalSettings((v) => !v)}
                data-testid="projects-calendar-settings"
                aria-label="Working calendar"
                title="Working calendar"
                className="fb-btn-surface inline-flex h-8 w-8 items-center justify-center text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
              >
                <Icon name="event_available" size={15} />
              </button>
              {showCalSettings && (
                <CalendarSettings projectId={projectId} onClose={() => setShowCalSettings(false)} onChanged={load} />
              )}
            </div>
            <button
              onClick={() => void levelResources()}
              data-testid="projects-level"
              title="Level resources: push each person's overlapping tasks so they never run at once"
              className="fb-btn-surface inline-flex items-center gap-1.5 h-8 px-3 text-[12.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
            >
              <Icon name="balance" size={15} /> Level
            </button>
            <button
              onClick={() => void exportXml()}
              data-testid="projects-export-xml"
              title="Export to Microsoft Project (XML)"
              className="fb-btn-surface inline-flex items-center gap-1.5 h-8 px-3 text-[12.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
            >
              <Icon name="ios_share" size={15} /> Export
            </button>
            <button
              onClick={() => void reschedule()}
              disabled={busy}
              data-testid="projects-reschedule"
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[rgb(var(--accent))] text-white text-[12.5px] font-medium hover:bg-[rgb(var(--accent-hover))] disabled:opacity-40"
              title="Shift the plan to account for what has actually finished"
            >
              <Icon name="update" size={15} /> {busy ? 'Rescheduling…' : 'Reschedule'}
            </button>
          </div>
        </div>
        {plan && plan.drift.some((d) => d.pushesSuccessors) && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-amber-600 dark:text-amber-400">
            <Icon name="warning" size={14} />
            {plan.drift.filter((d) => d.pushesSuccessors).length} task(s) slipped past plan and push later work. Reschedule to shift the timeline.
          </div>
        )}
        {plan?.hasCycle && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-rose-600 dark:text-rose-400">
            <Icon name="error" size={14} />
            This plan has a circular dependency. Remove a link to restore a valid schedule.
          </div>
        )}
        {error && <p className="mt-2 text-rose-500 text-[12px]" data-testid="gantt-error">{error}</p>}
      </div>

      <div className="flex-1 min-h-0 flex">
        <div ref={scrollRef} className="flex-1 min-w-0 overflow-auto">
          {!plan ? (
            <div className="flex items-center gap-2 px-6 py-10 text-[13px] text-[var(--ink-70)]">
              <Icon name="progress_activity" size={16} className="text-[rgb(var(--accent))] animate-spin" /> Loading plan…
            </div>
          ) : viewMode === 'overview' ? (
            <OverviewView plan={plan} critPathSet={critPathSet} lateSet={lateSet} />
          ) : viewMode === 'files' ? (
            <PlanFilesView projectId={projectId} />
          ) : plan.tasks.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <Icon name="account_tree" size={28} className="text-[var(--ink-30)]" />
              <p className="mt-2 text-[13px] text-[var(--ink-70)]">This plan has no tasks yet. Add tasks to the folder to build a timeline.</p>
            </div>
          ) : viewMode === 'board' ? (
            <BoardView plan={plan} selectedId={selectedId} onSelect={setSelectedId} onSetStatus={(id, s) => void setTaskStatus(id, s)} />
          ) : viewMode === 'grid' ? (
            <GridView plan={plan} selectedId={selectedId} onSelect={setSelectedId} critPathSet={critPathSet} lateSet={lateSet} />
          ) : viewMode === 'calendar' ? (
            <CalendarView plan={plan} selectedId={selectedId} onSelect={setSelectedId} critPathSet={critPathSet} lateSet={lateSet} />
          ) : viewMode === 'workload' ? (
            <WorkloadView plan={plan} selectedId={selectedId} onSelect={setSelectedId} />
          ) : geom ? (
            <div className="flex fb-fade-in-up">
              {/* Sticky task-name column */}
              <div className="shrink-0 sticky left-0 z-10 bg-[var(--surface-raised)] border-r border-[var(--edge-firm)]" style={{ width: NAME_W }}>
                <div className="border-b border-[var(--edge-firm)]" style={{ height: HEADER_H }} />
                {plan.tasks.map((t) => (
                  <button
                    key={t.id}
                    data-testid={`gantt-row-${t.id}`}
                    onClick={() => setSelectedId(t.id)}
                    className={`w-full text-left px-3 flex items-center gap-2 border-b border-[var(--edge-soft)] transition-colors ${
                      t.id === selectedId
                        ? 'bg-[rgb(var(--accent)/0.10)] border-l-2 border-l-[rgb(var(--accent))]'
                        : 'hover:bg-[rgb(var(--accent)/0.05)] border-l-2 border-l-transparent'
                    }`}
                    style={{ height: ROW_H }}
                  >
                    {t.isMilestone && <Icon name="flag" size={12} className="text-violet-500 shrink-0" filled />}
                    <span className="text-[13px] text-[var(--ink-100)] truncate flex-1 min-w-0">{t.title || 'Untitled'}</span>
                    {(t.status === 'done' || t.completedAt) && (
                      <Icon name="check_circle" size={13} className="text-emerald-500 shrink-0" filled />
                    )}
                  </button>
                ))}
              </div>

              {/* Timeline */}
              <div className="relative shrink-0" style={{ width: geom.width }}>
                <DateAxis anchorMs={plan.anchorMs} totalDays={geom.totalDays} />
                <div className="relative" style={{ height: geom.height }}>
                  <GridLines totalDays={geom.totalDays} rows={plan.tasks.length} />
                  <DependencyArrows plan={plan} geom={geom} critPathSet={critPathSet} />
                  <TodayLine x={geom.xOf(geom.now)} height={geom.height} />
                  {/* Baseline ghost bars: the captured plan window, under each task. */}
                  {plan.hasBaseline &&
                    plan.tasks.map((t, i) =>
                      t.baselineStartMs != null && t.baselineEndMs != null ? (
                        <div
                          key={`bl-${t.id}`}
                          className="absolute rounded-[2px] border border-dashed border-[var(--ink-40)] opacity-60 pointer-events-none"
                          style={{
                            left: geom.xOf(t.baselineStartMs),
                            top: i * ROW_H + ROW_H - 5,
                            width: Math.max(4, ((t.baselineEndMs - t.baselineStartMs) / DAY_MS) * DAY_W),
                            height: 3
                          }}
                          data-testid={`gantt-baseline-${t.id}`}
                          title={`Baseline ${fmtDate(t.baselineStartMs)} to ${fmtDate(t.baselineEndMs)}`}
                        />
                      ) : null
                    )}
                  {plan.tasks.map((t, i) => (
                    <TaskBar
                      key={t.id}
                      task={t}
                      x={geom.xOf(t.scheduledStartMs)}
                      y={i * ROW_H}
                      critical={critPathSet.has(t.id) || t.critical}
                      late={lateSet.has(t.id)}
                      anchorMs={plan.anchorMs}
                      onClick={() => setSelectedId(t.id)}
                      onReschedule={(startMs) => void rescheduleTask(t, startMs)}
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {selected && plan && (
          <TaskEditor
            task={selected}
            allTasks={plan.tasks}
            deps={plan.deps}
            onClose={() => setSelectedId(null)}
            onChanged={load}
          />
        )}
      </div>
    </div>
  )
}

function GanttLegend(): JSX.Element {
  const item = (cls: string, label: string): JSX.Element => (
    <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--ink-50)]">
      <span className={`h-2 w-3 rounded-[2px] ${cls}`} /> {label}
    </span>
  )
  return (
    <div className="hidden md:flex items-center gap-2.5 mr-1">
      {item('bg-[rgb(var(--accent)/0.20)] ring-1 ring-[rgb(var(--accent)/0.40)]', 'Task')}
      {item('bg-rose-500/35 ring-1 ring-rose-500', 'Critical')}
      {item('bg-emerald-500/20 ring-1 ring-emerald-500/40', 'Done')}
    </div>
  )
}

function DateAxis({ anchorMs, totalDays }: { anchorMs: number; totalDays: number }): JSX.Element {
  const ticks: JSX.Element[] = []
  for (let d = 0; d < totalDays; d += 7) {
    ticks.push(
      <div
        key={d}
        className="absolute top-0 flex items-center text-[11px] font-medium text-[var(--ink-70)] fb-tabular pl-1"
        style={{ left: d * DAY_W, height: HEADER_H }}
      >
        {fmtDate(anchorMs + d * DAY_MS)}
      </div>
    )
  }
  return (
    <div className="relative bg-[var(--surface-raised)] border-b border-[var(--edge-firm)]" style={{ height: HEADER_H }}>
      {ticks}
    </div>
  )
}

function GridLines({ totalDays, rows }: { totalDays: number; rows: number }): JSX.Element {
  const lines: JSX.Element[] = []
  for (let d = 0; d <= totalDays; d += 7) {
    lines.push(
      <div
        key={`v${d}`}
        className="absolute top-0 bottom-0 border-l border-[var(--edge-soft)]"
        style={{ left: d * DAY_W }}
      />
    )
  }
  for (let r = 0; r < rows; r++) {
    lines.push(
      <div
        key={`h${r}`}
        className="absolute left-0 right-0 border-b border-[var(--edge-soft)]"
        style={{ top: r * ROW_H + ROW_H }}
      />
    )
  }
  return <>{lines}</>
}

function TodayLine({ x, height }: { x: number; height: number }): JSX.Element | null {
  if (x < 0) return null
  return (
    <div className="absolute top-0 pointer-events-none" style={{ left: x, height }}>
      <div className="h-full w-px bg-sky-400 opacity-80" />
      <div className="absolute -top-0.5 -left-1 h-2 w-2 rounded-full bg-sky-400" />
    </div>
  )
}

function TaskBar({
  task,
  x,
  y,
  critical,
  late,
  anchorMs,
  onClick,
  onReschedule
}: {
  task: PlanTask
  x: number
  y: number
  critical: boolean
  late: boolean
  anchorMs: number
  onClick: () => void
  onReschedule: (newStartMs: number) => void
}): JSX.Element {
  const done = task.status === 'done' || task.completedAt != null
  const w = Math.max(task.durationDays * DAY_W, 8)
  const top = y + (ROW_H - 16) / 2

  // Drag a bar horizontally to change its start date. We track a live pixel
  // offset while dragging (so the bar follows the cursor), then on release snap
  // to the nearest day and commit. A drag below the threshold is treated as a
  // click (open the editor) so selecting still works.
  const [dx, setDx] = useState(0)
  const drag = useRef<{ startX: number; moved: boolean } | null>(null)

  const onPointerDown = (e: React.PointerEvent): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag.current) return
    const delta = e.clientX - drag.current.startX
    if (Math.abs(delta) > 3) drag.current.moved = true
    setDx(delta)
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const d = drag.current
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (!d) return
    if (!d.moved) {
      setDx(0)
      onClick()
      return
    }
    const days = Math.max(0, Math.round((x + dx) / DAY_W))
    setDx(0)
    onReschedule(anchorMs + days * DAY_MS)
  }
  const dragProps = { onPointerDown, onPointerMove, onPointerUp }

  if (task.isMilestone) {
    return (
      <div
        data-testid={`gantt-bar-${task.id}`}
        role="button"
        tabIndex={0}
        aria-label={`${task.title || 'Untitled'}, ${fmtDate(task.scheduledStartMs)}`}
        {...dragProps}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            if (e.key === ' ') e.preventDefault()
            onClick()
          }
        }}
        className="absolute cursor-grab active:cursor-grabbing select-none touch-none"
        style={{ left: x - 7 + dx, top: y + (ROW_H - 12) / 2 }}
        title={`${task.title}, ${fmtDate(task.scheduledStartMs)} (drag to reschedule)`}
      >
        <div className="h-3 w-3 rotate-45 bg-violet-500 ring-2 ring-[var(--surface-raised)]" />
      </div>
    )
  }

  // Completed wins, then critical, then a normal accent bar.
  const cls = done
    ? 'bg-emerald-500/20 ring-1 ring-emerald-500/40'
    : critical
      ? 'bg-rose-500/35 dark:bg-rose-500/30 ring-1 ring-rose-500'
      : 'bg-[rgb(var(--accent)/0.20)] ring-1 ring-[rgb(var(--accent)/0.40)]'

  return (
    <div
      data-testid={`gantt-bar-${task.id}`}
      role="button"
      tabIndex={0}
      aria-label={`${task.title || 'Untitled'}, ${fmtDate(task.scheduledStartMs)} to ${fmtDate(task.scheduledEndMs)}`}
      {...dragProps}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if (e.key === ' ') e.preventDefault()
          onClick()
        }
      }}
      className={`absolute rounded-[4px] cursor-grab active:cursor-grabbing select-none touch-none transition-colors flex items-center px-1.5 overflow-hidden ${cls} ${critical && !done ? 'gantt-crit-glow' : ''}`}
      style={{ left: x + dx, top, width: w, height: 16 }}
      title={`${task.title}, ${fmtDate(task.scheduledStartMs)} to ${fmtDate(task.scheduledEndMs)}${task.slackDays > 0 ? `, ${task.slackDays}d slack` : ', critical'}${late ? (done ? ', finished late' : ', running late') : ''}${!done ? `, ${task.progressPct}% done` : ''} (drag to reschedule)`}
    >
      {!done && task.progressPct > 0 && (
        <span
          className="absolute inset-y-0 left-0 bg-[rgb(var(--accent)/0.45)]"
          style={{ width: `${Math.min(100, task.progressPct)}%`, transition: 'width var(--dur-slow) var(--ease-spring-glide)' }}
          data-testid={`gantt-progress-${task.id}`}
        />
      )}
      {w > 44 && (
        <span className="relative text-[10px] truncate text-[var(--ink-90)] flex-1 min-w-0">{task.title}</span>
      )}
      {task.deadlineMiss && (
        <span className="shrink-0 ml-auto inline-flex" data-testid={`gantt-deadline-miss-${task.id}`} title="Misses its deadline">
          <Icon name="event_busy" size={11} className="text-rose-500" filled />
        </span>
      )}
      {late && (
        <span className={`shrink-0 inline-flex ${task.deadlineMiss ? 'ml-0.5' : 'ml-auto'}`} data-testid={`gantt-late-${task.id}`}>
          <Icon name="warning" size={11} className="text-amber-500" filled />
        </span>
      )}
    </div>
  )
}

function DependencyArrows({
  plan,
  geom,
  critPathSet
}: {
  plan: ProjectPlan
  geom: { xOf: (ms: number) => number; rowIndex: Map<string, number>; width: number; height: number }
  critPathSet: Set<string>
}): JSX.Element {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  const paths: JSX.Element[] = []
  for (const dep of plan.deps) {
    const pred = byId.get(dep.predId)
    const succ = byId.get(dep.succId)
    const pi = geom.rowIndex.get(dep.predId)
    const si = geom.rowIndex.get(dep.succId)
    if (!pred || !succ || pi === undefined || si === undefined) continue
    const x1 = geom.xOf(pred.scheduledEndMs)
    const y1 = pi * ROW_H + ROW_H / 2
    const x2 = geom.xOf(succ.scheduledStartMs)
    const y2 = si * ROW_H + ROW_H / 2
    const dx = Math.max(12, Math.abs(x2 - x1) / 2)
    const onCrit = critPathSet.has(dep.predId) && critPathSet.has(dep.succId)
    const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
    paths.push(
      <path
        key={dep.id}
        d={d}
        fill="none"
        stroke={onCrit ? 'rgb(var(--accent))' : 'var(--edge-firm)'}
        strokeWidth={onCrit ? 1.5 : 1}
        strokeOpacity={onCrit ? 0.7 : 0.5}
        markerEnd="url(#gantt-arrow)"
      />
    )
    // A flowing "current" of light along each critical-path edge.
    if (onCrit) {
      paths.push(
        <path
          key={`${dep.id}-flow`}
          d={d}
          fill="none"
          stroke="rgb(var(--accent))"
          strokeWidth={1.5}
          strokeOpacity={0.6}
          strokeDasharray="6 8"
          style={{ animation: 'gantt-flow 1.2s linear infinite', willChange: 'stroke-dashoffset' }}
        />
      )
    }
  }
  return (
    <svg className="absolute top-0 left-0 pointer-events-none" width={geom.width} height={geom.height}>
      <defs>
        <marker id="gantt-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="var(--edge-firm)" />
        </marker>
      </defs>
      {paths}
    </svg>
  )
}

function TaskEditor({
  task,
  allTasks,
  deps,
  onClose,
  onChanged
}: {
  task: PlanTask
  allTasks: PlanTask[]
  deps: PlanDep[]
  onClose: () => void
  onChanged: () => void
}): JSX.Element {
  const goTask = useViewStore((s) => s.goTask)
  const [depPick, setDepPick] = useState('')
  const [succPick, setSuccPick] = useState('')
  const [depError, setDepError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState(task.title)
  const [assignee, setAssignee] = useState(task.assignee ?? '')
  const [depType, setDepType] = useState<DepType>('FS')
  const [depLag, setDepLag] = useState(0)

  // Keep the editable fields in sync when a different task is selected.
  useEffect(() => setTitle(task.title), [task.id, task.title])
  useEffect(() => setAssignee(task.assignee ?? ''), [task.id, task.assignee])

  async function saveAssignee(): Promise<void> {
    if ((assignee ?? '') === (task.assignee ?? '')) return
    void patch({ assignee: assignee.trim() || null })
  }

  async function saveTitle(): Promise<void> {
    const next = title.trim()
    if (!next || next === task.title) return
    setError(null)
    try {
      await window.api.nodes.update(task.id, { title: next })
      onChanged()
    } catch (e) {
      setError(`Could not rename the task: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function removeTask(): Promise<void> {
    setError(null)
    try {
      // Go through the node store so the delete records a visible "Undo" toast,
      // the same forgiveness the sidebar tree gives.
      await useNodeStore.getState().remove(task.id)
      onClose()
      onChanged()
    } catch (e) {
      setError(`Could not delete the task: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function patch(p: Parameters<typeof window.api.projects.setTaskPlan>[1]): Promise<void> {
    setError(null)
    try {
      await window.api.projects.setTaskPlan(task.id, p)
      onChanged()
    } catch (e) {
      setError(`Could not save the change: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function addDep(predId: string): Promise<void> {
    setDepError(null)
    try {
      const r = await window.api.projects.addDep(predId, task.id, depType, depLag)
      if (!r.ok) {
        setDepError(
          r.reason === 'cycle'
            ? 'That would create a circular dependency.'
            : r.reason === 'duplicate'
              ? 'That dependency already exists.'
              : 'Could not add that dependency.'
        )
        return
      }
      setDepPick('')
      onChanged()
    } catch (e) {
      setDepError(`Could not add that dependency: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function removeDep(predId: string): Promise<void> {
    setError(null)
    try {
      await window.api.projects.removeDep(predId, task.id)
      onChanged()
    } catch (e) {
      setError(`Could not remove that dependency: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const depFor = (predId: string): PlanDep | undefined => deps.find((x) => x.predId === predId && x.succId === task.id)
  async function changeDep(predId: string, type: DepType, lag: number): Promise<void> {
    setError(null)
    try {
      await window.api.projects.setDep(predId, task.id, type, lag)
      onChanged()
    } catch (e) {
      setError(`Could not update that link: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Successors are the mirror of dependencies: a task that depends on this one.
  // Adding one makes this task its predecessor.
  async function addSucc(succId: string): Promise<void> {
    setDepError(null)
    try {
      const r = await window.api.projects.addDep(task.id, succId)
      if (!r.ok) {
        setDepError(
          r.reason === 'cycle'
            ? 'That would create a circular dependency.'
            : r.reason === 'duplicate'
              ? 'That link already exists.'
              : 'Could not add that successor.'
        )
        return
      }
      setSuccPick('')
      onChanged()
    } catch (e) {
      setDepError(`Could not add that successor: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function removeSucc(succId: string): Promise<void> {
    setError(null)
    try {
      await window.api.projects.removeDep(task.id, succId)
      onChanged()
    } catch (e) {
      setError(`Could not remove that successor: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Assignee suggestions: teammates currently online (the People presence layer)
  // plus anyone already assigned in this project. Free text is still allowed.
  const presencePeers = usePresenceStore((s) => s.peers)
  const assigneeSuggestions = useMemo(() => {
    const set = new Set<string>()
    for (const p of Object.values(presencePeers)) if (p.handle) set.add(p.handle)
    for (const t of allTasks) if (t.assignee) set.add(t.assignee)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [presencePeers, allTasks])

  const candidates = allTasks.filter((t) => t.id !== task.id && !task.deps.includes(t.id))
  const successors = allTasks.filter((t) => t.deps.includes(task.id))
  const succCandidates = allTasks.filter((t) => t.id !== task.id && !t.deps.includes(task.id))
  const titleOf = (id: string): string => allTasks.find((t) => t.id === id)?.title || 'Task'

  return (
    <div className="w-[300px] shrink-0 border-l border-[var(--edge-soft)] bg-[var(--surface-raised)] overflow-auto" data-testid="task-editor">
      <div className="px-4 py-3 border-b border-[var(--edge-soft)]">
        <div className="flex items-center gap-1.5">
          <input
            value={title}
            data-testid="task-title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void saveTitle()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            placeholder="Task title"
            className="flex-1 min-w-0 rounded-md bg-transparent border border-transparent hover:border-[var(--edge-soft)] focus:border-[rgb(var(--accent)/0.55)] px-1.5 py-1 text-[13px] font-semibold text-[var(--ink-100)] focus:bg-[var(--surface-base)]"
          />
          <button onClick={onClose} className="shrink-0 p-1 rounded text-[var(--ink-50)] hover:text-[var(--ink-100)]" title="Close">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => goTask(task.id)}
            data-testid="task-open"
            className="inline-flex items-center gap-1 text-[11.5px] text-[var(--ink-70)] hover:text-[rgb(var(--accent))]"
            title="Open this task, its notes and attachments"
          >
            <Icon name="open_in_new" size={13} /> Open task &amp; files
          </button>
          <button
            onClick={() => void removeTask()}
            data-testid="task-delete"
            className="inline-flex items-center gap-1 text-[11.5px] text-[var(--ink-70)] hover:text-rose-500 ml-auto"
            title="Move this task to trash"
          >
            <Icon name="delete" size={13} /> Delete
          </button>
        </div>
      </div>

      <div className="px-4 py-3 space-y-3">
        <label className="block">
          <span className="text-[11px] text-[var(--ink-70)]">Planned start</span>
          <input
            type="date"
            value={toDateInput(task.planStart)}
            data-testid="task-plan-start"
            onChange={(e) => void patch({ planStart: fromDateInput(e.target.value) })}
            className="fb-field mt-1 w-full px-2 py-1.5 text-[12px] text-[var(--ink-100)]"
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-[var(--ink-70)]">Planned finish</span>
          <input
            type="date"
            value={toDateInput(task.planDue)}
            data-testid="task-plan-due"
            onChange={(e) => void patch({ planDue: fromDateInput(e.target.value) })}
            className="fb-field mt-1 w-full px-2 py-1.5 text-[12px] text-[var(--ink-100)]"
          />
        </label>

        {!task.isMilestone && (
          <label className="block">
            <span className="text-[11px] text-[var(--ink-70)]">Length in working days (used when no finish date)</span>
            <input
              type="number"
              min={1}
              value={task.estimateMinutes ? Math.max(1, Math.round(task.estimateMinutes / (60 * 8))) : ''}
              placeholder="e.g. 3"
              data-testid="task-estimate-days"
              onChange={(e) => {
                const raw = e.target.value
                if (raw.trim() === '') {
                  void patch({ estimateMinutes: null })
                  return
                }
                const days = Math.min(3650, Math.round(Number(raw)))
                if (Number.isInteger(days) && days > 0) {
                  void patch({ estimateMinutes: days * 8 * 60 })
                }
              }}
              className="fb-field mt-1 w-full px-2 py-1.5 text-[12px] text-[var(--ink-100)]"
            />
          </label>
        )}

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={task.isMilestone}
            data-testid="task-milestone"
            onChange={(e) => void patch({ isMilestone: e.target.checked })}
            className="accent-[rgb(var(--accent))]"
          />
          <span className="text-[12px] text-[var(--ink-90)]">Milestone (zero-duration marker)</span>
        </label>

        <label className="block">
          <span className="text-[11px] text-[var(--ink-70)]">Assigned to</span>
          <input
            value={assignee}
            data-testid="task-assignee"
            list="plexi-assignee-suggestions"
            onChange={(e) => setAssignee(e.target.value)}
            onBlur={() => void saveAssignee()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void saveAssignee()
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            placeholder="Pick a teammate or type a name"
            className="fb-field mt-1 w-full px-2 py-1.5 text-[12px] text-[var(--ink-100)]"
          />
          <datalist id="plexi-assignee-suggestions">
            {assigneeSuggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>

        {!task.isMilestone && (
          <label className="block">
            <span className="flex items-center justify-between text-[11px] text-[var(--ink-70)]">
              <span>Progress</span>
              <span className="fb-tabular text-[var(--ink-90)]">{task.progressPct}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={task.progressPct}
              data-testid="task-progress"
              onChange={(e) => {
                const v = Number(e.target.value)
                // Celebrate crossing the finish line: 100% from below.
                if (v === 100 && task.progressPct < 100) {
                  const r = (e.target as HTMLInputElement).getBoundingClientRect()
                  spawnSparkBurst(r.right - 8, r.top + r.height / 2, 'rgb(16 185 129)')
                }
                void patch({ progressPct: v })
              }}
              className="mt-1.5 w-full accent-[rgb(var(--accent))]"
            />
          </label>
        )}

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] text-[var(--ink-70)]">Must start on</span>
            <input
              type="date"
              value={toDateInput(task.mustStartMs)}
              data-testid="task-must-start"
              onChange={(e) => void patch({ mustStartMs: fromDateInput(e.target.value) })}
              title="Pin the start to this date, overriding dependencies"
              className="fb-field mt-1 w-full px-2 py-1.5 text-[12px] text-[var(--ink-100)]"
            />
          </label>
          <label className="block">
            <span className="text-[11px] text-[var(--ink-70)]">Deadline (finish by)</span>
            <input
              type="date"
              value={toDateInput(task.deadlineMs)}
              data-testid="task-deadline"
              onChange={(e) => void patch({ deadlineMs: fromDateInput(e.target.value) })}
              title="Flag the task if the schedule finishes past this date"
              className={`mt-1 w-full rounded-md bg-[var(--surface-base)] border px-2 py-1.5 text-[12px] text-[var(--ink-100)] ${
                task.deadlineMiss ? 'border-rose-500/60' : 'border-[var(--edge-soft)] focus:border-[rgb(var(--accent)/0.55)]'
              }`}
            />
          </label>
        </div>
        {task.deadlineMiss && (
          <p className="-mt-1 flex items-center gap-1 text-[11px] text-rose-500" data-testid="task-deadline-miss">
            <Icon name="event_busy" size={12} /> Scheduled to finish past the deadline.
          </p>
        )}

        {!task.isMilestone && (
          <label className="block">
            <span className="text-[11px] text-[var(--ink-70)]">Cost (for budget rollup)</span>
            <input
              type="number"
              min={0}
              step="any"
              value={task.cost ?? ''}
              placeholder="e.g. 4000"
              data-testid="task-cost"
              onChange={(e) => {
                const raw = e.target.value.trim()
                void patch({ cost: raw === '' ? null : Number(raw) })
              }}
              className="fb-field mt-1 w-full px-2 py-1.5 text-[12px] text-[var(--ink-100)]"
            />
          </label>
        )}

        <div>
          <span className="text-[11px] text-[var(--ink-70)]">Depends on (finish first)</span>
          <div className="mt-1.5 space-y-1">
            {task.deps.length === 0 && <p className="text-[11.5px] text-[var(--ink-50)]">No dependencies.</p>}
            {task.deps.map((d) => {
              const dep = depFor(d)
              return (
                <div key={d} className="flex items-center gap-1.5 text-[12px] text-[var(--ink-90)] bg-[var(--surface-sunken)] rounded px-2 py-1">
                  <Icon name="arrow_forward" size={12} className="text-[var(--ink-50)]" />
                  <span className="truncate flex-1 min-w-0">{titleOf(d)}</span>
                  <select
                    value={dep?.type ?? 'FS'}
                    data-testid={`dep-type-${d}`}
                    onChange={(e) => void changeDep(d, e.target.value as DepType, dep?.lag ?? 0)}
                    className="fb-field shrink-0 text-[10.5px] px-1 py-0.5"
                    title="Link type"
                  >
                    <option value="FS">FS</option>
                    <option value="SS">SS</option>
                    <option value="FF">FF</option>
                    <option value="SF">SF</option>
                  </select>
                  <input
                    type="number"
                    value={dep?.lag ?? 0}
                    data-testid={`dep-lag-${d}`}
                    onChange={(e) => void changeDep(d, dep?.type ?? 'FS', Math.trunc(Number(e.target.value) || 0))}
                    title="Lag in working days"
                    className="fb-field shrink-0 w-10 text-[10.5px] px-1 py-0.5 fb-tabular"
                  />
                  <button onClick={() => void removeDep(d)} className="shrink-0 text-[var(--ink-50)] hover:text-rose-500">
                    <Icon name="close" size={12} />
                  </button>
                </div>
              )
            })}
          </div>
          {candidates.length > 0 && (
            <div className="mt-1.5 flex items-center gap-1.5">
              <select
                value={depPick}
                data-testid="task-add-dep"
                onChange={(e) => {
                  setDepPick(e.target.value)
                  if (e.target.value) void addDep(e.target.value)
                }}
                className="fb-field flex-1 px-2 py-1.5 text-[12px] text-[var(--ink-100)]"
              >
                <option value="">Add a predecessor…</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title || 'Untitled'}
                  </option>
                ))}
              </select>
              <select
                value={depType}
                data-testid="task-new-dep-type"
                onChange={(e) => setDepType(e.target.value as DepType)}
                title="Type for the next link you add"
                className="fb-field shrink-0 text-[11px] px-1.5 py-1.5"
              >
                <option value="FS">FS</option>
                <option value="SS">SS</option>
                <option value="FF">FF</option>
                <option value="SF">SF</option>
              </select>
              <input
                type="number"
                value={depLag}
                data-testid="task-new-dep-lag"
                onChange={(e) => setDepLag(Math.trunc(Number(e.target.value) || 0))}
                title="Lag in working days for the next link"
                className="fb-field shrink-0 w-11 text-[11px] px-1.5 py-1.5 fb-tabular"
              />
            </div>
          )}
          {depError && <p className="mt-1 text-[11px] text-rose-500">{depError}</p>}
        </div>

        <div>
          <span className="text-[11px] text-[var(--ink-70)]">Blocks (must finish before)</span>
          <div className="mt-1.5 space-y-1">
            {successors.length === 0 && <p className="text-[11.5px] text-[var(--ink-50)]">Nothing waits on this.</p>}
            {successors.map((s) => (
              <div key={s.id} className="flex items-center gap-1.5 text-[12px] text-[var(--ink-90)] bg-[var(--surface-sunken)] rounded px-2 py-1">
                <Icon name="arrow_back" size={12} className="text-[var(--ink-50)]" />
                <span className="truncate flex-1 min-w-0">{s.title || 'Untitled'}</span>
                <button onClick={() => void removeSucc(s.id)} className="text-[var(--ink-50)] hover:text-rose-500">
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
          </div>
          {succCandidates.length > 0 && (
            <select
              value={succPick}
              data-testid="task-add-succ"
              onChange={(e) => {
                setSuccPick(e.target.value)
                if (e.target.value) void addSucc(e.target.value)
              }}
              className="fb-field mt-1.5 w-full px-2 py-1.5 text-[12px] text-[var(--ink-100)]"
            >
              <option value="">Add a successor…</option>
              {succCandidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title || 'Untitled'}
                </option>
              ))}
            </select>
          )}
        </div>

        {error && <p className="text-rose-500 text-[12px]" data-testid="task-editor-error">{error}</p>}

        <div className="pt-1 text-[11px] text-[var(--ink-50)] space-y-0.5">
          <p className="fb-tabular">Scheduled {fmtDate(task.scheduledStartMs)} to {fmtDate(task.scheduledEndMs)}</p>
          <p className="fb-tabular">{task.critical ? 'On the critical path' : `${task.slackDays} day(s) of slack`}</p>
          {task.baselineEndMs != null &&
            (() => {
              const variance = Math.round((task.scheduledEndMs - task.baselineEndMs) / DAY_MS)
              return (
                <p className={`fb-tabular ${variance > 0 ? 'text-rose-500' : variance < 0 ? 'text-emerald-500' : ''}`} data-testid="task-variance">
                  {variance === 0
                    ? 'On baseline'
                    : variance > 0
                      ? `${variance} day(s) behind baseline`
                      : `${Math.abs(variance)} day(s) ahead of baseline`}
                </p>
              )
            })()}
        </div>
      </div>
    </div>
  )
}

// ── Board view ───────────────────────────────────────────────────────────────
// A Kanban board of the project's tasks grouped by workflow status. Cards are
// draggable between columns to change status; the schedule (dates, critical path)
// is unaffected, this is the "what's in flight" lens. Real data only.
function BoardView({
  plan,
  selectedId,
  onSelect,
  onSetStatus
}: {
  plan: ProjectPlan
  selectedId: string | null
  onSelect: (id: string) => void
  onSetStatus: (id: string, status: string) => void
}): JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const byCol = new Map<string, PlanTask[]>()
  for (const c of STATUS_COLUMNS) byCol.set(c.id, [])
  for (const t of plan.tasks) byCol.get(statusOf(t))!.push(t)

  return (
    <div className="flex gap-3 p-4 h-full overflow-x-auto fb-fade-in-up" data-testid="projects-board">
      {STATUS_COLUMNS.map((col) => {
        const tasks = byCol.get(col.id) ?? []
        return (
          <div
            key={col.id}
            data-testid={`board-column-${col.id}`}
            onDragOver={(e) => {
              e.preventDefault()
              setOverCol(col.id)
            }}
            onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
            onDrop={(e) => {
              e.preventDefault()
              const id = dragId || e.dataTransfer.getData('text/plain')
              if (id) {
                const wasDone = statusOf(plan.tasks.find((t) => t.id === id) ?? ({ status: '' } as PlanTask)) === 'done'
                onSetStatus(id, col.id)
                // Celebrate a genuine completion: dropping into Done from elsewhere.
                if (col.id === 'done' && !wasDone) spawnSparkBurst(e.clientX, e.clientY, 'rgb(16 185 129)')
              }
              setDragId(null)
              setOverCol(null)
            }}
            className={`w-[260px] shrink-0 flex flex-col rounded-xl border transition-colors ${
              overCol === col.id ? 'border-[rgb(var(--accent)/0.55)] bg-[rgb(var(--accent)/0.06)] gantt-crit-glow' : 'border-[var(--edge-soft)] bg-[var(--surface-raised)]'
            }`}
          >
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--edge-soft)]">
              <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[var(--ink-90)]">
                <StatusPill tone={col.tone as never} label={col.label} />
              </span>
              <span className="text-[11px] text-[var(--ink-50)] fb-tabular">{tasks.length}</span>
            </div>
            <div className="flex-1 overflow-auto p-2 space-y-2 min-h-[60px]">
              {tasks.length === 0 ? (
                <p className="px-1 py-3 text-[11.5px] text-[var(--ink-40)] text-center">Drop tasks here</p>
              ) : (
                tasks.map((t) => (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={(e) => {
                      setDragId(t.id)
                      e.dataTransfer.setData('text/plain', t.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => onSelect(t.id)}
                    data-testid={`board-card-${t.id}`}
                    className={`fb-hover-lift rounded-lg border bg-[var(--surface-base)] px-2.5 py-2 cursor-grab active:cursor-grabbing transition-[transform,box-shadow,border-color,opacity] ${
                      dragId === t.id ? 'opacity-50 scale-[0.98]' : ''
                    } ${
                      t.id === selectedId ? 'border-[rgb(var(--accent)/0.55)]' : 'border-[var(--edge-soft)] hover:border-[rgb(var(--accent)/0.35)]'
                    }`}
                  >
                    <div className="flex items-start gap-1.5">
                      {t.isMilestone && <Icon name="flag" size={12} className="text-violet-500 mt-0.5 shrink-0" filled />}
                      {(t.critical || plan.criticalPath.includes(t.id)) && !t.isMilestone && (
                        <span className="mt-1 h-1.5 w-1.5 rounded-full bg-rose-500 shrink-0" title="On the critical path" />
                      )}
                      <span className="text-[12.5px] text-[var(--ink-100)] leading-snug flex-1">{t.title || 'Untitled'}</span>
                    </div>
                    {!t.isMilestone && (
                      <div className="mt-2 h-1.5 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
                        <div className="h-full rounded-full bg-[rgb(var(--accent))]" style={{ width: `${t.progressPct}%` }} />
                      </div>
                    )}
                    <div className="mt-1.5 flex items-center justify-between text-[10.5px] text-[var(--ink-50)]">
                      <span className="truncate">{t.assignee || 'Unassigned'}</span>
                      {!t.isMilestone && <span className="fb-tabular shrink-0">{t.progressPct}%</span>}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Grid view ────────────────────────────────────────────────────────────────
// A sortable task sheet: every task with its owner, progress, schedule and slack.
// Click a row to open the editor. Columns sort on click. Real schedule data.
type GridSortKey = 'title' | 'assignee' | 'progress' | 'start' | 'end' | 'slack' | 'status'
function GridView({
  plan,
  selectedId,
  onSelect,
  critPathSet,
  lateSet
}: {
  plan: ProjectPlan
  selectedId: string | null
  onSelect: (id: string) => void
  critPathSet: Set<string>
  lateSet: Set<string>
}): JSX.Element {
  const [sort, setSort] = useState<{ key: GridSortKey; dir: 1 | -1 }>({ key: 'start', dir: 1 })
  const statusLabel = (t: PlanTask): string => STATUS_COLUMNS.find((c) => c.id === statusOf(t))?.label ?? 'To do'
  const sorted = [...plan.tasks].sort((a, b) => {
    const d = sort.dir
    switch (sort.key) {
      case 'title':
        return a.title.localeCompare(b.title) * d
      case 'assignee':
        return (a.assignee ?? '').localeCompare(b.assignee ?? '') * d
      case 'progress':
        return (a.progressPct - b.progressPct) * d
      case 'end':
        return (a.scheduledEndMs - b.scheduledEndMs) * d
      case 'slack':
        return (a.slackDays - b.slackDays) * d
      case 'status':
        return statusLabel(a).localeCompare(statusLabel(b)) * d
      case 'start':
      default:
        return (a.scheduledStartMs - b.scheduledStartMs) * d
    }
  })
  const toggle = (key: GridSortKey): void => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }))
  const Th = ({ k, label, cls = '' }: { k: GridSortKey; label: string; cls?: string }): JSX.Element => (
    <th className={`px-3 py-2 text-left font-medium ${cls}`}>
      <button onClick={() => toggle(k)} data-testid={`grid-sort-${k}`} className="inline-flex items-center gap-0.5 hover:text-[var(--ink-100)]">
        {label}
        {sort.key === k && <Icon name={sort.dir === 1 ? 'arrow_drop_down' : 'arrow_drop_up'} size={16} />}
      </button>
    </th>
  )

  return (
    <div className="p-4 overflow-auto h-full fb-fade-in-up" data-testid="projects-grid">
      <table className="w-full text-[12.5px] border-collapse">
        <thead className="text-[11px] uppercase tracking-[0.08em] text-[var(--ink-50)] border-b border-[var(--edge-firm)]">
          <tr>
            <Th k="title" label="Task" />
            <Th k="assignee" label="Owner" />
            <Th k="progress" label="Progress" />
            <Th k="start" label="Start" />
            <Th k="end" label="Finish" />
            <Th k="slack" label="Slack" cls="text-right" />
            <th className="px-3 py-2 text-right font-medium">Cost</th>
            <Th k="status" label="Status" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((t) => (
            <tr
              key={t.id}
              onClick={() => onSelect(t.id)}
              data-testid={`grid-row-${t.id}`}
              className={`border-b border-[var(--edge-soft)] cursor-pointer transition-colors ${
                t.id === selectedId ? 'bg-[rgb(var(--accent)/0.08)]' : 'hover:bg-[var(--surface-sunken)]'
              }`}
            >
              <td className="px-3 py-2">
                <span className="flex items-center gap-1.5">
                  {t.isMilestone && <Icon name="flag" size={12} className="text-violet-500 shrink-0" filled />}
                  {(critPathSet.has(t.id) || t.critical) && !t.isMilestone && <span className="h-1.5 w-1.5 rounded-full bg-rose-500 shrink-0" title="Critical" />}
                  <span className="text-[var(--ink-100)]">{t.title || 'Untitled'}</span>
                  {t.deadlineMiss && (
                    <span title="Misses its deadline" className="inline-flex shrink-0">
                      <Icon name="event_busy" size={12} className="text-rose-500" filled />
                    </span>
                  )}
                  {lateSet.has(t.id) && <Icon name="warning" size={12} className="text-amber-500 shrink-0" filled />}
                </span>
              </td>
              <td className="px-3 py-2 text-[var(--ink-80)]">{t.assignee || <span className="text-[var(--ink-40)]">Unassigned</span>}</td>
              <td className="px-3 py-2">
                {t.isMilestone ? (
                  <span className="text-[var(--ink-40)]">—</span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <span className="w-16 h-1.5 rounded-full bg-[var(--surface-sunken)] overflow-hidden inline-block">
                      <span className="block h-full rounded-full bg-[rgb(var(--accent))]" style={{ width: `${t.progressPct}%` }} />
                    </span>
                    <span className="fb-tabular text-[var(--ink-60)] text-[11px]">{t.progressPct}%</span>
                  </span>
                )}
              </td>
              <td className="px-3 py-2 fb-tabular text-[var(--ink-70)]">{fmtDate(t.scheduledStartMs)}</td>
              <td className="px-3 py-2 fb-tabular text-[var(--ink-70)]">{fmtDate(t.scheduledEndMs)}</td>
              <td className="px-3 py-2 fb-tabular text-right text-[var(--ink-70)]">{t.critical ? '0' : `${t.slackDays}d`}</td>
              <td className="px-3 py-2 fb-tabular text-right text-[var(--ink-70)]" data-testid={`grid-cost-${t.id}`}>
                {t.cost != null ? fmtCost(t.cost) : <span className="text-[var(--ink-40)]">—</span>}
              </td>
              <td className="px-3 py-2"><StatusPill tone={(STATUS_COLUMNS.find((c) => c.id === statusOf(t))?.tone ?? 'stone') as never} label={statusLabel(t)} /></td>
            </tr>
          ))}
        </tbody>
        {plan.totalCost > 0 && (
          <tfoot>
            <tr className="border-t border-[var(--edge-firm)] text-[var(--ink-90)] font-medium">
              <td className="px-3 py-2" colSpan={5}>Total</td>
              <td className="px-3 py-2 fb-tabular text-right" data-testid="grid-total-cost">{fmtCost(plan.totalCost)}</td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

// ── Calendar view ────────────────────────────────────────────────────────────
// A month grid showing each task on the days its scheduled window covers. A real
// calendar of the plan; navigate months with the arrows.
function CalendarView({
  plan,
  selectedId,
  onSelect,
  critPathSet,
  lateSet
}: {
  plan: ProjectPlan
  selectedId: string | null
  onSelect: (id: string) => void
  critPathSet: Set<string>
  lateSet: Set<string>
}): JSX.Element {
  const base = new Date(plan.anchorMs)
  const [month, setMonth] = useState({ y: base.getFullYear(), m: base.getMonth() })
  const first = new Date(month.y, month.m, 1)
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate()
  const leading = first.getDay() // 0=Sun
  const cells: Array<{ day: number; date: Date } | null> = []
  for (let i = 0; i < leading; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, date: new Date(month.y, month.m, d) })
  while (cells.length % 7 !== 0) cells.push(null)

  const dayCovers = (t: PlanTask, date: Date): boolean => {
    const ds = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    const de = ds + DAY_MS - 1
    const ts = Math.floor(t.scheduledStartMs / DAY_MS) * DAY_MS
    const te = t.scheduledEndMs
    return ts <= de && te >= ds
  }
  const todayKey = (() => {
    const n = new Date()
    return `${n.getFullYear()}-${n.getMonth()}-${n.getDate()}`
  })()
  const monthLabel = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <div className="p-4 h-full overflow-auto fb-fade-in-up" data-testid="projects-calendar">
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => setMonth((s) => (s.m === 0 ? { y: s.y - 1, m: 11 } : { y: s.y, m: s.m - 1 }))}
          data-testid="calendar-prev"
          className="fb-btn-surface inline-flex h-8 w-8 items-center justify-center text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
        >
          <Icon name="chevron_left" size={16} />
        </button>
        <h3 className="text-[14px] font-semibold text-[var(--ink-100)] fb-tabular w-40 text-center">{monthLabel}</h3>
        <button
          onClick={() => setMonth((s) => (s.m === 11 ? { y: s.y + 1, m: 0 } : { y: s.y, m: s.m + 1 }))}
          data-testid="calendar-next"
          className="fb-btn-surface inline-flex h-8 w-8 items-center justify-center text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
        >
          <Icon name="chevron_right" size={16} />
        </button>
        <button
          onClick={() => setMonth({ y: new Date().getFullYear(), m: new Date().getMonth() })}
          className="fb-btn-surface ml-1 inline-flex items-center h-8 px-2.5 text-[12px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
        >
          Today
        </button>
      </div>
      <div className="grid grid-cols-7 gap-px text-[11px] text-[var(--ink-50)] mb-1">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div key={d} className="px-2 py-1 font-medium">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px bg-[var(--edge-soft)] rounded-lg overflow-hidden border border-[var(--edge-soft)]">
        {cells.map((c, i) => {
          if (!c) return <div key={i} className="bg-[var(--surface-base)] min-h-[92px]" />
          const dayTasks = plan.tasks.filter((t) => dayCovers(t, c.date))
          const isToday = `${c.date.getFullYear()}-${c.date.getMonth()}-${c.date.getDate()}` === todayKey
          return (
            <div key={i} className="bg-[var(--surface-raised)] min-h-[92px] p-1.5">
              <div className={`text-[11px] mb-1 fb-tabular ${isToday ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-[rgb(var(--accent))] text-white' : 'text-[var(--ink-50)]'}`}>
                {c.day}
              </div>
              <div className="space-y-1">
                {dayTasks.slice(0, 3).map((t) => {
                  const crit = critPathSet.has(t.id) || t.critical
                  const done = t.status === 'done' || t.completedAt != null
                  return (
                    <button
                      key={t.id}
                      onClick={() => onSelect(t.id)}
                      data-testid={`calendar-task-${t.id}`}
                      title={t.title}
                      className={`w-full text-left truncate rounded px-1.5 py-0.5 text-[10.5px] ${
                        done
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                          : crit
                            ? 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
                            : 'bg-[rgb(var(--accent)/0.15)] text-[var(--ink-90)]'
                      } ${t.id === selectedId ? 'ring-1 ring-[rgb(var(--accent)/0.6)]' : ''}`}
                    >
                      {t.isMilestone ? '◆ ' : ''}
                      {lateSet.has(t.id) ? '⚠ ' : ''}
                      {t.title || 'Untitled'}
                    </button>
                  )
                })}
                {dayTasks.length > 3 && <div className="text-[10px] text-[var(--ink-50)] px-1">+{dayTasks.length - 3} more</div>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Workload view ────────────────────────────────────────────────────────────
// Each person and what is on their plate: their tasks, total working days, and a
// load bar relative to the busiest person. "Unassigned" surfaces unowned work.
function WorkloadView({
  plan,
  selectedId,
  onSelect
}: {
  plan: ProjectPlan
  selectedId: string | null
  onSelect: (id: string) => void
}): JSX.Element {
  const groups = new Map<string, PlanTask[]>()
  for (const t of plan.tasks) {
    if (t.isMilestone) continue
    const key = (t.assignee && t.assignee.trim()) || 'Unassigned'
    groups.set(key, [...(groups.get(key) ?? []), t])
  }
  const rows = [...groups.entries()]
    .map(([name, tasks]) => ({
      name,
      tasks,
      load: tasks.reduce((n, t) => n + t.durationDays, 0),
      open: tasks.filter((t) => !(t.status === 'done' || t.completedAt != null)).length
    }))
    .sort((a, b) => b.load - a.load)
  const maxLoad = Math.max(1, ...rows.map((r) => r.load))

  if (rows.length === 0) {
    return (
      <div className="p-8 text-center text-[13px] text-[var(--ink-50)]" data-testid="projects-workload">
        No tasks to schedule across people yet.
      </div>
    )
  }

  return (
    <div className="p-4 h-full overflow-auto fb-fade-in-up space-y-3" data-testid="projects-workload">
      {rows.map((r) => (
        <div key={r.name} className={`${PLEXI_CARD} p-3.5`} data-testid={`workload-row-${r.name === 'Unassigned' ? 'unassigned' : 'person'}`}>
          <div className="flex items-center gap-2.5">
            <span className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-[12px] font-semibold ${r.name === 'Unassigned' ? 'bg-[var(--surface-sunken)] text-[var(--ink-50)]' : 'bg-[rgb(var(--accent)/0.15)] text-[rgb(var(--accent))]'}`}>
              {r.name === 'Unassigned' ? '–' : r.name.replace(/^@/, '').slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-[var(--ink-100)] truncate">{r.name}</p>
              <p className="text-[11px] text-[var(--ink-50)] fb-tabular">
                {r.tasks.length} task{r.tasks.length === 1 ? '' : 's'} · {r.open} open · {r.load} working day{r.load === 1 ? '' : 's'}
              </p>
            </div>
          </div>
          <div className="mt-2 h-1.5 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
            <div
              className="h-full rounded-full bg-[rgb(var(--accent))]"
              style={{ width: `${(r.load / maxLoad) * 100}%`, transition: 'width var(--dur-slow) var(--ease-spring-glide)' }}
            />
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {r.tasks.map((t) => {
              const done = t.status === 'done' || t.completedAt != null
              return (
                <button
                  key={t.id}
                  onClick={() => onSelect(t.id)}
                  data-testid={`workload-task-${t.id}`}
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] transition-colors ${
                    t.id === selectedId ? 'border-[rgb(var(--accent)/0.55)]' : 'border-[var(--edge-soft)] hover:border-[rgb(var(--accent)/0.35)]'
                  } ${done ? 'text-[var(--ink-50)] line-through decoration-1' : 'text-[var(--ink-90)]'}`}
                >
                  {t.title || 'Untitled'}
                  <span className="text-[10px] text-[var(--ink-50)] fb-tabular">{t.durationDays}d</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Overview view ────────────────────────────────────────────────────────────
// A plain summary of the plan, built entirely from the ProjectPlan the parent
// already loaded. Every number is real: progress and task counts come from the
// tasks, the dates from the schedule, the milestone count from the isMilestone
// flag, the missed-deadline count from the engine's deadlineMiss, and the
// critical-path length from plan.criticalPath. Nothing is invented. A brand-new
// plan with no tasks shows honest zeros and a gentle prompt to add tasks.
function OverviewView({
  plan,
  critPathSet,
  lateSet
}: {
  plan: ProjectPlan
  critPathSet: Set<string>
  lateSet: Set<string>
}): JSX.Element {
  const total = plan.tasks.length
  const isDone = (t: PlanTask): boolean => t.status === 'done' || t.completedAt != null
  const done = plan.tasks.filter(isDone).length
  // Percent complete from the real task tally, rounded. Zero tasks reads 0%, not
  // a fabricated figure.
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)

  // Milestones are the tasks flagged as such. The next upcoming one is the
  // earliest-scheduled milestone that has not finished and is not in the past.
  const milestones = plan.tasks.filter((t) => t.isMilestone)
  const now = Date.now()
  const nextMilestone =
    milestones
      .filter((m) => !isDone(m) && m.scheduledStartMs >= now - DAY_MS)
      .sort((a, b) => a.scheduledStartMs - b.scheduledStartMs)[0] ?? null

  // Tasks that miss their deadline, straight from the engine's deadlineMiss flag.
  const deadlineMisses = plan.tasks.filter((t) => t.deadlineMiss).length
  // In-flight slippage the parent already computed (running-late, not done).
  const lateCount = plan.tasks.filter((t) => lateSet.has(t.id) && !isDone(t)).length
  // Critical-path length: number of tasks on it (criticalPath holds task ids).
  const critLength = critPathSet.size

  // The plan's real window: the earliest scheduled start to the project end.
  const startMs = total === 0 ? null : Math.min(...plan.tasks.map((t) => t.scheduledStartMs))
  const finishMs = total === 0 ? null : plan.projectEndMs

  if (total === 0) {
    return (
      <div className="p-6 max-w-3xl mx-auto fb-fade-in-up" data-testid="plan-overview">
        <div className={`${PLEXI_CARD} p-6 text-center`}>
          <Icon name="dashboard" size={28} className="text-[var(--ink-30)]" />
          <p className="mt-2 text-[14px] font-semibold text-[var(--ink-100)]">Nothing planned yet</p>
          <p className="mt-1 text-[13px] text-[var(--ink-60)]" data-testid="plan-overview-empty">
            Add tasks to start planning. As soon as this plan has tasks, the overview fills in with real progress,
            dates and milestones.
          </p>
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="plan-overview-progress">
            <StatTile icon="donut_large" label="Complete" value="0%" tone="stone" />
            <StatTile icon="task_alt" label="Tasks done" value="0/0" tone="stone" />
            <StatTile icon="flag" label="Milestones" value={0} tone="stone" />
            <StatTile icon="event_busy" label="Missed deadlines" value={0} tone="stone" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-3xl mx-auto fb-fade-in-up space-y-4" data-testid="plan-overview">
      <div className={`${PLEXI_CARD} p-5`} data-testid="plan-overview-progress">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold text-[var(--ink-90)]">Progress</span>
          <span className="text-[13px] fb-tabular text-[var(--ink-70)]">
            {done} of {total} task{total === 1 ? '' : 's'} done · {percent}%
          </span>
        </div>
        <div className="mt-2.5 h-2 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
          <div
            className="h-full rounded-full bg-[rgb(var(--accent))]"
            style={{
              width: `${percent}%`,
              minWidth: percent > 0 ? '0.375rem' : '0',
              transition: 'width var(--dur-slow) var(--ease-spring-glide)'
            }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="plan-overview-stats">
        <StatTile icon="task_alt" label="Tasks done" value={`${done}/${total}`} tone="emerald" />
        <StatTile icon="flag" label="Milestones" value={milestones.length} tone="violet" />
        <StatTile
          icon="event_busy"
          label="Missed deadlines"
          value={deadlineMisses}
          tone={deadlineMisses ? 'rose' : 'stone'}
        />
        <StatTile icon="warning" label="Running late" value={lateCount} tone={lateCount ? 'amber' : 'stone'} />
      </div>

      <div className={`${PLEXI_CARD} p-5 space-y-2.5`}>
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="text-[var(--ink-60)]">Starts</span>
          <span className="fb-tabular text-[var(--ink-90)]">{startMs != null ? fmtDate(startMs) : '—'}</span>
        </div>
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="text-[var(--ink-60)]">Finishes</span>
          <span className="fb-tabular text-[var(--ink-90)]">{finishMs != null ? fmtDate(finishMs) : '—'}</span>
        </div>
        <div className="flex items-center justify-between text-[12.5px]">
          <span className="text-[var(--ink-60)]">Critical path</span>
          <span className="fb-tabular text-[var(--ink-90)]">
            {critLength > 0 ? `${critLength} task${critLength === 1 ? '' : 's'}` : 'None'}
          </span>
        </div>
      </div>

      {nextMilestone ? (
        <div className={`${PLEXI_CARD} p-5`} data-testid="plan-overview-milestone">
          <div className="flex items-center gap-2">
            <Icon name="flag" size={16} className="text-violet-500" filled />
            <span className="text-[13px] font-semibold text-[var(--ink-100)] truncate">
              {nextMilestone.title || 'Untitled milestone'}
            </span>
          </div>
          <p className="mt-1 text-[12px] text-[var(--ink-60)] fb-tabular">
            Next milestone, scheduled {fmtDate(nextMilestone.scheduledStartMs)}
          </p>
        </div>
      ) : (
        <div className={`${PLEXI_CARD} p-5`} data-testid="plan-overview-nomilestone">
          <p className="text-[12.5px] text-[var(--ink-60)]">
            {milestones.length === 0
              ? 'No milestones in this plan yet. Mark a task as a milestone to track it here.'
              : 'No upcoming milestones. Every milestone in this plan is already in the past or done.'}
          </p>
        </div>
      )}
    </div>
  )
}

// ── Files view ───────────────────────────────────────────────────────────────
// The real documents and files filed under this plan node, read scoped to the
// plan via window.api.fileManager.list(projectId). A file in a plan is still
// just a file: clicking a document opens it, a file entry opens/reveals it, the
// same idiom FilesView uses. The plan node itself can hold child folders (sub-
// plans); those are listed too but open inside the file manager rather than
// here. An honest empty state shows when nothing is filed yet.
function planFileIcon(entry: FileEntry): string {
  if (entry.kind === 'folder') return 'folder'
  if (entry.kind === 'doc') return entry.docType === 'sheet' ? 'table_chart' : entry.docType === 'slides' ? 'slideshow' : 'description'
  const m = entry.mimeType ?? ''
  const ext = (entry.ext ?? '').replace(/^\./, '')
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'movie'
  if (m.startsWith('audio/')) return 'music_note'
  if (m === 'application/pdf') return 'picture_as_pdf'
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return 'description'
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return 'table_chart'
  if (['ppt', 'pptx', 'key'].includes(ext)) return 'slideshow'
  return 'draft'
}
function planFileType(entry: FileEntry): string {
  if (entry.kind === 'folder') return 'Folder'
  if (entry.kind === 'doc') return entry.docType === 'sheet' ? 'Spreadsheet' : entry.docType === 'slides' ? 'Slides' : 'Document'
  const ext = (entry.ext ?? '').replace(/^\./, '').toUpperCase()
  return ext ? `${ext} file` : 'File'
}
function fmtFileDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

function PlanFilesView({ projectId }: { projectId: string }): JSX.Element {
  const goDocument = useViewStore((s) => s.goDocument)
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    window.api.fileManager
      .list(projectId)
      .then(setEntries)
      .catch((e) => setError(`Could not load files: ${e instanceof Error ? e.message : String(e)}`))
  }, [projectId])

  useEffect(() => {
    load()
  }, [load])

  function openEntry(entry: FileEntry): void {
    if (entry.kind === 'doc' && entry.docId) goDocument(entry.docId)
    else if (entry.kind === 'file') void window.api.files.open(entry.id)
    else if (entry.kind === 'folder') void window.api.fileManager.reveal(entry.id)
  }

  if (entries === null) {
    return (
      <div className="flex items-center gap-2 px-6 py-10 text-[13px] text-[var(--ink-70)]" data-testid="plan-files">
        <Icon name="progress_activity" size={16} className="text-[rgb(var(--accent))] animate-spin" /> Loading files…
      </div>
    )
  }

  // Sort newest-modified first so the most recently touched plan material is on
  // top, the same instinct RecentView follows.
  const sorted = [...entries].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="p-4 h-full overflow-auto fb-fade-in-up" data-testid="plan-files">
      {error && <p className="mb-3 text-rose-500 text-[12px]" data-testid="plan-files-error">{error}</p>}
      {sorted.length === 0 ? (
        <div className="px-3 py-16 text-center" data-testid="plan-files-empty">
          <Icon name="folder_open" size={28} className="text-[var(--ink-30)]" />
          <p className="mt-2 text-[13px] text-[var(--ink-70)] max-w-md mx-auto leading-relaxed">
            No files in this plan yet. File a document or drop a file here to keep it with the plan.
          </p>
        </div>
      ) : (
        <table className="w-full text-[12.5px] border-collapse" data-testid="plan-files-table">
          <thead className="text-[11px] uppercase tracking-[0.08em] text-[var(--ink-50)] border-b border-[var(--edge-firm)]">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Name</th>
              <th className="px-3 py-2 text-left font-medium">Type</th>
              <th className="px-3 py-2 text-left font-medium">Modified</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => (
              <tr
                key={entry.id}
                onClick={() => openEntry(entry)}
                data-testid={`plan-files-row-${entry.id}`}
                data-kind={entry.kind}
                className="border-b border-[var(--edge-soft)] cursor-pointer transition-colors hover:bg-[var(--surface-sunken)]"
              >
                <td className="px-3 py-2">
                  <span className="flex items-center gap-2 min-w-0">
                    <Icon
                      name={planFileIcon(entry)}
                      size={16}
                      className={entry.kind === 'folder' ? 'text-[rgb(var(--accent))] shrink-0' : 'text-[var(--ink-50)] shrink-0'}
                    />
                    <span className="truncate text-[var(--ink-100)]">{entry.name}</span>
                  </span>
                </td>
                <td className="px-3 py-2 text-[var(--ink-70)]">{planFileType(entry)}</td>
                <td className="px-3 py-2 fb-tabular text-[var(--ink-70)]">{fmtFileDate(entry.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Working-calendar settings ────────────────────────────────────────────────
// A small popover to set which weekdays are working and add holiday dates, per
// project. The schedule (weekend-skipping, durations) recomputes against it.
function CalendarSettings({
  projectId,
  onClose,
  onChanged
}: {
  projectId: string
  onClose: () => void
  onChanged: () => void
}): JSX.Element {
  const [cal, setCal] = useState<WorkingCalendar | null>(null)
  const [holiday, setHoliday] = useState('')
  useEffect(() => {
    void window.api.projects.getCalendar(projectId).then(setCal)
  }, [projectId])

  async function save(next: WorkingCalendar): Promise<void> {
    setCal(next)
    await window.api.projects.setCalendar(projectId, next)
    onChanged()
  }
  const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
  const FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute right-0 mt-1.5 z-40 w-64 p-3" data-testid="calendar-settings">
        <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-medium mb-2">Working days</p>
        {!cal ? (
          <p className="text-[12px] text-[var(--ink-50)] py-2">Loading…</p>
        ) : (
          <>
            <div className="flex items-center gap-1">
              {cal.workingDays.map((on, i) => (
                <button
                  key={i}
                  onClick={() => void save({ ...cal, workingDays: cal.workingDays.map((w, j) => (j === i ? !w : w)) })}
                  data-testid={`calendar-day-${i}`}
                  title={FULL[i]}
                  className={`h-8 w-8 rounded-md text-[12px] font-medium ${
                    on ? 'bg-[rgb(var(--accent))] text-white' : 'bg-[var(--surface-sunken)] text-[var(--ink-50)]'
                  }`}
                >
                  {DAYS[i]}
                </button>
              ))}
            </div>
            <p className="mt-3 text-[11px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-medium mb-1.5">Holidays</p>
            <div className="space-y-1 max-h-28 overflow-auto">
              {(cal.holidays ?? []).length === 0 && <p className="text-[11.5px] text-[var(--ink-50)]">None.</p>}
              {(cal.holidays ?? [])
                .slice()
                .sort((a, b) => a - b)
                .map((h) => (
                  <div key={h} className="flex items-center gap-1.5 text-[12px] bg-[var(--surface-sunken)] rounded px-2 py-1">
                    <span className="flex-1 fb-tabular text-[var(--ink-90)]">{new Date(h).toLocaleDateString()}</span>
                    <button onClick={() => void save({ ...cal, holidays: (cal.holidays ?? []).filter((x) => x !== h) })} className="text-[var(--ink-50)] hover:text-rose-500">
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                ))}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                type="date"
                value={holiday}
                onChange={(e) => setHoliday(e.target.value)}
                data-testid="calendar-holiday-input"
                className="fb-field flex-1 px-2 py-1 text-[12px] text-[var(--ink-100)]"
              />
              <button
                onClick={() => {
                  const ms = fromDateInput(holiday)
                  if (ms != null && cal) {
                    setHoliday('')
                    void save({ ...cal, holidays: [...new Set([...(cal.holidays ?? []), ms])] })
                  }
                }}
                disabled={!holiday}
                className="inline-flex items-center h-7 px-2 rounded-md bg-[rgb(var(--accent))] text-white text-[12px] disabled:opacity-40"
              >
                Add
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )
}
