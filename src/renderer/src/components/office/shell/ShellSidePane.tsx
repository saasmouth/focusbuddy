import { useEffect, useRef, type ReactNode } from 'react'
import Icon from '../../Icon'
import { useShellSize } from './OfficeShellLayout'
import { SIDE_PANE_DOM_ID, SIDE_PANE_WIDTH } from './layout'

// The ONE right-hand content pane every office app shares (owner amendment to
// D1, SPEC §2.5a): panes you READ and TYPE in (comments, outline, the AI
// assistant), not property inspectors (those are ContextBar tabs) and not tool
// panels (those are ShellPanel overlays). One pane at a time with a switcher;
// collapses to a slim edge tab; below the narrow breakpoint it opens as a sheet
// over the canvas (never over the rail or the bar). The host owns which pane is
// open (and persists it per app). No global key listener: Esc inside a sheet
// closes it.

export interface SidePane {
  id: string
  title: string
  icon: string
  render: () => ReactNode
  badge?: string // e.g. an unread count
  testid?: string // the pane CONTENT keeps its existing testid (doc-comments-tab, sheet-ai-panel…)
  tabTestid?: string // its switcher tab keeps an existing id (doc-tab-comments); default `${testid}-tab-${id}`
}

export interface ShellSidePaneProps {
  panes: SidePane[]
  activeId: string | null // null = collapsed to the edge tab
  onChange: (id: string | null) => void
  width?: number
  /** The pane root (doc-side-panel, slides-side-panel). Also prefixes -expand, -collapse, -edge, -open-<id>, -tab-<id>. */
  testid: string
  collapseTestid?: string // keep an existing collapse id (sheet-ai-collapse); default `${testid}-collapse`
}

export default function ShellSidePane({ panes, activeId, onChange, width = SIDE_PANE_WIDTH, testid, collapseTestid }: ShellSidePaneProps): JSX.Element | null {
  const { sheetPanels, pillCorner, raise } = useShellSize()
  const active = panes.find((p) => p.id === activeId) ?? null
  // The edge's expand chevron brings back the pane you last had open.
  const last = useRef<string | null>(null)
  useEffect(() => {
    if (active) last.current = active.id
  }, [active])
  // Opening (or switching) a pane brings the side pane to the front over any sheet panel.
  const activeKey = active?.id ?? null
  useEffect(() => {
    if (activeKey) raise('side')
  }, [activeKey, raise])
  if (!panes.length) return null

  // Collapsed: a slim edge tab with one button per pane.
  if (!active) {
    return (
      <div
        id={SIDE_PANE_DOM_ID}
        role="tablist"
        aria-orientation="vertical"
        aria-label="Side panes"
        data-testid={`${testid}-edge`}
        className="shrink-0 w-7 h-full flex flex-col items-center gap-1 py-1.5 border-l border-[var(--edge-soft)] bg-[var(--surface-raised)]"
      >
        <button
          type="button"
          aria-label="Show the side pane"
          title="Show the side pane"
          data-testid={`${testid}-expand`}
          onClick={() => onChange(panes.some((p) => p.id === last.current) ? last.current : panes[0]!.id)}
          className="w-6 h-6 rounded inline-flex items-center justify-center text-[var(--ink-60)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]"
        >
          <Icon name="chevron_left" size={15} />
        </button>
        <span aria-hidden className="w-4 h-px bg-[var(--edge-soft)]" />
        {panes.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={false}
            aria-label={`Open ${p.title}`}
            title={p.title}
            data-testid={`${testid}-open-${p.id}`}
            onClick={() => onChange(p.id)}
            className="relative w-6 h-6 rounded inline-flex items-center justify-center text-[var(--ink-60)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]"
          >
            <Icon name={p.icon} size={15} />
            {p.badge && <span aria-hidden className="absolute -top-0.5 -right-0.5 min-w-[12px] h-3 px-0.5 rounded-full bg-accent text-white text-[8px] leading-3 text-center">{p.badge}</span>}
          </button>
        ))}
      </div>
    )
  }

  return (
    <aside
      id={SIDE_PANE_DOM_ID}
      aria-label={active.title}
      data-testid={testid}
      data-pane={active.id}
      data-sheet={sheetPanels ? 'true' : undefined}
      onKeyDown={(e) => {
        if (sheetPanels && e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onChange(null)
        }
      }}
      className={`h-full flex flex-col min-h-0 bg-[var(--surface-raised)] border-l border-[var(--edge-soft)] ${
        sheetPanels ? 'absolute top-0 bottom-0 right-0 z-40 shadow-lg' : 'shrink-0'
      }`}
      style={sheetPanels ? { width: 'calc(100% - 40px)' } : { width }}
    >
      <header className="shrink-0 flex items-center gap-1 px-1.5 h-9 border-b border-[var(--edge-soft)] min-w-0">
        {panes.length > 1 ? (
          <div role="tablist" aria-label="Side panes" className="flex items-center gap-0.5 min-w-0 overflow-x-auto [scrollbar-width:none]">
            {panes.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === active.id}
                data-testid={p.tabTestid ?? `${testid}-tab-${p.id}`}
                onClick={() => onChange(p.id)}
                className={`relative shrink-0 h-7 px-2 rounded text-[12px] inline-flex items-center gap-1 ${
                  p.id === active.id ? 'bg-accent/15 text-accent font-semibold' : 'text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                <Icon name={p.icon} size={14} />
                {p.title}
                {p.badge && <span className="ml-0.5 text-[10px] text-[var(--ink-50)]">{p.badge}</span>}
              </button>
            ))}
          </div>
        ) : (
          <span className="flex-1 min-w-0 px-1 text-[12px] font-semibold text-[var(--ink-90)] truncate inline-flex items-center gap-1.5">
            <Icon name={active.icon} size={14} />
            {active.title}
          </span>
        )}
        <span className="flex-1" />
        <button type="button" aria-label="Collapse the side pane" data-testid={collapseTestid ?? `${testid}-collapse`}
          data-shell-role="sidepane-collapse" onClick={() => onChange(null)} className="icon-btn !h-6 !w-6 shrink-0">
          <Icon name="right_panel_close" size={15} />
        </button>
      </header>
      <div
        role="tabpanel"
        aria-label={active.title}
        data-testid={active.testid}
        className="flex-1 min-h-0 overflow-auto"
        data-pill-clear={pillCorner || undefined}
        style={pillCorner ? { paddingBottom: 'var(--fb-corner-stack-bottom, 0px)' } : undefined}
      >
        {active.render()}
      </div>
    </aside>
  )
}
