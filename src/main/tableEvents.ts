import { BrowserWindow } from 'electron'

// Row-change fan-out: the main process writes table rows behind the renderer's
// back (PlexiFlows on the 5-minute tick, form submissions, the local REST API,
// template application). The tables store caches rows forever, so those writes
// were invisible until an app restart — the "table missing data" report. Every
// main-side row write announces itself here; the renderer invalidates just the
// affected table's cache. Renderer-initiated writes also pass through, which
// costs one redundant refetch and guarantees convergence.
export function notifyRowsChanged(tableId: string): void {
  // Guarded as a whole, like notifyDocumentChanged: a write that already
  // succeeded must never fail because there is no Electron to notify (tests,
  // other hosts). Degrading to silence is the safe failure.
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      try {
        win.webContents.send('tables:rowsChanged', tableId)
      } catch {
        // window may have closed mid-broadcast — ignore
      }
    }
  } catch {
    // no Electron here, or no windows yet: nothing to tell.
  }
}
