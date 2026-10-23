// Files beside your work: the compact browser that flies out of the side
// menu (FilesDock) or floats (FilesFloat). Its folder, selection and search
// are the 'panel' browser (stores/fileManager useFilesPanelBrowser), so the
// flyout and the float share them, and opening Files full screen or clicking
// a Drive work widget never moves the panel.
//
// Everything in it is a drag source: rows carry the one Files payload
// (lib/filesDrag), which the desk, the Workcentre, Files folders, Drive work
// widgets and the existing document and work widget targets all read.
//
// Keyboard (listbox, roving tabindex): ↑/↓ move, ⇧↑/⇧↓ extend, → or Enter
// opens a folder, ← or ⌫ goes up, Enter opens a file, ⌘↓ is an alias, typing
// jumps by name, Space previews, ⌘⏎ adds the selection to the open desk (the
// drag alternative, WCAG 2.5.7), Esc clears the search or closes the flyout.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@shared/fields'
import Icon from '../Icon'
import CanvasContextMenu, { type CtxMenuItem } from '../CanvasContextMenu'
import { useFileManagerStore, useFilesPanelBrowser, sortEntries } from '../../stores/fileManager'
import { useFilesPanelStore } from '../../stores/filesPanel'
import { useViewStore } from '../../stores/view'
import { useNodeStore } from '../../stores/nodes'
import { useOrgStore } from '../../stores/org'
import { useNoticeStore } from '../../stores/notice'
import { useThumbnail, previewable } from '../../lib/fileThumbnail'
import { fileTypeIcon, fileTypeLabel, isWidgetFileEntry } from '../../lib/fileEntryType'
import {
  ENTRY_DRAG_MIME,
  FILES_DRAG_MIME,
  readFilesDrag,
  refFromEntry,
  refsForDragStart,
  setFilesDragImage,
  writeFilesDrag,
  type FileDragRef
} from '../../lib/filesDrag'
import { moveFilesInto, placeFilesOnDesk } from '../../lib/filesDrop'
import { nextSelection, stepSelection } from '../../lib/filesSelection'
import { filesUndoAction } from '../../lib/filesUndoScope'
import { confirmTrashWidgetFile } from '../../lib/widgetRemoval'
import { spawnPositionFor } from '../../lib/spawnPosition'
import { catalogFor } from '../../lib/widgetCatalog'
import { exceedsSyncLimit } from '@shared/fileSyncLimits'

export type FilesPanelHost = 'flyout' | 'float'

/** Hover a folder this long during a drag and it opens, so you can drop deeper. */
export const SPRING_LOAD_MS = 700

function formatSize(e: FileEntry): string {
  if (e.kind === 'folder') return e.childCount === 1 ? '1 item' : `${e.childCount ?? 0} items`
  if (e.kind === 'doc') return fileTypeLabel(e)
  const b = e.sizeBytes ?? 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** Every control in the panel carries this, so the drag-region guard can find them all. */
const CONTROL = { 'data-files-panel-control': '' } as const
const ICON_BTN =
  'inline-flex items-center justify-center h-7 w-7 rounded-md text-[var(--ink-50)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent)/0.6)] disabled:opacity-40'

const pathCache = new Map<string, string>()
function usePathLabel(parentId: string | null | undefined, want: boolean): string | null {
  const key = parentId ?? ''
  const [label, setLabel] = useState<string | null>(() => (want ? (pathCache.get(key) ?? null) : null))
  useEffect(() => {
    if (!want) return
    if (!parentId) {
      setLabel('Files')
      return
    }
    const hit = pathCache.get(key)
    if (hit) {
      setLabel(hit)
      return
    }
    let live = true
    void window.api.fileManager
      .path(parentId)
      .then((p) => {
        const v = ['Files', ...p.map((c) => c.name)].join(' › ')
        pathCache.set(key, v)
        if (live) setLabel(v)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key, parentId, want])
  return label
}

export default function FilesPanel({
  host,
  onClose,
  headerProps
}: {
  host: FilesPanelHost
  onClose: () => void
  /** The float's header is its drag handle. */
  headerProps?: React.HTMLAttributes<HTMLDivElement>
}): JSX.Element {
  const b = useFilesPanelBrowser()
  const ops = useFileManagerStore.getState
  const view = useFilesPanelStore((s) => s.view)
  const pinned = useFilesPanelStore((s) => s.pinned)
  const setView = useFilesPanelStore((s) => s.setView)
  const setPinned = useFilesPanelStore((s) => s.setPinned)
  const openFloating = useFilesPanelStore((s) => s.openFloating)
  const openBeside = useFilesPanelStore((s) => s.openBeside)
  const activeOrgId = useOrgStore((s) => s.activeOrgId)
  const viewKind = useViewStore((s) => s.view.kind)
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const deskOpen = viewKind === 'task' && !!activeTaskId
  const canUndo = useFileManagerStore((s) => s.past.length > 0)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [query, setQuery] = useState(b.search)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [ctx, setCtx] = useState<{ x: number; y: number; items: CtxMenuItem[] } | null>(null)
  const [preview, setPreview] = useState<FileEntry | null>(null)
  const [pathOpen, setPathOpen] = useState(false)
  const [dropOver, setDropOver] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const anchorRef = useRef<string | null>(null)
  const typeAhead = useRef<{ text: string; at: number }>({ text: '', at: 0 })

  // First open lists the root; later opens keep the folder the panel was in.
  useEffect(() => {
    if (!useFilesPanelBrowser.getState().started) void useFilesPanelBrowser.getState().openFolder(null)
  }, [])

  // The panel's ⌘Z: only while focus is inside it (lib/filesUndoScope), so an
  // undo meant for the document beside it is never taken.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = filesUndoAction(e, { root: rootRef.current, active: document.activeElement, fullScreen: false })
      if (!action) return
      e.preventDefault()
      void (action === 'redo' ? ops().redo() : ops().undo())
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [ops])

  // Search, debounced.
  useEffect(() => {
    const t = setTimeout(() => {
      if (query.trim() !== useFilesPanelBrowser.getState().search.trim()) void useFilesPanelBrowser.getState().runSearch(query)
    }, 150)
    return () => clearTimeout(t)
  }, [query])

  const searching = b.search.trim().length > 0
  const shown = useMemo(
    () => (searching ? b.searchResults : sortEntries(b.entries, b.sortKey, b.sortDir)),
    [searching, b.searchResults, b.entries, b.sortKey, b.sortDir]
  )
  const order = useMemo(() => shown.map((e) => e.id), [shown])
  const lookup = useCallback((id: string) => shown.find((e) => e.id === id), [shown])
  const selected = b.selectedIds
  const folderName = b.crumbs.length ? b.crumbs[b.crumbs.length - 1]!.name : 'Files'
  const parentId = b.crumbs.length > 1 ? b.crumbs[b.crumbs.length - 2]!.id : null

  const focusRow = useCallback((id: string | null) => {
    if (!id) return
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`)
      el?.focus({ preventScroll: false })
    })
  }, [])

  const openEntry = useCallback(
    (e: FileEntry) => {
      if (e.kind === 'folder') {
        setQuery('')
        useFilesPanelBrowser.getState().clearSearch()
        void useFilesPanelBrowser.getState().openFolder(e.id)
      } else if (e.kind === 'doc' && e.docId) useViewStore.getState().goDocument(e.docId)
      else void window.api.files.open(e.id)
    },
    []
  )
  const goUp = useCallback(() => {
    if (searching) return
    if (b.cwd === null) return
    void useFilesPanelBrowser.getState().openFolder(parentId)
  }, [b.cwd, parentId, searching])

  const selectionRefs = useCallback((): FileDragRef[] => {
    const ids = selected.length ? selected : b.selectedId ? [b.selectedId] : []
    return ids.map((id) => lookup(id)).filter((e): e is FileEntry => !!e).map((e) => refFromEntry(e, activeOrgId))
  }, [selected, b.selectedId, lookup, activeOrgId])

  /** ⌘⏎ and the menu's "Add to this desk": the drag alternative. */
  const addToDesk = useCallback(
    async (refs: FileDragRef[]) => {
      if (!refs.length) return
      const taskId = useNodeStore.getState().activeTaskId
      if (useViewStore.getState().view.kind !== 'task' || !taskId) {
        useNoticeStore.getState().show({ text: 'Open a desk to add these to it.', icon: 'info' })
        return
      }
      const e = catalogFor('file')
      const pos = spawnPositionFor(e?.defaultWidth ?? 360, e?.defaultHeight ?? 280)
      await placeFilesOnDesk(refs, { taskId, at: { x: pos.x + (e?.defaultWidth ?? 360) / 2, y: pos.y + 20 } })
    },
    []
  )

  function entryMenu(entry: FileEntry): CtxMenuItem[] {
    const refs = selected.includes(entry.id) && selected.length > 1 ? selectionRefs() : [refFromEntry(entry, activeOrgId)]
    const items: CtxMenuItem[] = [{ label: 'Open', icon: 'open_in_new', onClick: () => openEntry(entry) }]
    if (deskOpen) {
      items.push({
        label: refs.length > 1 ? `Add ${refs.length} items to this desk` : 'Add to this desk',
        icon: 'add_to_queue',
        onClick: () => void addToDesk(refs)
      })
    }
    items.push({
      label: 'Show in full Files',
      icon: 'open_in_full',
      onClick: () => {
        useViewStore.getState().goFiles()
        void useFileManagerStore.getState().openFolder(entry.parentId ?? null).then(() => useFileManagerStore.getState().select(entry.id))
      }
    })
    items.push({ label: 'Rename', icon: 'edit', onClick: () => setRenaming(entry.id) })
    items.push({ separator: true })
    if (isWidgetFileEntry(entry) && entry.docId) {
      const docId = entry.docId
      items.push({ label: 'Move to Trash', icon: 'delete', onClick: () => void confirmTrashWidgetFile(docId).then(() => ops().refresh()) })
    } else {
      items.push({
        label: entry.kind === 'folder' ? 'Delete folder and contents' : entry.kind === 'doc' ? 'Remove from folder' : 'Delete',
        icon: 'delete',
        onClick: () => void ops().remove(entry.id)
      })
    }
    return items
  }

  function onListKey(e: React.KeyboardEvent): void {
    if (renaming) return
    const focus = b.selectedId
    const cur = focus ? lookup(focus) : undefined
    const meta = e.metaKey || e.ctrlKey
    if (e.key === 'ArrowDown' && meta) {
      if (cur) {
        e.preventDefault()
        openEntry(cur)
      }
      return
    }
    if (e.key === 'Enter' && meta) {
      e.preventDefault()
      void addToDesk(selectionRefs())
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = stepSelection(order, selected, focus, anchorRef.current, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
      anchorRef.current = next.anchor
      useFilesPanelBrowser.getState().setSelection(next.ids, next.focus)
      focusRow(next.focus)
      return
    }
    if ((e.key === 'ArrowRight' || e.key === 'Enter') && cur) {
      if (cur.kind === 'folder' || e.key === 'Enter') {
        e.preventDefault()
        openEntry(cur)
      }
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
      e.preventDefault()
      goUp()
      return
    }
    if (e.key === ' ' && cur) {
      e.preventDefault()
      setPreview((p) => (p?.id === cur.id ? null : cur))
      return
    }
    if (e.key.length === 1 && !meta && !e.altKey && /\S/.test(e.key)) {
      const now = Date.now()
      const t = now - typeAhead.current.at < 700 ? typeAhead.current.text + e.key.toLowerCase() : e.key.toLowerCase()
      typeAhead.current = { text: t, at: now }
      const hit = shown.find((x) => x.name.toLowerCase().startsWith(t))
      if (hit) {
        useFilesPanelBrowser.getState().select(hit.id)
        anchorRef.current = hit.id
        focusRow(hit.id)
      }
    }
  }

  // Drop onto the listing background: into the panel's current folder.
  function onBackgroundDrop(e: React.DragEvent): void {
    setDropOver(null)
    if (e.defaultPrevented) return
    const r = readFilesDrag(e.dataTransfer)
    if (r.ok) {
      e.preventDefault()
      if (!searching) void moveFilesInto(r.payload.refs, b.cwd)
      return
    }
    if (!r.ok && r.reason) {
      e.preventDefault()
      useNoticeStore.getState().show({ text: r.reason, icon: 'info' })
      return
    }
    if (e.dataTransfer.files.length && !searching) {
      e.preventDefault()
      void ingestInto(e.dataTransfer.files, b.cwd)
    }
  }

  async function ingestInto(list: FileList, parent: string | null): Promise<void> {
    const payloads: Array<{ buffer: ArrayBuffer; originalName: string; mimeType: string }> = []
    for (const f of Array.from(list)) payloads.push({ buffer: await f.arrayBuffer(), originalName: f.name, mimeType: f.type || 'application/octet-stream' })
    if (payloads.length) await ops().ingestBuffers(payloads, parent)
  }

  const isGrid = view === 'grid'

  return (
    <div
      ref={rootRef}
      id="files-panel"
      data-testid="files-panel"
      data-files-panel-host={host}
      className="h-full w-full min-w-0 min-h-0 flex flex-col text-[var(--ink-100)]"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        if (preview) {
          setPreview(null)
          e.stopPropagation()
        } else if (query) {
          setQuery('')
          useFilesPanelBrowser.getState().clearSearch()
          e.stopPropagation()
        } else if (host === 'flyout' && !pinned) {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      {/* Header: the ShellSidePane header idiom (h-9), every control ≥ 24px with a label. */}
      <div
        {...headerProps}
        className={`shrink-0 h-9 flex items-center gap-0.5 pl-1.5 pr-1 border-b border-[var(--edge-soft)] min-w-0 ${headerProps?.className ?? ''}`}
        data-testid={host === 'float' ? 'files-float-header' : 'files-panel-header'}
      >
        <button
          {...CONTROL}
          type="button"
          className={ICON_BTN}
          onClick={goUp}
          disabled={b.cwd === null || searching}
          aria-label="Up one folder"
          title="Up one folder (⌫)"
          data-testid="files-panel-up"
          onDragOver={(e) => {
            if (b.cwd !== null && e.dataTransfer.types.includes(FILES_DRAG_MIME)) e.preventDefault()
          }}
          onDrop={(e) => {
            const r = readFilesDrag(e.dataTransfer)
            if (r.ok && b.cwd !== null) {
              e.preventDefault()
              void moveFilesInto(r.payload.refs, parentId)
            }
          }}
        >
          <Icon name="arrow_back" size={16} />
        </button>
        <div className="relative min-w-0 flex-1">
          <button
            {...CONTROL}
            type="button"
            onClick={() => setPathOpen((v) => !v)}
            className="fb-nav-item w-full min-w-0 h-7 px-2 gap-1 text-[12.5px] font-medium text-[var(--ink-90)]"
            aria-haspopup="menu"
            aria-expanded={pathOpen}
            aria-label={`Folder: ${folderName}. Show the folders above it`}
            data-testid="files-panel-path"
            title={['Files', ...b.crumbs.map((c) => c.name)].join(' › ')}
          >
            <Icon name="folder" size={15} filled className="shrink-0 text-accent" />
            <span className="truncate min-w-0">{searching ? 'Search results' : folderName}</span>
            <Icon name="expand_more" size={14} className="shrink-0 ml-auto text-[var(--ink-40)]" />
          </button>
          {pathOpen && (
            <PathMenu
              crumbs={b.crumbs}
              onPick={(id) => {
                setPathOpen(false)
                setQuery('')
                useFilesPanelBrowser.getState().clearSearch()
                void useFilesPanelBrowser.getState().openFolder(id)
              }}
              onClose={() => setPathOpen(false)}
            />
          )}
        </div>
        <button
          {...CONTROL}
          type="button"
          className={ICON_BTN}
          onClick={() => setView(isGrid ? 'list' : 'grid')}
          aria-label={isGrid ? 'Show as a list' : 'Show as a grid'}
          title={isGrid ? 'List' : 'Grid'}
          data-testid={isGrid ? 'files-panel-view-list' : 'files-panel-view-grid'}
        >
          <Icon name={isGrid ? 'view_list' : 'grid_view'} size={16} />
        </button>
        {host === 'flyout' && (
          <button
            {...CONTROL}
            type="button"
            className={`${ICON_BTN} ${pinned ? '!text-accent bg-[rgb(var(--accent)/0.1)]' : ''}`}
            onClick={() => setPinned(!pinned)}
            aria-pressed={pinned}
            aria-label={pinned ? 'Unpin: fly out over the content' : 'Pin beside the menu'}
            title={pinned ? 'Unpin (fly out over the content)' : 'Pin beside the menu (moves the content over)'}
            data-testid="files-panel-pin"
          >
            <Icon name="push_pin" size={15} filled={pinned} />
          </button>
        )}
        {host === 'flyout' ? (
          <button
            {...CONTROL}
            type="button"
            className={ICON_BTN}
            onClick={openFloating}
            aria-label="Float this panel"
            title="Float"
            data-testid="files-panel-float"
          >
            <Icon name="picture_in_picture_alt" size={15} />
          </button>
        ) : (
          <button
            {...CONTROL}
            type="button"
            className={ICON_BTN}
            onClick={openBeside}
            aria-label="Dock beside the menu"
            title="Dock beside the menu"
            data-testid="files-panel-dock"
          >
            <Icon name="dock_to_right" size={15} />
          </button>
        )}
        <button
          {...CONTROL}
          type="button"
          className={ICON_BTN}
          onClick={() => {
            const cwd = useFilesPanelBrowser.getState().cwd
            useViewStore.getState().goFiles()
            void useFileManagerStore.getState().openFolder(cwd)
          }}
          aria-label="Open Files full screen"
          title="Full screen"
          data-testid="files-panel-fullscreen"
        >
          <Icon name="open_in_full" size={15} />
        </button>
        <button
          {...CONTROL}
          type="button"
          className={ICON_BTN}
          onClick={onClose}
          aria-label="Close Files"
          title="Close"
          data-testid="files-panel-close"
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      {/* Search, and the two actions a narrow panel still needs. */}
      <div className="shrink-0 flex items-center gap-1 px-1.5 py-1.5 border-b border-[var(--edge-soft)] min-w-0">
        <label className="relative flex-1 min-w-0">
          <Icon name="search" size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-40)] pointer-events-none" />
          <input
            {...CONTROL}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all files"
            aria-label="Search all files"
            data-testid="files-panel-search"
            className="fb-field w-full min-w-0 h-7 pl-7 pr-2 text-[12px]"
          />
        </label>
        <button
          {...CONTROL}
          type="button"
          className={ICON_BTN}
          onClick={() => void ops().createFolder('New folder', b.cwd).then(() => useFilesPanelBrowser.getState().refresh())}
          disabled={searching}
          aria-label="New folder here"
          title="New folder"
          data-testid="files-panel-new-folder"
        >
          <Icon name="create_new_folder" size={15} />
        </button>
        <button
          {...CONTROL}
          type="button"
          className={ICON_BTN}
          onClick={() => void ops().importFiles(b.cwd)}
          disabled={searching}
          aria-label="Add files here"
          title="Add files"
          data-testid="files-panel-add-files"
        >
          <Icon name="upload_file" size={15} />
        </button>
        <button
          {...CONTROL}
          type="button"
          className={ICON_BTN}
          onClick={() => void ops().undo()}
          disabled={!canUndo}
          aria-label="Undo the last file change"
          title="Undo (⌘Z while Files has focus)"
          data-testid="files-panel-undo"
        >
          <Icon name="undo" size={15} />
        </button>
      </div>

      <div
        ref={listRef}
        role="listbox"
        aria-multiselectable="true"
        aria-label={searching ? 'Search results' : `Contents of ${folderName}`}
        data-testid={isGrid ? 'files-panel-grid' : 'files-panel-list'}
        data-cwd={b.cwd ?? ''}
        onKeyDown={onListKey}
        onDragOver={(e) => {
          const t = e.dataTransfer.types
          if (t.includes(FILES_DRAG_MIME) || t.includes('Files')) {
            e.preventDefault()
            setDropOver('__bg__')
          }
        }}
        onDragLeave={(e) => {
          if (e.target === e.currentTarget) setDropOver(null)
        }}
        onDrop={onBackgroundDrop}
        className={`flex-1 min-h-0 min-w-0 overflow-auto p-1 outline-none ${dropOver === '__bg__' ? 'ring-2 ring-inset ring-[rgb(var(--accent)/0.6)]' : ''} ${
          isGrid ? 'grid gap-1 content-start' : 'flex flex-col'
        }`}
        style={isGrid ? { gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))' } : undefined}
      >
        {b.loading && !b.entries.length && !searching ? (
          <div className="p-3 text-[12px] text-[var(--ink-40)]" role="status">
            Loading…
          </div>
        ) : b.searching && !b.searchResults.length ? (
          <div className="p-3 text-[12px] text-[var(--ink-40)]" role="status">
            Searching…
          </div>
        ) : shown.length === 0 ? (
          <div className="p-4 text-center text-[12px] text-[var(--ink-50)]" data-testid="files-panel-empty" role="status">
            {searching ? 'Nothing matches that.' : 'This folder is empty. Drop files here to add them.'}
          </div>
        ) : (
          shown.map((entry) => (
            <PanelRow
              key={entry.id}
              entry={entry}
              grid={isGrid}
              searching={searching}
              selected={selected.includes(entry.id)}
              focused={b.selectedId === entry.id || (!b.selectedId && entry.id === order[0])}
              renaming={renaming === entry.id}
              dropOver={dropOver === entry.id}
              dragging={dragging}
              onClick={(ev) => {
                const next = nextSelection(order, selected, anchorRef.current ?? b.selectedId, entry.id, {
                  meta: ev.metaKey || ev.ctrlKey,
                  shift: ev.shiftKey
                })
                if (!ev.shiftKey) anchorRef.current = entry.id
                useFilesPanelBrowser.getState().setSelection(next.ids, ev.shiftKey ? entry.id : next.focus)
              }}
              onOpen={() => openEntry(entry)}
              onContext={(ev) => {
                ev.preventDefault()
                if (!selected.includes(entry.id)) useFilesPanelBrowser.getState().select(entry.id)
                setCtx({ x: ev.clientX, y: ev.clientY, items: entryMenu(entry) })
              }}
              onDragStart={(ev) => {
                const refs = refsForDragStart(entry, selected, lookup, activeOrgId)
                writeFilesDrag(ev.dataTransfer, refs, 'files-panel')
                setFilesDragImage(ev.dataTransfer, refs)
                setDragging(true)
                useFilesPanelStore.getState().setDragging(true)
              }}
              onDragEnd={() => {
                setDragging(false)
                useFilesPanelStore.getState().setDragging(false)
              }}
              onFolderDragOver={(ev) => {
                const t = ev.dataTransfer.types
                if (t.includes(FILES_DRAG_MIME) || t.includes(ENTRY_DRAG_MIME) || t.includes('Files')) {
                  ev.preventDefault()
                  ev.stopPropagation()
                  setDropOver(entry.id)
                }
              }}
              onFolderDragLeave={() => setDropOver((d) => (d === entry.id ? null : d))}
              onSpring={() => openEntry(entry)}
              onFolderDrop={(ev) => {
                setDropOver(null)
                const r = readFilesDrag(ev.dataTransfer)
                if (r.ok) {
                  ev.preventDefault()
                  ev.stopPropagation()
                  void moveFilesInto(r.payload.refs, entry.id)
                  return
                }
                const legacy = ev.dataTransfer.getData(ENTRY_DRAG_MIME)
                if (legacy) {
                  ev.preventDefault()
                  ev.stopPropagation()
                  void ops().move(legacy, entry.id)
                  return
                }
                if (ev.dataTransfer.files.length) {
                  ev.preventDefault()
                  ev.stopPropagation()
                  void ingestInto(ev.dataTransfer.files, entry.id)
                }
              }}
              onRenameCommit={(name) => {
                setRenaming(null)
                if (name.trim() && name !== entry.name) void ops().rename(entry.id, name.trim())
              }}
              onRenameCancel={() => setRenaming(null)}
            />
          ))
        )}
      </div>

      {preview && <PreviewCard entry={preview} onClose={() => setPreview(null)} />}
      {ctx && <CanvasContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
    </div>
  )
}

function PathMenu({
  crumbs,
  onPick,
  onClose
}: {
  crumbs: Array<{ id: string; name: string }>
  onPick: (id: string | null) => void
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [onClose])
  const rows: Array<{ id: string | null; name: string; depth: number }> = [
    { id: null, name: 'Files', depth: 0 },
    ...crumbs.map((c, i) => ({ id: c.id, name: c.name, depth: i + 1 }))
  ]
  return (
    <div
      ref={ref}
      role="menu"
      data-testid="files-panel-path-menu"
      className="absolute left-0 right-0 top-8 z-10 rounded-lg p-1 bg-[var(--surface-raised)] shadow-[0_0_0_1px_var(--edge-hairline),var(--shadow-cast)]"
    >
      {rows.map((r) => (
        <button
          key={r.id ?? 'root'}
          type="button"
          role="menuitem"
          onClick={() => onPick(r.id)}
          className="w-full min-w-0 flex items-center gap-1.5 h-7 rounded-md px-1.5 text-left text-[12px] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]"
          style={{ paddingLeft: 6 + r.depth * 10 }}
          data-testid={`files-panel-crumb-${r.id ?? 'root'}`}
        >
          <Icon name={r.id ? 'folder' : 'home_storage'} size={14} className="shrink-0 text-[var(--ink-40)]" />
          <span className="truncate min-w-0">{r.name}</span>
        </button>
      ))}
    </div>
  )
}

function PanelRow({
  entry,
  grid,
  searching,
  selected,
  focused,
  renaming,
  dropOver,
  dragging,
  onClick,
  onOpen,
  onContext,
  onDragStart,
  onDragEnd,
  onFolderDragOver,
  onFolderDragLeave,
  onFolderDrop,
  onSpring,
  onRenameCommit,
  onRenameCancel
}: {
  entry: FileEntry
  grid: boolean
  searching: boolean
  selected: boolean
  focused: boolean
  renaming: boolean
  dropOver: boolean
  dragging: boolean
  onClick: (e: React.MouseEvent) => void
  onOpen: () => void
  onContext: (e: React.MouseEvent) => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  onFolderDragOver: (e: React.DragEvent) => void
  onFolderDragLeave: () => void
  onFolderDrop: (e: React.DragEvent) => void
  onSpring: () => void
  onRenameCommit: (name: string) => void
  onRenameCancel: () => void
}): JSX.Element {
  const isFolder = entry.kind === 'folder'
  const thumb = useThumbnail(entry, grid || previewable(entry))
  const path = usePathLabel(entry.parentId, searching)
  const spring = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearSpring = (): void => {
    if (spring.current) clearTimeout(spring.current)
    spring.current = null
  }
  useEffect(() => clearSpring, [])
  const secondary = searching ? path : formatSize(entry)
  const big = exceedsSyncLimit(entry.sizeBytes) && entry.kind === 'file'
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      data-entry-id={entry.id}
      data-testid={`files-panel-entry-${entry.id}`}
      data-kind={entry.kind}
      data-doc-id={entry.docId}
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (!isFolder) return
        onFolderDragOver(e)
        if (e.defaultPrevented && !spring.current && dragging !== undefined) {
          spring.current = setTimeout(() => {
            spring.current = null
            onSpring()
          }, SPRING_LOAD_MS)
        }
      }}
      onDragLeave={() => {
        clearSpring()
        if (isFolder) onFolderDragLeave()
      }}
      onDrop={(e) => {
        clearSpring()
        if (isFolder) onFolderDrop(e)
      }}
      onClick={onClick}
      onDoubleClick={onOpen}
      onContextMenu={onContext}
      title={`${entry.name}${secondary ? `\n${secondary}` : ''}`}
      className={`group fb-nav-item min-w-0 cursor-default select-none outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent)/0.6)] ${
        grid ? 'flex-col !items-stretch p-1 gap-1' : 'h-7 px-1.5 gap-2 mb-px'
      } ${
        dropOver
          ? 'bg-[rgb(var(--accent)/0.16)] !border-[rgb(var(--accent)/0.5)]'
          : selected
            ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]'
            : 'hover:bg-[var(--surface-sunken)]'
      }`}
    >
      {grid ? (
        <div className="h-[64px] rounded-md bg-[var(--surface-sunken)] flex items-center justify-center overflow-hidden">
          {thumb ? (
            <img src={thumb} alt="" className="w-full h-full object-cover" draggable={false} />
          ) : (
            <Icon name={fileTypeIcon(entry)} size={28} className={isFolder ? 'text-accent' : 'text-[var(--ink-40)]'} filled={isFolder} />
          )}
        </div>
      ) : thumb ? (
        <img src={thumb} alt="" className="h-5 w-5 rounded-sm object-cover shrink-0" draggable={false} />
      ) : (
        <Icon name={fileTypeIcon(entry)} size={17} filled={isFolder} className={`shrink-0 ${isFolder ? 'text-accent' : 'text-[var(--ink-45,var(--ink-40))]'}`} />
      )}
      {renaming ? (
        <RenameInput initial={entry.name} onCommit={onRenameCommit} onCancel={onRenameCancel} />
      ) : (
        <span className={`min-w-0 flex-1 truncate text-[12.5px] ${grid ? 'text-center px-0.5' : ''} ${selected ? '' : 'text-[var(--ink-90)]'}`}>
          {entry.name}
        </span>
      )}
      {!grid && !renaming && (
        <span
          className={`shrink-0 max-w-[45%] truncate text-[10.5px] text-[var(--ink-40)] ${
            searching || big ? '' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
          }`}
        >
          {big ? 'on this device only' : secondary}
        </span>
      )}
    </div>
  )
}

function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }): JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      defaultValue={initial}
      data-testid="files-panel-rename-input"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit((e.target as HTMLInputElement).value)
        else if (e.key === 'Escape') onCancel()
      }}
      onBlur={(e) => onCommit(e.target.value)}
      className="min-w-0 flex-1 h-6 bg-[var(--surface-raised)] border border-[rgb(var(--accent))] rounded px-1 text-[12px]"
    />
  )
}

function PreviewCard({ entry, onClose }: { entry: FileEntry; onClose: () => void }): JSX.Element {
  const thumb = useThumbnail(entry, previewable(entry))
  return (
    <div
      role="dialog"
      aria-label={`Preview of ${entry.name}`}
      data-testid="files-panel-preview"
      className="shrink-0 border-t border-[var(--edge-soft)] p-2 flex flex-col gap-1.5 min-w-0"
    >
      <div className="flex items-center gap-1 min-w-0">
        <span className="truncate min-w-0 flex-1 text-[12px] font-medium text-[var(--ink-90)]">{entry.name}</span>
        <button {...CONTROL} type="button" className={ICON_BTN} onClick={onClose} aria-label="Close the preview">
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="h-[140px] rounded-md bg-[var(--surface-sunken)] flex items-center justify-center overflow-hidden">
        {thumb ? (
          <img src={thumb} alt="" className="max-w-full max-h-full object-contain" />
        ) : (
          <div className="flex flex-col items-center gap-1 text-[11px] text-[var(--ink-50)]">
            <Icon name={fileTypeIcon(entry)} size={32} className="text-[var(--ink-40)]" />
            {fileTypeLabel(entry)} · {formatSize(entry)}
          </div>
        )}
      </div>
    </div>
  )
}
