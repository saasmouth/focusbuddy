// AI Assist preview store.
//
// Every AI Assist action opens a single preview before anything is written.
// The menu's onSelect calls open() with the text to transform and the
// instruction; the AiAssistPreview component (mounted once) runs the
// ai:transformText IPC, shows the before/after, and applies in place on the
// user's confirmation. This is the "preview before applying" rule from the
// spec, deliverable 7.

import { create } from 'zustand'
import type { WidgetKind } from '@shared/types'

export interface AiAssistRequest {
  // Human label shown in the preview header, e.g. "Improve clarity".
  label: string
  // The instruction sent to the model.
  instruction: string
  /** The work widget the text came from; absent for text read on a web page. */
  sourceWidgetId?: string
  sourceKind?: WidgetKind
  /**
   * Text selected on a web page (the right-click menu on the standalone
   * browser or a browser work widget). Nothing is written back to a page, so
   * the preview offers Copy and Add to desk instead of Apply.
   */
  web?: { pageUrl: string; pageTitle: string }
  // The exact text to transform: the selection if there was one, else the
  // whole widget text.
  text: string
  // True when `text` is the entire widget content (no sub-selection), which
  // tells Apply to replace the whole content rather than splice a substring.
  wholeContent: boolean
  // True for Custom Prompt / Custom Tone / Custom Language: the preview opens
  // with an editable, possibly empty instruction and waits for the user to type
  // and press Run rather than firing the model immediately. window.prompt is
  // unsupported in Electron, so the editable field IS the prompt.
  awaitInput?: boolean
}

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface AiAssistPreviewState {
  open: boolean
  request: AiAssistRequest | null
  status: Status
  result: string | null
  error: string | null
  start: (req: AiAssistRequest) => void
  setLoading: () => void
  setResult: (result: string) => void
  setError: (error: string) => void
  close: () => void
}

export const useAiAssistPreview = create<AiAssistPreviewState>((set) => ({
  open: false,
  request: null,
  status: 'idle',
  result: null,
  error: null,
  start: (req) =>
    set({
      open: true,
      request: req,
      status: req.awaitInput ? 'idle' : 'loading',
      result: null,
      error: null
    }),
  setLoading: () => set({ status: 'loading', error: null }),
  setResult: (result) => set({ status: 'ready', result }),
  setError: (error) => set({ status: 'error', error }),
  close: () => set({ open: false, request: null, status: 'idle', result: null, error: null })
}))
