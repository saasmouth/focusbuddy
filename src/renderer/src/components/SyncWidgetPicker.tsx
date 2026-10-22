import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FbNode, Widget } from '@shared/types'
import { useNodeStore } from '../stores/nodes'
import { useWidgetStore } from '../stores/widgets'
import { catalogFor } from '../lib/widgetCatalog'
import PlexiiIcon from './PlexiiIcon'
import Icon from './Icon'

// Phase 4 — "Bring a synced widget from another task/folder onto this canvas."
// Pick a task, pick one of its content widgets, and a LIVE-synced duplicate is
// created here (shared syncGroupId → edits mirror both ways). Reuses the same
// sync mechanism as Duplicate (keep synced).

function isBringable(w: Widget): boolean {
  return w.kind !== 'section' && w.kind !== 'minimap' && !w.pinned && w.parentSectionId === null
}

interface Props {
  /** The task whose canvas the synced copy should land on (the active task). */
  targetTaskId: string
  onClose: () => void
}

export default function SyncWidgetPicker({ targetTaskId, onClose }: Props): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const create = useWidgetStore((s) => s.create)
  const [step, setStep] = useState<'task' | 'widget'>('task')
  const [taskQuery, setTaskQuery] = useState('')
  const [picked, setPicked] = useState<FbNode | null>(null)
  const [widgets, setWidgets] = useState<Widget[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const folderById = useMemo(
    () => new Map(nodes.filter((n) => n.kind === 'folder').map((f) => [f.id, f.title])),
    [nodes]
  )
  const tasks = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === 'task' && !n.archived && n.id !== targetTaskId)
        .filter((t) => (t.title || '').toLowerCase().includes(taskQuery.trim().toLowerCase())),
    [nodes, targetTaskId, taskQuery]
  )

  async function openTask(t: FbNode): Promise<void> {
    setPicked(t)
    setStep('widget')
    setWidgets(null)
    const all = await window.api.widgets.listByTask(t.id)
    setWidgets(all.filter(isBringable))
  }

  async function bringIn(source: Widget): Promise<void> {
    setBusyId(source.id)
    try {
      // Ensure the source belongs to a sync group, then create a copy sharing it.
      let groupId = source.syncGroupId ?? undefined
      if (!groupId) {
        groupId = crypto.randomUUID()
        await window.api.widgets.update(source.id, { syncGroupId: groupId })
      }
      const n = useWidgetStore.getState().widgets.filter((w) => !w.pinned).length
      await create({
        taskId: targetTaskId,
        kind: source.kind,
        title: source.title,
        content: source.content,
        x: 60 + (n % 5) * 36,
        y: 60 + (n % 5) * 36,
        width: source.width,
        height: source.height,
        color: source.color,
        sourceAppId: source.sourceAppId,
        mode: source.mode,
        syncGroupId: groupId
      })
      onClose()
    } finally {
      setBusyId(null)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/30"
      onMouseDown={onClose}
    >
      <div
        className="fb-card w-[min(520px,94vw)] max-h-[78vh] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="sync-widget-picker"
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--edge-soft)]">
          {step === 'widget' && (
            <button
              onClick={() => {
                setStep('task')
                setPicked(null)
              }}
              className="h-6 w-6 inline-flex items-center justify-center rounded text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
              aria-label="Back to tasks"
            >
              <Icon name="arrow_back" size={14} />
            </button>
          )}
          <Icon name="link" size={15} className="text-accent" />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-[var(--ink-100)]">
              {step === 'task' ? 'Bring a synced work widget' : `Pick a work widget from “${picked?.title}”`}
            </div>
            <div className="text-[10px] text-[var(--ink-50)]">
              {step === 'task'
                ? 'Choose where to copy from — the copy stays in sync with the original.'
                : 'A live-linked copy lands on your canvas.'}
            </div>
          </div>
          <button
            onClick={onClose}
            className="h-6 w-6 inline-flex items-center justify-center rounded text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
            aria-label="Close"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {step === 'task' && (
          <>
            <div className="px-3 pt-2.5">
              <input
                autoFocus
                value={taskQuery}
                onChange={(e) => setTaskQuery(e.target.value)}
                placeholder="Search tasks…"
                className="fb-field w-full h-8 px-2.5 text-[12px]"
              />
            </div>
            <div className="p-2 overflow-y-auto">
              {tasks.length === 0 && (
                <div className="px-3 py-6 text-center text-[12px] text-[var(--ink-40)]">
                  No other tasks to bring from.
                </div>
              )}
              {tasks.map((t) => (
                <button
                  key={t.id}
                  onClick={() => void openTask(t)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--surface-sunken)] text-left"
                  data-testid={`sync-pick-task-${t.id}`}
                >
                  <Icon name="task_alt" size={14} className="text-[var(--ink-50)] shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--ink-100)]">
                    {t.title || '(untitled task)'}
                  </span>
                  {t.parentId && folderById.get(t.parentId) && (
                    <span className="text-[10px] text-[var(--ink-40)] truncate max-w-[120px]">
                      {folderById.get(t.parentId)}
                    </span>
                  )}
                  <Icon name="chevron_right" size={14} className="text-[var(--ink-40)] shrink-0" />
                </button>
              ))}
            </div>
          </>
        )}

        {step === 'widget' && (
          <div className="p-2 overflow-y-auto">
            {widgets === null && (
              <div className="px-3 py-6 text-center text-[12px] text-[var(--ink-40)]">Loading…</div>
            )}
            {widgets && widgets.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-[var(--ink-40)]">
                No bringable work widgets on that task.
              </div>
            )}
            {widgets?.map((w) => {
              const entry = catalogFor(w.kind)
              const label = w.title || entry?.label || w.kind
              return (
                <button
                  key={w.id}
                  onClick={() => void bringIn(w)}
                  disabled={busyId !== null}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--surface-sunken)] text-left disabled:opacity-50"
                  data-testid={`sync-pick-widget-${w.id}`}
                >
                  <PlexiiIcon kind="widget" id={w.kind} size={18} fallback={entry?.icon ?? 'widgets'} className="shrink-0" fallbackClassName="text-accent" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-[var(--ink-100)] truncate">
                      {label}
                    </div>
                    <div className="text-[10px] text-[var(--ink-50)]">
                      {entry?.label ?? w.kind}
                      {w.syncGroupId ? ' · already synced' : ''}
                    </div>
                  </div>
                  <Icon
                    name={busyId === w.id ? 'progress_activity' : 'add_link'}
                    size={14}
                    className={`text-[var(--ink-40)] shrink-0 ${busyId === w.id ? 'animate-spin' : ''}`}
                  />
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
