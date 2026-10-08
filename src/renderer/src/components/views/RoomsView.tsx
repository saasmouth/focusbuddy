import { useMemo, useState } from 'react'
import type { FbNode, Widget } from '@shared/types'
import { useNodeStore } from '../../stores/nodes'
import { useOrgStore, PERSONAL_ORG_ID } from '../../stores/org'
import { useViewStore } from '../../stores/view'
import { useMessagingStore } from '../../stores/messaging'
import { useDeskWidgets } from '../../lib/useDeskWidgets'
import { formatRelativeTime } from '../../lib/changelog'
import RoomThumb from '../RoomThumb'
import Icon from '../Icon'
import SharedBadge from '../SharedBadge'
import { promptText } from '../plexi/PromptDialog'
import { shareToOrgOrGroup } from '../../lib/shareScope'
import ShareDialog from '../ShareDialog'
import RoomsDesksIndex, { type IndexConfig } from './RoomsDesksIndex'
import { lifecycleIndexActions } from '../../lib/deskLifecycleMenu'
import { bulkArchive, bulkTrash } from '../../lib/deleteDeskFlow'

// The All Rooms index. A Room is a folder node — a place desks live. Clicking a
// room opens its scoped Desks index (the "expand to show my desks" gesture). A
// Room that is also a Plan (is_plan) is badged, but still shows here as a room.

function rel(ms: number): string {
  return formatRelativeTime(new Date(ms).toISOString())
}

export default function RoomsView(): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const move = useNodeStore((s) => s.move)
  const create = useNodeStore((s) => s.create)
  const update = useNodeStore((s) => s.update)
  const moveToOrg = useNodeStore((s) => s.moveToOrg)
  // Lifecycle L1: the archived shelf (same mechanics as All Desks).
  const [showArchived, setShowArchived] = useState(
    () => localStorage.getItem('rooms-index.archived') === '1'
  )
  const toggleArchived = (): void => {
    setShowArchived((v) => {
      localStorage.setItem('rooms-index.archived', v ? '0' : '1')
      return !v
    })
  }
  const activeOrgId = useOrgStore((s) => s.activeOrgId)
  // Stable selector + useMemo: filtering inside the selector returns a new array
  // each render, which sends Zustand into an infinite re-render (React #185).
  const orgs = useOrgStore((s) => s.orgs)
  // A room is shared by moving it (and its desks/widgets) into a team org,
  // optionally narrowed to a group. Offered only from the Personal workspace when a
  // team org exists.
  const sharedOrgs = useMemo(() => orgs.filter((o) => !o.personal), [orgs])
  const canShare = activeOrgId === PERSONAL_ORG_ID && sharedOrgs.length > 0
  // Plans keep their own dashboard; every other room opens its desks. See the
  // note on goRoom in stores/view.ts.
  const goProject = useViewStore((s) => s.goProject)
  const goDesks = useViewStore((s) => s.goDesks)
  const openObjectChannel = useMessagingStore((s) => s.openObjectChannel)
  // Public share-link target (a room shared as a 'folder' snapshot with its
  // desks). Opens the universal ShareDialog; null when closed.
  const [linkTarget, setLinkTarget] = useState<{ id: string; title: string } | null>(null)

  const rooms = useMemo(
    () => nodes.filter((n) => n.kind === 'folder' && (showArchived ? n.archived : !n.archived)),
    [nodes, showArchived]
  )
  const archivedCount = useMemo(
    () => nodes.filter((n) => n.kind === 'folder' && n.archived).length,
    [nodes]
  )
  const roomTitleById = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of rooms) m.set(r.id, r.title || 'Untitled room')
    return m
  }, [rooms])

  // Direct child desks per room (for the thumbnail composite + counts). Sub-rooms
  // are counted separately.
  const childDesksByRoom = useMemo(() => {
    const m = new Map<string, FbNode[]>()
    for (const n of nodes) {
      if (n.kind === 'task' && !n.archived && n.parentId) {
        const arr = m.get(n.parentId) ?? []
        arr.push(n)
        m.set(n.parentId, arr)
      }
    }
    return m
  }, [nodes])

  const subRoomCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of nodes) {
      if (n.kind === 'folder' && !n.archived && n.parentId) {
        m.set(n.parentId, (m.get(n.parentId) ?? 0) + 1)
      }
    }
    return m
  }, [nodes])

  // Load widgets for the first few desks of every room so the composite icon has
  // real content to draw. Cap per room to keep the fetch bounded.
  const previewDeskIds = useMemo(() => {
    const ids: string[] = []
    for (const r of rooms) {
      const desks = childDesksByRoom.get(r.id) ?? []
      for (const d of desks.slice(0, 4)) ids.push(d.id)
    }
    return ids
  }, [rooms, childDesksByRoom])
  const widgetsByDesk = useDeskWidgets(previewDeskIds)

  function roomDeskSets(r: FbNode): Widget[][] {
    const desks = (childDesksByRoom.get(r.id) ?? []).slice(0, 4)
    return desks.map((d) => widgetsByDesk[d.id] ?? [])
  }

  const config: IndexConfig<FbNode> = {
    storageKey: 'rooms-index',
    title: showArchived ? 'Archived rooms' : 'All rooms',
    subtitle: 'Rooms are where your desks live. Open a room to see the desks inside it.',
    items: rooms,
    idOf: (r) => r.id,
    titleOf: (r) => r.title || 'Untitled room',
    // Mark a room shared with you by name (live per-desk share), with who shared it.
    badge: (r) =>
      r.sharedRootId ? (
        <SharedBadge
          handle={r.sharedFromHandle ?? '?'}
          label={r.sharedFromHandle ? `Shared by ${r.sharedFromHandle}` : 'Shared with you'}
        />
      ) : null,
    searchText: (r) => `${r.title} ${r.description}`,
    thumb: (r) => <RoomThumb deskWidgetSets={roomDeskSets(r)} width={320} height={144} />,
    smallIcon: (r) => (
      <div className="h-full w-full">
        <RoomThumb deskWidgetSets={roomDeskSets(r)} width={32} height={32} />
      </div>
    ),
    metaLine: (r) => {
      const desks = childDesksByRoom.get(r.id)?.length ?? 0
      const subs = subRoomCount.get(r.id) ?? 0
      const parts = [
        `${desks} ${desks === 1 ? 'desk' : 'desks'}`,
        subs ? `${subs} sub-${subs === 1 ? 'room' : 'rooms'}` : null,
        r.isPlan ? 'Plan' : null
      ].filter(Boolean)
      return parts.join(' · ')
    },
    columns: [
      {
        key: 'desks',
        label: 'Desks',
        align: 'right',
        render: (r) => childDesksByRoom.get(r.id)?.length ?? 0
      },
      {
        key: 'subrooms',
        label: 'Sub-rooms',
        align: 'right',
        render: (r) => subRoomCount.get(r.id) ?? 0
      },
      { key: 'type', label: 'Type', render: (r) => (r.isPlan ? 'Plan' : 'Room') },
      {
        key: 'parent',
        label: 'In room',
        render: (r) => (r.parentId ? roomTitleById.get(r.parentId) ?? '—' : 'Top level')
      },
      { key: 'updated', label: 'Updated', align: 'right', render: (r) => rel(r.updatedAt) }
    ],
    groups: [
      {
        key: 'type',
        label: 'Type',
        groupOf: (r) => ({
          id: r.isPlan ? 'plan' : 'room',
          label: r.isPlan ? 'Plans' : 'Rooms',
          order: r.isPlan ? 1 : 0
        })
      },
      {
        key: 'parent',
        label: 'Parent room',
        groupOf: (r) => ({
          id: r.parentId ?? 'top',
          label: r.parentId ? roomTitleById.get(r.parentId) ?? 'Unknown room' : 'Top level',
          order: r.parentId ? 1 : 0
        })
      }
    ],
    filters: [
      { key: 'rooms', label: 'Rooms only', predicate: (r) => !r.isPlan },
      { key: 'plans', label: 'Plans only', predicate: (r) => r.isPlan },
      { key: 'top', label: 'Top level', predicate: (r) => r.parentId == null }
    ],
    timelineDate: (r) => r.createdAt,
    // Opening a room = its scoped Desks index (the "show me its desks"
    // gesture this page's header promises). A room that is a PLAN keeps its
    // plan dashboard — that canvas has content; a plain room's would be blank
    // (the operator-reported bug this line fixes).
    onOpen: (r) => (r.isPlan ? goProject(r.id) : goDesks(r.id)),
    newLabel: 'New room',
    onNew: () => {
      void (async () => {
        try {
          const node = await create({ parentId: null, kind: 'folder', title: 'New room' })
          goDesks(node.id)
        } catch {
          /* create() surfaces its own limit prompt */
        }
      })()
    },
    onReorder: (ids) => {
      void (async () => {
        for (const id of ids) {
          const node = rooms.find((r) => r.id === id)
          if (node) await move(id, node.parentId, null)
        }
      })()
    },
    // One declarative list drives both the hover icon strip and the right-click
    // context menu — the menu is where the icons become discoverable.
    itemActions: (r) => [
      ...(canShare
        ? [
            {
              key: 'share',
              icon: 'group_add',
              label: 'Share with team or group',
              title: 'Share with your team or a group',
              onClick: () => {
                void shareToOrgOrGroup({
                  name: r.title || 'this room',
                  kindLabel: 'room and its desks',
                  sharedOrgs,
                  move: (org, team) => moveToOrg(r.id, org, team)
                })
              }
            }
          ]
        : []),
      {
        key: 'link',
        icon: 'link',
        label: 'Create public link',
        title: 'Create a public link — anyone with it can view this room',
        onClick: () => setLinkTarget({ id: r.id, title: r.title || 'this room' })
      },
      {
        key: 'chat',
        icon: 'forum',
        label: 'Chat about this room',
        onClick: () => {
          void openObjectChannel('room', r.id, r.title || 'Room')
        }
      },
      {
        key: 'rename',
        icon: 'edit',
        label: 'Rename room',
        onClick: () => {
          void (async () => {
            const next = await promptText({
              title: 'Rename room',
              label: 'Room name',
              initial: r.title || '',
              confirmLabel: 'Rename'
            })
            const trimmed = next?.trim()
            if (trimmed && trimmed !== (r.title || '')) await update(r.id, { title: trimmed })
          })()
        }
      },
      {
        key: 'plan',
        icon: r.isPlan ? 'layers_clear' : 'account_tree',
        label: r.isPlan ? 'Remove from Plans' : 'Make this a plan',
        title: r.isPlan
          ? 'Make this a plain room (removes it from Plans)'
          : 'Make this a plan (adds it to the Plans timeline)',
        onClick: () => {
          void update(r.id, { isPlan: !r.isPlan })
        }
      },
      {
        key: 'open',
        icon: 'chevron_right',
        label: r.isPlan ? 'Open plan' : 'Open room',
        onClick: () => (r.isPlan ? goProject(r.id) : goDesks(r.id))
      },
      // Lifecycle (DEC-021): the ONE shared definition — archive/trash for
      // personal rooms; Archive-for-me / Leave-share + the reason for shared.
      // A trashed room's desks travel with it; the undo toast restores all.
      ...lifecycleIndexActions(r)
    ],
    // DEC-022: bulk archive/trash over selected rooms (desks travel along).
    bulkActions: (ids, done) => {
      const byId = (): FbNode[] => {
        const all = useNodeStore.getState().nodes
        return ids.map((id) => all.find((n) => n.id === id)).filter((n): n is FbNode => !!n)
      }
      return [
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
    headerActions:
      archivedCount > 0 || showArchived ? (
        <button
          onClick={toggleArchived}
          title={showArchived ? 'Back to live rooms' : 'Show archived rooms'}
          className={`inline-flex items-center gap-1 h-9 px-3 fb-btn-surface fb-press fb-t-label ${
            showArchived
              ? 'text-[var(--ink-100)]'
              : 'text-[var(--ink-70)] hover:text-[var(--ink-100)]'
          }`}
        >
          <Icon name={showArchived ? 'arrow_back' : 'archive'} size={15} />
          {showArchived ? 'Live rooms' : `Archived${archivedCount ? ` (${archivedCount})` : ''}`}
        </button>
      ) : undefined
  }

  return (
    <>
      <RoomsDesksIndex config={config} />
      {linkTarget && (
        <ShareDialog
          kind="folder"
          entityId={linkTarget.id}
          label={linkTarget.title}
          onClose={() => setLinkTarget(null)}
        />
      )}
    </>
  )
}
