// window.api for the browser.
//
// The renderer reaches its data through window.api and nothing else -- it has
// no Electron import and no Node builtin anywhere in its files, which is what
// makes a cloud runtime possible at all. This builds the same object over a
// Worker instead of a preload, so the renderer runs unchanged.
//
// Every path is taken from the generated channel map rather than assembled from
// the namespace and method name: window.api.workspaceSync.pending is
// 'workspace:pending', and there are enough mismatches like it that a
// convention would be a guess. Regenerating the map is what stops a channel
// renamed on the desktop from silently doing nothing here.
//
// Where the call actually runs is dbClient's problem, not this file's: the
// database lives in whichever tab holds the lock, and this one may not be it.
import { INVOKE_CHANNELS, LISTEN_CHANNELS } from './channelMap.generated'
import { accountNamespace } from './session'
import { platformNamespaces } from './platform'
import { settingsNamespace } from './providerKeys'
import { dbCall, dbSubscribe, startCoordinator, unservedChannels } from './dbClient'

export { unservedChannels, isDatabaseLeader } from './dbClient'

type Listener = (...args: unknown[]) => void

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
    ;(api[ns] ??= {})[method] = (...args: unknown[]) => dbCall(channel, args)
  }

  for (const [path, channel] of Object.entries(LISTEN_CHANNELS)) {
    const [ns, method] = path.split('.')
    ;(api[ns] ??= {})[method] = (cb: Listener) => dbSubscribe(channel, cb)
  }

  // The session and the platform questions belong to the page, not the
  // database, so they are served here rather than in the Worker. Overlaid last
  // so they win over the generated entries for the same channels.
  api.account = { ...(api.account ?? {}), ...accountNamespace() }
  for (const [ns, members] of Object.entries(platformNamespaces())) {
    api[ns] = { ...(api[ns] ?? {}), ...members }
  }
  // Provider keys travel from the page to Signal directly and are never stored
  // here, so they are served on the main thread too -- routing them through the
  // Worker would put a key in a second place for no benefit.
  api.settings = { ...(api.settings ?? {}), ...settingsNamespace() }

  return api
}

/** Install as window.api. Called before the renderer's entry module runs. */
export function installBrowserApi(): void {
  startCoordinator()
  ;(window as unknown as { api: unknown }).api = createBrowserApi()
  // Reachable from the console for support: which calls this session asked for
  // and did not get.
  ;(window as unknown as { plexiiUnserved: unknown }).plexiiUnserved = unservedChannels
}
