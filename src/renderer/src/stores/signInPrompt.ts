import { create } from 'zustand'
import { shareGate } from '../lib/shareGate'

// A tiny shared flag so anywhere in the app (the Settings account section, a
// capability-expired prompt, a "sign in to invite" affordance) can pop the
// sign-in modal on demand. The modal renders on boot by its own rules; this
// lets it also open when the user explicitly asks, even after they once chose
// "Continue without account".
interface SignInPromptStore {
  open: boolean
  requestOpen: () => void
  close: () => void
}

export const useSignInPrompt = create<SignInPromptStore>((set) => ({
  open: false,
  // A shared desk's visitor has no sign-in here: Plexii's account lives in the
  // app, so asking for one is the download gate (lib/shareGate.ts).
  requestOpen: () => {
    if (shareGate('Signing in')) return
    set({ open: true })
  },
  close: () => set({ open: false })
}))

// Spec access, same convention as __fbView: e2e opens the modal on demand
// (the boot-path rules never fire in a seeded profile).
;(window as unknown as { __fbSignInPrompt?: typeof useSignInPrompt }).__fbSignInPrompt =
  useSignInPrompt
