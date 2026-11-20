// The widget host page (F2 of plexii-lite docs/plans/widget-files.md).
//
// ONE Plexii widget or Office document from a `.plexii-*` file, inside
// PlexiiLite. The page is handed the file's text (protocol.ts), imports it into
// a database that lives in memory for this page only, shows it with the same
// component a desk uses, and hands the text back when the person changes it.
// It never signs in, never touches a disk, and reaches the network only where
// a widget itself does (a map's tiles).
// The icon font pinned to the host's one style (0.5 MB, not 3.9): icons.css.
import './icons.css'
import '@fontsource-variable/inter'
import '@renderer/styles/globals.css'
import './host.css'
import { enterWidgetHost } from '@renderer/lib/widgetHost'
import { flushPendingDocumentSaves } from '@renderer/stores/documents'
import { createBrowserApi } from '../api/bridge'
import { createWorkerTransport, observeTransport } from './hostTransport'
import { windowEmbedder } from './embedder'
import { guardInput } from './inputGuard'
import { startWidgetHost } from './controller'
import { createReactView } from './view'
import { hostError } from './protocol'
import { routeLinks } from './links'
import { servePickers } from './pickers'

const readOnlyFromUrl = new URLSearchParams(location.search).get('readonly') === '1'
// Before anything renders: the renderer asks this to hide desk and AI controls.
enterWidgetHost({ readOnly: readOnlyFromUrl })
// The shared renderer's own web switch (renderWidget, lib/fileUrl).
;(globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__ = true

// A Worker of this page's own, with its rows in memory (worker/hostMode.ts):
// no Web Lock, no BroadcastChannel, no OPFS, no other page. The name is
// written out because Vite reads Worker options statically; it must equal
// WIDGET_HOST_WORKER_NAME (tests/unit/widgetHostMemoryDb.test.ts checks).
const worker = new Worker(new URL('../worker/index.ts', import.meta.url), { type: 'module', name: 'plexii-widget-host' })
const transport = observeTransport(createWorkerTransport(worker))
;(window as unknown as { api: unknown }).api = createBrowserApi(transport)
;(window as unknown as { plexiiUnserved: unknown }).plexiiUnserved = () => transport.unserved()
// Insert image and Place: a file input stands in for the desktop's dialog.
servePickers((window as unknown as { api: Record<string, Record<string, unknown>> }).api)

const embedder = windowEmbedder()
// Links open in the person's browser via PlexiiLite, never in this page.
routeLinks((m) => embedder.post(m))
const view = createReactView(document.getElementById('root')!, (detail) => {
  const msg = hostError('render-failed', { detail })
  embedder.post(msg)
  if (msg.type === 'plexii-widget-host:error') view.showProblem(msg.message)
})

startWidgetHost({
  embedder,
  transport,
  view: {
    ...view,
    show(shown) {
      enterWidgetHost({ readOnly: shown.readOnly })
      view.show(shown)
    }
  },
  readOnlyFromUrl,
  guard: (opts) => guardInput(opts),
  flushDocuments: flushPendingDocumentSaves
})
