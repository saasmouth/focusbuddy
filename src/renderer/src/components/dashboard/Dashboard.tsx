import { useEffect, useMemo, useState } from 'react'
import { confirmDialog } from '../plexi/PromptDialog'
import type {
  DashboardCardKind,
  DashboardCardSize,
  DashboardColumns
} from '@shared/types'
import { useNodeStore } from '../../stores/nodes'
import {
  DEFAULT_CARD_SIZE,
  DEFAULT_LAYOUT,
  useDashboardLayoutStore
} from '../../stores/dashboardLayouts'
import { DEFAULT_DASHBOARD_COLUMNS } from '@shared/types'
import { taskIdsInScope, type DashboardScope } from '../../lib/dashboardScope'
import StatsCard from './StatsCard'
import QuickStartCard from './QuickStartCard'
import TodayTasksCard from './TodayTasksCard'
import RecentActivityCard from './RecentActivityCard'
import FoldersCard from './FoldersCard'
import WorkspaceProgressCard from './WorkspaceProgressCard'
import WorkspaceHealthCard from './WorkspaceHealthCard'
import FocusSessionCard from './FocusSessionCard'
import AIAssistantCard from './AIAssistantCard'
import DailyBriefCard from './DailyBriefCard'
import RecentNotesCard from './RecentNotesCard'
import Icon from '../Icon'

interface Props {
  scope: DashboardScope
  title: string
  icon: string
  subtitle?: string
  // When true, the Dashboard skips rendering its own header bar — useful
  // when a parent view (e.g. ProjectDashboard) renders its own workspace
  // header above us.
  hideHeader?: boolean
  // When set, only render cards whose kind is in this set. Used by the
  // WorkspaceHeader tabs (Tasks / Notes / Files / Activity) to filter the
  // dashboard down to a relevant subset. null = no filter (default).
  cardFilter?: Set<DashboardCardKind> | null
}

// 'garden' and 'energy' deprecated from the UI — see POSITIONING.md §11.5 (dopamine
// reframe). DB + types retained for forward-compat; just not surfaced in the palette.
const CARD_META: Record<
  Exclude<DashboardCardKind, 'garden' | 'energy'>,
  { label: string; icon: string; description: string }
> = {
  'quick-start': {
    label: 'Quick Start',
    icon: 'bolt',
    description: 'One-tap 5-min on the highest-priority task in scope'
  },
  stats: {
    label: 'Today',
    icon: 'today',
    description: 'Sessions, focused minutes, and tasks done today'
  },
  'today-tasks': {
    label: 'Open Tasks',
    icon: 'checklist',
    description: 'Open tasks in scope — overdue, today, upcoming'
  },
  'recent-activity': {
    label: 'Recent Activity',
    icon: 'history',
    description: 'Last 24h of work widget adds, browses, sessions, chats'
  },
  folders: {
    label: 'Folders',
    icon: 'folder_open',
    description: 'Active / Closed / Archived folders — quick navigate, archive, restore'
  },
  'workspace-progress': {
    label: 'This Week',
    icon: 'trending_up',
    description: 'Completion ring + weekly delta + focus minutes — momentum at a glance'
  },
  'workspace-health': {
    label: 'Workspace Health',
    icon: 'health_and_safety',
    description: 'Local heuristics + optional AI analysis — surfaces stale folders, overdue tasks, momentum signals'
  },
  'focus-session': {
    label: 'Focus Session',
    icon: 'hourglass_empty',
    description: 'Big 25:00 timer with one-tap start — runs the existing focus session engine'
  },
  'ai-assistant': {
    label: 'AI Assistant',
    icon: 'auto_awesome',
    description: 'Quick-ask card with one-tap suggestions and free-form chat — uses your Anthropic key'
  },
  'recent-notes': {
    label: 'Recent Notes',
    icon: 'sticky_note_2',
    description: 'Last six edited sticky / note / page work widgets across the workspace'
  },
  'daily-brief': {
    label: 'Daily Brief',
    icon: 'wb_sunny',
    description: "A proactive morning summary of what to focus on today, built from your real tasks, calendar and recent docs"
  }
}

// Garden was deprecated — exclude it everywhere.
type ActiveCard = Exclude<DashboardCardKind, 'garden' | 'energy'>

// The next size in the Small → Medium → Large → Small cycle. Used by the
// per-card size control in edit mode.
const SIZE_ORDER: DashboardCardSize[] = ['small', 'medium', 'large']
function nextSize(size: DashboardCardSize): DashboardCardSize {
  const idx = SIZE_ORDER.indexOf(size)
  return SIZE_ORDER[(idx + 1) % SIZE_ORDER.length]
}
const SIZE_LABEL: Record<DashboardCardSize, string> = {
  small: 'S',
  medium: 'M',
  large: 'L'
}

// How many grid columns a card of a given size spans, capped at the dashboard's
// column count. Small spans 1, Medium spans up to 2, Large spans the full width.
function spanFor(size: DashboardCardSize, columns: DashboardColumns): number {
  if (columns === 1) return 1
  switch (size) {
    case 'small':
      return 1
    case 'medium':
      return Math.min(2, columns)
    case 'large':
      return columns
    default:
      return 1
  }
}

// A real min-height difference so the size choice reads visually even for cards
// whose own content is short.
const SIZE_MIN_HEIGHT: Record<DashboardCardSize, number> = {
  small: 0,
  medium: 120,
  large: 200
}

// Build a stable key for the dashboard's layout — 'home' for global, project id otherwise
function dashboardKeyOf(scope: DashboardScope): string {
  return scope.kind === 'global' ? 'home' : scope.projectId
}

export default function Dashboard({
  scope,
  title,
  icon,
  subtitle,
  hideHeader,
  cardFilter
}: Props): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const taskIds = useMemo(() => taskIdsInScope(nodes, scope), [nodes, scope])

  const dashboardKey = dashboardKeyOf(scope)
  const loadLayout = useDashboardLayoutStore((s) => s.load)
  const setCards = useDashboardLayoutStore((s) => s.setCards)
  const setColumns = useDashboardLayoutStore((s) => s.setColumns)
  const setCardSize = useDashboardLayoutStore((s) => s.setCardSize)
  const resetLayout = useDashboardLayoutStore((s) => s.reset)
  const configFromStore = useDashboardLayoutStore((s) => s.configs[dashboardKey])

  useEffect(() => {
    void loadLayout(dashboardKey)
  }, [dashboardKey, loadLayout])

  const cardIdsRaw =
    configFromStore && configFromStore.cardIds.length > 0
      ? configFromStore.cardIds
      : DEFAULT_LAYOUT
  // Filter out deprecated kinds so saved layouts containing 'garden' don't crash
  const cardIdsAll = cardIdsRaw.filter(
    (c): c is ActiveCard => c !== 'garden' && c !== 'energy'
  )
  // Apply tab-driven filter from the parent (Workspace Header tabs).
  const cardIds = cardFilter
    ? cardIdsAll.filter((c) => cardFilter.has(c))
    : cardIdsAll

  // Column count + per-card sizes for this dashboard, with defaults when unset.
  const columns: DashboardColumns =
    configFromStore?.columns ?? DEFAULT_DASHBOARD_COLUMNS
  const sizes = configFromStore?.sizes ?? {}
  function sizeOf(card: ActiveCard): DashboardCardSize {
    return sizes[card] ?? DEFAULT_CARD_SIZE
  }

  const [editing, setEditing] = useState(false)
  const [dragId, setDragId] = useState<ActiveCard | null>(null)
  const [dropBefore, setDropBefore] = useState<ActiveCard | null>(null)

  const hidden: ActiveCard[] = (
    Object.keys(CARD_META) as ActiveCard[]
  ).filter((k) => !cardIds.includes(k))

  function moveCard(dragged: ActiveCard, before: ActiveCard | null): void {
    const without = cardIds.filter((c) => c !== dragged)
    if (before === null) {
      void setCards(dashboardKey, [...without, dragged])
    } else {
      const idx = without.indexOf(before)
      const safeIdx = idx >= 0 ? idx : without.length
      void setCards(dashboardKey, [
        ...without.slice(0, safeIdx),
        dragged,
        ...without.slice(safeIdx)
      ])
    }
  }

  function addCard(card: ActiveCard): void {
    if (cardIds.includes(card)) return
    void setCards(dashboardKey, [...cardIds, card])
  }

  function removeCard(card: ActiveCard): void {
    void setCards(
      dashboardKey,
      cardIds.filter((c) => c !== card)
    )
  }

  function cycleSize(card: ActiveCard): void {
    void setCardSize(dashboardKey, card, nextSize(sizeOf(card)))
  }

  const todayLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })

  // Responsive column count. On narrow widths we fall to a single column so
  // cards never crush. The stored preference is unchanged; only the applied
  // template collapses. A card can never span more than the applied count.
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const apply = (): void => setNarrow(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  const appliedColumns: DashboardColumns = narrow ? 1 : columns

  return (
    <div className="h-full overflow-auto desk-paper no-tod">
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">
        {/* Header — suppressed when the parent view renders its own */}
        {!hideHeader && (
          <div className="flex items-center gap-3 mb-2">
            <div className="inline-flex items-center justify-center h-10 w-10 rounded-[var(--radius-row)] bg-[var(--surface-sunken)] shrink-0">
              <Icon name={icon} size={20} className="text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-semibold text-[var(--ink-100)] truncate">
                {title}
              </h1>
              <p className="text-[12px] text-[var(--ink-50)] truncate">
                {subtitle ?? todayLabel}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {editing && (
                <button
                  onClick={async () => {
                    if (await confirmDialog({ title: 'Reset this dashboard?', body: 'Your portlet layout returns to the default. Portlet data is untouched.', confirmLabel: 'Reset layout' }) === true) {
                      void resetLayout(dashboardKey)
                      setEditing(false)
                    }
                  }}
                  className="btn-ghost"
                  title="Restore default layout"
                >
                  <Icon name="restart_alt" size={14} />
                  <span>Reset</span>
                </button>
              )}
              <button
                data-testid="dashboard-customize"
                onClick={() => setEditing((v) => !v)}
                className={`btn-ghost ${editing ? '!text-accent' : ''}`}
                title={editing ? 'Done customizing' : 'Customize this dashboard'}
              >
                <Icon name={editing ? 'check' : 'tune'} size={14} />
                <span>{editing ? 'Done' : 'Customize'}</span>
              </button>
            </div>
          </div>
        )}

        {/* When a parent view renders its own header (hideHeader), the
            Dashboard still needs its own Customize / Done toggle so the layout,
            column and size controls remain reachable. This compact row provides
            it without duplicating the parent's title. */}
        {hideHeader && (
          <div className="flex items-center justify-end gap-1">
            {editing && (
              <button
                onClick={async () => {
                  if (await confirmDialog({ title: 'Reset this dashboard?', body: 'Your portlet layout returns to the default. Portlet data is untouched.', confirmLabel: 'Reset layout' }) === true) {
                    void resetLayout(dashboardKey)
                    setEditing(false)
                  }
                }}
                className="btn-ghost"
                title="Restore default layout"
              >
                <Icon name="restart_alt" size={14} />
                <span>Reset</span>
              </button>
            )}
            <button
              data-testid="dashboard-customize"
              onClick={() => setEditing((v) => !v)}
              className={`btn-ghost ${editing ? '!text-accent' : ''}`}
              title={editing ? 'Done customizing' : 'Customize this dashboard'}
            >
              <Icon name={editing ? 'check' : 'tune'} size={14} />
              <span>{editing ? 'Done' : 'Customize'}</span>
            </button>
          </div>
        )}

        {/* Column chooser — visible in edit mode so the layout can be set to
            one, two or three columns. Persisted per dashboard key. */}
        {editing && (
          <div className="flex items-center gap-2 rounded-xl bg-[var(--surface-sunken)] px-3 py-2">
            <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-semibold">
              Columns
            </span>
            <div className="inline-flex rounded-lg bg-[var(--surface-sunken)] overflow-hidden">
              {([1, 2, 3] as DashboardColumns[]).map((n) => (
                <button
                  key={n}
                  data-testid={`dashboard-columns-${n}`}
                  aria-pressed={columns === n}
                  onClick={() => void setColumns(dashboardKey, n)}
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    columns === n
                      ? 'bg-accent text-white'
                      : 'text-[var(--ink-70)] hover:bg-accent/10'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-[var(--ink-40)]">
              Cards flow into this many columns. Narrow windows fall back to one.
            </span>
          </div>
        )}

        {/* Cards laid out in a responsive grid. Each card spans a number of
            columns derived from its size. Drag-reorder + the drop indicator
            (top border) are preserved on each grid cell. */}
        <div
          data-testid="dashboard-grid"
          data-columns={appliedColumns}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${appliedColumns}, minmax(0, 1fr))`,
            gap: '16px',
            alignItems: 'start'
          }}
        >
          {cardIds.map((cardId) => {
            const isDragging = dragId === cardId
            const isDropTarget = dropBefore === cardId
            const size = sizeOf(cardId)
            const span = spanFor(size, appliedColumns)
            return (
              <div
                key={cardId}
                data-testid={`dashboard-card-${cardId}`}
                data-size={size}
                data-span={span}
                style={{
                  gridColumn: `span ${span} / span ${span}`,
                  minHeight: SIZE_MIN_HEIGHT[size] || undefined,
                  opacity: isDragging ? 0.45 : 1,
                  borderTop:
                    isDropTarget && editing
                      ? '3px solid rgb(var(--accent))'
                      : '3px solid transparent',
                  transition: 'border-color 80ms'
                }}
                onDragOver={
                  editing
                    ? (e) => {
                        if (!dragId || dragId === cardId) return
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        setDropBefore(cardId)
                      }
                    : undefined
                }
                onDrop={
                  editing
                    ? (e) => {
                        e.preventDefault()
                        if (dragId && dragId !== cardId) moveCard(dragId, cardId)
                        setDragId(null)
                        setDropBefore(null)
                      }
                    : undefined
                }
              >
                {editing && (
                  <CardEditChrome
                    cardKind={cardId}
                    size={size}
                    onRemove={() => removeCard(cardId)}
                    onCycleSize={() => cycleSize(cardId)}
                    onDragStart={() => setDragId(cardId)}
                    onDragEnd={() => {
                      setDragId(null)
                      setDropBefore(null)
                    }}
                  />
                )}
                <CardBody cardKind={cardId} taskIds={taskIds} editing={editing} />
              </div>
            )
          })}

          {/* Drop-at-end zone in edit mode — spans the full row. */}
          {editing && cardIds.length > 0 && (
            <div
              onDragOver={(e) => {
                if (!dragId) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropBefore(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragId) moveCard(dragId, null)
                setDragId(null)
                setDropBefore(null)
              }}
              style={{
                gridColumn: `span ${appliedColumns} / span ${appliedColumns}`,
                height: 12,
                borderTop:
                  dropBefore === null && dragId
                    ? '3px solid rgb(var(--accent))'
                    : '3px solid transparent',
                transition: 'border-color 80ms'
              }}
            />
          )}
        </div>

        {/* Add-card palette (edit mode only) */}
        {editing && (
          <div className="rounded-xl border border-dashed border-[var(--edge-firm)] p-4">
            <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-semibold mb-2">
              {hidden.length === 0 ? 'All cards added' : 'Add a card'}
            </div>
            {hidden.length === 0 ? (
              <p className="text-xs text-[var(--ink-50)]">
                Every available card is on this dashboard. Drag to reorder, click × to remove.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {hidden.map((k) => {
                  const meta = CARD_META[k]
                  return (
                    <button
                      key={k}
                      onClick={() => addCard(k)}
                      className="fb-btn-surface flex items-start gap-2 p-2 hover:border-accent hover:bg-accent/5 transition-colors text-left"
                    >
                      <Icon
                        name={meta.icon}
                        size={16}
                        className="text-accent shrink-0 mt-0.5"
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-[var(--ink-100)]">
                          {meta.label}
                        </div>
                        <div className="text-[10px] text-[var(--ink-50)] leading-snug">
                          {meta.description}
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Empty state — user removed every card */}
        {!editing && cardIds.length === 0 && (
          <div className="fb-card p-6 text-center">
            <Icon
              name="dashboard_customize"
              size={28}
              className="text-[var(--ink-40)] mx-auto mb-2"
            />
            <p className="text-sm text-[var(--ink-70)] mb-3">
              This dashboard is empty. Click <strong>Customize</strong> to add cards back.
            </p>
            <button onClick={() => setEditing(true)} className="btn-primary mx-auto">
              <Icon name="tune" size={14} />
              <span>Customize</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// Renders the actual card body — same components used before, just keyed by id
function CardBody({
  cardKind,
  taskIds
}: {
  cardKind: Exclude<DashboardCardKind, 'garden' | 'energy'>
  taskIds: Set<string>
  editing: boolean
}): JSX.Element | null {
  const nodes = useNodeStore((s) => s.nodes)
  switch (cardKind) {
    case 'quick-start':
      return <QuickStartCard taskIds={taskIds} nodes={nodes} />
    case 'stats':
      return <StatsCard taskIds={taskIds} nodes={nodes} />
    case 'today-tasks':
      return <TodayTasksCard taskIds={taskIds} nodes={nodes} />
    case 'recent-activity':
      return <RecentActivityCard taskIds={taskIds} />
    case 'folders':
      return <FoldersCard nodes={nodes} />
    case 'workspace-progress':
      return <WorkspaceProgressCard taskIds={taskIds} nodes={nodes} />
    case 'workspace-health':
      return <WorkspaceHealthCard taskIds={taskIds} nodes={nodes} />
    case 'focus-session':
      return <FocusSessionCard nodes={nodes} />
    case 'daily-brief':
      return <DailyBriefCard />
    case 'ai-assistant':
      return <AIAssistantCard />
    case 'recent-notes':
      return <RecentNotesCard taskIds={taskIds} />
    default:
      return null
  }
}

// Edit-mode chrome: drag handle + label + size cycler + remove button.
// Appears ABOVE each card.
function CardEditChrome({
  cardKind,
  size,
  onRemove,
  onCycleSize,
  onDragStart,
  onDragEnd
}: {
  cardKind: Exclude<DashboardCardKind, 'garden' | 'energy'>
  size: DashboardCardSize
  onRemove: () => void
  onCycleSize: () => void
  onDragStart: () => void
  onDragEnd: () => void
}): JSX.Element {
  const meta = CARD_META[cardKind]
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/fb-card', cardKind)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      className="flex items-center gap-2 px-3 py-1.5 rounded-t-xl border border-b-0 border-accent/40 bg-accent/5 text-accent text-[11px] font-medium cursor-grab active:cursor-grabbing select-none"
    >
      <Icon name="drag_indicator" size={14} />
      <Icon name={meta.icon} size={12} />
      <span className="flex-1">{meta.label}</span>
      <button
        data-testid={`dashboard-card-size-${cardKind}`}
        title={`Card size: ${size}. Click to cycle Small / Medium / Large.`}
        onClick={(e) => {
          e.stopPropagation()
          onCycleSize()
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="h-5 min-w-[20px] px-1 inline-flex items-center justify-center rounded border border-accent/40 hover:bg-accent/20 text-[10px] font-semibold"
      >
        {SIZE_LABEL[size]}
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="h-5 w-5 inline-flex items-center justify-center rounded hover:bg-accent/20"
        title="Remove from this dashboard"
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}
