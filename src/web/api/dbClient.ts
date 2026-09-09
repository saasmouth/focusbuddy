// One database, many tabs.
//
// OPFS sync access handles are exclusive: the tab that opens the workspace
// holds it, and a second tab asking for the same file is refused outright --
// "Access Handles cannot be created if there is another open Access Handle".
// So a browser Plexii that does nothing about this works perfectly until the
// moment someone opens it twice, which is a thing people do without thinking.
//
// The tidy-looking answer is a SharedWorker holding the single connection, and
// it does not work: createSyncAccessHandle is specified for dedicated workers
// only, and SharedWorkerGlobalScope genuinely does not have it (measured, not
// assumed). What is left is leader election. Exactly one tab holds a Web Lock,
// owns the Worker and therefore the database; every other tab sends its calls
// to that tab over a BroadcastChannel and gets answers back the same way. When
// the leader closes, its lock releases, another tab wins it and opens the
// database itself. Nothing is shared but messages.
//
// The one place this cannot be made invisible is a request that was already
// running when the leader disappeared. Its answer is lost, and re-sending it
// would be at-least-once delivery on top of writes -- a closed tab could turn
// one nodes:create into two desks. So a call that was merely queued (never
// dispatched, so never executed) is sent on to the new leader, and a call that
// was genuinely in flight is failed with a message that says what happened.
// Losing a call is recoverable; silently duplicating a write is not.
const LOCK_NAME = 'plexii.db.leader'
const CHANNEL_NAME = 'plexii.db'

type Listener = (...args: unknown[]) => void

interface Waiter {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  channel: string
  args: unknown[]
  /** False until it has actually been handed to a leader. */
  dispatched: boolean
}

const tabId = globalThis.crypto.randomUUID()
const waiters = new Map<number, Waiter>()
const listeners = new Map<string, Set<Listener>>()
const unserved = new Map<string, number>()

let bc: BroadcastChannel | null = null
let worker: Worker | null = null
let isLeader = false
let seq = 1
// Positive evidence that some tab is serving the database. Until a follower has
// this, its calls wait rather than being broadcast into an empty channel --
// BroadcastChannel does not queue, so a message sent with no leader listening
// is simply lost, and a lost call that is marked "sent" would later be failed
// as if it had run.
let leaderSeen = false

// Leader-side only: which tab and request each Worker call belongs to.
let workerSeq = 1
const routing = new Map<number, { tab: string; id: number }>()

/**
 * Channels the renderer called and was refused, with counts. The parity gap as
 * measured from real use rather than estimated.
 */
export function unservedChannels(): Array<{ channel: string; calls: number }> {
  return [...unserved.entries()]
    .map(([channel, calls]) => ({ channel, calls }))
    .sort((a, b) => b.calls - a.calls)
}

/** Diagnostics: whether this tab owns the database. */
export function isDatabaseLeader(): boolean {
  return isLeader
}

function settle(id: number, ok: boolean, value: unknown, error: string | undefined, channel: string, wasUnserved: boolean): void {
  const waiter = waiters.get(id)
  if (!waiter) return
  waiters.delete(id)
  if (ok) waiter.resolve(value)
  else {
    if (wasUnserved) unserved.set(channel, (unserved.get(channel) ?? 0) + 1)
    waiter.reject(new Error(error ?? 'workspace call failed'))
  }
}

function deliverPush(event: string, args: unknown[]): void {
  for (const cb of listeners.get(event) ?? []) cb(...args)
}

function startWorker(): Worker {
  const w = new Worker(new URL('../worker/index.ts', import.meta.url), { type: 'module' })
  w.onmessage = (ev: MessageEvent): void => {
    const { id, ok, value, error, channel, unserved: wasUnserved, event, args } = ev.data ?? {}
    if (event) {
      // A push from the data layer (a row-change fan-out, say). Every tab needs
      // it, including this one.
      deliverPush(event, (args as unknown[]) ?? [])
      bc?.postMessage({ kind: 'push', event, args })
      return
    }
    const route = routing.get(id)
    if (!route) return
    routing.delete(id)
    if (route.tab === tabId) settle(route.id, ok, value, error, channel, !!wasUnserved)
    else bc?.postMessage({ kind: 'res', tab: route.tab, id: route.id, ok, value, error, channel, unserved: wasUnserved })
  }
  return w
}

function dispatchAsLeader(tab: string, id: number, channel: string, args: unknown[]): void {
  const wid = workerSeq++
  routing.set(wid, { tab, id })
  worker!.postMessage({ id: wid, channel, args })
}

function becomeLeader(): void {
  isLeader = true
  leaderSeen = true
  worker = startWorker()
  // Tell the other tabs there is somewhere to send calls again.
  bc?.postMessage({ kind: 'leader' })
  flushQueued()
}

/**
 * Send on anything that never reached a leader. Safe by construction: an
 * undispatched call has not run anywhere, so there is nothing to duplicate.
 */
function flushQueued(): void {
  for (const [id, waiter] of waiters) {
    if (waiter.dispatched) continue
    waiter.dispatched = true
    if (isLeader) dispatchAsLeader(tabId, id, waiter.channel, waiter.args)
    else bc?.postMessage({ kind: 'req', tab: tabId, id, channel: waiter.channel, args: waiter.args })
  }
}

/**
 * Fail anything that was mid-flight when the leader changed. Its result is
 * unknowable from here -- the write may have committed just before the tab
 * closed -- so this reports the loss rather than repeating the call.
 */
function failInflight(): void {
  for (const [id, waiter] of [...waiters]) {
    if (!waiter.dispatched) continue
    waiters.delete(id)
    waiter.reject(
      new Error(
        `${waiter.channel}: the tab holding your workspace closed while this was running. ` +
          'Nothing was lost -- try again.'
      )
    )
  }
}

function onBroadcast(ev: MessageEvent): void {
  const msg = ev.data ?? {}
  switch (msg.kind) {
    case 'req':
      // Only the leader has a database to ask.
      if (isLeader) dispatchAsLeader(msg.tab, msg.id, msg.channel, msg.args ?? [])
      return
    case 'who':
      // A tab is asking whether anyone is serving. Only the leader answers.
      if (isLeader) bc?.postMessage({ kind: 'leader' })
      return
    case 'res':
      leaderSeen = true
      if (msg.tab === tabId) settle(msg.id, msg.ok, msg.value, msg.error, msg.channel, !!msg.unserved)
      return
    case 'leader':
      // A new leader exists. Anything still waiting on the old one is gone;
      // anything never sent can go now.
      leaderSeen = true
      if (!isLeader) {
        failInflight()
        flushQueued()
      }
      return
    case 'push':
      if (!isLeader) deliverPush(msg.event, msg.args ?? [])
      return
    default:
      return
  }
}

/**
 * Begin coordinating. Called once, before the renderer's first api call.
 *
 * The lock is held by never resolving inside the callback, which is the
 * standard leader-election idiom: the browser releases it when the tab goes,
 * and the next waiter's callback runs.
 */
export function startCoordinator(): void {
  if (bc) return
  bc = new BroadcastChannel(CHANNEL_NAME)
  bc.onmessage = onBroadcast
  // If a leader is already running in another tab, this asks it to say so; the
  // lock request below would otherwise leave this tab waiting behind a lock it
  // will not get until that tab closes.
  bc.postMessage({ kind: 'who' })

  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    // No Web Locks: behave exactly as a single tab, which is what this browser
    // can safely support. A second tab will fail to open the database and say
    // so, rather than quietly corrupting anything.
    becomeLeader()
    return
  }

  void navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, () => {
    becomeLeader()
    // Held for the life of the tab.
    return new Promise<never>(() => {})
  })
}

/** Make a call against the workspace database, wherever it happens to live. */
export function dbCall(channel: string, args: unknown[]): Promise<unknown> {
  const id = seq++
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { resolve, reject, channel, args, dispatched: false }
    waiters.set(id, waiter)
    // Before a leader exists, calls queue rather than fail: the gap is the
    // moment between page load and the lock being granted, which is short and
    // entirely normal.
    if (isLeader) {
      waiter.dispatched = true
      dispatchAsLeader(tabId, id, channel, args)
    } else if (bc && leaderSeen) {
      waiter.dispatched = true
      bc.postMessage({ kind: 'req', tab: tabId, id, channel, args })
    }
  })
}

/** Subscribe to a pushed channel (the equivalent of webContents.send). */
export function dbSubscribe(event: string, cb: Listener): () => void {
  let set = listeners.get(event)
  if (!set) listeners.set(event, (set = new Set()))
  set.add(cb)
  return () => { set?.delete(cb) }
}
