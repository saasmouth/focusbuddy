// Single source of truth for which OS-level view kinds require an entitlement.
//
// MainPane's CapabilityGate is the enforcement backbone: any navigation to a
// gated surface renders a reason-aware locked panel. This map is what MainPane
// reads to decide that, and it is exported here so the navigation surfaces (the
// sidebar, the per-area segment menus, the suite and home tiles) can hide the
// entries that lead to a locked surface using the EXACT same capability. Nav and
// surface then never disagree: if the surface would show a lock, its menu entry
// is simply not shown.
//
// Anything not listed is core and always available (home, tasks, desks, search,
// inbox, suite, plans, etc.). The office document editors gate on product_office
// for the standalone suite; the doc/sheet/etc widgets on a desk canvas live in
// the 'task' view and are deliberately never gated.

import { useCapabilityStore } from '../stores/capabilities'
import type { CapabilityValue } from './capabilityDefaults'

export const VIEW_CAPABILITY: Partial<Record<string, { cap: string; label: string }>> = {
  vault: { cap: 'password_vault', label: 'Vault' },
  messages: { cap: 'chat', label: 'Chat' },
  mail: { cap: 'mail', label: 'Mail' },
  meetings: { cap: 'meet', label: 'Meetings' },
  'people-map': { cap: 'people_map', label: 'People Map' },
  organization: { cap: 'org_directory', label: 'Organisation' },
  calendar: { cap: 'time_blocking', label: 'Calendar' },
  files: { cap: 'file_manager', label: 'Files' },
  collaborations: { cap: 'live_collaboration', label: 'Live collaboration' },
  livedoc: { cap: 'live_collaboration', label: 'Live collaboration' },
  livecanvas: { cap: 'live_collaboration', label: 'Live collaboration' },
  livefolder: { cap: 'live_collaboration', label: 'Live collaboration' },
  sign: { cap: 'esign', label: 'PlexiSign' },
  knowledge: { cap: 'product_brain', label: 'PlexiBrain' },
  documents: { cap: 'product_office', label: 'PlexiOffice' },
  design: { cap: 'product_office', label: 'PlexiOffice' },
  draw: { cap: 'product_office', label: 'PlexiOffice' },
  document: { cap: 'product_office', label: 'PlexiOffice' }
}

// Pure check that mirrors CapabilityGate's `enabled` exactly (a capability is on
// only when it resolves strictly true). An ungated kind is always enabled.
export function viewKindEnabled(
  capabilities: Record<string, CapabilityValue>,
  kind: string
): boolean {
  const gate = VIEW_CAPABILITY[kind]
  if (!gate) return true
  return capabilities[gate.cap] === true
}

/**
 * Reactive checker for nav lists. Subscribes to the capability map once and
 * returns a function that reports whether a given view kind is currently
 * reachable, so a menu can hide the entries that lead to a locked surface. Using
 * a returned function keeps us clear of the rules-of-hooks trap of calling a
 * hook per item inside a render loop.
 */
export function useViewKindEnabled(): (kind: string) => boolean {
  const capabilities = useCapabilityStore((s) => s.capabilities)
  return (kind: string) => viewKindEnabled(capabilities, kind)
}
