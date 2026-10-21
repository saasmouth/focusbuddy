import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import type { FocusCluster, Widget } from '@shared/types'
import { catalogFor } from '../lib/widgetCatalog'
import { buildContextForWidget } from '../lib/contextMenu/buildContext'
import type { MenuContext } from '../lib/contextMenu/types'
import type { CtxMenuItem } from './CanvasContextMenu'
import UnifiedWidgetMenu from './contextMenu/UnifiedWidgetMenu'
import WidgetPreview from './WidgetPreview'
import FocusClusterTab from './focus/FocusClusterTab'
import Icon from './Icon'
import { useSplitDrag } from '../lib/focusSplitDrag'

// Apple WWDC23 Stage Manager spring — the same physics the desk StageManagerStrip
// uses, so the widget filmstrip feels native to the app.
const SPRING = { type: 'spring' as const, stiffness: 158, damping: 25, mass: 1 }

// The two permanent "action tabs" that live after the widgets, separated by a
// divider. They are Focus-Mode chrome — NOT widgets — so they never touch the
// canvas, persistence, or the widget nav-order. The dock renders them as fixed
// tiles; selection is tracked separately from focusedWidgetId by the parent.
export type ChromeTab = 'add' | 'chat'

interface Props {
  // Full navigation order (spatial reading order) of the desk's focusable widgets.
  widgets: Widget[]
  // The currently-focused widget id. Empty string when a chrome tab is active
  // instead of a widget.
  activeId: string
  // Jump focus to a widget.
  onPick: (id: string) => void
  // Which permanent action tab (if any) is currently showing full-size.
  activeChromeTab: ChromeTab | null
  // Select one of the permanent action tabs.
  onPickChrome: (tab: ChromeTab) => void
  // ── Clusters (C2) ───────────────────────────────────────────────────────────
  // The desk's saved split "groups". Grouped widgets collapse OUT of the individual
  // tile row and are represented by one live cluster tab each.
  clusters: FocusCluster[]
  // The cluster currently open in focus mode (if any) — accent-ringed in the dock.
  activeClusterId: string | null
  // Open a cluster (hydrate its saved split).
  onOpenCluster: (cluster: FocusCluster) => void
}

// The dock/filmstrip shown along the bottom of focus mode — a Mac-dock / Stage
// Manager style row of live widget thumbnails. Each tile is a real scaled
// WidgetPreview so you recognise the thing by its content, not a generic icon.
// Click any tile to jump focus there; the active tile is lifted + accent-ringed
// and the strip auto-scrolls to keep it centred as you arrow through the deck.
export default function WidgetFocusDock({
  widgets,
  activeId,
  onPick,
  activeChromeTab,
  onPickChrome,
  clusters,
  activeClusterId,
  onOpenCluster
}: Props): JSX.Element | null {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<HTMLButtonElement | null>(null)
  const { beginDrag } = useSplitDrag()

  // Right-click context menu for a dock tile. Reuses the app-wide unified menu
  // engine (the same one widget headers use) so a dock tile gets the full
  // kind-aware action set for free. We add two dock-natural rows via headerExtras
  // (Focus, Open full-size) since the dock is fundamentally a "jump here" surface.
  const [menuCtx, setMenuCtx] = useState<MenuContext | null>(null)

  function openTileMenu(e: React.MouseEvent, w: Widget): void {
    e.preventDefault()
    e.stopPropagation()
    const headerExtras: CtxMenuItem[] = [
      {
        label: 'Show in full view',
        icon: 'center_focus_strong',
        onClick: () => onPick(w.id)
      }
    ]
    setMenuCtx(
      buildContextForWidget(w, { clientX: e.clientX, clientY: e.clientY }, { headerExtras })
    )
  }

  // Keep the focused tile centred in the strip whenever it changes — whether the
  // active tile is a widget or one of the permanent chrome tabs.
  useEffect(() => {
    const el = activeRef.current
    const scroller = scrollerRef.current
    if (!el || !scroller) return
    const target = el.offsetLeft - scroller.clientWidth / 2 + el.clientWidth / 2
    scroller.scrollTo({ left: Math.max(0, target), behavior: 'smooth' })
  }, [activeId, activeChromeTab])

  // The Add + Chat tabs are always present, so the dock is meaningful even with a
  // single widget (the old `< 2` guard would hide it and strand them). Only bail
  // when there is genuinely nothing to show — no widgets AND no chrome tabs, which
  // shouldn't happen since the tabs are permanent, but keeps the type honest.
  if (widgets.length === 0) return null

  // Collapse grouped widgets OUT of the individual-tile row (C2): a widget that
  // belongs to a cluster is represented by that cluster's tab, not its own tile.
  // Chrome members (Add/Chat) are permanent tabs and never removed from the strip.
  const groupedWidgetIds = new Set<string>()
  for (const c of clusters) {
    for (const p of c.panes) {
      if (p.source.kind === 'widget') groupedWidgetIds.add(p.source.widgetId)
    }
  }
  const ungroupedWidgets = widgets.filter((w) => !groupedWidgetIds.has(w.id))

  // The active INDEX (position counter) is over the ungrouped tiles, since those
  // are what the counter walks; a cluster/chrome being active shows a name instead.
  const activeIndex = ungroupedWidgets.findIndex((w) => w.id === activeId)

  return (
    <div
      className="shrink-0 flex flex-col items-center gap-1.5 px-4 pt-2 pb-3"
      data-testid="widget-focus-dock"
      // Sit above the backdrop; clicks here must not close focus mode.
      onClick={(e) => e.stopPropagation()}
    >
      {/* Position counter — quiet, tabular, tells you where you are in the deck.
          When a chrome tab (Add / Chat) is showing there is no numeric position,
          so we name it instead of showing a misleading index. */}
      <div className="fb-tabular text-[10px] tracking-wide text-[var(--ink-40)] select-none">
        {activeClusterId ? (
          <span className="uppercase tracking-[0.14em] text-[var(--ink-50)]">Group</span>
        ) : activeChromeTab ? (
          <span className="uppercase tracking-[0.14em] text-[var(--ink-50)]">
            {activeChromeTab === 'add' ? 'Add' : 'AI Chat'}
          </span>
        ) : activeIndex >= 0 ? (
          <>
            {activeIndex + 1} <span className="text-[var(--ink-30)]">/</span>{' '}
            {ungroupedWidgets.length}
          </>
        ) : (
          <span className="text-[var(--ink-30)]">·</span>
        )}
      </div>

      <div
        ref={scrollerRef}
        className="max-w-full overflow-x-auto overflow-y-hidden flex items-end gap-2 px-2 py-1"
        style={{ scrollbarWidth: 'none' }}
        onWheel={(e) => {
          // Turn vertical wheel into horizontal strip scroll so a trackpad or
          // mouse wheel walks the dock instead of doing nothing.
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && scrollerRef.current) {
            scrollerRef.current.scrollLeft += e.deltaY
          }
        }}
      >
        {/* Cluster tabs first — each stands in for a whole split "group", showing a
            live mini-preview in the group's real shape. Clicking one opens the
            saved split. Grouped widgets are collapsed out of the tile row below. */}
        {clusters.map((cluster) => (
          <FocusClusterTab
            key={cluster.id}
            cluster={cluster}
            widgets={widgets}
            isActive={cluster.id === activeClusterId}
            onOpen={onOpenCluster}
          />
        ))}

        {ungroupedWidgets.map((w) => {
          const isActive = w.id === activeId
          const entry = catalogFor(w.kind)
          return (
            <motion.button
              key={w.id}
              ref={isActive ? activeRef : undefined}
              onClick={() => onPick(w.id)}
              onContextMenu={(e) => openTileMenu(e, w)}
              // Drag this tile up into the view to snap it into a split pane
              // (spec §6.1). A plain click still focuses it — the drag only
              // promotes past a small movement threshold.
              onPointerDown={(e) =>
                beginDrag(e, { kind: 'widget', widgetId: w.id }, w.title || entry?.label || 'Work widget')
              }
              title={w.title || entry?.label || 'Work widget'}
              data-testid={`focus-dock-tile-${w.id}`}
              data-active={isActive ? 'true' : 'false'}
              initial={false}
              animate={{
                scale: isActive ? 1 : 0.9,
                y: isActive ? -6 : 0,
                opacity: isActive ? 1 : 0.72
              }}
              whileHover={{ scale: isActive ? 1.02 : 0.98, opacity: 1, transition: { ...SPRING, stiffness: 260 } }}
              whileTap={{ scale: 0.94 }}
              transition={SPRING}
              className="relative shrink-0 rounded-lg overflow-hidden block cursor-pointer"
              style={{ width: 92, height: 60 }}
            >
              {/* Live content thumbnail — scaled real preview of the widget. */}
              <div className="absolute inset-0 bg-[var(--surface-sunken)] overflow-hidden">
                <div
                  style={{
                    width: w.width,
                    height: w.height,
                    transform: `scale(${Math.min(92 / w.width, 60 / w.height)})`,
                    transformOrigin: 'top left',
                    pointerEvents: 'none'
                  }}
                >
                  <WidgetPreview widget={w} />
                </div>
              </div>

              {/* Ring: accent for active, hairline otherwise. */}
              <div
                className={[
                  'absolute inset-0 rounded-lg pointer-events-none transition-opacity duration-150',
                  isActive
                    ? 'ring-2 ring-inset ring-[rgb(var(--accent))]'
                    : 'ring-1 ring-inset ring-black/10 dark:ring-white/10'
                ].join(' ')}
              />

              {/* Kind glyph chip, bottom-left, so type is legible even when the
                  thumbnail is dense. */}
              <div className="absolute bottom-1 left-1 h-4 w-4 rounded-[5px] bg-[var(--surface-raised)] flex items-center justify-center shadow-sm">
                <Icon
                  name={entry?.icon ?? 'apps'}
                  size={10}
                  filled={isActive}
                  className={isActive ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-50)]'}
                />
              </div>
            </motion.button>
          )
        })}

        {/* ── Divider: open documents │ permanent action tabs ──────────────
            A vertical hairline (mirrors the StageManagerStrip separator) that
            visually splits "your open tabs" from the two fixed action tabs. */}
        <div
          className="self-stretch w-px bg-[color-mix(in_oklab,var(--edge-soft)_60%,transparent)] shrink-0 mx-1"
          aria-hidden="true"
        />

        {/* The two permanent action tabs. They render as fixed tiles the same
            size as widget tiles, so they read as first-class tabs — you scroll
            or click into them exactly like a document. */}
        {(['add', 'chat'] as const).map((tab) => {
          const isActive = activeChromeTab === tab
          const label = tab === 'add' ? 'Add' : 'AI Chat'
          const glyph = tab === 'add' ? 'add' : 'smart_toy'
          return (
            <motion.button
              key={tab}
              ref={isActive ? activeRef : undefined}
              onClick={() => onPickChrome(tab)}
              // Chrome tabs are draggable into split panes too (spec §6.1 /
              // "anything canvas-addable") — drop Add or AI Chat beside a doc.
              onPointerDown={(e) =>
                beginDrag(e, { kind: 'chrome', tab }, tab === 'add' ? 'Add' : 'AI Chat')
              }
              title={tab === 'add' ? 'Add — create or open a document' : 'AI Chat — your workspace assistant'}
              data-testid={`focus-dock-chrome-${tab}`}
              data-active={isActive ? 'true' : 'false'}
              initial={false}
              animate={{
                scale: isActive ? 1 : 0.9,
                y: isActive ? -6 : 0,
                opacity: isActive ? 1 : 0.72
              }}
              whileHover={{ scale: isActive ? 1.02 : 0.98, opacity: 1, transition: { ...SPRING, stiffness: 260 } }}
              whileTap={{ scale: 0.94 }}
              transition={SPRING}
              className="relative shrink-0 rounded-lg overflow-hidden block cursor-pointer"
              style={{ width: 92, height: 60 }}
            >
              {/* Action-tab face: a calm surface with a centred glyph + label,
                  distinct from the live-thumbnail widget tiles. Add uses a
                  dashed accent affordance (the "new" convention); Chat a solid
                  assistant glyph. */}
              <div
                className={[
                  'absolute inset-0 flex flex-col items-center justify-center gap-1',
                  tab === 'add'
                    ? 'bg-[var(--surface-sunken)]'
                    : 'bg-[rgb(var(--accent))]/8'
                ].join(' ')}
              >
                <Icon
                  name={glyph}
                  size={20}
                  filled={isActive}
                  className={isActive ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-50)]'}
                />
                <span
                  className={[
                    'text-[9px] font-medium uppercase tracking-[0.12em]',
                    isActive ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-50)]'
                  ].join(' ')}
                >
                  {label}
                </span>
              </div>

              {/* Ring: accent for active, and for the Add tab a dashed hairline
                  otherwise (the "create new" affordance); Chat gets the standard
                  solid hairline. */}
              <div
                className={[
                  'absolute inset-0 rounded-lg pointer-events-none transition-opacity duration-150',
                  isActive
                    ? 'ring-2 ring-inset ring-[rgb(var(--accent))]'
                    : tab === 'add'
                      ? 'ring-1 ring-inset ring-[var(--edge-soft)] border border-dashed border-[var(--edge-soft)]'
                      : 'ring-1 ring-inset ring-black/10 dark:ring-white/10'
                ].join(' ')}
              />
            </motion.button>
          )
        })}
      </div>

      {/* The right-click menu for a dock tile. Portaled to body by
          CanvasContextMenu, so it renders above the focus overlay. */}
      {menuCtx && (
        <UnifiedWidgetMenu menuContext={menuCtx} onClose={() => setMenuCtx(null)} />
      )}
    </div>
  )
}
