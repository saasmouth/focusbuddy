// Context Health presentation (spec §27, PLX-A11Y-004). Health states are
// distinguishable WITHOUT relying on colour: each carries a distinct icon (shape)
// and a text label as well as its tone. This is the single source of truth the
// badge renders from, so the accessibility property is guaranteed, not incidental.

import type { HealthState } from './contextHealth'

export interface HealthPresentation {
  label: string
  icon: string // a distinct shape per state
  tone: 'emerald' | 'sky' | 'amber' | 'rose'
}

export const HEALTH_PRESENTATION: Record<HealthState, HealthPresentation> = {
  current: { label: 'Current', icon: 'check_circle', tone: 'emerald' },
  changed: { label: 'Changed', icon: 'fiber_manual_record', tone: 'sky' },
  'attention-required': { label: 'Needs attention', icon: 'priority_high', tone: 'amber' },
  'decision-risk': { label: 'Decision risk', icon: 'gpp_maybe', tone: 'rose' }
}

export function healthPresentation(state: HealthState): HealthPresentation {
  return HEALTH_PRESENTATION[state]
}

// A11Y-004: every state is distinguishable by shape and text alone — distinct icon
// and distinct label per state — so colour is never the only differentiator.
export function statesDistinguishableWithoutColour(): boolean {
  const entries = Object.values(HEALTH_PRESENTATION)
  const icons = new Set(entries.map((e) => e.icon))
  const labels = new Set(entries.map((e) => e.label))
  return icons.size === entries.length && labels.size === entries.length
}
