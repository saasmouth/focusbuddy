import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import Icon from './Icon'
import WidgetPalette from './WidgetPalette'
import type { WidgetCatalogEntry } from '../lib/widgetCatalog'

export interface ToolbarAction {
  icon: string
  label: string
  shortcut?: string
  color?: string
  onClick: () => void
  separatorAfter?: boolean
}

interface Props {
  actions: ToolbarAction[]
  onAddWidget: (entry: WidgetCatalogEntry) => void
  onImport?: () => void
  onBringSynced?: () => void
  paletteDisabled: boolean
  onHistory: () => void
  historyDisabled: boolean
  // Pixels currently occupied on the right of the viewport by another surface
  // (the assistant panel). The toolbar is position:fixed, so without this it
  // would dock at the viewport's right edge and slide under the assistant when
  // it opens. Adding the inset keeps the docked toolbar beside the assistant,
  // and a dragged toolbar is clamped so it can never hide behind it either.
  rightInset?: number
}

const EASE_ENTER = [0.34, 1.2, 0.64, 1] as const
const EASE_EXIT  = [0.4, 0, 1, 1] as const

export default function FloatingToolbar({
  actions,
  onAddWidget,
  onImport,
  onBringSynced,
  paletteDisabled,
  onHistory,
  historyDisabled,
  rightInset = 0
}: Props): JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dragData = useRef<{
    startMX: number; startMY: number; startPX: number; startPY: number
  } | null>(null)

  const onMove = useRef((e: MouseEvent): void => {
    if (!dragData.current) return
    setPos({
      x: dragData.current.startPX + (e.clientX - dragData.current.startMX),
      y: dragData.current.startPY + (e.clientY - dragData.current.startMY)
    })
  })

  const onUp = useRef((): void => {
    dragData.current = null
    window.removeEventListener('mousemove', onMove.current)
    window.removeEventListener('mouseup', onUp.current)
  })

  useEffect(() => {
    const move = onMove.current
    const up = onUp.current
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  useEffect(() => () => {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current)
  }, [])

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>): void {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button')) return
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    e.preventDefault()
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    dragData.current = { startMX: e.clientX, startMY: e.clientY, startPX: rect.left, startPY: rect.top }
    window.addEventListener('mousemove', onMove.current)
    window.addEventListener('mouseup', onUp.current)
  }

  function handleMouseEnter(): void {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current)
    setHovered(true)
  }

  function handleMouseLeave(): void {
    leaveTimer.current = setTimeout(() => setHovered(false), 320)
  }

  // Horizontal when dragged near top or bottom edge (generous 200px zone).
  const orient: 'v' | 'h' = useMemo(() => {
    if (!pos) return 'v'
    return (pos.y < 200 || pos.y > window.innerHeight - 200) ? 'h' : 'v'
  }, [pos])

  // Default docks to the right edge, offset by whatever the assistant occupies so
  // it stays visible (and slides as the assistant opens/closes/resizes). A
  // dragged toolbar keeps the user's placement but is clamped left of the
  // assistant so it can never end up hidden behind it.
  const DOCK_MARGIN = 12
  const posStyle: React.CSSProperties = pos
    ? {
        left: Math.min(
          pos.x,
          Math.max(DOCK_MARGIN, window.innerWidth - rightInset - (ref.current?.offsetWidth ?? 220) - DOCK_MARGIN)
        ),
        top: pos.y
      }
    : {
        right: DOCK_MARGIN + rightInset,
        top: '50%',
        transform: 'translateY(-50%)',
        transition: 'right 200ms ease'
      }

  const sharedWrapper = {
    ref,
    onMouseDown: handleMouseDown,
    onMouseEnter: handleMouseEnter,
    onMouseLeave: handleMouseLeave,
    onDoubleClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('button')) return
      setPos(null)
    },
    title: 'Drag to reposition · Double-click to re-center',
    onWheel: (e: React.WheelEvent) => e.stopPropagation(),
    style: posStyle
  }

  if (orient === 'h') {
    // ── Horizontal (near top or bottom) ───────────────────────────────────────
    // Compact icon-only strip — no WidgetPalette, no labels.
    return (
      <div
        {...sharedWrapper}
        data-floating-menu
        data-testid="floating-toolbar"
        className="fixed z-[45] flex flex-row items-stretch fb-glass-chrome rounded-2xl overflow-hidden cursor-grab active:cursor-grabbing shadow-[0_4px_24px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.07] dark:ring-white/[0.07]"
      >
        {/* Header: drag + icon in a single compact row */}
        <div className="flex flex-row items-center gap-0.5 px-1.5 shrink-0 h-9">
          <Icon name="drag_indicator" size={12} className="text-[var(--ink-25,var(--ink-30))] pointer-events-none" />
          <div className="w-7 h-7 inline-flex items-center justify-center rounded-xl text-[var(--ink-50)]">
            <Icon name="construction" size={15} />
          </div>
        </div>

        {/* Expanded: icon-only action buttons — slides in from the right */}
        <AnimatePresence initial={false}>
          {hovered && (
            <motion.div
              key="actions-h"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 'auto', opacity: 1, transition: { duration: 0.2, ease: EASE_ENTER } }}
              exit={{ width: 0, opacity: 0, transition: { duration: 0.15, ease: EASE_EXIT } }}
              className="overflow-hidden flex flex-row items-center"
              data-no-drag
            >
              <div className="w-px self-stretch bg-[var(--edge-soft)] shrink-0" />

              {/* History */}
              <button
                onClick={onHistory}
                disabled={historyDisabled}
                className="h-9 px-2.5 inline-flex items-center gap-1.5 text-[var(--ink-60)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-100)] transition-colors disabled:opacity-40 whitespace-nowrap"
                title="Desk history"
              >
                <Icon name="history" size={14} />
                <span className="text-[12px]">History</span>
              </button>

              <div className="w-px self-stretch bg-[var(--edge-soft)] shrink-0" />

              {/* Action buttons — icon + label */}
              {actions.map((a, i) => (
                <Fragment key={`${a.label}-${i}`}>
                  <button
                    onClick={a.onClick}
                    className="h-9 px-2.5 inline-flex items-center gap-1.5 hover:bg-[var(--surface-sunken)] transition-colors whitespace-nowrap"
                    title={a.shortcut ? `${a.label} (${a.shortcut})` : a.label}
                  >
                    <Icon
                      name={a.icon}
                      size={14}
                      style={a.color ? { color: a.color } : { color: 'var(--ink-50)' }}
                    />
                    <span className="text-[12px] text-[var(--ink-70)]">{a.label}</span>
                    {a.shortcut && (
                      <span className="text-[10px] text-[var(--ink-35)] font-mono">{a.shortcut}</span>
                    )}
                  </button>
                  {a.separatorAfter && <div className="w-px self-stretch bg-[var(--edge-soft)] shrink-0" />}
                </Fragment>
              ))}

              <div className="w-1 shrink-0" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  // ── Vertical (default — right side) ───────────────────────────────────────
  return (
    <div
      {...sharedWrapper}
      data-floating-menu
      data-testid="floating-toolbar"
      className="fixed z-[45] flex flex-col items-stretch fb-glass-chrome rounded-2xl overflow-hidden cursor-grab active:cursor-grabbing shadow-[0_4px_24px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.07] dark:ring-white/[0.07]"
    >
      {/* Header: drag handle + construction icon stacked */}
      <div className="flex flex-col items-center w-10 shrink-0">
        <div className="pt-1.5 pb-0.5 flex items-center justify-center w-full">
          <Icon name="drag_indicator" size={12} className="text-[var(--ink-25,var(--ink-30))] pointer-events-none" />
        </div>
        {/* The add button, not a decorative construction icon. This is the
            only part of the rail that is visible without hovering, so it is
            the part that should carry the primary action. */}
        <div className="mb-1">
          <WidgetPalette
            onAdd={onAddWidget}
            onImport={onImport}
            onBringSynced={onBringSynced}
            disabled={paletteDisabled}
            variant="rail"
          />
        </div>
      </div>

      {/* Expanded: drops down from the header */}
      <AnimatePresence initial={false}>
        {hovered && (
          <motion.div
            key="actions-v"
            initial={{ height: 0, opacity: 0, y: -4 }}
            animate={{ height: 'auto', opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE_ENTER } }}
            exit={{ height: 0, opacity: 0, y: -4, transition: { duration: 0.16, ease: EASE_EXIT } }}
            className="overflow-hidden flex flex-col"
            style={{ width: 178 }}
            data-no-drag
          >
            <div className="mx-2 h-px bg-[var(--edge-soft)] mb-1" />

            {/* The widget palette moved UP into the always-visible header
                (2026-10-09). Keeping a second copy here would mean two add
                buttons, each with its own popover state. */}

            {/* History */}
            <button
              onClick={onHistory}
              disabled={historyDisabled}
              className="mx-1 h-8 inline-flex items-center gap-2 rounded-xl px-2 text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-100)] transition-colors disabled:opacity-40"
              title="Desk history — time-travel through this desk's changes"
            >
              <Icon name="history" size={15} className="shrink-0 text-[var(--ink-60)]" />
              <span className="text-[12px] truncate">History</span>
            </button>

            <div className="mx-2 h-px bg-[var(--edge-soft)] my-1" />

            {/* Action buttons — labeled */}
            {actions.map((a, i) => (
              <Fragment key={`${a.label}-${i}`}>
                <button
                  onClick={a.onClick}
                  className="mx-1 h-8 inline-flex items-center gap-2 rounded-xl px-2 text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-100)] transition-colors"
                  title={a.shortcut ? `${a.label} (${a.shortcut})` : a.label}
                >
                  <Icon
                    name={a.icon}
                    size={15}
                    className="shrink-0"
                    style={a.color ? { color: a.color } : { color: 'var(--ink-50)' }}
                  />
                  <span className="text-[12px] truncate flex-1 min-w-0 text-left">{a.label}</span>
                  {a.shortcut && (
                    <span className="text-[10px] text-[var(--ink-40)] font-mono shrink-0">{a.shortcut}</span>
                  )}
                </button>
                {a.separatorAfter && <div className="mx-2 h-px bg-[var(--edge-soft)] my-1" />}
              </Fragment>
            ))}

            <div className="h-1 shrink-0" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
