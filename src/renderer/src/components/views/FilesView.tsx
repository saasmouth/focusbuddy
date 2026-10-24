// The file/folder manager. A Finder-like library over fb_files: folders,
// imported files of any type, and internal documents filed into folders. It
// supports four view modes (list, small icons, large icons, large preview),
// column sorting in list mode (header click toggles direction with an arrow,
// right-click a header to choose the column), per-item right-click actions,
// inline rename, drag-to-move into folders, and drag-in of OS files to import.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@shared/fields'
import type { WidgetFileDesk } from '@shared/types'
import { useFileManagerStore, sortEntries, type FileSortKey, type FileViewMode } from '../../stores/fileManager'
import { useViewStore } from '../../stores/view'
import { useAccountStore } from '../../stores/account'
import { useOrgStore, PERSONAL_ORG_ID } from '../../stores/org'
import { promoteFolderToLive } from '../../lib/liveFolderMirror'
import { shareToOrgOrGroup } from '../../lib/shareScope'
import ShareDialog from '../ShareDialog'
import type { ShareableKind } from '@shared/types'
import Icon from '../Icon'
import CanvasContextMenu, { type CtxMenuItem } from '../CanvasContextMenu'
import { exceedsSyncLimit, syncLimitLabel } from '@shared/fileSyncLimits'
import { isWidgetFileName } from '@shared/widgetFiles'
import {
  fileTypeIcon,
  fileTypeLabel,
  isWidgetFileEntry,
  matchesTypeFilter,
  typeFilterOptions,
  widgetFileDeskLine
} from '../../lib/fileEntryType'
import {
  ENTRY_DRAG_MIME,
  FILES_DRAG_MIME,
  readFilesDrag,
  refsForDragStart,
  setFilesDragImage,
  writeFilesDrag,
  type FileDragRef
} from '../../lib/filesDrag'
import { moveFilesInto } from '../../lib/filesDrop'
import { nextSelection } from '../../lib/filesSelection'
import { confirmTrashWidgetFile } from '../../lib/widgetRemoval'
import { fileEntryMenu, filesAreaMenu, isTextFieldTarget } from '../../lib/fileEntryMenu'
import type { FileTypeFilter } from '../../stores/fileManager'
import { filesUndoAction } from '../../lib/filesUndoScope'

const ENTRY_MIME = ENTRY_DRAG_MIME

/** A Files drag (ours, the legacy entry id, or a Finder drag) is over a folder target. */
function folderAccepts(dt: DataTransfer): boolean {
  const t = dt.types
  return t.includes(FILES_DRAG_MIME) || t.includes(ENTRY_MIME) || t.includes('Files')
}

/**
 * Drop on a folder target: a Files drag moves (all of it, one undo), the legacy
 * entry id moves one, Finder files are imported. Returns whether it was handled.
 */
function dropOnFolder(
  e: React.DragEvent,
  folderId: string | null,
  h: { onMoveRefs: (refs: FileDragRef[], target: string | null) => void; onMove: (id: string, target: string | null) => void; onDropOsFiles?: (files: FileList, folderId: string) => void }
): boolean {
  const files = readFilesDrag(e.dataTransfer)
  if (files.ok) {
    e.preventDefault()
    h.onMoveRefs(files.payload.refs, folderId)
    return true
  }
  const dragged = e.dataTransfer.getData(ENTRY_MIME)
  if (dragged) {
    e.preventDefault()
    h.onMove(dragged, folderId)
    return true
  }
  if (folderId && e.dataTransfer.files.length && h.onDropOsFiles) {
    e.preventDefault()
    h.onDropOsFiles(e.dataTransfer.files, folderId)
    return true
  }
  return false
}

import { useThumbnail } from '../../lib/fileThumbnail'

// Type icons and labels live in lib/fileEntryType, shared with the sort and
// the type filter, so a widget file reads as "Table" everywhere.
const iconFor = fileTypeIcon
const typeLabel = fileTypeLabel

function formatSize(entry: FileEntry): string {
  if (entry.kind === 'folder') return entry.childCount === 1 ? '1 item' : `${entry.childCount ?? 0} items`
  if (entry.kind === 'doc') return '—'
  const b = entry.sizeBytes ?? 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

export default function FilesView(): JSX.Element {
  const store = useFileManagerStore()
  const goDocument = useViewStore((s) => s.goDocument)
  const goLiveFolder = useViewStore((s) => s.goLiveFolder)
  const sessionToken = useAccountStore((s) => s.sessionToken)
  const activeOrgId = useOrgStore((s) => s.activeOrgId)
  const orgs = useOrgStore((s) => s.orgs)
  // Sharing a file/folder = moving it into a team org, optionally narrowed to a
  // group. Offered only from the Personal Drive when a team org exists. useMemo
  // over the stable orgs array (a filtering selector returns a new array each
  // render -> React #185).
  const sharedOrgs = useMemo(() => orgs.filter((o) => !o.personal), [orgs])
  const canShare = activeOrgId === PERSONAL_ORG_ID && sharedOrgs.length > 0
  const undo = useFileManagerStore((s) => s.undo)
  const redo = useFileManagerStore((s) => s.redo)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [ctx, setCtx] = useState<{ x: number; y: number; items: CtxMenuItem[] } | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [docPicker, setDocPicker] = useState<Array<{ id: string; title: string; docType: string }> | null>(null)
  // Public share-link target for a Drive entry. A folder shares as a 'docfolder'
  // (its documents, browser-viewable), an office doc as a 'document', and a raw
  // file as a 'file' (bytes hosted against the token). null when closed.
  const [linkTarget, setLinkTarget] = useState<{ kind: ShareableKind; id: string; name: string } | null>(null)

  useEffect(() => {
    void store.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Undo/redo for file operations while the manager is open, scoped by
  // lib/filesUndoScope: never while focus edits text (rename, any editor),
  // only when focus is inside Files or nowhere in particular.
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const action = filesUndoAction(e, { root: rootRef.current, active: document.activeElement, fullScreen: true })
      if (!action) return
      e.preventDefault()
      if (action === 'redo') void redo()
      else void undo()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const sorted = useMemo(
    () =>
      sortEntries(store.entries, store.sortKey, store.sortDir).filter((e) =>
        matchesTypeFilter(e, store.typeFilter)
      ),
    [store.entries, store.sortKey, store.sortDir, store.typeFilter]
  )

  // Which desk(s) each work widget file in this listing sits on, in one call.
  // A work widget made on a desk is filed at the Files root (that is the rule
  // every device agrees on), so a root full of them reads as a flood unless
  // each row says where it lives. Nothing is moved: this is only a label.
  const widgetDocIds = useMemo(
    () => store.entries.filter((e) => isWidgetFileEntry(e) && e.docId).map((e) => e.docId as string),
    [store.entries]
  )
  const widgetDocKey = widgetDocIds.join(',')
  const [deskMap, setDeskMap] = useState<Record<string, WidgetFileDesk[]>>({})
  useEffect(() => {
    if (widgetDocIds.length === 0) {
      setDeskMap({})
      return
    }
    let live = true
    window.api.widgetFiles
      .placements(widgetDocIds)
      .then((m) => {
        if (live) setDeskMap(m ?? {})
      })
      .catch(() => {
        // Unknown is shown as nothing, never as "Not on a desk".
        if (live) setDeskMap({})
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetDocKey])

  // ⌘-click toggles, ⇧-click selects the range from the last click, a plain
  // click selects one (lib/filesSelection, shared with the panel).
  function selectWith(id: string, mods?: { meta?: boolean; shift?: boolean }): void {
    const next = nextSelection(sorted.map((e) => e.id), store.selectedIds, store.selectedId, id, mods ?? {})
    store.setSelection(next.ids, next.focus)
  }
  // A drag from a selected row carries the whole selection.
  function dragRefs(entry: FileEntry): FileDragRef[] {
    return refsForDragStart(entry, store.selectedIds, (id) => store.entries.find((x) => x.id === id), activeOrgId)
  }
  function moveRefs(refs: FileDragRef[], target: string | null): void {
    void moveFilesInto(refs, target)
  }

  function openEntry(entry: FileEntry): void {
    if (entry.kind === 'folder') void store.openFolder(entry.id)
    else if (entry.kind === 'doc' && entry.docId) goDocument(entry.docId)
    else void window.api.files.open(entry.id)
  }

  async function ingestOsFiles(fileList: FileList, parentId: string | null): Promise<void> {
    const payloads: Array<{ buffer: ArrayBuffer; originalName: string; mimeType: string }> = []
    for (const f of Array.from(fileList)) {
      // An exported widget file (.plexii-table …) comes back as the widget it
      // was, not as an opaque file. A malformed one falls through to a plain
      // file so nothing the user dropped is lost.
      if (isWidgetFileName(f.name)) {
        const r = await window.api.widgetFiles.import({ text: await f.text(), parentId })
        if (r.ok) continue
      }
      payloads.push({ buffer: await f.arrayBuffer(), originalName: f.name, mimeType: f.type })
    }
    if (payloads.length === 0) {
      await store.refresh()
    } else if (parentId === store.cwd) {
      await store.ingestBuffers(payloads)
    } else {
      for (const p of payloads) await window.api.files.ingestBuffer({ ...p, parentId })
      await store.refresh()
    }
  }

  // One builder for this view and the flyout (lib/fileEntryMenu.ts), so the
  // same entry says the same thing in both.
  function entryContextItems(entry: FileEntry): CtxMenuItem[] {
    return fileEntryMenu(
      entry,
      'view',
      { signedIn: !!sessionToken, canShareWithTeam: canShare, platform: window.api?.platform ?? 'darwin' },
      {
        open: () => openEntry(entry),
        rename: () => setRenaming(entry.id),
        exportWidgetFile: (docId) => void window.api.widgetFiles.export(docId),
        reveal: () => void window.api.fileManager.reveal(entry.id),
        collaborateLive: () => {
          // Promote a whole folder to a live, checked-out shared folder. Uploads
          // its files to the server so members can open them; documents come across
          // as live-openable copies. Members organise it one at a time.
          if (!sessionToken) return
          void promoteFolderToLive(entry.id, entry.name, sessionToken).then((res) => {
            if (res) goLiveFolder(res.liveId)
          })
        },
        share: () => {
          // Anyone with the link views it in the browser. A folder shares its
          // documents (docfolder), an office doc as itself, a raw file with its
          // bytes hosted against the token. A doc pointer needs its docId.
          const kind: ShareableKind = entry.kind === 'folder' ? 'docfolder' : entry.kind === 'doc' ? 'document' : 'file'
          const id = entry.kind === 'doc' ? entry.docId : entry.id
          if (id) setLinkTarget({ kind, id, name: entry.name })
        },
        shareWithTeam: () =>
          void shareToOrgOrGroup({
            name: entry.name,
            kindLabel: entry.kind === 'folder' ? 'folder and its contents' : 'file',
            sharedOrgs,
            move: (org, team) => store.moveToOrg(entry.id, org, team)
          }),
        // Deleting a work widget file takes its desk instances too; asks first when it is placed.
        moveToTrash: () =>
          void (isWidgetFileEntry(entry) && entry.docId ? confirmTrashWidgetFile(entry.docId).then(() => store.refresh()) : store.remove(entry.id)),
        removeFromFolder: () => void store.remove(entry.id)
      }
    )
  }

  // Right-click on the empty part of the listing.
  function onAreaContext(e: React.MouseEvent): void {
    if (e.defaultPrevented || isTextFieldTarget(e.target)) return
    e.preventDefault()
    setCtx({
      x: e.clientX,
      y: e.clientY,
      items: filesAreaMenu({
        newFolder: () => void store.createFolder('New folder'),
        addFiles: () => void store.importFiles(),
        importFolder: () => void store.importFolder(),
        addDocument: () => void openDocPicker(),
        selectAll: sorted.length ? () => store.setSelection(sorted.map((x) => x.id), sorted[0]!.id) : undefined
      })
    })
  }

  function onEntryContext(e: React.MouseEvent, entry: FileEntry): void {
    if (isTextFieldTarget(e.target)) return
    e.preventDefault()
    setCtx({ x: e.clientX, y: e.clientY, items: entryContextItems(entry) })
  }

  async function openDocPicker(): Promise<void> {
    const docs = await window.api.fileManager.unfiledDocuments()
    setDocPicker(docs)
  }

  return (
    <div
      ref={rootRef}
      data-testid="files-view"
      className="h-full flex flex-col bg-[var(--surface-raised)]"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDropActive(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDropActive(false)
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault()
          void ingestOsFiles(e.dataTransfer.files, store.cwd)
        }
        setDropActive(false)
      }}
    >
      <Toolbar onNewFolder={() => void store.createFolder('New folder').then(() => undefined)} onAddFiles={() => void store.importFiles()} onImportFolder={() => void store.importFolder()} onAddDoc={() => void openDocPicker()} />

      <Breadcrumbs crumbs={store.crumbs} onOpen={(id) => void store.openFolder(id)} onMove={(id, target) => void store.move(id, target)} onMoveRefs={moveRefs} />

      <div
        className={`flex-1 overflow-auto px-4 py-3 relative ${dropActive ? 'ring-2 ring-accent ring-inset' : ''}`}
        data-testid="files-view-area"
        onContextMenu={onAreaContext}
      >
        {store.loading ? (
          <div className="text-[13px] text-[var(--ink-40)] py-10 text-center">Loading…</div>
        ) : sorted.length === 0 && store.entries.length > 0 ? (
          // Filtered to nothing is not "empty": say what is hidden, and how to
          // see it, rather than claim the folder has nothing in it.
          <div className="flex flex-col items-center justify-center text-center py-20 gap-2" data-testid="files-filtered-empty">
            <Icon name="filter_alt_off" size={36} className="text-[var(--ink-30)]" />
            <p className="text-[13px] text-[var(--ink-50)]">Nothing of this type here.</p>
            <button className="fb-btn-surface text-[12px] px-3 py-1.5" onClick={() => store.setTypeFilter('all')}>
              Show all types
            </button>
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState onAddFiles={() => void store.importFiles()} onNewFolder={() => void store.createFolder('New folder')} />
        ) : store.viewMode === 'list' ? (
          <ListView
            entries={sorted}
            desks={deskMap}
            sortKey={store.sortKey}
            sortDir={store.sortDir}
            onSort={store.setSort}
            selectedId={store.selectedId}
            selectedIds={store.selectedIds}
            renaming={renaming}
            onSelect={selectWith}
            dragRefs={dragRefs}
            onMoveRefs={moveRefs}
            onOpen={openEntry}
            onRenameStart={setRenaming}
            onRenameCommit={(id, name) => {
              void store.rename(id, name)
              setRenaming(null)
            }}
            onRenameCancel={() => setRenaming(null)}
            onContext={onEntryContext}
            onMove={(id, target) => void store.move(id, target)}
            onDropOsFiles={(files, folderId) => void ingestOsFiles(files, folderId)}
          />
        ) : (
          <GridView
            entries={sorted}
            desks={deskMap}
            mode={store.viewMode}
            selectedId={store.selectedId}
            selectedIds={store.selectedIds}
            renaming={renaming}
            onSelect={selectWith}
            dragRefs={dragRefs}
            onMoveRefs={moveRefs}
            onOpen={openEntry}
            onRenameCommit={(id, name) => {
              void store.rename(id, name)
              setRenaming(null)
            }}
            onRenameCancel={() => setRenaming(null)}
            onContext={onEntryContext}
            onMove={(id, target) => void store.move(id, target)}
            onDropOsFiles={(files, folderId) => void ingestOsFiles(files, folderId)}
          />
        )}
      </div>

      {ctx && <CanvasContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />}
      {linkTarget && (
        <ShareDialog
          kind={linkTarget.kind}
          entityId={linkTarget.id}
          label={linkTarget.name}
          onClose={() => setLinkTarget(null)}
        />
      )}
      {docPicker && (
        <DocPickerModal
          docs={docPicker}
          onPick={(id) => {
            void store.fileExistingDocument(id)
            setDocPicker(null)
          }}
          onClose={() => setDocPicker(null)}
        />
      )}
    </div>
  )
}

// ── Toolbar ───────────────────────────────────────────────────────────────────
function Toolbar({ onNewFolder, onAddFiles, onImportFolder, onAddDoc }: { onNewFolder: () => void; onAddFiles: () => void; onImportFolder: () => void; onAddDoc: () => void }): JSX.Element {
  const viewMode = useFileManagerStore((s) => s.viewMode)
  const setViewMode = useFileManagerStore((s) => s.setViewMode)
  const sortKey = useFileManagerStore((s) => s.sortKey)
  const setSort = useFileManagerStore((s) => s.setSort)
  const undo = useFileManagerStore((s) => s.undo)
  const redo = useFileManagerStore((s) => s.redo)
  const canUndo = useFileManagerStore((s) => s.past.length > 0)
  const canRedo = useFileManagerStore((s) => s.future.length > 0)
  const btn = 'h-8 px-2.5 inline-flex items-center gap-1.5 rounded-lg text-[12px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
  const iconBtn = 'h-8 w-8 inline-flex items-center justify-center rounded-lg text-[var(--ink-50)] hover:bg-[var(--surface-sunken)] disabled:opacity-40'
  const modes: Array<{ id: FileViewMode; icon: string; title: string }> = [
    { id: 'list', icon: 'view_list', title: 'List' },
    { id: 'small', icon: 'grid_view', title: 'Small icons' },
    { id: 'large', icon: 'grid_on', title: 'Large icons' },
    { id: 'preview', icon: 'photo_library', title: 'Large preview' }
  ]
  return (
    <div className="flex items-center gap-1 px-4 py-2 border-b border-[var(--edge-soft)]">
      <h1 className="text-[15px] font-semibold text-[var(--ink-90)] mr-2">Files</h1>
      <button className={iconBtn} onClick={() => void undo()} disabled={!canUndo} title="Undo" data-testid="files-undo"><Icon name="undo" size={16} /></button>
      <button className={iconBtn} onClick={() => void redo()} disabled={!canRedo} title="Redo" data-testid="files-redo"><Icon name="redo" size={16} /></button>
      <span className="w-px h-5 bg-[var(--surface-sunken)] mx-1" />
      <button className={btn} onClick={onNewFolder} data-testid="files-new-folder"><Icon name="create_new_folder" size={16} /> New folder</button>
      <button className={btn} onClick={onAddFiles} data-testid="files-add-files"><Icon name="upload_file" size={16} /> Add files</button>
      <button className={btn} onClick={onImportFolder} data-testid="files-import-folder"><Icon name="drive_folder_upload" size={16} /> Import folder</button>
      <button className={btn} onClick={onAddDoc} data-testid="files-add-doc"><Icon name="post_add" size={16} /> Add document</button>

      <div className="ml-auto flex items-center gap-1">
        <TypeFilter />
        {viewMode !== 'list' && (
          <select
            value={sortKey}
            onChange={(e) => setSort(e.target.value as FileSortKey)}
            className="fb-field w-auto h-8 text-[12px] px-2 text-[var(--ink-70)]"
            title="Sort by"
            data-testid="files-sort-select"
          >
            <option value="name">Name</option>
            <option value="size">Size</option>
            <option value="type">Type</option>
            <option value="created">Date added</option>
            <option value="modified">Date modified</option>
          </select>
        )}
        <div className="flex items-center rounded-lg bg-[var(--surface-sunken)] overflow-hidden">
          {modes.map((m) => (
            <button
              key={m.id}
              title={m.title}
              data-testid={`files-view-${m.id}`}
              onClick={() => setViewMode(m.id)}
              className={`h-8 w-8 inline-flex items-center justify-center ${
                viewMode === m.id ? 'bg-accent/15 text-accent' : 'text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]'
              }`}
            >
              <Icon name={m.icon} size={16} />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Type filter ─────────────────────────────────────────────────────────────
// Narrow the listing to one family, or one widget file type ("Tables").
function TypeFilter(): JSX.Element {
  const typeFilter = useFileManagerStore((s) => s.typeFilter)
  const setTypeFilter = useFileManagerStore((s) => s.setTypeFilter)
  const entries = useFileManagerStore((s) => s.entries)
  const options = useMemo(() => {
    const opts = typeFilterOptions(entries)
    // Keep the active choice listed even when nothing in this folder matches it.
    if (!opts.some((o) => o.value === typeFilter)) opts.push({ value: typeFilter, label: typeFilter.replace(/^widget:/, '') })
    return opts
  }, [entries, typeFilter])
  return (
    <select
      value={typeFilter}
      onChange={(e) => setTypeFilter(e.target.value as FileTypeFilter)}
      className={`fb-field w-auto h-8 text-[12px] px-2 ${typeFilter === 'all' ? 'text-[var(--ink-70)]' : 'text-accent'}`}
      title="Show only one type"
      data-testid="files-type-filter"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

// ── Breadcrumbs ─────────────────────────────────────────────────────────────
function Breadcrumbs({
  crumbs,
  onOpen,
  onMove,
  onMoveRefs
}: {
  crumbs: Array<{ id: string; name: string }>
  onOpen: (id: string | null) => void
  onMove: (id: string, target: string | null) => void
  onMoveRefs: (refs: FileDragRef[], target: string | null) => void
}): JSX.Element {
  const crumb = (label: string, id: string | null, testid?: string): JSX.Element => (
    <button
      data-testid={testid}
      onClick={() => onOpen(id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(ENTRY_MIME) || e.dataTransfer.types.includes(FILES_DRAG_MIME)) e.preventDefault()
      }}
      onDrop={(e) => {
        dropOnFolder(e, id, { onMove, onMoveRefs })
      }}
      className="px-1.5 py-0.5 rounded text-[12px] text-[var(--ink-50)] hover:text-accent hover:bg-[var(--surface-sunken)]"
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-0.5 px-4 py-1.5 border-b border-[var(--edge-soft)]">
      {crumb('Files', null, 'files-crumb-root')}
      {crumbs.map((c) => (
        <span key={c.id} className="flex items-center gap-0.5">
          <Icon name="chevron_right" size={14} className="text-[var(--ink-30)]" />
          {crumb(c.name, c.id)}
        </span>
      ))}
    </div>
  )
}

// ── List view (sortable columns) ──────────────────────────────────────────────
const COLUMNS: Array<{ key: FileSortKey; label: string; width: string }> = [
  { key: 'name', label: 'Name', width: 'auto' },
  { key: 'type', label: 'Type', width: '140px' },
  { key: 'size', label: 'Size', width: '110px' },
  { key: 'created', label: 'Date added', width: '130px' },
  { key: 'modified', label: 'Date modified', width: '140px' }
]

interface RowHandlers {
  /** Work widget file id → the desks it sits on (absent while loading). */
  desks: Record<string, WidgetFileDesk[]>
  selectedId: string | null
  selectedIds: string[]
  renaming: string | null
  onSelect: (id: string, mods?: { meta?: boolean; shift?: boolean }) => void
  /** What a drag that starts on this entry carries (the selection when it is in it). */
  dragRefs: (entry: FileEntry) => FileDragRef[]
  onMoveRefs: (refs: FileDragRef[], target: string | null) => void
  onOpen: (e: FileEntry) => void
  onRenameCommit: (id: string, name: string) => void
  onRenameCancel: () => void
  onContext: (e: React.MouseEvent, entry: FileEntry) => void
  onMove: (id: string, target: string | null) => void
  onDropOsFiles: (files: FileList, folderId: string) => void
}

function ListView(
  props: {
    entries: FileEntry[]
    sortKey: FileSortKey
    sortDir: 'asc' | 'desc'
    onSort: (k: FileSortKey) => void
    onRenameStart: (id: string) => void
  } & RowHandlers
): JSX.Element {
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <table className="w-full text-[13px]" data-testid="files-list">
      <thead>
        <tr
          className="text-left text-[var(--ink-40)] border-b border-[var(--edge-soft)]"
          onContextMenu={(e) => {
            e.preventDefault()
            setHeaderMenu({ x: e.clientX, y: e.clientY })
          }}
        >
          {COLUMNS.map((c) => (
            <th
              key={c.key}
              data-testid={`files-col-${c.key}`}
              style={{ width: c.width }}
              onClick={() => props.onSort(c.key)}
              className="font-medium text-[11px] uppercase tracking-wide px-2 py-1.5 cursor-pointer select-none hover:text-[var(--ink-70)]"
            >
              <span className="inline-flex items-center gap-0.5">
                {c.label}
                {props.sortKey === c.key && (
                  <Icon name={props.sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={12} className="text-accent" />
                )}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.entries.map((entry) => (
          <ListRow key={entry.id} entry={entry} {...props} />
        ))}
      </tbody>
      {headerMenu && (
        <CanvasContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          items={COLUMNS.map((c) => ({ label: `Sort by ${c.label}`, onClick: () => props.onSort(c.key) }))}
          onClose={() => setHeaderMenu(null)}
        />
      )}
    </table>
  )
}

function ListRow({ entry, ...h }: { entry: FileEntry } & RowHandlers & { onRenameStart: (id: string) => void }): JSX.Element {
  const thumb = useThumbnail(entry, true)
  const selected = h.selectedIds.includes(entry.id) || h.selectedId === entry.id
  const [over, setOver] = useState(false)
  const isFolder = entry.kind === 'folder'
  return (
    <tr
      data-testid={`file-entry-${entry.id}`}
      data-kind={entry.kind}
      data-doc-id={entry.docId}
      data-widget-kind={entry.widgetKind}
      draggable={h.renaming !== entry.id}
      onDragStart={(e) => {
        // One payload for every target (lib/filesDrag): the Files MIME, plus the
        // entry id, the document drag and the work widget file drag for one item,
        // so a doc-ref cell, the tray and the desk all keep taking it.
        const refs = h.dragRefs(entry)
        writeFilesDrag(e.dataTransfer, refs, 'files-view')
        setFilesDragImage(e.dataTransfer, refs)
      }}
      onDragOver={(e) => {
        if (isFolder && folderAccepts(e.dataTransfer)) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!isFolder) return
        dropOnFolder(e, entry.id, h)
        setOver(false)
      }}
      onClick={(e) => h.onSelect(entry.id, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey })}
      onDoubleClick={() => h.onOpen(entry)}
      onContextMenu={(e) => h.onContext(e, entry)}
      className={`border-b border-[var(--edge-soft)] cursor-default ${
        selected ? 'bg-accent/10' : over ? 'bg-accent/15' : 'hover:bg-[var(--surface-sunken)]'
      }`}
    >
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          {thumb ? (
            <img src={thumb} alt="" className="h-5 w-5 object-cover rounded-sm shrink-0" />
          ) : (
            <Icon name={iconFor(entry)} size={18} className={isFolder ? 'text-accent' : 'text-[var(--ink-40)]'} />
          )}
          {h.renaming === entry.id ? (
            <RenameInput initial={entry.name} onCommit={(name) => h.onRenameCommit(entry.id, name)} onCancel={h.onRenameCancel} />
          ) : (
            <span className="min-w-0 flex flex-col">
              <span className="truncate text-[var(--ink-90)]">{entry.name}</span>
              {isWidgetFileEntry(entry) && entry.docId && <DeskLine desks={h.desks[entry.docId]} />}
            </span>
          )}
        </div>
      </td>
      <td className="px-2 py-1.5 text-[var(--ink-50)]">{typeLabel(entry)}</td>
      <td className="px-2 py-1.5 text-[var(--ink-50)] tabular-nums whitespace-nowrap">
        {formatSize(entry)}
        {/* A file above the cap keeps its bytes on this device forever. It used
            to look identical to every other file here, and only turned out to be
            different when someone opened it on another machine and found
            nothing. Saying so costs one word. */}
        {entry.kind === 'file' && exceedsSyncLimit(entry.sizeBytes) && (
          <span
            className="ml-1.5 text-[10px] uppercase tracking-wide text-amber-600"
            title={`Over the ${syncLimitLabel()} limit, so this file's contents stay on this device. Its name and type still appear on your other devices.`}
            data-testid="file-too-large-to-sync"
          >
            on this device only
          </span>
        )}
      </td>
      <td className="px-2 py-1.5 text-[var(--ink-50)]">{formatDate(entry.createdAt)}</td>
      <td className="px-2 py-1.5 text-[var(--ink-50)]">{formatDate(entry.updatedAt)}</td>
    </tr>
  )
}

// ── Grid views (small / large / preview) ──────────────────────────────────────
function GridView(
  props: {
    entries: FileEntry[]
    mode: FileViewMode
  } & Omit<RowHandlers, 'onRenameStart'>
): JSX.Element {
  const tile = props.mode === 'small' ? 96 : props.mode === 'large' ? 150 : 220
  return (
    <div
      data-testid="files-grid"
      className="grid gap-3"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tile}px, 1fr))` }}
    >
      {props.entries.map((entry) => (
        <GridTile key={entry.id} {...props} entry={entry} />
      ))}
    </div>
  )
}

function GridTile({ entry, mode, ...h }: { entry: FileEntry; mode: FileViewMode } & Omit<RowHandlers, 'onRenameStart'>): JSX.Element {
  const thumb = useThumbnail(entry, mode !== 'small')
  const selected = h.selectedIds.includes(entry.id) || h.selectedId === entry.id
  const [over, setOver] = useState(false)
  const isFolder = entry.kind === 'folder'
  const previewH = mode === 'preview' ? 150 : mode === 'large' ? 92 : 56
  const iconSize = mode === 'preview' ? 64 : mode === 'large' ? 44 : 30
  return (
    <button
      data-testid={`file-entry-${entry.id}`}
      data-kind={entry.kind}
      data-doc-id={entry.docId}
      data-widget-kind={entry.widgetKind}
      draggable
      onDragStart={(e) => {
        const refs = h.dragRefs(entry)
        writeFilesDrag(e.dataTransfer, refs, 'files-view')
        setFilesDragImage(e.dataTransfer, refs)
      }}
      onDragOver={(e) => {
        if (isFolder && folderAccepts(e.dataTransfer)) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!isFolder) return
        dropOnFolder(e, entry.id, h)
        setOver(false)
      }}
      onClick={(e) => h.onSelect(entry.id, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey })}
      onDoubleClick={() => h.onOpen(entry)}
      onContextMenu={(e) => h.onContext(e, entry)}
      className={`flex flex-col items-stretch rounded-lg border p-1.5 text-left transition ${
        selected ? 'border-accent bg-accent/10' : over ? 'border-accent bg-accent/15' : 'border-transparent hover:bg-[var(--surface-sunken)]'
      }`}
    >
      <div
        className="flex items-center justify-center rounded-md bg-[var(--surface-sunken)] overflow-hidden mb-1"
        style={{ height: previewH }}
      >
        {thumb ? (
          <img src={thumb} alt="" className="w-full h-full object-cover" />
        ) : (
          <Icon name={iconFor(entry)} size={iconSize} className={isFolder ? 'text-accent' : 'text-[var(--ink-40)]'} />
        )}
      </div>
      {h.renaming === entry.id ? (
        <RenameInput initial={entry.name} onCommit={(name) => h.onRenameCommit(entry.id, name)} onCancel={h.onRenameCancel} />
      ) : (
        <span className="text-[12px] text-[var(--ink-70)] truncate px-0.5" title={entry.name}>
          {entry.name}
        </span>
      )}
      {mode !== 'small' && isWidgetFileEntry(entry) && entry.docId && <DeskLine desks={h.desks[entry.docId]} compact />}
    </button>
  )
}

// ── Shared bits ───────────────────────────────────────────────────────────────

/**
 * "On Launch plan" under a work widget file's name. The first desks named are
 * links to them; the tooltip names every desk. Nothing while loading.
 */
function DeskLine({ desks, compact = false }: { desks: WidgetFileDesk[] | undefined; compact?: boolean }): JSX.Element | null {
  const line = widgetFileDeskLine(desks)
  if (!line || !desks) return null
  const go = (e: React.MouseEvent, deskId: string): void => {
    e.stopPropagation()
    useViewStore.getState().goTask(deskId)
  }
  const shown = desks.slice(0, desks.length > 2 ? 2 : desks.length)
  return (
    <span
      data-testid="files-widget-desks"
      data-desk-count={desks.length}
      title={desks.length > 0 ? `On ${desks.map((d) => d.deskTitle).join(', ')}` : 'In Files only. Drag it onto a desk to place it there.'}
      className={`truncate text-[10.5px] leading-tight text-[var(--ink-40)] ${compact ? 'px-0.5' : ''}`}
    >
      {desks.length === 0 ? (
        line
      ) : (
        <>
          On{' '}
          {shown.map((d, i) => (
            <span key={d.deskId}>
              {i > 0 && (desks.length === 2 ? ' and ' : ', ')}
              <span
                role="link"
                tabIndex={-1}
                onClick={(e) => go(e, d.deskId)}
                onDoubleClick={(e) => e.stopPropagation()}
                className="hover:text-accent hover:underline cursor-pointer"
              >
                {d.deskTitle}
              </span>
            </span>
          ))}
          {desks.length > 2 && ` and ${desks.length - 2} more desk${desks.length - 2 === 1 ? '' : 's'}`}
        </>
      )}
    </span>
  )
}

function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (name: string) => void; onCancel: () => void }): JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      defaultValue={initial}
      data-testid="files-rename-input"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit((e.target as HTMLInputElement).value)
        else if (e.key === 'Escape') onCancel()
      }}
      onBlur={(e) => onCommit(e.target.value)}
      className="min-w-0 flex-1 bg-[var(--surface-raised)] border border-accent rounded px-1 py-0.5 text-[12px]"
    />
  )
}

function EmptyState({ onAddFiles, onNewFolder }: { onAddFiles: () => void; onNewFolder: () => void }): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center text-center py-20 text-[var(--ink-40)]" data-testid="files-empty">
      <Icon name="folder_open" size={48} className="text-[var(--ink-30)] mb-3" />
      <p className="text-[14px] text-[var(--ink-50)]">This folder is empty</p>
      <p className="text-[12px] mb-4">Drag files in, or use the buttons below.</p>
      <div className="flex gap-2">
        <button onClick={onNewFolder} className="fb-btn-surface text-[12px] px-3 py-1.5 text-[var(--ink-70)]">New folder</button>
        <button onClick={onAddFiles} className="btn-primary text-[12px] px-3 py-1.5">Add files</button>
      </div>
    </div>
  )
}

function DocPickerModal({
  docs,
  onPick,
  onClose
}: {
  docs: Array<{ id: string; title: string; docType: string }>
  onPick: (id: string) => void
  onClose: () => void
}): JSX.Element {
  return (
    <div className="fixed inset-0 z-[250] bg-black/40 flex items-center justify-center" onMouseDown={onClose}>
      <div className="fb-card w-[420px] max-w-[92vw] max-h-[80vh] overflow-auto p-4" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <Icon name="post_add" size={16} className="text-accent" />
          <span className="text-[14px] font-semibold text-[var(--ink-90)]">File an existing document here</span>
          <button onClick={onClose} className="ml-auto icon-btn"><Icon name="close" size={15} /></button>
        </div>
        {docs.length === 0 ? (
          <p className="text-[13px] text-[var(--ink-50)]">Every document is already filed in a folder. Create new docs from the Documents area.</p>
        ) : (
          <div className="space-y-0.5">
            {docs.map((d) => (
              <button
                key={d.id}
                onClick={() => onPick(d.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[13px] hover:bg-[var(--surface-sunken)]"
              >
                <Icon name={d.docType === 'sheet' ? 'table_chart' : d.docType === 'slides' ? 'slideshow' : 'description'} size={16} className="text-[var(--ink-40)]" />
                <span className="truncate text-[var(--ink-70)]">{d.title || 'Untitled'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
