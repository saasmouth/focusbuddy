// The body of an embedded work widget, in its own module so it can be loaded
// lazily.
//
// WHY THIS FILE EXISTS AT ALL. A document can contain a work widget, and a
// work widget can contain a document, so importing the widget renderer from
// the embed closes a real cycle:
//
//   WidgetEmbed -> renderWidget -> OfficeDocWidget -> @office (DocEditor)
//     -> editor/extensions -> WidgetEmbedNode -> WidgetEmbed
//
// Every edge there is legitimate and none can be deleted: both containments
// are features. Statically it fails at module-evaluation with "Cannot access
// 'X' before initialization" — the whole app, not just the embed, because the
// editor is pulled in at startup. Loading this module lazily breaks the cycle
// at the only point where deferral costs nothing: by the time an embed is on
// screen, every module in the loop has finished initialising.

import type { JSX } from 'react'
import type { Widget } from '@shared/types'
import { renderWidget } from '../../widgets/renderWidget'
import { WidgetRemovableContext, WidgetSurfaceContext } from '../../../lib/widgetSurface'

export default function EmbeddedWidgetBody({ widget }: { widget: Widget }): JSX.Element {
  // 'embedded' fills the box and cannot be dragged, so nothing inside a
  // document writes desk coordinates back to the desk the object came from.
  //
  // Not removable: renderWidget draws each kind's own component, and those
  // carry their own desk frame, title bar and × included. The × here would
  // be `remove` on a `wf:` id, which trashes the FILE and every desk instance
  // of it — or, for a desk widget, deletes it from its desk. The frame drops
  // the tool (header and "…" menu alike) when told the host owns removal.
  return (
    <WidgetSurfaceContext.Provider value="embedded">
      <WidgetRemovableContext.Provider value={false}>{renderWidget(widget)}</WidgetRemovableContext.Provider>
    </WidgetSurfaceContext.Provider>
  )
}
