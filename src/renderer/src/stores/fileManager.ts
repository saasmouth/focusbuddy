import { create } from 'zustand'
import type { FileEntry } from '@shared/fields'
import { nudgeSync } from '../lib/syncNudge'
import { fileTypeKey } from '../lib/fileEntryType'
import { crdtEmitFileName, crdtEmitFileParent, crdtEmitFileCreate, crdtEmitFileDelete } from '../lib/crdtBridge'

// State for the file/folder manager view. The current folder (cwd, null = root)
// drives the listing; view mode and sort are persisted so the manager opens the
// way the user left it. All mutations go through window.api.fileManager and then
// refresh, so the DB stays the single source of truth.

export type FileViewMode = 'list' | 'small' | 'large' | 'preview'
export type FileSortKey = 'name' | 'size' | 'type' | 'created' | 'modified'
export type SortDir = 'asc' | 'desc'
/**
 * What the Files list is narrowed to: everything, a broad family, or one widget
 * file type ('widget:table'). See lib/fileEntryType for how an entry is typed.
 */
export type FileTypeFilter = 'all' | 'folders' | 'files' | 'documents' | 'widgets' | `widget:${string}`

const PREFS_KEY = 'fb.files.prefs'

function readPrefs(): { viewMode: FileViewMode; sortKey: FileSortKey; sortDir: SortDir } {
  const fallback = { viewMode: 'list' as FileViewMode, sortKey: 'name' as FileSortKey, sortDir: 'asc' as SortDir }
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    return raw ? { ...fallback, ...(JSON.parse(raw) as object) } : fallback
  } catch {
    return fallback
  }
}

function persistPrefs(p: { viewMode: FileViewMode; sortKey: FileSortKey; sortDir: SortDir }): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}

// One reversible action: undo and redo are async because they call the IPC
// layer. We keep the inverse rather than snapshots so undo stays cheap and the
// DB remains the source of truth.
interface UndoItem {
  label: string
  undo: () => Promise<void>
  redo: () => Promise<void>
}

/**
 * Which Files surface a piece of browsing state belongs to. The full-screen
 * Files view is 'main'; the panel beside your work (the flyout, its pinned dock
 * and the floating panel) is 'panel'. Each has its OWN folder, listing,
 * selection, search and type filter, so opening Files full screen, clicking a
 * Drive work widget or the Work widgets heading never yanks the panel to
 * another folder. File OPERATIONS (move, rename, create, delete) are shared,
 * with one undo stack.
 */
export type FileBrowserKey = 'main' | 'panel'

/** Per-instance browsing state and its actions (see FileBrowserKey). */
export interface FileBrowseState {
  cwd: string | null
  crumbs: Array<{ id: string; name: string }>
  entries: FileEntry[]
  loading: boolean
  /** The focused (last clicked) entry; the anchor for ⇧-click ranges. */
  selectedId: string | null
  /** Every selected entry (⌘-click and ⇧-click build it). Always contains selectedId when set. */
  selectedIds: string[]
  viewMode: FileViewMode
  sortKey: FileSortKey
  sortDir: SortDir
  typeFilter: FileTypeFilter
  // Drive-wide search: when `search` is non-empty the view shows searchResults
  // (matches across every folder) instead of the current folder's entries.
  search: string
  searchResults: FileEntry[]
  searching: boolean
  /** True once this instance has listed a folder (the panel starts idle until it is opened). */
  started: boolean
  refresh: () => Promise<void>
  runSearch: (q: string) => Promise<void>
  clearSearch: () => void
  openFolder: (id: string | null) => Promise<void>
  select: (id: string | null) => void
  /** Replace the selection; `focus` becomes selectedId (defaults to the last id). */
  setSelection: (ids: string[], focus?: string | null) => void
  setViewMode: (m: FileViewMode) => void
  setSort: (key: FileSortKey) => void
  setTypeFilter: (f: FileTypeFilter) => void
}

interface FileManagerStore extends FileBrowseState {
  past: UndoItem[]
  future: UndoItem[]
  // Trash: the roots of trashed subtrees, loaded on demand for the Trash view.
  trashed: FileEntry[]
  // Facets: the tag vocabulary, and the active tag view (every file carrying it,
  // wherever it physically sits). A tag is a folder that spans the whole Drive.
  tags: Array<{ tag: string; count: number }>
  activeTag: string | null
  tagEntries: FileEntry[]
  // Smart folders: saved tag queries (AND), optionally with a search term, that
  // always show the matching files.
  smartFolders: Array<{ id: string; name: string; tags: string[]; search: string }>
  activeSmart: { id: string; name: string; tags: string[]; search: string } | null
  smartEntries: FileEntry[]
  // Items (files + filed docs) that carry no tags yet — the Drive offers to
  // auto-file these proactively.
  untagged: FileEntry[]

  loadTrash: () => Promise<void>
  restoreFromTrash: (id: string) => Promise<void>
  purge: (id: string) => Promise<void>
  loadTags: () => Promise<void>
  loadUntagged: () => Promise<void>
  addTags: (fileId: string, tags: string[]) => Promise<void>
  removeTag: (fileId: string, tag: string) => Promise<void>
  openTag: (tag: string) => Promise<void>
  clearTag: () => void
  loadSmartFolders: () => Promise<void>
  createSmart: (name: string, tags: string[], search?: string) => Promise<void>
  deleteSmart: (id: string) => Promise<void>
  openSmart: (sf: { id: string; name: string; tags: string[]; search: string }) => Promise<void>
  clearSmart: () => void
  /** Create a folder in `parentId` (default: the full view's current folder). Resolves to the new folder. */
  createFolder: (name: string, parentId?: string | null) => Promise<FileEntry | void>
  rename: (id: string, name: string) => Promise<void>
  move: (id: string, newParentId: string | null) => Promise<void>
  /**
   * Move several entries into one folder as ONE undo step. Entries already in
   * the target, the target itself, and folders that would land inside
   * themselves are skipped. Resolves to how many moved.
   */
  moveMany: (ids: string[], newParentId: string | null) => Promise<number>
  // Share a file/folder (and its contents) with an org, optionally scoped to a
  // single team/group — re-scopes the subtree so it syncs (bytes and all) to the
  // org, or just that group's members.
  moveToOrg: (id: string, orgId: string, teamId?: string | null) => Promise<void>
  remove: (id: string) => Promise<void>
  importFiles: (parentId?: string | null) => Promise<void>
  // Import a whole local folder (recursively) into the Drive + brain.
  importFolder: (parentId?: string | null) => Promise<{ files: number; folders: number; skipped: number } | null>
  ingestBuffers: (
    files: Array<{ buffer: ArrayBuffer; originalName: string; mimeType: string }>,
    parentId?: string | null
  ) => Promise<void>
  fileExistingDocument: (docId: string) => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
}

const prefs = readPrefs()

/**
 * The browsing half of a Files surface. Built twice: once inside the main
 * store (the full view, which also persists its view mode and sort) and once
 * as the panel's own store.
 */
function browseSlice(
  set: (partial: Partial<FileBrowseState>) => void,
  get: () => FileBrowseState,
  opts: { persist: boolean; initial: { viewMode: FileViewMode; sortKey: FileSortKey; sortDir: SortDir } }
): FileBrowseState {
  const save = (): void => {
    if (!opts.persist) return
    const st = get()
    persistPrefs({ viewMode: st.viewMode, sortKey: st.sortKey, sortDir: st.sortDir })
  }
  return {
    cwd: null,
    crumbs: [],
    entries: [],
    loading: false,
    selectedId: null,
    selectedIds: [],
    viewMode: opts.initial.viewMode,
    sortKey: opts.initial.sortKey,
    sortDir: opts.initial.sortDir,
    typeFilter: 'all',
    search: '',
    searchResults: [],
    searching: false,
    started: false,

    refresh: async () => {
      const cwd = get().cwd
      set({ loading: true })
      const [entries, crumbs] = await Promise.all([
        window.api.fileManager.list(cwd),
        window.api.fileManager.path(cwd)
      ])
      // A folder opened while this listing was in flight wins.
      if (get().cwd !== cwd) return
      // Keep only selections that still exist here (a moved row leaves the listing).
      const present = new Set(entries.map((e) => e.id))
      const keep = get().search ? get().selectedIds : get().selectedIds.filter((id) => present.has(id))
      const focus = get().selectedId && keep.includes(get().selectedId as string) ? get().selectedId : (keep[keep.length - 1] ?? null)
      set({ entries, crumbs, loading: false, started: true, selectedIds: keep, selectedId: focus })
    },

    runSearch: async (q) => {
      set({ search: q })
      const query = q.trim()
      if (!query) {
        set({ searchResults: [], searching: false })
        return
      }
      set({ searching: true })
      const results = await window.api.fileManager.search(query)
      // Ignore a stale response if the query moved on while this one was in flight.
      if (get().search.trim() === query) set({ searchResults: results, searching: false })
    },
    clearSearch: () => set({ search: '', searchResults: [], searching: false }),

    openFolder: async (id) => {
      set({ cwd: id, selectedId: null, selectedIds: [] })
      await get().refresh()
    },

    select: (id) => set({ selectedId: id, selectedIds: id ? [id] : [] }),
    setSelection: (ids, focus) => {
      const uniq = Array.from(new Set(ids))
      const f = focus === undefined ? (uniq[uniq.length - 1] ?? null) : focus
      set({ selectedIds: uniq, selectedId: f })
    },

    setViewMode: (m) => {
      set({ viewMode: m })
      save()
    },
    setTypeFilter: (f) => set({ typeFilter: f }),
    setSort: (key) => {
      const { sortKey, sortDir } = get()
      const nextDir: SortDir = sortKey === key ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc'
      set({ sortKey: key, sortDir: nextDir })
      save()
    }
  }
}

/**
 * The panel's browsing state (the flyout, its pinned dock and the floating
 * panel share it, so switching between them keeps the folder and selection).
 */
export const useFilesPanelBrowser = create<FileBrowseState>((set, get) =>
  browseSlice(set, get, {
    persist: false,
    initial: { viewMode: 'list', sortKey: 'name', sortDir: 'asc' }
  })
)

/** Where an entry sits now, from whatever listing has it, else from the DB. */
async function parentOf(id: string, fallback: string | null): Promise<string | null> {
  for (const st of [useFileManagerStore.getState(), useFilesPanelBrowser.getState()]) {
    const hit = st.entries.find((e) => e.id === id) ?? st.searchResults.find((e) => e.id === id)
    if (hit) return hit.parentId ?? null
  }
  try {
    const meta = await window.api.fileManager.get(id)
    if (meta) return meta.parentId ?? null
  } catch {
    /* unknown: fall back */
  }
  return fallback
}

export const useFileManagerStore = create<FileManagerStore>((set, get) => {
  const mainSlice = browseSlice(set, get, { persist: true, initial: prefs })
  return {
  ...mainSlice,
  past: [],
  future: [],
  trashed: [],
  tags: [],
  activeTag: null,
  tagEntries: [],
  smartFolders: [],
  activeSmart: null,
  smartEntries: [],
  untagged: [],

  // Callers outside Files (sync, org switch, workspace import) call refresh()
  // after something changed underneath: every surface that is showing a
  // listing re-reads it, the panel included.
  refresh: async () => {
    const panel = useFilesPanelBrowser.getState()
    await Promise.all([mainSlice.refresh(), panel.started ? panel.refresh() : Promise.resolve()])
  },

  loadTrash: async () => {
    const trashed = await window.api.fileManager.listTrashed()
    set({ trashed })
  },
  restoreFromTrash: async (id) => {
    await window.api.fileManager.restoreDeep(id)
    await get().loadTrash()
    await get().refresh()
  },
  purge: async (id) => {
    await window.api.fileManager.purge(id)
    await get().loadTrash()
  },

  loadTags: async () => {
    set({ tags: await window.api.fileManager.allTags() })
  },
  loadUntagged: async () => {
    set({ untagged: await window.api.fileManager.untaggedEntries() })
  },
  addTags: async (fileId, tags) => {
    await window.api.fileManager.addTags(fileId, tags)
    await get().loadTags()
    await get().loadUntagged()
    // If a tag view is open, refresh it so a newly-tagged file appears.
    const active = get().activeTag
    if (active) set({ tagEntries: await window.api.fileManager.entriesByTag(active) })
  },
  removeTag: async (fileId, tag) => {
    await window.api.fileManager.removeTag(fileId, tag)
    await get().loadTags()
    await get().loadUntagged()
    const active = get().activeTag
    if (active) set({ tagEntries: await window.api.fileManager.entriesByTag(active) })
  },
  openTag: async (tag) => {
    set({ activeTag: tag, tagEntries: await window.api.fileManager.entriesByTag(tag), activeSmart: null })
  },
  clearTag: () => set({ activeTag: null, tagEntries: [] }),

  loadSmartFolders: async () => {
    set({ smartFolders: await window.api.fileManager.listSmartFolders() })
  },
  createSmart: async (name, tags, search) => {
    await window.api.fileManager.createSmartFolder(name, tags, search)
    await get().loadSmartFolders()
  },
  deleteSmart: async (id) => {
    await window.api.fileManager.deleteSmartFolder(id)
    if (get().activeSmart?.id === id) set({ activeSmart: null, smartEntries: [] })
    await get().loadSmartFolders()
  },
  openSmart: async (sf) => {
    set({
      activeSmart: sf,
      smartEntries: await window.api.fileManager.smartFolderEntries(sf.tags, sf.search),
      activeTag: null
    })
  },
  clearSmart: () => set({ activeSmart: null, smartEntries: [] }),

  createFolder: async (name, parentId) => {
    const folder = await window.api.fileManager.createFolder(parentId === undefined ? get().cwd : parentId, name)
    // WS01 sync substrate (flagged): materialise the folder on other devices.
    crdtEmitFileCreate(folder)
    record(set, get, {
      label: 'Create folder',
      // A created folder is removed by trashing it (recoverable), and brought
      // back by restoring — keeping the same id so later history stays valid.
      undo: async () => {
        await window.api.fileManager.delete(folder.id)
      },
      redo: async () => {
        await window.api.fileManager.restore([folder.id])
      }
    })
    await get().refresh()
    return folder
  },
  rename: async (id, name) => {
    const before =
      get().entries.find((e) => e.id === id)?.name ??
      useFilesPanelBrowser.getState().entries.find((e) => e.id === id)?.name ??
      (await window.api.fileManager.get(id).catch(() => null))?.name ??
      ''
    await window.api.fileManager.rename(id, name)
    // WS01 sync substrate (flagged): a rename is a 'name' LWW register. No-op off.
    crdtEmitFileName(id, name)
    record(set, get, {
      label: 'Rename',
      undo: async () => {
        await window.api.fileManager.rename(id, before)
      },
      redo: async () => {
        await window.api.fileManager.rename(id, name)
      }
    })
    await get().refresh()
  },
  move: async (id, newParentId) => {
    const before = await parentOf(id, get().cwd)
    const ok = await window.api.fileManager.move(id, newParentId)
    if (!ok) return
    // WS01 sync substrate (flagged): a move is a 'parent' LWW register. No-op off.
    crdtEmitFileParent(id, newParentId)
    record(set, get, {
      label: 'Move',
      undo: async () => {
        await window.api.fileManager.move(id, before)
      },
      redo: async () => {
        await window.api.fileManager.move(id, newParentId)
      }
    })
    await get().refresh()
  },
  moveMany: async (ids, newParentId) => {
    const moved: Array<{ id: string; before: string | null }> = []
    for (const id of Array.from(new Set(ids))) {
      if (id === newParentId) continue
      const before = await parentOf(id, get().cwd)
      if (before === newParentId) continue
      // The DB refuses a folder into its own descendant; that one is skipped.
      const ok = await window.api.fileManager.move(id, newParentId)
      if (!ok) continue
      crdtEmitFileParent(id, newParentId)
      moved.push({ id, before })
    }
    if (moved.length) {
      record(set, get, {
        label: moved.length === 1 ? 'Move' : `Move ${moved.length} items`,
        undo: async () => {
          for (const m of [...moved].reverse()) await window.api.fileManager.move(m.id, m.before)
        },
        redo: async () => {
          for (const m of moved) await window.api.fileManager.move(m.id, newParentId)
        }
      })
    }
    await get().refresh()
    return moved.length
  },
  moveToOrg: async (id, orgId, teamId) => {
    const moved = await window.api.fileManager.moveToOrg(id, orgId, teamId)
    if (!moved?.length) return
    // The item left the active (personal) org; refresh drops it from this view.
    // It now belongs to the team org and appears when that org is active, and the
    // nudge pushes it (metadata + file bytes) to every member right away.
    await get().refresh()
    nudgeSync()
  },
  remove: async (id) => {
    const ids = await window.api.fileManager.delete(id)
    set({ selectedId: null })
    // WS01 sync substrate (flagged): tombstone every removed entry (a folder delete
    // cascades) so the removal converges on other devices.
    for (const rid of ids) crdtEmitFileDelete(rid)
    if (ids.length) {
      record(set, get, {
        label: 'Delete',
        undo: async () => {
          await window.api.fileManager.restore(ids)
        },
        redo: async () => {
          await window.api.fileManager.delete(id)
        }
      })
    }
    await get().refresh()
  },
  importFiles: async (parentId) => {
    const added = await window.api.fileManager.pickFiles(parentId === undefined ? get().cwd : parentId)
    const ids = added.map((f) => f.id)
    if (ids.length) {
      record(set, get, {
        label: 'Import files',
        undo: async () => {
          for (const fid of ids) await window.api.fileManager.delete(fid)
        },
        redo: async () => {
          await window.api.fileManager.restore(ids)
        }
      })
    }
    await get().refresh()
  },
  importFolder: async (parentId) => {
    const res = await window.api.fileManager.importFolder(parentId === undefined ? get().cwd : parentId)
    if (!res?.ok) return null
    await get().refresh()
    // Fold the freshly-imported files into the brain so they're searchable/graphed
    // right away, rather than only on the next Brain open.
    void window.api.brain.ingestWorkspace().catch(() => {})
    return { files: res.files ?? 0, folders: res.folders ?? 0, skipped: res.skipped ?? 0 }
  },
  ingestBuffers: async (files, parentId) => {
    const cwd = parentId === undefined ? get().cwd : parentId
    const ids: string[] = []
    for (const f of files) {
      const created = await window.api.files.ingestBuffer({ ...f, parentId: cwd })
      ids.push(created.id)
    }
    if (ids.length) {
      record(set, get, {
        label: 'Add files',
        undo: async () => {
          for (const fid of ids) await window.api.fileManager.delete(fid)
        },
        redo: async () => {
          await window.api.fileManager.restore(ids)
        }
      })
    }
    await get().refresh()
  },
  fileExistingDocument: async (docId) => {
    await window.api.fileManager.fileDocument(docId, get().cwd)
    await get().refresh()
  },
  undo: async () => {
    const past = get().past
    const item = past[past.length - 1]
    if (!item) return
    set({ past: past.slice(0, -1), future: [...get().future, item] })
    await item.undo()
    await get().refresh()
  },
  redo: async () => {
    const future = get().future
    const item = future[future.length - 1]
    if (!item) return
    set({ future: future.slice(0, -1), past: [...get().past, item] })
    await item.redo()
    await get().refresh()
  }
  }
})

// Push a reversible action onto the undo stack, clearing the redo branch.
function record(
  set: (partial: Partial<FileManagerStore>) => void,
  get: () => FileManagerStore,
  item: UndoItem
): void {
  set({ past: [...get().past, item].slice(-50), future: [] })
}

// Sort + always-folders-first comparator used by the view.
export function sortEntries(entries: FileEntry[], key: FileSortKey, dir: SortDir): FileEntry[] {
  const sign = dir === 'asc' ? 1 : -1
  // A widget file sorts by its own type ("widget:table"), so sorting by type
  // groups tables with tables rather than every widget under one "widget".
  const typeOf = (e: FileEntry): string => fileTypeKey(e)
  return entries.slice().sort((a, b) => {
    // Folders always cluster above files/docs, regardless of sort direction.
    if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1
    let cmp = 0
    switch (key) {
      case 'size':
        cmp = (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)
        break
      case 'type':
        cmp = typeOf(a).localeCompare(typeOf(b))
        break
      case 'created':
        cmp = a.createdAt - b.createdAt
        break
      case 'modified':
        cmp = a.updatedAt - b.updatedAt
        break
      default:
        cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    }
    if (cmp === 0) cmp = a.name.localeCompare(b.name, undefined, { numeric: true })
    return cmp * sign
  })
}
