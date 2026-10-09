import { useMemo } from 'react'
import type { Widget } from '@shared/types'
import Icon from './Icon'

// Every item on the desk, newest-touched first, each one a camera shortcut.
//
// The minimap shows you WHERE things are but not WHAT they are: at 160×100 a
// widget is a grey rectangle, so finding "the sheet I was in ten minutes ago"
// means recognising its shape. This list answers the question the minimap
// cannot — it names each item and puts the one you touched last at the top,
// which is almost always the one you are going back to.
//
// Sorted by updatedAt descending. That is the field the store already bumps on
// every edit, move and resize, so "last touched" needs no new bookkeeping and
// cannot drift from what actually happened.

/** Humanised fallback when a widget has no title of its own. */
function kindLabel(kind: string): string {
  const special: Record<string, string> = {
    webview: 'Browser',
    gdoc: 'Google Doc',
    gsheet: 'Google Sheet',
    gslide: 'Google Slides',
    pdf: 'PDF',
    'task-list': 'Tasks',
    'stat-card': 'Stat',
    'location-map': 'Map',
    mindmap: 'Mind map'
  }
  if (special[kind]) return special[kind]
  const words = kind.replace(/[-_]/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const ICON: Record<string, string> = {
  note: 'sticky_note_2',
  sticky: 'sticky_note_2',
  doc: 'description',
  page: 'description',
  sheet: 'table_chart',
  table: 'table_chart',
  slides: 'slideshow',
  webview: 'public',
  pdf: 'picture_as_pdf',
  file: 'draft',
  gallery: 'image',
  chart: 'bar_chart',
  metrics: 'monitoring',
  'stat-card': 'monitoring',
  calculator: 'calculate',
  calendar: 'calendar_month',
  contacts: 'contacts',
  'task-list': 'checklist',
  timer: 'timer',
  'location-map': 'map',
  mindmap: 'account_tree',
  scratchpad: 'edit_note',
  markdown: 'notes',
  card: 'cards',
  inbox: 'inbox',
  section: 'select_all'
}

/** "now", "4m", "2h", "3d" — short enough to sit at the end of a row. */
export function sinceLabel(then: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - then) / 1000))
  if (s < 45) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${Math.max(1, m)}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d`
  return `${Math.floor(d / 7)}w`
}

/**
 * Order the desk's items for the jump list: most recently touched first.
 *
 * The minimap itself is excluded — jumping the camera to the thing you are
 * pointing at is not a shortcut — and so is anything archived. Pinned widgets
 * stay IN, unlike the minimap's own `visible` set: a pinned widget is fixed to
 * the screen rather than the canvas, so it has no position to fly to, but it
 * is still an item on the desk and leaving it out would make the list look
 * like it had lost something.
 */
export function jumpTargets(widgets: Widget[]): Widget[] {
  return widgets
    .filter((w) => !w.archived && w.kind !== 'minimap')
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export default function DeskJumpList({
  widgets,
  onJump
}: {
  widgets: Widget[]
  /** Centre the camera on this widget. Pinned widgets report false. */
  onJump: (w: Widget) => void
}): JSX.Element | null {
  const items = useMemo(() => jumpTargets(widgets), [widgets])
  if (items.length === 0) return null

  return (
    <div
      data-testid="desk-jump-list"
      className="w-[216px] max-h-[260px] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--edge-firm)] bg-[var(--surface-raised)] p-1"
      style={{ boxShadow: 'var(--shadow-cast)' }}
      role="menu"
      aria-label="Jump to an item on this desk"
    >
      <div className="px-1.5 pt-1 pb-1 fb-t-caption uppercase tracking-[0.06em] text-[var(--ink-40)] select-none">
        Jump to · last touched
      </div>
      {items.map((w) => (
        <button
          key={w.id}
          type="button"
          role="menuitem"
          onClick={() => onJump(w)}
          data-testid={`desk-jump-${w.id}`}
          title={`${w.title || kindLabel(w.kind)} — ${w.pinned ? 'pinned to the screen' : 'centre the camera here'}`}
          className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-[var(--radius-chip)] text-left text-[11.5px] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]"
        >
          <Icon
            name={ICON[w.kind] ?? 'widgets'}
            size={13}
            className="shrink-0 text-[var(--ink-50)]"
          />
          <span className="flex-1 min-w-0 truncate">{w.title || kindLabel(w.kind)}</span>
          {w.pinned && (
            <Icon name="push_pin" size={11} className="shrink-0 text-[var(--ink-40)]" />
          )}
          <span className="shrink-0 text-[10px] tabular-nums text-[var(--ink-40)]">
            {sinceLabel(w.updatedAt ?? 0)}
          </span>
        </button>
      ))}
    </div>
  )
}
