// Create-or-open helpers for the Focus Mode "Add" action tab.
//
// The Add tab lets you spin up a new document / page or drop an existing one
// onto the current desk without leaving Focus Mode. Both paths resolve to a
// real widget (the same kind of tab every other document opens as) so the
// result behaves identically to adding from the canvas palette — it persists,
// links, and focus-navigates like any widget.
//
// Reuse notes: office documents are created through useDocumentsStore.createBlank
// (the same call the canvas OfficeDocAddDialog and the AI create-document
// action use), and the widget is positioned with spawnPositionFor (the shared
// spawn geometry every non-drag add path uses). This keeps the Add tab
// consistent with the rest of the app rather than inventing a parallel flow.

import type { DocType, Widget } from '@shared/types'
import { useDocumentsStore } from '../stores/documents'
import { useWidgetStore } from '../stores/widgets'
import { catalogFor } from './widgetCatalog'
import { spawnPositionFor } from './spawnPosition'

// The office document kinds that are ALSO widget kinds (every DocType). These
// back a real fb_documents row.
export type OfficeAddKind = 'doc' | 'sheet' | 'slides' | 'map' | 'design' | 'draw'

// The widget kinds the Add tab can spawn: the office kinds above, plus 'page'
// (a self-contained Tiptap widget whose body lives in widget.content, no
// separate document row).
export type AddableKind = OfficeAddKind | 'page'

export interface AddOption {
  kind: AddableKind
  label: string
  icon: string
  hint: string
}

// The create menu, in the order they read best: the everyday writing surfaces
// first, then the diagram. Labels/icons come from the widget catalog so the Add
// tab stays in lockstep with the palette if those ever change.
export const ADD_OPTIONS: AddOption[] = (['doc', 'sheet', 'slides', 'map', 'design', 'draw', 'page'] as const).map(
  (kind) => {
    const entry = catalogFor(kind)
    return {
      kind,
      label: entry?.label ?? kind,
      icon: entry?.icon ?? 'note_add',
      hint: entry?.hint ?? ''
    }
  }
)

// Office document kinds are everything except the self-contained 'page'.
export function isOfficeKind(kind: AddableKind): kind is OfficeAddKind {
  return kind !== 'page'
}

// A DocType from the existing-documents list is placeable as a widget when it
// has a matching widget kind — now every office DocType, including 'design'.
export function isPlaceableDocType(docType: DocType): docType is OfficeAddKind {
  return docType === 'doc' || docType === 'sheet' || docType === 'slides' || docType === 'map' || docType === 'design' || docType === 'draw'
}

// Create a brand-new document/page and drop it on the active desk as a widget.
// Returns the created widget (caller focuses it) or null when there's no active
// task to attach it to.
export async function createAndPlace(kind: AddableKind, taskId: string | null): Promise<Widget | null> {
  if (!taskId) return null
  const entry = catalogFor(kind === 'page' ? 'page' : kind)
  const width = entry?.defaultWidth ?? 480
  const height = entry?.defaultHeight ?? 400

  if (isOfficeKind(kind)) {
    // Real fb_documents row (same as the palette's "create new") — the widget's
    // content field carries the document id, which OfficeDocWidget resolves.
    const doc = await useDocumentsStore.getState().createBlank(kind)
    return useWidgetStore.getState().create({
      taskId,
      kind,
      title: doc.title,
      content: doc.id,
      ...spawnPositionFor(width, height),
      width,
      height,
      color: null
    })
  }

  // A page is a standalone Tiptap widget — empty body, ready to type into.
  return useWidgetStore.getState().create({
    taskId,
    kind: 'page',
    title: '',
    content: '',
    ...spawnPositionFor(width, height),
    width,
    height,
    color: null
  })
}

// Drop an EXISTING office document onto the active desk as a widget pointing at
// its id. Returns the created widget or null when there's no active task.
export async function placeExisting(
  docType: DocType,
  documentId: string,
  title: string,
  taskId: string | null
): Promise<Widget | null> {
  if (!taskId) return null
  // Guard: only office DocTypes map to a widget kind.
  if (!isPlaceableDocType(docType)) return null
  const entry = catalogFor(docType)
  const width = entry?.defaultWidth ?? 480
  const height = entry?.defaultHeight ?? 400
  return useWidgetStore.getState().create({
    taskId,
    kind: docType,
    title,
    content: documentId,
    ...spawnPositionFor(width, height),
    width,
    height,
    color: null
  })
}
