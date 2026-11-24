// The MCP client Plexii uses as a host for remote servers (SPEC-CONNECTIONS.md §4).
//
// Lifecycle: initialize (pinned protocol version, NO client capabilities) →
// notifications/initialized → list only what the server advertises → call.
//
// Auth, in one place (`send`):
//  - a stored token goes only to the resource it was issued for;
//  - expired → one refresh (single-flight per connection); 401 → refresh once;
//  - still 401, or never signed in → sign in through the browser ONLY when a
//    person is at the screen (`interactive`); a background run gets
//    reconnect_required instead, so it never pops a browser;
//  - 403 insufficient_scope → ConsentRequired, never a silent re-authorisation.
//
// Everything a server sends back is untrusted data: tool output is returned as
// text and content, capped, and nothing in it triggers any further request.

import { McpError, cleanServerText, isMcpError } from './errors'
import type { BearerChallenge } from './challenge'
import { EgressPolicy, type McpNetOptions } from './egress'
import { authorizeMcpServer, tokenManagerFor, type AuthBinding, type McpTokenManager, type McpTokenStore, type PendingAuthStore } from './oauth'
import {
  PREFERRED_PROTOCOL_VERSION,
  StreamableHttpTransport,
  SUPPORTED_PROTOCOL_VERSIONS,
  type BoundToken,
  type JsonRpcId,
  type JsonRpcMessage
} from './transport'
import type { McpTool } from './snapshot'
import type { JsonSchema } from '@shared/aispace/connections'

export const MAX_LIST_PAGES = 20
export const TOOL_TEXT_CAP = 60_000
const INSTRUCTIONS_CAP = 8_000
// A server may ask us things mid-stream; past this many in one answer it is
// flooding, and the request is abandoned rather than answered forever.
const MAX_SERVER_REQUESTS_PER_CALL = 16
const REFUSED_LOG_CAP = 200

// ── Public shapes ─────────────────────────────────────────────────────────────

export interface InteractiveAuth {
  binding: AuthBinding
  openExternal: (url: string) => void | Promise<void>
  clientId?: string | null
  timeoutMs?: number
  signal?: AbortSignal
  pending?: PendingAuthStore
}

export interface McpClientOptions {
  connectionId: string
  endpoint: string
  // Plexii's version, for clientInfo.
  clientVersion: string
  auth?: {
    tokenStore: McpTokenStore
    // Present only when a person is at the screen (setup or reconnect).
    interactive?: InteractiveAuth | null
  } | null
  // `localEndpoint: true` when the person typed a loopback address.
  net?: McpNetOptions
  requestTimeoutMs?: number
  onToolsListChanged?: () => void
  // Each server request Plexii refused (sampling, elicitation, roots, ...).
  onServerRequestRefused?: (r: RefusedServerRequest) => void
}

export interface CallOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface McpServerInfo {
  protocolVersion: string
  name: string
  version: string
  title: string | null
  capabilities: { tools: boolean; resources: boolean; prompts: boolean; toolsListChanged: boolean }
  // Untrusted server text: show it, never follow it.
  instructions: string | null
}

export interface McpListResult<T> {
  items: T[]
  // False when the server doesn't advertise this feature; nothing was asked.
  advertised: boolean
  // False when the page cap was hit or the server repeated a cursor.
  complete: boolean
  // Entries dropped because they didn't have the shape MCP requires.
  skipped: number
}

export interface McpResource {
  uri: string
  name: string
  title: string | null
  description: string | null
  mimeType: string | null
}

export interface McpPrompt {
  name: string
  title: string | null
  description: string | null
  arguments: Array<{ name: string; description: string | null; required: boolean }>
}

export type McpContentItem =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; mimeType: string; data: string }
  | { type: 'resource_link'; uri: string; name: string | null; mimeType: string | null; description: string | null }
  | { type: 'resource'; uri: string; mimeType: string | null; text: string | null; blob: string | null }
  | { type: 'unknown'; originalType: string }

// Tool output is evidence, not instructions (§4 Tool invocation).
export interface McpToolOutput {
  isError: boolean
  text: string
  truncated: boolean
  content: McpContentItem[]
  structuredContent?: Record<string, unknown>
}

export interface McpResourceOutput {
  text: string
  truncated: boolean
  contents: Array<{ uri: string; mimeType: string | null; text: string | null; blob: string | null }>
}

export interface RefusedServerRequest {
  method: string
  at: number
  // Whether our -32601 answer reached the server.
  delivered: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

// Cap text with an explicit note, never silently.
export function capToolText(s: string, max = TOOL_TEXT_CAP, source = 'the tool'): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false }
  let cut = max
  // Don't split a surrogate pair.
  const code = s.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return {
    text: `${s.slice(0, cut)}\n[Truncated by Plexii: ${source} returned ${s.length.toLocaleString('en')} characters; only the first ${cut.toLocaleString('en')} are kept.]`,
    truncated: true
  }
}

function contentItem(raw: unknown): McpContentItem {
  if (!isObject(raw)) return { type: 'unknown', originalType: 'invalid' }
  const type = str(raw.type)
  switch (type) {
    case 'text':
      return { type: 'text', text: capToolText(str(raw.text)).text }
    case 'image':
    case 'audio':
      return { type, mimeType: str(raw.mimeType), data: str(raw.data) }
    case 'resource_link':
      return {
        type: 'resource_link',
        uri: str(raw.uri),
        name: strOrNull(raw.name),
        mimeType: strOrNull(raw.mimeType),
        description: strOrNull(raw.description)
      }
    case 'resource': {
      const r = isObject(raw.resource) ? raw.resource : {}
      return {
        type: 'resource',
        uri: str(r.uri),
        mimeType: strOrNull(r.mimeType),
        text: typeof r.text === 'string' ? capToolText(r.text).text : null,
        blob: strOrNull(r.blob)
      }
    }
    default:
      return { type: 'unknown', originalType: cleanServerText(type, 40) || 'missing' }
  }
}

function renderItem(c: McpContentItem): string {
  switch (c.type) {
    case 'text':
      return c.text
    case 'image':
    case 'audio':
      return `[${c.type}${c.mimeType ? `: ${cleanServerText(c.mimeType, 60)}` : ''}]`
    case 'resource_link':
      return `[link: ${cleanServerText(c.name ?? c.uri, 200)}${c.name ? ` <${cleanServerText(c.uri, 500)}>` : ''}]`
    case 'resource':
      return c.text ?? `[file: ${cleanServerText(c.uri, 500)}]`
    default:
      return `[unsupported content: ${c.originalType}]`
  }
}

// Exported for tests and for callers holding a raw tools/call result.
export function toolOutputOf(r: Record<string, unknown>): McpToolOutput {
  const content = Array.isArray(r.content) ? r.content.map(contentItem) : []
  let joined = content
    .map(renderItem)
    .filter((s) => s !== '')
    .join('\n\n')
  // Servers SHOULD mirror structured output as text; when one didn't, show the JSON.
  if (!joined && isObject(r.structuredContent)) joined = JSON.stringify(r.structuredContent)
  const { text, truncated } = capToolText(joined)
  const out: McpToolOutput = { isError: r.isError === true, text, truncated, content }
  if (isObject(r.structuredContent)) out.structuredContent = r.structuredContent
  return out
}

function toolOf(raw: unknown): McpTool | null {
  if (!isObject(raw) || typeof raw.name !== 'string' || !raw.name || !isObject(raw.inputSchema)) return null
  const t: McpTool = { name: raw.name, inputSchema: raw.inputSchema as JsonSchema }
  if (typeof raw.title === 'string') t.title = raw.title
  if (typeof raw.description === 'string') t.description = raw.description
  if (isObject(raw.outputSchema)) t.outputSchema = raw.outputSchema as JsonSchema
  if (isObject(raw.annotations)) t.annotations = raw.annotations
  return t
}

function resourceOf(raw: unknown): McpResource | null {
  if (!isObject(raw) || typeof raw.uri !== 'string' || !raw.uri) return null
  return {
    uri: raw.uri,
    name: str(raw.name) || raw.uri,
    title: strOrNull(raw.title),
    description: strOrNull(raw.description),
    mimeType: strOrNull(raw.mimeType)
  }
}

function promptOf(raw: unknown): McpPrompt | null {
  if (!isObject(raw) || typeof raw.name !== 'string' || !raw.name) return null
  const args = Array.isArray(raw.arguments) ? raw.arguments.filter(isObject) : []
  return {
    name: raw.name,
    title: strOrNull(raw.title),
    description: strOrNull(raw.description),
    arguments: args
      .filter((a) => typeof a.name === 'string')
      .map((a) => ({ name: a.name as string, description: strOrNull(a.description), required: a.required === true }))
  }
}

function resultOf(method: string, res: JsonRpcMessage | null): Record<string, unknown> {
  if (!res) throw new McpError('protocol_error', `The server didn’t answer ${method}.`, { reason: 'no_response', uncertain: true })
  if (res.error !== undefined) {
    const err: Record<string, unknown> = isObject(res.error) ? res.error : {}
    throw new McpError('protocol_error', `The server returned an error for ${method}: ${cleanServerText(err.message) || 'no message'}`, {
      reason: 'rpc_error',
      rpcCode: typeof err.code === 'number' ? err.code : null
    })
  }
  if (!isObject(res.result)) throw new McpError('protocol_error', `The server’s answer to ${method} was malformed.`, { reason: 'invalid_result' })
  return res.result
}

// ── Client ────────────────────────────────────────────────────────────────────

type Capability = 'tools' | 'resources' | 'prompts'

export class McpClient {
  readonly connectionId: string
  readonly endpoint: string
  private readonly net: McpNetOptions
  private readonly transport: StreamableHttpTransport
  private readonly tokens: McpTokenManager | null
  private readonly interactive: InteractiveAuth | null
  private readonly timeoutMs: number
  private info: McpServerInfo | null = null
  private connecting: Promise<McpServerInfo> | null = null
  private nextId = 1
  private readonly refused: RefusedServerRequest[] = []

  constructor(private readonly o: McpClientOptions) {
    this.connectionId = o.connectionId
    this.net = o.net ?? {}
    // Validates the endpoint now (https, or a loopback address the person typed).
    const policy = new EgressPolicy(o.endpoint, this.net)
    this.endpoint = policy.endpoint
    this.transport = new StreamableHttpTransport(policy)
    this.tokens = o.auth ? tokenManagerFor(o.auth.tokenStore) : null
    this.interactive = o.auth?.interactive ?? null
    this.timeoutMs = o.requestTimeoutMs ?? 60_000
  }

  get serverInfo(): McpServerInfo | null {
    return this.info
  }

  // Requests the server made that Plexii refused (and never acted on).
  get refusedServerRequests(): readonly RefusedServerRequest[] {
    return this.refused.slice()
  }

  connect(): Promise<McpServerInfo> {
    if (this.info) return Promise.resolve(this.info)
    if (!this.connecting) {
      this.connecting = this.initialize().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  listTools(o?: CallOptions): Promise<McpListResult<McpTool>> {
    return this.listAll('tools/list', 'tools', 'tools', toolOf, o)
  }

  listResources(o?: CallOptions): Promise<McpListResult<McpResource>> {
    return this.listAll('resources/list', 'resources', 'resources', resourceOf, o)
  }

  listPrompts(o?: CallOptions): Promise<McpListResult<McpPrompt>> {
    return this.listAll('prompts/list', 'prompts', 'prompts', promptOf, o)
  }

  async callTool(name: string, args: Record<string, unknown> = {}, o: CallOptions = {}): Promise<McpToolOutput> {
    await this.requireCapability('tools')
    return toolOutputOf(await this.rpc('tools/call', { name, arguments: args }, o))
  }

  async readResource(uri: string, o: CallOptions = {}): Promise<McpResourceOutput> {
    await this.requireCapability('resources')
    const r = await this.rpc('resources/read', { uri }, o)
    const contents = (Array.isArray(r.contents) ? r.contents.filter(isObject) : []).map((c) => ({
      uri: str(c.uri),
      mimeType: strOrNull(c.mimeType),
      text: typeof c.text === 'string' ? capToolText(c.text, TOOL_TEXT_CAP, 'the resource').text : null,
      blob: strOrNull(c.blob)
    }))
    const joined = contents
      .map((c) => c.text ?? (c.blob !== null ? `[file: ${cleanServerText(c.uri, 500)}]` : ''))
      .filter((s) => s !== '')
      .join('\n\n')
    return { ...capToolText(joined, TOOL_TEXT_CAP, 'the resource'), contents }
  }

  // End the session politely (DELETE). Safe to call more than once.
  async close(): Promise<void> {
    const bearer = await this.currentBearer()
    await this.transport.deleteSession(bearer)
    this.info = null
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async requireCapability(cap: Capability): Promise<void> {
    const info = await this.connect()
    if (!info.capabilities[cap]) {
      throw new McpError('protocol_error', `This server doesn’t offer ${cap}.`, { reason: 'not_advertised' })
    }
  }

  private async initialize(): Promise<McpServerInfo> {
    this.transport.reset()
    const id = this.nextId++
    const res = await this.send(
      {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: PREFERRED_PROTOCOL_VERSION,
          // Deliberately empty: no sampling, no elicitation, no roots (§4)
          // until each has its own policy and review flow.
          capabilities: {},
          clientInfo: { name: 'Plexii', version: this.o.clientVersion }
        }
      },
      { expectId: id, timeoutMs: Math.min(this.timeoutMs, 30_000) }
    )
    const r = resultOf('initialize', res)
    const version = r.protocolVersion
    if (typeof version !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      await this.transport.deleteSession(await this.currentBearer())
      throw new McpError(
        'protocol_error',
        `This server speaks MCP ${cleanServerText(version, 40) || '(no version)'}; Plexii supports ${SUPPORTED_PROTOCOL_VERSIONS.join(' and ')}.`,
        { reason: 'unsupported_version' }
      )
    }
    this.transport.protocolVersion = version
    const caps: Record<string, unknown> = isObject(r.capabilities) ? r.capabilities : {}
    const server: Record<string, unknown> = isObject(r.serverInfo) ? r.serverInfo : {}
    const tools = isObject(caps.tools)
    const info: McpServerInfo = {
      protocolVersion: version,
      name: cleanServerText(server.name, 100) || 'Unnamed server',
      version: cleanServerText(server.version, 50),
      title: typeof server.title === 'string' ? cleanServerText(server.title, 100) : null,
      capabilities: {
        tools,
        resources: isObject(caps.resources),
        prompts: isObject(caps.prompts),
        toolsListChanged: tools && (caps.tools as Record<string, unknown>).listChanged === true
      },
      instructions: typeof r.instructions === 'string' ? capToolText(r.instructions, INSTRUCTIONS_CAP, 'the server').text : null
    }
    await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, { timeoutMs: 10_000 })
    this.info = info
    return info
  }

  private async listAll<T>(
    method: string,
    key: string,
    cap: Capability,
    map: (raw: unknown) => T | null,
    o: CallOptions = {}
  ): Promise<McpListResult<T>> {
    const info = await this.connect()
    // Only ask for what the server advertised (§4 Tool discovery).
    if (!info.capabilities[cap]) return { items: [], advertised: false, complete: true, skipped: 0 }
    const items: T[] = []
    let skipped = 0
    let cursor: string | null = null
    const seen = new Set<string>()
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const r = await this.rpc(method, cursor ? { cursor } : undefined, o)
      const list = r[key]
      if (!Array.isArray(list)) throw new McpError('protocol_error', `The server’s ${method} answer was malformed.`, { reason: 'invalid_result' })
      for (const raw of list) {
        const v = map(raw)
        if (v === null) skipped++
        else items.push(v)
      }
      const next = r.nextCursor
      if (typeof next !== 'string' || next === '') return { items, advertised: true, complete: true, skipped }
      // A repeated cursor would loop forever: stop and say the list is partial.
      if (seen.has(next)) return { items, advertised: true, complete: false, skipped }
      seen.add(next)
      cursor = next
    }
    return { items, advertised: true, complete: false, skipped }
  }

  private async rpc(method: string, params: Record<string, unknown> | undefined, o: CallOptions = {}): Promise<Record<string, unknown>> {
    await this.connect()
    let renewed = false
    for (;;) {
      const id = this.nextId++
      try {
        const res = await this.send(
          { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) },
          { expectId: id, timeoutMs: o.timeoutMs ?? this.timeoutMs, signal: o.signal }
        )
        return resultOf(method, res)
      } catch (e) {
        if (isMcpError(e) && e.reason === 'session_expired' && !renewed) {
          // Spec: a 404 for our session means start a new one. The request
          // never ran, so sending it again is safe.
          renewed = true
          this.info = null
          await this.connect()
          continue
        }
        if (isMcpError(e) && (e.code === 'timeout' || e.code === 'cancelled')) void this.notifyCancelled(id, e.code)
        throw e
      }
    }
  }

  // One message out, with the auth rules from the header comment.
  private async send(
    msg: JsonRpcMessage,
    o: { expectId?: JsonRpcId; timeoutMs: number; signal?: AbortSignal }
  ): Promise<JsonRpcMessage | null> {
    let refreshed = false
    let signedIn = false
    for (;;) {
      let bearer: BoundToken | null = null
      if (this.tokens) {
        try {
          bearer = await this.tokens.tokenFor(this.connectionId, this.endpoint, this.net)
        } catch (e) {
          if (isMcpError(e, 'reconnect_required') && this.interactive && !signedIn) {
            signedIn = true
            await this.signIn(null)
            continue
          }
          throw e
        }
      }
      let serverRequests = 0
      try {
        return await this.transport.post(msg, {
          ...o,
          bearer,
          onServerMessage: async (m) => {
            if (m.id !== undefined && m.id !== null && ++serverRequests > MAX_SERVER_REQUESTS_PER_CALL) {
              throw new McpError('protocol_error', 'The server sent too many requests of its own.', { reason: 'server_request_flood', uncertain: true })
            }
            await this.onServerMessage(m, bearer)
          }
        })
      } catch (e) {
        if (!isMcpError(e) || e.reason !== 'unauthorized') throw e
        if (!this.tokens) {
          throw new McpError('reconnect_required', 'This server needs sign-in, and this connection has none.', {
            reason: 'authorization_required',
            status: 401,
            challenge: e.challenge
          })
        }
        if (bearer && !refreshed) {
          refreshed = true
          try {
            await this.tokens.refresh(this.connectionId, this.endpoint, bearer.token, this.net)
            continue
          } catch (re) {
            if (!(isMcpError(re, 'reconnect_required') && this.interactive && !signedIn)) throw re
          }
        }
        if (this.interactive && !signedIn) {
          signedIn = true
          await this.signIn(e.challenge)
          continue
        }
        throw new McpError(
          'reconnect_required',
          bearer ? 'Sign-in for this server has expired or was revoked. Reconnect to keep using it.' : 'This server needs sign-in. Connect it from Connections.',
          { reason: bearer ? 'token_rejected' : 'authorization_required', status: 401, challenge: e.challenge }
        )
      }
    }
  }

  private async signIn(challenge: BearerChallenge | null): Promise<void> {
    const i = this.interactive
    const store = this.o.auth?.tokenStore
    if (!i || !store) throw new McpError('reconnect_required', 'This server needs sign-in.', { reason: 'authorization_required' })
    await authorizeMcpServer({
      connectionId: this.connectionId,
      endpoint: this.endpoint,
      binding: i.binding,
      openExternal: i.openExternal,
      tokenStore: store,
      challenge,
      clientId: i.clientId,
      timeoutMs: i.timeoutMs,
      signal: i.signal,
      net: this.net,
      pending: i.pending
    })
  }

  private async currentBearer(): Promise<BoundToken | null> {
    if (!this.tokens) return null
    try {
      return await this.tokens.tokenFor(this.connectionId, this.endpoint, this.net)
    } catch {
      return null
    }
  }

  private async onServerMessage(m: JsonRpcMessage, bearer: BoundToken | null): Promise<void> {
    if (typeof m.method !== 'string') return
    if (m.id === undefined || m.id === null) {
      if (m.method === 'notifications/tools/list_changed') {
        try {
          this.o.onToolsListChanged?.()
        } catch {
          // A listener's bug must not break the protocol.
        }
      }
      // Progress, logging and other notifications are not surfaced.
      return
    }
    // A request from the server. Plexii declared no client capabilities, so
    // anything but ping is answered "method not found", recorded, and never
    // acted on (§4: sampling and elicitation stay disabled).
    const isPing = m.method === 'ping'
    const reply: JsonRpcMessage = isPing
      ? { jsonrpc: '2.0', id: m.id, result: {} }
      : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found: Plexii does not offer this to servers.' } }
    let delivered = true
    try {
      await this.transport.post(reply, { timeoutMs: 10_000, bearer })
    } catch {
      delivered = false
    }
    if (isPing) return
    const record: RefusedServerRequest = { method: cleanServerText(m.method, 100), at: Date.now(), delivered }
    this.refused.push(record)
    if (this.refused.length > REFUSED_LOG_CAP) this.refused.shift()
    try {
      this.o.onServerRequestRefused?.(record)
    } catch {
      // As above.
    }
  }

  private async notifyCancelled(id: JsonRpcId, why: 'timeout' | 'cancelled' | string): Promise<void> {
    try {
      await this.transport.post(
        { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: why === 'timeout' ? 'Timed out' : 'Cancelled' } },
        { timeoutMs: 5_000, bearer: await this.currentBearer() }
      )
    } catch {
      // Best effort: the server may already have given up too.
    }
  }
}
