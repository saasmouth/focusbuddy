import { useEffect, useMemo, useState } from 'react'
import type { FbNode, Widget } from '@shared/types'
import { useNodeStore } from '../stores/nodes'
import { requestNewDesk } from '../lib/newDesk'
import { useViewStore } from '../stores/view'
import DeskMiniature from './DeskMiniature'
import Icon from './Icon'
import CanvasContextMenu from './CanvasContextMenu'
import { deskLifecycleMenuItems } from '../lib/deskLifecycleMenu'
import { DashboardHeader, PLEXI_CARD } from './plexi'

// Shown when no desk is open (Canvas has no active node). A "desk" is a canvas —
// the same thing under one name — so rather than a dead-end "your desk is clear"
// message, this presents every desk in the current organisation as a live
// thumbnail you can open. Top-level nodes are the desks (folders and standalone
// canvases); their widget previews come from a per-desk widget fetch.
export default function DeskGallery(): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const nodesLoaded = useNodeStore((s) => s.loaded)
  const setActive = useNodeStore((s) => s.setActive)
  const goProject = useViewStore((s) => s.goProject)
  const goTask = useViewStore((s) => s.goTask)
  const [widgetsByDesk, setWidgetsByDesk] = useState<Record<string, Widget[]>>({})
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; desk: FbNode } | null>(null)

  const desks = useMemo(
    () =>
      nodes
        .filter((n) => n.parentId === null && !n.archived && n.kind !== 'work_item')
        .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt),
    [nodes]
  )
  const deskIdsKey = desks.map((d) => d.id).join(',')

  // Load each desk's widgets so the cards can show a real spatial preview. Only
  // the active desk's widgets live in the widget store, so the gallery fetches
  // the rest directly. Failures fall back to an empty (honest) preview.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(
        desks.map(async (d) => {
          try {
            return [d.id, await window.api.widgets.listByTask(d.id)] as const
          } catch {
            return [d.id, [] as Widget[]] as const
          }
        })
      )
      if (!cancelled) setWidgetsByDesk(Object.fromEntries(entries))
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deskIdsKey])

  function openDesk(n: FbNode): void {
    setActive(n.id)
    if (n.kind === 'folder') goProject(n.id)
    else goTask(n.id)
  }

  function newDesk(): void {
    // Reuse the sidebar's create flow (opens the new-desk dialog).
    requestNewDesk(null)
  }

  // Genuinely empty workspace: no desks at all yet.
  if (nodesLoaded && desks.length === 0) {
    return (
      <div className="h-full flex items-center justify-center desk-paper">
        <div className="text-center max-w-md px-6">
          <Icon name="desk" size={48} className="text-[var(--ink-50)] mb-3" />
          <h2 className="fb-t-hero text-[var(--ink-100)] mb-2">No desks yet</h2>
          <p className="fb-t-body text-[var(--ink-70)] leading-relaxed mb-4">
            A desk is a canvas you fill with notes, files, browsers and tools. Create your first one to get started.
          </p>
          <button
            onClick={newDesk}
            data-testid="desk-gallery-new-empty"
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-[var(--radius-field)] bg-[rgb(var(--accent))] text-white fb-t-label fb-press hover:bg-[rgb(var(--accent-hover))]"
          >
            <Icon name="add" size={16} /> New desk
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto desk-paper" data-testid="desk-gallery">
      <div className="max-w-[1100px] mx-auto px-6 py-8">
        <DashboardHeader
          title="Your desks"
          subtitle="Every desk is a canvas. Open one to bring its notes, files and tools to the surface."
        />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {desks.map((d, i) => {
            const ws = widgetsByDesk[d.id] ?? []
            const count = ws.filter(
              (w) => !w.archived && !w.pinned && w.parentSectionId === null && w.kind !== 'minimap'
            ).length
            return (
              <button
                key={d.id}
                onClick={() => openDesk(d)}
                onContextMenu={(e) => {
                  // Lifecycle L1/S6: the same Archive/Trash set the index pages
                  // carry, on right-click. Shared desks hold both (D1 pending).
                  e.preventDefault()
                  setCtxMenu({ x: e.clientX, y: e.clientY, desk: d })
                }}
                data-testid={`desk-card-${d.id}`}
                style={{ animationDelay: `${Math.min(i * 35, 350)}ms` }}
                className={`group text-left ${PLEXI_CARD} overflow-hidden fb-lift fb-press fb-fade-in-up hover:border-[rgb(var(--accent)/0.5)]`}
              >
                <div className="h-36 flex items-center justify-center overflow-hidden bg-[var(--surface-sunken)] border-b border-[var(--edge-soft)]">
                  <DeskMiniature widgets={ws} width={320} height={144} />
                </div>
                <div className="px-3 py-2 flex items-center gap-2">
                  <Icon
                    name={d.kind === 'folder' ? 'folder' : 'task_alt'}
                    size={16}
                    filled
                    className="text-[var(--ink-50)] shrink-0"
                  />
                  <span className="flex-1 min-w-0 truncate fb-t-body font-medium text-[var(--ink-100)]">
                    {d.title || 'Untitled desk'}
                  </span>
                  <span className="fb-t-caption fb-tabular shrink-0">
                    {count === 0 ? 'empty' : count}
                  </span>
                </div>
              </button>
            )
          })}
          <button
            onClick={newDesk}
            data-testid="desk-card-new"
            className="fb-btn-surface rounded-[var(--radius-card)] border-dashed flex flex-col items-center justify-center gap-2 min-h-[180px] text-[var(--ink-50)] fb-lift fb-press fb-fade-in-up hover:border-[rgb(var(--accent)/0.5)] hover:text-[rgb(var(--accent))]"
          >
            <Icon name="add" size={22} />
            <span className="fb-t-body font-medium">New desk</span>
          </button>
        </div>
        {ctxMenu && (
          <CanvasContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            items={deskLifecycleMenuItems(ctxMenu.desk)}
            onClose={() => setCtxMenu(null)}
          />
        )}
      </div>
    </div>
  )
}
