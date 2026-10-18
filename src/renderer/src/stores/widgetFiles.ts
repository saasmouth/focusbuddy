// Widget files in the renderer — docs/widget-files.md.
//
// A widget file is a widget with no desk. This store holds the files that are
// open (the full-pane view reads from it), and owns the gestures that create
// and place them, so the side menu, the canvas drop, the command palette and
// the widget menu all make the same thing the same way.
//
// The full-pane widget is a synthetic Widget whose id is `wf:<file id>`. The
// widget store routes any update or delete for such an id here (see
// stores/widgets.ts), which is what lets every widget component work full-pane
// without knowing it has no desk.

import { create } from 'zustand'
import type { Widget, WidgetFile, WidgetFilePatch, WidgetKind, WidgetPatch } from '@shared/types'
import {
  isStandaloneWidgetKind,
  widgetFileGroupId,
  widgetFileIdFromGroup,
  widgetFileTypeLabel
} from '@shared/widgetFiles'
import { catalogFor } from '../lib/widgetCatalog'
import { useWidgetStore } from './widgets'
import { useViewStore } from './view'
import { useNodeStore } from './nodes'
import { useDocumentsStore } from './documents'
import { useNoticeStore } from './notice'
import { nudgeSync } from '../lib/syncNudge'
import { recordAction } from './actionHistory'
import { fitNewWidgetToView } from '../lib/fitDroppedWidget'

interface WidgetFilesState {
  /** Files loaded into this window, by id. */
  files: Record<string, WidgetFile>
  /** Fetch (and cache) one file. Null when it no longer exists. */
  load: (id: string) => Promise<WidgetFile | null>
  /**
   * Create a standalone file of `kind`. Opens it full-pane unless `open` is
   * false. Never leaves it "Untitled": main names it from its content or gives
   * it a dated placeholder the naming pass replaces later.
   */
  create: (
    kind: WidgetKind,
    opts?: { open?: boolean; title?: string; content?: string; parentId?: string | null }
  ) => Promise<WidgetFile | null>
  /** Patch a file; mirrors to any of its instances on the open desk. */
  update: (id: string, patch: WidgetFilePatch) => Promise<WidgetFile | null>
  /** Rename by a person: the name becomes theirs. */
  rename: (id: string, title: string) => Promise<void>
  /** Move to the Documents Trash, with Undo. */
  trash: (id: string) => Promise<boolean>
  /**
   * Several files at once (a multi-selection's "Delete N work widgets"): one
   * notice, one Undo and one undo step for the lot. Resolves with how many
   * went to Trash.
   */
  trashMany: (ids: string[]) => Promise<number>
  /** Place a LINKED instance of an existing file on a desk. */
  place: (
    id: string,
    taskId: string,
    at?: { x?: number; y?: number; width?: number; height?: number }
  ) => Promise<Widget | null>
  /** Create a new file of `kind` and place it on a desk in one gesture. */
  createAndPlace: (
    kind: WidgetKind,
    taskId: string,
    at?: { x?: number; y?: number; width?: number; height?: number }
  ) => Promise<{ file: WidgetFile; widget: Widget | null } | null>
  /** "Save as file" for a desk widget. */
  promote: (widgetId: string) => Promise<WidgetFile | null>
}

function remember(file: WidgetFile | null): void {
  if (!file) return
  useWidgetFilesStore.setState((s) => ({ files: { ...s.files, [file.id]: file } }))
  // The documents list is what the tray, mentions and pickers name documents
  // from; keep the file's row in it current without a full (cloud-pulling)
  // refresh, so a new or renamed file never shows as "Document".
  const docs = useDocumentsStore.getState()
  const meta = {
    id: file.id,
    docType: 'widget' as const,
    title: file.title,
    archived: false,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    widgetKind: file.kind
  }
  useDocumentsStore.setState({ list: [meta, ...docs.list.filter((d) => d.id !== file.id)] })
}

function forget(id: string): void {
  const docs = useDocumentsStore.getState()
  if (docs.list.some((d) => d.id === id)) useDocumentsStore.setState({ list: docs.list.filter((d) => d.id !== id) })
}

/** Put a freshly created instance into the open desk, as a create would. */
function adoptInstance(widget: Widget | null): void {
  if (!widget) return
  const ws = useWidgetStore.getState()
  if (ws.widgets.some((w) => w.id === widget.id)) return
  // Only when that desk is the one loaded; otherwise it appears when opened.
  if (widget.taskId !== useNodeStore.getState().activeTaskId) return
  useWidgetStore.setState({ widgets: [...ws.widgets, widget] })
  ws.setActive(widget.id)
  ws.bumpLayoutVersion()
}

/** Mirror a file's synced fields into its instances on the open desk. */
function mirrorToInstances(fileId: string, fields: Partial<Pick<Widget, 'content' | 'title' | 'color'>>): void {
  const sgid = widgetFileGroupId(fileId)
  const ws = useWidgetStore.getState()
  if (!ws.widgets.some((w) => w.syncGroupId === sgid)) return
  useWidgetStore.setState({
    widgets: ws.widgets.map((w) => (w.syncGroupId === sgid ? { ...w, ...fields } : w))
  })
}

/** Take a trashed file's instances off the open desk, as main took them off every desk. */
function dropInstancesFromOpenDesk(fileId: string): void {
  const sgid = widgetFileGroupId(fileId)
  const ws = useWidgetStore.getState()
  if (!ws.widgets.some((w) => w.syncGroupId === sgid)) return
  useWidgetStore.setState({ widgets: ws.widgets.filter((w) => w.syncGroupId !== sgid) })
  ws.bumpLayoutVersion()
}

/** After a restore, bring the open desk's restored instances back without a blink. */
async function reloadOpenDeskInstances(): Promise<void> {
  const taskId = useNodeStore.getState().activeTaskId
  if (taskId) await useWidgetStore.getState().loadForTask(taskId, { refresh: true })
}

/**
 * A desk instance's size, capped to the view the same way every other new
 * widget is (fitNewWidgetToView — the one place a new widget is fitted). An
 * instance is created in main, not through the widget store's create, so the
 * cap is applied here rather than at each drop site.
 */
function fitInstance(
  kind: WidgetKind,
  at: { x?: number; y?: number; width?: number; height?: number }
): { x?: number; y?: number; width?: number; height?: number } {
  const entry = catalogFor(kind)
  const draft = { kind, x: at.x, y: at.y, width: at.width ?? entry?.defaultWidth, height: at.height ?? entry?.defaultHeight }
  const sized = fitNewWidgetToView(draft, (k) => {
    const e = catalogFor(k as WidgetKind)
    return e ? { width: e.defaultWidth, height: e.defaultHeight } : null
  })
  return { x: sized.x, y: sized.y, width: sized.width, height: sized.height }
}

function kindLabel(kind: WidgetKind): string {
  return catalogFor(kind)?.label ?? widgetFileTypeLabel(kind)
}

export const useWidgetFilesStore = create<WidgetFilesState>((set, get) => ({
  files: {},

  load: async (id) => {
    const file = await window.api.widgetFiles.get(id)
    if (file) remember(file)
    else
      set((s) => {
        const next = { ...s.files }
        delete next[id]
        return { files: next }
      })
    return file
  },

  create: async (kind, opts = {}) => {
    if (!isStandaloneWidgetKind(kind)) return null
    const entry = catalogFor(kind)
    try {
      const file = await window.api.widgetFiles.create(
        { kind, title: opts.title, content: opts.content, parentId: opts.parentId ?? null },
        { defaultContent: entry?.defaultContent ?? '' }
      )
      remember(file)
      nudgeSync()
      if (opts.open !== false) useViewStore.getState().goDocument(file.id)
      return file
    } catch (e) {
      useNoticeStore.getState().show({
        text: `Could not create the ${kindLabel(kind).toLowerCase()}: ${e instanceof Error ? e.message : 'unknown error'}`,
        icon: 'error'
      })
      return null
    }
  },

  update: async (id, patch) => {
    const prev = get().files[id]
    if (prev) {
      // Optimistic, as a desk widget's update is: the pane re-renders on the
      // keystroke, not on the IPC round trip.
      remember({
        ...prev,
        content: patch.content ?? prev.content,
        color: patch.color !== undefined ? patch.color : prev.color,
        title: patch.title?.trim() ? patch.title.trim() : prev.title,
        updatedAt: Date.now()
      })
    }
    const file = await window.api.widgetFiles.update(id, patch)
    if (!file) return null
    remember(file)
    mirrorToInstances(id, {
      ...(patch.content !== undefined ? { content: file.content } : {}),
      ...(patch.color !== undefined ? { color: file.color } : {}),
      // Always carry the title: a content edit can NAME the file (placeholder
      // → derived), and the instance headers should show it at once.
      title: file.title
    })
    nudgeSync()
    return file
  },

  rename: async (id, title) => {
    const t = title.trim()
    if (!t) return
    await get().update(id, { title: t })
  },

  trash: async (id) => (await get().trashMany([id])) > 0,

  trashMany: async (ids) => {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return 0
    // Deleting a file takes every desk instance with it (main does that, in
    // trashDocument). Count the desks first so the notice can say so.
    const names: string[] = []
    const desks = new Set<string>()
    const done: string[] = []
    for (const id of unique) {
      const file = get().files[id] ?? (await get().load(id))
      let on: string[] = []
      try {
        on = (await window.api.widgetFiles.instances(id)).map((w) => w.taskId)
      } catch {
        /* the count is only for the notice */
      }
      if (!(await window.api.widgetFiles.trash(id))) continue
      for (const t of on) desks.add(t)
      done.push(id)
      names.push(file?.title ?? 'Work widget')
      forget(id)
      dropInstancesFromOpenDesk(id)
    }
    if (done.length === 0) return 0
    // …and re-read the open desk, in case its copy of a widget predates the
    // link (the launch backfill files widgets under an already-open desk).
    void reloadOpenDeskInstances()
    nudgeSync()
    const view = useViewStore.getState().view
    if (view.kind === 'document' && done.includes(view.documentId)) useViewStore.getState().back()
    const restoreAll = async (): Promise<void> => {
      // Restoring a file puts its instances back where they were.
      for (const id of done) await window.api.documents.restore(id)
      nudgeSync()
      for (const id of done) void get().load(id)
      await reloadOpenDeskInstances()
    }
    // Cmd-Z reaches it too (and an assistant "Apply all" folds it into its one
    // undo step); the notice below carries the visible Undo.
    recordAction({
      label: done.length === 1 ? `Delete “${names[0]}”` : `Delete ${done.length} work widgets`,
      undo: restoreAll,
      redo: async () => {
        for (const id of done) {
          await window.api.widgetFiles.trash(id)
          forget(id)
          dropInstancesFromOpenDesk(id)
        }
        nudgeSync()
      }
    })
    const n = desks.size
    const onDesks = n > 0 ? ` and removed from ${n} desk${n === 1 ? '' : 's'}` : ''
    useNoticeStore.getState().show({
      text:
        done.length === 1
          ? `“${names[0]}” moved to Trash${onDesks}`
          : `${done.length} work widgets moved to Trash${onDesks}`,
      icon: 'delete',
      action: { label: 'Undo', run: () => void restoreAll() }
    })
    return done.length
  },

  place: async (id, taskId, at = {}) => {
    const file = get().files[id] ?? (await get().load(id))
    const sized = file ? fitInstance(file.kind, at) : at
    const widget = await window.api.widgetFiles.place(id, { taskId, ...sized })
    if (!widget) {
      useNoticeStore.getState().show({ text: 'That work widget file no longer exists.', icon: 'error' })
      return null
    }
    adoptInstance(widget)
    nudgeSync()
    return widget
  },

  createAndPlace: async (kind, taskId, at = {}) => {
    if (!isStandaloneWidgetKind(kind)) return null
    const entry = catalogFor(kind)
    const res = await window.api.widgetFiles.createAndPlace(
      { kind },
      { taskId, ...fitInstance(kind, at) },
      { defaultContent: entry?.defaultContent ?? '' }
    )
    remember(res.file)
    adoptInstance(res.widget)
    nudgeSync()
    return res
  },

  promote: async (widgetId) => {
    const file = await window.api.widgetFiles.promote(widgetId)
    if (!file) {
      useNoticeStore.getState().show({ text: 'This work widget only works on a desk, so it cannot be saved as a file.', icon: 'info' })
      return null
    }
    remember(file)
    // Every in-store widget that was linked to this one now belongs to the file.
    const ws = useWidgetStore.getState()
    const target = ws.widgets.find((w) => w.id === widgetId)
    const oldGroup = target?.syncGroupId ?? null
    const sgid = widgetFileGroupId(file.id)
    useWidgetStore.setState({
      widgets: ws.widgets.map((w) =>
        w.id === widgetId || (oldGroup && w.syncGroupId === oldGroup)
          ? { ...w, syncGroupId: sgid, title: w.title || file.title }
          : w
      )
    })
    nudgeSync()
    useNoticeStore.getState().show({
      text: `Saved to Files as “${file.title}”`,
      icon: 'folder',
      action: { label: 'Open', run: () => useViewStore.getState().goDocument(file.id) }
    })
    return file
  }
}))

/**
 * The widget store's hook for the full-pane widget (id `wf:<file id>`): a widget
 * component calling update() on it lands here.
 */
export async function updateWidgetFileFromPane(paneId: string, patch: WidgetPatch): Promise<void> {
  const fileId = widgetFileIdFromGroup(paneId)
  if (!fileId) return
  const p: WidgetFilePatch = {}
  if (patch.content !== undefined) p.content = patch.content
  if (patch.title !== undefined) p.title = patch.title
  if (patch.color !== undefined) p.color = patch.color
  if (Object.keys(p).length === 0) return
  await useWidgetFilesStore.getState().update(fileId, p)
}

/** The file a desk widget is an instance of, or null. */
export function fileIdOfWidget(w: Pick<Widget, 'syncGroupId'> | null | undefined): string | null {
  return widgetFileIdFromGroup(w?.syncGroupId ?? null)
}
