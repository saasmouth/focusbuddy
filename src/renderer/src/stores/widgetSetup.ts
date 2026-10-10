// Drives the per-widget AI setup preview. A menu action calls start(widgetId);
// the WidgetSetupPreview component (mounted once) runs the suggest IPC, shows
// the drafted items for approval, and applies the ticked ones in the widget's
// native format. This is the "tables-style AI setup, for every widget" flow.
//
// This is WIDGET AI — the expert for one widget, speaking that widget's own
// vocabulary — and it is deliberately not the conversational assistant. See
// lib/widgetAiFamilies for what each kind's expert is for, and
// lib/widgetAi for which surface a given widget's AI button opens.

import { create } from 'zustand'

interface WidgetSetupState {
  open: boolean
  widgetId: string | null
  /**
   * What the person asked for, when something asked on their behalf.
   *
   * The assistant delegates here via the `ask-widget-ai` action rather than
   * writing a widget's content itself: it can plan, but it does not know what a
   * chart's content means or how an inbox rule is phrased, and guessing
   * produces a shape nothing validates. It passes the INTENT in plain language
   * and this expert decides what the widget actually becomes.
   *
   * Null when the person opened the widget's AI themselves — then the expert
   * works from the desk and the widget alone, which is the original behaviour.
   */
  intent: string | null
  start: (widgetId: string, intent?: string) => void
  close: () => void
}

export const useWidgetSetup = create<WidgetSetupState>((set) => ({
  open: false,
  widgetId: null,
  intent: null,
  start: (widgetId, intent) => set({ open: true, widgetId, intent: intent ?? null }),
  close: () => set({ open: false, widgetId: null, intent: null })
}))
