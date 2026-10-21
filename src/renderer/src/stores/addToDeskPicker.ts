// The "Add to desk" picker: opened by "New desk…" / "Choose a desk…" in the
// right-click menu on a web page, and by AI Assist's "Add to desk…" for a
// result made from text on a page. Mounted once (AddToDeskPicker).
import { create } from 'zustand'
import type { AddToDeskCommand } from '../lib/addToDesk'

interface AddToDeskPickerState {
  command: AddToDeskCommand | null
  /** 'new' opens straight on naming a new desk; 'choose' on the desk list. */
  open: (command: AddToDeskCommand) => void
  close: () => void
}

export const useAddToDeskPicker = create<AddToDeskPickerState>((set) => ({
  command: null,
  open: (command) => set({ command }),
  close: () => set({ command: null })
}))
