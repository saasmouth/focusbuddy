import { useEffect, useMemo, useRef, useState } from 'react'
import MentionTextarea from '../MentionTextarea'
import { eligibleDestinations, destinationLabel } from '../../lib/agentDestination'
import { catalogFor } from '../../lib/widgetCatalog'
import type { Widget, WidgetKind } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import { useWidgetStore } from '../../stores/widgets'
import { useLinksStore } from '../../stores/links'
import {
  DEFAULT_AGENT,
  MIN_INTERVAL_SEC,
  parseAgent,
  serializeAgent,
  type AgentConfig,
  type AgentTrigger
} from '../../lib/deskAgent'
import { recommendProfileLocal, type ProfileSuggestion } from '../../lib/agentRecommend'
import { AGENT_JOBS } from '../../lib/agentJobs'
import ProposalCards from '../ProposalCards'
import type { AppliedProposal } from '@shared/types'
import { runAgent, useAgentRunStore } from '../../lib/deskAgentEngine'
import {
  allProfiles,
  resolveProfile,
  useAgentProfilesStore,
  type AgentProfile
} from '../../lib/agentProfiles'
import AgentProfileDialog from '../AgentProfileDialog'

// Desk agent — a standing AI worker on the canvas. Its inputs are the widgets
// wired INTO it; it runs its instruction over them and logs the result here.
//
// We keep only the EDITABLE fields in local state (instruction / trigger /
// interval / enabled) and render the run output + history straight from the
// widget content, which the engine writes. On save we merge our editable fields
// over the latest content so an in-flight run's log is never clobbered.

interface Props {
  widget: Widget
  inline?: boolean
}

type Editable = Pick<
  AgentConfig,
  'instruction' | 'trigger' | 'intervalSec' | 'enabled' | 'profileId' | 'destinationWidgetId' | 'destinationMode' | 'destinationAutoApply'
>

function editableOf(c: AgentConfig): Editable {
  return {
    instruction: c.instruction,
    trigger: c.trigger,
    intervalSec: c.intervalSec,
    enabled: c.enabled,
    profileId: c.profileId,
    destinationWidgetId: c.destinationWidgetId ?? null,
    destinationMode: c.destinationMode ?? 'append',
    destinationAutoApply: c.destinationAutoApply ?? false
  }
}

const TRIGGERS: Array<{ value: AgentTrigger; label: string; icon: string }> = [
  { value: 'manual', label: 'Manual', icon: 'play_circle' },
  { value: 'onChange', label: 'On change', icon: 'bolt' },
  { value: 'interval', label: 'Interval', icon: 'schedule' }
]

function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.round(m / 60)}h ago`
}

export default function AgentWidget({ widget }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const links = useLinksStore((s) => s.links)
  const widgets = useWidgetStore((s) => s.widgets)
  const running = useAgentRunStore((s) => s.running[widget.id] ?? false)
  const agentProposals = useAgentRunStore((s) => s.proposals[widget.id])
  const clearAgentProposals = useAgentRunStore((s) => s.clearProposals)
  const agentAttribution = useAgentRunStore((s) => s.attribution[widget.id])

  // What the user does with a proposal is the only real signal about whether
  // this agent is useful, and it was being thrown away: desk-agent runs recorded
  // no invocation, so there was nothing to attribute an outcome to. Best-effort
  // by design — a failure to record must never interfere with applying the
  // change the user actually asked for.
  const recordProposalOutcome = async (
    proposalId: string,
    action: 'applied' | 'dismissed'
  ): Promise<void> => {
    if (!agentAttribution) return
    const proposal = agentProposals?.find((p) => p.id === proposalId)
    if (!proposal) return
    try {
      await window.api.agents.recordOutcome({
        invocationId: agentAttribution.invocationId,
        agentSlug: agentAttribution.agentSlug,
        proposalId,
        proposalKind: proposal.kind,
        action
      })
    } catch (err) {
      console.warn('[AgentWidget] recordOutcome failed:', err)
    }
  }
  const [appliedProposals, setAppliedProposals] = useState<Record<string, AppliedProposal>>({})

  // Live config (output/history/lastError) read fresh each render.
  const cfg = parseAgent(widget.content)
  const [edit, setEdit] = useState<Editable>(() => editableOf(cfg))
  const lastSaved = useRef<string>(JSON.stringify(editableOf(cfg)))

  // Debounced save of editable fields, merged over the latest content.
  useEffect(() => {
    const snap = JSON.stringify(edit)
    if (snap === lastSaved.current) return
    const h = window.setTimeout(() => {
      lastSaved.current = snap
      const latest = parseAgent(
        useWidgetStore.getState().widgets.find((w) => w.id === widget.id)?.content
      )
      void update(widget.id, { content: serializeAgent({ ...latest, ...edit }) })
    }, 350)
    return () => window.clearTimeout(h)
  }, [edit, widget.id, update])

  // Adopt external edits to the editable fields (e.g. config changed elsewhere)
  // without disturbing what the user is typing right now.
  useEffect(() => {
    const incoming = JSON.stringify(editableOf(cfg))
    if (incoming !== lastSaved.current && incoming !== JSON.stringify(edit)) {
      lastSaved.current = incoming
      setEdit(editableOf(cfg))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.content])

  // Interval trigger — owned here so it only ticks while the widget is mounted.
  useEffect(() => {
    if (edit.trigger !== 'interval' || !edit.enabled) return
    const sec = Math.max(MIN_INTERVAL_SEC, edit.intervalSec)
    const h = window.setInterval(() => void runAgent(widget.id), sec * 1000)
    return () => window.clearInterval(h)
  }, [edit.trigger, edit.enabled, edit.intervalSec, widget.id])

  // The widgets wired INTO this agent (its inputs).
  const inputs = useMemo(() => {
    const ids = new Set(
      links.filter((l) => l.targetWidgetId === widget.id).map((l) => l.sourceWidgetId)
    )
    return widgets.filter((w) => ids.has(w.id) && !w.archived)
  }, [links, widgets, widget.id])

  // Widgets this agent FEEDS — its outgoing wires. A mirror wire out delivers
  // the agent's latest output into the target automatically after each run.
  const outputCount = useMemo(
    () => links.filter((l) => l.sourceWidgetId === widget.id).length,
    [links, widget.id]
  )

  const set = (patch: Partial<Editable>): void => setEdit((e) => ({ ...e, ...patch }))

  // Only widgets on THIS desk that can actually hold written output. Offering a
  // timer or a colour swatch as a destination would be offering nonsense.
  const allWidgets = useWidgetStore((st) => st.widgets)
  const destinations = eligibleDestinations(allWidgets, widget.taskId, widget.id)

  // "Add a … to this desk" — create the target and select it in one step, so
  // setting an agent up does not mean leaving it to go find the widget picker.
  async function createDestination(kind: WidgetKind): Promise<void> {
    const entry = catalogFor(kind)
    const created = await useWidgetStore.getState().create({
      taskId: widget.taskId,
      kind,
      title: widget.title ? `${widget.title} output` : 'Agent output',
      content: '',
      x: Math.round(widget.x + widget.width + 24),
      y: widget.y,
      width: entry?.defaultWidth,
      height: entry?.defaultHeight
    })
    set({ destinationWidgetId: created.id })
  }

  // ── Profile ("job description") ──────────────────────────────────────────
  const customProfiles = useAgentProfilesStore((s) => s.custom)
  const upsertProfile = useAgentProfilesStore((s) => s.upsert)
  const removeProfile = useAgentProfilesStore((s) => s.remove)
  const profile = resolveProfile(edit.profileId, customProfiles)
  const [profileMenu, setProfileMenu] = useState(false)
  const [profileDialog, setProfileDialog] = useState(false)
  const [profileQuery, setProfileQuery] = useState('')
  const allList = useMemo(() => allProfiles(customProfiles), [customProfiles])
  const profileList = useMemo(() => {
    const q = profileQuery.trim().toLowerCase()
    return q ? allList.filter((p) => `${p.name} ${p.blurb}`.toLowerCase().includes(q)) : allList
  }, [allList, profileQuery])

  // ── Intelligent agent suggestion (non-intrusive) ─────────────────────────
  const [suggestion, setSuggestion] = useState<ProfileSuggestion | null>(null)
  const dismissed = useRef<Set<string>>(new Set())
  const [specialist, setSpecialist] = useState<AgentProfile | null>(null)
  const [specialistBusy, setSpecialistBusy] = useState(false)

  // Recompute the instant, local suggestion shortly after the instruction
  // settles. Never blocks typing; only surfaces a clearly-better role.
  useEffect(() => {
    const h = window.setTimeout(() => {
      const instr = edit.instruction.trim()
      if (!instr || dismissed.current.has(instr)) {
        setSuggestion(null)
        return
      }
      const s = recommendProfileLocal(instr, edit.profileId, allList)
      setSuggestion(s && s.id !== edit.profileId ? s : null)
    }, 700)
    return () => window.clearTimeout(h)
  }, [edit.instruction, edit.profileId, allList])

  const dismissSuggestion = (): void => {
    const instr = edit.instruction.trim()
    if (instr) dismissed.current.add(instr)
    setSuggestion(null)
  }

  // Create a NEW agent with the chosen profile, wired into the SAME flows
  // (this agent's incoming + outgoing wires are replicated), placed beside it.
  async function addLinkedAgent(profileId: string, draft?: AgentProfile): Promise<void> {
    if (draft) upsertProfile(draft)
    const ls = useLinksStore.getState()
    const incoming = ls.links.filter((l) => l.targetWidgetId === widget.id)
    const outgoing = ls.links.filter((l) => l.sourceWidgetId === widget.id)
    const created = await useWidgetStore.getState().create({
      taskId: widget.taskId,
      kind: 'agent',
      title: widget.title || 'Agent',
      content: serializeAgent({
        ...DEFAULT_AGENT,
        instruction: edit.instruction,
        trigger: edit.trigger,
        destinationWidgetId: edit.destinationWidgetId ?? null,
        destinationMode: edit.destinationMode ?? 'append',
        destinationAutoApply: edit.destinationAutoApply ?? false,
        intervalSec: edit.intervalSec,
        enabled: edit.enabled,
        profileId
      }),
      x: widget.x + (widget.width || 340) + 40,
      y: widget.y,
      width: widget.width,
      height: widget.height,
      color: null
    })
    for (const l of incoming) {
      const link = await window.api.widgetLinks.create(l.sourceWidgetId, created.id, widget.taskId, l.type)
      if (link && l.verb) await window.api.widgetLinks.update(link.id, { verb: l.verb })
    }
    for (const l of outgoing) {
      const link = await window.api.widgetLinks.create(created.id, l.targetWidgetId, widget.taskId, l.type)
      if (link && l.verb) await window.api.widgetLinks.update(link.id, { verb: l.verb })
    }
    await ls.loadForTask(widget.taskId)
    setSuggestion(null)
    setSpecialist(null)
  }

  function replaceWithProfile(p: AgentProfile): void {
    upsertProfile(p)
    set({ profileId: p.id })
    setSpecialist(null)
    setSuggestion(null)
  }

  // AI path — design a brand-new specialist persona for this exact instruction.
  async function makeSpecialist(): Promise<void> {
    if (specialistBusy || !edit.instruction.trim()) return
    setSpecialistBusy(true)
    try {
      const res = await window.api.agents.designProfile(edit.instruction.trim())
      if (res.ok && res.name && res.systemPrompt) {
        setSpecialist({
          id: `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          name: res.name,
          blurb: res.blurb || 'Custom specialist',
          icon: 'psychology',
          systemPrompt: res.systemPrompt
        })
        setSuggestion(null)
      }
    } finally {
      setSpecialistBusy(false)
    }
  }

  const body = (
    <div
      className="h-full w-full flex flex-col bg-[var(--surface-raised)] text-[var(--ink-90)]"
      onMouseDown={(e) => e.stopPropagation()}
      data-testid="agent-widget"
    >
      {/* Profile selector — the agent's role / expertise. */}
      <div className="relative px-2.5 pt-2 pb-1.5 border-b border-[var(--edge-soft)]">
        <button
          onClick={() => setProfileMenu((v) => !v)}
          className="fb-tile w-full flex items-center gap-1.5 px-2 py-1 hover:border-accent/50 text-left"
          data-testid="agent-profile-button"
          title={profile.systemPrompt}
        >
          <Icon name={profile.icon} size={14} className="text-accent shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="block text-[11px] font-medium truncate">{profile.name}</span>
            <span className="block text-[9px] text-[var(--ink-50)] truncate">
              {profile.blurb}
            </span>
          </span>
          <Icon name="expand_more" size={14} className="text-[var(--ink-40)] shrink-0" />
        </button>
        {profileMenu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setProfileMenu(false)} />
            <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute left-2.5 right-2.5 top-full mt-1 z-20 max-h-64 overflow-y-auto py-1">
              <div className="sticky top-0 bg-[var(--surface-raised)] px-2 pb-1.5 pt-0.5 border-b border-[var(--edge-soft)]">
                <input
                  autoFocus
                  value={profileQuery}
                  onChange={(e) => setProfileQuery(e.target.value)}
                  placeholder="Search roles…"
                  className="w-full px-2 py-1 rounded bg-[var(--surface-sunken)] text-[11px] focus:outline-none focus:ring-1 focus:ring-accent"
                  data-testid="agent-profile-search"
                />
              </div>
              {profileList.map((p) => (
                <div
                  key={p.id}
                  className={`group flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-[var(--surface-sunken)] ${
                    p.id === profile.id ? 'bg-accent/10' : ''
                  }`}
                  onClick={() => {
                    set({ profileId: p.id })
                    setProfileMenu(false)
                  }}
                  data-testid={`agent-profile-option-${p.id}`}
                >
                  <Icon name={p.icon} size={14} className="text-accent shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium truncate">{p.name}</div>
                    <div className="text-[9px] text-[var(--ink-50)] truncate">{p.blurb}</div>
                  </div>
                  {!p.builtIn && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (edit.profileId === p.id) set({ profileId: undefined })
                        removeProfile(p.id)
                      }}
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-[var(--ink-40)] hover:text-red-600"
                      title="Delete profile"
                    >
                      <Icon name="delete" size={12} />
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={() => {
                  setProfileMenu(false)
                  setProfileDialog(true)
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 border-t border-[var(--edge-soft)] text-[11px] text-accent hover:bg-accent/5"
                data-testid="agent-profile-create"
              >
                <Icon name="add" size={14} />
                Create new profile…
              </button>
            </div>
          </>
        )}
      </div>

      {/* Instruction */}
      <div className="p-2.5 border-b border-[var(--edge-soft)]">
        {/* One-click jobs: shown while the instruction is empty so a new agent
            configures itself (instruction + persona + trigger) instead of facing
            a blank box. It stays disabled until the user turns it on. */}
        {!edit.instruction.trim() && (
          <div className="mb-2" data-testid="agent-jobs">
            <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--ink-50)] mb-1">
              Quick jobs
            </div>
            <div className="flex flex-wrap gap-1">
              {AGENT_JOBS.map((job) => (
                <button
                  key={job.id}
                  title={job.blurb}
                  data-testid={`agent-job-${job.id}`}
                  onClick={() =>
                    set({
                      instruction: job.instruction,
                      profileId: job.profileId,
                      trigger: job.trigger,
                      intervalSec: job.intervalSec ?? edit.intervalSec
                    })
                  }
                  className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-[var(--surface-sunken)] text-[11px] text-[var(--ink-70)] hover:text-[var(--ink-100)] hover:border-[rgb(var(--accent)/0.4)] transition-colors"
                >
                  <Icon name={job.icon} size={12} />
                  {job.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <MentionTextarea
          value={edit.instruction}
          onChange={(e) => set({ instruction: e.target.value })}
          placeholder="Standing instruction, e.g. keep a running summary of the wired notes"
          className="w-full h-12 resize-none bg-[var(--surface-sunken)] rounded-md px-2 py-1.5 text-[12px] leading-snug focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-[var(--ink-40)]"
          data-testid="agent-instruction"
        />
        <div className="mt-1.5 flex items-center gap-1 text-[10px] text-[var(--ink-50)]">
          <Icon name="cable" size={12} />
          <span data-testid="agent-input-count">
            {inputs.length === 0
              ? 'No inputs — wire widgets into this agent'
              : `${inputs.length} input${inputs.length === 1 ? '' : 's'}: ${inputs
                  .map((w) => w.title || w.kind)
                  .slice(0, 3)
                  .join(', ')}${inputs.length > 3 ? '…' : ''}`}
          </span>
          {outputCount > 0 && (
            <span className="inline-flex items-center gap-0.5 text-accent" data-testid="agent-output-count">
              <Icon name="arrow_forward" size={11} />
              feeds {outputCount}
            </span>
          )}
        </div>

        {/* Intelligent suggestion — a better-fitting existing role. */}
        {suggestion && !specialist && (
          <div
            className="mt-2 flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/[0.06] px-2 py-1.5 text-[10px]"
            data-testid="agent-suggestion"
            data-suggested-id={suggestion.id}
          >
            <Icon name="tips_and_updates" size={13} className="text-accent shrink-0" />
            <span className="flex-1 min-w-0 truncate">
              Better fit: <span className="font-medium">{suggestion.name}</span>
            </span>
            <button
              onClick={() => {
                set({ profileId: suggestion.id })
                setSuggestion(null)
              }}
              className="px-1.5 py-0.5 rounded bg-accent text-white"
              data-testid="agent-suggestion-switch"
            >
              Switch
            </button>
            <button
              onClick={() => void addLinkedAgent(suggestion.id)}
              className="px-1.5 py-0.5 rounded border border-accent/50 text-accent"
              title="Create a new agent with this role, wired into the same flows"
              data-testid="agent-suggestion-add"
            >
              + linked
            </button>
            <button
              onClick={dismissSuggestion}
              className="text-[var(--ink-40)] hover:text-[var(--ink-70)] shrink-0"
              aria-label="Dismiss suggestion"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )}

        {/* A freshly-designed specialist persona — replace this agent or spin up
            a linked one. */}
        {specialist && (
          <div
            className="mt-2 rounded-md border border-accent/40 bg-accent/[0.06] px-2 py-1.5 text-[10px]"
            data-testid="agent-specialist"
          >
            <div className="flex items-center gap-1.5">
              <Icon name="psychology" size={13} className="text-accent shrink-0" />
              <span className="flex-1 min-w-0 font-medium truncate">{specialist.name}</span>
              <button onClick={() => setSpecialist(null)} className="text-[var(--ink-40)] hover:text-[var(--ink-70)]" aria-label="Dismiss">
                <Icon name="close" size={12} />
              </button>
            </div>
            <div className="text-[var(--ink-50)] mt-0.5">{specialist.blurb}</div>
            <div className="flex items-center gap-1.5 mt-1.5">
              <button
                onClick={() => replaceWithProfile(specialist)}
                className="px-1.5 py-0.5 rounded bg-accent text-white"
                data-testid="agent-specialist-replace"
              >
                Replace this agent
              </button>
              <button
                onClick={() => void addLinkedAgent(specialist.id, specialist)}
                className="px-1.5 py-0.5 rounded border border-accent/50 text-accent"
                data-testid="agent-specialist-add"
              >
                Create linked agent
              </button>
            </div>
          </div>
        )}

        {/* AI entry point — design a specialist for this exact instruction. */}
        {!specialist && edit.instruction.trim().length > 10 && (
          <button
            onClick={() => void makeSpecialist()}
            disabled={specialistBusy}
            className="mt-1.5 inline-flex items-center gap-1 text-[9px] text-[var(--ink-50)] hover:text-accent disabled:opacity-60"
            data-testid="agent-make-specialist"
          >
            <Icon name={specialistBusy ? 'hourglass_empty' : 'auto_awesome'} size={11} />
            {specialistBusy ? 'Designing…' : 'Design a specialist for this'}
          </button>
        )}
      </div>

      {/* Controls */}
      <div className="px-2.5 py-2 flex items-center gap-1.5 border-b border-[var(--edge-soft)]">
        <div className="grid grid-cols-3 gap-1 flex-1">
          {TRIGGERS.map((t) => (
            <button
              key={t.value}
              onClick={() => set({ trigger: t.value })}
              className={`flex items-center justify-center gap-1 py-1 rounded text-[10px] border transition-colors ${
                edit.trigger === t.value
                  ? 'border-accent bg-accent/10 text-[var(--ink-100)]'
                  : 'border-[var(--edge-soft)] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
              }`}
              data-testid={`agent-trigger-${t.value}`}
              title={t.label}
            >
              <Icon name={t.icon} size={12} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Destination — where this agent's output goes.
          Wiring alone only told the model what FORMAT to write; it delivered
          nothing. Naming a destination here is what makes the result actually
          land somewhere, as a review card the user accepts. */}
      <div className="px-2.5 py-1.5 flex items-center gap-1.5 border-b border-[var(--edge-soft)]">
        <span className="text-[10px] text-[var(--ink-50)] shrink-0">Write to</span>
        <select
          value={edit.destinationWidgetId ?? ''}
          onChange={(e) => {
            const v = e.target.value
            if (v.startsWith('new:')) void createDestination(v.slice(4) as WidgetKind)
            else set({ destinationWidgetId: v || null })
          }}
          className="flex-1 min-w-0 bg-transparent border border-[var(--edge-soft)] rounded px-1.5 py-1 text-[10px] text-[var(--ink-90)]"
          data-testid="agent-destination"
        >
          <option value="">Nowhere — just show the result</option>
          {destinations.map((d) => (
            <option key={d.id} value={d.id}>
              {destinationLabel(d)}
            </option>
          ))}
          <option disabled>──────────</option>
          <option value="new:page">Add a Page to this desk…</option>
          <option value="new:markdown">Add a Markdown note…</option>
          <option value="new:note">Add a Note…</option>
          <option value="new:table">Add a Table…</option>
        </select>
        {edit.destinationWidgetId && (
          <button
            onClick={() =>
              set({ destinationMode: edit.destinationMode === 'replace' ? 'append' : 'replace' })
            }
            className="shrink-0 text-[10px] px-1.5 py-1 rounded border border-[var(--edge-soft)] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
            data-testid="agent-destination-mode"
            title={
              edit.destinationMode === 'replace'
                ? 'Each run replaces what is there'
                : 'Each run adds to what is there'
            }
          >
            {edit.destinationMode === 'replace' ? 'replace' : 'append'}
          </button>
        )}
      </div>
      {edit.destinationWidgetId && (
        <div className="px-2.5 pb-1.5 -mt-0.5">
          <label className="flex items-center gap-1.5 text-[10px] text-[var(--ink-60)] cursor-pointer">
            <input
              type="checkbox"
              checked={edit.destinationAutoApply ?? false}
              onChange={(e) => set({ destinationAutoApply: e.target.checked })}
              data-testid="agent-destination-auto"
            />
            {/* The review card is worth keeping when the write is a surprise.
                Once a destination is named, it is not — so this is offered,
                and left off by default because an interval agent writing
                unattended is the case that needs the extra beat. */}
            Write without asking me first
          </label>
        </div>
      )}

      <div className="px-2.5 py-1.5 flex items-center gap-2 border-b border-[var(--edge-soft)]">
        {edit.trigger === 'interval' && (
          <label className="flex items-center gap-1 text-[10px] text-[var(--ink-70)]">
            every
            <input
              type="number"
              min={MIN_INTERVAL_SEC}
              value={edit.intervalSec}
              onChange={(e) =>
                set({ intervalSec: Math.max(MIN_INTERVAL_SEC, Number(e.target.value) || MIN_INTERVAL_SEC) })
              }
              className="fb-field w-12 px-1 py-0.5 text-[10px]"
              data-testid="agent-interval"
            />
            s
          </label>
        )}
        <label className="flex items-center gap-1 text-[10px] text-[var(--ink-70)] cursor-pointer">
          <input
            type="checkbox"
            checked={edit.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
            className="accent-accent"
            data-testid="agent-enabled"
          />
          Active
        </label>
        <div className="flex-1" />
        <button
          onClick={() => void runAgent(widget.id)}
          disabled={running}
          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-accent text-white text-[10px] disabled:opacity-60"
          data-testid="agent-run"
        >
          <Icon name={running ? 'hourglass_empty' : 'play_arrow'} size={12} />
          {running ? 'Running…' : 'Run'}
        </button>
      </div>

      {/* Output / status */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2.5">
        {cfg.lastError ? (
          <div
            className="text-[11px] text-red-600 dark:text-red-400 flex items-start gap-1"
            data-testid="agent-error"
          >
            <Icon name="error" size={13} className="mt-0.5 shrink-0" />
            <span>{cfg.lastError}</span>
          </div>
        ) : cfg.lastOutput ? (
          <div className="text-[12px] leading-relaxed whitespace-pre-wrap" data-testid="agent-output">
            {cfg.lastOutput}
          </div>
        ) : (
          <div className="text-[11px] text-[var(--ink-40)]" data-testid="agent-output">
            {running ? 'Thinking…' : 'No output yet. Wire in some inputs, give an instruction, then Run.'}
          </div>
        )}
        {/* Review-before-apply: concrete changes the agent proposed this run
            (set a cell, add a row, update a note, draft mail). Nothing is applied
            until the user confirms each card. */}
        {agentProposals && agentProposals.length > 0 && (
          <div className="mt-2 pt-2 border-t border-[var(--edge-soft)]" data-testid="agent-proposals">
            <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--ink-50)] mb-1">
              Proposed changes
            </div>
            <ProposalCards
              proposals={agentProposals}
              activeTaskId={widget.taskId}
              appliedProposals={appliedProposals}
              onApplied={(id, applied) => {
                setAppliedProposals((m) => ({ ...m, [id]: applied }))
                void recordProposalOutcome(id, 'applied')
              }}
              onConsume={(id) => {
                // A card leaves the list either because it was applied (already
                // recorded above) or because the user dismissed it. Both are
                // signal; only the second is recorded here.
                if (!appliedProposals[id]) void recordProposalOutcome(id, 'dismissed')
                const remaining = agentProposals.filter((p) => p.id !== id)
                if (remaining.length === 0) clearAgentProposals(widget.id)
                else useAgentRunStore.getState().setProposals(widget.id, remaining)
              }}
            />
          </div>
        )}
      </div>

      {/* Footer: last run + tiny history */}
      <div className="px-2.5 py-1 border-t border-[var(--edge-soft)] flex items-center justify-between text-[9px] text-[var(--ink-40)]">
        <span data-testid="agent-status">
          {running ? 'running' : cfg.lastRunAt ? `ran ${timeAgo(cfg.lastRunAt)}` : 'never run'}
        </span>
        <span>{cfg.history.length > 0 ? `${cfg.history.length} run${cfg.history.length === 1 ? '' : 's'} logged` : ''}</span>
      </div>
    </div>
  )

  return (
    <>
      <WidgetFrame widget={widget} headerLabel="agent" headerAccent="bg-accent/20">
        {body}
      </WidgetFrame>
      {profileDialog && (
        <AgentProfileDialog
          onClose={() => setProfileDialog(false)}
          onSave={(p: AgentProfile) => {
            upsertProfile(p)
            set({ profileId: p.id })
            setProfileDialog(false)
          }}
        />
      )}
    </>
  )
}
