// Renderer state for agentic-browsing runs (A6/B2): the runtime's client.
// Main drives the loop and pushes events; this store is the one place the
// renderer accumulates them — B3's visible run (step ledger, consent
// prompt, Stop) renders from here. Starting a run through this store also
// registers it with the web panel, so closing the panel keeps its
// kill-switch meaning (no page, no run).

import { create } from 'zustand'
import { useWebPanel } from './webPanel'
import { hasFindings, normalizeFindings, type BrowseFindings } from '@shared/browseFindings'
import type { ActionProposal } from '@shared/types'
import type { Destination } from '../lib/deliveryDestination'

export interface BrowserAgentEventLite {
  kind: string
  runId: string
  [key: string]: unknown
}

export interface BrowserAgentRunState {
  runId: string
  task: string
  // 'running' until a finished event lands; then that event's outcome.
  outcome: string
  summary: string
  // The host awaiting an R26 consent answer, when paused.
  pendingConsentHost: string | null
  events: BrowserAgentEventLite[]
  cost: { inputTokens: number; outputTokens: number; costMicros: number } | null
  // What the run actually learned. The run's real product — kept so it can be
  // routed to whatever the task was for instead of dying with the event.
  findings: BrowseFindings | null
  // Delivery of those findings to their destination.
  delivery: {
    state: 'idle' | 'planning' | 'done' | 'error'
    message: string
    // Where it landed, so the dock can offer a way there. Null when nothing
    // that was applied has somewhere to go.
    destination?: Destination | null
  }
}

interface BrowserAgentStore {
  runs: Record<string, BrowserAgentRunState>
  start: (input: { task: string; startUrl?: string }) => Promise<string | null>
  stop: (runId: string) => Promise<void>
  /** Say something to a run that is already working. */
  steer: (runId: string, text: string) => Promise<boolean>
  consent: (runId: string, granted: boolean, remember: boolean) => Promise<void>
  // Hand a finished run's findings to the AI to place where the task intended.
  deliver: (runId: string) => Promise<void>
}

export const useBrowserAgentRuns = create<BrowserAgentStore>((set) => ({
  runs: {},

  // Starts a run against the web panel's live webview. The panel must be
  // open (the run drives ITS page — R28: acting happens where you can see
  // it); returns null when there is no page to drive.
  start: async ({ task, startUrl }) => {
    const wcId = useWebPanel.getState().wcId
    if (wcId == null) return null
    const { runId } = await window.api.browserAgent.start({ wcId, task, startUrl })
    useWebPanel.getState().setActiveRun(runId)
    set((s) => ({
      runs: {
        ...s.runs,
        [runId]: {
          runId,
          task,
          outcome: 'running',
          summary: '',
          pendingConsentHost: null,
          events: [],
          cost: null,
          findings: null,
          delivery: { state: 'idle', message: '' }
        }
      }
    }))
    return runId
  },

  stop: async (runId) => {
    await window.api.browserAgent.stop(runId)
  },

  // Guide a run in flight. Main queues it and hands it to the model at the top
  // of its next round, framed as an amendment to the task rather than a new
  // one, so nothing it has already found is thrown away.
  steer: async (runId, text) => {
    const t = text.trim()
    if (!t) return false
    return window.api.browserAgent.steer(runId, t)
  },

  consent: async (runId, granted, remember) => {
    await window.api.browserAgent.consent(runId, granted, remember)
    set((s) => {
      const run = s.runs[runId]
      return run
        ? { runs: { ...s.runs, [runId]: { ...run, pendingConsentHost: null } } }
        : s
    })
  },

  // Take what the run found and put it where the task meant it to go. Main
  // plans the destination from the user's original wording; what comes back is
  // ordinary action proposals, applied through the same path as any other
  // suggestion, so the user still reviews before anything is created.
  deliver: async (runId) => {
    const run = useBrowserAgentRuns.getState().runs[runId]
    if (!run?.findings) return
    const setDelivery = (delivery: BrowserAgentRunState['delivery']): void =>
      set((s) => {
        const r = s.runs[runId]
        return r ? { runs: { ...s.runs, [runId]: { ...r, delivery } } } : s
      })
    setDelivery({ state: 'planning', message: 'Working out where this belongs…' })
    try {
      const { useNodeStore } = await import('./nodes')
      const taskId = useNodeStore.getState().activeTaskId ?? null
      const res = await window.api.browserAgent.deliver({ task: run.task, findings: run.findings, taskId })
      if (!res.ok) {
        setDelivery({ state: 'error', message: res.error ?? 'Could not place these results.' })
        return
      }
      const proposals = (res.proposals ?? []) as ActionProposal[]
      if (proposals.length === 0) {
        setDelivery({ state: 'error', message: res.reply || 'Nothing to place.' })
        return
      }
      const { applyProposal } = await import('../lib/actionExecutor')
      const resolvedIds = new Map<string, string>()
      let applied = 0
      const failures: string[] = []
      for (const p of proposals) {
        const r = await applyProposal(p, { activeTaskId: taskId, resolvedIds })
        if (r.ok) applied++
        else failures.push(r.message)
      }
      // Report what actually happened, including a partial result — silently
      // reporting success for rows that failed to land is exactly the sort of
      // thing that made the old empty-table failure so hard to notice.
      // Where it all went. Worked out from what was APPLIED rather than from
      // the model's sentence, which was written before anything was placed and
      // cannot know — the desk used is whichever was last active, which from a
      // desk-less browser is one the user was not looking at.
      const { destinationOf, deliveryMessage } = await import('../lib/deliveryDestination')
      const nodes = useNodeStore.getState().nodes
      const destination = destinationOf(proposals, resolvedIds, {
        activeTaskId: taskId,
        deskTitle: (id) => nodes.find((n) => n.id === id)?.title ?? null
      })
      // A notice as well as the dock line: the dock can be dismissed, and a
      // result you cannot find afterwards is barely delivered. Same shape as
      // every other "we put something somewhere" notice in the app.
      if (applied > 0 && destination) {
        const { useNoticeStore } = await import('./notice')
        useNoticeStore.getState().show({
          text: `Results placed on ${destination.label}`,
          icon: destination.icon,
          action: {
            label: 'Open',
            run: () => {
              void import('./view').then((m) => m.useViewStore.getState().go(destination.view))
            }
          }
        })
      }
      setDelivery(
        failures.length === 0
          ? {
              state: 'done',
              message: deliveryMessage(
                res.reply || `Placed ${applied} item${applied === 1 ? '' : 's'}.`,
                destination
              ),
              destination
            }
          : {
              state: applied > 0 ? 'done' : 'error',
              message: `${applied} of ${proposals.length} placed. ${failures[0]}`,
              destination: applied > 0 ? destination : null
            }
      )
    } catch (e) {
      setDelivery({ state: 'error', message: (e as Error).message })
    }
  }
}))

// One subscription for the window's lifetime; events for unknown runs (e.g.
// started before this window existed) create their entry on first sight.
window.api.browserAgent.onEvent((ev) => {
  useBrowserAgentRuns.setState((s) => {
    const prev: BrowserAgentRunState = s.runs[ev.runId] ?? {
      runId: ev.runId,
      task: typeof ev.task === 'string' ? ev.task : '',
      outcome: 'running',
      summary: '',
      pendingConsentHost: null,
      events: [],
      cost: null
    }
    const next: BrowserAgentRunState = {
      ...prev,
      events: [...prev.events, ev as BrowserAgentEventLite]
    }
    if (ev.kind === 'consent_required' && typeof ev.host === 'string') next.pendingConsentHost = ev.host
    if (ev.kind === 'acted' && ev.cost) next.cost = ev.cost as BrowserAgentRunState['cost']
    if (ev.kind === 'finished') {
      next.outcome = typeof ev.outcome === 'string' ? ev.outcome : 'finished'
      next.summary = typeof ev.summary === 'string' ? ev.summary : ''
      const found = normalizeFindings(ev.findings)
      next.findings = hasFindings(found) ? found : null
      next.pendingConsentHost = null
      const cost = ev.cost as BrowserAgentRunState['cost']
      next.cost = cost ?? null
      if (useWebPanel.getState().activeRunId === ev.runId) useWebPanel.getState().setActiveRun(null)
    }
    return { runs: { ...s.runs, [ev.runId]: next } }
  })
})

// Test handle (A6 probe): drive and observe runs without UI.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbBrowserAgent?: typeof useBrowserAgentRuns }).__fbBrowserAgent =
    useBrowserAgentRuns
}
