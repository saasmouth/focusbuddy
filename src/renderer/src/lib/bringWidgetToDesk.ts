import type { Widget } from '@shared/types'
import { sizeWhenMoved } from '@shared/widgetStartSizes'

// Bring a copy of an existing widget onto another desk. Two modes, matching the
// SyncWidgetPicker / duplicate-synced behaviour:
//   synced = true  -> both copies share a syncGroupId, so edits to content, title
//                     or colour mirror across every desk that holds the widget
//                     (the "editable widget stays synced across desks" model).
//   synced = false -> a disconnected, independent copy: same content now, but it
//                     diverges freely afterwards.
// Writes go straight through window.api (not the widget store) because the target
// desk is typically not the active one; it loads the new widgets when opened.

export interface BringOpts {
  synced: boolean
  x?: number
  y?: number
}

export async function bringWidgetToDesk(
  source: Widget,
  targetTaskId: string,
  opts: BringOpts
): Promise<Widget | null> {
  const api = window.api?.widgets
  if (!api?.create) return null
  let groupId: string | undefined
  if (opts.synced) {
    // Ensure the source belongs to a sync group first, then share it.
    groupId = source.syncGroupId ?? crypto.randomUUID()
    if (!source.syncGroupId) await api.update(source.id, { syncGroupId: groupId })
  }
  return api.create({
    taskId: targetTaskId,
    kind: source.kind,
    title: source.title,
    content: source.content,
    x: opts.x ?? source.x,
    y: opts.y ?? source.y,
    // Never sized by anybody: the standard. Sized by somebody: as they left it.
    ...sizeWhenMoved(source.kind, source.width, source.height),
    color: source.color,
    sourceAppId: source.sourceAppId,
    mode: source.mode,
    syncGroupId: groupId
  })
}
