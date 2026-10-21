// Work-item preferences for the cloud runtime.
//
// DEC-144: Focus (work items) is always on, here as on the desktop; the
// tables are present because applySchemaAndMigrations calls
// ensureWorkItemSchema. What a tab still lacks is somewhere to hold the
// per-org migration attestation, so org scope reports off -- a real answer,
// not a placeholder. Porting the attestation to server-held state is what
// turns these into reads.

export function workItemsOrgEnabled(_orgId: string): boolean {
  return false
}

export function orgMigrationAttested(_orgId: string): null {
  return null
}

export function attestOrgMigrated(_orgId: string, _note: string): void {
  throw new Error('Org migration cannot be attested from the browser runtime.')
}

export function revokeOrgAttestation(_orgId: string): void {
  throw new Error('Org attestation cannot be revoked from the browser runtime.')
}
