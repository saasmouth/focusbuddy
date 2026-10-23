import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '../Icon'
import { useDeskViewStore, type DeskViewMode } from '../../stores/deskView'

// Spec §3.4 — a dedicated Views control that shows a visual PREVIEW per view
// (not a text-only menu), names each one, marks the active one, supports keyboard
// navigation, and lets the user pin a per-desk DEFAULT (§3.3). Previews are inline
// SVG (CSP-safe, theme-aware) rather than image files. Only views that actually
// exist are listed — no "coming soon" placeholders. As real views are added
// (Kanban, Table, Timeline, …) they slot into VIEWS and appear here automatically.

interface ViewDef {
  mode: DeskViewMode
  label: string
  icon: string
  Preview: () => JSX.Element
}

function CanvasPreview(): JSX.Element {
  return (
    <svg viewBox="0 0 80 52" className="w-full h-full" aria-hidden="true">
      <rect x="6" y="8" width="26" height="16" rx="3" className="fill-[var(--surface-sunken)] stroke-[var(--edge-firm)]" strokeWidth="1" />
      <rect x="40" y="6" width="20" height="12" rx="3" className="fill-[var(--surface-sunken)] stroke-[var(--edge-firm)]" strokeWidth="1" />
      <rect x="14" y="30" width="22" height="14" rx="3" className="fill-[var(--surface-sunken)] stroke-[var(--edge-firm)]" strokeWidth="1" />
      <rect x="46" y="26" width="24" height="18" rx="3" className="fill-[rgb(var(--accent))]/20 stroke-[rgb(var(--accent))]" strokeWidth="1" />
    </svg>
  )
}

function ColumnsPreview(): JSX.Element {
  return (
    <svg viewBox="0 0 80 52" className="w-full h-full" aria-hidden="true">
      {[6, 30, 54].map((x, i) => (
        <g key={x}>
          <rect x={x} y="6" width="20" height="40" rx="3" className="fill-[var(--surface-sunken)] stroke-[var(--edge-firm)]" strokeWidth="1" />
          <rect x={x + 3} y="10" width="14" height="7" rx="2" className={i === 2 ? 'fill-[rgb(var(--accent))]/30' : 'fill-[var(--edge-firm)]'} />
          <rect x={x + 3} y="20" width="14" height="7" rx="2" className="fill-[var(--edge-firm)]" />
          {i !== 1 && <rect x={x + 3} y="30" width="14" height="7" rx="2" className="fill-[var(--edge-firm)]" />}
        </g>
      ))}
    </svg>
  )
}

function WorkcentrePreview(): JSX.Element {
  // Tiles of different sizes on one grid, none overlapping: a dashboard.
  return (
    <svg viewBox="0 0 80 52" className="w-full h-full" aria-hidden="true">
      <rect x="6" y="6" width="40" height="22" rx="3" className="fill-[rgb(var(--accent))]/20 stroke-[rgb(var(--accent))]" strokeWidth="1" />
      <rect x="50" y="6" width="24" height="12" rx="3" className="fill-[var(--surface-sunken)] stroke-[var(--edge-firm)]" strokeWidth="1" />
      <rect x="50" y="22" width="24" height="24" rx="3" className="fill-[var(--surface-sunken)] stroke-[var(--edge-firm)]" strokeWidth="1" />
      <rect x="6" y="32" width="18" height="14" rx="3" className="fill-[var(--surface-sunken)] stroke-[var(--edge-firm)]" strokeWidth="1" />
      <rect x="28" y="32" width="18" height="14" rx="3" className="fill-[var(--surface-sunken)] stroke-[var(--edge-firm)]" strokeWidth="1" />
    </svg>
  )
}

function RowsPreview(): JSX.Element {
  return (
    <svg viewBox="0 0 80 52" className="w-full h-full" aria-hidden="true">
      {[8, 20, 32, 44].map((y) => (
        <rect key={y} x="8" y={y} width="64" height="8" rx="2" className="fill-[var(--surface-sunken)] stroke-[var(--edge-firm)]" strokeWidth="1" />
      ))}
    </svg>
  )
}

function TablePreview(): JSX.Element {
  return (
    <svg viewBox="0 0 80 52" className="w-full h-full" aria-hidden="true">
      <rect x="8" y="8" width="64" height="36" rx="2" className="fill-[var(--surface-sunken)] stroke-[var(--edge-firm)]" strokeWidth="1" />
      <line x1="8" y1="18" x2="72" y2="18" className="stroke-[var(--edge-firm)]" strokeWidth="1" />
      <line x1="30" y1="8" x2="30" y2="44" className="stroke-[var(--edge-firm)]" strokeWidth="1" />
      <line x1="50" y1="8" x2="50" y2="44" className="stroke-[var(--edge-firm)]" strokeWidth="1" />
    </svg>
  )
}

function GalleryPreview(): JSX.Element {
  return (
    <svg viewBox="0 0 80 52" className="w-full h-full" aria-hidden="true">
      {[8, 30, 52].map((x) =>
        [8, 28].map((y) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="20" height="16" rx="2" className="fill-[var(--surface-sunken)] stroke-[var(--edge-firm)]" strokeWidth="1" />
        ))
      )}
    </svg>
  )
}

function CompactPreview(): JSX.Element {
  return (
    <svg viewBox="0 0 80 52" className="w-full h-full" aria-hidden="true">
      {[[8, 10, 22], [34, 10, 16], [54, 10, 18], [8, 24, 16], [28, 24, 24], [56, 24, 16], [8, 38, 20], [32, 38, 20]].map(([x, y, w], i) => (
        <rect key={i} x={x} y={y} width={w} height="9" rx="4.5" className="fill-[var(--surface-sunken)] stroke-[var(--edge-firm)]" strokeWidth="1" />
      ))}
    </svg>
  )
}

const VIEWS: ViewDef[] = [
  { mode: 'canvas', label: 'Free canvas', icon: 'dashboard', Preview: CanvasPreview },
  { mode: 'columns', label: 'Columns', icon: 'view_column', Preview: ColumnsPreview },
  { mode: 'workcentre', label: 'Workcentre', icon: 'space_dashboard', Preview: WorkcentrePreview },
  { mode: 'list', label: 'List', icon: 'view_list', Preview: RowsPreview },
  { mode: 'table', label: 'Table', icon: 'table_rows', Preview: TablePreview },
  { mode: 'gallery', label: 'Gallery', icon: 'grid_view', Preview: GalleryPreview },
  { mode: 'compact', label: 'Compact', icon: 'density_small', Preview: CompactPreview }
]

export default function ViewSelector({ taskId }: { taskId: string }): JSX.Element {
  const modes = useDeskViewStore((s) => s.modes)
  const defaults = useDeskViewStore((s) => s.defaults)
  const setMode = useDeskViewStore((s) => s.set)
  const setDefault = useDeskViewStore((s) => s.setDefault)
  const active: DeskViewMode = modes[taskId] ?? defaults[taskId] ?? 'canvas'
  const current = VIEWS.find((v) => v.mode === active) ?? VIEWS[0]

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // The menu is PORTALED to document.body so it escapes the desk-view overlay's
  // stacking context (z-60) and can sit above the floating assistant (z-120);
  // otherwise its items are unclickable behind the assistant. Position is measured
  // from the trigger and clamped into the viewport.
  function openMenu(): void {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 268)) })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      const t = e.target as Node
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Arrow-key navigation across the option cards (spec §3.4 keyboard support).
  function onMenuKey(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const idx = VIEWS.findIndex((v) => v.mode === active)
    const next = e.key === 'ArrowRight' ? (idx + 1) % VIEWS.length : (idx - 1 + VIEWS.length) % VIEWS.length
    setMode(taskId, VIEWS[next].mode)
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={btnRef}
        onClick={() => (open ? setOpen(false) : openMenu())}
        data-testid="view-selector-btn"
        title="Change how this desk is shown"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[var(--ink-50)] hover:text-[rgb(var(--accent))] hover:bg-[var(--surface-sunken)] transition-colors shrink-0 whitespace-nowrap"
      >
        <Icon name={current.icon} size={12} />
        <span className="text-[11px] font-medium">{current.label}</span>
        <Icon name="expand_more" size={12} className="text-[var(--ink-40)]" />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          data-testid="view-selector-menu"
          onKeyDown={onMenuKey}
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
          /* Portaled to body + z above the floating assistant (z-120) so items are
             always clickable, below dialogs/command-center. */
          className="fb-card z-[130] w-[260px] p-2"
        >
          <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--ink-50)] font-semibold px-1 pb-1.5">
            Views
          </div>
          <div className="grid grid-cols-2 gap-2">
            {VIEWS.map((v) => {
              const isActive = v.mode === active
              const isDefault = defaults[taskId] === v.mode
              return (
                <div key={v.mode} className="relative">
                  <button
                    onClick={() => {
                      setMode(taskId, v.mode)
                      setOpen(false)
                    }}
                    data-testid={`view-opt-${v.mode}`}
                    title={v.label}
                    className={`w-full rounded-lg border p-1.5 text-left transition-colors ${
                      isActive
                        ? 'border-accent bg-accent/10'
                        : 'border-[var(--edge-soft)] hover:bg-[var(--surface-sunken)]'
                    }`}
                  >
                    <div className="h-[52px] w-full rounded-md overflow-hidden bg-[var(--surface-sunken)]">
                      <v.Preview />
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      {isActive && <Icon name="check" size={12} className="text-accent" />}
                      <span className="text-[11.5px] text-[var(--ink-90)]">{v.label}</span>
                    </div>
                  </button>
                  {/* Pin this view as the desk's default (§3.3). */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setDefault(taskId, v.mode)
                    }}
                    data-testid={`view-default-${v.mode}`}
                    title={isDefault ? 'Default view for this desk' : 'Set as default view for this desk'}
                    className="absolute top-2 right-2 h-6 w-6 inline-flex items-center justify-center rounded-md bg-[var(--surface-raised)] text-[var(--ink-40)] hover:text-amber-500"
                  >
                    <Icon name={isDefault ? 'star' : 'star_border'} size={14} className={isDefault ? 'text-amber-500' : ''} />
                  </button>
                </div>
              )
            })}
          </div>
          <div className="mt-1.5 px-1 text-[10.5px] text-[var(--ink-40)]">
            The star pins a default view for this desk.
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
