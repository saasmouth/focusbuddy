// What a drag out of Files carries (pure: no DOM). The DOM half (writing it
// onto a DataTransfer, the module state readable during dragover, the webview
// shield) is renderer/src/lib/filesDrag.ts.
//
// METADATA ONLY, never bytes. A 2 GB video costs nothing to drag; a target
// reads bytes at drop time through files.read(entryId). A ref is enough to
// build the content forms a later drop needs (Phase 3): `entryId` is the
// fb_files id that 2e's ImageValue.fileId and LinkValue name, `mimeType`/`ext`
// decide the forms, `docId`/`docType`/`widgetKind` name a document or work
// widget file.

import type { DocType, WidgetKind } from './types'
import { XLSX_EXT, XLSX_MIME } from './xlsxSheet'

/** Lowercase: DataTransfer lowercases every type it stores. */
export const FILES_DRAG_MIME = 'application/x-plexii-files'
export const FILES_DRAG_VERSION = 1
/** `application/x-plexii-files-has-<marker>`: readable during dragover, when getData is not. */
export const FILES_DRAG_MARKER_PREFIX = 'application/x-plexii-files-has-'

export type FilesDragSource = 'files-panel' | 'files-view' | 'drive-widget'

export interface FileDragRef {
  /** The fb_files row: the file, the folder, or the doc pointer filed in Files. */
  entryId: string
  kind: 'file' | 'folder' | 'doc'
  name: string
  mimeType?: string
  ext?: string
  sizeBytes?: number
  /** Doc pointers and work widget files: the document behind the entry. */
  docId?: string
  docType?: DocType
  widgetKind?: WidgetKind
  /** The workspace (org) the entry lives in: 'personal' for the Personal drive. */
  orgId?: string
}

export interface FilesDragPayload {
  v: number
  source: FilesDragSource
  refs: FileDragRef[]
}

/** What a dragged entry IS, for deciding where it can go. */
export type FileSourceKind =
  | 'image'
  | 'svg'
  | 'pdf'
  | 'office-doc'
  | 'widget'
  | 'video'
  | 'audio'
  | 'text'
  /** An Excel workbook (.xlsx, .xlsm): a file in Files, not a PlexiiCells document. */
  | 'sheet'
  | 'generic'
  | 'folder'

export type FilesDragMarker = 'image' | 'svg' | 'pdf' | 'doc' | 'widget' | 'media' | 'text' | 'sheet' | 'other' | 'folder'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'])
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json'])
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'])

function extOf(ref: Pick<FileDragRef, 'ext' | 'name'>): string {
  const e = (ref.ext ?? '').replace(/^\./, '').toLowerCase()
  if (e) return e
  const m = /\.([a-z0-9]+)$/i.exec(ref.name ?? '')
  return m ? m[1]!.toLowerCase() : ''
}

/**
 * Classified from the entry's metadata. Placement (desk, Workcentre, folders)
 * only needs the family; content drops (Phase 3) sniff the bytes, "by what they
 * ARE, never by name", before converting anything.
 */
export function sourceKindOf(ref: FileDragRef): FileSourceKind {
  if (ref.kind === 'folder') return 'folder'
  if (ref.kind === 'doc') return ref.docType === 'widget' ? 'widget' : 'office-doc'
  const mime = (ref.mimeType ?? '').toLowerCase()
  const ext = extOf(ref)
  if (mime === 'image/svg+xml' || ext === 'svg') return 'svg'
  if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image'
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mime.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video'
  if (mime.startsWith('audio/') || AUDIO_EXT.has(ext)) return 'audio'
  if (XLSX_EXT.has(ext) || XLSX_MIME.has(mime)) return 'sheet'
  if (TEXT_EXT.has(ext) || mime === 'text/plain' || mime === 'text/markdown' || mime === 'text/csv' || mime === 'application/json')
    return 'text'
  return 'generic'
}

export function markerOf(kind: FileSourceKind): FilesDragMarker {
  switch (kind) {
    case 'office-doc':
      return 'doc'
    case 'video':
    case 'audio':
      return 'media'
    case 'generic':
      return 'other'
    default:
      return kind
  }
}

/** The marker MIME types a payload adds, one per distinct kind. */
export function markerTypesFor(refs: FileDragRef[]): string[] {
  return Array.from(new Set(refs.map((r) => FILES_DRAG_MARKER_PREFIX + markerOf(sourceKindOf(r)))))
}

/** The markers present in a drag's type list (dragover). */
export function markersIn(types: readonly string[]): FilesDragMarker[] {
  return types
    .filter((t) => t.startsWith(FILES_DRAG_MARKER_PREFIX))
    .map((t) => t.slice(FILES_DRAG_MARKER_PREFIX.length) as FilesDragMarker)
}

export function serializeFilesDrag(source: FilesDragSource, refs: FileDragRef[]): string {
  const payload: FilesDragPayload = { v: FILES_DRAG_VERSION, source, refs }
  return JSON.stringify(payload)
}

export const NEWER_VERSION_REASON = 'This was dragged from a newer PlexiiDesk.'

export type FilesDragParse = { ok: true; payload: FilesDragPayload } | { ok: false; reason: string | null }

/**
 * Parse a payload. An unknown version is REFUSED with a reason, never guessed
 * at (the same rule as Draw's clipboard): a newer app may mean something this
 * one would get wrong. Malformed data is not ours: `reason: null`.
 */
export function parseFilesDrag(raw: string | null | undefined): FilesDragParse {
  if (!raw) return { ok: false, reason: null }
  let p: unknown
  try {
    p = JSON.parse(raw)
  } catch {
    return { ok: false, reason: null }
  }
  if (!p || typeof p !== 'object') return { ok: false, reason: null }
  const o = p as Record<string, unknown>
  if (typeof o.v !== 'number') return { ok: false, reason: null }
  if (o.v !== FILES_DRAG_VERSION) return { ok: false, reason: o.v > FILES_DRAG_VERSION ? NEWER_VERSION_REASON : null }
  if (!Array.isArray(o.refs)) return { ok: false, reason: null }
  const refs: FileDragRef[] = []
  for (const r of o.refs) {
    if (!r || typeof r !== 'object') continue
    const x = r as Record<string, unknown>
    if (typeof x.entryId !== 'string' || !x.entryId) continue
    if (x.kind !== 'file' && x.kind !== 'folder' && x.kind !== 'doc') continue
    refs.push({
      entryId: x.entryId,
      kind: x.kind,
      name: typeof x.name === 'string' ? x.name : '',
      mimeType: typeof x.mimeType === 'string' ? x.mimeType : undefined,
      ext: typeof x.ext === 'string' ? x.ext : undefined,
      sizeBytes: typeof x.sizeBytes === 'number' ? x.sizeBytes : undefined,
      docId: typeof x.docId === 'string' ? x.docId : undefined,
      docType: typeof x.docType === 'string' ? (x.docType as DocType) : undefined,
      widgetKind: typeof x.widgetKind === 'string' ? (x.widgetKind as WidgetKind) : undefined,
      orgId: typeof x.orgId === 'string' ? x.orgId : undefined
    })
  }
  if (!refs.length) return { ok: false, reason: null }
  const source = o.source === 'files-view' || o.source === 'drive-widget' ? o.source : 'files-panel'
  return { ok: true, payload: { v: FILES_DRAG_VERSION, source, refs } }
}

/** "Q3 report.pdf", or "3 items". */
export function dragLabel(refs: FileDragRef[]): string {
  if (refs.length === 1) return refs[0]!.name || 'Untitled'
  return `${refs.length} items`
}
