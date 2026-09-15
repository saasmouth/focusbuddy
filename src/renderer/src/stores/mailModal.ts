import { create } from 'zustand'

// Which email is open, if any.
//
// A store rather than local state because the reader is opened from several
// places that do not know about each other -- the inbox widget on a desk, the
// mail view, a search hit -- and none of them should have to own the modal or
// navigate away to show one message.

interface MailModalState {
  uid: number | null
  open: (uid: number) => void
  close: () => void
}

export const useMailModalStore = create<MailModalState>((set) => ({
  uid: null,
  open: (uid) => set({ uid }),
  close: () => set({ uid: null })
}))

// Same handle as __fbView: a thin reference to the real store so e2e specs and
// debugging sessions can open the reader without a configured mailbox to click
// through. Not a mock — it changes nothing about how the app behaves.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbMailModal?: typeof useMailModalStore }).__fbMailModal =
    useMailModalStore
}
