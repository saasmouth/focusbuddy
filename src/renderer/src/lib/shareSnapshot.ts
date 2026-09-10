import type { FbNode, NodeKind, SectionLayout, Widget, DocType } from '@shared/types'
import { MAX_SYNCED_FILE_BYTES } from '@shared/fileSyncLimits'

// Snapshot shapes — the on-the-wire contract between desktop, signal
// server, and public viewer. Versioned via `_version` so we can evolve
// without breaking deployed viewers. The signal server stores these as
// opaque JSON; only desktop + viewer parse them.
//
// The snapshot is INTENTIONALLY a copy at share-time — not a live link
// to the source workspace. Three reasons:
//   1. We never want a shared link to suddenly change under a viewer.
//   2. The owner can revoke without leaving inconsistent state.
//   3. We don't need cross-user authz on the source data.

export const SHARE_SNAPSHOT_VERSION = 1 as const

export interface ShareSnapshotBase {
  _version: typeof SHARE_SNAPSHOT_VERSION
  // Friendly handle (adjective-animal) the recipient sees as "shared by".
  // Anonymous-by-default — no email, no identity. Owner can override in
  // future when accounts ship.
  fromHandle: string
  // Wall-clock when this snapshot was minted. Viewer shows "shared 3
  // days ago" relative to this.
  capturedAt: number
}

export interface FolderSnapshot extends ShareSnapshotBase {
  kind: 'folder'
  folder: SerializedNode
  // All descendant tasks of the folder (depth-first). Each task carries
  // its own widgets so the viewer can render a folder's full contents
  // without a second roundtrip.
  tasks: SerializedTask[]
}

export interface TaskSnapshot extends ShareSnapshotBase {
  kind: 'task'
  task: SerializedTask
}

export interface WidgetSnapshot extends ShareSnapshotBase {
  kind: 'widget'
  widget: SerializedWidget
}

// An office document (doc / sheet / slides / map) shared read-only. The body is
// pre-rendered to safe, structural HTML on the desktop (where the editors live)
// so the public viewer can display it without bundling the editors.
export interface DocumentSnapshot extends ShareSnapshotBase {
  kind: 'document'
  title: string
  docType: DocType
  html: string
}

// One node of a shared Drive folder tree: a nested folder, or a document
// carrying both its rendered `html` (for the browser viewer) and its raw `body`
// (so a copy-scope recipient can import a real, editable copy).
export interface DocFolderEntry {
  type: 'folder' | 'document'
  name: string
  docType?: DocType
  html?: string
  body?: unknown
  items?: DocFolderEntry[]
}

export interface DocFolderSnapshot extends ShareSnapshotBase {
  kind: 'docfolder'
  name: string
  items: DocFolderEntry[]
}

// A raw Drive file (PDF, image, video, arbitrary binary) shared by link. The
// bytes are NOT embedded here (they'd blow the share POST body limit and bloat
// every resolve); they are hosted publicly against the share token and fetched
// by the viewer from `${signal}/share/<token>/blob`. This snapshot carries only
// the metadata the viewer needs to choose how to render (image/pdf/video/audio
// inline, else a download button) and to label the file. `hosted` is false when
// the file exceeded the public-share size cap, in which case the viewer shows an
// honest "too large to preview" note rather than a broken embed.
export interface FileSnapshot extends ShareSnapshotBase {
  kind: 'file'
  name: string
  mimeType: string
  ext: string
  sizeBytes: number
  hosted: boolean
}

export type ShareSnapshot =
  | FolderSnapshot
  | TaskSnapshot
  | WidgetSnapshot
  | DocumentSnapshot
  | DocFolderSnapshot
  | FileSnapshot

// Trim-down of FbNode — the snapshot only keeps display-relevant fields.
// Internal tracking (sortOrder, axis values, resume markdown if empty,
// extensionsMinutes) is dropped to keep the payload small and the
// viewer's render simple.
export interface SerializedNode {
  id: string
  kind: NodeKind
  title: string
  description: string
  status: string
  priority: number
  importance: number
  interest: number
  createdAt: number
  updatedAt: number
  completedAt: number | null
  dueDate: number | null
  estimateMinutes: number | null
}

export interface SerializedTask extends SerializedNode {
  kind: 'task'
  // Widgets ON THIS TASK only — not on child tasks (tasks can't have
  // task children in v1 anyway, but the type stays accurate).
  widgets: SerializedWidget[]
}

// Widget snapshot — geometry + content + style. WebView widgets ALSO
// carry their URL (in content) so the viewer can show a screenshot
// placeholder + the URL. Sticky/note/markdown/page text is preserved
// verbatim. Table widgets carry a flattened cells dump (no live editing).
export interface SerializedWidget {
  id: string
  kind: string
  title: string
  content: string
  x: number
  y: number
  width: number
  height: number
  color: string | null
  // Optional: when widget.kind === 'table', the snapshot expands the
  // backing table (schema + rows) so the viewer can render the data
  // without needing a separate fb_tables fetch. Capped to 200 rows.
  tableSnapshot?: SerializedTable
  // Optional section membership. Carried so a faithful reconstruct (live
  // canvas) can rebuild section grouping + layout; the one-off share accept
  // path ignores these, so adding them is backward compatible. parentSectionId
  // references another SerializedWidget id in the same set; layout is set only
  // on section widgets (kind === 'section').
  parentSectionId?: string | null
  layout?: SectionLayout | null
}

export interface SerializedTable {
  title: string
  columns: Array<{ id: string; type: string; label: string }>
  rows: Array<{ id: string; cells: Record<string, unknown> }>
}

// Serialize a single node into the SerializedNode shape. Strips fields
// that don't make sense for a public viewer.
function serializeNode(n: FbNode): SerializedNode {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title || '(untitled)',
    description: n.description || '',
    status: n.status,
    priority: n.priority,
    importance: n.importance,
    interest: n.interest,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    completedAt: n.completedAt,
    dueDate: n.dueDate,
    estimateMinutes: n.estimateMinutes
  }
}

function serializeWidget(w: Widget): SerializedWidget {
  return {
    id: w.id,
    kind: w.kind,
    title: w.title || '',
    content: w.content || '',
    x: w.x,
    y: w.y,
    width: w.width,
    height: w.height,
    color: w.color,
    // Section membership — undefined for plain widgets, so the wire payload and
    // the existing share-accept path are unaffected.
    parentSectionId: w.parentSectionId ?? null,
    layout: w.layout ?? null
  }
}

// ── Public builders ─────────────────────────────────────────────────────

// Build a snapshot for a single task. Pulls widgets via the IPC widgets
// API; the table-widget table data is fetched separately and inlined.
export async function buildTaskSnapshot(
  task: FbNode,
  fromHandle: string
): Promise<TaskSnapshot> {
  const widgets = await window.api.widgets.listByTask(task.id)
  const serializedWidgets: SerializedWidget[] = []
  for (const w of widgets) {
    if (w.archived) continue
    const base = serializeWidget(w)
    // Expand table widgets — the user wants to see the data, not a
    // "this is a table" placeholder. Cap rows to keep snapshot size sane.
    if (w.kind === 'table' && w.content) {
      try {
        const tableId = w.content
        const tbl = await window.api.tables.get(tableId)
        const rows = await window.api.tables.listRows(tableId)
        if (tbl) {
          base.tableSnapshot = {
            title: tbl.title,
            columns: tbl.schema.columns.map((c) => ({
              id: c.id,
              type: c.type,
              label: c.label
            })),
            rows: rows.slice(0, 200).map((r) => ({
              id: r.id,
              cells: r.cells
            }))
          }
        }
      } catch {
        // table fetch failed (e.g. deleted) — leave the widget without
        // tableSnapshot; the viewer will show a placeholder.
      }
    }
    serializedWidgets.push(base)
  }
  return {
    _version: SHARE_SNAPSHOT_VERSION,
    kind: 'task',
    fromHandle,
    capturedAt: Date.now(),
    task: {
      ...serializeNode(task),
      kind: 'task',
      widgets: serializedWidgets
    }
  }
}

// Build a snapshot for a folder. Walks descendant tasks (and any
// sub-folders flattened to their tasks for v1 — the viewer renders a
// flat task list). Calls buildTaskSnapshot for each so widgets + tables
// are inlined.
export async function buildFolderSnapshot(
  folder: FbNode,
  allNodes: FbNode[],
  fromHandle: string
): Promise<FolderSnapshot> {
  // Collect descendant TASKS only (folders inside folders become flat).
  function descendantTasks(parentId: string): FbNode[] {
    const out: FbNode[] = []
    for (const n of allNodes) {
      if (n.parentId !== parentId) continue
      if (n.archived) continue
      if (n.kind === 'task') out.push(n)
      else if (n.kind === 'folder') out.push(...descendantTasks(n.id))
    }
    return out
  }
  const tasks = descendantTasks(folder.id)
  const taskSnapshots: SerializedTask[] = []
  for (const t of tasks) {
    const ts = await buildTaskSnapshot(t, fromHandle)
    taskSnapshots.push(ts.task)
  }
  return {
    _version: SHARE_SNAPSHOT_VERSION,
    kind: 'folder',
    fromHandle,
    capturedAt: Date.now(),
    folder: serializeNode(folder),
    tasks: taskSnapshots
  }
}

// Build a snapshot for a single widget. Lightweight — no descendants.
export async function buildWidgetSnapshot(
  widget: Widget,
  fromHandle: string
): Promise<WidgetSnapshot> {
  const base = serializeWidget(widget)
  if (widget.kind === 'table' && widget.content) {
    try {
      const tbl = await window.api.tables.get(widget.content)
      const rows = await window.api.tables.listRows(widget.content)
      if (tbl) {
        base.tableSnapshot = {
          title: tbl.title,
          columns: tbl.schema.columns.map((c) => ({
            id: c.id,
            type: c.type,
            label: c.label
          })),
          rows: rows.slice(0, 200).map((r) => ({ id: r.id, cells: r.cells }))
        }
      }
    } catch {
      // ignore
    }
  }
  return {
    _version: SHARE_SNAPSHOT_VERSION,
    kind: 'widget',
    fromHandle,
    capturedAt: Date.now(),
    widget: base
  }
}

// Largest raw file we host on a public link. The same limit the server applies
// to synced bytes, and now literally the same constant -- two copies of one
// number is one copy too many, and this one already carried a comment saying it
// had to match.
export const MAX_PUBLIC_FILE_BYTES = MAX_SYNCED_FILE_BYTES

// Build a metadata snapshot for a raw Drive file. The bytes themselves are
// uploaded separately (by the shares store, against the minted token) so they
// never ride this JSON. `hosted` reflects whether the bytes will be served: true
// for files within the cap, false for oversized ones.
export function buildFileSnapshot(
  file: { name: string; mimeType: string | null; ext: string | null; sizeBytes: number | null },
  fromHandle: string
): FileSnapshot {
  const size = file.sizeBytes ?? 0
  return {
    _version: SHARE_SNAPSHOT_VERSION,
    kind: 'file',
    fromHandle,
    capturedAt: Date.now(),
    name: file.name || 'File',
    mimeType: file.mimeType || 'application/octet-stream',
    ext: (file.ext || '').replace(/^\./, ''),
    sizeBytes: size,
    hosted: size > 0 && size <= MAX_PUBLIC_FILE_BYTES
  }
}

// Generate a pseudonymous handle — adjective + animal. Used for the
// "shared by" line in the viewer. Re-uses the same lib as body double.
export function generateAnonymousHandle(): string {
  const adjectives = [
    'cosmic',
    'gentle',
    'curious',
    'rapid',
    'silent',
    'midnight',
    'amber',
    'velvet',
    'azure',
    'electric'
  ]
  const animals = [
    'koala',
    'otter',
    'lynx',
    'narwhal',
    'gecko',
    'puffin',
    'badger',
    'tapir',
    'tortoise',
    'fennec'
  ]
  const a = adjectives[Math.floor(Math.random() * adjectives.length)]
  const n = animals[Math.floor(Math.random() * animals.length)]
  return `${a}-${n}`
}
