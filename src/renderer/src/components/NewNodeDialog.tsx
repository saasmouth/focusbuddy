import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import type { AxisValue, BrowsingHistoryEntry, FbNode, NodeKind, Template } from '@shared/types'
import { useNodeStore } from '../stores/nodes'
import { useCapabilityEnabled } from '../stores/capabilities'
import { promptUpgrade } from '../stores/upgradePrompt'
import { useWidgetStore } from '../stores/widgets'
import { useTemplateStore } from '../stores/templates'
import { computeVelocity, predictForEstimate } from '../lib/velocityStats'
import { STARTER_TEMPLATES } from '../lib/starterTemplates'
import AxisPicker from './AxisPicker'
import Icon from './Icon'
import { defaultDeskTitle } from '../lib/deskDefaults'
import { useViewStore } from '../stores/view'
import { fieldInputClass, FieldLabel, FormField } from './plexi/forms'

interface Props {
  // Create mode: pass parentId + kind. Edit mode: pass node.
  parentId?: string | null
  kind?: NodeKind
  node?: FbNode | null
  onClose: () => void
  // When provided, parent renders the AI Setup dialog for the given task after this dialog closes.
  onRequestAISetup?: (task: FbNode) => void
}

function toDateInputValue(ms: number | null | undefined): string {
  if (!ms) return ''
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fromDateInputValue(s: string): number | null {
  if (!s) return null
  // Interpret the date as end-of-day local time so "due 2026-05-25" doesn't pass at midnight.
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10))
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d, 23, 59, 59).getTime()
}

// Quiet hue rotation for template cards — colour lives in the icon stroke,
// the chip behind stays neutral, selection stays accent. Literal classes so
// Tailwind generates them.
const TEMPLATE_TONES = [
  'text-sky-500',
  'text-emerald-500',
  'text-amber-500',
  'text-violet-500',
  'text-rose-500',
  'text-teal-500',
  'text-orange-500',
  'text-fuchsia-500'
]

export default function NewNodeDialog({
  parentId: parentIdProp,
  kind: kindProp,
  node,
  onClose,
  onRequestAISetup
}: Props): JSX.Element {
  const isEdit = !!node
  const effectiveKind: NodeKind = node ? node.kind : kindProp ?? 'task'
  const parentId = node ? node.parentId : parentIdProp ?? null

  const create = useNodeStore((s) => s.create)
  const aiSetupEnabled = useCapabilityEnabled('ai_task_setup')
  const updateNode = useNodeStore((s) => s.update)
  const setActive = useNodeStore((s) => s.setActive)
  const allNodes = useNodeStore((s) => s.nodes)
  const activeTaskId = useNodeStore((s) => s.activeTaskId)

  // Where a new task goes.
  //
  // This dialog only ever made a top-level node, which in this model IS a desk
  // -- its own canvas, its own sidebar row. So "new task" from the app chrome
  // could not produce a task at all, only another desk, and there was no way
  // to add one to the desk you were looking at.
  //
  // Offered only when a desk is actually open, because otherwise there is
  // nothing to choose between.
  const activeDesk = useMemo(
    () => allNodes.find((n) => n.id === activeTaskId && n.kind === 'task') ?? null,
    [allNodes, activeTaskId]
  )
  const canPlaceOnDesk = !isEdit && effectiveKind === 'task' && Boolean(activeDesk)
  const [placement, setPlacement] = useState<'thisDesk' | 'newDesk'>('newDesk')
  const createWidget = useWidgetStore((s) => s.create)
  const templates = useTemplateStore((s) => s.templates)
  const refreshTemplates = useTemplateStore((s) => s.refresh)
  const velocity = useMemo(() => computeVelocity(allNodes), [allNodes])

  // Folders the new task can live in, and existing tasks the user might want to
  // jump to instead of creating a new one. Both drive the destination controls
  // we add below for the "+add" flow.
  const folders = useMemo(() => allNodes.filter((n) => n.kind === 'folder' && !n.archived), [allNodes])
  const existingTasks = useMemo(
    () => allNodes.filter((n) => n.kind === 'task' && !n.archived),
    [allNodes]
  )
  const NEW_FOLDER = '__new_folder__'
  // Where the new task lands. Defaults to the parent we were opened with; for a
  // top-level "+add" (parentId null) we default to the first folder if one
  // exists so a stray task does not get orphaned at the root.
  const [destParent, setDestParent] = useState<string | null>(() => {
    if (parentId && allNodes.some((n) => n.id === parentId && n.kind === 'folder')) return parentId
    return null
  })
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [folderQuery, setFolderQuery] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  // Quick-jump: search existing tasks and switch to one for fast navigation,
  // instead of creating a new task at all.
  const [jumpQuery, setJumpQuery] = useState('')
  const jumpRef = useRef<HTMLDivElement | null>(null)

  // DEC-073 — a new Desk pre-fills its title with the moment of creation, so a
  // bare Enter files something findable; the input selects it all on focus so
  // typing replaces it in one keystroke. Rooms and edits keep their own text.
  const [title, setTitle] = useState(
    node?.title ?? (!node && (kindProp ?? 'task') === 'task' ? defaultDeskTitle() : '')
  )
  const [description, setDescription] = useState(node?.description ?? '')
  const [priority, setPriority] = useState<AxisValue>(node?.priority ?? 3)
  // Interest is no longer surfaced in the UI (two-axis model — see POSITIONING.md §11.5),
  // but we still write it to the DB so existing tasks aren't disrupted. Defaulted to 3
  // for new tasks; preserved from existing tasks on edit.
  const interest = node?.interest ?? 3
  const [importance, setImportance] = useState<AxisValue>(node?.importance ?? 3)
  const [estimateMinutes, setEstimateMinutes] = useState<string>(
    node?.estimateMinutes != null ? String(node.estimateMinutes) : ''
  )
  const [dueDate, setDueDate] = useState<string>(toDateInputValue(node?.dueDate))
  const [toolsInput, setToolsInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null)
  const [autoSuggestAI, setAutoSuggestAI] = useState(false)
  const [recentPages, setRecentPages] = useState<BrowsingHistoryEntry[]>([])
  const [addedUrls, setAddedUrls] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (effectiveKind === 'task' && !isEdit) void refreshTemplates()
  }, [effectiveKind, isEdit, refreshTemplates])

  useEffect(() => {
    if (effectiveKind !== 'task' || isEdit) return
    let cancelled = false
    void (async () => {
      const entries = await window.api.history.recent(10, null)
      if (!cancelled) setRecentPages(entries)
    })()
    return () => {
      cancelled = true
    }
  }, [effectiveKind, isEdit])

  function appendRecentPage(entry: BrowsingHistoryEntry): void {
    if (addedUrls.has(entry.url)) return
    setToolsInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n${entry.url}` : entry.url))
    setAddedUrls((prev) => new Set(prev).add(entry.url))
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const estimate = estimateMinutes.trim() === '' ? null : parseInt(estimateMinutes, 10)
      const dueDateMs = effectiveKind === 'task' ? fromDateInputValue(dueDate) : null

      if (isEdit && node) {
        await updateNode(node.id, {
          title: title.trim(),
          description: description.trim(),
          priority,
          interest,
          importance,
          estimateMinutes:
            effectiveKind === 'task' && typeof estimate === 'number' && !isNaN(estimate) && estimate > 0
              ? estimate
              : null,
          dueDate: dueDateMs
        })
        onClose()
        return
      }

      // Resolve where a new task lands. Folders keep the parent they were
      // opened with; a task uses the destination the user picked, creating a
      // new folder first when they asked for one.
      let resolvedParent = parentId
      // A task ON the desk in view: a child of it, not another canvas.
      if (canPlaceOnDesk && placement === 'thisDesk' && activeDesk) {
        resolvedParent = activeDesk.id
      } else if (effectiveKind === 'task') {
        if (destParent === NEW_FOLDER) {
          const name = newFolderName.trim()
          if (!name) {
            setBusy(false)
            // Reopen the picker so the missing name is obvious.
            setFolderPickerOpen(true)
            return
          }
          const folder = await create({
            parentId: null,
            kind: 'folder',
            title: name
          } as Parameters<typeof create>[0])
          resolvedParent = folder.id
        } else {
          resolvedParent = destParent
        }
      }

      const created = await create({
        parentId: resolvedParent,
        kind: effectiveKind,
        title: title.trim(),
        description: description.trim(),
        priority,
        interest,
        importance,
        estimateMinutes:
          effectiveKind === 'task' && typeof estimate === 'number' && !isNaN(estimate) && estimate > 0
            ? estimate
            : null,
        dueDate: dueDateMs
      })
      if (effectiveKind === 'task') {
        if (selectedTemplate) {
          for (const w of selectedTemplate.widgets) {
            await createWidget({
              taskId: created.id,
              kind: w.kind,
              title: w.title,
              content: w.content,
              x: w.x,
              y: w.y,
              width: w.width,
              height: w.height,
              color: w.color
            })
          }
        } else {
          const lines = toolsInput
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
          let x = 60
          let y = 60
          for (const line of lines) {
            const isUrl = /^https?:\/\//i.test(line)
            await createWidget({
              taskId: created.id,
              kind: isUrl ? 'webview' : 'sticky',
              title: isUrl ? new URL(line).hostname.replace(/^www\./, '') : '',
              content: line,
              x,
              y,
              color: isUrl ? null : '#fef08a'
            })
            x += isUrl ? 60 : 40
            y += isUrl ? 40 : 30
          }
        }
        setActive(created.id)
        // DEC-073 — creation OPENS the desk. Previously the desk was created
        // and the user stayed put, left to find it under All Desks.
        useViewStore.getState().goTask(created.id)
        if (autoSuggestAI && onRequestAISetup) {
          // Close this dialog and hand off to parent so the AI Setup modal opens cleanly.
          onClose()
          onRequestAISetup(created)
          return
        }
      }
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const nounLabel = effectiveKind === 'folder' ? 'Room' : 'Desk'
  const dialogTitle = `${isEdit ? 'Edit' : 'New'} ${nounLabel}`
  const dialogSubtitle =
    effectiveKind === 'folder'
      ? 'A Room holds the desks that belong together.'
      : isEdit
        ? 'Adjust the details of this workspace.'
        : 'Set up a focused workspace for one piece of work.'
  const submitLabel = isEdit ? 'Save changes' : `Create ${nounLabel}`
  const submitIcon = isEdit ? 'save' : 'check'

  const composer = effectiveKind === 'task' && !isEdit

  // Portaled to <body>: this dialog is mounted from inside the sidebar, whose
  // glass chrome (transform/backdrop-filter) turns it into a containing block
  // for position:fixed — without the portal the "fullscreen" overlay is trapped
  // inside the sidebar's box and renders as a cramped side column.
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="fb-scrim fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.form
        initial={{ opacity: 0, scale: 0.985, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        role="dialog"
        aria-modal="true"
        aria-label={dialogTitle}
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
        className={`fb-card fb-press w-full ${
          composer ? 'max-w-[880px]' : 'max-w-lg'
        } overflow-hidden max-h-[86vh] flex flex-col shadow-[0_32px_80px_-16px_rgba(0,0,0,0.5)]`}
      >
        {/* Header: identity row, then the name as the hero. Creating a desk should
            feel like titling a fresh page, not filling in a boxed form. */}
        <div className="px-6 pt-5 pb-4 border-b border-[var(--edge-soft)] shrink-0">
          <div className="flex items-center gap-2.5 mb-3">
            <span className="h-8 w-8 rounded-xl bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))] inline-flex items-center justify-center shrink-0">
              <Icon
                name={isEdit ? 'edit' : effectiveKind === 'folder' ? 'plexii:rooms' : 'plexii:desks'}
                size={17}
              />
            </span>
            <div className="flex-1 min-w-0">
              <h3 className="text-[13px] font-semibold text-[var(--ink-100)] leading-tight">
                {dialogTitle}
              </h3>
              <p className="text-[11px] text-[var(--ink-50)] leading-tight mt-0.5">{dialogSubtitle}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              title="Close"
              className="h-7 w-7 rounded-lg inline-flex items-center justify-center text-[var(--ink-40)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] transition-colors shrink-0"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <input
            autoFocus
            data-testid="newnode-name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder={effectiveKind === 'folder' ? 'Name this Room…' : 'What needs to happen?'}
            className="w-full bg-transparent border-0 p-0 text-[20px] font-semibold text-[var(--ink-100)] placeholder:text-[var(--ink-30)] placeholder:font-medium focus:outline-none focus:ring-0"
          />
          {canPlaceOnDesk && (
            <div className="mt-3 flex gap-1.5" data-testid="newnode-placement">
              <button
                type="button"
                onClick={() => setPlacement('thisDesk')}
                data-testid="newnode-this-desk"
                className={`flex-1 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  placement === 'thisDesk'
                    ? 'border-accent bg-accent/10'
                    : 'border-[var(--line)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                <span className="block text-[12px] font-medium text-[var(--ink-90)]">
                  A task on this desk
                </span>
                <span className="block truncate text-[11px] text-[var(--ink-50)]">
                  {activeDesk?.title || 'Untitled desk'}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPlacement('newDesk')}
                data-testid="newnode-new-desk"
                className={`flex-1 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                  placement === 'newDesk'
                    ? 'border-accent bg-accent/10'
                    : 'border-[var(--line)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                <span className="block text-[12px] font-medium text-[var(--ink-90)]">
                  A new desk
                </span>
                <span className="block text-[11px] text-[var(--ink-50)]">Its own canvas</span>
              </button>
            </div>
          )}
          {!isEdit && effectiveKind === 'task' && existingTasks.length > 0 && (
            <div ref={jumpRef} className="relative mt-3">
              <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-sunken)] px-2.5 focus-within:ring-1 focus-within:ring-[rgb(var(--accent)/0.4)]">
                <Icon name="search" size={14} className="text-[var(--ink-40)] shrink-0" />
                <input
                  value={jumpQuery}
                  onChange={(e) => setJumpQuery(e.target.value)}
                  placeholder="Or jump to an existing Desk…"
                  className="w-full bg-transparent border-0 py-2 text-[12.5px] text-[var(--ink-90)] placeholder:text-[var(--ink-40)] focus:outline-none focus:ring-0"
                />
              </div>
              {jumpQuery.trim() && (
                <div className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute left-0 right-0 top-full mt-1 z-10 max-h-44 overflow-auto shadow-[0_12px_32px_rgba(0,0,0,0.25)]">
                  {existingTasks
                    .filter((t) =>
                      (t.title || '').toLowerCase().includes(jumpQuery.trim().toLowerCase())
                    )
                    .slice(0, 30)
                    .map((t) => {
                      const folder = allNodes.find((n) => n.id === t.parentId)
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setActive(t.id)
                            onClose()
                          }}
                          className="w-full text-left px-3 py-2 text-[12.5px] flex items-center justify-between gap-2 text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
                        >
                          <span className="truncate">{t.title || '(untitled Desk)'}</span>
                          {folder && (
                            <span className="text-[10px] text-[var(--ink-50)] shrink-0 truncate max-w-[140px]">
                              {folder.title}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  {existingTasks.filter((t) =>
                    (t.title || '').toLowerCase().includes(jumpQuery.trim().toLowerCase())
                  ).length === 0 && (
                    <div className="px-3 py-2 text-[11px] text-[var(--ink-50)]">No Desks match.</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="overflow-y-auto">
          {composer ? (
            /* Composer: the work on the left, the details in a quiet rail on the
               right — the same split every mature creation surface uses, so the
               eye lands on "what am I making" before "how is it filed". */
            <div className="sm:grid sm:grid-cols-[minmax(0,1fr)_300px]">
              <div className="px-6 py-5 space-y-5 min-w-0">
                <FormField label="Notes" hint="(optional)">
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    placeholder="Anything to remember about this…"
                    className={`${fieldInputClass()} resize-none`}
                  />
                </FormField>

                <div>
                  <FieldLabel>
                    Start from a template <span className="normal-case text-[var(--ink-40)]">(optional)</span>
                  </FieldLabel>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedTemplate(null)}
                      className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                        !selectedTemplate
                          ? 'border-[rgb(var(--accent))] bg-[rgb(var(--accent)/0.08)]'
                          : 'border-[var(--edge-soft)] hover:border-[var(--edge-firm)] hover:bg-[var(--surface-sunken)]'
                      }`}
                    >
                      <span className={`h-8 w-8 rounded-lg inline-flex items-center justify-center shrink-0 ${!selectedTemplate ? 'text-[rgb(var(--accent))] bg-[rgb(var(--accent)/0.12)]' : 'text-[var(--ink-50)] bg-[var(--surface-sunken)]'}`}>
                        <Icon name="add" size={16} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[12.5px] font-medium text-[var(--ink-100)] truncate">Empty</span>
                        <span className="block text-[10.5px] text-[var(--ink-40)] truncate">Blank canvas</span>
                      </span>
                    </button>
                    {/* Built-in starters first (always available), then the user's
                        own saved templates. Picking one pre-fills a blank title. */}
                    {[...STARTER_TEMPLATES, ...templates].map((t, ti) => {
                      const isStarter = t.id.startsWith('starter-')
                      const isSel = selectedTemplate?.id === t.id
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setSelectedTemplate(t)
                            if (!title.trim()) setTitle(t.name)
                          }}
                          title={t.description || t.name}
                          className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                            isSel
                              ? 'border-[rgb(var(--accent))] bg-[rgb(var(--accent)/0.08)]'
                              : 'border-[var(--edge-soft)] hover:border-[var(--edge-firm)] hover:bg-[var(--surface-sunken)]'
                          }`}
                        >
                          <span className={`h-8 w-8 rounded-lg inline-flex items-center justify-center shrink-0 ${isSel ? 'text-[rgb(var(--accent))] bg-[rgb(var(--accent)/0.12)]' : `${TEMPLATE_TONES[ti % TEMPLATE_TONES.length]} bg-[var(--surface-sunken)]`}`}>
                            <Icon name={isStarter ? 'plexii:templates' : 'plexii:assemble'} size={16} />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[12.5px] font-medium text-[var(--ink-100)] truncate">{t.name}</span>
                            <span className="block text-[10.5px] text-[var(--ink-40)] truncate">
                              {isStarter ? 'Starter' : `${t.widgets.length} widget${t.widgets.length === 1 ? '' : 's'}`}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  {selectedTemplate && (
                    <div className="mt-2 text-[11px] text-[var(--ink-50)]">
                      {selectedTemplate.description || `${selectedTemplate.widgets.length} widgets`}
                    </div>
                  )}
                </div>

                {!selectedTemplate && recentPages.length > 0 && (
                  <div>
                    <FieldLabel className="flex items-center gap-1.5">
                      <Icon name="history" size={12} className="text-sky-500" />
                      Recent pages
                      <span className="normal-case text-[var(--ink-40)]">click to add</span>
                    </FieldLabel>
                    <div className="flex flex-wrap gap-1.5">
                      {recentPages.map((entry) => {
                        const added = addedUrls.has(entry.url)
                        const label = entry.title || entry.host || entry.url
                        return (
                          <button
                            key={entry.url}
                            type="button"
                            onClick={() => appendRecentPage(entry)}
                            disabled={added}
                            title={`${entry.url}\n${entry.visitCount} visit${entry.visitCount === 1 ? '' : 's'}`}
                            className={`chip-btn max-w-[220px] ${
                              added
                                ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 cursor-default'
                                : 'chip-active'
                            }`}
                          >
                            <Icon name={added ? 'check' : 'public'} size={12} className={added ? '' : 'text-sky-500'} />
                            <span className="truncate">{label}</span>
                            {!added && entry.visitCount > 1 && (
                              <span className="text-[9px] text-[var(--ink-40)] font-mono shrink-0">
                                {entry.visitCount}
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {!selectedTemplate && (
                  <FormField
                    label="Tools & tabs"
                    hint="(one per line — URLs open as browsers, text becomes stickies)"
                  >
                    <textarea
                      value={toolsInput}
                      onChange={(e) => setToolsInput(e.target.value)}
                      rows={3}
                      placeholder={'https://docs.google.com/...\nhttps://github.com/...\nRemember: due Friday'}
                      className={`${fieldInputClass()} !text-xs font-mono resize-none`}
                    />
                  </FormField>
                )}
              </div>

              <aside className="px-5 py-5 space-y-5 border-t sm:border-t-0 sm:border-l border-[var(--edge-soft)] bg-[var(--surface-sunken)]">
                <div>
                  <FieldLabel>Room</FieldLabel>
                  {!folderPickerOpen ? (
                    <button
                      type="button"
                      onClick={() => setFolderPickerOpen(true)}
                      className={`${fieldInputClass()} flex items-center justify-between gap-2 text-left bg-[var(--surface-raised)] hover:border-[var(--edge-firm)]`}
                    >
                      <span className="truncate flex items-center gap-1.5">
                        <Icon name="meeting_room" size={14} className="text-sky-500" />
                        {destParent === NEW_FOLDER
                          ? newFolderName.trim() || 'New Room…'
                          : destParent
                            ? folders.find((f) => f.id === destParent)?.title || '(Room)'
                            : 'Top level (no Room)'}
                      </span>
                      <span className="text-[11px] text-[var(--ink-50)] shrink-0">Change</span>
                    </button>
                  ) : (
                    <div className="fb-card overflow-hidden">
                      <input
                        autoFocus
                        value={folderQuery}
                        onChange={(e) => setFolderQuery(e.target.value)}
                        placeholder="Search Rooms…"
                        className="w-full bg-[var(--surface-sunken)] border-b border-[var(--edge-soft)] px-3 py-2 text-sm text-[var(--ink-100)] placeholder:text-[var(--ink-40)]"
                      />
                      <div className="max-h-40 overflow-auto">
                        <button
                          type="button"
                          onClick={() => {
                            setDestParent(null)
                            setFolderPickerOpen(false)
                          }}
                          className="w-full text-left px-3 py-1.5 text-sm text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
                        >
                          Top level (no Room)
                        </button>
                        {folders
                          .filter((f) =>
                            (f.title || '').toLowerCase().includes(folderQuery.trim().toLowerCase())
                          )
                          .map((f) => (
                            <button
                              key={f.id}
                              type="button"
                              onClick={() => {
                                setDestParent(f.id)
                                setFolderPickerOpen(false)
                              }}
                              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--surface-sunken)] ${
                                destParent === f.id
                                  ? 'text-accent bg-accent/[0.06]'
                                  : 'text-[var(--ink-90)]'
                              }`}
                            >
                              {f.title || '(untitled Room)'}
                            </button>
                          ))}
                        <button
                          type="button"
                          onClick={() => {
                            setDestParent(NEW_FOLDER)
                            if (folderQuery.trim()) setNewFolderName(folderQuery.trim())
                            setFolderPickerOpen(false)
                          }}
                          className="w-full text-left px-3 py-1.5 text-sm text-accent border-t border-[var(--edge-soft)] hover:bg-accent/5"
                        >
                          + Create new Room{folderQuery.trim() ? ` "${folderQuery.trim()}"` : '…'}
                        </button>
                      </div>
                    </div>
                  )}
                  {destParent === NEW_FOLDER && !folderPickerOpen && (
                    <input
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      placeholder="New Room name"
                      className={`${fieldInputClass()} mt-1.5 bg-[var(--surface-raised)]`}
                    />
                  )}
                </div>

                {/* Two-axis model: Interest dropped from UI (see POSITIONING.md §11.5).
                    The state + DB field stay defaulted to 3 so existing tasks aren't disrupted. */}
                <AxisPicker label="Urgency" hint="whenever → urgent" value={priority} onChange={setPriority} />
                <AxisPicker label="Importance" hint="low → high stakes" value={importance} onChange={setImportance} />

                <div className="grid grid-cols-2 gap-3">
                  <FormField label="Duration" hint="(min)">
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      value={estimateMinutes}
                      onChange={(e) => setEstimateMinutes(e.target.value)}
                      placeholder="e.g. 30"
                      className={`${fieldInputClass()} bg-[var(--surface-raised)]`}
                    />
                  </FormField>
                  <FormField label="Due" hint="(optional)">
                    <div className="flex gap-1.5">
                      <input
                        type="date"
                        value={dueDate}
                        onChange={(e) => setDueDate(e.target.value)}
                        className={`${fieldInputClass()} flex-1 min-w-0 bg-[var(--surface-raised)] [color-scheme:light] dark:[color-scheme:dark]`}
                      />
                      {dueDate && (
                        <button
                          type="button"
                          onClick={() => setDueDate('')}
                          className="icon-btn"
                          title="Clear due date"
                        >
                          <Icon name="close" size={14} />
                        </button>
                      )}
                    </div>
                  </FormField>
                </div>

                {velocity && (
                  <div className="fb-card px-3 py-2 text-[11px] text-[var(--ink-90)] flex items-start gap-2">
                    <Icon name="insights" size={13} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                    <div>
                      <div>
                        <strong>Your history:</strong> {Math.round(velocity.ratio * 100)}% of estimates
                        <span className="text-[var(--ink-50)]"> (n={velocity.sampleCount})</span>
                      </div>
                      {estimateMinutes.trim() !== '' && parseInt(estimateMinutes, 10) > 0 && (
                        <div className="mt-0.5">
                          Predicted real time:{' '}
                          <strong>{predictForEstimate(velocity, parseInt(estimateMinutes, 10))} min</strong>
                        </div>
                      )}
                      {estimateMinutes.trim() === '' && (
                        <div className="mt-0.5">
                          Median Desk takes <strong>{Math.round(velocity.medianActualMin)} min</strong>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* AI Setup integration — gated by the ai_task_setup capability.
                    On Free it renders locked + opens the upgrade prompt. */}
                {onRequestAISetup && !aiSetupEnabled && (
                  <button
                    type="button"
                    onClick={() => promptUpgrade('AI task setup is a Pro feature.')}
                    className="fb-btn-surface w-full px-3 py-2.5 text-left"
                    data-testid="ai-setup-locked"
                  >
                    <div className="text-xs font-medium text-[var(--ink-70)] flex items-center gap-1.5">
                      <Icon name="lock" size={13} className="text-accent" />
                      Have AI suggest the setup
                      <span className="ml-auto text-[9px] uppercase tracking-wider text-accent">Pro</span>
                    </div>
                    <div className="text-[11px] text-[var(--ink-50)] mt-0.5">
                      Upgrade to let the assistant propose widgets, browsers and notes for this Desk.
                    </div>
                  </button>
                )}
                {onRequestAISetup && aiSetupEnabled && (
                  <div className="rounded-lg border border-[rgb(var(--accent)/0.25)] bg-[rgb(var(--accent)/0.08)] px-3 py-2.5">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={autoSuggestAI}
                        onChange={(e) => setAutoSuggestAI(e.target.checked)}
                        className="mt-0.5 h-3.5 w-3.5 accent-[rgb(var(--accent))] cursor-pointer"
                      />
                      <div className="flex-1">
                        <div className="text-xs font-medium text-[var(--ink-100)] flex items-center gap-1.5">
                          <Icon name="auto_awesome" size={14} className="text-[rgb(var(--accent))]" />
                          Have AI suggest the setup
                        </div>
                        <div className="text-[11px] text-[var(--ink-70)] mt-0.5">
                          After creating, the assistant proposes widgets, browsers and notes that fit this Desk.
                        </div>
                      </div>
                    </label>
                  </div>
                )}
              </aside>
            </div>
          ) : (
            /* Edit mode and Rooms: a single calm column — fewer fields, same law. */
            <div className="px-6 py-5 space-y-5">
              <FormField label="Notes" hint="(optional)">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder="Anything to remember about this…"
                  className={`${fieldInputClass()} resize-none`}
                />
              </FormField>

              {effectiveKind === 'task' && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <AxisPicker label="Urgency" hint="whenever → urgent" value={priority} onChange={setPriority} />
                    <AxisPicker label="Importance" hint="low → high stakes" value={importance} onChange={setImportance} />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <FormField label="Duration" hint="(minutes)">
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        value={estimateMinutes}
                        onChange={(e) => setEstimateMinutes(e.target.value)}
                        placeholder="e.g. 30"
                        className={fieldInputClass()}
                      />
                    </FormField>
                    <FormField label="Due date" hint="(optional)">
                      <div className="flex gap-1.5">
                        <input
                          type="date"
                          value={dueDate}
                          onChange={(e) => setDueDate(e.target.value)}
                          className={`${fieldInputClass()} flex-1 [color-scheme:light] dark:[color-scheme:dark]`}
                        />
                        {dueDate && (
                          <button
                            type="button"
                            onClick={() => setDueDate('')}
                            className="icon-btn"
                            title="Clear due date"
                          >
                            <Icon name="close" size={14} />
                          </button>
                        )}
                      </div>
                    </FormField>
                  </div>

                  {velocity && (
                    <div className="px-3 py-2 rounded-lg bg-[var(--surface-sunken)] text-[11px] text-[var(--ink-90)] flex items-start gap-2">
                      <Icon name="insights" size={13} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                      <div>
                        <div>
                          <strong>Your history:</strong> {Math.round(velocity.ratio * 100)}% of estimates
                          <span className="text-[var(--ink-50)]"> (n={velocity.sampleCount})</span>
                        </div>
                        {estimateMinutes.trim() !== '' && parseInt(estimateMinutes, 10) > 0 && (
                          <div className="mt-0.5">
                            Predicted real time:{' '}
                            <strong>{predictForEstimate(velocity, parseInt(estimateMinutes, 10))} min</strong>
                          </div>
                        )}
                        {estimateMinutes.trim() === '' && (
                          <div className="mt-0.5">
                            Median Desk takes <strong>{Math.round(velocity.medianActualMin)} min</strong>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {onRequestAISetup && !aiSetupEnabled && (
                    <button
                      type="button"
                      onClick={() => promptUpgrade('AI task setup is a Pro feature.')}
                      className="fb-tile w-full px-3 py-2.5 text-left"
                      data-testid="ai-setup-locked"
                    >
                      <div className="text-xs font-medium text-[var(--ink-70)] flex items-center gap-1.5">
                        <Icon name="lock" size={13} className="text-accent" />
                        Have AI suggest the setup
                        <span className="ml-auto text-[9px] uppercase tracking-wider text-accent">Pro</span>
                      </div>
                      <div className="text-[11px] text-[var(--ink-50)] mt-0.5">
                        Upgrade to let the assistant propose widgets, browsers and notes for this Desk.
                      </div>
                    </button>
                  )}
                  {onRequestAISetup && aiSetupEnabled && isEdit && node && (
                    <div className="rounded-lg border border-[rgb(var(--accent)/0.25)] bg-[rgb(var(--accent)/0.08)] px-3 py-1">
                      <button
                        type="button"
                        onClick={() => {
                          onClose()
                          onRequestAISetup(node)
                        }}
                        className="w-full flex items-center justify-center gap-1.5 text-xs font-medium text-[rgb(var(--accent))] hover:bg-[rgb(var(--accent)/0.08)] transition-colors rounded py-1.5"
                      >
                        <Icon name="auto_awesome" size={14} />
                        <span>Suggest more setup with AI</span>
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-3.5 border-t border-[var(--edge-soft)] bg-[var(--surface-sunken)] flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-[var(--ink-40)] hidden sm:block">
            {composer ? 'Your new Desk opens as soon as it is created.' : ''}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
            <button type="submit" disabled={!title.trim() || busy} className="btn-primary">
              {busy ? (
                <>
                  <Icon name="hourglass_top" size={14} />
                  <span>{isEdit ? 'Saving…' : 'Creating…'}</span>
                </>
              ) : (
                <>
                  <Icon name={submitIcon} size={14} />
                  <span>{submitLabel}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </motion.form>
    </motion.div>,
    document.body
  )
}
