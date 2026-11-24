// Streamable HTTP transport for remote MCP servers (spec revision 2025-06-18,
// also accepting servers that answer 2025-03-26).
//
// One POST per JSON-RPC message. The server answers a request either with one
// JSON body or with an SSE stream that may carry its own requests and
// notifications before the response. Notifications and our replies get 202.
//
// Why hand-written: Plexii's MCP server is hand-written too (src/main/mcpProtocol.ts),
// every request here must go through guardedFetch, and the surface a client
// needs is small enough to read in one sitting.
//
// What this layer does NOT do: decide about auth. It attaches a bearer token
// it is given (after checking the token belongs to this endpoint) and reports
// 401/403 as typed errors; client.ts decides whether to refresh, sign in or ask.

import { ConsentRequired, McpError, fromNetworkError, parseRetryAfter } from './errors'
import { parseWwwAuthenticate } from './challenge'
import { EgressPolicy, sameResource } from './egress'
import { SseParser } from './sse'

export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26']
export const PREFERRED_PROTOCOL_VERSION = '2025-06-18'

// A response bigger than this is refused rather than buffered: a server must
// not be able to exhaust the main process's memory.
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export type JsonRpcId = string | number

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: JsonRpcId | null
  method?: string
  params?: unknown
  result?: unknown
  error?: JsonRpcError
}

// A token together with the exact resource it was issued for.
export interface BoundToken {
  token: string
  resource: string
}

export interface PostOptions {
  // The id of the response to wait for. Omitted for notifications and for our
  // replies to server requests, which expect 202 and no body.
  expectId?: JsonRpcId
  timeoutMs: number
  signal?: AbortSignal
  bearer?: BoundToken | null
  // Server requests and notifications that arrive while we wait.
  onServerMessage?: (msg: JsonRpcMessage) => Promise<void>
}

// The last line of defence for credentials: a token only ever goes to the
// resource it was issued for, whatever the caller thought it was doing.
export function assertTokenFor(bearer: BoundToken, url: string): void {
  if (!sameResource(bearer.resource, url)) {
    throw new McpError('refused', 'Plexii won’t send this connection’s sign-in to a different address. Reconnect to authorise this one.', {
      reason: 'token_resource_mismatch'
    })
  }
}

export async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      total += r.value.byteLength
      if (total > maxBytes) {
        throw new McpError('protocol_error', 'The server sent more than Plexii will read.', { reason: 'response_too_large' })
      }
      text += decoder.decode(r.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.cancel().catch(() => {})
  }
}

function discard(res: Response): void {
  res.body?.cancel().catch(() => {})
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new McpError('protocol_error', 'The server sent something that isn’t JSON.', { reason: 'invalid_json' })
  }
}

type MessageKind = 'response' | 'request' | 'notification' | 'invalid'

function kindOf(m: unknown): MessageKind {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'invalid'
  const o = m as Record<string, unknown>
  if (o.jsonrpc !== '2.0') return 'invalid'
  if (typeof o.method === 'string') return o.id === undefined || o.id === null ? 'notification' : 'request'
  if ('result' in o || 'error' in o) return 'response'
  return 'invalid'
}

// Session ids are visible ASCII (spec 2025-06-18); anything else could smuggle
// a header line, so it is refused rather than echoed.
const SESSION_ID = /^[\x21-\x7e]{1,512}$/

export class StreamableHttpTransport {
  sessionId: string | null = null
  // Sent on every request after initialisation (MCP-Protocol-Version header).
  protocolVersion: string | null = null

  constructor(
    private readonly policy: EgressPolicy,
    private readonly maxBytes = MAX_RESPONSE_BYTES
  ) {}

  get endpoint(): string {
    return this.policy.endpoint
  }

  reset(): void {
    this.sessionId = null
    this.protocolVersion = null
  }

  private headers(bearer: BoundToken | null | undefined): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json'
    }
    if (this.protocolVersion) h['MCP-Protocol-Version'] = this.protocolVersion
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId
    if (bearer) {
      assertTokenFor(bearer, this.policy.endpoint)
      h.Authorization = `Bearer ${bearer.token}`
    }
    return h
  }

  async post(message: JsonRpcMessage, o: PostOptions): Promise<JsonRpcMessage | null> {
    const host = new URL(this.policy.endpoint).host
    const sentSession = this.sessionId
    let res: Response
    try {
      res = await this.policy.fetch(
        this.policy.endpoint,
        { method: 'POST', headers: this.headers(o.bearer), body: JSON.stringify(message), signal: o.signal },
        this.policy.origin,
        o.timeoutMs
      )
    } catch (e) {
      throw fromNetworkError(e, host, o.signal)
    }

    if (message.method === 'initialize') {
      const sid = res.headers.get('mcp-session-id')
      if (sid !== null) {
        if (!SESSION_ID.test(sid)) {
          discard(res)
          throw new McpError('protocol_error', 'The server sent an invalid session id.', { reason: 'invalid_session_id' })
        }
        this.sessionId = sid
      }
    }

    if (res.status >= 300) {
      discard(res)
      throw this.httpError(res, sentSession)
    }
    if (o.expectId === undefined) {
      discard(res)
      return null
    }
    if (res.status === 202 || res.status === 204) {
      throw new McpError('protocol_error', 'The server accepted the request but sent no answer.', { reason: 'no_response', uncertain: true })
    }

    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    try {
      if (type === 'text/event-stream') return await this.readStream(res, o)
      if (type === 'application/json') {
        const found = await this.dispatch(parseJson(await readCappedText(res, this.maxBytes)), o)
        if (!found) throw new McpError('protocol_error', 'The server’s answer was for a different request.', { reason: 'no_response', uncertain: true })
        return found
      }
    } catch (e) {
      throw fromNetworkError(e, host, o.signal)
    }
    discard(res)
    throw new McpError('protocol_error', 'The server answered in a format MCP doesn’t use.', { reason: 'unexpected_content_type' })
  }

  // End the session (spec: clients SHOULD send DELETE). Best effort: a server
  // may answer 405 when it doesn't let clients end sessions.
  async deleteSession(bearer: BoundToken | null): Promise<void> {
    if (!this.sessionId) return
    try {
      const res = await this.policy.fetch(this.policy.endpoint, { method: 'DELETE', headers: this.headers(bearer) }, this.policy.origin, 10_000)
      discard(res)
    } catch {
      // Nothing to repair: the session simply lapses on the server.
    } finally {
      this.reset()
    }
  }

  private httpError(res: Response, sentSession: string | null): McpError {
    const status = res.status
    const challenge = parseWwwAuthenticate(res.headers.get('www-authenticate'))
    if (status === 401) {
      return new McpError('reconnect_required', 'This server needs you to sign in.', { reason: 'unauthorized', status, challenge })
    }
    if (status === 403) {
      if (challenge?.error === 'insufficient_scope') return new ConsentRequired(challenge.scope, { status, challenge })
      return new McpError('denied', 'The server refused this request.', { reason: 'forbidden', status, challenge })
    }
    if (status === 404 && sentSession) {
      return new McpError('protocol_error', 'The server ended this session.', { reason: 'session_expired', status })
    }
    if (status === 404) return new McpError('protocol_error', 'No MCP server answers at this address.', { reason: 'not_found', status })
    if (status === 408 || status === 429 || status >= 500) {
      return new McpError('unavailable', status === 429 ? 'The server is rate limiting Plexii.' : `The server is having trouble (${status}).`, {
        reason: status === 429 ? 'rate_limited' : 'server_error',
        status,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        // A 5xx may come after a tool did part of its work.
        uncertain: status >= 500
      })
    }
    return new McpError('protocol_error', `The server answered ${status}.`, { reason: 'http_status', status })
  }

  private async readStream(res: Response, o: PostOptions): Promise<JsonRpcMessage> {
    if (!res.body) throw new McpError('protocol_error', 'The server opened an empty stream.', { reason: 'no_response', uncertain: true })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    let total = 0
    try {
      for (;;) {
        const r = await reader.read()
        let events
        if (r.done) {
          events = parser.push(decoder.decode()).concat(parser.end())
        } else {
          total += r.value.byteLength
          if (total > this.maxBytes) {
            throw new McpError('protocol_error', 'The server sent more than Plexii will read.', { reason: 'response_too_large', uncertain: true })
          }
          events = parser.push(decoder.decode(r.value, { stream: true }))
        }
        for (const ev of events) {
          // Only 'message' events carry JSON-RPC. An empty data field is a
          // priming / keep-alive event (newer servers send one first).
          if (ev.event !== 'message' || ev.data.trim() === '') continue
          const found = await this.dispatch(parseJson(ev.data), o)
          // Stop reading as soon as our answer is here; finally{} closes the stream.
          if (found) return found
        }
        if (r.done) break
      }
    } finally {
      reader.cancel().catch(() => {})
    }
    // The request may have run: the answer was lost, so the result is uncertain.
    throw new McpError('unavailable', 'The server closed the stream before answering.', { reason: 'stream_ended', uncertain: true })
  }

  private async dispatch(raw: unknown, o: PostOptions): Promise<JsonRpcMessage | null> {
    // 2025-03-26 allowed JSON-RPC batches, so a body may be an array.
    const list = Array.isArray(raw) ? raw : [raw]
    let found: JsonRpcMessage | null = null
    for (const m of list) {
      const kind = kindOf(m)
      if (kind === 'invalid') {
        throw new McpError('protocol_error', 'The server sent a message that isn’t JSON-RPC 2.0.', { reason: 'invalid_message' })
      }
      const msg = m as JsonRpcMessage
      if (kind === 'response') {
        if (o.expectId !== undefined && msg.id === o.expectId) found = msg
        continue
      }
      if (o.onServerMessage) await o.onServerMessage(msg)
    }
    return found
  }
}
