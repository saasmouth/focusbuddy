import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FbNode, Widget } from '@shared/types'
import { useTemplateStore } from '../stores/templates'
import { useWidgetStore } from '../stores/widgets'
import { catalogFor } from '../lib/widgetCatalog'
import Icon from './Icon'

// SaveTemplateDialog — per-widget selection + name/description. Opens from
// either the toolbar's "Save template" button or the auto-prompt when a
// task transitions to "done". All widgets default-checked (the user's ask)
// so the happy path is: pick a name, click Save.
//
// Section-children behaviour: when a section is checked, its children are
// auto-included server-side (db/templates.ts). The UI mirrors that — the
// children appear under the section and disable the individual checkbox
// when the section is checked (since they're guaranteed to ride along).
// When the section is unchecked, children become individually selectable.

interface Props {
  // The task the template will be saved from. Used for the widget list +
  // default name + onSaved follow-up.
  task: FbNode
  // Optional default name (e.g. when invoked from the task-done auto-
  // prompt we prefill with "${task.title} template").
  defaultName?: string
  // Called after a successful save. The auto-prompt path uses this to
  // then close the task / advance the state machine. Toolbar path passes a
  // simple onClose.
  onSaved?: (templateId: string) => void
  // Called when the user dismisses without saving. The auto-prompt's
  // "Just close" button passes a closer that ALSO advances the task state.
  onSkip?: () => void
  onClose: () => void
  // Subtle messaging tweak for the auto-prompt context — the dialog
  // surfaces "save this task as a template so future similar tasks can
  // start here" framing when auto-opened from task completion.
  context?: 'toolbar' | 'task-done'
}

export default function SaveTemplateDialog({
  task,
  defaultName,
  onSaved,
  onSkip,
  onClose,
  context = 'toolbar'
}: Props): JSX.Element {
  const widgets = useWidgetStore((s) => s.widgets)
  const loadingFor = useWidgetStore((s) => s.loadingFor)
  const loadForTask = useWidgetStore((s) => s.loadForTask)
  const saveFromTask = useTemplateStore((s) => s.saveFromTask)

  // If the dialog was opened from somewhere that hasn't already loaded
  // the task's widgets (e.g. task-done prompt before user switched to
  // the task), trigger a load so the checkbox list is populated.
  useEffect(() => {
    if (loadingFor === task.id) return
    const haveAny = widgets.some((w) => w.taskId === task.id)
    if (!haveAny) void loadForTask(task.id)
  }, [task.id, widgets, loadingFor, loadForTask])

  // Visible widgets for THIS task. Archived widgets never appear (they
  // wouldn't make sense in a template anyway). Section-children are shown
  // grouped under their parent.
  const taskWidgets = useMemo(
    () => widgets.filter((w) => w.taskId === task.id && !w.archived),
    [widgets, task.id]
  )

  // Per-widget selection. Default: every widget checked (the user's ask).
  // When the task list loads asynchronously we top up the selection map
  // with newly-arrived ids so they default-checked too.
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  useEffect(() => {
    setSelected((prev) => {
      const next = { ...prev }
      let changed = false
      for (const w of taskWidgets) {
        if (next[w.id] === undefined) {
          next[w.id] = true
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [taskWidgets])

  // Group widgets so sections + their children render together. Top-level
  // free widgets follow.
  const grouped = useMemo(() => {
    const sections = taskWidgets.filter((w) => w.kind === 'section')
    const freeTopLevel = taskWidgets.filter(
      (w) => w.kind !== 'section' && w.parentSectionId === null
    )
    return { sections, freeTopLevel }
  }, [taskWidgets])

  const [name, setName] = useState(
    defaultName ?? (task.title ? `${task.title} template` : 'Untitled template')
  )
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function toggleAll(value: boolean): void {
    const next: Record<string, boolean> = {}
    for (const w of taskWidgets) next[w.id] = value
    setSelected(next)
  }

  function isSectionChecked(sectionId: string): boolean {
    return !!selected[sectionId]
  }

  function widgetIsKept(widget: Widget): boolean {
    // Top-level widget: own checkbox decides.
    if (widget.parentSectionId === null) return !!selected[widget.id]
    // Section child: ridden along when the parent section is checked;
    // otherwise the child's own checkbox decides.
    if (isSectionChecked(widget.parentSectionId)) return true
    return !!selected[widget.id]
  }

  const keptCount = taskWidgets.filter(widgetIsKept).length
  const totalCount = taskWidgets.length

  async function handleSave(): Promise<void> {
    if (saving) return
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      const widgetIds: string[] = []
      for (const w of taskWidgets) {
        if (widgetIsKept(w)) widgetIds.push(w.id)
      }
      const t = await saveFromTask(
        task.id,
        trimmed,
        description.trim() || undefined,
        widgetIds.length === totalCount ? undefined : widgetIds // pass undefined when ALL are selected for clean parity with legacy
      )
      onSaved?.(t.id)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  function handleSkip(): void {
    if (onSkip) onSkip()
    else onClose()
  }

  function renderRow(widget: Widget, indent: number, disabled: boolean): JSX.Element {
    const catalog = catalogFor(widget.kind)
    const icon = catalog?.icon ?? 'widgets'
    const label = catalog?.label ?? widget.kind
    return (
      <label
        key={widget.id}
        className={`flex items-start gap-2 px-2 py-1.5 rounded hover:bg-[var(--surface-sunken)] cursor-pointer ${
          disabled ? 'opacity-60 cursor-not-allowed' : ''
        }`}
        style={{ paddingLeft: `${indent * 16 + 8}px` }}
      >
        <input
          type="checkbox"
          checked={widgetIsKept(widget)}
          disabled={disabled}
          onChange={(e) =>
            setSelected((prev) => ({ ...prev, [widget.id]: e.target.checked }))
          }
          className="mt-0.5 accent-accent shrink-0"
        />
        <Icon name={icon} size={14} className="text-[var(--ink-50)] mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-[var(--ink-90)] truncate">
            {widget.title || label}
          </div>
          {widget.content && widget.kind !== 'webview' && (
            <div className="text-[10px] text-[var(--ink-50)] truncate">
              {widget.content.replace(/\s+/g, ' ').slice(0, 80)}
            </div>
          )}
          {widget.kind === 'webview' && widget.content && (
            <div className="text-[10px] text-[var(--ink-50)] truncate font-mono">
              {widget.content}
            </div>
          )}
        </div>
      </label>
    )
  }

  return createPortal(
    <div
      className="fb-scrim fixed inset-0 z-[260] flex items-center justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="fb-card w-[520px] max-h-[85vh] flex flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--edge-soft)]">
          <div className="h-8 w-8 rounded-full bg-accent/10 inline-flex items-center justify-center">
            <Icon name="bookmark_add" size={16} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--ink-100)]">
              {context === 'task-done'
                ? 'Save this as a template?'
                : 'Save as template'}
            </h2>
            <p className="text-[11px] text-[var(--ink-50)] leading-tight">
              {context === 'task-done'
                ? `Reuse this setup when you start another task like "${task.title}"`
                : 'Reuse this layout for future tasks of the same kind'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 rounded inline-flex items-center justify-center text-[var(--ink-40)] hover:bg-[var(--surface-sunken)]"
            aria-label="Close"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-50)] mb-1.5">
              Name
            </label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Template name"
              className="fb-field w-full text-[13px] px-2.5 py-1.5"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-50)] mb-1.5">
              Description{' '}
              <span className="text-[var(--ink-40)] normal-case font-normal">(optional)</span>
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What's this template for?"
              className="fb-field w-full text-[13px] px-2.5 py-1.5"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-50)]">
                What to include
                <span className="ml-1 text-[var(--ink-40)] normal-case font-normal">
                  ({keptCount} of {totalCount})
                </span>
              </label>
              <div className="flex items-center gap-1.5 text-[10px]">
                <button
                  onClick={() => toggleAll(true)}
                  className="text-[var(--ink-70)] hover:text-accent"
                >
                  All
                </button>
                <span className="text-[var(--ink-30)]">·</span>
                <button
                  onClick={() => toggleAll(false)}
                  className="text-[var(--ink-70)] hover:text-accent"
                >
                  None
                </button>
              </div>
            </div>
            <div className="max-h-[260px] overflow-y-auto rounded-md bg-[var(--surface-sunken)] py-1">
              {taskWidgets.length === 0 ? (
                <div className="px-4 py-6 text-center text-[12px] text-[var(--ink-50)]">
                  This task has no work widgets to template yet.
                </div>
              ) : (
                <>
                  {/* Sections first, with their children nested under them */}
                  {grouped.sections.map((section) => {
                    const children = taskWidgets.filter(
                      (w) => w.parentSectionId === section.id
                    )
                    const parentChecked = isSectionChecked(section.id)
                    return (
                      <div key={section.id}>
                        {renderRow(section, 0, false)}
                        {children.map((child) =>
                          renderRow(child, 1, parentChecked)
                        )}
                      </div>
                    )
                  })}
                  {/* Free top-level widgets after sections */}
                  {grouped.freeTopLevel.map((w) => renderRow(w, 0, false))}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-[var(--edge-soft)] flex justify-end gap-2">
          <button
            onClick={handleSkip}
            className="text-[12px] px-3 py-1.5 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
          >
            {context === 'task-done' ? 'Skip — just close' : 'Cancel'}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving || !name.trim() || keptCount === 0}
            className="text-[12px] px-4 py-1.5 rounded bg-accent text-white hover:brightness-110 disabled:opacity-50 font-medium inline-flex items-center gap-1.5"
          >
            {saving ? (
              <>
                <Icon name="autorenew" size={12} className="animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Icon name="bookmark_add" size={12} />
                Save template
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
