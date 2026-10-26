// Saved copies of desk widgets the widget store does not hold.
//
// The store holds the open desk's widgets, and everything showing one of them
// follows the store. An embed can show a widget from a desk that is not open,
// and that widget can be edited from another embed of it, from Focus mode, or
// from the embed itself. Without this the store wrote it and told no one, so a
// second embed kept its stale copy, and a checklist or table edited inside the
// embed rendered its old value until the embed was reopened.
//
// The store publishes the server's copy after each such write; embeds take it
// the way the desk takes its own reconcile.

import type { Widget } from '@shared/types'

type Listener = (widget: Widget) => void
const listeners = new Set<Listener>()

export function publishWidgetWrite(widget: Widget): void {
  for (const l of listeners) l(widget)
}

export function onWidgetWrite(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
