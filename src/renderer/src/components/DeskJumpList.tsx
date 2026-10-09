import { useEffect, useMemo, useRef, useState } from 'react'
import type { Widget } from '@shared/types'
import { useWidgetStore } from '../stores/widgets'
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
  onJump,
  onEditingChange
}: {
  widgets: Widget[]
  /** Centre the camera on this widget. Pinned widgets report false. */
  onJump: (w: Widget) => void
  /**
   * Raised while a name is being edited.
   *
   * The list is held open by hovering the minimap, so without this the pointer
   * drifting off it mid-rename would unmount the input and lose what was
   * typed. The FAB suppresses its close timer while this is true.
   */
  onEditingChange?: (editing: boolean) => void
}): JSX.Element | null {
  const items = useMemo(() => jumpTargets(widgets), [widgets])
  const update = useWidgetStore((st) => st.update)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    onEditingChange?.(editingId !== null)
  }, [editingId, onEditingChange])

  useEffect(() => {
    if (editingId !== null) inputRef.current?.select()
  }, [editingId])

  function beginRename(w: Widget): void {
    setDraft(w.title ?? '')
    setEditingId(w.id)
  }

  function commitRename(w: Widget): void {
    const next = draft.trim()
    // An unchanged name writes nothing, so renaming is not a spurious "touch"
    // that reorders this very list under the user's pointer.
    if (next !== (w.title ?? '')) void update(w.id, { title: next })
    setEditingId(null)
  }

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
      {items.map((w) =>
        editingId === w.id ? (
          // Renaming in place. A div, not the button: an input inside a button
          // swallows its own clicks and keystrokes.
          <div
            key={w.id}
            data-testid={`desk-jump-edit-${w.id}`}
            className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded-[var(--radius-chip)] bg-[var(--surface-sunken)]"
          >
            <Icon
              name={ICON[w.kind] ?? 'widgets'}
              size={13}
              className="shrink-0 text-accent"
            />
            <input
              ref={inputRef}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Stop here: the desk binds single-key quick-add shortcuts, so
                // typing a name must not also drop a sticky on the canvas.
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitRename(w)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditingId(null)
                }
              }}
              onBlur={() => commitRename(w)}
              placeholder={kindLabel(w.kind)}
              aria-label={`Rename ${w.title || kindLabel(w.kind)}`}
              className="flex-1 min-w-0 bg-transparent text-[11.5px] text-[var(--ink-100)] placeholder:text-[var(--ink-40)] outline-none"
            />
          </div>
        ) : (
          <button
            key={w.id}
            type="button"
            role="menuitem"
            onClick={() => onJump(w)}
            onDoubleClick={(e) => {
              e.preventDefault()
              beginRename(w)
            }}
            onContextMenu={(e) => {
              // Right-click renames rather than opening the canvas menu.
              e.preventDefault()
              e.stopPropagation()
              beginRename(w)
            }}
            data-testid={`desk-jump-${w.id}`}
            title={`${w.title || kindLabel(w.kind)} — ${w.pinned ? 'pinned to the screen' : 'click to centre the camera here'}; double-click or right-click to rename`}
            className="group w-full flex items-center gap-1.5 px-1.5 py-1 rounded-[var(--radius-chip)] text-left text-[11.5px] text-[var(--ink-80)] cursor-pointer transition-colors hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-100)]"
          >
            <Icon
              name={ICON[w.kind] ?? 'widgets'}
              size={13}
              className="shrink-0 text-[var(--ink-50)] transition-colors group-hover:text-accent"
            />
            <span className="flex-1 min-w-0 truncate">{w.title || kindLabel(w.kind)}</span>
            {w.pinned && (
              <Icon name="push_pin" size={11} className="shrink-0 text-[var(--ink-40)]" />
            )}
            <span className="shrink-0 text-[10px] tabular-nums text-[var(--ink-40)]">
              {sinceLabel(w.updatedAt ?? 0)}
            </span>
            {/* Appears only on hover, so the row stays quiet at rest while
                still advertising that the name is editable. */}
            <Icon
              name="edit"
              size={10}
              className="shrink-0 text-[var(--ink-40)] opacity-0 transition-opacity group-hover:opacity-100"
            />
          </button>
        )
      )}
    </div>
  )
}
