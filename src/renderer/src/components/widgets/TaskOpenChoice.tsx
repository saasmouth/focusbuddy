import { useEffect } from 'react'
import type { FbNode } from '@shared/types'
import Icon from '../Icon'

// A task with a desk behind it: which did you mean?
//
// A desk and a task are the same node kind, so any task CAN be opened as a
// canvas. That made clicking a task ambiguous in the worst way -- it silently
// took you off the desk you were working on, and the only way back was the
// sidebar. Most clicks mean "show me this task"; some mean "take me to its
// canvas". Rather than guess, ask -- but only when there is genuinely a canvas
// to go to. A task with no widgets has no desk, and gets no question.

export default function TaskOpenChoice({
  task,
  widgetCount,
  onOpenHere,
  onGoToDesk,
  onClose
}: {
  task: FbNode
  widgetCount: number
  onOpenHere: () => void
  onGoToDesk: () => void
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/35 p-6"
      onClick={onClose}
      data-testid="task-open-choice-backdrop"
    >
      <div
        className="w-full max-w-[400px] overflow-hidden rounded-[var(--radius-card)] bg-[var(--surface-raised)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="task-open-choice"
      >
        <div className="border-b border-[var(--line)] px-4 py-3">
          <div className="truncate text-[13px] font-semibold text-[var(--ink-90)]">
            {task.title || 'Untitled task'}
          </div>
          <div className="text-[11px] text-[var(--ink-50)]">
            This task also has a desk, with {widgetCount} {widgetCount === 1 ? 'widget' : 'widgets'}
            .
          </div>
        </div>
        <div className="flex flex-col gap-1.5 p-3">
          <button
            type="button"
            onClick={onOpenHere}
            data-testid="task-open-here"
            className="flex items-start gap-2 rounded-md border border-[var(--line)] px-3 py-2 text-left hover:bg-[var(--surface-sunken)]"
          >
            <Icon name="unfold_more" size={15} className="mt-0.5 shrink-0 text-[var(--ink-50)]" />
            <span>
              <span className="block text-[12px] font-medium text-[var(--ink-90)]">
                Open the task here
              </span>
              <span className="block text-[11px] text-[var(--ink-50)]">
                Dates, subtasks and attachments, without leaving this desk.
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={onGoToDesk}
            data-testid="task-go-to-desk"
            className="flex items-start gap-2 rounded-md border border-[var(--line)] px-3 py-2 text-left hover:bg-[var(--surface-sunken)]"
          >
            <Icon name="space_dashboard" size={15} className="mt-0.5 shrink-0 text-[var(--ink-50)]" />
            <span>
              <span className="block text-[12px] font-medium text-[var(--ink-90)]">
                Go to its desk
              </span>
              <span className="block text-[11px] text-[var(--ink-50)]">
                Leave this desk and open that canvas.
              </span>
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
