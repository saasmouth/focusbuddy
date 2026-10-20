// The body shape of a LIVE FOLDER plus the pure operations the holder uses to
// edit it. A live folder is shared under a lock-holder model: one member holds
// the lock and edits, everyone else mirrors. Live DOCUMENTS no longer work this
// way — they moved to CRDT co-editing with no lock (see LiveDocEditorView), so
// do not describe the two as the same model;
// its body is a flat list of entries (folders, files, inlined documents) keyed
// by a stable id with a parentId pointer, so it carries the whole tree in one
// JSON payload. Files reference a server blob id (see liveFolderClient); the
// bytes travel through the signal server. Documents inline their body so a
// recipient can open a real copy.
//
// The edit ops here are PURE (body in, body out) so they're trivially testable
// and so the view can apply them optimistically before pushing.

export const FOLDER_BODY_VERSION = 1 as const

export interface FolderEntry {
  // Stable id within the body. For files/docs this is the originating local id;
  // it only needs to be unique within the folder and stable for parent links.
  id: string
  // null = top level of the shared folder.
  parentId: string | null
  kind: 'folder' | 'file' | 'doc'
  name: string
  // kind === 'file': the server blob id (null/absent if the upload failed) +
  // descriptive metadata so the UI can show type/size without downloading.
  blobId?: string
  mimeType?: string
  ext?: string
  sizeBytes?: number
  // kind === 'doc': the document type + an inlined body so the recipient can
  // recreate a real, openable copy.
  docType?: 'doc' | 'sheet' | 'slides'
  docBody?: unknown
}

export interface FolderBody {
  version: number
  rootName: string
  entries: FolderEntry[]
}

export function emptyFolderBody(rootName: string): FolderBody {
  return { version: FOLDER_BODY_VERSION, rootName: rootName || 'Shared folder', entries: [] }
}

// Coerce an already-parsed value into a FolderBody, reading defensively so a
// corrupt or foreign body fails to null rather than throwing in the view.
export function coerceFolderBody(obj: unknown): FolderBody | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Partial<FolderBody>
  if (!Array.isArray(o.entries)) return null
  return {
    version: typeof o.version === 'number' ? o.version : 1,
    rootName: typeof o.rootName === 'string' ? o.rootName : 'Shared folder',
    entries: (o.entries as FolderEntry[]).filter(
      (e) => e && typeof e.id === 'string' && (e.kind === 'folder' || e.kind === 'file' || e.kind === 'doc')
    )
  }
}

export function parseFolderBody(raw: string): FolderBody | null {
  try {
    return coerceFolderBody(JSON.parse(raw))
  } catch {
    return null
  }
}

// Direct children of a parent (null = top level), in stable order: folders
// first, then files/docs, each alphabetical — matching the file manager's feel.
export function childrenOf(body: FolderBody, parentId: string | null): FolderEntry[] {
  return body.entries
    .filter((e) => e.parentId === parentId)
    .sort((a, b) => {
      if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

// All descendant ids of a folder (not including the folder itself).
export function descendantIds(body: FolderBody, folderId: string): string[] {
  const out: string[] = []
  const walk = (pid: string): void => {
    for (const e of body.entries) {
      if (e.parentId === pid) {
        out.push(e.id)
        if (e.kind === 'folder') walk(e.id)
      }
    }
  }
  walk(folderId)
  return out
}

// ── Pure edit ops (return a NEW body) ──────────────────────────────────────

export function addEntry(body: FolderBody, entry: FolderEntry): FolderBody {
  return { ...body, entries: [...body.entries, entry] }
}

export function renameEntry(body: FolderBody, id: string, name: string): FolderBody {
  const next = name.trim() || 'Untitled'
  return { ...body, entries: body.entries.map((e) => (e.id === id ? { ...e, name: next } : e)) }
}

// Remove an entry and, for a folder, its whole subtree.
export function removeEntry(body: FolderBody, id: string): FolderBody {
  const doomed = new Set<string>([id, ...descendantIds(body, id)])
  return { ...body, entries: body.entries.filter((e) => !doomed.has(e.id)) }
}

// Reparent an entry. Refuses to move a folder into itself or its own subtree
// (which would orphan a cycle); returns the body unchanged in that case.
export function moveEntry(body: FolderBody, id: string, newParentId: string | null): FolderBody {
  if (id === newParentId) return body
  if (newParentId !== null) {
    const subtree = new Set<string>([id, ...descendantIds(body, id)])
    if (subtree.has(newParentId)) return body
  }
  return { ...body, entries: body.entries.map((e) => (e.id === id ? { ...e, parentId: newParentId } : e)) }
}
