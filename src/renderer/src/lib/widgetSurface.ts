import { createContext, useContext } from 'react'

// Where a widget is being rendered.
//
// 'canvas' is the desk: the object is absolutely positioned at its own x/y,
// draggable and resizable through react-rnd. 'embedded' is anywhere that gives
// the object a box and expects it to fill it -- a dashboard card, today.
//
// The distinction has to exist because the two are genuinely different: an
// object dropped on a dashboard has no meaningful desk coordinates, and letting
// someone drag it there would write nonsense positions back to the desk it
// still belongs to. Embedded mode fills its parent and cannot be moved, so that
// is structurally impossible rather than merely discouraged.

export type WidgetSurface = 'canvas' | 'embedded'

export const WidgetSurfaceContext = createContext<WidgetSurface>('canvas')

export function useWidgetSurface(): WidgetSurface {
  return useContext(WidgetSurfaceContext)
}

// Whether the frame may offer to remove the widget it draws.
//
// Separate from the surface, because 'embedded' covers hosts with opposite
// answers: the full-pane view of a work widget file IS the file, so its × is
// the honest way to delete it, while an embed inside a document, slide, sheet,
// diagram, design or drawing is a PLACEMENT of an object that lives elsewhere.
// There, `remove` on a `wf:` id trashes the file and every desk instance of it
// (stores/widgets.ts), and on a desk widget's id it deletes the widget from its
// desk — either way a stray × inside a document destroys work that is not the
// document's. Removing an embed is the host editor's job: delete the node, not
// the widget. Hosts like that provide `false`.
export const WidgetRemovableContext = createContext<boolean>(true)

export function useWidgetRemovable(): boolean {
  return useContext(WidgetRemovableContext)
}

// How an EMBEDDED widget presents itself, chosen per placement by whoever
// placed it.
//
// 'object' is the original object exactly as the desk draws it: its frame,
// title bar and tools. 'data' is only what it holds: the same live, editable
// component with no frame or header around it, so a table reads as a table in
// a document rather than as a desk card pasted into one.
//
// Before this, every embed was forced into the desk look, header included,
// and the embed's own title strip doubled it.
export type { EmbedDisplay } from '@shared/embedDisplay'
export { EMBED_DISPLAY_DEFAULT, normaliseEmbedDisplay } from '@shared/embedDisplay'
import type { EmbedDisplay } from '@shared/embedDisplay'

// Read by WidgetFrame: in 'data' it draws the body only. Outside an embed this
// is always 'object', so the desk and every other surface are untouched.
export const WidgetChromeContext = createContext<EmbedDisplay>('object')

export function useWidgetChrome(): EmbedDisplay {
  return useContext(WidgetChromeContext)
}

// How a host saves a placement's choice, keyed by the placement's own id. The
// renderers that draw embeds (slide elements, diagram nodes, drawing objects)
// are pure views with no update path of their own, so each EDITOR provides
// this; a viewer or a static render provides nothing, and then no toggle is
// offered rather than one that silently does not save.
export type EmbedDisplayWriter = (placementId: string, display: EmbedDisplay) => void
export const EmbedDisplayWriterContext = createContext<EmbedDisplayWriter | null>(null)

export function useEmbedDisplayWriter(): EmbedDisplayWriter | null {
  return useContext(EmbedDisplayWriterContext)
}
