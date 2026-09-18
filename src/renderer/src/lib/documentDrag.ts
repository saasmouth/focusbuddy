import type { DocType } from '@shared/types'

// Dragging a document onto a desk.
//
// A document and a desk are separate things in this app: documents live in the
// library, desks are canvases, and putting one on the other meant opening the
// desk, finding the add-widget flow and choosing the document from a list. The
// tray already shows both, side by side, which makes the obvious gesture — drag
// the document onto the desk — available for the first time.
//
// The payload is deliberately small and self-describing: an id, a type and a
// title. Everything else is looked up at the drop, so a stale drag (the document
// renamed or deleted mid-gesture) resolves against what is true on arrival
// rather than against what was true when the drag started.

/** Our own MIME type, so a drop from outside the app is never mistaken for one. */
export const DOC_DRAG_TYPE = 'application/x-plexii-document'

export interface DocumentDragPayload {
  documentId: string
  docType: DocType
  title: string
}

/** Every document type that can sit on a desk as a widget of its own kind. */
const PLACEABLE: ReadonlySet<string> = new Set<DocType>([
  'doc',
  'sheet',
  'slides',
  'map',
  'design',
  'draw'
])

export function canPlaceOnDesk(docType: string): boolean {
  return PLACEABLE.has(docType)
}

export function writeDocumentDrag(dt: DataTransfer, payload: DocumentDragPayload): void {
  try {
    dt.setData(DOC_DRAG_TYPE, JSON.stringify(payload))
    // A plain-text fallback so dragging into a text field or another app pastes
    // something meaningful rather than nothing.
    dt.setData('text/plain', payload.title)
    dt.effectAllowed = 'copy'
  } catch {
    /* some platforms refuse setData outside a real drag — the drop simply will not offer */
  }
}

/**
 * Read a drag, or null when it is not one of ours.
 *
 * Returns null rather than throwing on anything malformed: a drop handler that
 * throws leaves the UI in a dragging state with no way out.
 */
export function readDocumentDrag(dt: DataTransfer | null): DocumentDragPayload | null {
  if (!dt) return null
  let raw = ''
  try {
    raw = dt.getData(DOC_DRAG_TYPE)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<DocumentDragPayload>
    if (typeof p.documentId !== 'string' || !p.documentId) return null
    if (typeof p.docType !== 'string' || !canPlaceOnDesk(p.docType)) return null
    return {
      documentId: p.documentId,
      docType: p.docType as DocType,
      title: typeof p.title === 'string' ? p.title : 'Untitled'
    }
  } catch {
    return null
  }
}

/**
 * Whether a drag is currently carrying one of our documents.
 *
 * dragover cannot read the DATA (the browser withholds it until drop, so a page
 * cannot snoop on what is being dragged over it) — only the type list. So the
 * highlight is driven by the type being present, and the payload is validated
 * at the drop.
 */
export function dragCarriesDocument(dt: DataTransfer | null): boolean {
  if (!dt) return false
  try {
    return Array.from(dt.types).includes(DOC_DRAG_TYPE)
  } catch {
    return false
  }
}

/** The widget a dropped document becomes: same kind as the document. */
export function widgetDraftFor(
  payload: DocumentDragPayload,
  taskId: string
): { taskId: string; kind: DocType; title: string; content: string; width: number; height: number } {
  return {
    taskId,
    kind: payload.docType,
    title: payload.title,
    // The widget points AT the document rather than copying it: editing it on
    // the desk and editing it in Office are the same file, which is the whole
    // reason to put it there.
    content: payload.documentId,
    width: 520,
    height: 400
  }
}
