// Whether the email-verification modal is open. Opened by the sign-up flow, the
// footer "Verify email" pill, and a managed-AI refusal (email_not_verified).
import { create } from 'zustand'

interface VerifyEmailStore {
  isOpen: boolean
  open: () => void
  close: () => void
}

export const useVerifyEmailStore = create<VerifyEmailStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false })
}))
