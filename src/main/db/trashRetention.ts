// How long the Trash keeps things (4.3.55).
//
// What this device deleted itself is kept 7 days, as before. What was deleted
// elsewhere (on another device, or by a collaborator) and reached this device by
// sync is kept 30 days: the person here did not choose it, may not notice it for
// a while, and the 16 Nov loss went three days before anyone knew. Kinds that
// never aged out (documents, tables, table rows, time blocks) still do not.
//
// "Deleted elsewhere" is the row's deleted_elsewhere_at stamp (workspaceSync.ts
// writes it when a delete arrives by sync), counted only when it is at least as
// recent as the row's trash time: a row restored and later trashed here again is
// this device's own delete, whatever stamp it once carried.
//
// No imports: nodeLifecycle.ts is Electron-free and shared with the browser app.

const DAY = 24 * 60 * 60 * 1000
export const OWN_TRASH_RETENTION_MS = 7 * DAY
export const DELETED_ELSEWHERE_RETENTION_MS = 30 * DAY

/** SQL: the row's current trash came from elsewhere. `t` is a table alias with its dot, or ''. */
export function deletedElsewhereSql(t = ''): string {
  return `(${t}deleted_elsewhere_at IS NOT NULL AND ${t}deleted_elsewhere_at >= ${t}trashed_at)`
}

/**
 * SQL: trashed long enough to purge. Binds two values, in order: the cutoff for
 * items deleted elsewhere, then the cutoff for this device's own deletes
 * (purgeCutoffs gives both).
 */
export function pastRetentionSql(t = ''): string {
  return `${t}trashed_at < CASE WHEN ${deletedElsewhereSql(t)} THEN ? ELSE ? END`
}

/** The two purge cutoffs, [deleted elsewhere, own], for an own retention of `ownMs`. */
export function purgeCutoffs(now: number, ownMs = OWN_TRASH_RETENTION_MS): [number, number] {
  return [now - Math.max(ownMs, DELETED_ELSEWHERE_RETENTION_MS), now - ownMs]
}

/** When the purge claims a row trashed at `trashedAt`. */
export function purgeAtFor(trashedAt: number, deletedElsewhere: boolean): number {
  return trashedAt + (deletedElsewhere ? DELETED_ELSEWHERE_RETENTION_MS : OWN_TRASH_RETENTION_MS)
}
