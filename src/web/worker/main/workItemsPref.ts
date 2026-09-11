// Work-item preferences for the cloud runtime.
//
// The desktop keeps these in a JSON file beside the database and gates the
// Attention layer on them. The cloud runtime reports the feature off, and that
// is a real answer rather than a placeholder.
//
// What is missing is the preferences, not the tables: applySchemaAndMigrations
// calls ensureWorkItemSchema, so wi_local, wi_deliveries and the work_item
// columns on nodes are all present in a browser database. The desktop reads the
// gate from a JSON file beside the database, and a tab has no such file -- so
// there is nowhere to record a per-user answer and nowhere to hold the per-org
// attestation that the migration requires.
//
// Turning it on means porting both to server-held state, at which point these
// stop being constants. Until then they return the truth: off.
export function isWorkItemsEnabled(): boolean {
  return false
}

export function setWorkItemsEnabled(_enabled: boolean): void {
  throw new Error('Work items cannot be enabled from the browser runtime yet.')
}

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
