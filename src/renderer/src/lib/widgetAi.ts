// Two different AIs, deliberately not the same one.
//
// THE ASSISTANT is a conversation about your workspace. It reads across desks,
// documents, mail and meetings, it answers questions, and a widget can be
// attached to it as context. It is a correspondent.
//
// WIDGET AI sets up and controls ONE widget, in that widget's own vocabulary.
// A table's AI proposes columns and then rows. A browser widget's AI resolves
// "the AWS console" to a URL. An inbox widget's AI writes a mail rule. None of
// those are conversation, and none share a vocabulary with each other.
//
// They were conflated for one commit: the header AI button opened the assistant
// whenever a widget had no AI surface of its own. That was wrong for the reason
// the operator gave — "they serve different purposes, and the widget ai context
// should be unique to its requirements and use". A generic `update-widget`
// action can write a title, a content string and a geometry, and nothing more;
// it has no idea what a chart's content means, so asking it to "show revenue by
// month" would make it guess at a shape nothing validates.
//
// WHAT EACH KIND'S AI IS FOR lives in widgetAiFamilies — one registry, all 56
// kinds. This module only decides which SURFACE answers the button, and is
// deliberately honest about reach: a kind whose family has no applier wired yet
// says so rather than quietly handing the job to the correspondent.

import type { Widget } from '@shared/types'
import { isSetupSupported, isWidgetEmptyForSetup } from './widgetSetup'
import { WIDGET_AI, verbFor } from './widgetAiFamilies'

/** Which surface answers the AI button for a widget. */
export type WidgetAiSurface =
  /** The widget ships its own AI, passed to WidgetFrame as `onAi`. */
  | 'own'
  /** The shared setup/control expert (stores/widgetSetup). */
  | 'setup'
  /** Not wired yet. The button explains, and offers the assistant separately. */
  | 'none'

export interface WidgetAiPlan {
  surface: WidgetAiSurface
  /** The button's tooltip and the panel's heading. */
  label: string
  /** One line on what this widget's AI does, in its own terms. */
  purpose: string
}

/**
 * Decide what the AI button does for this widget.
 *
 * `hasOwnAi` is whether the widget passed a handler; the registry cannot know
 * that by itself and must not claim an AI that is not wired up.
 */
export function planWidgetAi(widget: Widget, hasOwnAi: boolean): WidgetAiPlan {
  const entry = WIDGET_AI[widget.kind]
  if (hasOwnAi) {
    return {
      surface: 'own',
      label: 'AI',
      purpose: entry?.purpose ?? 'Set up and change this widget'
    }
  }
  if (isSetupSupported(widget.kind)) {
    // The verb changes with state. "Set up" is wrong for a widget that already
    // has content — at that point the honest offer is to change it — and the
    // verb itself comes from the kind's FAMILY ("write" for a sticky, "find"
    // for a browser, "describe" for a rule), because "set up" says nothing
    // about what is about to happen.
    const empty = isWidgetEmptyForSetup(widget)
    return {
      surface: 'setup',
      label: verbFor(widget.kind, empty) ?? (empty ? 'Set up with AI' : 'Change with AI'),
      purpose: entry?.purpose ?? 'Set up this widget from what this desk is about'
    }
  }
  return {
    surface: 'none',
    label: 'AI',
    // Every catalogue kind is in WIDGET_AI, so this is a kind whose family has
    // no applier wired yet rather than one nobody thought about. Say which, so
    // the gap reads as unfinished work and not as an oversight.
    purpose: entry
      ? `${entry.purpose} — not wired up yet`
      : 'This widget has no AI of its own yet'
  }
}

/**
 * Kinds whose AI is actually wired to an expert today.
 *
 * DERIVED, never listed: two hand-kept lists of the same thing is exactly how
 * they drift, and this file already shipped one that went stale the moment the
 * expert registry grew.
 */
export const KINDS_WITH_WIDGET_AI: readonly string[] = Object.keys(WIDGET_AI)
  .filter((k) => isSetupSupported(k) || k === 'table')
  .sort()
