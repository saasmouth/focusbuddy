import { useEffect, useMemo, useState } from 'react'
import type { Widget } from '@shared/types'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import Icon from '../Icon'

interface Props {
  taskIds: Set<string>
}

// Recent Notes card — surfaces the most recently updated note-like
// widgets across the workspace (sticky / note / markdown / page kinds).
// Pulls widgets from the same IPC the canvas uses, ranks by updatedAt,
// caps at six entries. Clicking jumps to the host task with the widget
// focused.
//
// Why a dedicated card: the 2.0 mockup shows a "Recent Notes" surface
// that's distinct from "Recent Activity". Activity is event-shaped
// (created widget X, opened browser Y); Notes is content-shaped (what
// did I write recently?). For a workspace where the user thinks in pages
// and sticky notes, this card is the "show me my recent writing" lens.
const NOTE_KINDS = new Set(['sticky', 'note', 'markdown', 'page'])

function relativeAge(ts: number): string {
  const diffMs = Date.now() - ts
  if (diffMs < 60_000) return 'just now'
  const m = Math.round(diffMs / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

function summarise(w: Widget): string {
  // Strip HTML and produce a one-line summary for sticky/note/markdown/page.
  const raw = (w.content || '').toString()
  const text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 80 ? text.slice(0, 78).trimEnd() + '…' : text
}

export default function RecentNotesCard({ taskIds }: Props): JSX.Element {
  const setActiveTask = useNodeStore((s) => s.setActive)
  const goTask = useViewStore((s) => s.goTask)
  const [widgets, setWidgets] = useState<Widget[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // The widget store only carries the active task's widgets. For a
      // dashboard surface we want widgets across ALL tasks in scope. The
      // simplest path is to fetch each task's widgets and merge — this
      // could be replaced by a dedicated `widgets:recent` IPC later.
      const all: Widget[] = []
      const ids = Array.from(taskIds).slice(0, 60) // cap fan-out
      const results = await Promise.all(
        ids.map((id) => window.api.widgets.listByTask(id).catch(() => [] as Widget[]))
      )
      for (const r of results) all.push(...r)
      if (!cancelled) {
        setWidgets(all)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [taskIds])

  const noteWidgets = useMemo(
    () =>
      widgets
        .filter((w) => !w.archived && NOTE_KINDS.has(w.kind))
        .filter((w) => {
          const summary = summarise(w)
          return summary.length > 0 || (w.title && w.title.length > 0)
        })
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, 6),
    [widgets]
  )

  function jumpTo(w: Widget): void {
    setActiveTask(w.taskId)
    goTask(w.taskId)
  }

  return (
    <div className="fb-card p-4 fb-glass-soft">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-semibold">
          <Icon name="sticky_note_2" size={12} />
          <span>Recent Notes</span>
        </div>
        <span className="text-[10px] text-[var(--ink-40)] tabular-nums">
          {noteWidgets.length === 0 ? '' : `${noteWidgets.length}`}
        </span>
      </div>
      {loading ? (
        <div className="text-center py-6 text-[11px] text-[var(--ink-50)]">
          Loading notes…
        </div>
      ) : noteWidgets.length === 0 ? (
        <div className="text-center py-6 text-[11px] text-[var(--ink-50)]">
          No notes yet. Drop a sticky or page work widget on any task to start.
        </div>
      ) : (
        <div className="space-y-1.5">
          {noteWidgets.map((w) => {
            const summary = summarise(w)
            return (
              <button
                key={w.id}
                onClick={() => jumpTo(w)}
                className="w-full flex items-start gap-2 p-2 rounded-md hover:bg-[var(--surface-sunken)] text-left transition-colors"
                title={summary}
              >
                <Icon
                  name={
                    w.kind === 'sticky'
                      ? 'sticky_note_2'
                      : w.kind === 'markdown'
                        ? 'description'
                        : w.kind === 'page'
                          ? 'article'
                          : 'edit_note'
                  }
                  size={13}
                  className="text-[var(--ink-40)] mt-0.5 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium text-[var(--ink-90)] truncate">
                    {w.title || summary.slice(0, 32) || 'Untitled note'}
                  </div>
                  {summary && w.title && (
                    <div className="text-[10px] text-[var(--ink-50)] truncate">
                      {summary}
                    </div>
                  )}
                </div>
                <div className="text-[9px] text-[var(--ink-40)] font-mono shrink-0">
                  {relativeAge(w.updatedAt ?? 0)}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
