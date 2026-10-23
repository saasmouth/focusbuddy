import { BrowserWindow } from 'electron'

// Document-change fan-out, the same shape as tableEvents and for a sharper
// reason: without it, one document open in two places went silently out of sync
// and then one side's save destroyed the other's work.
//
// A document can be open more than once at a time — two linked-duplicate
// widgets share a document id, a desk widget and the Documents view can show
// the same file, and there may be more than one window — and each holds the
// whole body in its own memory, seeded when it mounted. Nothing told the others
// when one of them saved, so their copies silently aged, and the next save from
// a stale copy overwrote the newer body in full. body_rev now REFUSES that
// write; this is what stops it happening in the first place, by letting a copy
// with nothing unsaved simply catch up.
//
// It carries the new revision so a listener can tell its own write apart from
// someone else's: the writer already has that number, so it can ignore the echo
// of its own save instead of refetching for nothing.
export function notifyDocumentChanged(id: string, bodyRev: number): void {
  // A SAVE MUST NEVER FAIL BECAUSE A NOTIFICATION COULD NOT GO OUT, which is
  // why the whole thing is guarded and not just the per-window send. This is
  // called from db/documents.ts, which also runs where there is no Electron at
  // all — the cloud runtime swaps this module out, but a test or any other
  // non-Electron host imports it as it is, and `BrowserWindow` is then
  // undefined. Unguarded, `BrowserWindow.getAllWindows()` threw and took the
  // document write down with it: eight tests failed on a write that had already
  // succeeded.
  //
  // Degrading to silence is the right failure. Without the broadcast another
  // editor's copy simply ages, which is exactly the state body_rev's
  // compare-and-set exists to catch — so the worst case is a conflict prompt,
  // not lost work.
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send('documents:changed', id, bodyRev)
      } catch {
        // window may have closed mid-broadcast — ignore
      }
    }
  } catch {
    // no Electron here, or no windows yet: nothing to tell.
  }
}
