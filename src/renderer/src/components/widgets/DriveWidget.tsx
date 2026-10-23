import { useCallback, useEffect, useRef, useState } from 'react'
import type { Widget } from '@shared/types'
import type { FileEntry } from '@shared/fields'
import WidgetFrame from './WidgetFrame'
import FolderPickerModal from '../FolderPickerModal'
import Icon from '../Icon'
import { useWidgetStore } from '../../stores/widgets'
import { useViewStore } from '../../stores/view'
import { useFileManagerStore } from '../../stores/fileManager'
import { useOrgStore } from '../../stores/org'
import { FILES_DRAG_MIME, readFilesDrag, refFromEntry, setFilesDragImage, writeFilesDrag } from '../../lib/filesDrag'
import { moveFilesInto } from '../../lib/filesDrop'
import { useNoticeStore } from '../../stores/notice'

interface Props {
  widget: Widget
  inline?: boolean
}

// Drive widget — a folder of the Files manager, placed on a desk. Unlike the
// single-file FileWidget, a Drive is bound to a folder: it lists that folder's
// contents, opens it in the Files view, and — crucially — any file dropped or
// added through it SAVES INTO that folder, so the desk becomes a live window on a
// specific place in your files rather than a one-off attachment.
//
// widget.content holds the bound folder id (an fb_files folder). The ROOT
// sentinel means "the whole Files drive" (the file manager's top level, which the
// APIs address as parentId = null). Empty content = not bound yet.
const ROOT = '__drive_root__'

function folderIdFromContent(content: string): { bound: boolean; parentId: string | null } {
  if (!content) return { bound: false, parentId: null }
  if (content === ROOT) return { bound: true, parentId: null }
  return { bound: true, parentId: content }
}

const iconForEntry = (e: FileEntry): string =>
  e.kind === 'folder' ? 'folder' : e.kind === 'doc' ? 'description' : 'draft'

export default function DriveWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const goFiles = useViewStore((s) => s.goFiles)
  const openFolder = useFileManagerStore((s) => s.openFolder)

  const { bound, parentId } = folderIdFromContent(widget.content ?? '')
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [folderName, setFolderName] = useState<string>('')
  const [picking, setPicking] = useState(false)
  const [dropping, setDropping] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (!bound) {
      setEntries(null)
      return
    }
    const list = await window.api.fileManager.list(parentId)
    setEntries(list)
    if (parentId === null) {
      setFolderName('All files')
    } else {
      const meta = await window.api.fileManager.get(parentId)
      setFolderName(meta?.name ?? 'Folder')
    }
  }, [bound, parentId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function bindTo(folderId: string | null): void {
    setPicking(false)
    const content = folderId ?? ROOT
    // Title the widget after the folder so the header reads as the drive's name.
    void (async () => {
      let name = 'All files'
      if (folderId) {
        const meta = await window.api.fileManager.get(folderId)
        name = meta?.name ?? 'Drive'
      }
      void update(widget.id, { content, title: name })
    })()
  }

  async function ingestInto(files: File[]): Promise<void> {
    if (!bound || files.length === 0) return
    for (const f of files) {
      const buffer = await f.arrayBuffer()
      await window.api.files.ingestBuffer({
        buffer,
        originalName: f.name,
        mimeType: f.type || 'application/octet-stream',
        parentId
      })
    }
    await refresh()
  }

  /** What this drive takes: things from Files (moved in) and Finder files (saved in). */
  const takes = (dt: DataTransfer): boolean => dt.types.includes(FILES_DRAG_MIME) || dt.types.includes('Files')

  async function handleDrop(e: React.DragEvent): Promise<void> {
    setDropping(false)
    // Only the drops it takes: anything else (a palette kind, a link) falls
    // through to the desk, which places it beside this drive.
    if (!takes(e.dataTransfer)) return
    e.preventDefault()
    if (e.dataTransfer.types.includes(FILES_DRAG_MIME)) {
      const read = readFilesDrag(e.dataTransfer)
      if (!read.ok) {
        if (read.reason) useNoticeStore.getState().show({ text: read.reason, icon: 'info' })
        return
      }
      // Moved into the bound folder (one undo); a folder into itself is refused.
      await moveFilesInto(read.payload.refs, parentId)
      await refresh()
      return
    }
    const dropped = Array.from(e.dataTransfer.files ?? [])
    if (dropped.length) await ingestInto(dropped)
  }

  function openInFiles(): void {
    goFiles()
    void openFolder(parentId)
  }

  // ── Unbound state: choose the folder this drive points at ────────────────
  const body = !bound ? (
    <div className="h-full w-full flex flex-col items-center justify-center gap-3 p-4 text-center bg-[var(--surface-sunken)]">
      <Icon name="folder_open" size={28} className="text-[var(--ink-40)]" />
      <div className="text-[12px] text-[var(--ink-70)]">
        Point this drive at a folder. Files you add save there.
      </div>
      <button
        type="button"
        onClick={() => setPicking(true)}
        className="text-[11px] px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 transition-opacity"
        data-testid="drive-choose-folder"
      >
        Choose folder…
      </button>
    </div>
  ) : (
    <div
      className={`h-full w-full flex flex-col bg-[var(--surface-sunken)] ${
        dropping ? 'ring-2 ring-accent ring-inset' : ''
      }`}
      onDragOver={(e) => {
        if (!takes(e.dataTransfer)) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => void handleDrop(e)}
      data-testid="drive-body"
    >
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-1 px-2 py-1 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-raised)_70%,transparent)]">
        <Icon name="folder" size={14} className="text-accent shrink-0" />
        <span className="text-[11px] font-medium text-[var(--ink-90)] truncate flex-1 min-w-0" title={folderName}>
          {folderName}
        </span>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="icon-btn !h-6 !w-6 text-[var(--ink-50)] hover:text-accent"
          title="Add files to this folder"
          data-testid="drive-add-files"
        >
          <Icon name="upload" size={13} />
        </button>
        <button
          onClick={openInFiles}
          className="icon-btn !h-6 !w-6 text-[var(--ink-50)] hover:text-accent"
          title="Open in Files"
          data-testid="drive-open"
        >
          <Icon name="open_in_new" size={13} />
        </button>
        <button
          onClick={() => setPicking(true)}
          className="icon-btn !h-6 !w-6 text-[var(--ink-40)] hover:text-accent"
          title="Point at a different folder"
          data-testid="drive-rebind"
        >
          <Icon name="edit" size={12} />
        </button>
      </div>
      {/* Contents */}
      <div className="flex-1 min-h-0 overflow-auto">
        {entries === null ? (
          <div className="p-3 text-[11px] text-[var(--ink-40)]">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="p-4 text-center text-[11px] text-[var(--ink-45)]">
            Empty. Drop files here to save them into this folder.
          </div>
        ) : (
          <div className="divide-y divide-[var(--edge-soft)]">
            {entries.map((e) => (
              <button
                key={e.id}
                draggable
                onDragStart={(ev) => {
                  // A drive row drags like a Files row: onto the desk, a folder, another drive.
                  const refs = [refFromEntry(e, useOrgStore.getState().activeOrgId)]
                  writeFilesDrag(ev.dataTransfer, refs, 'drive-widget')
                  setFilesDragImage(ev.dataTransfer, refs)
                }}
                onClick={() => {
                  if (e.kind === 'folder') {
                    // Drill into a subfolder inside the widget.
                    void update(widget.id, { content: e.id, title: e.name })
                  } else {
                    openInFiles()
                  }
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                data-testid={`drive-entry-${e.id}`}
              >
                <Icon name={iconForEntry(e)} size={14} className="text-[var(--ink-50)] shrink-0" />
                <span className="truncate text-[11.5px] text-[var(--ink-90)]">{e.name}</span>
                {e.kind === 'folder' && e.childCount != null && (
                  <span className="ml-auto text-[10px] text-[var(--ink-40)] fb-tabular">
                    {e.childCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const chosen = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (chosen.length) void ingestInto(chosen)
        }}
      />
    </div>
  )

  const withModal = (
    <>
      {body}
      {picking && (
        <FolderPickerModal
          title="Point this drive at a folder"
          currentParentId={parentId}
          onPick={(id) => bindTo(id)}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  )

  if (inline) return withModal
  return (
    <WidgetFrame widget={widget} headerLabel={bound ? folderName || 'Drive' : 'Drive'} headerAccent="bg-amber-300/50 dark:bg-amber-400/20">
      {withModal}
    </WidgetFrame>
  )
}
