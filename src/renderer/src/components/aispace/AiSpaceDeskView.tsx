// AI Space on a Desk (SPEC-AI-SPACE.md §1 Project Desk, §4, §5): the goal,
// the Project Manager conversation, tasks and current outputs, with a compact
// switcher for Overview, Tasks, Outputs and Impact. The Manager lives in a
// collapsible pane with its own history; anything opened in the inspector has
// a stable link and can expand to fill the Desk.

import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import Icon from '../Icon'
import type { ProjectViewData, MessagesData } from '@shared/aispace/api'
import type { AiProject, AiTask, AiWorkspace, OutputKind, RecordRef } from '@shared/aispace/model'
import { OUTPUT_KINDS, OUTPUT_KIND_LABEL } from '@shared/aispace/model'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import { useActionHistory } from '../../stores/actionHistory'
import { takePendingFocus, openProject, type DeskTab } from '../../lib/aiSpaceNav'
import { aiSpaceAvailable } from '../../lib/aiSpaceAvailable'
import ViewSelector from '../views/ViewSelector'
import Modal from '../plexi/Modal'
import { confirmDialog, promptText } from '../plexi/PromptDialog'
import Composer from './Composer'
import ImpactView, { type InspectTarget } from './ImpactView'
import NewProjectDialog from './NewProjectDialog'
import BranchReview from './BranchReview'
import { OutputInspectorBody, OutputsGrid, Preview } from './OutputsPanel'
import { Announcer, EmptyState, Inspector, Kbd, LinkButton, PrimaryButton, QuietButton, Section, StatusBadge, Tabs, announce, authorLabel, fmtAgo, fmtMoney, fmtWhen, useWideLayout } from './ui'

const RunInspector = lazy(() => import('./RunInspector'))

const TABS: Array<{ id: DeskTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'outputs', label: 'Outputs' },
  { id: 'impact', label: 'Impact' }
]

const TAB_KEY = 'fb.aispace.deskTab'
const PM_KEY = 'fb.aispace.pmOpen'

function loadPref<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
function savePref(k: string, v: unknown): void {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* private mode */
  }
}

export default function AiSpaceDeskView({ taskId: deskId }: { taskId: string }): JSX.Element {
  const desk = useNodeStore((s) => s.nodes.find((n) => n.id === deskId) ?? null)
  const [project, setProject] = useState<AiProject | null | undefined>(undefined)
  const [view, setView] = useState<ProjectViewData | null>(null)
  const [workspaces, setWorkspaces] = useState<AiWorkspace[]>([])
  const [tab, setTab] = useState<DeskTab>(() => loadPref<Record<string, DeskTab>>(TAB_KEY, {})[deskId] ?? 'overview')
  const [pmOpen, setPmOpen] = useState<boolean>(() => loadPref(PM_KEY, true))
  const [inspect, setInspect] = useState<InspectTarget | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [focusChange, setFocusChange] = useState<string | null>(null)
  const [presetInputs, setPresetInputs] = useState<RecordRef[]>([])
  const [newOpen, setNewOpen] = useState(false)
  const [newOutput, setNewOutput] = useState(false)
  const [switcher, setSwitcher] = useState(false)
  const [branchId, setBranchId] = useState<string | null>(null)
  const [shortcuts, setShortcuts] = useState(false)
  const wide = useWideLayout()
  const rootRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    if (!aiSpaceAvailable()) return
    const p = await window.api.aiSpace.projectForDesk(deskId)
    setProject(p)
    if (p) {
      const [v, c] = await Promise.all([window.api.aiSpace.projectView(p.id), window.api.aiSpace.getContext()])
      setView(v)
      setWorkspaces(c.workspaces)
    } else setView(null)
  }, [deskId])

  useEffect(() => {
    void load()
  }, [load])

  // Mark the project viewed when the person leaves it, so the next return
  // brief starts from here. Opening never resolves anything.
  useEffect(() => {
    const id = project?.id
    return () => {
      if (id) void window.api.aiSpace.markProjectViewed(id)
    }
  }, [project?.id])

  // Live: refresh on this project's events (the brief and lists are small).
  useEffect(() => {
    const off = window.api.aiSpace.onChanged((p) => {
      if (!project || p.projectId === project.id || p.topic === 'connection' || p.topic === 'context') void load()
    })
    return off
  }, [project, load])

  // Deep links from Home / Impact / the palette.
  const applyFocus = useCallback(() => {
    const f = takePendingFocus(deskId)
    if (!f) return
    setTab(f.tab)
    if (f.changeId) setFocusChange(f.changeId)
    if (f.item) {
      if (f.item.type === 'output') setInspect({ kind: 'output', id: f.item.id, versionId: f.item.versionId ?? null })
      else if (f.item.type === 'run') setInspect({ kind: 'run', id: f.item.id })
      else if (f.item.type === 'decision') setInspect({ kind: 'decision', id: f.item.id })
      else if (f.item.type === 'task') setInspect({ kind: 'task', id: f.item.id })
      else if (f.item.type === 'source') setInspect({ kind: 'source', id: f.item.id })
    }
  }, [deskId])
  useEffect(() => {
    applyFocus()
    const on = (): void => applyFocus()
    window.addEventListener('aispace:focus', on)
    return () => window.removeEventListener('aispace:focus', on)
  }, [applyFocus, view])

  useEffect(() => {
    const m = loadPref<Record<string, DeskTab>>(TAB_KEY, {})
    m[deskId] = tab
    savePref(TAB_KEY, m)
  }, [tab, deskId])

  // Shortcuts that belong to this surface (§5): ⌘⇧K find or switch project,
  // ? shortcuts. Captured here so the app-wide ⇧⌘K (Plexii hub) stays as is
  // everywhere else; inside AI Space the project switcher takes it.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent): void {
      const inField = e.target instanceof Element ? e.target.closest('input, textarea, select, [contenteditable="true"]') : null
      // Exactly ⇧⌘K: with Option it is PlexiiDraw's shortcut sheet, left alone.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        setSwitcher(true)
      } else if (e.key === '?' && !inField && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        setShortcuts(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const onInspect = useCallback(async (t: InspectTarget) => {
    if (t.kind === 'output' && !t.id && t.versionId) {
      const r = await window.api.aiSpace.getVersion(t.versionId)
      if (r) setInspect({ kind: 'output', id: r.output.id, versionId: r.version.id })
      return
    }
    setExpanded(false)
    setInspect(t)
  }, [])

  if (!aiSpaceAvailable()) {
    return <EmptyState icon="desktop_mac" title="AI Space is in the Plexii desktop app" body="AI projects stay on the owner’s Mac." testId="ais-desk-unavailable" />
  }

  if (project === undefined) return <div className="h-full bg-[var(--surface-base)] p-8"><div className="fb-skeleton h-40 rounded-xl" aria-busy="true" /></div>

  if (project === null) {
    return (
      <div className="h-full overflow-auto bg-[var(--surface-base)] ais-touch" data-testid="ais-desk-empty">
        <div className="flex items-center gap-2 px-5 pt-4">
          <ViewSelector taskId={deskId} />
        </div>
        <div className="max-w-xl mx-auto mt-10 fb-card">
          <EmptyState icon="auto_awesome" title="Start an AI project on this Desk" body="Give it a goal and a brief. AIs work on it from here, every output keeps its versions, and Impact shows what a change affects." action={{ label: 'Start an AI project', run: () => setNewOpen(true), testId: 'ais-desk-start' }}>
            <p className="mt-3 text-[13px] text-[var(--ink-60)]">
              Already have work in a chat? <LinkButton onClick={() => useViewStore.getState().goAiSpace()}>Bring it in from AI Space</LinkButton>
            </p>
          </EmptyState>
        </div>
        {newOpen && <NewProjectDialog deskId={deskId} deskTitle={desk?.title ?? ''} roomId={desk?.parentId ?? null} onClose={() => setNewOpen(false)} onCreated={() => void load()} />}
      </div>
    )
  }

  const docked = wide && !expanded
  const ws = workspaces.find((w) => w.id === project.workspaceId)

  return (
    <div ref={rootRef} className="h-full flex bg-[var(--surface-base)] text-[var(--ink-100)] ais-touch relative" data-testid="ais-desk" data-project={project.id}>
      <Announcer />
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="px-6 pt-4 pb-3 border-b border-[var(--edge-hairline)]">
          <div className="flex items-center gap-2">
            <ViewSelector taskId={deskId} />
            <span className="ml-auto flex items-center gap-2">
              <QuietButton icon="swap_horiz" onClick={() => setSwitcher(true)} title="Find or switch project (⌘⇧K)" testId="ais-switch-project">
                Projects
              </QuietButton>
              <QuietButton icon={pmOpen ? 'right_panel_close' : 'right_panel_open'} onClick={() => { setPmOpen((v) => !v); savePref(PM_KEY, !pmOpen) }} testId="ais-toggle-pm" ariaLabel={pmOpen ? 'Hide the Project Manager' : 'Show the Project Manager'}>
                Manager
              </QuietButton>
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-1">
            <h1 className="text-[28px] font-semibold leading-tight min-w-0 truncate" data-testid="ais-project-title">
              {project.title}
            </h1>
            {ws && <span className="mb-1 text-[12px] px-1.5 py-0.5 rounded-md border border-[var(--edge-soft)] text-[var(--ink-60)]">{ws.name}</span>}
            <span className="mb-1 text-[12px] text-[var(--ink-50)] inline-flex items-center gap-1">
              <Icon name="lock" size={12} />
              On this Mac only
            </span>
          </div>
          {project.goal && <p className="mt-1 text-[14px] text-[var(--ink-70)]">{project.goal}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Tabs
              label="Project view"
              tabs={TABS.map((t) => ({ ...t, count: t.id === 'impact' ? view?.brief.needsYou.length || undefined : t.id === 'outputs' ? view?.outputs.filter((o) => o.role !== 'brief').length || undefined : t.id === 'tasks' ? view?.tasks.filter((x) => x.status !== 'done').length || undefined : undefined }))}
              active={tab}
              onChange={setTab}
              testIdPrefix="ais-tab"
            />
            {view && (
              <BranchPicker
                view={view}
                branchId={branchId}
                onPick={setBranchId}
                onReview={() => {
                  setInspect({ kind: 'branches', id: 'all' })
                  setExpanded(true)
                }}
                onCreated={async (id) => {
                  await load()
                  setBranchId(id)
                }}
              />
            )}
          </div>
        </header>
        <main className="flex-1 min-h-0 overflow-auto px-6 py-5" data-testid={`ais-panel-${tab}`}>
          {!view ? (
            <div className="fb-skeleton h-40 rounded-xl" aria-busy="true" />
          ) : tab === 'overview' ? (
            <Overview view={view} onInspect={onInspect} onRefresh={load} presetInputs={presetInputs} branchId={branchId} branchName={view.branches.find((b) => b.id === branchId)?.name ?? null} onImpact={(changeId) => { setFocusChange(changeId); setTab('impact') }} />
          ) : tab === 'tasks' ? (
            <TasksPanel view={view} onInspect={onInspect} onRefresh={load} />
          ) : tab === 'outputs' ? (
            <OutputsGrid view={{ ...view, outputs: view.outputs.filter((o) => (o.branchId ?? null) === branchId) }} onOpen={(id) => void onInspect({ kind: 'output', id })} onNew={() => setNewOutput(true)} selectedId={inspect?.kind === 'output' ? inspect.id : null} />
          ) : (
            <ImpactView projectId={project.id} onInspect={(t) => void onInspect(t)} focusChangeId={focusChange} onChanged={load} />
          )}
        </main>
      </div>

      {pmOpen && view && <ManagerPane project={project} view={view} onInspect={onInspect} />}

      <Inspector
        open={Boolean(inspect)}
        onClose={() => {
          setInspect(null)
          setExpanded(false)
        }}
        title={inspectTitle(inspect, view)}
        subtitle={<span className="text-[11.5px] text-[var(--ink-50)]">{project.title}{inspect ? ` · ${inspect.kind}` : ''}</span>}
        expanded={expanded}
        onToggleExpand={() => setExpanded((v) => !v)}
        docked={docked}
        targetKey={inspect ? `${inspect.kind}:${inspect.id}` : ''}
        testId="ais-inspector"
      >
        {inspect?.kind === 'output' && (
          <OutputInspectorBody
            key={inspect.id}
            outputId={inspect.id}
            focusVersionId={inspect.versionId ?? null}
            initialCompare={inspect.compare ?? null}
            workspaces={workspaces.filter((w) => w.id !== project.workspaceId)}
            onReference={(ref) => {
              setPresetInputs([ref])
              setTab('overview')
              announce(`${ref.label ?? 'Reference'} added to the composer.`)
            }}
            onChanged={() => void load()}
          />
        )}
        {inspect?.kind === 'run' && (
          <Suspense fallback={<div className="fb-skeleton h-24 rounded-lg" />}>
            <RunInspector key={inspect.id} runId={inspect.id} onClose={() => setInspect(null)} docked={docked} embedded onOpenRun={(id) => setInspect({ kind: 'run', id })} />
          </Suspense>
        )}
        {inspect?.kind === 'decision' && view && <DecisionBody id={inspect.id} view={view} onRefresh={load} />}
        {inspect?.kind === 'source' && view && <SourceBody id={inspect.id} view={view} />}
        {inspect?.kind === 'task' && view && <TaskBody id={inspect.id} view={view} onInspect={onInspect} onRefresh={load} />}
        {inspect?.kind === 'request' && view && <RequestBody id={inspect.id} view={view} onRefresh={load} />}
        {inspect?.kind === 'branches' && view && <BranchReview view={view} onChanged={load} />}
      </Inspector>

      {newOutput && view && <NewOutputDialog projectId={project.id} tasks={view.tasks} onClose={() => setNewOutput(false)} onCreated={(id) => { setNewOutput(false); void load(); void onInspect({ kind: 'output', id }) }} />}
      {switcher && <ProjectSwitcher currentId={project.id} onClose={() => setSwitcher(false)} />}
      {shortcuts && <ShortcutsSheet onClose={() => setShortcuts(false)} />}
    </div>
  )
}

function inspectTitle(t: InspectTarget | null, view: ProjectViewData | null): string {
  if (!t || !view) return ''
  if (t.kind === 'output') return view.outputs.find((o) => o.id === t.id)?.title ?? 'Output'
  if (t.kind === 'run') return view.runs.find((r) => r.id === t.id)?.title ?? 'Run'
  if (t.kind === 'decision') return view.decisions.find((d) => d.id === t.id)?.title ?? 'Decision'
  if (t.kind === 'source') return view.sources.find((s) => s.id === t.id)?.title ?? 'Source'
  if (t.kind === 'task') return view.tasks.find((x) => x.id === t.id)?.title ?? 'Task'
  if (t.kind === 'branches') return 'Compare branches'
  return 'Request'
}

// ── Overview ──────────────────────────────────────────────────────────────────

function Overview(props: { view: ProjectViewData; onInspect: (t: InspectTarget) => void; onRefresh: () => Promise<void>; presetInputs: RecordRef[]; branchId: string | null; branchName: string | null; onImpact: (changeId: string) => void }): JSX.Element {
  const { view } = props
  const b = view.brief
  const cur = b.currentDeliverable
  const curMeta = cur ? view.outputs.find((o) => o.id === cur.output.id) : null
  return (
    <div className="max-w-5xl">
      {/* The return brief: up to three consequential updates, each with an action and a source. */}
      <section className="fb-card px-5 py-4" data-testid="ais-return-brief" aria-label="What changed since you were last here">
        <p className="text-[15px] font-medium">{b.headline}</p>
        {b.updates.length > 0 && (
          <ol className="mt-3 space-y-3">
            {b.updates.map((u) => (
              <li key={u.id} className="flex gap-3" data-testid="ais-brief-update">
                <Icon name={u.category === 'conflict' ? 'priority_high' : u.category === 'usable' ? 'task_alt' : 'info'} size={17} className={`mt-0.5 shrink-0 ${u.category === 'conflict' ? 'text-[color:var(--ais-warn)]' : 'text-[var(--ink-50)]'}`} />
                <div className="min-w-0">
                  <p className="text-[14.5px]">{u.text}</p>
                  {u.detail && <p className="text-[13.5px] text-[var(--ink-70)]">{u.detail}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-3">
                    {u.action && (
                      <QuietButton onClick={() => props.onImpact(u.id)} testId="ais-brief-action">
                        {u.action.label}
                      </QuietButton>
                    )}
                    {u.source && (
                      <LinkButton onClick={() => props.onInspect(sourceTarget(u.source!))}>Open source</LinkButton>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        {b.nextStep && (
          <p className="mt-3 text-[13.5px] text-[var(--ink-70)]">
            <span className="text-[var(--ink-50)]">Most useful next: </span>
            {b.nextStep.text}
          </p>
        )}
      </section>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-6">
          <Section title="Current deliverable" testId="ais-current-deliverable">
            {cur && curMeta ? (
              <button type="button" onClick={() => props.onInspect({ kind: 'output', id: cur.output.id })} className="w-full text-left fb-card overflow-hidden hover:bg-[var(--surface-sunken)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]">
                <Preview kind={curMeta.kind} v={curMeta.latest} />
                <div className="px-4 py-3 flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-medium">{curMeta.title}</span>
                  <StatusBadge status={curMeta.reviewState} />
                  <span className="text-[12px] text-[var(--ink-50)]">{cur.why}</span>
                </div>
              </button>
            ) : (
              <p className="text-[14px] text-[var(--ink-60)]">No deliverable yet. Ask for one below.</p>
            )}
          </Section>
          <Section title="Ask or assign">
            <Composer view={view} onSent={() => void props.onRefresh()} onOpenRun={(id) => props.onInspect({ kind: 'run', id })} presetInputs={props.presetInputs} branchId={props.branchId} branchName={props.branchName} />
          </Section>
          <BriefCard view={view} onRefresh={props.onRefresh} />
        </div>
        <div className="min-w-0 space-y-6">
          <Section title="Needs you" testId="ais-needs">
            {b.needsYou.length === 0 ? (
              <p className="text-[14px] text-[var(--ink-60)]">Nothing is waiting for you.</p>
            ) : (
              <ul className="space-y-1.5">
                {b.needsYou.map((n) => (
                  <li key={n.id}>
                    <button type="button" onClick={() => props.onInspect(sourceTarget(n.target))} className="w-full text-left fb-card px-3 py-2 text-[14px] hover:bg-[var(--surface-sunken)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]">
                      {n.text}
                      <span className="block text-[12px] text-[var(--ink-50)]">{fmtAgo(n.since)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <DecisionsCard view={view} onInspect={props.onInspect} onRefresh={props.onRefresh} />
          <SourcesCard view={view} onInspect={props.onInspect} onRefresh={props.onRefresh} />
          <SettingsCard view={view} onRefresh={props.onRefresh} />
        </div>
      </div>
    </div>
  )
}

function sourceTarget(ref: { type: string; id: string; versionId?: string | null }): InspectTarget {
  if (ref.type === 'run') return { kind: 'run', id: ref.id }
  if (ref.type === 'decision') return { kind: 'decision', id: ref.id }
  if (ref.type === 'source') return { kind: 'source', id: ref.id }
  if (ref.type === 'task') return { kind: 'task', id: ref.id }
  if (ref.type === 'request') return { kind: 'request', id: ref.id }
  if (ref.type === 'version') return { kind: 'output', id: '', versionId: ref.id }
  return { kind: 'output', id: ref.id, versionId: ref.versionId ?? null }
}

function BriefCard({ view, onRefresh }: { view: ProjectViewData; onRefresh: () => Promise<void> }): JSX.Element {
  const brief = view.outputs.find((o) => o.role === 'brief')
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [summary, setSummary] = useState('')
  const [stale, setStale] = useState<string | null>(null)
  if (!brief) return <></>
  const approved = brief.approved
  async function save(): Promise<void> {
    if (!brief) return
    const r = await window.api.aiSpace.addVersion({ outputId: brief.id, content: text, changeSummary: summary.trim() || 'Brief edited.', expectedParentVersionId: brief.latestVersionId })
    if (!r.ok) {
      setStale(r.currentContent)
      return
    }
    await window.api.aiSpace.approveVersion(brief.id, r.version.id)
    announce(`Brief v${r.version.n} approved. Impact will show what it affects.`)
    setEditing(false)
    await onRefresh()
  }
  return (
    <Section title="Brief" testId="ais-brief" aside={!editing && <QuietButton icon="edit" onClick={() => { setText(approved?.excerpt ?? brief.latest?.excerpt ?? ''); setEditing(true) }} testId="ais-brief-edit">Edit brief</QuietButton>}>
      {editing ? (
        <div className="fb-card p-3">
          <textarea aria-label="Brief" value={text} onChange={(e) => setText(e.target.value)} className="fb-field w-full min-h-[160px] rounded-lg px-3 py-2 text-[14px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]" data-testid="ais-brief-text" />
          <input aria-label="What changed" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What changed (e.g. Trial 14 → 30 days)" className="mt-2 fb-field w-full h-9 rounded-lg px-3 text-[13px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]" />
          {stale !== null && (
            <p role="alert" className="mt-2 text-[13px] text-[color:var(--ais-warn)]">
              The brief changed while you were editing. Newer text: “{stale.slice(0, 200)}”. Copy what you need, then try again.
            </p>
          )}
          <p className="mt-2 text-[12px] text-[var(--ink-50)]">Saving makes a new version and approves it. Earlier versions stay, and runs keep the version they used.</p>
          <div className="mt-2 flex justify-end gap-2">
            <QuietButton onClick={() => setEditing(false)}>Cancel</QuietButton>
            <PrimaryButton onClick={() => void save()} testId="ais-brief-save">
              Save and approve
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <div className="fb-card px-4 py-3">
          <p className="text-[14px] whitespace-pre-wrap text-[var(--ink-90)]">{approved?.excerpt || brief.latest?.excerpt || 'No brief yet. Add one so agents work from the same facts.'}</p>
          {approved && <p className="mt-2 text-[12px] text-[var(--ink-50)]">v{approved.n} · approved · {fmtAgo(approved.createdAt)}</p>}
        </div>
      )}
    </Section>
  )
}

function DecisionsCard({ view, onInspect, onRefresh }: { view: ProjectViewData; onInspect: (t: InspectTarget) => void; onRefresh: () => Promise<void> }): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [topic, setTopic] = useState('')
  const [title, setTitle] = useState('')
  const [value, setValue] = useState('')
  const [approve, setApprove] = useState(true)
  const live = view.decisions.filter((d) => d.status === 'open' || d.status === 'approved').slice(0, 8)
  async function add(): Promise<void> {
    if (!title.trim() || !value.trim()) return
    await window.api.aiSpace.recordDecision({ projectId: view.project.id, topic: (topic.trim() || title.trim()).toLowerCase().replace(/\s+/g, '_'), title: title.trim(), value: value.trim(), approve })
    setAdding(false)
    setTopic('')
    setTitle('')
    setValue('')
    announce('Decision recorded.')
    await onRefresh()
  }
  const field = 'fb-field w-full h-9 rounded-lg px-3 text-[13px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]'
  return (
    <Section title="Decisions" testId="ais-decisions" aside={<QuietButton icon="add" onClick={() => setAdding((v) => !v)} testId="ais-decision-add">Record</QuietButton>}>
      {adding && (
        <div className="fb-card p-3 mb-2 space-y-2">
          <input aria-label="Decision" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What was decided (e.g. Client approved a 30-day trial)" className={field} data-testid="ais-decision-title" />
          <div className="grid grid-cols-2 gap-2">
            <input aria-label="Topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic (e.g. trial length)" className={field} data-testid="ais-decision-topic" />
            <input aria-label="Value" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value (e.g. 30 days)" className={field} data-testid="ais-decision-value" />
          </div>
          <label className="inline-flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
            Approved now (otherwise it waits as a decision due)
          </label>
          <div className="flex justify-end">
            <PrimaryButton onClick={() => void add()} testId="ais-decision-save">
              Record decision
            </PrimaryButton>
          </div>
        </div>
      )}
      {live.length === 0 ? (
        <p className="text-[14px] text-[var(--ink-60)]">No decisions recorded.</p>
      ) : (
        <ul className="space-y-1.5">
          {live.map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => onInspect({ kind: 'decision', id: d.id })} className="w-full text-left fb-card px-3 py-2 hover:bg-[var(--surface-sunken)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]">
                <span className="flex items-center gap-2">
                  <span className="text-[14px] min-w-0 flex-1 truncate">{d.title}</span>
                  <StatusBadge status={d.status} />
                </span>
                <span className="block text-[12px] text-[var(--ink-50)]">
                  {d.value}
                  {d.previousValue ? ` (was ${d.previousValue})` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function SourcesCard({ view, onInspect, onRefresh }: { view: ProjectViewData; onInspect: (t: InspectTarget) => void; onRefresh: () => Promise<void> }): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [url, setUrl] = useState('')
  async function add(): Promise<void> {
    if (!title.trim() || !content.trim()) return
    await window.api.aiSpace.addSource({ projectId: view.project.id, title: title.trim(), content, url: url.trim() || null, kind: url.trim() ? 'link' : 'note' })
    setAdding(false)
    setTitle('')
    setContent('')
    setUrl('')
    announce('Source added. Open questions that match it are answered automatically.')
    await onRefresh()
  }
  const field = 'fb-field w-full rounded-lg px-3 text-[13px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]'
  return (
    <Section title="Sources" testId="ais-sources" aside={<QuietButton icon="add" onClick={() => setAdding((v) => !v)} testId="ais-source-add">Add</QuietButton>}>
      {adding && (
        <div className="fb-card p-3 mb-2 space-y-2">
          <input aria-label="Source title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (e.g. Client email, 22 Nov)" className={`${field} h-9`} data-testid="ais-source-title" />
          <input aria-label="Link (optional)" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (optional)" className={`${field} h-9`} />
          <textarea aria-label="Source text" value={content} onChange={(e) => setContent(e.target.value)} placeholder="Paste what it says" className={`${field} py-2 min-h-[80px]`} data-testid="ais-source-content" />
          <p className="text-[12px] text-[var(--ink-50)]">Sources are material for the work. Nothing in them can grant permission or start anything.</p>
          <div className="flex justify-end">
            <PrimaryButton onClick={() => void add()} testId="ais-source-save">
              Add source
            </PrimaryButton>
          </div>
        </div>
      )}
      {view.sources.length === 0 ? (
        <p className="text-[14px] text-[var(--ink-60)]">No sources yet.</p>
      ) : (
        <ul className="space-y-1">
          {view.sources.slice(0, 8).map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => onInspect({ kind: 'source', id: s.id })} className="w-full text-left px-2.5 py-1.5 rounded-lg text-[13.5px] flex items-center gap-2 hover:bg-[var(--surface-sunken)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]">
                <Icon name={s.kind === 'import' ? 'download_done' : s.kind === 'tool_result' || s.kind === 'app_api' ? 'build' : 'article'} size={15} className="text-[var(--ink-50)]" />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="text-[11.5px] text-[var(--ink-50)] fb-tabular">{fmtAgo(s.capturedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

function SettingsCard({ view, onRefresh }: { view: ProjectViewData; onRefresh: () => Promise<void> }): JSX.Element {
  const p = view.project
  const [budget, setBudget] = useState(p.budgetLimitMinor === null ? '' : String(p.budgetLimitMinor / 100))
  const models = view.eligibleConnections.filter((c) => c.kind === 'model_api' && c.status !== 'disconnected')
  const current = models.find((c) => c.id === p.defaultConnectionId) ?? null
  return (
    <Section title="Project settings" testId="ais-project-settings">
      <div className="fb-card px-4 py-3 space-y-3 text-[13.5px]">
        <div>
          <p className="text-[12px] text-[var(--ink-50)] mb-1">Default model (used by the Manager and agent drafts)</p>
          {models.length === 0 ? (
            <p>
              No model connection in this workspace. <LinkButton onClick={() => useViewStore.getState().goConnections()}>Add one</LinkButton>
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Default connection"
                value={p.defaultConnectionId ?? ''}
                data-testid="ais-default-connection"
                onChange={async (e) => {
                  const c = models.find((x) => x.id === e.target.value) ?? null
                  await window.api.aiSpace.setProjectDefault(p.id, c?.id ?? null, c?.defaultModel ?? null)
                  announce(c ? `${c.alias} is now the project default.` : 'No default model.')
                  await onRefresh()
                }}
                className="fb-field h-9 rounded-lg px-2 bg-[var(--surface-sunken)] border border-[var(--edge-soft)]"
              >
                <option value="">None (Manager answers from records)</option>
                {models.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.alias} · {c.payer}
                  </option>
                ))}
              </select>
              {current && (
                <select
                  aria-label="Default model"
                  value={p.defaultModel ?? ''}
                  onChange={async (e) => {
                    await window.api.aiSpace.setProjectDefault(p.id, current.id, e.target.value)
                    await onRefresh()
                  }}
                  className="fb-field h-9 rounded-lg px-2 bg-[var(--surface-sunken)] border border-[var(--edge-soft)]"
                >
                  {current.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>
        <div>
          <label className="text-[12px] text-[var(--ink-50)] block mb-1" htmlFor="ais-budget">
            Budget for this project (US$, Plexii’s own limit — not your provider invoice)
          </label>
          <div className="flex gap-2 items-center">
            <input
              id="ais-budget"
              inputMode="decimal"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              onBlur={async () => {
                const n = budget.trim() === '' ? null : Math.round(Number(budget) * 100)
                if (n !== null && !Number.isFinite(n)) return
                await window.api.aiSpace.updateProject(p.id, { budgetLimitMinor: n })
                await onRefresh()
              }}
              placeholder="No limit"
              className="fb-field h-9 w-32 rounded-lg px-3 bg-[var(--surface-sunken)] border border-[var(--edge-soft)] fb-tabular"
              data-testid="ais-budget"
            />
            <span className="text-[12.5px] text-[var(--ink-60)] fb-tabular">
              Spent {fmtMoney(view.spend.spentMicros)}
              {view.spend.reservedMicros ? ` · ${fmtMoney(view.spend.reservedMicros)} reserved` : ''}
              {view.spend.unknownCount ? ` · ${view.spend.unknownCount} with unknown cost` : ''}
            </span>
          </div>
        </div>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={p.authority.draftRevisions}
            data-testid="ais-authority-drafts"
            onChange={async (e) => {
              const on = e.target.checked
              if (on) {
                // Opting in sends project content to a provider without a
                // click each time, so say exactly where, as whom and what.
                const agentConns = view.agents.map((a) => view.eligibleConnections.find((c) => c.id === (a.connectionId ?? p.defaultConnectionId))).filter((c): c is NonNullable<typeof c> => Boolean(c))
                const conns = [...new Map(agentConns.map((c) => [c.id, c])).values()]
                const where = conns.length ? conns.map((c) => `${c.alias} (${c.providerName}, sent to ${c.dataDestination ?? c.providerName}, paid by ${c.payer})`).join('; ') : 'no model is set yet, so nothing can be sent until you choose one'
                const ok = await confirmDialog({
                  title: 'Let agents draft fixes on their own?',
                  body: `When an approved input changes (a decision or the brief), agents will draft new versions of the work that recorded using the old one, without asking each time. Each draft sends the new input and the current version of that output to: ${where}. At most ${p.authority.maxAutoFollowUps} drafts per change, within this project's budget. Drafts never approve, publish or send anything.`,
                  confirmLabel: 'Turn on'
                })
                if (!ok) return
              }
              await window.api.aiSpace.updateProject(p.id, { authority: { ...p.authority, draftRevisions: on } })
              announce(on ? 'Automatic drafts are on for this project.' : 'Automatic drafts are off.')
              await onRefresh()
            }}
          />
          <span>
            Let agents draft fixes on their own
            <span className="block text-[12px] text-[var(--ink-50)]">Off by default. When on: after an approved change, agents draft new versions of work that used the old input, at most {p.authority.maxAutoFollowUps} per change. Each draft is an AI call on this project’s model. Approving, publishing and sending always wait for you.</span>
          </span>
        </label>
      </div>
    </Section>
  )
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

function TasksPanel({ view, onInspect, onRefresh }: { view: ProjectViewData; onInspect: (t: InspectTarget) => void; onRefresh: () => Promise<void> }): JSX.Element {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<OutputKind | ''>('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const roots = view.tasks.filter((t) => !t.parentTaskId)
  const children = (id: string) => view.tasks.filter((t) => t.parentTaskId === id)
  const flat = roots.flatMap((r) => [r, ...children(r.id)])

  async function add(): Promise<void> {
    if (!title.trim()) return
    await window.api.aiSpace.createTask({ projectId: view.project.id, title: title.trim(), deliverableKind: kind || null })
    setTitle('')
    announce('Task added.')
    await onRefresh()
  }
  async function move(t: AiTask, dir: -1 | 1): Promise<void> {
    const sibs = view.tasks.filter((x) => x.parentTaskId === t.parentTaskId)
    const i = sibs.findIndex((x) => x.id === t.id)
    const other = sibs[i + dir]
    if (!other) return
    const swap = async (a: AiTask, b: AiTask): Promise<void> => {
      await window.api.aiSpace.updateTask(a.id, { sortOrder: b.sortOrder })
      await window.api.aiSpace.updateTask(b.id, { sortOrder: a.sortOrder })
      await onRefresh()
    }
    await swap(t, other)
    useActionHistory.getState().recordWithToast({ label: `Move “${t.title}”`, toastIcon: 'swap_vert', undo: () => swap({ ...t, sortOrder: other.sortOrder }, { ...other, sortOrder: t.sortOrder }), redo: () => swap(t, other) })
    announce(`Moved “${t.title}” ${dir < 0 ? 'up' : 'down'}.`)
  }
  async function dropOn(target: AiTask): Promise<void> {
    const t = view.tasks.find((x) => x.id === dragId)
    setDragId(null)
    setOverId(null)
    if (!t || t.id === target.id) return
    if (target.parentTaskId === t.parentTaskId) {
      // Reorder within the same level: place before the target.
      const before = t.sortOrder
      const after = target.sortOrder - 0.5
      await window.api.aiSpace.updateTask(t.id, { sortOrder: after })
      useActionHistory.getState().recordWithToast({
        label: `Move “${t.title}”`,
        toastIcon: 'swap_vert',
        undo: async () => {
          await window.api.aiSpace.updateTask(t.id, { sortOrder: before })
          await onRefresh()
        },
        redo: async () => {
          await window.api.aiSpace.updateTask(t.id, { sortOrder: after })
          await onRefresh()
        }
      })
      announce(`Moved “${t.title}”.`)
    } else {
      // Changing where a task lives changes its dependencies: confirm first.
      const ok = await confirmDialog({ title: 'Make it a subtask?', body: `“${t.title}” becomes part of “${target.title}”.`, confirmLabel: 'Make subtask' })
      if (!ok) return
      await window.api.aiSpace.updateTask(t.id, { parentTaskId: target.id })
    }
    await onRefresh()
  }

  return (
    <div className="max-w-5xl" data-testid="ais-tasks">
      <form
        className="flex flex-wrap gap-2 mb-4"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <input aria-label="New task" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task (e.g. Draft the site hero)" className="fb-field flex-1 min-w-[220px] h-9 rounded-lg px-3 text-[14px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]" data-testid="ais-task-new" />
        <select aria-label="Deliverable type" value={kind} onChange={(e) => setKind(e.target.value as OutputKind | '')} className="fb-field h-9 rounded-lg px-2 text-[13px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]">
          <option value="">No deliverable</option>
          {OUTPUT_KINDS.map((k) => (
            <option key={k} value={k}>
              {OUTPUT_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <PrimaryButton type="submit" testId="ais-task-add">
          Add task
        </PrimaryButton>
      </form>
      {flat.length === 0 ? (
        <EmptyState icon="checklist" title="No tasks yet" body="A task names an outcome. It can have several runs, depend on other tasks, and wait for your review." />
      ) : (
        <ul className="fb-card divide-y divide-[var(--edge-hairline)]" aria-label="Tasks">
          {flat.map((t) => {
            const sub = Boolean(t.parentTaskId)
            const deps = t.dependsOn.map((d) => view.tasks.find((x) => x.id === d)?.title).filter(Boolean)
            return (
              <li
                key={t.id}
                draggable
                onDragStart={(e: DragEvent) => {
                  setDragId(t.id)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e: DragEvent) => {
                  if (!dragId || dragId === t.id) return
                  e.preventDefault()
                  setOverId(t.id)
                }}
                onDragLeave={() => setOverId((o) => (o === t.id ? null : o))}
                onDrop={(e: DragEvent) => {
                  e.preventDefault()
                  void dropOn(t)
                }}
                onDragEnd={() => {
                  setDragId(null)
                  setOverId(null)
                }}
                className={`relative px-4 py-2.5 grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 items-center ${sub ? 'pl-10' : ''} ${dragId === t.id ? 'opacity-40' : ''}`}
                data-testid="ais-task-row"
              >
                {overId === t.id && <span className="absolute -top-px left-0 right-0 h-0.5 bg-[rgb(var(--accent))]" aria-hidden />}
                {overId === t.id && (
                  <span className="absolute right-3 -top-3 text-[11px] px-1.5 rounded bg-[rgb(var(--accent))] text-white" aria-hidden>
                    {view.tasks.find((x) => x.id === dragId)?.parentTaskId === t.parentTaskId ? 'Move' : 'Make subtask'}
                  </span>
                )}
                <select
                  aria-label={`Status of ${t.title}`}
                  value={t.status}
                  onChange={async (e) => {
                    await window.api.aiSpace.updateTask(t.id, { status: e.target.value as AiTask['status'] })
                    await onRefresh()
                  }}
                  className="fb-field h-8 rounded-lg px-1.5 text-[12.5px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]"
                >
                  {(['todo', 'in_progress', 'waiting', 'awaiting_review', 'done', 'blocked'] as const).map((s) => (
                    <option key={s} value={s}>
                      {s.replace('_', ' ')}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => onInspect({ kind: 'task', id: t.id })} className="min-w-0 text-left rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]">
                  <span className="block text-[14px] truncate">{t.title}</span>
                  <span className="block text-[12px] text-[var(--ink-50)] truncate">
                    {t.deliverableKind ? OUTPUT_KIND_LABEL[t.deliverableKind] : 'No deliverable'}
                    {t.assignee ? ` · ${view.agents.find((a) => a.id === t.assignee)?.name ?? t.assignee}` : ''}
                    {t.scheduledAt ? ` · ${fmtWhen(t.scheduledAt)}` : ''}
                    {deps.length ? ` · after ${deps.join(', ')}` : ''}
                  </span>
                </button>
                <span className="flex items-center gap-1">
                  <QuietButton ariaLabel={`Move ${t.title} up`} icon="arrow_upward" onClick={() => void move(t, -1)}>
                    <span className="sr-only">Up</span>
                  </QuietButton>
                  <QuietButton ariaLabel={`Move ${t.title} down`} icon="arrow_downward" onClick={() => void move(t, 1)}>
                    <span className="sr-only">Down</span>
                  </QuietButton>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-2 text-[12px] text-[var(--ink-50)]">Drag to reorder, or use the arrows. Dropping a task onto another one makes it a subtask after you confirm.</p>
    </div>
  )
}

function TaskBody({ id, view, onInspect, onRefresh }: { id: string; view: ProjectViewData; onInspect: (t: InspectTarget) => void; onRefresh: () => Promise<void> }): JSX.Element {
  const t = view.tasks.find((x) => x.id === id)
  if (!t) return <p className="text-[13px] text-[var(--ink-60)]">This task is gone.</p>
  const runs = view.runs.filter((r) => r.aiTaskId === t.id)
  const outputs = view.outputs.filter((o) => o.aiTaskId === t.id)
  return (
    <div className="space-y-4 text-[13.5px]" data-testid="ais-task-inspector">
      <StatusBadge status={t.status} />
      {t.outcome && <p className="whitespace-pre-wrap">{t.outcome}</p>}
      <label className="block">
        <span className="text-[12px] text-[var(--ink-50)]">Assigned to</span>
        <select
          value={t.assignee ?? ''}
          onChange={async (e) => {
            await window.api.aiSpace.updateTask(t.id, { assignee: e.target.value || null })
            await onRefresh()
          }}
          className="mt-1 fb-field w-full h-9 rounded-lg px-2 bg-[var(--surface-sunken)] border border-[var(--edge-soft)]"
        >
          <option value="">Nobody</option>
          <option value="user">You</option>
          {view.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.role})
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-[12px] text-[var(--ink-50)]">Waits for</span>
        <select
          multiple
          value={t.dependsOn}
          onChange={async (e) => {
            const picked = [...e.target.selectedOptions].map((o) => o.value)
            try {
              await window.api.aiSpace.setTaskDeps(t.id, picked)
            } catch (err) {
              announce(err instanceof Error ? err.message : String(err))
            }
            await onRefresh()
          }}
          className="mt-1 fb-field w-full min-h-[80px] rounded-lg px-2 bg-[var(--surface-sunken)] border border-[var(--edge-soft)]"
        >
          {view.tasks.filter((x) => x.id !== t.id).map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </select>
      </label>
      {outputs.length > 0 && (
        <div>
          <p className="text-[12px] text-[var(--ink-50)] mb-1">Outputs</p>
          {outputs.map((o) => (
            <LinkButton key={o.id} onClick={() => onInspect({ kind: 'output', id: o.id })}>
              {o.title}
            </LinkButton>
          ))}
        </div>
      )}
      {runs.length > 0 && (
        <div>
          <p className="text-[12px] text-[var(--ink-50)] mb-1">Runs</p>
          <ul className="space-y-1">
            {runs.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => onInspect({ kind: 'run', id: r.id })} className="flex items-center gap-2 text-left">
                  <StatusBadge status={r.status} />
                  <span className="text-[12px] text-[var(--ink-50)]">{fmtAgo(r.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function DecisionBody({ id, view, onRefresh }: { id: string; view: ProjectViewData; onRefresh: () => Promise<void> }): JSX.Element {
  const d = view.decisions.find((x) => x.id === id)
  if (!d) return <p className="text-[13px] text-[var(--ink-60)]">This decision is gone.</p>
  return (
    <div className="space-y-3 text-[13.5px]" data-testid="ais-decision-inspector">
      <StatusBadge status={d.status} />
      <p>
        <span className="text-[var(--ink-50)]">Value: </span>
        {d.value}
        {d.previousValue ? <span className="text-[var(--ink-50)]"> (was {d.previousValue})</span> : null}
      </p>
      {d.decidedAt && <p className="text-[12px] text-[var(--ink-50)]">Decided {fmtWhen(d.decidedAt)} by {authorLabel(d.decidedBy ?? '')}</p>}
      {d.evidence.length > 0 && <p className="text-[12.5px] text-[var(--ink-60)]">Evidence: {d.evidence.map((e) => e.label ?? e.type).join(', ')}</p>}
      {d.status === 'open' && (
        <div className="flex gap-2">
          <PrimaryButton
            onClick={async () => {
              await window.api.aiSpace.approveDecision(d.id)
              announce('Decision approved. Impact shows what it affects.')
              await onRefresh()
            }}
            testId="ais-decision-approve"
          >
            Approve
          </PrimaryButton>
          <QuietButton
            onClick={async () => {
              await window.api.aiSpace.resolveDecision(d.id, 'rejected')
              await onRefresh()
            }}
          >
            Reject
          </QuietButton>
        </div>
      )}
      <p className="text-[12px] text-[var(--ink-50)]">Only a person approves a decision. Agents can propose; they can’t decide.</p>
    </div>
  )
}

function SourceBody({ id, view }: { id: string; view: ProjectViewData }): JSX.Element {
  const s = view.sources.find((x) => x.id === id)
  if (!s) return <p className="text-[13px] text-[var(--ink-60)]">This source isn’t in the project.</p>
  return (
    <div className="space-y-3 text-[13.5px]" data-testid="ais-source-inspector">
      <p className="text-[12px] text-[var(--ink-50)]">
        {s.kind === 'import' ? 'Imported' : s.kind === 'tool_result' ? 'Tool result' : s.kind === 'app_api' ? 'From an app' : 'Added'} {fmtWhen(s.capturedAt)}
        {s.provider ? ` · ${s.provider}` : ''} · untrusted material
      </p>
      {s.url && (
        <LinkButton onClick={() => void window.api.aiSpace.openOriginal(s.url!)}>
          Open the original
        </LinkButton>
      )}
      <pre className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink-90)] font-sans">{s.content}</pre>
    </div>
  )
}

function RequestBody({ id, view, onRefresh }: { id: string; view: ProjectViewData; onRefresh: () => Promise<void> }): JSX.Element {
  const r = view.requests.find((x) => x.id === id)
  if (!r) return <p className="text-[13px] text-[var(--ink-60)]">This request is gone.</p>
  const src = r.suppliedSourceId ? view.sources.find((s) => s.id === r.suppliedSourceId) : null
  return (
    <div className="space-y-3 text-[13.5px]">
      <p>
        <span className="text-[var(--ink-50)]">{authorLabel(r.requestedBy)} asked: </span>“{r.question}”
      </p>
      {r.canProceed && <p className="text-[12.5px] text-[var(--ink-60)]">Can carry on meanwhile with: {r.canProceed}</p>}
      {src ? <p>Answered by {src.title}{r.deliveredAt ? `, delivered ${fmtAgo(r.deliveredAt)}` : ''}.</p> : <p className="text-[var(--ink-60)]">Still open. A source that matches it is delivered automatically.</p>}
      {src && !r.deliveredAt && (
        <QuietButton onClick={async () => { await window.api.aiSpace.deliverRequest(r.id); await onRefresh() }}>Deliver now</QuietButton>
      )}
    </div>
  )
}

// ── The Project Manager pane (own history) ────────────────────────────────────

function ManagerPane({ project, view, onInspect }: { project: AiProject; view: ProjectViewData; onInspect: (t: InspectTarget) => void }): JSX.Element {
  const [data, setData] = useState<MessagesData | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLOListElement>(null)
  const hid = useId()
  const load = useCallback(async () => setData(await window.api.aiSpace.managerThread(project.id)), [project.id])
  useEffect(() => {
    void load()
    const off = window.api.aiSpace.onChanged((p) => {
      if (p.projectId === project.id) void load()
    })
    return off
  }, [load, project.id])
  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'end' })
  }, [data?.messages.length])
  async function send(): Promise<void> {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      const r = await window.api.aiSpace.askManager(project.id, t)
      setText('')
      if (!r.ok && r.reason) announce(r.reason)
      await load()
    } finally {
      setBusy(false)
    }
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void send()
    }
  }
  const mgr = view.agents.find((a) => a.role === 'manager')
  const conn = view.eligibleConnections.find((c) => c.id === (mgr?.connectionId ?? project.defaultConnectionId))
  return (
    <aside aria-labelledby={hid} className="w-[320px] shrink-0 border-l border-[var(--edge-soft)] bg-[var(--surface-raised)] flex flex-col" data-testid="ais-pm">
      <header className="px-4 pt-4 pb-2 border-b border-[var(--edge-hairline)]">
        <h2 id={hid} className="text-[15px] font-semibold">
          Project Manager
        </h2>
        <p className="text-[12px] text-[var(--ink-50)]">{conn ? `${conn.alias} · ${mgr?.model ?? project.defaultModel ?? ''}` : 'Answers from your records. Set a default model to chat.'}</p>
      </header>
      <ol ref={listRef} className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-3" aria-label="Conversation">
        {(data?.messages ?? []).length === 0 && <li className="text-[13px] text-[var(--ink-60)]">Ask what changed, what to do next, or to plan the work.</li>}
        {(data?.messages ?? []).filter((m) => m.role !== 'system').map((m) => (
          <li key={m.id} className={m.role === 'user' ? 'text-right' : ''}>
            <div className={`inline-block max-w-full text-left rounded-xl px-3 py-2 text-[13.5px] whitespace-pre-wrap ${m.role === 'user' ? 'bg-[rgb(var(--accent)/0.10)]' : 'bg-[var(--surface-sunken)]'}`}>{m.text}</div>
            <div className="mt-0.5 text-[11px] text-[var(--ink-50)]">
              {m.role === 'user' ? 'You' : m.author} · {fmtAgo(m.createdAt)}
              {m.runId && (
                <button type="button" onClick={() => onInspect({ kind: 'run', id: m.runId! })} className="ml-1.5 text-[rgb(var(--accent))] hover:underline">
                  run
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="p-3 border-t border-[var(--edge-hairline)]">
        <textarea aria-label="Message the Project Manager" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder="Message the Manager…" className="fb-field w-full min-h-[64px] rounded-lg px-3 py-2 text-[13.5px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)] resize-y" data-testid="ais-pm-text" />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11.5px] text-[var(--ink-50)]">
            <Kbd>⌘</Kbd> <Kbd>Enter</Kbd>
          </span>
          <PrimaryButton onClick={() => void send()} disabled={busy || !text.trim()} testId="ais-pm-send">
            Send
          </PrimaryButton>
        </div>
      </div>
    </aside>
  )
}

// ── Branches ──────────────────────────────────────────────────────────────────

// Main or a branch: new tasks and runs land where this points. A branch starts
// from a named snapshot of the brief and the current outputs.
function BranchPicker(props: { view: ProjectViewData; branchId: string | null; onPick: (id: string | null) => void; onReview: () => void; onCreated: (id: string) => Promise<void> }): JSX.Element {
  const open = props.view.branches.filter((b) => b.status === 'open')
  return (
    <span className="inline-flex items-center gap-2">
      <label className="inline-flex items-center gap-1.5 text-[13px] text-[var(--ink-60)]">
        <Icon name="call_split" size={15} />
        <span className="sr-only">Branch</span>
        <select
          value={props.branchId ?? ''}
          data-testid="ais-branch-picker"
          onChange={async (e) => {
            const v = e.target.value
            if (v === '__new') {
              const name = await promptText({ title: 'Start a branch', label: 'Name this direction (e.g. Bold headline)', confirmLabel: 'Start branch' })
              if (name && name.trim()) {
                const b = await window.api.aiSpace.createBranch(props.view.project.id, name.trim())
                announce(`Branch “${b.name}” started from the current brief and outputs.`)
                await props.onCreated(b.id)
              }
              return
            }
            props.onPick(v || null)
          }}
          className="fb-field h-8 rounded-lg px-2 text-[13px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]"
        >
          <option value="">Main</option>
          {open.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
          <option value="__new">New branch…</option>
        </select>
      </label>
      {open.length > 0 && (
        <QuietButton icon="compare" onClick={props.onReview} testId="ais-branch-review">
          Compare branches
        </QuietButton>
      )}
    </span>
  )
}

// ── Dialogs ───────────────────────────────────────────────────────────────────

function NewOutputDialog({ projectId, tasks, onClose, onCreated }: { projectId: string; tasks: AiTask[]; onClose: () => void; onCreated: (id: string) => void }): JSX.Element {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<OutputKind>('document')
  const [taskId, setTaskId] = useState('')
  const [content, setContent] = useState('')
  const head = useId()
  const field = 'fb-field w-full rounded-lg px-3 text-[14px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]'
  return (
    <Modal onClose={onClose} labelledById={head} testId="ais-new-output" className="fb-card w-[min(560px,94vw)]">
      <form
        className="p-5 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!title.trim()) return
          const o = await window.api.aiSpace.createOutput({ projectId, kind, title: title.trim(), aiTaskId: taskId || null, content })
          onCreated(o.id)
        }}
      >
        <h2 id={head} className="text-[18px] font-semibold">
          Add an output
        </h2>
        <input aria-label="Name" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name" className={`${field} h-10`} autoFocus />
        <div className="grid grid-cols-2 gap-2">
          <select aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value as OutputKind)} className={`${field} h-10`}>
            {OUTPUT_KINDS.map((k) => (
              <option key={k} value={k}>
                {OUTPUT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <select aria-label="Task" value={taskId} onChange={(e) => setTaskId(e.target.value)} className={`${field} h-10`}>
            <option value="">No task</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </div>
        <textarea aria-label="First version (optional)" value={content} onChange={(e) => setContent(e.target.value)} placeholder="Paste the first version (optional)" className={`${field} py-2 min-h-[120px]`} />
        <div className="flex justify-end gap-2">
          <QuietButton onClick={onClose}>Cancel</QuietButton>
          <PrimaryButton type="submit">Add output</PrimaryButton>
        </div>
      </form>
    </Modal>
  )
}

// ⌘⇧K inside AI Space: find or switch project.
function ProjectSwitcher({ currentId, onClose }: { currentId: string; onClose: () => void }): JSX.Element {
  const [q, setQ] = useState('')
  const [projects, setProjects] = useState<Array<{ project: AiProject; headline: string }>>([])
  const [i, setI] = useState(0)
  const head = useId()
  useEffect(() => {
    void window.api.aiSpace.home().then((h) => setProjects(h.projects.map((p) => ({ project: p.project, headline: p.headline }))))
  }, [])
  const list = useMemo(() => projects.filter((p) => !q.trim() || `${p.project.title} ${p.project.goal}`.toLowerCase().includes(q.trim().toLowerCase())), [projects, q])
  function go(p: AiProject): void {
    onClose()
    if (p.id !== currentId) openProject(p, { tab: 'overview' })
  }
  return (
    <Modal onClose={onClose} labelledById={head} testId="ais-switcher" className="fb-card w-[min(520px,94vw)]">
      <div className="p-4">
        <h2 id={head} className="sr-only">
          Find or switch project
        </h2>
        <input
          autoFocus
          aria-label="Find a project"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setI(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setI((n) => Math.min(list.length - 1, n + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setI((n) => Math.max(0, n - 1))
            } else if (e.key === 'Enter' && list[i]) {
              e.preventDefault()
              go(list[i].project)
            }
          }}
          placeholder="Find a project…"
          className="fb-field w-full h-11 rounded-lg px-3 text-[15px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${head}-list`}
          aria-activedescendant={list[i] ? `${head}-${list[i].project.id}` : undefined}
        />
        <ul id={`${head}-list`} role="listbox" className="mt-2 max-h-[50vh] overflow-auto">
          {list.map((p, n) => (
            <li key={p.project.id} id={`${head}-${p.project.id}`} role="option" aria-selected={n === i}>
              <button type="button" onClick={() => go(p.project)} className={`w-full text-left px-3 py-2 rounded-lg ${n === i ? 'bg-[rgb(var(--accent)/0.10)]' : 'hover:bg-[var(--surface-sunken)]'}`}>
                <span className="block text-[14px]">{p.project.title}{p.project.id === currentId ? ' (here)' : ''}</span>
                <span className="block text-[12px] text-[var(--ink-50)]">{p.headline}</span>
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="px-3 py-2 text-[13px] text-[var(--ink-60)]">No matching project.</li>}
        </ul>
      </div>
    </Modal>
  )
}

function ShortcutsSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const head = useId()
  const rows: Array<[string, string]> = [
    ['⌘K', 'Search and commands'],
    ['⌘⇧K', 'Find or switch project (inside AI Space)'],
    ['⌘ Enter', 'Send the focused draft'],
    ['Enter', 'Open the focused item, or show its evidence'],
    ['Esc', 'Close the topmost view and return focus'],
    ['⌘Z', 'Undo the last reversible workspace action'],
    ['?', 'Show these shortcuts']
  ]
  return (
    <Modal onClose={onClose} labelledById={head} testId="ais-shortcuts" className="fb-card w-[min(460px,94vw)]">
      <div className="p-5">
        <h2 id={head} className="text-[18px] font-semibold">
          AI Space shortcuts
        </h2>
        <dl className="mt-3 space-y-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center gap-3 text-[14px]">
              <dt className="w-24 shrink-0">
                <Kbd>{k}</Kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[12px] text-[var(--ink-50)]">Outside AI Space, ⌘⇧K keeps opening the Plexii hub. All Plexii shortcuts: ⌘/.</p>
      </div>
    </Modal>
  )
}

