// fb-file://<file-id> → that file from the files store, on the sessions that may
// read local files (4.3.50).
//
// It was handled on the default session only, so a pdf widget's <webview>
// (persist:webview-default) could not load its own fb-file:// src. Local files
// now open in a session of their own, LOCAL_FILE_PARTITION, which handles
// fb-file:// and answers every http(s) request itself with a refusal: no website
// runs in the one webview session that can read local files by id.
// persist:webview-default, where any website runs, is deliberately left without
// it. (The refusal is a protocol handler, not webRequest.onBeforeRequest: a
// session has one such listener, and the e2e net guard owns it.)

import { net, type Protocol, type Session } from 'electron'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'

type FileLookup = (id: string) => { storedPath: string; mimeType: string } | null | undefined

/** The fb-file:// handler: Range requests pass through net.fetch (video, chunked PDF). */
export function makeFbFileHandler(getFile: FileLookup): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url)
      // host is the file id (e.g. fb-file://abc-123/) — Chromium normalises
      // to lowercase, but our UUIDs are lowercase anyway. The path is ignored.
      const file = getFile(url.hostname)
      if (!file || !existsSync(file.storedPath)) {
        return new Response('Not found', { status: 404 })
      }
      // net.fetch on a file:// URL streams the file; the stored mime type
      // overrides the extension's so the renderer always picks the right viewer.
      const response = await net.fetch(pathToFileURL(file.storedPath).toString())
      const headers = new Headers(response.headers)
      headers.set('Content-Type', file.mimeType)
      headers.set('Cache-Control', 'no-cache')
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    } catch (err) {
      return new Response(`fb-file error: ${String(err)}`, { status: 500 })
    }
  }
}

/** The schemes the local-file session answers with a refusal, without touching the network. */
export const LOCAL_FILE_SESSION_REFUSED = ['http', 'https'] as const

function refuseWeb(): Response {
  return new Response('This view opens files from this computer only.', { status: 403, headers: { 'Content-Type': 'text/plain' } })
}

/**
 * Handle fb-file:// on the app's own session (its iframes and video) and on the
 * local-file webview session, which also refuses http(s).
 */
export function installFileProtocol(
  appProtocol: Pick<Protocol, 'handle'>,
  localFileSession: Pick<Session, 'protocol'>,
  getFile: FileLookup
): void {
  const handler = makeFbFileHandler(getFile)
  appProtocol.handle('fb-file', handler)
  localFileSession.protocol.handle('fb-file', handler)
  for (const scheme of LOCAL_FILE_SESSION_REFUSED) localFileSession.protocol.handle(scheme, refuseWeb)
}
