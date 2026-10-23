import type { FbNode } from '@shared/types'
import { MENU } from '@shared/menus/lexicon'
import type { CtxMenuItem } from '../components/CanvasContextMenu'
import { promptText } from '../components/plexi/PromptDialog'
import { useNodeStore } from '../stores/nodes'
import { useViewStore } from '../stores/view'
import { useOrgStore, PERSONAL_ORG_ID } from '../stores/org'
import { useMessagingStore } from '../stores/messaging'
import { useChatStore, NEW_CHAT_KEY } from '../stores/chat'
import { useAssistantChrome } from '../stores/assistantChrome'
import { leaveSharedDesk } from './deleteDeskFlow'
import { shareToOrgOrGroup } from './shareScope'
import { presetForDesk } from './attentionPresets'
import { mentionFromNode } from './assistantMentions'
import { objectMenu } from './objectMenu'

// ONE right-click menu for a desk or a room, wherever one is shown: the All
// Desks and All Rooms index pages (every view mode) and the desk gallery. A
// desk reads the same in all of them (tests/unit/contextMenuContract.wp2.test.tsx
// holds them equal), so the gallery can no longer say "Open desk" first while
// the index said it fourth (AUDIT F-6).
//
// SPEC §9.3 order, as the owner ruled (E-1, E-2): Open · Add to Focus… ·
// Rename · Share… | Ask PlexiiAssist | Remove from ‹container› · Archive · Move
// to Trash, last and in danger. Both orders live in ONE place, leadRows and
// lifecycleRows below, which every object menu outside the office apps uses. The actions live here
// as plain functions so the index pages' hover strips call the very same code.
//
// DEC-021 (reshaped by operator QA): "Move to Trash" is DIRECT — undoable,
// 7-day window, memory untouched. Shared desks (D1) get Archive-for-me
// (scope-local: the archived flag is stripped from shared sync in both
// directions) and, for received shares, Leave share; Move to Trash stays in the
// menu, disabled, with the reason (SPEC §9.5) instead of an informational row.

const nounOf = (node: FbNode): 'desk' | 'room' => (node.kind === 'folder' ? 'room' : 'desk')
const titleOf = (node: FbNode): string => node.title || (node.kind === 'folder' ? 'Untitled room' : 'Untitled desk')

/** Open a desk on its canvas; a room as its desks, or a plan on its own dashboard (goRoom's note in stores/view). */
export function openNode(node: FbNode): void {
  const view = useViewStore.getState()
  if (node.kind === 'folder') {
    if (node.isPlan) view.goProject(node.id)
    else view.goRoom(node.id)
    return
  }
  useNodeStore.getState().setActive(node.id)
  view.goTask(node.id)
}

/** The house prompt, then the store. */
export async function renameNode(node: FbNode): Promise<void> {
  const noun = nounOf(node)
  const next = await promptText({
    title: noun === 'room' ? 'Rename room' : 'Rename desk',
    label: noun === 'room' ? 'Room name' : 'Desk name',
    initial: node.title || '',
    confirmLabel: 'Rename'
  })
  const trimmed = next?.trim()
  if (trimmed && trimmed !== (node.title || '')) await useNodeStore.getState().update(node.id, { title: trimmed })
}

/** A desk or room is shared with a team by MOVING it into a team org; offered from Personal when one exists. */
export function canShareToTeam(): boolean {
  const { activeOrgId, orgs } = useOrgStore.getState()
  return activeOrgId === PERSONAL_ORG_ID && orgs.some((o) => !o.personal)
}

export function shareNodeToTeam(node: FbNode): void {
  const room = node.kind === 'folder'
  void shareToOrgOrGroup({
    name: node.title || (room ? 'this room' : 'this desk'),
    kindLabel: room ? 'room and its desks' : 'desk and its work widgets',
    sharedOrgs: useOrgStore.getState().orgs.filter((o) => !o.personal),
    move: (org, team) => useNodeStore.getState().moveToOrg(node.id, org, team)
  })
}

export function chatAboutRoom(node: FbNode): void {
  void useMessagingStore.getState().openObjectChannel('room', node.id, node.title || 'Room')
}

export function togglePlan(node: FbNode): void {
  void useNodeStore.getState().update(node.id, { isPlan: !node.isPlan })
}

/**
 * CR-09 Q3: mark the whole desk (or room) for Focus. The same capture seam
 * every other "Add to Focus…" uses (fb:command-new-work-item → the confirm
 * card), with presetForDesk's text and class. The item POINTS at the node; it
 * parents onto the desk only where a work item may live (a personal, live
 * desk — the Focus editor's own rule), never onto a room.
 */
export function addNodeToFocus(node: FbNode): void {
  const p = presetForDesk(node.title || '')
  const parentable = node.kind === 'task' && !node.archived && !node.sharedRootId
  window.dispatchEvent(
    new CustomEvent('fb:command-new-work-item', {
      detail: {
        captureText: p.text,
        source: {
          sourceType: nounOf(node),
          sourceRef: node.id,
          intentClass: p.intentClass,
          deskId: parentable ? node.id : null,
          deskTitle: parentable ? titleOf(node) : null
        }
      }
    })
  )
}

/** Attach the desk or room to PlexiiAssist as a mention chip and open the panel (the @-mention path). */
export function askAssistAboutNode(node: FbNode): void {
  const chat = useChatStore.getState()
  chat.addMentionRef(mentionFromNode(node, chat.activeConversationId ?? NEW_CHAT_KEY))
  useAssistantChrome.getState().openPanel()
}

function setArchived(node: FbNode, archived: boolean): void {
  void useNodeStore.getState().update(node.id, { archived })
}

/**
 * E-1 (owner ruling): an object menu leads with Open, then Add to Focus….
 * The one place that order is written; desks, rooms, Home cards and Focus
 * rows all start their object group with this.
 */
export function leadRows(open: CtxMenuItem | null, addToFocus: CtxMenuItem | null): CtxMenuItem[] {
  return [open, addToFocus].filter((r): r is CtxMenuItem => !!r)
}

/**
 * E-2 (owner ruling): the destructive group is explicit rows in this order —
 * Remove from ‹container› · Archive · Move to Trash. The one place that order
 * is written; objectMenu marks them danger and puts them last.
 */
export function lifecycleRows(r: { remove?: CtxMenuItem | null; archive?: CtxMenuItem | null; trash?: CtxMenuItem | null }): CtxMenuItem[] {
  return [r.remove, r.archive, r.trash].filter((x): x is CtxMenuItem => !!x)
}

export interface NodeMenuHost {
  /** Opens the universal ShareDialog for this node; the hosting view renders it. */
  onShare: (node: FbNode) => void
}

/** The menu for one desk or room. `host` supplies only what needs the hosting view's state. */
export function deskMenuItems(node: FbNode, host: NodeMenuHost): CtxMenuItem[] {
  const room = node.kind === 'folder'
  const shared = !!node.sharedRootId
  const id = (key: string): string => `node-menu-${key}`

  const object: CtxMenuItem[] = [
    ...leadRows(
      { label: MENU.open.label, icon: 'open_in_new', testid: id('open'), onClick: () => openNode(node) },
      { label: MENU.addToFocus.label, icon: 'notifications', testid: id('focus'), onClick: () => addNodeToFocus(node) }
    ),
    { label: MENU.rename.label, icon: 'edit', testid: id('rename'), onClick: () => void renameNode(node) }
  ]
  // Taking a node off the archived shelf is not destructive, so it is an object row.
  if (node.archived) {
    object.push({
      label: shared ? 'Unarchive for me' : 'Unarchive',
      icon: 'unarchive',
      testid: id('unarchive'),
      onClick: () => setArchived(node, false)
    })
  }
  // Share… (the ShareDialog: public links and the desk share sheet), then,
  // where it applies, Share with team or group… as its own row: the same two
  // rows, same words, as a file in Files (WP3's fileEntryMenu), so a desk, a
  // room and a file read alike.
  object.push({ label: MENU.share.label, icon: 'ios_share', testid: id('share'), onClick: () => host.onShare(node) })
  if (canShareToTeam()) {
    // TODO(§9 lexicon): move to MENU.shareWithTeam (shared with FILES_MENU_LABELS.shareWithTeam).
    object.push({ label: 'Share with team or group…', icon: 'group_add', testid: id('share-team'), onClick: () => shareNodeToTeam(node) })
  }
  if (room) {
    object.push(
      {
        label: node.isPlan ? 'Remove from Plans' : 'Make this a plan',
        icon: node.isPlan ? 'layers_clear' : 'account_tree',
        testid: id('plan'),
        onClick: () => togglePlan(node)
      },
      { label: 'Chat about this room', icon: 'forum', testid: id('chat'), onClick: () => chatAboutRoom(node) }
    )
  }

  let destructive: CtxMenuItem[]
  if (shared) {
    destructive = lifecycleRows({
      // A received share: leaving takes it out of this account's workspace
      // (the share's "Remove from…"), and is this account's own right.
      remove: node.sharedFromHandle
        ? { label: 'Leave share', icon: 'logout', testid: id('leave-share'), onClick: () => void leaveSharedDesk(node) }
        : null,
      archive: node.archived
        ? null
        : { label: 'Archive for me', icon: 'archive', testid: id('archive'), onClick: () => setArchived(node, true) },
      // D1 (DEC-021): no unilateral trash of a shared desk in v1.
      trash: {
        label: MENU.moveToTrash.label,
        icon: 'delete',
        testid: id('trash'),
        disabled: true,
        hint: node.sharedFromHandle
          ? `Shared by @${node.sharedFromHandle}: leave or archive instead`
          : 'Shared: unshare it before deleting'
      }
    })
  } else {
    // A desk or room is not a placement in anything, so it has no Remove from….
    destructive = lifecycleRows({
      archive: node.archived
        ? null
        : { label: MENU.archive.label, icon: 'archive', testid: id('archive'), onClick: () => setArchived(node, true) },
      trash: { label: MENU.moveToTrash.label, icon: 'delete', testid: id('trash'), onClick: () => void useNodeStore.getState().remove(node.id) }
    })
  }

  return objectMenu({
    object,
    plexii: [{ label: MENU.askAssist.label, icon: 'auto_awesome', testid: id('ask'), onClick: () => askAssistAboutNode(node) }],
    destructive
  })
}
