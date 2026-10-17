// Drag payloads for widget files (docs/widget-files.md).
//
// Two gestures put a widget-file instance on a desk, and they carry different
// things:
//
//   NEW  — a kind dragged from the side menu's Widgets section. The drop creates
//          a new widget file of that kind AND places a linked instance of it.
//   FILE — an existing widget file dragged from Files or from its full-pane
//          header. The drop places a linked instance of THAT file.
//
// Both are our own MIME types, so a drop from outside the app is never taken
// for one. A FILE drag also carries the generic document payloads, so any
// surface that already accepts a dragged document (the tray's desk rows, a
// table's doc-ref cell) accepts a widget file too.

import type { WidgetKind } from '@shared/types'
import { isStandaloneWidgetKind } from '@shared/widgetFiles'
import { setDocDrag } from './docMetaCache'
import { writeDocumentDrag } from './documentDrag'

export const WIDGET_NEW_FILE_DRAG_MIME = 'application/x-plexii-widget-new-file'
export const WIDGET_FILE_DRAG_MIME = 'application/x-plexii-widget-file'

export function writeNewWidgetFileDrag(dt: DataTransfer, kind: WidgetKind): void {
  dt.setData(WIDGET_NEW_FILE_DRAG_MIME, kind)
  dt.effectAllowed = 'copy'
}

export function readNewWidgetFileDrag(dt: DataTransfer | null): WidgetKind | null {
  if (!dt) return null
  let k = ''
  try {
    k = dt.getData(WIDGET_NEW_FILE_DRAG_MIME)
  } catch {
    return null
  }
  return isStandaloneWidgetKind(k) ? k : null
}

export function writeWidgetFileDrag(
  dt: DataTransfer,
  file: { id: string; title: string }
): void {
  dt.setData(WIDGET_FILE_DRAG_MIME, file.id)
  // The generic document payloads, after ours: both set text/plain to the title.
  setDocDrag({ dataTransfer: dt }, { id: file.id, docType: 'widget', title: file.title })
  writeDocumentDrag(dt, { documentId: file.id, docType: 'widget', title: file.title })
  dt.effectAllowed = 'copyLink'
}

export function readWidgetFileDrag(dt: DataTransfer | null): string | null {
  if (!dt) return null
  try {
    const id = dt.getData(WIDGET_FILE_DRAG_MIME)
    return id || null
  } catch {
    return null
  }
}

/** For dragover, where only the type list is readable. */
export function dragCarriesWidgetFile(dt: DataTransfer | null): boolean {
  if (!dt) return false
  try {
    const types = Array.from(dt.types)
    return types.includes(WIDGET_FILE_DRAG_MIME) || types.includes(WIDGET_NEW_FILE_DRAG_MIME)
  } catch {
    return false
  }
}
