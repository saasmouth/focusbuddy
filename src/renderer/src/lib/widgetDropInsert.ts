// Turning a drag from the side menu into a work widget an editor can embed.
//
// Four editors need exactly the same three steps — decide whether the drag is
// one of ours, turn it into a widget id, and say something honest when it
// cannot be — and they differ only in where they then put the id. Writing
// that out four times is how the prefix in six copies of dl() became a thing
// nobody could change safely, so it lives here once.
//
// The payloads are the ones the desk canvas and the dashboard already read.
// One drag source, four destinations, no second set of mime types.

import {
  WIDGET_FILE_DRAG_MIME,
  WIDGET_NEW_FILE_DRAG_MIME,
  readNewWidgetFileDrag,
  readWidgetFileDrag
} from './widgetFileDrag'
import { DRAG_MIME } from './widgetCatalog'
import { isStandaloneWidgetKind, widgetFileGroupId } from '@shared/widgetFiles'
import { useWidgetFilesStore } from '../stores/widgetFiles'
import { useNoticeStore } from '../stores/notice'
import type { WidgetKind } from '@shared/types'

/** Is this drag something an editor can embed? */
export function acceptsWidgetDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false
  const types = Array.from(dt.types)
  return [WIDGET_FILE_DRAG_MIME, WIDGET_NEW_FILE_DRAG_MIME, DRAG_MIME].some((m) => types.includes(m))
}

/**
 * The widget id to embed, creating a work widget file when the drag carries a
 * kind rather than an existing object. Returns null when there is nothing to
 * embed, having already told the user why.
 *
 * A dropped kind becomes a FILE, not a desk widget: it has no desk, it shows
 * up in Files, and the `wf:<id>` form is what makes the embed editable —
 * the widget store routes a write on that id to the file, which fans out to
 * every desk holding it (docs/widget-files.md).
 */
export async function widgetIdFromDrop(dt: DataTransfer | null): Promise<string | null> {
  if (!dt) return null

  const existing = readWidgetFileDrag(dt)
  if (existing) return widgetFileGroupId(existing)

  const kind = readNewWidgetFileDrag(dt) || dt.getData(DRAG_MIME)
  if (!kind) return null

  if (!isStandaloneWidgetKind(kind)) {
    // A section, portal or desk agent describes the desk it sits on, so it
    // cannot be a file and cannot be embedded. Said out loud: a drop that
    // silently does nothing is what sent the original bug report in.
    useNoticeStore.getState().show({
      icon: 'info',
      text: `A ${kind.replace(/-/g, ' ')} arranges a desk, so it only lives on one.`
    })
    return null
  }

  // `open: false` matters: the store opens a new file full-pane by default,
  // which is right from the side menu and wrong here — it would navigate away
  // from the document you just dropped into, before you saw the result.
  const file = await useWidgetFilesStore.getState().create(kind as WidgetKind, { open: false })
  if (!file) {
    useNoticeStore.getState().show({ icon: 'error', text: 'That work widget could not be created.' })
    return null
  }
  return widgetFileGroupId(file.id)
}
