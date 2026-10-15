import type { FbNode } from '@shared/types'
import { promptText, confirmDialog } from '../components/plexi/PromptDialog'
import { useNodeStore } from '../stores/nodes'
import { useWorkItemStore } from '../stores/workItems'
import { useAccountStore } from '../stores/account'
import { revokeDeskAccess } from './deskShareClient'
import { crdtEmitNodeDelete, crdtEmitWidgetDelete } from './crdtBridge'

// DEC-021/DEC-022 — the delete flows (TRACK-LIFECYCLE L2, reshaped by
// operator QA):
//
// "Move to Trash" is DIRECT — no dialog. It is the everyday, undoable path
// (7-day window; memory untouched; attention items sweep along restorably).
// The memory-preservation contract is stated where the trash lives: the
// Trash page's copy.
//
// "Delete permanently" lives on the Trash page, per item — the OS-native
// "empty trash" shape: typed-name confirmation, immediate hard-delete of the
// whole subtree, memory purged (facts, chunk derivations, review points).
// Attention items STILL survive it (R008: no work_item hard-delete) — they
// detach back to the Attention page, and the closing notice counts them.
//
// D1: shared desks reach neither path — Archive-for-me / Leave-share instead
// (the archived flag is scope-local on shared sync, both directions).

/**
 * DEC-142 — tell the sync layer what a permanent delete erased.
 *
 * The purge only ever ran against this device's database. The workspace kept
 * the desk's widget snapshots and re-offered them to every device on every
 * poll, where they could never be created again: their parent node was gone,
 * so each failed a FOREIGN KEY check and retried for ever (measured at 888
 * failed writes a minute for one desk deleted in August, filling 97% of the
 * dev log). Tombstoning the widgets and the nodes is what makes
 * "permanently" true beyond this machine.
 *
 * Children first, then their parents — the order a peer applies cleanly.
 */
export function tombstonePurged(purged: { nodeIds: string[]; widgetIds: string[] }): void {
  for (const widgetId of purged.widgetIds) crdtEmitWidgetDelete(widgetId)
  if (purged.nodeIds.length > 0) crdtEmitNodeDelete(purged.nodeIds)
}

export async function confirmPermanentDelete(entry: {
  id: string
  kind: string
  title: string
}): Promise<boolean> {
  const noun = entry.kind === 'folder' ? 'room' : 'desk'
  const title = entry.title || `Untitled ${noun}`
  const expected = (entry.title || '').trim()
  const typed = await promptText({
    title: `Type the ${noun}'s name to confirm`,
    label: `“${title}” and everything Plexii learned from it are erased immediately. Attention items on it are preserved — they move to your Attention page. This cannot be undone.`,
    placeholder: expected || `Untitled ${noun}`,
    confirmLabel: 'Delete permanently',
    danger: true,
    selectAll: false
  })
  if (typed == null) return false
  if (expected && typed.trim().toLowerCase() !== expected.toLowerCase()) {
    await confirmDialog({
      title: 'Name did not match',
      body: `Nothing was deleted. Type “${expected}” exactly to confirm a permanent delete.`,
      confirmLabel: 'OK'
    })
    return false
  }

  const result = await window.api.nodes.deletePermanent(entry.id)
  tombstonePurged(result)
  await useNodeStore.getState().refresh()
  await useWorkItemStore.getState().refresh()
  window.dispatchEvent(new CustomEvent('fb:workitems-changed'))
  if (result.revived > 0) {
    await confirmDialog({
      title: `“${title}” deleted permanently`,
      body: `${result.revived} attention item${result.revived === 1 ? ' was' : 's were'} preserved and moved to your Attention page.`,
      confirmLabel: 'OK'
    })
  }
  return true
}

/** D1's "Leave share" — the recipient side: give up this account's access,
 *  then prune the local materialization (detach-and-revive included). If the
 *  server declines the self-revocation, nothing local is touched. */
export async function leaveSharedDesk(node: FbNode): Promise<void> {
  const rootId = node.sharedRootId
  const accountId = useAccountStore.getState().account?.id
  if (!rootId || !accountId) return
  const ok = await confirmDialog({
    title: `Leave “${node.title || 'this desk'}”?`,
    body: 'It disappears from your workspace; the other participants keep it. Any attention items of yours on it move to your Attention page.',
    confirmLabel: 'Leave share',
    danger: true
  })
  if (!ok) return
  // revokeDeskAccess resolves null on ANY failure (offline, declined) —
  // leave nothing local half-removed in that case.
  const revoked = await revokeDeskAccess(rootId, accountId)
  if (!revoked) {
    await confirmDialog({
      title: 'Could not leave the share',
      body: 'The server declined or was unreachable — nothing changed. Ask the owner to remove you if it persists.',
      confirmLabel: 'OK'
    })
    return
  }
  await window.api.workspaceSync.pruneSharedDesk(rootId)
  await useNodeStore.getState().refresh()
  await useWorkItemStore.getState().refresh()
}

// ── Bulk lifecycle actions (DEC-022) ────────────────────────────────────────
// Shared by the All Desks and All Rooms indexes' selection mode. Shared-scope
// roots are excluded from trash (D1) with an honest count; archive applies to
// everything selected (scope-local on shared rows).

export async function bulkArchive(nodes: FbNode[], archived: boolean): Promise<void> {
  const update = useNodeStore.getState().update
  for (const n of nodes) {
    if (n.archived !== archived) await update(n.id, { archived })
  }
}

export async function bulkTrash(nodes: FbNode[]): Promise<void> {
  const shared = nodes.filter((n) => n.sharedRootId)
  const own = nodes.filter((n) => !n.sharedRootId)
  if (own.length) {
    const ok = await confirmDialog({
      title: `Move ${own.length} item${own.length === 1 ? '' : 's'} to Trash?`,
      body:
        `Restorable for 7 days; what Plexii learned stays.` +
        (shared.length
          ? ` ${shared.length} shared item${shared.length === 1 ? ' is' : 's are'} skipped — leave or archive those instead.`
          : ''),
      confirmLabel: 'Move to Trash',
      danger: true
    })
    if (!ok) return
    await useNodeStore.getState().removeMany(own.map((n) => n.id))
  } else if (shared.length) {
    await confirmDialog({
      title: 'Only shared items selected',
      body: 'Shared desks and rooms are never trashed unilaterally — leave the share or archive them for yourself instead.',
      confirmLabel: 'OK'
    })
  }
}

/** Move the selected desks under another room (or to the top level). */
export async function bulkMoveToRoom(nodes: FbNode[]): Promise<void> {
  const all = useNodeStore.getState().nodes
  const rooms = all.filter((n) => n.kind === 'folder' && !n.archived)
  const movable = nodes.filter((n) => !n.sharedRootId)
  if (!movable.length) return
  const target = await promptText({
    title: `Move ${movable.length} desk${movable.length === 1 ? '' : 's'} where?`,
    choices: [
      { value: '', label: 'Top level', hint: 'No room' },
      ...rooms
        .filter((r) => !nodes.some((n) => n.id === r.id))
        .map((r) => ({ value: r.id, label: r.title || 'Untitled room' }))
    ]
  })
  if (target == null) return
  const move = useNodeStore.getState().move
  for (const n of movable) {
    if ((n.parentId ?? '') !== target) await move(n.id, target || null, null)
  }
}
