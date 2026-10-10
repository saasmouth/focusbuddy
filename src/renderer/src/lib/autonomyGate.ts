// The bridge between the autonomy POLICY and the places that actually act.
//
// Three pieces already existed and had never been introduced to each other:
//
//   autonomyPolicy.canActAutonomously(level, risk)  — the gate, pure and tested
//   actionExecutor.isAutoApplyable(p)               — the risk classifier
//   stores/autonomy.resolveFor()                    — the user's resolved level
//
// Between them the user's choice reached nothing: agentRunner hardcoded
// `isGated: (p) => !isAutoApplyable(p)`, which is the 'auto' policy spelled out
// by hand. So an operator who chose "Suggest only" still had an agent loop
// applying things, and one who chose "Ask before acting" was never asked. The
// setting saved, displayed its resolved value with its source and org ceiling,
// and governed nothing.
//
// This module is the single place that joins them, so there is one answer to
// "may this be applied without asking" rather than one per call site.
//
// RISK IS NOT RE-DERIVED HERE. isAutoApplyable is already documented as the
// source of truth for which proposals are consequential (delete, real calendar
// time, real mail, a live external channel, a real timer). A second list would
// drift from it the first time a kind was added.

import type { ActionProposal } from '@shared/types'
import { isAutoApplyable } from './actionExecutor'
import { canActAutonomously, type AutonomyLevel, type ResolvedAutonomy } from './autonomyPolicy'
import { useAutonomyStore } from '../stores/autonomy'

/** A proposal's risk, in the terms the policy gate speaks. */
export function proposalRisk(p: ActionProposal): 'low' | 'high' {
  return isAutoApplyable(p) ? 'low' : 'high'
}

/**
 * The resolved policy, loading it first if it has not been loaded.
 *
 * This await matters. The store only loaded when the Settings section mounted,
 * so acting on `resolveFor()` in a fresh session would have read an empty
 * policy and reported the built-in default — silently demoting an operator who
 * had chosen 'auto' and inventing a cap for one whose org had set none. Reading
 * a policy that has not arrived is worse than waiting for it.
 */
export async function ensureAutonomy(assistantId?: string): Promise<ResolvedAutonomy> {
  const store = useAutonomyStore.getState()
  if (!store.loaded) {
    try {
      await store.load()
    } catch {
      // A failed load leaves the store unloaded; resolveFor then reports the
      // built-in 'ask' default, which is the conservative end.
    }
  }
  return useAutonomyStore.getState().resolveFor(assistantId)
}

/** May a proposal of this risk be applied without asking, at this level? */
export function mayApplyWithoutAsking(level: AutonomyLevel, p: ActionProposal): boolean {
  return canActAutonomously(level, proposalRisk(p))
}

/**
 * Does this level offer a one-click Apply at all?
 *
 * 'manual' is "the assistant surfaces ideas but never changes anything itself —
 * you do the action". An Apply button that performs the action is the assistant
 * doing it, so at 'manual' the card offers the idea and a way in, not an Apply.
 */
export function offersOneClickApply(level: AutonomyLevel): boolean {
  return level !== 'manual'
}

/** One line naming why a card is not offering to act. Shown, never guessed. */
export function manualModeNote(r: ResolvedAutonomy): string {
  if (r.cappedByOrg) {
    return 'Your organisation limits the assistant to suggestions, so these are not applied for you.'
  }
  return 'Your autonomy setting is “Suggest only”, so Plexii leaves the doing to you.'
}

/** One line for something the assistant applied on its own. */
export function autoAppliedNote(): string {
  return 'Applied automatically — your autonomy setting allows low-risk work without asking.'
}
