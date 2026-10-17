import { useEffect, useMemo, useState } from 'react'
import type { ActionProposal, AppliedProposal, SmartStackGroup } from '@shared/types'
import { useNodeStore } from '../stores/nodes'
import { useWidgetStore } from '../stores/widgets'
import {
  getCachedProposal,
  invalidateCache,
  setCachedProposal,
  signatureFor
} from '../lib/smartStackCache'
import ProposalCards from './ProposalCards'
import Icon from './Icon'

// Smart Stack: AI proposes grouping loose widgets into labelled Sections. The
// suggestions now render through the shared approval-card surface (ProposalCards) —
// one card per group — so accept/approve, Apply-all, undo batching and applied
// state match every other suggestion in the app. This shell keeps the canvas entry
// point + the propose/cache/refresh flow; only the body is the standard card now.

type State =
  | { stage: 'loading' }
  | { stage: 'ready'; groups: SmartStackGroup[]; fromCache: boolean }
  | { stage: 'error'; message: string; needsApiKey?: boolean }

interface Props {
  onClose: () => void
}

export default function SmartStackModal({ onClose }: Props): JSX.Element {
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const widgets = useWidgetStore((s) => s.widgets)

  const [state, setState] = useState<State>({ stage: 'loading' })
  // Applied-state + dismissals for the shared ProposalCards.
  const [applied, setApplied] = useState<Record<string, AppliedProposal>>({})
  const [consumed, setConsumed] = useState<Set<string>>(new Set())

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!activeTaskId) {
      setState({ stage: 'error', message: 'Pick a task first.' })
      return
    }
    let cancelled = false
    void (async () => {
      const signature = signatureFor(widgets)
      const cached = getCachedProposal(activeTaskId, signature)
      if (cached) {
        if (!cancelled) setState({ stage: 'ready', groups: cached.groups, fromCache: true })
        return
      }
      const result = await window.api.smartStack.propose(activeTaskId)
      if (cancelled) return
      if (result.ok && result.groups && result.groups.length > 0) {
        setCachedProposal(activeTaskId, signature, result.groups)
        setState({ stage: 'ready', groups: result.groups, fromCache: false })
      } else {
        setState({ stage: 'error', message: result.error ?? 'No groups found.', needsApiKey: result.needsApiKey })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeTaskId, widgets])

  function refreshProposal(): void {
    if (!activeTaskId) return
    invalidateCache(activeTaskId)
    setState({ stage: 'loading' })
    setApplied({})
    setConsumed(new Set())
    void (async () => {
      const result = await window.api.smartStack.propose(activeTaskId)
      if (result.ok && result.groups && result.groups.length > 0) {
        setCachedProposal(activeTaskId, signatureFor(widgets), result.groups)
        setState({ stage: 'ready', groups: result.groups, fromCache: false })
      } else {
        setState({ stage: 'error', message: result.error ?? 'No groups found.' })
      }
    })()
  }

  // Each group becomes a create-section approval card (stable id per group).
  const proposals = useMemo<ActionProposal[]>(
    () =>
      state.stage === 'ready'
        ? state.groups.map((g, i) => ({
            id: `smartstack-${i}`,
            kind: 'create-section' as const,
            name: g.name,
            widgetIds: g.widgetIds,
            reason: g.reason
          }))
        : [],
    [state]
  )
  const visible = proposals.filter((p) => !consumed.has(p.id))

  return (
    <div
      className="fb-scrim fixed inset-0 z-[170] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="fb-card fb-press w-full max-w-lg mx-4 overflow-hidden flex flex-col max-h-[85vh]"
        data-testid="smart-stack-modal"
      >
        <div className="px-5 py-4 border-b border-[var(--edge-soft)] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <Icon name="hub" size={18} className="text-accent" />
            <h3 className="text-base font-semibold text-[var(--ink-100)]">Smart Stack</h3>
            {state.stage === 'ready' && state.fromCache && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-sunken)] text-[var(--ink-50)]">
                cached
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {state.stage === 'ready' && (
              <button onClick={refreshProposal} className="icon-btn" title="Generate a fresh proposal">
                <Icon name="refresh" size={14} />
              </button>
            )}
            <button onClick={onClose} className="icon-btn" aria-label="Close">
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto">
          {state.stage === 'loading' && (
            <div className="py-8 flex flex-col items-center justify-center text-[var(--ink-50)]">
              <Icon name="hub" size={32} className="text-accent mb-2 animate-pulse" />
              <p className="text-sm">Finding groups in your work widgets…</p>
            </div>
          )}

          {state.stage === 'error' && (
            <div className="py-6 flex flex-col items-center text-center gap-2">
              <Icon name="warning" size={24} className="text-amber-600 dark:text-amber-400" />
              <p className="text-sm text-[var(--ink-90)]">{state.message}</p>
              {state.needsApiKey && (
                <p className="text-[12px] text-[var(--ink-50)]">
                  Open <strong>Settings → AI · API keys</strong> to paste your Anthropic key.
                </p>
              )}
            </div>
          )}

          {state.stage === 'ready' && (
            <>
              <p className="text-[12px] text-[var(--ink-50)] mb-3 leading-relaxed">
                Here&apos;s what I&apos;d group together. Create the ones you want, or dismiss the rest.
              </p>
              {visible.length === 0 ? (
                <p className="text-[12.5px] text-[var(--ink-50)]">No groups left.</p>
              ) : (
                <ProposalCards
                  proposals={visible}
                  activeTaskId={activeTaskId}
                  appliedProposals={applied}
                  onApplied={(id, a) => setApplied((m) => ({ ...m, [id]: a }))}
                  onConsume={(id) => setConsumed((prev) => new Set(prev).add(id))}
                />
              )}
            </>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--edge-soft)] bg-[var(--surface-sunken)] flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="btn-ghost">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
