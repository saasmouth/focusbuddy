// The window takes what main kept for it, without a gap (4.3.56).
//
// Main keeps each link it is handed (a sign-in, a share, a meeting, an external
// markdown file, a notice about a refused link) until a window takes it, and
// sends a message only to nudge the window (main/authProtocol.ts). The window
// must LISTEN FIRST and take after: taking first and subscribing after left a
// gap (an await; for a share or meeting link, a whole accept or join) in which a
// new link's nudge reached nobody. The shape 1a found in PlexiiLite (1dcc8dc).
//
// Every nudge takes again, so the message's own payload is never used: what is
// taken is what main kept, each item once, in the order it came. Taking is one
// at a time; handling is not waited for, as before (a sign-in check or a share
// accept can take a while, and an alert stays up until OK, where a second
// notice of the same kind is dropped by its handler, not queued behind it).

function start<T>(handle: (item: T) => unknown, item: T): void {
  try {
    void Promise.resolve(handle(item)).catch(() => undefined)
  } catch {
    /* one item failing does not stop the next */
  }
}

type Listen = (nudge: () => void) => () => void

function runner(listen: Listen, drainOnce: (stopped: () => boolean) => Promise<void>): () => void {
  let stopped = false
  let chain: Promise<void> = Promise.resolve()
  const drain = (): void => {
    chain = chain.then(() => drainOnce(() => stopped)).catch(() => undefined)
  }
  const unlisten = listen(() => drain())
  drain()
  return () => {
    stopped = true
    unlisten()
  }
}

/** Listen for nudges, then take items one at a time until none waits; again on every nudge. */
export function listenThenTake<T, P>(
  listen: (cb: (payload: P) => void) => () => void,
  takeOne: () => Promise<T | null>,
  handle: (item: T) => unknown
): () => void {
  return runner((nudge) => listen(() => nudge()), async (stopped) => {
    while (!stopped()) {
      const item = await takeOne().catch(() => null)
      if (item === null || item === undefined) return
      start(handle, item)
    }
  })
}

/** As listenThenTake, for a source that hands over everything waiting at once. */
export function listenThenTakeAll<T, P>(
  listen: (cb: (payload: P) => void) => () => void,
  takeAll: () => Promise<T[]>,
  handle: (item: T) => unknown
): () => void {
  return runner((nudge) => listen(() => nudge()), async (stopped) => {
    if (stopped()) return
    const items = await takeAll().catch(() => [] as T[])
    for (const item of items) start(handle, item)
  })
}
