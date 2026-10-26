// Which embeds have an output view, kept apart from EmbedOutput so the embed
// can ask without loading the renderers (EmbedOutput is lazy; see WidgetEmbed).

import type { Widget } from '@shared/types'
import { documentIdFromEmbed } from '@shared/documentEmbedId'

/** Height / width of the content, or its measured height when it flows (text). */
export type NaturalShape = { aspect: number } | { height: number }

/** Kinds whose output WidgetPreview draws faithfully. */
export const PREVIEW_KINDS = new Set(['card', 'file', 'image', 'markdown', 'note', 'page', 'shape', 'sticky', 'table', 'timer'])

/** Does this kind have an output view, or is its live view the content (a calendar, a browser)? */
export function hasOutputView(widget: Widget): boolean {
  return !!documentIdFromEmbed(widget.id) || widget.kind === 'scratchpad' || PREVIEW_KINDS.has(widget.kind)
}
