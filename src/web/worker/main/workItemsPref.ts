// Work-item preferences for the cloud runtime.
//
// The desktop keeps these in a JSON file beside the database and gates the
// Attention layer on them. The cloud runtime reports the feature off, and that
// is a real answer rather than a placeholder: openWorkspaceDatabase does not
// call ensureWorkItemSchema, because that function reaches for preferences and
// an active org the browser has not wired yet. Claiming the feature were on
// would mean nodes.ts taking work-item code paths against tables that do not
// exist here.
//
// Turning it on is a matter of porting the preference file and the org
// attestation to server-held state, at which point these stop being constants.
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
