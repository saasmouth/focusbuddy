// Dragging things out of Files: the ONE payload every target reads.
//
// FilesPanel, the full Files view and Drive work widget rows all start their
// drags here. The payload itself (types, version, markers) is pure and lives
// in @shared/filesDragPayload; this module puts it on a DataTransfer and keeps
// it readable while the drag is in flight.
//
// - getData is blocked during dragover; only `types` can be read. So the
//   payload is also held in module state (activeFilesDrag) from dragstart until
//   dragend, drop, or the first pointer move after the drag (which catches a
//   drop outside the window, where dragend can be lost), and marker types say
//   what kinds are in it.
// - Compatibility payloads follow ours for a single ref, so every surface that
//   took a drag from Files before keeps taking it: fb-entry-id (moves inside
//   Files), the document drag for doc pointers, the work widget file drag.
// - text/plain carries the names, one per line, as Finder does.
// - The webview shield: while a Files drag is in flight `<html>` carries
//   data-fb-files-drag, and globals.css makes webviews and iframes pointer
//   transparent, so a desk browser never swallows the drag or navigates.

import type { FileEntry } from '@shared/fields'
import type { DocType } from '@shared/types'
import {
  FILES_DRAG_MIME,
  FILES_DRAG_MARKER_PREFIX,
  dragLabel,
  markerTypesFor,
  parseFilesDrag,
  serializeFilesDrag,
  type FileDragRef,
  type FilesDragParse,
  type FilesDragPayload,
  type FilesDragSource
} from '@shared/filesDragPayload'
import { setDocDrag } from './docMetaCache'
import { writeWidgetFileDrag } from './widgetFileDrag'
import { isWidgetFileEntry } from './fileEntryType'

export { FILES_DRAG_MIME }
export type { FileDragRef, FilesDragPayload }

/** Files' own in-app move payload (one entry id). */
export const ENTRY_DRAG_MIME = 'application/fb-entry-id'

export function refFromEntry(entry: FileEntry, orgId?: string | null): FileDragRef {
  return {
    entryId: entry.id,
    kind: entry.kind,
    name: entry.name,
    mimeType: entry.mimeType,
    ext: entry.ext,
    sizeBytes: entry.sizeBytes,
    docId: entry.docId,
    docType: entry.docType,
    widgetKind: entry.widgetKind,
    orgId: orgId ?? undefined
  }
}

let active: FilesDragPayload | null = null
let pointerWatch: (() => void) | null = null
const listeners = new Set<(p: FilesDragPayload | null) => void>()

/** The Files drag in flight, readable during dragover (where getData is not). */
export function activeFilesDrag(): FilesDragPayload | null {
  return active
}

export function onFilesDragChange(cb: (p: FilesDragPayload | null) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function setActive(p: FilesDragPayload | null): void {
  active = p
  try {
    if (p) document.documentElement.setAttribute('data-fb-files-drag', '')
    else document.documentElement.removeAttribute('data-fb-files-drag')
  } catch {
    /* no document (tests) */
  }
  for (const l of listeners) l(p)
}

/** End the drag state everywhere: dragend, drop, or the first pointer move after. */
export function clearFilesDrag(): void {
  if (pointerWatch) {
    pointerWatch()
    pointerWatch = null
  }
  if (active) setActive(null)
}

/**
 * Put a Files drag on `dt`. Call from a dragstart handler. Returns the payload.
 */
export function writeFilesDrag(dt: DataTransfer, refs: FileDragRef[], source: FilesDragSource): FilesDragPayload | null {
  if (!refs.length) return null
  const raw = serializeFilesDrag(source, refs)
  dt.setData(FILES_DRAG_MIME, raw)
  for (const t of markerTypesFor(refs)) dt.setData(t, '1')
  // Compatibility payloads, single ref only (the existing targets take one thing).
  if (refs.length === 1) {
    const r = refs[0]!
    dt.setData(ENTRY_DRAG_MIME, r.entryId)
    if (r.kind === 'doc' && r.docId) {
      if (r.docType === 'widget') writeWidgetFileDrag(dt, { id: r.docId, title: r.name })
      else setDocDrag({ dataTransfer: dt }, { id: r.docId, docType: (r.docType ?? 'doc') as DocType, title: r.name })
    }
  }
  // Names, one per line, last so no compatibility writer overrides it.
  dt.setData('text/plain', refs.map((r) => r.name).join('\n'))
  // Copy onto desks and into documents, move between folders.
  dt.effectAllowed = 'copyMove'
  const payload = parseFilesDrag(raw)
  const p = payload.ok ? payload.payload : null
  setActive(p)
  if (typeof window !== 'undefined') {
    // dragend is lost when the drop lands outside the window or the source
    // unmounts; the first pointer move after a drag means it is over.
    const arm = (): void => {
      const onMove = (): void => clearFilesDrag()
      window.addEventListener('pointermove', onMove, { once: true, capture: true })
      pointerWatch = () => window.removeEventListener('pointermove', onMove, { capture: true } as EventListenerOptions)
    }
    // Chromium fires no pointer events during a native drag; arm after this tick.
    setTimeout(arm, 0)
  }
  return p
}

/** Read a Files drag at drop time. */
export function readFilesDrag(dt: DataTransfer | null): FilesDragParse {
  if (!dt) return { ok: false, reason: null }
  let raw = ''
  try {
    raw = dt.getData(FILES_DRAG_MIME)
  } catch {
    raw = ''
  }
  if (!raw) {
    // Some hosts hide data until drop; fall back to the in-flight payload only
    // when the type list says this IS a Files drag.
    if (dragCarriesFiles(dt) && active) return { ok: true, payload: active }
    return { ok: false, reason: null }
  }
  return parseFilesDrag(raw)
}

/** For dragover, where only the type list is readable. */
export function dragCarriesFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  try {
    return Array.from(dt.types).includes(FILES_DRAG_MIME)
  } catch {
    return false
  }
}

/** Marker types in the drag (dragover-safe). */
export function dragMarkers(dt: DataTransfer | null): string[] {
  if (!dt) return []
  try {
    return Array.from(dt.types)
      .filter((t) => t.startsWith(FILES_DRAG_MARKER_PREFIX))
      .map((t) => t.slice(FILES_DRAG_MARKER_PREFIX.length))
  } catch {
    return []
  }
}

/**
 * A small chip as the drag image: "Q3 report.pdf", or "3 items" with a stack.
 * Built offscreen, captured by setDragImage, removed on the next tick.
 */
export function setFilesDragImage(dt: DataTransfer, refs: FileDragRef[]): void {
  if (typeof document === 'undefined' || typeof dt.setDragImage !== 'function') return
  try {
    const chip = document.createElement('div')
    chip.textContent = dragLabel(refs)
    chip.setAttribute('data-testid', 'files-drag-chip')
    chip.style.cssText =
      'position:fixed;top:-1000px;left:-1000px;max-width:240px;padding:4px 10px;border-radius:8px;' +
      'font:500 12px system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      'background:rgb(var(--accent));color:#fff;box-shadow:' +
      (refs.length > 1 ? '3px 3px 0 -1px rgba(0,0,0,.25),6px 6px 0 -2px rgba(0,0,0,.18)' : '0 2px 8px rgba(0,0,0,.25)')
    document.body.appendChild(chip)
    dt.setDragImage(chip, 12, 12)
    setTimeout(() => chip.remove(), 0)
  } catch {
    /* the default ghost is fine */
  }
}

/** The refs for a drag that starts on `entry`: the whole selection when the entry is in it. */
export function refsForDragStart(
  entry: FileEntry,
  selectedIds: string[],
  lookup: (id: string) => FileEntry | undefined,
  orgId?: string | null
): FileDragRef[] {
  if (selectedIds.includes(entry.id) && selectedIds.length > 1) {
    const out: FileDragRef[] = []
    for (const id of selectedIds) {
      const e = lookup(id)
      if (e) out.push(refFromEntry(e, orgId))
    }
    return out
  }
  return [refFromEntry(entry, orgId)]
}

/** Compatibility: whether this entry is a work widget file (it drags as a linked instance). */
export function isWidgetEntry(entry: FileEntry): boolean {
  return isWidgetFileEntry(entry)
}

// Clear the drag state on any dragend or drop, wherever it lands in the app.
if (typeof window !== 'undefined') {
  window.addEventListener('dragend', () => clearFilesDrag(), true)
  window.addEventListener('drop', () => setTimeout(clearFilesDrag, 0), true)
}
