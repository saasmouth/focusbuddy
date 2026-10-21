// Persisted work-items preferences (the Focus layer).
//
// DEC-144: work items are no longer optional. The old per-device `enabled`
// switch (default OFF, DEC-023's Settings row) is gone: Focus is the one list
// of tasks, so it is always on. A legacy `enabled` key in an existing file is
// ignored and dropped on the next save. What remains here is the per-org
// migration attestation, which still gates org-scope work items (SPEC-027).
//
// Same persistence pattern as voiceProviderPref.ts: a one-line JSON file in
// userData, cached after first read, write-through on set. Not a secret.

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

interface OrgAttestation {
  /** When the operator attested every peer in the org runs the S1 migration. */
  attestedAt: number
  /** Free-text provenance ("presence surface 3/3 migrated", "manual check w/ Caleb"). */
  note: string
}

interface PrefShape {
  v: 1
  /**
   * P1 migrated-peer confirmation (ARCHITECTURE §2.6/§8): the org-scope switch
   * flips per-org ONLY after confirmation that every peer carries the S1
   * migration — the org presence/version surface where available, else this
   * recorded operator attestation. Absent entry = NOT confirmed = work items
   * stay personal (park-local) for that org. Revoking deletes the entry.
   */
  orgAttestations?: Record<string, OrgAttestation>
}

let cache: PrefShape | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'work-items.json')
}

function load(): PrefShape {
  if (cache) return cache
  try {
    if (!existsSync(filePath())) {
      cache = { v: 1 }
      return cache
    }
    const raw = readFileSync(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PrefShape>
    cache = {
      v: 1,
      // Carry attestations through the round-trip — dropping them here would
      // silently un-confirm every org on restart.
      ...(parsed.orgAttestations && typeof parsed.orgAttestations === 'object'
        ? { orgAttestations: parsed.orgAttestations }
        : {})
    }
    return cache
  } catch {
    cache = { v: 1 }
    return cache
  }
}

// ── P1 migrated-peer confirmation ───────────────────────────────────────────
// Pure record + gate. Nothing consults the gate to widen scope yet: the
// org-carry branch lands with the SPEC-027 architecture pass, and MUST check
// `workItemsOrgEnabled(orgId)` before letting a work item cross into org
// scope. Until then moveNodeToOrg parks work items locally unconditionally.

export function attestOrgMigrated(orgId: string, note: string): void {
  const p = load()
  cache = {
    ...p,
    orgAttestations: {
      ...(p.orgAttestations ?? {}),
      [orgId]: { attestedAt: Date.now(), note: note || 'operator attestation' }
    }
  }
  save()
}

export function revokeOrgAttestation(orgId: string): void {
  const p = load()
  const next = { ...(p.orgAttestations ?? {}) }
  delete next[orgId]
  cache = { ...p, orgAttestations: next }
  save()
}

export function orgMigrationAttested(orgId: string): OrgAttestation | null {
  return load().orgAttestations?.[orgId] ?? null
}

/** The P1 per-org switch: this org's peers confirmed migrated. */
export function workItemsOrgEnabled(orgId: string): boolean {
  return load().orgAttestations?.[orgId] != null
}

function save(): void {
  try {
    writeFileSync(filePath(), JSON.stringify(cache, null, 2), 'utf-8')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[workItemsPref] save failed:', err)
  }
}
