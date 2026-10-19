// Finding the work widget an action is aimed at, wherever it lives.
//
// WHY THIS EXISTS. Every widget action resolved its target with
// `useWidgetStore.getState().widgets.find(w => w.id === id)` — the widgets on
// the DESK CURRENTLY OPEN. That was right when a widget could only be on a
// desk. Since 4.3.32 a work widget is a file (docs/widget-files.md): it can
// have no desk at all, sit in Files, be embedded in a document, a slide, a
// design, a diagram or a dashboard, and be on several desks at once.
//
// So the assistant could not touch any of them. Asked to change a widget
// embedded in a document it answered "No work widget found with id …",
// which reads as the widget not existing rather than the assistant being
// unable to see it. Nine call sites had the same blind spot, which is why
// this is one resolver rather than nine fixes.
//
// THREE SHAPES OF ID reach here, and all three are legitimate:
//   - a desk widget's row id, from the desk index;
//   - `wf:<file id>`, the pane id an embed and the full-pane view use;
//   - a bare widget-file documentId, which is what the assistant is given
//     for scope 'everywhere' (see ActionProposal in shared/types.ts).

import type { Widget, WidgetPatch } from '@shared/types'
import { isWidgetFilePaneId, widgetFileIdFromGroup, widgetFileGroupId, widgetFromFile } from '@shared/widgetFiles'
import { useWidgetStore } from '../stores/widgets'

export interface WidgetTarget {
  widget: Widget
  /** The id to WRITE through, which is not always the id you looked up. */
  writeId: string
  /** True when it is a work widget file rather than a row on a desk. */
  isFile: boolean
}

/**
 * The widget an id names, or null when nothing of that id exists anywhere.
 *
 * Checks the open desk first because that is the common case and needs no
 * round trip; only then asks for a file. A null result means genuinely
 * absent, so callers can say so honestly.
 */
export async function resolveWidgetTarget(id: string): Promise<WidgetTarget | null> {
  if (!id) return null

  const onDesk = useWidgetStore.getState().widgets.find((w) => w.id === id)
  if (onDesk) return { widget: onDesk, writeId: onDesk.id, isFile: false }

  const fileId = isWidgetFilePaneId(id) ? widgetFileIdFromGroup(id) : id
  if (!fileId) return null
  try {
    const file = await window.api.widgetFiles.get(fileId)
    if (!file) return null
    return { widget: widgetFromFile(file), writeId: widgetFileGroupId(file.id), isFile: true }
  } catch {
    return null
  }
}

/**
 * Apply a patch to whatever the id names.
 *
 * Writes go through the widget store in both cases: it already routes a
 * `wf:` id to the file (which fans the change out to every desk holding it)
 * and a desk id to its row. Doing it here rather than in each caller means a
 * widget edited by the assistant behaves exactly like one edited by hand.
 */
export async function patchWidgetTarget(id: string, patch: WidgetPatch): Promise<boolean> {
  const target = await resolveWidgetTarget(id)
  if (!target) return false
  await useWidgetStore.getState().update(target.writeId, patch)
  return true
}
