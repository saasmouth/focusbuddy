// window.api's transport for the widget host: one private Worker per page.
//
// The share app's transport (api/dbClient.ts) elects ONE tab per origin, over
// a Web Lock and a BroadcastChannel, to hold the workspace database; every other
// tab sends its calls there. That is right for a workspace and wrong here.
// PlexiiLite shows each widget file in its own page, and those pages share an
// origin, so they would have shared one database through whichever tile won
// the lock -- mixing their rows, and failing one tile's calls in flight when
// another tile closed. A widget host page owns its Worker, and the Worker keeps
// its rows in memory (worker/hostMode.ts): nothing is shared with any other page.
import type { ApiTransport } from '../api/bridge'

type Listener = (...args: unknown[]) => void

export interface HostTransport extends ApiTransport {
  /** Every push from the data layer (a row or document change), by event name. */
  onPush(cb: (event: string) => void): () => void
  /** Channels the widget called and this runtime does not serve, with counts. */
  unserved(): Array<{ channel: string; calls: number }>
}

export function createWorkerTransport(worker: Worker): HostTransport {
  let seq = 1
  const waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const listeners = new Map<string, Set<Listener>>()
  const anyPush = new Set<(event: string) => void>()
  const unserved = new Map<string, number>()

  // Signed out, said explicitly: the host never signs in and never reaches
  // Signal, and the data layer asks for the session through loadAccountState.
  worker.postMessage({ kind: 'init', session: { sessionToken: null, skippedAt: null, cachedEmail: null } })

  worker.onmessage = (ev: MessageEvent): void => {
    const { id, ok, value, error, channel, unserved: wasUnserved, event, args } = (ev.data ?? {}) as {
      id?: number; ok?: boolean; value?: unknown; error?: string; channel?: string; unserved?: boolean; event?: string; args?: unknown[]
    }
    if (event) {
      for (const cb of listeners.get(event) ?? []) cb(...(args ?? []))
      for (const cb of anyPush) cb(event)
      return
    }
    if (id === undefined) return
    const w = waiters.get(id)
    if (!w) return
    waiters.delete(id)
    if (ok) w.resolve(value)
    else {
      if (wasUnserved && channel) unserved.set(channel, (unserved.get(channel) ?? 0) + 1)
      w.reject(new Error(error ?? 'widget host call failed'))
    }
  }

  return {
    call(channel, args) {
      const id = seq++
      return new Promise((resolve, reject) => {
        waiters.set(id, { resolve, reject })
        worker.postMessage({ id, channel, args })
      })
    },
    subscribe(event, cb) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(cb)
      return () => void set!.delete(cb)
    },
    onPush(cb) {
      anyPush.add(cb)
      return () => void anyPush.delete(cb)
    },
    unserved() {
      return [...unserved.entries()].map(([channel, calls]) => ({ channel, calls })).sort((a, b) => b.calls - a.calls)
    }
  }
}

// Channels that only read. Everything else may have changed the file, so it is
// followed by an export check (debounced, and the save gate decides).
const READS = /:(get|list|read|load|search|find|count|has|is|resolve|preview|query|status|describe|current|instances|placements|export)/

export interface ObservedTransport extends HostTransport {
  /** Calls sent and not yet answered. A flush waits for this to reach 0. */
  inFlight(): number
  /** When a call last started or settled (Date.now()), for a flush's quiet window. */
  lastActivity(): number
  /** After any call that may have written settles. */
  onWrite(cb: () => void): () => void
}

/**
 * The same transport, watched: how many calls are in flight, and when a call
 * that may have written something has settled. The widget host saves by
 * exporting the file after writes; watching the transport (rather than a
 * store) catches every write a widget makes, whichever store or table it goes
 * through, including a table's rows and an Office document's body.
 */
export function observeTransport(t: HostTransport): ObservedTransport {
  let inFlight = 0
  let last = 0
  const now = (): number => Date.now()
  const writers = new Set<() => void>()
  return {
    call(channel, args) {
      inFlight++
      last = now()
      const done = (): void => {
        inFlight--
        last = now()
        if (!READS.test(channel)) for (const cb of writers) cb()
      }
      return t.call(channel, args).then(
        (v) => { done(); return v },
        (e) => { done(); throw e }
      )
    },
    subscribe: (event, cb) => t.subscribe(event, cb),
    onPush: (cb) => t.onPush(cb),
    unserved: () => t.unserved(),
    inFlight: () => inFlight,
    lastActivity: () => last,
    onWrite(cb) {
      writers.add(cb)
      return () => void writers.delete(cb)
    }
  }
}
