import { useEffect, useRef, useState } from 'react'
import type { ActionProposal, AppliedProposal } from '@shared/types'
import { useActionHistory } from '../stores/actionHistory'
import { applyProposal, describeProposal, ensureDependencies } from '../lib/actionExecutor'
import ProposalPreview from './assistant/ProposalPreview'
import { useAgentLoop } from '../stores/agentLoop'
import { useNodeStore } from '../stores/nodes'
import { useViewStore } from '../stores/view'
import { resolveGoToTarget, goToTarget } from '../lib/goToTarget'
import { resolveProposalDesk } from '../lib/proposalDesk'
import {
  ensureAutonomy,
  mayApplyWithoutAsking,
  offersOneClickApply,
  manualModeNote,
  autoAppliedNote
} from '../lib/autonomyGate'
import type { ResolvedAutonomy } from '../lib/autonomyPolicy'
import Icon from './Icon'

// Proposal kinds that create content ON a desk canvas and therefore need an
// active desk. When the assistant proposes one of these off a desk (e.g. a table
// while you're in a document), we offer a place for it rather than dead-ending.
const DESK_KINDS = new Set<ActionProposal['kind']>([
  'create-widget',
  'create-table',
  'add-table-row',
  'create-field',
  'create-agent',
  'create-section',
  'create-todo-list',
  'create-page'
])

// Kinds whose result is a document that can live in Files instead of (or as well
// as) on a desk. create-document already lands in Files; generate-document can be
// routed there via the applier's toFiles mode instead of dropping a desk widget.
const FILE_KINDS = new Set<ActionProposal['kind']>(['create-document', 'generate-document'])

// Can this proposal be placed on a desk? Everything in DESK_KINDS, plus a
// generated document (which normally drops a desk widget).
function isDeskCapable(kind: ActionProposal['kind']): boolean {
  return DESK_KINDS.has(kind) || kind === 'generate-document'
}
function isFileCapable(kind: ActionProposal['kind']): boolean {
  return FILE_KINDS.has(kind)
}
// A card gets the "choose where" control only when there is a real choice to
// make — i.e. it can go on a desk (and so also possibly to Files). A files-only
// kind has one home, so its plain Apply already does the right thing.
function hasPlacementChoice(kind: ActionProposal['kind']): boolean {
  return isDeskCapable(kind)
}

// The word the Apply affordance shows WHILE a card is being applied, so a slow
// step reads as what it is instead of a bare "…". Generating a document can take
// several seconds; saying so is the whole point of this.
function busyVerb(kind: ActionProposal['kind']): string {
  if (kind === 'generate-document') return 'generating…'
  if (kind === 'create-document') return 'creating…'
  return '…'
}

// ── Inline action-proposal cards ────────────────────────────────────────────
//
// Each ActionProposal renders as a clickable card. On apply, the executor
// mutates the workspace; on success the card turns green (done) and STAYS in the
// thread as a durable record with an optional "Go to". Dismiss (×) removes an
// un-applied suggestion. Multiple cards can be applied; "Apply all" runs them.
//
// Placement: cards that create content can go somewhere other than the current
// desk. A "choose where" control opens an inline chooser (never a floating
// dropdown, so it can't get trapped under the overlay's stacking) offering: this
// desk, another desk, a new desk, or Files for a document. Clicking the card
// itself still applies to the sensible default.
//
// Store-agnostic: the applied-state + the mark-applied callback are passed in by
// the host surface, so the SAME component works for the in-memory side-panel
// assistant (useChatStore) AND the persisted Focus chat (useFocusChatStore).

interface ProposalCardsProps {
  proposals: ActionProposal[]
  activeTaskId: string | null
  // Optional destination folder for document-producing proposals (e.g. the
  // meeting wrap-up files deliverables into the meeting folder). Threaded to the
  // applier; ignored by proposals that don't create documents.
  destinationFolderId?: string | null
  // DEC-079 — provenance stamped on any create-work-item this surface applies
  // (the meeting wrap-up passes its meeting id; other hosts omit it). The
  // toFiles document path below deliberately omits it: it never files items.
  workItemSource?: { sourceType: string; sourceRef: string }
  // Applied-card state keyed by proposal id (from the host surface's store).
  // Omitted → no card is ever shown as applied (see onApplied).
  appliedProposals?: Record<string, AppliedProposal>
  // Record that a proposal was approved (the host persists / stores it).
  // Omitted → the card is consumed on success instead of kept as a record.
  onApplied?: (proposalId: string, applied: AppliedProposal) => void
  // Remove an un-applied suggestion (dismiss).
  onConsume: (proposalId: string) => void
  // Optional per-card Undo on an APPLIED card. The host performs the actual
  // reversal (e.g. deleting the created entity + recording an agent outcome) and
  // updates its applied-state. When provided, applied cards show an Undo button.
  // Distinct from the applyAll action-history batch — this is host-owned, per-card.
  onUndo?: (proposalId: string, applied: AppliedProposal) => void
}

const NO_APPLIED: Record<string, AppliedProposal> = {}

export default function ProposalCards({
  proposals,
  activeTaskId,
  destinationFolderId = null,
  workItemSource,
  appliedProposals = NO_APPLIED,
  onApplied,
  onConsume,
  onUndo
}: ProposalCardsProps): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<{ id: string; ok: boolean; message: string } | null>(
    null
  )
  // Per-card checkboxes (A4, AI-09 — R3): ticking a subset turns "Apply all"
  // into "Apply selected". Selection is presentation state on this group;
  // applied cards fall out of it naturally because only pending cards are
  // counted. Drag-box selection stays a canvas gesture, never a transcript one.
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  function toggleChecked(id: string): void {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // Run-lock: while an autonomous agent run is applying proposals into one shared
  // undo batch, a manual Apply here would fold into that batch (wrong attribution)
  // or race its applies. Disable manual apply for the duration of a run.
  const agentRunning = useAgentLoop((s) => s.running)

  // The operator's autonomy level governs what this card may offer. null means
  // "not resolved yet" and is deliberately NOT treated as permission: acting on
  // an unloaded policy is how a "Suggest only" setting ends up applying things.
  const [autonomy, setAutonomy] = useState<ResolvedAutonomy | null>(null)
  useEffect(() => {
    let alive = true
    void ensureAutonomy().then((r) => {
      if (alive) setAutonomy(r)
    })
    return () => {
      alive = false
    }
  }, [])
  // While the policy is still in flight, keep offering Apply. The asymmetry is
  // deliberate: the dangerous direction is ACTING on an unloaded policy, which
  // the auto-apply effect below refuses to do. Withholding the button is the
  // safe-looking choice that is actually worse — it blanks a control the user is
  // reaching for and makes their click a no-op for as long as the load takes,
  // which is the dead-control bug this pass exists to remove. A user clicking
  // Apply is the user doing the action, which even 'manual' permits; only the
  // one-click affordance goes away, and only once we KNOW the level is manual.
  const oneClick = autonomy === null || offersOneClickApply(autonomy.level)
  // Proposals this group has already applied on its own, so a re-render can
  // never apply one twice.
  const autoAppliedRef = useRef<Set<string>>(new Set())
  // How many this group applied on its own. 'auto' is "...on its own AND TELLS
  // YOU", so the count drives a standing line under the group — work done for
  // you that you were not told about is indistinguishable from work you did.
  const [autoAppliedCount, setAutoAppliedCount] = useState(0)

  // Placement chooser: the proposal(s) awaiting a destination. Opened either by
  // the per-card "choose where" control, or automatically when a desk-kind
  // proposal is applied with no active desk. Rendered inline (see the panel
  // below) rather than as a popover, so it can never be clipped or z-trapped.
  const [placeOffer, setPlaceOffer] = useState<ActionProposal[] | null>(null)
  const [newDeskName, setNewDeskName] = useState('')
  const desks = useNodeStore((s) => s.nodes).filter((n) => n.kind === 'task' && !n.archived)

  // resolvedIds threads newly-created entity ids (today: tables) through a
  // batch so a follow-up proposal (today: add-table-row) can reference what
  // an earlier one created via "$<proposalId>" symbolic refs. Held in a ref
  // so a per-card click survives outside of a single applyAll() loop.
  const batchResolvedIds = useRef<Map<string, string>>(new Map())

  // Single place the "what happens to a card once it succeeds" decision lives.
  // With an applied-state store the card becomes a durable green record with a
  // "Go to"; without one it is consumed, matching the pre-durable behaviour.
  function recordApplied(
    p: ActionProposal,
    message: string,
    resolvedIds: Map<string, string>
  ): void {
    if (onApplied) {
      onApplied(p.id, {
        message,
        target: resolveGoToTarget(p, resolvedIds),
        appliedAt: Date.now()
      })
    } else {
      onConsume(p.id)
    }
  }

  async function applyOne(
    p: ActionProposal,
    resolvedIds?: Map<string, string>
  ): Promise<void> {
    if (busy || agentRunning) return
    // DEC-032: a proposal that names its own desk applies THERE, with no
    // detour through the chooser — the operator's complaint was being asked
    // to pick a desk the assistant had already identified.
    const named = resolveProposalDesk(p, desks)
    const target = named ?? activeTaskId
    // A desk-capable proposal with no desk at all: offer a place rather than
    // dead-end. The chooser then applies it wherever the user picks.
    if (!target && isDeskCapable(p.kind)) {
      setPlaceOffer([p])
      return
    }
    const ids = resolvedIds ?? batchResolvedIds.current
    setBusy(p.id)
    // Resolve any not-yet-applied parent this proposal forward-references, via the
    // shared resolver (so this card path and the agent loop can never drift).
    const dep = await ensureDependencies(p, proposals, { activeTaskId: target, resolvedIds: ids, destinationFolderId })
    if (!dep.ok) {
      setBusy(null)
      setToast({ id: p.id, ok: false, message: dep.message })
      setTimeout(() => setToast((t) => (t?.id === p.id ? null : t)), 2800)
      return
    }
    for (const parent of dep.appliedParents) recordApplied(parent.proposal, parent.message, ids)
    // A canvas handler (or its store IPC) can throw rather than return a
    // failure envelope. Always clear busy and show an honest failure chip; the
    // card stays for a retry.
    let result: { ok: boolean; message: string }
    try {
      result = await applyProposal(p, { activeTaskId: target, resolvedIds: ids, destinationFolderId, workItemSource })
    } catch (err) {
      result = { ok: false, message: err instanceof Error ? err.message : 'Could not apply that action.' }
    }
    setBusy(null)
    if (result.ok) {
      recordApplied(p, result.message, ids)
    } else {
      setToast({ id: p.id, ok: false, message: result.message })
      setTimeout(() => setToast((t) => (t?.id === p.id ? null : t)), 2200)
    }
  }

  // Apply a batch: the whole pending group ("Apply all") or the ticked subset
  // ("Apply selected"). One undo entry either way.
  async function applyBatch(batch: ActionProposal[]): Promise<void> {
    if (busy || agentRunning) return
    // Only apply the ones not already done (applied cards stay as green records).
    const pending = batch.filter((p) => !appliedProposals[p.id])
    if (pending.length === 0) return
    // Off a desk, gather the desk-kind proposals and offer a place for them first.
    if (!activeTaskId) {
      // DEC-032: proposals that named their own desk are already placed; only
      // the genuinely homeless ones need the chooser.
      const deskPending = pending.filter(
        (p) => isDeskCapable(p.kind) && !resolveProposalDesk(p, desks)
      )
      if (deskPending.length > 0) {
        setPlaceOffer(deskPending)
        return
      }
    }
    // Confirm before a batch that destroys anything — undo exists as a backstop,
    // but a one-click bulk delete deserves a heads-up.
    const destructive = pending.filter((p) => p.kind === 'delete-widget')
    if (destructive.length > 0) {
      const ok = window.confirm(
        `This will delete ${destructive.length} item${destructive.length > 1 ? 's' : ''} from your canvas. You can undo it afterwards. Apply ${pending.length} change${pending.length > 1 ? 's' : ''}?`
      )
      if (!ok) return
    }
    const resolvedIds = batchResolvedIds.current
    // Coalesce the whole batch into one undo entry, so a single Cmd-Z (or the
    // toast's Undo) reverses the entire "Apply all".
    useActionHistory.getState().beginBatch()
    try {
      for (const p of pending) {
        // Sequential so error messages from one don't get clobbered by the
        // next, AND so symbolic-id refs resolve in order (create-table must
        // run before its add-table-row siblings).
        await applyOne(p, resolvedIds)
      }
    } finally {
      useActionHistory
        .getState()
        .endBatch(`Apply ${pending.length} AI change${pending.length > 1 ? 's' : ''}`)
    }
  }

  // Apply the offered proposals on a specific desk, then navigate there so the
  // user sees what was created. One undo batch for the lot.
  async function applyOnDesk(deskId: string): Promise<void> {
    const offered = placeOffer ?? []
    setPlaceOffer(null)
    setNewDeskName('')
    useViewStore.getState().goTask(deskId)
    const ids = batchResolvedIds.current
    useActionHistory.getState().beginBatch()
    try {
      for (const p of offered) {
        setBusy(p.id)
        try {
          const dep = await ensureDependencies(p, proposals, {
            activeTaskId: deskId,
            resolvedIds: ids,
            destinationFolderId
          })
          if (dep.ok) {
            for (const parent of dep.appliedParents) recordApplied(parent.proposal, parent.message, ids)
          }
          const result = await applyProposal(p, { activeTaskId: deskId, resolvedIds: ids, destinationFolderId, workItemSource })
          if (result.ok) recordApplied(p, result.message, ids)
          else setToast({ id: p.id, ok: false, message: result.message })
        } catch (err) {
          setToast({ id: p.id, ok: false, message: err instanceof Error ? err.message : 'Could not apply that action.' })
        }
      }
    } finally {
      setBusy(null)
      useActionHistory.getState().endBatch(`Add ${offered.length} to a desk`)
    }
  }

  // Save the offered document proposal(s) to Files, without dropping a desk
  // widget. Only file-capable kinds are ever offered this route (see the panel).
  async function applyToFiles(): Promise<void> {
    const offered = placeOffer ?? []
    setPlaceOffer(null)
    setNewDeskName('')
    const ids = batchResolvedIds.current
    useActionHistory.getState().beginBatch()
    try {
      for (const p of offered) {
        setBusy(p.id)
        try {
          const result = await applyProposal(p, {
            activeTaskId: null,
            resolvedIds: ids,
            destinationFolderId,
            toFiles: true
          })
          if (result.ok) recordApplied(p, result.message, ids)
          else setToast({ id: p.id, ok: false, message: result.message })
        } catch (err) {
          setToast({ id: p.id, ok: false, message: err instanceof Error ? err.message : 'Could not save to Files.' })
        }
      }
    } finally {
      setBusy(null)
      useActionHistory.getState().endBatch(`Add ${offered.length} to Files`)
    }
  }

  async function createDeskAndApply(): Promise<void> {
    const title = newDeskName.trim() || 'New desk'
    try {
      const desk = await useNodeStore.getState().create({ parentId: null, kind: 'task', title })
      await applyOnDesk(desk.id)
    } catch {
      setToast({ id: 'desk', ok: false, message: 'Could not create the desk.' })
    }
  }

  // Only the not-yet-applied proposals are candidates for "Apply all".
  const pendingProposals = proposals.filter((p) => !appliedProposals[p.id])
  const pendingCount = pendingProposals.length
  // The ticked subset (AI-09). Empty selection means the button applies all.
  const selectedProposals = pendingProposals.filter((p) => checked.has(p.id))
  const selectedCount = selectedProposals.length

  // 'auto' is "handles routine, low-risk work on its own and tells you, but
  // still asks before anything risky" — so at that level the low-risk half of
  // the group applies itself. One at a time, because applyOne holds a single
  // `busy` id and threads created ids through a shared resolvedIds map; firing
  // them together would race that map. Each pass applies one and the effect
  // re-runs when busy clears.
  //
  // Three things are deliberately NOT auto-applied: anything isAutoApplyable
  // calls consequential (the risk gate), anything already applied, and anything
  // that would need the placement chooser — being asked WHERE is a question for
  // a person, and silently picking a desk is not "low-risk".
  useEffect(() => {
    if (!autonomy || autonomy.level !== 'auto') return
    if (busy !== null || agentRunning || placeOffer) return
    const next = pendingProposals.find((p) => {
      if (autoAppliedRef.current.has(p.id)) return false
      if (!mayApplyWithoutAsking(autonomy.level, p)) return false
      const target = resolveProposalDesk(p, desks) ?? activeTaskId
      if (!target && isDeskCapable(p.kind)) return false
      return true
    })
    if (!next) return
    autoAppliedRef.current.add(next.id)
    setAutoAppliedCount((n) => n + 1)
    void applyOne(next)
    // applyOne and the desk list are stable enough for this to be driven by
    // what actually changes: the policy, the pending set, and the locks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autonomy, pendingProposals, busy, agentRunning, placeOffer, activeTaskId])

  // Which destination options the current chooser should show, from the kinds of
  // the offered proposals. Desk options appear when any can live on a desk; the
  // Files option appears only when EVERY offered proposal can go to Files, so it
  // never silently drops a desk-only sibling.
  const offerShowsDesk = (placeOffer ?? []).some((p) => isDeskCapable(p.kind))
  const offerShowsFiles = (placeOffer ?? []).length > 0 && (placeOffer ?? []).every((p) => isFileCapable(p.kind))
  const offerLabel =
    placeOffer && placeOffer.length === 1
      ? describeProposal(placeOffer[0]).subject
      : `these ${placeOffer?.length ?? 0}`

  return (
    <div className="ml-0 mr-auto max-w-[92%] flex flex-col gap-1">
      {placeOffer && (
        <div
          data-testid="desk-offer"
          className="fb-card bg-accent/5 p-2.5 flex flex-col gap-2"
        >
          <div className="fb-t-caption text-[var(--ink-80)] leading-snug">
            Where should <span className="font-medium">{offerLabel}</span> go?
          </div>
          {offerShowsDesk && activeTaskId && (
            <button
              onClick={() => void applyOnDesk(activeTaskId)}
              data-testid="place-this-desk"
              className="text-left rounded-[var(--radius-chip)] px-2 py-1 fb-t-label text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] flex items-center gap-2"
            >
              <Icon name="space_dashboard" size={13} className="text-accent shrink-0" />
              <span className="truncate">This desk</span>
            </button>
          )}
          {offerShowsFiles && (
            <button
              onClick={() => void applyToFiles()}
              data-testid="place-files"
              className="text-left rounded-[var(--radius-chip)] px-2 py-1 fb-t-label text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] flex items-center gap-2"
            >
              <Icon name="folder" size={13} className="text-accent shrink-0" />
              <span className="truncate">Add to Files</span>
            </button>
          )}
          {offerShowsDesk && (
            <>
              <div className="flex items-center gap-1.5">
                <input
                  value={newDeskName}
                  onChange={(e) => setNewDeskName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void createDeskAndApply()
                  }}
                  placeholder="New desk name"
                  data-testid="desk-offer-name"
                  className="flex-1 min-w-0 rounded-[var(--radius-chip)] border border-[var(--edge-soft)] bg-[var(--surface-base)] px-2 py-1 fb-t-label focus:outline-none focus:border-accent"
                />
                <button
                  onClick={() => void createDeskAndApply()}
                  data-testid="desk-offer-create"
                  className="fb-press shrink-0 rounded-[var(--radius-chip)] bg-[rgb(var(--accent))] text-white px-2.5 py-1 fb-t-caption font-medium hover:bg-[rgb(var(--accent-hover))]"
                >
                  New desk
                </button>
              </div>
              {desks.length > 0 && (
                <div className="flex flex-col gap-0.5 max-h-40 overflow-auto">
                  <div className="fb-t-caption uppercase tracking-wide text-[var(--ink-40)] px-0.5">
                    Or another desk
                  </div>
                  {desks.slice(0, 8).map((d) => (
                    <button
                      key={d.id}
                      onClick={() => void applyOnDesk(d.id)}
                      data-testid={`desk-offer-existing-${d.id}`}
                      className="text-left rounded-[var(--radius-chip)] px-2 py-1 fb-t-label text-[var(--ink-80)] hover:bg-[var(--surface-sunken)] flex items-center gap-2"
                    >
                      <Icon name="desktop_windows" size={13} className="text-[var(--ink-40)] shrink-0" />
                      <span className="truncate">{d.title || 'Untitled desk'}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <button
            onClick={() => setPlaceOffer(null)}
            className="fb-t-caption text-[var(--ink-50)] self-start hover:underline"
          >
            Cancel
          </button>
        </div>
      )}
      {proposals.map((p) => {
        const desc = describeProposal(p)
        const isBusy = busy === p.id
        const showToast = toast?.id === p.id
        const applied = appliedProposals[p.id]

        // ── Applied (done) card: green, kept as a durable record, with an
        //    optional "Go to". Not clickable-to-apply; never dismissed.
        if (applied) {
          return (
            <div
              key={p.id}
              data-testid={`proposal-card-applied-${p.id}`}
              className="fb-card bg-emerald-500/10 px-2.5 py-1.5"
            >
              <div className="flex items-center gap-2">
                <span className="h-6 w-6 rounded-[var(--radius-chip)] inline-flex items-center justify-center bg-emerald-500/15 text-emerald-500 shrink-0">
                  <Icon name="check" size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="fb-t-caption uppercase tracking-wider text-emerald-500/80">
                    {desc.verb} · done
                  </div>
                  <div className="fb-t-label font-medium text-[var(--ink-100)] truncate">
                    {desc.subject}
                  </div>
                  <div className="fb-t-caption text-emerald-500 mt-0.5 leading-snug">
                    {applied.message}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {onUndo && (
                    <button
                      onClick={() => onUndo(p.id, applied)}
                      title="Undo this"
                      data-testid={`proposal-undo-${p.id}`}
                      className="fb-press inline-flex items-center gap-1 rounded-[var(--radius-chip)] bg-[var(--surface-sunken)] px-2 py-1 fb-t-caption font-medium text-[var(--ink-60)] hover:text-[var(--ink-90)] transition-colors"
                    >
                      <Icon name="undo" size={12} />
                      <span>Undo</span>
                    </button>
                  )}
                  {applied.target && (
                    <button
                      onClick={() => void goToTarget(applied.target!)}
                      title="Go to what this created"
                      data-testid={`proposal-goto-${p.id}`}
                      className="fb-press inline-flex items-center gap-1 rounded-[var(--radius-chip)] bg-emerald-500/10 hover:bg-emerald-500/20 px-2 py-1 fb-t-caption font-medium text-emerald-500 transition-colors"
                    >
                      <span>Go to</span>
                      <Icon name="north_east" size={12} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        }

        // ── Pending card: clickable to apply, a "choose where" control for
        //    placeable kinds, and × to dismiss.
        return (
          <div key={p.id} className="flex items-center gap-1.5">
            {/* The subset checkbox (A4, AI-09) lives OUTSIDE the card button:
                interactive content nested in a <button> is invalid HTML and
                Chromium retargets real clicks to the button — the probe's
                click toggled nothing until this moved out. */}
            {pendingCount > 1 && (
              <button
                type="button"
                onClick={() => toggleChecked(p.id)}
                role="checkbox"
                aria-checked={checked.has(p.id)}
                title={checked.has(p.id) ? 'Remove from the selection' : 'Select for a partial apply'}
                data-testid={`proposal-check-${p.id}`}
                className={`h-4 w-4 rounded-[4px] border inline-flex items-center justify-center shrink-0 transition-colors ${
                  checked.has(p.id)
                    ? 'bg-[rgb(var(--accent))] border-[rgb(var(--accent))] text-white'
                    : 'border-[var(--edge-soft)] bg-[var(--surface-base)] text-transparent hover:border-[rgb(var(--accent)/0.6)]'
                }`}
              >
                <Icon name="check" size={11} />
              </button>
            )}
          <button
            onClick={() => {
              // At 'manual' the assistant must not perform the action. The card
              // says why rather than going quiet — a control that looks live and
              // does nothing is the bug this whole pass is about.
              if (autonomy && !oneClick) {
                setToast({ id: p.id, ok: false, message: manualModeNote(autonomy) })
                setTimeout(() => setToast((t) => (t?.id === p.id ? null : t)), 3600)
                return
              }
              void applyOne(p)
            }}
            aria-disabled={autonomy !== null && !oneClick}
            data-autonomy={autonomy?.level ?? 'loading'}
            disabled={isBusy || agentRunning}
            data-testid={`proposal-card-${p.id}`}
            className="flex-1 min-w-0 text-left fb-card fb-press hover:bg-accent/5 hover:outline hover:outline-1 hover:outline-[rgb(var(--accent)/0.5)] hover:-outline-offset-1 px-2.5 py-1.5 transition-colors group"
          >
            <div className="flex items-center gap-2">
              <span className="h-6 w-6 rounded-[var(--radius-chip)] inline-flex items-center justify-center bg-accent/10 text-accent shrink-0">
                <Icon name={desc.icon} size={13} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="fb-t-caption uppercase tracking-wider text-[var(--ink-50)]">
                  {desc.verb}
                </div>
                <div className="fb-t-label font-medium text-[var(--ink-100)] truncate">
                  {desc.subject}
                </div>
                {/* The reason is the field the user actually decides from, so
                    its ABSENCE is information too. This used to render nothing
                    when the model omitted it, which left a card asking you to
                    approve a change on trust with no visible sign that anything
                    was missing -- and that reads as the assistant being
                    arbitrary rather than as the assistant being quiet. */}
                {p.reason?.trim() ? (
                  <div className="fb-t-caption text-[var(--ink-50)] mt-0.5 leading-snug">
                    {p.reason}
                  </div>
                ) : (
                  <div
                    className="fb-t-caption text-[var(--ink-50)] mt-0.5 leading-snug italic"
                    data-testid="proposal-no-reason"
                  >
                    Plexii gave no reason for this one — worth a look before you apply it.
                  </div>
                )}
                {/* The miniature (F3): the real thing this card would create,
                    small — actual columns, actual items, actual first lines.
                    Kinds with nothing to preview add nothing. */}
                <div className="mt-1.5 empty:hidden">
                  <ProposalPreview p={p} />
                </div>
                {showToast && (
                  <div className="fb-t-caption mt-1 text-amber-500">
                    ⚠ {toast.message}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!isBusy && hasPlacementChoice(p.kind) && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      setPlaceOffer([p])
                    }}
                    title="Choose where to add this"
                    role="button"
                    data-testid={`proposal-place-${p.id}`}
                    className="icon-btn !h-5 !w-5"
                  >
                    <Icon name="drive_file_move" size={12} />
                  </span>
                )}
                {!isBusy && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      onConsume(p.id)
                    }}
                    title="Dismiss this suggestion"
                    role="button"
                    // The one control in this row that carried no handle, so
                    // "I declined the suggestion" was the only outcome here
                    // that could not be driven or asserted.
                    data-testid={`proposal-dismiss-${p.id}`}
                    className="icon-btn !h-5 !w-5"
                  >
                    <Icon name="close" size={11} />
                  </span>
                )}
                <span className="fb-t-caption text-accent font-medium px-1">
                  {isBusy ? busyVerb(p.kind) : 'apply'}
                </span>
              </div>
            </div>
          </button>
          </div>
        )
      })}
      {autonomy !== null && !offersOneClickApply(autonomy.level) && pendingCount > 0 && (
        <p
          className="fb-t-caption text-[var(--ink-50)] self-start px-1.5"
          data-testid="proposal-manual-note"
        >
          {manualModeNote(autonomy)}
        </p>
      )}
      {autoAppliedCount > 0 && (
        <p
          className="fb-t-caption text-[var(--ink-50)] self-start px-1.5"
          data-testid="proposal-auto-note"
        >
          {autoAppliedNote()}
        </p>
      )}
      {pendingCount > 1 && oneClick && (
        <button
          onClick={() =>
            void applyBatch(selectedCount > 0 ? selectedProposals : pendingProposals)
          }
          disabled={busy !== null || agentRunning}
          data-testid="proposal-apply-batch"
          className="fb-t-caption text-accent self-start px-1.5 py-0.5 hover:underline disabled:opacity-50"
        >
          {selectedCount > 0 ? `Apply selected ${selectedCount}` : `Apply all ${pendingCount}`}
        </button>
      )}
    </div>
  )
}
