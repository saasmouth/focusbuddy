import { motion, useReducedMotion } from 'framer-motion'
import type { FocusCluster, Widget, Pane } from '@shared/types'
import { gridTemplate } from '../../lib/splitGeometry'
import { catalogFor } from '../../lib/widgetCatalog'
import WidgetPreview from '../WidgetPreview'
import Icon from '../Icon'

// Apple Stage Manager spring — same physics the widget tiles use so a cluster tab
// feels native alongside them.
const SPRING = { type: 'spring' as const, stiffness: 158, damping: 25, mass: 1 }

interface Props {
  cluster: FocusCluster
  // All live widgets on the desk, to resolve { kind:'widget', widgetId } panes.
  widgets: Widget[]
  // Is this cluster the one currently open in focus mode?
  isActive: boolean
  // Open the cluster (hydrate its saved split).
  onOpen: (cluster: FocusCluster) => void
  // Begin a drag from this tab (reserved for later phases — a cluster tab is
  // draggable like a widget tile). Optional so the dock can omit it in v1.
  onPointerDown?: (e: React.PointerEvent) => void
}

// One pane's mini preview inside the cluster tab. A widget pane renders its live
// WidgetPreview (recognizable by content); a chrome pane (Add / AI Chat) renders a
// small glyph tile; a meet pane a camera glyph; a missing widget a calm dash.
function MiniPane({ pane, widgets }: { pane: Pane; widgets: Widget[] }): JSX.Element {
  const { source } = pane
  if (source.kind === 'widget') {
    const w = widgets.find((x) => x.id === source.widgetId)
    if (!w) {
      return (
        <div className="h-full w-full grid place-items-center bg-[var(--surface-sunken)]">
          <Icon name="remove" size={12} className="text-[var(--ink-30)]" />
        </div>
      )
    }
    return (
      <div className="h-full w-full overflow-hidden bg-[var(--surface-raised)]">
        <div style={{ pointerEvents: 'none' }} className="h-full w-full">
          <WidgetPreview widget={w} />
        </div>
      </div>
    )
  }
  if (source.kind === 'chrome') {
    return (
      <div
        className={[
          'h-full w-full grid place-items-center',
          source.tab === 'add' ? 'bg-[var(--surface-sunken)]' : 'bg-[rgb(var(--accent))]/8'
        ].join(' ')}
      >
        <Icon
          name={source.tab === 'add' ? 'add' : 'smart_toy'}
          size={14}
          className="text-[var(--ink-50)]"
        />
      </div>
    )
  }
  // meet (reserved)
  return (
    <div className="h-full w-full grid place-items-center bg-[var(--surface-sunken)]">
      <Icon name="videocam" size={14} className="text-[var(--ink-50)]" />
    </div>
  )
}

// A dock tab that STANDS IN for a whole cluster (a split "group"). It shows a live
// mini-preview laid out in the cluster's real shape (via the same gridTemplate the
// split uses), so you recognize the group by its content — the halves/left-2stack/
// quad silhouette reads at a glance. Clicking it opens the saved split.
export default function FocusClusterTab({
  cluster,
  widgets,
  isActive,
  onOpen,
  onPointerDown
}: Props): JSX.Element {
  const tpl = gridTemplate(cluster.shape, cluster.ratios)
  const count = cluster.panes.length
  const reduceMotion = useReducedMotion()

  // A short label from the members' content — "Doc + AI Chat", "3 in group", etc.
  const label = clusterLabel(cluster, widgets)

  return (
    <motion.button
      type="button"
      onClick={() => onOpen(cluster)}
      onPointerDown={onPointerDown}
      title={label}
      // Screen-reader name: announce it's a GROUP with its member count + contents,
      // and its state, since the visual (silhouette + chip) can't be read aloud.
      aria-label={`Open group of ${count} — ${label}${isActive ? ' (open)' : ''}`}
      aria-pressed={isActive}
      data-testid={`focus-dock-cluster-${cluster.id}`}
      data-active={isActive ? 'true' : 'false'}
      data-pane-count={count}
      initial={false}
      // Respect prefers-reduced-motion: skip the lift/scale spring, keep only the
      // resting opacity difference so active vs inactive is still legible.
      animate={
        reduceMotion
          ? { scale: 1, y: 0, opacity: isActive ? 1 : 0.72 }
          : { scale: isActive ? 1 : 0.9, y: isActive ? -6 : 0, opacity: isActive ? 1 : 0.72 }
      }
      whileHover={
        reduceMotion
          ? { opacity: 1 }
          : { scale: isActive ? 1.02 : 0.98, opacity: 1, transition: { ...SPRING, stiffness: 260 } }
      }
      whileTap={reduceMotion ? undefined : { scale: 0.94 }}
      transition={reduceMotion ? { duration: 0 } : SPRING}
      className="relative shrink-0 rounded-lg overflow-hidden block cursor-pointer"
      style={{ width: 92, height: 60 }}
    >
      {/* The live mini split-preview — real shape, tiny gap between tiles so the
          group silhouette is legible even at 92×60. */}
      <div
        className="absolute inset-0 grid bg-[var(--surface-sunken)]"
        style={{
          gap: 1.5,
          gridTemplateColumns: tpl.columns,
          gridTemplateRows: tpl.rows,
          gridTemplateAreas: tpl.areas
        }}
      >
        {cluster.panes.map((pane) => (
          <div
            key={pane.id}
            className="overflow-hidden"
            style={{ gridArea: tpl.cellArea[pane.cell] }}
          >
            <MiniPane pane={pane} widgets={widgets} />
          </div>
        ))}
      </div>

      {/* Group affordance chip — a grid glyph + pane count, bottom-left, so the tab
          reads unmistakably as a GROUP (not a single widget) at a glance. */}
      <div className="absolute bottom-1 left-1 h-4 min-w-4 px-1 rounded-[5px] bg-[var(--surface-raised)] flex items-center justify-center gap-0.5 shadow-sm">
        <Icon
          name="grid_view"
          size={9}
          filled={isActive}
          className={isActive ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-50)]'}
        />
        <span
          className={[
            'text-[8px] font-semibold leading-none',
            isActive ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-50)]'
          ].join(' ')}
        >
          {count}
        </span>
      </div>

      {/* Ring: accent for the open cluster, hairline otherwise — matches widget tiles. */}
      <div
        className={[
          'absolute inset-0 rounded-lg pointer-events-none transition-opacity duration-150',
          isActive
            ? 'ring-2 ring-inset ring-[rgb(var(--accent))]'
            : 'ring-1 ring-inset ring-black/10 dark:ring-white/10'
        ].join(' ')}
      />
    </motion.button>
  )
}

// A short human label for a cluster from its members' titles. Keeps it to the
// first two names + "…" so it fits a tooltip without wrapping.
function clusterLabel(cluster: FocusCluster, widgets: Widget[]): string {
  const names = cluster.panes.map((p) => {
    const source = p.source
    if (source.kind === 'widget') {
      const w = widgets.find((x) => x.id === source.widgetId)
      return w?.title || (w ? catalogFor(w.kind)?.label : null) || 'Work widget'
    }
    if (source.kind === 'chrome') return source.tab === 'add' ? 'Add' : 'AI Chat'
    return 'PlexiiCall'
  })
  if (names.length <= 2) return names.join(' + ')
  return `${names.slice(0, 2).join(' + ')} +${names.length - 2}`
}
