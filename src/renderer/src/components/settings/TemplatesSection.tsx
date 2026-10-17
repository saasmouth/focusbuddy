// Templates section of the Settings panel. This used to be a collapsible
// "Templates" section in the sidebar; it now lives here. It lists the real
// templates (the user's saved templates first, then the built-in starters) and
// applies one to the active task by reusing the shared applyTemplateToActiveTask
// helper, so there is a single spawn implementation rather than two copies.
// When there is no active task, applying is disabled and an honest hint is
// shown instead of the action failing silently.

import { useEffect, useState } from 'react'
import { useNodeStore } from '../../stores/nodes'
import { useTemplateStore } from '../../stores/templates'
import { STARTER_TEMPLATES } from '../../lib/starterTemplates'
import { applyTemplateToActiveTask } from '../../lib/applyTemplate'
import Icon from '../Icon'

export default function TemplatesSection(): JSX.Element {
  const userTemplates = useTemplateStore((s) => s.templates)
  const refreshTemplates = useTemplateStore((s) => s.refresh)
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Load the user's saved templates once so they show alongside the starters.
  useEffect(() => {
    void refreshTemplates()
  }, [refreshTemplates])

  const templates = [...userTemplates, ...STARTER_TEMPLATES]
  const canApply = activeTaskId != null

  async function apply(id: string): Promise<void> {
    if (!canApply || busyId) return
    setBusyId(id)
    try {
      await applyTemplateToActiveTask(id)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div
      className="px-3 py-3 border-t border-[var(--edge-soft)] space-y-2"
      data-testid="settings-section-templates"
    >
      <div className="fb-t-caption uppercase tracking-[0.12em] font-medium">
        Templates
      </div>
      <p className="fb-t-caption text-[var(--ink-50)] leading-snug">
        {canApply
          ? 'Apply a template to spawn its work widgets onto the task you have open.'
          : 'Open a task first — templates apply to the task you have open.'}
      </p>

      <div role="list" className={canApply ? '' : 'opacity-50'}>
        {templates.map((tpl) => (
          <button
            key={tpl.id}
            role="listitem"
            disabled={!canApply || busyId === tpl.id}
            onClick={() => void apply(tpl.id)}
            data-testid={`settings-template-${tpl.id}`}
            className="group w-full flex items-center gap-1.5 px-2 py-1.5 rounded-[var(--radius-chip)] hover:bg-[var(--surface-sunken)] text-left disabled:cursor-not-allowed"
            title={
              tpl.description
                ? `${tpl.description}\n\nApply to the active task.`
                : 'Apply to the active task.'
            }
          >
            <Icon name="layers" size={14} className="text-accent shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-[var(--ink-90)] truncate">
                {tpl.name}
              </div>
              <div className="fb-t-caption text-[var(--ink-50)]">
                {tpl.widgets.length} widget{tpl.widgets.length === 1 ? '' : 's'}
              </div>
            </div>
            {busyId === tpl.id && (
              <span className="fb-t-caption text-[var(--ink-50)]">Applying…</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
