import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FbNode, Widget } from '@shared/types'
import { useNodeStore } from '../stores/nodes'
import { useWidgetStore } from '../stores/widgets'
import Icon from './Icon'
import Modal from './plexi/Modal'

// "Make this a task" dialog — invoked from a widget or section's right-click
// context menu. Lets the user create a task in an existing folder OR in a
// brand-new folder, with the task title pre-filled from whatever the user
// right-clicked. Portalled into document.body so the canvas's stacking
// contexts can't trap it behind sibling widgets.

interface Props {
  // Pre-filled task title — usually the widget/section's display name or a
  // first-line summary of its content. The user can edit before saving.
  seedTitle: string
  // Optional default parent folder — when the right-click happened inside
  // a context that already implies a folder (e.g. a section that was
  // dragged from a folder view). Falls back to the first folder in the
  // sidebar or to "create new" if none exist yet.
  defaultParentId?: string | null
  // The widget the user right-clicked to open this dialog. When set, we
  // surface a checkbox that lets them clone the widget into the new task
  // after creation — useful for "promote this thing I'm working on to a
  // proper task" flows where the widget is the genesis of the task.
  sourceWidget?: Widget | null
  onClose: () => void
}

const NEW_FOLDER_VALUE = '__new__'

export default function MakeTaskDialog({
  seedTitle,
  defaultParentId,
  sourceWidget,
  onClose
}: Props): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const create = useNodeStore((s) => s.create)
  const setActiveTask = useNodeStore((s) => s.setActive)
  const createWidget = useWidgetStore((s) => s.create)
  const updateWidget = useWidgetStore((s) => s.update)
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const folders = useMemo(
    () => nodes.filter((n) => n.kind === 'folder'),
    [nodes]
  )
  // The folder the user is currently working in = the active task's parent.
  // This is what we default the picker to (the operator's explicit ask).
  const currentFolderId = useMemo(() => {
    const task = nodes.find((n) => n.id === activeTaskId)
    const pid = task?.parentId ?? null
    return pid && folders.some((f) => f.id === pid) ? pid : null
  }, [nodes, activeTaskId, folders])

  const [taskTitle, setTaskTitle] = useState(seedTitle.trim() || 'Untitled desk')
  const [folderQuery, setFolderQuery] = useState('')
  // Default to ON when a source widget was passed — almost always what the
  // user wants from a right-click "make this a task" flow. They can untick
  // if they just want the task and the widget should stay on the current
  // canvas (e.g. a sticky that's a reference, not the task itself).
  const [copyWidget, setCopyWidget] = useState<boolean>(!!sourceWidget)
  // When copying the widget across, default to a LIVE-synced copy (autolinked) —
  // the user can choose an independent point-in-time copy instead. This is the
  // explicit "copy vs sync" choice; synced is the default so edits mirror unless
  // the user opts out.
  const [syncCopy, setSyncCopy] = useState<boolean>(true)
  const [switchToNewTask, setSwitchToNewTask] = useState<boolean>(!!sourceWidget)
  // Default the selector to the supplied parent if it's a real folder,
  // otherwise the first existing folder, otherwise the "new folder" path.
  const [folderSel, setFolderSel] = useState<string>(() => {
    // Default order: explicit prop → the current folder (active task's parent)
    // → first folder → create-new.
    if (defaultParentId && folders.some((f) => f.id === defaultParentId)) {
      return defaultParentId
    }
    const task = nodes.find((n) => n.id === activeTaskId)
    const pid = task?.parentId ?? null
    if (pid && folders.some((f) => f.id === pid)) return pid
    if (folders.length > 0) return folders[0].id
    return NEW_FOLDER_VALUE
  })
  const [newFolderName, setNewFolderName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Where this task goes.
  //
  // A desk and a task are the same node kind here, and the difference is where
  // it sits: a top-level one gets its own canvas and shows up in the sidebar as
  // a desk. This dialog used to make one of those EVERY time, so "make a task
  // from this" quietly produced a new desk on each use and the sidebar filled
  // with them. Adding it to the desk you are on is what people mean almost
  // always; a new desk is now something you ask for.
  const activeDesk = useMemo(
    () => nodes.find((n) => n.id === activeTaskId && n.kind === 'task') ?? null,
    [nodes, activeTaskId]
  )
  const [placement, setPlacement] = useState<'thisDesk' | 'newDesk'>(
    activeDesk ? 'thisDesk' : 'newDesk'
  )

  async function handleSubmit(): Promise<void> {
    if (busy) return
    const title = taskTitle.trim()
    if (!title) {
      setError('Give the task a title.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      // A task on the desk you are looking at: a child of it, not a new canvas.
      if (placement === 'thisDesk' && activeDesk) {
        const newTask = await create({
          parentId: activeDesk.id,
          kind: 'task',
          title
        } as Parameters<typeof create>[0])
        onClose()
        void newTask
        return
      }
      let parentId: string
      if (folderSel === NEW_FOLDER_VALUE) {
        const folderName = newFolderName.trim()
        if (!folderName) {
          setError('Give the new folder a name.')
          setBusy(false)
          return
        }
        const folder = await create({
          parentId: null,
          kind: 'folder',
          title: folderName
        } as Parameters<typeof create>[0])
        parentId = folder.id
      } else {
        parentId = folderSel
      }
      const newTask = await create({
        parentId,
        kind: 'task',
        title
      } as Parameters<typeof create>[0])
      // If the user opted in (default when a source widget was supplied),
      // clone the widget into the new task. We use the widget store's
      // create() rather than IPC-level copy because it includes optimistic
      // updates + activity log entries. Fresh canvas position so the clone
      // doesn't collide with the original's stored x/y if the user happens
      // to land on the new task quickly.
      if (sourceWidget && copyWidget) {
        // SYNCED copy → share a syncGroupId so edits mirror across the two
        // tasks (tick a checkbox / rename here → it mirrors there). Reuse the
        // source's group or create one and tag the source too.
        // INDEPENDENT copy → no syncGroupId: a point-in-time snapshot that
        // never affects (or is affected by) the source.
        let groupId: string | undefined
        if (syncCopy) {
          groupId = sourceWidget.syncGroupId ?? crypto.randomUUID()
          if (!sourceWidget.syncGroupId) {
            await updateWidget(sourceWidget.id, { syncGroupId: groupId })
          }
        }
        await createWidget({
          taskId: newTask.id,
          kind: sourceWidget.kind,
          title: sourceWidget.title,
          content: sourceWidget.content,
          x: 80,
          y: 80,
          width: sourceWidget.width,
          height: sourceWidget.height,
          color: sourceWidget.color,
          sourceAppId: sourceWidget.sourceAppId,
          mode: sourceWidget.mode,
          syncGroupId: groupId
        })
      }
      // Switch the active task so the user lands on the new task they
      // just created. Off by default unless a widget was being promoted —
      // matches the "ok this is now my next thing to work on" intent.
      if (switchToNewTask) {
        setActiveTask(newTask.id)
      }
      onClose()
    } catch (e) {
      setError((e as Error).message ?? 'Failed to create desk')
      setBusy(false)
    }
  }

  return createPortal(
    <Modal
      onClose={onClose}
      label="Make this a desk"
      z={250}
      className="fb-card w-[380px] p-4"
    >
        <div className="flex items-center gap-1.5 mb-3">
          <Icon name="task_alt" size={16} className="text-accent" />
          <h2 className="text-sm font-semibold text-[var(--ink-100)]">
            Make this a desk
          </h2>
        </div>
        <div className="space-y-3">
          <div>
            {/* A <label> with no htmlFor names nothing: the control was reaching
                assistive technology unnamed, with only a placeholder. */}
            <label
              htmlFor="make-desk-title"
              className="block text-[10px] uppercase tracking-wider text-[var(--ink-50)] mb-1"
            >
              Task title
            </label>
            <input
              id="make-desk-title"
              autoFocus
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSubmit()
              }}
              className="fb-field w-full text-sm px-2.5 py-1.5 bg-[var(--surface-raised)] text-[var(--ink-100)]"
              placeholder="What is the desk for?"
            />
          </div>
          {activeDesk && (
            <div role="group" aria-labelledby="make-task-placement-label">
              <label
                id="make-task-placement-label"
                className="block text-[10px] uppercase tracking-wider text-[var(--ink-50)] mb-1"
              >
                Add it
              </label>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setPlacement('thisDesk')}
                  data-testid="make-task-this-desk"
                  className={`flex-1 rounded-md border px-2 py-1.5 text-left text-[11px] ${
                    placement === 'thisDesk'
                      ? 'border-accent bg-accent/10 text-[var(--ink-90)]'
                      : 'border-[var(--line)] text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'
                  }`}
                >
                  <span className="block font-medium">To this desk</span>
                  <span className="block truncate text-[10px] text-[var(--ink-45)]">
                    {activeDesk.title || 'Untitled desk'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setPlacement('newDesk')}
                  data-testid="make-task-new-desk"
                  className={`flex-1 rounded-md border px-2 py-1.5 text-left text-[11px] ${
                    placement === 'newDesk'
                      ? 'border-accent bg-accent/10 text-[var(--ink-90)]'
                      : 'border-[var(--line)] text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]'
                  }`}
                >
                  <span className="block font-medium">As a new desk</span>
                  <span className="block text-[10px] text-[var(--ink-45)]">
                    Its own canvas
                  </span>
                </button>
              </div>
            </div>
          )}

          {placement === 'newDesk' && (
          <div role="group" aria-labelledby="make-desk-folder-label">
            <label
              id="make-desk-folder-label"
              className="block text-[10px] uppercase tracking-wider text-[var(--ink-50)] mb-1"
            >
              Folder
            </label>
            {folderSel === NEW_FOLDER_VALUE ? (
              <div className="space-y-1.5">
                <input
                  autoFocus
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleSubmit()
                  }}
                  aria-label="New folder name"
                  placeholder="New folder name — e.g. Q3 outreach"
                  className="fb-field w-full text-sm px-2.5 py-1.5 bg-[var(--surface-raised)] text-[var(--ink-100)]"
                />
                <button
                  type="button"
                  onClick={() => setFolderSel(currentFolderId || folders[0]?.id || NEW_FOLDER_VALUE)}
                  className="text-[11px] text-[var(--ink-50)] hover:text-[var(--ink-70)]"
                >
                  ← Pick an existing folder
                </button>
              </div>
            ) : (
              <div>
                <input
                  value={folderQuery}
                  onChange={(e) => setFolderQuery(e.target.value)}
                  aria-label="Search folders"
                  placeholder="Search folders…"
                  className="fb-field w-full text-sm px-2.5 py-1.5 bg-[var(--surface-raised)] text-[var(--ink-100)]"
                />
                <div className="mt-1 max-h-40 overflow-auto rounded bg-[var(--surface-sunken)]">
                  {folders
                    .filter((f: FbNode) =>
                      (f.title || '').toLowerCase().includes(folderQuery.trim().toLowerCase())
                    )
                    .map((f: FbNode) => (
                      <button
                        type="button"
                        key={f.id}
                        onClick={() => setFolderSel(f.id)}
                        className={`w-full text-left px-2.5 py-1.5 text-sm flex items-center justify-between gap-2 ${
                          folderSel === f.id
                            ? 'bg-accent/15 text-accent'
                            : 'text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]'
                        }`}
                      >
                        <span className="truncate">{f.title || '(untitled folder)'}</span>
                        {f.id === currentFolderId && (
                          <span className="text-[9px] uppercase tracking-wider text-[var(--ink-40)] shrink-0">
                            current
                          </span>
                        )}
                      </button>
                    ))}
                  {folders.filter((f: FbNode) =>
                    (f.title || '').toLowerCase().includes(folderQuery.trim().toLowerCase())
                  ).length === 0 && (
                    <div className="px-2.5 py-1.5 text-[11px] text-[var(--ink-40)]">No folders match.</div>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setFolderSel(NEW_FOLDER_VALUE)
                      if (folderQuery.trim()) setNewFolderName(folderQuery.trim())
                    }}
                    className="w-full text-left px-2.5 py-1.5 text-sm text-accent border-t border-[var(--edge-soft)] hover:bg-accent/5"
                  >
                    + Create new folder{folderQuery.trim() ? ` "${folderQuery.trim()}"` : '…'}
                  </button>
                </div>
              </div>
            )}
          </div>
          )}
          {sourceWidget && placement === 'newDesk' && (
            <div className="pt-1 border-t border-[var(--edge-soft)] space-y-1.5">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={copyWidget}
                  onChange={(e) => setCopyWidget(e.target.checked)}
                  className="mt-0.5 accent-accent"
                />
                <div className="flex-1">
                  <div className="text-[12px] text-[var(--ink-90)]">
                    Copy this widget into the new desk
                  </div>
                  <div className="text-[10px] text-[var(--ink-50)] leading-tight">
                    Bring this widget onto the new desk. Choose whether it stays in sync or becomes its own copy.
                  </div>
                </div>
              </label>
              {copyWidget && (
                <div className="ml-6 space-y-1.5 pl-0.5 border-l-2 border-[var(--edge-soft)]">
                  <label className="flex items-start gap-2 cursor-pointer pl-2">
                    <input
                      type="radio"
                      name="fb-copy-mode"
                      checked={syncCopy}
                      onChange={() => setSyncCopy(true)}
                      className="mt-0.5 accent-accent"
                    />
                    <div className="flex-1">
                      <div className="text-[12px] text-[var(--ink-90)]">
                        🔗 Keep in sync <span className="text-[var(--ink-40)]">(live)</span>
                      </div>
                      <div className="text-[10px] text-[var(--ink-50)] leading-tight">
                        Content, title and colour mirror both ways. Unlink anytime from the widget menu.
                      </div>
                    </div>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer pl-2">
                    <input
                      type="radio"
                      name="fb-copy-mode"
                      checked={!syncCopy}
                      onChange={() => setSyncCopy(false)}
                      className="mt-0.5 accent-accent"
                    />
                    <div className="flex-1">
                      <div className="text-[12px] text-[var(--ink-90)]">
                        Independent copy <span className="text-[var(--ink-40)]">(point-in-time)</span>
                      </div>
                      <div className="text-[10px] text-[var(--ink-50)] leading-tight">
                        A snapshot of the current state. The two never affect each other.
                      </div>
                    </div>
                  </label>
                </div>
              )}
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={switchToNewTask}
                  onChange={(e) => setSwitchToNewTask(e.target.checked)}
                  className="mt-0.5 accent-accent"
                />
                <div className="flex-1">
                  <div className="text-[12px] text-[var(--ink-90)]">
                    Switch to the new desk
                  </div>
                  <div className="text-[10px] text-[var(--ink-50)] leading-tight">
                    Otherwise it just appears in your sidebar — you'll stay on the current desk.
                  </div>
                </div>
              </label>
            </div>
          )}
          {error && (
            <div className="text-[11px] text-red-600 dark:text-red-400">{error}</div>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={busy}
            className="text-xs px-3 py-1.5 rounded bg-accent text-white hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? 'Creating…' : 'Create task'}
          </button>
        </div>
    </Modal>,
    document.body
  )
}
