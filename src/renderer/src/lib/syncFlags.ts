import { plexiId } from '@shared/plexiId'

// WS01 sync substrate — per-type migration flags.
//
// Each object type rides the CRDT change log alongside the twenty-second workspace
// poll (the design's dual-write rule: the poll stays as the backstop, so a dropped
// frame or a not-yet-migrated field never loses data). Every type is now proven live
// across all three partition scopes (account, org, shared desk) and the signal is
// deployed, so as of the lock-retire rollout these DEFAULT ON.
//
// Default ON, with an explicit off-switch: `localStorage['fb.sync.crdt.<type>']`
// unset or '1' is ON; only the literal '0' turns a type off. This is what makes
// shared-desk canvas collaboration real (it rides widgets + nodes + tables + links),
// which is the prerequisite for retiring the check-out lock. If localStorage is
// unreadable we fail safe to OFF (poll-only) rather than starting the engine blind.
function crdtFlagOn(type: string): boolean {
  try {
    return localStorage.getItem(`fb.sync.crdt.${type}`) !== '0'
  } catch {
    return false
  }
}

export function crdtWidgetsEnabled(): boolean {
  return crdtFlagOn('widgets')
}

// Nodes (tasks / folders / desks). Syncs the node's title, parent and scalar attrs
// as LWW registers; sibling ORDER still reconciles via the poll (no fractional-index
// CRDT yet), so a reparent converges live while order catches up on the poll.
export function crdtNodesEnabled(): boolean {
  return crdtFlagOn('nodes')
}

// Table rows. Syncs each row CELL as an LWW register keyed by column, so two people
// editing different cells of the same row both survive (the poll's whole-row LWW
// loses one).
export function crdtTablesEnabled(): boolean {
  return crdtFlagOn('tables')
}

// Time blocks (calendar). Syncs start / duration / title / status as LWW registers;
// recurrence-series expansion stays on the poll.
export function crdtTimeBlocksEnabled(): boolean {
  return crdtFlagOn('timeblocks')
}

// Files/folders (the Drive manager entries). Syncs name + parent as LWW registers;
// the file bytes stay on the poll + blob sync.
export function crdtFilesEnabled(): boolean {
  return crdtFlagOn('files')
}

// Document METADATA (title / archived / create / delete). The document BODY rides
// its own channel (org bodies on Yjs, personal on the poll), not this.
export function crdtDocumentsEnabled(): boolean {
  return crdtFlagOn('documents')
}

// Widget LINKS (the connector wires between widgets on a desk). Existence
// (create / delete) plus type / verb / enabled as LWW registers, routed with the
// wire's task node so a SHARED DESK's wires converge alongside its widgets. Run-state
// (lastRunAt / lastError) is local engine output and stays off the log.
export function crdtLinksEnabled(): boolean {
  return crdtFlagOn('links')
}

// LIVE FOLDERS (the shared, collaborative folder tree — LiveFolderView). Each tree
// entry becomes a CRDT object (create snapshot + delete tombstone + name/parent LWW),
// so people reorganise a shared folder concurrently and converge WITHOUT the
// check-out lock. body_json stays the frozen baseline; the change log carries the
// deltas on top.
export function crdtLiveFoldersEnabled(): boolean {
  return crdtFlagOn('livefolders')
}

// A stable per-install id, minted once and reused. It is the LWW tiebreak actor, so
// it MUST be distinct per device: two devices of the same account editing at the
// same millisecond would otherwise share an actor and could diverge. Combined with
// the account id when emitting, so the actor is unique across the whole system.
export function deviceId(): string {
  try {
    let id = localStorage.getItem('fb.sync.deviceId')
    if (!id) {
      id = plexiId()
      localStorage.setItem('fb.sync.deviceId', id)
    }
    return id
  } catch {
    // No storage (should not happen in the renderer) — fall back to an ephemeral id
    // so LWW still has a distinct actor for this session.
    return plexiId()
  }
}

// The sync partition (room) for an account's widgets. The first slice scopes
// widgets to the owning account, so it is multi-device convergence for one user;
// shared-desk partitions come with their own access check in a later step.
export function widgetPartition(accountId: string): string {
  return `w:acct:${accountId}`
}

// The sync partition for an account's nodes. Separate from widgets so each type's
// log and catch-up are independent (the server sequences each partition on its own).
export function nodePartition(accountId: string): string {
  return `n:acct:${accountId}`
}

// The sync partition for an account's table rows.
export function rowPartition(accountId: string): string {
  return `r:acct:${accountId}`
}

// The sync partition for an account's time blocks.
export function timeBlockPartition(accountId: string): string {
  return `t:acct:${accountId}`
}

// The sync partition for an account's file/folder entries.
export function filePartition(accountId: string): string {
  return `f:acct:${accountId}`
}

// The sync partition for an account's document metadata.
export function documentPartition(accountId: string): string {
  return `d:acct:${accountId}`
}

// The sync partition for an account's widget links (wires).
export function linkPartition(accountId: string): string {
  return `l:acct:${accountId}`
}

// The sync partition (room) for a LIVE folder's tree entries. A live folder is its
// OWN room keyed by the live-folder id, NOT by the viewer's active scope — every
// member converges regardless of which org they are in, exactly like the folder's
// membership-based REST access. The server authorises this `folder:` scope by
// live-doc membership (liveDocs.isMember), the same rule its REST endpoints use.
export function liveFolderPartition(folderId: string): string {
  return `lfe:folder:${folderId}`
}

// The partition SCOPE suffix for the currently-active workspace. The renderer is
// single-org-at-a-time, so this alone routes every object correctly: a real active
// org → `org:<orgId>` (all members converge), otherwise the account's own devices →
// `acct:<accountId>`. Pure + unit-tested; the engine prepends the per-type prefix.
// 'personal' mirrors PERSONAL_ORG_ID in stores/org (kept literal to avoid importing
// the zustand store into this pure module).
export function crdtScopeSuffix(activeOrgId: string | null | undefined, accountId: string): string {
  return activeOrgId && activeOrgId !== 'personal' ? `org:${activeOrgId}` : `acct:${accountId}`
}

// Per-OBJECT partition scope, with shared-desk taking precedence. An object under a
// desk shared with named individuals carries a shared_root_id; it must route to that
// desk's partition so every grantee (across accounts) converges, REGARDLESS of whose
// account or which org it is being viewed in — otherwise a shared-desk edit would be
// stranded in the editor's personal/org scope and never reach the other grantees.
// With no shared root it falls back to the active-workspace scope (org or account).
// This precedence (desk > org > account) is the contract that keeps a shared object
// on the shared channel and a private object off it.
/** DEC-144 — the org a partition key belongs to (`<type>:org:<orgId>`), or
 *  null for an account or desk partition (those land in Personal). */
export function orgOfPartition(partitionKey: string | null | undefined): string | null {
  const m = /^[a-z]+:org:(.+)$/.exec(partitionKey ?? '')
  return m ? m[1] : null
}

export function crdtObjectScope(
  sharedRootId: string | null | undefined,
  activeOrgId: string | null | undefined,
  accountId: string
): string {
  if (sharedRootId) return `desk:${sharedRootId}`
  return crdtScopeSuffix(activeOrgId, accountId)
}
