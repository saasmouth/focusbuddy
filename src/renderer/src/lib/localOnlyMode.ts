// "Keep this device local: don't sync" (Settings > Data > Privacy).
//
// While on, this computer stops sending its PERSONAL workspace to the account
// and stops receiving it: the personal sync loop (rooms, desks, work widgets,
// documents, tables, rows, time blocks, files) in workspaceSync.ts, the
// documents mirror in cloudDocsSync.ts, and the small synced preferences in
// accountStateClient.ts. Everything stays in the local database.
//
// Still signed in (the plan needs the account), and still working when used:
// sharing, PlexiiChat, PlexiiCall, live desks, AI credits, and workspaces or
// desks shared with other people (an organisation's workspace, a desk shared by
// name). Those exist to reach other people, so pausing them would quietly break
// the people on the other end; the setting says so.
//
// What it does NOT do: delete anything already on the server (Account > Delete
// my account and data does that). Turning it off resumes sync; a backup of this
// device is saved first (main/db/backup.ts snapshotBeforeSyncResume), because
// on resume an item changed both here and on another device keeps the other
// device's version (server wins).
//
// Per device, in localStorage. Only a stored 'on' enables it.

export const LOCAL_ONLY_KEY = 'plexii.sync.localOnly'

export function localOnlyMode(): boolean {
  try {
    return localStorage.getItem(LOCAL_ONLY_KEY) === 'on'
  } catch {
    return false
  }
}

export function setLocalOnlyMode(on: boolean): void {
  try {
    localStorage.setItem(LOCAL_ONLY_KEY, on ? 'on' : 'off')
  } catch {
    /* storage unavailable: the choice cannot persist */
  }
  try {
    window.dispatchEvent(new CustomEvent('plexii:local-only-changed', { detail: { on } }))
  } catch {
    /* no window (tests) */
  }
}
