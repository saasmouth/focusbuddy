// Two different AIs, deliberately not the same one.
//
// THE ASSISTANT is a conversation about your workspace. It reads across desks,
// documents, mail and meetings, it answers questions, and a widget can be
// attached to it as context. It is a correspondent.
//
// WIDGET AI sets up and controls ONE widget, in that widget's own vocabulary.
// A table's AI proposes columns and then rows. A browser widget's AI resolves
// "the AWS console" to a URL. A mindmap's AI emits nodes and edges. None of
// those are conversation, and none of them share a vocabulary with each other.
//
// They were conflated for one commit: the new header button opened the
// assistant whenever a widget had no AI surface of its own. That was wrong for
// the reason the operator gave — "they serve different purposes, and the widget
// ai context should be unique to its requirements and use". A generic
// `update-widget` action can write a title, a content string and a geometry,
// and nothing more; it has no idea what a chart's content means, so asking it
// to "show revenue by month" would make it guess at a shape nothing validates.
//
// This module is the registry that keeps them apart, and it is deliberately
// honest about reach: 56 kinds exist, nine have a widget AI today. A kind with
// none says so rather than quietly handing the job to the correspondent.

import type { Widget } from '@shared/types'
import { isSetupSupported, isWidgetEmptyForSetup } from './widgetSetup'

/** Which surface answers the AI button for a widget. */
export type WidgetAiSurface =
  /** The widget ships its own AI, passed to WidgetFrame as `onAi`. */
  | 'own'
  /** The shared setup/control assistant (stores/widgetSetup). */
  | 'setup'
  /** Nothing yet. The button explains, and offers the assistant as a separate thing. */
  | 'none'

export interface WidgetAiPlan {
  surface: WidgetAiSurface
  /** The button's tooltip and the panel's heading. */
  label: string
  /** One line on what this widget's AI actually does, in its own terms. */
  purpose: string
}

/**
 * What a kind's own AI is for, where it has one of its own.
 *
 * Only kinds whose widget passes `onAi` belong here — the text is what the
 * button promises, so a line here with no handler behind it would be a lie.
 */
const OWN_AI: Readonly<Record<string, string>> = {
  table: 'Propose columns, then generate rows to match them'
}

/**
 * What the shared setup assistant does for the kinds it reaches.
 *
 * Phrased per kind rather than generically, because "set up this widget" tells
 * someone nothing about what they are about to get. These are the eight kinds
 * SETUP_SUPPORTED_KINDS covers.
 */
const SETUP_PURPOSE: Readonly<Record<string, string>> = {
  sticky: 'Draft the note from what this desk is about',
  note: 'Draft the note from what this desk is about',
  markdown: 'Draft the text from what this desk is about',
  card: 'Fill the card from what this desk is about',
  mindmap: 'Propose the branches, as real nodes and edges',
  diagram: 'Propose the shapes and the connections between them',
  page: 'Draft the page from what this desk is about',
  webview: 'Work out which site you meant and open it'
}

/**
 * Decide what the AI button does for this widget.
 *
 * `hasOwnAi` is whether the widget passed a handler; the registry cannot know
 * that by itself and must not claim an AI that is not wired up.
 */
export function planWidgetAi(widget: Widget, hasOwnAi: boolean): WidgetAiPlan {
  if (hasOwnAi) {
    return {
      surface: 'own',
      label: 'AI',
      purpose: OWN_AI[widget.kind] ?? 'Set up and change this widget'
    }
  }
  if (isSetupSupported(widget.kind)) {
    // The verb changes with state. "Set up" is wrong for a widget that already
    // has content — at that point the honest offer is to change it.
    const empty = isWidgetEmptyForSetup(widget)
    return {
      surface: 'setup',
      label: empty ? 'Set up with AI' : 'Change with AI',
      purpose: SETUP_PURPOSE[widget.kind] ?? 'Set up this widget from what this desk is about'
    }
  }
  return {
    surface: 'none',
    label: 'AI',
    purpose: 'This widget has no AI of its own yet'
  }
}

/** Every kind with a widget AI today — the honest coverage number. */
export const KINDS_WITH_WIDGET_AI: readonly string[] = [
  ...Object.keys(OWN_AI),
  ...Object.keys(SETUP_PURPOSE)
].sort()
