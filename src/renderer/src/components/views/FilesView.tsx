// The file/folder manager. A Finder-like library over fb_files: folders,
// imported files of any type, and internal documents filed into folders. It
// supports four view modes (list, small icons, large icons, large preview),
// column sorting in list mode (header click toggles direction with an arrow,
// right-click a header to choose the column), per-item right-click actions,
// inline rename, drag-to-move into folders, and drag-in of OS files to import.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '@shared/fields'
import type { DocType } from '@shared/types'
import { setDocDrag } from '../../lib/docMetaCache'
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

const ENTRY_MIME = 'application/fb-entry-id'

// Lazily-fetched QuickLook thumbnails, cached across renders/remounts so
// scrolling and re-sorting never re-thumbnail the same file.
const thumbCache = new Map<string, string | null>()

function previewable(entry: FileEntry): boolean {
  if (entry.kind !== 'file') return false
  const m = entry.mimeType ?? ''
  return m.startsWith('image/') || m === 'application/pdf' || m.startsWith('video/')
}

function useThumbnail(entry: FileEntry, want: boolean): string | null {
  const key = entry.id
  const [url, setUrl] = useState<string | null>(() => thumbCache.get(key) ?? null)
  useEffect(() => {
    if (!want || !previewable(entry)) return
    if (thumbCache.has(key)) {
      setUrl(thumbCache.get(key) ?? null)
      return
    }
    let alive = true
    void window.api.files.thumbnail(entry.id, { size: 256 }).then((res) => {
      const value = res ? `data:${res.mimeType};base64,${res.base64}` : null
      thumbCache.set(key, value)
      if (alive) setUrl(value)
    })
    return () => {
      alive = false
    }
  }, [entry, key, want])
  return url
}

function iconFor(entry: FileEntry): string {
  if (entry.kind === 'folder') return 'folder'
  if (entry.kind === 'doc') return entry.docType === 'sheet' ? 'table_chart' : entry.docType === 'slides' ? 'slideshow' : 'description'
  const m = entry.mimeType ?? ''
  const ext = (entry.ext ?? '').replace(/^\./, '')
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'movie'
  if (m.startsWith('audio/')) return 'music_note'
  if (m === 'application/pdf') return 'picture_as_pdf'
  if (['doc', 'docx', 'rtf', 'odt'].includes(ext)) return 'description'
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return 'table_chart'
  if (['ppt', 'pptx', 'key'].includes(ext)) return 'slideshow'
  if (['md', 'txt'].includes(ext)) return 'article'
  if (['html', 'json', 'js', 'ts', 'css'].includes(ext)) return 'code'
  if (['zip', 'gz', 'tar', '7z', 'rar'].includes(ext)) return 'folder_zip'
  return 'draft'
}

function typeLabel(entry: FileEntry): string {
  if (entry.kind === 'folder') return 'Folder'
  if (entry.kind === 'doc') return entry.docType === 'sheet' ? 'Spreadsheet' : entry.docType === 'slides' ? 'Slides' : 'Document'
  const ext = (entry.ext ?? '').replace(/^\./, '').toUpperCase()
  return ext ? `${ext} file` : 'File'
}

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

  // Undo/redo for file operations while the manager is open. Ignored while
  // typing in an input (rename) so text editing keeps its own undo.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const tag = (document.activeElement?.tagName ?? '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      e.preventDefault()
      if (e.shiftKey) void redo()
      else void undo()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const sorted = useMemo(
    () => sortEntries(store.entries, store.sortKey, store.sortDir),
    [store.entries, store.sortKey, store.sortDir]
  )

  function openEntry(entry: FileEntry): void {
    if (entry.kind === 'folder') void store.openFolder(entry.id)
    else if (entry.kind === 'doc' && entry.docId) goDocument(entry.docId)
    else void window.api.files.open(entry.id)
  }

  async function ingestOsFiles(fileList: FileList, parentId: string | null): Promise<void> {
    const payloads: Array<{ buffer: ArrayBuffer; originalName: string; mimeType: string }> = []
    for (const f of Array.from(fileList)) {
      payloads.push({ buffer: await f.arrayBuffer(), originalName: f.name, mimeType: f.type })
    }
    if (parentId === store.cwd) {
      await store.ingestBuffers(payloads)
    } else {
      for (const p of payloads) await window.api.files.ingestBuffer({ ...p, parentId })
      await store.refresh()
    }
  }

  function entryContextItems(entry: FileEntry): CtxMenuItem[] {
    const items: CtxMenuItem[] = [{ label: 'Open', icon: 'open_in_new', onClick: () => openEntry(entry) }]
    items.push({ label: 'Rename', icon: 'edit', onClick: () => setRenaming(entry.id) })
    if (entry.kind === 'folder') {
      // Promote a whole folder to a live, checked-out shared folder. Uploads
      // its files to the server so members can open them; documents come across
      // as live-openable copies. Members organise it one at a time.
      items.push({
        label: 'Collaborate live',
        icon: 'group',
        onClick: () => {
          if (!sessionToken) return
          void promoteFolderToLive(entry.id, entry.name, sessionToken).then((res) => {
            if (res) goLiveFolder(res.liveId)
          })
        }
      })
    }
    if (entry.kind === 'file') {
      items.push({ label: 'Reveal in Finder', icon: 'folder_open', onClick: () => void window.api.fileManager.reveal(entry.id) })
    }
    // Share a file or folder (and its contents) with the team, optionally a group.
    // Doc pointers sync as their own document, so sharing them here is a no-op — omit.
    if (canShare && entry.kind !== 'doc') {
      items.push({
        label: 'Share with team or group',
        icon: 'group_add',
        onClick: () => {
          void shareToOrgOrGroup({
            name: entry.name,
            kindLabel: entry.kind === 'folder' ? 'folder and its contents' : 'file',
            sharedOrgs,
            move: (org, team) => store.moveToOrg(entry.id, org, team)
          })
        }
      })
    }
    // Public link — anyone with the URL views it in the browser. A folder shares
    // its documents (docfolder), an office doc as itself, a raw file with its
    // bytes hosted against the token. A doc pointer needs its docId as the entity.
    const publicKind: ShareableKind | null =
      entry.kind === 'folder' ? 'docfolder' : entry.kind === 'doc' ? 'document' : 'file'
    const publicEntityId = entry.kind === 'doc' ? entry.docId ?? null : entry.id
    if (publicKind && publicEntityId) {
      items.push({
        label: 'Create public link',
        icon: 'link',
        onClick: () => setLinkTarget({ kind: publicKind, id: publicEntityId, name: entry.name })
      })
    }
    items.push({ separator: true })
    items.push({
      label: entry.kind === 'folder' ? 'Delete folder and contents' : entry.kind === 'doc' ? 'Remove from folder' : 'Delete',
      icon: 'delete',
      onClick: () => void store.remove(entry.id)
    })
    return items
  }

  async function openDocPicker(): Promise<void> {
    const docs = await window.api.fileManager.unfiledDocuments()
    setDocPicker(docs)
  }

  return (
    <div
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

      <Breadcrumbs crumbs={store.crumbs} onOpen={(id) => void store.openFolder(id)} onMove={(id, target) => void store.move(id, target)} />

      <div className={`flex-1 overflow-auto px-4 py-3 relative ${dropActive ? 'ring-2 ring-accent ring-inset' : ''}`}>
        {store.loading ? (
          <div className="text-[13px] text-[var(--ink-40)] py-10 text-center">Loading…</div>
        ) : sorted.length === 0 ? (
          <EmptyState onAddFiles={() => void store.importFiles()} onNewFolder={() => void store.createFolder('New folder')} />
        ) : store.viewMode === 'list' ? (
          <ListView
            entries={sorted}
            sortKey={store.sortKey}
            sortDir={store.sortDir}
            onSort={store.setSort}
            selectedId={store.selectedId}
            renaming={renaming}
            onSelect={store.select}
            onOpen={openEntry}
            onRenameStart={setRenaming}
            onRenameCommit={(id, name) => {
              void store.rename(id, name)
              setRenaming(null)
            }}
            onRenameCancel={() => setRenaming(null)}
            onContext={(e, entry) => {
              e.preventDefault()
              setCtx({ x: e.clientX, y: e.clientY, items: entryContextItems(entry) })
            }}
            onMove={(id, target) => void store.move(id, target)}
            onDropOsFiles={(files, folderId) => void ingestOsFiles(files, folderId)}
          />
        ) : (
          <GridView
            entries={sorted}
            mode={store.viewMode}
            selectedId={store.selectedId}
            renaming={renaming}
            onSelect={store.select}
            onOpen={openEntry}
            onRenameCommit={(id, name) => {
              void store.rename(id, name)
              setRenaming(null)
            }}
            onRenameCancel={() => setRenaming(null)}
            onContext={(e, entry) => {
              e.preventDefault()
              setCtx({ x: e.clientX, y: e.clientY, items: entryContextItems(entry) })
            }}
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

// ── Breadcrumbs ─────────────────────────────────────────────────────────────
function Breadcrumbs({
  crumbs,
  onOpen,
  onMove
}: {
  crumbs: Array<{ id: string; name: string }>
  onOpen: (id: string | null) => void
  onMove: (id: string, target: string | null) => void
}): JSX.Element {
  const crumb = (label: string, id: string | null, testid?: string): JSX.Element => (
    <button
      data-testid={testid}
      onClick={() => onOpen(id)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(ENTRY_MIME)) e.preventDefault()
      }}
      onDrop={(e) => {
        const dragged = e.dataTransfer.getData(ENTRY_MIME)
        if (dragged) {
          e.preventDefault()
          onMove(dragged, id)
        }
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
  selectedId: string | null
  renaming: string | null
  onSelect: (id: string) => void
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
  const selected = h.selectedId === entry.id
  const [over, setOver] = useState(false)
  const isFolder = entry.kind === 'folder'
  return (
    <tr
      data-testid={`file-entry-${entry.id}`}
      data-kind={entry.kind}
      draggable={h.renaming !== entry.id}
      onDragStart={(e) => {
        e.dataTransfer.setData(ENTRY_MIME, entry.id)
        // An office document entry also carries the doc drag payload, so it can
        // be dropped into a table cell (doc-ref) or a doc embed elsewhere.
        if (entry.kind === 'doc' && entry.docId) {
          setDocDrag(e, {
            id: entry.docId,
            docType: (entry.docType ?? 'doc') as DocType,
            title: entry.name
          })
        }
      }}
      onDragOver={(e) => {
        if (isFolder && (e.dataTransfer.types.includes(ENTRY_MIME) || e.dataTransfer.types.includes('Files'))) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!isFolder) return
        const dragged = e.dataTransfer.getData(ENTRY_MIME)
        if (dragged) {
          e.preventDefault()
          h.onMove(dragged, entry.id)
        } else if (e.dataTransfer.files.length) {
          e.preventDefault()
          h.onDropOsFiles(e.dataTransfer.files, entry.id)
        }
        setOver(false)
      }}
      onClick={() => h.onSelect(entry.id)}
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
            <span className="truncate text-[var(--ink-90)]">{entry.name}</span>
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
  const selected = h.selectedId === entry.id
  const [over, setOver] = useState(false)
  const isFolder = entry.kind === 'folder'
  const previewH = mode === 'preview' ? 150 : mode === 'large' ? 92 : 56
  const iconSize = mode === 'preview' ? 64 : mode === 'large' ? 44 : 30
  return (
    <button
      data-testid={`file-entry-${entry.id}`}
      data-kind={entry.kind}
      draggable
      onDragStart={(e) => e.dataTransfer.setData(ENTRY_MIME, entry.id)}
      onDragOver={(e) => {
        if (isFolder && (e.dataTransfer.types.includes(ENTRY_MIME) || e.dataTransfer.types.includes('Files'))) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!isFolder) return
        const dragged = e.dataTransfer.getData(ENTRY_MIME)
        if (dragged) {
          e.preventDefault()
          h.onMove(dragged, entry.id)
        } else if (e.dataTransfer.files.length) {
          e.preventDefault()
          h.onDropOsFiles(e.dataTransfer.files, entry.id)
        }
        setOver(false)
      }}
      onClick={() => h.onSelect(entry.id)}
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
    </button>
  )
}

// ── Shared bits ───────────────────────────────────────────────────────────────
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
