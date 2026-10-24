import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Icon from '../Icon'
import { DashboardHeader, PLEXI_CARD } from '../plexi'
import CanvasContextMenu, { type CtxMenuItem } from '../CanvasContextMenu'
import { focusInvoker } from '../../lib/objectMenu'

// The shared engine behind the All Rooms and All Desks index pages. One item
// type (a Room or a Desk) rendered five ways — gallery, list, kanban, table and
// timeline — with search, a filter, a group-by, and manual drag-to-reorder. The
// two index pages configure this with their own columns, groups and renderers so
// the interaction model stays identical across both.

export type IndexMode = 'gallery' | 'list' | 'kanban' | 'table' | 'timeline'

export interface IndexColumn<T> {
  key: string
  label: string
  render: (item: T) => ReactNode
  align?: 'left' | 'right'
}

export interface GroupOption<T> {
  key: string
  label: string
  // Which bucket an item belongs to, plus the bucket's display order. Buckets are
  // shown in ascending `order`; ties break alphabetically by label.
  groupOf: (item: T) => { id: string; label: string; order: number }
}

export interface FilterOption<T> {
  key: string
  label: string
  predicate: (item: T) => boolean
}

// One hover-strip action: an icon button (tooltip = title ?? label). The
// right-click menu is NOT built from these any more: it is the shared desk/room
// menu (lib/deskLifecycleMenu, via `itemMenu`), drawn by the context-menu kit,
// so a desk reads the same here as in the gallery. The strip's buttons call the
// same functions that menu does.
export interface IndexAction {
  key: string
  icon: string
  label: string
  // Longer tooltip for the hover strip.
  title?: string
  onClick: () => void
}

export interface IndexConfig<T> {
  storageKey: string
  title: string
  subtitle: string
  items: T[]
  idOf: (item: T) => string
  titleOf: (item: T) => string
  searchText: (item: T) => string
  thumb: (item: T) => ReactNode
  smallIcon: (item: T) => ReactNode
  metaLine: (item: T) => ReactNode
  columns: IndexColumn<T>[]
  groups: GroupOption<T>[]
  filters: FilterOption<T>[]
  timelineDate: (item: T) => number | null
  onOpen: (item: T) => void
  onNew?: () => void
  newLabel?: string
  // The hover strip.
  itemActions?: (item: T) => IndexAction[]
  // The right-click menu (SPEC §9.3), drawn by the context-menu kit.
  itemMenu?: (item: T) => CtxMenuItem[]
  // Persist a manual order. Given the ids in their new order; the page writes it
  // through to the node sortOrder. Absent = reorder disabled.
  onReorder?: (orderedIds: string[]) => void
  headerActions?: ReactNode
  // Small marker rendered next to the title (gallery + list), e.g. a "Shared by X"
  // badge on a room/desk shared with you. Absent = no badge.
  badge?: (item: T) => ReactNode
  // DEC-022 selection mode: when present, a "Select" toggle joins the toolbar
  // (gallery/list/table). The page defines the bulk actions; each receives the
  // selected ids and a `done` callback that clears the selection after acting.
  bulkActions?: (
    selectedIds: string[],
    done: () => void
  ) => Array<{ key: string; icon: string; label: string; onClick: () => void }>
}

const MODES: Array<{ key: IndexMode; icon: string; label: string }> = [
  { key: 'gallery', icon: 'grid_view', label: 'Gallery' },
  { key: 'list', icon: 'view_list', label: 'List' },
  { key: 'kanban', icon: 'view_kanban', label: 'Board' },
  { key: 'table', icon: 'table_rows', label: 'Table' },
  { key: 'timeline', icon: 'timeline', label: 'Timeline' }
]

function usePersistedString(key: string, initial: string): [string, (v: string) => void] {
  const [v, setV] = useState<string>(() => {
    try {
      return localStorage.getItem(key) ?? initial
    } catch {
      return initial
    }
  })
  const set = (next: string): void => {
    setV(next)
    try {
      localStorage.setItem(key, next)
    } catch {
      /* ignore quota */
    }
  }
  return [v, set]
}

export default function RoomsDesksIndex<T>({ config }: { config: IndexConfig<T> }): JSX.Element {
  const {
    storageKey,
    title,
    subtitle,
    items,
    idOf,
    titleOf,
    searchText,
    thumb,
    smallIcon,
    metaLine,
    columns,
    groups,
    filters,
    timelineDate,
    onOpen,
    onNew,
    newLabel,
    itemActions,
    itemMenu,
    onReorder,
    headerActions,
    badge,
    bulkActions
  } = config

  const [mode, setMode] = usePersistedString(`${storageKey}.mode`, 'gallery') as [
    IndexMode,
    (m: IndexMode) => void
  ]
  const [groupKey, setGroupKey] = usePersistedString(
    `${storageKey}.group`,
    groups[0]?.key ?? 'none'
  )
  const [filterKey, setFilterKey] = usePersistedString(`${storageKey}.filter`, 'all')
  const [search, setSearch] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  // Right-click context menu (every view mode): the shared desk/room menu.
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: CtxMenuItem[] } | null>(null)

  // DEC-022 selection mode: clicking toggles membership instead of opening;
  // the bar under the toolbar carries the bulk actions the page defined.
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const selectable =
    Boolean(bulkActions) && (mode === 'gallery' || mode === 'list' || mode === 'table')
  const exitSelect = (): void => {
    setSelecting(false)
    setSelected(new Set())
  }
  const toggleSelected = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const handleOpen = (it: T): void => {
    if (selecting) toggleSelected(idOf(it))
    else onOpen(it)
  }
  // Leaving the selectable modes (kanban/timeline) ends selection cleanly.
  useEffect(() => {
    if (selecting && !selectable) exitSelect()
  }, [selecting, selectable])

  function openCtxMenu(e: React.MouseEvent, it: T): void {
    if (!itemMenu) return
    const items = itemMenu(it)
    if (items.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    // The kit returns focus to whatever had it when the menu opened, so give it
    // to the card or row first: Escape then lands back on what was clicked.
    focusInvoker(e)
    setCtxMenu({ x: e.clientX, y: e.clientY, items })
  }

  const stripOf = (it: T): ReactNode =>
    itemActions ? <ActionStrip actions={itemActions(it)} /> : null

  const activeFilter = filters.find((f) => f.key === filterKey) ?? null
  const activeGroup = groups.find((g) => g.key === groupKey) ?? null

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((it) => {
      if (activeFilter && !activeFilter.predicate(it)) return false
      if (q && !searchText(it).toLowerCase().includes(q)) return false
      return true
    })
  }, [items, search, activeFilter, searchText])

  // Manual reorder is only meaningful when nothing else is imposing an order, so
  // it applies in gallery and list, ungrouped, unsearched, unfiltered.
  const canReorder = Boolean(onReorder) && !activeGroup && !search.trim() && filterKey === 'all'

  function handleDrop(targetId: string): void {
    if (!dragId || dragId === targetId || !onReorder) return
    const ids = visible.map(idOf)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ids.splice(from, 1)[0])
    onReorder(ids)
    setDragId(null)
  }

  const grouped = useMemo(() => {
    if (!activeGroup) return [{ id: 'all', label: '', order: 0, items: visible }]
    const buckets = new Map<string, { id: string; label: string; order: number; items: T[] }>()
    for (const it of visible) {
      const g = activeGroup.groupOf(it)
      const b = buckets.get(g.id) ?? { id: g.id, label: g.label, order: g.order, items: [] }
      b.items.push(it)
      buckets.set(g.id, b)
    }
    return [...buckets.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  }, [visible, activeGroup])

  const controlCls =
    'fb-field h-8 !py-0 fb-t-label px-2'

  return (
    <div
      className="h-full w-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]"
      data-testid={`${storageKey}-view`}
    >
      <div className="max-w-[1180px] mx-auto px-6 py-6">
        <DashboardHeader
          title={title}
          subtitle={subtitle}
          actions={
            <div className="flex items-center gap-2">
              {headerActions}
              {onNew && (
                <button
                  onClick={onNew}
                  data-testid={`${storageKey}-new`}
                  className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-[var(--radius-field)] bg-[rgb(var(--accent))] text-white fb-t-label fb-press hover:bg-[rgb(var(--accent-hover))]"
                >
                  <Icon name="add" size={16} /> {newLabel ?? 'New'}
                </button>
              )}
            </div>
          }
        />

        {/* Toolbar: mode switch on the left, then search / group / filter. */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <div className="inline-flex rounded-[var(--radius-field)] overflow-hidden bg-[var(--surface-raised)] shadow-[0_0_0_1px_var(--edge-hairline)]">
            {MODES.map((m) => (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                title={m.label}
                data-testid={`${storageKey}-mode-${m.key}`}
                className={`h-8 w-9 inline-flex items-center justify-center fb-press ${
                  mode === m.key
                    ? 'bg-[rgb(var(--accent))] text-white'
                    : 'bg-[var(--surface-raised)] text-[var(--ink-60)] hover:text-[var(--ink-100)]'
                }`}
              >
                <Icon name={m.icon} size={16} />
              </button>
            ))}
          </div>

          <div className="relative">
            <Icon
              name="search"
              size={14}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-40)]"
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search"
              data-testid={`${storageKey}-search`}
              className={`${controlCls} pl-7 w-44`}
            />
          </div>

          {groups.length > 0 && (
            <label className="inline-flex items-center gap-1 fb-t-caption">
              Group
              <select
                value={groupKey}
                onChange={(e) => setGroupKey(e.target.value)}
                data-testid={`${storageKey}-group`}
                className={controlCls}
              >
                <option value="none">None</option>
                {groups.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {filters.length > 0 && (
            <label className="inline-flex items-center gap-1 fb-t-caption">
              Filter
              <select
                value={filterKey}
                onChange={(e) => setFilterKey(e.target.value)}
                data-testid={`${storageKey}-filter`}
                className={controlCls}
              >
                <option value="all">All</option>
                {filters.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {selectable && !selecting && (
            <button
              onClick={() => setSelecting(true)}
              data-testid={`${storageKey}-select`}
              className="inline-flex items-center gap-1.5 h-8 px-3 fb-btn-surface fb-press fb-t-label text-[var(--ink-70)] hover:text-[var(--ink-100)]"
            >
              <Icon name="check_circle" size={15} /> Select
            </button>
          )}

          <span className="ml-auto fb-t-caption fb-tabular">
            {visible.length} {visible.length === 1 ? 'item' : 'items'}
          </span>
        </div>

        {/* DEC-022: the selection bar — count, select-all, the page's bulk
            actions, and Done. Lives under the toolbar while selecting. */}
        {selecting && bulkActions && (
          <div
            data-testid={`${storageKey}-selection-bar`}
            className="flex flex-wrap items-center gap-2 mb-4 px-3 py-2 rounded-[var(--radius-field)] bg-[var(--surface-raised)] shadow-[0_0_0_1px_var(--edge-hairline)]"
          >
            <span className="fb-t-label text-[var(--ink-90)] fb-tabular">
              {selected.size} selected
            </span>
            <button
              onClick={() => {
                const all = visible.map(idOf)
                setSelected((prev) => (prev.size === all.length ? new Set() : new Set(all)))
              }}
              className="inline-flex items-center gap-1 h-7 px-2.5 fb-btn-surface fb-press fb-t-label text-[var(--ink-70)] hover:text-[var(--ink-100)]"
            >
              <Icon name="select_all" size={14} />
              {selected.size === visible.length && visible.length > 0 ? 'Select none' : 'Select all'}
            </button>
            <div className="w-px h-5 bg-[var(--edge-soft)]" />
            {bulkActions([...selected], exitSelect).map((a) => (
              <button
                key={a.key}
                onClick={a.onClick}
                disabled={selected.size === 0}
                data-testid={`${storageKey}-bulk-${a.key}`}
                className="inline-flex items-center gap-1.5 h-7 px-2.5 fb-btn-surface fb-press fb-t-label text-[var(--ink-70)] hover:text-[var(--ink-100)] disabled:opacity-40 disabled:pointer-events-none"
              >
                <Icon name={a.icon} size={14} /> {a.label}
              </button>
            ))}
            <button
              onClick={exitSelect}
              className="ml-auto inline-flex items-center gap-1 h-7 px-2.5 fb-t-label text-[var(--ink-60)] hover:text-[var(--ink-100)] fb-press"
            >
              Done
            </button>
          </div>
        )}

        {visible.length === 0 ? (
          // Two honest empty states: a search that matched nothing offers a way
          // back; a genuinely empty index offers the first creation.
          <div className="py-16 text-center" data-testid={`${storageKey}-empty`}>
            <Icon
              name={search.trim() ? 'search_off' : 'grid_view'}
              size={28}
              className="text-[var(--ink-30)] mx-auto"
            />
            <p className="fb-t-title text-[var(--ink-90)] mt-3">
              {search.trim() ? 'Nothing matches' : 'Nothing here yet'}
            </p>
            <p className="fb-t-body text-[var(--ink-50)] mt-1">
              {search.trim()
                ? `No results for “${search.trim()}”.`
                : 'Create the first one and it will live here.'}
            </p>
            {search.trim() ? (
              <button
                onClick={() => setSearch('')}
                className="mt-4 inline-flex items-center gap-1.5 h-8 px-3 fb-btn-surface fb-press fb-t-label text-[var(--ink-90)]"
              >
                Clear search
              </button>
            ) : (
              onNew && (
                <button
                  onClick={onNew}
                  className="mt-4 inline-flex items-center gap-1.5 h-9 px-3.5 rounded-[var(--radius-field)] bg-[rgb(var(--accent))] text-white fb-t-label fb-press hover:bg-[rgb(var(--accent-hover))]"
                >
                  <Icon name="add" size={16} /> {newLabel ?? 'New'}
                </button>
              )
            )}
          </div>
        ) : mode === 'kanban' ? (
          <KanbanBoard
            groups={activeGroup ? grouped : bucketByFirstGroup(visible, groups[0], activeGroup)}
            fallbackGroup={groups[0]}
            visible={visible}
            activeGroup={activeGroup}
            idOf={idOf}
            titleOf={titleOf}
            thumb={thumb}
            metaLine={metaLine}
            onOpen={onOpen}
            onItemContextMenu={openCtxMenu}
          />
        ) : mode === 'table' ? (
          <TableView
            grouped={grouped}
            columns={columns}
            idOf={idOf}
            titleOf={titleOf}
            smallIcon={smallIcon}
            onOpen={handleOpen}
            onItemContextMenu={openCtxMenu}
            storageKey={storageKey}
            selecting={selecting}
            selectedIds={selected}
          />
        ) : mode === 'timeline' ? (
          <TimelineView
            visible={visible}
            idOf={idOf}
            titleOf={titleOf}
            smallIcon={smallIcon}
            metaLine={metaLine}
            timelineDate={timelineDate}
            onOpen={onOpen}
            onItemContextMenu={openCtxMenu}
          />
        ) : (
          // gallery + list both group and both support reorder
          <div className="space-y-6">
            {grouped.map((bucket) => (
              <div key={bucket.id}>
                {activeGroup && (
                  <div className="flex items-center gap-2 mb-2">
                    <span className="fb-t-caption uppercase tracking-[0.1em] font-semibold">
                      {bucket.label || 'Ungrouped'}
                    </span>
                    <span className="fb-t-caption text-[var(--ink-40)] fb-tabular">
                      {bucket.items.length}
                    </span>
                    <div className="flex-1 h-px bg-[var(--edge-soft)]" />
                  </div>
                )}
                {mode === 'gallery' ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {bucket.items.map((it, i) => (
                      <GalleryCard
                        key={idOf(it)}
                        id={idOf(it)}
                        enterDelay={Math.min(i * 35, 350)}
                        title={titleOf(it)}
                        badge={badge?.(it)}
                        thumb={thumb(it)}
                        meta={metaLine(it)}
                        actions={stripOf(it)}
                        onOpen={() => handleOpen(it)}
                        onContextMenu={(e) => openCtxMenu(e, it)}
                        canReorder={canReorder && !selecting}
                        onDragStart={() => setDragId(idOf(it))}
                        onDrop={() => handleDrop(idOf(it))}
                        dragging={dragId === idOf(it)}
                        selecting={selecting}
                        selected={selected.has(idOf(it))}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="fb-card overflow-hidden divide-y divide-[var(--edge-soft)]">
                    {bucket.items.map((it, i) => (
                      <ListRow
                        key={idOf(it)}
                        id={idOf(it)}
                        enterDelay={Math.min(i * 35, 350)}
                        title={titleOf(it)}
                        badge={badge?.(it)}
                        icon={smallIcon(it)}
                        meta={metaLine(it)}
                        actions={stripOf(it)}
                        onOpen={() => handleOpen(it)}
                        onContextMenu={(e) => openCtxMenu(e, it)}
                        canReorder={canReorder && !selecting}
                        onDragStart={() => setDragId(idOf(it))}
                        onDrop={() => handleDrop(idOf(it))}
                        dragging={dragId === idOf(it)}
                        selecting={selecting}
                        selected={selected.has(idOf(it))}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {ctxMenu && (
        <CanvasContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />
      )}
    </div>
  )
}

// The hover icon strip, rendered from the same IndexAction list as the context
// menu. Visuals match the previous hand-rolled buttons exactly.
function ActionStrip({ actions }: { actions: IndexAction[] }): JSX.Element | null {
  const strip = actions
  if (strip.length === 0) return null
  return (
    <div className="flex items-center gap-1">
      {strip.map((a) => (
        <button
          key={a.key}
          onClick={(e) => {
            e.stopPropagation()
            a.onClick()
          }}
          title={a.title ?? a.label}
          className="inline-flex items-center justify-center h-6 w-6 rounded-[var(--radius-chip)] bg-[color-mix(in_oklab,var(--surface-raised)_95%,transparent)] shadow-[0_0_0_1px_var(--edge-hairline),var(--shadow-soft)] text-[var(--ink-60)] hover:text-[var(--ink-100)] fb-press"
        >
          <Icon name={a.icon} size={14} />
        </button>
      ))}
    </div>
  )
}

// Kanban always needs a grouping; if the user picked "None", fall back to the
// first defined group so the board still has columns.
function bucketByFirstGroup<T>(
  visible: T[],
  first: GroupOption<T> | undefined,
  active: GroupOption<T> | null
): Array<{ id: string; label: string; order: number; items: T[] }> {
  if (active || !first) return [{ id: 'all', label: 'All', order: 0, items: visible }]
  const buckets = new Map<string, { id: string; label: string; order: number; items: T[] }>()
  for (const it of visible) {
    const g = first.groupOf(it)
    const b = buckets.get(g.id) ?? { id: g.id, label: g.label, order: g.order, items: [] }
    b.items.push(it)
    buckets.set(g.id, b)
  }
  return [...buckets.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
}

function GalleryCard(props: {
  id: string
  enterDelay: number
  title: string
  badge?: ReactNode
  thumb: ReactNode
  meta: ReactNode
  actions?: ReactNode
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
  canReorder: boolean
  onDragStart: () => void
  onDrop: () => void
  dragging: boolean
  selecting?: boolean
  selected?: boolean
}): JSX.Element {
  return (
    <div
      draggable={props.canReorder}
      onDragStart={props.onDragStart}
      onDragOver={(e) => props.canReorder && e.preventDefault()}
      onDrop={props.onDrop}
      onContextMenu={props.onContextMenu}
      style={{ animationDelay: `${props.enterDelay}ms` }}
      className={`group relative ${PLEXI_CARD} overflow-hidden fb-lift fb-press fb-fade-in-up ${
        props.dragging ? 'opacity-40' : ''
      } ${props.selected ? 'ring-2 ring-[rgb(var(--accent))]' : ''}`}
      data-testid={`index-card-${props.id}`}
    >
      <button onClick={props.onOpen} className="block w-full text-left">
        <div className="h-36 flex items-center justify-center overflow-hidden bg-[var(--surface-sunken)]">
          {props.thumb}
        </div>
        <div className="px-3 py-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate fb-t-body font-medium text-[var(--ink-100)]">{props.title}</span>
            {props.badge}
          </div>
          <div className="fb-t-caption mt-0.5 truncate">{props.meta}</div>
        </div>
      </button>
      {props.selecting && (
        <span
          data-testid={`index-card-check-${props.id}`}
          className={`absolute top-1.5 left-1.5 inline-flex items-center justify-center h-6 w-6 rounded-full shadow-[0_0_0_1px_var(--edge-hairline)] ${
            props.selected
              ? 'bg-[rgb(var(--accent))] text-white'
              : 'bg-[color-mix(in_oklab,var(--surface-raised)_95%,transparent)] text-[var(--ink-40)]'
          }`}
        >
          <Icon name={props.selected ? 'check' : 'radio_button_unchecked'} size={15} />
        </span>
      )}
      {props.actions && !props.selecting && (
        <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {props.actions}
        </div>
      )}
    </div>
  )
}

function ListRow(props: {
  id: string
  enterDelay: number
  title: string
  badge?: ReactNode
  icon: ReactNode
  meta: ReactNode
  actions?: ReactNode
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
  canReorder: boolean
  onDragStart: () => void
  onDrop: () => void
  dragging: boolean
  selecting?: boolean
  selected?: boolean
}): JSX.Element {
  return (
    <div
      draggable={props.canReorder}
      onDragStart={props.onDragStart}
      onDragOver={(e) => props.canReorder && e.preventDefault()}
      onDrop={props.onDrop}
      onContextMenu={props.onContextMenu}
      style={{ animationDelay: `${props.enterDelay}ms` }}
      className={`group flex items-center gap-3 px-3 h-12 fb-press fb-fade-in-up ${
        props.dragging ? 'opacity-40' : ''
      } ${
        props.selected
          ? 'bg-accent/[0.08] hover:bg-accent/[0.12]'
          : 'bg-[var(--surface-raised)] hover:bg-[var(--surface-hover)]'
      }`}
      data-testid={`index-row-${props.id}`}
    >
      {props.selecting && (
        <Icon
          name={props.selected ? 'check_circle' : 'radio_button_unchecked'}
          size={17}
          className={`shrink-0 ${props.selected ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-30)]'}`}
        />
      )}
      {props.canReorder && !props.selecting && (
        <Icon name="drag_indicator" size={15} className="text-[var(--ink-30)] cursor-grab shrink-0" />
      )}
      <div className="w-8 h-8 rounded-[var(--radius-chip)] overflow-hidden bg-[var(--surface-sunken)] flex items-center justify-center shrink-0">
        {props.icon}
      </div>
      <button onClick={props.onOpen} className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="truncate fb-t-body text-[var(--ink-100)]">{props.title}</span>
          {props.badge}
        </div>
        <div className="truncate fb-t-caption">{props.meta}</div>
      </button>
      {props.actions && (
        <div className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          {props.actions}
        </div>
      )}
    </div>
  )
}

function KanbanBoard<T>(props: {
  groups: Array<{ id: string; label: string; order: number; items: T[] }>
  fallbackGroup: GroupOption<T> | undefined
  visible: T[]
  activeGroup: GroupOption<T> | null
  idOf: (t: T) => string
  titleOf: (t: T) => string
  thumb: (t: T) => ReactNode
  metaLine: (t: T) => ReactNode
  onOpen: (t: T) => void
  onItemContextMenu: (e: React.MouseEvent, t: T) => void
}): JSX.Element {
  return (
    <div className="flex gap-3 overflow-x-auto pb-3">
      {props.groups.map((col) => (
        <div key={col.id} className="w-64 shrink-0">
          <div className="flex items-center gap-2 mb-2 px-1">
            <span className="fb-t-label font-semibold text-[var(--ink-90)]">
              {col.label || 'Ungrouped'}
            </span>
            <span className="fb-t-caption text-[var(--ink-40)] fb-tabular">{col.items.length}</span>
          </div>
          <div className="space-y-2 rounded-[var(--radius-card)] bg-[var(--surface-sunken)] p-2 min-h-[80px]">
            {col.items.map((it, i) => (
              <button
                key={props.idOf(it)}
                onClick={() => props.onOpen(it)}
                onContextMenu={(e) => props.onItemContextMenu(e, it)}
                data-testid={`kanban-card-${props.idOf(it)}`}
                style={{ animationDelay: `${Math.min(i * 35, 350)}ms` }}
                className={`block w-full text-left ${PLEXI_CARD} overflow-hidden fb-lift fb-press fb-fade-in-up`}
              >
                <div className="h-24 overflow-hidden bg-[var(--surface-base)] flex items-center justify-center">
                  {props.thumb(it)}
                </div>
                <div className="px-2.5 py-1.5">
                  <div className="truncate fb-t-label text-[var(--ink-100)]">
                    {props.titleOf(it)}
                  </div>
                  <div className="truncate fb-t-caption">
                    {props.metaLine(it)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function TableView<T>(props: {
  grouped: Array<{ id: string; label: string; order: number; items: T[] }>
  columns: IndexColumn<T>[]
  idOf: (t: T) => string
  titleOf: (t: T) => string
  smallIcon: (t: T) => ReactNode
  onOpen: (t: T) => void
  onItemContextMenu: (e: React.MouseEvent, t: T) => void
  storageKey: string
  selecting?: boolean
  selectedIds?: ReadonlySet<string>
}): JSX.Element {
  return (
    <div className="overflow-x-auto fb-card">
      <table className="w-full fb-t-body" data-testid={`${props.storageKey}-table`}>
        <thead>
          <tr className="bg-[var(--surface-sunken)] fb-t-caption uppercase tracking-[0.06em]">
            <th className="text-left font-semibold px-3 py-2">Name</th>
            {props.columns.map((c) => (
              <th
                key={c.key}
                className={`font-semibold px-3 py-2 ${c.align === 'right' ? 'text-right' : 'text-left'}`}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--edge-soft)]">
          {props.grouped.map((bucket) => (
            <TableGroup key={bucket.id} bucket={bucket} {...props} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TableGroup<T>(props: {
  bucket: { id: string; label: string; items: T[] }
  columns: IndexColumn<T>[]
  idOf: (t: T) => string
  titleOf: (t: T) => string
  smallIcon: (t: T) => ReactNode
  onOpen: (t: T) => void
  onItemContextMenu: (e: React.MouseEvent, t: T) => void
  selecting?: boolean
  selectedIds?: ReadonlySet<string>
}): JSX.Element {
  return (
    <>
      {props.bucket.label && (
        <tr className="bg-[var(--surface-base)]">
          <td
            colSpan={props.columns.length + 1}
            className="px-3 py-1.5 fb-t-caption uppercase tracking-[0.08em] font-semibold"
          >
            {props.bucket.label}
          </td>
        </tr>
      )}
      {props.bucket.items.map((it) => (
        <tr
          key={props.idOf(it)}
          onClick={() => props.onOpen(it)}
          onContextMenu={(e) => props.onItemContextMenu(e, it)}
          data-testid={`table-row-${props.idOf(it)}`}
          className={`cursor-pointer ${
            props.selectedIds?.has(props.idOf(it))
              ? 'bg-accent/[0.08] hover:bg-accent/[0.12]'
              : 'hover:bg-[var(--surface-hover)] active:bg-[var(--surface-sunken)]'
          }`}
        >
          <td className="px-3 py-2">
            <div className="flex items-center gap-2">
              {props.selecting && (
                <Icon
                  name={props.selectedIds?.has(props.idOf(it)) ? 'check_circle' : 'radio_button_unchecked'}
                  size={16}
                  className={`shrink-0 ${
                    props.selectedIds?.has(props.idOf(it))
                      ? 'text-[rgb(var(--accent))]'
                      : 'text-[var(--ink-30)]'
                  }`}
                />
              )}
              <span className="w-6 h-6 rounded-[var(--radius-chip)] overflow-hidden bg-[var(--surface-sunken)] flex items-center justify-center shrink-0">
                {props.smallIcon(it)}
              </span>
              <span className="truncate text-[var(--ink-100)]">{props.titleOf(it)}</span>
            </div>
          </td>
          {props.columns.map((c) => (
            <td
              key={c.key}
              className={`px-3 py-2 text-[var(--ink-70)] ${c.align === 'right' ? 'text-right' : 'text-left'}`}
            >
              {c.render(it)}
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

function TimelineView<T>(props: {
  visible: T[]
  idOf: (t: T) => string
  titleOf: (t: T) => string
  smallIcon: (t: T) => ReactNode
  metaLine: (t: T) => ReactNode
  timelineDate: (t: T) => number | null
  onOpen: (t: T) => void
  onItemContextMenu: (e: React.MouseEvent, t: T) => void
}): JSX.Element {
  // Group by month of the item's date, newest month first, so the timeline reads
  // as a real chronology rather than an undated list.
  const sections = useMemo(() => {
    const dated = props.visible
      .map((it) => ({ it, d: props.timelineDate(it) }))
      .filter((r): r is { it: T; d: number } => r.d != null)
      .sort((a, b) => b.d - a.d)
    const undated = props.visible.filter((it) => props.timelineDate(it) == null)
    const byMonth = new Map<string, { label: string; order: number; items: T[] }>()
    for (const { it, d } of dated) {
      const date = new Date(d)
      const id = `${date.getFullYear()}-${date.getMonth()}`
      const label = date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      const b = byMonth.get(id) ?? { label, order: -d, items: [] }
      b.items.push(it)
      byMonth.set(id, b)
    }
    const out = [...byMonth.values()].sort((a, b) => a.order - b.order)
    if (undated.length) out.push({ label: 'No date', order: Infinity, items: undated })
    return out
  }, [props])

  return (
    <div className="relative pl-4">
      <div className="absolute left-[7px] top-1 bottom-1 w-px bg-[var(--edge-firm)]" />
      <div className="space-y-6">
        {sections.map((s) => (
          <div key={s.label}>
            <div className="flex items-center gap-2 mb-2 -ml-4">
              <span className="w-3.5 h-3.5 rounded-full bg-[rgb(var(--accent))] ring-4 ring-[var(--surface-base)] shrink-0" />
              <span className="fb-t-label font-semibold text-[var(--ink-90)]">{s.label}</span>
              <span className="fb-t-caption text-[var(--ink-40)] fb-tabular">{s.items.length}</span>
            </div>
            <div className="space-y-1.5">
              {s.items.map((it, i) => (
                <button
                  key={props.idOf(it)}
                  onClick={() => props.onOpen(it)}
                  onContextMenu={(e) => props.onItemContextMenu(e, it)}
                  data-testid={`timeline-row-${props.idOf(it)}`}
                  style={{ animationDelay: `${Math.min(i * 35, 350)}ms` }}
                  className="flex items-center gap-2.5 w-full text-left fb-tile fb-press fb-fade-in-up px-3 py-2"
                >
                  <span className="w-7 h-7 rounded-[var(--radius-chip)] overflow-hidden bg-[var(--surface-sunken)] flex items-center justify-center shrink-0">
                    {props.smallIcon(it)}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate fb-t-body text-[var(--ink-100)]">
                      {props.titleOf(it)}
                    </span>
                    <span className="block truncate fb-t-caption">
                      {props.metaLine(it)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
