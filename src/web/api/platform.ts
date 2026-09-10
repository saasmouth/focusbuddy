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

    files: {
      /**
       * A real thumbnail, generated here.
       *
       * The desktop rasterises with native tooling and can preview a PDF, a Word
       * document or a video frame. The browser can only do what it can decode --
       * images -- so anything else returns null, which is the contract's own way
       * of saying "no thumbnail", and the Files view already draws a file-type
       * icon for it.
       *
       * The bytes come through the Service Worker rather than the database,
       * because that path already exists and already knows the MIME type.
       */
      thumbnail: async (
        id: string,
        opts?: { size?: number }
      ): Promise<{ base64: string; mimeType: 'image/png'; width: number; height: number } | null> => {
        const size = Math.max(16, Math.min(opts?.size ?? 256, 1024))
        try {
          const res = await fetch(`/fb-file/${encodeURIComponent(id)}`)
          if (!res.ok) return null
          const type = res.headers.get('content-type') ?? ''
          // SVG decodes, but drawing one to a canvas taints it in some browsers
          // and it scales perfectly on its own anyway.
          if (!type.startsWith('image/') || type.includes('svg')) return null
          const bitmap = await createImageBitmap(await res.blob())
          // Fit inside the box, never upscale: a 32px icon blown up to 256 looks
          // worse than the icon the caller would have drawn instead.
          const scale = Math.min(size / bitmap.width, size / bitmap.height, 1)
          const width = Math.max(1, Math.round(bitmap.width * scale))
          const height = Math.max(1, Math.round(bitmap.height * scale))
          const canvas = new OffscreenCanvas(width, height)
          const ctx = canvas.getContext('2d')
          if (!ctx) {
            bitmap.close()
            return null
          }
          ctx.drawImage(bitmap, 0, 0, width, height)
          bitmap.close()
          const blob = await canvas.convertToBlob({ type: 'image/png' })
          const buf = new Uint8Array(await blob.arrayBuffer())
          let binary = ''
          // Chunked: a single spread of a few hundred thousand bytes overflows
          // the argument limit on some engines.
          for (let i = 0; i < buf.length; i += 0x8000) {
            binary += String.fromCharCode(...buf.subarray(i, i + 0x8000))
          }
          return { base64: btoa(binary), mimeType: 'image/png', width, height }
        } catch {
          // A file with no bytes here yet, or a format this browser will not
          // decode. Null is the honest answer and the caller handles it.
          return null
        }
      }
    },

    mail: {
      // There is no mailbox here, and saying so is the true answer rather than
      // a stand-in: the desktop returns exactly this shape when no account has
      // been connected, and a browser cannot open an IMAP socket at all.
      //
      // Refusing instead was correct but unhelpful. The mail store calls this
      // on boot and does not catch, so every load of the cloud app threw an
      // uncaught rejection into the console -- alarming, and it buried the
      // errors that actually mattered.
      //
      // Only this one channel. Listing, sending or connecting would be a lie,
      // so those still refuse by name.
      getAccount: async () => ({ configured: false, host: '', port: 993, secure: true, user: '', email: '' })
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
