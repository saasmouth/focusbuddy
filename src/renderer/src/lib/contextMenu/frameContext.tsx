// React context that carries a widget's frame management callbacks, and the
// per-instance menu rows its host passed (WidgetFrame `menuContributions`),
// down to its body. WidgetFrame provides both; a body's content menu
// (UnifiedConnectedMenu) reads them so a right-click on a widget's content
// offers the same unified menu, with the same rows, as its header.

import { createContext, useContext } from 'react'
import type { FrameCallbacks, MenuContribution } from './types'

const FrameCallbacksContext = createContext<FrameCallbacks | undefined>(undefined)
const FrameRowsContext = createContext<MenuContribution[] | undefined>(undefined)

export const FrameCallbacksProvider = FrameCallbacksContext.Provider
export const FrameRowsProvider = FrameRowsContext.Provider

export function useFrameCallbacks(): FrameCallbacks | undefined {
  return useContext(FrameCallbacksContext)
}

export function useFrameRows(): MenuContribution[] | undefined {
  return useContext(FrameRowsContext)
}
