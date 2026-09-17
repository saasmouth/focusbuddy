// Recall over MCP — the G3 round (deferred at DEC-103, built here).
//
// External AI tools (Claude Code, Claude Desktop, anything speaking MCP over
// Streamable HTTP) get a READ-ONLY door into the meeting corpus: search the
// attributed segments, read a meeting's record, list what exists. Every
// answer carries its attribution — a speaker, a timestamp, a meeting —
// because a Recall answer without provenance is just a rumour with an API.
//
// Transport and auth are NOT this module's problem, on purpose: the endpoint
// mounts as POST /mcp on the existing PlexiAPI server (apiServer.ts) behind
// everything it already enforces — 127.0.0.1 binding, bearer tokens, the
// Origin rejection and the DNS-rebind host guard, user-enabled only. MCP
// speaks POST for reads, so the route requires the READ scope explicitly
// rather than riding the server's method-based write gate.
//
// The refusals, stated where they are enforced:
//   - READ-ONLY forever: no tool on this surface writes, files, or sends.
//   - No audio: bytes never leave the machine (CR-11/CR-13); MCP gets text.
//   - No reach: loopback only, token required — both inherited, both real.
//
// The protocol layer lives in mcpProtocol.ts (hand-rolled JSON-RPC 2.0,
// shared with the workspace surface in mcpServer.ts). Stateless by design:
// the spec lets a Streamable HTTP server skip session ids, and every reply
// is plain JSON. This module owns only the three Recall tools.

import { searchMeetingSegments, attributedLine } from './segmentRecall'
import { getMeeting, listMeetings } from './db/meetings'
import { listTranscriptSegments } from './db/transcripts'

import {
  dispatchMcpBody,
  dispatchMcpMessage,
  text,
  toolError,
  num,
  str,
  type McpCaller,
  type McpServerSpec,
  type McpToolDef,
  type McpToolResult,
  type RpcMessage,
  type RpcReply
} from './mcpProtocol'

export interface McpDeps {
  searchSegments: typeof searchMeetingSegments
  getMeeting: typeof getMeeting
  listMeetings: typeof listMeetings
  listSegments: typeof listTranscriptSegments
  serverVersion: string
}

const TRANSCRIPT_CHAR_CAP = 24_000

// Every Recall tool is read-only by contract; the annotations say so to the
// host and `scope: 'read'` says so to the dispatcher.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

function recallSearch(args: Record<string, unknown>, deps: McpDeps): McpToolResult {
  const query = str(args.query)
  if (!query) return toolError('recall_search needs a query.')
  const limit = num(args.limit, 12, 1, 50)
  const hits = deps.searchSegments(query, limit)
  if (hits.length === 0) return text('No spoken lines match that query — an honest zero, not a failure.')
  const lines = hits.map((h) => `${attributedLine(h)}\n    — in “${h.meetingTitle}” (meetingId: ${h.meetingId})`)
  return text(lines.join('\n'))
}

function recallMeeting(args: Record<string, unknown>, deps: McpDeps): McpToolResult {
  const id = str(args.meetingId)
  const m = id ? deps.getMeeting(id) : null
  if (!m) return toolError('No meeting with that id.')
  const segs = deps.listSegments(m.id)
  let transcript = segs.map((s) => attributedLine(s)).join('\n')
  let truncated = false
  if (transcript.length > TRANSCRIPT_CHAR_CAP) {
    transcript = transcript.slice(0, TRANSCRIPT_CHAR_CAP)
    truncated = true
  }
  const parts = [
    `# ${m.title}`,
    `Date: ${new Date(m.createdAt).toISOString()}`,
    m.summary ? `\n## Summary\n${m.summary}` : '',
    m.actionItems.length ? `\n## Action items\n${m.actionItems.map((a) => `- ${a}`).join('\n')}` : '',
    segs.length
      ? `\n## Transcript (attributed)\n${transcript}${truncated ? '\n[… truncated — the full transcript lives in Plexii]' : ''}`
      : '\n(No attributed transcript for this meeting.)'
  ]
  return text(parts.filter(Boolean).join('\n'))
}

function recallRecentMeetings(args: Record<string, unknown>, deps: McpDeps): McpToolResult {
  const limit = num(args.limit, 20, 1, 100)
  const rows = deps.listMeetings().slice(0, limit)
  if (rows.length === 0) return text('No meetings recorded yet.')
  return text(
    rows.map((m) => `${m.id} · ${m.title} · ${new Date(m.createdAt).toISOString().slice(0, 10)}`).join('\n')
  )
}

/** The three Recall tools, as a group any composed server can mount. */
export const RECALL_TOOLS: McpToolDef<McpDeps>[] = [
  {
    name: 'recall_search',
    description:
      'Search everything said across recorded Plexii meetings. Returns attributed lines — ' +
      'speaker, timestamp, meeting — never a paraphrase. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for (free text).' },
        limit: { type: 'number', description: 'Max hits (default 12).' }
      },
      required: ['query']
    },
    annotations: { title: 'Search meeting transcripts', ...READ_ONLY },
    scope: 'read',
    run: recallSearch
  },
  {
    name: 'recall_meeting',
    description:
      'Read one meeting: title, date, summary, action items, and its attributed transcript. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'The meeting id (from recall_search or recall_recent_meetings).' }
      },
      required: ['meetingId']
    },
    annotations: { title: 'Read a meeting', ...READ_ONLY },
    scope: 'read',
    run: recallMeeting
  },
  {
    name: 'recall_recent_meetings',
    description: 'List recent Plexii meetings (id, title, date) so a meeting can be picked. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max meetings (default 20).' } }
    },
    annotations: { title: 'List recent meetings', ...READ_ONLY },
    scope: 'read',
    run: recallRecentMeetings
  }
]

/** Recall as a standalone server: the shape shipped in G3, kept so the
 *  read-only contract has its own name and its own tests. The live /mcp route
 *  mounts these same tools inside the workspace server (mcpServer.ts). */
export function recallServerSpec(serverVersion: string): McpServerSpec<McpDeps> {
  return { name: 'plexii-recall', version: serverVersion, tools: RECALL_TOOLS }
}

const READ_CALLER: McpCaller = { scopes: ['read'] }

/** One JSON-RPC message in, one reply out (null = notification, no body). */
export function handleMcpMessage(msg: RpcMessage, deps: McpDeps): Promise<RpcReply> {
  return dispatchMcpMessage(msg, recallServerSpec(deps.serverVersion), deps, READ_CALLER)
}

/** The HTTP body handler: single message or (older clients) a batch array.
 *  Returns null when nothing needs a body (202). */
export function handleMcpBody(body: unknown, deps: McpDeps): Promise<RpcReply | RpcReply[]> {
  return dispatchMcpBody(body, recallServerSpec(deps.serverVersion), deps, READ_CALLER)
}

/** Real-store deps for the live route. */
export function liveMcpDeps(serverVersion: string): McpDeps {
  return {
    searchSegments: searchMeetingSegments,
    getMeeting,
    listMeetings,
    listSegments: listTranscriptSegments,
    serverVersion
  }
}
