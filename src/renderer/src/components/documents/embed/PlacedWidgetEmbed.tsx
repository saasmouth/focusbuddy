import type { JSX } from 'react'
import WidgetEmbed from './WidgetEmbed'
import { useEmbedDisplayWriter, type EmbedDisplay } from '../../../lib/widgetSurface'

// A work widget embedded as an element of a slide, design, diagram or drawing.
// Those renderers are pure views of their element and have no update path, so
// the placement's display choice is saved through the editor's writer, keyed
// by the element's own id. Without a writer (a viewer, a slideshow, a static
// render) no toggle is offered at all, rather than one that does not save.
export default function PlacedWidgetEmbed({
  placementId,
  widgetId,
  display
}: {
  placementId: string
  widgetId: string
  display: EmbedDisplay | undefined
}): JSX.Element {
  const write = useEmbedDisplayWriter()
  return (
    <WidgetEmbed
      widgetId={widgetId}
      display={display}
      onDisplayChange={write ? (d) => write(placementId, d) : undefined}
    />
  )
}
