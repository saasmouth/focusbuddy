// The protected-video probe for desk web pages (see src/shared/drm.ts).
//
// Registered by main as a SESSION preload on the web partitions
// (src/main/widevine.ts installDrmProbe), for http(s) pages only. It is not a
// <webview> preload: will-attach-webview strips those, because a preload a page
// could choose would be a sandbox escape. This one is chosen by main, runs
// sandboxed and context-isolated like the page around it, and gives the page
// nothing: the page's world gets one injected function (drmMainWorldProbe)
// that holds two callbacks in a closure, and those can only ask main whether
// the CDM is ready and tell main what happened. Main validates every report
// and acts on none of them beyond a notice for this page.
import { contextBridge, ipcRenderer } from 'electron'
import { drmMainWorldProbe } from '@shared/drmMainWorldProbe'
import { isNetflixHost, NETFLIX_CODE_SOURCE, NETFLIX_DRM_FAMILIES, type CdmStatus } from '@shared/drm'

/** How long a licence request may go unanswered before it counts as failed. */
const LICENCE_WAIT_MS = 15_000
/** Reports one page may send; a page that loops cannot flood main. */
const MAX_REPORTS = 12

let settled: CdmStatus | null = null
let pending: Promise<CdmStatus | null> | null = null

/** Ask main once whether the CDM is ready; main answers when it has settled. */
function waitForCdm(): Promise<CdmStatus | null> {
  if (settled && settled.state !== 'installing') return Promise.resolve(settled)
  if (!pending) {
    pending = new Promise((resolve) => {
      const onStatus = (_e: unknown, s: CdmStatus): void => {
        ipcRenderer.removeListener('drm:cdm-status', onStatus)
        settled = s && typeof s === 'object' ? s : null
        pending = null
        resolve(settled)
      }
      ipcRenderer.on('drm:cdm-status', onStatus)
      ipcRenderer.send('drm:cdm-wait')
    })
  }
  return pending
}

let reports = 0
function report(evidence: Record<string, unknown>): void {
  if (++reports > MAX_REPORTS) return
  ipcRenderer.send('drm:report', evidence)
}

try {
  const host = typeof location !== 'undefined' ? location.hostname : ''
  contextBridge.executeInMainWorld({
    func: drmMainWorldProbe,
    args: [
      waitForCdm,
      report,
      {
        watchNetflix: isNetflixHost(host),
        netflixCodeSource: NETFLIX_CODE_SOURCE,
        netflixFamilies: [...NETFLIX_DRM_FAMILIES],
        licenceWaitMs: LICENCE_WAIT_MS
      }
    ]
  })
} catch (err) {
  // Never stop a page loading over this: without the probe it simply gets no
  // wait and no notice.
  console.warn('[drm] probe not installed:', err instanceof Error ? err.message : err)
}
