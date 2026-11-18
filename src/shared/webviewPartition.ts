// Which session a <webview> runs in (4.3.50).
//
// Freeform browser widgets share persist:webview-default (one cookie jar with
// the web panel); a connected app keeps its own persist:connectedapp-<id>. A
// file from this computer (fb-file://<id>, the pdf / file / gdoc widgets) gets
// LOCAL_FILE_PARTITION: the one webview session that can read local files, and
// one that refuses web traffic (main/fileProtocol.ts). fb-file:// is never
// handled on the shared web partition, where any website runs.

export const LOCAL_FILE_PARTITION = 'fb-local-files'
export const SHARED_WEB_PARTITION = 'persist:webview-default'

export function webviewPartitionFor(src: string, sourceAppId?: string | null): string {
  if (/^fb-file:\/\//i.test(src)) return LOCAL_FILE_PARTITION
  return sourceAppId ? `persist:connectedapp-${sourceAppId}` : SHARED_WEB_PARTITION
}
