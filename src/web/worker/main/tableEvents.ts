// Row-change fan-out for the cloud runtime.
//
// The desktop broadcasts to every BrowserWindow so the renderer's table cache
// can be invalidated when the main process writes rows behind its back. Here
// there is one client -- the page that owns this Worker -- and the same message
// reaches it by postMessage on the channel the renderer already subscribes to
// through window.api.tables.onRowsChanged.
//
// The bridge recognises a message carrying `event` as a push rather than an
// answer to a call, which is the postMessage equivalent of webContents.send.
export function notifyRowsChanged(tableId: string): void {
  ;(self as unknown as { postMessage(m: unknown): void }).postMessage({
    event: 'tables:rowsChanged',
    args: [tableId]
  })
}
