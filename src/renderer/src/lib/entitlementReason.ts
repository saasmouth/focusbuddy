// Reason-aware entitlement helper.
//
// This centralises the "why is this app off, and what can this person do about
// it" logic that SegmentSwitcher pioneered, so every place that gates a
// PlexiOffice surface tells the user the same story with the same words. An app
// is off for one of two reasons and the copy differs: a 'user' source is a
// deliberate admin restriction (a dead end, no upsell), anything else is a
// licensing gap where an owner/admin (or a personal account) is offered an
// upgrade and a plain member is told to ask an admin. Personal accounts drop the
// org framing entirely.
//
// computeEntitlement is the pure core so it can run inside a render loop (where
// calling a hook per item would break the rules of hooks) and outside React
// (the workspace-brain create path reads it via entitlementFor). useEntitlement
// is the reactive hook for components that gate a single known surface.

import { useCapabilityStore, type CapabilitySource } from '../stores/capabilities'
import { useOrgStore, PERSONAL_ORG_ID } from '../stores/org'
import type { CapabilityValue } from './capabilityDefaults'
import type { DocType } from '@shared/types'
import { PRICING_URL } from './siteUrls'

// docType -> per-editor capability. This is the single source of truth for the
// mapping so the office shell, the drive, the command bar and the AI create path
// all gate on the same key.
export const DOC_TYPE_CAPABILITY: Record<DocType, string> = {
  doc: 'office_docs',
  sheet: 'office_sheets',
  slides: 'office_slides',
  // PlexiDiagrams and PlexiDraw were one product before the split, so they share
  // the capability they have always been licensed under. Minting a new key would
  // lock the new studio for every signed-in user until the entitlements server
  // learned about it, which is a worse outcome than one key covering both.
  map: 'office_draw',
  design: 'office_design',
  draw: 'office_draw'
}

// Human label per editor, used in the "<Editor> is not available" copy.
export const DOC_TYPE_LABEL: Record<DocType, string> = {
  doc: 'PlexiDocs',
  sheet: 'PlexiSheets',
  slides: 'PlexiSlides',
  map: 'PlexiDiagrams',
  design: 'PlexiDesign',
  draw: 'PlexiDraw'
}

export function capabilityForDocType(docType: DocType): string {
  return DOC_TYPE_CAPABILITY[docType]
}

export interface Entitlement {
  /** True when the capability resolves entitled for this user/org right now. */
  enabled: boolean
  /** True when off because an admin deliberately restricted it (no upsell). */
  restricted: boolean
  /** The reason-aware sentence to show when the surface is locked. */
  reason: string
  /** True when this person could act on an upgrade (owner/admin, or personal). */
  canUpgrade: boolean
  /** Send the user somewhere they can act — opens pricing for a licensing gap. */
  onLockedClick: () => void
}

export interface EntitlementInputs {
  capabilities: Record<string, CapabilityValue>
  sources: Record<string, CapabilitySource>
  orgRole: string | null
  activeOrgId: string
  orgName: string | null
}

// The pure decision. Mirrors SegmentSwitcher's original lockedReason/onLockedClick
// copy exactly so the messaging stays identical across every gated surface.
export function computeEntitlement(
  inputs: EntitlementInputs,
  capabilityKey: string,
  appLabel: string
): Entitlement {
  const { capabilities, sources, orgRole, activeOrgId, orgName } = inputs
  const inOrg = activeOrgId !== PERSONAL_ORG_ID && !!orgName
  const canUpgrade = orgRole === 'owner' || orgRole === 'admin'
  const enabled = capabilities[capabilityKey] === true
  const restricted = sources[capabilityKey] === 'user'

  let reason: string
  if (restricted) {
    reason = inOrg
      ? `${appLabel} is turned off for you in ${orgName} by your administrator.`
      : `${appLabel} is turned off for your account by your administrator.`
  } else if (inOrg) {
    reason = canUpgrade
      ? `${appLabel} is not included in ${orgName}'s plan. Upgrade to add it.`
      : `${appLabel} is not included in ${orgName}'s plan. Ask an admin to add it.`
  } else {
    reason = `${appLabel} is not on your plan. Upgrade to add it.`
  }

  const onLockedClick = (): void => {
    // Only send someone somewhere they can act: a licensing gap for an owner/
    // admin (or a personal account) opens pricing. A restriction is a dead end
    // by design, so it just shows its tooltip.
    if (!restricted && (canUpgrade || !inOrg)) void window.api.files.openExternal(PRICING_URL)
  }

  return { enabled, restricted, reason, canUpgrade, onLockedClick }
}

// Read the current store state without subscribing. For non-React callers such
// as the workspace-brain action executor.
function currentInputs(): EntitlementInputs {
  const cap = useCapabilityStore.getState()
  const org = useOrgStore.getState()
  const orgName = org.orgs.find((o) => o.id === org.activeOrgId)?.name ?? null
  return {
    capabilities: cap.capabilities,
    sources: cap.sources,
    orgRole: cap.orgRole,
    activeOrgId: org.activeOrgId,
    orgName
  }
}

/** Non-reactive one-shot resolve, for code outside React. */
export function entitlementFor(capabilityKey: string, appLabel: string): Entitlement {
  return computeEntitlement(currentInputs(), capabilityKey, appLabel)
}

/**
 * Reactive entitlement for a single known surface. Subscribes to the capability
 * + source maps and the active org so the UI reacts when entitlements resolve or
 * change (e.g. after an org switch).
 */
export function useEntitlement(capabilityKey: string, appLabel: string): Entitlement {
  const capabilities = useCapabilityStore((s) => s.capabilities)
  const sources = useCapabilityStore((s) => s.sources)
  const orgRole = useCapabilityStore((s) => s.orgRole)
  const activeOrgId = useOrgStore((s) => s.activeOrgId)
  const orgName = useOrgStore((s) => s.orgs.find((o) => o.id === s.activeOrgId)?.name ?? null)
  return computeEntitlement({ capabilities, sources, orgRole, activeOrgId, orgName }, capabilityKey, appLabel)
}
