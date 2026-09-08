// window.api for the browser.
//
// The renderer reaches its data through window.api and nothing else -- it has
// no Electron import and no Node builtin anywhere in its 900-odd files, which
// is what makes a cloud runtime possible at all. This builds the same object
// over a Worker instead of a preload, so the renderer runs unchanged.
//
// Every path is taken from the generated channel map rather than assembled from
// the namespace and method name: window.api.workspaceSync.pending is
// 'workspace:pending', and there are enough mismatches like it that a
// convention would be a guess. Regenerating the map is what stops a channel
// renamed on the desktop from silently doing nothing here.
import { INVOKE_CHANNELS, LISTEN_CHANNELS } from './channelMap.generated'
import { accountNamespace } from './session'

type Listener = (...args: unknown[]) => void

let worker: Worker | null = null
let nextId = 1
const inflight = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const listeners = new Map<string, Set<Listener>>()

/** Channels the renderer asked for that this runtime does not serve. */
const unserved = new Map<string, number>()

/**
 * Every channel the renderer has actually called and been refused, with a
 * count. This is the parity gap as measured rather than estimated: not what
 * somebody thought the browser would need, but what this session's use of the
 * app genuinely reached for and did not get.
 */
export function unservedChannels(): Array<{ channel: string; calls: number }> {
  return [...unserved.entries()]
    .map(([channel, calls]) => ({ channel, calls }))
    .sort((a, b) => b.calls - a.calls)
}

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../worker/index.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent): void => {
    const { id, ok, value, error, channel, unserved: wasUnserved, event: pushed, args } = event.data ?? {}
    // A push from the Worker rather than an answer -- the equivalent of the main
    // process sending on a channel the renderer subscribed to.
    if (pushed) {
      for (const cb of listeners.get(pushed) ?? []) cb(...((args as unknown[]) ?? []))
      return
    }
    const pendingCall = inflight.get(id)
    if (!pendingCall) return
    inflight.delete(id)
    if (ok) pendingCall.resolve(value)
    else {
      if (wasUnserved) unserved.set(channel, (unserved.get(channel) ?? 0) + 1)
      pendingCall.reject(new Error(String(error)))
    }
  }
  return worker
}

function invoke(channel: string, args: unknown[]): Promise<unknown> {
  const w = ensureWorker()
  const id = nextId++
  return new Promise((resolve, reject) => {
    inflight.set(id, { resolve, reject })
    // Arguments cross a structured-clone boundary here exactly as they cross
    // Electron's, so anything the desktop could not send over IPC cannot be
    // sent here either -- the constraint is identical, not merely similar.
    w.postMessage({ id, channel, args })
  })
}

function subscribe(channel: string, cb: Listener): () => void {
  let set = listeners.get(channel)
  if (!set) listeners.set(channel, (set = new Set()))
  set.add(cb)
  return () => { set?.delete(cb) }
}

/**
 * Build the api object.
 *
 * Namespaces are materialised from the channel map, so the shape matches the
 * preload's. A method the map knows but the Worker does not serve still exists
 * and still returns a promise -- it rejects, with the channel named. The
 * renderer already handles rejected api calls; what it cannot handle is a
 * method that is simply absent, which throws a TypeError deep inside a render.
 */
export function createBrowserApi(): Record<string, Record<string, unknown>> {
  const api: Record<string, Record<string, unknown>> = {}

  for (const [path, channel] of Object.entries(INVOKE_CHANNELS)) {
    const [ns, method] = path.split('.')
    ;(api[ns] ??= {})[method] = (...args: unknown[]) => invoke(channel, args)
  }

  for (const [path, channel] of Object.entries(LISTEN_CHANNELS)) {
    const [ns, method] = path.split('.')
    ;(api[ns] ??= {})[method] = (cb: Listener) => subscribe(channel, cb)
  }

  // The session belongs to the browser, not to the database, so account is
  // served here rather than in the Worker. Overlaid last so it wins over the
  // generated entries for the same four channels.
  api.account = { ...(api.account ?? {}), ...accountNamespace() }

  return api
}

/** Install as window.api. Called before the renderer's entry module runs. */
export function installBrowserApi(): void {
  ;(window as unknown as { api: unknown }).api = createBrowserApi()
}
