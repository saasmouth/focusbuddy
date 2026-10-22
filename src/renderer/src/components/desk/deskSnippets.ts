import { useEffect } from 'react'
import type { Widget, WidgetKind } from '@shared/types'
import type { Snippet, SnippetTarget, WidgetSnippetBody } from '@shared/snippets'
import { registerSnippetTarget } from '../../stores/snippets'
import { useWidgetStore } from '../../stores/widgets'

// A desk as a snippet surface: save a work widget as a reusable one, and place
// a saved one on any desk.
//
// DUPLICATE ONLY, on purpose. A work widget already has a live mechanism of its
// own: it is a file, and a file can be placed on any number of desks as a
// linked instance whose edits flow both ways (docs/widget-files.md). A "live
// widget snippet" would be a second way to do the same thing, competing with
// the first, so the desk target declares `supports: ['duplicate']` and the
// library offers Duplicate alone rather than a Live option that would either
// duplicate the widget-file mechanism or quietly degrade.
//
// So the division is: a widget SNIPPET is a template for making new widgets of
// a shape you use often; a widget FILE is one widget that appears in several
// places at once. Both are real, and they are not the same want.

/** Turn a widget on a desk into a reusable snippet body. */
export function widgetBodyFromWidget(w: Widget): WidgetSnippetBody {
  return {
    kind: 'widget',
    widgetKind: w.kind,
    title: w.title ?? '',
    content: w.content ?? '',
    // Size travels with the snippet because a widget's shape is part of what
    // makes it reusable; its POSITION does not, since the destination desk
    // decides where a new widget lands.
    width: w.width ?? 2,
    height: w.height ?? 2,
    color: w.color ?? null
  }
}

/**
 * Place a widget snippet on a desk as a new widget.
 *
 * Returns false when it declined — no desk, or a body that is not a widget — so
 * the store reports a refusal instead of counting a use that did not happen.
 */
export async function insertWidgetSnippetOnDesk(taskId: string, snippet: Snippet): Promise<boolean> {
  if (!taskId) return false
  if (snippet.body.kind !== 'widget') return false
  const b = snippet.body
  if (!b.widgetKind) return false
  const created = await useWidgetStore.getState().createOptional({
    taskId,
    kind: b.widgetKind as WidgetKind,
    // The snippet's own name is the better default title: it is what the user
    // called this reusable thing, and it is what they will look for on the desk.
    title: b.title || snippet.name,
    content: b.content,
    width: b.width,
    height: b.height,
    color: b.color
  })
  return created !== null
}

/**
 * Register the open desk as an insertion target while it is mounted.
 *
 * `taskId` is the desk. A desk that is not open is not a destination, which is
 * why this is a registration tied to the mount rather than a list of all desks.
 */
export function useDeskSnippetTarget(taskId: string | null, deskTitle: string): void {
  useEffect(() => {
    if (!taskId) return
    const target: SnippetTarget = {
      id: `desk:${taskId}`,
      label: deskTitle?.trim() ? `“${deskTitle.trim()}” desk` : 'This desk',
      accepts: ['widget'],
      // See the note at the top: a widget file already provides live, so the
      // desk honours Duplicate and says so rather than offering both.
      supports: ['duplicate'],
      insert: (snippet) => insertWidgetSnippetOnDesk(taskId, snippet)
    }
    return registerSnippetTarget(target)
  }, [taskId, deskTitle])
}

/** The registry id for a desk surface. One place, so host and picker agree. */
export function deskSnippetTargetId(taskId: string): string {
  return `desk:${taskId}`
}
