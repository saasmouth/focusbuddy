// A request to open "Build with AI" with its prompt already written. Raised by
// the demo → app handoff (growth spec section 7: the site's /demo stores the
// sentence on the new account, the app fetches it once on first sign-in and
// opens Build with AI prefilled). Canvas owns the dialog and consumes this.
import { create } from 'zustand'

interface AiBuilderLaunchStore {
  prompt: string | null
  request: (prompt: string) => void
  consume: () => string | null
}

export const useAiBuilderLaunch = create<AiBuilderLaunchStore>((set, get) => ({
  prompt: null,
  request: (prompt) => set({ prompt }),
  consume: () => {
    const p = get().prompt
    set({ prompt: null })
    return p
  }
}))
