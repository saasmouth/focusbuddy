import { useMemo, useRef, useState } from 'react'
import type { FbNode, NodeKind } from '@shared/types'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import { buildTree, flatten, isDescendantOrSelf, type TreeItem } from '../../lib/nodeTree'
import NewNodeDialog from '../NewNodeDialog'
import Icon from '../Icon'

// Folder tree surfaced on the home dashboard. Three top-level buckets
// (Active / Closed / Archived) each render the same kind of recursive
// folder/task tree the sidebar shows — including nested folders, click-
// row-to-expand-AND-navigate, hover create actions (+ folder / + task),
// and drag-drop reorder with parent/child reparenting.
//
// `expanded` is read from the shared `useNodeStore` so toggling a folder
// here is reflected in the sidebar too (and vice-versa). One mental model
// of "is this folder open" across every surface.

interface Props {
  nodes: FbNode[]
}

type Tab = 'active' | 'closed' | 'archived'

// Build a descendant-aware bucket label for each folder. Used to decide
// which root folders appear under each tab.
function bucketFor(folderId: string, allNodes: FbNode[]): Tab {
  const folder = allNodes.find((n) => n.id === folderId)
  if (!folder) return 'active'
  if (folder.archived) return 'archived'
  // Walk descendants once to find any active task. An empty folder counts
  // as "closed" — a natural "no current work" state, not necessarily a
  // failure mode.
  const childrenOf = new Map<string | null, FbNode[]>()
  for (const n of allNodes) {
    const list = childrenOf.get(n.parentId) ?? []
    list.push(n)
    childrenOf.set(n.parentId, list)
  }
  const stack = [folderId]
  let anyActiveTask = false
  let anyTaskAtAll = false
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined) break
    const kids = childrenOf.get(id) ?? []
    for (const kid of kids) {
      if (kid.archived) continue
      if (kid.kind === 'task') {
        anyTaskAtAll = true
        if (kid.status !== 'done') {
          anyActiveTask = true
        }
      } else if (kid.kind === 'folder') {
        stack.push(kid.id)
      }
      // work_item: not a desk and not a room — never bucketed here (S1)
    }
  }
  if (!anyTaskAtAll) return 'closed'
  return anyActiveTask ? 'active' : 'closed'
}

export default function FoldersCard({ nodes }: Props): JSX.Element {
  const expanded = useNodeStore((s) => s.expanded)
  const toggleExpand = useNodeStore((s) => s.toggleExpand)
  const setActive = useNodeStore((s) => s.setActive)
  const update = useNodeStore((s) => s.update)
  const moveNode = useNodeStore((s) => s.move)
  const goRoom = useViewStore((s) => s.goRoom)
  const goTask = useViewStore((s) => s.goTask)

  const [tab, setTab] = useState<Tab>('active')
  const [dialog, setDialog] = useState<
    | { mode: 'create'; parentId: string | null; kind: NodeKind }
    | null
  >(null)

  // Build the right pool of nodes per tab. Archived rolls up its own pool
  // (only archived nodes are visible). Active/Closed share the non-
  // archived pool — the difference is which TOP-LEVEL folders we expose.
  const { pool, bucketByRootId } = useMemo(() => {
    const archived = nodes.filter((n) => n.archived)
    const visible = nodes.filter((n) => !n.archived)
    const map = new Map<string, Tab>()
    for (const n of visible) {
      if (n.kind === 'folder' && n.parentId === null) {
        map.set(n.id, bucketFor(n.id, nodes))
      }
    }
    return {
      pool: tab === 'archived' ? archived : visible,
      bucketByRootId: map
    }
  }, [nodes, tab])

  const fullTree = useMemo(() => buildTree(pool), [pool])

  // Top-level filtering — for Active/Closed, only root folders matching
  // the bucket. For Archived, show everything in the archived pool (which
  // is already filtered to archived rows).
  const tree = useMemo(() => {
    if (tab === 'archived') return fullTree
    return fullTree.filter((item) => {
      if (item.node.kind !== 'folder') return false
      return bucketByRootId.get(item.node.id) === tab
    })
  }, [fullTree, tab, bucketByRootId])

  const flat = useMemo(() => flatten(tree, expanded), [tree, expanded])

  // Bucket counts for the tab pills — derived from ALL nodes so even when
  // we're viewing Active, the user sees how many are in Archived.
  const counts = useMemo(() => {
    let active = 0
    let closed = 0
    let archivedCount = 0
    for (const n of nodes) {
      if (n.kind !== 'folder' || n.parentId !== null) continue
      const b = bucketFor(n.id, nodes)
      if (b === 'active') active++
      else if (b === 'closed') closed++
      else archivedCount++
    }
    return { active, closed, archived: archivedCount }
  }, [nodes])

  // ── Drag-and-drop reorder ───────────────────────────────────────────────
  // Same before/inside/after semantics as the sidebar. before/after change
  // sibling order under the SAME parent; inside reparents into the target
  // folder. Cycle guard prevents dropping a folder into its own subtree.
  const draggingIdRef = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    id: string
    position: 'before' | 'inside' | 'after'
  } | null>(null)
  // Track focus for keyboard nav (Up/Down/Right/Left/Enter/Esc) like the
  // sidebar. Even though the dashboard already supports Tab to walk items,
  // arrow navigation matches sidebar behavior so muscle memory transfers.
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null)

  function handleRowDragStart(e: React.DragEvent, node: FbNode): void {
    draggingIdRef.current = node.id
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/fb-node-move', node.id)
  }
  function handleRowDragOver(e: React.DragEvent, node: FbNode): void {
    const draggingId = draggingIdRef.current
    if (!draggingId || draggingId === node.id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // Three-zone hit-test: top 30% = before, bottom 30% = after, middle
    // 40% = inside (only valid for folders). Same proportions as sidebar
    // so behaviour is consistent.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const ratio = (e.clientY - rect.top) / rect.height
    let position: 'before' | 'inside' | 'after'
    if (node.kind === 'folder' && ratio > 0.3 && ratio < 0.7) {
      position = 'inside'
    } else if (ratio < 0.5) {
      position = 'before'
    } else {
      position = 'after'
    }
    setDropTarget({ id: node.id, position })
  }
  function handleRowDragLeave(e: React.DragEvent, node: FbNode): void {
    if (dropTarget?.id !== node.id) return
    // Only clear when leaving for an element outside the row.
    const related = e.relatedTarget as HTMLElement | null
    if (related && (e.currentTarget as HTMLElement).contains(related)) return
    setDropTarget(null)
  }
  async function handleRowDrop(e: React.DragEvent, node: FbNode): Promise<void> {
    e.preventDefault()
    const draggingId = draggingIdRef.current
    setDropTarget(null)
    draggingIdRef.current = null
    if (!draggingId || draggingId === node.id) return
    // Cycle guard: can't drop a folder into its own descendant.
    if (isDescendantOrSelf(node.id, draggingId, nodes)) return
    const position =
      node.kind === 'folder' &&
      dropTarget?.id === node.id &&
      dropTarget.position === 'inside'
        ? 'inside'
        : dropTarget?.position ?? 'after'
    if (position === 'inside') {
      await moveNode(draggingId, node.id, null)
    } else {
      // Insert before/after the target under its current parent.
      const newParent = node.parentId
      const beforeId = position === 'before' ? node.id : null
      // If position === 'after', we need the NEXT sibling under newParent
      // to use as beforeId — passing null appends. moveNode signature is
      // (id, newParentId, beforeId).
      if (position === 'after') {
        const siblings = nodes.filter(
          (n) => n.parentId === newParent && !n.archived
        )
        siblings.sort(
          (a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt
        )
        const idx = siblings.findIndex((s) => s.id === node.id)
        const after = siblings[idx + 1]
        await moveNode(draggingId, newParent, after ? after.id : null)
      } else {
        await moveNode(draggingId, newParent, beforeId)
      }
    }
  }
  function handleRowDragEnd(): void {
    draggingIdRef.current = null
    setDropTarget(null)
  }

  // Keyboard handler — same WAI-ARIA tree semantics as the sidebar.
  function handleKeyDown(
    e: React.KeyboardEvent<HTMLDivElement>,
    item: TreeItem
  ): void {
    const node = item.node
    const isFolder = node.kind === 'folder'
    const hasChildren = item.children.length > 0
    const isExpanded = !!expanded[node.id]
    const idx = flat.findIndex((i) => i.node.id === node.id)
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (flat[idx + 1]) setFocusedNodeId(flat[idx + 1].node.id)
        break
      case 'ArrowUp':
        e.preventDefault()
        if (flat[idx - 1]) setFocusedNodeId(flat[idx - 1].node.id)
        break
      case 'ArrowRight':
        e.preventDefault()
        if (isFolder && hasChildren) {
          if (!isExpanded) toggleExpand(node.id)
          else setFocusedNodeId(flat[idx + 1]?.node.id ?? node.id)
        }
        break
      case 'ArrowLeft':
        e.preventDefault()
        if (isFolder && isExpanded) toggleExpand(node.id)
        else if (node.parentId) setFocusedNodeId(node.parentId)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (isFolder) {
          if (hasChildren) toggleExpand(node.id)
          setActive(node.id)
          // A room shows its desks (see goRoom in stores/view.ts), not a canvas.
          goRoom(node.id)
        } else {
          setActive(node.id)
          goTask(node.id)
        }
        break
      case 'Escape':
        e.preventDefault()
        setFocusedNodeId(null)
        ;(e.currentTarget as HTMLElement).blur()
        break
    }
  }

  function openNode(node: FbNode): void {
    if (node.kind === 'folder') {
      setActive(node.id)
      goRoom(node.id)
    } else {
      setActive(node.id)
      goTask(node.id)
    }
  }

  function archive(id: string): void {
    void update(id, { archived: true })
  }
  function restore(id: string): void {
    void update(id, { archived: false })
  }

  const TABS: Array<{ value: Tab; label: string; icon: string; count: number }> = [
    { value: 'active', label: 'Active', icon: 'folder_open', count: counts.active },
    { value: 'closed', label: 'Closed', icon: 'folder', count: counts.closed },
    { value: 'archived', label: 'Archived', icon: 'inventory_2', count: counts.archived }
  ]

  return (
    <div className="flex flex-col h-full">
      {/* Header row — tabs + a "New Room" button */}
      <div className="flex items-center justify-between gap-2 mb-2 border-b border-[var(--edge-soft)]">
        <div role="tablist" aria-label="Room buckets" className="flex gap-0.5">
          {TABS.map((t) => {
            const active = tab === t.value
            return (
              <button
                key={t.value}
                role="tab"
                aria-selected={active}
                aria-controls={`folder-panel-${t.value}`}
                onClick={() => setTab(t.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight') {
                    e.preventDefault()
                    const idx = TABS.findIndex((x) => x.value === tab)
                    setTab(TABS[(idx + 1) % TABS.length].value)
                  } else if (e.key === 'ArrowLeft') {
                    e.preventDefault()
                    const idx = TABS.findIndex((x) => x.value === tab)
                    setTab(TABS[(idx - 1 + TABS.length) % TABS.length].value)
                  }
                }}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium border-b-2 transition-colors -mb-px ${
                  active
                    ? 'text-accent border-accent'
                    : 'text-[var(--ink-50)] border-transparent hover:text-[var(--ink-90)]'
                }`}
              >
                <Icon name={t.icon} size={13} />
                <span>{t.label}</span>
                {t.count > 0 && (
                  <span
                    className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded-full ${
                      active
                        ? 'bg-accent/15 text-accent'
                        : 'bg-[var(--surface-sunken)] text-[var(--ink-50)]'
                    }`}
                  >
                    {t.count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        {tab !== 'archived' && (
          <button
            onClick={() =>
              setDialog({ mode: 'create', parentId: null, kind: 'folder' })
            }
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded text-accent hover:bg-accent/10"
            title="New top-level Room"
          >
            <Icon name="create_new_folder" size={13} />
            <span>New Room</span>
          </button>
        )}
      </div>
      <div
        id={`folder-panel-${tab}`}
        role="tabpanel"
        className="flex-1 min-h-0 overflow-y-auto"
      >
        {flat.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-[var(--ink-40)]">
            <Icon
              name={
                tab === 'archived'
                  ? 'inventory_2'
                  : tab === 'closed'
                    ? 'folder'
                    : 'folder_open'
              }
              size={28}
              className="text-[var(--ink-30)]"
            />
            <span className="text-[12px]">
              {tab === 'active'
                ? 'No Rooms with active Desks.'
                : tab === 'closed'
                  ? 'No closed Rooms yet.'
                  : 'No archived Rooms.'}
            </span>
            {tab === 'active' && (
              <button
                onClick={() =>
                  setDialog({ mode: 'create', parentId: null, kind: 'folder' })
                }
                className="text-[11px] text-accent hover:underline"
              >
                Create your first Room
              </button>
            )}
          </div>
        ) : (
          <div role="tree" aria-label={`${tab} Rooms`}>
            {flat.map((item) => {
              const { node, depth } = item
              const hasChildren = item.children.length > 0
              const isOpen = !!expanded[node.id]
              const isFolder = node.kind === 'folder'
              const isFocused = focusedNodeId === node.id
              const isDragging = draggingIdRef.current === node.id
              const isDropTargetRow = dropTarget?.id === node.id
              const dropPos = isDropTargetRow ? dropTarget.position : null
              return (
                <div
                  key={node.id}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={isFolder ? isOpen : undefined}
                  tabIndex={
                    isFocused ||
                    (focusedNodeId === null && flat[0]?.node.id === node.id)
                      ? 0
                      : -1
                  }
                  onFocus={() => setFocusedNodeId(node.id)}
                  onKeyDown={(e) => handleKeyDown(e, item)}
                  style={{
                    paddingLeft: `${depth * 14 + 2}px`,
                    borderTop:
                      dropPos === 'before'
                        ? '2px solid rgb(var(--accent))'
                        : '2px solid transparent',
                    borderBottom:
                      dropPos === 'after'
                        ? '2px solid rgb(var(--accent))'
                        : '2px solid transparent',
                    backgroundColor:
                      dropPos === 'inside'
                        ? 'rgb(var(--accent) / 0.12)'
                        : undefined,
                    boxShadow:
                      dropPos === 'inside'
                        ? 'inset 0 0 0 2px rgb(var(--accent) / 0.45)'
                        : undefined,
                    opacity: isDragging ? 0.4 : 1,
                    transition: 'border-color 80ms, background-color 80ms'
                  }}
                  className="relative group flex items-center pr-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset focus-visible:bg-accent/[0.06] rounded"
                  onDragOver={(e) => handleRowDragOver(e, node)}
                  onDragLeave={(e) => handleRowDragLeave(e, node)}
                  onDrop={(e) => void handleRowDrop(e, node)}
                >
                  <button
                    onClick={() => hasChildren && toggleExpand(node.id)}
                    className={`w-5 h-5 flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)] transition-colors ${
                      hasChildren ? '' : 'invisible'
                    }`}
                    aria-label={isOpen ? 'Collapse' : 'Expand'}
                    tabIndex={-1}
                  >
                    <Icon name={isOpen ? 'expand_more' : 'chevron_right'} size={14} />
                  </button>
                  <div
                    draggable
                    onDragStart={(e) => handleRowDragStart(e, node)}
                    onDragEnd={handleRowDragEnd}
                    onClick={() => {
                      // Single click toggles AND navigates — same fluid
                      // behaviour as the sidebar.
                      if (isFolder && hasChildren) toggleExpand(node.id)
                      openNode(node)
                    }}
                    className="flex-1 flex items-center gap-1.5 px-1.5 py-1 rounded min-w-0 cursor-grab active:cursor-grabbing hover:bg-[var(--surface-sunken)]"
                  >
                    <Icon
                      name={isFolder ? 'folder' : 'task_alt'}
                      size={14}
                      filled
                      className={
                        tab === 'archived'
                          ? 'text-[var(--ink-40)]'
                          : isFolder
                            ? 'text-amber-700'
                            : node.status === 'done'
                              ? 'text-emerald-700'
                              : node.status === 'in_progress'
                                ? 'text-blue-700'
                                : 'text-[var(--ink-50)]'
                      }
                    />
                    <span
                      className={`text-[13px] truncate ${
                        tab === 'archived'
                          ? 'text-[var(--ink-50)]'
                          : 'text-[var(--ink-90)]'
                      } ${
                        node.status === 'done'
                          ? 'line-through text-[var(--ink-40)]'
                          : ''
                      }`}
                    >
                      {node.title || '(untitled)'}
                    </span>
                  </div>
                  <div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-focus-within:opacity-100 flex items-center transition-opacity">
                    {tab === 'archived' ? (
                      <button
                        onClick={() => restore(node.id)}
                        title="Restore"
                        className="icon-btn"
                      >
                        <Icon name="unarchive" size={14} />
                      </button>
                    ) : (
                      <>
                        {isFolder && (
                          <>
                            <button
                              onClick={() =>
                                setDialog({
                                  mode: 'create',
                                  parentId: node.id,
                                  kind: 'folder'
                                })
                              }
                              title="Add sub-Room"
                              className="icon-btn"
                            >
                              <Icon name="create_new_folder" size={14} />
                            </button>
                            <button
                              onClick={() =>
                                setDialog({
                                  mode: 'create',
                                  parentId: node.id,
                                  kind: 'task'
                                })
                              }
                              title="Add Desk to this Room"
                              className="icon-btn"
                            >
                              <Icon name="add_task" size={14} />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => archive(node.id)}
                          title="Archive"
                          className="icon-btn"
                        >
                          <Icon name="inventory_2" size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {dialog && (
        <NewNodeDialog
          parentId={dialog.parentId}
          kind={dialog.kind}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  )
}
