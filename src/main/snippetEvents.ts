import { BrowserWindow } from 'electron'

// Snippet-change fan-out, the same shape as tableEvents and for the same reason.
//
// A live snippet instance resolves its master when it mounts. That covers a
// host opened after an edit and misses the one the user is looking at — so
// editing a master from inside a placed instance left the copy beside it showing
// the old text while still claiming to be live.
//
// Announcing it from MAIN rather than from the renderer store is deliberate. The
// store is not the only writer: a direct `window.api.snippets.update` call
// bypasses it (the e2e suite does exactly that), and workspace sync will write
// here too once it carries snippets. Broadcasting from the one place every write
// already funnels through means no writer has to remember. Renderer-initiated
// writes also pass through, which costs one redundant re-resolve and guarantees
// convergence.
export function notifySnippetChanged(id: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send('snippets:changed', id)
    } catch {
      // window may have closed mid-broadcast — ignore
    }
  }
}
