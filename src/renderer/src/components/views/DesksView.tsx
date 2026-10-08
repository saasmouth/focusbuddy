import { useMemo, useState } from 'react'
import LazyVisible from '../LazyVisible'
import type { FbNode } from '@shared/types'
import { useNodeStore } from '../../stores/nodes'
import { useWorkItemStore } from '../../stores/workItems'
import { isTerminalState } from '../../lib/attentionQueues'
import { useOrgStore, PERSONAL_ORG_ID } from '../../stores/org'
import { requestNewDesk } from '../../lib/newDesk'
import { useViewStore } from '../../stores/view'
import { useDeskWidgets, realWidgetCount } from '../../lib/useDeskWidgets'
import { formatRelativeTime } from '../../lib/changelog'
import DeskMiniature from '../DeskMiniature'
import Icon from '../Icon'
import SharedBadge from '../SharedBadge'
import { promptText } from '../plexi/PromptDialog'
import { shareToOrgOrGroup } from '../../lib/shareScope'
import ShareDialog from '../ShareDialog'
import RoomsDesksIndex, { type IndexConfig } from './RoomsDesksIndex'
import { lifecycleIndexActions } from '../../lib/deskLifecycleMenu'
import { bulkArchive, bulkMoveToRoom, bulkTrash } from '../../lib/deleteDeskFlow'

// The All Desks index. A Desk is a task node (a canvas). Optionally scoped to a
// single Room via roomId, in which case only that room's descendant desks show.

const STATUS_LABEL: Record<FbNode['status'], string> = {
  open: 'To do',
  in_progress: 'In progress',
  done: 'Done',
  parked: 'Parked'
}
const STATUS_ORDER: Record<FbNode['status'], number> = {
  open: 0,
  in_progress: 1,
  parked: 2,
  done: 3
}

function rel(ms: number): string {
  return formatRelativeTime(new Date(ms).toISOString())
}

export default function DesksView({ roomId }: { roomId?: string }): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const move = useNodeStore((s) => s.move)
  const setActive = useNodeStore((s) => s.setActive)
  const create = useNodeStore((s) => s.create)
  const update = useNodeStore((s) => s.update)
  const moveToOrg = useNodeStore((s) => s.moveToOrg)
  // Lifecycle L1: the archived shelf. Off = the live index (archived hidden,
  // as always); on = archived desks only. Persisted like the index's own modes.
  const [showArchived, setShowArchived] = useState(
    () => localStorage.getItem('desks-index.archived') === '1'
  )
  const toggleArchived = (): void => {
    setShowArchived((v) => {
      localStorage.setItem('desks-index.archived', v ? '0' : '1')
      return !v
    })
  }
  const activeOrgId = useOrgStore((s) => s.activeOrgId)
  // Select the stable orgs array and derive with useMemo — filtering inside the
  // selector returns a fresh array every render, which Zustand treats as a change
  // and re-renders forever (React #185).
  const orgs = useOrgStore((s) => s.orgs)
  // Sharing a desk = moving it into a team org (optionally narrowed to a group).
  // Only offered from the Personal workspace (desks already in a team org are
  // shared), and only when the user belongs to a team org. useMemo over the stable
  // orgs array — a filtering selector returns a new array each render (React #185).
  const sharedOrgs = useMemo(() => orgs.filter((o) => !o.personal), [orgs])
  const canShare = activeOrgId === PERSONAL_ORG_ID && sharedOrgs.length > 0
  const goTask = useViewStore((s) => s.goTask)
  const goRooms = useViewStore((s) => s.goRooms)
  // Public share-link target (a desk shared as a 'task' snapshot). Opens the
  // universal ShareDialog; null when closed.
  const [linkTarget, setLinkTarget] = useState<{ id: string; title: string } | null>(null)

  // DEC-047 D-4 — each desk's attention signal, derived with the queues' own
  // active-set rules (non-terminal, not detached) + a due count.
  const workItems = useWorkItemStore((st) => st.items)
  const attentionByDesk = useMemo(() => {
    const m = new Map<string, { open: number; due: number }>()
    const now = Date.now()
    for (const i of workItems) {
      if (!i.parentId) continue
      if (isTerminalState(i.workItemState) || i.detachedFromId != null) continue
      const e = m.get(i.parentId) ?? { open: 0, due: 0 }
      e.open++
      if (i.dueAt && Date.parse(i.dueAt) < now + 48 * 60 * 60 * 1000) e.due++
      m.set(i.parentId, e)
    }
    return m
  }, [workItems])

  const roomTitleById = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of nodes) if (n.kind === 'folder') m.set(n.id, n.title || 'Untitled room')
    return m
  }, [nodes])

  // The set of room ids in-scope: the room itself plus every descendant folder,
  // so a desk nested in a sub-room of the scoped room still counts.
  const scopeRoomIds = useMemo(() => {
    if (!roomId) return null
    const set = new Set<string>([roomId])
    let grew = true
    while (grew) {
      grew = false
      for (const n of nodes) {
        if (n.kind === 'folder' && n.parentId && set.has(n.parentId) && !set.has(n.id)) {
          set.add(n.id)
          grew = true
        }
      }
    }
    return set
  }, [nodes, roomId])

  const desks = useMemo(
    () =>
      nodes.filter(
        (n) =>
          n.kind === 'task' &&
          (showArchived ? n.archived : !n.archived) &&
          (!scopeRoomIds || (n.parentId != null && scopeRoomIds.has(n.parentId)))
      ),
    [nodes, scopeRoomIds, showArchived]
  )
  const archivedCount = useMemo(
    () =>
      nodes.filter(
        (n) =>
          n.kind === 'task' &&
          n.archived &&
          (!scopeRoomIds || (n.parentId != null && scopeRoomIds.has(n.parentId)))
      ).length,
    [nodes, scopeRoomIds]
  )

  const widgetsByDesk = useDeskWidgets(useMemo(() => desks.map((d) => d.id), [desks]))

  function deskThumb(d: FbNode, w: number, h: number): JSX.Element {
    const ws = widgetsByDesk[d.id]
    if (!ws) {
      return <Icon name="task_alt" size={Math.min(w, h) * 0.4} className="text-[var(--ink-30)]" />
    }
    return <DeskMiniature widgets={ws} width={w} height={h} />
  }

  const scopeTitle = roomId ? roomTitleById.get(roomId) : null

  const config: IndexConfig<FbNode> = {
    storageKey: 'desks-index',
    title: showArchived
      ? scopeTitle
        ? `Archived desks in ${scopeTitle}`
        : 'Archived desks'
      : scopeTitle
        ? `Desks in ${scopeTitle}`
        : 'All desks',
    subtitle: scopeTitle
      ? 'Every canvas that lives in this room. Open one to bring its notes, files and tools to the surface.'
      : 'Every canvas across your rooms. Open one to bring its notes, files and tools to the surface.',
    items: desks,
    idOf: (d) => d.id,
    titleOf: (d) => d.title || 'Untitled desk',
    // Mark a desk shared with you by name, so it's obviously not one of your own and
    // you can see who shared it. Only live-shared desks (sharedRootId set) get this.
    badge: (d) =>
      d.sharedRootId ? (
        <SharedBadge
          handle={d.sharedFromHandle ?? '?'}
          label={d.sharedFromHandle ? `Shared by ${d.sharedFromHandle}` : 'Shared with you'}
        />
      ) : null,
    searchText: (d) => `${d.title} ${d.description}`,
    thumb: (d) => (
      <div className="h-full w-full flex items-center justify-center">
        {/* Each miniature renders every widget on its desk. Building them for
            cards nobody has scrolled to is what made this index slow. */}
        <LazyVisible>{deskThumb(d, 320, 144)}</LazyVisible>
      </div>
    ),
    // A 32px well is too small for a live miniature (its caption turns to noise);
    // icons are monochrome at rest per the icon doctrine.
    smallIcon: (d) => (
      <Icon name={d.kind === 'folder' ? 'folder' : 'desk'} size={16} className="text-[var(--ink-50)]" />
    ),
    metaLine: (d) => {
      const room = d.parentId ? roomTitleById.get(d.parentId) : null
      const count = widgetsByDesk[d.id] ? realWidgetCount(widgetsByDesk[d.id]) : null
      // DEC-047 D-4: the desk card carries its attention signal — derived
      // from the same active-set rules the queues use. Status groups stay
      // exactly as they were.
      const attn = attentionByDesk.get(d.id)
      const attnLine = attn
        ? `${attn.open} open${attn.due ? ` · ${attn.due} due` : ''}`
        : null
      return [room, STATUS_LABEL[d.status], count == null ? null : count === 0 ? 'empty' : `${count} items`, attnLine]
        .filter(Boolean)
        .join(' · ')
    },
    columns: [
      {
        key: 'room',
        label: 'Room',
        render: (d) => (d.parentId ? roomTitleById.get(d.parentId) ?? '—' : 'Top level')
      },
      { key: 'status', label: 'Status', render: (d) => STATUS_LABEL[d.status] },
      {
        key: 'items',
        label: 'Items',
        align: 'right',
        render: (d) => (widgetsByDesk[d.id] ? realWidgetCount(widgetsByDesk[d.id]) : '—')
      },
      { key: 'updated', label: 'Updated', align: 'right', render: (d) => rel(d.updatedAt) }
    ],
    groups: [
      {
        key: 'status',
        label: 'Status',
        groupOf: (d) => ({
          id: d.status,
          label: STATUS_LABEL[d.status],
          order: STATUS_ORDER[d.status]
        })
      },
      {
        key: 'room',
        label: 'Room',
        groupOf: (d) => ({
          id: d.parentId ?? 'top',
          label: d.parentId ? roomTitleById.get(d.parentId) ?? 'Unknown room' : 'Top level',
          order: 0
        })
      }
    ],
    filters: (['open', 'in_progress', 'done', 'parked'] as FbNode['status'][]).map((s) => ({
      key: s,
      label: STATUS_LABEL[s],
      predicate: (d) => d.status === s
    })),
    timelineDate: (d) => d.updatedAt,
    onOpen: (d) => {
      setActive(d.id)
      goTask(d.id)
    },
    newLabel: 'New desk',
    onNew: () => {
      // Same set-up dialog as the sidebar's New desk, pre-filed into the room
      // being viewed. This used to create an untitled "New desk" outright.
      if (requestNewDesk(roomId ?? null)) return
      void (async () => {
        try {
          const node = await create({ parentId: roomId ?? null, kind: 'task', title: 'New desk' })
          setActive(node.id)
          goTask(node.id)
        } catch {
          /* create() surfaces its own limit prompt */
        }
      })()
    },
    onReorder: (ids) => {
      // Persist the new order by re-appending each desk to the end of its parent
      // in the chosen sequence; done in order, the final sortOrder matches ids.
      void (async () => {
        for (const id of ids) {
          const node = desks.find((d) => d.id === id)
          if (node) await move(id, node.parentId, null)
        }
      })()
    },
    // One declarative list drives both the hover icon strip and the right-click
    // context menu. "Open desk" is menu-only (inStrip: false) — clicking the
    // card already opens it, so the strip stays as it was.
    itemActions: (d) => [
      ...(canShare
        ? [
            {
              key: 'share',
              icon: 'group_add',
              label: 'Share with team or group',
              title: 'Share with your team or a group',
              onClick: () => {
                void shareToOrgOrGroup({
                  name: d.title || 'this desk',
                  kindLabel: 'desk and its widgets',
                  sharedOrgs,
                  move: (org, team) => moveToOrg(d.id, org, team)
                })
              }
            }
          ]
        : []),
      {
        key: 'link',
        icon: 'link',
        label: 'Create public link',
        title: 'Create a public link — anyone with it can view this desk',
        onClick: () => setLinkTarget({ id: d.id, title: d.title || 'this desk' })
      },
      {
        key: 'rename',
        icon: 'edit',
        label: 'Rename desk',
        onClick: () => {
          void (async () => {
            const next = await promptText({
              title: 'Rename desk',
              label: 'Desk name',
              initial: d.title || '',
              confirmLabel: 'Rename'
            })
            const trimmed = next?.trim()
            if (trimmed && trimmed !== (d.title || '')) await update(d.id, { title: trimmed })
          })()
        }
      },
      {
        key: 'open',
        icon: 'chevron_right',
        label: 'Open desk',
        inStrip: false,
        onClick: () => {
          setActive(d.id)
          goTask(d.id)
        }
      },
      // Lifecycle (DEC-021): the ONE shared definition — archive/trash for
      // personal desks; Archive-for-me / Leave-share + the reason for shared.
      ...lifecycleIndexActions(d)
    ],
    // DEC-022: selection-mode bulk actions. Ids resolve against the live
    // store at click time; shared desks are skipped from trash with a count.
    bulkActions: (ids, done) => {
      const byId = (): FbNode[] => {
        const all = useNodeStore.getState().nodes
        return ids.map((id) => all.find((n) => n.id === id)).filter((n): n is FbNode => !!n)
      }
      return [
        {
          key: 'move-room',
          icon: 'drive_file_move',
          label: 'Move to room…',
          onClick: () => {
            void bulkMoveToRoom(byId()).then(done)
          }
        },
        {
          key: 'archive',
          icon: showArchived ? 'unarchive' : 'archive',
          label: showArchived ? 'Unarchive' : 'Archive',
          onClick: () => {
            void bulkArchive(byId(), !showArchived).then(done)
          }
        },
        {
          key: 'trash',
          icon: 'delete',
          label: 'Move to Trash',
          onClick: () => {
            void bulkTrash(byId()).then(done)
          }
        }
      ]
    },
    headerActions: (
      <>
        {roomId ? (
          <button
            onClick={() => goRooms()}
            className="inline-flex items-center gap-1 h-9 px-3 fb-btn-surface fb-press fb-t-label text-[var(--ink-70)] hover:text-[var(--ink-100)]"
          >
            <Icon name="arrow_back" size={15} /> All rooms
          </button>
        ) : null}
        {(archivedCount > 0 || showArchived) && (
          <button
            onClick={toggleArchived}
            title={showArchived ? 'Back to live desks' : 'Show archived desks'}
            className={`inline-flex items-center gap-1 h-9 px-3 fb-btn-surface fb-press fb-t-label ${
              showArchived
                ? 'text-[var(--ink-100)]'
                : 'text-[var(--ink-70)] hover:text-[var(--ink-100)]'
            }`}
          >
            <Icon name={showArchived ? 'arrow_back' : 'archive'} size={15} />
            {showArchived ? 'Live desks' : `Archived${archivedCount ? ` (${archivedCount})` : ''}`}
          </button>
        )}
      </>
    )
  }

  return (
    <>
      <RoomsDesksIndex config={config} />
      {linkTarget && (
        <ShareDialog
          kind="task"
          entityId={linkTarget.id}
          label={linkTarget.title}
          onClose={() => setLinkTarget(null)}
        />
      )}
    </>
  )
}
