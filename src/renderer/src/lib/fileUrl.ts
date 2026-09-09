// The URL an <img>, <video> or <a> uses to reach a Drive file's bytes.
//
// On the desktop that is `fb-file://<id>`, a privileged custom protocol
// registered in the main process which streams from disk and supports Range
// requests. A browser has no such scheme -- an <img src="fb-file://…"> simply
// fails, silently, which is exactly how every image on a synced desk came up
// blank in the cloud app.
//
// So in the browser the same id becomes a same-origin path, served by a Service
// Worker that reads the bytes out of OPFS. Deliberately a path rather than a
// blob: URL, because a blob: URL has to be created before the element renders,
// revoked afterwards, and re-created on every mount -- three ways to leak or to
// show nothing. A path is a plain string that behaves like any other image URL,
// including in CSS, and it survives being copied into markup.
const WEB = (): boolean => (globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__ === true

/** Where this file's bytes can be fetched from, in whichever runtime we are. */
export function fileSrc(fileId: string): string {
  return WEB() ? `/fb-file/${encodeURIComponent(fileId)}` : `fb-file://${fileId}`
}
