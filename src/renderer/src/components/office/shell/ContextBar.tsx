import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode } from 'react'
import Icon from '../../Icon'
import { BarContext } from './primitives'
import { planRow1 } from './layout'

// The office ContextBar (spec §2.3): Row 1 = the app's existing menu bar plus
// the tab strip (one row, Office-style); Row 2 = the active tab's controls with
// Undo/Redo pinned left and a right slot. Contextual tabs come and go with the
// selection (they never steal focus; a vanished active tab falls back to Home).
// Row 1 folds for narrow/embedded editors: menus into "≡", then trailing tabs
// into "More" (spec §2.6). Keys are handled only on the bar's own elements.

export interface BarTab<C> {
  id: string
  label: string
  when?: (c: C) => boolean
  contextual?: boolean
  render: (c: C) => ReactNode
}

export interface ContextBarHandle {
  focusBar: () => void
}

export interface ContextBarProps<C> {
  tabs: BarTab<C>[]
  ctx: C
  activeTab: string
  onTabChange: (id: string) => void
  collapsed?: boolean
  onCollapsedChange?: (v: boolean) => void
  pinnedStart?: ReactNode
  rightSlot?: ReactNode
  menuBar: ReactNode
  readOnly?: boolean
  barRef?: MutableRefObject<ContextBarHandle | null>
  testid: string
}

/** Tabs visible for this context. Pure, for tests. */
export function visibleTabs<C>(tabs: BarTab<C>[], ctx: C): BarTab<C>[] {
  return tabs.filter((t) => !t.when || t.when(ctx))
}

/** The tab that should be active: the requested one if visible, else Home, else the first. Pure. */
export function resolveActiveTab<C>(tabs: BarTab<C>[], ctx: C, requested: string): string {
  const vis = visibleTabs(tabs, ctx)
  if (vis.some((t) => t.id === requested)) return requested
  return vis.find((t) => t.id === 'home')?.id ?? vis[0]?.id ?? requested
}

const CHROME = 48 // divider + collapse chevron + paddings

export default function ContextBar<C>({ tabs, ctx, activeTab, onTabChange, collapsed = false, onCollapsedChange, pinnedStart, rightSlot, menuBar, readOnly = false, barRef, testid }: ContextBarProps<C>): JSX.Element {
  const vis = useMemo(() => visibleTabs(tabs, ctx), [tabs, ctx])
  const active = resolveActiveTab(tabs, ctx, activeTab)

  // A contextual tab that disappeared while active falls back (D3: no auto-switch the other way).
  useEffect(() => {
    if (active !== activeTab) onTabChange(active)
  }, [active, activeTab, onTabChange])

  // ── Row 1 folding ──────────────────────────────────────────────────────
  const row1 = useRef<HTMLDivElement>(null)
  const menuLive = useRef<HTMLDivElement>(null)
  const tabMeasure = useRef<Record<string, HTMLButtonElement | null>>({})
  const [widths, setWidths] = useState<{ menu: number; tabs: Record<string, number> }>({ menu: 0, tabs: {} })
  const [available, setAvailable] = useState<number>(Infinity)
  const [menuOpen, setMenuOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)

  const tabKey = vis.map((t) => `${t.id}:${t.label}`).join('|')
  useLayoutEffect(() => {
    // Tab natural widths come from a hidden copy of the LABELS only (no ids,
    // no handlers). The menu bar is never duplicated: its natural width is
    // measured live while unfolded (it starts unfolded) and remembered.
    const tabsW: Record<string, number> = {}
    for (const t of vis) tabsW[t.id] = tabMeasure.current[t.id]?.offsetWidth ?? 0
    setWidths((w) => ({ menu: menuLive.current?.scrollWidth || w.menu, tabs: tabsW }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey])
  useEffect(() => {
    const el = row1.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => setAvailable(entries[0]!.contentRect.width))
    ro.observe(el)
    setAvailable(el.clientWidth || Infinity)
    return () => ro.disconnect()
  }, [])
  const plan = useMemo(
    () =>
      planRow1({
        available,
        menuWidth: widths.menu,
        chrome: CHROME,
        tabs: vis.map((t) => ({ id: t.id, width: widths.tabs[t.id] ?? 0, keep: t.id === active || !!t.contextual }))
      }),
    [available, widths, vis, active]
  )
  const shownTabs = vis.filter((t) => !plan.folded.includes(t.id))
  const foldedTabs = vis.filter((t) => plan.folded.includes(t.id))

  // ── Tabs keyboard (only while a tab is focused) ────────────────────────
  const tabEls = useRef<Record<string, HTMLButtonElement | null>>({})
  const row2 = useRef<HTMLDivElement>(null)
  const onTabKey = (e: ReactKeyboardEvent, idx: number): void => {
    const list = shownTabs
    let to = -1
    if (e.key === 'ArrowRight') to = (idx + 1) % list.length
    else if (e.key === 'ArrowLeft') to = (idx - 1 + list.length) % list.length
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = list.length - 1
    else if (e.key === 'ArrowDown' && !collapsed) {
      e.preventDefault()
      row2.current?.querySelector<HTMLElement>('button:not([disabled]),select,input')?.focus()
      return
    }
    if (to < 0) return
    e.preventDefault()
    const t = list[to]!
    onTabChange(t.id)
    tabEls.current[t.id]?.focus()
  }

  const focusBar = useCallback(() => {
    tabEls.current[active]?.focus()
  }, [active])
  useEffect(() => {
    if (barRef) barRef.current = { focusBar }
  }, [barRef, focusBar])

  // ── Row 2 roving + overflow chevrons ───────────────────────────────────
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)
  const syncScroll = useCallback(() => {
    const el = row2.current
    if (!el) return
    setCanLeft(el.scrollLeft > 1)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])
  useEffect(() => {
    const el = row2.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(syncScroll)
    ro.observe(el)
    return () => ro.disconnect()
  }, [syncScroll, collapsed])
  useEffect(syncScroll, [syncScroll, active, ctx])
  const onRow2Key = (e: ReactKeyboardEvent): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return // fields keep their arrows
    const items = [...(row2.current?.querySelectorAll<HTMLElement>('button:not([disabled]),select:not([disabled]),input:not([disabled])') ?? [])]
    const i = items.indexOf(target)
    if (i < 0) return
    e.preventDefault()
    items[(i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]?.focus()
  }

  const activeTabDef = vis.find((t) => t.id === active)
  const tabBtn = (t: BarTab<C>, i: number, inMore = false): JSX.Element => (
    <button
      key={t.id}
      ref={inMore ? undefined : (el) => (tabEls.current[t.id] = el)}
      type="button"
      role={inMore ? 'menuitem' : 'tab'}
      aria-selected={inMore ? undefined : t.id === active}
      tabIndex={inMore ? 0 : t.id === active ? 0 : -1}
      data-testid={`${testid}-tab-${t.id}`}
      data-contextual={t.contextual ? 'true' : undefined}
      onClick={() => {
        onTabChange(t.id)
        setMoreOpen(false)
        if (collapsed && t.id !== active) onCollapsedChange?.(false)
      }}
      onDoubleClick={() => t.id === active && onCollapsedChange?.(!collapsed)}
      onKeyDown={inMore ? undefined : (e) => onTabKey(e, i)}
      className={
        inMore
          ? 'w-full text-left px-2.5 py-1 text-[12px] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]'
          : `relative shrink-0 h-7 px-2.5 text-[12px] rounded-t transition-colors ${
              t.id === active ? 'text-[var(--ink-90)] font-semibold' : 'text-[var(--ink-60)] hover:text-[var(--ink-90)]'
            } ${t.contextual ? 'text-accent' : ''}`
      }
    >
      {t.contextual && !inMore && <span aria-hidden className="absolute top-1 right-1 w-1 h-1 rounded-full bg-accent" />}
      {t.label}
      {t.id === active && !inMore && <span aria-hidden className="absolute left-2 right-2 -bottom-px h-0.5 rounded bg-accent" />}
    </button>
  )

  return (
    <BarContext.Provider value={{ readOnly }}>
      <div data-testid={testid} className="shrink-0 border-b border-[var(--edge-soft)] bg-[var(--surface-raised)]">
        {/* Hidden measuring copy of the tab labels (natural widths for Row 1 folding). */}
        <div aria-hidden className="absolute -left-[9999px] top-0 flex invisible pointer-events-none" style={{ height: 0, overflow: 'hidden' }}>
          {vis.map((t) => (
            <button key={t.id} ref={(el) => (tabMeasure.current[t.id] = el)} tabIndex={-1} className="shrink-0 h-7 px-2.5 text-[12px] font-semibold">
              {t.label}
            </button>
          ))}
        </div>

        {/* Row 1: menus + tabs */}
        <div ref={row1} className="flex items-end gap-1 px-2 pt-1 min-w-0">
          {plan.foldMenus ? (
            <div className="relative shrink-0 self-center">
              <button
                type="button"
                aria-label="Menus"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                data-testid={`${testid}-menus`}
                onClick={() => setMenuOpen((v) => !v)}
                className="icon-btn !h-7 !w-7"
              >
                <Icon name="menu" size={17} />
              </button>
              {menuOpen && (
                <div className="absolute top-full left-0 mt-1 z-50 fb-glass-panel rounded-[var(--radius-row)] p-1 fb-pop-in" onKeyDown={(e) => e.key === 'Escape' && setMenuOpen(false)}>
                  {menuBar}
                </div>
              )}
            </div>
          ) : (
            <div ref={menuLive} className="shrink-0 self-center">{menuBar}</div>
          )}
          <span aria-hidden className="shrink-0 self-center w-px h-4 mx-1 bg-[var(--edge-soft)]" />
          <div role="tablist" aria-label="Ribbon tabs" className="flex items-end min-w-0">
            {shownTabs.map((t, i) => tabBtn(t, i))}
            {foldedTabs.length > 0 && (
              <div className="relative shrink-0">
                <button type="button" aria-haspopup="menu" aria-expanded={moreOpen} data-testid={`${testid}-tab-more`} onClick={() => setMoreOpen((v) => !v)} className="h-7 px-2.5 text-[12px] text-[var(--ink-60)] hover:text-[var(--ink-90)] inline-flex items-center gap-0.5">
                  More <Icon name="expand_more" size={14} />
                </button>
                {moreOpen && (
                  <div role="menu" className="absolute top-full right-0 mt-1 z-50 fb-glass-panel rounded-[var(--radius-row)] py-1 min-w-[160px] fb-pop-in" onKeyDown={(e) => e.key === 'Escape' && setMoreOpen(false)}>
                    {foldedTabs.map((t, i) => tabBtn(t, i, true))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="flex-1" />
          <button
            type="button"
            aria-label={collapsed ? 'Show the ribbon' : 'Hide the ribbon'}
            aria-expanded={!collapsed}
            data-testid={`${testid}-collapse`}
            onClick={() => onCollapsedChange?.(!collapsed)}
            className="icon-btn !h-6 !w-6 self-center shrink-0"
          >
            <Icon name={collapsed ? 'expand_more' : 'expand_less'} size={16} />
          </button>
        </div>

        {/* Row 2: pinned start · active tab controls (scrolls, never hides) · right slot */}
        {!collapsed && (
          <div role="tabpanel" aria-label={activeTabDef?.label} data-testid={`${testid}-panel`} className="flex items-center gap-1 px-2 h-9 min-w-0">
            {pinnedStart && (
              <>
                <div className="shrink-0 inline-flex items-center gap-0.5">{pinnedStart}</div>
                <span aria-hidden className="shrink-0 w-px h-5 mx-1 bg-[var(--edge-soft)]" />
              </>
            )}
            {canLeft && (
              <button type="button" aria-label="Scroll left" onClick={() => row2.current?.scrollBy({ left: -200, behavior: 'smooth' })} className="icon-btn !h-6 !w-6 shrink-0">
                <Icon name="chevron_left" size={16} />
              </button>
            )}
            <div
              ref={row2}
              role="toolbar"
              aria-label={`${activeTabDef?.label ?? ''} controls`}
              onScroll={syncScroll}
              onKeyDown={onRow2Key}
              className="flex-1 min-w-0 flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              style={{
                maskImage: `linear-gradient(to right, ${canLeft ? 'transparent' : '#000'} 0, #000 16px, #000 calc(100% - 16px), ${canRight ? 'transparent' : '#000'} 100%)`
              }}
            >
              {activeTabDef?.render(ctx)}
            </div>
            {canRight && (
              <button type="button" aria-label="Scroll right" onClick={() => row2.current?.scrollBy({ left: 200, behavior: 'smooth' })} className="icon-btn !h-6 !w-6 shrink-0">
                <Icon name="chevron_right" size={16} />
              </button>
            )}
            {rightSlot && <div className="shrink-0 inline-flex items-center gap-0.5 pl-1">{rightSlot}</div>}
          </div>
        )}
      </div>
    </BarContext.Provider>
  )
}
