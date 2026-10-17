// Commands the open desk carries out on behalf of chrome that lives outside it.
//
// The side menu's Widgets section is where widgets are added now (the header
// Add widget button and the hover palette are gone, 4.3.32). Some of what it
// offers needs the canvas itself: a desk-only kind goes through the canvas's
// own add path (spawn beside the last-touched widget, the office-document
// chooser, capability gating), and "Import file…" / "Bring a synced widget…"
// open dialogs the canvas owns. Rather than lift that state out of Canvas, the
// menu asks, and the mounted canvas answers. With no desk open nobody is
// listening, which is why the menu only offers these when a desk is open.

import type { WidgetKind } from '@shared/types'

const ADD_KIND = 'plexii:canvas-add-kind'
const IMPORT_FILE = 'plexii:canvas-import-file'
const BRING_SYNCED = 'plexii:canvas-bring-synced'

/** Add a plain (desk-only) widget of `kind` to the open desk, via the canvas. */
export function requestCanvasAddKind(kind: WidgetKind): void {
  window.dispatchEvent(new CustomEvent(ADD_KIND, { detail: { kind } }))
}
export function requestCanvasImportFile(): void {
  window.dispatchEvent(new CustomEvent(IMPORT_FILE))
}
export function requestCanvasBringSynced(): void {
  window.dispatchEvent(new CustomEvent(BRING_SYNCED))
}

/** Canvas side: subscribe to all three; returns the unsubscribe. */
export function onCanvasCommands(handlers: {
  addKind: (kind: WidgetKind) => void
  importFile: () => void
  bringSynced: () => void
}): () => void {
  const add = (e: Event): void => {
    const kind = (e as CustomEvent<{ kind?: WidgetKind }>).detail?.kind
    if (kind) handlers.addKind(kind)
  }
  const imp = (): void => handlers.importFile()
  const bring = (): void => handlers.bringSynced()
  window.addEventListener(ADD_KIND, add)
  window.addEventListener(IMPORT_FILE, imp)
  window.addEventListener(BRING_SYNCED, bring)
  return () => {
    window.removeEventListener(ADD_KIND, add)
    window.removeEventListener(IMPORT_FILE, imp)
    window.removeEventListener(BRING_SYNCED, bring)
  }
}
