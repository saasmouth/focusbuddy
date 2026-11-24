// AI Space Home (SPEC-AI-SPACE.md §1 Home, §7 "Return to work"): since your
// last visit, work needing you, active runs across projects, and a way to
// start or bring in work. Built so a person back after a day can name the
// current deliverable, why something changed and their next decision within
// 30 seconds: every project card carries those three lines.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../Icon'
import type { HomeData, CaptureResultData, SearchHitData } from '@shared/aispace/api'
import type { AiWorkspace } from '@shared/aispace/model'
import type { ImpactAction } from '@shared/aispace/impact'
import { OUTPUT_KIND_LABEL } from '@shared/aispace/model'
import { useViewStore } from '../../stores/view'
import { useNoticeStore } from '../../stores/notice'
import { useActionHistory } from '../../stores/actionHistory'
import { openProject, type DeskTab } from '../../lib/aiSpaceNav'
import { aiSpaceAvailable } from '../../lib/aiSpaceAvailable'
import NewProjectDialog from './NewProjectDialog'
import { Announcer, EmptyState, LinkButton, NewUpdatesBar, PrimaryButton, QuietButton, Section, StatusBadge, fmtAgo, fmtWhen, useOnRequestUpdates } from './ui'
import { promptText } from '../plexi/PromptDialog'

const KIND_ICON: Record<string, string> = {
  decision: 'gavel',
  review: 'rate_review',
  suggestion: 'lightbulb',
  uncertain_action: 'help',
  approval: 'approval',
  reconnect: 'link_off'
}

export default function AiSpaceHome(): JSX.Element {
  const [data, setData] = useState<HomeData | null>(null)
  const [ctx, setCtx] = useState<{ workspaces: AiWorkspace[]; active: string[] } | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const marked = useRef(false)

  const load = useCallback(async () => {
    // Desktop only: never call AI Space from the browser runtime or a share window.
    if (!aiSpaceAvailable()) return
    try {
      const [c, h] = await Promise.all([window.api.aiSpace.getContext(), window.api.aiSpace.home()])
      setCtx(c)
      setData(h)
      setError(null)
      // Opening Home moves "last visit" for next time; nothing is resolved by it.
      if (!marked.current) {
        marked.current = true
        void window.api.aiSpace.markHomeViewed()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const { pending, apply } = useOnRequestUpdates(load, (p) => p.topic === 'event' || p.topic === 'run' || p.topic === 'context')

  if (!aiSpaceAvailable()) {
    return <EmptyState icon="desktop_mac" title="AI Space is in the Plexii desktop app" body="Your AI projects and connections stay on your Mac, so they aren’t available here." testId="ais-home-unavailable" />
  }

  return (
    <div className="h-full w-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)] ais-touch" data-testid="ais-home">
      <Announcer />
      <NewUpdatesBar count={pending} onApply={apply} />
      <div className="max-w-5xl mx-auto px-6 pt-6 pb-16">
        <header className="flex flex-wrap items-end gap-3">
          <div className="min-w-0">
            <h1 className="text-[28px] font-semibold leading-tight">AI Space</h1>
            <p className="mt-1 text-[14px] text-[var(--ink-60)]">
              {data ? (data.firstVisit ? 'What your AI work is doing, what it affects, and what needs you.' : `Since your last visit${data.since ? `, ${fmtWhen(data.since)}` : ''}.`) : ' '}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <QuietButton icon="hub" onClick={() => useViewStore.getState().goConnections()} testId="ais-home-connections">
              Connections
            </QuietButton>
            <QuietButton icon="list_alt" onClick={() => useViewStore.getState().goAiRuns()} testId="ais-home-runs">
              Runs
            </QuietButton>
            <PrimaryButton onClick={() => setNewOpen(true)} testId="ais-home-new">
              <Icon name="add" size={16} />
              Start a project
            </PrimaryButton>
          </div>
        </header>
        {ctx && <ContextSwitcher ctx={ctx} onChange={async (ids) => {
          setCtx(await window.api.aiSpace.setContext(ids))
        }} onNewWorkspace={async () => {
          const name = await promptText({ title: 'New work workspace', label: 'Name (e.g. your company or a client)', confirmLabel: 'Create' })
          if (name && name.trim()) {
            await window.api.aiSpace.createWorkspace('work', name.trim())
            await load()
          }
        }} afterChange={load} />}
        {data && <p className="mt-2 text-[12px] text-[var(--ink-50)] inline-flex items-center gap-1"><Icon name="lock" size={13} />{data.storageNote}</p>}
        {error && (
          <p role="alert" className="mt-4 text-[13px] text-[color:var(--ais-bad)]">
            Couldn’t load AI Space: {error}
          </p>
        )}

        {!data && !error && <div className="mt-10 fb-skeleton h-40 rounded-xl" aria-busy="true" />}

        {data && data.projects.length === 0 && data.inbox.length === 0 && (
          <div className="mt-10 fb-card">
            <EmptyState icon="auto_awesome" title="Start your first AI project" body="Give it a goal and a brief. Ask AIs to work on it, leave, and come back to finished drafts and the decisions that need you." action={{ label: 'Start a project', run: () => setNewOpen(true), testId: 'ais-home-empty-new' }}>
              <p className="mt-3 text-[13px] text-[var(--ink-60)]">Or bring in a chat you already had, below.</p>
            </EmptyState>
          </div>
        )}

        {data && (data.updates.length > 0 || data.needsYou.length > 0) && (
          <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Section title={data.firstVisit ? 'What’s happening' : 'Since your last visit'} testId="ais-home-updates">
              {data.updates.length === 0 ? (
                <p className="text-[14px] text-[var(--ink-60)]">Nothing new across your projects.</p>
              ) : (
                <ol className="space-y-2">
                  {data.updates.slice(0, 8).map((u) => (
                    <li key={`${u.projectId}:${u.id}`} className="fb-card px-4 py-3" data-testid="ais-home-update">
                      <div className="flex items-center gap-2 text-[12px] text-[var(--ink-50)]">
                        <span className="truncate">{u.projectTitle}</span>
                        <span aria-hidden>·</span>
                        <span className="fb-tabular">{fmtAgo(u.at)}</span>
                      </div>
                      <p className="mt-1 text-[14.5px] font-medium">{u.text}</p>
                      {u.detail && <p className="mt-0.5 text-[14px] text-[var(--ink-70)]">{u.detail}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-3">
                        {u.action && (
                          <QuietButton onClick={() => runAction(u.projectId, data, u.action!)} testId="ais-home-update-action">
                            {u.action.label}
                          </QuietButton>
                        )}
                        {u.source && (
                          <LinkButton onClick={() => openTarget(u.projectId, data, u.source!.type === 'run' ? 'overview' : 'impact', u.source!)}>
                            Open source
                          </LinkButton>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Section>
            <Section title="Needs you" testId="ais-home-needs">
              {data.needsYou.length === 0 ? (
                <p className="text-[14px] text-[var(--ink-60)]">Nothing is waiting for you.</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.needsYou.slice(0, 10).map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        data-testid="ais-home-need"
                        onClick={() => {
                          if (n.target.type === 'connection') useViewStore.getState().goConnections(n.target.id)
                          else if (n.projectId) openTarget(n.projectId, data, n.kind === 'review' ? 'outputs' : 'impact', n.target)
                        }}
                        className="w-full text-left fb-card px-3.5 py-2.5 flex items-start gap-2.5 hover:bg-[var(--surface-sunken)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]"
                      >
                        <Icon name={KIND_ICON[n.kind] ?? 'flag'} size={17} className="mt-0.5 text-[color:var(--ais-warn)] shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-[14px]">{n.text}</span>
                          <span className="block text-[12px] text-[var(--ink-50)]">{n.projectTitle ?? 'Connections'} · {fmtAgo(n.since)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}

        {data && data.activeRuns.length > 0 && (
          <Section title="Active runs" aside={<LinkButton onClick={() => useViewStore.getState().goAiRuns()}>All runs</LinkButton>} testId="ais-home-runs-list">
            <ul className="fb-card divide-y divide-[var(--edge-hairline)]">
              {data.activeRuns.slice(0, 6).map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => useViewStore.getState().goAiRuns(r.id)} className="w-full text-left px-4 py-2.5 grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 items-center hover:bg-[var(--surface-sunken)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]">
                    <StatusBadge status={r.status} />
                    <span className="min-w-0">
                      <span className="block truncate text-[14px]">{r.title}</span>
                      <span className="block truncate text-[12px] text-[var(--ink-50)]">
                        {r.projectTitle} · {r.connectionAlias ?? 'No connection'}
                        {r.status === 'unavailable' || r.status === 'running' ? ` · ${r.lastConfirmedStep || 'Started'}${r.lastConfirmedAt ? ` (${fmtAgo(r.lastConfirmedAt)})` : ''}` : ''}
                      </span>
                    </span>
                    <span className="text-[12px] text-[var(--ink-50)] fb-tabular">{fmtAgo(r.startedAt ?? r.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {data && data.projects.length > 0 && (
          <Section title="Projects" testId="ais-home-projects">
            <ul className="grid gap-3 sm:grid-cols-2">
              {data.projects.map((pc) => {
                const ws = ctx?.workspaces.find((w) => w.id === pc.project.workspaceId)
                return (
                  <li key={pc.project.id}>
                    <button
                      type="button"
                      data-testid="ais-home-project"
                      onClick={() => openProject(pc.project, { tab: 'overview' })}
                      className="w-full h-full text-left fb-card px-4 py-3.5 hover:bg-[var(--surface-sunken)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-[15px] font-semibold truncate">{pc.project.title}</span>
                        {ws && <span className="ml-auto shrink-0 text-[11.5px] px-1.5 py-0.5 rounded-md border border-[var(--edge-soft)] text-[var(--ink-60)]">{ws.name}</span>}
                      </div>
                      <p className="mt-1 text-[13px] text-[var(--ink-60)]">{pc.headline}</p>
                      <dl className="mt-2.5 space-y-1 text-[13px]">
                        <div className="flex gap-2">
                          <dt className="text-[var(--ink-50)] w-[92px] shrink-0">Deliverable</dt>
                          <dd className="min-w-0 truncate">{pc.currentDeliverable ? `${pc.currentDeliverable.title} · ${OUTPUT_KIND_LABEL[pc.currentDeliverable.kind] ?? ''}` : 'None yet'}</dd>
                        </div>
                        {pc.currentDeliverable && (
                          <div className="flex gap-2">
                            <dt className="text-[var(--ink-50)] w-[92px] shrink-0">Why</dt>
                            <dd className="min-w-0 truncate">{pc.currentDeliverable.why}</dd>
                          </div>
                        )}
                        <div className="flex gap-2">
                          <dt className="text-[var(--ink-50)] w-[92px] shrink-0">Next</dt>
                          <dd className="min-w-0 truncate">{pc.nextStep?.text ?? 'Nothing waiting'}</dd>
                        </div>
                      </dl>
                      {pc.needs > 0 && (
                        <p className="mt-2 inline-flex items-center gap-1 text-[12px] text-[color:var(--ais-warn)]">
                          <Icon name="flag" size={13} />
                          {pc.needs} need{pc.needs === 1 ? 's' : ''} you
                        </p>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </Section>
        )}

        {data && data.projects.length > 0 && <SearchBox data={data} />}

        {data && <CaptureBox data={data} onDone={load} />}

        {data && data.sharedIn.length > 0 && (
          <Section title="Shared into this workspace" testId="ais-home-shared">
            <ul className="space-y-2">
              {data.sharedIn.map((s) => (
                <li key={s.shareId} className="fb-card px-4 py-3">
                  <p className="text-[14px] font-medium">
                    {s.title} <span className="text-[12px] text-[var(--ink-50)]">v{s.n} · pinned</span>
                  </p>
                  <p className="mt-1 text-[13px] text-[var(--ink-70)] line-clamp-3">{s.excerpt}</p>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
      {newOpen && <NewProjectDialog onClose={() => setNewOpen(false)} />}
    </div>
  )
}

function openTarget(projectId: string, data: HomeData, tab: DeskTab, target: { type: string; id: string; versionId?: string | null }): void {
  const p = data.projects.find((x) => x.project.id === projectId)?.project
  if (!p) return
  const item = ['output', 'task', 'run', 'decision', 'thread', 'source'].includes(target.type) ? { type: target.type as 'output', id: target.id, versionId: target.versionId ?? null } : null
  if (!openProject(p, { tab, item })) useNoticeStore.getState().show({ text: 'This project has no Desk yet.', icon: 'info' })
}

// A return-brief action from Home lands on the Desk's Impact view with the
// change open, where every action has its evidence beside it.
function runAction(projectId: string, data: HomeData, action: ImpactAction): void {
  const p = data.projects.find((x) => x.project.id === projectId)?.project
  if (!p) return
  if (action.target.type === 'connection') {
    useViewStore.getState().goConnections(action.target.id)
    return
  }
  const changeId = typeof action.payload?.changeId === 'string' ? action.payload.changeId : null
  openProject(p, { tab: action.id === 'review' ? 'outputs' : 'impact', item: action.target.type === 'output' || action.target.type === 'run' || action.target.type === 'decision' ? { type: action.target.type, id: action.target.id, versionId: action.target.versionId ?? null } : null, changeId })
}

function ContextSwitcher(props: { ctx: { workspaces: AiWorkspace[]; active: string[] }; onChange: (ids: string[]) => Promise<unknown>; onNewWorkspace: () => void; afterChange: () => Promise<void> }): JSX.Element {
  const all = props.ctx.workspaces.map((w) => w.id)
  const isAll = props.ctx.active.length === all.length
  const pick = async (ids: string[]): Promise<void> => {
    await props.onChange(ids)
    await props.afterChange()
  }
  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5" role="group" aria-label="Workspace you’re working in" data-testid="ais-context">
      {props.ctx.workspaces.length > 1 && (
        <ChipButton on={isAll} onClick={() => void pick(all)} label="All workspaces" />
      )}
      {props.ctx.workspaces.map((w) => (
        <ChipButton key={w.id} on={!isAll && props.ctx.active.includes(w.id)} onClick={() => void pick([w.id])} label={w.name} icon={w.kind === 'work' ? 'work' : 'person'} />
      ))}
      <button type="button" onClick={props.onNewWorkspace} className="h-8 px-2.5 rounded-lg text-[13px] text-[var(--ink-60)] hover:text-[var(--ink-100)] inline-flex items-center gap-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]" data-testid="ais-context-new">
        <Icon name="add" size={15} />
        Work workspace
      </button>
    </div>
  )
}

function ChipButton({ on, onClick, label, icon }: { on: boolean; onClick: () => void; label: string; icon?: string }): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`h-8 px-3 rounded-lg text-[13px] inline-flex items-center gap-1.5 border focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))] ${on ? 'border-[rgb(var(--accent)/0.45)] bg-[rgb(var(--accent)/0.10)] text-[rgb(var(--accent))]' : 'border-[var(--edge-soft)] text-[var(--ink-70)] hover:text-[var(--ink-100)]'}`}
    >
      {icon && <Icon name={icon} size={14} />}
      {label}
    </button>
  )
}

// Start and capture (§1): paste a chat link or the part of a chat you want.
// The original link and the capture time are kept; up to three matching
// projects are suggested, or it waits in the inbox.
function CaptureBox({ data, onDone }: { data: HomeData; onDone: () => Promise<void> }): JSX.Element {
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [result, setResult] = useState<CaptureResultData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const projects = useMemo(() => data.projects.map((p) => p.project), [data.projects])

  async function capture(): Promise<void> {
    setError(null)
    try {
      const r = await window.api.aiSpace.capture({ url: url.trim() || null, selectedText: text.trim() || null })
      setResult(r)
      setUrl('')
      setText('')
      await onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function file(threadId: string, projectId: string): Promise<void> {
    await window.api.aiSpace.fileThread(threadId, projectId)
    setResult(null)
    const title = projects.find((p) => p.id === projectId)?.title ?? 'the project'
    // Reversible: Undo moves it back to the inbox.
    useActionHistory.getState().recordWithToast({
      label: `File into ${title}`,
      toastIcon: 'drive_file_move',
      undo: async () => {
        await window.api.aiSpace.unfileThread(threadId)
        await onDone()
      },
      redo: async () => {
        await window.api.aiSpace.fileThread(threadId, projectId)
        await onDone()
      }
    })
    await onDone()
  }

  return (
    <Section title="Bring in work" testId="ais-home-capture">
      <div className="fb-card px-4 py-4">
        <p className="text-[13px] text-[var(--ink-60)]">Paste a chat link (ChatGPT, Claude, Gemini, Perplexity) to link it, and paste the part you want to keep to import it. Nothing is fetched from the chat: links open in your browser.</p>
        <div className="mt-3 grid gap-2">
          <input aria-label="Chat link" data-testid="ais-capture-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://chatgpt.com/c/…" className="fb-field w-full rounded-lg px-3 py-2 text-[14px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]" />
          <textarea aria-label="Selected text to import" data-testid="ais-capture-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the messages or output you want to keep (optional)" className="fb-field w-full min-h-[72px] rounded-lg px-3 py-2 text-[14px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)] resize-y" />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <PrimaryButton onClick={() => void capture()} disabled={!url.trim() && !text.trim()} testId="ais-capture-go">
            {text.trim() ? 'Import' : 'Link'}
          </PrimaryButton>
          {error && (
            <span role="alert" className="text-[13px] text-[color:var(--ais-bad)]">
              {error}
            </span>
          )}
        </div>
        {result && (
          <div className="mt-4 rounded-lg border border-[var(--edge-soft)] px-3 py-3" data-testid="ais-capture-result">
            <p className="text-[14px]">
              {result.thread.level === 'imported' ? 'Imported' : 'Linked'} “{result.thread.title}”{result.provider ? ` from ${result.provider.name}` : ''}, {fmtWhen(result.thread.capturedAt ?? result.thread.createdAt)}.
            </p>
            <p className="mt-2 text-[12px] text-[var(--ink-50)]">File it into:</p>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {result.suggestions.map((s) => (
                <QuietButton key={s.id} onClick={() => void file(result.thread.id, s.id)} title={s.why} testId="ais-capture-suggestion">
                  {s.title}
                </QuietButton>
              ))}
              {result.suggestions.length === 0 && projects.slice(0, 3).map((p) => (
                <QuietButton key={p.id} onClick={() => void file(result.thread.id, p.id)}>
                  {p.title}
                </QuietButton>
              ))}
              <QuietButton onClick={() => setResult(null)} testId="ais-capture-inbox">
                Keep in inbox
              </QuietButton>
            </div>
          </div>
        )}
        {data.inbox.length > 0 && (
          <div className="mt-5">
            <p className="text-[12px] text-[var(--ink-50)]">Inbox · not filed yet</p>
            <ul className="mt-1.5 space-y-1.5" data-testid="ais-inbox">
              {data.inbox.map((t) => (
                <li key={t.id} className="flex items-center gap-2 text-[14px]">
                  <Icon name={t.level === 'imported' ? 'download_done' : 'link'} size={15} className="text-[var(--ink-50)]" />
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="text-[12px] text-[var(--ink-50)] fb-tabular">{fmtAgo(t.capturedAt)}</span>
                  {projects.length > 0 && (
                    <select aria-label={`File “${t.title}” into a project`} defaultValue="" onChange={(e) => e.target.value && void file(t.id, e.target.value)} className="fb-field h-8 rounded-lg px-2 text-[13px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]">
                      <option value="">File into…</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Section>
  )
}

// Search across the workspaces you're working in (§1 Search): projects, chats,
// tasks, outputs and decisions, filtered by type, project or provider, each
// opened in its own context.
function SearchBox({ data }: { data: HomeData }): JSX.Element {
  const [q, setQ] = useState('')
  const [type, setType] = useState<'' | SearchHitData['type']>('')
  const [projectId, setProjectId] = useState('')
  const [provider, setProvider] = useState('')
  const [hits, setHits] = useState<SearchHitData[] | null>(null)
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setHits(null)
      return
    }
    const t = setTimeout(() => {
      void window.api.aiSpace.search(term, { type: type || undefined, projectId: projectId || undefined, provider: provider || undefined }).then(setHits)
    }, 160)
    return () => clearTimeout(t)
  }, [q, type, projectId, provider])
  const open = (h: SearchHitData): void => {
    const p = data.projects.find((x) => x.project.id === h.projectId)?.project
    if (!p) return
    if (h.type === 'task') openProject(p, { tab: 'tasks', item: { type: 'task', id: h.id } })
    else if (h.type === 'output') openProject(p, { tab: 'outputs', item: { type: 'output', id: h.id } })
    else if (h.type === 'decision') openProject(p, { tab: 'overview', item: { type: 'decision', id: h.id } })
    else openProject(p, { tab: 'overview' })
  }
  const field = 'fb-field h-9 rounded-lg px-2 text-[13px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)]'
  const ICON: Record<SearchHitData['type'], string> = { project: 'auto_awesome', task: 'checklist', thread: 'forum', output: 'description', decision: 'gavel' }
  return (
    <Section title="Search" testId="ais-home-search">
      <div className="flex flex-wrap gap-2">
        <input aria-label="Search AI Space" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects, chats, tasks, outputs and decisions" className={`${field} flex-1 min-w-[240px] px-3 text-[14px]`} data-testid="ais-search" />
        <select aria-label="Type" value={type} onChange={(e) => setType(e.target.value as '' | SearchHitData['type'])} className={field}>
          <option value="">Any type</option>
          <option value="project">Projects</option>
          <option value="thread">Chats</option>
          <option value="task">Tasks</option>
          <option value="output">Outputs</option>
          <option value="decision">Decisions</option>
        </select>
        <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className={field}>
          <option value="">Any project</option>
          {data.projects.map((p) => (
            <option key={p.project.id} value={p.project.id}>
              {p.project.title}
            </option>
          ))}
        </select>
        <select aria-label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)} className={field}>
          <option value="">Any provider</option>
          <option value="chatgpt_web">ChatGPT</option>
          <option value="claude_web">Claude</option>
          <option value="gemini_web">Gemini</option>
          <option value="perplexity_web">Perplexity</option>
        </select>
      </div>
      {hits && (
        <ul className="mt-3 fb-card divide-y divide-[var(--edge-hairline)]" aria-live="polite" data-testid="ais-search-results">
          {hits.length === 0 && <li className="px-4 py-3 text-[13.5px] text-[var(--ink-60)]">Nothing matches in the workspaces you’re working in.</li>}
          {hits.map((h) => (
            <li key={`${h.type}:${h.id}`}>
              <button type="button" onClick={() => open(h)} className="w-full text-left px-4 py-2.5 flex items-start gap-2.5 hover:bg-[var(--surface-sunken)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]">
                <Icon name={ICON[h.type]} size={16} className="mt-0.5 text-[var(--ink-50)]" />
                <span className="min-w-0">
                  <span className="block text-[14px]">{h.title}</span>
                  <span className="block text-[12px] text-[var(--ink-50)] truncate">
                    {h.projectTitle ?? 'Inbox'}
                    {h.snippet ? ` · ${h.snippet}` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
