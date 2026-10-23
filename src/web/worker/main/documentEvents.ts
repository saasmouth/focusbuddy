// Document-change fan-out for the cloud runtime.
//
// The desktop broadcasts to every BrowserWindow so another editor on the same
// document can catch up instead of saving over it. Here there is one client —
// the page that owns this Worker — and the same message reaches it by
// postMessage on the channel the renderer already subscribes to.
//
// A browser has one page, so the cross-window case does not arise; the case
// that still does is two editors on ONE page (a desk widget and the Documents
// view, or two linked-duplicate widgets), which is the common one.
export function notifyDocumentChanged(id: string, bodyRev: number): void {
  ;(self as unknown as { postMessage(m: unknown): void }).postMessage({
    event: 'documents:changed',
    args: [id, bodyRev]
  })
}
