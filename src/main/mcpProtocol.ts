// The MCP protocol layer Plexii speaks over the local PlexiAPI server.
//
// One JSON-RPC 2.0 dispatcher (initialize / ping / tools/list / tools/call /
// notifications) over a registry of tools. Recall (mcpRecall.ts) and the
// workspace surface (mcpServer.ts) both compose on this, so the wire contract
// can never drift between them: one place decides what "a tool" is, how a
// read-only token is gated, and what a tool error looks like.
//
// Why hand-rolled rather than the official SDK: the server is stateless
// Streamable HTTP mounted on an existing http.Server behind PlexiAPI's guards
// (127.0.0.1, bearer token, Origin + DNS-rebind checks). The SDK wants to own
// the transport; here the transport is already owned. The surface we need
// (tools with annotations) is small and fully specified, and this file is the
// whole of it. Prompts / resources / sampling are deliberately NOT claimed in
// the capabilities so a client never asks for what we cannot answer.
//
// Scope gating is structural, not advisory. Every tool declares `scope`
// ('read' | 'write'); a token without the write scope never SEES a write
// tool in tools/list, and a call to one is refused as a JSON-RPC error rather
// than a tool result — so a read-only token cannot be talked into writing
// even by a model that ignores tool descriptions.

import type { ApiScope } from '@shared/apiAccess'

// Protocol versions we can honestly speak. The client's offer is echoed when
// known; otherwise we answer with our newest and let the client decide.
export const KNOWN_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export const DEFAULT_VERSION = '2025-06-18'

/** MCP tool annotations (spec 2025-03-26+). Hints, never enforcement — the
 *  enforcement is `scope`. Hosts (Claude Desktop, Claude Code) use these to
 *  decide whether to confirm a call with the user before running it. */
export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpTextContent {
  type: 'text'
  text: string
}

export interface McpToolResult {
  content: McpTextContent[]
  isError?: boolean
  /** Optional machine-readable twin of the text (spec 2025-06-18). */
  structuredContent?: Record<string, unknown>
}

export interface McpToolDef<Deps> {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: McpToolAnnotations
  /** The PlexiAPI scope this tool needs. Write tools are hidden from and
   *  refused to read-only tokens. */
  scope: ApiScope
  run: (args: Record<string, unknown>, deps: Deps) => McpToolResult | Promise<McpToolResult>
}

export interface RpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

export type RpcReply = Record<string, unknown> | null

/** Everything the dispatcher needs about the caller: which scopes the bearer
 *  token carries. Read-only tokens see and may call only read tools. */
export interface McpCaller {
  scopes: ApiScope[]
}

/** A resource a client can attach as context (MCP 2025-06-18 §Resources). */
export interface McpResource {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
}

export interface McpResourceContents {
  uri: string
  mimeType?: string
  text: string
}

/** Resources a server exposes. Optional: a server that has none must NOT
 *  declare the capability, or a client will ask for what cannot be answered. */
export interface McpResourceProvider<Deps> {
  /** One page. `cursor` is opaque to the client and minted by `list`. */
  list: (cursor: string | null, deps: Deps) => Promise<{ resources: McpResource[]; nextCursor?: string }>
  /** Contents, or null when the uri names nothing — answered as -32002. */
  read: (uri: string, deps: Deps) => Promise<McpResourceContents | null>
}

export interface McpServerSpec<Deps> {
  name: string
  version: string
  tools: McpToolDef<Deps>[]
  /** Called after a WRITE tool succeeds, so the surface can record that an
   *  agent did it.
   *
   *  It lives here rather than inside each tool for one reason: a tool author
   *  cannot forget it. Attribution that depends on remembering to add a line to
   *  every new write tool is attribution that decays — and the failure is
   *  silent, because an unattributed write looks exactly like the user's own
   *  work. Optional so this module stays pure; mcpServer supplies the real one. */
  onWrite?: (input: { tool: McpToolDef<Deps>; objectId: string | null; summary: string }, deps: Deps) => void
  /** Optional. Present = the `resources` capability is declared. */
  resources?: McpResourceProvider<Deps>
}

// ── Result helpers (shared by every tool module) ────────────────────────────

export function text(s: string): McpToolResult {
  return { content: [{ type: 'text', text: s }] }
}

export function toolError(s: string): McpToolResult {
  return { ...text(s), isError: true }
}

/** Cap a tool's text at `max` characters, appending an honest marker rather
 *  than silently truncating. Claude.ai/Desktop reject results over ~150k
 *  characters and Claude Code caps at 25k tokens; every tool stays well under
 *  both so a large workspace never yields an unreadable reply. */
export const RESULT_CHAR_CAP = 60_000

export function capText(s: string, max = RESULT_CHAR_CAP, note = '[… truncated — the rest lives in Plexii]'): string {
  return s.length > max ? `${s.slice(0, max)}\n${note}` : s
}

// ── Argument coercion (one place, so every tool validates the same way) ─────

export function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim()
}

export function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(min, Math.trunc(n)), max)
}

export function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return fallback
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

function callerCanUse(tool: { scope: ApiScope }, caller: McpCaller): boolean {
  // 'write' implies read: a write token may use every tool.
  if (tool.scope === 'read') return caller.scopes.includes('read') || caller.scopes.includes('write')
  return caller.scopes.includes('write')
}

/** The wire shape of a tool for tools/list — everything but `run`/`scope`. */
export function toolListing<Deps>(t: McpToolDef<Deps>): Record<string, unknown> {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }
}

/** One JSON-RPC message in, one reply out (null = notification, no body). */
export async function dispatchMcpMessage<Deps>(
  msg: RpcMessage,
  spec: McpServerSpec<Deps>,
  deps: Deps,
  caller: McpCaller
): Promise<RpcReply> {
  const id = msg.id ?? null
  const reply = (result: unknown): RpcReply => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, message: string): RpcReply => ({ jsonrpc: '2.0', id, error: { code, message } })

  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return fail(-32600, 'Invalid JSON-RPC 2.0 request.')
  }
  // Notifications carry no id and get no reply body.
  if (msg.method.startsWith('notifications/')) return null

  switch (msg.method) {
    case 'initialize': {
      const offered = String((msg.params?.protocolVersion as string) ?? '')
      return reply({
        protocolVersion: KNOWN_VERSIONS.includes(offered) ? offered : DEFAULT_VERSION,
        // Declare ONLY what we can answer. `resources: {}` means we serve them
        // but support neither `subscribe` nor `listChanged` — claiming either
        // would have clients waiting for notifications that never come.
        capabilities: spec.resources ? { tools: {}, resources: {} } : { tools: {} },
        serverInfo: { name: spec.name, version: spec.version }
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: spec.tools.filter((t) => callerCanUse(t, caller)).map(toolListing) })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      const tool = spec.tools.find((t) => t.name === name)
      if (!tool) return reply(toolError(`Unknown tool: ${name}`))
      // A scope refusal is a protocol-level error, not a tool result: the
      // token is not allowed to invoke this tool at all.
      if (!callerCanUse(tool, caller)) {
        return fail(-32602, `Tool "${name}" needs the "${tool.scope}" scope; this token does not have it.`)
      }
      try {
        const out = await tool.run(args && typeof args === 'object' ? args : {}, deps)
        // Record the write centrally — see onWrite. Only on success: a refused
        // or failed tool changed nothing, and logging it as a change would make
        // the record lie in the other direction.
        if (tool.scope === 'write' && !out.isError && spec.onWrite) {
          // A batch reports `ids`; a single write reports `id`. Attribute the
          // batch to its first object rather than dropping the event entirely —
          // an unattributed bulk write is the worst kind to lose.
          const sc = out.structuredContent
          const many = Array.isArray(sc?.ids) ? (sc.ids as unknown[]) : []
          const objectId =
            typeof sc?.id === 'string' ? sc.id : typeof many[0] === 'string' ? (many[0] as string) : null
          spec.onWrite({ tool, objectId, summary: out.content[0]?.text ?? '' }, deps)
        }
        // Belt and braces: never let an oversized text reach the wire.
        return reply({ ...out, content: out.content.map((c) => ({ ...c, text: capText(c.text) })) })
      } catch (err) {
        return reply(toolError(`Tool failed: ${err instanceof Error ? err.message : 'unknown error'}`))
      }
    }
    case 'resources/list': {
      if (!spec.resources) return fail(-32601, 'This server exposes no resources.')
      // Resources are reads. A token with no read scope sees none, for the same
      // reason it lists no read tools.
      if (!caller.scopes.includes('read') && !caller.scopes.includes('write')) {
        return fail(-32602, 'This token has no read scope.')
      }
      const cursor = typeof msg.params?.cursor === 'string' ? msg.params.cursor : null
      const out = await spec.resources.list(cursor, deps)
      return reply(out.nextCursor ? { resources: out.resources, nextCursor: out.nextCursor } : { resources: out.resources })
    }
    case 'resources/read': {
      if (!spec.resources) return fail(-32601, 'This server exposes no resources.')
      if (!caller.scopes.includes('read') && !caller.scopes.includes('write')) {
        return fail(-32602, 'This token has no read scope.')
      }
      const uri = String(msg.params?.uri ?? '')
      if (!uri) return fail(-32602, 'resources/read needs a uri.')
      const contents = await spec.resources.read(uri, deps)
      // -32002 is the spec's "resource not found"; a generic error would have
      // the client retry something that will never exist.
      if (!contents) return { jsonrpc: '2.0', id, error: { code: -32002, message: 'Resource not found', data: { uri } } }
      return reply({ contents: [contents] })
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`)
  }
}

/** The HTTP body handler the PlexiAPI route calls: single message or (older
 *  clients) a batch array. Returns null when nothing needs a body (202). */
export async function dispatchMcpBody<Deps>(
  body: unknown,
  spec: McpServerSpec<Deps>,
  deps: Deps,
  caller: McpCaller
): Promise<RpcReply | RpcReply[]> {
  if (Array.isArray(body)) {
    const replies = (
      await Promise.all(body.map((m) => dispatchMcpMessage((m ?? {}) as RpcMessage, spec, deps, caller)))
    ).filter((r): r is Record<string, unknown> => r !== null)
    return replies.length ? replies : null
  }
  return dispatchMcpMessage((body ?? {}) as RpcMessage, spec, deps, caller)
}
