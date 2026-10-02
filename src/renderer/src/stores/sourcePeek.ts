import { create } from 'zustand'
import type { ResolvedTarget } from '../lib/sourcePeek'

// The reference currently being looked at in place.
//
// A store rather than state inside the chat panel because a reference can be
// cited from more than one surface -- the assistant panel, a focus-mode chat
// block, a proposal card's evidence -- and all of them should open the same one
// viewer rather than each growing their own.
interface SourcePeekStore {
  target: ResolvedTarget | null
  /** What the citation called it, so the viewer has a title before it loads. */
  label: string | null
  open: (target: ResolvedTarget, label?: string | null) => void
  close: () => void
}

export const useSourcePeek = create<SourcePeekStore>((set) => ({
  target: null,
  label: null,
  open: (target, label = null) => set({ target, label }),
  close: () => set({ target: null, label: null })
}))

// Exposed on window the way __fbWidgets and __fbView are, so a spec can open a
// reference without first having to make the assistant cite one. A thin handle
// to the real store, not a mock; it changes nothing for users.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbSourcePeek?: typeof useSourcePeek }).__fbSourcePeek = useSourcePeek
}
