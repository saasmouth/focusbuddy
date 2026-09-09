// The parts of window.api that are about the platform rather than the data.
//
// These are served on the main thread, next to the session, because they are
// questions about the page: how big the text is, whether an update is waiting,
// whether a link was handed to the app on launch. Sending them to the Worker
// would be routing a question about the window to the process that holds the
// database.
//
// Every answer here is the true one for a browser, not a placeholder. That
// distinction matters: the renderer treats a rejected call as a fault worth
// logging, and there is no fault in a tab having no pending deep link.

/**
 * App-wide text size. The desktop sets Chromium's page zoom on the window; a
 * tab cannot, because that zoom belongs to the user's browser. Scaling the root
 * element gives the same result for the same input, and leaves the browser's
 * own zoom independently on top of it, which is what a user would expect.
 */
function setZoomFactor(factor: number): void {
  const f = typeof factor === 'number' && factor > 0 ? Math.min(Math.max(factor, 0.5), 3) : 1
  document.documentElement.style.setProperty('font-size', `${16 * f}px`)
}

export function platformNamespaces(): Record<string, Record<string, unknown>> {
  return {
    app: {
      setZoomFactor: async (factor: number) => setZoomFactor(factor),
      // The tab paints its own background; there is no native window behind it.
      setBackgroundColor: async () => false,
      // The preview guard asks this before deciding whether to block sync. The
      // browser build is not the side-by-side preview binary, so: no.
      isPreviewBuild: async () => false,
      getLaunchInfo: async () => ({
        version: __APP_VERSION__,
        // A tab has no previous launch to compare against, and claiming an
        // update would fire the "What's new" modal on every visit.
        previousVersion: null,
        wasUpdated: false,
        firstInstall: false
      }),
      focusWindow: async () => {
        window.focus()
      }
    },

    update: {
      // A browser app is whatever the server last deployed: there is no
      // download, no install and no restart. 'idle' is the honest answer, and
      // it is one of the states the renderer already handles.
      getState: async () => ({ kind: 'idle' as const }),
      check: async () => ({ ok: true as const }),
      installAndRestart: async () => ({ ok: true as const }),
      openDownload: async () => ({ ok: true as const }),
      downloadAndInstall: async () => ({ ok: true as const })
    },

    // Deep-link handoffs. On the desktop the OS hands the app a URL it was
    // opened with and these drain it. A tab is opened with its own URL instead,
    // so there is genuinely nothing pending -- null, not an error.
    auth: { getPending: async () => null },
    share: { getPending: async () => null },
    meet: { getPending: async () => null },
    mdext: { getPending: async () => null }
  }
}
