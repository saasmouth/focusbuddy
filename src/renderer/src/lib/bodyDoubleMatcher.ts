// Matching + signaling abstraction for the body double feature.
//
// Production is RemoteMatcher: a WebSocket to the hosted matching service
// (projects/focusbuddy-signal). When two signed-in members pair, the service
// mints a private PlexiiMeet room for them and both sides learn its id in the
// match, so the strangers can see each other while they work.
//
// LocalMockMatcher is a development-only stand-in (VITE_USE_REMOTE_SIGNAL=false):
// two PlexiDesk windows on the same machine find each other over IPC or a
// BroadcastChannel and exchange chat. It has no server, so it never carries a
// meeting room — the session is text-only, and the UI says so.
//
// The Matcher interface is what the store consumes, so it does not care which
// one is wired up.

import type {
  BodyDoubleChatMessage,
  BodyDoubleError,
  BodyDoubleErrorCode,
  BodyDoubleMeeting,
  BodyDoubleMode,
  BodyDoublePartner,
  BodyDoubleRequest
} from '@shared/types'

export interface MatcherEvents {
  // Fired when a partner is found and the session is provisionally matched.
  // The store transitions from `looking` to `matched` on this event. `meeting`
  // is the private PlexiiMeet room for the pair, or null for a text-only one.
  onPartnerMatched: (partner: BodyDoublePartner, meeting: BodyDoubleMeeting | null) => void
  // Fired when the partner sends a chat message.
  onChatMessage: (msg: BodyDoubleChatMessage) => void
  // Fired when the partner ends the session (End, Skip, block, or their
  // connection dropped — the server reports all of them the same way).
  onPartnerLeft: () => void
  // Fired when the service refuses the request (sign-in, plan, validation).
  // The matcher has stopped looking; the store returns to idle and says why.
  onError: (error: BodyDoubleError) => void
  // Fired when OUR connection to the service drops unexpectedly. Distinct from
  // onPartnerLeft: the partner did nothing, so the UI must not say they left.
  onConnectionLost: () => void
}

export interface Matcher {
  // Place a request on the queue. Resolves once the request is in flight;
  // the actual match (which might never come) is delivered via events.
  startLooking: (req: BodyDoubleRequest, events: MatcherEvents) => Promise<void>
  // Cancel an in-flight request and remove ourselves from the queue. Called
  // when the user clicks "Cancel" during the looking state.
  stopLooking: () => Promise<void>
  // Send a chat message to the matched partner. No-op when not in a session.
  sendChat: (text: string) => void
  // Politely end the active session — notifies the partner.
  endSession: () => Promise<void>
  // End the active session AND never be matched with this partner again. The
  // partner is told only that the session ended.
  block: () => Promise<void>
}

// ─── Local mock matcher (BroadcastChannel-based) ────────────────────────────
// Two PlexiDesk windows on the same machine can talk over a shared
// BroadcastChannel. Production will replace this with a WebSocket-based
// matcher hitting our hosted signaling service.

interface PoolEntry {
  fromHandle: string
  mode: BodyDoubleMode
  workingOn: string | null
  // Random per-session id so the matcher can target one specific window
  // when two are queuing at once.
  sessionId: string
  ts: number
}

interface BroadcastMessage {
  // 'announce': a window is in the matching pool.
  // 'match-offer': someone is offering a match to a specific sessionId.
  // 'match-accept': the recipient of an offer accepts; both transition to matched.
  // 'leave-pool': the window withdrew its request.
  // 'chat': in-session text message.
  // 'end': the partner is ending the session.
  type: 'announce' | 'match-offer' | 'match-accept' | 'leave-pool' | 'chat' | 'end'
  payload: unknown
}

const CHANNEL = 'fb-body-double-mock'

// Transport abstraction for the local-mock matcher. BroadcastChannel
// works fine between two browser tabs in the SAME renderer process; it
// does NOT cross Electron window boundaries. The IPC-bus transport
// (below) routes through main so two PlexiDesk windows on the same
// machine can pair — which is the common dev case.
export interface MatcherTransport {
  broadcast: (msg: BroadcastMessage) => void
  onMessage: (cb: (msg: BroadcastMessage) => void) => void
  close: () => void
}

class BroadcastChannelTransport implements MatcherTransport {
  private channel: BroadcastChannel
  constructor() {
    this.channel = new BroadcastChannel(CHANNEL)
  }
  broadcast(msg: BroadcastMessage): void {
    this.channel.postMessage(msg)
  }
  onMessage(cb: (msg: BroadcastMessage) => void): void {
    this.channel.onmessage = (e: MessageEvent) => cb(e.data as BroadcastMessage)
  }
  close(): void {
    this.channel.close()
  }
}

// IPC-bus transport — sends every outgoing message to main, which
// re-broadcasts to every other renderer window. Preload exposes the
// `bodyDoubleBus` channel; main handles `fb:body-double-bus`.
class IpcBusTransport implements MatcherTransport {
  private unsubscribe: (() => void) | null = null
  private api: {
    send: (payload: unknown) => void
    onMessage: (cb: (payload: unknown) => void) => () => void
  }
  constructor() {
    // window.api.bodyDoubleBus is added in preload; we'd be checking
    // .bodyDoubleBus on a non-existent object on a pre-update window.
    const api = (
      window as unknown as {
        api: {
          bodyDoubleBus: {
            send: (payload: unknown) => void
            onMessage: (cb: (payload: unknown) => void) => () => void
          }
        }
      }
    ).api.bodyDoubleBus
    this.api = api
  }
  broadcast(msg: BroadcastMessage): void {
    this.api.send(msg)
  }
  onMessage(cb: (msg: BroadcastMessage) => void): void {
    this.unsubscribe = this.api.onMessage((payload) =>
      cb(payload as BroadcastMessage)
    )
  }
  close(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}

// Factory — picks IPC when available (Electron), falls back to
// BroadcastChannel for plain browser contexts (vitest, web preview).
export function createLocalTransport(): MatcherTransport {
  if (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { api?: { bodyDoubleBus?: unknown } }).api
      ?.bodyDoubleBus !== 'undefined'
  ) {
    return new IpcBusTransport()
  }
  return new BroadcastChannelTransport()
}

export class LocalMockMatcher implements Matcher {
  private transport: MatcherTransport | null = null
  // Factory injected at construction so tests can supply a stub. Defaults
  // to the IPC-or-BroadcastChannel auto-picker so the common path "just
  // works" in both dev and unit tests.
  private transportFactory: () => MatcherTransport
  // Legacy `channel` field removed — every transport-touching site now
  // routes through this.transport. Kept the class name LocalMockMatcher
  // so the rest of the renderer (store, dialog) doesn't churn.
  private mySessionId: string
  private myHandle: string | null = null
  private partnerSessionId: string | null = null
  private events: MatcherEvents | null = null
  private pool = new Map<string, PoolEntry>()
  private myRequest: BodyDoubleRequest | null = null
  private myEntry: PoolEntry | null = null
  private rescanTimer: ReturnType<typeof setTimeout> | null = null

  constructor(transportFactory: () => MatcherTransport = createLocalTransport) {
    this.transportFactory = transportFactory
    this.mySessionId =
      Math.random().toString(36).slice(2, 9) +
      Math.random().toString(36).slice(2, 9)
  }

  async startLooking(
    req: BodyDoubleRequest,
    events: MatcherEvents
  ): Promise<void> {
    this.myRequest = req
    this.myHandle = req.handle
    this.events = events
    this.transport = this.transportFactory()
    this.transport.onMessage((msg) => this.onMessage(msg))
    this.myEntry = {
      fromHandle: req.handle,
      mode: req.mode,
      workingOn: req.workingOn ?? null,
      sessionId: this.mySessionId,
      ts: Date.now()
    }
    // Announce ourselves so any existing peers can find us.
    this.broadcast({ type: 'announce', payload: this.myEntry })
    // Tick periodically to try matching — covers the race where a window
    // arrived before us and is still waiting.
    this.scheduleRescan()
  }

  async stopLooking(): Promise<void> {
    if (this.transport) {
      this.broadcast({ type: 'leave-pool', payload: { sessionId: this.mySessionId } })
    }
    this.clear()
  }

  sendChat(text: string): void {
    if (!this.transport || !this.partnerSessionId || !this.myHandle) return
    this.broadcast({
      type: 'chat',
      payload: {
        toSessionId: this.partnerSessionId,
        fromSessionId: this.mySessionId,
        fromHandle: this.myHandle,
        text,
        id: Math.random().toString(36).slice(2, 10),
        ts: Date.now()
      }
    })
  }

  async endSession(): Promise<void> {
    if (this.transport && this.partnerSessionId) {
      this.broadcast({
        type: 'end',
        payload: {
          toSessionId: this.partnerSessionId,
          fromSessionId: this.mySessionId
        }
      })
    }
    this.clear()
  }

  // The mock has no accounts to block; ending is all it can honestly do.
  async block(): Promise<void> {
    await this.endSession()
  }

  private onMessage(msg: BroadcastMessage): void {
    if (!this.events) return
    switch (msg.type) {
      case 'announce': {
        const entry = msg.payload as PoolEntry
        if (entry.sessionId === this.mySessionId) return
        this.pool.set(entry.sessionId, entry)
        this.tryMatch()
        break
      }
      case 'match-offer': {
        const offer = msg.payload as {
          toSessionId: string
          fromSessionId: string
          fromHandle: string
          fromMode: BodyDoubleMode
          fromWorkingOn: string | null
        }
        if (offer.toSessionId !== this.mySessionId) return
        if (this.partnerSessionId) return // already matched
        // Accept the first offer that meets our mode compatibility.
        if (!this.myRequest) return
        if (!modesCompatible(this.myRequest.mode, offer.fromMode)) return
        this.partnerSessionId = offer.fromSessionId
        this.broadcast({
          type: 'match-accept',
          payload: {
            toSessionId: offer.fromSessionId,
            fromSessionId: this.mySessionId,
            fromHandle: this.myRequest.handle,
            fromWorkingOn: this.myRequest.workingOn ?? null
          }
        })
        this.events.onPartnerMatched(
          {
            handle: offer.fromHandle,
            workingOn: offer.fromWorkingOn,
            joinedAt: Date.now()
          },
          null
        )
        break
      }
      case 'match-accept': {
        const accept = msg.payload as {
          toSessionId: string
          fromSessionId: string
          fromHandle: string
          fromWorkingOn: string | null
        }
        if (accept.toSessionId !== this.mySessionId) return
        if (this.partnerSessionId) return
        this.partnerSessionId = accept.fromSessionId
        this.events.onPartnerMatched(
          {
            handle: accept.fromHandle,
            workingOn: accept.fromWorkingOn,
            joinedAt: Date.now()
          },
          null
        )
        break
      }
      case 'leave-pool': {
        const { sessionId } = msg.payload as { sessionId: string }
        this.pool.delete(sessionId)
        if (sessionId === this.partnerSessionId) {
          this.events.onPartnerLeft()
          this.clear()
        }
        break
      }
      case 'chat': {
        const m = msg.payload as {
          toSessionId: string
          fromSessionId: string
          fromHandle: string
          text: string
          id: string
          ts: number
        }
        if (m.toSessionId !== this.mySessionId) return
        if (m.fromSessionId !== this.partnerSessionId) return
        this.events.onChatMessage({
          id: m.id,
          senderHandle: m.fromHandle,
          text: m.text,
          ts: m.ts
        })
        break
      }
      case 'end': {
        const m = msg.payload as { toSessionId: string; fromSessionId: string }
        if (m.toSessionId !== this.mySessionId) return
        if (m.fromSessionId !== this.partnerSessionId) return
        this.events.onPartnerLeft()
        this.clear()
        break
      }
    }
  }

  private tryMatch(): void {
    if (this.partnerSessionId) return
    if (!this.myRequest || !this.myEntry) return
    // Find the oldest compatible peer in the pool.
    let oldest: PoolEntry | null = null
    for (const entry of this.pool.values()) {
      if (entry.sessionId === this.mySessionId) continue
      if (!modesCompatible(this.myRequest.mode, entry.mode)) continue
      if (!oldest || entry.ts < oldest.ts) oldest = entry
    }
    if (!oldest) return
    // Send an offer; they'll accept if they're still in their looking state.
    this.broadcast({
      type: 'match-offer',
      payload: {
        toSessionId: oldest.sessionId,
        fromSessionId: this.mySessionId,
        fromHandle: this.myRequest.handle,
        fromMode: this.myRequest.mode,
        fromWorkingOn: this.myRequest.workingOn ?? null
      }
    })
  }

  private scheduleRescan(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    // Re-announce every 1.5s so peers that opened after us still see us.
    this.rescanTimer = setTimeout(() => {
      if (!this.transport || this.partnerSessionId) return
      if (this.myEntry) {
        this.broadcast({ type: 'announce', payload: this.myEntry })
      }
      this.scheduleRescan()
    }, 1500)
  }

  private broadcast(msg: BroadcastMessage): void {
    this.transport?.broadcast(msg)
  }

  private clear(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.rescanTimer = null
    this.transport?.close()
    this.transport = null
    this.pool.clear()
    this.partnerSessionId = null
    this.myEntry = null
    this.myRequest = null
    this.events = null
  }
}

// Mode compatibility: paired users must be on the same wavelength. We
// accept exact-match for simplicity in v1. A future enhancement could let
// the silent-preference user opt into "willing to upgrade to greetings if
// the partner wants" — but for now, mismatched modes are a no-match.
function modesCompatible(a: BodyDoubleMode, b: BodyDoubleMode): boolean {
  return a === b
}

// ─── Remote matcher (WebSocket to focusbuddy-signal) ────────────────────────
//
// Connects to the hosted matching service. Wraps the wire protocol from
// projects/focusbuddy-signal/src/protocol.ts into the local Matcher
// interface — the store, the dialog, and every UI consumer stays the same.
//
// The protocol types are intentionally NOT imported across the project
// boundary (the server is a sibling project with its own tsconfig). We
// re-declare the bare-minimum message shapes inline so the renderer can
// build without a cross-project type dependency.
//
// One socket per request. It opens on startLooking and closes when the
// request ends for any reason (cancel, end, block, the partner leaving, a
// refusal), so a stale socket can never deliver a match into a later session.

// Outbound message vocabulary — mirrors ClientToServer in
// projects/focusbuddy-signal/src/protocol.ts. Keep these in sync when the
// server protocol evolves.
type ClientToServer =
  | {
      type: 'announce'
      payload: { mode: BodyDoubleMode; workingOn: string | null; handle: string; token?: string }
    }
  | { type: 'cancel' }
  | { type: 'chat'; payload: { text: string } }
  | { type: 'end' }
  | { type: 'block' }
  | { type: 'ping' }

// Inbound message vocabulary — mirrors ServerToClient.
interface ServerMatchedMsg {
  type: 'matched'
  payload: {
    partner: { handle: string; workingOn: string | null; joinedAt: number }
    // Absent from servers that predate pair rooms; null for text-only pairs.
    meeting?: { roomId: string } | null
  }
}
interface ServerChatMsg {
  type: 'chat'
  payload: { id: string; senderHandle: string; text: string; ts: number }
}
interface ServerPartnerLeftMsg {
  type: 'partnerLeft'
}
interface ServerErrorMsg {
  type: 'error'
  payload: { message: string; code?: string }
}
interface ServerPongMsg {
  type: 'pong'
}
type ServerToClient =
  | ServerMatchedMsg
  | ServerChatMsg
  | ServerPartnerLeftMsg
  | ServerErrorMsg
  | ServerPongMsg

const SERVER_ERROR_CODES: readonly BodyDoubleErrorCode[] = ['bd_sign_in', 'bd_not_entitled', 'bd_bad_request']

export const UNREACHABLE_MESSAGE = 'Could not reach the matching service. Check your connection and try again.'

// Heartbeat cadence — proxies that drop idle WebSockets (Fly, CloudFront)
// must never see this socket go quiet mid-session.
const PING_INTERVAL_MS = 25_000

export type SocketFactory = (url: string) => WebSocket

export class RemoteMatcher implements Matcher {
  private url: string
  private socketFactory: SocketFactory
  private socket: WebSocket | null = null
  private events: MatcherEvents | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null

  // The factory is injectable so tests can drive the protocol without a server.
  constructor(url: string, socketFactory: SocketFactory = (u) => new WebSocket(u)) {
    this.url = url
    this.socketFactory = socketFactory
  }

  // Resolves once the socket is open and the announce has gone out; rejects
  // when the service cannot be reached at all. Everything after that (the
  // match, a refusal, a drop) arrives through `events`.
  async startLooking(req: BodyDoubleRequest, events: MatcherEvents): Promise<void> {
    // A previous request's socket (if any) is finished; never reuse it.
    this.close()
    this.events = events
    const sock = this.socketFactory(this.url)
    this.socket = sock
    return new Promise((resolve, reject) => {
      let opened = false
      sock.addEventListener('open', () => {
        if (this.socket !== sock) return
        opened = true
        this.send({
          type: 'announce',
          payload: {
            mode: req.mode,
            workingOn: req.workingOn ?? null,
            handle: req.handle,
            ...(req.token ? { token: req.token } : {})
          }
        })
        this.startHeartbeat()
        resolve()
      })
      sock.addEventListener('message', (e: MessageEvent) => {
        if (this.socket !== sock) return
        let msg: ServerToClient
        try {
          msg = JSON.parse(String(e.data)) as ServerToClient
        } catch {
          return // a malformed frame is not worth ending a session over
        }
        this.dispatch(msg)
      })
      sock.addEventListener('close', () => {
        // A socket we closed on purpose was detached first; this is a drop.
        if (this.socket !== sock) return
        const lost = this.events
        this.clear()
        if (!opened) {
          reject(new Error(UNREACHABLE_MESSAGE))
          return
        }
        lost?.onConnectionLost()
      })
    })
  }

  async stopLooking(): Promise<void> {
    this.send({ type: 'cancel' })
    this.close()
  }

  sendChat(text: string): void {
    this.send({ type: 'chat', payload: { text } })
  }

  async endSession(): Promise<void> {
    this.send({ type: 'end' })
    this.close()
  }

  async block(): Promise<void> {
    this.send({ type: 'block' })
    this.close()
  }

  private dispatch(msg: ServerToClient): void {
    const events = this.events
    if (!events) return
    switch (msg.type) {
      case 'matched': {
        const roomId = msg.payload.meeting?.roomId
        events.onPartnerMatched(
          {
            handle: msg.payload.partner.handle,
            workingOn: msg.payload.partner.workingOn,
            joinedAt: msg.payload.partner.joinedAt
          },
          typeof roomId === 'string' && roomId ? { roomId } : null
        )
        break
      }
      case 'chat':
        events.onChatMessage({
          id: msg.payload.id,
          senderHandle: msg.payload.senderHandle,
          text: msg.payload.text,
          ts: msg.payload.ts
        })
        break
      case 'partnerLeft':
        // The request is over; the next one opens a fresh socket.
        this.close()
        events.onPartnerLeft()
        break
      case 'error': {
        const code = msg.payload.code as BodyDoubleErrorCode | undefined
        if (code && SERVER_ERROR_CODES.includes(code)) {
          this.close()
          events.onError({ code, message: msg.payload.message })
        } else {
          // Uncoded errors answer malformed frames this client never sends.
          // eslint-disable-next-line no-console
          console.warn('[RemoteMatcher] server error:', msg.payload.message)
        }
        break
      }
      case 'pong':
        break
    }
  }

  private send(msg: ClientToServer): void {
    const sock = this.socket
    if (!sock || sock.readyState !== WebSocket.OPEN) return
    try {
      sock.send(JSON.stringify(msg))
    } catch {
      // ignore — the close handler surfaces the underlying problem
    }
  }

  private startHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL_MS)
  }

  // Detach first, then close: the close event of a socket we let go of on
  // purpose must not read as a lost connection.
  private close(): void {
    const sock = this.socket
    this.clear()
    try {
      sock?.close()
    } catch {
      // ignore
    }
  }

  private clear(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    this.socket = null
    this.events = null
  }
}
