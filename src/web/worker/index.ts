// The cloud runtime's main process.
//
// In the desktop app the renderer calls window.api, the preload forwards it
// over IPC, and the main process answers with a database on disk. Here the
// renderer calls window.api, the bridge forwards it over postMessage, and this
// Worker answers with the same database compiled to WebAssembly. The renderer
// cannot tell the difference, which is why it runs unmodified.
//
// The Worker is not an implementation detail that could be moved to the main
// thread later: SQLite's OPFS backing needs FileSystemSyncAccessHandle, which
// only exists inside a Worker, and the data layer is synchronous. Both facts
// point here.
import { openWorkspaceDatabase } from './database'
import { HANDLERS } from './handlers'
import { adoptSession } from './main/account'

export interface WorkerRequest {
  id: number
  channel: string
  args: unknown[]
}

/**
 * Sent once, before any call, to hand the Worker the signed-in session.
 *
 * The session lives on the main thread, in localStorage, because it belongs to
 * the browser rather than to the database -- but the data layer asks for it
 * through loadAccountState(), and code that needs a token to reach Signal
 * (credits, live desks) would otherwise see an empty account and quietly behave
 * as if signed out.
 */
export interface WorkerInit {
  kind: 'init'
  session: { sessionToken: string | null; skippedAt: number | null; cachedEmail: string | null }
}

export interface WorkerResponse {
  id: number
  ok: boolean
  value?: unknown
  error?: string
  /** Echoed back so the caller can record refusals without parsing messages. */
  channel: string
  /** Set when the channel exists on the desktop but this runtime does not serve it. */
  unserved?: boolean
}

// Opening is awaited before the first message is answered. Requests that arrive
// during startup queue behind this promise rather than racing an empty handle.
const ready = openWorkspaceDatabase().then(
  () => null,
  (err: Error) => err
)

self.onmessage = async (event: MessageEvent<WorkerRequest | WorkerInit>): Promise<void> => {
  if ((event.data as WorkerInit).kind === 'init') {
    adoptSession((event.data as WorkerInit).session)
    return
  }
  const { id, channel, args } = event.data as WorkerRequest
  const reply = (r: Omit<WorkerResponse, 'id' | 'channel'>): void => self.postMessage({ id, channel, ...r })

  const failure = await ready
  if (failure) {
    // The database never opened. Every call fails with that reason rather than
    // with whatever each one would have thrown for want of a handle, because
    // "getDb() before open" repeated 500 times hides the one message that says
    // OPFS is unavailable.
    reply({ ok: false, error: `workspace database unavailable: ${failure.message}` })
    return
  }

  const handler = HANDLERS[channel]
  if (!handler) {
    // An honest refusal, naming the channel. The desktop serves 526 of these
    // and this runtime serves a subset; a call outside the subset must say so
    // rather than resolve with undefined, which the renderer would render as an
    // empty desk and a user would read as lost work.
    reply({ ok: false, unserved: true, error: `${channel} is not available in the browser runtime yet` })
    return
  }

  try {
    reply({ ok: true, value: await (handler as (...a: unknown[]) => unknown)(...args) })
  } catch (err) {
    // Name the channel. A handler's own message -- "Cannot read properties of
    // undefined (reading 'length')" -- says nothing about which of a hundred
    // calls produced it, and both sides of this boundary are minified in a
    // build, so the stack does not either.
    const detail = err instanceof Error ? err.message : String(err)
    reply({ ok: false, error: `${channel}: ${detail}` })
  }
}
